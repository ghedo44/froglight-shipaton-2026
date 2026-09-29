/**
 * React access to the account identity capability.
 *
 * Trusted React UI only: components receive the host-owned
 * `AccountService` (resolved through the runtime token by the shell) and
 * subscribe to its snapshots. No Firebase, Auth, or DOM-storage types
 * enter the presentation layer; failures render from stable
 * `AccountError` codes.
 */

import { useEffect, useState } from 'react';
import type {
  AccountService,
  AccountSnapshot,
} from '@froglight/foundation/account';

const SIGNED_OUT_SNAPSHOT: AccountSnapshot = Object.freeze({
  ready: false,
  loading: false,
  user: null,
  error: null,
});

export interface AccountSnapshotState {
  /** Live snapshot; the frozen signed-out value when no service exists. */
  readonly snapshot: AccountSnapshot;
}

/**
 * Live account state for one service instance. Subscribes first, then
 * reads, closing the render/effect race the same way the purchase hook
 * does. A `null` service (unconfigured host) yields the signed-out
 * snapshot; the section renders the local-only state.
 */
export function useAccountSnapshot(
  service: AccountService | null,
): AccountSnapshotState {
  const [snapshot, setSnapshot] = useState<AccountSnapshot>(() =>
    service === null ? SIGNED_OUT_SNAPSHOT : service.snapshot(),
  );

  useEffect(() => {
    if (service === null) {
      setSnapshot(SIGNED_OUT_SNAPSHOT);
      return;
    }
    const off = service.subscribe(setSnapshot);
    setSnapshot(service.snapshot());
    return off;
  }, [service]);

  if (service === null) {
    return { snapshot: SIGNED_OUT_SNAPSHOT };
  }
  return { snapshot };
}
