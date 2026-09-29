/**
 * Firebase `SyncRemote` conformance.
 *
 * The real provider logic over fake Firestore/Storage seams (no network,
 * no emulator, no secrets in CI):
 *
 * ```text
 * signed-out → NOT_AUTHENTICATED before any backend traffic
 * paths carry the UID only — email never appears
 * HEAD create/read/CAS round-trips with createdAt preservation
 * lost races → REMOTE_CHANGED, never an overwrite
 * manifests resolve by hash, re-hash on load, reject impostors
 * blobs round-trip; malformed refs and oversize payloads fail fast
 * watcher: change hints, null handling, corrupt-drop, error hook
 * backend failures surface as stable Froglight codes
 * ```
 *
 * Wire behavior (SDK delegation + Security Rules) is proven against the
 * Emulator Suite in `sync-remote.emulator.spec.ts`.
 */

import { describe, expect, it } from 'vitest';
import {
  SYNC_LIMITS,
  VaultSyncError,
  buildManifest,
  hashBytes,
  hashManifest,
  type ExpectedHead,
  type RemoteHeadInput,
  type SyncManifest,
} from '@froglight/foundation';
import type { FirestoreSyncBackend } from './firestore-backend.js';
import type { StorageSyncBackend } from './storage-backend.js';
import { createFirebaseSyncRemote } from './sync-remote.js';

const UID = 'firebase-uid-1';
const EMAIL = 'ada@example.com';
const VAULT = 'cloud-vault-1';
const BLOB_A = `sha256:${'a'.repeat(64)}`;
const BLOB_B = `sha256:${'b'.repeat(64)}`;

function headInput(overrides: Partial<RemoteHeadInput> = {}): RemoteHeadInput {
  return {
    name: 'University',
    revision: 1,
    manifestHash: `sha256:${'1'.repeat(64)}`,
    manifestObject: `users/${UID}/vaults/${VAULT}/manifests/1-${'1'.repeat(64)}.json`,
    fileCount: 1,
    totalBytes: 10,
    updatedByDeviceId: 'device-1',
    ...overrides,
  };
}

function manifest(revision = 1): SyncManifest {
  return buildManifest({
    vaultId: VAULT,
    revision,
    parentHash: null,
    entries: [{ path: 'a.md', kind: 'file', blob: BLOB_A, size: 5 }],
  });
}

interface WatcherRegistration {
  listener: (data: Record<string, unknown> | null) => void;
  onError?: (error: unknown) => void;
}

