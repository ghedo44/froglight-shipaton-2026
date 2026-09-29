/**
 * The runtime kernel: generic composition infrastructure.
 *
 * Owns plugin slots, fibers, the service registry, the typed event bus,
 * dependency reconciliation, and the dependency graph that guarantees
 * dependency-safe teardown. Contains no product concepts (documents, search,
 * UI, hosts) and no host-specific APIs.
 */

import { EffectScope, type Effect } from './effects.js';
import { BroadcastBus, type EventBus, type EventMap } from './events.js';
import {
  AggregateRuntimeError,
  DuplicateBindingError,
  DuplicateSlotError,
  FiberNotActiveError,
  MissingRequirementsError,
  RuntimeDisposedError,
  asError,
} from './errors.js';
import { DependencyGraph } from './graph.js';
import { buildIntrospection } from './introspection.js';
import { Reconciler, type ReconcilableSlot } from './reconciler.js';
import type { FiberDiagnostics } from './diagnostics.js';
import type {
  BindingRecord,
  ServiceRegistry,
  ServiceToken,
} from './services.js';
import type {
  ChildMountOptions,
  ConfigProperty,
  Context,
  Disposer,
  FailureRecord,
  FiberHandle,
  FiberSnapshot,
  FiberState,
  PluginConfig,
  PluginDefinition,
  PluginSlot,
  RuntimeState,
  SlotOrigin,
  SlotSnapshot,
  SlotState,
} from './types.js';

export type RootSlotOptions<C = PluginConfig, E extends EventMap = EventMap> = {
  readonly id: string;
  readonly plugin: PluginDefinition<C, E>;
} & ConfigProperty<C>;

interface SlotRecord<E extends EventMap = EventMap> {
  readonly id: string;
  readonly plugin: PluginDefinition<PluginConfig, E>;
  readonly config: PluginConfig;
  readonly origin: SlotOrigin;
  readonly parentId: string | null;
  parentFiber: FiberRecord<E> | null;
  state: SlotState;
  fiber: FiberRecord<E> | null;
  failure: FailureRecord | null;
  disposed: boolean;
  /** Dynamic `ctx.require` tokens the slot is waiting for. */
  missingDynamicTokens: readonly string[];
}

interface FiberRecord<E extends EventMap = EventMap> {
  readonly id: string;
  readonly slotId: string;
  readonly pluginId: string;
  readonly parentId: string | null;
  readonly record: SlotRecord<E>;
  state: FiberState;
  readonly scope: EffectScope;
  readonly controller: AbortController;
  readonly children: Map<string, SlotRecord<E>>;
  readonly bindings: Set<string>;
  readonly subscriptions: Set<Effect>;
  diagnostics: FiberDiagnostics;
  /** Set synchronously when the underlying disposal operation starts. */
  disposed: boolean;
  /**
   * One disposal operation per fiber. Overlapping cascades join this promise
   * instead of skipping an unloading consumer and tearing down its provider
   * early.
   */
  disposePromise: Promise<void> | null;
  /** Tokens held before unload; cleanup-time resolution is restricted here. */
  heldHardTokens: Set<string>;
  heldSoftTokens: Set<string>;
  context: Context<PluginConfig, E>;
}

const DEFAULT_NEXT_ID = (() => {
  let counter = 0;
  return () => `f${++counter}`;
})();

export class Runtime<E extends EventMap = EventMap> {
  readonly #services: ServiceRegistry;
  readonly #bus: BroadcastBus<E>;
  readonly #reconciler: Reconciler<E>;
  readonly #graph = new DependencyGraph();
  readonly #slots = new Map<string, SlotRecord<E>>();
  readonly #slotDisposals = new Map<string, Promise<void>>();
  #disposePromise: Promise<void> | null = null;
  #state: RuntimeState = 'running';

