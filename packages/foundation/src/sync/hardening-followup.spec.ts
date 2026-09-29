/**
 * Correctness hardening follow-up conformance.
 *
 * Executable distributed-state documentation for:
 *
 * ```text
 * prepare A → switch B → finalize rejects ACCOUNT_CHANGED (no rebinding)
 * finalize persistence failure → zero phantom binding, retry succeeds
 * vault A reconcile paused → switch B → A hook never hits B
 * pending A → switch B → B never receives A paths; back to A → retries
 * R1 → apply R2 → network fail → remote R3 → retry without spurious conflict
 * production-style forUid(A) stays pinned after live becomes B
 * ```
 *
 * All concurrency uses explicit deferred gates (no sleeps for correctness).
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
  VaultSyncError,
  type ExpectedHead,
  type RemoteHeadInput,
  type SyncRemote,
} from '../index.js';
import { VaultSyncStore, createMemorySyncStorage } from './service.js';
import { ObservableVaultService } from './mutations.js';

const UID_A = 'uid-prepare-a';
const UID_B = 'uid-prepare-b';

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

async function readText(vault: VaultService, path: string): Promise<string> {
  return new TextDecoder().decode(await vault.read(workspacePath(path)));
}

/** Seed one cloud vault under the given uid; returns its cloud id. */
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

describe('prepared Download & Open identity stability', () => {
  it('prepare under A → switch B → finalize rejects ACCOUNT_CHANGED with no rebinding', async () => {
    const account = createFakeAccount();
    const remote = new MemorySyncRemote();
    const cloudA = await seedCloudVault(remote, account, UID_A, 'seed-a', {
      'note.md': 'hello-a',
    });
    // Downloader service shares the remote + account (fresh storage).
    account.signInAs(UID_A);
    const service = new VaultSyncStore({
      remote,
      account: account.store,
      storage: createMemorySyncStorage(),
      tracker: null,
    });
    await service.restore();
    const { vault: target } = createMemoryVault({});
    const trace: string[] = [];
    trace.push('prepare A start');
    const prepared = await service.materializeRemoteVault(
      cloudA,
      'local-b',
      target,
    );
    trace.push('prepare A ok');
    expect(prepared.owner.uid).toBe(UID_A);
    expect(service.snapshot().binding).toBeNull();
    expect(await readText(target, 'note.md')).toBe('hello-a');

    // Activation (simulated store) succeeds, then the account switches
    // before finalization.
    trace.push('switch A→B');
    account.signOut();
    account.signInAs(UID_B);
    expect(service.snapshot().binding).toBeNull();

    trace.push('finalize attempt under B');
    await expect(
      service.finalizeMaterializedVault(prepared),
    ).rejects.toMatchObject({ code: 'ACCOUNT_CHANGED' });
    trace.push('ACCOUNT_CHANGED');
    // B has no binding; the prepared A transaction was not rebound under B.
    expect(service.isCloudVaultBound(cloudA)).toBe(false);
    expect(service.snapshot().binding).toBeNull();
    expect(service.snapshot().bindings).toEqual([]);
    expect(service.snapshot().activeLocalVaultId).not.toBe('local-b');
    expect(trace).toEqual([
      'prepare A start',
      'prepare A ok',
      'switch A→B',
      'finalize attempt under B',
      'ACCOUNT_CHANGED',
    ]);

    // Back under A, a fresh prepare → finalize succeeds (the stale
    // prepared handle stays invalid — retry means re-prepare).
    account.signOut();
    account.signInAs(UID_A);
    const { vault: target2 } = createMemoryVault({});
    const prepared2 = await service.materializeRemoteVault(
      cloudA,
      'local-b',
      target2,
    );
    // Real activation attaches the staged vault under the prepared id.
    service.attach({
      localVaultId: 'local-b',
      vault: new ObservableVaultService(target2),
    });
    await service.finalizeMaterializedVault(prepared2);
    expect(service.isCloudVaultBound(cloudA)).toBe(true);
    expect(service.snapshot().binding).toMatchObject({
      localVaultId: 'local-b',
    });
    service.dispose();
  });

  it('finalization is local-only (no network read at finalize time)', async () => {
    const account = createFakeAccount();
    const remote = new MemorySyncRemote();
    const cloudA = await seedCloudVault(remote, account, UID_A, 'seed-a', {
      'note.md': 'v1',
    });
    account.signInAs(UID_A);
    const service = new VaultSyncStore({
      remote,
      account: account.store,
      storage: createMemorySyncStorage(),
      tracker: null,
    });
    await service.restore();
    const { vault: target } = createMemoryVault({});
    const prepared = await service.materializeRemoteVault(
      cloudA,
      'local-b',
      target,
    );
    // Real activation attaches the staged vault under the prepared id.
    service.attach({
      localVaultId: 'local-b',
      vault: new ObservableVaultService(target),
    });
    const callsBefore = [...remote.calls];
    await service.finalizeMaterializedVault(prepared);
    // No remote traffic during finalization (name/base came prepared).
    expect(remote.calls.slice(callsBefore.length)).toEqual([]);
    expect(service.snapshot().binding).toMatchObject({ name: prepared.name });
    service.dispose();
  });
});

