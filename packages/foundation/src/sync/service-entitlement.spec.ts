/**
 * Vault sync Pro authorization.
 *
 * Backend authorization is trusted server state only: client
 * `PurchaseService` state gates UI, Firebase Security Rules gate the
 * cloud. A Rules denial (`PERMISSION_DENIED`) while the client reports
 * Pro but the server claim is still missing enters the explicit
 * `waiting-for-entitlement` phase (never a purchase error);
 * `ensureProEntitlement()` force-refreshes with bounded backoff until
 * the claim propagates. Never bypasses Rules: every test remote still
 * denies without the server claim.
 */

import { describe, expect, it, vi } from 'vitest';
import { AccountStore } from '../account/index.js';
import type { AccountTransport, AccountUser } from '../account/contract.js';
import type {
  PurchaseCustomerState,
  PurchaseService,
  PurchaseSnapshot,
} from '../purchases/contract.js';
import { createMemoryVault } from '../vault/memory.js';
import { workspacePath } from '../paths.js';
import { MemorySyncRemote, VaultSyncError, type SyncRemote } from '../index.js';
import {
  ManualDirtyTracker,
  VaultSyncStore,
  createMemorySyncStorage,
} from './service.js';
import { ObservableVaultService } from './mutations.js';

const UID_A = 'uid-alice-123';
const LOCAL_A = 'local-vault-a';

