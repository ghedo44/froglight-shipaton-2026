/**
 * Scan-cache coherency across mutation-feed gaps.
 *
 * The incremental `LocalScanCache` reuses `size + modifiedMillis → blob`
 * without re-reading. That is safe only while the mutation feed is
 * continuously observed. `disable()`, failed-disable recovery,
 * sign-out parking, and detach/reattach all remove the mutation listener
 * while the local vault stays writable, so the next reconcile must not
 * trust any pre-gap content identity.
 *
 * Each test defeats the size+mtime heuristic deterministically with a
 * fixed vault clock:
 *
 * ```text
 * note.md: "AAAA" → "BBBB" (same length, same modifiedMillis, diff bytes)
 * ```
 *
 * Without cache invalidation the first post-gap scan reuses H("AAAA")
 * and the edit is invisible for one reconcile. With the fix the first
 * post-gap reconcile re-hashes authoritatively, and the second unchanged
 * reconcile reuses the warmed cache again.
 */

import { describe, expect, it } from 'vitest';
import {
  AccountStore,
  type AccountTransport,
  type AccountUser,
} from '../account/index.js';
import type {
  VaultCapabilities,
  VaultEntry,
  VaultOperationOptions,
  VaultService,
  VaultStat,
} from '../vault/contract.js';
import { createMemoryVault } from '../vault/memory.js';
import { workspacePath, type WorkspacePath } from '../paths.js';
import { MemorySyncRemote } from './remote-memory.js';
import { VaultSyncStore, createMemorySyncStorage } from './service.js';
import type { StoredSyncState, VaultSyncStorage } from './contract.js';
import { ObservableVaultService } from './mutations.js';

const UID = 'uid-scan-cache';
const LOCAL_A = 'local-scan-a';
const LOCAL_B = 'local-scan-b';
const FIXED_MTIME = 1_700_000_000_000;

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
}

function createFakeAccount(initialUid: string | null = UID): FakeAccount {
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
  const store = new AccountStore({ transport });
  const api: FakeAccount = {
    store,
    signInAs: (uid) => announce({ id: uid, email: `${uid}@example.com` }),
    signOut: () => announce(null),
  };
  if (initialUid !== null) api.signInAs(initialUid);
  return api;
}

/**
 * Test-only vault wrapper: fixed-clock memory vault stays underneath;
 * this layer only counts authoritative `read` calls so tests can prove
 * the first post-gap scan re-hashes (`reads > 0`) and the next unchanged
 * scan reuses the cache (`reads === 0`). All other operations delegate.
 */
class CountingVault implements VaultService {
  reads = 0;
  readonly readPaths: string[] = [];

  constructor(private readonly inner: VaultService) {}

  get capabilities(): VaultCapabilities {
    return this.inner.capabilities;
  }

  stat(
    path: WorkspacePath,
    options?: VaultOperationOptions,
  ): Promise<VaultStat> {
    return this.inner.stat(path, options);
  }

  list(
    path: WorkspacePath,
    options?: VaultOperationOptions,
  ): Promise<readonly VaultEntry[]> {
    return this.inner.list(path, options);
  }

  createDirectory(
    path: WorkspacePath,
    options?: VaultOperationOptions,
  ): Promise<void> {
    return this.inner.createDirectory(path, options);
  }

  async read(
    path: WorkspacePath,
    options?: VaultOperationOptions,
  ): Promise<Uint8Array> {
    this.reads += 1;
    this.readPaths.push(path as string);
    return this.inner.read(path, options);
  }

  write(
    path: WorkspacePath,
    data: Uint8Array,
    options?: VaultOperationOptions,
  ): Promise<void> {
    return this.inner.write(path, data, options);
  }

  remove(path: WorkspacePath, options?: VaultOperationOptions): Promise<void> {
    return this.inner.remove(path, options);
  }

  move(
    from: WorkspacePath,
    to: WorkspacePath,
    options?: VaultOperationOptions,
  ): Promise<void> {
    return this.inner.move(from, to, options);
  }
}

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

async function writeText(
  vault: VaultService,
  path: string,
  text: string,
): Promise<void> {
  await vault.write(workspacePath(path), encode(text));
}

async function readText(vault: VaultService, path: string): Promise<string> {
  return decode(await vault.read(workspacePath(path)));
}

