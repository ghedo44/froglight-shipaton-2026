/**
 * Core runtime types: plugin definitions, slots, fibers, contexts, and
 * lifecycle state machines.
 *
 * The runtime kernel is generic composition infrastructure. It must not
 * contain product concepts (documents, search, UI, hosts) or host-specific
 * APIs.
 */

import type { ServiceToken } from './services.js';
import type { Effect } from './effects.js';
import type { EventMap } from './events.js';
import type { FiberDiagnostics } from './diagnostics.js';

/**
 * Lifecycle states of the runtime itself.
 *
 * - `running`: accepts new slots and reconciliation activations;
 * - `disposing`: `dispose()` has started; no new fiber may be created and no
 *   new mutations are accepted, but in-flight activations and cleanups may
 *   settle;
 * - `disposed`: every slot is detached; the runtime is permanently closed.
 */
export type RuntimeState = 'running' | 'disposing' | 'disposed';

/**
 * Requirements a plugin declares to be activatable.
 *
 * - `requires` — required services; the plugin stays active only while every
 *   token has an active binding. These are hard dependencies: they
 *   participate in mandatory dependency-safe teardown and are tracked from
 *   the moment the fiber starts loading.
 * - `optionallyRequires` — optional services; the plugin may activate without
 *   them. These are soft dependencies: appearance/disappearance of an
 *   optional dependency does not trigger disposal or reactivation.
 */
export interface PluginRequirements {
  readonly requires?: readonly ServiceToken[];
  readonly optionallyRequires?: readonly ServiceToken[];
}

/**
 * The activation function of a plugin definition. It receives the fiber's
 * scoped context and may return a dispose function that undoes everything it
 * registered. Async activations may resolve to a disposer.
 */
export type Activate<C = PluginConfig, E extends EventMap = EventMap> = (
  ctx: Context<C, E>,
) => ActivateResult | Promise<ActivateResult>;

/**
 * A dispose function returned by an activation. It must undo every effect the
 * activation registered.
 */
export type Disposer = () => void | Promise<void>;

/** The result of a successful activation. */
export type ActivateResult = void | Disposer;

/**
 * Lifecycle states of a fiber. Fibers only exist once activation starts;
 * configured-but-not-active intent is represented by the slot, not by a
 * fiber, so there is no `pending` state.
 */
export type FiberState = 'loading' | 'active' | 'unloading' | 'disposed';

/** Lifecycle states of a slot. */
export type SlotState = 'inactive' | 'activating' | 'active' | 'failed';

/**
 * A failure recorded by the runtime, attributed to a plugin/fiber. The
 * original activation error is always preserved; rollback failures are
 * secondary but never lost.
 */
export interface FailureRecord {
  readonly phase: 'activation';
  /** Human-readable summary of the original error (never parsed). */
  readonly message: string;
  /** The original activation error. */
  readonly error: unknown;
  /** Errors raised while rolling back the failed activation, if any. */
  readonly rollbackErrors: readonly unknown[];
}

/**
 * Configuration presented to a plugin when its fiber activates. The schema is
 * opaque to the runtime; validation belongs to the plugin.
 *
 * The default plugin config type has no known fields, so registering a
 * default-typed plugin without `config` is sound: `ctx.config` offers no
 * field that the runtime could fail to supply.
 */
export type PluginConfig = Readonly<Record<string, unknown>>;

/**
 * The `config` property of slot/mount options. It is optional when the
 * plugin's config type is the default `PluginConfig` (which promises no
 * concrete fields) and required when the plugin declares concrete config
 * fields, so TypeScript can never promise `ctx.config.greeting: string`
 * while the runtime would supply `{}`.
 *
 * A plugin created with `definePlugin<{ greeting: string }>` must be
 * registered with `config: { greeting: ... }`; omitting it is a compile-time
 * error. At runtime the runtime supplies `{}` when config is omitted (JS
 * callers bypass type checks), and the plugin's own validation fails loudly
 * rather than silently misbehaving.
 */
type ConfigProperty<C> = PluginConfig extends C
  ? { readonly config?: C }
  : { readonly config: C };

/** Public shape of `ConfigProperty` (used by slot and mount options). */
export type { ConfigProperty };

/** How a slot was registered. */
export type SlotOrigin = 'root' | 'child';

/**
 * A persistent configured placement of a plugin. The slot survives periods
 * where requirements are unavailable and may produce multiple fibers over its
 * lifetime. Removal is done through the runtime (`removeSlot`) or by
 * disposing the owning parent fiber.
 */
export interface PluginSlot<C = PluginConfig> {
  readonly id: string;
  readonly plugin: PluginDefinition<C>;
  readonly config: C;
  readonly origin: SlotOrigin;
  readonly parentId?: string;
  readonly state: SlotState;
  readonly fiberId: string | null;
  readonly failure: FailureRecord | null;
}

/** A read-only view of a slot for introspection. */
export interface SlotSnapshot {
  readonly id: string;
  readonly pluginId: string;
  readonly state: SlotState;
  readonly parentId: string | null;
  readonly fiberId: string | null;
  readonly config: PluginConfig;
  readonly failure: FailureRecord | null;
  /** Required tokens with no committed binding (why the slot is inactive). */
  readonly missingRequirements: readonly string[];
}

