import { describe, expect, it } from 'vitest';
import { emptyBlockPage } from './blocks/model.js';
import { blockPageKind } from './blocks/kind.js';
import { databaseKind } from './databases/kind.js';
import { createDatabase } from './databases/model.js';
import { updateDocumentTitle } from './document-titles.js';
import { InMemoryDocumentRegistry } from './documents.js';
import { InMemoryMetadataService } from './metadata.js';
import { markdownKind } from './markdown/kind.js';
import { notebookKind } from './notebooks/kind.js';
import { emptyNotebook } from './notebooks/model.js';
import { workspacePath } from './paths.js';
import { pdfKind } from './pdf/kind.js';
import { InMemoryRelationshipService } from './relationships.js';
import { emptySurface, infiniteFrame } from './surfaces/model.js';
import { inkPageKind } from './surfaces/kind.js';
import { createMemoryVault } from './vault/memory.js';
import type { VaultFailureInjector } from './vault/memory.js';
import { whiteboardKind } from './whiteboard/kind.js';
import { WorkspaceServiceImpl } from './workspace.js';

async function fixture(fail?: VaultFailureInjector) {
  const { vault } = createMemoryVault({ fail });
  const documents = new InMemoryDocumentRegistry();
  documents.register(markdownKind);
  documents.register(blockPageKind);
  documents.register(notebookKind);
  documents.register(whiteboardKind);
  documents.register(inkPageKind);
  documents.register(databaseKind);
  documents.register(pdfKind);
  const metadata = new InMemoryMetadataService();
  const workspace = await WorkspaceServiceImpl.create({
    vault,
    registry: documents,
    metadata,
    relationships: new InMemoryRelationshipService(),
    revisions: null,
  });
  return { vault, documents, metadata, workspace };
}

describe('provider-owned document titles', () => {
  it('updates Markdown title metadata without changing its body or filename', async () => {
    const env = await fixture();
    const ref = await env.workspace.createDocument({
      kindId: markdownKind.id,
      path: workspacePath('original.md'),
      initialModel: {
        raw: '---\ntags: ["kept"]\ncustom: 7\n---\n# Content heading\n\nBody\n',
      },
    });

    const result = await updateDocumentTitle({
      workspace: env.workspace,
      documents: env.documents,
      documentId: ref.documentId,
      title: 'Catalog title',
    });

    expect(result).toMatchObject({ committed: true, error: null });
    expect(env.workspace.resolveResourcePath(ref.location.resourceId)).toBe(
      'original.md',
    );
    const reopened = await env.workspace.openDocument<{ raw: string }>(
      ref.documentId,
    );
    expect(reopened.model.raw).toBe(
      '---\ntitle: "Catalog title"\ntags: ["kept"]\ncustom: 7\n---\n# Content heading\n\nBody\n',
    );
    expect(env.metadata.get(ref.documentId)?.title).toBe('Catalog title');
  });

  it('preserves provider content while updating structured titles', () => {
    const block = emptyBlockPage({ title: 'Old', custom: 'kept' });
    blockPageKind.documentTitle!.write(block, 'New', {} as never);
    expect(block.meta).toEqual({ title: 'New', custom: 'kept' });

    const notebook = emptyNotebook('Old');
    notebook.meta.custom = 'kept';
    notebookKind.documentTitle!.write(notebook, 'New', {} as never);
    expect(notebook.meta).toMatchObject({ title: 'New', custom: 'kept' });

    const board = emptySurface(infiniteFrame());
    board.unknownFields = { plugin: 4, meta: { tags: ['kept'] } };
    whiteboardKind.documentTitle!.write(board, 'New', {} as never);
    expect(board.unknownFields).toEqual({
      plugin: 4,
      meta: { tags: ['kept'], title: 'New' },
    });

    const ink = emptySurface(infiniteFrame());
    ink.unknownFields = { plugin: 4 };
    inkPageKind.documentTitle!.write(ink, 'New', {} as never);
    expect(ink.unknownFields).toEqual({
      plugin: 4,
      meta: { title: 'New' },
    });

    const database = createDatabase('Old');
    databaseKind.documentTitle!.write(database, 'New', {} as never);
    expect(database.title).toBe('New');
  });

  it('closes and discards a retained title edit when retry is abandoned', async () => {
    let failWrites = false;
    const env = await fixture((operation) =>
      operation === 'write' && failWrites
        ? new Error('temporary write failure')
        : null,
    );
    const ref = await env.workspace.createDocument({
      kindId: markdownKind.id,
      path: workspacePath('discard.md'),
      initialModel: { raw: '# Stored\n' },
    });
    failWrites = true;

    const result = await updateDocumentTitle({
      workspace: env.workspace,
      documents: env.documents,
      documentId: ref.documentId,
      title: 'Uncommitted title',
    });

    expect(result.committed).toBe(false);
    expect(env.workspace.getOpenDocument(ref.documentId)?.dirty).toBe(true);
    await result.discard();
    await result.discard();
    expect(env.workspace.getOpenDocument(ref.documentId)).toBeNull();
    await expect(result.retry()).rejects.toThrow('discarded');
    failWrites = false;
    const reopened = await env.workspace.openDocument<{ raw: string }>(
      ref.documentId,
    );
    expect(reopened.model.raw).toBe('# Stored\n');
  });

  it('refuses open and unsupported documents instead of overwriting them', async () => {
    const env = await fixture();
    const note = await env.workspace.createDocument({
      kindId: markdownKind.id,
      path: workspacePath('open.md'),
      initialModel: { raw: '# Open\n' },
    });
    const open = await env.workspace.openDocument<{ raw: string }>(
      note.documentId,
    );
    open.model.raw = '# Unsaved\n';
    open.markDirty();
    await expect(
      updateDocumentTitle({
        workspace: env.workspace,
        documents: env.documents,
        documentId: note.documentId,
        title: 'Replacement',
      }),
    ).rejects.toMatchObject({
      reason: 'dirty-document',
    });
    expect(open.model.raw).toBe('# Unsaved\n');

    const pdf = await env.workspace.createDocument({
      kindId: pdfKind.id,
      path: workspacePath('paper.pdf'),
      initialModel: { bytes: new Uint8Array([37, 80, 68, 70]) },
    });
    await expect(
      updateDocumentTitle({
        workspace: env.workspace,
        documents: env.documents,
        documentId: pdf.documentId,
        title: 'Paper',
      }),
    ).rejects.toMatchObject({
      reason: 'unsupported-kind',
    });
  });
});
