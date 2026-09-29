/**
 * Firebase sync error mapping.
 *
 * Every Firestore/Storage failure shape maps onto a stable Froglight
 * code; unknown present/future codes degrade without throwing. The
 * `aborted`-in-CAS case is covered through `compareAndSwapHead` in
 * `sync-remote.spec.ts`.
 */

import { describe, expect, it } from 'vitest';
import { VaultSyncError } from '@froglight/foundation';
import { normalizeFirebaseSyncError } from './sync-errors.js';

describe('normalizeFirebaseSyncError', () => {
  it.each([
    ['unauthenticated', 'NOT_AUTHENTICATED'],
    ['storage/unauthenticated', 'NOT_AUTHENTICATED'],
    ['permission-denied', 'PERMISSION_DENIED'],
    ['storage/unauthorized', 'PERMISSION_DENIED'],
    ['not-found', 'REMOTE_NOT_FOUND'],
    ['storage/object-not-found', 'REMOTE_NOT_FOUND'],
    ['storage/bucket-not-found', 'REMOTE_NOT_FOUND'],
    ['storage/project-not-found', 'REMOTE_NOT_FOUND'],
    ['storage/no-default-bucket', 'NOT_CONFIGURED'],
    ['unavailable', 'NETWORK'],
    ['deadline-exceeded', 'NETWORK'],
    ['storage/retry-limit-exceeded', 'NETWORK'],
    ['storage/server-file-wrong-size', 'NETWORK'],
    ['resource-exhausted', 'QUOTA_EXCEEDED'],
    ['storage/quota-exceeded', 'QUOTA_EXCEEDED'],
    ['storage/invalid-checksum', 'HASH_MISMATCH'],
  ] as const)('maps %s to %s', (code, expected) => {
    const normalized = normalizeFirebaseSyncError({ code, message: code });
    expect(normalized).toBeInstanceOf(VaultSyncError);
    expect(normalized.code).toBe(expected);
  });

  it('maps aborted to REMOTE_CHANGED only inside compare-and-swap', () => {
    expect(
      normalizeFirebaseSyncError(
        { code: 'aborted', message: 'contention' },
        { compareAndSwap: true },
      ).code,
    ).toBe('REMOTE_CHANGED');
    expect(
      normalizeFirebaseSyncError({ code: 'aborted', message: 'contention' })
        .code,
    ).toBe('UNKNOWN');
  });

  it('degrades cancellations, misuse, and unknown codes to UNKNOWN', () => {
    for (const code of [
      'cancelled',
      'storage/canceled',
      'invalid-argument',
      'storage/invalid-argument',
      'failed-precondition',
      'internal',
      'firestore/future-code',
      'storage/future-code',
    ]) {
      expect(normalizeFirebaseSyncError({ code, message: code }).code).toBe(
        'UNKNOWN',
      );
    }
    expect(normalizeFirebaseSyncError(new Error('boom')).code).toBe('UNKNOWN');
    expect(normalizeFirebaseSyncError(null).code).toBe('UNKNOWN');
    expect(normalizeFirebaseSyncError('nope').code).toBe('UNKNOWN');
  });

  it('passes VaultSyncError through unchanged', () => {
    const original = new VaultSyncError('REMOTE_CHANGED', 'race lost');
    expect(normalizeFirebaseSyncError(original)).toBe(original);
  });

  it('preserves the original failure as the cause', () => {
    const failure = { code: 'unavailable', message: 'offline' };
    const normalized = normalizeFirebaseSyncError(failure);
    expect(normalized.cause).toBe(failure);
  });
});
