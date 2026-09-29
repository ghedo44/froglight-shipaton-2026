/**
 * Firebase `SyncRemote` emulator integration.
 *
 * The real provider — real modular SDK backends, real Firestore/Storage
 * emulators, real Security Rules — driven through the same contract the
 * engine consumes, including one full `reconcileVault` round-trip and the
 * claim model: a Pro-claimed user syncs, a claimless user is denied
 * writes while keeping reads.
 *
 * Runs ONLY under the Emulator Suite (skipped otherwise, so unit CI
 * stays hermetic with no network, no emulator, no secrets):
 *
 * ```sh
 * # from infra/firebase (owns firebase.json + the emulator lifecycle)
 * pnpm test:emulators:provider
 * ```
 *
 * `firebase emulators:exec` supplies `FIRESTORE_EMULATOR_HOST`,
 * `FIREBASE_STORAGE_EMULATOR_HOST`, and `FIREBASE_AUTH_EMULATOR_HOST`.
 * Claim-bearing users come from the Admin SDK against the Auth
 * emulator (no credentials needed for `demo-*` projects), exactly how
 * the RevenueCat Extension mints `revenueCatEntitlements` server-side.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  deleteApp as deleteAdminApp,
  initializeApp as initializeAdminApp,
} from 'firebase-admin/app';
import { getAuth as getAdminAuth } from 'firebase-admin/auth';
import {
  connectAuthEmulator,
  getAuth,
  signInWithCustomToken,
  type Auth,
} from 'firebase/auth';
import {
  connectFirestoreEmulator,
  getFirestore,
  type Firestore,
} from 'firebase/firestore';
import {
  connectStorageEmulator,
  getStorage,
  type FirebaseStorage,
} from 'firebase/storage';
import { deleteApp, initializeApp, type FirebaseApp } from 'firebase/app';
import {
  buildManifest,
  createMemoryVault,
  hashBytes,
  reconcileVault,
  workspacePath,
  type SyncRemote,
} from '@froglight/foundation';
import { createSdkFirestoreSyncBackend } from './firestore-backend.js';
import { createSdkStorageSyncBackend } from './storage-backend.js';
import { createFirebaseSyncRemote } from './sync-remote.js';

const PROJECT_ID =
  process.env.FIREBASE_PROJECT_ID ?? 'demo-froglight-sync-test';
const EMULATORS = [
  process.env.FIRESTORE_EMULATOR_HOST,
  process.env.FIREBASE_STORAGE_EMULATOR_HOST,
  process.env.FIREBASE_AUTH_EMULATOR_HOST,
].every((value) => typeof value === 'string' && value.length > 0);

function splitHostPort(value: string): { host: string; port: number } {
  const separator = value.lastIndexOf(':');
  return {
    host: value.slice(0, separator),
    port: Number(value.slice(separator + 1)),
  };
}

const PRO_UID = 'emulator-pro-user';
const FREE_UID = 'emulator-free-user';
const VAULT = 'emulator-vault-1';

describe.runIf(EMULATORS)('firebase sync remote against emulators', () => {
  let proRemote: SyncRemote;
  let freeRemote: SyncRemote;
  const cleanup: Array<() => Promise<void>> = [];

  async function signedInClient(
    label: string,
    uid: string,
  ): Promise<{
    app: FirebaseApp;
    auth: Auth;
    firestore: Firestore;
    storage: FirebaseStorage;
  }> {
    const app = initializeApp(
      {
        apiKey: 'emulator-fake-key',
        projectId: PROJECT_ID,
        // Bucket name is arbitrary against the emulator, which
        // provisions it on first use; without it the client SDK
        // reports storage/no-default-bucket before any traffic.
        storageBucket: `${PROJECT_ID}.appspot.com`,
      },
      `sync-emulator-${label}`,
    );
    const authHost = splitHostPort(
      process.env.FIREBASE_AUTH_EMULATOR_HOST as string,
    );
    const firestoreHost = splitHostPort(
      process.env.FIRESTORE_EMULATOR_HOST as string,
    );
    const storageHost = splitHostPort(
      process.env.FIREBASE_STORAGE_EMULATOR_HOST as string,
    );
    const auth = getAuth(app);
    connectAuthEmulator(auth, `http://${authHost.host}:${authHost.port}`, {
      disableWarnings: true,
    });
    const firestore = getFirestore(app);
    connectFirestoreEmulator(firestore, firestoreHost.host, firestoreHost.port);
    const storage = getStorage(app);
    connectStorageEmulator(storage, storageHost.host, storageHost.port);
    const adminAuth = getAdminAuth();
    await signInWithCustomToken(auth, await adminAuth.createCustomToken(uid));
    cleanup.push(async () => {
      await deleteApp(app);
    });
    return { app, auth, firestore, storage };
  }

  beforeAll(async () => {
    const adminApp = initializeAdminApp({ projectId: PROJECT_ID });
    cleanup.push(async () => {
      await deleteAdminApp(adminApp);
    });
    const adminAuth = getAdminAuth(adminApp);
    await adminAuth.createUser({ uid: PRO_UID, email: 'pro@example.com' });
    // Server-issued claim, exactly as the RevenueCat Extension writes it.
    await adminAuth.setCustomUserClaims(PRO_UID, {
      revenueCatEntitlements: ['pro'],
    });
    await adminAuth.createUser({ uid: FREE_UID, email: 'free@example.com' });

    const pro = await signedInClient('pro', PRO_UID);
    proRemote = createFirebaseSyncRemote({
      firestore: createSdkFirestoreSyncBackend({ firestore: pro.firestore }),
      storage: createSdkStorageSyncBackend({ storage: pro.storage }),
      getUid: () => pro.auth.currentUser?.uid ?? null,
    });

    const free = await signedInClient('free', FREE_UID);
    freeRemote = createFirebaseSyncRemote({
      firestore: createSdkFirestoreSyncBackend({ firestore: free.firestore }),
      storage: createSdkStorageSyncBackend({ storage: free.storage }),
      getUid: () => free.auth.currentUser?.uid ?? null,
    });
  }, 60_000);

  afterAll(async () => {
    for (const fn of cleanup.splice(0).reverse()) {
      await fn();
    }
  });

  it('denies claimless writes while allowing reads (real Rules)', async () => {
    await expect(
      freeRemote.compareAndSwapHead(VAULT, null, {
        name: 'Nope',
        revision: 1,
        manifestHash: `sha256:${'1'.repeat(64)}`,
        manifestObject: 'x',
        fileCount: 0,
        totalBytes: 0,
        updatedByDeviceId: 'd',
      }),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    const deniedBytes = new Uint8Array([1]);
    const deniedBlob = (await hashBytes(deniedBytes)) as `sha256:${string}`;
    await expect(
      freeRemote.uploadBlob(VAULT, deniedBlob, deniedBytes),
    ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
    // Reads stay open (retention): an absent vault reads as null.
    await expect(freeRemote.readHead('missing-vault')).resolves.toBeNull();
  });

  it('commits and reads the HEAD through the real control plane', async () => {
    expect(await proRemote.readHead(VAULT)).toBeNull();
    const head = await proRemote.compareAndSwapHead(VAULT, null, {
      name: 'Emulator University',
      revision: 1,
      manifestHash: `sha256:${'1'.repeat(64)}`,
      manifestObject: `users/${PRO_UID}/vaults/${VAULT}/manifests/1-${'1'.repeat(64)}.json`,
      fileCount: 1,
      totalBytes: 5,
      updatedByDeviceId: 'device-emulator',
    });
    expect(head).toMatchObject({ name: 'Emulator University', revision: 1 });
    expect(await proRemote.readHead(VAULT)).toEqual(head);
    const listed = await proRemote.listVaults();
    expect(listed.map((entry) => entry.cloudVaultId)).toContain(VAULT);
  });

  it('round-trips blobs and manifests through the real data plane', async () => {
    const bytes = new TextEncoder().encode('emulator bytes');
    const blob = (await hashBytes(bytes)) as `sha256:${string}`;
    expect(await proRemote.hasBlob(VAULT, blob)).toBe(false);
    await proRemote.uploadBlob(VAULT, blob, bytes);
    expect(await proRemote.hasBlob(VAULT, blob)).toBe(true);
    expect(await proRemote.downloadBlob(VAULT, blob)).toEqual(bytes);

    const manifest = buildManifest({
      vaultId: VAULT,
      revision: 1,
      parentHash: null,
      entries: [{ path: 'a.md', kind: 'file', blob, size: bytes.length }],
    });
    const uploaded = await proRemote.uploadManifest(VAULT, manifest);
    expect(
      await proRemote.loadManifest(VAULT, uploaded.hash, uploaded.object),
    ).toEqual(manifest);
  });

  it('treats identical immutable re-uploads as idempotent success (real Rules)', async () => {
    const bytes = new TextEncoder().encode('emulator-idempotent');
    const blob = (await hashBytes(bytes)) as `sha256:${string}`;
    const idemVault = `emulator-idem-${Date.now()}`;
    // First create succeeds; second identical create (distributed race /
    // crash retry) succeeds via verification, never as entitlement failure.
    await proRemote.uploadBlob(idemVault, blob, bytes);
    await proRemote.uploadBlob(idemVault, blob, bytes);
    expect(await proRemote.downloadBlob(idemVault, blob)).toEqual(bytes);

    const manifest = buildManifest({
      vaultId: idemVault,
      revision: 1,
      parentHash: null,
      entries: [{ path: 'a.md', kind: 'file', blob, size: bytes.length }],
    });
    const first = await proRemote.uploadManifest(idemVault, manifest);
    const second = await proRemote.uploadManifest(idemVault, manifest);
    expect(second.hash).toBe(first.hash);
  });

  it('loses a real transaction race with REMOTE_CHANGED', async () => {
    const head = await proRemote.readHead(VAULT);
    if (head === null) throw new Error('expected the HEAD from prior tests');
    await expect(
      proRemote.compareAndSwapHead(
        VAULT,
        { revision: head.revision, manifestHash: `sha256:${'f'.repeat(64)}` },
        {
          name: 'Racer',
          revision: head.revision + 1,
          manifestHash: `sha256:${'2'.repeat(64)}`,
          manifestObject: `users/${PRO_UID}/vaults/${VAULT}/manifests/${head.revision + 1}-${'2'.repeat(64)}.json`,
          fileCount: 0,
          totalBytes: 0,
          updatedByDeviceId: 'd',
        },
      ),
    ).rejects.toMatchObject({ code: 'REMOTE_CHANGED' });
  });

  it('notifies HEAD changes through the real listener', async () => {
    const seen: (number | null)[] = [];
    const stop = proRemote.watchHead('watch-vault', (head) => {
      seen.push(head?.revision ?? null);
    });
    try {
      const first = await proRemote.compareAndSwapHead('watch-vault', null, {
        name: 'Watch',
        revision: 1,
        manifestHash: `sha256:${'3'.repeat(64)}`,
        manifestObject: `users/${PRO_UID}/vaults/watch-vault/manifests/1-${'3'.repeat(64)}.json`,
        fileCount: 0,
        totalBytes: 0,
        updatedByDeviceId: 'd',
      });
      const start = Date.now();
      while (!seen.includes(first.revision) && Date.now() - start < 10_000) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(seen).toContain(first.revision);
    } finally {
      stop();
    }
  });

  it('syncs a vault end to end through engine + provider + Rules', async () => {
    const deviceAVault = createMemoryVault();
    await deviceAVault.vault.createDirectory(workspacePath('Notes'));
    await deviceAVault.vault.write(
      workspacePath('Notes/lecture.md'),
      new TextEncoder().encode('# Lecture'),
    );
    const first = await reconcileVault({
      vault: deviceAVault.vault,
      remote: proRemote,
      vaultId: 'engine-vault',
      name: 'Engine',
      base: null,
      deviceId: 'device-a',
    });
    expect(first.committed).toBe(true);
    expect(first.revision).toBe(1);

    // A second device pulls the same revision through a fresh provider
    // view and materializes it as ordinary local files.
    const deviceBVault = createMemoryVault();
    const pulled = await reconcileVault({
      vault: deviceBVault.vault,
      remote: proRemote,
      vaultId: 'engine-vault',
      name: 'Engine',
      base: null,
      deviceId: 'device-b',
    });
    expect(pulled.committed).toBe(false);
    expect(
      await deviceBVault.vault.read(workspacePath('Notes/lecture.md')),
    ).toEqual(new TextEncoder().encode('# Lecture'));
  });
});
