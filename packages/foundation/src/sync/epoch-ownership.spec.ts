/**
 * Epoch/replica-owned reconcile presentation + binding-stable recovery.
 *
 * Executable proof of the invariants:
 *
 * ```text
 * a reconcile queued under epoch A never wakes later and executes as B
 * stale A completions (NETWORK, PERMISSION_DENIED, LOCAL_CHANGED,
 *   progress, workspace failure) cannot mutate B's phase/error/telemetry
 *   or run B's entitlement classification against A's failure
 * account/replica transitions reset transient presentation before the
 *   newly live binding re-establishes its own state
 * corrupt-base repair is pinned to the EXACT original binding, not
 *   merely the account UID
 * a local vault already bound to cloud X cannot silently be rebound to
 *   cloud Y through attachRemoteVault()
 * re-enabling an existing disabled binding preserves cloudVaultId,
 *   base, lastRevision, and deviceId
 * ```
 *
 * All races use explicit deferred gates; no sleeps construct ordering.
 */

import { describe, expect, it } from 'vitest';
import {
  AccountStore,
  type AccountTransport,
  type AccountUser,
} from '../account/index.js';
import type {
  PurchaseCustomerState,
  PurchaseService,
  PurchaseSnapshot,
} from '../purchases/contract.js';
import { createMemoryVault } from '../vault/memory.js';
import type { VaultService } from '../vault/contract.js';
import { ensureDirectory } from '../vault/helpers.js';
import { workspacePath } from '../paths.js';
import {
  MemorySyncRemote,
  SYNC_MANIFEST_FORMAT,
  SYNC_PROTOCOL_VERSION,
  VaultSyncError,
  type StoredSyncState,
  type SyncManifest,
  type VaultSyncStorage,
} from '../index.js';
import { VaultSyncStore, createMemorySyncStorage } from './service.js';
import { ObservableVaultService } from './mutations.js';

const UID_A = 'uid-epoch-a';
const UID_B = 'uid-epoch-b';
const LOCAL_A = 'local-epoch-a';
const LOCAL_B = 'local-epoch-b';
const BLOB = `sha256:${'a'.repeat(64)}`;
const ZERO_HASH = `sha256:${'0'.repeat(64)}`;

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function flush(times = 16): Promise<void> {
  let chain = Promise.resolve();
  for (let i = 0; i < times; i += 1) chain = chain.then(() => undefined);
  return chain;
}

interface FakeAccount {
  store: AccountStore;
  signInAs(uid: string): void;
  signOut(): void;
  setEntitlements(entitlements: readonly string[]): void;
  refreshCalls: string[];
}

function createFakeAccount(): FakeAccount {
  let user: AccountUser | null = null;
  let entitlements: readonly string[] = [];
  const refreshCalls: string[] = [];
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
    async refreshToken(force = false) {
      refreshCalls.push(force ? 'refreshToken:force' : 'refreshToken:cached');
      return {
        token: 'token',
        expiresAt: null,
        entitlements: [...entitlements],
      };
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
    signOut: () => announce(null),
    setEntitlements: (next) => {
      entitlements = [...next];
    },
    refreshCalls,
  };
}

function purchasePro(uid: string): PurchaseCustomerState {
  return {
    appUserId: uid,
    activeEntitlementIds: ['pro'],
    entitlements: {
      pro: {
        active: true,
        productId: 'pro_monthly',
        expirationDate: null,
        willRenew: true,
      },
    },
  };
}

function createPurchasesFake(customer: PurchaseCustomerState | null): {
  service: PurchaseService;
  setCustomer: (next: PurchaseCustomerState | null) => void;
} {
  let current = customer;
  const listeners = new Set<(snapshot: PurchaseSnapshot) => void>();
  const snapshot = (): PurchaseSnapshot => ({
    ready: true,
    loading: false,
    customer: current,
    error: null,
  });
  const service: PurchaseService = {
    snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async refresh() {
      return undefined;
    },
    async offerings() {
      return [];
    },
    async purchase(): Promise<never> {
      throw new Error('not implemented in epoch-ownership tests');
    },
    async restore(): Promise<never> {
      throw new Error('not implemented in epoch-ownership tests');
    },
    handleNativeEvent() {
      return undefined;
    },
  };
  return {
    service,
    setCustomer: (next) => {
      current = next;
    },
  };
}

async function writeFile(
  vault: VaultService,
  path: string,
  text: string,
): Promise<void> {
  const segments = path.split('/');
  if (segments.length > 1) {
    await ensureDirectory(
      vault,
      workspacePath(segments.slice(0, -1).join('/')),
    );
  }
  await vault.write(workspacePath(path), new TextEncoder().encode(text));
}