function createFakeFirestore(): FirestoreSyncBackend & {
  docs: Map<string, Record<string, unknown>>;
  calls: string[];
  paths: string[];
  failures: Map<string, unknown>;
  watchers: Map<string, Set<WatcherRegistration>>;
  emit(
    uid: string,
    vaultId: string,
    data: Record<string, unknown> | null,
  ): void;
  failWatch(uid: string, vaultId: string, error: unknown): void;
} {
  const docs = new Map<string, Record<string, unknown>>();
  const calls: string[] = [];
  const paths: string[] = [];
  const failures = new Map<string, unknown>();
  const watchers = new Map<string, Set<WatcherRegistration>>();
  const key = (uid: string, vaultId: string): string => `${uid}/${vaultId}`;
  const maybeFail = (name: string): void => {
    calls.push(name);
    const failure = failures.get(name);
    if (failure !== undefined) throw failure;
  };
  const backend: FirestoreSyncBackend & {
    docs: Map<string, Record<string, unknown>>;
    calls: string[];
    paths: string[];
    failures: Map<string, unknown>;
    watchers: Map<string, Set<WatcherRegistration>>;
    emit(
      uid: string,
      vaultId: string,
      data: Record<string, unknown> | null,
    ): void;
    failWatch(uid: string, vaultId: string, error: unknown): void;
  } = {
    docs,
    calls,
    paths,
    failures,
    watchers,
    async getHeadDocument(uid: string, vaultId: string) {
      maybeFail('getHeadDocument');
      paths.push(`users/${uid}/vaults/${vaultId}`);
      const found = docs.get(key(uid, vaultId));
      return found === undefined ? null : { ...found };
    },
    async listHeadDocuments(uid: string) {
      maybeFail('listHeadDocuments');
      paths.push(`users/${uid}/vaults`);
      const out: { id: string; data: Record<string, unknown> }[] = [];
      for (const [k, data] of docs) {
        if (k.startsWith(`${uid}/`))
          out.push({ id: k.slice(uid.length + 1), data: { ...data } });
      }
      return out;
    },
    async compareAndSwapHeadDocument(
      uid: string,
      vaultId: string,
      expected: ExpectedHead | null,
      next: RemoteHeadInput,
    ) {
      maybeFail('compareAndSwapHeadDocument');
      paths.push(`users/${uid}/vaults/${vaultId}`);
      const k = key(uid, vaultId);
      const current = docs.get(k) ?? null;
      const matches =
        expected === null
          ? current === null
          : current !== null &&
            current.revision === expected.revision &&
            current.manifestHash === expected.manifestHash;
      if (!matches) return null;
      const now = new Date().toISOString();
      const written: Record<string, unknown> = {
        protocolVersion: 1,
        ...next,
        createdAt:
          current !== null && typeof current.createdAt === 'string'
            ? current.createdAt
            : now,
        updatedAt: now,
      };
      docs.set(k, written);
      for (const registration of watchers.get(k) ?? []) {
        registration.listener({ ...written });
      }
      return { ...written };
    },
    watchHeadDocument(uid, vaultId, listener, onError) {
      calls.push('watchHeadDocument');
      paths.push(`users/${uid}/vaults/${vaultId}`);
      const k = key(uid, vaultId);
      let set = watchers.get(k);
      if (set === undefined) {
        set = new Set();
        watchers.set(k, set);
      }
      const registration: WatcherRegistration = { listener, onError };
      set.add(registration);
      return () => {
        set.delete(registration);
      };
    },
    emit(uid, vaultId, data) {
      for (const registration of watchers.get(key(uid, vaultId)) ?? []) {
        registration.listener(data === null ? null : { ...data });
      }
    },
    failWatch(uid, vaultId, error) {
      for (const registration of watchers.get(key(uid, vaultId)) ?? []) {
        registration.onError?.(error);
      }
    },
  };
  return backend;
}

function createFakeStorage(): StorageSyncBackend & {
  objects: Map<string, { bytes: Uint8Array; contentType: string }>;
  calls: string[];
  failures: Map<string, unknown>;
} {
  const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const calls: string[] = [];
  const failures = new Map<string, unknown>();
  const maybeFail = (name: string): void => {
    calls.push(name);
    const failure = failures.get(name);
    if (failure !== undefined) throw failure;
  };
  return {
    objects,
    calls,
    failures,
    async exists(objectPath: string) {
      maybeFail(`exists:${objectPath}`);
      return objects.has(objectPath);
    },
    async upload(objectPath: string, bytes: Uint8Array, contentType: string) {
      maybeFail(`upload:${objectPath}`);
      // Production immutability: blobs and manifests
      // are create-only (`resource == null` + `allow update: if false`).
      // A second create to the same path is denied as unauthorized even
      // for byte-identical content — the provider's idempotent retry
      // verifies the existing object and maps the safe duplicate to
      // success (never an entitlement failure). The fake models the
      // denial so tests match production instead of silently overwriting.
      if (objects.has(objectPath)) {
        throw { code: 'storage/unauthorized', message: 'immutable object' };
      }
      const copy = new Uint8Array(bytes.length);
      copy.set(bytes);
      objects.set(objectPath, { bytes: copy, contentType });
    },
    async download(objectPath: string) {
      maybeFail(`download:${objectPath}`);
      const found = objects.get(objectPath);
      if (found === undefined) {
        throw { code: 'storage/object-not-found', message: 'missing' };
      }
      const copy = new Uint8Array(found.bytes.length);
      copy.set(found.bytes);
      return copy;
    },
    async listNames(prefix: string) {
      maybeFail(`listNames:${prefix}`);
      const out: string[] = [];
      for (const path of objects.keys()) {
        if (path.startsWith(`${prefix}/`))
          out.push(path.slice(prefix.length + 1));
      }
      return out;
    },
  };
}

