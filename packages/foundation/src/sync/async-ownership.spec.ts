/**
 * Final async-ownership regression (narrow correctness pass).
 *
 * Deterministic proof (deferred gates, captured callbacks, no sleeps for
 * ordering) that:
 *
 * ```text
 * stale disable(A) never detaches vault B listeners/watcher/telemetry
 * old watcher NETWORK/PERMISSION_DENIED after same-UID A→B never touches B
 * reconcile PERMISSION_DENIED classifier paused during same-UID A→B never
 *   publishes into B (pure classification + replica-owned publish)
 * ensureProEntitlement refresh paused → signout / account B / disable never
 *   publishes stale waiting/error state
 * ```
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
  VaultSyncError,
  type RemoteHead,
  type StoredSyncState,
  type SyncRemote,
  type VaultSyncStorage,
} from '../index.js';
import { VaultSyncStore, createMemorySyncStorage } from './service.js';
import { ObservableVaultService } from './mutations.js';

const UID = 'uid-async-owner';
const UID_B = 'uid-async-owner-b';
const LOCAL_A = 'local-async-a';
const LOCAL_B = 'local-async-b';

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

function flush(times = 20): Promise<void> {
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
  gateRefresh: null | {
    reached: ReturnType<typeof deferred<void>>;
    release: ReturnType<typeof deferred<void>>;
    armed: boolean;
  };
}

function createFakeAccount(): FakeAccount {
  let user: AccountUser | null = null;
  let entitlements: readonly string[] = [];
  const refreshCalls: string[] = [];
  const listeners = new Set<(next: AccountUser | null) => void>();
  const fake: FakeAccount = {
    store: null as unknown as AccountStore,
    signInAs: (uid) => announce({ id: uid, email: `${uid}@example.com` }),
    signOut: () => announce(null),
    setEntitlements: (next) => {
      entitlements = [...next];
    },
    refreshCalls,
    gateRefresh: null,
  };
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
      const gate = fake.gateRefresh;
      if (gate !== null && gate.armed && force) {
        gate.armed = false;
        gate.reached.resolve();
        await gate.release.promise;
      }
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
  fake.store = new AccountStore({ transport });
  return fake;
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
  calls: string[];
} {
  let current = customer;
  const calls: string[] = [];
  const listeners = new Set<(snapshot: PurchaseSnapshot) => void>();
  const snapshot = (): PurchaseSnapshot => ({
    ready: true,
    loading: false,
    customer: current,
    error: null,
  });
  const service: PurchaseService = {
    snapshot: () => {
      calls.push('snapshot');
      return snapshot();
    },
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
      throw new Error('not implemented');
    },
    async restore(): Promise<never> {
      throw new Error('not implemented');
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
    calls,
  };
}

async function writeFile(
  vault: VaultService | ObservableVaultService,
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

/** Remote wrapper that captures per-subscription watcher callbacks. */
class CapturingRemote implements SyncRemote {
  readonly heads = new Map<
    string,
    {
      onHead: (head: RemoteHead | null) => void;
      onError?: (e: unknown) => void;
    }
  >();
  watchCalls: string[] = [];
  unwatchCalls: string[] = [];
  constructor(readonly inner: MemorySyncRemote) {}
  async listVaults() {
    return this.inner.listVaults();
  }
  async readHead(vaultId: string) {
    return this.inner.readHead(vaultId);
  }
  async loadManifest(
    vaultId: string,
    hash: Parameters<SyncRemote['loadManifest']>[1],
    object: string,
  ) {
    return this.inner.loadManifest(vaultId, hash, object);
  }
  async hasBlob(vaultId: string, blob: Parameters<SyncRemote['hasBlob']>[1]) {
    return this.inner.hasBlob(vaultId, blob);
  }
  async uploadBlob(
    vaultId: string,
    blob: Parameters<SyncRemote['uploadBlob']>[1],
    bytes: Uint8Array,
  ) {
    return this.inner.uploadBlob(vaultId, blob, bytes);
  }
  async downloadBlob(
    vaultId: string,
    blob: Parameters<SyncRemote['downloadBlob']>[1],
  ) {
    return this.inner.downloadBlob(vaultId, blob);
  }
  async uploadManifest(
    vaultId: string,
    manifest: Parameters<SyncRemote['uploadManifest']>[1],
  ) {
    return this.inner.uploadManifest(vaultId, manifest);
  }
  async compareAndSwapHead(
    vaultId: string,
    expected: Parameters<SyncRemote['compareAndSwapHead']>[1],
    next: Parameters<SyncRemote['compareAndSwapHead']>[2],
  ) {
    return this.inner.compareAndSwapHead(vaultId, expected, next);
  }
  watchHead(
    vaultId: string,
    onHead: (head: RemoteHead | null) => void,
    onError?: (error: unknown) => void,
  ): () => void {
    this.watchCalls.push(`watch:${vaultId}`);
    this.heads.set(vaultId, { onHead, onError });
    const innerUnsub = this.inner.watchHead(vaultId, onHead, onError);
    return () => {
      this.unwatchCalls.push(`unwatch:${vaultId}`);
      this.heads.delete(vaultId);
      innerUnsub();
    };
  }
  forUid(): SyncRemote {
    return this;
  }
}

