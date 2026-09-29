import { parseStoredSyncState } from './persisted-state.js';
/**
 * Persisted numeric validation.
 *
 * `lastRevision` must be null or a safe non-negative integer; prepared
 * `owner.identityGeneration` must be a safe non-negative integer; manifest
 * numerics already enforce safe integers. `typeof === 'number'` alone is
 * insufficient (NaN/Infinity/negatives/fractions/unsafe integers degrade
 * the envelope instead of persisting corrupt progress).
 */

import { describe, expect, it } from 'vitest';
import {
} from './service.js';
import { parseSyncManifest, parseRemoteHead } from './manifest.js';
import { SYNC_MANIFEST_FORMAT, SYNC_PROTOCOL_VERSION } from './contract.js';

function binding(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    cloudVaultId: 'cloud-1',
    localVaultId: 'local-1',
    name: 'V',
    deviceId: 'device-1',
    base: null,
    lastSyncedAt: null,
    lastRevision: 3,
    enabled: true,
    ...overrides,
  };
}

function storedWithRevision(revision: unknown): unknown {
  return {
    version: 1,
    deviceId: 'device-1',
    accounts: {
      'uid-a': {
        bindings: { 'local-1': binding({ lastRevision: revision }) },
        activeLocalVaultId: 'local-1',
      },
    },
  };
}

describe('persisted lastRevision validation', () => {
  it.each([0, 1, 42, Number.MAX_SAFE_INTEGER])(
    'accepts safe non-negative integer %s',
    (revision) => {
      expect(parseStoredSyncState(storedWithRevision(revision))).not.toBeNull();
    },
  );

  it.each([
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['negative', -1],
    ['fraction', 1.5],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
    ['string', '3'],
    ['missing becomes undefined', undefined],
  ])('rejects %s', (_label, revision) => {
    expect(parseStoredSyncState(storedWithRevision(revision))).toBeNull();
  });

});

describe('manifest numeric validation (safe integers)', () => {
  function manifestWith(revision: unknown): unknown {
    return {
      format: SYNC_MANIFEST_FORMAT,
      version: SYNC_PROTOCOL_VERSION,
      vaultId: 'vault-1',
      revision,
      parentHash: null,
      entries: [],
    };
  }

  it('accepts zero revision, rejects unsafe numerics', () => {
    expect(() => parseSyncManifest(manifestWith(0))).not.toThrow();
    for (const bad of [
      NaN,
      Infinity,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
      '1',
    ]) {
      expect(() => parseSyncManifest(manifestWith(bad))).toThrow();
    }
  });

  it('rejects unsafe HEAD numerics', () => {
    const head = (overrides: Record<string, unknown>): unknown => ({
      protocolVersion: SYNC_PROTOCOL_VERSION,
      name: 'V',
      revision: 1,
      manifestHash:
        'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      manifestObject: 'users/u/vaults/v/manifests/1-00.json',
      fileCount: 0,
      totalBytes: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      updatedByDeviceId: 'device-1',
      ...overrides,
    });
    expect(() => parseRemoteHead(head({}))).not.toThrow();
    for (const bad of [NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => parseRemoteHead(head({ revision: bad }))).toThrow();
      expect(() => parseRemoteHead(head({ fileCount: bad }))).toThrow();
      expect(() => parseRemoteHead(head({ totalBytes: bad }))).toThrow();
    }
  });
});
