/**
 * Vault mutation feed.
 *
 * `DocumentSession.onPostCommit()` only sees saved documents, but vault
 * mutations also flow through `write` / `remove` / `move` /
 * `createDirectory` (asset ingestion, settings resources, plugin-managed
 * canonical resources, …). `ObservableVaultService` wraps any concrete
 * local `VaultService`, still satisfies `VaultService` itself, and emits
 * one `VaultMutation` per successful mutation for `VaultSyncService` to
 * coalesce into reconcile requests.
 *
 * Two guarantees make the feed sync-safe:
 *
 * - Failed mutations emit nothing: the event fires only after the inner
 *   operation resolves, so the feed never describes state that does not
 *   exist.
 * - `suppress()` runs remote-apply work without emitting, so
 *   materializing downloaded state can never echo back into an upload.
 *   Suppression nests and always unwinds, even when the work throws.
 */

import type {
  Context,
  EventMap,
  PluginConfig,
  PluginDefinition,
  ServiceToken,
} from '@froglight/runtime';
import type { WorkspacePath } from '../paths.js';
import { vaultToken } from '../tokens.js';
import type {
  VaultCapabilities,
  VaultEntry,
  VaultFile,
  VaultOperationOptions,
  VaultService,
  VaultStat,
} from '../vault/contract.js';

/** One committed local mutation. Paths are validated `WorkspacePath`s. */
export type VaultMutation =
  | { readonly type: 'write'; readonly path: WorkspacePath }
  | { readonly type: 'remove'; readonly path: WorkspacePath }
  | {
      readonly type: 'move';
      readonly from: WorkspacePath;
      readonly to: WorkspacePath;
    }
  | { readonly type: 'mkdir'; readonly path: WorkspacePath };

export type VaultMutationListener = (mutation: VaultMutation) => void;

/**
 * `VaultService` decorator that emits a mutation event per successful
 * mutating operation. Reads (`stat` / `list` / `read` / `readFile`)
 * never emit. Listener failures are contained: one bad listener can
 * neither break the vault operation nor starve later listeners.
 */
export class ObservableVaultService implements VaultService {
  readonly #inner: VaultService;
  readonly #listeners = new Set<VaultMutationListener>();
  #suppressionDepth = 0;
  #silent: VaultService | null = null;

  readonly readFile?: (
    path: WorkspacePath,
    options?: VaultOperationOptions,
  ) => Promise<VaultFile>;

  constructor(inner: VaultService) {
    this.#inner = inner;
    // Preserve capability detection: callers probing `readFile?.()` must
    // see support exactly when the wrapped provider offers it.
    const readFile = inner.readFile?.bind(inner);
    if (readFile !== undefined) {
      this.readFile = readFile;
    }
  }

  /** The wrapped provider used for session-adjacent work. */
  get inner(): VaultService {
    return this.#inner;
  }

  /**
   * A view of the same vault that never emits mutation events. The sync
   * engine runs against this view so downloaded bytes cannot echo back
   * into follow-up uploads — while concurrent user saves through the
   * observable face still emit (and reschedule) normally. Prefer this
   * over `suppress()` for engine I/O: suppression is coarse and would
   * also silence user saves landing mid-reconcile, stranding them until
   * the next trigger.
   */
  get silent(): VaultService {
    if (this.#silent === null) {
      const inner = this.#inner;
      const readFile = inner.readFile?.bind(inner);
      const view: VaultService = {
        get capabilities(): VaultCapabilities {
          return inner.capabilities;
        },
        stat: (path, options) => inner.stat(path, options),
        list: (path, options) => inner.list(path, options),
        createDirectory: (path, options) =>
          inner.createDirectory(path, options),
        read: (path, options) => inner.read(path, options),
        write: (path, data, options) => inner.write(path, data, options),
        remove: (path, options) => inner.remove(path, options),
        move: (from, to, options) => inner.move(from, to, options),
        ...(readFile === undefined ? {} : { readFile }),
      };
      this.#silent = view;
    }
    return this.#silent;
  }

  get capabilities(): VaultCapabilities {
    return this.#inner.capabilities;
  }

  /** True while inside `suppress()` (nesting counts). Exposed for tests. */
  get suppressing(): boolean {
    return this.#suppressionDepth > 0;
  }