describe('stale disable(A) vs attach(B)', () => {
  it('old disable completion never detaches B listeners/watcher/telemetry', async () => {
    const account = createFakeAccount();
    account.signInAs(UID);
    const inner = new MemorySyncRemote();
    const remote = new CapturingRemote(inner);
    const backing = createMemorySyncStorage();
    let gateArmed = false;
    const reached = deferred<void>();
    const release = deferred<void>();
    let gatedOnce = false;
    const storage: VaultSyncStorage = {
      async load() {
        return backing.load();
      },
      async save(state: StoredSyncState) {
        if (
          !gatedOnce &&
          gateArmed &&
          state.accounts[UID]?.bindings[LOCAL_A]?.enabled === false
        ) {
          gatedOnce = true;
          reached.resolve();
          await release.promise;
        }
        return backing.save(state);
      },
      async clear() {
        return backing.clear();
      },
    };
    const service = new VaultSyncStore({
      remote,
      account: account.store,
      storage,
      tracker: null,
      debounceMs: 0,
    });
    await service.restore();
    const obsA = new ObservableVaultService(createMemoryVault({}).vault);
    const obsB = new ObservableVaultService(createMemoryVault({}).vault);
    // Two enabled bindings under the SAME UID.
    service.attach({ localVaultId: LOCAL_A, vault: obsA });
    service.setActiveLocalVault(LOCAL_A);
    await writeFile(obsA, 'a.md', 'v1');
    await service.enable({ localVaultId: LOCAL_A, name: 'A' });
    await service.reconcile();
    const cloudA = service.snapshot().binding?.cloudVaultId as string;
    service.attach({ localVaultId: LOCAL_B, vault: obsB });
    service.setActiveLocalVault(LOCAL_B);
    await writeFile(obsB, 'b.md', 'v1');
    await service.enable({ localVaultId: LOCAL_B, name: 'B' });
    await service.reconcile();
    const cloudB = service.snapshot().binding?.cloudVaultId as string;
    expect(cloudB).not.toBe(cloudA);
    // Back to A before the race.
    service.attach({ localVaultId: LOCAL_A, vault: obsA });
    service.setActiveLocalVault(LOCAL_A);
    await flush();
    expect(service.snapshot().binding?.localVaultId).toBe(LOCAL_A);

    // disable(A) pauses inside storage.save.
    gateArmed = true;
    const disabling = service.disable();
    await reached.promise;

    // Runtime switches to B while disable(A) is gated.
    service.attach({ localVaultId: LOCAL_B, vault: obsB });
    service.setActiveLocalVault(LOCAL_B);
    await flush();
    // Prove B listener installed WITHOUT touching the metadata lane
    // (disable's save still holds it): a B mutation counts synchronously.
    // No explicit reconcile here — any commit would queue behind the
    // paused disable save and deadlock the gate.
    await writeFile(obsB, 'b-prove.md', 'prove');
    expect(service.snapshot().pendingChanges).toBe(1);
    // Prove B watcher installed: a subscription exists for cloud B.
    expect(remote.heads.has(cloudB)).toBe(true);
    const watchCallsBefore = remote.watchCalls.length;
    const unwatchBefore = remote.unwatchCalls.length;
    const phaseBefore = service.snapshot().phase;
    const errorBefore = service.snapshot().error;

    // Release stale disable(A).
    release.resolve();
    await disabling;
    await flush();
    // Drain the prove mutation + any auto run queued during the gate.
    await service.reconcile();
    await flush();

    // Durable: A disabled, B still enabled.
    const stored = await backing.load();
    expect(stored?.accounts[UID]?.bindings[LOCAL_A]?.enabled).toBe(false);
    expect(stored?.accounts[UID]?.bindings[LOCAL_B]?.enabled).toBe(true);
    // Presentation: B remains attached/current.
    expect(service.snapshot().binding?.localVaultId).toBe(LOCAL_B);
    expect(service.snapshot().binding?.cloudVaultId).toBe(cloudB);
    expect(service.snapshot().enabled).toBe(true);
    // Stale completion detached nothing for B.
    expect(remote.unwatchCalls.length).toBe(unwatchBefore);
    expect(remote.watchCalls.length).toBe(watchCallsBefore);
    expect(remote.heads.has(cloudB)).toBe(true);
    expect(service.snapshot().phase).toBe(phaseBefore);
    expect(service.snapshot().error).toBe(errorBefore);

    // B mutation still increments and schedules.
    await writeFile(obsB, 'b-after.md', 'after');
    expect(service.snapshot().pendingChanges).toBe(1);
    await service.reconcile();
    expect(service.snapshot()).toMatchObject({ phase: 'idle', error: null });
    expect(service.snapshot().pendingChanges).toBe(0);

    // HEAD watcher side: advance cloud B remotely; B watcher still fires.
    const seederAccount = createFakeAccount();
    seederAccount.signInAs(UID);
    const seeder = new VaultSyncStore({
      remote: inner,
      account: seederAccount.store,
      storage: createMemorySyncStorage(),
      tracker: null,
      debounceMs: 3_600_000,
    });
    await seeder.restore();
    const { vault: seedVault } = createMemoryVault({});
    const seedObs = new ObservableVaultService(seedVault);
    seeder.attach({ localVaultId: 'seeder', vault: seedObs });
    await seeder.attachRemoteVault(cloudB, 'seeder');
    await writeFile(seedVault, 'b-remote.md', 'remote-v2');
    await seeder.reconcile();
    seeder.dispose();
    seederAccount.store.dispose();
    // The memory remote notifies B's onHead synchronously on CAS; the
    // service scheduler (debounce 0) pulls on the next microtask.
    await flush(40);
    // Manual reconcile also succeeds even if the watcher race above took
    // the explicit path; what must hold is convergence without B losing
    // its subscription.
    await service.reconcile();
    expect(service.snapshot().binding?.cloudVaultId).toBe(cloudB);
    expect(remote.heads.has(cloudB)).toBe(true);
    service.dispose();
  });
});

