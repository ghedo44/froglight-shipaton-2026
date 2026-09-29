/**
 * Remote-apply → workspace/session reconciliation conformance.
 *
 * Regression suite for the stale-clean-session data-loss hazard:
 *
 * ```text
 * base = X
 * Device B edits note.md → cloud becomes Y
 * Device A has note.md open and CLEAN; sync downloads Y into the vault
 *   and advances the base to Y, but the open editor still holds X
 * User edits stale X and saves X + new-edit
 * Next sync sees base = Y, remote = Y, local = X + new-edit and
 *   overwrites Y without a conflict (silent data loss)
 * ```
 *
 * Dirty-session deferral cannot cover this case (the session is clean),
 * so the sync service invokes the host `SyncWorkspaceReconciler` seam
 * with clean-applied paths BEFORE persisting the advanced base. The
 * workspace-backed reconciler reloads clean open sessions (dirty ones
 * stay deferred and untouched), reloads the workspace record, and
 * rebuilds derived state — all without importing React/UI concepts.
 */

import { describe, expect, it } from 'vitest';
import {
  AccountStore,
  type AccountTransport,
  type AccountUser,
} from '../account/index.js';
import { InMemoryDocumentRegistry } from '../documents.js';
import { InMemoryMetadataService } from '../metadata.js';
import { InMemoryRelationshipService } from '../relationships.js';
import { createMemoryVault } from '../vault/memory.js';
import type { VaultService } from '../vault/contract.js';
import { workspacePath, type WorkspacePath } from '../paths.js';
import type { DocumentRef } from '../documents.js';
import {
  testNoteKind,
  testNoteKindId,
  type TestDocModel,
} from '../testing/test-note.js';
import { WorkspaceServiceImpl, type WorkspaceService } from '../workspace.js';
import { MemorySyncRemote, type SyncRemote } from '../index.js';
import { VaultSyncStore, createMemorySyncStorage } from './service.js';
import { ObservableVaultService } from './mutations.js';
import {
  WorkspaceDirtyTracker,
  WorkspaceSyncReconciler,
} from './workspace-tracker.js';

const UID = 'uid-alice';
const LOCAL_A = 'local-a';
const LOCAL_B = 'local-b';
const NOTE = workspacePath('note.md');

function createFakeAccount(): {
  store: AccountStore;
  signInAs(uid: string): void;
  signOut(): void;
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
  return {
    store: new AccountStore({ transport }),
    signInAs: (uid) => {
      user = { id: uid, email: `${uid}@example.com` };
      for (const listener of [...listeners]) {
        listener(user === null ? null : { ...user });
      }
    },
    signOut: () => {
      user = null;
      for (const listener of [...listeners]) listener(null);
    },
  };
}

interface Device {
  vault: VaultService;
  observable: ObservableVaultService;
  workspace: WorkspaceService | null;
  service: VaultSyncStore;
  /** Late workspace init (after the first pull) over the live vault. */
  createWorkspace(): Promise<WorkspaceService>;
}

async function newWorkspace(vault: VaultService): Promise<WorkspaceService> {
  const registry = new InMemoryDocumentRegistry();
  registry.register(testNoteKind);
  return WorkspaceServiceImpl.create({
    vault,
    registry,
    metadata: new InMemoryMetadataService(),
    relationships: new InMemoryRelationshipService(),
    revisions: null,
  });
}

async function makeDevice(
  remote: SyncRemote,
  account: AccountStore,
  options: {
    reconciler?: boolean;
    workspace?: boolean;
    localVaultId?: string;
  } = {},
): Promise<Device> {
  const {
    reconciler = true,
    workspace: withWorkspace = true,
    localVaultId = LOCAL_A,
  } = options;
  const { vault } = createMemoryVault({});
  const observable = new ObservableVaultService(vault);
  let workspace: WorkspaceService | null = null;
  const getWorkspace = (): WorkspaceService | null => workspace;
  const service = new VaultSyncStore({
    remote,
    account,
    storage: createMemorySyncStorage(),
    tracker: new WorkspaceDirtyTracker({ getWorkspace }),
    ...(reconciler
      ? { reconciler: new WorkspaceSyncReconciler({ getWorkspace }) }
      : {}),
  });
  await service.restore();
  service.attach({ localVaultId, vault: observable });
  // A downloading device initializes its workspace AFTER the first pull
  // (mirroring Download & Open): initializing an empty workspace first
  // would flush a competing empty record and mask the sync under test.
  const device: Device = {
    vault,
    observable,
    workspace: null,
    service,
    createWorkspace: async () => {
      workspace = await newWorkspace(observable);
      device.workspace = workspace;
      return workspace;
    },
  };
  if (withWorkspace) await device.createWorkspace();
  return device;
}

