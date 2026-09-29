/**
 *  composition-root tests: ink pages flow through the same
 * workspace/session/persistence path, and the ink editor is demonstrably
 * replaceable at the generic registry seam.
 */

import { describe, expect, it } from 'vitest';
import { createApp } from './index.js';
import {
  InMemorySearchService,
  boundedFrame,
  emptySurface,
  infiniteFrame,
  inkPageKind,
  inkPageKindId,
  markdownKind,
  memoryVaultPlugin,
  whiteboardKind,
  whiteboardKindId,
  workspacePath,
  type DocumentAssetStore,
  type DocumentEditorProvider,
  type SurfaceModel,
} from '@froglight/foundation';
import {
  MockInkEditorProvider,
  type MockInkEditorHandle,
} from '@froglight/foundation/testing';

describe('application — ink page vertical slice', () => {
  it('creates/opens/edits/saves an ink page through the shared composition', async () => {
    const search = new InMemorySearchService();
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      searchService: search,
      documentKinds: [markdownKind, inkPageKind],
      documentEditorProviders: [new MockInkEditorProvider()],
    });
    const workspace = app.getWorkspace()!;

    // The ink editor resolves through the generic registry seam.
    const provider = app.getDocumentEditor(inkPageKindId);
    expect(provider?.id).toBe('mock-ink');

    const seed = emptySurface(boundedFrame(800, 600));
    seed.objects.t1 = { id: 't1', type: 'froglight.text', x: 5, y: 5, text: 'diagram label' };
    seed.order.push('t1');
    const ref = await workspace.createDocument({
      kindId: inkPageKindId,
      path: workspacePath('sketches/page.ink'),
      initialModel: seed,
    });
    await workspace.rebuildDerivedState();

    const session = await workspace.openDocument<SurfaceModel>(ref.documentId);
    const handle = provider!.createEditor({ session, parent: {} }) as MockInkEditorHandle;
    handle.addStroke(10, 10);
    const saved = await session.save();
    expect(saved.committed).toBe(true);

    // Search still sees the surface text projection after the edit.
    expect(search.search({ text: 'diagram' })).toHaveLength(1);

    // The stroke and unknown-safe text object survive save/reopen.
    const reopened = await workspace.openDocument<SurfaceModel>(ref.documentId);
    const model = reopened.model;
    expect(model.order).toEqual(['t1', 'mock-stroke-1']);
    expect((model.objects['t1'] as { text?: string }).text).toBe('diagram label');
    await app.dispose();
  });

  it('swaps the ink adapter without changing canonical contracts', async () => {
    for (const provider of [new MockInkEditorProvider(), new MockInkEditorProvider()]) {
      const app = await createApp({
        vaultPlugin: memoryVaultPlugin,
        searchService: new InMemorySearchService(),
        documentKinds: [inkPageKind],
        documentEditorProviders: [provider],
      });
      expect(app.getDocumentEditor(inkPageKindId)).not.toBeNull();
      await app.dispose();
    }
  });

  it('injects the vault asset store into ink and whiteboard providers', async () => {
    const received = new Map<string, DocumentAssetStore | null>();
    const recordingProvider = (
      id: string,
      kindId: typeof inkPageKindId | typeof whiteboardKindId,
    ): DocumentEditorProvider => ({
      id,
      kindIds: [kindId],
      createEditor(input) {
        received.set(
          kindId === inkPageKindId ? 'ink' : 'whiteboard',
          (input as { assets?: DocumentAssetStore }).assets ?? null,
        );
        return new MockInkEditorProvider().createEditor(input);
      },
    });
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      documentKinds: [inkPageKind, whiteboardKind],
      documentEditorProviders: [
        recordingProvider('asset-aware-ink', inkPageKindId),
        recordingProvider('asset-aware-whiteboard', whiteboardKindId),
      ],
    });
    const workspace = app.getWorkspace()!;
    for (const [kindId, path, model] of [
      [inkPageKindId, 'sketches/assets.ink', emptySurface(boundedFrame(400, 300))],
      [whiteboardKindId, 'boards/assets.whiteboard', emptySurface(infiniteFrame())],
    ] as const) {
      const ref = await workspace.createDocument({
        kindId,
        path: workspacePath(path),
        initialModel: model,
      });
      const session = await workspace.openDocument<SurfaceModel>(ref.documentId);
      app.getDocumentEditor(kindId)!.createEditor({ session, parent: {} });
      await session.close();
    }

    expect(received.get('ink')).not.toBeNull();
    expect(received.get('whiteboard')).not.toBeNull();
    await app.dispose();
  });
});