describe('watcher errors carry subscription ownership', () => {
  async function sameUidHarness(): Promise<{
    account: FakeAccount;
    remote: CapturingRemote;
    inner: MemorySyncRemote;
    service: VaultSyncStore;
    obsA: ObservableVaultService;
    obsB: ObservableVaultService;
    cloudA: string;
    cloudB: string;
    purchases: ReturnType<typeof createPurchasesFake>;
  }> {
    const account = createFakeAccount();
    account.signInAs(UID);
    const inner = new MemorySyncRemote();
    const remote = new CapturingRemote(inner);
    const purchases = createPurchasesFake(purchasePro(UID));
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
    const obsB = new ObservableVaultService(createMemoryVault({}).vault);
    service.attach({ localVaultId: LOCAL_A, vault: obsA });
    service.setActiveLocalVault(LOCAL_A);
    await writeFile(obsA, 'a.md', 'v1');
    await service.enable({ localVaultId: LOCAL_A, name: 'A' });
    await service.reconcile();
    const cloudA = service.snapshot().binding?.cloudVaultId as string;
    service.attach({ localVaultId: LOCAL_B, vault: obsB });
    service.setActiveLocalVault(LOCAL_B);
    await writeFile(obsB, 'b.md', 'v1');
    await service.enable({ localVaultId: LOCAL_B, name: 'B' });
    await service.reconcile();
    const cloudB = service.snapshot().binding?.cloudVaultId as string;
    // Back to A to capture A's subscription, then switch to B.
    service.attach({ localVaultId: LOCAL_A, vault: obsA });
    service.setActiveLocalVault(LOCAL_A);
    await flush();
    return {
      account,
      remote,
      inner,
      service,
      obsA,
      obsB,
      cloudA,
      cloudB,
      purchases,
    };
  }

  it('old watcher NETWORK after same-UID A→B never touches B', async () => {
    const { account, remote, service, obsB, cloudA, cloudB } =
      await sameUidHarness();
    const oldOnError = remote.heads.get(cloudA)?.onError;
    expect(oldOnError).toBeDefined();
    const refreshBefore = account.refreshCalls.length;
    // Same-UID switch A→B.
    service.attach({ localVaultId: LOCAL_B, vault: obsB });
    service.setActiveLocalVault(LOCAL_B);
    await flush();
    expect(service.snapshot().binding?.cloudVaultId).toBe(cloudB);
    expect(service.snapshot()).toMatchObject({ phase: 'idle', error: null });
    // Deliver the QUEUED old A error after the switch.
    (oldOnError as (e: unknown) => void)(
      new VaultSyncError('NETWORK', 'offline'),
    );
    await flush(30);
    expect(account.refreshCalls.length).toBe(refreshBefore);
    expect(service.snapshot()).toMatchObject({ phase: 'idle', error: null });
    expect(service.snapshot().binding?.cloudVaultId).toBe(cloudB);
    expect(service.snapshot().pendingChanges).toBe(0);
    expect(remote.heads.has(cloudB)).toBe(true);
    // B still works.
    await writeFile(obsB, 'b2.md', 'v2');
    expect(service.snapshot().pendingChanges).toBe(1);
    await service.reconcile();
    expect(service.snapshot()).toMatchObject({ phase: 'idle', error: null });
    service.dispose();
  });

  it('old watcher PERMISSION_DENIED after same-UID A→B never touches B entitlement', async () => {
    const { account, remote, service, obsB, cloudA, cloudB, purchases } =
      await sameUidHarness();
    purchases.setCustomer(purchasePro(UID));
    account.setEntitlements([]);
    const refreshBefore = account.refreshCalls.length;
    const oldOnError = remote.heads.get(cloudA)?.onError;
    expect(oldOnError).toBeDefined();
    service.attach({ localVaultId: LOCAL_B, vault: obsB });
    service.setActiveLocalVault(LOCAL_B);
    await flush();
    expect(service.snapshot()).toMatchObject({ phase: 'idle', error: null });
    (oldOnError as (e: unknown) => void)(
      new VaultSyncError('PERMISSION_DENIED', 'denied'),
    );
    await flush(30);
    // Stale watcher: no token refresh, no classification effect.
    expect(account.refreshCalls.length).toBe(refreshBefore);
    expect(service.snapshot()).toMatchObject({ phase: 'idle', error: null });
    expect(service.snapshot().error).toBeNull();
    expect(service.snapshot().binding?.cloudVaultId).toBe(cloudB);
    expect(remote.heads.has(cloudB)).toBe(true);
    service.dispose();
  });
});