/**
 * A read-only, runtime-safe view of a fiber exposed to plugins. The handle is
 * frozen; lifecycle state is only readable through live getters and can never
 * be mutated by plugin code.
 */
export interface FiberHandle {
  readonly id: string;
  readonly slotId: string;
  readonly pluginId: string;
  readonly state: FiberState;
  readonly parentId: string | null;
}

/** A read-only view of a fiber for introspection. */
export interface FiberSnapshot {
  readonly id: string;
  readonly slotId: string;
  readonly pluginId: string;
  readonly state: FiberState;
  readonly parentId: string | null;
  readonly bindingCount: number;
  readonly listenerCount: number;
  readonly effectCount: number;
  readonly childCount: number;
  /**
   * Token ids this fiber hard-requires (declared `requires` or a successful
   * `ctx.require`). Only hard dependencies participate in mandatory teardown.
   */
  readonly hardRequiredTokens: readonly string[];
  /**
   * Token ids this fiber softly observes (declared `optionallyRequires` or a
   * successful `ctx.try`). Soft dependencies never force teardown.
   */
  readonly softRequiredTokens: readonly string[];
  /** Token ids this fiber provides (committed bindings). */
  readonly providedTokens: readonly string[];
  readonly diagnostics: FiberDiagnostics;
}

/**
 * A plugin definition: reusable activation behavior plus declared
 * requirements. `C` is the configuration type the plugin receives during
 * activation; `E` is the event map its context is typed against.
 */
export interface PluginDefinition<
  C = PluginConfig,
  E extends EventMap = EventMap,
> {
  readonly id: string;
  readonly activate: Activate<C, E>;
  readonly requirements?: PluginRequirements;
}

/**
 * Create a plugin definition with explicit configuration and event types.
 * The runtime treats configuration as opaque; schema validation belongs to
 * the plugin itself.
 */
export function definePlugin<C = PluginConfig, E extends EventMap = EventMap>(
  definition: PluginDefinition<C, E>,
): PluginDefinition<C, E> {
  return definition;
}

/**
 * The scoped API presented to an active fiber for resolving capabilities and
 * registering owned effects.
 *
 * State-producing methods (`provide`, `on`, `effect`, `mount`, `emit`) reject
 * calls from unloading/disposed fibers: a disposed fiber is permanently
 * incapable of registering new runtime state.
 *
 * Resolution methods (`require`, `try`) are also available during cleanup
 * while a fiber is unloading, they resolve active-or-retiring
 * bindings, so cleanup can keep using the services it held — a provider's
 * cleanup never runs before its consumers finish. Resolution during
 * loading/active resolves committed bindings only.
 */
export interface Context<C = PluginConfig, E extends EventMap = EventMap> {
  /** Read-only view of the owning fiber (frozen; never mutable). */
  readonly fiber: FiberHandle;
  /** The slot configuration, typed by the plugin definition. */
  readonly config: C;
  /** Abort signal fired when the fiber is disposed (async cancellation). */
  readonly signal: AbortSignal;
  /**
   * Resolve the committed binding for a required service token. Records a
   * hard dependency edge (participates in mandatory teardown). During
   * cleanup, resolves active-or-retiring bindings without recording edges.
   */
  require<T>(token: ServiceToken<T>): T;
  /**
   * Resolve a committed binding if one is currently active for the token, or
   * `undefined`. Records a soft dependency edge (introspection only; never
   * forces teardown). During cleanup, resolves active-or-retiring bindings
   * without recording edges.
   */
  try<T>(token: ServiceToken<T>): T | undefined;
  /**
   * Reserve a binding owned by this fiber. The binding is staged and only
   * becomes dependency-visible when the activation commits successfully.
   */
  provide<T>(token: ServiceToken<T>, implementation: T): void;
  /** Subscribe to an event owned by this fiber. */
  on<K extends keyof E & string>(
    type: K,
    handler: (payload: E[K]) => void,
  ): Effect;
  /** Register an owned cleanup effect (direct handle form). */
  effect(effect: Effect): Effect;
  /**
   * Register an owned cleanup effect (acquisition form): the resource is
   * created inside the registration call and the returned disposer is owned
   * by the scope, so creation and cleanup ownership are atomic.
   */
  effect(acquire: () => void | Disposer): Effect;
  /**
   * Mount a child plugin scope. Children reconcile independently but cannot
   * outlive their parent fiber.
   */
  mount<C2 extends PluginConfig = PluginConfig>(
    options: ChildMountOptions<C2>,
  ): Promise<PluginSlot<C2>>;
  /** Emit an event into the shared typed event bus. */
  emit<K extends keyof E & string>(type: K, payload: E[K]): void;
}

/**
 * Options for mounting a child plugin scope from within a fiber. `config` is
 * optional for default-typed plugins and required for plugins with concrete
 * config fields (see `ConfigProperty`).
 */
export type ChildMountOptions<C = PluginConfig> = {
  readonly id: string;
  readonly plugin: PluginDefinition<C>;
} & ConfigProperty<C>;
