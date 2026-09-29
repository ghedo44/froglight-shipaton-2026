/**
 * Firebase immutable-upload idempotency.
 *
 * Production Storage denies the second create as permission-denied
 * (immutable `resource == null` + `allow update: if false`). The provider
 * must map a safe duplicate (existing object matches the requested
 * hash/bytes) to success — never to ENTITLEMENT_PENDING/PRO_REQUIRED —
 * while genuine denials (absent object) stay PERMISSION_DENIED and
 * mismatched objects become corruption.
 *
 * The fake backend models production denial (second create → unauthorized)
 * so these tests match emulator/production semantics.
 */

import { describe, expect, it } from 'vitest';
import {
  buildManifest,
  hashBytes,
  type SyncManifest,
} from '@froglight/foundation';
import type { FirestoreSyncBackend } from './firestore-backend.js';
import type { StorageSyncBackend } from './storage-backend.js';
import { createFirebaseSyncRemote } from './sync-remote.js';

const UID = 'uid-immutable';
const VAULT = 'vault-immutable';

function createFakeFirestore(): FirestoreSyncBackend {
  const docs = new Map<string, Record<string, unknown>>();
  return {
    async getHeadDocument(uid: string, vaultId: string) {
      return docs.get(`${uid}/${vaultId}`) ?? null;
    },
    async listHeadDocuments() {
      return [];
    },
    async compareAndSwapHeadDocument(uid, vaultId, expected, next) {
      const key = `${uid}/${vaultId}`;
      const current = docs.get(key) ?? null;
      const matches =
        expected === null
          ? current === null
          : current !== null &&
            current.revision === expected.revision &&
            current.manifestHash === expected.manifestHash;
      if (!matches) return null;
      const now = new Date().toISOString();
      const written = {
        protocolVersion: 1,
        ...next,
        createdAt:
          current !== null && typeof current.createdAt === 'string'
            ? current.createdAt
            : now,
        updatedAt: now,
      };
      docs.set(key, written);
      return { ...written };
    },
    watchHeadDocument() {
      return () => undefined;
    },
  };
}

function createImmutableFakeStorage(): StorageSyncBackend & {
  objects: Map<string, { bytes: Uint8Array; contentType: string }>;
} {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  return {
    objects,
    async exists(objectPath: string) {
      return objects.has(objectPath);
    },
    async upload(objectPath: string, bytes: Uint8Array, contentType: string) {
      // Production semantics: second create denied even for identical bytes.
      if (objects.has(objectPath)) {
        throw { code: 'storage/unauthorized', message: 'immutable' };
      }
      const copy = new Uint8Array(bytes.length);
      copy.set(bytes);
      objects.set(objectPath, { bytes: copy, contentType });
    },
    async download(objectPath: string) {
      const found = objects.get(objectPath);
      if (found === undefined) {
        throw { code: 'storage/object-not-found', message: 'missing' };
      }
      const copy = new Uint8Array(found.bytes.length);
      copy.set(found.bytes);
      return copy;
    },
    async listNames(prefix: string) {
      const out: string[] = [];
      for (const path of objects.keys()) {
        if (path.startsWith(`${prefix}/`))
          out.push(path.slice(prefix.length + 1));
      }
      return out;
    },
  };
}

function setup() {
  const firestore = createFakeFirestore();
  const storage = createImmutableFakeStorage();
  const remote = createFirebaseSyncRemote({
    firestore,
    storage,
    getUid: () => UID,
  });
  return { firestore, storage, remote };
}

function manifest(revision = 1): SyncManifest {
  return buildManifest({
    vaultId: VAULT,
    revision,
    parentHash: null,
    entries: [],
  });
}

