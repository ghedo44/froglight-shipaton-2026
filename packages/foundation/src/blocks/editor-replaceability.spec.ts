/**
 * Block-page editor replaceability fixtures (the
 *  Markdown acceptance): two internally different providers over
 * one seam must leave canonical bytes, sessions, and derived state
 * unchanged, and unknown plugin content must survive editing verbatim.
 */

import { describe, expect, it } from 'vitest';
import { WorkspaceServiceImpl } from '../workspace.js';
import { InMemoryDocumentRegistry } from '../documents.js';
import { InMemoryMetadataService } from '../metadata.js';
import { InMemoryRelationshipService } from '../relationships.js';
import { VaultRevisionService } from '../revisions.js';
import { createMemoryVault } from '../vault/memory.js';
import { utf8Decode } from '../encoding.js';
import type { ResourceId } from '../identity.js';
import type { WorkspacePath } from '../paths.js';
import { blockPageKind, blockPageKindId } from './kind.js';
import { emptyBlockPage, headingBlock, type BlockPageModel } from './model.js';
import { MockBlockPageEditorProvider } from '../testing/mock-block-editor.js';
import { TiptapStubProvider } from '../testing/tiptap-stub.js';
import type { DocumentSession } from '../session.js';

type ProviderEntry = readonly [name: string, provider: MockBlockPageEditorProvider | TiptapStubProvider];

const providers: readonly ProviderEntry[] = [
  ['mock', new MockBlockPageEditorProvider()],
  ['tiptap-stub', new TiptapStubProvider()],
] as const;

function makeWorkspace() {
  const { vault } = createMemoryVault();
  const registry = new InMemoryDocumentRegistry();
  registry.register(blockPageKind);
  const revisions = new VaultRevisionService({ vault, resolveResource: () => undefined });
  return WorkspaceServiceImpl.create({
    vault,
    registry,
    metadata: new InMemoryMetadataService(),
    relationships: new InMemoryRelationshipService(),
    revisions,
    workspaceId: 'ws-block-editor-test',
  });
}

function modelWithOpaqueBlock(): BlockPageModel {
  const model = emptyBlockPage();
  model.rootOrder = ['h1', 'x1'];
  model.blocks = {
    h1: headingBlock('h1', 1, [{ text: 'Title' }]),
    x1: { id: 'x1', type: 'acme.callout', tone: 'loud', payload: { nested: [1, 2] } },
  };
  return model;
}

async function createDoc(ws: Awaited<ReturnType<typeof makeWorkspace>>, name: string) {
  const ref = await ws.createDocument({
    kindId: blockPageKindId,
    path: `pages/${name}.blockpage` as WorkspacePath,
    initialModel: modelWithOpaqueBlock(),
  });
  return await ws.openDocument<BlockPageModel>(ref.documentId);
}

/** The native edit each concrete handle exposes, applied via its own API. */
function applyNativeEdit(handle: object): void {
  if ('appendParagraph' in handle) {
    (handle as { appendParagraph(text: string): void }).appendParagraph('after');
  } else {
    (handle as { prependParagraph(text: string): void }).prependParagraph('before');
  }
}

/**
 * Bind a provider to a live session exactly the way the application
 * adapter does, apply the native edit, and return the bound handle.
 */
function bindAndEdit(
  entry: ProviderEntry,
  session: DocumentSession<BlockPageModel>,
): { execCommand(id: 'undo' | 'redo'): boolean } {
  const [, provider] = entry;
  const handle = provider.createEditor({
    session,
    parent: {},
    initialModel: session.model,
    onDirtyModel: (model) => {
      Object.assign(session.model as object, model);
      session.markDirty();
    },
  });
  applyNativeEdit(handle);
  return handle;
}

describe('block page editor replaceability', () => {
  for (const entry of providers) {
    const [name] = entry;

    it(`[${name}] unknown plugin blocks survive edit→save→reopen verbatim`, async () => {
      const ws = await makeWorkspace();
      const session = await createDoc(ws, `survive-${name}`);
      bindAndEdit(entry, session);
      const result = await session.save();
      expect(result.committed).toBe(true);

      // Reopen from canonical bytes: the opaque payload is untouched.
      const ref = ws.listDocuments()[0]!;
      const reopened = await ws.openDocument<BlockPageModel>(ref.documentId);
      expect(reopened.model.blocks.x1).toEqual(modelWithOpaqueBlock().blocks.x1);
    });
  }

  it('undo converges both providers to the original canonical bytes', async () => {
    const initial = modelWithOpaqueBlock();
    // Independent source of truth: the documented serialization of the
    // original document, never a re-computation from either provider.
    const expected = `${JSON.stringify(initial, null, 2)}\n`;

    for (const entry of providers) {
      const [name] = entry;
      const ws = await makeWorkspace();
      const session = await createDoc(ws, `converge-${name}`);
      const handle = bindAndEdit(entry, session);

      expect(handle.execCommand('undo')).toBe(true);
      expect(session.model).toEqual(initial);

      await session.save();
      expect(utf8Decode(blockPageKind.encode(session.model, {
        documentId: 'd' as never,
        kindId: blockPageKindId,
        location: { resourceId: 'r' as ResourceId },
      }))).toBe(expected);
    }
  });

  it('[mock] destroyed handles stop emitting dirty updates', async () => {
    const ws = await makeWorkspace();
    const session = await createDoc(ws, 'destroy');
    let dirtyCalls = 0;
    const handle = new MockBlockPageEditorProvider().createEditor({
      session,
      parent: {},
      initialModel: emptyBlockPage(),
      onDirtyModel: () => {
        dirtyCalls++;
      },
    });
    handle.destroy();
    const native = handle as unknown as { appendParagraph(t: string): void };
    expect(() => native.appendParagraph('x')).toThrowError();
    expect(dirtyCalls).toBe(0);
  });
});
