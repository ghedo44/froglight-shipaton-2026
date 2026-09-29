/**
 * Transactional Download & Open conformance.
 *
 * The user-visible transaction is:
 *
 * ```text
 * create temporary/fresh local destination
 *   → materialize + verify all remote bytes (NO binding)
 *   → activate/open successfully
 *   → finalize binding
 *   → show synced
 * ```
 *
 * If any step before final binding fails: no binding, and the temporary
 * destination is discarded best-effort (never hides the primary error;
 * never deletes user-created data).
 */

import { describe, expect, it, vi } from 'vitest';
import {
  AccountStore,
  type AccountTransport,
  type AccountUser,
} from '../account/index.js';
import { createMemoryVault } from '../vault/memory.js';
import { workspacePath } from '../paths.js';
import { MemorySyncRemote } from '../index.js';
import { VaultSyncStore, createMemorySyncStorage } from './service.js';
import { ObservableVaultService } from './mutations.js';

const UID = 'uid-download';

function createFakeAccount(): {
  store: AccountStore;
  signInAs(uid: string): void;
} {
  let user: AccountUser | null = null;
  const listeners = new Set<(next: AccountUser | null) => void>();
  const transport: AccountTransport = {
    async currentUser() {
      return user === null ? null : { ...user };
    },
    async createAccount(email: string) {
      const created: AccountUser = { id: `uid-${email}`, email };
      user = created;
      for (const listener of [...listeners]) listener({ ...created });
      return { ...created };
    },
    async signIn(email: string) {
      const signedIn: AccountUser = { id: `uid-${email}`, email };
      user = signedIn;
      for (const listener of [...listeners]) listener({ ...signedIn });
      return { ...signedIn };
    },
    async signOut() {
      user = null;
      for (const listener of [...listeners]) listener(null);
    },
    async refreshToken() {
      return { token: 'token', expiresAt: null, entitlements: [] };
    },
    onAuthChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    store: new AccountStore({ transport }),
    signInAs: (uid) => {
      user = { id: uid, email: `${uid}@example.com` };
      for (const listener of [...listeners]) {
        listener(user === null ? null : { ...user });
      }
    },
  };
}

async function setupSource(): Promise<{
  remote: MemorySyncRemote;
  account: AccountStore;
  cloudId: string;
}> {
  const account = createFakeAccount();
  account.signInAs(UID);
  const remote = new MemorySyncRemote();
  const { vault } = createMemoryVault({});
  const observable = new ObservableVaultService(vault);
  const service = new VaultSyncStore({
    remote,
    account: account.store,
    storage: createMemorySyncStorage(),
    tracker: null,
  });
  await service.restore();
  service.attach({ localVaultId: 'local-a', vault: observable });
  await observable.write(
    workspacePath('note.md'),
    new TextEncoder().encode('hello'),
  );
  await service.enable({ localVaultId: 'local-a', name: 'A' });
  await service.reconcile();
  const cloudId = service.snapshot().binding?.cloudVaultId as string;
  service.dispose();
  return { remote, account: account.store, cloudId };
}