function setup(uid: string | null = UID) {
  const firestore = createFakeFirestore();
  const storage = createFakeStorage();
  const remote = createFirebaseSyncRemote({
    firestore,
    storage,
    getUid: () => uid,
  });
  return { firestore, storage, remote };
}

describe('firebase sync remote identity', () => {
  it('fails fast with NOT_AUTHENTICATED before any backend traffic', async () => {
    const { firestore, storage, remote } = setup(null);
    await expect(remote.listVaults()).rejects.toMatchObject({
      code: 'NOT_AUTHENTICATED',
    });
    await expect(remote.readHead(VAULT)).rejects.toMatchObject({
      code: 'NOT_AUTHENTICATED',
    });
    await expect(
      remote.loadManifest(
        VAULT,
        BLOB_A,
        `users/${UID}/vaults/${VAULT}/manifests/1-${BLOB_A.slice('sha256:'.length)}.json`,
      ),
    ).rejects.toMatchObject({ code: 'NOT_AUTHENTICATED' });
    await expect(remote.hasBlob(VAULT, BLOB_A)).rejects.toMatchObject({
      code: 'NOT_AUTHENTICATED',
    });
    await expect(
      remote.uploadBlob(VAULT, BLOB_A, new Uint8Array([1])),
    ).rejects.toMatchObject({ code: 'NOT_AUTHENTICATED' });
    await expect(remote.downloadBlob(VAULT, BLOB_A)).rejects.toMatchObject({
      code: 'NOT_AUTHENTICATED',
    });
    await expect(
      remote.uploadManifest(VAULT, manifest()),
    ).rejects.toMatchObject({
      code: 'NOT_AUTHENTICATED',
    });
    await expect(
      remote.compareAndSwapHead(VAULT, null, headInput()),
    ).rejects.toMatchObject({ code: 'NOT_AUTHENTICATED' });
    expect(() => remote.watchHead(VAULT, () => undefined)).toThrow(
      expect.objectContaining({ code: 'NOT_AUTHENTICATED' }),
    );
    expect(firestore.calls).toEqual([]);
    expect(storage.calls).toEqual([]);
  });

  it('rejects an empty UID the same way', async () => {
    const { remote } = setup('');
    await expect(remote.readHead(VAULT)).rejects.toMatchObject({
      code: 'NOT_AUTHENTICATED',
    });
  });

  it('builds every path from the UID; email never appears', async () => {
    const { firestore, storage, remote } = setup(UID);
    const xBytes = new TextEncoder().encode('x');
    const xBlob = (await hashBytes(xBytes)) as `sha256:${string}`;
    await remote.compareAndSwapHead(VAULT, null, headInput());
    await remote.uploadBlob(VAULT, xBlob, xBytes);
    await remote.uploadManifest(VAULT, manifest());
    await remote.readHead(VAULT);
    await remote.listVaults();
    const remoteStop = remote.watchHead(VAULT, () => undefined);
    remoteStop();

    const paths = [
      ...firestore.paths,
      ...storage.calls.map((call) => call.split(':').slice(1).join(':')),
    ];
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) {
      expect(path).toContain(`users/${UID}/`);
      expect(path).not.toContain('@');
      expect(path).not.toContain(EMAIL);
    }
  });
});