  constructor() {
    this.#services = createServiceRegistry();
    this.#bus = new BroadcastBus<E>();
    this.#reconciler = new Reconciler<E>({
      services: this.#services,
      getSlots: () => this.#reconcilableSlots(),
      activateSlot: (slot) => this.#activateSlot(slot as SlotRecord<E>),
      disposeFiberOf: (slot) => this.#disposeFiberOf(slot as SlotRecord<E>),
    });
  }

  get bus(): EventBus<E> {
    return this.#bus;
  }

  async registerSlot<C extends PluginConfig = PluginConfig>(
    options: RootSlotOptions<C, E>,
  ): Promise<PluginSlot<C>> {
    this.#assertRunning();
    if (this.#slots.has(options.id)) {
      throw new DuplicateSlotError(options.id);
    }
    const record: SlotRecord<E> = {
      id: options.id,
      plugin: options.plugin as unknown as PluginDefinition<PluginConfig, E>,
      config: options.config ?? {},
      origin: 'root',
      parentId: null,
      parentFiber: null,
      state: 'inactive',
      fiber: null,
      failure: null,
      disposed: false,
      missingDynamicTokens: [],
    };
    this.#slots.set(record.id, record);
    this.#reconciler.requestReconcile();
    await this.#reconciler.awaitQuiescence();
    return this.#publicSlot(record) as PluginSlot<C>;
  }

  /**
   * Remove a root slot. The in-flight operation is published before teardown
   * starts, so abort/cleanup callbacks that re-enter `removeSlot` join the
   * existing operation instead of starting another one.
   */
  async removeSlot(id: string): Promise<void> {
    this.#assertRunning();
    const record = this.#slots.get(id);
    if (!record) {
      return;
    }
    if (record.parentId !== null) {
      throw new Error(
        `slot "${id}" is a child slot; dispose its parent instead`,
      );
    }
    const inFlight = this.#slotDisposals.get(id);
    if (inFlight !== undefined) {
      return inFlight;
    }

    let resolveRemoval!: () => void;
    let rejectRemoval!: (reason?: unknown) => void;
    const removal = new Promise<void>((resolve, reject) => {
      resolveRemoval = resolve;
      rejectRemoval = reject;
    });
    this.#slotDisposals.set(id, removal);

    // Publication happens before this call. `#removeSlotOnce` starts
    // synchronously until its first await and may abort a fiber, which can
    // synchronously run plugin callbacks that re-enter `removeSlot`.
    void this.#removeSlotOnce(record).then(resolveRemoval, rejectRemoval);

    try {
      await removal;
    } finally {
      if (this.#slotDisposals.get(id) === removal) {
        this.#slotDisposals.delete(id);
      }
    }
  }

  async #removeSlotOnce(record: SlotRecord<E>): Promise<void> {
    await this.#disposeSlot(record);
    this.#reconciler.requestReconcile();
    await this.#reconciler.awaitQuiescence();
  }

  /**
   * Dispose is single-flight and reentrancy-safe: the shared promise is
   * published before abort events or plugin cleanup code can re-enter it.
   */
  dispose(): Promise<void> {
    if (this.#disposePromise !== null) {
      return this.#disposePromise;
    }

    let resolveDispose!: () => void;
    let rejectDispose!: (reason?: unknown) => void;
    const operation = new Promise<void>((resolve, reject) => {
      resolveDispose = resolve;
      rejectDispose = reject;
    });
    this.#disposePromise = operation;

    // Publication happens before global abort. AbortSignal listeners dispatch
    // synchronously, so a listener calling `runtime.dispose()` now joins the
    // already-published operation.
    void this.#performDispose().then(resolveDispose, rejectDispose);
    return operation;
  }

  async #performDispose(): Promise<void> {
    if (this.#state === 'disposed') {
      return;
    }
    this.#state = 'disposing';
    for (const record of this.#allSlotRecords()) {
      record.fiber?.controller.abort();
    }
    await this.#reconciler.awaitQuiescence();

    const failures: Error[] = [];

    // No new root-slot removal can start after `disposing`, so this snapshot
    // is complete. allSettled preserves every concurrent removal failure
    // instead of losing all but Promise.all's first rejection.
    const inFlightRemovals = [...new Set(this.#slotDisposals.values())];
    if (inFlightRemovals.length > 0) {
      const results = await Promise.allSettled(inFlightRemovals);
      for (const result of results) {
        if (result.status === 'rejected') {
          failures.push(asError(result.reason));
        }
      }
    }

    for (const record of this.#allSlotRecords()) {
      try {
        await this.#disposeSlot(record);
      } catch (error) {
        failures.push(asError(error));
      }
    }
    this.#slots.clear();
    this.#state = 'disposed';
    if (failures.length > 0) {
      throw new AggregateRuntimeError(
        `runtime disposal failed for ${failures.length} slot(s)`,
        failures,
      );
    }
  }

  inspect(): ReturnType<typeof buildIntrospection> {
    const slots = this.#allSlotRecords();
    return buildIntrospection({
      runtimeState: this.#state,
      slots: slots.map((s) => this.#slotSnapshot(s)),
      fiberSnapshots: slots.flatMap((s) =>
        s.fiber === null ? [] : [this.#fiberSnapshot(s.fiber)],
      ),
      bindingRecords: this.#services.all(),
      retiringBindingRecords: this.#services.retiring(),
      subscriptionRecords: this.#bus.records(),
      graphCycles: this.#graph.cycles(),
    });
  }

  #assertRunning(): void {
    if (this.#state !== 'running') {
      throw new RuntimeDisposedError();
    }
  }

  #allSlotRecords(): SlotRecord<E>[] {
    const all: SlotRecord<E>[] = [];
    for (const root of this.#slots.values()) {
      all.push(root);
      const visit = (fiber: FiberRecord<E> | null): void => {
        if (fiber === null) {
          return;
        }
        for (const child of fiber.children.values()) {
          all.push(child);
          visit(child.fiber);
        }
      };
      visit(root.fiber);
    }
    return all;
  }

  #reconcilableSlots(): readonly ReconcilableSlot<E>[] {
    return this.#allSlotRecords().filter((record) => !record.disposed);
  }

  #publicSlot(record: SlotRecord<E>): PluginSlot {
    return {
      id: record.id,
      plugin: record.plugin as unknown as PluginDefinition<
        PluginConfig,
        EventMap
      >,
      config: record.config,
      origin: record.origin,
      parentId: record.parentId ?? undefined,
      get state() {
        return record.state;
      },
      get fiberId() {
        return record.fiber?.id ?? null;
      },
      get failure() {
        return record.failure;
      },
    };
  }

  #slotSnapshot(record: SlotRecord<E>): SlotSnapshot {
    return {
      id: record.id,
      pluginId: record.plugin.id,
      state: record.state,
      parentId: record.parentId,
      fiberId: record.fiber?.id ?? null,
      config: record.config,
      failure: record.failure,
      missingRequirements: this.#missingRequirements(record),
    };
  }

  #missingRequirements(record: SlotRecord<E>): string[] {
    const missing: string[] = [];
    for (const token of record.plugin.requirements?.requires ?? []) {
      if (this.#services.getActive(token) === undefined) {
        missing.push(token.id);
      }
    }
    for (const tokenId of record.missingDynamicTokens) {
      if (
        !missing.includes(tokenId) &&
        this.#services.getActiveById(tokenId) === undefined
      ) {
        missing.push(tokenId);
      }
    }
    return missing;
  }

  #fiberSnapshot(fiber: FiberRecord<E>): FiberSnapshot {
    return {
      id: fiber.id,
      slotId: fiber.slotId,
      pluginId: fiber.pluginId,
      state: fiber.state,
      parentId: fiber.parentId,
      bindingCount: fiber.bindings.size,
      listenerCount: fiber.subscriptions.size,
      effectCount: fiber.scope.size,
      childCount: fiber.children.size,
      hardRequiredTokens: [...this.#graph.hardRequiredTokens(fiber.id)],
      softRequiredTokens: [...this.#graph.softRequiredTokens(fiber.id)],
      providedTokens: [...this.#graph.providedTokens(fiber.id)],
      diagnostics: fiber.diagnostics,
    };
  }

  async #disposeSlot(record: SlotRecord<E>): Promise<void> {
    if (record.disposed) {
      // A child/root slot can be encountered by overlapping ownership and
      // dependency cascades. Its fiber disposal, if still running, is joined
      // by the cascade that owns the actual FiberRecord.
      if (record.fiber?.disposePromise !== null) {
        await record.fiber?.disposePromise;
      }
      return;
    }
    record.disposed = true;
    let failure: unknown;
    try {
      if (record.fiber !== null) {
        await this.#disposeFiberCascade(record.fiber);
      }
    } catch (error) {
      failure = error;
    } finally {
      record.fiber = null;
      record.state = 'inactive';
      record.missingDynamicTokens = [];
      if (record.parentFiber !== null) {
        record.parentFiber.children.delete(record.id);
      } else {
        this.#slots.delete(record.id);
      }
    }
    if (failure !== undefined) {
      throw failure;
    }
  }

  async #disposeFiberOf(record: SlotRecord<E>): Promise<void> {
    if (record.fiber === null) {
      return;
    }
    try {
      await this.#disposeFiberCascade(record.fiber);
    } finally {
      record.fiber = null;
      record.state = 'inactive';
      record.missingDynamicTokens = [];
    }
  }

  /**
   * Dispose a provider and its dependency closure. Every provider in the
   * closure retires before the first await. An already-unloading dependent is
   * joined rather than skipped, so an overlapping cascade cannot tear down a
   * provider before that consumer's cleanup has actually completed.
   */
  async #disposeFiberCascade(fiber: FiberRecord<E>): Promise<void> {
    const byId = new Map<string, FiberRecord<E>>();
    for (const record of this.#allSlotRecords()) {
      if (record.fiber !== null) {
        byId.set(record.fiber.id, record.fiber);
      }
    }

    const order = this.#graph.teardownOrder(fiber.id);
    const closure = this.#teardownClosure(order, byId);
    for (const id of closure) {
      this.#services.retire(id);
    }

    const failures: Error[] = [];
    for (const dependentId of order) {
      if (dependentId === fiber.id) {
        continue;
      }
      const dependent = byId.get(dependentId);
      if (dependent === undefined) {
        continue;
      }
      try {
        // `#disposeFiber` is single-flight. If another cascade already began
        // this consumer's cleanup, await that exact operation instead of
        // treating `disposed === true` as if cleanup had completed.
        await this.#disposeFiber(dependent);
      } catch (error) {
        failures.push(asError(error));
      } finally {
        if (dependent.record.fiber === dependent) {
          dependent.record.fiber = null;
          dependent.record.state = 'inactive';
        }
      }
    }

    try {
      await this.#disposeFiber(fiber);
    } catch (error) {
      failures.push(asError(error));
    }

    if (failures.length > 0) {
      throw new AggregateRuntimeError(
        `disposal cascade for fiber "${fiber.id}" failed for ${failures.length} fiber(s)`,
        failures,
      );
    }
  }

  #teardownClosure(
    order: readonly string[],
    byId: ReadonlyMap<string, FiberRecord<E>>,
  ): string[] {
    const closure = new Set<string>(order);
    const queue = [...order];
    while (queue.length > 0) {
      const id = queue.shift() as string;
      const member = byId.get(id);
      if (member === undefined) {
        continue;
      }
      for (const child of member.children.values()) {
        if (child.fiber !== null && !closure.has(child.fiber.id)) {
          closure.add(child.fiber.id);
          queue.push(child.fiber.id);
        }
      }
      for (const tokenId of this.#graph.providedTokens(id)) {
        for (const consumerId of this.#graph.hardConsumersOf(tokenId)) {
          if (!closure.has(consumerId)) {
            closure.add(consumerId);
            queue.push(consumerId);
          }
        }
      }
    }
    return [...closure];
  }

  /**
   * Joinable fiber disposal. The promise is published before AbortSignal
   * dispatch or cleanup can re-enter runtime lifecycle APIs.
   */
  #disposeFiber(fiber: FiberRecord<E>): Promise<void> {
    if (fiber.disposePromise !== null) {
      return fiber.disposePromise;
    }

    let resolveDispose!: () => void;
    let rejectDispose!: (reason?: unknown) => void;
    const operation = new Promise<void>((resolve, reject) => {
      resolveDispose = resolve;
      rejectDispose = reject;
    });
    fiber.disposePromise = operation;

    void this.#performDisposeFiber(fiber).then(resolveDispose, rejectDispose);
    return operation;
  }

  async #performDisposeFiber(fiber: FiberRecord<E>): Promise<void> {
    fiber.disposed = true;
    fiber.state = 'unloading';
    const disposeStart = performance.now();
    fiber.diagnostics = {
      timing: {
        ...fiber.diagnostics.timing,
        disposeStart,
      },
    };

    fiber.controller.abort();
    fiber.heldHardTokens = new Set(this.#graph.hardRequiredTokens(fiber.id));
    fiber.heldSoftTokens = new Set(this.#graph.softRequiredTokens(fiber.id));
    const failures: Error[] = [];

    // Children are owned by this fiber and must finish before parent-owned
    // resources are released.
    for (const child of [...fiber.children.values()]) {
      try {
        await this.#disposeSlot(child);
      } catch (error) {
        failures.push(asError(error));
      }
    }
    fiber.children.clear();

    // Services can be withdrawn once dependency consumers have completed (or
    // joined this disposal). The dependency graph edges intentionally remain
    // until cleanup completes: an overlapping cascade must still see this
    // unloading fiber as a consumer and wait for its in-flight disposal.
    this.#services.withdrawAll(fiber.id);
    fiber.bindings.clear();

    failures.push(...(await fiber.scope.dispose()));
    fiber.subscriptions.clear();

    // Only now is this fiber no longer relevant to dependency ordering.
    this.#graph.removeFiber(fiber.id);

    fiber.state = 'disposed';
    fiber.diagnostics = {
      timing: {
        ...fiber.diagnostics.timing,
        disposeEnd: performance.now(),
      },
    };
    if (failures.length > 0) {
      throw new AggregateRuntimeError(
        `disposal of fiber "${fiber.id}" failed for ${failures.length} effect(s)`,
        failures,
      );
    }
  }

  async #activateSlot(record: SlotRecord<E>): Promise<boolean> {
    if (
      this.#state !== 'running' ||
      record.disposed ||
      record.fiber !== null ||
      record.state === 'activating'
    ) {
      return false;
    }
    record.state = 'activating';
    const fiber = this.#createFiber(record);
    record.fiber = fiber;
    try {
      await this.#activateFiber(fiber);
      record.state = 'active';
      record.failure = null;
      record.missingDynamicTokens = [];
    } catch (error) {
      if (
        fiber.disposed ||
        fiber.controller.signal.aborted ||
        this.#state !== 'running'
      ) {
        return true;
      }
      if (error instanceof MissingRequirementsError) {
        record.fiber = null;
        record.state = 'inactive';
        record.failure = null;
        record.missingDynamicTokens = error.missing;
        try {
          await this.#disposeFiber(fiber);
        } catch {
          // A dynamic missing dependency is a wait state; rollback failure
          // does not convert it into a permanent plugin failure.
        }
        return true;
      }
      record.fiber = null;
      record.state = 'failed';
      const cause = asError(error);
      const rollbackErrors: unknown[] = [];
      try {
        await this.#disposeFiber(fiber);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
      record.failure = {
        phase: 'activation',
        message: cause.message,
        error: cause,
        rollbackErrors,
      };
      return true;
    }
    return true;
  }

  #createFiber(record: SlotRecord<E>): FiberRecord<E> {
    const fiber = {
      id: DEFAULT_NEXT_ID(),
      slotId: record.id,
      pluginId: record.plugin.id,
      parentId: record.parentId,
      record,
      state: 'loading',
      scope: new EffectScope(),
      controller: new AbortController(),
      children: new Map(),
      bindings: new Set(),
      subscriptions: new Set(),
      diagnostics: {
        timing: {
          activateStart: 0,
          activateEnd: 0,
          activatedAt: 0,
          disposeStart: 0,
          disposeEnd: 0,
        },
      },
      disposed: false,
      disposePromise: null,
      heldHardTokens: new Set(),
      heldSoftTokens: new Set(),
    } as FiberRecord<E>;

    for (const token of record.plugin.requirements?.requires ?? []) {
      this.#graph.addHardConsumer(fiber.id, token.id);
    }
    for (const token of record.plugin.requirements?.optionallyRequires ?? []) {
      this.#graph.addSoftConsumer(fiber.id, token.id);
    }
    fiber.context = this.#createContext(fiber);
    return fiber;
  }

  #fiberHandle(fiber: FiberRecord<E>): FiberHandle {
    return Object.freeze({
      get id() {
        return fiber.id;
      },
      get slotId() {
        return fiber.slotId;
      },
      get pluginId() {
        return fiber.pluginId;
      },
      get state() {
        return fiber.state;
      },
      get parentId() {
        return fiber.parentId;
      },
    });
  }

  #assertFiberCanRegister(fiber: FiberRecord<E>): void {
    this.#assertRunning();
    if (fiber.state === 'unloading' || fiber.state === 'disposed') {
      throw new FiberNotActiveError(fiber.id);
    }
  }

  #assertFiberCanResolve(fiber: FiberRecord<E>): void {
    if (fiber.state === 'disposed') {
      throw new FiberNotActiveError(fiber.id);
    }
  }

  #resolveService(fiber: FiberRecord<E>, token: ServiceToken): unknown {
    if (fiber.state === 'unloading') {
      return this.#services.getResolvable(token);
    }
    return this.#services.getActive(token);
  }

  #createContext(fiber: FiberRecord<E>): Context<PluginConfig, E> {
    return {
      fiber: this.#fiberHandle(fiber),
      config: fiber.record.config,
      signal: fiber.controller.signal,
      require: <T>(token: ServiceToken<T>): T => {
        this.#assertFiberCanResolve(fiber);
        if (
          fiber.state === 'unloading' &&
          !fiber.heldHardTokens.has(token.id)
        ) {
          throw new MissingRequirementsError([token.id]);
        }
        const value = this.#resolveService(fiber, token);
        if (value === undefined) {
          throw new MissingRequirementsError([token.id]);
        }
        if (fiber.state !== 'unloading') {
          this.#graph.addHardConsumer(fiber.id, token.id);
        }
        return value as T;
      },
      try: <T>(token: ServiceToken<T>): T | undefined => {
        this.#assertFiberCanResolve(fiber);
        if (
          fiber.state === 'unloading' &&
          !fiber.heldHardTokens.has(token.id) &&
          !fiber.heldSoftTokens.has(token.id)
        ) {
          return undefined;
        }
        const value = this.#resolveService(fiber, token);
        if (value !== undefined && fiber.state !== 'unloading') {
          this.#graph.addSoftConsumer(fiber.id, token.id);
        }
        return value as T | undefined;
      },
      provide: <T>(token: ServiceToken<T>, implementation: T): void => {
        this.#assertFiberCanRegister(fiber);
        if (this.#services.hasReserved(token)) {
          throw new DuplicateBindingError(token.id);
        }
        this.#services.stage({
          token,
          implementation,
          fiber: this.#fiberHandle(fiber),
        });
        fiber.bindings.add(token.id);
        fiber.scope.add({
          dispose: () => {
            this.#services.withdraw(token, fiber.id);
            fiber.bindings.delete(token.id);
          },
        });
      },
      on: <K extends keyof E & string>(
        type: K,
        handler: (payload: E[K]) => void,
      ): Effect => {
        this.#assertFiberCanRegister(fiber);
        const subscription = this.#bus.on(type, handler);
        const effect: Effect = { dispose: () => subscription.dispose() };
        fiber.subscriptions.add(effect);
        fiber.scope.add(effect);
        return effect;
      },
      effect: (effectOrAcquire: Effect | (() => void | Disposer)): Effect => {
        this.#assertFiberCanRegister(fiber);
        let effect: Effect;
        if (typeof effectOrAcquire === 'function') {
          const disposer = effectOrAcquire();
          effect = {
            dispose: () => {
              if (typeof disposer === 'function') {
                return disposer();
              }
            },
          };
        } else {
          effect = effectOrAcquire;
        }
        fiber.scope.add(effect);
        return effect;
      },
      mount: <C2 extends PluginConfig = PluginConfig>(
        options: ChildMountOptions<C2>,
      ): Promise<PluginSlot<C2>> => {
        this.#assertFiberCanRegister(fiber);
        if (fiber.children.has(options.id)) {
          throw new DuplicateSlotError(options.id);
        }
        const child: SlotRecord<E> = {
          id: options.id,
          plugin: options.plugin as unknown as PluginDefinition<
            PluginConfig,
            E
          >,
          config: options.config ?? {},
          origin: 'child',
          parentId: fiber.id,
          parentFiber: fiber,
          state: 'inactive',
          fiber: null,
          failure: null,
          disposed: false,
          missingDynamicTokens: [],
        };
        fiber.children.set(child.id, child);
        this.#reconciler.requestReconcile();
        return Promise.resolve(this.#publicSlot(child) as PluginSlot<C2>);
      },
      emit: <K extends keyof E & string>(type: K, payload: E[K]): void => {
        this.#assertFiberCanRegister(fiber);
        this.#bus.emit(type, payload);
      },
    };
  }

  async #activateFiber(fiber: FiberRecord<E>): Promise<void> {
    const activateStart = performance.now();
    const activatedAt = Date.now();
    const result = await fiber.record.plugin.activate(fiber.context);
    if (!this.#canCommitActivation(fiber)) {
      this.#services.withdrawAll(fiber.id);
      fiber.bindings.clear();
      if (typeof result === 'function') {
        try {
          await result();
        } catch {
          // Late cleanup failure cannot resurrect or partially commit a fiber.
        }
      }
      throw new FiberNotActiveError(fiber.id);
    }

    this.#services.commit(fiber.id);
    for (const tokenId of fiber.bindings) {
      this.#graph.addProvider(fiber.id, tokenId);
    }
    fiber.state = 'active';
    fiber.diagnostics = {
      timing: {
        activateStart,
        activateEnd: performance.now(),
        activatedAt,
        disposeStart: 0,
        disposeEnd: 0,
      },
    };
    if (typeof result === 'function') {
      fiber.scope.add({ dispose: () => result() });
    }
  }

  #canCommitActivation(fiber: FiberRecord<E>): boolean {
    return (
      !fiber.disposed &&
      !fiber.controller.signal.aborted &&
      this.#state === 'running'
    );
  }
}

