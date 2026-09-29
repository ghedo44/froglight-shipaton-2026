import { writeVaultProfile } from '../vault/profile.js';
import { parseStoredSyncState } from './persisted-state.js';
/**
 * Vault sync service conformance.
 *
 * Full-stack over real collaborators (memory vaults, memory remote
 * partitioned per account like Firebase, real account store, real
 * scheduler and engine): binding lifecycle, two-device convergence,
 * offline behavior, restart recovery, dirty-session deferral, local
 * saves never waiting on the cloud, sign-out/in transitions, and the
 * runtime binding invariant. No network, no emulator.
 */

import { describe, expect, it, vi } from 'vitest';
import { Runtime, definePlugin } from '@froglight/runtime';
import { vaultSyncToken, vaultToken } from '../tokens.js';
import {
  AccountStore,
  type AccountTransport,
  type AccountUser,
} from '../account/index.js';
import { createAccountHost } from '../account/plugin.js';
import { createMemoryVault, createMemoryVaultState } from '../vault/memory.js';
import type { MemoryVaultState } from '../vault/memory.js';
import type { VaultService } from '../vault/contract.js';
import { ensureDirectory } from '../vault/helpers.js';
import { workspacePath } from '../paths.js';
import {
  MemorySyncRemote,
  VaultSyncError,
  type BlobRef,
  type ExpectedHead,
  type ManifestHash,
  type RemoteHead,
  type RemoteHeadInput,
  type RemoteVaultInfo,
  type SyncManifest,
  type SyncRemote,
  type VaultSyncStorage,
} from '../index.js';
import {
  ManualDirtyTracker,
  VaultSyncStore,
  createMemorySyncStorage,
  generateCloudVaultId,
  generateDeviceId,
} from './service.js';
import { ObservableVaultService, withObservableVault } from './mutations.js';
import { createVaultSyncHost } from './plugin.js';
import { memoryVaultPlugin } from '../plugins/memory-vault.js';

const UID_A = 'uid-alice-123';
const UID_B = 'uid-bob-456';
const LOCAL_A = 'local-vault-a';
const LOCAL_B = 'local-vault-b';

function flush(times = 10): Promise<void> {
  let chain = Promise.resolve();
  for (let i = 0; i < times; i += 1) {
    chain = chain.then(() => undefined);
  }
  return chain;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface FakeAccount {
  store: AccountStore;
  transport: AccountTransport;
  signInAs(uid: string, email?: string): void;
  signOut(): void;
}

/** Account store over a scriptable transport (no network). */
function createFakeAccount(): FakeAccount {
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
    transport,
    signInAs: (uid, email = `${uid}@example.com`) => {
      announce({ id: uid, email });
    },
    signOut: () => announce(null),
  };
}

/**
 * Memory remote partitioned per account UID, mirroring Firebase
 * path isolation (`users/{uid}/…`). Unsigned callers fail like the
 * Firebase provider's uid gate.
 */
class PartitionedRemote implements SyncRemote {
  readonly calls: string[] = [];
  private readonly partitions = new Map<string, MemorySyncRemote>();

  constructor(private readonly getUid: () => string | null) {}

  partitionFor(uid: string): MemorySyncRemote {
    let partition = this.partitions.get(uid);
    if (partition === undefined) {
      partition = new MemorySyncRemote();
      this.partitions.set(uid, partition);
    }
    return partition;
  }

  private active(): MemorySyncRemote {
    const uid = this.getUid();
    if (uid === null) {
      throw new VaultSyncError('NOT_AUTHENTICATED', 'sign in before syncing');
    }
    this.calls.push('active');
    return this.partitionFor(uid);
  }

  async listVaults(): Promise<readonly RemoteVaultInfo[]> {
    this.calls.push('listVaults');
    return this.active().listVaults();
  }

  async readHead(vaultId: string) {
    this.calls.push(`readHead:${vaultId}`);
    return this.active().readHead(vaultId);
  }

  async loadManifest(
    vaultId: string,
    manifestHash: ManifestHash,
    object: string,
  ) {
    this.calls.push(`loadManifest:${vaultId}`);
    return this.active().loadManifest(vaultId, manifestHash, object);
  }

  async hasBlob(vaultId: string, blob: BlobRef) {
    this.calls.push(`hasBlob:${vaultId}`);
    return this.active().hasBlob(vaultId, blob);
  }

  async uploadBlob(vaultId: string, blob: BlobRef, bytes: Uint8Array) {
    this.calls.push(`uploadBlob:${vaultId}`);
    return this.active().uploadBlob(vaultId, blob, bytes);
  }

  async downloadBlob(vaultId: string, blob: BlobRef) {
    this.calls.push(`downloadBlob:${vaultId}`);
    return this.active().downloadBlob(vaultId, blob);
  }

  async uploadManifest(vaultId: string, manifest: SyncManifest) {
    this.calls.push(`uploadManifest:${vaultId}`);
    return this.active().uploadManifest(vaultId, manifest);
  }

  async compareAndSwapHead(
    vaultId: string,
    expected: ExpectedHead | null,
    next: RemoteHeadInput,
  ) {
    this.calls.push(`compareAndSwapHead:${vaultId}`);
    return this.active().compareAndSwapHead(vaultId, expected, next);
  }

  watchHead(
    vaultId: string,
    onHead: (head: RemoteHead | null) => void,
    onError?: (error: unknown) => void,
  ): () => void {
    this.calls.push(`watchHead:${vaultId}`);
    return this.active().watchHead(vaultId, onHead, onError);
  }
}

interface Harness {
  service: VaultSyncStore;
  account: FakeAccount;
  vault: VaultService;
  observable: ObservableVaultService;
  remote: PartitionedRemote;
  storage: VaultSyncStorage;
  tracker: ManualDirtyTracker;
}

function createHarness(
  options: {
    uid?: string | null;
    remote?: PartitionedRemote;
    storage?: VaultSyncStorage;
    state?: MemoryVaultState;
    tracker?: ManualDirtyTracker;
  } = {},
): Harness {
  const account = createFakeAccount();
  if (options.uid !== null && options.uid !== undefined) {
    account.signInAs(options.uid);
  } else if (options.uid === undefined) {
    account.signInAs(UID_A);
  }
  const { vault } = createMemoryVault(
    options.state === undefined ? {} : { state: options.state },
  );
  const observable = new ObservableVaultService(vault);
  const remote =
    options.remote ??
    new PartitionedRemote(() => account.store.snapshot().user?.id ?? null);
  const storage = options.storage ?? createMemorySyncStorage();
  const tracker = options.tracker ?? new ManualDirtyTracker();
  const service = new VaultSyncStore({
    remote,
    account: account.store,
    storage,
    tracker,
  });
  return { service, account, vault, observable, remote, storage, tracker };
}

/** Production boot order: restore, then attach the vault fiber. */
async function boot(
  harness: Harness,
  localVaultId: string = LOCAL_A,
): Promise<void> {
  await harness.service.restore();
  harness.service.attach({ localVaultId, vault: harness.observable });
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
      else
        out[path] = new TextDecoder().decode(
          await vault.read(workspacePath(path)),
        );
    }
  };
  await walk('');
  return out;
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