describe('firebase sync remote HEAD', () => {
  it('creates, reads, and lists the HEAD', async () => {
    const { remote } = setup();
    expect(await remote.readHead(VAULT)).toBeNull();
    expect(await remote.listVaults()).toEqual([]);

    const head = await remote.compareAndSwapHead(VAULT, null, headInput());
    expect(head).toMatchObject({ name: 'University', revision: 1 });
    expect(await remote.readHead(VAULT)).toEqual(head);
    const listed = await remote.listVaults();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      cloudVaultId: VAULT,
      name: 'University',
      revision: 1,
    });
  });

  it('advances revisions and preserves createdAt', async () => {
    const { remote } = setup();
    const first = await remote.compareAndSwapHead(VAULT, null, headInput());
    const second = await remote.compareAndSwapHead(
      VAULT,
      { revision: 1, manifestHash: first.manifestHash },
      headInput({ revision: 2, manifestHash: `sha256:${'2'.repeat(64)}` }),
    );
    expect(second.revision).toBe(2);
    expect(second.createdAt).toBe(first.createdAt);
  });

  it('loses races with REMOTE_CHANGED instead of overwriting', async () => {
    const { remote } = setup();
    const first = await remote.compareAndSwapHead(VAULT, null, headInput());
    // A second create against the existing vault fails.
    await expect(
      remote.compareAndSwapHead(VAULT, null, headInput()),
    ).rejects.toMatchObject({ code: 'REMOTE_CHANGED' });
    // A stale revision fails even with a plausible manifest hash.
    await expect(
      remote.compareAndSwapHead(
        VAULT,
        { revision: 1, manifestHash: `sha256:${'f'.repeat(64)}` },
        headInput({ revision: 2 }),
      ),
    ).rejects.toMatchObject({ code: 'REMOTE_CHANGED' });
    // The winner is untouched.
    expect(await remote.readHead(VAULT)).toEqual(first);
  });

  it('maps backend contention and denial through stable codes', async () => {
    const { firestore, remote } = setup();
    firestore.failures.set('compareAndSwapHeadDocument', {
      code: 'aborted',
      message: 'contention',
    });
    await expect(
      remote.compareAndSwapHead(VAULT, null, headInput()),
    ).rejects.toMatchObject({ code: 'REMOTE_CHANGED' });

    firestore.failures.set('getHeadDocument', {
      code: 'permission-denied',
      message: 'denied',
    });
    await expect(remote.readHead(VAULT)).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
    });
  });

  it('rejects corrupt HEAD documents loudly', async () => {
    const { firestore, remote } = setup();
    firestore.docs.set(`${UID}/${VAULT}`, { protocolVersion: 99 });
    await expect(remote.readHead(VAULT)).rejects.toMatchObject({
      code: 'CORRUPT_MANIFEST',
    });
  });

  it('lists healthy vaults while skipping corrupt ones, sorted', async () => {
    const { remote, firestore } = setup();
    await remote.compareAndSwapHead('b-vault', null, headInput({ name: 'B' }));
    await remote.compareAndSwapHead('a-vault', null, headInput({ name: 'A' }));
    firestore.docs.set(`${UID}/broken`, { nope: true });
    const listed = await remote.listVaults();
    expect(listed.map((entry) => entry.cloudVaultId)).toEqual([
      'a-vault',
      'b-vault',
    ]);
  });
});

