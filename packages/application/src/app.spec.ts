import { describe, expect, it } from 'vitest';
import { createApp } from './index.js';
import {
  InMemorySearchService,
  markdownKindId,
  markdownModel,
  memoryVaultPlugin,
  workspacePath,
} from '@froglight/foundation';
import { MockMarkdownEditorProvider, CodemirrorStubProvider } from '@froglight/foundation/testing';

describe('application — shared composition over the same plugin graph', () => {
  it('creates/opens/edits via editor seam and saves the same canonical bytes', async () => {
    const search = new InMemorySearchService();
    const app = await createApp({ vaultPlugin: memoryVaultPlugin, searchService: search });
    const workspace = app.getWorkspace()!;
    const ref = await workspace.createDocument({
      kindId: markdownKindId,
      path: workspacePath('notes/a.md'),
      initialModel: markdownModel('# Title\nHello'),
    });
    const session = await workspace.openDocument(ref.documentId);
    const markdownSession = session as typeof session & { model: { raw: string } };
    const mock = new MockMarkdownEditorProvider();
    const handle = mock.createEditor({
      session: markdownSession,
      parent: {},
      initialText: markdownSession.model.raw,
      onDirtyText: (text) => {
        markdownSession.model.raw = text;
        markdownSession.markDirty();
      },
    });
    (handle as unknown as { replaceAll(text: string): void }).replaceAll('# Title\nHello World');
    const saved = await markdownSession.save();
    expect(saved.committed).toBe(true);

    const reopened = await workspace.openDocument(ref.documentId);
    expect((reopened.model as { raw: string }).raw).toBe('# Title\nHello World');
    await app.dispose();
  });

  it('swaps the Markdown adapter without changing document/storage contracts', async () => {
    const app1 = await createApp({
      vaultPlugin: memoryVaultPlugin,
      searchService: new InMemorySearchService(),
      markdownEditorProvider: new MockMarkdownEditorProvider(),
    });
    expect(app1.getDocumentEditor(markdownKindId)).not.toBeNull();
    await app1.dispose();

    const app2 = await createApp({
      vaultPlugin: memoryVaultPlugin,
      searchService: new InMemorySearchService(),
      markdownEditorProvider: new CodemirrorStubProvider(),
    });
    expect(app2.getDocumentEditor(markdownKindId)).not.toBeNull();
    await app2.dispose();
  });

  it('delete derived index and rebuild restores search', async () => {
    const search = new InMemorySearchService();
    const app = await createApp({ vaultPlugin: memoryVaultPlugin, searchService: search });
    const workspace = app.getWorkspace()!;
    await workspace.createDocument({
      kindId: markdownKindId,
      path: workspacePath('notes/c.md'),
      initialModel: markdownModel('searchable content'),
    });
    await workspace.rebuildDerivedState();
    expect(search.search({ text: 'searchable' })).toHaveLength(1);
    search.clear();
    expect(search.search({ text: 'searchable' })).toHaveLength(0);
    await workspace.rebuildDerivedState();
    expect(search.search({ text: 'searchable' })).toHaveLength(1);
    await app.dispose();
  });
});