function createServiceRegistry(): ServiceRegistry {
  const staged = new Map<string, BindingRecord>();
  const active = new Map<string, BindingRecord>();
  const retiring = new Map<string, BindingRecord>();
  return {
    stage(binding: BindingRecord): void {
      staged.set(binding.token.id, binding);
    },
    commit(fiberId: string): void {
      for (const [tokenId, binding] of [...staged]) {
        if (binding.fiber.id === fiberId) {
          staged.delete(tokenId);
          active.set(tokenId, binding);
        }
      }
    },
    retire(fiberId: string): void {
      for (const [tokenId, binding] of [...active]) {
        if (binding.fiber.id === fiberId) {
          active.delete(tokenId);
          retiring.set(tokenId, binding);
        }
      }
    },
    withdraw(token: ServiceToken, fiberId: string): void {
      const stagedBinding = staged.get(token.id);
      if (stagedBinding !== undefined && stagedBinding.fiber.id === fiberId) {
        staged.delete(token.id);
        return;
      }
      const activeBinding = active.get(token.id);
      if (activeBinding !== undefined && activeBinding.fiber.id === fiberId) {
        active.delete(token.id);
        return;
      }
      const retiringBinding = retiring.get(token.id);
      if (
        retiringBinding !== undefined &&
        retiringBinding.fiber.id === fiberId
      ) {
        retiring.delete(token.id);
      }
    },
    withdrawAll(fiberId: string): void {
      for (const [tokenId, binding] of [...staged]) {
        if (binding.fiber.id === fiberId) {
          staged.delete(tokenId);
        }
      }
      for (const [tokenId, binding] of [...active]) {
        if (binding.fiber.id === fiberId) {
          active.delete(tokenId);
        }
      }
      for (const [tokenId, binding] of [...retiring]) {
        if (binding.fiber.id === fiberId) {
          retiring.delete(tokenId);
        }
      }
    },
    getActive(token: ServiceToken): unknown | undefined {
      return active.get(token.id)?.implementation;
    },
    getActiveById(tokenId: string): unknown | undefined {
      return active.get(tokenId)?.implementation;
    },
    getResolvable(token: ServiceToken): unknown | undefined {
      return (
        active.get(token.id)?.implementation ??
        retiring.get(token.id)?.implementation
      );
    },
    isRetiring(token: ServiceToken): boolean {
      return retiring.has(token.id);
    },
    hasReserved(token: ServiceToken): boolean {
      return (
        staged.has(token.id) || active.has(token.id) || retiring.has(token.id)
      );
    },
    all(): readonly BindingRecord[] {
      return [...active.values()];
    },
    staged(): readonly BindingRecord[] {
      return [...staged.values()];
    },
    retiring(): readonly BindingRecord[] {
      return [...retiring.values()];
    },
  };
}
