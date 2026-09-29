/**
 * Firebase Auth error normalization.
 *
 * Every stable `auth/...` code maps onto a Froglight-owned account code;
 * unknown present/future codes and non-Firebase values degrade to
 * `UNKNOWN` without throwing.
 */

import { describe, expect, it } from 'vitest';
import { AccountError } from '@froglight/foundation/account';
import { normalizeFirebaseAuthError } from './errors.js';

describe('normalizeFirebaseAuthError', () => {
  it.each([
    ['auth/email-already-in-use', 'EMAIL_IN_USE'],
    ['auth/invalid-email', 'INVALID_EMAIL'],
    ['auth/weak-password', 'INVALID_PASSWORD'],
    ['auth/user-not-found', 'USER_NOT_FOUND'],
    ['auth/wrong-password', 'WRONG_PASSWORD'],
    ['auth/invalid-credential', 'UNAUTHENTICATED'],
    ['auth/user-disabled', 'UNAUTHENTICATED'],
    ['auth/network-request-failed', 'NETWORK'],
    ['auth/operation-not-allowed', 'NOT_CONFIGURED'],
  ] as const)('maps %s to %s', (code, expected) => {
    const normalized = normalizeFirebaseAuthError({ code, message: code });
    expect(normalized).toBeInstanceOf(AccountError);
    expect(normalized.code).toBe(expected);
  });

  it('degrades unknown codes and values to UNKNOWN', () => {
    expect(
      normalizeFirebaseAuthError({ code: 'auth/future-code', message: 'x' })
        .code,
    ).toBe('UNKNOWN');
    expect(normalizeFirebaseAuthError(new Error('boom')).code).toBe('UNKNOWN');
    expect(normalizeFirebaseAuthError(null).code).toBe('UNKNOWN');
  });

  it('passes AccountError through unchanged', () => {
    const original = new AccountError('NETWORK', 'offline');
    expect(normalizeFirebaseAuthError(original)).toBe(original);
  });
});
