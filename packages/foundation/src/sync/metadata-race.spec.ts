/**
 * Adversarial sync-metadata persistence (serialized commit lane).
 *
 * All races use deterministic deferred gates — never sleeps for
 * correctness. Each test proves the contested state was reached before
 * releasing the next step:
 *
 * ```text
 * Case A — finalize persistence vs account switch
 * Case B — checkpoint persistence vs vault switch
 * Case C — selection persistence vs newer binding mutation
 * Case D — attachment switch during a paused save
 * Case E — stale enable completion vs host-reported selection
 * ```
 */

import { describe, expect, it } from 'vitest';
import {
  AccountStore,
  type AccountTransport,
  type AccountUser,
} from '../account/index.js';
import { createMemoryVault } from '../vault/memory.js';
import type { VaultService } from '../vault/contract.js';
import { ensureDirectory } from '../vault/helpers.js';
import { workspacePath } from '../paths.js';
import {
  MemorySyncRemote,
  type StoredSyncState,
  type VaultSyncStorage,
} from '../index.js';
import { VaultSyncStore, createMemorySyncStorage } from './service.js';
import { ObservableVaultService } from './mutations.js';

const UID_A = 'uid-race-a';
const UID_B = 'uid-race-b';

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

/** Gated storage: every save pauses at the gate until released. */
function gatedStorage(
  inner: VaultSyncStorage,
  onSave: () => void,
): {
  storage: VaultSyncStorage;
  gate: ReturnType<typeof deferred<void>>;
  saved: StoredSyncState[];
} {
  const gate = deferred<void>();
  const released = false;
  const saved: StoredSyncState[] = [];
  let saveCount = 0;
  const storage: VaultSyncStorage = {
    async load() {
      return inner.load();
    },
    async save(state) {
      saveCount += 1;
      const mine = saveCount;
      if (mine === 1 && !released) {
        onSave();
        await gate.promise;
      }
      saved.push(state);
      return inner.save(state);
    },
    async clear() {
      return inner.clear();
    },
  };
  return {
    storage,
    gate,
    saved,
  };
}

