/**
 * Dependency graph: tracks which fibers provide which service tokens and
 * which fibers consume which tokens, so teardown can dispose consumers
 * before their providers (dependency-safe order).
 *
 * Edges are fiber-level and are maintained by the runtime:
 *
 * - provider edge: committed binding `fiber → token`;
 * - hard consumer edge: a declared requirement (`requirements.requires`) or
 *   a successful `ctx.require(...)`. Hard edges participate in mandatory
 *   dependency-safe teardown;
 * - soft consumer edge: an optional observation
 *   (`requirements.optionallyRequires` or a successful `ctx.try(...)`). Soft
 *   edges never force teardown; they are visible in introspection only.
 *
 * Teardown ordering is a true topological sort of the fiber-level hard
 * dependency graph (consumers before providers), not a BFS-depth heuristic:
 *
 * - arbitrary DAGs dispose correctly: a consumer with multiple dependency
 *   paths to a provider is still disposed before every provider;
 * - dependency cycles are handled by strongly-connected-component
 *   condensation: each SCC is torn down as one deterministic group (members
 *   in ascending fiber-id order) and the condensation DAG is topologically
 *   sorted, so teardown is deterministic and never hangs. Cycles cannot
 *   arise from initially-declared mutually-unsatisfied requirements (a
 *   fiber only activates once its declared requirements are committed), but
 *   dynamic `ctx.require()` calls after activation create hard edges, so a
 *   hard-edge cycle CAN be formed at runtime. SCC handling is therefore
 *   required runtime behavior, not merely defense in depth — and it feeds
 *   introspection.
 *
 * Determinism: iteration is insertion-ordered; all ordering decisions are
 * made by explicit sorts on fiber ids. Sibling consumers (incomparable in
 * the dependency order) are emitted in descending fiber-id order because the
 * final order is the reversal of the ascending Kahn ready queue.
 *
 * The graph is internal runtime state; it is never exposed to plugins.
 */

const EMPTY: ReadonlySet<string> = new Set<string>();

/**
 * Fiber-level dependency graph with deterministic traversal and
 * dependency-safe teardown ordering.
 */
export class DependencyGraph {
  /** fiberId → token ids the fiber provides (committed bindings). */
  readonly #provided = new Map<string, Set<string>>();
  /** tokenId → provider fiber id (single-valued tokens). */
  readonly #providers = new Map<string, string>();
  /** tokenId → hard consumer fiber ids (mandatory teardown edges). */
  readonly #hardConsumers = new Map<string, Set<string>>();
  /** tokenId → soft consumer fiber ids (introspection-only edges). */
  readonly #softConsumers = new Map<string, Set<string>>();
  /** fiberId → token ids the fiber hard-requires. */
  readonly #hardRequired = new Map<string, Set<string>>();
  /** fiberId → token ids the fiber softly observes. */
  readonly #softRequired = new Map<string, Set<string>>();

  /** Record that `fiberId` provides `tokenId` (single-valued). */
  addProvider(fiberId: string, tokenId: string): void {
    this.#providers.set(tokenId, fiberId);
    let set = this.#provided.get(fiberId);
    if (!set) {
      set = new Set();
      this.#provided.set(fiberId, set);
    }
    set.add(tokenId);
  }

  /** Remove the provider edge if `fiberId` still owns it. */
  removeProvider(tokenId: string, fiberId: string): void {
    if (this.#providers.get(tokenId) === fiberId) {
      this.#providers.delete(tokenId);
    }
    this.#provided.get(fiberId)?.delete(tokenId);
  }

  /** The fiber currently providing `tokenId`, if any. */
  providerOf(tokenId: string): string | undefined {
    return this.#providers.get(tokenId);
  }

  /** Record a mandatory consumer edge `fiberId → tokenId`. Idempotent. */
  addHardConsumer(fiberId: string, tokenId: string): void {
    let set = this.#hardConsumers.get(tokenId);
    if (!set) {
      set = new Set();
      this.#hardConsumers.set(tokenId, set);
    }
    set.add(fiberId);
    let required = this.#hardRequired.get(fiberId);
    if (!required) {
      required = new Set();
      this.#hardRequired.set(fiberId, required);
    }
    required.add(tokenId);
  }

  /** Record an optional observation edge `fiberId → tokenId`. Idempotent. */
  addSoftConsumer(fiberId: string, tokenId: string): void {
    let set = this.#softConsumers.get(tokenId);
    if (!set) {
      set = new Set();
      this.#softConsumers.set(tokenId, set);
    }
    set.add(fiberId);
    let required = this.#softRequired.get(fiberId);
    if (!required) {
      required = new Set();
      this.#softRequired.set(fiberId, required);
    }
    required.add(tokenId);
  }