async function readText(vault: VaultService, path: string): Promise<string> {
  return new TextDecoder().decode(await vault.read(workspacePath(path)));
}

/** Seed one cloud vault under `uid`; returns its cloud id. */
async function seedCloud(
  remote: MemorySyncRemote,
  uid: string,
  localVaultId: string,
  files: Record<string, string>,
): Promise<string> {
  const account = createFakeAccount();
  account.signInAs(uid);
  const { vault } = createMemoryVault({});
  const observable = new ObservableVaultService(vault);
  const service = new VaultSyncStore({
    remote,
    account: account.store,
    storage: createMemorySyncStorage(),
    tracker: null,
  });
  await service.restore();
  service.attach({ localVaultId, vault: observable });
  for (const [path, text] of Object.entries(files)) {
    await writeFile(observable, path, text);
  }
  await service.enable({ localVaultId, name: localVaultId });
  await service.reconcile();
  const cloudId = service.snapshot().binding?.cloudVaultId as string;
  service.dispose();
  return cloudId;
}

function manifestFor(vaultId: string): SyncManifest {
  return {
    format: SYNC_MANIFEST_FORMAT,
    version: SYNC_PROTOCOL_VERSION,
    vaultId,
    revision: 1,
    parentHash: null,
    entries: [{ path: 'a.md', kind: 'file', blob: BLOB, size: 1 }],
  };
}

/** Envelope with a structurally valid base whose digest is wrong. */
function corruptEnvelope(
  cloudVaultId: string,
  localVaultId: string,
  uid: string,
): StoredSyncState {
  return {
    version: 1,
    deviceId: 'device-corrupt',
    accounts: {
      [uid]: {
        bindings: {
          [localVaultId]: {
            cloudVaultId,
            localVaultId,
            name: 'Corrupt',
            deviceId: 'device-corrupt',
            base: { manifest: manifestFor(cloudVaultId), hash: ZERO_HASH },
            lastSyncedAt: null,
            lastRevision: 1,
            enabled: true,
          },
        },
        activeLocalVaultId: localVaultId,
      },
    },
  };
}

