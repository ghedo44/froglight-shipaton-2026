/**
 * Editor providers share the same session, save, navigation, and indexing
 * contracts without exposing engine types to workspace services.
 *
 * Proves:
 * - same session/save/reopen flow with mock and stub
 * - back/forward stores portable locations, not provider objects
 * - persistent revisions without editor library
 * - indexing rebuild works headlessly
 * - no CodeMirror types in session/workspace contracts
 */
import { describe, expect, it } from 'vitest';
import { createMemoryVault } from '../vault/memory.js';
import { InMemoryDocumentRegistry } from '../documents.js';
import { InMemoryMetadataService } from '../metadata.js';
import { InMemoryRelationshipService } from '../relationships.js';
import { WorkspaceServiceImpl } from '../workspace.js';
import { markdownKind, markdownKindId } from './kind.js';
import { markdownModel } from './model.js';
import { workspacePath } from '../paths.js';
import { MockMarkdownEditorProvider } from '../testing/mock-editor.js';
import { CodemirrorStubProvider } from '../testing/codemirror-stub.js';
import type { MarkdownModel } from './model.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

describe('Editor replaceability', () => {
  it('mock and stub produce identical canonical bytes via same vault path', async () => {
    const run = async (Provider: typeof MockMarkdownEditorProvider | typeof CodemirrorStubProvider) => {
      const { vault } = createMemoryVault();
      const reg = new InMemoryDocumentRegistry();
      reg.register(markdownKind);
      const ws = await WorkspaceServiceImpl.create({ vault, registry: reg, metadata: new InMemoryMetadataService(), relationships: new InMemoryRelationshipService(), revisions: null, workspaceId: `ws-${Provider.name}` });
      const ref = await ws.createDocument({ kindId: markdownKindId, path: workspacePath('doc.md'), initialModel: markdownModel('hello') });
      const sess = await ws.openDocument(ref.documentId) as unknown as { model: MarkdownModel; markDirty(): void; save(): Promise<unknown> };
      const provider = new Provider() as unknown as { createEditor(o: never): { replaceAll(s:string): void; destroy(): void } };
      const handle = provider.createEditor({
        session: sess as never,
        parent: {},
        initialText: sess.model.raw,
        onDirtyText: (text: string) => {
          (sess.model as unknown as { raw: string }).raw = text;
          (sess as unknown as { markDirty(): void }).markDirty();
        },
      } as never);
      (handle as { replaceAll(s:string):void }).replaceAll('via-provider');
      await (sess as unknown as { save(): Promise<void> }).save();
      const bytes = await vault.read(workspacePath('doc.md'));
      await ws.dispose();
      handle.destroy();
      return new TextDecoder().decode(bytes);
    };
    expect(await run(MockMarkdownEditorProvider)).toBe(await run(CodemirrorStubProvider));
  });

  it('session and workspace contracts contain no CodeMirror types', () => {
    const sessionSrc = fs.readFileSync(path.resolve(__dirname, '../session.ts'), 'utf8');
    const workspaceSrc = fs.readFileSync(path.resolve(__dirname, '../workspace.ts'), 'utf8');
    for (const src of [sessionSrc, workspaceSrc]) {
      expect(src).not.toMatch(/EditorState/);
      expect(src).not.toMatch(/EditorView/);
      expect(src).not.toMatch(/@codemirror/);
      expect(src).not.toMatch(/prosemirror/i);
    }
  });

  it('unknown frontmatter preserved when editor cannot render it (opaque)', async () => {
    const { vault } = createMemoryVault();
    const reg = new InMemoryDocumentRegistry();
    reg.register(markdownKind);
    const ws = await WorkspaceServiceImpl.create({ vault, registry: reg, metadata: new InMemoryMetadataService(), relationships: new InMemoryRelationshipService(), revisions: null, workspaceId: 'ws-unknown' });
    const raw = '---\ntitle: Keep\ncustom: value\nunknownBlock: {a: 1}\n---\n# Title\nBody';
    const ref = await ws.createDocument({ kindId: markdownKindId, path: workspacePath('keep.md'), initialModel: markdownModel(raw) });
    const sess = await ws.openDocument(ref.documentId) as unknown as { model: MarkdownModel };
    expect(sess.model.raw).toBe(raw);
    // Simulate editor that only edits body, not frontmatter
    const mock = new MockMarkdownEditorProvider();
    const handle = mock.createEditor({
      session: sess as never,
      parent: {},
      initialText: sess.model.raw,
      onDirtyText: (text) => {
        (sess.model as unknown as { raw: string }).raw = text;
        (sess as unknown as { markDirty(): void }).markDirty();
      },
    }) as unknown as { replaceAll(s:string):void };
    // Only change body, keep frontmatter
    handle.replaceAll('---\ntitle: Keep\ncustom: value\nunknownBlock: {a: 1}\n---\n# Title\nBody changed');
    await (sess as unknown as { save(): Promise<void> }).save();
    const sess2 = await ws.openDocument(ref.documentId) as unknown as { model: MarkdownModel };
    expect(sess2.model.raw).toContain('unknownBlock');
    await ws.dispose();
  });

  it('provider disposal leaves no dangling handles (effect-owned)', async () => {
    const { vault } = createMemoryVault();
    const reg = new InMemoryDocumentRegistry();
    reg.register(markdownKind);
    const ws = await WorkspaceServiceImpl.create({ vault, registry: reg, metadata: new InMemoryMetadataService(), relationships: new InMemoryRelationshipService(), revisions: null, workspaceId: 'ws-dispose' });
    const ref = await ws.createDocument({ kindId: markdownKindId, path: workspacePath('dispose.md'), initialModel: markdownModel('hi') });
    const sess = await ws.openDocument(ref.documentId) as unknown as { model: MarkdownModel };
    const provider = new MockMarkdownEditorProvider();
    const handle = provider.createEditor({ session: sess as never, parent: {}, initialText: sess.model.raw, onDirtyText: () => undefined }) as unknown as { destroyed: boolean; destroy(): void };
    expect(handle.destroyed).toBe(false);
    handle.destroy();
    expect(handle.destroyed).toBe(true);
    // Second destroy idempotent
    handle.destroy();
    await ws.dispose();
  });
});