  /** Remove the consumer edge `fiberId → tokenId` (hard or soft). */
  removeConsumer(fiberId: string, tokenId: string): void {
    this.#hardConsumers.get(tokenId)?.delete(fiberId);
    this.#softConsumers.get(tokenId)?.delete(fiberId);
    this.#hardRequired.get(fiberId)?.delete(tokenId);
    this.#softRequired.get(fiberId)?.delete(tokenId);
  }

  /** Hard consumer fiber ids of `tokenId` (insertion order). */
  hardConsumersOf(tokenId: string): ReadonlySet<string> {
    return this.#hardConsumers.get(tokenId) ?? EMPTY;
  }

  /** Soft consumer fiber ids of `tokenId` (insertion order). */
  softConsumersOf(tokenId: string): ReadonlySet<string> {
    return this.#softConsumers.get(tokenId) ?? EMPTY;
  }

  /** Token ids provided by `fiberId` (insertion order). */
  providedTokens(fiberId: string): ReadonlySet<string> {
    return this.#provided.get(fiberId) ?? EMPTY;
  }

  /** Token ids hard-required by `fiberId` (insertion order). */
  hardRequiredTokens(fiberId: string): ReadonlySet<string> {
    return this.#hardRequired.get(fiberId) ?? EMPTY;
  }

  /** Token ids softly observed by `fiberId` (insertion order). */
  softRequiredTokens(fiberId: string): ReadonlySet<string> {
    return this.#softRequired.get(fiberId) ?? EMPTY;
  }

  /** Remove every edge involving `fiberId`. */
  removeFiber(fiberId: string): void {
    for (const tokenId of this.#provided.get(fiberId) ?? []) {
      if (this.#providers.get(tokenId) === fiberId) {
        this.#providers.delete(tokenId);
      }
    }
    for (const tokenId of this.#hardRequired.get(fiberId) ?? []) {
      this.#hardConsumers.get(tokenId)?.delete(fiberId);
    }
    for (const tokenId of this.#softRequired.get(fiberId) ?? []) {
      this.#softConsumers.get(tokenId)?.delete(fiberId);
    }
    this.#provided.delete(fiberId);
    this.#hardRequired.delete(fiberId);
    this.#softRequired.delete(fiberId);
  }

  /**
   * Consumer-first disposal order for `fiberId` and every transitive hard
   * consumer of the services it provides. The root fiber is always last,
   * preceded by its dependents in dependency-safe order.
   *
   * The order is a true topological sort of the fiber-level hard dependency
   * subgraph: a consumer is never emitted before a fiber it depends on.
   * Cycles collapse into deterministic SCC groups (members in ascending
   * fiber-id order); sibling consumers are emitted in descending fiber-id
   * order.
   */
  teardownOrder(fiberId: string): string[] {
    const affected = this.#affectedSet(fiberId);
    // Fiber-level dependency edges: provider → hard consumer (a consumer
    // depends on every fiber providing a token it requires). Self-edges are
    // irrelevant to ordering (a fiber never waits on itself).
    const edges = new Map<string, Set<string>>();
    for (const id of affected) {
      for (const tokenId of this.#provided.get(id) ?? []) {
        for (const consumerId of this.#hardConsumers.get(tokenId) ?? []) {
          if (consumerId !== id && affected.has(consumerId)) {
            let set = edges.get(id);
            if (set === undefined) {
              set = new Set();
              edges.set(id, set);
            }
            set.add(consumerId);
          }
        }
      }
    }
    const sccs = this.#stronglyConnectedComponents([...affected], edges);
    const nodeToScc = new Map<string, number>();
    sccs.forEach((members, index) => {
      for (const member of members) {
        nodeToScc.set(member, index);
      }
    });
    // Condensation DAG: SCC index → consumer SCC indexes (self-loops gone).
    const dagEdges: Set<number>[] = sccs.map(() => new Set<number>());
    for (const [id, consumers] of edges) {
      const from = nodeToScc.get(id) as number;
      for (const consumerId of consumers) {
        const to = nodeToScc.get(consumerId) as number;
        if (from !== to) {
          dagEdges[from].add(to);
        }
      }
    }
    // Kahn's algorithm over the condensation, emitting providers first; the
    // final order is the reversal (consumers first). The ready queue always
    // pops the SCC with the smallest member fiber id, so the reversed order
    // is fully deterministic: siblings appear in descending fiber-id order.
    const indegree = new Array<number>(sccs.length).fill(0);
    for (const out of dagEdges) {
      for (const to of out) {
        indegree[to] += 1;
      }
    }
    const ready: number[] = [];
    for (let i = 0; i < sccs.length; i += 1) {
      if (indegree[i] === 0) {
        ready.push(i);
      }
    }
    const order: number[] = [];
    while (ready.length > 0) {
      ready.sort((a, b) => sccs[a][0].localeCompare(sccs[b][0]));
      const scc = ready.shift() as number;
      order.push(scc);
      for (const to of dagEdges[scc]) {
        indegree[to] -= 1;
        if (indegree[to] === 0) {
          ready.push(to);
        }
      }
    }
    // The condensation of an SCC decomposition is always a DAG, so `order`
    // covers every component; the guard only keeps teardown complete and
    // deterministic if a graph invariant is ever violated.
    if (order.length < sccs.length) {
      const ordered = new Set(order);
      for (let i = 0; i < sccs.length; i += 1) {
        if (!ordered.has(i)) {
          order.push(i);
        }
      }
    }
    const result: string[] = [];
    for (let i = order.length - 1; i >= 0; i -= 1) {
      result.push(...sccs[order[i]]);
    }
    return result;
  }

