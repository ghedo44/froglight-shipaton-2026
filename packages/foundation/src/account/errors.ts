/**
 * Account error contract.
 *
 * Host- and framework-free: no Firebase, Firestore, or DOM types leak
 * into this surface. Providers translate SDK errors into these stable
 * codes at the DTO boundary; shared consumers match on `code` and never
 * parse messages or raw provider error strings.
 */

export type AccountErrorCode =
  | 'NOT_CONFIGURED'
  | 'INVALID_EMAIL'
  | 'INVALID_PASSWORD'
  | 'EMAIL_IN_USE'
  | 'USER_NOT_FOUND'
  | 'WRONG_PASSWORD'
  | 'NETWORK'
  | 'UNAUTHENTICATED'
  | 'UNSUPPORTED'
  | 'UNKNOWN';

const KNOWN_ACCOUNT_ERROR_CODES: ReadonlySet<string> = new Set([
  'NOT_CONFIGURED',
  'INVALID_EMAIL',
  'INVALID_PASSWORD',
  'EMAIL_IN_USE',
  'USER_NOT_FOUND',
  'WRONG_PASSWORD',
  'NETWORK',
  'UNAUTHENTICATED',
  'UNSUPPORTED',
  'UNKNOWN',
]);

export function isAccountErrorCode(value: unknown): value is AccountErrorCode {
  return typeof value === 'string' && KNOWN_ACCOUNT_ERROR_CODES.has(value);
}

/** Stable account failure with a machine-readable code. */
export class AccountError extends Error {
  readonly code: AccountErrorCode;
  constructor(
    code: AccountErrorCode,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = 'AccountError';
    this.code = code;
  }
}

export function isAccountError(error: unknown): error is AccountError {
  return error instanceof AccountError;
}

/**
 * Normalize an unknown thrown value into an `AccountError`.
 *
 * Existing `AccountError`s pass through unchanged. Objects carrying a
 * known `code` string (for example decoded provider payloads) keep that
 * code with a coerced message. Everything else becomes `UNKNOWN` with
 * the original value preserved as the cause. Never throws.
 */
export function normalizeAccountError(error: unknown): AccountError {
  if (error instanceof AccountError) return error;
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>;
    if (isAccountErrorCode(record.code)) {
      const message =
        typeof record.message === 'string' && record.message.length > 0
          ? record.message
          : 'account request failed';
      return new AccountError(record.code, message, { cause: error });
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  return new AccountError(
    'UNKNOWN',
    message.length > 0 ? message : 'account request failed',
    {
      cause: error,
    },
  );
}