describe('firebase sync remote manifests', () => {
  it('uploads and resolves manifests by hash with engine-compatible hashes', async () => {
    const { storage, remote } = setup();
    const next = manifest();
    const uploaded = await remote.uploadManifest(VAULT, next);
    expect(uploaded.hash).toBe(await hashManifest(next));
    expect(uploaded.object).toBe(
      `users/${UID}/vaults/${VAULT}/manifests/1-${uploaded.hash.slice('sha256:'.length)}.json`,
    );
    expect(storage.objects.get(uploaded.object)?.contentType).toBe(
      'application/json',
    );
    expect(
      await remote.loadManifest(VAULT, uploaded.hash, uploaded.object),
    ).toEqual(next);
  });

  it('fetches the exact HEAD-pointed object without listing', async () => {
    const { storage, remote } = setup();
    const next = manifest();
    const uploaded = await remote.uploadManifest(VAULT, next);
    storage.calls.length = 0;
    const loaded = await remote.loadManifest(
      VAULT,
      uploaded.hash,
      uploaded.object,
    );
    expect(loaded).toEqual(next);
    // Normal HEAD loads never pay O(number-of-revisions) listings.
    expect(storage.calls.some((call) => call.startsWith('listNames:'))).toBe(
      false,
    );
    expect(
      storage.calls.some((call) =>
        call.startsWith(`download:${uploaded.object}`),
      ),
    ).toBe(true);
  });

  it('rejects missing or mismatched exact-object pointers without listing', async () => {
    const { storage, remote } = setup();
    const next = manifest();
    const uploaded = await remote.uploadManifest(VAULT, next);
    storage.calls.length = 0;
    await expect(
      remote.loadManifest(VAULT, uploaded.hash, ''),
    ).rejects.toMatchObject({
      code: 'CORRUPT_MANIFEST',
    });
    await expect(
      remote.loadManifest(
        VAULT,
        uploaded.hash,
        `users/${UID}/vaults/other/manifests/1-${uploaded.hash.slice('sha256:'.length)}.json`,
      ),
    ).rejects.toMatchObject({ code: 'CORRUPT_MANIFEST' });
    expect(storage.calls).toEqual([]);
  });

  it('normalizes Firestore Timestamp values to ISO strings', async () => {
    const { firestore, remote } = setup();
    const created = new Date('2026-01-01T00:00:00.000Z');
    const updated = { toDate: () => new Date('2026-02-02T00:00:00.000Z') };
    firestore.docs.set(`${UID}/${VAULT}`, {
      protocolVersion: 1,
      name: 'University',
      revision: 1,
      manifestHash: `sha256:${'1'.repeat(64)}`,
      manifestObject: `users/${UID}/vaults/${VAULT}/manifests/1-${'1'.repeat(64)}.json`,
      fileCount: 1,
      totalBytes: 10,
      createdAt: created,
      updatedAt: updated,
      updatedByDeviceId: 'device-1',
    });
    const head = await remote.readHead(VAULT);
    // Foundation receives provider-neutral ISO timestamps, never
    // Firebase Timestamp objects.
    expect(head?.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(head?.updatedAt).toBe('2026-02-02T00:00:00.000Z');
  });

  it('reports missing manifests as REMOTE_NOT_FOUND', async () => {
    const { remote } = setup();
    await expect(
      remote.loadManifest(
        VAULT,
        `sha256:${'0'.repeat(64)}`,
        `users/${UID}/vaults/${VAULT}/manifests/1-${'0'.repeat(64)}.json`,
      ),
    ).rejects.toMatchObject({ code: 'REMOTE_NOT_FOUND' });
  });

  it('rejects impostor objects that do not re-hash', async () => {
    const { storage, remote } = setup();
    const hex = 'c'.repeat(64);
    storage.objects.set(
      `users/${UID}/vaults/${VAULT}/manifests/1-${hex}.json`,
      {
        bytes: new TextEncoder().encode(JSON.stringify({ forged: true })),
        contentType: 'application/json',
      },
    );
    await expect(
      remote.loadManifest(
        VAULT,
        `sha256:${hex}`,
        `users/${UID}/vaults/${VAULT}/manifests/1-${hex}.json`,
      ),
    ).rejects.toMatchObject({ code: 'CORRUPT_MANIFEST' });
  });

  it('rejects manifests bound to another vault', async () => {
    const { storage, remote } = setup();
    const other = buildManifest({
      vaultId: 'other-vault',
      revision: 1,
      parentHash: null,
      entries: [],
    });
    await expect(remote.uploadManifest(VAULT, other)).rejects.toMatchObject({
      code: 'CORRUPT_MANIFEST',
    });
    // A foreign manifest smuggled into our prefix is still refused on load.
    const foreign = buildManifest({
      vaultId: 'other-vault',
      revision: 1,
      parentHash: null,
      entries: [{ path: 'x.md', kind: 'file', blob: BLOB_A, size: 1 }],
    });
    const foreignHash = await hashManifest(foreign);
    const hex = foreignHash.slice('sha256:'.length);
    storage.objects.set(
      `users/${UID}/vaults/${VAULT}/manifests/1-${hex}.json`,
      {
        bytes: new TextEncoder().encode(JSON.stringify(foreign)),
        contentType: 'application/json',
      },
    );
    await expect(
      remote.loadManifest(
        VAULT,
        foreignHash,
        `users/${UID}/vaults/${VAULT}/manifests/1-${hex}.json`,
      ),
    ).rejects.toMatchObject({ code: 'CORRUPT_MANIFEST' });
  });

  it('rejects oversize manifests before upload', async () => {
    const { storage, remote } = setup();
    const entries = [];
    for (let i = 0; i < 9000; i += 1) {
      entries.push({
        path: `${'p'.repeat(1000)}${String(i).padStart(4, '0')}`,
        kind: 'file' as const,
        blob: BLOB_A,
        size: 1,
      });
    }
    const huge = buildManifest({
      vaultId: VAULT,
      revision: 1,
      parentHash: null,
      entries,
    });
    await expect(remote.uploadManifest(VAULT, huge)).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
    });
    expect(storage.calls.some((call) => call.startsWith('upload:'))).toBe(
      false,
    );
  });

  it('rejects malformed manifest hashes without backend traffic', async () => {
    const { storage, remote } = setup();
    await expect(
      remote.loadManifest(VAULT, 'nope', 'irrelevant'),
    ).rejects.toMatchObject({ code: 'CORRUPT_MANIFEST' });
    expect(storage.calls).toEqual([]);
  });
});