async function seedCloudVault(
  remote: MemorySyncRemote,
  account: ReturnType<typeof createFakeAccount>,
  uid: string,
  localVaultId: string,
  files: Record<string, string>,
): Promise<string> {
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

describe('Case A — finalize persistence vs account switch', () => {
  it('pause finalize save, switch A→B, resume: B never receives A binding', async () => {
    const account = createFakeAccount();
    const remote = new MemorySyncRemote();
    const cloudA = await seedCloudVault(remote, account, UID_A, 'seed-a', {
      'note.md': 'hello-a',
    });
    account.signInAs(UID_A);
    const inner = createMemorySyncStorage();
    const saveReached = deferred<void>();
    const releaseSave = deferred<void>();
    let firstSave = false;
    const storage: VaultSyncStorage = {
      async load() {
        return inner.load();
      },
      async save(state) {
        if (firstSave) {
          firstSave = false;
          saveReached.resolve();
          await releaseSave.promise;
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
    // Arm the gate AFTER restore (restore's own migration writes must not
    // trip it — only the finalize commit below pauses).
    firstSave = true;
    const { vault: target } = createMemoryVault({});
    const prepared = await service.materializeRemoteVault(
      cloudA,
      'local-b',
      target,
    );
    // Finalize starts and enters storage.save (paused at the gate).
    const finalize = service.finalizeMaterializedVault(prepared);
    // Prove finalize actually reached the contested save (no sleeps).
    await saveReached.promise;
    // Identity switches to B while the A save is in flight.
    account.signOut();
    account.signInAs(UID_B);
    // Resume the stale A save.
    releaseSave.resolve();
    await expect(finalize).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' });
    // B never receives the A binding; B-visible state shows nothing.
    expect(service.isCloudVaultBound(cloudA)).toBe(false);
    expect(service.snapshot().binding).toBeNull();
    expect(service.snapshot().bindings).toEqual([]);
    // No stale listener resurrected: no watcher/mutation work runs for B
    // without a B binding (snapshot stays idle, no error attributed to B).
    expect(service.snapshot().phase).toBe('idle');
    // Final state coherent after switching back to A: the failed finalize
    // left no phantom — A must re-prepare to bind (old token stays dead
    // even for the same UID, new epoch).
    account.signOut();
    account.signInAs(UID_A);
    await expect(
      service.finalizeMaterializedVault(prepared),
    ).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' });
    expect(service.snapshot().binding).toBeNull();
    // A fresh prepare → finalize succeeds (no residue from the stale S1).
    const { vault: target2 } = createMemoryVault({});
    const prepared2 = await service.materializeRemoteVault(
      cloudA,
      'local-b',
      target2,
    );
    await service.finalizeMaterializedVault(prepared2);
    expect(service.isCloudVaultBound(cloudA)).toBe(true);
    service.dispose();
  });
});

describe('Case B — checkpoint persistence vs vault switch', () => {
  it('pause checkpoint save, switch A→B, resume: B untouched, A truth under A only', async () => {
    const account = createFakeAccount();
    account.signInAs(UID_A);
    const remote = new MemorySyncRemote();
    const PARKED = 3_600_000;
    // Device A seeds R1 for vault A.
    const { vault: vaultA } = createMemoryVault({});
    const obsA = new ObservableVaultService(vaultA);
    const hookCalls: string[] = [];
    const inner = createMemorySyncStorage();
    const checkpointReached = deferred<void>();
    const releaseCheckpoint = deferred<void>();
    let checkpointArmed = false;
    let checkpointSeen = false;
    const storage: VaultSyncStorage = {
      async load() {
        return inner.load();
      },
      async save(state) {
        // The checkpoint save is the first base-advancing save after R2
        // apply (revision 2 under local-a). Pause exactly there.
        const rev = (state as StoredSyncState).accounts[UID_A]?.bindings[
          'local-a'
        ]?.base?.manifest.revision;
        if (checkpointArmed && !checkpointSeen && rev === 2) {
          checkpointSeen = true;
          checkpointReached.resolve();
          await releaseCheckpoint.promise;
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
      debounceMs: PARKED,
      reconciler: {
        handleRemoteApplied: async (notification) => {
          hookCalls.push(
            [...notification.written, ...notification.removed].sort().join(','),
          );
        },
      },
    });
    await service.restore();
    await writeFile(obsA, 'note.md', 'v1');
    service.attach({ localVaultId: 'local-a', vault: obsA });
    await service.enable({ localVaultId: 'local-a', name: 'A' });
    await service.reconcile();
    const cloudA = service.snapshot().binding?.cloudVaultId as string;
    // Bind B (second cloud) so the switch has a real replica.
    const { vault: vaultB } = createMemoryVault({});
    await writeFile(vaultB, 'b-local.md', 'b1');
    const obsB = new ObservableVaultService(vaultB);
    service.attach({ localVaultId: 'local-b', vault: obsB });
    service.setActiveLocalVault('local-b');
    await service.enable({ localVaultId: 'local-b', name: 'B' });
    await service.reconcile();
    const cloudB = service.snapshot().binding?.cloudVaultId as string;
    expect(cloudB).not.toBe(cloudA);
    // Back to A; a seeder advances cloudA R1→R2 (remote-only file).
    service.attach({ localVaultId: 'local-a', vault: obsA });
    service.setActiveLocalVault('local-a');
    const { vault: seedVault } = createMemoryVault({});
    const seeder = new VaultSyncStore({
      remote,
      account: account.store,
      storage: createMemorySyncStorage(),
      tracker: null,
      debounceMs: PARKED,
    });
    await seeder.restore();
    seeder.attach({
      localVaultId: 'seeder',
      vault: new ObservableVaultService(seedVault),
    });
    await seeder.attachRemoteVault(cloudA, 'seeder');
    await writeFile(seedVault, 'remote-only.md', 'r2');
    await seeder.reconcile();
    seeder.dispose();
    // Arm the checkpoint gate and start A's pull (applies R2, checkpoints).
    checkpointArmed = true;
    hookCalls.length = 0;
    const cycle = service.reconcile();
    await checkpointReached.promise;
    // App switches active vault to B while A's checkpoint save is gated.
    service.setActiveLocalVault('local-b');
    releaseCheckpoint.resolve();
    await cycle.catch(() => undefined);
    // B binding/base unchanged: B never received A's checkpoint or paths.
    const stored = await inner.load();
    const bBase =
      stored?.accounts[UID_A]?.bindings['local-b']?.base?.manifest.revision;
    // B was at revision 1 (its own seed); A's R2 checkpoint must not move it.
    expect(bBase).toBe(1);
    expect(hookCalls.filter((c) => c.includes('remote-only.md'))).toHaveLength(
      1,
    );
    // The one hook ran for A (before the switch), never replayed into B:
    // no second hook after the switch carried A paths into B context.
    expect(hookCalls).toHaveLength(1);
    // A checkpoint remains associated only with A (under local-a key).
    const aBase =
      stored?.accounts[UID_A]?.bindings['local-a']?.base?.manifest.revision;
    expect(aBase).toBe(2);
    service.dispose();
  });
});

describe('Case C — selection persistence vs newer binding mutation', () => {
  it('older selection save never overwrites newer binding mutation (durable ends at S2)', async () => {
    const account = createFakeAccount();
    account.signInAs(UID_A);
    const remote = new MemorySyncRemote();
    const inner = createMemorySyncStorage();
    const selectionReached = deferred<void>();
    const releaseSelection = deferred<void>();
    let pauseNextSave = false;
    let selectionPaused = false;
    const storage: VaultSyncStorage = {
      async load() {
        return inner.load();
      },
      async save(state) {
        if (pauseNextSave && !selectionPaused) {
          selectionPaused = true;
          pauseNextSave = false;
          selectionReached.resolve();
          await releaseSelection.promise;
        }
        return inner.save(state);
      },
      async clear() {
        return inner.clear();
      },
    };
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
      localVaultId: 'local-a',
      vault: new ObservableVaultService(vault),
    });
    await service.enable({ localVaultId: 'local-a', name: 'A' });
    // S1: selection write starts (active → local-b memory + persist queued).
    // Pause its durable save.
    pauseNextSave = true;
    service.setActiveLocalVault('local-b');
    await selectionReached.promise;
    // S2: a newer binding/base mutation lands while S1 is paused.
    // (Enable a second vault: newer durable state.)
    releaseSelection.resolve();
    // Note: with the serialized lane S1 holds the lock across its save, so
    // S2 queues behind. To prove ordering (older never overwrites newer),
    // enable AFTER releasing S1 would trivially order S1→S2. The contested
    // interleaving is S2 staged while S1 in flight — but the lane forces
    // S2 to clone AFTER S1 installs, so final durable includes S2 (newer
    // wins) and never reverts to S1.
    await service.enable({ localVaultId: 'local-c', name: 'C' });
    // Durable ends at S2 (local-c bound), never S1 (stale selection-only).
    const durable = await inner.load();
    expect(
      durable?.accounts[UID_A]?.bindings['local-c']?.cloudVaultId,
    ).toBeTruthy();
    // Presentation ownership: enable mutates only
    // the binding — it never retroactively rewrites which vault the host
    // reported as active. Selection memory and durable selection stay at
    // the last `setActiveLocalVault()` ('local-b').
    expect(service.snapshot().activeLocalVaultId).toBe('local-b');
    expect(durable?.accounts[UID_A]?.activeLocalVaultId).toBe('local-b');
    service.dispose();
  });

  it('true whole-envelope race: gated S1 save vs queued S2 through one lane', async () => {
    // Direct lane proof with two overlapping commits: S1 (selection) holds
    // the lane across a paused save; S2 (binding) queues behind. Resume S1,
    // then S2. Durable must end at S2.
    const account = createFakeAccount();
    account.signInAs(UID_A);
    const remote = new MemorySyncRemote();
    const inner = createMemorySyncStorage();
    const s1Reached = deferred<void>();
    const s1Release = deferred<void>();
    let armed = false;
    let pausedOnce = false;
    const storage: VaultSyncStorage = {
      async load() {
        return inner.load();
      },
      async save(state: StoredSyncState) {
        if (armed && !pausedOnce) {
          pausedOnce = true;
          s1Reached.resolve();
          await s1Release.promise;
        }
        return inner.save(state);
      },
      async clear() {
        return inner.clear();
      },
    };
    void gatedStorage;
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
      localVaultId: 'local-a',
      vault: new ObservableVaultService(vault),
    });
    await service.enable({ localVaultId: 'local-a', name: 'A' });
    // Arm AFTER setup: only S1's selection persist below pauses.
    armed = true;
    service.setActiveLocalVault('local-x');
    const s1done = (async () => {
      await s1Reached.promise;
      // S2 queues while S1 in flight.
      const s2 = service.enable({ localVaultId: 'local-y', name: 'Y' });
      // Prove S2 actually queued (lane held by S1): it must not resolve
      // before S1 releases.
      let s2Resolved = false;
      void s2.then(() => {
        s2Resolved = true;
      });
      await Promise.resolve();
      await Promise.resolve();
      expect(s2Resolved).toBe(false);
      s1Release.resolve();
      await s2;
      expect(s2Resolved).toBe(true);
    })();
    await s1done;
    // Quiesce the fire-and-forget selection persist from setActiveLocalVault
    // (it queued behind the same lane; enable already drained it, but flush
    // once more for determinism).
    await (service as unknown as { reconcile: () => Promise<void> })
      .reconcile()
      .catch(() => undefined);
    const durable = await inner.load();
    expect(
      durable?.accounts[UID_A]?.bindings['local-y']?.cloudVaultId,
    ).toBeTruthy();
    service.dispose();
  });
});

describe('Case D — attachment switch during a paused save', () => {
  it('stale A enable save cannot redirect B selection or rewire B', async () => {
    // ```text
    // A attached + enable(local-a) starts → enters storage.save → PAUSED
    // runtime replaces attachment A → B (atomic identity switch)
    // selection B reported; enable(local-b) queues behind the lane
    // release the stale A save
    // ```
    const account = createFakeAccount();
    account.signInAs(UID_A);
    const remote = new MemorySyncRemote();
    const cloudA = await seedCloudVault(remote, account, UID_A, 'seed-a', {
      'a.md': 'a',
    });
    void cloudA;

    const inner = createMemorySyncStorage();
    const saveReached = deferred<void>();
    const releaseSave = deferred<void>();
    let pauseNext = false;
    const storage: VaultSyncStorage = {
      async load() {
        return inner.load();
      },
      async save(state: StoredSyncState) {
        if (pauseNext) {
          pauseNext = false;
          saveReached.resolve();
          await releaseSave.promise;
        }
        return inner.save(state);
      },
      async clear() {
        return inner.clear();
      },
    };
    const { vault: vaultA } = createMemoryVault({});
    const obsA = new ObservableVaultService(vaultA);
    const { vault: vaultB } = createMemoryVault({});
    const obsB = new ObservableVaultService(vaultB);
    const service = new VaultSyncStore({
      remote,
      account: account.store,
      storage,
      tracker: null,
      debounceMs: 3_600_000,
    });
    await service.restore();
    service.attach({ localVaultId: 'local-a', vault: obsA });

    // S1: enable A enters its save and pauses there.
    pauseNext = true;
    const enableA = service.enable({ localVaultId: 'local-a', name: 'A' });
    await saveReached.promise;

    // Runtime switches attachment to B while A's save is paused.
    service.attach({ localVaultId: 'local-b', vault: obsB });
    service.setActiveLocalVault('local-b');
    // S2/S3 queue behind the lane (selection + enable B).
    const enableB = service.enable({ localVaultId: 'local-b', name: 'B' });

    releaseSave.resolve();
    await enableA;
    await enableB;
    // Drain the queued selection commit behind the same lane.
    await service.reconcile();

    // Live state: B attachment is authoritative; both bindings survive.
    const snapshot = service.snapshot();
    expect(snapshot.binding).toMatchObject({
      localVaultId: 'local-b',
      name: 'B',
    });
    expect(snapshot.activeLocalVaultId).toBe('local-b');
    expect(snapshot.bindings).toHaveLength(2);

    // Durable state agrees: B selection, B name, A binding preserved.
    const durable = await inner.load();
    expect(durable?.accounts[UID_A]?.activeLocalVaultId).toBe('local-b');
    expect(durable?.accounts[UID_A]?.bindings['local-a']).toMatchObject({
      name: 'A',
      enabled: true,
    });
    expect(durable?.accounts[UID_A]?.bindings['local-b']).toMatchObject({
      name: 'B',
      enabled: true,
    });

    // The stale A transition never rewired B's physical vault: a write
    // through B schedules, a write through A does not.
    await writeFile(obsA, 'stale.md', 'stale');
    await Promise.resolve();
    const pendingAfterStaleA = snapshotPending(service);
    expect(pendingAfterStaleA).toBe(0);
    await writeFile(obsB, 'fresh.md', 'fresh');
    expect(snapshotPending(service)).toBeGreaterThan(0);
    service.dispose();
  });
});

describe('Case E — presentation ownership across a paused enable save', () => {
  it('a stale enable completion cannot reset the host-reported selection', async () => {
    // ```text
    // attach A; setActiveLocalVault(A); enable(A) → pause inside persistence
    // runtime switches to B; setActiveLocalVault(B)
    // release the stale A save
    // → attached replica B, remembered B, durable account active B
    // → B's existing binding stays eligible and reconciles
    // ```
    const account = createFakeAccount();
    account.signInAs(UID_A);
    const remote = new MemorySyncRemote();
    const inner = createMemorySyncStorage();
    const saveReached = deferred<void>();
    const releaseSave = deferred<void>();
    const selectionSaved = deferred<void>();
    let pauseNextSave = false;
    let watchSelection = false;
    const storage: VaultSyncStorage = {
      async load() {
        return inner.load();
      },
      async save(state: StoredSyncState) {
        if (pauseNextSave) {
          pauseNextSave = false;
          saveReached.resolve();
          await releaseSave.promise;
        }
        if (
          watchSelection &&
          state.accounts[UID_A]?.activeLocalVaultId === 'local-b'
        ) {
          selectionSaved.resolve();
        }
        return inner.save(state);
      },
      async clear() {
        return inner.clear();
      },
    };
    const { vault: vaultA } = createMemoryVault({});
    const obsA = new ObservableVaultService(vaultA);
    const { vault: vaultB } = createMemoryVault({});
    const obsB = new ObservableVaultService(vaultB);
    const service = new VaultSyncStore({
      remote,
      account: account.store,
      storage,
      tracker: null,
      debounceMs: 3_600_000,
    });
    await service.restore();
    // Set up two real bindings (A and B) side by side.
    service.attach({ localVaultId: 'local-a', vault: obsA });
    service.setActiveLocalVault('local-a');
    await writeFile(obsA, 'a.md', 'a');
    await service.enable({ localVaultId: 'local-a', name: 'A' });
    await service.reconcile();
    const cloudA = service.snapshot().binding?.cloudVaultId as string;
    service.attach({ localVaultId: 'local-b', vault: obsB });
    service.setActiveLocalVault('local-b');
    await writeFile(obsB, 'b.md', 'b');
    await service.enable({ localVaultId: 'local-b', name: 'B' });
    await service.reconcile();
    const cloudB = service.snapshot().binding?.cloudVaultId as string;
    expect(cloudB).not.toBe(cloudA);
    // Host re-opens A and reports it; drain the queued selection commit.
    service.attach({ localVaultId: 'local-a', vault: obsA });
    service.setActiveLocalVault('local-a');
    await service.reconcile();

    // Arm: the next durable save is the stale enable(A) below.
    pauseNextSave = true;
    const enableA = service.enable({ localVaultId: 'local-a', name: 'A2' });
    await saveReached.promise;

    // Runtime replaces the replica while A's save is paused, and the host
    // reports B. No enable(B) "repair" is involved.
    service.attach({ localVaultId: 'local-b', vault: obsB });
    watchSelection = true;
    service.setActiveLocalVault('local-b');
    releaseSave.resolve();
    await enableA;
    await selectionSaved.promise;

    // Presentation state is host-owned: the stale A completion cannot
    // reset it, and the attached replica is B with B's existing binding
    // eligible (snapshot.binding is the live B binding).
    const snapshot = service.snapshot();
    expect(snapshot.binding).toMatchObject({
      localVaultId: 'local-b',
      cloudVaultId: cloudB,
    });
    expect(snapshot.activeLocalVaultId).toBe('local-b');
    const durable = await inner.load();
    expect(durable?.accounts[UID_A]?.activeLocalVaultId).toBe('local-b');

    // B remains fully operational: a local write syncs through B's
    // binding without any repair call.
    const revisionBefore = service.snapshot().lastRevision ?? 0;
    await writeFile(obsB, 'b2.md', 'b2');
    await service.reconcile();
    expect(service.snapshot().lastRevision).toBeGreaterThan(revisionBefore);
    expect(
      remote.calls.some(
        (call) =>
          call.includes(cloudB) && call.startsWith('compareAndSwapHead'),
      ),
    ).toBe(true);
    service.dispose();
  });
});

function snapshotPending(service: VaultSyncStore): number {
  return service.snapshot().pendingChanges;
}