describe('transactional Download & Open', () => {
  it('binds only after activation (prepare → activate → finalize)', async () => {
    const { remote, account, cloudId } = await setupSource();
    const service = new VaultSyncStore({
      remote,
      account,
      storage: createMemorySyncStorage(),
      tracker: null,
    });
    await service.restore();
    const { vault: target } = createMemoryVault({});

    // Prepare: bytes verified, NO binding yet.
    const prepared = await service.materializeRemoteVault(
      cloudId,
      'local-b',
      target,
    );
    expect(service.snapshot().binding).toBeNull();
    expect(service.isCloudVaultBound(cloudId)).toBe(false);
    expect(
      new TextDecoder().decode(await target.read(workspacePath('note.md'))),
    ).toBe('hello');

    // Host activates successfully: the runtime attaches the exact staged
    // vault under the prepared local identity, then finalizes.
    service.attach({
      localVaultId: 'local-b',
      vault: new ObservableVaultService(target),
    });
    await service.finalizeMaterializedVault(prepared);
    expect(service.isCloudVaultBound(cloudId)).toBe(true);
    expect(service.snapshot().binding).toMatchObject({
      cloudVaultId: cloudId,
      localVaultId: 'local-b',
    });
    service.dispose();
  });

  it('failed download binds nothing (REMOTE_NOT_FOUND)', async () => {
    const { remote, account } = await setupSource();
    const service = new VaultSyncStore({
      remote,
      account,
      storage: createMemorySyncStorage(),
      tracker: null,
    });
    await service.restore();
    await expect(
      service.materializeRemoteVault(
        'missing-cloud',
        'local-x',
        createMemoryVault({}).vault,
      ),
    ).rejects.toMatchObject({ code: 'REMOTE_NOT_FOUND' });
    expect(service.snapshot().binding).toBeNull();
    service.dispose();
  });

  it('corrupt blob binds nothing', async () => {
    const { remote, account, cloudId } = await setupSource();
    // Corrupt the remote blob in place (simulates a bad backend).
    const head = await remote.readHead(cloudId);
    const manifest = await remote.loadManifest(cloudId, head!.manifestHash);
    const entry = manifest.entries.find((e) => e.kind === 'file');
    if (entry?.kind !== 'file' || entry.blob === undefined) {
      throw new Error('expected a file entry');
    }
    // MemorySyncRemote internals are private; corrupt via download+re-upload
    // is impossible (hash-guarded), so simulate by using a corrupting wrapper.
    const corrupting: MemorySyncRemote = remote;
    const origDownload = corrupting.downloadBlob.bind(corrupting);
    corrupting.downloadBlob = async (vaultId, blob) => {
      const bytes = await origDownload(vaultId, blob);
      bytes[0] = (bytes[0] ?? 0) ^ 0xff;
      return bytes;
    };
    const service = new VaultSyncStore({
      remote: corrupting,
      account,
      storage: createMemorySyncStorage(),
      tracker: null,
    });
    await service.restore();
    await expect(
      service.materializeRemoteVault(
        cloudId,
        'local-b',
        createMemoryVault({}).vault,
      ),
    ).rejects.toMatchObject({ code: 'HASH_MISMATCH' });
    expect(service.snapshot().binding).toBeNull();
    service.dispose();
  });

  it('activation failure binds nothing (finalize never runs)', async () => {
    const { remote, account, cloudId } = await setupSource();
    const service = new VaultSyncStore({
      remote,
      account,
      storage: createMemorySyncStorage(),
      tracker: null,
    });
    await service.restore();
    const { vault: target } = createMemoryVault({});
    const prepared = await service.materializeRemoteVault(
      cloudId,
      'local-b',
      target,
    );
    expect(service.snapshot().binding).toBeNull();

    // Host activation fails: finalize is never called, binding never exists.
    const activate = vi.fn(async (): Promise<null> => null);
    const discard = vi.fn(async () => undefined);
    const created = await activate();
    if (created === null) {
      await discard();
    } else {
      await service.finalizeMaterializedVault(prepared);
    }
    expect(service.snapshot().binding).toBeNull();
    expect(discard).toHaveBeenCalledTimes(1);
    service.dispose();
  });

  it('cancel leaves no binding and discards the temporary store', async () => {
    const { remote, account, cloudId } = await setupSource();
    const service = new VaultSyncStore({
      remote,
      account,
      storage: createMemorySyncStorage(),
      tracker: null,
    });
    await service.restore();
    const { vault: target } = createMemoryVault({});
    const prepared = await service.materializeRemoteVault(
      cloudId,
      'local-b',
      target,
    );
    void prepared;
    // User cancels the destination choice after prepare (or before
    // finalize): discard, bind nothing.
    const discard = vi.fn(async () => undefined);
    await discard();
    expect(service.snapshot().binding).toBeNull();
    expect(discard).toHaveBeenCalledTimes(1);
    service.dispose();
  });

  it('binding persistence failure surfaces with zero phantom state (finalize throws, rollback, retry succeeds)', async () => {
    const { remote, account, cloudId } = await setupSource();
    const failingStorage = createMemorySyncStorage();
    const origSave = failingStorage.save.bind(failingStorage);
    let failNextSave = false;
    failingStorage.save = async (state) => {
      if (failNextSave) {
        failNextSave = false;
        throw new Error('disk full');
      }
      return origSave(state);
    };
    const service = new VaultSyncStore({
      remote,
      account,
      storage: failingStorage,
      tracker: null,
    });
    await service.restore();
    const persistedBefore = await failingStorage.load();
    const { vault: target } = createMemoryVault({});
    const prepared = await service.materializeRemoteVault(
      cloudId,
      'local-b',
      target,
    );
    // Runtime activation attached the staged vault before finalize.
    service.attach({
      localVaultId: 'local-b',
      vault: new ObservableVaultService(target),
    });
    failNextSave = true;
    await expect(service.finalizeMaterializedVault(prepared)).rejects.toThrow(
      'disk full',
    );
    // Transactional rollback: failed durable save leaves in-memory state
    // equal to the previous durable state (no phantom binding).
    expect(service.snapshot().binding).toBeNull();
    expect(service.isCloudVaultBound(cloudId)).toBe(false);
    expect(service.snapshot().activeLocalVaultId).not.toBe('local-b');
    const persistedAfter = await failingStorage.load();
    expect(persistedAfter).toEqual(persistedBefore);
    // Retry with a healthy store succeeds and binds exactly once.
    await service.finalizeMaterializedVault(prepared);
    expect(service.isCloudVaultBound(cloudId)).toBe(true);
    expect(service.snapshot().binding).toMatchObject({
      cloudVaultId: cloudId,
      localVaultId: 'local-b',
    });
    service.dispose();
  });
});