describe('same-UID permission classifier race', () => {
  it('paused PERMISSION_DENIED classification never publishes into B', async () => {
    const account = createFakeAccount();
    account.signInAs(UID);
    account.setEntitlements([]);
    const purchases = createPurchasesFake(purchasePro(UID));
    // Gate the classifier's server-claim read (cached path).
    const reached = deferred<void>();
    const releaseGate = deferred<void>();
    let gateOnce = true;
    const origRefresh = account.store.refreshToken.bind(account.store);
    account.store.refreshToken = (async (force = false) => {
      if (!force && gateOnce) {
        gateOnce = false;
        reached.resolve();
        await releaseGate.promise;
      }
      return origRefresh(force);
    }) as AccountStore['refreshToken'];
    const inner = new MemorySyncRemote();
    // Deny A's HEAD read so the cycle reaches PERMISSION_DENIED.
    const denying = new (class extends MemorySyncRemote {
      override async readHead(vaultId: string) {
        if (vaultId === (this as unknown as { __cloudA?: string }).__cloudA) {
          throw new VaultSyncError('PERMISSION_DENIED', 'denied');
        }
        return super.readHead(vaultId);
      }
    })();
    void inner;
    const service = new VaultSyncStore({
      remote: denying,
      account: account.store,
      storage: createMemorySyncStorage(),
      tracker: null,
      debounceMs: 3_600_000,
      purchases: purchases.service,
    });
    await service.restore();
    const obsA = new ObservableVaultService(createMemoryVault({}).vault);
    const obsB = new ObservableVaultService(createMemoryVault({}).vault);
    // Seed cloud ids through a healthy remote first (same UID).
    const seederRemote = new MemorySyncRemote();
    const seederAccount = createFakeAccount();
    seederAccount.signInAs(UID);
    const mkSeeder = async (local: string, files: Record<string, string>) => {
      const s = new VaultSyncStore({
        remote: seederRemote,
        account: seederAccount.store,
        storage: createMemorySyncStorage(),
        tracker: null,
      });
      await s.restore();
      const { vault } = createMemoryVault({});
      const o = new ObservableVaultService(vault);
      s.attach({ localVaultId: local, vault: o });
      for (const [p, t] of Object.entries(files)) await writeFile(o, p, t);
      await s.enable({ localVaultId: local, name: local });
      await s.reconcile();
      const id = s.snapshot().binding?.cloudVaultId as string;
      s.dispose();
      return id;
    };
    const cloudASeed = await mkSeeder('seed-a', { 'a.md': 'a' });
    const cloudBSeed = await mkSeeder('seed-b', { 'b.md': 'b' });
    // Copy seeded state into the denying remote by re-seeding through it?
    // Simpler: use the seeder remote as the service remote and gate its
    // readHead for cloudA only.
    service.dispose();
    seederAccount.store.dispose();
    // Rebuild with the seeded remote and a readHead gate for A.
    const shared = seederRemote;
    const gateReadReached = deferred<void>();
    void gateReadReached;
    const service2 = new VaultSyncStore({
      remote: shared,
      account: account.store,
      storage: createMemorySyncStorage(),
      tracker: null,
      debounceMs: 3_600_000,
      purchases: purchases.service,
    });
    await service2.restore();
    service2.attach({ localVaultId: LOCAL_A, vault: obsA });
    service2.setActiveLocalVault(LOCAL_A);
    await service2.attachRemoteVault(cloudASeed, LOCAL_A);
    await service2.reconcile();
    // Make the NEXT reconcile for A deny at readHead, then pause the
    // classifier's cached claim read.
    const origRead = shared.readHead.bind(shared);
    let denyOnce = true;
    shared.readHead = async (vaultId: string) => {
      if (vaultId === cloudASeed && denyOnce) {
        denyOnce = false;
        throw new VaultSyncError('PERMISSION_DENIED', 'denied');
      }
      return origRead(vaultId);
    };
    // Reset the classifier gate for this denial.
    gateOnce = true;
    await writeFile(obsA, 'a2.md', 'a2');
    const cycling = service2.reconcile();
    await reached.promise;
    // Same-UID switch to B while A's classifier is paused.
    service2.attach({ localVaultId: LOCAL_B, vault: obsB });
    service2.setActiveLocalVault(LOCAL_B);
    await service2.attachRemoteVault(cloudBSeed, LOCAL_B);
    await service2.reconcile();
    await flush();
    expect(service2.snapshot().binding?.cloudVaultId).toBe(cloudBSeed);
    expect(service2.snapshot()).toMatchObject({ phase: 'idle', error: null });
    const phaseBefore = service2.snapshot().phase;
    // Release A's classifier: server Free, client Pro → would be
    // ENTITLEMENT_PENDING if published. Must be discarded.
    releaseGate.resolve();
    await cycling;
    await flush(30);
    expect(service2.snapshot().binding?.cloudVaultId).toBe(cloudBSeed);
    expect(service2.snapshot().phase).toBe(phaseBefore);
    expect(service2.snapshot().error).toBeNull();
    expect(service2.snapshot().phase).not.toBe('waiting-for-entitlement');
    service2.dispose();
  });
});

