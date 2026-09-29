import { describe, expect, it } from 'vitest';
import { createApp } from './index.js';
import { createWorkspaceResourceResolver } from './resource-resolver.js';
import {
  InMemorySearchService,
  blockPageKind,
  blockPageKindId,
  emptyBlockPage,
  markdownKind,
  markdownKindId,
  markdownModel,
  memoryVaultPlugin,
  paragraphBlock,
  workspacePath,
  type BlockPageEditorProvider,
  type BlockPageModel,
  type ResourceResolver,
} from '@froglight/foundation';
import { MockBlockPageEditorProvider } from '@froglight/foundation/testing';

async function createAppWithCapturedResolver(
  additionalResolver?: ResourceResolver,
) {
  const holder: { current: ResourceResolver | null } = { current: null };
  const recording: BlockPageEditorProvider = {
    createEditor(input) {
      holder.current = input.resourceResolver ?? null;
      return new MockBlockPageEditorProvider().createEditor(input);
    },
  };
  const app = await createApp({
    vaultPlugin: memoryVaultPlugin,
    searchService: new InMemorySearchService(),
    documentKinds: [markdownKind, blockPageKind],
    blockPageEditorProvider: recording,
    ...(additionalResolver !== undefined ? { resourceResolver: additionalResolver } : {}),
  });
  const workspace = app.getWorkspace()!;
  const markdownRef = await workspace.createDocument({
    kindId: markdownKindId,
    path: workspacePath('notes/guide.md'),
    initialModel: markdownModel('# Guide\n## Getting Started\nBody'),
  });
  const blockModel = emptyBlockPage({ title: 'Blocks' });
  blockModel.rootOrder = ['b1'];
  blockModel.blocks.b1 = paragraphBlock('b1', [{ text: 'hello block' }]);
  const blockRef = await workspace.createDocument({
    kindId: blockPageKindId,
    path: workspacePath('pages/blocks.blockpage'),
    initialModel: blockModel,
  });
  // Force adapter creation so the resolver is captured.
  const session = await workspace.openDocument<BlockPageModel>(blockRef.documentId);
  app.getDocumentEditor(blockPageKindId)!.createEditor({ session, parent: {} });
  await session.close();
  if (holder.current === null) throw new Error('resource resolver was not captured');
  return { app, workspace, markdownRef, blockRef, resolver: holder.current as ResourceResolver };
}

