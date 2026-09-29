/**
 * Vault sync error contract.
 *
 * Stable Froglight-owned codes for the sync protocol. Providers translate
 * SDK errors into these codes at their boundary; shared
 * consumers and UI match on `code` and never parse raw Firebase error
 * strings.
 */

export type VaultSyncErrorCode =
  | 'NOT_CONFIGURED'
  | 'NOT_AUTHENTICATED'
  | 'PRO_REQUIRED'
  | 'ENTITLEMENT_PENDING'
  | 'NETWORK'
  | 'REMOTE_NOT_FOUND'
  | 'REMOTE_CHANGED'
  | 'LOCAL_CHANGED'
  | 'ACCOUNT_CHANGED'
  | 'CONFLICT'
  | 'CORRUPT_MANIFEST'
  | 'CORRUPT_SYNC_METADATA'
  | 'REMATERIALIZE_REQUIRED'
  | 'HASH_MISMATCH'
  | 'QUOTA_EXCEEDED'
  | 'PERMISSION_DENIED'
  | 'UNSUPPORTED'
  | 'UNKNOWN';

const KNOWN_SYNC_ERROR_CODES: ReadonlySet<string> = new Set([
  'NOT_CONFIGURED',
  'NOT_AUTHENTICATED',
  'PRO_REQUIRED',
  'ENTITLEMENT_PENDING',
  'NETWORK',
  'REMOTE_NOT_FOUND',
  'REMOTE_CHANGED',
  'LOCAL_CHANGED',
  'ACCOUNT_CHANGED',
  'CONFLICT',
  'CORRUPT_MANIFEST',
  'CORRUPT_SYNC_METADATA',
  'REMATERIALIZE_REQUIRED',
  'HASH_MISMATCH',
  'QUOTA_EXCEEDED',
  'PERMISSION_DENIED',
  'UNSUPPORTED',
  'UNKNOWN',
]);

export function isVaultSyncErrorCode(
  value: unknown,
): value is VaultSyncErrorCode {
  return typeof value === 'string' && KNOWN_SYNC_ERROR_CODES.has(value);
}

/** Stable sync failure with a machine-readable code. */
export class VaultSyncError extends Error {
  readonly code: VaultSyncErrorCode;
  constructor(
    code: VaultSyncErrorCode,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = 'VaultSyncError';
    this.code = code;
  }
}

export function isVaultSyncError(error: unknown): error is VaultSyncError {
  return error instanceof VaultSyncError;
}

/**
 * Normalize an unknown thrown value into a `VaultSyncError`.
 *
 * Existing `VaultSyncError`s pass through unchanged. Objects carrying a
 * known `code` string (for example decoded provider payloads) keep that
 * code with a coerced message. Everything else becomes `UNKNOWN` with
 * the original value preserved as the cause. Never throws.
 */
export function normalizeSyncError(error: unknown): VaultSyncError {
  if (error instanceof VaultSyncError) return error;
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>;
    if (isVaultSyncErrorCode(record.code)) {
      const message =
        typeof record.message === 'string' && record.message.length > 0
          ? record.message
          : 'vault sync failed';
      return new VaultSyncError(record.code, message, { cause: error });
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return new VaultSyncError(
    'UNKNOWN',
    message.length > 0 ? message : 'vault sync failed',
    { cause: error },
  );
}
