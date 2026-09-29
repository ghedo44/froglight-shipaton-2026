/**
 * Shared provider slot-replacement primitive for application composition
 * Every provider replacement enforces the same lifecycle:
 *
 * - remove dependent probe slots before provider slots;
 * - capture becomes null after withdrawal (via `clearCaptures`);
 * - register provider slots before probe slots;
 * - exactly one active registration after replacement;
 * - post-replacement reconciliation/listener hooks run after slots settle
 *   (each `registerSlot` awaits runtime quiescence).
 *
 * Provider-specific plugin construction and after-effects remain
 * callbacks/configuration, not duplicated lifecycle code.
 */

import type { Runtime } from '@froglight/runtime';

export interface SlotReplacement {
  /** Provider slots to withdraw (removed after probes, registered first). */
  readonly providerSlotIds: readonly string[];
  /** Dependent probe slots to withdraw first and re-register last. */
  readonly probeSlotIds?: readonly string[];
  /** Release instance-owned captures after withdrawal. */
  readonly clearCaptures?: () => void;
  /** Register provider slots (called after withdrawal + clear). */
  readonly registerProviders: () => Promise<void>;
  /** Re-register probe slots (called after providers, when present). */
  readonly registerProbes?: () => Promise<void>;
  /** Post-replacement reconciliation/listener hooks (run after settle). */
  readonly afterReplace?: () => Promise<void> | void;
}

/**
 * Execute one provider replacement through the shared lifecycle primitive.
 * `removeSlot` is idempotent for absent slots; `registerSlot` throws on
 * duplicates, so a successful replacement always ends with exactly one
 * active registration per re-registered slot.
 */
export async function replaceSlots(
  runtime: Runtime,
  replacement: SlotReplacement,
): Promise<void> {
  for (const probeId of replacement.probeSlotIds ?? []) {
    await runtime.removeSlot(probeId);
  }
  for (const providerId of replacement.providerSlotIds) {
    await runtime.removeSlot(providerId);
  }
  replacement.clearCaptures?.();
  await replacement.registerProviders();
  await replacement.registerProbes?.();
  await replacement.afterReplace?.();
}
