/**
 * React access to the vault sync capability.
 *
 * Trusted React UI only: components receive the host-owned
 * `VaultSyncService` (resolved through the runtime token by the shell)
 * and subscribe to its snapshots. No Firebase, Firestore, or Storage
 * types enter the presentation layer; sync failures render from stable
 * `VaultSyncError` codes and the explicit `waiting-for-entitlement`
 * phase — never as purchase errors.
 */

import { useEffect, useState } from 'react';
import type {
  VaultSyncService,
  VaultSyncSnapshot,
} from '@froglight/foundation';

const DETACHED_SNAPSHOT: VaultSyncSnapshot = Object.freeze({
  enabled: false,
  phase: 'idle',
  binding: null,
  bindings: [],
  activeLocalVaultId: null,
  pendingChanges: 0,
  lastSyncedAt: null,
  lastRevision: null,
  deferredPaths: [],
  conflicts: [],
  error: null,
});

export interface VaultSyncSnapshotState {
  /** Live snapshot; the frozen detached value when no service exists. */
  readonly snapshot: VaultSyncSnapshot;
}

/**
 * Live sync state for one service instance. Subscribes first, then reads,
 * closing the render/effect race the same way the account/purchase hooks
 * do. A `null` service (host without the sync slot) yields the detached
 * snapshot; the section renders sync as unavailable.
 */
export function useVaultSyncSnapshot(
  service: VaultSyncService | null,
): VaultSyncSnapshotState {
  const [snapshot, setSnapshot] = useState<VaultSyncSnapshot>(() =>
    service === null ? DETACHED_SNAPSHOT : service.snapshot(),
  );

  useEffect(() => {
    if (service === null) {
      setSnapshot(DETACHED_SNAPSHOT);
      return;
    }
    const off = service.subscribe(setSnapshot);
    setSnapshot(service.snapshot());
    return off;
  }, [service]);

  if (service === null) {
    return { snapshot: DETACHED_SNAPSHOT };
  }
  return { snapshot };
}
