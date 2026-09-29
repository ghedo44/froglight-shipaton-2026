/**
 * Persisted merge-base validation conformance.
 *
 * A persisted `SyncBase` is an input to three-way merge and is never
 * trusted structurally or cryptographically:
 *
 * ```text
 * structural: parseSyncManifest + isManifestHash + manifest.vaultId match
 * crypto:     hashManifest(manifest) === base.hash before merge use
 *
 * corruption → CORRUPT_SYNC_METADATA, reconciliation parked for the
 *              binding, all local files preserved, ZERO remote work, and
 *              the binding is NEVER degraded to a brand-new replica.
 * crypto corruption additionally latches `baseCorrupt: true` durably,
 * parks listeners/watcher/scheduler, and is repaired only from
 * cryptographically verified remote state at the last synchronized
 * revision; anything else is `REMATERIALIZE_REQUIRED` (Download & Open).
 * ```
 *
 * The matrix covers every corruption class from the hardening review,
 * plus a forged prepared Download & Open token whose base hash was
 * tampered with after verification, durable latch, restart reload,
 * explicit repair, re-materialization replacement, and
 * identity-interrupted repair.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  AccountStore,
  type AccountTransport,
  type AccountUser,
} from '../account/index.js';
import { createMemoryVault } from '../vault/memory.js';
import { workspacePath } from '../paths.js';
import {
  MemorySyncRemote,
  SYNC_MANIFEST_FORMAT,
  SYNC_PROTOCOL_VERSION,
  type PreparedRemoteVault,
  type StoredSyncState,
  type SyncManifest,
} from '../index.js';
import { VaultSyncStore, createMemorySyncStorage } from './service.js';
import { ObservableVaultService } from './mutations.js';

const UID = 'uid-base-corruption';
const CLOUD = 'cloud-base-corruption';
const LOCAL = 'local-base-corruption';
const BLOB = `sha256:${'a'.repeat(64)}`;
const ZERO_HASH = `sha256:${'0'.repeat(64)}`;

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function flush(times = 12): Promise<void> {
  let chain = Promise.resolve();
  for (let i = 0; i < times; i += 1) chain = chain.then(() => undefined);
  return chain;
}

function createFakeAccount(): {
  store: AccountStore;
  signInAs(uid: string): void;
} {
  let user: AccountUser | null = null;
  const listeners = new Set<(next: AccountUser | null) => void>();
  const announce = (next: AccountUser | null): void => {
    user = next;
    for (const listener of [...listeners]) {
      listener(next === null ? null : { ...next });
    }
  };
  const transport: AccountTransport = {
    async currentUser() {
      return user === null ? null : { ...user };
    },
    async createAccount(email: string) {
      const created: AccountUser = { id: `uid-${email}`, email };
      announce(created);
      return { ...created };
    },
    async signIn(email: string) {
      const signedIn: AccountUser = { id: `uid-${email}`, email };
      announce(signedIn);
      return { ...signedIn };
    },
    async signOut() {
      announce(null);
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
    signInAs: (uid) => announce({ id: uid, email: `${uid}@example.com` }),
  };
}

function manifestFor(
  vaultId: string,
  overrides: Partial<SyncManifest> = {},
): SyncManifest {
  return {
    format: SYNC_MANIFEST_FORMAT,
    version: SYNC_PROTOCOL_VERSION,
    vaultId,
    revision: 1,
    parentHash: null,
    entries: [{ path: 'a.md', kind: 'file', blob: BLOB, size: 1 }],
    ...overrides,
  };
}

function envelopeWithBase(
  base: unknown,
  cloudVaultId: string = CLOUD,
): StoredSyncState {
  return {
    version: 1,
    deviceId: 'device-base',
    accounts: {
      [UID]: {
        bindings: {
          [LOCAL]: {
            cloudVaultId,
            localVaultId: LOCAL,
            name: 'Corrupt',
            deviceId: 'device-base',
            base,
            lastSyncedAt: null,
            lastRevision: 1,
            enabled: true,
          },
        },
        activeLocalVaultId: LOCAL,
      },
    },
  } as unknown as StoredSyncState;
}

/** Load a corrupt-base envelope and prove the parked, non-destructive policy. */
async function assertCorruptBaseParked(base: unknown): Promise<void> {
  const account = createFakeAccount();
  account.signInAs(UID);
  const remote = new MemorySyncRemote();
  const storage = createMemorySyncStorage();
  await storage.save(envelopeWithBase(base));

  const notifications: string[] = [];
  const { vault, state } = createMemoryVault({});
  await vault.write(
    workspacePath('local-only.md'),
    new TextEncoder().encode('keep'),
  );
  const observable = new ObservableVaultService(vault);
  const service = new VaultSyncStore({
    remote,
    account: account.store,
    storage,
    reconciler: {
      handleRemoteApplied: (notification) => {
        notifications.push(...notification.written, ...notification.removed);
      },
    },
  });
  await service.restore();
  service.attach({ localVaultId: LOCAL, vault: observable });

  // The binding SURVIVES (never degraded to a brand-new replica).
  expect(service.isCloudVaultBound(CLOUD)).toBe(true);
  expect(service.snapshot().binding).toMatchObject({
    localVaultId: LOCAL,
    cloudVaultId: CLOUD,
  });

  const callsBefore = remote.calls.length;
  await expect(service.reconcile()).rejects.toMatchObject({
    code: 'CORRUPT_SYNC_METADATA',
  });
  // Zero remote work of any kind: no HEAD read, manifest, blob, or CAS.
  expect(remote.calls.slice(callsBefore)).toEqual([]);
  expect(notifications).toEqual([]);
  // The async digest check aborts whichever cycle detected it; wait for
  // the error to settle rather than sampling between concurrent runs.
  await vi.waitFor(() => {
    expect(service.snapshot().error?.code).toBe('CORRUPT_SYNC_METADATA');
  });

  // Local files are untouched and the binding remains recoverable.
  const bytes = await vault.read(workspacePath('local-only.md'));
  expect(new TextDecoder().decode(bytes)).toBe('keep');
  expect(state.tree.kind).toBe('directory');
  service.dispose();
}

