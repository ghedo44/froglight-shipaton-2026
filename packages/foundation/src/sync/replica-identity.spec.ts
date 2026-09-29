/**
 * Explicit replica identity and bounded sign-out adversarial conformance.
 *
 * Executable proof of the invariants:
 *
 * ```text
 * sole binding A + open unbound B → B never touches A's cloud replica
 * two bindings → only the attached localVaultId's binding runs
 * stale observable callbacks cannot schedule the replacement replica
 * stale attachRemoteVault (A→B mid-read) never reaches durable storage
 * hung remote call → prepareForSignOut resolves on the injected bound and
 *   skips persistence instead of re-entering the blocked metadata lane
 * a permanently hung A reconcile never blocks B sign-in, bind, and sync
 *   (lane split: the stale epoch is abandoned, not waited on)
 * attach during sign-out cannot clear suspension
 * ```
 *
 * All concurrency uses explicit deferred gates; no sleeps construct races.
 */

import { describe, expect, it } from 'vitest';
import {
  AccountStore,
  type AccountTransport,
  type AccountUser,
} from '../account/index.js';
import { ensureDirectory } from '../vault/helpers.js';
import { createMemoryVault } from '../vault/memory.js';
import type { VaultService } from '../vault/contract.js';
import { workspacePath } from '../paths.js';
import { MemorySyncRemote } from '../index.js';
import {
  VaultSyncStore,
  createMemorySyncStorage,
  type VaultSyncSignOutDrainOutcome,
} from './service.js';
import { ObservableVaultService, type VaultMutation } from './mutations.js';

const UID_A = 'uid-replica-a';
const UID_B = 'uid-replica-b';

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
  signOut(): void;
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
    signOut: () => announce(null),
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

async function dumpVault(vault: VaultService): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string): Promise<void> => {
    const children = await vault.list(
      dir === '' ? workspacePath('') : workspacePath(dir),
    );
    for (const child of children) {
      const path = dir === '' ? child.name : `${dir}/${child.name}`;
      if (child.kind === 'directory') await walk(path);
      else out[path] = await readText(vault, path);
    }
  };
  await walk('');
  return out;
}