describe('firebase sync remote blobs', () => {
  it('round-trips blobs with octet-stream type', async () => {
    const { storage, remote } = setup();
    const bytes = new TextEncoder().encode('vault bytes');
    const realBlob = (await hashBytes(bytes)) as `sha256:${string}`;
    const realHex = realBlob.slice('sha256:'.length);
    expect(await remote.hasBlob(VAULT, realBlob)).toBe(false);
    await remote.uploadBlob(VAULT, realBlob, bytes);
    expect(await remote.hasBlob(VAULT, realBlob)).toBe(true);
    expect(await remote.downloadBlob(VAULT, realBlob)).toEqual(bytes);
    expect(
      storage.objects.get(`users/${UID}/vaults/${VAULT}/blobs/${realHex}`)
        ?.contentType,
    ).toBe('application/octet-stream');
  });

  it('maps a missing blob to REMOTE_NOT_FOUND', async () => {
    const { remote } = setup();
    await expect(remote.downloadBlob(VAULT, BLOB_B)).rejects.toMatchObject({
      code: 'REMOTE_NOT_FOUND',
    });
  });

  it('rejects malformed blob references without backend traffic', async () => {
    const { storage, remote } = setup();
    for (const method of [
      () => remote.hasBlob(VAULT, 'garbage'),
      () => remote.uploadBlob(VAULT, 'garbage', new Uint8Array([1])),
      () => remote.downloadBlob(VAULT, 'garbage'),
    ]) {
      await expect(method()).rejects.toMatchObject({
        code: 'CORRUPT_MANIFEST',
      });
    }
    expect(storage.calls).toEqual([]);
  });

  it('rejects oversize blobs before upload', async () => {
    const { storage, remote } = setup();
    // Length-spoofed payload: the guard reads `.length` and throws
    // before the backend ever sees the bytes.
    const spoofed = new Proxy(new Uint8Array(1), {
      get: (target, property) =>
        property === 'length'
          ? SYNC_LIMITS.maxBlobBytes + 1
          : Reflect.get(target, property),
    });
    await expect(
      remote.uploadBlob(VAULT, BLOB_A, spoofed),
    ).rejects.toMatchObject({
      code: 'QUOTA_EXCEEDED',
    });
    expect(storage.calls.some((call) => call.startsWith('upload:'))).toBe(
      false,
    );
  });

  it('normalizes backend failures per operation', async () => {
    const { storage, remote } = setup();
    storage.failures.set(
      `exists:users/${UID}/vaults/${VAULT}/blobs/${'a'.repeat(64)}`,
      {
        code: 'unavailable',
        message: 'offline',
      },
    );
    await expect(remote.hasBlob(VAULT, BLOB_A)).rejects.toMatchObject({
      code: 'NETWORK',
    });
  });
});