describe('persisted SyncBase corruption (structural)', () => {
  it('malformed entry path parks with CORRUPT_SYNC_METADATA', async () => {
    await assertCorruptBaseParked({
      manifest: manifestFor(CLOUD, {
        entries: [{ path: '../escape.md', kind: 'file', blob: BLOB, size: 1 }],
      }),
      hash: ZERO_HASH,
    });
  });

  it('invalid revision parks with CORRUPT_SYNC_METADATA', async () => {
    await assertCorruptBaseParked({
      manifest: manifestFor(CLOUD, { revision: -1 }),
      hash: ZERO_HASH,
    });
  });

  it('duplicate manifest entry parks with CORRUPT_SYNC_METADATA', async () => {
    await assertCorruptBaseParked({
      manifest: manifestFor(CLOUD, {
        entries: [
          { path: 'a.md', kind: 'file', blob: BLOB, size: 1 },
          { path: 'a.md', kind: 'file', blob: BLOB, size: 1 },
        ],
      }),
      hash: ZERO_HASH,
    });
  });

  it('file/directory collision parks with CORRUPT_SYNC_METADATA', async () => {
    await assertCorruptBaseParked({
      manifest: manifestFor(CLOUD, {
        entries: [
          { path: 'folder', kind: 'directory' },
          { path: 'folder/a.md', kind: 'file', blob: BLOB, size: 1 },
        ],
      }),
      hash: ZERO_HASH,
    });
  });

  it('malformed hash shape parks with CORRUPT_SYNC_METADATA', async () => {
    await assertCorruptBaseParked({
      manifest: manifestFor(CLOUD),
      hash: 'not-a-manifest-hash',
    });
  });

  it('manifest belonging to another cloud vault parks with CORRUPT_SYNC_METADATA', async () => {
    await assertCorruptBaseParked({
      manifest: manifestFor('another-cloud-vault'),
      hash: ZERO_HASH,
    });
  });
});