describe('firebase immutable-upload idempotency', () => {
  it('maps a safe blob duplicate to success (not entitlement)', async () => {
    const { remote } = setup();
    const bytes = new TextEncoder().encode('immutable-blob');
    const blob = await hashBytes(bytes);
    await remote.uploadBlob(VAULT, blob, bytes);
    // Second identical create (distributed race / crash retry) succeeds
    // via verification, never as PERMISSION_DENIED/ENTITLEMENT_PENDING.
    await remote.uploadBlob(VAULT, blob, bytes);
    expect(await remote.hasBlob(VAULT, blob)).toBe(true);
  });

  it('rejects mismatched bytes under the same hash (never poison)', async () => {
    const { remote } = setup();
    const bytesA = new TextEncoder().encode('A');
    const blobA = await hashBytes(bytesA);
    await remote.uploadBlob(VAULT, blobA, bytesA);
    const bytesB = new TextEncoder().encode('B');
    await expect(remote.uploadBlob(VAULT, blobA, bytesB)).rejects.toMatchObject(
      {
        code: 'HASH_MISMATCH',
      },
    );
  });

  it('keeps genuine denials as PERMISSION_DENIED (never swallowed as idempotent)', async () => {
    const firestore = createFakeFirestore();
    const storage = createImmutableFakeStorage();
    // Deny every upload (entitlement missing) with no existing object.
    const denying: StorageSyncBackend = {
      ...storage,
      async upload() {
        throw { code: 'storage/unauthorized', message: 'denied' };
      },
    };
    const remote = createFirebaseSyncRemote({
      firestore,
      storage: denying,
      getUid: () => UID,
    });
    const bytes = new TextEncoder().encode('new-blob');
    const blob = await hashBytes(bytes);
    await expect(remote.uploadBlob(VAULT, blob, bytes)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
  });

  it('maps a safe manifest duplicate to success (crash-after-manifest)', async () => {
    const { remote } = setup();
    const next = manifest(1);
    const first = await remote.uploadManifest(VAULT, next);
    const second = await remote.uploadManifest(VAULT, next);
    expect(second.hash).toBe(first.hash);
    expect(second.object).toBe(first.object);
  });

  it('never uploads when content-hash verification itself fails (fail closed)', async () => {
    // Defense in depth: the provider must never store bytes under a
    // content address unless the content hash has been verified. A hashing
    // failure is an integrity failure — upload must never be attempted
    // (no catch-and-continue into a success path).
    const firestore = createFakeFirestore();
    const storage = createImmutableFakeStorage();
    let uploads = 0;
    const origUpload = storage.upload.bind(storage);
    storage.upload = async (objectPath, bytes, contentType) => {
      uploads += 1;
      return origUpload(objectPath, bytes, contentType);
    };
    const remote = createFirebaseSyncRemote({
      firestore,
      storage,
      getUid: () => UID,
    });
    const bytes = new TextEncoder().encode('some-blob');
    const blob = await hashBytes(bytes);
    // Quota-valid length but unhashable input: subtle.digest rejects for a
    // non-BufferSource, isolating the hash-failure path.
    const unhashable = { length: bytes.length } as unknown as Uint8Array;
    await expect(
      remote.uploadBlob(VAULT, blob, unhashable),
    ).rejects.toMatchObject({ code: 'HASH_MISMATCH' });
    expect(uploads).toBe(0);
    expect(await remote.hasBlob(VAULT, blob)).toBe(false);
  });

  it('rejects a corrupt existing manifest as corruption (never silent success)', async () => {
    const { storage, remote } = setup();
    const next = manifest(1);
    const uploaded = await remote.uploadManifest(VAULT, next);
    // Corrupt the stored object in place (impossible in production, but
    // proves the verification is not a blind success).
    const stored = storage.objects.get(uploaded.object);
    if (stored === undefined) throw new Error('expected the manifest object');
    stored.bytes = new TextEncoder().encode('{"forged":true}');
    await expect(remote.uploadManifest(VAULT, next)).rejects.toMatchObject({
      code: 'CORRUPT_MANIFEST',
    });
  });
});