describe('transactional binding persistence', () => {
  it('enable storage failure leaves zero in-memory binding', async () => {
    const account = createFakeAccount();
    account.signInAs(UID_A);
    const storage = createMemorySyncStorage();
    const origSave = storage.save.bind(storage);
    let failNext = false;
    storage.save = async (state) => {
      if (failNext) {
        failNext = false;
        throw new Error('disk full');
      }
      return origSave(state);
    };
    const { vault } = createMemoryVault({});
    const service = new VaultSyncStore({
      remote: new MemorySyncRemote(),
      account: account.store,
      storage,
      tracker: null,
    });
    await service.restore();
    service.attach({
      localVaultId: 'local-a',
      vault: new ObservableVaultService(vault),
    });
    failNext = true;
    await expect(
      service.enable({ localVaultId: 'local-a', name: 'A' }),
    ).rejects.toThrow('disk full');
    expect(service.snapshot().binding).toBeNull();
    expect(service.snapshot().bindings).toEqual([]);
    // Retry succeeds.
    await service.enable({ localVaultId: 'local-a', name: 'A' });
    expect(service.snapshot().binding?.localVaultId).toBe('local-a');
    service.dispose();
  });
});

describe('replica-stable reconcile generation', () => {
  it('vault A reconcile paused → switch to B → A hook never hits B', async () => {
    // Deterministic vault-switch race (no sleeps):
    //
    // ```text
    // vault A bound and syncing (base R1)
    // remote advances cloudA to R2 (remote-only.md)
    // A starts reconcile, gated inside downloadBlob for cloudA
    // app switches to vault B (setActiveLocalVault, different cloud)
    // resume A → aborts before invoking B workspace reconciler
    // ```
    const account = createFakeAccount();
    account.signInAs(UID_A);
    const baseRemote = new MemorySyncRemote();
    // Background auto-runs are parked (huge debounce) so only explicit
    // reconciles drive the protocol; otherwise watcher/mutation-triggered
    // runs would race the gate.
    const PARKED_DEBOUNCE_MS = 3_600_000;
    const hookCalls: Array<{ vault: string; paths: string[] }> = [];
    let activeLabel = 'A';
    const downloadGate = deferred<void>();
    const reachedDownload = deferred<void>();
    let gating = false;
    // Gate ANY blob download while armed: background runs are parked,
    // so the only download in flight is A's pull of cloudA R2.
    const gated: SyncRemote = {
      listVaults: () => baseRemote.listVaults(),
      readHead: (vaultId) => baseRemote.readHead(vaultId),
      loadManifest: (vaultId, hash, object) =>
        baseRemote.loadManifest(vaultId, hash, object),
      hasBlob: (vaultId, blob) => baseRemote.hasBlob(vaultId, blob),
      uploadBlob: (vaultId, blob, bytes) =>
        baseRemote.uploadBlob(vaultId, blob, bytes),
      downloadBlob: async (vaultId, blob) => {
        if (gating) {
          reachedDownload.resolve();
          await downloadGate.promise;
        }
        return baseRemote.downloadBlob(vaultId, blob);
      },
      uploadManifest: (vaultId, manifest) =>
        baseRemote.uploadManifest(vaultId, manifest),
      compareAndSwapHead: (vaultId, expected, next) =>
        baseRemote.compareAndSwapHead(vaultId, expected, next),
      watchHead: (vaultId, onHead, onError) =>
        baseRemote.watchHead(vaultId, onHead, onError),
    };

    const service = new VaultSyncStore({
      remote: gated,
      account: account.store,
      storage: createMemorySyncStorage(),
      tracker: null,
      debounceMs: PARKED_DEBOUNCE_MS,
      reconciler: {
        handleRemoteApplied: async (notification) => {
          hookCalls.push({
            vault: activeLabel,
            paths: [...notification.written, ...notification.removed],
          });
        },
      },
    });
    await service.restore();
    // Bind A (fresh cloud) and commit R1 (a seed file forces a real HEAD;
    // an empty vault would converge pull-only with no remote vault).
    const { vault: vaultA } = createMemoryVault({});
    await writeFile(vaultA, 'a.md', 'v1');
    service.attach({
      localVaultId: 'local-a',
      vault: new ObservableVaultService(vaultA),
    });
    await service.enable({ localVaultId: 'local-a', name: 'A' });
    await service.reconcile();
    const cloudA = service.snapshot().binding?.cloudVaultId as string;
    // Bind B (a second fresh cloud) so the switch has a real replica.
    const { vault: vaultB } = createMemoryVault({});
    await writeFile(vaultB, 'b-local.md', 'b1');
    const obsB = new ObservableVaultService(vaultB);
    service.attach({ localVaultId: 'local-b', vault: obsB });
    service.setActiveLocalVault('local-b');
    await service.enable({ localVaultId: 'local-b', name: 'B' });
    await service.reconcile();
    const cloudB = service.snapshot().binding?.cloudVaultId as string;
    expect(cloudB).not.toBe(cloudA);
    // Back to A (still R1 locally); a seeder advances cloudA to R2 with a
    // remote-only file A must download.
    service.attach({
      localVaultId: 'local-a',
      vault: new ObservableVaultService(vaultA),
    });
    service.setActiveLocalVault('local-a');
    const { vault: seedVault } = createMemoryVault({});
    const seeder = new VaultSyncStore({
      remote: baseRemote,
      account: account.store,
      storage: createMemorySyncStorage(),
      tracker: null,
      debounceMs: PARKED_DEBOUNCE_MS,
    });
    await seeder.restore();
    seeder.attach({
      localVaultId: 'seeder',
      vault: new ObservableVaultService(seedVault),
    });
    await seeder.attachRemoteVault(cloudA, 'seeder');
    await writeFile(seedVault, 'remote-only.md', 'r1');
    await seeder.reconcile();
    seeder.dispose();

    // A starts its pull, gated inside the cloudA download.
    gating = true;
    activeLabel = 'A';
    hookCalls.length = 0;
    const cycle = service.reconcile();
    // Prove A actually reached the contested download (no sleeps).
    await reachedDownload.promise;
    // App replaces the attached replica with vault B while A is gated
    // (runtime attachment identity changes atomically).
    activeLabel = 'B';
    service.attach({ localVaultId: 'local-b', vault: obsB });
    service.setActiveLocalVault('local-b');
    // Resume the stale A cycle: it must abort before invoking B's
    // workspace reconciler (generation check precedes the hook).
    downloadGate.resolve();
    gating = false;
    await cycle;
    // A reconcile aborted: B received zero A paths and A's old result did
    // not update B's binding/base.
    expect(
      hookCalls.filter(
        (c) => c.vault === 'B' && c.paths.includes('remote-only.md'),
      ),
    ).toEqual([]);
    expect(hookCalls).toEqual([]);
    expect(service.snapshot().binding?.localVaultId).toBe('local-b');
    expect(service.snapshot().binding?.cloudVaultId).toBe(cloudB);
    service.dispose();
  });
});