describe('persisted SyncBase corruption (cryptographic)', () => {
  it('valid-format but wrong digest parks with CORRUPT_SYNC_METADATA', async () => {
    // Structurally perfect (manifest parses, vault matches); only the
    // digest is wrong, so the async verification is the gate.
    await assertCorruptBaseParked({
      manifest: manifestFor(CLOUD),
      hash: ZERO_HASH,
    });
  });
});

describe('forged prepared Download & Open token', () => {
  async function sourceCloud(): Promise<{
    remote: MemorySyncRemote;
    cloudId: string;
    account: AccountStore;
  }> {
    const seederAccount = createFakeAccount();
    seederAccount.signInAs(UID);
    const remote = new MemorySyncRemote();
    const { vault } = createMemoryVault({});
    const observable = new ObservableVaultService(vault);
    await observable.write(
      workspacePath('a.md'),
      new TextEncoder().encode('a'),
    );
    const seeder = new VaultSyncStore({
      remote,
      account: seederAccount.store,
      storage: createMemorySyncStorage(),
    });
    await seeder.restore();
    seeder.attach({ localVaultId: 'seeder', vault: observable });
    await seeder.enable({ localVaultId: 'seeder', name: 'Seeder' });
    await seeder.reconcile();
    const cloudId = seeder.snapshot().binding?.cloudVaultId as string;
    seeder.dispose();
    return { remote, cloudId, account: seederAccount.store };
  }

  it('tampered base hash is rejected before persistence (zero binding, zero remote)', async () => {
    const { remote, cloudId } = await sourceCloud();
    const account = createFakeAccount();
    account.signInAs(UID);
    const storage = createMemorySyncStorage();
    const service = new VaultSyncStore({
      remote,
      account: account.store,
      storage,
    });
    await service.restore();
    const { vault: target } = createMemoryVault({});
    const prepared = await service.materializeRemoteVault(
      cloudId,
      'local-forged',
      target,
    );
    const forged: PreparedRemoteVault = {
      ...prepared,
      base: { ...prepared.base, hash: ZERO_HASH },
    };
    const callsBefore = remote.calls.length;
    const storedBefore = await storage.load();
    await expect(
      service.finalizeMaterializedVault(forged),
    ).rejects.toMatchObject({ code: 'CORRUPT_SYNC_METADATA' });
    expect(service.snapshot().binding).toBeNull();
    expect(service.isCloudVaultBound(cloudId)).toBe(false);
    expect(await storage.load()).toEqual(storedBefore);
    expect(remote.calls.slice(callsBefore)).toEqual([]);
    // Downloaded bytes are still present and usable; the vault is simply
    // unbound (the host keeps it as an ordinary opened local vault).
    expect(
      new TextDecoder().decode(await target.read(workspacePath('a.md'))),
    ).toBe('a');
    service.dispose();
  });

  it('structurally forged base manifest is rejected before persistence', async () => {
    const { remote, cloudId } = await sourceCloud();
    const account = createFakeAccount();
    account.signInAs(UID);
    const service = new VaultSyncStore({
      remote,
      account: account.store,
      storage: createMemorySyncStorage(),
    });
    await service.restore();
    const { vault: target } = createMemoryVault({});
    const prepared = await service.materializeRemoteVault(
      cloudId,
      'local-forged',
      target,
    );
    const forged: PreparedRemoteVault = {
      ...prepared,
      base: {
        ...prepared.base,
        manifest: manifestFor(CLOUD, {
          entries: [{ path: '', kind: 'file', blob: BLOB, size: 1 }],
        }),
      },
    };
    await expect(
      service.finalizeMaterializedVault(forged),
    ).rejects.toMatchObject({ code: 'CORRUPT_SYNC_METADATA' });
    expect(service.snapshot().binding).toBeNull();
    expect(service.isCloudVaultBound(cloudId)).toBe(false);
    service.dispose();
  });
});