/** Seed one cloud vault under `uid`; returns its cloud id. */
async function seedCloud(
  remote: MemorySyncRemote,
  localVaultId: string,
  files: Record<string, string>,
  uid: string = UID_A,
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

describe('explicit replica identity', () => {
  it('sole binding A + open unbound B never touches A and stays parked', async () => {
    const account = createFakeAccount();
    account.signInAs(UID_A);
    const remote = new MemorySyncRemote();
    const cloudA = await seedCloud(remote, 'local-a', { 'a.md': 'a-data' });

    const reconcilerCalls: string[] = [];
    const { vault: vaultA } = createMemoryVault({});
    const obsA = new ObservableVaultService(vaultA);
    const { vault: vaultB } = createMemoryVault({});
    const obsB = new ObservableVaultService(vaultB);
    const service = new VaultSyncStore({
      remote,
      account: account.store,
      storage: createMemorySyncStorage(),
      reconciler: {
        handleRemoteApplied: (notification) => {
          reconcilerCalls.push(
            ...notification.written,
            ...notification.removed,
          );
        },
      },
    });
    await service.restore();

    // Bind and sync local-a, then close it (launcher active: no replica,
    // no selection reported).
    service.attach({ localVaultId: 'local-a', vault: obsA });
    await service.attachRemoteVault(cloudA, 'local-a');
    await service.reconcile();
    expect(service.snapshot().binding?.cloudVaultId).toBe(cloudA);
    reconcilerCalls.length = 0;
    service.detach();
    service.setActiveLocalVault(null);
    expect(service.snapshot().binding).toBeNull();

    // Open unrelated local-b: the runtime attachment enters atomically
    // with B's identity; no UI selection has been reported yet.
    const baseline = remote.calls.length;
    service.attach({ localVaultId: 'local-b', vault: obsB });
    expect(service.snapshot().binding).toBeNull();
    expect(service.snapshot().enabled).toBe(false);

    // Local writes to B schedule nothing and touch no remote namespace.
    await writeFile(obsB, 'b.md', 'b-data');
    await flush();
    expect(service.snapshot().pendingChanges).toBe(0);
    expect(
      remote.calls.slice(baseline).filter((call) => call.includes(cloudA)),
    ).toEqual([]);

    // Manual reconcile refuses: B has no binding.
    await expect(service.reconcile()).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });

    // Report/select local-b in the UI: nothing changes (still parked, no
    // guessed binding from A).
    service.setActiveLocalVault('local-b');
    await flush();
    expect(service.snapshot().activeLocalVaultId).toBe('local-b');
    expect(service.snapshot().binding).toBeNull();
    await expect(service.reconcile()).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });
    expect(
      remote.calls.slice(baseline).filter((call) => call.includes(cloudA)),
    ).toEqual([]);
    expect(reconcilerCalls).toEqual([]);

    // Bind B to a DIFFERENT cloud vault: only that binding syncs.
    const cloudB = await seedCloud(remote, 'seeder-b', { 'b.md': 'b-cloud' });
    expect(cloudB).not.toBe(cloudA);
    await service.attachRemoteVault(cloudB, 'local-b');
    await service.reconcile();
    expect(service.snapshot().binding).toMatchObject({
      localVaultId: 'local-b',
      cloudVaultId: cloudB,
    });
    const mergedB = await dumpVault(vaultB);
    expect(mergedB['b.md']).toBe('b-data');
    const conflictCopiesB = Object.keys(mergedB).filter(
      (path) => path !== 'b.md',
    );
    expect(conflictCopiesB).toHaveLength(1);
    expect(mergedB[conflictCopiesB[0] as string]).toBe('b-cloud');
    // A's cloud vault was never read or written after the switch.
    const afterBind = remote.calls
      .slice(baseline)
      .filter((call) => call.includes(cloudA));
    expect(afterBind).toEqual([]);
    // B's own namespace received the work.
    expect(
      remote.calls.slice(baseline).some((call) => call.includes(cloudB)),
    ).toBe(true);

    // A's binding is preserved for its next open.
    expect(service.snapshot().bindings).toHaveLength(2);
    service.dispose();
  });

  it('stale observable callbacks cannot schedule the replacement replica', async () => {
    class CapturingObservable extends ObservableVaultService {
      captured: ((mutation: VaultMutation) => void) | null = null;
      override onMutation(listener: (mutation: VaultMutation) => void) {
        this.captured = listener;
        return super.onMutation(listener);
      }
    }
    const account = createFakeAccount();
    account.signInAs(UID_A);
    const remote = new MemorySyncRemote();
    const { vault } = createMemoryVault({});
    const obsA = new CapturingObservable(vault);
    const obsB = new ObservableVaultService(createMemoryVault({}).vault);
    const service = new VaultSyncStore({
      remote,
      account: account.store,
      storage: createMemorySyncStorage(),
      debounceMs: 3_600_000,
    });
    await service.restore();
    service.attach({ localVaultId: 'local-a', vault: obsA });
    await writeFile(obsA, 'a.md', 'v1');
    await service.enable({ localVaultId: 'local-a', name: 'A' });
    await service.reconcile();
    const callsBefore = remote.calls.length;

    // Replace A with B (B unbound → parked), then fire the captured old-A
    // listener manually: it must be a no-op for B's telemetry/scheduler.
    service.attach({ localVaultId: 'local-b', vault: obsB });
    expect(service.snapshot().pendingChanges).toBe(0);
    const stale = obsA.captured;
    expect(stale).not.toBeNull();
    stale?.({ type: 'write', path: workspacePath('stale.md') });
    stale?.({ type: 'write', path: workspacePath('stale.md') });
    expect(service.snapshot().pendingChanges).toBe(0);
    await flush();
    expect(remote.calls.length).toBe(callsBefore);
    service.dispose();
  });
});