function workspaceOf(device: Device): WorkspaceService {
  const workspace = device.workspace;
  if (workspace === null) throw new Error('workspace not initialized');
  return workspace;
}

function encodeNote(text: string): Uint8Array {
  const ref: DocumentRef = {
    documentId: 'doc-ref' as never,
    kindId: testNoteKindId,
    location: { resourceId: 'res-ref' as never },
  };
  return testNoteKind.encode({ title: 'Note', tags: [], text }, ref);
}

function decodeNote(bytes: Uint8Array): TestDocModel {
  const ref: DocumentRef = {
    documentId: 'doc-ref' as never,
    kindId: testNoteKindId,
    location: { resourceId: 'res-ref' as never },
  };
  return testNoteKind.decode(bytes, ref).model as TestDocModel;
}

async function vaultText(
  vault: VaultService,
  path: WorkspacePath,
): Promise<string> {
  return decodeNote(await vault.read(path)).text;
}

async function listAll(vault: VaultService): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const children = await vault.list(
      dir === '' ? workspacePath('') : workspacePath(dir),
    );
    for (const child of children) {
      const path = dir === '' ? child.name : `${dir}/${child.name}`;
      if (child.kind === 'directory') await walk(path);
      else out.push(path);
    }
  };
  await walk('');
  return out.sort();
}