describe('ensureProEntitlement stale refresh races', () => {
  async function entitledHarness(): Promise<{
    account: FakeAccount;
    service: VaultSyncStore;
    purchases: ReturnType<typeof createPurchasesFake>;
  }> {
    const account = createFakeAccount();
    account.signInAs(UID);
    account.setEntitlements([]);
    const purchases = createPurchasesFake(purchasePro(UID));
    const { vault } = createMemoryVault({});
    const service = new VaultSyncStore({
      remote: new MemorySyncRemote(),
      account: account.store,
      storage: createMemorySyncStorage(),
      purchases: purchases.service,
      entitlement: {
        maxAttempts: 3,
        baseDelayMs: 1,
        sleep: () => Promise.resolve(),
      },
    });
    await account.store.restore();
    await service.restore();
    service.attach({
      localVaultId: LOCAL_A,
      vault: new ObservableVaultService(vault),
    });
    await service.enable({ localVaultId: LOCAL_A, name: 'A' });
    return { account, service, purchases };
  }

  it('refresh pending → signout rejects without publishing stale state', async () => {
    const { account, service } = await entitledHarness();
    const reached = deferred<void>();
    const releaseGate = deferred<void>();
    account.gateRefresh = { reached, release: releaseGate, armed: true };
    const pending = service.ensureProEntitlement();
    await reached.promise;
    account.signOut();
    releaseGate.resolve();
    await expect(pending).rejects.toMatchObject({
      code: 'NOT_AUTHENTICATED',
    });
    await flush();
    expect(service.snapshot().error).toBeNull();
    expect(service.snapshot().phase).toBe('idle');
    service.dispose();
  });

  it('refresh pending → account B never mutates B presentation', async () => {
    const { account, service } = await entitledHarness();
    const reached = deferred<void>();
    const releaseGate = deferred<void>();
    account.gateRefresh = { reached, release: releaseGate, armed: true };
    const pending = service.ensureProEntitlement();
    await reached.promise;
    account.signInAs(UID_B);
    await flush();
    releaseGate.resolve();
    await expect(pending).rejects.toMatchObject({
      code: 'NOT_AUTHENTICATED',
    });
    await flush();
    // B starts clean: no waiting/error leaked from A.
    expect(service.snapshot().error).toBeNull();
    expect(service.snapshot().phase).toBe('idle');
    service.dispose();
  });

  it('refresh pending → disable keeps Off with no stale publish', async () => {
    const { account, service } = await entitledHarness();
    expect(service.snapshot().enabled).toBe(true);
    const reached = deferred<void>();
    const releaseGate = deferred<void>();
    account.gateRefresh = { reached, release: releaseGate, armed: true };
    const pending = service.ensureProEntitlement();
    await reached.promise;
    await service.disable();
    expect(service.snapshot().enabled).toBe(false);
    releaseGate.resolve();
    await expect(pending).rejects.toMatchObject({
      code: 'NOT_AUTHENTICATED',
    });
    await flush();
    expect(service.snapshot().enabled).toBe(false);
    expect(service.snapshot().error).toBeNull();
    expect(service.snapshot().phase).toBe('idle');
    service.dispose();
  });
});

