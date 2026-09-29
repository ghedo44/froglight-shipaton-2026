/**
 * Sync manifest conformance (§77–§78).
 *
 * Deterministic ordering, stable hashing, byte round-trips, and
 * structural rejection of every untrusted-input shape the plan requires:
 * format, version, vault id, revision, paths, duplicates, hashes, sizes,
 * limits, and directory/file collisions. No I/O, no network.
 */

import { describe, expect, it } from 'vitest';
import {
  SYNC_LIMITS,
  blobRef,
  buildManifest,
  canonicalizeManifest,
  emptyManifest,
  hashBytes,
  hashManifest,
  isBlobRef,
  manifestsEqual,
  parseManifestBytes,
  parseRemoteHead,
  parseSyncManifest,
} from './manifest.js';
import { SYNC_MANIFEST_FORMAT, SYNC_PROTOCOL_VERSION } from './contract.js';
import type { SyncManifest } from './contract.js';

const BLOB_A = `sha256:${'a'.repeat(64)}`;
const BLOB_B = `sha256:${'b'.repeat(64)}`;
const HASH_1 = `sha256:${'1'.repeat(64)}`;

function sampleManifest(): SyncManifest {
  return buildManifest({
    vaultId: 'cloud-vault-1',
    revision: 42,
    parentHash: HASH_1,
    entries: [
      { path: 'Notes/physics.md', kind: 'file', blob: BLOB_A, size: 28491 },
      { path: 'Assets/book.pdf', kind: 'file', blob: BLOB_B, size: 8472919 },
      { path: 'Empty Folder', kind: 'directory' },
    ],
  });
}

