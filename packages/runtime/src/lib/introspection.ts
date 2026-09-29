/**
 * Runtime introspection: the inspectable surface the runtime exposes so
 * developer tooling and tests can assert active fibers, services, effects,
 * and event subscriptions without depending on hidden implementation detail.
 *
 * Snapshots are read-only views: they are computed on demand and never
 * expose mutable graph internals.
 */

import type { BindingRecord } from './services.js';
import type { SubscriptionRecord } from './events.js';
import type { FiberSnapshot, RuntimeState, SlotSnapshot } from './types.js';

/** Counts of runtime-owned resources. */
export interface RuntimeCounts {
  readonly slots: number;
  readonly activeFibers: number;
  /** Committed (active) bindings; retiring bindings are not counted. */
  readonly bindings: number;
  readonly subscriptions: number;
  /** Total owned effects across active fibers. */
  readonly effects: number;
}

/**
 * Full runtime introspection snapshot. Answers "why" questions:
 *
 * - `runtimeState` — is the runtime disposing?
 * - `slots[].missingRequirements` — why is this slot inactive?
 * - `retiringBindings` — which providers are being torn down?
 * - `fibers[].hardRequiredTokens` / `softRequiredTokens` — which hard
 *   dependency blocks this activation? Which fibers depend on a provider,
 *   and is the dependency hard or optional?
 * - `graphCycles` — which dependency cycles exist (SCC groups)?
 */
export interface RuntimeIntrospection {
  readonly runtimeState: RuntimeState;
  readonly counts: RuntimeCounts;
  readonly slots: readonly SlotSnapshot[];
  readonly fibers: readonly FiberSnapshot[];
  /** Active (committed) bindings. */
  readonly bindings: readonly BindingRecord[];
  /** Retiring bindings: resolvable by existing consumers, not by new ones. */
  readonly retiringBindings: readonly BindingRecord[];
  readonly subscriptions: readonly SubscriptionRecord[];
  /** Dependency cycles (SCC groups of fiber ids); empty when acyclic. */
  readonly graphCycles: readonly (readonly string[])[];
}

/**
 * Compute a snapshot of the runtime's current state. `fiberSnapshots`,
 * `bindingRecords`, `retiringBindingRecords`, and `subscriptionRecords` are
 * provided by the runtime core; this function shapes them into the public
 * introspection view.
 */
export function buildIntrospection(input: {
  readonly runtimeState: RuntimeState;
  readonly slots: readonly SlotSnapshot[];
  readonly fiberSnapshots: readonly FiberSnapshot[];
  readonly bindingRecords: readonly BindingRecord[];
  readonly retiringBindingRecords: readonly BindingRecord[];
  readonly subscriptionRecords: readonly SubscriptionRecord[];
  readonly graphCycles: readonly (readonly string[])[];
}): RuntimeIntrospection {
  const {
    runtimeState,
    slots,
    fiberSnapshots,
    bindingRecords,
    retiringBindingRecords,
    subscriptionRecords,
    graphCycles,
  } = input;
  const activeFibers = fiberSnapshots.filter((f) => f.state !== 'disposed');
  const effects = fiberSnapshots.reduce(
    (sum, f) => sum + (f.state === 'disposed' ? 0 : f.effectCount),
    0,
  );
  return {
    runtimeState,
    counts: {
      slots: slots.length,
      activeFibers: activeFibers.length,
      bindings: bindingRecords.length,
      subscriptions: subscriptionRecords.length,
      effects,
    },
    slots,
    fibers: fiberSnapshots,
    bindings: bindingRecords,
    retiringBindings: retiringBindingRecords,
    subscriptions: subscriptionRecords,
    graphCycles,
  };
}
