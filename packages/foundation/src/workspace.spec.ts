/**
 * Tests for the workspace service.
 *
 * The workspace owns document identity, canonical resources, sessions, and
 * derived-state projection. Canonical content lives in
 * vault files; the identity record and derived indexes are derived state.
 */

import { describe, expect, it } from 'vitest';
import { WorkspaceServiceImpl, WORKSPACE_RECORD_PATH } from './workspace.js';
import { createMemoryVault, createMemoryVaultState } from './vault/memory.js';
import { InMemoryDocumentRegistry } from './documents.js';
import { InMemoryMetadataService } from './metadata.js';
import { InMemoryRelationshipService } from './relationships.js';
import { VaultRevisionService } from './revisions.js';
import {
  testNoteKind,
  testNoteKindId,
  testNoteModel,
  type TestDocModel,
} from './testing/test-note.js';
import { documentId, type ResourceId } from './identity.js';
import { joinPath, workspacePath, type WorkspacePath } from './paths.js';
import { utf8Encode } from './encoding.js';
import { FroglightError, isFroglightError } from './errors.js';

type Mutable<T> = { -readonly [P in keyof T]: T[P] };

interface Deps {
  vault: ReturnType<typeof createMemoryVault>['vault'];
  registry: InMemoryDocumentRegistry;
  metadata: InMemoryMetadataService;
  relationships: InMemoryRelationshipService;
  revisions: VaultRevisionService;
  setResolver: (fn: (id: ResourceId) => WorkspacePath | undefined) => void;
}

function makeDeps(
  options: { clock?: () => number; failFlush?: boolean } = {},
): Deps & {
  workspace: () => Promise<WorkspaceServiceImpl>;
  failFlush: (value: boolean) => void;
} {
  let flushFails = options.failFlush ?? false;
  const { vault } = createMemoryVault({
    fail: (op, path) =>
      flushFails && op === 'write' && path === WORKSPACE_RECORD_PATH
        ? new Error('flush boom')
        : null,
  });
  const registry = new InMemoryDocumentRegistry();
  registry.register(testNoteKind);
  const metadata = new InMemoryMetadataService();
  const relationships = new InMemoryRelationshipService();
  let resolver: (id: ResourceId) => WorkspacePath | undefined = () => undefined;
  const revisions = new VaultRevisionService({
    vault,
    resolveResource: (id) => resolver(id),
    clock: options.clock,
  });
  const workspace = WorkspaceServiceImpl.create({
    vault,
    registry,
    metadata,
    relationships,
    revisions,
    workspaceId: 'ws-test',
    clock: options.clock,
  });
  workspace.then((ws) => {
    resolver = (id) => {
      try {
        return ws.resolveResourcePath(id);
      } catch {
        return undefined;
      }
    };
  });
  return {
    vault,
    registry,
    metadata,
    relationships,
    revisions,
    setResolver: (fn) => {
      resolver = fn;
    },
    workspace: () => workspace,
    failFlush: (value) => {
      flushFails = value;
    },
  };
}

async function makeWorkspace(options: { clock?: () => number } = {}) {
  const deps = makeDeps(options);
  const workspace = await deps.workspace();
  return { ...deps, workspace };
}

async function expectRejectsCode(
  promise: Promise<unknown>,
  code: string,
): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