describe('stale clean sessions can never silently erase remote changes', () => {
  it('reloads the clean open session before the base advances', async () => {
    const account = createFakeAccount();
    account.signInAs(UID);
    const remote = new MemorySyncRemote();
    const deviceA = await makeDevice(remote, account.store);
    const deviceB = await makeDevice(remote, account.store, {
      workspace: false,
      localVaultId: LOCAL_B,
    });

    // Device A creates the note and syncs revision 1 (base = X).
    const ref = await workspaceOf(deviceA).createDocument({
      kindId: testNoteKindId,
      path: NOTE,
      initialModel: { title: 'Note', tags: [], text: 'X' },
    });
    await deviceA.service.enable({ localVaultId: LOCAL_A, name: 'A' });
    await deviceA.service.reconcile();
    expect(deviceA.service.snapshot().lastRevision).toBe(1);
    const cloudId = deviceA.service.snapshot().binding?.cloudVaultId as string;

    // Device B downloads X (clean pull, revision stays 1).
    await deviceB.service.attachRemoteVault(cloudId, LOCAL_B);
    await deviceB.service.reconcile();
    expect(deviceB.service.snapshot().lastRevision).toBe(1);

    // Device A opens the note (clean, holding X) BEFORE the remote edit,
    // exactly as in the hazard scenario.
    const session = await workspaceOf(deviceA).openDocument<TestDocModel>(
      ref.documentId,
    );
    expect(session.dirty).toBe(false);
    expect((session.model as TestDocModel).text).toBe('X');

    // Device B edits to Y through its observable facade (production-like:
    // the mutation feed observes the committed write) and syncs rev 2.
    await deviceB.observable.write(NOTE, encodeNote('Y'));
    await deviceB.service.reconcile();
    expect(deviceB.service.snapshot().lastRevision).toBe(2);

    // Device A syncs (directly, or via the HEAD watcher auto-cycle that
    // B's commit already triggered — both funnel through the same seam).
    await deviceA.service.reconcile();

    // The remote apply reloaded the clean session before the base moved:
    // vault, session, and base all agree on Y.
    expect(await vaultText(deviceA.vault, NOTE)).toBe('Y');
    expect((session.model as TestDocModel).text).toBe('Y');
    expect(session.dirty).toBe(false);
    expect(deviceA.service.snapshot()).toMatchObject({ lastRevision: 2 });
    expect(deviceA.service.snapshot().deferredPaths).toEqual([]);

    // A subsequent user edit builds on Y (never on stale X): the next
    // sync uploads Y + edit as a plain local change — no conflict copy,
    // and Y is never silently erased.
    (session.model as { text: string }).text = 'Y + edit';
    session.markDirty();
    await session.save();
    await deviceA.service.reconcile();
    expect(deviceA.service.snapshot().lastRevision).toBe(3);

    const files = await listAll(deviceA.vault);
    expect(files.filter((path) => path.includes('.conflict-'))).toEqual([]);
    // A third device converges on exactly Y + edit with no extra copies.
    const deviceC = await makeDevice(remote, account.store, {
      workspace: false,
      localVaultId: 'local-c',
    });
    await deviceC.service.attachRemoteVault(cloudId, 'local-c');
    await deviceC.service.reconcile();
    expect(await vaultText(deviceC.vault, NOTE)).toBe('Y + edit');
    expect(
      (await listAll(deviceC.vault)).filter((path) =>
        path.includes('.conflict-'),
      ),
    ).toEqual([]);

    deviceA.service.dispose();
    deviceB.service.dispose();
    deviceC.service.dispose();
  });

  it('leaves dirty sessions deferred and untouched while reloading clean ones', async () => {
    const account = createFakeAccount();
    account.signInAs(UID);
    const remote = new MemorySyncRemote();
    const deviceA = await makeDevice(remote, account.store);
    const deviceB = await makeDevice(remote, account.store, {
      workspace: false,
      localVaultId: LOCAL_B,
    });

    const ref = await workspaceOf(deviceA).createDocument({
      kindId: testNoteKindId,
      path: NOTE,
      initialModel: { title: 'Note', tags: [], text: 'X' },
    });
    await deviceA.service.enable({ localVaultId: LOCAL_A, name: 'A' });
    await deviceA.service.reconcile();
    const cloudId = deviceA.service.snapshot().binding?.cloudVaultId as string;
    await deviceB.service.attachRemoteVault(cloudId, LOCAL_B);
    await deviceB.service.reconcile();

    // The session holds unsaved local edits (dirty).
    const session = await workspaceOf(deviceA).openDocument<TestDocModel>(
      ref.documentId,
    );
    (session.model as { text: string }).text = 'X + unsaved';
    session.markDirty();

    await deviceB.observable.write(NOTE, encodeNote('Y'));
    await deviceB.service.reconcile();
    await deviceA.service.reconcile();

    // Deferral held: vault bytes and the editor model are untouched, and
    // the deferral is reported.
    expect(await vaultText(deviceA.vault, NOTE)).toBe('X');
    expect((session.model as TestDocModel).text).toBe('X + unsaved');
    expect(session.dirty).toBe(true);
    expect(deviceA.service.snapshot().deferredPaths).toEqual(['note.md']);

    // Saving reconciles as a genuine concurrent edit: both versions
    // survive (local keeps the path, remote Y is preserved as a copy).
    await session.save();
    await deviceA.service.reconcile();
    expect(await vaultText(deviceA.vault, NOTE)).toBe('X + unsaved');
    const files = await listAll(deviceA.vault);
    const copies = files.filter((path) => path.includes('.conflict-'));
    expect(copies).toHaveLength(1);
    expect(
      await vaultText(deviceA.vault, workspacePath(copies[0] as string)),
    ).toBe('Y');

    deviceA.service.dispose();
    deviceB.service.dispose();
  });

  it('documents the data-loss hazard when the seam is absent', async () => {
    const account = createFakeAccount();
    account.signInAs(UID);
    const remote = new MemorySyncRemote();
    // No reconciler: the service advances the base behind the session.
    const deviceA = await makeDevice(remote, account.store, {
      reconciler: false,
    });
    const deviceB = await makeDevice(remote, account.store, {
      reconciler: false,
      workspace: false,
      localVaultId: LOCAL_B,
    });

    const ref = await workspaceOf(deviceA).createDocument({
      kindId: testNoteKindId,
      path: NOTE,
      initialModel: { title: 'Note', tags: [], text: 'X' },
    });
    await deviceA.service.enable({ localVaultId: LOCAL_A, name: 'A' });
    await deviceA.service.reconcile();
    const cloudId = deviceA.service.snapshot().binding?.cloudVaultId as string;
    await deviceB.service.attachRemoteVault(cloudId, LOCAL_B);
    await deviceB.service.reconcile();

    // The clean session predates the remote edit (hazard precondition).
    const session = await workspaceOf(deviceA).openDocument<TestDocModel>(
      ref.documentId,
    );
    expect((session.model as TestDocModel).text).toBe('X');

    await deviceB.observable.write(NOTE, encodeNote('Y'));
    await deviceB.service.reconcile();
    await deviceA.service.reconcile();

    // Without the seam the vault moved to Y but the clean editor still
    // holds X — the exact stale state the reconciler exists to prevent.
    expect(await vaultText(deviceA.vault, NOTE)).toBe('Y');
    expect((session.model as TestDocModel).text).toBe('X');

    // Editing the stale model then silently erases Y (no conflict copy).
    (session.model as { text: string }).text = 'X + stale-edit';
    session.markDirty();
    await session.save();
    await deviceA.service.reconcile();
    expect(await vaultText(deviceA.vault, NOTE)).toBe('X + stale-edit');
    expect(
      (await listAll(deviceA.vault)).filter((path) =>
        path.includes('.conflict-'),
      ),
    ).toEqual([]);

    deviceA.service.dispose();
    deviceB.service.dispose();
  });

  it('makes remotely added and removed documents visible to the workspace', async () => {
    const account = createFakeAccount();
    account.signInAs(UID);
    const remote = new MemorySyncRemote();
    const deviceA = await makeDevice(remote, account.store);
    const deviceB = await makeDevice(remote, account.store, {
      workspace: false,
      localVaultId: LOCAL_B,
    });

    const ref = await workspaceOf(deviceA).createDocument({
      kindId: testNoteKindId,
      path: NOTE,
      initialModel: { title: 'Note', tags: [], text: 'X' },
    });
    await deviceA.service.enable({ localVaultId: LOCAL_A, name: 'A' });
    await deviceA.service.reconcile();
    const cloudId = deviceA.service.snapshot().binding?.cloudVaultId as string;
    await deviceB.service.attachRemoteVault(cloudId, LOCAL_B);
    await deviceB.service.reconcile();
    // B opens its workspace over the pulled bytes (adopts the record).
    await deviceB.createWorkspace();

    // B adds a second document through its own workspace (record + bytes).
    const other = workspacePath('other.md');
    await workspaceOf(deviceB).createDocument({
      kindId: testNoteKindId,
      path: other,
      initialModel: { title: 'Other', tags: [], text: 'O' },
    });
    await deviceB.service.reconcile();

    // A open session on note.md stays clean; the sync adopts the new
    // workspace record and the new file becomes resolvable locally.
    const session = await workspaceOf(deviceA).openDocument<TestDocModel>(
      ref.documentId,
    );
    await deviceA.service.reconcile();
    const found = workspaceOf(deviceA).findByResourcePath(other);
    expect(found).not.toBeNull();
    expect(await vaultText(deviceA.vault, other)).toBe('O');
    expect((session.model as TestDocModel).text).toBe('X');

    // B removes the note through its workspace; A's open clean session
    // closes and the record drops (no dangling session, no stale bytes).
    await workspaceOf(deviceB).removeDocument(
      workspaceOf(deviceB).findByResourcePath(NOTE)?.documentId as never,
    );
    await deviceB.service.reconcile();
    await deviceA.service.reconcile();
    expect(workspaceOf(deviceA).findByResourcePath(NOTE)).toBeNull();
    expect(workspaceOf(deviceA).getOpenDocument(ref.documentId)).toBeNull();
    expect(await listAll(deviceA.vault)).not.toContain('note.md');

    deviceA.service.dispose();
    deviceB.service.dispose();
  });
});