  /**
   * Every dependency cycle in the graph as SCC groups (members in ascending
   * fiber-id order, groups sorted by first member). A single-member group
   * appears when a fiber requires a token it provides itself. Empty when the
   * graph is acyclic.
   */
  cycles(): readonly (readonly string[])[] {
    const nodes = new Set<string>();
    for (const fiberId of this.#provided.keys()) {
      nodes.add(fiberId);
    }
    for (const fiberId of this.#hardRequired.keys()) {
      nodes.add(fiberId);
    }
    const edges = new Map<string, Set<string>>();
    for (const fiberId of nodes) {
      for (const tokenId of this.#provided.get(fiberId) ?? []) {
        for (const consumerId of this.#hardConsumers.get(tokenId) ?? []) {
          let set = edges.get(fiberId);
          if (set === undefined) {
            set = new Set();
            edges.set(fiberId, set);
          }
          set.add(consumerId);
        }
      }
    }
    const result: string[][] = [];
    for (const component of this.#stronglyConnectedComponents(
      [...nodes],
      edges,
    )) {
      if (component.length > 1) {
        result.push(component);
        continue;
      }
      const [member] = component;
      if (edges.get(member)?.has(member) === true) {
        // Single-member SCC with a self-loop: the fiber requires its own
        // provided token.
        result.push(component);
      }
    }
    return result;
  }

  /**
   * `fiberId` plus every transitive hard consumer of the tokens it provides
   * (BFS over hard edges; soft edges never extend the teardown set).
   */
  #affectedSet(fiberId: string): Set<string> {
    const affected = new Set<string>([fiberId]);
    const queue: string[] = [fiberId];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      for (const tokenId of this.#provided.get(current) ?? []) {
        for (const consumerId of this.#hardConsumers.get(tokenId) ?? []) {
          if (!affected.has(consumerId)) {
            affected.add(consumerId);
            queue.push(consumerId);
          }
        }
      }
    }
    return affected;
  }

  /**
   * Tarjan's strongly connected components over `nodes` with the given
   * edges. Deterministic: nodes are visited in ascending id order and edges
   * in insertion order; every component is emitted with members sorted in
   * ascending id order, and components are sorted by first member.
   *
   * Recursion depth is bounded by the longest dependency chain in the
   * subgraph.
   */
  #stronglyConnectedComponents(
    nodes: string[],
    edges: Map<string, Set<string>>,
  ): string[][] {
    const index = new Map<string, number>();
    const lowlink = new Map<string, number>();
    const onStack = new Set<string>();
    const stack: string[] = [];
    const components: string[][] = [];
    let counter = 0;
    const strongconnect = (v: string): void => {
      index.set(v, counter);
      lowlink.set(v, counter);
      counter += 1;
      stack.push(v);
      onStack.add(v);
      for (const w of edges.get(v) ?? []) {
        if (!index.has(w)) {
          strongconnect(w);
          lowlink.set(
            v,
            Math.min(lowlink.get(v) as number, lowlink.get(w) as number),
          );
        } else if (onStack.has(w)) {
          lowlink.set(
            v,
            Math.min(lowlink.get(v) as number, index.get(w) as number),
          );
        }
      }
      if (lowlink.get(v) === index.get(v)) {
        const component: string[] = [];
        for (;;) {
          const w = stack.pop() as string;
          onStack.delete(w);
          component.push(w);
          if (w === v) {
            break;
          }
        }
        component.sort();
        components.push(component);
      }
    };
    for (const node of [...nodes].sort()) {
      if (!index.has(node)) {
        strongconnect(node);
      }
    }
    components.sort((a, b) => a[0].localeCompare(b[0]));
    return components;
  }
}