describe('failed disable restores automatic sync (disable lifecycle)', () => {
  it('failed persistence keeps enabled and rewires listeners/watcher/scheduler', async () => {
    const account = createFakeAccount();
    account.signInAs(UID);
    const inner = new MemorySyncRemote();
    const remote = new CapturingRemote(inner);
    const backing = createMemorySyncStorage();
    const failure = new Error('disable persist boom');
    let failNextDisable = true;
    const storage: VaultSyncStorage = {
      async load() {
        return backing.load();
      },
      async save(state: StoredSyncState) {
        if (
          failNextDisable &&
          state.accounts[UID]?.bindings[LOCAL_A]?.enabled === false
        ) {
          failNextDisable = false;
          throw failure;
        }
        return backing.save(state);
      },
      async clear() {
        return backing.clear();
      },
    };
    const service = new VaultSyncStore({
      remote,
      account: account.store,
      storage,
      tracker: null,
      debounceMs: 0,
    });
    await service.restore();
    const obsA = new ObservableVaultService(createMemoryVault({}).vault);
    service.attach({ localVaultId: LOCAL_A, vault: obsA });
    service.setActiveLocalVault(LOCAL_A);
    await writeFile(obsA, 'a.md', 'v1');
    await service.enable({ localVaultId: LOCAL_A, name: 'A' });
    await service.reconcile();
    await flush();
    // Drain any follow-up run so the baseline below is stable.
    await service.reconcile();
    await flush();
    const cloudA = service.snapshot().binding?.cloudVaultId as string;
    expect(service.snapshot().enabled).toBe(true);
    expect(service.snapshot().binding?.localVaultId).toBe(LOCAL_A);
    expect(remote.heads.has(cloudA)).toBe(true);

    // The next disable persistence fails.
    await expect(service.disable()).rejects.toBe(failure);
    await flush();
    // Durable and in-memory binding correctly remain enabled.
    expect(service.snapshot().enabled).toBe(true);
    expect(service.snapshot().binding?.localVaultId).toBe(LOCAL_A);
    const stored = await backing.load();
    expect(stored?.accounts[UID]?.bindings[LOCAL_A]?.enabled).toBe(true);
    // Lifecycle was restored: watcher subscription exists again.
    expect(remote.heads.has(cloudA)).toBe(true);

    // Behavior proof: a new local write increments telemetry and converges
    // automatically (no manual reopen/re-enable required).
    await writeFile(obsA, 'a2.md', 'v2');
    expect(service.snapshot().pendingChanges).toBe(1);
    await flush(40);
    // Automatic scheduler run converges (debounce 0); drain any
    // watcher-triggered follow-up so the snapshot below is stable.
    await service.reconcile();
    await flush(40);
    await service.reconcile();
    await flush(40);
    expect(service.snapshot().pendingChanges).toBe(0);
    expect(service.snapshot()).toMatchObject({ phase: 'idle', error: null });

    // Watcher remains capable: advance cloud A from another replica and
    // converge through the same session path.
    const seederAccount = createFakeAccount();
    seederAccount.signInAs(UID);
    const seeder = new VaultSyncStore({
      remote: inner,
      account: seederAccount.store,
      storage: createMemorySyncStorage(),
      tracker: null,
      debounceMs: 3_600_000,
    });
    await seeder.restore();
    const { vault: seedVault } = createMemoryVault({});
    const seedObs = new ObservableVaultService(seedVault);
    seeder.attach({ localVaultId: 'seeder', vault: seedObs });
    await seeder.attachRemoteVault(cloudA, 'seeder');
    await writeFile(seedVault, 'a-remote.md', 'remote-v2');
    await seeder.reconcile();
    seeder.dispose();
    seederAccount.store.dispose();
    await flush(40);
    await service.reconcile();
    await flush();
    expect(service.snapshot().binding?.cloudVaultId).toBe(cloudA);
    expect(remote.heads.has(cloudA)).toBe(true);
    service.dispose();
  });
});