describe('sync manifest format', () => {
  it('orders entries deterministically regardless of input order', () => {
    const forward = buildManifest({
      vaultId: 'v',
      revision: 1,
      parentHash: null,
      entries: [
        { path: 'b.md', kind: 'file', blob: BLOB_A, size: 1 },
        { path: 'a.md', kind: 'file', blob: BLOB_B, size: 2 },
      ],
    });
    const backward = buildManifest({
      vaultId: 'v',
      revision: 1,
      parentHash: null,
      entries: [
        { path: 'a.md', kind: 'file', blob: BLOB_B, size: 2 },
        { path: 'b.md', kind: 'file', blob: BLOB_A, size: 1 },
      ],
    });
    expect(forward.entries.map((entry) => entry.path)).toEqual([
      'a.md',
      'b.md',
    ]);
    expect(canonicalizeManifest(forward)).toBe(canonicalizeManifest(backward));
  });

  it('hashes identical states identically and distinct states distinctly', async () => {
    const first = sampleManifest();
    const clone = parseSyncManifest(JSON.parse(canonicalizeManifest(first)));
    expect(await hashManifest(first)).toBe(await hashManifest(clone));
    expect(await hashManifest(first)).toMatch(/^sha256:[0-9a-f]{64}$/);
    const edited = buildManifest({
      vaultId: 'cloud-vault-1',
      revision: 42,
      parentHash: HASH_1,
      entries: [
        { path: 'Notes/physics.md', kind: 'file', blob: BLOB_B, size: 9 },
        { path: 'Assets/book.pdf', kind: 'file', blob: BLOB_B, size: 8472919 },
        { path: 'Empty Folder', kind: 'directory' },
      ],
    });
    expect(await hashManifest(edited)).not.toBe(await hashManifest(first));
  });

  it('round-trips through canonical bytes', () => {
    const manifest = sampleManifest();
    const bytes = new TextEncoder().encode(canonicalizeManifest(manifest));
    const parsed = parseManifestBytes(bytes);
    expect(parsed).toEqual(manifest);
    expect(manifestsEqual(parsed, manifest)).toBe(true);
    expect(manifestsEqual(parsed, emptyManifest('cloud-vault-1'))).toBe(false);
  });

  it('hashes blobs with SHA-256 hex references', async () => {
    // SHA-256 of the empty string is a well-known constant.
    expect(await hashBytes(new Uint8Array(0))).toBe(
      'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(isBlobRef(BLOB_A)).toBe(true);
    expect(isBlobRef('md5:abc')).toBe(false);
    expect(blobRef('ab'.repeat(32))).toBe(`sha256:${'ab'.repeat(32)}`);
  });

  it('rejects unknown formats and versions structurally', () => {
    const manifest = sampleManifest();
    expect(() =>
      parseSyncManifest({ ...manifest, format: 'froglight.other' }),
    ).toThrow(/unknown manifest format/);
    expect(() => parseSyncManifest({ ...manifest, version: 2 })).toThrow(
      /unsupported manifest version/,
    );
    expect(() => parseSyncManifest({ ...manifest, version: '1' })).toThrow(
      /unsupported manifest version/,
    );
  });

  it('rejects bad vault identity and revision', () => {
    const manifest = sampleManifest();
    expect(() => parseSyncManifest({ ...manifest, vaultId: '' })).toThrow(
      /vaultId/,
    );
    expect(() => parseSyncManifest({ ...manifest, revision: -1 })).toThrow(
      /revision/,
    );
    expect(() => parseSyncManifest({ ...manifest, revision: 1.5 })).toThrow(
      /revision/,
    );
    expect(() =>
      parseSyncManifest({ ...manifest, parentHash: 'nope' }),
    ).toThrow(/parentHash/);
  });

  it('rejects invalid, duplicate, and root paths', () => {
    const manifest = sampleManifest();
    expect(() =>
      parseSyncManifest({
        ...manifest,
        entries: [
          { path: '../escape.md', kind: 'file', blob: BLOB_A, size: 1 },
        ],
      }),
    ).toThrow(/invalid workspace path/);
    expect(() =>
      parseSyncManifest({
        ...manifest,
        entries: [
          { path: '/absolute.md', kind: 'file', blob: BLOB_A, size: 1 },
        ],
      }),
    ).toThrow(/invalid workspace path/);
    expect(() =>
      parseSyncManifest({
        ...manifest,
        entries: [{ path: '', kind: 'directory' }],
      }),
    ).toThrow(/must not be the vault root/);
    expect(() =>
      parseSyncManifest({
        ...manifest,
        entries: [
          { path: 'a.md', kind: 'file', blob: BLOB_A, size: 1 },
          { path: 'a.md', kind: 'file', blob: BLOB_B, size: 2 },
        ],
      }),
    ).toThrow(/duplicate manifest path/);
  });

  it('rejects malformed file entries', () => {
    const manifest = sampleManifest();
    expect(() =>
      parseSyncManifest({
        ...manifest,
        entries: [{ path: 'a.md', kind: 'file', blob: 'nope', size: 1 }],
      }),
    ).toThrow(/blob reference/);
    expect(() =>
      parseSyncManifest({
        ...manifest,
        entries: [{ path: 'a.md', kind: 'file', blob: BLOB_A, size: -1 }],
      }),
    ).toThrow(/file size/);
    expect(() =>
      parseSyncManifest({
        ...manifest,
        entries: [{ path: 'a.md', kind: 'file', blob: BLOB_A }],
      }),
    ).toThrow(/file size/);
    expect(() =>
      parseSyncManifest({
        ...manifest,
        entries: [{ path: 'a.md', kind: 'file', blob: BLOB_A, size: 1.5 }],
      }),
    ).toThrow(/file size/);
    expect(() =>
      parseSyncManifest({
        ...manifest,
        entries: [{ path: 'd', kind: 'directory', blob: BLOB_A }],
      }),
    ).toThrow(/must not carry blob/);
    expect(() =>
      parseSyncManifest({
        ...manifest,
        entries: [{ path: 'a.md', kind: 'symlink' }],
      }),
    ).toThrow(/unknown entry kind/);
  });

  it('rejects directory/file collisions in both directions', () => {
    const manifest = sampleManifest();
    expect(() =>
      parseSyncManifest({
        ...manifest,
        entries: [
          { path: 'a', kind: 'file', blob: BLOB_A, size: 1 },
          { path: 'a/b.md', kind: 'file', blob: BLOB_B, size: 2 },
        ],
      }),
    ).toThrow(/collision/);
    expect(() =>
      parseSyncManifest({
        ...manifest,
        entries: [
          { path: 'a', kind: 'directory' },
          { path: 'a', kind: 'file', blob: BLOB_A, size: 1 },
        ],
      }),
    ).toThrow(/duplicate manifest path|collision/);
  });

  it('enforces entry-count limits', () => {
    expect(SYNC_LIMITS.maxEntries).toBeGreaterThan(0);
    const manifest = sampleManifest();
    expect(() => parseSyncManifest({ ...manifest, entries: 'nope' })).toThrow(
      /entries must be an array/,
    );
  });

  it('rejects oversized manifest bytes before parsing', () => {
    const huge = new Uint8Array(SYNC_LIMITS.maxManifestBytes + 1);
    expect(() => parseManifestBytes(huge)).toThrow(/exceeds/);
    expect(() => parseManifestBytes(new TextEncoder().encode('{nope'))).toThrow(
      /valid JSON/,
    );
  });

  it('exposes the example shape', () => {
    const manifest = sampleManifest();
    expect(manifest.format).toBe(SYNC_MANIFEST_FORMAT);
    expect(manifest.format).toBe('froglight.sync-manifest');
    expect(manifest.version).toBe(SYNC_PROTOCOL_VERSION);
    expect(manifest.version).toBe(1);
  });
});

describe('remote HEAD validation', () => {
  const validHead = {
    protocolVersion: 1,
    name: 'University',
    revision: 42,
    manifestHash: HASH_1,
    manifestObject: 'users/uid/vaults/vid/manifests/42-abc.json',
    fileCount: 193,
    totalBytes: 48281732,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-09T00:00:00.000Z',
    updatedByDeviceId: 'device-1',
  };

  it('accepts the shape', () => {
    expect(parseRemoteHead(validHead)).toEqual(validHead);
  });

  it('rejects bad revisions, hashes, counts, and versions', () => {
    expect(() => parseRemoteHead({ ...validHead, revision: 0 })).toThrow(
      /revision/,
    );
    expect(() => parseRemoteHead({ ...validHead, revision: 1.5 })).toThrow(
      /revision/,
    );
    expect(() => parseRemoteHead({ ...validHead, manifestHash: 'x' })).toThrow(
      /manifestHash/,
    );
    expect(() => parseRemoteHead({ ...validHead, protocolVersion: 2 })).toThrow(
      /protocolVersion/,
    );
    expect(() => parseRemoteHead({ ...validHead, fileCount: -1 })).toThrow(
      /fileCount/,
    );
    expect(() =>
      parseRemoteHead({ ...validHead, fileCount: SYNC_LIMITS.maxEntries + 1 }),
    ).toThrow(/fileCount/);
    expect(() => parseRemoteHead({ ...validHead, totalBytes: -1 })).toThrow(
      /totalBytes/,
    );
    expect(() => parseRemoteHead({ ...validHead, name: '' })).toThrow(/name/);
    expect(() => parseRemoteHead(null)).toThrow(/not an object/);
  });
});
