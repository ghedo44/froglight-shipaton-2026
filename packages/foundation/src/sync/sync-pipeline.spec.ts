/**
 * Mutation-pipeline and first-materialization conformance.
 *
 * 1. Observable wiring (provider-composition boundary): the `vaultToken`
 *    exposed to workspace/application consumers is the shared observable
 *    facade, so a save through `DocumentSession` (never a direct
 *    `ObservableVaultService.write()` call) reaches the sync scheduler's
 *    mutation feed, while remote-applied bytes materialized through the
 *    silent view never echo back into the feed — and the feed stays live
 *    for later local saves.
 *
 * 2. Download & Open first materialization: `materializeRemoteVault()`
 *    downloads and verifies the whole cloud replica into a fresh empty
 *    store and only then binds it. The initial download materializes the
 *    remote manifest verbatim (never a three-way merge against
 *    initialized workspace metadata); failure binds nothing.
 */

import { describe, expect, it } from 'vitest';
import { Runtime, definePlugin } from '@froglight/runtime';
import {
  AccountStore,
  type AccountTransport,
  type AccountUser,
} from '../account/index.js';
import { createAccountHost } from '../account/plugin.js';
import {
  documentRegistryToken,
  vaultToken,
  workspaceToken,
} from '../tokens.js';
import { memoryVaultPlugin } from '../plugins/memory-vault.js';
import { workspacePlugin } from '../plugins/workspace.js';
import type { PluginDefinition } from '@froglight/runtime';
import { createMemoryVault } from '../vault/memory.js';
import type { VaultService } from '../vault/contract.js';
import { workspacePath } from '../paths.js';
import { InMemoryDocumentRegistry } from '../documents.js';
import { InMemoryMetadataService } from '../metadata.js';
import { InMemoryRelationshipService } from '../relationships.js';
import {
  testNoteKind,
  testNoteKindId,
  testNoteModel,
  type TestDocModel,
} from '../testing/test-note.js';
import { WorkspaceServiceImpl, type WorkspaceService } from '../workspace.js';
import { MemorySyncRemote } from '../index.js';
import { VaultSyncStore, createMemorySyncStorage } from './service.js';
import {
  ObservableVaultService,
  asObservableVault,
  withObservableVault,
  type VaultMutation,
} from './mutations.js';
import { createVaultSyncHost } from './plugin.js';
import {
  WorkspaceDirtyTracker,
  WorkspaceSyncReconciler,
} from './workspace-tracker.js';

const UID = 'uid-alice';
const NOTE = workspacePath('note.md');