describe('disable in progress is fully parked (disable lifecycle)', () => {
  it('blocked save parks mutation/watcher/queued-scheduler work; local writes stay usable', async () => {
    const account = createFakeAccount();
    account.signInAs(UID);
    const inner = new MemorySyncRemote();
    const remote = new CapturingRemote(inner);
    const backing = createMemorySyncStorage();
    const reached = deferred<void>();
    const release = deferred<void>();
    let gatedOnce = false;
    let gateArmed = false;
    const storage: VaultSyncStorage = {
      async load() {
        return backing.load();
      },
      async save(state: StoredSyncState) {
        if (
          !gatedOnce &&
          gateArmed &&
          state.accounts[UID]?.bindings[LOCAL_A]?.enabled === false
        ) {
          gatedOnce = true;
          reached.resolve();
          await release.promise;
        }
        return backing.save(state);
      },
      async clear() {
        return backing.clear();
      },
    };
    const service = new VaultSyncStore({
      remote,
      account: account.store,
      storage,
      tracker: null,
      debounceMs: 0,
    });
    await service.restore();
    const obsA = new ObservableVaultService(createMemoryVault({}).vault);
    service.attach({ localVaultId: LOCAL_A, vault: obsA });
    service.setActiveLocalVault(LOCAL_A);
    await writeFile(obsA, 'a.md', 'v1');
    await service.enable({ localVaultId: LOCAL_A, name: 'A' });
    await service.reconcile();
    await flush();
    await service.reconcile();
    await flush();
    const cloudA = service.snapshot().binding?.cloudVaultId as string;
    expect(remote.heads.has(cloudA)).toBe(true);
    const baseline = inner.calls.length;
    const oldOnHead = remote.heads.get(cloudA)?.onHead;
    expect(oldOnHead).toBeDefined();

    // Queue one scheduler run that must not survive the disable bump.
    // Both calls are synchronous with no await between them: the watcher
    // callback queues the scheduler microtask (debounce 0 defers past the
    // burst), then disable bumps + parks before that microtask runs. The
    // old scheduler must be disposed so the queued run never starts a
    // fresh reconcile for the still-enabled binding.
    gateArmed = true;
    oldOnHead?.(null);
    const disabling = service.disable();
    await reached.promise;
    // Parked immediately: the watcher is already removed before the durable
    // save resolves (old code left it wired until after the commit).
    expect(remote.heads.has(cloudA)).toBe(false);
    // While the durable enabled/disabled state is undecided the replica is
    // parked: local writes stay usable, cloud work must not start.
    await writeFile(obsA, 'during.md', 'during');
    // Local vault fully usable: bytes landed despite parked sync.
    const duringBytes = await obsA.read(workspacePath('during.md'));
    expect(new TextDecoder().decode(duringBytes)).toBe('during');
    // Stale HEAD callback (retained from before disable) must not schedule.
    oldOnHead?.(null);
    await flush(40);
    const blockedCalls = inner.calls.slice(baseline);
    const protocol = blockedCalls.filter((call) =>
      [
        'readHead',
        'loadManifest',
        'hasBlob',
        'uploadBlob',
        'downloadBlob',
        'uploadManifest',
        'compareAndSwapHead',
      ].some((prefix) => call.startsWith(prefix)),
    );
    expect(protocol).toEqual([]);
    expect(inner.calls.length).toBe(baseline);
    // Parked mutation did not increment telemetry (listener removed, not
    // merely stale).
    expect(service.snapshot().pendingChanges).toBe(0);

    release.resolve();
    await disabling;
    await flush();
    expect(service.snapshot().enabled).toBe(false);
    // Remains unwired: watcher removed, scheduler disposed.
    expect(remote.heads.has(cloudA)).toBe(false);
    expect(service.snapshot().pendingChanges).toBe(0);

    // Later local mutations never trigger cloud work while disabled.
    const afterDisable = inner.calls.length;
    await writeFile(obsA, 'after.md', 'after');
    await flush(20);
    expect(service.snapshot().pendingChanges).toBe(0);
    expect(inner.calls.length).toBe(afterDisable);
    service.dispose();
  });
});