describe('sync identities and persisted state validation', () => {
  it('generates distinct opaque identities', () => {
    expect(generateDeviceId()).toMatch(/^device-/);
    expect(generateDeviceId()).not.toBe(generateDeviceId());
    expect(generateCloudVaultId().length).toBeGreaterThan(0);
    expect(generateCloudVaultId()).not.toBe(generateCloudVaultId());
  });

  it('validates persisted state strictly', () => {
    expect(parseStoredSyncState(null)).toBeNull();
    expect(parseStoredSyncState({})).toBeNull();
    expect(parseStoredSyncState({ version: 0 })).toBeNull();
    expect(parseStoredSyncState({ version: 2 })).toBeNull();
    expect(parseStoredSyncState({ version: 3 })).toBeNull();
    expect(
      parseStoredSyncState({ version: 1, deviceId: '', accounts: {} }),
    ).toBeNull();
    expect(
      parseStoredSyncState({ version: 1, deviceId: 'd', accounts: [] }),
    ).toBeNull();
    const binding = {
      cloudVaultId: 'cloud-1',
      localVaultId: 'local-1',
      name: 'N',
      deviceId: 'device-1',
      base: null,
      lastSyncedAt: null,
      lastRevision: null,
      enabled: true,
    };
    const valid = {
      version: 1 as const,
      deviceId: 'device-1',
      accounts: {
        'uid-a': {
          bindings: { 'local-1': binding },
          activeLocalVaultId: 'local-1',
        },
      },
    };
    expect(parseStoredSyncState(valid)).toEqual(valid);
    // Empty accounts (signed out, fresh device) are valid.
    expect(
      parseStoredSyncState({ version: 1, deviceId: 'd', accounts: {} }),
    ).toEqual({ version: 1, deviceId: 'd', accounts: {} });
    // Bindings keyed under the wrong local vault id invalidate the envelope.
    expect(
      parseStoredSyncState({
        version: 1,
        deviceId: 'device-1',
        accounts: {
          'uid-a': {
            bindings: { 'local-other': binding },
            activeLocalVaultId: null,
          },
        },
      }),
    ).toBeNull();
    // A binding missing its enabled flag is malformed.
    const { enabled: _dropped, ...withoutEnabled } = binding;
    void _dropped;
    expect(
      parseStoredSyncState({
        version: 1,
        deviceId: 'device-1',
        accounts: {
          'uid-a': {
            bindings: { 'local-1': withoutEnabled },
            activeLocalVaultId: null,
          },
        },
      }),
    ).toBeNull();
    // A corrupt base must NOT invalidate the binding (dropping it would
    // treat a bound replica as brand new): it is preserved with the
    // explicit baseCorrupt marker so reconciliation parks instead.
    const corruptBase = parseStoredSyncState({
      version: 1,
      deviceId: 'device-1',
      accounts: {
        'uid-a': {
          bindings: {
            'local-1': {
              ...binding,
              base: { manifest: { format: 'x' }, hash: '' },
            },
          },
          activeLocalVaultId: null,
        },
      },
    });
    expect(corruptBase).not.toBeNull();
    expect(corruptBase?.accounts['uid-a']?.bindings['local-1']).toMatchObject({
      cloudVaultId: 'cloud-1',
      localVaultId: 'local-1',
      base: null,
      baseCorrupt: true,
    });
  });
});

describe('vault sync service lifecycle', () => {
  it('starts detached, disabled, and empty', async () => {
    const harness = createHarness();
    expect(harness.service.snapshot()).toMatchObject({
      enabled: false,
      phase: 'idle',
      binding: null,
      pendingChanges: 0,
      lastSyncedAt: null,
      lastRevision: null,
      error: null,
    });
    expect(harness.service.snapshot().deferredPaths).toEqual([]);
    await boot(harness);
    expect(harness.service.snapshot().binding).toBeNull();
    harness.service.dispose();
  });

  it('persists a fresh device id on first restore', async () => {
    const storage = createMemorySyncStorage();
    const first = createHarness({ storage });
    await boot(first);
    const stored = await storage.load();
    expect(stored?.deviceId).toMatch(/^device-/);
    expect(stored?.accounts).toEqual({});
    first.service.dispose();

    const second = createHarness({ storage });
    await boot(second);
    expect((await storage.load())?.deviceId).toBe(stored?.deviceId);
    second.service.dispose();
  });

  it('recovers a fresh start from corrupt storage without bricking', async () => {
    const storage = createMemorySyncStorage();
    await storage.save({
      version: 99,
      deviceId: '',
      enabled: true,
      binding: { nope: true },
    } as unknown as Parameters<VaultSyncStorage['save']>[0]);
    const harness = createHarness({ storage });
    await boot(harness);
    expect(harness.service.snapshot()).toMatchObject({
      enabled: false,
      binding: null,
      error: null,
    });
    // And the service still works afterwards.
    await harness.service.enable({ localVaultId: LOCAL_A, name: 'A' });
    expect(harness.service.snapshot().binding?.localVaultId).toBe(LOCAL_A);
    harness.service.dispose();
  });

  it('enable without a prior restore still establishes state', async () => {
    const harness = createHarness();
    harness.service.attach({
      localVaultId: LOCAL_A,
      vault: harness.observable,
    });
    await writeFile(harness.observable, 'a.md', 'v1');
    await harness.service.enable({ localVaultId: LOCAL_A, name: 'A' });
    await harness.service.reconcile();
    expect(harness.service.snapshot()).toMatchObject({
      enabled: true,
      lastRevision: 1,
    });
    // A later restore must not clobber the live state.
    await harness.service.restore();
    expect(harness.service.snapshot()).toMatchObject({
      enabled: true,
      lastRevision: 1,
    });
    harness.service.dispose();
  });

  it('restore is idempotent', async () => {
    const harness = createHarness();
    await boot(harness);
    await harness.service.restore();
    await harness.service.restore();
    await writeFile(harness.observable, 'a.md', 'v1');
    await harness.service.enable({ localVaultId: LOCAL_A, name: 'A' });
    await harness.service.reconcile();
    expect(harness.service.snapshot().lastRevision).toBe(1);
    harness.service.dispose();
  });
});