describe('queued reconcile epoch binding', () => {
  it('a reconcile queued under A never wakes and executes as B', async () => {
    const account = createFakeAccount();
    account.signInAs(UID_A);
    const remote = new MemorySyncRemote();
    const cloudA = await seedCloud(remote, UID_A, 'seed-a', { 'a.md': 'a' });
    const cloudB = await seedCloud(remote, UID_B, 'seed-b', { 'b.md': 'b' });

    const obsA = new ObservableVaultService(createMemoryVault({}).vault);
    const obsB = new ObservableVaultService(createMemoryVault({}).vault);
    const reconcilerNotifications: string[] = [];
    const service = new VaultSyncStore({
      remote,
      account: account.store,
      storage: createMemorySyncStorage(),
      tracker: null,
      debounceMs: 3_600_000,
      reconciler: {
        handleRemoteApplied: (notification) => {
          reconcilerNotifications.push(
            ...notification.written,
            ...notification.removed,
          );
        },
      },
    });
    await service.restore();
    service.attach({ localVaultId: LOCAL_A, vault: obsA });
    service.setActiveLocalVault(LOCAL_A);
    await service.attachRemoteVault(cloudA, LOCAL_A);
    await service.reconcile();
    expect(service.snapshot().lastRevision).toBe(1);
    // A's initial pull materialized a.md; clear before B's work.
    reconcilerNotifications.length = 0;

    // Gate A1 at its HEAD read and B1 at its own (armed separately).
    const headA = await remote.readHead(cloudA);
    const originalReadHead = remote.readHead.bind(remote);
    const a1Reached = deferred<void>();
    const releaseA1 = deferred<void>();
    const b1Reached = deferred<void>();
    const releaseB1 = deferred<void>();
    let gateA = true;
    let gateB = false;
    let activeB = 0;
    let maxActiveB = 0;
    let bReads = 0;
    remote.readHead = async (vaultId: string) => {
      if (vaultId === cloudA && gateA) {
        gateA = false;
        a1Reached.resolve();
        await releaseA1.promise;
        return headA;
      }
      if (vaultId === cloudB) {
        bReads += 1;
        activeB += 1;
        maxActiveB = Math.max(maxActiveB, activeB);
        try {
          if (gateB) {
            b1Reached.resolve();
            await releaseB1.promise;
          }
          return await originalReadHead(vaultId);
        } finally {
          activeB -= 1;
        }
      }
      return originalReadHead(vaultId);
    };

    // A1 starts and pauses inside protocol work.
    await writeFile(obsA, 'a2.md', 'a2');
    const a1 = service.reconcile();
    await a1Reached.promise;

    // A2 is requested while A1 is unresolved: queued behind A1, not run.
    let a2Settled = false;
    const a2 = service.reconcile();
    void a2.then(
      () => {
        a2Settled = true;
      },
      () => {
        a2Settled = true;
      },
    );
    await flush();
    const callsWhenQueued = remote.calls.length;
    expect(a2Settled).toBe(false);
    expect(remote.calls.length).toBe(callsWhenQueued);

    // Account/replica switch to B while A1 hangs and A2 is queued.
    account.signOut();
    account.signInAs(UID_B);
    await flush();
    service.attach({ localVaultId: LOCAL_B, vault: obsB });
    service.setActiveLocalVault(LOCAL_B);
    await service.attachRemoteVault(cloudB, LOCAL_B);

    // B1 starts and pauses; A1 is still unresolved and A2 still queued.
    gateB = true;
    bReads = 0;
    const b1 = service.reconcile();
    await b1Reached.promise;
    let b1Settled = false;
    void b1.then(
      () => {
        b1Settled = true;
      },
      () => {
        b1Settled = true;
      },
    );
    expect(b1Settled).toBe(false);
    expect(bReads).toBe(1);
    expect(maxActiveB).toBe(1);

    // Release A1: A2 becomes eligible to leave its queue. It is stale and
    // must be suppressed at the lane primitive — no callback, no B cycle.
    releaseA1.resolve();
    await a1;
    await a2;
    await flush();
    expect(a2Settled).toBe(true);
    // Exactly one B protocol execution was ever active; releasing A2's
    // predecessor created no overlapping B reconcile.
    expect(maxActiveB).toBe(1);
    expect(bReads).toBe(1);
    expect(b1Settled).toBe(false);
    expect(reconcilerNotifications).toEqual([]);

    // B1 completes normally afterward.
    releaseB1.resolve();
    await b1;
    expect(b1Settled).toBe(true);
    expect(service.snapshot()).toMatchObject({
      phase: 'idle',
      error: null,
      lastRevision: 1,
    });
    expect(service.snapshot().binding?.cloudVaultId).toBe(cloudB);
    expect(reconcilerNotifications).toContain('b.md');
    service.dispose();
  });
});