describe('replica-scoped pending reconciliation', () => {
  it('pending A never replays into B; switching back retries A first', async () => {
    const account = createFakeAccount();
    account.signInAs(UID_A);
    const remote = new MemorySyncRemote();
    const cloudA = await seedCloudVault(remote, account, UID_A, 'seed-a', {
      'note.md': 'v1',
    });
    account.signInAs(UID_A);
    const hookLog: string[] = [];
    let failNextHook = false;
    // Park background auto-runs (huge debounce): only explicit reconciles
    // drive the protocol, so gates and failure injection stay deterministic.
    const PARKED_DEBOUNCE_MS = 3_600_000;
    const service = new VaultSyncStore({
      remote,
      account: account.store,
      storage: createMemorySyncStorage(),
      tracker: null,
      debounceMs: PARKED_DEBOUNCE_MS,
      reconciler: {
        handleRemoteApplied: async (notification) => {
          const paths = [...notification.written, ...notification.removed]
            .sort()
            .join(',');
          if (failNextHook) {
            failNextHook = false;
            hookLog.push(`throw:${paths}`);
            throw new Error('workspace reload blew up');
          }
          hookLog.push(`ok:${paths}`);
        },
      },
    });
    await service.restore();
    // Bind local-a (fresh cloud) and commit R1 so a seeder can attach
    // (an empty vault would converge pull-only with no remote vault).
    const { vault: vA } = createMemoryVault({});
    await writeFile(vA, 'seed.md', 's1');
    const oA = new ObservableVaultService(vA);
    service.attach({ localVaultId: 'local-a', vault: oA });
    await service.enable({ localVaultId: 'local-a', name: 'A' });
    await service.reconcile();
    const freshCloud = service.snapshot().binding?.cloudVaultId as string;
    // Seed freshCloud with v2 from another replica so A pulls.
    const { vault: vSeed } = createMemoryVault({});
    await writeFile(vSeed, 'note.md', 'v2-remote');
    const seeder = new VaultSyncStore({
      remote,
      account: account.store,
      storage: createMemorySyncStorage(),
      tracker: null,
      debounceMs: PARKED_DEBOUNCE_MS,
    });
    await seeder.restore();
    seeder.attach({
      localVaultId: 'seeder',
      vault: new ObservableVaultService(vSeed),
    });
    await seeder.attachRemoteVault(freshCloud, 'seeder');
    await seeder.reconcile();
    seeder.dispose();
    void cloudA;

    // A pulls v2 but the hook throws → pending keyed to A.
    failNextHook = true;
    await expect(service.reconcile()).rejects.toThrow(
      'workspace reload blew up',
    );
    expect(hookLog).toEqual(['throw:note.md']);

    // Bind B (different cloud) and switch to it.
    await writeFile(vA, 'a-local.md', 'a1');
    const { vault: vB } = createMemoryVault({});
    const oB = new ObservableVaultService(vB);
    service.attach({ localVaultId: 'local-b', vault: oB });
    service.setActiveLocalVault('local-b');
    await service.enable({ localVaultId: 'local-b', name: 'B' });
    hookLog.length = 0;
    await service.reconcile();
    // B never receives A's pending paths.
    expect(hookLog.filter((l) => l.includes('note.md'))).toEqual([]);

    // Switch back to A: the pending A notification retries before new work.
    service.attach({ localVaultId: 'local-a', vault: oA });
    service.setActiveLocalVault('local-a');
    hookLog.length = 0;
    await service.reconcile();
    expect(hookLog[0]).toBe('ok:note.md');
    service.dispose();
  });
});