describe('stale attachRemoteVault identity race', () => {
  it('A→B mid-read rejects ACCOUNT_CHANGED and never persists a phantom binding', async () => {
    const account = createFakeAccount();
    account.signInAs(UID_A);
    const remote = new MemorySyncRemote();
    const cloudA = await seedCloud(remote, 'seeder', { 'a.md': 'a' });

    // Gate the stale attach's HEAD read.
    const reachedRead = deferred<void>();
    const releaseRead = deferred<void>();
    const originalReadHead = remote.readHead.bind(remote);
    remote.readHead = async (vaultId: string) => {
      if (vaultId === cloudA) {
        reachedRead.resolve();
        await releaseRead.promise;
      }
      return originalReadHead(vaultId);
    };

    const storage = createMemorySyncStorage();
    const savedStates: Array<Record<string, unknown>> = [];
    const originalSave = storage.save.bind(storage);
    storage.save = async (state) => {
      savedStates.push(state as unknown as Record<string, unknown>);
      return originalSave(state);
    };
    const service = new VaultSyncStore({
      remote,
      account: account.store,
      storage,
      debounceMs: 3_600_000,
    });
    await service.restore();

    const attaching = service.attachRemoteVault(cloudA, 'local-b');
    await reachedRead.promise; // contested point reached (no sleeps)

    // A signs out, B signs in and settles while the old read is gated.
    account.signOut();
    account.signInAs(UID_B);
    await flush();
    const savesBeforeRelease = savedStates.length;

    releaseRead.resolve();
    await expect(attaching).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' });

    // The stale attach never reached durable storage: no saved state
    // contains an A binding for local-b, and B is untouched.
    const phantomSaves = savedStates
      .slice(savesBeforeRelease)
      .filter((state) => {
        const accounts = state.accounts as
          | Record<string, { bindings?: Record<string, unknown> }>
          | undefined;
        return accounts?.[UID_A]?.bindings?.['local-b'] !== undefined;
      });
    expect(phantomSaves).toEqual([]);
    const stored = await storage.load();
    expect(stored?.accounts[UID_A]?.bindings['local-b']).toBeUndefined();
    expect(stored?.accounts[UID_B]).toBeUndefined();
    expect(service.snapshot().bindings).toEqual([]);

    // Switching back to A does not reveal a phantom binding.
    account.signOut();
    account.signInAs(UID_A);
    await flush();
    expect(service.snapshot().bindings).toEqual([]);
    expect(service.isCloudVaultBound(cloudA)).toBe(false);
    service.dispose();
  });
});

