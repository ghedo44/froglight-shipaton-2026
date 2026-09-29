// @vitest-environment jsdom
/**
 *  composition-root tests: whiteboards flow through the same
 * workspace/session/persistence path, and the whiteboard editor is
 * demonstrably replaceable at the generic registry seam (spec #52).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './index.js';
import { WhiteboardDocumentEditorProvider } from '@froglight/editor-whiteboard';
import {
  InMemorySearchService,
  emptySurface,
  infiniteFrame,
  markdownKind,
  memoryVaultPlugin,
  whiteboardKind,
  whiteboardKindId,
  workspacePath,
  type SurfaceModel,
} from '@froglight/foundation';
import {
  MockWhiteboardEditorProvider,
  type MockWhiteboardEditorHandle,
  installCanvasStub,
} from '@froglight/foundation/testing';

type WhiteboardApp = Awaited<ReturnType<typeof createApp>>;

/** One mock-wired composition per test; the caller owns disposal. */
async function setupWhiteboardApp(
  documentKinds: Parameters<typeof createApp>[0]['documentKinds'] = [
    whiteboardKind,
  ],
): Promise<{ app: WhiteboardApp; search: InMemorySearchService }> {
  const search = new InMemorySearchService();
  const app = await createApp({
    vaultPlugin: memoryVaultPlugin,
    searchService: search,
    documentKinds,
    documentEditorProviders: [new MockWhiteboardEditorProvider()],
  });
  return { app, search };
}

describe('application — whiteboard vertical slice', () => {
  let restoreCanvas: (() => void) | null = null;

  beforeEach(() => {
    restoreCanvas = installCanvasStub();
  });

  afterEach(() => {
    restoreCanvas?.();
    restoreCanvas = null;
    document.body.replaceChildren();
  });

  it('creates/opens/edits/saves a whiteboard through the shared composition', async () => {
    const { app, search } = await setupWhiteboardApp([
      markdownKind,
      whiteboardKind,
    ]);
    const workspace = app.getWorkspace()!;

    // The whiteboard editor resolves through the generic registry seam.
    const provider = app.getDocumentEditor(whiteboardKindId);
    expect(provider?.id).toBe('mock-whiteboard');

    const seed = emptySurface(infiniteFrame());
    seed.objects.t1 = {
      id: 't1',
      type: 'froglight.text',
      x: 5,
      y: 5,
      text: 'board label',
    };
    seed.order.push('t1');
    const ref = await workspace.createDocument({
      kindId: whiteboardKindId,
      path: workspacePath('boards/ideas.whiteboard'),
      initialModel: seed,
    });
    await workspace.rebuildDerivedState();

    const session = await workspace.openDocument<SurfaceModel>(ref.documentId);
    const handle = provider!.createEditor({
      session,
      parent: {},
    }) as MockWhiteboardEditorHandle;
    handle.addStroke(10, 10);
    const saved = await session.save();
    expect(saved.committed).toBe(true);

    // Search still sees the surface text projection after the edit.
    expect(search.search({ text: 'board' })).toHaveLength(1);

    // The stroke and unknown-safe text object survive save/reopen.
    const reopened = await workspace.openDocument<SurfaceModel>(ref.documentId);
    const model = reopened.model;
    expect(model.order).toEqual(['t1', 'mock-stroke-1']);
    expect((model.objects['t1'] as { text?: string }).text).toBe('board label');
    await app.dispose();
  });

  it('speaks the provider-neutral tools seam without the canvas engine', async () => {
    const { app } = await setupWhiteboardApp();
    const workspace = app.getWorkspace()!;
    const ref = await workspace.createDocument({
      kindId: whiteboardKindId,
      path: workspacePath('boards/tools.whiteboard'),
      initialModel: emptySurface(infiniteFrame()),
    });
    const session = await workspace.openDocument<SurfaceModel>(ref.documentId);
    const handle = app
      .getDocumentEditor(whiteboardKindId)!
      .createEditor({ session, parent: {} });
    const tools = handle.tools!;
    expect(tools.snapshot().context).toBe('Whiteboard');
    let notifications = 0;
    const subscription = tools.onDidChange(() => {
      notifications += 1;
    });
    expect(tools.execute('whiteboard.tool.pen')).toBe(true);
    expect(tools.execute('whiteboard.zoom-in')).toBe(true);
    expect(notifications).toBe(2);
    expect(
      tools.snapshot().controls.find(
        (control) => (control as { id: string }).id === 'whiteboard.tool.pen',
      ),
    ).toMatchObject({ active: true });
    expect(tools.execute('whiteboard.tool.arrow')).toBe(false);
    subscription.dispose();
    handle.destroy();
    await app.dispose();
  });

  it('swaps the whiteboard adapter without changing canonical contracts', async () => {
    for (const provider of [
      new MockWhiteboardEditorProvider(),
      new MockWhiteboardEditorProvider(),
    ]) {
      const app = await createApp({
        vaultPlugin: memoryVaultPlugin,
        searchService: new InMemorySearchService(),
        documentKinds: [whiteboardKind],
        documentEditorProviders: [provider],
      });
      expect(app.getDocumentEditor(whiteboardKindId)).not.toBeNull();
      await app.dispose();
    }
  });

  it('opens mock-saved bytes through the production provider unchanged', async () => {
    const { app } = await setupWhiteboardApp();
    const workspace = app.getWorkspace()!;
    const ref = await workspace.createDocument({
      kindId: whiteboardKindId,
      path: workspacePath('boards/swap.whiteboard'),
      initialModel: emptySurface(infiniteFrame()),
    });

    // Edit through the alternate provider and persist.
    const mockSession =
      await workspace.openDocument<SurfaceModel>(ref.documentId);
    const mockHandle = app
      .getDocumentEditor(whiteboardKindId)!
      .createEditor({ session: mockSession, parent: {} });
    (mockHandle as MockWhiteboardEditorHandle).addStroke(4, 4);
    expect((await mockSession.save()).committed).toBe(true);
    const mockIds = mockHandle
      .tools!.snapshot()
      .controls.map((control) => (control as { id: string }).id);
    mockHandle.destroy();

    // The production Canvas provider opens the same canonical bytes: same
    // objects, same toolbar dialect, same tools seam.
    const prodSession =
      await workspace.openDocument<SurfaceModel>(ref.documentId);
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const prodHandle = new WhiteboardDocumentEditorProvider().createEditor({
      session: prodSession,
      parent,
    });
    try {
      expect(prodSession.model.order).toEqual(['mock-stroke-1']);
      const prodTools = prodHandle.tools!;
      expect(prodTools.snapshot().context).toBe('Whiteboard');
      const prodIds = prodTools
        .snapshot()
        .controls.map((control) => (control as { id: string }).id);
      for (const id of mockIds) {
        expect(prodIds).toContain(id);
      }
      expect(prodTools.execute('whiteboard.tool.pen')).toBe(true);
    } finally {
      prodHandle.destroy();
    }
    await app.dispose();
  });
});
