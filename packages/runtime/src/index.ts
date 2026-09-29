/**
 * Froglight runtime kernel — generic composition infrastructure.
 *
 * Provides plugin definitions, slots, fibers, contexts, typed service
 * tokens, owned bindings, effect scopes, dependency reconciliation, child
 * plugin scopes, a typed broadcast event bus, and runtime introspection.
 * Contains no product or host concepts.
 *
 * The public surface is explicit: internal machinery (the reconciler, the
 * dependency graph, introspection builders) is not exported.
 */

export type {
  PluginDefinition,
  PluginRequirements,
  Activate,
  ActivateResult,
  Disposer,
  PluginSlot,
  SlotSnapshot,
  SlotState,
  SlotOrigin,
  PluginConfig,
  FiberHandle,
  FiberSnapshot,
  FiberState,
  FailureRecord,
  Context,
  ChildMountOptions,
  RuntimeState,
} from './lib/types.js';
export { definePlugin } from './lib/types.js';
export {
  createServiceToken,
  type ServiceToken,
  type BindingRecord,
} from './lib/services.js';
export {
  ServiceProbe,
  createServiceProbe,
  type ServiceProbeOptions,
} from './lib/service-probe.js';
export { EffectScope, type Effect } from './lib/effects.js';
export {
  BroadcastBus,
  type EventBus,
  type EventMap,
  type EventSubscription,
  type SubscriptionRecord,
} from './lib/events.js';
export {
  RuntimeError,
  MissingRequirementsError,
  DuplicateBindingError,
  FiberNotActiveError,
  DuplicateSlotError,
  RuntimeDisposedError,
  EffectScopeDisposedError,
  AggregateRuntimeError,
  asError,
} from './lib/errors.js';
export type { FiberDiagnostics, FiberTiming } from './lib/diagnostics.js';
export { Runtime, type RootSlotOptions } from './lib/runtime.js';
export type {
  RuntimeIntrospection,
  RuntimeCounts,
} from './lib/introspection.js';