  /**
   * Subscribe to committed mutations. Returns an unregister function.
   * No replay: subscribers observe only mutations after subscribing.
   */
  onMutation(listener: VaultMutationListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Run `fn` without emitting mutation events (remote apply).
   * Returns `fn`'s result; rethrows `fn`'s errors after unwinding.
   */
  async suppress<T>(fn: () => T | Promise<T>): Promise<T> {
    this.#suppressionDepth += 1;
    try {
      return await fn();
    } finally {
      this.#suppressionDepth -= 1;
    }
  }

  #emit(mutation: VaultMutation): void {
    if (this.#suppressionDepth > 0) return;
    for (const listener of [...this.#listeners]) {
      try {
        listener(mutation);
      } catch {
        // Listener failures must never break vault operations.
      }
    }
  }

  stat(
    path: WorkspacePath,
    options?: VaultOperationOptions,
  ): Promise<VaultStat> {
    return this.#inner.stat(path, options);
  }

  list(
    path: WorkspacePath,
    options?: VaultOperationOptions,
  ): Promise<readonly VaultEntry[]> {
    return this.#inner.list(path, options);
  }

  async createDirectory(
    path: WorkspacePath,
    options?: VaultOperationOptions,
  ): Promise<void> {
    await this.#inner.createDirectory(path, options);
    this.#emit({ type: 'mkdir', path });
  }

  read(
    path: WorkspacePath,
    options?: VaultOperationOptions,
  ): Promise<Uint8Array> {
    return this.#inner.read(path, options);
  }

  async write(
    path: WorkspacePath,
    data: Uint8Array,
    options?: VaultOperationOptions,
  ): Promise<void> {
    await this.#inner.write(path, data, options);
    this.#emit({ type: 'write', path });
  }

  async remove(
    path: WorkspacePath,
    options?: VaultOperationOptions,
  ): Promise<void> {
    await this.#inner.remove(path, options);
    this.#emit({ type: 'remove', path });
  }

  async move(
    from: WorkspacePath,
    to: WorkspacePath,
    options?: VaultOperationOptions,
  ): Promise<void> {
    await this.#inner.move(from, to, options);
    this.#emit({ type: 'move', from, to });
  }
}

/**
 * Injectable one-shot timer. Foundation ships without DOM/Node libs, so
 * the debounce never touches the `setTimeout` global directly (same
 * pattern as `KeyboardInsetTimer`): hosts and tests run wherever they
 * already run.
 */
export interface SyncSchedulerTimer {
  schedule(task: () => void, delayMs: number): { cancel(): void };
}

type GlobalTimerScope = {
  setTimeout(task: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
};

const globalTimer: SyncSchedulerTimer = {
  schedule(task, delayMs) {
    const scope = globalThis as unknown as GlobalTimerScope;
    const handle = scope.setTimeout(task, delayMs);
    let done = false;
    return {
      cancel: () => {
        if (done) return;
        done = true;
        scope.clearTimeout(handle);
      },
    };
  },
};

/**
 * Narrow an observed vault to its feed, if it has one. Hosts that did
 * not install `withObservableVault` get `null` and may wrap locally —
 * functional for the wrapper's own calls, but blind to writes through
 * the original handle (documented degradation, not silent loss: only
 * the feed is affected, never vault reads or writes).
 */
export function asObservableVault(
  vault: VaultService,
): ObservableVaultService | null {
  return vault instanceof ObservableVaultService ? vault : null;
}

/**
 * Make every vault provided by a plugin definition observable: the
 * `vaultToken` binding becomes an `ObservableVaultService` so all
 * downstream consumers (workspace, sessions, asset ingestion) emit
 * through one feed. Transparent — still a `VaultService` with identical
 * semantics — and idempotent (already-observable providers pass through
 * untouched). The application composition applies this to every vault
 * provider (initial and replacements), so the sync scheduler always
 * observes the same facade the workspace writes through.
 */
export function withObservableVault<
  C extends PluginConfig = PluginConfig,
  E extends EventMap = EventMap,
>(definition: PluginDefinition<C, E>): PluginDefinition<C, E> {
  return {
    ...definition,
    activate: ((ctx: Context<C, E>, ...rest: unknown[]) => {
      const provide = ctx.provide.bind(ctx) as {
        <T>(token: ServiceToken<T>, value: T): void;
      };
      const proxied = new Proxy(ctx, {
        get(target, property) {
          if (property === 'provide') {
            return <T>(token: ServiceToken<T>, value: T): void => {
              if (token === vaultToken) {
                if (value instanceof ObservableVaultService) {
                  provide(token as ServiceToken<VaultService>, value);
                  return;
                }
                provide(
                  token as ServiceToken<VaultService>,
                  new ObservableVaultService(value as VaultService),
                );
                return;
              }
              provide(token, value);
            };
          }
          const current = Reflect.get(target, property, target);
          return typeof current === 'function' ? current.bind(target) : current;
        },
      });
      return (definition.activate as (...args: unknown[]) => unknown)(
        proxied,
        ...rest,
      );
    }) as PluginDefinition<C, E>['activate'],
  };
}

export interface SyncSchedulerOptions {
  /**
   * Coalescing window in milliseconds. Requests arriving inside the
   * window restart it (debounce), so a typing burst schedules one run.
   * Defaults to 0: synchronous bursts still coalesce into one run via
   * microtask deferral, with no added latency.
   */
  readonly debounceMs?: number;
  /** Failures of `run` are reported here; without it they are swallowed. */
  readonly onError?: (error: unknown) => void;
  /** Injectable clock for the debounce window; defaults to global timers. */
  readonly timer?: SyncSchedulerTimer;
}

/**
 * Single-flight reconcile scheduler.
 *
 * - N requests while idle → exactly one run.
 * - Requests arriving mid-run → exactly one follow-up run, never
 *   overlapping executions and never an unbounded task pile-up.
 * - `dispose()` cancels pending work; an in-flight run finishes but
 *   never reschedules.
 */
export class SyncScheduler {
  readonly #run: () => Promise<void>;
  readonly #debounceMs: number;
  readonly #onError?: (error: unknown) => void;
  readonly #timerSource: SyncSchedulerTimer;
  #timer: { cancel(): void } | undefined;
  #scheduled = false;
  #running = false;
  #rerunRequested = false;
  #disposed = false;

  constructor(run: () => Promise<void>, options: SyncSchedulerOptions = {}) {
    this.#run = run;
    const debounceMs = options.debounceMs ?? 0;
    this.#debounceMs =
      Number.isFinite(debounceMs) && debounceMs > 0 ? debounceMs : 0;
    this.#onError = options.onError;
    this.#timerSource = options.timer ?? globalTimer;
  }

  /** True while a run is queued, debouncing, executing, or owed. */
  get pending(): boolean {
    return (
      this.#timer !== undefined ||
      this.#scheduled ||
      this.#running ||
      this.#rerunRequested
    );
  }

  get running(): boolean {
    return this.#running;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  /** Request a run. Coalesced per the class contract; never throws. */
  request(): void {
    if (this.#disposed) return;
    if (this.#running) {
      this.#rerunRequested = true;
      return;
    }
    if (this.#timer !== undefined) {
      this.#timer.cancel();
      this.#timer = undefined;
    }
    if (this.#scheduled) return;
    if (this.#debounceMs > 0) {
      this.#timer = this.#timerSource.schedule(() => {
        this.#timer = undefined;
        void this.#cycle();
      }, this.#debounceMs);
      return;
    }
    this.#scheduled = true;
    // Defer past the current synchronous burst so N back-to-back
    // requests collapse into one run instead of run + rerun.
    void Promise.resolve().then(() => {
      this.#scheduled = false;
      void this.#cycle();
    });
  }

  /**
   * Cancel pending/debounced work. An in-flight run finishes; its
   * completion never schedules follow-up work after disposal.
   */
  dispose(): void {
    this.#disposed = true;
    if (this.#timer !== undefined) {
      this.#timer.cancel();
      this.#timer = undefined;
    }
    this.#scheduled = false;
    this.#rerunRequested = false;
  }

  async #cycle(): Promise<void> {
    if (this.#disposed || this.#running) return;
    this.#running = true;
    try {
      await this.#run();
    } catch (error) {
      try {
        this.#onError?.(error);
      } catch {
        // Error reporting must never break the scheduler.
      }
    } finally {
      this.#running = false;
      if (this.#rerunRequested && !this.#disposed) {
        this.#rerunRequested = false;
        // Requested mid-run: the world changed under the run that just
        // finished, so follow up promptly (no second debounce window).
        void this.#cycle();
      }
    }
  }
}