/** Seed a cloud vault under UID with one verified file (revision 1). */
async function seedVerifiedCloud(): Promise<{
  remote: MemorySyncRemote;
  cloudId: string;
}> {
  const seederAccount = createFakeAccount();
  seederAccount.signInAs(UID);
  const remote = new MemorySyncRemote();
  const { vault } = createMemoryVault({});
  const observable = new ObservableVaultService(vault);
  await observable.write(workspacePath('a.md'), new TextEncoder().encode('a'));
  const seeder = new VaultSyncStore({
    remote,
    account: seederAccount.store,
    storage: createMemorySyncStorage(),
  });
  await seeder.restore();
  seeder.attach({ localVaultId: 'seeder', vault: observable });
  await seeder.enable({ localVaultId: 'seeder', name: 'Seeder' });
  await seeder.reconcile();
  const cloudId = seeder.snapshot().binding?.cloudVaultId as string;
  seeder.dispose();
  return { remote, cloudId };
}

describe('cryptographic corruption latches durably (state machine)', () => {
  it('first verification latches baseCorrupt, parks listeners, and stops cloud work', async () => {
    const account = createFakeAccount();
    account.signInAs(UID);
    const remote = new MemorySyncRemote();
    const storage = createMemorySyncStorage();
    await storage.save(
      envelopeWithBase({ manifest: manifestFor(CLOUD), hash: ZERO_HASH }),
    );
    const { vault } = createMemoryVault({});
    const observable = new ObservableVaultService(vault);
    const service = new VaultSyncStore({
      remote,
      account: account.store,
      storage,
      tracker: null,
      debounceMs: 3_600_000,
    });
    await service.restore();
    service.attach({ localVaultId: LOCAL, vault: observable });
    // Crypto verification is async and happens at the pre-merge gate: not
    // yet latched at attach time.
    expect(service.snapshot().error).toBeNull();

    const callsBefore = remote.calls.length;
    await expect(service.reconcile()).rejects.toMatchObject({
      code: 'CORRUPT_SYNC_METADATA',
    });
    // Zero remote work of any kind (the gate runs before any read).
    expect(remote.calls.slice(callsBefore)).toEqual([]);

    // Durable latch via copy-on-write metadata transition.
    const stored = await storage.load();
    expect(stored?.accounts[UID]?.bindings[LOCAL]?.baseCorrupt).toBe(true);
    // The structurally parsed base is preserved for the repair path (it
    // is never degraded to "brand new replica").
    expect(stored?.accounts[UID]?.bindings[LOCAL]?.base).not.toBeNull();

    // Listeners/watcher parked: a local mutation neither counts nor
    // schedules cloud work.
    await vault.write(
      workspacePath('local-only.md'),
      new TextEncoder().encode('keep'),
    );
    await flush();
    expect(service.snapshot().pendingChanges).toBe(0);

    // Subsequent attempts stay parked with zero remote work.
    const callsAfterLatch = remote.calls.length;
    await expect(service.reconcile()).rejects.toMatchObject({
      code: 'CORRUPT_SYNC_METADATA',
    });
    expect(remote.calls.length).toBe(callsAfterLatch);
    expect(
      new TextDecoder().decode(
        await vault.read(workspacePath('local-only.md')),
      ),
    ).toBe('keep');
    service.dispose();
  });

  it('restart reloads the persisted corrupt marker parked with zero remote work', async () => {
    const account = createFakeAccount();
    account.signInAs(UID);
    const remote = new MemorySyncRemote();
    const storage = createMemorySyncStorage();
    await storage.save(
      envelopeWithBase({ manifest: manifestFor(CLOUD), hash: ZERO_HASH }),
    );
    const first = new VaultSyncStore({
      remote,
      account: account.store,
      storage,
      tracker: null,
      debounceMs: 3_600_000,
    });
    await first.restore();
    first.attach({
      localVaultId: LOCAL,
      vault: new ObservableVaultService(createMemoryVault({}).vault),
    });
    await expect(first.reconcile()).rejects.toMatchObject({
      code: 'CORRUPT_SYNC_METADATA',
    });
    first.dispose();

    // Fresh service over the same durable state: parked immediately.
    const second = new VaultSyncStore({
      remote,
      account: account.store,
      storage,
      tracker: null,
      debounceMs: 3_600_000,
    });
    await second.restore();
    second.attach({
      localVaultId: LOCAL,
      vault: new ObservableVaultService(createMemoryVault({}).vault),
    });
    expect(second.snapshot().error?.code).toBe('CORRUPT_SYNC_METADATA');
    const callsBefore = remote.calls.length;
    await expect(second.reconcile()).rejects.toMatchObject({
      code: 'CORRUPT_SYNC_METADATA',
    });
    expect(remote.calls.length).toBe(callsBefore);
    second.dispose();
  });
});

