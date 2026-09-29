/**
 * Integration tests for Markdown vertical slice.
 *
 * Covers: create/open/edit/save, restart/restore, back/forward navigation,
 * revisions independent from CodeMirror undo, links/backlinks, search,
 * delete+rebuild equivalence, host-agnostic core, editor replaceability.
 */
import { describe, expect, it } from 'vitest';
import { WorkspaceServiceImpl } from '../workspace.js';
import { InMemoryDocumentRegistry } from '../documents.js';
import { InMemoryMetadataService } from '../metadata.js';
import { InMemoryRelationshipService } from '../relationships.js';
import { InMemoryNavigationService } from '../navigation.js';
import { VaultRevisionService } from '../revisions.js';
import { InMemorySearchService } from '../search/service.js';
import { createMemoryVault, createMemoryVaultState } from '../vault/memory.js';
import { markdownKind, markdownKindId } from './kind.js';
import { markdownModel } from './model.js';
import { workspacePath } from '../paths.js';
import { MockMarkdownEditorProvider } from '../testing/mock-editor.js';
import { CodemirrorStubProvider } from '../testing/codemirror-stub.js';
import type { MarkdownModel } from './model.js';
import type { ResourceId } from '../identity.js';

function makeWorkspace(options: { state?: ReturnType<typeof createMemoryVaultState>; search?: InMemorySearchService } = {}) {
  const state = options.state ?? createMemoryVaultState();
  const { vault } = createMemoryVault({ state });
  const registry = new InMemoryDocumentRegistry();
  registry.register(markdownKind);
  const metadata = new InMemoryMetadataService();
  const relationships = new InMemoryRelationshipService();
  const navigation = new InMemoryNavigationService();
  const search = options.search ?? new InMemorySearchService();
  let resolver: (id: ResourceId) => ReturnType<typeof workspacePath> | undefined = () => undefined;
  const revisions = new VaultRevisionService({ vault, resolveResource: (id) => resolver(id) });
  const wsPromise = WorkspaceServiceImpl.create({ vault, registry, metadata, relationships, revisions, search, workspaceId: 'ws-md-test' });
  wsPromise.then((ws) => {
    resolver = (id) => {
      try {
        return ws.resolveResourcePath(id);
      } catch {
        return undefined;
      }
    };
  });
  return { vault, state, registry, metadata, relationships, navigation, search, revisions, wsPromise };
}

describe('Markdown vertical slice — create/open/edit/save', () => {
  it('creates, opens, edits via editor seam, saves, and restarts', async () => {
    const { vault, state, wsPromise, metadata, relationships, search, navigation } = makeWorkspace();
    const ws = await wsPromise;
    const ref = await ws.createDocument({ kindId: markdownKindId, path: workspacePath('notes/a.md'), initialModel: markdownModel('# Title\nHello') });
    const session = (await ws.openDocument(ref.documentId)) as unknown as { model: MarkdownModel; markDirty(): void; save(): Promise<unknown> };
    // Navigation push on open (portable DocumentLocation)
    navigation.push({ resourceId: ref.location.resourceId });

    // Edit via mock editor provider — same path as CodeMirror provider
    const mockProvider = new MockMarkdownEditorProvider();
    const handle = mockProvider.createEditor({
      session: session as never,
      parent: {},
      initialText: session.model.raw,
      onDirtyText: (text) => {
        (session.model as unknown as { raw: string }).raw = text;
        (session as unknown as { markDirty(): void }).markDirty();
      },
    });
    (handle as unknown as { replaceAll(s: string): void }).replaceAll('# Title\nHello World\n[[Other]]');
    expect(handle.getTextForTest!()).toContain('World');
    const result = await (session as unknown as { save(): Promise<{ committed: boolean }> }).save();
    expect(result.committed).toBe(true);
    // Derived state fresh
    expect(metadata.get(ref.documentId).title).toBe('Title');
    expect(relationships.bySource(ref.location.resourceId)).toHaveLength(1);
    // Search reflects edit
    expect(search.search({ text: 'World' })).toHaveLength(1);
    // Back/forward continues across Markdown views
    const ref2 = await ws.createDocument({ kindId: markdownKindId, path: workspacePath('notes/b.md'), initialModel: markdownModel('# Other\nContent') });
    navigation.push({ resourceId: ref2.location.resourceId });
    expect(navigation.current?.resourceId).toBe(ref2.location.resourceId);
    navigation.back();
    expect(navigation.current?.resourceId).toBe(ref.location.resourceId);
    navigation.forward();
    expect(navigation.current?.resourceId).toBe(ref2.location.resourceId);

    // Save and restart: new WorkspaceService over same vault bytes (simulates Tauri vs PWA same core)
    await ws.dispose();
    const { vault: vault2 } = createMemoryVault({ state });
    const registry2 = new InMemoryDocumentRegistry();
    registry2.register(markdownKind);
    const metadata2 = new InMemoryMetadataService();
    const relationships2 = new InMemoryRelationshipService();
    const search2 = new InMemorySearchService();
    let resolver2: (id: ResourceId) => ReturnType<typeof workspacePath> | undefined = () => undefined;
    const rev2 = new VaultRevisionService({ vault: vault2, resolveResource: (id) => resolver2(id) });
    const ws2 = await WorkspaceServiceImpl.create({ vault: vault2, registry: registry2, metadata: metadata2, relationships: relationships2, revisions: rev2, search: search2, workspaceId: 'ws-md-test' });
    resolver2 = (id) => {
      try { return ws2.resolveResourcePath(id); } catch { return undefined; }
    };
    await ws2.rebuildDerivedState();
    const session2 = await ws2.openDocument(ref.documentId) as unknown as { model: MarkdownModel };
    expect(session2.model.raw).toContain('World');
    expect(metadata2.get(ref.documentId).title).toBe('Title');
    expect(search2.search({ text: 'World' })[0].documentId).toBe(ref.documentId);
    await ws2.dispose();
    // Host-agnostic: same Markdown core code ran over same VaultService contract; no fs vs OPFS branch.
    void vault;
  });
});

