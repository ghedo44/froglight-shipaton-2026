/**
 * Firebase Auth error normalization.
 *
 * The Firebase SDK throws `FirebaseError`-shaped values carrying a stable
 * `code` string (`auth/...`). This module is the single place that maps
 * those codes onto Froglight-owned `AccountError` codes; shared consumers
 * match on `code` and never parse Firebase messages. Unknown present and
 * future codes degrade to `UNKNOWN` with the original value preserved as
 * the cause.
 */

import { AccountError, normalizeAccountError } from '@froglight/foundation';

function readCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as Record<string, unknown>).code;
  return typeof code === 'string' ? code : null;
}

/**
 * Map a Firebase Auth error code onto a Froglight account error. Never
 * throws; unknown codes become `UNKNOWN`.
 */
export function normalizeFirebaseAuthError(error: unknown): AccountError {
  if (error instanceof AccountError) return error;
  switch (readCode(error)) {
    case 'auth/email-already-in-use':
      return new AccountError(
        'EMAIL_IN_USE',
        'that email is already registered',
        {
          cause: error,
        },
      );
    case 'auth/invalid-email':
      return new AccountError(
        'INVALID_EMAIL',
        'a valid email address is required',
        {
          cause: error,
        },
      );
    case 'auth/weak-password':
      return new AccountError(
        'INVALID_PASSWORD',
        'password must be at least 6 characters',
        { cause: error },
      );
    case 'auth/user-not-found':
      return new AccountError(
        'USER_NOT_FOUND',
        'no account exists for that email',
        {
          cause: error,
        },
      );
    case 'auth/wrong-password':
      return new AccountError('WRONG_PASSWORD', 'the password is incorrect', {
        cause: error,
      });
    case 'auth/invalid-credential':
      // Since Firebase collapsed wrong-password/user-not-found into one
      // anti-enumeration code, report it without claiming which half failed.
      return new AccountError(
        'UNAUTHENTICATED',
        'the email or password is incorrect',
        { cause: error },
      );
    case 'auth/user-disabled':
      return new AccountError(
        'UNAUTHENTICATED',
        'that account has been disabled',
        {
          cause: error,
        },
      );
    case 'auth/network-request-failed':
      return new AccountError('NETWORK', 'the network request failed', {
        cause: error,
      });
    case 'auth/operation-not-allowed':
      // Email/password sign-in is disabled in the Firebase console: a
      // backend-setup problem, not a user-credential problem.
      return new AccountError(
        'NOT_CONFIGURED',
        'email/password sign-in is not enabled for this project',
        { cause: error },
      );
    default:
      return normalizeAccountError(error);
  }
}