describe('explicit repair (verified ancestor reconstruction)', () => {
  it('rebuilds from verified remote state when remote is at the last synced revision', async () => {
    const { remote, cloudId } = await seedVerifiedCloud();
    const account = createFakeAccount();
    account.signInAs(UID);
    const storage = createMemorySyncStorage();
    await storage.save(
      envelopeWithBase(
        { manifest: manifestFor(cloudId), hash: ZERO_HASH },
        cloudId,
      ),
    );
    const { vault } = createMemoryVault({});
    const observable = new ObservableVaultService(vault);
    // Mimic a real materialized replica: local bytes match revision 1,
    // plus one unsynced local file.
    await observable.write(
      workspacePath('a.md'),
      new TextEncoder().encode('a'),
    );
    await observable.write(
      workspacePath('local-only.md'),
      new TextEncoder().encode('keep'),
    );
    const service = new VaultSyncStore({
      remote,
      account: account.store,
      storage,
      tracker: null,
      debounceMs: 3_600_000,
    });
    await service.restore();
    service.attach({ localVaultId: LOCAL, vault: observable });
    await expect(service.reconcile()).rejects.toMatchObject({
      code: 'CORRUPT_SYNC_METADATA',
    });
    const corruptState = await storage.load();
    expect(corruptState?.accounts[UID]?.bindings[LOCAL]?.baseCorrupt).toBe(
      true,
    );

    await service.repairCorruptBinding();

    const head = await remote.readHead(cloudId);
    const repaired = await storage.load();
    const binding = repaired?.accounts[UID]?.bindings[LOCAL];
    expect(binding?.baseCorrupt).toBeUndefined();
    expect(binding?.base?.hash).toBe(head?.manifestHash);
    expect(service.snapshot().error).toBeNull();

    // Local safety + resumed sync: local files survive, the unsynced
    // local file uploads as revision 2.
    await service.reconcile();
    expect(service.snapshot().lastRevision).toBe(2);
    expect(
      new TextDecoder().decode(await vault.read(workspacePath('a.md'))),
    ).toBe('a');
    expect(
      new TextDecoder().decode(
        await vault.read(workspacePath('local-only.md')),
      ),
    ).toBe('keep');
    const afterSync = await storage.load();
    expect(
      afterSync?.accounts[UID]?.bindings[LOCAL]?.baseCorrupt,
    ).toBeUndefined();
    service.dispose();
  });

  it('refuses an advanced remote with REMATERIALIZE_REQUIRED and stays parked', async () => {
    const { remote, cloudId } = await seedVerifiedCloud();
    // Another device advances the cloud to revision 2 after this
    // device's last synchronized revision (1).
    const account = createFakeAccount();
    account.signInAs(UID);
    const advancer = new VaultSyncStore({
      remote,
      account: account.store,
      storage: createMemorySyncStorage(),
    });
    await advancer.restore();
    const { vault: advanceVault } = createMemoryVault({});
    const advanceObs = new ObservableVaultService(advanceVault);
    advancer.attach({ localVaultId: 'advancer', vault: advanceObs });
    await advancer.attachRemoteVault(cloudId, 'advancer');
    await advanceObs.write(
      workspacePath('advanced.md'),
      new TextEncoder().encode('r2'),
    );
    await advancer.reconcile();
    expect(advancer.snapshot().lastRevision).toBe(2);
    advancer.dispose();

    // The damaged replica is still at lastRevision 1 with a corrupt base.
    const storage = createMemorySyncStorage();
    await storage.save(
      envelopeWithBase(
        { manifest: manifestFor(cloudId), hash: ZERO_HASH },
        cloudId,
      ),
    );
    const { vault } = createMemoryVault({});
    const observable = new ObservableVaultService(vault);
    await observable.write(
      workspacePath('local.md'),
      new TextEncoder().encode('local'),
    );
    const service = new VaultSyncStore({
      remote,
      account: account.store,
      storage,
      tracker: null,
      debounceMs: 3_600_000,
    });
    await service.restore();
    service.attach({ localVaultId: LOCAL, vault: observable });
    await expect(service.reconcile()).rejects.toMatchObject({
      code: 'CORRUPT_SYNC_METADATA',
    });

    const callsBefore = remote.calls.length;
    await expect(service.repairCorruptBinding()).rejects.toMatchObject({
      code: 'REMATERIALIZE_REQUIRED',
    });
    // Read-only attempt: no cloud writes, no installed repair.
    expect(
      remote.calls
        .slice(callsBefore)
        .filter(
          (call) =>
            call.startsWith('uploadBlob') ||
            call.startsWith('uploadManifest') ||
            call.startsWith('compareAndSwapHead'),
        ),
    ).toEqual([]);
    const stillCorrupt = await storage.load();
    expect(stillCorrupt?.accounts[UID]?.bindings[LOCAL]?.baseCorrupt).toBe(
      true,
    );
    expect(service.snapshot().error?.code).toBe('CORRUPT_SYNC_METADATA');
    expect(
      new TextDecoder().decode(await vault.read(workspacePath('local.md'))),
    ).toBe('local');
    service.dispose();
  });

  it('refuses cryptographically corrupt remote state and preserves the park', async () => {
    const { remote, cloudId } = await seedVerifiedCloud();
    const account = createFakeAccount();
    account.signInAs(UID);
    const storage = createMemorySyncStorage();
    await storage.save(
      envelopeWithBase(
        { manifest: manifestFor(cloudId), hash: ZERO_HASH },
        cloudId,
      ),
    );
    const { vault } = createMemoryVault({});
    const service = new VaultSyncStore({
      remote,
      account: account.store,
      storage,
      tracker: null,
      debounceMs: 3_600_000,
    });
    await service.restore();
    service.attach({
      localVaultId: LOCAL,
      vault: new ObservableVaultService(vault),
    });
    await expect(service.reconcile()).rejects.toMatchObject({
      code: 'CORRUPT_SYNC_METADATA',
    });

    // Simulate a cloud copy that does not hash to its HEAD pointer.
    const originalLoad = remote.loadManifest.bind(remote);
    remote.loadManifest = async (vaultId, hash, object) => {
      const real = await originalLoad(vaultId, hash, object);
      return {
        ...real,
        entries: [
          ...real.entries,
          { path: 'evil.md', kind: 'file' as const, blob: BLOB, size: 1 },
        ],
      };
    };
    try {
      await expect(service.repairCorruptBinding()).rejects.toMatchObject({
        code: 'CORRUPT_MANIFEST',
      });
    } finally {
      remote.loadManifest = originalLoad;
    }
    const stillCorrupt = await storage.load();
    expect(stillCorrupt?.accounts[UID]?.bindings[LOCAL]?.baseCorrupt).toBe(
      true,
    );
    expect(service.snapshot().error?.code).toBe('CORRUPT_SYNC_METADATA');
    service.dispose();
  });

  it('a repair interrupted by an account switch installs nothing under B', async () => {
    const { remote, cloudId } = await seedVerifiedCloud();
    const account = createFakeAccount();
    account.signInAs(UID);
    const storage = createMemorySyncStorage();
    await storage.save(
      envelopeWithBase(
        { manifest: manifestFor(cloudId), hash: ZERO_HASH },
        cloudId,
      ),
    );
    const { vault } = createMemoryVault({});
    const service = new VaultSyncStore({
      remote,
      account: account.store,
      storage,
      tracker: null,
      debounceMs: 3_600_000,
    });
    await service.restore();
    service.attach({
      localVaultId: LOCAL,
      vault: new ObservableVaultService(vault),
    });
    await expect(service.reconcile()).rejects.toMatchObject({
      code: 'CORRUPT_SYNC_METADATA',
    });

    // Gate the repair's HEAD read; switch accounts while it is in flight.
    const head = await remote.readHead(cloudId);
    const originalReadHead = remote.readHead.bind(remote);
    const reached = deferred<void>();
    const release = deferred<void>();
    remote.readHead = async (vaultId: string) => {
      if (vaultId === cloudId) {
        reached.resolve();
        await release.promise;
        return head;
      }
      return originalReadHead(vaultId);
    };
    const repairing = service.repairCorruptBinding();
    await reached.promise;
    await account.store.signOut();
    account.signInAs('uid-repair-b');
    await flush();
    release.resolve();
    await expect(repairing).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' });
    await flush();

    const stored = await storage.load();
    expect(stored?.accounts['uid-repair-b']).toBeUndefined();
    expect(stored?.accounts[UID]?.bindings[LOCAL]?.baseCorrupt).toBe(true);
    service.dispose();
  });
});

