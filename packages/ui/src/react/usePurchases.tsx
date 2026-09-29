/**
 * React access to the purchase/entitlement capability.
 *
 * Trusted React UI only: components receive the host-owned
 * `PurchaseService` (resolved through the runtime token by the shell) and
 * subscribe to its snapshots. No Tauri, RevenueCat, or StoreKit types
 * enter the presentation layer; prices render from the store-provided
 * localized strings and are never hardcoded.
 */

import { useEffect, useState } from 'react';
import {
  hasFroglightPro,
  type PurchaseService,
  type PurchaseSnapshot,
} from '@froglight/foundation/purchases';

const UNAVAILABLE_SNAPSHOT: PurchaseSnapshot = Object.freeze({
  ready: false,
  loading: false,
  customer: null,
  error: null,
});

export interface PurchaseSnapshotState {
  /** Live snapshot; the frozen unavailable value when no service exists. */
  readonly snapshot: PurchaseSnapshot;
  /** Best-effort refresh (re-seed from the host); resolves when settled. */
  readonly reload: () => Promise<void>;
}

/**
 * Live purchase state for one service instance. Subscribes first, then
 * refreshes, closing the render/effect race the same way the keyboard
 * hook does. A `null` service (hosts without a provider, e.g. web today)
 * yields the unavailable snapshot and a no-op reload.
 */
export function usePurchaseSnapshot(
  service: PurchaseService | null,
): PurchaseSnapshotState {
  const [snapshot, setSnapshot] = useState<PurchaseSnapshot>(() =>
    service === null ? UNAVAILABLE_SNAPSHOT : service.snapshot(),
  );

  useEffect(() => {
    if (service === null) {
      setSnapshot(UNAVAILABLE_SNAPSHOT);
      return;
    }
    const off = service.subscribe(setSnapshot);
    // Fresh prices matter on a paywall: reseed on mount. Failures land in
    // the snapshot error (rendered with recovery), never as a throw.
    void service.refresh().catch(() => undefined);
    setSnapshot(service.snapshot());
    return off;
  }, [service]);

  if (service === null) {
    return { snapshot: UNAVAILABLE_SNAPSHOT, reload: async () => undefined };
  }
  return {
    snapshot,
    reload: async () => {
      try {
        await service.refresh();
      } catch {
        // Snapshot carries the error; callers render it with recovery.
      }
    },
  };
}

/**
 * Application policy hook: does the current customer hold Froglight Pro?
 * The only sanctioned Pro check for React — never scatter
 * `activeEntitlementIds.includes('pro')` through components.
 */
export function useFroglightPro(service: PurchaseService | null): boolean {
  const { snapshot } = usePurchaseSnapshot(service);
  return hasFroglightPro(snapshot.customer);
}