describe('failed stale disable must not repair B (disable lifecycle)', () => {
  it('disable(A) failure during B attachment leaves B fully wired', async () => {
    const account = createFakeAccount();
    account.signInAs(UID);
    const inner = new MemorySyncRemote();
    const remote = new CapturingRemote(inner);
    const backing = createMemorySyncStorage();
    const reached = deferred<void>();
    const release = deferred<void>();
    const failure = new Error('stale disable persist boom');
    let gatedOnce = false;
    let gateArmed = false;
    let shouldFail = false;
    const storage: VaultSyncStorage = {
      async load() {
        return backing.load();
      },
      async save(state: StoredSyncState) {
        if (
          !gatedOnce &&
          gateArmed &&
          state.accounts[UID]?.bindings[LOCAL_A]?.enabled === false
        ) {
          gatedOnce = true;
          reached.resolve();
          await release.promise;
          if (shouldFail) throw failure;
        }
        return backing.save(state);
      },
      async clear() {
        return backing.clear();
      },
    };
    // Large debounce: B proving writes stay pending without background
    // churn, so phase/error/pending comparisons stay deterministic.
    const service = new VaultSyncStore({
      remote,
      account: account.store,
      storage,
      tracker: null,
      debounceMs: 3_600_000,
    });
    await service.restore();
    const obsA = new ObservableVaultService(createMemoryVault({}).vault);
    const obsB = new ObservableVaultService(createMemoryVault({}).vault);
    service.attach({ localVaultId: LOCAL_A, vault: obsA });
    service.setActiveLocalVault(LOCAL_A);
    await writeFile(obsA, 'a.md', 'v1');
    await service.enable({ localVaultId: LOCAL_A, name: 'A' });
    await service.reconcile();
    const cloudA = service.snapshot().binding?.cloudVaultId as string;
    service.attach({ localVaultId: LOCAL_B, vault: obsB });
    service.setActiveLocalVault(LOCAL_B);
    await writeFile(obsB, 'b.md', 'v1');
    await service.enable({ localVaultId: LOCAL_B, name: 'B' });
    await service.reconcile();
    const cloudB = service.snapshot().binding?.cloudVaultId as string;
    expect(cloudB).not.toBe(cloudA);
    service.attach({ localVaultId: LOCAL_A, vault: obsA });
    service.setActiveLocalVault(LOCAL_A);
    await flush();
    expect(service.snapshot().binding?.localVaultId).toBe(LOCAL_A);

    gateArmed = true;
    const disabling = service.disable();
    await reached.promise;

    // Runtime switches A -> B while disable(A) save is paused. B wires
    // normally through the synchronous attach path (its selection persist
    // queues behind the lane without blocking wiring).
    service.attach({ localVaultId: LOCAL_B, vault: obsB });
    service.setActiveLocalVault(LOCAL_B);
    await flush();
    await writeFile(obsB, 'b-prove.md', 'prove');
    expect(service.snapshot().pendingChanges).toBe(1);
    expect(remote.heads.has(cloudB)).toBe(true);
    const phaseBefore = service.snapshot().phase;
    const errorBefore = service.snapshot().error;
    const pendingBefore = service.snapshot().pendingChanges;
    const watchCallsBefore = remote.watchCalls.length;
    const unwatchBefore = remote.unwatchCalls.length;

    // Fail the stale save; the failure must propagate without touching B.
    shouldFail = true;
    release.resolve();
    await expect(disabling).rejects.toBe(failure);
    await flush();

    expect(service.snapshot().binding?.localVaultId).toBe(LOCAL_B);
    expect(service.snapshot().binding?.cloudVaultId).toBe(cloudB);
    expect(service.snapshot().enabled).toBe(true);
    // B stays fully wired: listener, watcher, telemetry untouched.
    expect(remote.heads.has(cloudB)).toBe(true);
    expect(remote.unwatchCalls.length).toBe(unwatchBefore);
    expect(remote.watchCalls.length).toBe(watchCallsBefore);
    expect(service.snapshot().phase).toBe(phaseBefore);
    expect(service.snapshot().error).toBe(errorBefore);
    expect(service.snapshot().pendingChanges).toBe(pendingBefore);
    await writeFile(obsB, 'b-after.md', 'after');
    expect(service.snapshot().pendingChanges).toBe(pendingBefore + 1);
    expect(remote.heads.has(cloudB)).toBe(true);
    await service.reconcile();
    expect(service.snapshot()).toMatchObject({ phase: 'idle', error: null });
    // A is still durably enabled (save failed) but was never rewired over B.
    const stored = await backing.load();
    expect(stored?.accounts[UID]?.bindings[LOCAL_A]?.enabled).toBe(true);
    expect(stored?.accounts[UID]?.bindings[LOCAL_B]?.enabled).toBe(true);
    // Reopening A later wires it normally from its still-enabled binding.
    service.attach({ localVaultId: LOCAL_A, vault: obsA });
    service.setActiveLocalVault(LOCAL_A);
    await flush();
    expect(service.snapshot().binding?.localVaultId).toBe(LOCAL_A);
    expect(service.snapshot().enabled).toBe(true);
    expect(remote.heads.has(cloudA)).toBe(true);
    service.dispose();
  });
});
