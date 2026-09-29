/**
 * Account ↔ purchase identity coordinator contract.
 *
 * One identity only: the Firebase Auth UID is the Froglight
 * account ID and must become the RevenueCat App User ID before any
 * account-bound purchase or sync. This capability owns that binding:
 * it observes `AccountService` and drives `PurchaseService.identify` /
 * `clearIdentity` in the mandated order, and it owns the ordered
 * sign-out that dismantles cloud authority without touching local vaults.
 *
 * Host- and framework-free like every other foundation capability.
 */

import type { AccountError } from '../account/errors.js';
import type { PurchaseError } from '../purchases/errors.js';

export interface AccountIdentitySnapshot {
  /** Last UID successfully bound as the RevenueCat App User ID. */
  readonly identifiedUid: string | null;
  readonly pending: boolean;
  readonly error: AccountError | PurchaseError | null;
}

export type AccountIdentitySnapshotListener = (
  snapshot: AccountIdentitySnapshot,
) => void;

/**
 * Stable identity-binding service behind `accountIdentityToken`
 * (`froglight.account-identity`). Bound to live `AccountService` and
 * `PurchaseService` instances by its runtime definition; every binding
 * operation is serialized so rapid identity replacement (A → B →
 * sign-out) cannot interleave.
 */
export interface AccountIdentityService {
  snapshot(): AccountIdentitySnapshot;
  /** Subscribe to every snapshot change; returns an unregister function. */
  subscribe(listener: AccountIdentitySnapshotListener): () => void;
  /**
   * Ensure the RevenueCat identity matches the signed-in Firebase UID,
   * identifying and refreshing purchase state when stale. Throws
   * `UNAUTHENTICATED` when signed out. Account-bound purchase/sync flows
   * must await this before starting a paid subscription.
   */
  ensureAccountIdentity(): Promise<void>;
  /**
   * Ordered sign-out:
   *
   * ```text
   * sync teardown hook (VaultSyncService lands in a later slice)
   *   → PurchaseService.clearIdentity()
   *   → Firebase Auth signOut (through AccountService)
   * ```
   *
   * Local vaults and canonical data are never deleted or unlinked.
   */
  signOut(): Promise<void>;
}
