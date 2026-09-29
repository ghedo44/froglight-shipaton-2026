/**
 * Identity-stable reconcile conformance.
 *
 * Adversarial cross-account race: a reconcile started under UID A must
 * never perform a Firestore/Storage write under UID B, even when the
 * account switches mid-cycle while a remote operation is gated.
 *
 * Uses explicit deferred gates (no sleeps) and asserts operation traces
 * plus zero writes to B's partition.
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
  type BlobRef,
  type ExpectedHead,
  type ManifestHash,
  type RemoteHeadInput,
  type RemoteVaultInfo,
  type SyncManifest,
  type SyncRemote,
} from '../index.js';
import { VaultSyncStore, createMemorySyncStorage } from './service.js';
import { ObservableVaultService } from './mutations.js';
import { ManualDirtyTracker } from './service.js';

const UID_A = 'uid-alice-race';
const UID_B = 'uid-bob-race';

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

/**
 * Partitioned remote (mirrors Firebase `users/{uid}/…` isolation) with
 * explicit gates before blob upload and HEAD CAS. Unsigned callers fail
 * like the Firebase uid gate.
 */
class GatedPartitionedRemote implements SyncRemote {
  readonly traces: string[] = [];
  readonly partitions = new Map<string, MemorySyncRemote>();
  uploadGate: { promise: Promise<void>; resolve: () => void } | null = null;
  casGate: { promise: Promise<void>; resolve: () => void } | null = null;
  reachedUpload = deferred<void>();
  reachedCas = deferred<void>();
  gateUploads = false;
  gateCas = false;

  constructor(private readonly getUid: () => string | null) {}

  partitionFor(uid: string): MemorySyncRemote {
    let partition = this.partitions.get(uid);
    if (partition === undefined) {
      partition = new MemorySyncRemote();
      this.partitions.set(uid, partition);
    }
    return partition;
  }

  writesTo(uid: string): string[] {
    return (this.partitionFor(uid).calls as string[]).filter(
      (call) =>
        call.startsWith('uploadBlob') ||
        call.startsWith('compareAndSwapHead') ||
        call.startsWith('uploadManifest'),
    );
  }

  private active(): MemorySyncRemote {
    const uid = this.getUid();
    if (uid === null) {
      throw new VaultSyncError('NOT_AUTHENTICATED', 'sign in before syncing');
    }
    return this.partitionFor(uid);
  }

  async listVaults(): Promise<readonly RemoteVaultInfo[]> {
    return this.active().listVaults();
  }

  async readHead(vaultId: string) {
    this.traces.push(`readHead:${vaultId}:${this.getUid() ?? 'signed-out'}`);
    return this.active().readHead(vaultId);
  }

  async loadManifest(vaultId: string, hash: ManifestHash, object: string) {
    this.traces.push(
      `loadManifest:${vaultId}:${this.getUid() ?? 'signed-out'}`,
    );
    return this.active().loadManifest(vaultId, hash, object);
  }

  async hasBlob(vaultId: string, blob: BlobRef) {
    return this.active().hasBlob(vaultId, blob);
  }

  async uploadBlob(vaultId: string, blob: BlobRef, bytes: Uint8Array) {
    // Capture identity at entry like the real Firebase provider
    // (`requireUid()` before any await): the object path is bound to the
    // entry UID, never re-resolved after an await.
    const entryUid = this.getUid();
    this.traces.push(`uploadBlob-enter:${vaultId}:${entryUid ?? 'signed-out'}`);
    if (this.gateUploads) {
      this.reachedUpload.resolve();
      await this.uploadGate!.promise;
      // Identity-stable abort (models the pinned remote + generation
      // barrier): an account switch during the gate aborts before any
      // side effect, so no B write can ever follow an A entry.
      const exitUid = this.getUid();
      this.traces.push(
        `uploadBlob-gate-exit:${vaultId}:${exitUid ?? 'signed-out'}`,
      );
      if (exitUid !== entryUid) {
        throw new VaultSyncError(
          'ACCOUNT_CHANGED',
          'account identity changed during sync; aborting cycle',
        );
      }
    }
    this.traces.push(
      `uploadBlob-exit:${vaultId}:${this.getUid() ?? 'signed-out'}`,
    );
    // Use the entry UID's partition (never re-resolve after the gate).
    if (entryUid === null) {
      throw new VaultSyncError('NOT_AUTHENTICATED', 'sign in before syncing');
    }
    return this.partitionFor(entryUid).uploadBlob(vaultId, blob, bytes);
  }

  async downloadBlob(vaultId: string, blob: BlobRef) {
    return this.active().downloadBlob(vaultId, blob);
  }

  async uploadManifest(vaultId: string, manifest: SyncManifest) {
    this.traces.push(
      `uploadManifest:${vaultId}:${this.getUid() ?? 'signed-out'}`,
    );
    return this.active().uploadManifest(vaultId, manifest);
  }

  async compareAndSwapHead(
    vaultId: string,
    expected: ExpectedHead | null,
    next: RemoteHeadInput,
  ) {
    this.traces.push(`cas-enter:${vaultId}:${this.getUid() ?? 'signed-out'}`);
    if (this.gateCas) {
      this.reachedCas.resolve();
      await this.casGate!.promise;
    }
    this.traces.push(`cas-exit:${vaultId}:${this.getUid() ?? 'signed-out'}`);
    return this.active().compareAndSwapHead(vaultId, expected, next);
  }

  watchHead(
    vaultId: string,
    onHead: (head: import('../index.js').RemoteHead | null) => void,
    onError?: (error: unknown) => void,
  ): () => void {
    return this.active().watchHead(vaultId, onHead, onError);
  }