describe('vault sync enable / disable', () => {
  it('refuses to enable while signed out without persisting', async () => {
    const harness = createHarness({ uid: null });
    await boot(harness);
    await expect(
      harness.service.enable({ localVaultId: LOCAL_A, name: 'A' }),
    ).rejects.toMatchObject({ code: 'NOT_AUTHENTICATED' });
    expect(await harness.storage.load()).toMatchObject({
      version: 1,
      accounts: {},
    });
    expect(harness.service.snapshot().binding).toBeNull();
    harness.service.dispose();
  });

  it('rejects empty identifiers as host errors', async () => {
    const harness = createHarness();
    await boot(harness);
    await expect(
      harness.service.enable({ localVaultId: '', name: 'A' }),
    ).rejects.toMatchObject({ code: 'UNKNOWN' });
    await expect(
      harness.service.attachRemoteVault('', LOCAL_A),
    ).rejects.toMatchObject({ code: 'UNKNOWN' });
    harness.service.dispose();
  });

  it('excludes OS junk and temporaries by default', async () => {
    const harness = createHarness();
    await boot(harness);
    await writeFile(harness.observable, 'Notes/real.md', 'hello');
    await writeFile(harness.observable, 'Notes/.DS_Store', 'junk');
    await writeFile(harness.observable, 'Notes/draft.tmp', 'junk');
    await harness.service.enable({ localVaultId: LOCAL_A, name: 'A' });
    await harness.service.reconcile();
    const cloudVaultId = harness.service.snapshot().binding!.cloudVaultId;
    const partition = harness.remote.partitionFor(UID_A);
    const head = await partition.readHead(cloudVaultId);
    expect(head).not.toBeNull();
    const manifest = await partition.loadManifest(
      cloudVaultId,
      head!.manifestHash,
      head!.manifestObject,
    );
    const paths = manifest.entries.map((entry) => entry.path);
    expect(paths).toContain('Notes/real.md');
    expect(paths).not.toContain('Notes/.DS_Store');
    expect(paths).not.toContain('Notes/draft.tmp');
    harness.service.dispose();
  });

  it('enables with a fresh UUID binding and syncs in the background', async () => {
    const harness = createHarness();
    await boot(harness);
    await writeFile(harness.observable, 'Notes/a.md', 'hello');
    await harness.service.enable({ localVaultId: LOCAL_A, name: 'University' });
    const binding = harness.service.snapshot().binding;
    expect(binding).toMatchObject({
      localVaultId: LOCAL_A,
      name: 'University',
    });
    expect(binding?.cloudVaultId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$|^[a-z]+-/,
    );
    await vi.waitFor(() => {
      expect(harness.service.snapshot().lastRevision).toBe(1);
    });
    expect(harness.service.snapshot()).toMatchObject({
      enabled: true,
      phase: 'idle',
      pendingChanges: 0,
      error: null,
    });
    expect(harness.service.snapshot().lastSyncedAt).not.toBeNull();
    harness.service.dispose();
  });

  it('resumes the same binding for the same vault, replaces for another', async () => {
    const harness = createHarness();
    await boot(harness);
    await writeFile(harness.observable, 'a.md', 'v1');
    await harness.service.enable({ localVaultId: LOCAL_A, name: 'A' });
    await harness.service.reconcile();
    const first = harness.service.snapshot().binding?.cloudVaultId;
    await harness.service.disable();
    await harness.service.enable({ localVaultId: LOCAL_A, name: 'A renamed' });
    expect(harness.service.snapshot().binding?.cloudVaultId).toBe(first);
    expect(harness.service.snapshot().binding?.name).toBe('A renamed');

    // Opening a different local vault switches the attached replica; the
    // new binding is fresh while A's binding is remembered.
    const { vault: vaultB } = createMemoryVault({});
    const observableB = new ObservableVaultService(vaultB);
    harness.service.attach({ localVaultId: LOCAL_B, vault: observableB });
    await harness.service.enable({ localVaultId: LOCAL_B, name: 'B' });
    const second = harness.service.snapshot().binding?.cloudVaultId;
    expect(second).not.toBe(first);
    // The previous cloud vault is left intact, never deleted.
    expect(await harness.remote.readHead(first as string)).not.toBeNull();
    harness.service.dispose();
  });

  it('disable parks triggers but keeps binding and base', async () => {
    const harness = createHarness();
    await boot(harness);
    await writeFile(harness.observable, 'a.md', 'v1');
    await harness.service.enable({ localVaultId: LOCAL_A, name: 'A' });
    await harness.service.reconcile();
    // Drain any enable-time background run through the exclusive chain so
    // the baseline below cannot race a pull that legitimately started
    // while still enabled (its readHead would otherwise land after the
    // baseline and look like post-disable traffic).
    await harness.service.reconcile();
    const callsBefore = harness.remote.calls.length;
    const bindingBefore = harness.service.snapshot().binding;
    await harness.service.disable();
    expect(harness.service.snapshot()).toMatchObject({
      enabled: false,
      phase: 'idle',
      error: null,
      pendingChanges: 0,
    });
    expect(harness.service.snapshot().binding).toEqual({
      ...bindingBefore,
      enabled: false,
    });
    expect(harness.service.snapshot().bindings).toContainEqual({
      ...bindingBefore,
      enabled: false,
    });

    await writeFile(harness.observable, 'b.md', 'v2');
    await flush();
    expect(harness.remote.calls.length).toBe(callsBefore);
    // Re-enabling resumes incrementally: one commit carries the delta.
    await harness.service.enable({ localVaultId: LOCAL_A, name: 'A' });
    await harness.service.reconcile();
    expect(harness.service.snapshot().lastRevision).toBe(2);
    harness.service.dispose();
  });

  it('manual reconcile while disabled fails fast', async () => {
    const harness = createHarness();
    await boot(harness);
    await expect(harness.service.reconcile()).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });
    harness.service.dispose();
  });

  it('manual reconcile while signed out fails fast', async () => {
    const harness = createHarness();
    await boot(harness);
    await harness.service.enable({ localVaultId: LOCAL_A, name: 'A' });
    harness.account.signOut();
    await expect(harness.service.reconcile()).rejects.toMatchObject({
      code: 'NOT_AUTHENTICATED',
    });
    harness.service.dispose();
  });
});

describe('two-device sync through services', () => {
  it('converges A → B → A with conflicts preserved', async () => {
    // One shared remote; both devices signed in as the same account.
    const remote = new PartitionedRemote(() => UID_A);
    const deviceA = createHarness({ remote });
    const deviceB = createHarness({ remote });
    await boot(deviceA);
    await boot(deviceB, LOCAL_B);
    const {
      service: serviceA,
      observable: observableA,
      vault: vaultA,
    } = deviceA;
    const {
      service: serviceB,
      observable: observableB,
      vault: vaultB,
    } = deviceB;

    await writeFile(observableA, 'Notes/a.md', 'hello');
    await serviceA.enable({ localVaultId: LOCAL_A, name: 'University' });
    await serviceA.reconcile();
    expect(serviceA.snapshot().lastRevision).toBe(1);
    const cloudId = serviceA.snapshot().binding?.cloudVaultId as string;

    await serviceB.attachRemoteVault(cloudId, LOCAL_B);
    await serviceB.reconcile();
    expect(await dumpVault(vaultB)).toEqual({ 'Notes/a.md': 'hello' });

    await writeFile(observableB, 'Notes/a.md', 'hello edited');
    await serviceB.reconcile();
    await serviceA.reconcile();
    expect(await dumpVault(vaultA)).toEqual({ 'Notes/a.md': 'hello edited' });

    // Concurrent edits preserve both versions.
    await writeFile(observableA, 'Notes/a.md', 'A-side');
    await writeFile(observableB, 'Notes/a.md', 'B-side');
    await serviceA.reconcile();
    await serviceB.reconcile();
    const afterB = await dumpVault(vaultB);
    expect(afterB['Notes/a.md']).toBe('B-side');
    const copies = Object.keys(afterB).filter((path) => path !== 'Notes/a.md');
    expect(copies).toHaveLength(1);
    expect(afterB[copies[0] as string]).toBe('A-side');
    await serviceA.reconcile();
    expect(await dumpVault(vaultA)).toEqual(afterB);

    serviceA.dispose();
    serviceB.dispose();
  });

  it('pulls remote changes through the HEAD watcher without local edits', async () => {
    const remote = new PartitionedRemote(() => UID_A);
    const deviceA = createHarness({ remote });
    const deviceB = createHarness({ remote });
    await boot(deviceA);
    await boot(deviceB, LOCAL_B);

    await writeFile(deviceA.observable, 'a.md', 'v1');
    await deviceA.service.enable({ localVaultId: LOCAL_A, name: 'A' });
    // Explicit reconcile: the enable-time background run is not awaitable.
    await deviceA.service.reconcile();
    expect(deviceA.service.snapshot().lastRevision).toBe(1);
    const cloudId = deviceA.service.snapshot().binding?.cloudVaultId as string;
    await deviceB.service.attachRemoteVault(cloudId, LOCAL_B);
    await deviceB.service.reconcile();
    expect(await dumpVault(deviceB.vault)).toEqual({ 'a.md': 'v1' });

    // No local edits on B afterwards: the watcher alone must deliver v2.
    await writeFile(deviceA.observable, 'a.md', 'v2');
    await deviceA.service.reconcile();
    expect(deviceA.service.snapshot().lastRevision).toBe(2);
    // Await the cycle, not just the bytes: the vault fills mid-cycle
    // (downloading) while the base lands at the end.
    await vi.waitFor(() => {
      expect(deviceB.service.snapshot().lastRevision).toBe(2);
    });
    expect(deviceB.service.snapshot()).toMatchObject({ phase: 'idle' });
    expect(await dumpVault(deviceB.vault)).toEqual({ 'a.md': 'v2' });

    deviceA.service.dispose();
    deviceB.service.dispose();
  });
});