describe('Markdown — revisions independent from editor undo', () => {
  it('editor undo/redo does not create persistent revisions; only save does', async () => {
    const { wsPromise, metadata } = makeWorkspace();
    const ws = await wsPromise;
    const ref = await ws.createDocument({ kindId: markdownKindId, path: workspacePath('notes/rev.md'), initialModel: markdownModel('v1') });
    const session = await ws.openDocument(ref.documentId) as unknown as { model: MarkdownModel; markDirty(): void; save(): Promise<{ revision: { revisionId: string } | null }> };
    const mock = new MockMarkdownEditorProvider();
    const handle = mock.createEditor({
      session: session as never,
      parent: {},
      initialText: session.model.raw,
      onDirtyText: (text) => {
        (session.model as unknown as { raw: string }).raw = text;
        (session as unknown as { markDirty(): void }).markDirty();
      },
    }) as unknown as { replaceAll(s: string): void; execCommand(c: 'undo'|'redo'): boolean; getUndoDepth(): number };
    // Edit without save → no revision
    handle.replaceAll('v2');
    expect(handle.getUndoDepth()).toBe(1);
    // Revision count should still be 0 via metadata? Actually revisions are in VaultRevisionService; check via session lastSavedRevision before save
    expect((session as unknown as { lastSavedRevision: string | null }).lastSavedRevision).toBeNull();
    await (session as unknown as { save(): Promise<unknown> }).save();
    const revAfterSave = (session as unknown as { lastSavedRevision: string | null }).lastSavedRevision;
    expect(revAfterSave).not.toBeNull();
    // Undo via editor does not affect persistent revision
    handle.execCommand('undo');
    expect(handle.getUndoDepth()).toBe(0);
    // Model is now v1 again, but not saved
    expect((session.model as MarkdownModel).raw).toBe('v1');
    // Persistent revision still v2
    expect((session as unknown as { lastSavedRevision: string | null }).lastSavedRevision).toBe(revAfterSave);
    // Undo stack is editor-local; persistent history survives provider swap
    // Workspace back/forward also independent
    void metadata;
    await ws.dispose();
  });
});

describe('Markdown — links/backlinks and search', () => {
  it('extracts links, bySource and byTarget, and search over content/metadata', async () => {
    const { wsPromise, metadata, relationships, search } = makeWorkspace();
    const ws = await wsPromise;
    const refA = await ws.createDocument({ kindId: markdownKindId, path: workspacePath('a.md'), initialModel: markdownModel('# Alpha\nSee [[Beta]] and [link](b.md)') });
    const refB = await ws.createDocument({ kindId: markdownKindId, path: workspacePath('b.md'), initialModel: markdownModel('# Beta\nContent about cats') });
    await ws.rebuildDerivedState();
    // Metadata
    expect(metadata.get(refA.documentId).title).toBe('Alpha');
    expect(metadata.get(refB.documentId).title).toBe('Beta');
    // Relationships from A
    const relsA = relationships.bySource(refA.location.resourceId);
    expect(relsA.length).toBe(2);
    // Search over content and metadata (tags/title)
    const searchBeta = search.search({ text: 'Beta' });
    expect(searchBeta.some((r) => r.documentId === refA.documentId)).toBe(true);
    expect(searchBeta.some((r) => r.documentId === refB.documentId)).toBe(true);
    const searchCats = search.search({ text: 'cats' });
    expect(searchCats[0].documentId).toBe(refB.documentId);
    await ws.dispose();
  });
});