describe('scan cache invalidation across mutation-feed gaps', () => {
  it('successful disable → same-size/same-mtime edit → re-enable discovers on the first reconcile', async () => {
    const account = createFakeAccount();
    const remote = new MemorySyncRemote();
    const { vault: inner } = createMemoryVault({
      now: () => FIXED_MTIME,
    });
    const counting = new CountingVault(inner);
    const observable = new ObservableVaultService(counting);
    const service = new VaultSyncStore({
      remote,
      account: account.store,
      storage: createMemorySyncStorage(),
      tracker: null,
      debounceMs: 3_600_000,
    });
    await service.restore();
    service.attach({ localVaultId: LOCAL_A, vault: observable });

    await writeText(observable, 'note.md', 'AAAA');
    await service.enable({ localVaultId: LOCAL_A, name: 'A' });
    await service.reconcile();
    expect(service.snapshot().lastRevision).toBe(1);
    const cloudId = service.snapshot().binding?.cloudVaultId as string;

    // Warm the incremental cache: an unchanged reconcile must not re-read.
    counting.reads = 0;
    await service.reconcile();
    expect(service.snapshot().lastRevision).toBe(1);
    expect(counting.reads).toBe(0);

    await service.disable();
    expect(service.snapshot().enabled).toBe(false);

    // While disabled the vault stays writable but unobserved.
    await writeText(observable, 'note.md', 'BBBB');
    const stat = await counting.stat(workspacePath('note.md'));
    expect(stat.kind).toBe('file');
    if (stat.kind === 'file') {
      expect(stat.size).toBe(4);
      expect(stat.modifiedMillis).toBe(FIXED_MTIME);
    }
    // No mutation hint was recorded while parked.
    expect(service.snapshot().pendingChanges).toBe(0);

    await service.enable({ localVaultId: LOCAL_A, name: 'A' });

    // First post-gap reconcile must be authoritative.
    counting.reads = 0;
    counting.readPaths.length = 0;
    await service.reconcile();
    expect(counting.reads).toBeGreaterThan(0);
    expect(counting.readPaths).toContain('note.md');
    expect(service.snapshot().lastRevision).toBe(2);
    expect(await readText(observable, 'note.md')).toBe('BBBB');

    // Another replica downloads the discovered bytes.
    const account2 = createFakeAccount();
    const { vault: vault2 } = createMemoryVault({});
    const obs2 = new ObservableVaultService(vault2);
    const service2 = new VaultSyncStore({
      remote,
      account: account2.store,
      storage: createMemorySyncStorage(),
      tracker: null,
      debounceMs: 3_600_000,
    });
    await service2.restore();
    service2.attach({ localVaultId: LOCAL_B, vault: obs2 });
    await service2.attachRemoteVault(cloudId, LOCAL_B);
    await service2.reconcile();
    expect(await readText(vault2, 'note.md')).toBe('BBBB');
    service2.dispose();

    // Incremental behavior resumes after the authoritative pass.
    counting.reads = 0;
    await service.reconcile();
    expect(service.snapshot().lastRevision).toBe(2);
    expect(counting.reads).toBe(0);

    service.dispose();
  });

  it('failed disable gap → recovery reconcile discovers the unobserved edit immediately', async () => {
    const account = createFakeAccount();
    const remote = new MemorySyncRemote();
    const backing = createMemorySyncStorage();
    const failure = new Error('disable persist boom');
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
          state.accounts[UID]?.bindings[LOCAL_A]?.enabled === false
        ) {
          gatedOnce = true;
          reached.resolve();
          await release.promise;
          throw failure;
        }
        return backing.save(state);
      },
      async clear() {
        return backing.clear();
      },
    };
    const { vault: inner } = createMemoryVault({
      now: () => FIXED_MTIME,
    });
    const counting = new CountingVault(inner);
    const observable = new ObservableVaultService(counting);
    const service = new VaultSyncStore({
      remote,
      account: account.store,
      storage,
      tracker: null,
      debounceMs: 3_600_000,
    });
    await service.restore();
    service.attach({ localVaultId: LOCAL_A, vault: observable });

    await writeText(observable, 'note.md', 'AAAA');
    await service.enable({ localVaultId: LOCAL_A, name: 'A' });
    await service.reconcile();
    expect(service.snapshot().lastRevision).toBe(1);
    counting.reads = 0;
    await service.reconcile();
    expect(counting.reads).toBe(0);

    // Disable starts and parks the replica before persistence resolves.
    const disabling = service.disable();
    await reached.promise;
    // Listener coverage is already gone while the save is paused.
    expect(service.snapshot().pendingChanges).toBe(0);

    // Unobserved edit with identical size/mtime.
    await writeText(observable, 'note.md', 'BBBB');
    const stat = await counting.stat(workspacePath('note.md'));
    if (stat.kind === 'file') {
      expect(stat.size).toBe(4);
      expect(stat.modifiedMillis).toBe(FIXED_MTIME);
    }

    release.resolve();
    await expect(disabling).rejects.toBe(failure);
    await flush();
    // Lifecycle recovered (still enabled and live) with no hint recorded.
    expect(service.snapshot().enabled).toBe(true);
    expect(service.snapshot().binding?.localVaultId).toBe(LOCAL_A);
    expect(service.snapshot().pendingChanges).toBe(0);

    // Recovery reconcile must be authoritative despite zero hints.
    counting.reads = 0;
    counting.readPaths.length = 0;
    await service.reconcile();
    expect(counting.reads).toBeGreaterThan(0);
    expect(counting.readPaths).toContain('note.md');
    expect(service.snapshot().lastRevision).toBe(2);
    expect(await readText(observable, 'note.md')).toBe('BBBB');

    // And incremental caching resumes afterwards.
    counting.reads = 0;
    await service.reconcile();
    expect(service.snapshot().lastRevision).toBe(2);
    expect(counting.reads).toBe(0);

    service.dispose();
  });

  it('sign-out parking → same-size/same-mtime edit → sign-in resumes authoritatively', async () => {
    const account = createFakeAccount();
    const remote = new MemorySyncRemote();
    const { vault: inner } = createMemoryVault({
      now: () => FIXED_MTIME,
    });
    const counting = new CountingVault(inner);
    const observable = new ObservableVaultService(counting);
    const service = new VaultSyncStore({
      remote,
      account: account.store,
      storage: createMemorySyncStorage(),
      tracker: null,
      debounceMs: 3_600_000,
    });
    await service.restore();
    service.attach({ localVaultId: LOCAL_A, vault: observable });

    await writeText(observable, 'note.md', 'AAAA');
    await service.enable({ localVaultId: LOCAL_A, name: 'A' });
    await service.reconcile();
    expect(service.snapshot().lastRevision).toBe(1);
    counting.reads = 0;
    await service.reconcile();
    expect(counting.reads).toBe(0);

    // Sign out parks cloud listening but leaves the vault writable.
    account.signOut();
    await flush();

    await writeText(observable, 'note.md', 'BBBB');
    const stat = await counting.stat(workspacePath('note.md'));
    if (stat.kind === 'file') {
      expect(stat.size).toBe(4);
      expect(stat.modifiedMillis).toBe(FIXED_MTIME);
    }
    expect(service.snapshot().pendingChanges).toBe(0);

    // Same account signs back in; the same physical replica resumes.
    account.signInAs(UID);
    await flush();

    counting.reads = 0;
    counting.readPaths.length = 0;
    await service.reconcile();
    expect(counting.reads).toBeGreaterThan(0);
    expect(counting.readPaths).toContain('note.md');
    expect(service.snapshot().lastRevision).toBe(2);
    expect(await readText(observable, 'note.md')).toBe('BBBB');

    counting.reads = 0;
    await service.reconcile();
    expect(service.snapshot().lastRevision).toBe(2);
    expect(counting.reads).toBe(0);

    service.dispose();
  });

  it('detach → same-size/same-mtime edit → reattach resumes authoritatively', async () => {
    const account = createFakeAccount();
    const remote = new MemorySyncRemote();
    const { vault: inner } = createMemoryVault({
      now: () => FIXED_MTIME,
    });
    const counting = new CountingVault(inner);
    const observable = new ObservableVaultService(counting);
    const service = new VaultSyncStore({
      remote,
      account: account.store,
      storage: createMemorySyncStorage(),
      tracker: null,
      debounceMs: 3_600_000,
    });
    await service.restore();
    service.attach({ localVaultId: LOCAL_A, vault: observable });

    await writeText(observable, 'note.md', 'AAAA');
    await service.enable({ localVaultId: LOCAL_A, name: 'A' });
    await service.reconcile();
    expect(service.snapshot().lastRevision).toBe(1);
    counting.reads = 0;
    await service.reconcile();
    expect(counting.reads).toBe(0);

    service.detach();
    await flush();

    await writeText(observable, 'note.md', 'BBBB');
    const stat = await counting.stat(workspacePath('note.md'));
    if (stat.kind === 'file') {
      expect(stat.size).toBe(4);
      expect(stat.modifiedMillis).toBe(FIXED_MTIME);
    }

    service.attach({ localVaultId: LOCAL_A, vault: observable });
    await flush();

    counting.reads = 0;
    counting.readPaths.length = 0;
    await service.reconcile();
    expect(counting.reads).toBeGreaterThan(0);
    expect(counting.readPaths).toContain('note.md');
    expect(service.snapshot().lastRevision).toBe(2);
    expect(await readText(observable, 'note.md')).toBe('BBBB');

    counting.reads = 0;
    await service.reconcile();
    expect(service.snapshot().lastRevision).toBe(2);
    expect(counting.reads).toBe(0);

    service.dispose();
  });
});