describe('offline behavior and restart recovery', () => {
  /** Remote whose control plane is down; local vault I/O is unaffected. */
  class OfflineRemote extends PartitionedRemote {
    override async listVaults(): Promise<never> {
      this.calls.push('listVaults');
      throw new VaultSyncError('NETWORK', 'offline');
    }

    override async readHead(): Promise<never> {
      this.calls.push('readHead');
      throw new VaultSyncError('NETWORK', 'offline');
    }
  }

  it('enables while offline and records failures without blocking local use', async () => {
    const harness = createHarness({
      remote: new OfflineRemote(() => UID_A),
    });
    await boot(harness);
    // Enabling is local-only: it resolves despite the dead network.
    await harness.service.enable({ localVaultId: LOCAL_A, name: 'A' });
    await vi.waitFor(() => {
      expect(harness.service.snapshot().error?.code).toBe('NETWORK');
    });
    expect(harness.service.snapshot()).toMatchObject({
      enabled: true,
      phase: 'error',
    });
    expect(harness.service.snapshot().binding?.localVaultId).toBe(LOCAL_A);

    // The vault stays fully usable throughout.
    await writeFile(harness.observable, 'local.md', 'offline work');
    expect(await dumpVault(harness.vault)).toEqual({
      'local.md': 'offline work',
    });
    harness.service.dispose();
  });

  it('reconstructs pending work after restart and converges on retry', async () => {
    const state = createMemoryVaultState();
    const storage = createMemorySyncStorage();
    const remote = new PartitionedRemote(() => UID_A);

    const first = createHarness({ remote, storage, state });
    await boot(first);
    await writeFile(first.observable, 'a.md', 'v1');
    await first.service.enable({ localVaultId: LOCAL_A, name: 'A' });
    await first.service.reconcile();
    expect(first.service.snapshot().lastRevision).toBe(1);

    // Offline edit, then "restart": drop the service (and vault handle)
    // while the shared state, storage, and remote survive.
    await writeFile(first.observable, 'a.md', 'v2-offline');
    first.service.dispose();

    const second = createHarness({ remote, storage, state });
    await boot(second);
    // Binding, base, and enabled state all survived the restart.
    expect(second.service.snapshot()).toMatchObject({
      enabled: true,
      lastRevision: 1,
    });
    expect(second.service.snapshot().binding?.localVaultId).toBe(LOCAL_A);
    // The pending edit reconciles without re-entering anything.
    await second.service.reconcile();
    expect(second.service.snapshot()).toMatchObject({
      lastRevision: 2,
      pendingChanges: 0,
      error: null,
    });
    expect(await dumpVault(second.vault)).toEqual({ 'a.md': 'v2-offline' });
    // Same device identity across the restart (HEAD metadata proof).
    const binding = second.service.snapshot().binding as {
      cloudVaultId: string;
    };
    const head = await remote.readHead(binding.cloudVaultId);
    expect(head?.updatedByDeviceId).toBe((await storage.load())?.deviceId);
    second.service.dispose();
  });

  it('keeps device identity stable across restarts', async () => {
    const storage = createMemorySyncStorage();
    const first = createHarness({ storage });
    await boot(first);
    await first.service.enable({ localVaultId: LOCAL_A, name: 'A' });
    const before = (await storage.load())?.deviceId;
    expect(before).toMatch(/^device-/);
    first.service.dispose();

    const second = createHarness({ storage });
    await boot(second);
    expect((await storage.load())?.deviceId).toBe(before);
    second.service.dispose();
  });

  it('tracks pending changes until a successful reconcile', async () => {
    const harness = createHarness();
    await boot(harness);
    await harness.service.enable({ localVaultId: LOCAL_A, name: 'A' });
    await harness.service.reconcile();
    expect(harness.service.snapshot().pendingChanges).toBe(0);

    await writeFile(harness.observable, 'a.md', '1');
    await writeFile(harness.observable, 'b.md', '2');
    expect(harness.service.snapshot().pendingChanges).toBe(2);
    await harness.service.reconcile();
    expect(harness.service.snapshot().pendingChanges).toBe(0);
    harness.service.dispose();
  });
});

