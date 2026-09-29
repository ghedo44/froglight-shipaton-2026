/**
 * Smoke tests for the OPFS provider that run in Node without a browser.
 *
 * The real browser contract suite runs via Playwright (Chromium) against
 * `navigator.storage.getDirectory()`. This file keeps `provider-opfs:test`
 * (Vitest) green in CI and covers the pure-JS parts of the provider:
 * `mapOpfsError` translation and `OpfsVault.create` validation.
 * No DOM FileSystemHandle is created here — browser code is in `tests/`.
 */

import { describe, expect, it } from 'vitest';
import { VaultError } from '@froglight/foundation';
import { isDomException, mapOpfsError } from './error-map.js';
import { OpfsVault } from './opfs-vault.js';

describe('mapOpfsError', () => {
  it('maps NotFoundError → NOT_FOUND', () => {
    const err = new DOMException('missing', 'NotFoundError');
    const mapped = mapOpfsError(err, '' as never);
    expect(mapped).toBeInstanceOf(VaultError);
    expect(mapped.code).toBe('NOT_FOUND');
  });

  it('maps TypeMismatchError → NOT_DIRECTORY', () => {
    const err = new DOMException('not a dir', 'TypeMismatchError');
    expect(mapOpfsError(err, '' as never).code).toBe('NOT_DIRECTORY');
  });

  it('maps InvalidStateError → CONFLICT', () => {
    const err = new DOMException('busy', 'InvalidStateError');
    expect(mapOpfsError(err, '' as never).code).toBe('CONFLICT');
  });

  it('maps QuotaExceededError → QUOTA_EXCEEDED', () => {
    const err = new DOMException('quota', 'QuotaExceededError');
    expect(mapOpfsError(err, '' as never).code).toBe('QUOTA_EXCEEDED');
  });

  it('maps NotAllowedError → PERMISSION_DENIED', () => {
    const err = new DOMException('denied', 'NotAllowedError');
    expect(mapOpfsError(err, '' as never).code).toBe('PERMISSION_DENIED');
  });

  it('maps unknown DOM name → IO', () => {
    const err = new DOMException('weird', 'UnknownError');
    expect(mapOpfsError(err, '' as never).code).toBe('IO');
  });

  it('maps non-DOM throw → IO and preserves cause', () => {
    const cause = new Error('boom');
    const mapped = mapOpfsError(cause, '' as never);
    expect(mapped.code).toBe('IO');
    expect(mapped.cause).toBe(cause);
  });
});

describe('isDomException', () => {
  it('recognizes matching name', () => {
    expect(isDomException(new DOMException('x', 'NotFoundError'), 'NotFoundError')).toBe(true);
  });

  it('rejects non-matching name', () => {
    expect(isDomException(new DOMException('x', 'NotFoundError'), 'TypeMismatchError')).toBe(false);
  });

  it('rejects plain Error', () => {
    expect(isDomException(new Error('x'), 'NotFoundError')).toBe(false);
  });

  it('handles object with name field', () => {
    expect(isDomException({ name: 'NotFoundError' }, 'NotFoundError')).toBe(true);
  });
});

describe('OpfsVault.create validation (no browser needed)', () => {
  it('rejects missing root', async () => {
    await expect(OpfsVault.create({ root: null as never })).rejects.toMatchObject({
      code: 'INVALID_PATH',
    });
  });

  it('rejects root without getDirectoryHandle', async () => {
    await expect(OpfsVault.create({ root: {} as never })).rejects.toMatchObject({
      code: 'INVALID_PATH',
    });
  });

  it('creates with a minimal directory handle stub and reports honest capabilities', async () => {
    const stub = {
      getDirectoryHandle: async () => stub,
      getFileHandle: async () => {
        throw new DOMException('missing', 'NotFoundError');
      },
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      removeEntry: async () => {},
      // entries() is accessed via Symbol.asyncIterator or .entries()
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      [Symbol.asyncIterator]: async function* () {},
    } as unknown as FileSystemDirectoryHandle;
    const vault = await OpfsVault.create({ root: stub });
    expect(vault.capabilities).toMatchObject({
      atomicReplace: true,
      supportsMove: true,
      supportsReopen: true,
    });
    expect(['sensitive', 'insensitive']).toContain(vault.capabilities.caseSensitivity);
  });

  it('defaults to nfc normalization and durableFlush unknown', async () => {
    const stub = {
      getDirectoryHandle: async () => stub,
      getFileHandle: async () => {
        throw new DOMException('missing', 'NotFoundError');
      },
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      removeEntry: async () => {},
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      [Symbol.asyncIterator]: async function* () {},
    } as unknown as FileSystemDirectoryHandle;
    const vault = await OpfsVault.create({ root: stub });
    expect(vault.capabilities.nameNormalization).toBe('nfc');
    expect(vault.capabilities.durableFlush).toBe('unknown');
  });
});
