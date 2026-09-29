/**
 * Firebase sync error normalization.
 *
 * Firestore throws `FirebaseError`-shaped values with bare codes
 * (`permission-denied`, …); Storage prefixes its domain
 * (`storage/object-not-found`, …). This module is the single place that
 * maps those codes onto Froglight-owned `VaultSyncError` codes; shared
 * consumers and UI match on `code` and never parse Firebase messages or
 * raw SDK strings.
 *
 * Two deliberate mappings deserve a callout:
 *
 * - `aborted` inside a HEAD compare-and-swap means another writer won
 *  the transaction race, so it becomes `REMOTE_CHANGED`.
 *   Anywhere else it is an unexpected failure (`UNKNOWN`).
 * - `storage/no-default-bucket` means the backend was never provisioned
 *  so it becomes `NOT_CONFIGURED`, not `REMOTE_NOT_FOUND`.
 *
 * A denied write with a signed-in user almost always means the trusted
 * Pro claim is missing or stale — but the provider cannot distinguish
 * that from a wrong-UID path, so it reports neutral `PERMISSION_DENIED`
 * and leaves claim inspection/refresh to entitlement handling.
 */

import { VaultSyncError, normalizeSyncError } from '@froglight/foundation';

function readCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as Record<string, unknown>).code;
  return typeof code === 'string' ? code : null;
}

export interface NormalizeFirebaseSyncErrorOptions {
  /**
   * Set when normalizing a compare-and-swap failure: transaction
   * contention (`aborted`) means the HEAD moved under us.
   */
  readonly compareAndSwap?: boolean;
}

/**
 * Map a Firestore/Storage SDK failure onto a Froglight sync error. Never
 * throws; unknown present and future codes become `UNKNOWN` with the
 * original value preserved as the cause.
 */
export function normalizeFirebaseSyncError(
  error: unknown,
  options: NormalizeFirebaseSyncErrorOptions = {},
): VaultSyncError {
  if (error instanceof VaultSyncError) return error;
  switch (readCode(error)) {
    case 'unauthenticated':
    case 'storage/unauthenticated':
      return new VaultSyncError('NOT_AUTHENTICATED', 'sign in before syncing', {
        cause: error,
      });
    case 'permission-denied':
    case 'storage/unauthorized':
      // Signed-in callers pass the uid gate in sync-remote.ts, so this is
      // a Security Rules denial: most often a missing/stale Pro claim
      // (entitlement handling refreshes it), never something a retry alone fixes.
      return new VaultSyncError(
        'PERMISSION_DENIED',
        'Firebase Security Rules denied the sync request',
        { cause: error },
      );
    case 'not-found':
    case 'storage/object-not-found':
    case 'storage/bucket-not-found':
    case 'storage/project-not-found':
      return new VaultSyncError(
        'REMOTE_NOT_FOUND',
        'the cloud vault object does not exist',
        { cause: error },
      );
    case 'storage/no-default-bucket':
      return new VaultSyncError(
        'NOT_CONFIGURED',
        'no Firebase Storage bucket is provisioned for this project',
        { cause: error },
      );
    case 'unavailable':
    case 'deadline-exceeded':
    case 'storage/retry-limit-exceeded':
      return new VaultSyncError(
        'NETWORK',
        'the sync request did not reach Firebase',
        { cause: error },
      );
    case 'storage/server-file-wrong-size':
      return new VaultSyncError(
        'NETWORK',
        'the upload landed incompletely; retry the sync',
        { cause: error },
      );
    case 'aborted':
      if (options.compareAndSwap === true) {
        return new VaultSyncError(
          'REMOTE_CHANGED',
          'another device committed first; reload and retry',
          { cause: error },
        );
      }
      return normalizeSyncError(error);
    case 'resource-exhausted':
    case 'storage/quota-exceeded':
      return new VaultSyncError(
        'QUOTA_EXCEEDED',
        'the Firebase quota or sync size limit was exceeded',
        { cause: error },
      );
    case 'storage/invalid-checksum':
      return new VaultSyncError(
        'HASH_MISMATCH',
        'Firebase reported a checksum mismatch for the object',
        { cause: error },
      );
    default:
      return normalizeSyncError(error);
  }
}