describe('dirty-session deferral through the service', () => {
  const NOTE = workspacePath('note.md');

  async function syncedPair(): Promise<{
    remote: PartitionedRemote;
    a: Harness;
    b: Harness;
  }> {
    const remote = new PartitionedRemote(() => UID_A);
    const a = createHarness({ remote });
    const b = createHarness({ remote });
    await boot(a);
    await boot(b, LOCAL_B);
    await writeFile(a.observable, 'note.md', 'v1');
    await a.service.enable({ localVaultId: LOCAL_A, name: 'A' });
    await a.service.reconcile();
    const cloudId = a.service.snapshot().binding?.cloudVaultId as string;
    await b.service.attachRemoteVault(cloudId, LOCAL_B);
    await b.service.reconcile();
    return { remote, a, b };
  }

  it('never clobbers the dirty file and reports the deferral', async () => {
    const { b, a } = await syncedPair();
    b.tracker.markDirty(NOTE);
    await writeFile(a.observable, 'note.md', 'v2-remote');
    await a.service.reconcile();

    await b.service.reconcile();
    expect(await dumpVault(b.vault)).toEqual({ 'note.md': 'v1' });
    expect(b.service.snapshot().deferredPaths).toEqual(['note.md']);
    expect(b.service.snapshot()).toMatchObject({ phase: 'idle', error: null });
    a.service.dispose();
    b.service.dispose();
  });

  it('merges the save as a concurrent edit and clears the deferral', async () => {
    const { b, a } = await syncedPair();
    b.tracker.markDirty(NOTE);
    await writeFile(a.observable, 'note.md', 'v2-remote');
    await a.service.reconcile();
    await b.service.reconcile();

    // The session saves; the feed retriggers and both versions survive.
    b.tracker.markClean(NOTE);
    await writeFile(b.observable, 'note.md', 'v2-local');
    await b.service.reconcile();
    const files = await dumpVault(b.vault);
    expect(files['note.md']).toBe('v2-local');
    const copies = Object.keys(files).filter((path) => path !== 'note.md');
    expect(copies).toHaveLength(1);
    expect(files[copies[0] as string]).toBe('v2-remote');
    expect(b.service.snapshot().deferredPaths).toEqual([]);
    a.service.dispose();
    b.service.dispose();
  });

  it('downloads after a revert without resurrecting stale content', async () => {
    const { b, a } = await syncedPair();
    b.tracker.markDirty(NOTE);
    await writeFile(a.observable, 'note.md', 'v2-remote');
    await a.service.reconcile();
    await b.service.reconcile();
    expect(await dumpVault(b.vault)).toEqual({ 'note.md': 'v1' });

    // Close without saving: no vault mutation, no trigger needed. The
    // next reconcile (here: manual) downloads instead of uploading v1.
    b.tracker.markClean(NOTE);
    await b.service.reconcile();
    expect(await dumpVault(b.vault)).toEqual({ 'note.md': 'v2-remote' });
    // And the cloud was never polluted with the stale version.
    const cloudId = b.service.snapshot().binding?.cloudVaultId as string;
    const checker = createHarness({
      remote: b.remote,
    });
    await boot(checker, 'checker');
    await checker.service.attachRemoteVault(cloudId, 'checker');
    await checker.service.reconcile();
    expect(await dumpVault(checker.vault)).toEqual({ 'note.md': 'v2-remote' });
    a.service.dispose();
    b.service.dispose();
    checker.service.dispose();
  });

  it('defers through automatic (mutation-driven) reconciles too', async () => {
    const { b, a } = await syncedPair();
    b.tracker.markDirty(NOTE);
    await writeFile(a.observable, 'note.md', 'v2-remote');
    await a.service.reconcile();
    // A local edit elsewhere triggers an automatic reconcile; note.md
    // must still be spared while unrelated paths converge.
    await writeFile(b.observable, 'other.md', 'local');
    await vi.waitFor(() => {
      expect(b.service.snapshot().lastRevision).toBe(3);
    });
    const files = await dumpVault(b.vault);
    expect(files['note.md']).toBe('v1');
    expect(files['other.md']).toBe('local');
    expect(b.service.snapshot().deferredPaths).toEqual(['note.md']);
    a.service.dispose();
    b.service.dispose();
  });
});

describe('local saves never wait for the cloud', () => {
  it('a hanging upload does not block vault writes', async () => {
    class HangingRemote extends MemorySyncRemote {
      hangUploads = false;
      parkedUploads = 0;
      private waiters: Array<() => void> = [];

      override async uploadBlob(
        vaultId: string,
        blob: Parameters<SyncRemote['uploadBlob']>[1],
        bytes: Uint8Array,
      ): Promise<void> {
        if (this.hangUploads) {
          this.parkedUploads += 1;
          await new Promise<void>((resolve) => {
            this.waiters.push(resolve);
          });
        }
        return super.uploadBlob(vaultId, blob, bytes);
      }

      releaseUploads(): void {
        this.hangUploads = false;
        for (const resolve of this.waiters.splice(0)) resolve();
      }
    }
    const hanging = new HangingRemote();
    const remote = new PartitionedRemote(() => UID_A);
    // Preseed the account partition with the gated remote (test seam).
    (
      remote as unknown as { partitions: Map<string, MemorySyncRemote> }
    ).partitions.set(UID_A, hanging);
    const harness = createHarness({ remote });
    await boot(harness);
    await writeFile(harness.observable, 'a.md', 'v1');
    await harness.service.enable({ localVaultId: LOCAL_A, name: 'A' });
    await harness.service.reconcile();
    expect(harness.service.snapshot().lastRevision).toBe(1);

    // The next cycle hangs uploading b.md; a concurrent save of c.md
    // still settles immediately (writes never await the cloud).
    hanging.hangUploads = true;
    await writeFile(harness.observable, 'b.md', 'v2');
    const pending = harness.service.reconcile();
    await flush();
    const outcome = await Promise.race([
      writeFile(harness.observable, 'c.md', 'v3').then(() => 'wrote' as const),
      sleep(50).then(() => 'stalled' as const),
    ]);
    expect(outcome).toBe('wrote');

    // Release only once the cycle is actually parked in upload: the scan
    // needs macrotask hops (hashing) that the microtask flush cannot
    // cover, so an eagerly released gate would be missed entirely.
    await vi.waitFor(() => {
      expect(hanging.parkedUploads).toBeGreaterThan(0);
    });
    hanging.releaseUploads();
    await pending;
    // The hung run committed what its scan saw (rev2); the mid-run save
    // may have landed in that same commit or in the automatic rerun it
    // scheduled, so the revision split is not deterministic. What must
    // hold is convergence: every local byte reaches the cloud manifest.
    expect(harness.service.snapshot().lastRevision).toBeGreaterThanOrEqual(2);
    const cloudId = harness.service.snapshot().binding?.cloudVaultId as string;
    await vi.waitFor(async () => {
      const partition = harness.remote.partitionFor(UID_A);
      const head = await partition.readHead(cloudId);
      expect(head).not.toBeNull();
      const manifest = await partition.loadManifest(
        cloudId,
        head!.manifestHash,
        head!.manifestObject,
      );
      expect(manifest.entries.map((entry) => entry.path)).toEqual(
        expect.arrayContaining(['a.md', 'b.md', 'c.md']),
      );
    });
    expect(await dumpVault(harness.vault)).toMatchObject({
      'a.md': 'v1',
      'b.md': 'v2',
      'c.md': 'v3',
    });
    harness.service.dispose();
  });
});