describe('re-materialization replaces a corrupt binding (Strategy A)', () => {
  it('replaces the parked corrupt binding only after verified activation', async () => {
    const { remote, cloudId } = await seedVerifiedCloud();
    const account = createFakeAccount();
    account.signInAs(UID);
    const storage = createMemorySyncStorage();
    await storage.save(
      envelopeWithBase(
        { manifest: manifestFor(cloudId), hash: ZERO_HASH },
        cloudId,
      ),
    );
    const { vault } = createMemoryVault({});
    const service = new VaultSyncStore({
      remote,
      account: account.store,
      storage,
      tracker: null,
      debounceMs: 3_600_000,
    });
    await service.restore();
    service.attach({
      localVaultId: LOCAL,
      vault: new ObservableVaultService(vault),
    });
    await expect(service.reconcile()).rejects.toMatchObject({
      code: 'CORRUPT_SYNC_METADATA',
    });
    const callsBefore = remote.calls.length;

    // Prepare a fresh, verified replica; still nothing persisted.
    const { vault: target } = createMemoryVault({});
    const prepared = await service.materializeRemoteVault(
      cloudId,
      'local-recovered',
      target,
    );
    expect(
      new TextDecoder().decode(await target.read(workspacePath('a.md'))),
    ).toBe('a');
    const beforeFinalize = await storage.load();
    expect(beforeFinalize?.accounts[UID]?.bindings[LOCAL]?.baseCorrupt).toBe(
      true,
    );
    // Activation attaches the fresh store under the prepared identity.
    service.attach({
      localVaultId: 'local-recovered',
      vault: new ObservableVaultService(target),
    });
    await service.finalizeMaterializedVault(prepared);

    const stored = await storage.load();
    const bindings = stored?.accounts[UID]?.bindings ?? {};
    // The corrupt binding is replaced; its local vault files were never
    // touched (the vault is simply unbound and remains a local vault).
    expect(bindings[LOCAL]).toBeUndefined();
    expect(bindings['local-recovered']).toMatchObject({
      cloudVaultId: cloudId,
      enabled: true,
    });
    expect(bindings['local-recovered']?.baseCorrupt).toBeUndefined();
    // The verified materialization was downloaded, not merged.
    expect(remote.calls.slice(callsBefore)).toContain(
      `downloadBlob:${cloudId}:${prepared.base.manifest.entries[0]?.blob}`,
    );
    expect(service.snapshot().bindings).toHaveLength(1);

    // Synced work resumes under the fresh binding (host reports the opened
    // vault; presentation state is host-owned).
    service.setActiveLocalVault('local-recovered');
    await service.reconcile();
    expect(service.snapshot().lastRevision).toBeGreaterThanOrEqual(1);
    service.dispose();
  });
});
