// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { createApp, createWorkbenchController } from '@froglight/application';
import {
  InMemorySearchService,
  blockPageKind,
  blockPageKindId,
  emptyBlockPage,
  memoryVaultPlugin,
  paragraphBlock,
  workspacePath,
  type BlockPageModel,
} from '@froglight/foundation';
import { BlockPageDocumentEditorProvider } from '@froglight/editor-blockpage';

const zeroRect = () => ({
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  width: 0,
  height: 0,
  toJSON: () => ({}),
});
for (const proto of [Element.prototype, Range.prototype, Text.prototype]) {
  if (
    typeof (proto as { getClientRects?: unknown }).getClientRects !== 'function'
  )
    (proto as unknown as { getClientRects: () => unknown[] }).getClientRects =
      () => [zeroRect()];
  if (
    typeof (proto as { getBoundingClientRect?: unknown })
      .getBoundingClientRect !== 'function'
  )
    (
      proto as unknown as { getBoundingClientRect: () => unknown }
    ).getBoundingClientRect = zeroRect;
}

describe('web workbench — real Block Page close/reopen', () => {
  it('does not clear canonical content when its tab closes and reopens', async () => {
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      searchService: new InMemorySearchService(),
      documentKinds: [blockPageKind],
      blockPageEditorProvider: new BlockPageDocumentEditorProvider(),
    });
    const controller = createWorkbenchController(app);
    const model = emptyBlockPage({ title: 'Reopen' });
    model.rootOrder = ['p1'];
    model.blocks.p1 = paragraphBlock('p1', [{ text: 'survives close' }]);
    const ref = await app
      .getWorkspace()!
      .createDocument({
        kindId: blockPageKindId,
        path: workspacePath('pages/reopen.blockpage'),
        initialModel: model,
      });

    const firstHost = document.createElement('div');
    document.body.appendChild(firstHost);
    await controller.openDocument(String(ref.documentId), firstHost);
    const paragraph = firstHost.querySelector('p[data-block-id="p1"]');
    if (paragraph === null) throw new Error('missing Block Page paragraph');
    paragraph.textContent = 'edited immediately before close';
    paragraph.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        inputType: 'insertText',
        data: 'edited immediately before close',
      }),
    );
    await controller.closeTab('main', String(ref.documentId));

    const secondHost = document.createElement('div');
    document.body.appendChild(secondHost);
    await controller.openDocument(String(ref.documentId), secondHost);
    expect(secondHost.textContent).toContain('edited immediately before close');
    const reopened = await app
      .getWorkspace()!
      .readDocument<BlockPageModel>(ref.documentId);
    expect(reopened.model.blocks.p1?.runs).toEqual([
      { text: 'edited immediately before close' },
    ]);
    await app.dispose();
  });
});
