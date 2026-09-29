/**
 * Deterministic mock Block Page editor provider for exercising the provider
 * boundary without mounting an editor engine.
 *
 * No DOM, no Tiptap/ProseMirror. Edits operate on canonical plain data;
 * history scaffolding is shared with the stub via SnapshotHandleBase.
 *
 * Link-reveal asymmetry: this mock has no `revealAddress`
 * seam, so controller links opened through it always degrade to
 * document-open-only (`revealed: false`). Exact-reveal assertions need a
 * resolve-aware test double or a production provider; like the
 * whiteboard/notebook/ink mocks, this one only proves the degrade path,
 * never exactness.
 */

import type { BlockPageEditorHandle, BlockPageEditorInput, BlockPageEditorProvider } from '../editors/block-provider.js';
import { paragraphBlock, type BlockPageModel } from '../blocks/model.js';
import { SnapshotHandleBase } from './block-editor-base.js';

export class MockBlockPageEditorHandle extends SnapshotHandleBase implements BlockPageEditorHandle {
  constructor(input: BlockPageEditorInput) {
    // The mock never touches opaque payloads: it clones the canonical model
    // and edits only well-known fields, so unknown blocks survive verbatim.
    super(structuredCloneModel(input.initialModel), input.onDirtyModel);
  }

  /** Simulate appending a paragraph block (deterministic edit). */
  appendParagraph(text: string): void {
    const next = structuredCloneModel(this.model);
    const id = `mock-${next.rootOrder.length + 1}`;
    next.blocks[id] = paragraphBlock(id, [{ text }]);
    next.rootOrder.push(id);
    this.commit(next);
  }

  /** Simulate deleting the last root block. */
  deleteLastBlock(): void {
    const next = structuredCloneModel(this.model);
    const id = next.rootOrder.pop();
    if (id !== undefined) delete next.blocks[id];
    this.commit(next);
  }
}

function structuredCloneModel(model: BlockPageModel): BlockPageModel {
  return JSON.parse(JSON.stringify(model)) as BlockPageModel;
}

export class MockBlockPageEditorProvider implements BlockPageEditorProvider {
  createEditor(input: BlockPageEditorInput): BlockPageEditorHandle {
    void input.session;
    void input.parent;
    return new MockBlockPageEditorHandle(input);
  }
}