describe('sign-out and identity transitions', () => {
  it('detaches both remote and local listeners on sign-out but unlinks nothing', async () => {
    const remote = new PartitionedRemote(() => UID_A);
    const harness = createHarness({ remote });
    await boot(harness);
    await writeFile(harness.observable, 'a.md', 'v1');
    await harness.service.enable({ localVaultId: LOCAL_A, name: 'A' });
    await harness.service.reconcile();
    const bindingBefore = harness.service.snapshot().binding;
    const cloudId = bindingBefore?.cloudVaultId as string;

    harness.account.signOut();
    // Remote advances while signed out: no pull (watcher detached)...
    const raw = remote.partitionFor(UID_A);
    const head = await raw.readHead(cloudId);
    if (head === null) throw new Error('expected a committed HEAD');
    await raw.compareAndSwapHead(
      cloudId,
      { revision: head.revision, manifestHash: head.manifestHash },
      {
        name: 'External',
        revision: head.revision + 1,
        manifestHash: head.manifestHash,
        manifestObject: 'external',
        fileCount: 0,
        totalBytes: 0,
        updatedByDeviceId: 'device-external',
      },
    );
    await flush();
    expect(await dumpVault(harness.vault)).toEqual({ 'a.md': 'v1' });
    // Local edits while signed out do NOT queue cloud work (both
    // listeners detached): pendingChanges stays zero and no remote
    // traffic is scheduled, but the binding survives for display.
    const callsBefore = remote.calls.length;
    await writeFile(harness.observable, 'b.md', 'v2');
    await flush();
    expect(harness.service.snapshot().pendingChanges).toBe(0);
    expect(harness.service.snapshot().binding).toEqual(bindingBefore);
    expect(remote.calls.length).toBe(callsBefore);
    // And the cloud vault itself is untouched by the sign-out.
    expect(await raw.readHead(cloudId)).not.toBeNull();
    harness.service.dispose();
  });

  it('never interprets UID A bindings under UID B', async () => {
    const account = createFakeAccount();
    account.signInAs(UID_A);
    const remote = new PartitionedRemote(
      () => account.store.snapshot().user?.id ?? null,
    );
    const harness = createHarness({ remote });
    // Rewire onto the shared scriptable account.
    harness.service.dispose();
    const service = new VaultSyncStore({
      remote,
      account: account.store,
      storage: harness.storage,
      tracker: harness.tracker,
    });
    service.attach({ localVaultId: LOCAL_A, vault: harness.observable });
    await service.restore();

    await writeFile(harness.observable, 'a.md', 'v1');
    await service.enable({ localVaultId: LOCAL_A, name: 'A' });
    await service.reconcile();
    const cloudId = service.snapshot().binding?.cloudVaultId as string;
    expect(service.snapshot().bindings).toHaveLength(1);

    // Same device, different account: A's binding is parked (not leaked
    // into B's namespace) and B sees no binding of its own.
    const callsBefore = remote.calls.length;
    account.signInAs(UID_B);
    await flush();
    expect(service.snapshot().binding).toBeNull();
    expect(service.snapshot().bindings).toEqual([]);
    expect(service.snapshot().enabled).toBe(false);
    // No cloud work runs for B: the parked service never touches any
    // namespace with A's cloud id after the switch.
    expect(
      remote.calls.slice(callsBefore).filter((call) => call.includes(cloudId)),
    ).toHaveLength(0);
    // A's persisted state is untouched by the switch.
    const stored = await harness.storage.load();
    expect(stored?.accounts[UID_A]?.bindings[LOCAL_A]?.cloudVaultId).toBe(
      cloudId,
    );
    expect(stored?.accounts[UID_B]).toBeUndefined();
    service.dispose();
  });

  it('restores A bindings after A → B → A', async () => {
    const account = createFakeAccount();
    account.signInAs(UID_A);
    const remote = new PartitionedRemote(
      () => account.store.snapshot().user?.id ?? null,
    );
    const storage = createMemorySyncStorage();
    const makeService = (vault: VaultService): VaultSyncStore => {
      const observable = new ObservableVaultService(vault);
      const service = new VaultSyncStore({
        remote,
        account: account.store,
        storage,
        tracker: new ManualDirtyTracker(),
      });
      service.attach({ localVaultId: LOCAL_A, vault: observable });
      return service;
    };
    const { vault: vaultA } = createMemoryVault({});
    const serviceA = makeService(vaultA);
    await serviceA.restore();
    await writeFile(vaultA, 'a.md', 'v1');
    await serviceA.enable({ localVaultId: LOCAL_A, name: 'A' });
    await serviceA.reconcile();
    const cloudA = serviceA.snapshot().binding?.cloudVaultId as string;
    expect(serviceA.snapshot().lastRevision).toBe(1);

    // Sign out parks but does not delete; B signs in and binds its own.
    account.signOut();
    await flush();
    expect(serviceA.snapshot().binding).not.toBeNull();
    account.signInAs(UID_B);
    const { vault: vaultB } = createMemoryVault({});
    serviceA.setActiveLocalVault(LOCAL_B);
    await writeFile(vaultB, 'b.md', 'v2');
    // The same service instance now serves B: enable binds B's own vault
    // without inheriting A's cloud id.
    const observableB = new ObservableVaultService(vaultB);
    serviceA.attach({ localVaultId: LOCAL_B, vault: observableB });
    await serviceA.enable({ localVaultId: LOCAL_B, name: 'B' });
    await serviceA.reconcile();
    const cloudB = serviceA.snapshot().binding?.cloudVaultId as string;
    expect(cloudB).not.toBe(cloudA);
    expect(serviceA.snapshot().binding?.localVaultId).toBe(LOCAL_B);

    // Back to A: A's binding (and base) is restored, B's is parked.
    account.signInAs(UID_A);
    serviceA.setActiveLocalVault(LOCAL_A);
    const observableA = new ObservableVaultService(vaultA);
    serviceA.attach({ localVaultId: LOCAL_A, vault: observableA });
    await flush();
    expect(serviceA.snapshot().binding?.cloudVaultId).toBe(cloudA);
    expect(serviceA.snapshot().bindings).toHaveLength(1);
    expect(serviceA.snapshot()).toMatchObject({ lastRevision: 1 });
    await serviceA.reconcile();
    expect(serviceA.snapshot().lastRevision).toBe(1);
    serviceA.dispose();
  });

  it('keeps two local vault bindings side by side and switches live work', async () => {
    const harness = createHarness();
    await boot(harness);
    await writeFile(harness.observable, 'a.md', 'v1');
    await harness.service.enable({ localVaultId: LOCAL_A, name: 'A' });
    await harness.service.reconcile();
    const cloudA = harness.service.snapshot().binding?.cloudVaultId as string;

    // Open a second physical vault: its binding is created independently.
    const { vault: vaultB } = createMemoryVault({});
    const observableB = new ObservableVaultService(vaultB);
    harness.service.attach({ localVaultId: LOCAL_B, vault: observableB });
    await harness.service.enable({ localVaultId: LOCAL_B, name: 'B' });
    expect(harness.service.snapshot().binding?.localVaultId).toBe(LOCAL_B);
    expect(harness.service.snapshot().bindings).toHaveLength(2);
    const cloudB = harness.service.snapshot().binding?.cloudVaultId as string;
    expect(cloudB).not.toBe(cloudA);
    await harness.service.reconcile();

    // Re-attach A's exact replica (host then reports the selection):
    // reconcile resumes on A's cloud vault, and B's binding stays
    // remembered.
    harness.service.attach({
      localVaultId: LOCAL_A,
      vault: harness.observable,
    });
    harness.service.setActiveLocalVault(LOCAL_A);
    expect(harness.service.snapshot().binding?.cloudVaultId).toBe(cloudA);
    await writeFile(harness.observable, 'a2.md', 'v2');
    await harness.service.reconcile();
    expect(harness.service.snapshot().lastRevision).toBe(2);
    expect(harness.service.snapshot().bindings).toHaveLength(2);

    // Detach parks cloud work without forgetting either binding.
    harness.service.detach();
    expect(harness.service.snapshot().binding).toBeNull();
    expect(harness.service.snapshot().bindings).toHaveLength(2);
    await expect(harness.service.reconcile()).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });
    harness.service.dispose();
  });

  it('refuses to bind the same cloud vault twice on one device', async () => {
    const harness = createHarness();
    await boot(harness);
    await writeFile(harness.observable, 'a.md', 'v1');
    await harness.service.enable({ localVaultId: LOCAL_A, name: 'A' });
    await harness.service.reconcile();
    const cloudId = harness.service.snapshot().binding?.cloudVaultId as string;
    expect(harness.service.isCloudVaultBound(cloudId)).toBe(true);
    expect(harness.service.isCloudVaultBound('cloud-missing')).toBe(false);
    await expect(
      harness.service.attachRemoteVault(cloudId, LOCAL_B),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    // Re-attaching the same cloud id to the SAME local vault is idempotent.
    await harness.service.attachRemoteVault(cloudId, LOCAL_A);
    expect(harness.service.snapshot().binding?.cloudVaultId).toBe(cloudId);
    harness.service.dispose();
  });
});