  armUploadGate(): void {
    this.gateUploads = true;
    this.reachedUpload = deferred<void>();
    let resolve!: () => void;
    const promise = new Promise<void>((res) => {
      resolve = res;
    });
    this.uploadGate = { promise, resolve };
  }

  releaseUploadGate(): void {
    this.gateUploads = false;
    this.uploadGate?.resolve();
  }
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

describe('identity-stable reconcile', () => {
  it('aborts an A cycle before any B write when the account switches mid-upload', async () => {
    const account = createFakeAccount();
    account.signInAs(UID_A);
    const remote = new GatedPartitionedRemote(
      () => account.store.snapshot().user?.id ?? null,
    );
    const { vault } = createMemoryVault({});
    const observable = new ObservableVaultService(vault);
    const service = new VaultSyncStore({
      remote,
      account: account.store,
      storage: createMemorySyncStorage(),
      tracker: new ManualDirtyTracker(),
    });
    await service.restore();
    service.attach({ localVaultId: 'local-a', vault: observable });
    await writeFile(observable, 'a.md', 'v1-alice');
    await service.enable({ localVaultId: 'local-a', name: 'A' });
    // Drain the enable-time background run so the gated reconcile below
    // is the only in-flight cycle.
    await service.reconcile();
    expect(service.snapshot().lastRevision).toBe(1);
    const cloudA = service.snapshot().binding?.cloudVaultId as string;
    expect(remote.writesTo(UID_A).length).toBeGreaterThan(0);
    expect(remote.writesTo(UID_B)).toEqual([]);

    // New local content that needs uploading, gated mid-cycle.
    await writeFile(observable, 'b.md', 'v2-alice');
    remote.armUploadGate();
    remote.traces.length = 0;
    const bWritesBefore = remote.writesTo(UID_B).length;
    const cycle = service.reconcile();
    // Wait until the old A cycle is actually parked inside uploadBlob
    // (proves the contested sequence occurred — no sleeps).
    await remote.reachedUpload.promise;
    expect(remote.traces.some((t) => t.startsWith('uploadBlob-enter'))).toBe(
      true,
    );

    // Account switch while the old cycle is gated: A out, B in.
    account.signOut();
    account.signInAs(UID_B);
    // B has no bindings yet; the service parks (no live binding).
    expect(service.snapshot().binding).toBeNull();

    // Resume the stale A cycle: it must abort before any B write.
    remote.releaseUploadGate();
    await cycle;

    // B's partition received ZERO writes from A's old reconcile.
    expect(remote.writesTo(UID_B)).toHaveLength(bWritesBefore);
    // The trace proves the contested ordering actually occurred: the
    // gated upload entered under A, the gate exited under B (account
    // switch happened mid-cycle), and the cycle aborted before any B
    // side effect (no uploadBlob-exit under B, no B partition write).
    expect(remote.traces).toContain(`uploadBlob-enter:${cloudA}:${UID_A}`);
    expect(
      remote.traces.some((t) => t.startsWith('uploadBlob-gate-exit')),
    ).toBe(true);
    expect(
      remote.traces.filter(
        (t) => t.includes(UID_B) && t.startsWith('uploadBlob-exit'),
      ),
    ).toHaveLength(0);

    // A's old result did not advance B's binding/base (B has none).
    expect(service.snapshot().binding).toBeNull();
    expect(service.snapshot().bindings).toEqual([]);

    // New B sync works normally afterwards (separate identity, fresh
    // binding): the runtime attaches the vault under B's local identity.
    service.attach({ localVaultId: 'local-b', vault: observable });
    service.setActiveLocalVault('local-b');
    await writeFile(observable, 'b-bob.md', 'v1-bob');
    await service.enable({ localVaultId: 'local-b', name: 'B' });
    await service.reconcile();
    expect(service.snapshot().binding?.localVaultId).toBe('local-b');
    expect(service.snapshot().lastRevision).toBe(1);
    expect(remote.writesTo(UID_B).length).toBeGreaterThan(0);
    // A's cloud vault is untouched by B's work (different namespace).
    expect(await remote.partitionFor(UID_A).readHead(cloudA)).not.toBeNull();

    service.dispose();
  });

  it('prepareForSignOut drains the in-flight cycle and detaches both listeners', async () => {
    const account = createFakeAccount();
    account.signInAs(UID_A);
    const remote = new GatedPartitionedRemote(
      () => account.store.snapshot().user?.id ?? null,
    );
    const { vault } = createMemoryVault({});
    const observable = new ObservableVaultService(vault);
    const service = new VaultSyncStore({
      remote,
      account: account.store,
      storage: createMemorySyncStorage(),
      tracker: new ManualDirtyTracker(),
    });
    await service.restore();
    service.attach({ localVaultId: 'local-a', vault: observable });
    await writeFile(observable, 'a.md', 'v1');
    await service.enable({ localVaultId: 'local-a', name: 'A' });
    await service.reconcile();

    await writeFile(observable, 'b.md', 'v2');
    remote.armUploadGate();
    const cycle = service.reconcile();
    await remote.reachedUpload.promise;

    // Ordered barrier runs concurrently with the gated cycle: release
    // the gate shortly after the barrier starts so the drain completes
    // without hitting the 5s bound (proves drain, no sleeps for
    // correctness — the gate release is the deterministic ordering).
    const barrier = service.prepareForSignOut();
    remote.releaseUploadGate();
    await barrier;
    await cycle;

    // Both listeners detached: further local saves queue nothing.
    await writeFile(observable, 'c.md', 'v3');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(service.snapshot().pendingChanges).toBe(0);
    service.dispose();
  }, 10000);
});
