/**
 * Persistent revisions are Froglight history, not CodeMirror undo.
 * Also proves revisions survive editor swap and are independent from
 * workspace navigation history.
 */
import { describe, expect, it } from 'vitest';
import { createMemoryVault, createMemoryVaultState } from '../vault/memory.js';
import { InMemoryDocumentRegistry } from '../documents.js';
import { InMemoryMetadataService } from '../metadata.js';
import { InMemoryRelationshipService } from '../relationships.js';
import { InMemoryNavigationService } from '../navigation.js';
import { VaultRevisionService } from '../revisions.js';
import { WorkspaceServiceImpl } from '../workspace.js';
import { markdownKind, markdownKindId } from './kind.js';
import { markdownModel } from './model.js';
import { workspacePath } from '../paths.js';
import { MockMarkdownEditorProvider } from '../testing/mock-editor.js';
import { CodemirrorStubProvider } from '../testing/codemirror-stub.js';
import type { ResourceId } from '../identity.js';
import type { MarkdownModel } from './model.js';

describe('Revision/history separation', () => {
  it('CodeMirror undo does not create revisions; save does; navigation history is separate', async () => {
    const state = createMemoryVaultState();
    const { vault } = createMemoryVault({ state });
    const registry = new InMemoryDocumentRegistry();
    registry.register(markdownKind);
    const metadata = new InMemoryMetadataService();
    const relationships = new InMemoryRelationshipService();
    const navigation = new InMemoryNavigationService();
    let resolver: (id: ResourceId) => ReturnType<typeof workspacePath> | undefined = () => undefined;
    const revisions = new VaultRevisionService({ vault, resolveResource: (id) => resolver(id) });
    const ws = await WorkspaceServiceImpl.create({ vault, registry, metadata, relationships, revisions, workspaceId: 'ws-rev-test' });
    resolver = (id) => {
      try { return ws.resolveResourcePath(id); } catch { return undefined; }
    };

    const ref = await ws.createDocument({ kindId: markdownKindId, path: workspacePath('notes/rev.md'), initialModel: markdownModel('v1') });
    const sess = await ws.openDocument(ref.documentId) as unknown as { model: MarkdownModel; markDirty(): void; save(): Promise<{ revision: { revisionId: string } | null }> ; lastSavedRevision: string | null };

    // Navigation history
    navigation.push({ resourceId: ref.location.resourceId });
    expect(navigation.current?.resourceId).toBe(ref.location.resourceId);

    // Editor edits
    const mock = new MockMarkdownEditorProvider();
    const handle = mock.createEditor({
      session: sess as never,
      parent: {},
      initialText: sess.model.raw,
      onDirtyText: (text) => {
        (sess.model as unknown as { raw: string }).raw = text;
        (sess as unknown as { markDirty(): void }).markDirty();
      },
    }) as unknown as { replaceAll(s: string): void; execCommand(c: 'undo'|'redo'): boolean; getUndoDepth(): number };

    handle.replaceAll('v2');
    expect(handle.getUndoDepth()).toBe(1);
    // Not yet saved → no new revision
    expect(sess.lastSavedRevision).toBeNull();
    // Navigation still at same entry (editor cursor change didn't push)
    expect(navigation.canGoBack).toBe(false);

    await (sess as unknown as { save(): Promise<unknown> }).save();
    const rev1 = sess.lastSavedRevision;
    expect(rev1).not.toBeNull();

    // Editor undo is local
    handle.execCommand('undo');
    expect((sess.model as unknown as MarkdownModel).raw).toBe('v1');
    expect(handle.getUndoDepth()).toBe(0);
    // Revision still points to v2
    expect(sess.lastSavedRevision).toBe(rev1);
    // Reading persistent revision yields v2 bytes
    const revRecord = await revisions.readRevision(rev1!);
    expect(new TextDecoder().decode(revRecord as unknown as Uint8Array)).toBe('v2');

    // Swap provider — revisions and navigation survive
    const stub = new CodemirrorStubProvider();
    const handle2 = stub.createEditor({
      session: sess as never,
      parent: {},
      initialText: sess.model.raw,
      onDirtyText: (text) => {
        (sess.model as unknown as { raw: string }).raw = text;
        (sess as unknown as { markDirty(): void }).markDirty();
      },
    });
    void handle2;
    expect(sess.lastSavedRevision).toBe(rev1);
    expect(navigation.current?.resourceId).toBe(ref.location.resourceId);

    // Restore revision
    await revisions.restoreRevision(rev1!);
    await (sess as unknown as { reload(): Promise<void> }).reload();
    expect((sess.model as unknown as MarkdownModel).raw).toBe('v2');

    await ws.dispose();
  });
});