describe('remote discovery and attach', () => {
  it('lists cloud vaults only while signed in', async () => {
    const remote = new PartitionedRemote(() => UID_A);
    const harness = createHarness({ remote });
    await boot(harness);
    await writeFile(harness.observable, 'a.md', 'v1');
    await harness.service.enable({ localVaultId: LOCAL_A, name: 'A' });
    await harness.service.reconcile();

    const listed = await harness.service.listRemoteVaults();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ name: 'A', revision: 1 });

    harness.account.signOut();
    await expect(harness.service.listRemoteVaults()).rejects.toMatchObject({
      code: 'NOT_AUTHENTICATED',
    });
    harness.service.dispose();
  });

  it('attach verifies the cloud vault exists', async () => {
    const harness = createHarness();
    await boot(harness);
    await expect(
      harness.service.attachRemoteVault('missing-vault', LOCAL_B),
    ).rejects.toMatchObject({ code: 'REMOTE_NOT_FOUND' });
    expect(harness.service.snapshot()).toMatchObject({
      enabled: false,
      binding: null,
    });
    harness.service.dispose();
  });

  it('attach adopts the HEAD name and pulls on reconcile', async () => {
    const remote = new PartitionedRemote(() => UID_A);
    const deviceA = createHarness({ remote });
    await boot(deviceA);
    await writeFile(deviceA.observable, 'a.md', 'v1');
    await deviceA.service.enable({ localVaultId: LOCAL_A, name: 'Original' });
    await deviceA.service.reconcile();
    const cloudId = deviceA.service.snapshot().binding?.cloudVaultId as string;

    const deviceB = createHarness({ remote });
    await boot(deviceB, LOCAL_B);
    await deviceB.service.attachRemoteVault(cloudId, LOCAL_B);
    expect(deviceB.service.snapshot().binding).toMatchObject({
      cloudVaultId: cloudId,
      localVaultId: LOCAL_B,
      name: 'Original',
    });
    await deviceB.service.reconcile();
    expect(await dumpVault(deviceB.vault)).toEqual({ 'a.md': 'v1' });
    deviceA.service.dispose();
    deviceB.service.dispose();
  });
});

describe('vault sync runtime binding', () => {
  it('provides one binding, withdraws on dispose, restores on reactivate', async () => {
    const runtime = new Runtime();
    const account = createFakeAccount();
    account.signInAs(UID_A);
    const accountHost = createAccountHost({
      transport: account.transport,
      service: account.store,
    });
    const remote = new PartitionedRemote(
      () => account.store.snapshot().user?.id ?? null,
    );
    const service = new VaultSyncStore({
      remote,
      account: account.store,
      storage: createMemorySyncStorage(),
    });
    const syncHost = createVaultSyncHost({ service });

    await runtime.registerSlot({
      id: 'vault',
      plugin: withObservableVault(memoryVaultPlugin),
      config: { localVaultId: LOCAL_A },
    });
    await runtime.registerSlot({
      id: 'account',
      plugin: accountHost.definition,
    });
    const slot = await runtime.registerSlot({
      id: 'vault-sync',
      plugin: syncHost.definition,
    });
    expect(slot.id).toBe('vault-sync');
    await runtime.registerSlot({
      id: 'vault-sync-attachment',
      plugin: syncHost.attachment,
    });

    let observed = 0;
    const probe = await runtime.registerSlot({
      id: 'sync-probe',
      plugin: definePlugin({
        id: 'froglight.vault-sync.probe',
        requirements: { requires: [vaultSyncToken] },
        activate: (ctx) => {
          ctx.require(vaultSyncToken);
          observed += 1;
          ctx.effect(() => () => {
            observed -= 1;
          });
        },
      }),
    });
    expect(observed).toBe(1);
    await runtime.removeSlot(probe.id);
    expect(observed).toBe(0);

    // The decorated vault is genuinely observable through the graph.
    const seen: { vault: VaultService | null } = { vault: null };
    await runtime.registerSlot({
      id: 'vault-probe',
      plugin: definePlugin({
        id: 'froglight.vault.probe',
        requirements: { requires: [vaultToken] },
        activate: (ctx) => {
          seen.vault = ctx.require(vaultToken);
        },
      }),
    });
    expect(seen.vault instanceof ObservableVaultService).toBe(true);

    // Host-lifetime service survives; attachment follows the vault.
    // Removing the vault withdraws the attachment but NOT the token.
    await runtime.removeSlot('vault-sync-attachment');
    await runtime.removeSlot(slot.id);
    if (seen.vault === null) throw new Error('expected a bound vault');
    await writeFile(seen.vault, 'a.md', 'v1');
    await runtime.registerSlot({
      id: 'vault-sync',
      plugin: syncHost.definition,
    });
    await runtime.registerSlot({
      id: 'vault-sync-attachment',
      plugin: syncHost.attachment,
    });
    let observedAgain = 0;
    await runtime.registerSlot({
      id: 'sync-probe',
      plugin: definePlugin({
        id: 'froglight.vault-sync.probe2',
        requirements: { requires: [vaultSyncToken] },
        activate: (ctx) => {
          if (ctx.require(vaultSyncToken) === service) observedAgain += 1;
        },
      }),
    });
    expect(observedAgain).toBe(1);

    await service.enable({ localVaultId: LOCAL_A, name: 'A' });
    await service.reconcile();
    expect(service.snapshot().lastRevision).toBe(1);
    await runtime.dispose();
    service.dispose();
  });

  it('vaultSyncToken survives launcher closeVault while attachment follows the vault', async () => {
    const runtime = new Runtime();
    const account = createFakeAccount();
    account.signInAs(UID_A);
    const accountHost = createAccountHost({
      transport: account.transport,
      service: account.store,
    });
    const remote = new PartitionedRemote(
      () => account.store.snapshot().user?.id ?? null,
    );
    const service = new VaultSyncStore({
      remote,
      account: account.store,
      storage: createMemorySyncStorage(),
    });
    const syncHost = createVaultSyncHost({ service });
    await runtime.registerSlot({
      id: 'vault',
      plugin: withObservableVault(memoryVaultPlugin),
      config: {},
    });
    await runtime.registerSlot({
      id: 'account',
      plugin: accountHost.definition,
    });
    await runtime.registerSlot({
      id: 'vault-sync',
      plugin: syncHost.definition,
    });
    await runtime.registerSlot({
      id: 'vault-sync-attachment',
      plugin: syncHost.attachment,
    });
    let observed = 0;
    await runtime.registerSlot({
      id: 'sync-probe',
      plugin: definePlugin({
        id: 'froglight.vault-sync.launcher-probe',
        requirements: { requires: [vaultSyncToken] },
        activate: (ctx) => {
          ctx.require(vaultSyncToken);
          observed += 1;
          ctx.effect(() => () => {
            observed -= 1;
          });
        },
      }),
    });
    expect(observed).toBe(1);
    // Launcher: close the bootstrap vault. The host-lifetime token must
    // remain; only the workspace attachment parks.
    await runtime.removeSlot('vault-sync-attachment');
    await runtime.removeSlot('vault');
    expect(observed).toBe(1);
    // Discovery still works with no vault open (unauthenticated remote
    // denies, but the token resolves — the launcher can list/download).
    await runtime.registerSlot({
      id: 'vault',
      plugin: withObservableVault(memoryVaultPlugin),
      config: {},
    });
    await runtime.registerSlot({
      id: 'vault-sync-attachment',
      plugin: syncHost.attachment,
    });
    expect(observed).toBe(1);
    await runtime.dispose();
    service.dispose();
  });

  it('survives vault replacement by re-attaching to the fresh vault', async () => {
    const runtime = new Runtime();
    const account = createFakeAccount();
    account.signInAs(UID_A);
    const accountHost = createAccountHost({
      transport: account.transport,
      service: account.store,
    });
    const remote = new PartitionedRemote(
      () => account.store.snapshot().user?.id ?? null,
    );
    const service = new VaultSyncStore({
      remote,
      account: account.store,
      storage: createMemorySyncStorage(),
    });
    const syncHost = createVaultSyncHost({ service });

    await runtime.registerSlot({
      id: 'vault',
      plugin: withObservableVault(memoryVaultPlugin),
      config: { localVaultId: LOCAL_A },
    });
    await runtime.registerSlot({
      id: 'account',
      plugin: accountHost.definition,
    });
    await runtime.registerSlot({
      id: 'vault-sync',
      plugin: syncHost.definition,
    });
    await runtime.registerSlot({
      id: 'vault-sync-attachment',
      plugin: syncHost.attachment,
    });
    await service.enable({ localVaultId: LOCAL_A, name: 'A' });

    // Swap the vault provider: the attachment disposes/reactivates while
    // the host service instance survives, and the service observes the
    // fresh vault without host intervention. The write through the
    // replacement vault schedules a reconcile that commits it (a fresh
    // replica's local-only change).
    await runtime.removeSlot('vault-sync-attachment');
    await runtime.removeSlot('vault');
    await runtime.registerSlot({
      id: 'vault',
      plugin: withObservableVault(memoryVaultPlugin),
      config: { localVaultId: LOCAL_A },
    });
    await runtime.registerSlot({
      id: 'vault-sync-attachment',
      plugin: syncHost.attachment,
    });
    const freshSeen: { vault: VaultService | null } = { vault: null };
    await runtime.registerSlot({
      id: 'vault-probe',
      plugin: definePlugin({
        id: 'froglight.vault.probe2',
        requirements: { requires: [vaultToken] },
        activate: (ctx) => {
          freshSeen.vault = ctx.require(vaultToken);
        },
      }),
    });
    if (freshSeen.vault === null) throw new Error('expected a bound vault');
    const freshVault: VaultService = freshSeen.vault;
    await writeFile(freshVault, 'fresh.md', 'new replica');
    await vi.waitFor(() => {
      expect(service.snapshot().lastRevision).toBe(1);
    });
    expect(await dumpVault(freshVault)).toEqual({
      'fresh.md': 'new replica',
    });
    const cloudId = service.snapshot().binding?.cloudVaultId as string;
    expect(await remote.readHead(cloudId)).toMatchObject({ revision: 1 });
    await runtime.dispose();
    service.dispose();
  });
});

