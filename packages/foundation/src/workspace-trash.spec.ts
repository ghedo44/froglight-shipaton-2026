import { describe, expect, it } from 'vitest';
import { InMemoryDocumentRegistry } from './documents.js';
import { utf8Decode, utf8Encode } from './encoding.js';
import { InMemoryMetadataService } from './metadata.js';
import { workspacePath } from './paths.js';
import { InMemoryRelationshipService } from './relationships.js';
import { resourcePropertyPath } from './resource-properties/provider.js';
import {
  testNoteKind,
  testNoteKindId,
  testNoteModel,
  type TestDocModel,
} from './testing/test-note.js';
import {
  createMemoryVault,
  createMemoryVaultState,
  type MemoryVaultState,
} from './vault/memory.js';
import { WORKSPACE_RECORD_PATH, WorkspaceServiceImpl } from './workspace.js';

function registryWithTestNote(): InMemoryDocumentRegistry {
  const registry = new InMemoryDocumentRegistry();
  registry.register(testNoteKind);
  return registry;
}

async function openWorkspace(
  state: MemoryVaultState,
  registry = registryWithTestNote(),
  clock: () => number = () => 100,
) {
  const { vault } = createMemoryVault({ state });
  const workspace = await WorkspaceServiceImpl.create({
    vault,
    registry,
    metadata: new InMemoryMetadataService(),
    relationships: new InMemoryRelationshipService(),
    revisions: null,
    workspaceId: 'ws-trash',
    clock,
  });
  return { vault, workspace };
}