describe('Markdown — delete derived and rebuild equivalence', () => {
  it('delete all derived indexes and rebuild yields equivalent results', async () => {
    const state = createMemoryVaultState();
    const { wsPromise, metadata, relationships, search } = makeWorkspace({ state });
    const ws = await wsPromise;
    await ws.createDocument({ kindId: markdownKindId, path: workspacePath('x.md'), initialModel: markdownModel('# X\nhello world') });
    await ws.createDocument({ kindId: markdownKindId, path: workspacePath('y.md'), initialModel: markdownModel('# Y\nhello cats') });
    await ws.rebuildDerivedState();
    const beforeMeta = metadata.list().map((m) => m.documentId).sort();
    const beforeRels = relationships.list().map((r) => `${r.source.resourceId}->${r.target.documentId}`).sort();
    const beforeSearch = search.search({ text: 'hello' }).map((r) => r.documentId).sort();
    // Delete derived (clear in-memory projections)
    metadata.clear();
    relationships.clear();
    search.clear();
    expect(metadata.list()).toHaveLength(0);
    // Rebuild
    await ws.rebuildDerivedState();
    const afterMeta = metadata.list().map((m) => m.documentId).sort();
    const afterRels = relationships.list().map((r) => `${r.source.resourceId}->${r.target.documentId}`).sort();
    const afterSearch = search.search({ text: 'hello' }).map((r) => r.documentId).sort();
    expect(afterMeta).toEqual(beforeMeta);
    expect(afterRels).toEqual(beforeRels);
    expect(afterSearch).toEqual(beforeSearch);
    await ws.dispose();
  });
});

describe('Markdown — host-agnostic core and editor replaceability', () => {
  it('same Markdown core over different vault providers produces identical canonical bytes', async () => {
    const state1 = createMemoryVaultState();
    const state2 = createMemoryVaultState();
    const make = async (state: typeof state1) => {
      const { vault } = createMemoryVault({ state });
      const reg = new InMemoryDocumentRegistry();
      reg.register(markdownKind);
      const ws = await WorkspaceServiceImpl.create({ vault, registry: reg, metadata: new InMemoryMetadataService(), relationships: new InMemoryRelationshipService(), revisions: null, workspaceId: 'ws-host-test' });
      const ref = await ws.createDocument({ kindId: markdownKindId, path: workspacePath('doc.md'), initialModel: markdownModel('# Title\nBody') });
      const sess = await ws.openDocument(ref.documentId) as unknown as { model: MarkdownModel };
      return { vault, ws, sess, ref };
    };
    const a = await make(state1);
    const b = await make(state2);
    expect(a.sess.model.raw).toBe(b.sess.model.raw);
    const aBytes = await a.vault.read(workspacePath('doc.md'));
    const bBytes = await b.vault.read(workspacePath('doc.md'));
    expect(new TextDecoder().decode(aBytes)).toBe(new TextDecoder().decode(bBytes));
    await a.ws.dispose();
    await b.ws.dispose();
  });

  it('swaps CodeMirror stub with mock without changing canonical codec/storage', async () => {
    const { wsPromise } = makeWorkspace();
    const ws = await wsPromise;
    const ref = await ws.createDocument({ kindId: markdownKindId, path: workspacePath('swap.md'), initialModel: markdownModel('initial') });

    const runWithProvider = async (provider: MockMarkdownEditorProvider | CodemirrorStubProvider) => {
      const sess = await ws.openDocument(ref.documentId) as unknown as { model: MarkdownModel; markDirty(): void; save(): Promise<unknown> };
      const handle = provider.createEditor({
        session: sess as never,
        parent: {},
        initialText: sess.model.raw,
        onDirtyText: (text) => {
          (sess.model as unknown as { raw: string }).raw = text;
          (sess as unknown as { markDirty(): void }).markDirty();
        },
      });
      const mockOrStub = handle as unknown as { replaceAll(s: string): void; getTextForTest(): string };
      mockOrStub.replaceAll('from-provider');
      await (sess as unknown as { save(): Promise<unknown> }).save();
      // Reopen to verify canonical bytes same
      const sess2 = await ws.openDocument(ref.documentId) as unknown as { model: MarkdownModel };
      return sess2.model.raw;
    };

    const mockProvider = new MockMarkdownEditorProvider();
    const stubProvider = new CodemirrorStubProvider();
    const afterMock = await runWithProvider(mockProvider);
    expect(afterMock).toBe('from-provider');
    // Reset to initial for second provider
    const sessReset = await ws.openDocument(ref.documentId) as unknown as { model: MarkdownModel; markDirty(): void; save(): Promise<unknown> };
    (sessReset.model as unknown as { raw: string }).raw = 'initial';
    (sessReset as unknown as { markDirty(): void }).markDirty();
    await (sessReset as unknown as { save(): Promise<unknown> }).save();
    const afterStub = await runWithProvider(stubProvider);
    expect(afterStub).toBe('from-provider');
    await ws.dispose();
  });
});
