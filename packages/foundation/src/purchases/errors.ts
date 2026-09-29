/**
 * Purchase/entitlement error contract.
 *
 * Host- and framework-free: no Tauri, RevenueCat, StoreKit, or DOM types
 * leak into this surface. Native providers translate SDK errors into these
 * stable codes at the DTO boundary; shared consumers match on `code` and
 * never parse messages. User cancellation is not an error and never
 * produces a `PurchaseError` — transports report it through the
 * cancelled purchase result instead.
 */

export type PurchaseErrorCode =
  | 'NOT_CONFIGURED'
  | 'NETWORK'
  | 'STORE_UNAVAILABLE'
  | 'PRODUCT_UNAVAILABLE'
  | 'PURCHASE_NOT_ALLOWED'
  | 'INVALID_OFFERING'
  | 'INVALID_PACKAGE'
  | 'RECEIPT_INVALID'
  | 'CONFIGURATION'
  | 'UNSUPPORTED'
  | 'UNKNOWN';

const KNOWN_PURCHASE_ERROR_CODES: ReadonlySet<string> = new Set([
  'NOT_CONFIGURED',
  'NETWORK',
  'STORE_UNAVAILABLE',
  'PRODUCT_UNAVAILABLE',
  'PURCHASE_NOT_ALLOWED',
  'INVALID_OFFERING',
  'INVALID_PACKAGE',
  'RECEIPT_INVALID',
  'CONFIGURATION',
  'UNSUPPORTED',
  'UNKNOWN',
]);

export function isPurchaseErrorCode(value: unknown): value is PurchaseErrorCode {
  return typeof value === 'string' && KNOWN_PURCHASE_ERROR_CODES.has(value);
}

/** Stable purchase failure with a machine-readable code. */
export class PurchaseError extends Error {
  readonly code: PurchaseErrorCode;
  constructor(code: PurchaseErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'PurchaseError';
    this.code = code;
  }
}

export function isPurchaseError(error: unknown): error is PurchaseError {
  return error instanceof PurchaseError;
}

/**
 * Normalize an unknown thrown value into a `PurchaseError`.
 *
 * Existing `PurchaseError`s pass through unchanged. Objects carrying a
 * known `code` string (for example decoded native payloads) keep that
 * code with a coerced message. Everything else becomes `UNKNOWN` with
 * the original value preserved as the cause. Never throws.
 */
export function normalizePurchaseError(error: unknown): PurchaseError {
  if (error instanceof PurchaseError) return error;
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>;
    if (isPurchaseErrorCode(record.code)) {
      const message =
        typeof record.message === 'string' && record.message.length > 0
          ? record.message
          : 'purchase request failed';
      return new PurchaseError(record.code, message, { cause: error });
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return new PurchaseError('UNKNOWN', message.length > 0 ? message : 'purchase request failed', {
    cause: error,
  });
}