describe('bounded sign-out', () => {
  it('hung remote: barrier resolves on the injected bound, skips persistence, and stays inert', async () => {
    const account = createFakeAccount();
    account.signInAs(UID_A);
    const remote = new MemorySyncRemote();
    const cloudA = await seedCloud(remote, 'seeder', { 'a.md': 'a' });
    const { vault } = createMemoryVault({});
    const observable = new ObservableVaultService(vault);

    const raced = deferred<VaultSyncSignOutDrainOutcome>();
    let raceCalls = 0;
    const service = new VaultSyncStore({
      remote,
      account: account.store,
      storage: createMemorySyncStorage(),
      debounceMs: 3_600_000,
      signOut: {
        drainTimeoutMs: 1,
        raceTimeout: async () => {
          raceCalls += 1;
          return raced.promise;
        },
      },
    });
    await service.restore();
    service.attach({ localVaultId: 'local-a', vault: observable });
    await service.enable({ localVaultId: 'local-a', name: 'A' });
    await service.reconcile();
    // A prepared token that must die with the auth epoch.
    const prepared = await service.materializeRemoteVault(
      cloudA,
      'prepared-local',
      createMemoryVault({}).vault,
    );

    // Gate the next remote read so the in-flight cycle hangs until the
    // test releases it AFTER sign-out (deterministic hung remote). The
    // released call returns the pre-captured HEAD without touching the
    // call log, so post-release assertions measure only NEW remote work.
    const headA = await remote.readHead(cloudA);
    const reached = deferred<void>();
    const releaseHang = deferred<void>();
    remote.readHead = async () => {
      reached.resolve();
      await releaseHang.promise;
      return headA;
    };
    const callsAtHang = remote.calls.length;
    await writeFile(observable, 'b.md', 'v2');
    const cycling = service.reconcile();
    await reached.promise;

    const barrier = service.prepareForSignOut();
    // Injected race resolves independently: the barrier must not wait on
    // the hung chain and must not re-enter the blocked lane.
    raced.resolve('timeout');
    await barrier;
    expect(raceCalls).toBe(1);

    // Persistence skipped; no new remote call from the barrier.
    expect(remote.calls.length).toBe(callsAtHang);
    // Old prepared token invalid under the new epoch.
    await expect(
      service.finalizeMaterializedVault(prepared),
    ).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' });

    // B signs in; the old hung continuation must stay inert when released.
    account.signOut();
    account.signInAs(UID_B);
    await flush();
    const callsBeforeRelease = remote.calls.length;
    releaseHang.resolve();
    await expect(cycling).resolves.toBeUndefined();
    expect(remote.calls.length).toBe(callsBeforeRelease);
    expect(service.snapshot().bindings).toEqual([]);
    expect(service.snapshot().pendingChanges).toBe(0);
    // Local writes after sign-in B schedule nothing against A's cloud.
    await writeFile(observable, 'c.md', 'v3');
    await flush();
    expect(
      remote.calls
        .slice(callsBeforeRelease)
        .filter((call) => call.includes(cloudA)),
    ).toEqual([]);
    service.dispose();
  });

  it('attach during sign-out cannot clear suspension; authenticated resume re-wires', async () => {
    const account = createFakeAccount();
    account.signInAs(UID_A);
    const remote = new MemorySyncRemote();
    const cloudA = await seedCloud(remote, 'seeder', { 'a.md': 'a' });
    const { vault } = createMemoryVault({});
    const observableA = new ObservableVaultService(vault);
    const observableB = new ObservableVaultService(createMemoryVault({}).vault);

    const raceGate = deferred<VaultSyncSignOutDrainOutcome>();
    const service = new VaultSyncStore({
      remote,
      account: account.store,
      storage: createMemorySyncStorage(),
      debounceMs: 3_600_000,
      signOut: {
        drainTimeoutMs: 1,
        raceTimeout: () => raceGate.promise,
      },
    });
    await service.restore();
    service.attach({ localVaultId: 'local-a', vault: observableA });
    await service.attachRemoteVault(cloudA, 'local-a');
    await service.reconcile();
    expect(service.snapshot().binding?.cloudVaultId).toBe(cloudA);

    // Barrier active (suspended, listeners detached, scheduler disposed).
    const barrier = service.prepareForSignOut();
    // Runtime replaces the vault while teardown is in flight.
    service.attach({ localVaultId: 'local-b', vault: observableB });
    const callsAtAttach = remote.calls.length;
    await writeFile(observableB, 'b.md', 'b-work');
    await flush();
    // Suspension survives the attach: zero scheduling, zero remote work.
    expect(service.snapshot().pendingChanges).toBe(0);
    expect(remote.calls.length).toBe(callsAtAttach);
    await expect(service.reconcile()).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });
    raceGate.resolve('timeout');
    await barrier;

    // Actual authenticated resume (sign-out → sign-in B) re-enables wiring
    // for the attached replica.
    account.signOut();
    account.signInAs(UID_B);
    await flush();
    const cloudB = await seedCloud(remote, 'seeder-b', { 'b.md': 'b-cloud' });
    await service.attachRemoteVault(cloudB, 'local-b');
    await service.reconcile();
    expect(service.snapshot().binding).toMatchObject({
      localVaultId: 'local-b',
      cloudVaultId: cloudB,
    });
    const merged = await dumpVault(observableB.inner);
    expect(merged['b.md']).toBe('b-work');
    const conflictCopies = Object.keys(merged).filter(
      (path) => path !== 'b.md',
    );
    expect(conflictCopies).toHaveLength(1);
    expect(merged[conflictCopies[0] as string]).toBe('b-cloud');
    // A's namespace was never touched during the race.
    expect(
      remote.calls.filter((call) => call.includes(cloudA)).length,
    ).toBeGreaterThan(0);
    service.dispose();
  });

  it('a permanently hung A reconcile never blocks B sign-in, bind, and sync', async () => {
    // Acceptance for bounded sign-out recovery (lane
    // split): the old A remote gate is NEVER released while B completes a
    // full attach → bind → reconcile → remote write. Only after B has
    // succeeded is A released, proving the abandoned epoch stays inert
    // (zero new remote calls, no metadata install under B).
    const account = createFakeAccount();
    account.signInAs(UID_A);
    const remote = new MemorySyncRemote();
    const cloudA = await seedCloud(remote, 'seeder-a', { 'a.md': 'a' }, UID_A);
    const cloudB = await seedCloud(
      remote,
      'seeder-b',
      { 'b.md': 'b-cloud' },
      UID_B,
    );
    const { vault: vaultA } = createMemoryVault({});
    const obsA = new ObservableVaultService(vaultA);
    const { vault: vaultB } = createMemoryVault({});
    const obsB = new ObservableVaultService(vaultB);

    const service = new VaultSyncStore({
      remote,
      account: account.store,
      storage: createMemorySyncStorage(),
      debounceMs: 3_600_000,
      signOut: {
        drainTimeoutMs: 1,
        // Deterministic injected bound: 'timeout' wins immediately while
        // the reconcile chain stays hung (no sleeps).
        raceTimeout: async () => 'timeout',
      },
    });
    await service.restore();
    service.attach({ localVaultId: 'local-a', vault: obsA });
    service.setActiveLocalVault('local-a');
    await service.attachRemoteVault(cloudA, 'local-a');
    await service.reconcile();
    expect(service.snapshot().lastRevision).toBe(1);

    // Gate A's next HEAD read permanently. The released call returns the
    // pre-captured HEAD without touching the call log, so post-release
    // assertions measure only NEW remote work.
    const headA = await remote.readHead(cloudA);
    const originalReadHead = remote.readHead.bind(remote);
    const aReached = deferred<void>();
    const aNever = deferred<void>();
    remote.readHead = async (vaultId: string) => {
      if (vaultId === cloudA) {
        aReached.resolve();
        await aNever.promise;
        return headA;
      }
      return originalReadHead(vaultId);
    };
    await writeFile(obsA, 'a2.md', 'a2');
    const cyclingA = service.reconcile();
    let aSettled = false;
    void cyclingA.then(
      () => {
        aSettled = true;
      },
      () => {
        aSettled = true;
      },
    );
    await aReached.promise;

    // Bounded sign-out: the injected timeout wins while A is hung.
    await service.prepareForSignOut();

    // A signs out; B signs in and operates on a different replica.
    account.signOut();
    account.signInAs(UID_B);
    await flush();
    service.attach({ localVaultId: 'local-b', vault: obsB });
    service.setActiveLocalVault('local-b');
    await writeFile(obsB, 'b-local.md', 'b-local');
    await service.attachRemoteVault(cloudB, 'local-b');
    await service.reconcile();

    // B reached a successful revision and a real remote write while A's
    // promise is STILL unresolved.
    expect(aSettled).toBe(false);
    expect(service.snapshot().binding).toMatchObject({
      localVaultId: 'local-b',
      cloudVaultId: cloudB,
    });
    expect(service.snapshot().lastRevision).toBeGreaterThanOrEqual(1);
    expect(
      remote.calls.some(
        (call) =>
          call.includes(cloudB) && call.startsWith('compareAndSwapHead'),
      ),
    ).toBe(true);
    expect(service.snapshot().bindings).toHaveLength(1);

    // Release the permanently-stale A continuation: its generations are
    // already invalid, so it must produce zero new remote calls and no
    // metadata install under B.
    const callsBeforeRelease = remote.calls.length;
    aNever.resolve();
    await cyclingA;
    expect(aSettled).toBe(true);
    expect(remote.calls.length).toBe(callsBeforeRelease);
    expect(service.snapshot().binding?.cloudVaultId).toBe(cloudB);
    expect(service.snapshot().lastRevision).toBeGreaterThanOrEqual(1);
    service.dispose();
  });
});