describe('vault profile discovery', () => {
  it('rejects unverified profile bytes during discovery', async () => {
    const harness = createHarness();
    await boot(harness);
    try {
      await writeVaultProfile(harness.observable, {
        name: 'Private',
        icon: 'book',
        color: 'violet',
      });
      await harness.service.enable({ localVaultId: LOCAL_A, name: 'Private' });
      await harness.service.reconcile();
      await harness.service.disable();
      vi.spyOn(harness.remote, 'downloadBlob').mockResolvedValue(
        new Uint8Array([0]),
      );
      await expect(harness.service.listRemoteVaults()).rejects.toMatchObject({
        code: 'HASH_MISMATCH',
      });
    } finally {
      harness.service.dispose();
    }
  });

  it('stops profile discovery before the next request when the account changes', async () => {
    const harness = createHarness();
    await boot(harness);
    try {
      await writeVaultProfile(harness.observable, {
        name: 'Private',
        icon: 'book',
        color: 'violet',
      });
      await harness.service.enable({ localVaultId: LOCAL_A, name: 'Private' });
      await harness.service.reconcile();
      await harness.service.disable();
      const read = harness.remote.readHead.bind(harness.remote);
      vi.spyOn(harness.remote, 'readHead').mockImplementation(async (id) => {
        const head = await read(id);
        harness.account.signInAs(UID_B);
        return head;
      });
      const load = vi.spyOn(harness.remote, 'loadManifest');
      await expect(harness.service.listRemoteVaults()).rejects.toMatchObject({
        code: 'ACCOUNT_CHANGED',
      });
      expect(load).not.toHaveBeenCalled();
    } finally {
      harness.service.dispose();
    }
  });

  it('reads the synced name and appearance from verified canonical bytes', async () => {
    const harness = createHarness();
    await boot(harness);
    try {
      await writeVaultProfile(harness.observable, {
        name: 'Biology',
        icon: 'apple',
        color: 'green',
      });
      await harness.service.enable({
        localVaultId: LOCAL_A,
        name: 'Old host name',
      });
      await harness.service.reconcile();
      expect(await harness.service.listRemoteVaults()).toEqual([
        expect.objectContaining({
          name: 'Biology',
          profile: { name: 'Biology', icon: 'apple', color: 'green' },
        }),
      ]);
    } finally {
      harness.service.dispose();
    }
  });
});

it('preserves downloaded bindings when authentication restores before sync metadata', async () => {
  const storage = createMemorySyncStorage();
  await storage.save({
    version: 1,
    deviceId: 'device-existing',
    accounts: {
      [UID_A]: {
        activeLocalVaultId: null,
        bindings: {
          downloaded: {
            localVaultId: 'downloaded',
            cloudVaultId: 'cloud-downloaded',
            name: 'Downloaded',
            deviceId: 'device-existing',
            enabled: true,
            base: null,
            lastRevision: null,
            lastSyncedAt: null,
          },
        },
      },
    },
  });
  const before = await storage.load();
  const account = createFakeAccount();
  const sync = new VaultSyncStore({
    account: account.store,
    storage,
    remote: new MemorySyncRemote(),
  });
  try {
    account.signInAs(UID_A);
    await account.store.restore();
    await flush();
    expect(await storage.load()).toEqual(before);
    await sync.restore();
    expect(sync.snapshot().bindings).toContainEqual(
      expect.objectContaining({
        localVaultId: 'downloaded',
        cloudVaultId: 'cloud-downloaded',
        enabled: true,
      }),
    );
  } finally {
    sync.dispose();
  }
});