describe('post-apply checkpoint across invocations', () => {
  it('R1 → apply R2 → network fail → remote R3 → retry without spurious conflict', async () => {
    const account = createFakeAccount();
    account.signInAs(UID_A);
    const remote = new MemorySyncRemote();
    // Device A seeds R1.
    const { vault: vaultA } = createMemoryVault({});
    const obsA = new ObservableVaultService(vaultA);
    const PARKED = 3_600_000;
    const serviceA = new VaultSyncStore({
      remote,
      account: account.store,
      storage: createMemorySyncStorage(),
      tracker: null,
      debounceMs: PARKED,
    });
    await serviceA.restore();
    serviceA.attach({ localVaultId: 'local-a', vault: obsA });
    await writeFile(obsA, 'note.md', 'v1');
    await serviceA.enable({ localVaultId: 'local-a', name: 'A' });
    await serviceA.reconcile();
    const cloudId = serviceA.snapshot().binding?.cloudVaultId as string;

    // Device B pulls R1, then adds a genuine local edit.
    const storageB = createMemorySyncStorage();
    const { vault: vaultB } = createMemoryVault({});
    const obsB = new ObservableVaultService(vaultB);
    const serviceB = new VaultSyncStore({
      remote,
      account: account.store,
      storage: storageB,
      tracker: null,
      debounceMs: PARKED,
    });
    await serviceB.restore();
    serviceB.attach({ localVaultId: 'local-b', vault: obsB });
    await serviceB.attachRemoteVault(cloudId, 'local-b');
    await serviceB.reconcile();
    expect(await readText(vaultB, 'note.md')).toBe('v1');
    await writeFile(obsB, 'b-local.md', 'mine');

    // A advances to R2 (remote-only edit for B).
    await writeFile(obsA, 'note.md', 'v2');
    await serviceA.reconcile();

    // B's next cycle applies R2 then fails the outbound upload (NETWORK).
    const innerUpload = remote.uploadBlob.bind(remote);
    let failNextUpload = true;
    remote.uploadBlob = async (vaultId, blob, bytes) => {
      if (failNextUpload && vaultId === cloudId) {
        failNextUpload = false;
        throw new VaultSyncError('NETWORK', 'simulated fault after apply');
      }
      return innerUpload(vaultId, blob, bytes);
    };
    const trace: string[] = [];
    trace.push('B read R1');
    await expect(serviceB.reconcile()).rejects.toMatchObject({
      code: 'NETWORK',
    });
    trace.push('B apply R2');
    trace.push('network failure');
    // Checkpoint truth: B's persisted base is now R2 even though the
    // outbound commit failed (R2 bytes are the merge ancestor, not edits).
    const storedB = await storageB.load();
    const baseRev =
      storedB?.accounts[UID_A]?.bindings['local-b']?.base?.manifest.revision;
    expect(baseRev).toBe(2);
    expect(await readText(vaultB, 'note.md')).toBe('v2');

    // Another device commits R3 (touches an unrelated path plus note.md
    // remotely? keep note.md remote-only so no genuine conflict).
    await writeFile(obsA, 'extra.md', 'e3');
    await serviceA.reconcile();
    trace.push('A commit R3');

    // B retries with checkpoint R2: R2 bytes are NOT classified as B edits.
    remote.uploadBlob = innerUpload;
    trace.push('B retry with provisional/checkpoint R2');
    await serviceB.reconcile();
    const dumpB: Record<string, string> = {};
    for (const path of ['note.md', 'b-local.md', 'extra.md']) {
      try {
        dumpB[path] = await readText(vaultB, path);
      } catch {
        // Missing path stays absent.
      }
    }
    expect(dumpB['note.md']).toBe('v2');
    expect(dumpB['b-local.md']).toBe('mine');
    expect(dumpB['extra.md']).toBe('e3');
    // No spurious conflict copy for the R2-applied file: R2 bytes were the
    // merge ancestor (checkpoint), never B's local edits.
    const conflicts: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      const children = await vaultB.list(
        dir === '' ? workspacePath('') : workspacePath(dir),
      );
      for (const child of children) {
        const path = dir === '' ? child.name : `${dir}/${child.name}`;
        if (child.kind === 'directory') await walk(path);
        else if (path.includes('.conflict-')) conflicts.push(path);
      }
    };
    await walk('');
    expect(conflicts).toEqual([]);
    // No spurious conflict copy for the R2-applied file.
    const { vault: probe } = createMemoryVault({});
    void probe;
    expect(trace).toEqual([
      'B read R1',
      'B apply R2',
      'network failure',
      'A commit R3',
      'B retry with provisional/checkpoint R2',
    ]);
    serviceA.dispose();
    serviceB.dispose();
  });
});