describe('resource-resolver contracts', () => {
  it('suggests workspace paths matching the needle', async () => {
    const { app, resolver } = await createAppWithCapturedResolver();
    const hits = await resolver.search('guide');
    expect(hits.map((hit) => hit.label)).toContain('notes/guide.md');
    expect(hits.map((hit) => hit.label)).not.toContain('pages/blocks.blockpage');
    await app.dispose();
  });

  it('returns every path for an empty query', async () => {
    const { app, resolver } = await createAppWithCapturedResolver();
    const hits = await resolver.search('   ');
    const labels = hits.map((hit) => hit.label).sort();
    expect(labels).toEqual(['notes/guide.md', 'pages/blocks.blockpage']);
    await app.dispose();
  });

  it('enriches Markdown suggestions with heading addresses', async () => {
    const { app, resolver } = await createAppWithCapturedResolver();
    const hits = await resolver.search('guide');
    const markdown = hits.find((hit) => hit.label === 'notes/guide.md');
    expect(markdown?.addresses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ address: 'guide', label: 'Guide' }),
        expect.objectContaining({ address: 'getting-started', label: 'Getting Started' }),
      ]),
    );
    await app.dispose();
  });

  it('enriches Block Page suggestions with block addresses', async () => {
    const { app, resolver } = await createAppWithCapturedResolver();
    const hits = await resolver.search('blocks');
    const block = hits.find((hit) => hit.label === 'pages/blocks.blockpage');
    expect(block?.addresses).toEqual(
      expect.arrayContaining([expect.objectContaining({ address: 'b1', label: 'hello block' })]),
    );
    await app.dispose();
  });

  it('merges additional-resolver hits after workspace hits', async () => {
    const additional: ResourceResolver = {
      async search() {
        return [
          {
            target: {
              documentId: 'external-1',
              kindId: markdownKindId,
              resourceId: 'external-1',
            },
            label: 'External Hit',
          },
        ];
      },
    };
    const { app, resolver } = await createAppWithCapturedResolver(additional);
    const hits = await resolver.search('guide');
    // Workspace hit comes first, additional external hit is appended.
    expect(hits[0]?.label).toBe('notes/guide.md');
    expect(hits.map((hit) => hit.label)).toContain('External Hit');
    await app.dispose();
  });

  it('dedups overlapping workspace and additional hits by document and resource', async () => {
    const holder: { current: ResourceResolver | null } = { current: null };
    const recording: BlockPageEditorProvider = {
      createEditor(input) {
        holder.current = input.resourceResolver ?? null;
        return new MockBlockPageEditorProvider().createEditor(input);
      },
    };
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      searchService: new InMemorySearchService(),
      documentKinds: [markdownKind, blockPageKind],
      blockPageEditorProvider: recording,
    });
    const workspace = app.getWorkspace()!;
    const markdownRef = await workspace.createDocument({
      kindId: markdownKindId,
      path: workspacePath('notes/guide.md'),
      initialModel: markdownModel('# Guide\nBody'),
    });
    const blockRef = await workspace.createDocument({
      kindId: blockPageKindId,
      path: workspacePath('pages/blocks.blockpage'),
      initialModel: emptyBlockPage({ title: 'Blocks' }),
    });
    const session = await workspace.openDocument<BlockPageModel>(blockRef.documentId);
    app.getDocumentEditor(blockPageKindId)!.createEditor({ session, parent: {} });
    await session.close();
    if (holder.current === null) throw new Error('resolver not captured');

    // Resolve through the app's configured additional resolver path by
    // composing a workspace resolver with an overlapping additional hit.
    const overlapping: ResourceResolver = {
      async search() {
        return [
          {
            target: {
              documentId: String(markdownRef.documentId),
              kindId: String(markdownKindId),
              resourceId: String(markdownRef.location.resourceId),
            },
            label: 'Overridden Label',
          },
        ];
      },
    };
    const composed = createWorkspaceResourceResolver({
      getWorkspace: () => app.getWorkspace(),
      additionalResolver: overlapping,
    });
    const hits = await composed.search('guide');
    const matches = hits.filter(
      (hit) => String(hit.target.documentId) === String(markdownRef.documentId),
    );
    expect(matches).toHaveLength(1);
    expect(matches[0]?.label).toBe('Overridden Label');
    // Workspace enrichment (heading addresses) survives the override merge.
    expect(matches[0]?.addresses).toEqual(
      expect.arrayContaining([expect.objectContaining({ address: 'guide' })]),
    );
    await app.dispose();
  });

  it('returns only additional hits when the workspace is unavailable', async () => {
    const additional: ResourceResolver = {
      async search() {
        return [
          {
            target: { documentId: 'a', kindId: 'k', resourceId: 'r' },
            label: 'Additional Only',
          },
        ];
      },
    };
    const resolver = createWorkspaceResourceResolver({
      getWorkspace: () => null,
      additionalResolver: additional,
    });
    await expect(resolver.search('anything')).resolves.toEqual([
      {
        target: { documentId: 'a', kindId: 'k', resourceId: 'r' },
        label: 'Additional Only',
      },
    ]);
  });

  it('reads the active workspace per search', async () => {
    const first = await createApp({
      vaultPlugin: memoryVaultPlugin,
      documentKinds: [markdownKind],
    });
    const second = await createApp({
      vaultPlugin: memoryVaultPlugin,
      documentKinds: [markdownKind],
    });
    let active: 'first' | 'second' = 'first';
    const resolver = createWorkspaceResourceResolver({
      getWorkspace: () =>
        active === 'first' ? first.getWorkspace() : second.getWorkspace(),
    });
    await first.getWorkspace()!.createDocument({
      kindId: markdownKindId,
      path: workspacePath('notes/first.md'),
      initialModel: markdownModel('first'),
    });
    await second.getWorkspace()!.createDocument({
      kindId: markdownKindId,
      path: workspacePath('notes/second.md'),
      initialModel: markdownModel('second'),
    });
    active = 'first';
    await expect(resolver.search('')).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'notes/first.md' })]),
    );
    active = 'second';
    await expect(resolver.search('')).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'notes/second.md' })]),
    );
    await first.dispose();
    await second.dispose();
  });
});