function createFakeAccount(): {
  store: AccountStore;
  transport: AccountTransport;
  signInAs(uid: string): void;
} {
  let user: AccountUser | null = null;
  const listeners = new Set<(next: AccountUser | null) => void>();
  const transport: AccountTransport = {
    async currentUser() {
      return user === null ? null : { ...user };
    },
    async createAccount(email: string) {
      const created: AccountUser = { id: `uid-${email}`, email };
      user = created;
      for (const listener of [...listeners]) listener({ ...created });
      return { ...created };
    },
    async signIn(email: string) {
      const signedIn: AccountUser = { id: `uid-${email}`, email };
      user = signedIn;
      for (const listener of [...listeners]) listener({ ...signedIn });
      return { ...signedIn };
    },
    async signOut() {
      user = null;
      for (const listener of [...listeners]) listener(null);
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
  return {
    store,
    transport,
    signInAs: (uid) => {
      user = { id: uid, email: `${uid}@example.com` };
      for (const listener of [...listeners]) {
        listener(user === null ? null : { ...user });
      }
    },
  };
}

function kindsPlugin(): PluginDefinition {
  return definePlugin({
    id: 'test.kinds',
    requirements: { requires: [documentRegistryToken] },
    activate: (ctx) => {
      ctx.effect(
        () => ctx.require(documentRegistryToken).register(testNoteKind).dispose,
      );
    },
  });
}

/**
 * Wait until the service is quiescent (no pending mutations, idle phase,
 * revision stable across macrotask hops) and return the revision. The
 * runtime-composed workspace records vault-backed revisions on every
 * save, so one save can legitimately commit twice (note, then sidecars);
 * callers therefore compute expectations relative to the settled value.
 */
async function quiescentRevision(service: VaultSyncStore): Promise<number> {
  let stable = 0;
  let last = -1;
  for (let i = 0; i < 200; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const snapshot = service.snapshot();
    if (
      snapshot.pendingChanges === 0 &&
      snapshot.phase === 'idle' &&
      snapshot.lastRevision === last
    ) {
      stable += 1;
      if (stable >= 3) return last;
    } else {
      stable = 0;
      last = snapshot.lastRevision ?? -1;
    }
  }
  throw new Error('sync did not reach quiescence');
}

describe('mutation pipeline through the shared observable facade', () => {
  it('routes DocumentSession saves to the scheduler and never echoes remote applies', async () => {
    const account = createFakeAccount();
    account.signInAs(UID);
    const remote = new MemorySyncRemote();
    const runtime = new Runtime();
    // Host composition boundary: the vault provider is wrapped once, so
    // every consumer shares the same observable facade.
    await runtime.registerSlot({
      id: 'vault',
      plugin: withObservableVault(memoryVaultPlugin),
      config: { localVaultId: 'local-a' },
    });
    await runtime.registerSlot({
      id: 'workspace',
      plugin: workspacePlugin,
      config: {},
    });
    await runtime.registerSlot({ id: 'kinds', plugin: kindsPlugin() });
    const accountHost = createAccountHost({
      transport: account.transport,
      service: account.store,
    });
    await runtime.registerSlot({
      id: 'account',
      plugin: accountHost.definition,
    });
    // Pick up the already-signed-in session (the store subscribed after
    // the fake announced it, so seed explicitly like host boot does).
    await accountHost.service.restore();

    const captured: {
      workspace: WorkspaceService | null;
      vault: VaultService | null;
    } = { workspace: null, vault: null };
    await runtime.registerSlot({
      id: 'probe',
      plugin: definePlugin({
        id: 'test.probe',
        requirements: { requires: [workspaceToken, vaultToken] },
        activate: (ctx) => {
          captured.workspace = ctx.require(workspaceToken);
          captured.vault = ctx.require(vaultToken);
        },
      }),
    });
    const workspace = captured.workspace;
    const vault = captured.vault;
    if (workspace === null || vault === null) {
      throw new Error('expected workspace and vault probes');
    }
    // The vaultToken IS the shared observable facade (not a disconnected
    // wrapper living only inside the sync consumer).
    expect(vault).toBeInstanceOf(ObservableVaultService);
    const observable = asObservableVault(vault);
    if (observable === null) throw new Error('expected an observable vault');

    const getWorkspace = (): WorkspaceService | null => workspace;
    const service = new VaultSyncStore({
      remote,
      account: accountHost.service,
      storage: createMemorySyncStorage(),
      tracker: new WorkspaceDirtyTracker({ getWorkspace }),
      reconciler: new WorkspaceSyncReconciler({ getWorkspace }),
    });
    const syncHost = createVaultSyncHost({ service });
    await runtime.registerSlot({
      id: 'vault-sync',
      plugin: syncHost.definition,
    });
    await runtime.registerSlot({
      id: 'vault-sync-attachment',
      plugin: syncHost.attachment,
    });

    const mutations: VaultMutation[] = [];
    observable.onMutation((mutation) => {
      mutations.push(mutation);
    });

    const ref = await workspace.createDocument({
      kindId: testNoteKindId,
      path: NOTE,
      initialModel: testNoteModel('Note', 'X'),
    });
    await service.enable({ localVaultId: 'local-a', name: 'A' });
    await service.reconcile();
    expect(service.snapshot().lastRevision).toBe(1);
    const cloudId = service.snapshot().binding?.cloudVaultId as string;

    // A save through DocumentSession (not a direct observable write)
    // reaches the mutation feed: the scheduler observes it.
    const session = await workspace.openDocument<TestDocModel>(ref.documentId);
    mutations.length = 0;
    (session.model as { text: string }).text = 'X + edit';
    session.markDirty();
    await session.save();
    expect(
      mutations.filter(
        (mutation) => mutation.type === 'write' && mutation.path === NOTE,
      ),
    ).toHaveLength(1);
    expect(service.snapshot().pendingChanges).toBeGreaterThanOrEqual(1);
    const revAfterSave = await quiescentRevision(service);
    expect(revAfterSave).toBeGreaterThanOrEqual(2);

    // A second device pushes Y; this replica downloads it through the
    // silent view: no mutation echoes back into the feed...
    const { vault: vaultB } = createMemoryVault({});
    const observableB = new ObservableVaultService(vaultB);
    const serviceB = new VaultSyncStore({
      remote,
      account: accountHost.service,
      storage: createMemorySyncStorage(),
      tracker: null,
    });
    await serviceB.restore();
    serviceB.attach({ localVaultId: 'local-b', vault: observableB });
    await serviceB.attachRemoteVault(cloudId, 'local-b');
    await serviceB.reconcile();
    await observableB.write(
      NOTE,
      testNoteKind.encode(testNoteModel('Note', 'Y'), {
        documentId: ref.documentId,
        kindId: testNoteKindId,
        location: ref.location,
      }),
    );
    await serviceB.reconcile();
    expect(serviceB.snapshot().lastRevision).toBe(revAfterSave + 1);

    mutations.length = 0;
    await service.reconcile();
    expect(service.snapshot().lastRevision).toBe(revAfterSave + 1);
    expect(mutations).toEqual([]);
    // ...and the feed stays live: a later local save still schedules.
    (session.model as { text: string }).text = 'Y + edit';
    session.markDirty();
    await session.save();
    expect(
      mutations.filter(
        (mutation) => mutation.type === 'write' && mutation.path === NOTE,
      ),
    ).toHaveLength(1);
    const revFinal = await quiescentRevision(service);
    expect(revFinal).toBeGreaterThan(revAfterSave + 1);

    serviceB.dispose();
    service.dispose();
    await runtime.dispose();
  });
});

describe('materializeRemoteVault first-materialization flow', () => {
  async function setupSource(): Promise<{
    remote: MemorySyncRemote;
    account: AccountStore;
    cloudId: string;
  }> {
    const account = createFakeAccount();
    account.signInAs(UID);
    const remote = new MemorySyncRemote();
    const { vault } = createMemoryVault({});
    const observable = new ObservableVaultService(vault);
    const registry = new InMemoryDocumentRegistry();
    registry.register(testNoteKind);
    const workspace = await WorkspaceServiceImpl.create({
      vault: observable,
      registry,
      metadata: new InMemoryMetadataService(),
      relationships: new InMemoryRelationshipService(),
      revisions: null,
    });
    const getWorkspace = (): WorkspaceService | null => workspace;
    const service = new VaultSyncStore({
      remote,
      account: account.store,
      storage: createMemorySyncStorage(),
      tracker: new WorkspaceDirtyTracker({ getWorkspace }),
      reconciler: new WorkspaceSyncReconciler({ getWorkspace }),
    });
    await service.restore();
    service.attach({ localVaultId: 'local-a', vault: observable });
    await workspace.createDocument({
      kindId: testNoteKindId,
      path: NOTE,
      initialModel: testNoteModel('Note', 'X'),
    });
    await workspace.createDocument({
      kindId: testNoteKindId,
      path: workspacePath('Docs/nested.md'),
      initialModel: testNoteModel('Nested', 'N'),
    });
    await observable.createDirectory(workspacePath('Empty'));
    await service.enable({ localVaultId: 'local-a', name: 'A' });
    await service.reconcile();
    const cloudId = service.snapshot().binding?.cloudVaultId as string;
    service.dispose();
    return { remote, account: account.store, cloudId };
  }

  function makeDownloader(
    remote: MemorySyncRemote,
    account: AccountStore,
  ): VaultSyncStore {
    const service = new VaultSyncStore({
      remote,
      account,
      storage: createMemorySyncStorage(),
      tracker: null,
    });
    return service;
  }

  it('materializes remote bytes without binding until finalized (transactional)', async () => {
    const { remote, account, cloudId } = await setupSource();
    const service = makeDownloader(remote, account);
    await service.restore();
    const { vault: target } = createMemoryVault({});

    const prepared = await service.materializeRemoteVault(
      cloudId,
      'local-b',
      target,
    );

    // Remote bytes exist verified in the target BEFORE finalize...
    const read = async (path: string): Promise<string> => {
      const bytes = await target.read(workspacePath(path));
      return (
        testNoteKind.decode(bytes, {
          documentId: 'x' as never,
          kindId: testNoteKindId,
          location: { resourceId: 'y' as never },
        }).model as TestDocModel
      ).text;
    };
    expect(await read('note.md')).toBe('X');
    expect(await read('Docs/nested.md')).toBe('N');
    expect(await target.stat(workspacePath('Empty'))).toMatchObject({
      kind: 'directory',
    });
    // ...but nothing is bound until the host activates and finalizes:
    // activation failure / cancel must leave no binding behind.
    expect(service.isCloudVaultBound(cloudId)).toBe(false);
    expect(service.snapshot().binding).toBeNull();

    // Host activates the materialized store as an ordinary local vault:
    // the runtime attaches the exact staged vault under the prepared id,
    // then finalizes the binding with the exact prepared base.
    service.attach({
      localVaultId: 'local-b',
      vault: new ObservableVaultService(target),
    });
    await service.finalizeMaterializedVault(prepared);
    expect(service.isCloudVaultBound(cloudId)).toBe(true);
    expect(service.snapshot().binding).toMatchObject({
      cloudVaultId: cloudId,
      localVaultId: 'local-b',
    });
    expect(service.snapshot()).toMatchObject({ lastRevision: 1 });
    // The materialized vault opens as an ordinary local vault: its
    // workspace record resolves the downloaded documents.
    const registry = new InMemoryDocumentRegistry();
    registry.register(testNoteKind);
    const workspace = await WorkspaceServiceImpl.create({
      vault: target,
      registry,
      metadata: new InMemoryMetadataService(),
      relationships: new InMemoryRelationshipService(),
      revisions: null,
    });
    expect(workspace.listDocuments()).toHaveLength(2);
    service.dispose();
  });

  it('refuses duplicates, missing vaults, and non-empty targets without binding', async () => {
    const { remote, account, cloudId } = await setupSource();
    const service = makeDownloader(remote, account);
    await service.restore();

    await expect(
      service.materializeRemoteVault(
        'cloud-missing',
        'local-x',
        createMemoryVault({}).vault,
      ),
    ).rejects.toMatchObject({ code: 'REMOTE_NOT_FOUND' });
    expect(service.snapshot().binding).toBeNull();

    const { vault: dirty } = createMemoryVault({});
    await dirty.write(workspacePath('scratch.md'), new Uint8Array([1]));
    await expect(
      service.materializeRemoteVault(cloudId, 'local-y', dirty),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(service.snapshot().binding).toBeNull();

    const { vault: target } = createMemoryVault({});
    const prepared = await service.materializeRemoteVault(
      cloudId,
      'local-b',
      target,
    );
    // Real activation attaches the staged vault under the prepared id.
    service.attach({
      localVaultId: 'local-b',
      vault: new ObservableVaultService(target),
    });
    // Finalizing twice is CONFLICT. Here we finalize once, then a
    // second prepare for the same cloud vault must refuse the duplicate
    // cloud binding at prepare time (already materialized on this device).
    await service.finalizeMaterializedVault(prepared);
    await expect(
      service.materializeRemoteVault(
        cloudId,
        'local-c',
        createMemoryVault({}).vault,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    // The original binding is untouched by the refused duplicate.
    expect(service.snapshot().binding).toMatchObject({
      localVaultId: 'local-b',
    });
    // Preparing a different cloud id under an already-bound local vault
    // is also CONFLICT (local vault already bound).
    // Seed a second cloud vault through a throwaway service so the cloud
    // id exists, then refuse the duplicate local binding at prepare time.
    const { vault: seedVault } = createMemoryVault({});
    await seedVault.write(workspacePath('s.md'), new TextEncoder().encode('s'));
    const seeder = makeDownloader(remote, account);
    await seeder.restore();
    seeder.attach({
      localVaultId: 'local-seed',
      vault: new (await import('./mutations.js')).ObservableVaultService(
        seedVault,
      ),
    });
    await seeder.enable({ localVaultId: 'local-seed', name: 'Seed' });
    await seeder.reconcile();
    const otherCloud = seeder.snapshot().binding?.cloudVaultId as string;
    seeder.dispose();
    await expect(
      service.materializeRemoteVault(
        otherCloud,
        'local-b',
        createMemoryVault({}).vault,
      ),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    service.dispose();
  });
});