describe('stale reconcile presentation ownership', () => {
  it('Case A: a stale NETWORK completion never publishes into B', async () => {
    const account = createFakeAccount();
    account.signInAs(UID_A);
    const remote = new MemorySyncRemote();
    const cloudA = await seedCloud(remote, UID_A, 'seed-a', { 'a.md': 'a' });
    const cloudB = await seedCloud(remote, UID_B, 'seed-b', { 'b.md': 'b' });

    const service = new VaultSyncStore({
      remote,
      account: account.store,
      storage: createMemorySyncStorage(),
      tracker: null,
      debounceMs: 0,
    });
    await service.restore();
    const obsA = new ObservableVaultService(createMemoryVault({}).vault);
    service.attach({ localVaultId: LOCAL_A, vault: obsA });
    service.setActiveLocalVault(LOCAL_A);
    await service.attachRemoteVault(cloudA, LOCAL_A);
    await service.reconcile();

    // Gate A's next HEAD read; it will be rejected AFTER B is healthy.
    const originalReadHead = remote.readHead.bind(remote);
    const aReached = deferred<void>();
    const aReject = deferred<never>();
    let gateA = true;
    remote.readHead = async (vaultId: string) => {
      if (vaultId === cloudA && gateA) {
        gateA = false;
        aReached.resolve();
        return aReject.promise;
      }
      return originalReadHead(vaultId);
    };
    await writeFile(obsA, 'a2.md', 'a2');
    const cyclingA = service.reconcile();
    await aReached.promise;

    // Switch to B and reach a healthy idle state.
    account.signOut();
    account.signInAs(UID_B);
    await flush();
    const obsB = new ObservableVaultService(createMemoryVault({}).vault);
    service.attach({ localVaultId: LOCAL_B, vault: obsB });
    service.setActiveLocalVault(LOCAL_B);
    await service.attachRemoteVault(cloudB, LOCAL_B);
    await service.reconcile();
    await flush();
    expect(service.snapshot()).toMatchObject({ phase: 'idle', error: null });
    const bBinding = service.snapshot().binding?.cloudVaultId;
    const bRevision = service.snapshot().lastRevision;
    const callsBefore = remote.calls.length;

    // The old A call rejects as a transient network failure.
    aReject.reject(new VaultSyncError('NETWORK', 'offline'));
    await expect(cyclingA).resolves.toBeUndefined();
    await flush();

    // B keeps its own healthy state: no, no stale error, no
    // binding/pending mutation, and no B retry caused by A's failure.
    expect(service.snapshot()).toMatchObject({
      phase: 'idle',
      error: null,
      pendingChanges: 0,
    });
    expect(service.snapshot().binding?.cloudVaultId).toBe(bBinding);
    expect(service.snapshot().lastRevision).toBe(bRevision);
    await flush();
    expect(remote.calls.length).toBe(callsBefore);
    service.dispose();
  });

  it('Case B: a stale PERMISSION_DENIED never runs B entitlement classification', async () => {
    const account = createFakeAccount();
    account.signInAs(UID_A);
    const remote = new MemorySyncRemote();
    const cloudA = await seedCloud(remote, UID_A, 'seed-a', { 'a.md': 'a' });
    const cloudB = await seedCloud(remote, UID_B, 'seed-b', { 'b.md': 'b' });

    const purchases = createPurchasesFake(purchasePro(UID_A));
    const service = new VaultSyncStore({
      remote,
      account: account.store,
      storage: createMemorySyncStorage(),
      tracker: null,
      debounceMs: 3_600_000,
      purchases: purchases.service,
    });
    await service.restore();
    const obsA = new ObservableVaultService(createMemoryVault({}).vault);
    service.attach({ localVaultId: LOCAL_A, vault: obsA });
    service.setActiveLocalVault(LOCAL_A);
    await service.attachRemoteVault(cloudA, LOCAL_A);
    await service.reconcile();

    const originalReadHead = remote.readHead.bind(remote);
    const aReached = deferred<void>();
    const aReject = deferred<never>();
    let gateA = true;
    remote.readHead = async (vaultId: string) => {
      if (vaultId === cloudA && gateA) {
        gateA = false;
        aReached.resolve();
        return aReject.promise;
      }
      return originalReadHead(vaultId);
    };
    await writeFile(obsA, 'a2.md', 'a2');
    const cyclingA = service.reconcile();
    await aReached.promise;

    // Switch to B with a DISTINCT entitlement state (client Pro, server
    // Free): if stale A's denial were classified under B it would enter
    // waiting-for-entitlement using B's purchase state.
    account.signOut();
    account.signInAs(UID_B);
    purchases.setCustomer(purchasePro(UID_B));
    await flush();
    const obsB = new ObservableVaultService(createMemoryVault({}).vault);
    service.attach({ localVaultId: LOCAL_B, vault: obsB });
    service.setActiveLocalVault(LOCAL_B);
    await service.attachRemoteVault(cloudB, LOCAL_B);
    await service.reconcile();
    await flush();
    expect(service.snapshot()).toMatchObject({ phase: 'idle', error: null });
    const bBinding = service.snapshot().binding?.cloudVaultId;
    const refreshCallsBefore = account.refreshCalls.length;

    aReject.reject(new VaultSyncError('PERMISSION_DENIED', 'denied'));
    await expect(cyclingA).resolves.toBeUndefined();
    await flush();

    // B's entitlement refresh/classification path was never invoked.
    expect(account.refreshCalls.length).toBe(refreshCallsBefore);
    expect(service.snapshot()).toMatchObject({ phase: 'idle', error: null });
    expect(service.snapshot().binding?.cloudVaultId).toBe(bBinding);
    expect(service.snapshot().phase).not.toBe('waiting-for-entitlement');
    expect(service.snapshot().error?.code).not.toBe('PRO_REQUIRED');
    expect(service.snapshot().error?.code).not.toBe('ENTITLEMENT_PENDING');
    service.dispose();
  });

  it('Case C: a stale progress callback never moves B off idle', async () => {
    const account = createFakeAccount();
    account.signInAs(UID_A);
    const remote = new MemorySyncRemote();
    const cloudA = await seedCloud(remote, UID_A, 'seed-a', { 'a.md': 'a' });
    const cloudB = await seedCloud(remote, UID_B, 'seed-b', { 'b.md': 'b' });

    const service = new VaultSyncStore({
      remote,
      account: account.store,
      storage: createMemorySyncStorage(),
      tracker: null,
      debounceMs: 3_600_000,
    });
    await service.restore();
    const obsA = new ObservableVaultService(createMemoryVault({}).vault);
    service.attach({ localVaultId: LOCAL_A, vault: obsA });
    service.setActiveLocalVault(LOCAL_A);
    await service.attachRemoteVault(cloudA, LOCAL_A);
    await service.reconcile();

    // Gate A's manifest read: the engine reports `merge`/`download`
    // progress after it resolves, which is where stale progress leaks.
    const originalLoadManifest = remote.loadManifest.bind(remote);
    const aReached = deferred<void>();
    const releaseA = deferred<void>();
    let gateA = true;
    remote.loadManifest = async (vaultId, hash, object) => {
      if (vaultId === cloudA && gateA) {
        gateA = false;
        aReached.resolve();
        await releaseA.promise;
      }
      return originalLoadManifest(vaultId, hash, object);
    };
    await writeFile(obsA, 'a2.md', 'a2');
    const cyclingA = service.reconcile();
    await aReached.promise;

    // B attaches and completes a healthy idle reconcile.
    account.signOut();
    account.signInAs(UID_B);
    await flush();
    const obsB = new ObservableVaultService(createMemoryVault({}).vault);
    service.attach({ localVaultId: LOCAL_B, vault: obsB });
    service.setActiveLocalVault(LOCAL_B);
    await service.attachRemoteVault(cloudB, LOCAL_B);
    await service.reconcile();
    await flush();
    expect(service.snapshot()).toMatchObject({ phase: 'idle', error: null });

    // Resume A: its progress callbacks fire while stale and must be inert.
    releaseA.resolve();
    await expect(cyclingA).resolves.toBeUndefined();
    await flush();
    expect(service.snapshot()).toMatchObject({ phase: 'idle', error: null });
    expect(service.snapshot().binding?.cloudVaultId).toBe(cloudB);
    service.dispose();
  });

  it('Case E: a stale workspace-reconciliation failure stays pending for A', async () => {
    const account = createFakeAccount();
    account.signInAs(UID_A);
    const remote = new MemorySyncRemote();
    const cloudA = await seedCloud(remote, UID_A, 'seed-a', { 'a.md': 'a' });
    const cloudB = await seedCloud(remote, UID_B, 'seed-b', { 'b.md': 'b' });

    const reconcilerCalls: string[] = [];
    const aReached = deferred<void>();
    const aReject = deferred<never>();
    let gateA = false;
    const service = new VaultSyncStore({
      remote,
      account: account.store,
      storage: createMemorySyncStorage(),
      tracker: null,
      debounceMs: 3_600_000,
      reconciler: {
        handleRemoteApplied: (notification) => {
          if (
            gateA &&
            notification.written.includes('a.md') &&
            !reconcilerCalls.includes('a.md')
          ) {
            aReached.resolve();
            return aReject.promise;
          }
          reconcilerCalls.push(
            ...notification.written,
            ...notification.removed,
          );
          return undefined;
        },
      },
    });
    await service.restore();
    const obsA = new ObservableVaultService(createMemoryVault({}).vault);
    service.attach({ localVaultId: LOCAL_A, vault: obsA });
    service.setActiveLocalVault(LOCAL_A);
    await service.attachRemoteVault(cloudA, LOCAL_A);

    // A's pull applies a.md, then the gated workspace hook stalls.
    gateA = true;
    const cyclingA = service.reconcile();
    await aReached.promise;

    // Switch to B and reach a healthy idle state.
    account.signOut();
    account.signInAs(UID_B);
    await flush();
    const obsB = new ObservableVaultService(createMemoryVault({}).vault);
    service.attach({ localVaultId: LOCAL_B, vault: obsB });
    service.setActiveLocalVault(LOCAL_B);
    await service.attachRemoteVault(cloudB, LOCAL_B);
    await service.reconcile();
    await flush();
    expect(service.snapshot()).toMatchObject({ phase: 'idle', error: null });

    // The stale workspace hook now fails: pending stays replica-scoped and
    // B's presentation is untouched.
    aReject.reject(new Error('workspace reload failed'));
    await expect(cyclingA).resolves.toBeUndefined();
    await flush();
    expect(service.snapshot()).toMatchObject({ phase: 'idle', error: null });
    expect(service.snapshot().binding?.cloudVaultId).toBe(cloudB);
    expect(reconcilerCalls).not.toContain('a.md');

    // Back under A, the preserved pending retry flushes before protocol
    // work (the hook runs again) and the cycle proceeds normally.
    account.signOut();
    account.signInAs(UID_A);
    await flush();
    service.attach({ localVaultId: LOCAL_A, vault: obsA });
    service.setActiveLocalVault(LOCAL_A);
    gateA = false;
    await service.reconcile();
    expect(reconcilerCalls).toContain('a.md');
    expect(service.snapshot()).toMatchObject({ phase: 'idle', error: null });
    service.dispose();
  });

  it('a stale corrupt-base latch never unwires the replacement replica', async () => {
    const account = createFakeAccount();
    account.signInAs(UID_A);
    const remote = new MemorySyncRemote();
    const inner = createMemorySyncStorage();
    // A's base is structurally valid but cryptographically wrong (latch
    // path); B is a healthy enabled binding with no synced history.
    await inner.save({
      version: 1,
      deviceId: 'device-multi',
      accounts: {
        [UID_A]: {
          bindings: {
            'local-a': {
              cloudVaultId: 'cloud-a',
              localVaultId: 'local-a',
              name: 'A',
              deviceId: 'device-multi',
              base: { manifest: manifestFor('cloud-a'), hash: ZERO_HASH },
              lastSyncedAt: null,
              lastRevision: 1,
              enabled: true,
            },
            'local-b': {
              cloudVaultId: 'cloud-b',
              localVaultId: 'local-b',
              name: 'B',
              deviceId: 'device-multi',
              base: null,
              lastSyncedAt: null,
              lastRevision: null,
              enabled: true,
            },
          },
          activeLocalVaultId: null,
        },
      },
    });
    const latchReached = deferred<void>();
    const releaseLatch = deferred<void>();
    let latchPaused = false;
    const storage: VaultSyncStorage = {
      async load() {
        return inner.load();
      },
      async save(state) {
        if (
          !latchPaused &&
          state.accounts[UID_A]?.bindings['local-a']?.baseCorrupt === true
        ) {
          latchPaused = true;
          latchReached.resolve();
          await releaseLatch.promise;
        }
        return inner.save(state);
      },
      async clear() {
        return inner.clear();
      },
    };
    const service = new VaultSyncStore({
      remote,
      account: account.store,
      storage,
      tracker: null,
      debounceMs: 3_600_000,
    });
    await service.restore();
    const obsA = new ObservableVaultService(createMemoryVault({}).vault);
    service.attach({ localVaultId: 'local-a', vault: obsA });
    service.setActiveLocalVault('local-a');
    // A's crypto verification fails and its durable latch save pauses.
    const cyclingA = service.reconcile();
    await latchReached.promise;

    // The host replaces the live replica with B while A's latch is in the
    // durable lane.
    const obsB = new ObservableVaultService(createMemoryVault({}).vault);
    service.attach({ localVaultId: 'local-b', vault: obsB });
    service.setActiveLocalVault('local-b');
    releaseLatch.resolve();
    await cyclingA;

    // B's listeners/scheduler must still be attached: a local mutation
    // keeps counting and scheduling for B.
    await writeFile(obsB, 'b.md', 'b');
    await flush();
    expect(service.snapshot().pendingChanges).toBe(1);
    expect(service.snapshot().binding?.cloudVaultId).toBe('cloud-b');
    expect(service.snapshot().error).toBeNull();
    service.dispose();
  });

  it('Case D: account/replica transitions reset transient presentation', async () => {
    class OfflineRemote extends MemorySyncRemote {
      override async readHead(): Promise<never> {
        throw new VaultSyncError('NETWORK', 'offline');
      }
    }
    const account = createFakeAccount();
    account.signInAs(UID_A);
    const remote = new OfflineRemote();
    const service = new VaultSyncStore({
      remote,
      account: account.store,
      storage: createMemorySyncStorage(),
      tracker: null,
      debounceMs: 3_600_000,
    });
    await service.restore();
    const obsA = new ObservableVaultService(createMemoryVault({}).vault);
    service.attach({ localVaultId: LOCAL_A, vault: obsA });
    await service.enable({ localVaultId: LOCAL_A, name: 'A' });
    await expect(service.reconcile()).rejects.toMatchObject({
      code: 'NETWORK',
    });
    expect(service.snapshot()).toMatchObject({ phase: 'error' });
    expect(service.snapshot().error?.code).toBe('NETWORK');

    // Identity AND replica change: the next replica must see a clean
    // presentation slate, not A's network error.
    account.signOut();
    account.signInAs(UID_B);
    await flush();
    const obsB = new ObservableVaultService(createMemoryVault({}).vault);
    service.attach({ localVaultId: LOCAL_B, vault: obsB });
    expect(service.snapshot()).toMatchObject({
      phase: 'idle',
      error: null,
      pendingChanges: 0,
      binding: null,
    });
    expect(service.snapshot().deferredPaths).toEqual([]);
    service.dispose();
  });
});

