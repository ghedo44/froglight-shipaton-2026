/**
 * Alternate deterministic Block Page editor provider ("Tiptap stub").
 *
 * Mirrors CodemirrorStubProvider for Markdown: it stands in for the real
 * Tiptap/ProseMirror adapter (a separate open decision, like the real
 * CodeMirror runtime) while proving the same seam supports a second,
 * internally different implementation with identical canonical output.
 * History scaffolding is shared with the mock via SnapshotHandleBase.
 *
 * Link-reveal asymmetry: like the mock, this stub has no
 * `revealAddress` seam, so controller links opened through it always
 * degrade to document-open-only (`revealed: false`). Exact-reveal
 * assertions need a resolve-aware test double or a production provider.
 */

import type { BlockPageEditorHandle, BlockPageEditorInput, BlockPageEditorProvider } from '../editors/block-provider.js';
import { headingBlock, paragraphBlock, type BlockPageModel, type Run } from '../blocks/model.js';
import { SnapshotHandleBase } from './block-editor-base.js';

export class TiptapStubHandle extends SnapshotHandleBase implements BlockPageEditorHandle {
  constructor(input: BlockPageEditorInput) {
    super(input.initialModel, input.onDirtyModel);
  }

  /** Simulate inserting a paragraph at the top of the page. */
  prependParagraph(text: string): void {
    const next = clone(this.model);
    const id = `stub-${next.rootOrder.length + 1}`;
    // Different construction path than the mock on purpose.
    next.blocks[id] = { ...paragraphBlock(id, [{ text }]) };
    next.rootOrder.unshift(id);
    this.commit(next);
  }

  /** Simulate re-titling via an inline "heading" transform. */
  setHeading(id: string, level: 1 | 2 | 3 | 4 | 5 | 6): void {
    const next = clone(this.model);
    const record = next.blocks[id];
    if (record === undefined) return;
    const runs = Array.isArray(record.runs) ? (record.runs as Run[]) : [];
    delete next.blocks[id];
    next.blocks[id] = headingBlock(id, level, runs);
    this.commit(next);
  }
}

function clone(model: BlockPageModel): BlockPageModel {
  return JSON.parse(JSON.stringify(model)) as BlockPageModel;
}

export class TiptapStubProvider implements BlockPageEditorProvider {
  createEditor(input: BlockPageEditorInput): BlockPageEditorHandle {
    void input.session;
    void input.parent;
    return new TiptapStubHandle(input);
  }
}