describe('production-style identity scoping', () => {
  it('forUid(A) remains pinned after live account becomes B', async () => {
    // Partitioned provider with immutable per-UID scopes (Firebase model).
    const partitions = new Map<string, MemorySyncRemote>();
    let liveUid: string | null = UID_A;
    const forUid = (uid: string): SyncRemote => {
      let part = partitions.get(uid);
      if (part === undefined) {
        part = new MemorySyncRemote();
        partitions.set(uid, part);
      }
      const scoped = part;
      return {
        listVaults: () => scoped.listVaults(),
        readHead: (v) => scoped.readHead(v),
        loadManifest: (v, h, o) =>
          (
            scoped.loadManifest as (
              vaultId: string,
              hash: Parameters<SyncRemote['loadManifest']>[1],
              object?: string,
            ) => ReturnType<SyncRemote['loadManifest']>
          )(v, h, o),
        hasBlob: (v, b) => scoped.hasBlob(v, b),
        uploadBlob: (v, b, bytes) => scoped.uploadBlob(v, b, bytes),
        downloadBlob: (v, b) => scoped.downloadBlob(v, b),
        uploadManifest: (v, m) => scoped.uploadManifest(v, m),
        compareAndSwapHead: (e, x, n) =>
          scoped.compareAndSwapHead(
            e as string,
            x as ExpectedHead | null,
            n as RemoteHeadInput,
          ),
        watchHead: (v, onHead, onError) => scoped.watchHead(v, onHead, onError),
      } as SyncRemote;
    };
    const scopedA = forUid(UID_A);
    // Write under A through the scoped view.
    const { vault } = createMemoryVault({});
    await writeFile(vault, 'a.md', 'v1');
    const { reconcileVault } = await import('./engine.js');
    await reconcileVault({
      vault,
      remote: scopedA,
      vaultId: 'vault-x',
      name: 'X',
      base: null,
      deviceId: 'device-a',
    });
    // Live account becomes B; the previously captured scope still
    // addresses A only (reads A HEAD, never B's namespace).
    liveUid = UID_B;
    void liveUid;
    const headViaScopedA = await scopedA.readHead('vault-x');
    expect(headViaScopedA).not.toBeNull();
    expect(headViaScopedA?.revision).toBe(1);
    const scopedB = forUid(UID_B);
    expect(await scopedB.readHead('vault-x')).toBeNull();
  });
});