describe('persisted document trash', () => {
  it('survives reopen and restores identity, opaque content, and sidecars without a provider', async () => {
    const state = createMemoryVaultState();
    const first = await openWorkspace(state);
    const originalPath = workspacePath('notes/keep.note');
    const ref = await first.workspace.createDocument({
      kindId: testNoteKindId,
      path: originalPath,
      initialModel: testNoteModel('Keep me'),
    });
    const originalBytes = await first.vault.read(originalPath);
    const sidecarPath = resourcePropertyPath(ref.location.resourceId);
    await first.vault.createDirectory(workspacePath('.froglight/properties'));
    // Deliberately opaque/corrupt bytes: lifecycle operations must never
    // decode or normalize a provider-owned sidecar.
    const sidecarBytes = utf8Encode('{opaque sidecar bytes');
    await first.vault.write(sidecarPath, sidecarBytes);

    await first.workspace.removeDocument(ref.documentId);
    expect(first.workspace.listDocuments()).toEqual([]);
    expect(first.workspace.listTrashedDocuments()).toMatchObject([
      {
        documentId: ref.documentId,
        resourceId: ref.location.resourceId,
        originalResource: originalPath,
        createdMillis: 100,
        trashedMillis: 100,
      },
    ]);
    await expect(first.vault.read(originalPath)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await first.workspace.dispose();

    const unavailableRegistry = new InMemoryDocumentRegistry();
    const second = await openWorkspace(state, unavailableRegistry);
    const restored = await second.workspace.restoreDocument(ref.documentId);
    expect(restored).toEqual(ref);
    expect(await second.vault.read(originalPath)).toEqual(originalBytes);
    expect(await second.vault.read(sidecarPath)).toEqual(sidecarBytes);
    await expect(
      second.workspace.openDocument(ref.documentId),
    ).rejects.toMatchObject({ code: 'UNKNOWN_DOCUMENT_KIND' });

    unavailableRegistry.register(testNoteKind);
    const session = await second.workspace.openDocument<TestDocModel>(
      ref.documentId,
    );
    expect(session.model.title).toBe('Keep me');
  });

  it('keeps a tombstone on restore collision and supports an alternate path', async () => {
    const state = createMemoryVaultState();
    const { vault, workspace } = await openWorkspace(state);
    const originalPath = workspacePath('notes/collision.note');
    const ref = await workspace.createDocument({
      kindId: testNoteKindId,
      path: originalPath,
      initialModel: testNoteModel('Original'),
    });
    await workspace.trashDocument(ref.documentId);
    await vault.write(originalPath, utf8Encode('replacement'));

    await expect(
      workspace.restoreDocument(ref.documentId),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(workspace.listTrashedDocuments()).toHaveLength(1);
    expect(utf8Decode(await vault.read(originalPath))).toBe('replacement');

    const alternate = workspacePath('notes/restored.note');
    const restored = await workspace.restoreDocument(ref.documentId, alternate);
    expect(restored).toEqual(ref);
    expect(workspace.resolveResourcePath(ref.location.resourceId)).toBe(
      alternate,
    );
  });

  it('requires an explicit permanent delete and removes the opaque sidecar', async () => {
    const state = createMemoryVaultState();
    const { vault, workspace } = await openWorkspace(state);
    const ref = await workspace.createDocument({
      kindId: testNoteKindId,
      path: workspacePath('gone.note'),
      initialModel: testNoteModel('Gone'),
    });
    const sidecarPath = resourcePropertyPath(ref.location.resourceId);
    await vault.createDirectory(workspacePath('.froglight/properties'));
    await vault.write(sidecarPath, utf8Encode('not-json'));
    await workspace.trashDocument(ref.documentId);
    const [tombstone] = workspace.listTrashedDocuments();

    await workspace.permanentlyDeleteDocument(ref.documentId);
    expect(workspace.listTrashedDocuments()).toEqual([]);
    await expect(vault.read(tombstone!.trashedResource)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(vault.read(sidecarPath)).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(
      workspace.permanentlyDeleteDocument(ref.documentId),
    ).rejects.toMatchObject({ code: 'UNKNOWN_DOCUMENT' });
  });

  it('rolls canonical moves back when a tombstone record write fails', async () => {
    const state = createMemoryVaultState();
    let failWorkspaceWrite = false;
    const { vault } = createMemoryVault({
      state,
      fail: (operation, path) =>
        failWorkspaceWrite &&
        operation === 'write' &&
        path === WORKSPACE_RECORD_PATH
          ? new Error('workspace write failed')
          : null,
    });
    const workspace = await WorkspaceServiceImpl.create({
      vault,
      registry: registryWithTestNote(),
      metadata: new InMemoryMetadataService(),
      relationships: new InMemoryRelationshipService(),
      revisions: null,
      workspaceId: 'ws-rollback',
    });
    const path = workspacePath('rollback.note');
    const ref = await workspace.createDocument({
      kindId: testNoteKindId,
      path,
      initialModel: testNoteModel('Rollback'),
    });
    const bytes = await vault.read(path);

    failWorkspaceWrite = true;
    await expect(workspace.trashDocument(ref.documentId)).rejects.toThrow(
      'workspace write failed',
    );
    expect(await vault.read(path)).toEqual(bytes);
    expect(workspace.listDocuments()).toHaveLength(1);
    expect(workspace.listTrashedDocuments()).toEqual([]);

    failWorkspaceWrite = false;
    await workspace.trashDocument(ref.documentId);
    failWorkspaceWrite = true;
    await expect(workspace.restoreDocument(ref.documentId)).rejects.toThrow(
      'workspace write failed',
    );
    await expect(vault.read(path)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(workspace.listDocuments()).toEqual([]);
    expect(workspace.listTrashedDocuments()).toHaveLength(1);
  });

  it('rejects a record missing trash without rewriting it', async () => {
    const state = createMemoryVaultState();
    const { vault } = createMemoryVault({ state });
    await vault.createDirectory(workspacePath('.froglight'));
    const previous = utf8Encode(
      JSON.stringify({
        format: 'froglight.workspace',
        version: 1,
        workspaceId: 'workspace-id',
        documents: [],
        future: { retained: true },
      }),
    );
    await vault.write(WORKSPACE_RECORD_PATH, previous);
    await expect(openWorkspace(state)).rejects.toMatchObject({
      code: 'RECORD_CORRUPT',
    });
    expect(await vault.read(WORKSPACE_RECORD_PATH)).toEqual(previous);
  });

  it('rejects corrupt tombstones without changing workspace or canonical bytes', async () => {
    const state = createMemoryVaultState();
    const { vault } = createMemoryVault({ state });
    await vault.createDirectory(workspacePath('.froglight'));
    await vault.write(workspacePath('keep.note'), utf8Encode('keep'));
    const corrupt = utf8Encode(
      JSON.stringify({
        format: 'froglight.workspace',
        version: 1,
        workspaceId: 'corrupt',
        documents: [],
        trash: [{ documentId: 'missing-required-fields' }],
      }),
    );
    await vault.write(WORKSPACE_RECORD_PATH, corrupt);

    await expect(openWorkspace(state)).rejects.toMatchObject({
      code: 'RECORD_CORRUPT',
    });
    expect(await vault.read(WORKSPACE_RECORD_PATH)).toEqual(corrupt);
    expect(utf8Decode(await vault.read(workspacePath('keep.note')))).toBe(
      'keep',
    );
  });

  it('preserves unknown fields on tombstones during unrelated restores', async () => {
    const state = createMemoryVaultState();
    const first = await openWorkspace(state);
    const one = await first.workspace.createDocument({
      kindId: testNoteKindId,
      path: workspacePath('one.note'),
      initialModel: testNoteModel('One'),
    });
    const two = await first.workspace.createDocument({
      kindId: testNoteKindId,
      path: workspacePath('two.note'),
      initialModel: testNoteModel('Two'),
    });
    await first.workspace.trashDocument(one.documentId);
    await first.workspace.trashDocument(two.documentId);
    await first.workspace.dispose();

    const { vault } = createMemoryVault({ state });
    const record = JSON.parse(
      utf8Decode(await vault.read(WORKSPACE_RECORD_PATH)),
    ) as { trash: Array<Record<string, unknown>> };
    const retained = record.trash.find(
      (entry) => entry.documentId === two.documentId,
    );
    retained!.futureProviderState = { opaque: true };
    await vault.write(
      WORKSPACE_RECORD_PATH,
      utf8Encode(JSON.stringify(record)),
    );

    const reopened = await openWorkspace(state);
    await reopened.workspace.restoreDocument(one.documentId);
    const after = JSON.parse(
      utf8Decode(await reopened.vault.read(WORKSPACE_RECORD_PATH)),
    ) as { trash: Array<Record<string, unknown>> };
    expect(after.trash).toMatchObject([
      { documentId: two.documentId, futureProviderState: { opaque: true } },
    ]);
  });
});
