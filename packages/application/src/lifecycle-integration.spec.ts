import { describe, expect, it } from 'vitest';
import { createApp } from './index.js';
import {
  InMemorySearchService,
  markdownKindId,
  markdownModel,
  memoryVaultPlugin,
  workspacePath,
  type DocumentSession,
  type MarkdownModel,
} from '@froglight/foundation';
import { MockMarkdownEditorProvider } from '@froglight/foundation/testing';

describe('application lifecycle integration', () => {
  it('injects search into workspace rebuild/post-commit projection and clears it on vault close', async () => {
    const search = new InMemorySearchService();
    const editor = new MockMarkdownEditorProvider();
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      vaultConfig: {},
      searchService: search,
      markdownEditorProvider: editor,
    });
    const workspace = app.getWorkspace();
    expect(workspace).not.toBeNull();
    expect(app.getSearch()).toBe(search);
    expect(app.getDocumentEditor(markdownKindId)).not.toBeNull();

    const ref = await workspace!.createDocument({
      kindId: markdownKindId,
      path: workspacePath('notes/lifecycle.md'),
      initialModel: markdownModel('# Lifecycle\nalpha searchable'),
    });

    expect(
      search.search({ text: 'alpha' }).map((result) => result.documentId),
    ).toEqual([ref.documentId]);
    await workspace!.rebuildDerivedState();
    expect(
      search.search({ text: 'alpha' }).map((result) => result.documentId),
    ).toEqual([ref.documentId]);

    const session = (await workspace!.openDocument(
      ref.documentId,
    )) as DocumentSession<MarkdownModel>;
    (session.model as { raw: string }).raw = '# Lifecycle\nbeta searchable';
    session.markDirty();
    const saved = await session.save();
    expect(saved.committed).toBe(true);
    expect(search.search({ text: 'alpha' })).toHaveLength(0);
    expect(
      search.search({ text: 'beta' }).map((result) => result.documentId),
    ).toEqual([ref.documentId]);

    await app.closeVault();
    expect(app.getWorkspace()).toBeNull();
    expect(search.indexedIds()).toHaveLength(0);
    await app.dispose();
  });
});