function proCustomer(uid: string): PurchaseCustomerState {
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

function freeCustomer(uid: string): PurchaseCustomerState {
  return {
    appUserId: uid,
    activeEntitlementIds: [],
    entitlements: {},
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
  const emit = (): void => {
    const next = snapshot();
    for (const listener of [...listeners]) listener(next);
  };
  const service: PurchaseService = {
    snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async refresh(): Promise<void> {
      // Re-emit the current fake state so refresh observers converge.
      emit();
    },
    async offerings(): Promise<never[]> {
      return [];
    },
    async purchase(): Promise<never> {
      throw new Error('not implemented in entitlement tests');
    },
    async restore(): Promise<never> {
      throw new Error('not implemented in entitlement tests');
    },
    handleNativeEvent(): void {
      // Entitlement tests drive customer state directly via setCustomer.
      return undefined;
    },
  };
  return {
    service,
    setCustomer: (next) => {
      current = next;
      emit();
    },
  };
}

interface FakeAccount {
  store: AccountStore;
  signInAs: (uid: string) => void;
  signOut: () => void;
  setEntitlements: (entitlements: readonly string[]) => void;
  refreshCalls: string[];
}

/** Account store with scriptable server entitlements (no network). */
function createFakeAccountWithEntitlements(
  initialEntitlements: readonly string[] = [],
): FakeAccount {
  let user: AccountUser | null = { id: UID_A, email: `${UID_A}@example.com` };
  let entitlements: readonly string[] = [...initialEntitlements];
  const listeners = new Set<(next: AccountUser | null) => void>();
  const refreshCalls: string[] = [];
  const transport: AccountTransport = {
    async currentUser() {
      return user === null ? null : { ...user };
    },
    async createAccount(email: string) {
      const created: AccountUser = { id: UID_A, email };
      user = created;
      for (const listener of [...listeners]) listener({ ...created });
      return { ...created };
    },
    async signIn(email: string) {
      const signedIn: AccountUser = { id: UID_A, email };
      user = signedIn;
      for (const listener of [...listeners]) listener({ ...signedIn });
      return { ...signedIn };
    },
    async signOut() {
      user = null;
      for (const listener of [...listeners]) listener(null);
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
      // Seed the initial session like provider persistence recovery:
      // the store constructor subscribes, then the test restores.
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const store = new AccountStore({ transport });
  return {
    store,
    signInAs: (uid) => {
      user = { id: uid, email: `${uid}@example.com` };
      for (const listener of [...listeners])
        listener(user === null ? null : { ...user });
    },
    signOut: () => {
      user = null;
      for (const listener of [...listeners]) listener(null);
    },
    setEntitlements: (next) => {
      entitlements = [...next];
    },
    refreshCalls,
  };
}

/** Remote that denies every write like Security Rules without the claim. */
class DenyingRemote extends MemorySyncRemote {
  override async compareAndSwapHead(): Promise<never> {
    throw new VaultSyncError(
      'PERMISSION_DENIED',
      'Firebase Security Rules denied the sync request',
    );
  }

  override async uploadBlob(): Promise<never> {
    throw new VaultSyncError(
      'PERMISSION_DENIED',
      'Firebase Security Rules denied the sync request',
    );
  }

  override async uploadManifest(): Promise<never> {
    throw new VaultSyncError(
      'PERMISSION_DENIED',
      'Firebase Security Rules denied the sync request',
    );
  }
}

async function writeFile(
  vault: ObservableVaultService,
  path: string,
  text: string,
): Promise<void> {
  await vault.write(workspacePath(path), new TextEncoder().encode(text));
}

describe('entitlement mapping', () => {
  it('client Pro alone cannot write: denial stays activating, never success', async () => {
    const account = createFakeAccountWithEntitlements([]);
    const purchases = createPurchasesFake(proCustomer(UID_A));
    const { vault } = createMemoryVault({});
    const observable = new ObservableVaultService(vault);
    const remote = new DenyingRemote();
    const service = new VaultSyncStore({
      remote,
      account: account.store,
      storage: createMemorySyncStorage(),
      tracker: new ManualDirtyTracker(),
      purchases: purchases.service,
      entitlement: {
        maxAttempts: 2,
        baseDelayMs: 1,
        sleep: () => Promise.resolve(),
      },
    });
    await account.store.restore();
    await service.restore();
    service.attach({ localVaultId: LOCAL_A, vault: observable });
    await writeFile(observable, 'a.md', 'v1');
    await service.enable({ localVaultId: LOCAL_A, name: 'A' });
    await expect(service.reconcile()).rejects.toMatchObject({
      code: 'ENTITLEMENT_PENDING',
    });
    // Explicit activating state — never a purchase error, never success.
    expect(service.snapshot()).toMatchObject({
      phase: 'waiting-for-entitlement',
    });
    expect(service.snapshot().error?.code).toBe('ENTITLEMENT_PENDING');
    // Local vault stays fully usable throughout.
    expect(
      new TextDecoder().decode(await vault.read(workspacePath('a.md'))),
    ).toBe('v1');
    service.dispose();
    account.store.dispose();
  });

  it('server Pro authorizes: no waiting state', async () => {
    const account = createFakeAccountWithEntitlements(['pro']);
    const purchases = createPurchasesFake(proCustomer(UID_A));
    const { vault } = createMemoryVault({});
    const observable = new ObservableVaultService(vault);
    const service = new VaultSyncStore({
      remote: new MemorySyncRemote(),
      account: account.store,
      storage: createMemorySyncStorage(),
      tracker: new ManualDirtyTracker(),
      purchases: purchases.service,
    });
    await account.store.restore();
    await service.restore();
    service.attach({ localVaultId: LOCAL_A, vault: observable });
    await writeFile(observable, 'a.md', 'v1');
    await service.enable({ localVaultId: LOCAL_A, name: 'A' });
    await service.reconcile();
    expect(service.snapshot()).toMatchObject({ phase: 'idle', error: null });
    expect(service.snapshot().lastRevision).toBe(1);
    service.dispose();
    account.store.dispose();
  });

  it('Free client maps denial to PRO_REQUIRED (needs paywall, not waiting)', async () => {
    const account = createFakeAccountWithEntitlements([]);
    const purchases = createPurchasesFake(freeCustomer(UID_A));
    const { vault } = createMemoryVault({});
    const observable = new ObservableVaultService(vault);
    const service = new VaultSyncStore({
      remote: new DenyingRemote() as unknown as SyncRemote,
      account: account.store,
      storage: createMemorySyncStorage(),
      tracker: new ManualDirtyTracker(),
      purchases: purchases.service,
    });
    await account.store.restore();
    await service.restore();
    service.attach({ localVaultId: LOCAL_A, vault: observable });
    await writeFile(observable, 'a.md', 'v1');
    await service.enable({ localVaultId: LOCAL_A, name: 'A' });
    await expect(service.reconcile()).rejects.toMatchObject({
      code: 'PRO_REQUIRED',
    });
    expect(service.snapshot().error?.code).toBe('PRO_REQUIRED');
    // Non-Pro denial is a terminal error state, not the activating phase.
    expect(service.snapshot().phase).toBe('error');
    service.dispose();
    account.store.dispose();
  });

  it('watcher denial maps to the same states without throwing', async () => {
    const account = createFakeAccountWithEntitlements([]);
    const purchases = createPurchasesFake(proCustomer(UID_A));
    const { vault } = createMemoryVault({});
    const observable = new ObservableVaultService(vault);
    const remote = new DenyingRemote();
    const service = new VaultSyncStore({
      // Denying remote keeps the enable-time background reconcile from
      // succeeding afterwards and resetting the activating state to idle.
      remote,
      account: account.store,
      storage: createMemorySyncStorage(),
      tracker: new ManualDirtyTracker(),
      purchases: purchases.service,
      entitlement: {
        maxAttempts: 2,
        baseDelayMs: 1,
        sleep: () => Promise.resolve(),
      },
    });
    await account.store.restore();
    await service.restore();
    service.attach({ localVaultId: LOCAL_A, vault: observable });
    await writeFile(observable, 'a.md', 'v1');
    await service.enable({ localVaultId: LOCAL_A, name: 'A' });
    remote.failWatch(
      service.snapshot().binding!.cloudVaultId,
      new VaultSyncError('PERMISSION_DENIED', 'denied'),
    );
    // Watcher errors map asynchronously after the refresh round-trip.
    await vi.waitFor(() => {
      expect(service.snapshot().phase).toBe('waiting-for-entitlement');
    });
    expect(service.snapshot().error?.code).toBe('ENTITLEMENT_PENDING');
    service.dispose();
    account.store.dispose();
  });
});

describe('ensureProEntitlement claim propagation', () => {
  it('returns immediately when the cached claim already has pro', async () => {
    const account = createFakeAccountWithEntitlements(['pro']);
    const purchases = createPurchasesFake(proCustomer(UID_A));
    const { vault } = createMemoryVault({});
    const service = new VaultSyncStore({
      remote: new MemorySyncRemote(),
      account: account.store,
      storage: createMemorySyncStorage(),
      purchases: purchases.service,
    });
    await account.store.restore();
    await service.restore();
    service.attach({
      localVaultId: LOCAL_A,
      vault: new ObservableVaultService(vault),
    });
    await expect(service.ensureProEntitlement()).resolves.toBe(true);
    expect(account.refreshCalls).toEqual(['refreshToken:cached']);
    expect(service.snapshot()).toMatchObject({ phase: 'idle', error: null });
    service.dispose();
    account.store.dispose();
  });

  it('retries with force-refresh until the claim appears, then sync begins', async () => {
    const account = createFakeAccountWithEntitlements([]);
    const purchases = createPurchasesFake(proCustomer(UID_A));
    const delays: number[] = [];
    const { vault } = createMemoryVault({});
    const observable = new ObservableVaultService(vault);
    const remote = new MemorySyncRemote();
    // Flip the server claim after two force-refreshes (propagation delay).
    let forces = 0;
    const originalRefresh = account.store.refreshToken.bind(account.store);
    account.store.refreshToken = (async (force = false) => {
      const state = await originalRefresh(force);
      if (force) {
        forces += 1;
        if (forces >= 2) return { ...state, entitlements: ['pro'] };
      }
      return state;
    }) as AccountStore['refreshToken'];
    const service = new VaultSyncStore({
      remote,
      account: account.store,
      storage: createMemorySyncStorage(),
      tracker: new ManualDirtyTracker(),
      purchases: purchases.service,
      entitlement: {
        maxAttempts: 5,
        baseDelayMs: 10,
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    });
    await account.store.restore();
    await service.restore();
    service.attach({ localVaultId: LOCAL_A, vault: observable });
    await service.enable({ localVaultId: LOCAL_A, name: 'A' });
    await expect(service.ensureProEntitlement()).resolves.toBe(true);
    expect(service.snapshot()).toMatchObject({ phase: 'idle', error: null });
    // Exponential backoff between attempts (one sleep before success).
    expect(delays).toEqual([10]);
    // And the cloud write now succeeds through the same service.
    await writeFile(observable, 'a.md', 'v1');
    await service.reconcile();
    expect(service.snapshot().lastRevision).toBe(1);
    service.dispose();
    account.store.dispose();
  });

  it('exhausts the bound as ENTITLEMENT_PENDING, never a purchase error', async () => {
    const account = createFakeAccountWithEntitlements([]);
    const purchases = createPurchasesFake(proCustomer(UID_A));
    const delays: number[] = [];
    const { vault } = createMemoryVault({});
    const service = new VaultSyncStore({
      remote: new MemorySyncRemote(),
      account: account.store,
      storage: createMemorySyncStorage(),
      purchases: purchases.service,
      entitlement: {
        maxAttempts: 3,
        baseDelayMs: 5,
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    });
    await account.store.restore();
    await service.restore();
    service.attach({
      localVaultId: LOCAL_A,
      vault: new ObservableVaultService(vault),
    });
    await expect(service.ensureProEntitlement()).rejects.toMatchObject({
      code: 'ENTITLEMENT_PENDING',
    });
    expect(service.snapshot()).toMatchObject({
      phase: 'waiting-for-entitlement',
      error: expect.objectContaining({ code: 'ENTITLEMENT_PENDING' }),
    });
    expect(delays).toEqual([5, 10]);
    service.dispose();
    account.store.dispose();
  });

  it('Free client fails fast with PRO_REQUIRED (no pointless refresh loop)', async () => {
    const account = createFakeAccountWithEntitlements([]);
    const purchases = createPurchasesFake(freeCustomer(UID_A));
    const { vault } = createMemoryVault({});
    const service = new VaultSyncStore({
      remote: new MemorySyncRemote(),
      account: account.store,
      storage: createMemorySyncStorage(),
      purchases: purchases.service,
      entitlement: {
        maxAttempts: 5,
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
    const before = account.refreshCalls.length;
    await expect(service.ensureProEntitlement()).rejects.toMatchObject({
      code: 'PRO_REQUIRED',
    });
    // One cached check + one force attempt, then fast failure.
    expect(account.refreshCalls.length).toBeLessThanOrEqual(before + 2);
    expect(service.snapshot().error?.code).toBe('PRO_REQUIRED');
    service.dispose();
    account.store.dispose();
  });

  it('sign-out during the wait aborts with NOT_AUTHENTICATED', async () => {
    const account = createFakeAccountWithEntitlements([]);
    const purchases = createPurchasesFake(proCustomer(UID_A));
    const { vault } = createMemoryVault({});
    const service = new VaultSyncStore({
      remote: new MemorySyncRemote(),
      account: account.store,
      storage: createMemorySyncStorage(),
      purchases: purchases.service,
      entitlement: {
        maxAttempts: 5,
        baseDelayMs: 50,
        sleep: async () => {
          account.signOut();
        },
      },
    });
    await account.store.restore();
    await service.restore();
    service.attach({
      localVaultId: LOCAL_A,
      vault: new ObservableVaultService(vault),
    });
    await expect(service.ensureProEntitlement()).rejects.toMatchObject({
      code: 'NOT_AUTHENTICATED',
    });
    service.dispose();
    account.store.dispose();
  });
});

describe('active-vault parking and suspend', () => {
  const LOCAL_B = 'local-vault-b';

  async function parkedHarness(): Promise<{
    account: FakeAccount;
    service: VaultSyncStore;
    observable: ObservableVaultService;
    remote: MemorySyncRemote;
  }> {
    const account = createFakeAccountWithEntitlements(['pro']);
    const purchases = createPurchasesFake(proCustomer(UID_A));
    const { vault } = createMemoryVault({});
    const observable = new ObservableVaultService(vault);
    const remote = new MemorySyncRemote();
    const service = new VaultSyncStore({
      remote,
      account: account.store,
      storage: createMemorySyncStorage(),
      tracker: new ManualDirtyTracker(),
      purchases: purchases.service,
    });
    await account.store.restore();
    await service.restore();
    service.attach({ localVaultId: LOCAL_A, vault: observable });
    await writeFile(observable, 'a.md', 'v1');
    await service.enable({ localVaultId: LOCAL_A, name: 'A' });
    await service.reconcile();
    expect(service.snapshot().lastRevision).toBe(1);
    return { account, service, observable, remote };
  }

  it('parks on a mismatched selection report and on detach, resumes when consistent', async () => {
    const { account, service, observable, remote } = await parkedHarness();
    const cloudId = service.snapshot().binding?.cloudVaultId as string;
    // Drain any queued background run from enable so the parked-write
    // baseline below cannot race legitimately started work.
    await service.reconcile();

    // A reported selection that disagrees with the attached replica parks
    // future work (fail-closed composition) WITHOUT switching replicas.
    service.setActiveLocalVault(LOCAL_B);
    expect(service.snapshot().activeLocalVaultId).toBe(LOCAL_B);
    await expect(service.reconcile()).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });
    service.setActiveLocalVault(LOCAL_A);
    await service.reconcile();

    // Detaching the physical replica parks all cloud work.
    service.detach();
    await writeFile(observable, 'b.md', 'parked-work');
    await new Promise((resolve) => setTimeout(resolve, 25));
    const head = await remote.readHead(cloudId);
    expect(head?.revision).toBe(1);
    await expect(service.reconcile()).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });

    // Re-attaching the bound replica resumes incrementally.
    service.attach({ localVaultId: LOCAL_A, vault: observable });
    await service.reconcile();
    expect(service.snapshot().lastRevision).toBe(2);
    expect(service.snapshot()).toMatchObject({ phase: 'idle', error: null });
    service.dispose();
    account.store.dispose();
  });

  it('enable never overwrites the host-reported selection', async () => {
    const { account, service } = await parkedHarness();
    const { vault } = createMemoryVault({});
    const observableB = new ObservableVaultService(vault);
    service.attach({ localVaultId: LOCAL_B, vault: observableB });
    service.setActiveLocalVault(LOCAL_B);
    await service.enable({ localVaultId: LOCAL_B, name: 'B' });
    // Presentation state is host-owned: enabling a
    // binding never retroactively rewrites the selection.
    expect(service.snapshot().activeLocalVaultId).toBe(LOCAL_B);
    expect(service.snapshot().binding?.localVaultId).toBe(LOCAL_B);
    service.dispose();
    account.store.dispose();
  });

  it('suspend stops scheduling; sign-in re-wires without losing the binding', async () => {
    const { account, service, observable, remote } = await parkedHarness();
    const cloudId = service.snapshot().binding?.cloudVaultId as string;
    const bindingBefore = service.snapshot().binding;

    service.suspend();
    await writeFile(observable, 'b.md', 'while-suspended');
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect((await remote.readHead(cloudId))?.revision).toBe(1);

    // Sign-out/in cycle (ordered teardown ran suspend first): the binding
    // survives and cloud work resumes for the same vault.
    account.signOut();
    account.signInAs(UID_A);
    service.setActiveLocalVault(LOCAL_A);
    await service.reconcile();
    expect(service.snapshot().binding).toEqual(bindingBefore);
    expect(service.snapshot().lastRevision).toBe(2);
    service.dispose();
    account.store.dispose();
  });

  it('suspend cancels an in-flight entitlement wait', async () => {
    const account = createFakeAccountWithEntitlements([]);
    const purchases = createPurchasesFake(proCustomer(UID_A));
    const { vault } = createMemoryVault({});
    const service = new VaultSyncStore({
      remote: new MemorySyncRemote(),
      account: account.store,
      storage: createMemorySyncStorage(),
      purchases: purchases.service,
      entitlement: {
        maxAttempts: 5,
        baseDelayMs: 50,
        sleep: async () => {
          service.suspend();
        },
      },
    });
    await account.store.restore();
    await service.restore();
    service.attach({
      localVaultId: LOCAL_A,
      vault: new ObservableVaultService(vault),
    });
    await expect(service.ensureProEntitlement()).rejects.toMatchObject({
      code: 'NOT_AUTHENTICATED',
    });
    service.dispose();
    account.store.dispose();
  });
});