describe('WorkspaceServiceImpl', () => {
  it('creates a workspace record on first run and reopens with the same id', async () => {
    const state = createMemoryVaultState();
    const { vault } = createMemoryVault({ state });
    const registry = new InMemoryDocumentRegistry();
    registry.register(testNoteKind);
    const ws1 = await WorkspaceServiceImpl.create({
      vault,
      registry,
      metadata: new InMemoryMetadataService(),
      relationships: new InMemoryRelationshipService(),
      revisions: null,
      workspaceId: 'ws-stable',
    });
    expect(ws1.workspaceId).toBe('ws-stable');

    // Reopen over the same bytes: same identity, no documents.
    const { vault: vault2 } = createMemoryVault({ state });
    const registry2 = new InMemoryDocumentRegistry();
    registry2.register(testNoteKind);
    const ws2 = await WorkspaceServiceImpl.create({
      vault: vault2,
      registry: registry2,
      metadata: new InMemoryMetadataService(),
      relationships: new InMemoryRelationshipService(),
      revisions: null,
    });
    expect(ws2.workspaceId).toBe('ws-stable');
    expect(ws2.listDocuments()).toEqual([]);
  });

  it('createDocument writes the canonical resource and registers identity', async () => {
    const { vault, workspace } = await makeWorkspace();
    const ref = await workspace.createDocument({
      kindId: testNoteKindId,
      path: workspacePath('notes/hello.md'),
      initialModel: testNoteModel('Hello'),
    });
    expect(typeof ref.documentId).toBe('string');
    expect(ref.documentId.length).toBeGreaterThan(0);
    expect(typeof ref.location.resourceId).toBe('string');
    expect(ref.location.resourceId.length).toBeGreaterThan(0);
    expect(ref.kindId).toBe(testNoteKindId);
    const bytes = await vault.read(workspacePath('notes/hello.md'));
    expect(new TextDecoder().decode(bytes)).toContain('"title":"Hello"');
    expect(
      workspace.findByResourcePath(workspacePath('notes/hello.md')),
    ).toEqual(ref);
    expect(workspace.listDocuments()).toEqual([ref]);
  });

  it('createDocument creates parent directories', async () => {
    const { vault, workspace } = await makeWorkspace();
    await workspace.createDocument({
      kindId: testNoteKindId,
      path: workspacePath('a/b/c.md'),
      initialModel: testNoteModel('Deep'),
    });
    const stat = await vault.stat(workspacePath('a/b'));
    expect(stat.kind).toBe('directory');
  });

  it('does not replace a preexisting untracked file when creating a document', async () => {
    const { vault, workspace } = await makeWorkspace();
    const path = workspacePath('Existing.md');
    const bytes = utf8Encode('canonical content outside the workspace index');
    await vault.write(path, bytes);
    await expectRejectsCode(
      workspace.createDocument({
        kindId: testNoteKindId,
        path,
        initialModel: testNoteModel('New'),
      }),
      'ALREADY_EXISTS',
    );
    expect(await vault.read(path)).toEqual(bytes);
    expect(workspace.listDocuments()).toEqual([]);
  });

  it('serializes concurrent creates targeting the same path', async () => {
    const { vault, workspace } = await makeWorkspace();
    const path = workspacePath('Shared.md');
    const results = await Promise.allSettled([
      workspace.createDocument({
        kindId: testNoteKindId,
        path,
        initialModel: testNoteModel('First'),
      }),
      workspace.createDocument({
        kindId: testNoteKindId,
        path,
        initialModel: testNoteModel('Second'),
      }),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    expect(workspace.listDocuments()).toHaveLength(1);
    expect(await vault.read(path)).toBeDefined();
  });

  it('createDocument with an unknown kind throws UNKNOWN_DOCUMENT_KIND', async () => {
    const { workspace } = await makeWorkspace();
    await expectRejectsCode(
      workspace.createDocument({
        kindId: 'froglight.missing' as never,
        path: workspacePath('x.md'),
        initialModel: testNoteModel('X'),
      }),
      'UNKNOWN_DOCUMENT_KIND',
    );
  });

  it('createDocument rolls the file back when the record flush fails', async () => {
    const { vault, workspace, failFlush } = await makeWorkspace();
    failFlush(true);
    // The injected failure is a plain Error (no `code`), so match by message.
    await expect(
      workspace.createDocument({
        kindId: testNoteKindId,
        path: workspacePath('notes/boom.md'),
        initialModel: testNoteModel('Boom'),
      }),
    ).rejects.toThrow('flush boom');
    // Canonical file removed, no dangling identity.
    await expectRejectsCode(
      vault.read(workspacePath('notes/boom.md')),
      'NOT_FOUND',
    );
    expect(workspace.listDocuments()).toEqual([]);
  });

  it('openDocument decodes content into a session and tracks it', async () => {
    const { workspace } = await makeWorkspace();
    const ref = await workspace.createDocument({
      kindId: testNoteKindId,
      path: workspacePath('notes/a.md'),
      initialModel: testNoteModel('A', 'body'),
    });
    const session = await workspace.openDocument(ref.documentId);
    expect(session.state).toBe('open');
    const model = session.model as TestDocModel;
    expect(model.title).toBe('A');
    expect(model.text).toBe('body');
    await workspace.closeDocument(ref.documentId);
    expect(session.state).toBe('closed');
  });

  it('openDocument projects post-commit state into metadata/relationships', async () => {
    const { metadata, workspace } = await makeWorkspace();
    const ref = await workspace.createDocument({
      kindId: testNoteKindId,
      path: workspacePath('notes/a.md'),
      initialModel: testNoteModel('A'),
    });
    const session = await workspace.openDocument(ref.documentId);
    // Mutate the live model and save; derived metadata must follow.
    const model = session.model as TestDocModel;
    (model as unknown as Mutable<TestDocModel>).title = 'A2';
    session.markDirty();
    await session.save();
    expect(metadata.get(ref.documentId).title).toBe('A2');
  });

  it('openDocument with an unknown document throws UNKNOWN_DOCUMENT', async () => {
    const { workspace } = await makeWorkspace();
    await expectRejectsCode(
      workspace.openDocument(documentId('doc-missing')),
      'UNKNOWN_DOCUMENT',
    );
  });

  it('moveDocument moves the resource and preserves identity', async () => {
    const { vault, workspace } = await makeWorkspace();
    const ref = await workspace.createDocument({
      kindId: testNoteKindId,
      path: workspacePath('notes/old.md'),
      initialModel: testNoteModel('Move me'),
    });
    await workspace.moveDocument(ref.documentId, workspacePath('notes/new.md'));
    expect(workspace.resolveResourcePath(ref.location.resourceId)).toBe(
      'notes/new.md',
    );
    expect(workspace.findByResourcePath(workspacePath('notes/new.md'))).toEqual(
      ref,
    );
    await expectRejectsCode(
      vault.read(workspacePath('notes/old.md')),
      'NOT_FOUND',
    );
    // Identity (documentId + resourceId) survived the move.
    const moved = (await workspace.openDocument(ref.documentId))
      .model as TestDocModel;
    expect(moved.title).toBe('Move me');
  });

  it('moveDocument to the same path is a no-op', async () => {
    const { workspace } = await makeWorkspace();
    const ref = await workspace.createDocument({
      kindId: testNoteKindId,
      path: workspacePath('notes/a.md'),
      initialModel: testNoteModel('A'),
    });
    await workspace.moveDocument(ref.documentId, workspacePath('notes/a.md'));
    expect(workspace.listDocuments()).toHaveLength(1);
  });

  it('moveDocument rolls back the move when the flush fails', async () => {
    const { workspace, failFlush } = await makeWorkspace();
    const ref = await workspace.createDocument({
      kindId: testNoteKindId,
      path: workspacePath('notes/old.md'),
      initialModel: testNoteModel('A'),
    });
    failFlush(true);
    // The injected failure is a plain Error (no `code`), so match by message.
    await expect(
      workspace.moveDocument(ref.documentId, workspacePath('notes/new.md')),
    ).rejects.toThrow('flush boom');
    expect(workspace.resolveResourcePath(ref.location.resourceId)).toBe(
      'notes/old.md',
    );
  });

  it('removeDocument moves the resource and identity to recoverable trash', async () => {
    const { vault, workspace } = await makeWorkspace();
    const ref = await workspace.createDocument({
      kindId: testNoteKindId,
      path: workspacePath('notes/gone.md'),
      initialModel: testNoteModel('Delete me'),
    });
    await workspace.removeDocument(ref.documentId);
    await expectRejectsCode(
      vault.read(workspacePath('notes/gone.md')),
      'NOT_FOUND',
    );
    expect(workspace.listDocuments()).toHaveLength(0);
    expect(workspace.listTrashedDocuments()).toMatchObject([
      { documentId: ref.documentId, resourceId: ref.location.resourceId },
    ]);
    expect(
      workspace.findByResourcePath(workspacePath('notes/gone.md')),
    ).toBeNull();
    await expectRejectsCode(
      workspace.openDocument(ref.documentId),
      'UNKNOWN_DOCUMENT',
    );
  });

  it('removeDocument closes an open session first and clears derived state', async () => {
    const { metadata, relationships, workspace } = await makeWorkspace();
    const ref = await workspace.createDocument({
      kindId: testNoteKindId,
      path: workspacePath('notes/open.md'),
      initialModel: testNoteModel('Open doc'),
    });
    const session = await workspace.openDocument(ref.documentId);
    await workspace.rebuildDerivedState();
    expect(metadata.get(ref.documentId).title).toBe('Open doc');
    await workspace.removeDocument(ref.documentId);
    expect(session.state).toBe('closed');
    await expectRejectsCode(
      Promise.resolve().then(() => metadata.get(ref.documentId)),
      'NOT_FOUND',
    );
    expect(relationships.bySource(ref.location.resourceId)).toHaveLength(0);
  });

  it('removeDocument with an unknown document throws UNKNOWN_DOCUMENT', async () => {
    const { workspace } = await makeWorkspace();
    await expectRejectsCode(
      workspace.removeDocument(documentId('doc-missing')),
      'UNKNOWN_DOCUMENT',
    );
  });

  it('removeDocument persists the tombstone across a provider reopen', async () => {
    const state = createMemoryVaultState();
    const { vault } = createMemoryVault({ state });
    const registry = new InMemoryDocumentRegistry();
    registry.register(testNoteKind);
    const ws1 = await WorkspaceServiceImpl.create({
      vault,
      registry,
      metadata: new InMemoryMetadataService(),
      relationships: new InMemoryRelationshipService(),
      revisions: null,
    });
    const ref = await ws1.createDocument({
      kindId: testNoteKindId,
      path: workspacePath('notes/tmp.md'),
      initialModel: testNoteModel('Temp'),
    });
    await ws1.removeDocument(ref.documentId);
    // Reload from the persisted workspace record.
    const { vault: vault2 } = createMemoryVault({ state });
    const ws2 = await WorkspaceServiceImpl.create({
      vault: vault2,
      registry: new InMemoryDocumentRegistry(),
      metadata: new InMemoryMetadataService(),
      relationships: new InMemoryRelationshipService(),
      revisions: null,
    });
    expect(ws2.listDocuments()).toHaveLength(0);
    expect(ws2.listTrashedDocuments()).toMatchObject([
      { documentId: ref.documentId, resourceId: ref.location.resourceId },
    ]);
  });

  it('resolveResourcePath throws UNKNOWN_RESOURCE for unknown ids', async () => {
    const { workspace } = await makeWorkspace();
    await expectRejectsCode(
      Promise.resolve().then(() =>
        workspace.resolveResourcePath('res-gone' as never),
      ),
      'UNKNOWN_RESOURCE',
    );
  });

  it('listDocuments sorts by documentId', async () => {
    const { workspace } = await makeWorkspace();
    await workspace.createDocument({
      kindId: testNoteKindId,
      path: workspacePath('z.md'),
      initialModel: testNoteModel('Z'),
    });
    await workspace.createDocument({
      kindId: testNoteKindId,
      path: workspacePath('a.md'),
      initialModel: testNoteModel('A'),
    });
    const docs = workspace.listDocuments();
    expect(docs.map((d) => d.documentId).sort()).toEqual(
      docs.map((d) => d.documentId),
    );
    expect(docs).toHaveLength(2);
  });

  it('rebuildDerivedState rebuilds metadata and relationships from canonical content', async () => {
    const { metadata, workspace } = await makeWorkspace();
    const ref = await workspace.createDocument({
      kindId: testNoteKindId,
      path: workspacePath('notes/a.md'),
      initialModel: testNoteModel('A'),
    });
    // Corrupt the derived state, then rebuild.
    metadata.remove(ref.documentId);
    expect(() => metadata.get(ref.documentId)).toThrow();
    await workspace.rebuildDerivedState();
    expect(metadata.get(ref.documentId).title).toBe('A');
  });

  it('notifies only after a derived-state rebuild is complete', async () => {
    const { metadata, workspace } = await makeWorkspace();
    const ref = await workspace.createDocument({
      kindId: testNoteKindId,
      path: workspacePath('notes/a.md'),
      initialModel: testNoteModel('A'),
    });
    let observedTitle: string | null = null;
    const subscription = workspace.onDidUpdateDerivedState?.(() => {
      observedTitle = String(metadata.get(ref.documentId).title);
    });
    metadata.remove(ref.documentId);
    await workspace.rebuildDerivedState();
    expect(observedTitle).toBe('A');
    subscription?.dispose();
  });

  it('rebuildDerivedState reports per-document failures as RECORD_CORRUPT', async () => {
    const { vault, workspace } = await makeWorkspace();
    await workspace.createDocument({
      kindId: testNoteKindId,
      path: workspacePath('notes/a.md'),
      initialModel: testNoteModel('A'),
    });
    // Corrupt the canonical file.
    await vault.write(workspacePath('notes/a.md'), utf8Encode('{not json'));
    try {
      await workspace.rebuildDerivedState();
      expect.unreachable();
    } catch (error) {
      expect(isFroglightError(error)).toBe(true);
      expect((error as FroglightError).code).toBe('RECORD_CORRUPT');
    }
  });

  it('persists across reopen: documents and identity survive a restart', async () => {
    const state = createMemoryVaultState();
    const { vault } = createMemoryVault({ state });
    const registry = new InMemoryDocumentRegistry();
    registry.register(testNoteKind);
    const ws1 = await WorkspaceServiceImpl.create({
      vault,
      registry,
      metadata: new InMemoryMetadataService(),
      relationships: new InMemoryRelationshipService(),
      revisions: null,
      workspaceId: 'ws-persist',
    });
    const ref = await ws1.createDocument({
      kindId: testNoteKindId,
      path: workspacePath('notes/a.md'),
      initialModel: testNoteModel('Persisted'),
    });
    await ws1.dispose();

    // Fresh vault + fresh service over the same bytes.
    const { vault: vault2 } = createMemoryVault({ state });
    const registry2 = new InMemoryDocumentRegistry();
    registry2.register(testNoteKind);
    const ws2 = await WorkspaceServiceImpl.create({
      vault: vault2,
      registry: registry2,
      metadata: new InMemoryMetadataService(),
      relationships: new InMemoryRelationshipService(),
      revisions: null,
    });
    expect(ws2.workspaceId).toBe('ws-persist');
    expect(ws2.listDocuments()).toHaveLength(1);
    expect(ws2.findByResourcePath(workspacePath('notes/a.md'))).toEqual(ref);
    const session = await ws2.openDocument(ref.documentId);
    expect((session.model as TestDocModel).title).toBe('Persisted');
  });

  it('dispose closes open sessions and guards further use (SERVICE_DISPOSED)', async () => {
    const { workspace } = await makeWorkspace();
    const ref = await workspace.createDocument({
      kindId: testNoteKindId,
      path: workspacePath('notes/a.md'),
      initialModel: testNoteModel('A'),
    });
    const session = await workspace.openDocument(ref.documentId);
    await workspace.dispose();
    expect(session.state).toBe('closed');
    await expectRejectsCode(
      workspace.createDocument({
        kindId: testNoteKindId,
        path: workspacePath('notes/b.md'),
        initialModel: testNoteModel('B'),
      }),
      'SERVICE_DISPOSED',
    );
    expect(() => workspace.listDocuments()).toThrowError();
    await workspace.dispose(); // idempotent
  });

  it('canonical bytes remain readable after deleting.froglight derived state', async () => {
    const { vault, workspace } = await makeWorkspace();
    const ref = await workspace.createDocument({
      kindId: testNoteKindId,
      path: workspacePath('notes/a.md'),
      initialModel: testNoteModel('Survives', 'canonical'),
    });
    // Derived state is under .froglight; canonical file is independent.
    async function removeTree(path: WorkspacePath): Promise<void> {
      let stat;
      try {
        stat = await vault.stat(path);
      } catch {
        return;
      }
      if (stat.kind === 'directory') {
        for (const entry of await vault.list(path)) {
          await removeTree(joinPath(path, entry.name));
        }
      }
      try {
        await vault.remove(path);
      } catch {
        // best-effort
      }
    }
    await removeTree(workspacePath('.froglight'));
    await expectRejectsCode(vault.stat(WORKSPACE_RECORD_PATH), 'NOT_FOUND');
    // Canonical resource is still readable — derived state was not the source of truth.
    const canonical = await vault.read(workspacePath('notes/a.md'));
    const decoded = JSON.parse(
      new TextDecoder().decode(canonical),
    ) as TestDocModel;
    expect(decoded.title).toBe('Survives');
    // In-memory workspace still knows the document; listing shows it.
    expect(workspace.listDocuments()).toEqual([ref]);
    // And sessions still open from the same in-memory record.
    const session = await workspace.openDocument(ref.documentId);
    const sessionModel = session.model as TestDocModel;
    expect(sessionModel.title).toBe('Survives');
  });
});