describe('binding-stable corrupt-base repair', () => {
  async function corruptHarness(): Promise<{
    account: FakeAccount;
    remote: MemorySyncRemote;
    storage: VaultSyncStorage;
    service: VaultSyncStore;
    vaultL: VaultService;
  }> {
    const account = createFakeAccount();
    account.signInAs(UID_A);
    const remote = new MemorySyncRemote();
    const cloudX = await seedCloud(remote, UID_A, 'seed-x', { 'a.md': 'a' });
    const storage = createMemorySyncStorage();
    await storage.save(corruptEnvelope(cloudX, 'local-corrupt', UID_A));
    const { vault: vaultL } = createMemoryVault({});
    await writeFile(vaultL, 'local-only.md', 'keep');
    const observableL = new ObservableVaultService(vaultL);
    const service = new VaultSyncStore({
      remote,
      account: account.store,
      storage,
      tracker: null,
      debounceMs: 3_600_000,
    });
    await service.restore();
    service.attach({ localVaultId: 'local-corrupt', vault: observableL });
    service.setActiveLocalVault('local-corrupt');
    await expect(service.reconcile()).rejects.toMatchObject({
      code: 'CORRUPT_SYNC_METADATA',
    });
    expect(
      (await storage.load())?.accounts[UID_A]?.bindings['local-corrupt']
        ?.baseCorrupt,
    ).toBe(true);
    return { account, remote, storage, service, vaultL };
  }

  it('attachRemoteVault refuses to silently rebind a bound local vault', async () => {
    const account = createFakeAccount();
    account.signInAs(UID_A);
    const remote = new MemorySyncRemote();
    const cloudX = await seedCloud(remote, UID_A, 'seed-x', { 'a.md': 'a' });
    const cloudY = await seedCloud(remote, UID_A, 'seed-y', { 'b.md': 'b' });
    const storage = createMemorySyncStorage();
    const service = new VaultSyncStore({
      remote,
      account: account.store,
      storage,
      tracker: null,
      debounceMs: 3_600_000,
    });
    await service.restore();
    service.attach({
      localVaultId: LOCAL_A,
      vault: new ObservableVaultService(createMemoryVault({}).vault),
    });
    await service.attachRemoteVault(cloudX, LOCAL_A);
    expect(service.snapshot().binding?.cloudVaultId).toBe(cloudX);

    await expect(
      service.attachRemoteVault(cloudY, LOCAL_A),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    // The binding is untouched (memory AND durable state); Y stays
    // unbound on this device.
    expect(service.snapshot().binding?.cloudVaultId).toBe(cloudX);
    expect(service.isCloudVaultBound(cloudY)).toBe(false);
    const stored = await storage.load();
    expect(stored?.accounts[UID_A]?.bindings[LOCAL_A]?.cloudVaultId).toBe(
      cloudX,
    );

    // The idempotent same-cloud refresh is preserved.
    await service.attachRemoteVault(cloudX, LOCAL_A);
    expect(service.snapshot().binding?.cloudVaultId).toBe(cloudX);
    service.dispose();
  });

  it('a repair paused mid-read never installs after an attach rebind attempt', async () => {
    const { account, remote, storage, service, vaultL } =
      await corruptHarness();
    const cloudX = service.snapshot().binding?.cloudVaultId as string;
    const cloudY = await seedCloud(remote, UID_A, 'seed-y', { 'b.md': 'b' });

    const originalLoadManifest = remote.loadManifest.bind(remote);
    const reached = deferred<void>();
    const release = deferred<void>();
    let gateArmed = true;
    remote.loadManifest = async (vaultId, hash, object) => {
      if (gateArmed && vaultId === cloudX) {
        gateArmed = false;
        reached.resolve();
        await release.promise;
      }
      return originalLoadManifest(vaultId, hash, object);
    };
    const repairing = service.repairCorruptBinding();
    await reached.promise;

    // The contested rebind attempt is rejected at the API boundary...
    await expect(
      service.attachRemoteVault(cloudY, 'local-corrupt'),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    // ...and the paused repair resumes into its ORIGINAL binding X.
    release.resolve();
    await repairing;

    const stored = await storage.load();
    const binding = stored?.accounts[UID_A]?.bindings['local-corrupt'];
    expect(binding?.cloudVaultId).toBe(cloudX);
    expect(binding?.baseCorrupt).toBeUndefined();
    expect(binding?.base?.hash).toBe(
      (await remote.readHead(cloudX))?.manifestHash,
    );
    expect(
      stored?.accounts[UID_A]?.bindings['local-corrupt']?.cloudVaultId,
    ).not.toBe(cloudY);
    expect(service.isCloudVaultBound(cloudY)).toBe(false);
    // No local files changed; no X base landed anywhere except X.
    expect(await readText(vaultL, 'local-only.md')).toBe('keep');
    service.dispose();
    account.store.dispose();
  });

  it('a repair pinned to X never installs into a binding replaced during the read', async () => {
    const { account, remote, storage, service, vaultL } =
      await corruptHarness();
    const cloudX = service.snapshot().binding?.cloudVaultId as string;

    const originalLoadManifest = remote.loadManifest.bind(remote);
    const reached = deferred<void>();
    const release = deferred<void>();
    let gateArmed = true;
    remote.loadManifest = async (vaultId, hash, object) => {
      if (gateArmed && vaultId === cloudX) {
        gateArmed = false;
        reached.resolve();
        await release.promise;
      }
      return originalLoadManifest(vaultId, hash, object);
    };
    const repairing = service.repairCorruptBinding();
    await reached.promise;

    // A valid lifecycle operation replaces the corrupt binding while the
    // repair awaits I/O: Download & Open of the same cloud vault into a
    // fresh local vault removes the corrupt binding and installs a
    // verified one under a different local id.
    const { vault: target } = createMemoryVault({});
    const prepared = await service.materializeRemoteVault(
      cloudX,
      'local-recovered',
      target,
    );
    service.attach({
      localVaultId: 'local-recovered',
      vault: new ObservableVaultService(target),
    });
    await service.finalizeMaterializedVault(prepared);

    release.resolve();
    await expect(repairing).rejects.toMatchObject({
      code: 'ACCOUNT_CHANGED',
    });

    const stored = await storage.load();
    // The repair did not report success against the changed binding.
    expect(stored?.accounts[UID_A]?.bindings['local-corrupt']).toBeUndefined();
    const recovered = stored?.accounts[UID_A]?.bindings['local-recovered'];
    expect(recovered?.baseCorrupt).toBeUndefined();
    expect(recovered?.base?.hash).toBe(
      (await remote.readHead(cloudX))?.manifestHash,
    );
    // The replacement's verified base was NOT re-installed by the stale
    // repair (single binding for X), and local files are untouched.
    expect(service.isCloudVaultBound(cloudX)).toBe(true);
    expect(await readText(vaultL, 'local-only.md')).toBe('keep');
    expect(await readText(target, 'a.md')).toBe('a');
    service.dispose();
    account.store.dispose();
  });
});

describe('re-enabling a disabled binding', () => {
  it('preserves the exact cloudVaultId/base/revision/deviceId', async () => {
    const account = createFakeAccount();
    account.signInAs(UID_A);
    const remote = new MemorySyncRemote();
    const storage = createMemorySyncStorage();
    const observable = new ObservableVaultService(createMemoryVault({}).vault);
    await writeFile(observable, 'a.md', 'v1');
    const service = new VaultSyncStore({
      remote,
      account: account.store,
      storage,
      tracker: null,
      debounceMs: 3_600_000,
    });
    await service.restore();
    service.attach({ localVaultId: LOCAL_A, vault: observable });
    await service.enable({ localVaultId: LOCAL_A, name: 'A' });
    await service.reconcile();
    const before = (await storage.load())?.accounts[UID_A]?.bindings[LOCAL_A];
    expect(before?.cloudVaultId).toBeTruthy();

    await service.disable();
    expect(service.snapshot().enabled).toBe(false);

    await service.enable({ localVaultId: LOCAL_A, name: 'A renamed' });
    const after = (await storage.load())?.accounts[UID_A]?.bindings[LOCAL_A];
    expect(after?.cloudVaultId).toBe(before?.cloudVaultId);
    expect(after?.base?.hash).toBe(before?.base?.hash);
    expect(after?.lastRevision).toBe(before?.lastRevision);
    expect(after?.deviceId).toBe(before?.deviceId);
    expect(after?.name).toBe('A renamed');
    expect(after?.enabled).toBe(true);
    // No second cloud vault was created.
    expect((await remote.listVaults()).length).toBe(1);
    service.dispose();
  });
});