describe('firebase sync remote watcher', () => {
  it('forwards parsed HEAD changes and nulls', async () => {
    const { firestore, remote } = setup();
    const seen: unknown[] = [];
    const stop = remote.watchHead(VAULT, (head) => {
      seen.push(head);
    });
    const written = await remote.compareAndSwapHead(VAULT, null, headInput());
    firestore.emit(UID, VAULT, null);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toEqual(written);
    expect(seen[1]).toBeNull();
    stop();
  });

  it('drops corrupt snapshots and contains listener failures', async () => {
    const { firestore, remote } = setup();
    const seen: unknown[] = [];
    remote.watchHead(VAULT, (head) => {
      seen.push(head);
      throw new Error('consumer blew up');
    });
    // Neither the corrupt snapshot nor the throwing consumer breaks delivery.
    firestore.emit(UID, VAULT, { protocolVersion: 99 });
    const written = await remote.compareAndSwapHead(VAULT, null, headInput());
    expect(seen).toEqual([written]);
  });

  it('unsubscribe stops delivery', async () => {
    const { firestore, remote } = setup();
    const seen: unknown[] = [];
    const stop = remote.watchHead(VAULT, (head) => {
      seen.push(head);
    });
    stop();
    firestore.emit(UID, VAULT, null);
    await remote.compareAndSwapHead(VAULT, null, headInput());
    expect(seen).toEqual([]);
  });

  it('routes snapshot errors to the subscription onError normalized', async () => {
    const { firestore, remote } = setup();
    const errors: VaultSyncError[] = [];
    remote.watchHead(
      VAULT,
      () => undefined,
      (error) => {
        errors.push(error as VaultSyncError);
      },
    );
    firestore.failWatch(UID, VAULT, {
      code: 'permission-denied',
      message: 'x',
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: 'PERMISSION_DENIED' });
  });

  it('contains snapshot errors without a hook', async () => {
    const { firestore, remote } = setup();
    remote.watchHead(VAULT, () => undefined);
    expect(() =>
      firestore.failWatch(UID, VAULT, { code: 'unavailable', message: 'x' }),
    ).not.toThrow();
  });
});

describe('firebase sync remote failure propagation', () => {
  it('a throwing subscription onError never breaks the watcher', async () => {
    const { firestore, remote } = setup();
    const seen: unknown[] = [];
    remote.watchHead(
      VAULT,
      (head) => {
        seen.push(head);
      },
      () => {
        throw new Error('hook blew up');
      },
    );
    firestore.failWatch(UID, VAULT, { code: 'unavailable', message: 'x' });
    firestore.emit(UID, VAULT, null);
    expect(seen).toEqual([null]);
  });

  it('preserves backend failure causes for diagnosis', async () => {
    const storage = createFakeStorage();
    const failure = { code: 'storage/retry-limit-exceeded', message: 'slow' };
    storage.failures.set(
      `download:users/${UID}/vaults/${VAULT}/blobs/${'a'.repeat(64)}`,
      failure,
    );
    const failing = createFirebaseSyncRemote({
      firestore: createFakeFirestore(),
      storage,
      getUid: () => UID,
    });
    const error = await failing.downloadBlob(VAULT, BLOB_A).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: 'NETWORK' });
    expect((error as VaultSyncError).cause).toBe(failure);
  });
});
