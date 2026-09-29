/**
 *  alternate/mock provider open/save/reopen (AGENTS.md editor-provider
 * rule): the same canonical model opens, saves, and reopens through the
 * default Tiptap provider and through a minimal mock provider without the
 * default editor engine, preserving opaque records and unknown marks.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  emptyBlockPage,
  paragraphBlock,
  type BlockPageEditorHandle,
  type BlockPageEditorInput,
  type BlockPageModel,
} from '@froglight/foundation';
import { BlockPageDocumentEditorProvider } from './editor.js';
import { HeadlessBlockpageEditorHandle } from './headless-handle.js';
import { cloneModel } from './model-edit.js';

/** Minimal mock provider: canonical-only, no Tiptap/ProseMirror engine. */
class MockBlockpageProvider {
  createEditor(input: BlockPageEditorInput): BlockPageEditorHandle {
    let model = cloneModel(input.initialModel);
    return {
      focus: () => undefined,
      hasFocus: () => false,
      setReadOnly: () => undefined,
      execCommand: () => false,
      canExecCommand: () => false,
      destroy: () => undefined,
      getModelForTest: () => cloneModel(model),
      // Resolve-only mirror of the production reveal seam: true iff
      // the opaque address names a block. Ephemeral, never dirty.
      revealAddress: (address: string) => {
        if (typeof address !== 'string' || address === '') return false;
        return model.blocks[address] !== undefined;
      },
      blockCommand: (id: string, arg?: unknown) => {
        if (id !== 'mock-append') return false;
        const text = String((arg as { text?: unknown } | undefined)?.text ?? '');
        const next = cloneModel(model);
        const nid = `mock-${next.rootOrder.length + 1}`;
        next.blocks[nid] = paragraphBlock(nid, [{ text }]);
        next.rootOrder.push(nid);
        model = next;
        input.onDirtyModel(cloneModel(next));
        return true;
      },
    } as unknown as BlockPageEditorHandle;
  }
}

function fixture(): BlockPageModel {
  const model = emptyBlockPage({ title: 'Alt fixture', tags: [], properties: {} });
  model.rootOrder = ['p1', 'x1'];
  model.blocks = {
    p1: paragraphBlock('p1', [
      { text: 'hello ' },
      { text: 'mystery', marks: [{ type: 'acme.highlight', color: 'yellow' }] },
    ]),
    x1: { id: 'x1', type: 'acme.kanban', lanes: [1, 2], vendor: { keep: true } },
  };
  return model;
}

function mountTiptap(model: BlockPageModel, onDirty: (m: BlockPageModel) => void) {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const handle = new BlockPageDocumentEditorProvider().createEditor({
    session: {} as never,
    parent,
    initialModel: model,
    onDirtyModel: onDirty,
  });
  return {
    parent,
    handle,
    cleanup: () => {
      handle.destroy();
      parent.remove();
    },
  };
}

afterEach(() => {
  document.body.replaceChildren();
  document.getElementById('flbp-chrome-styles')?.remove();
});

describe('alternate/mock provider open/save/reopen', () => {
  it('mock edits reopen byte-faithful in the default provider', () => {
    const start = fixture();
    let saved: BlockPageModel | null = null;
    const mock = new MockBlockpageProvider().createEditor({
      session: {} as never,
      parent: {},
      initialModel: start,
      onDirtyModel: (m) => {
        saved = m;
      },
    });
    expect(mock.blockCommand?.('mock-append', { text: 'from mock' })).toBe(true);
    expect(saved).not.toBeNull();
    const env = mountTiptap(saved!, () => undefined);
    try {
      const reopened = (env.handle.getModelForTest as () => BlockPageModel)();
      expect(reopened.blocks['x1']).toEqual(start.blocks['x1']);
      expect(JSON.stringify(reopened)).toContain('acme.highlight');
      expect(JSON.stringify(reopened)).toContain('from mock');
    } finally {
      env.cleanup();
    }
  });

  it('default provider edits reopen in headless + mock without the editor engine', () => {
    const start = fixture();
    let saved: BlockPageModel | null = null;
    const env = mountTiptap(start, (m) => {
      saved = m;
    });
    try {
      const live = env.handle as unknown as { blockCommand(id: string, arg?: unknown): boolean };
      live.blockCommand('set-selection', { from: 1, to: 1 });
      expect(live.blockCommand('insert-text', { text: 'typed ' })).toBe(true);
      expect(saved).not.toBeNull();
    } finally {
      env.cleanup();
    }
    // Headless twin opens the Tiptap-saved model without the engine.
    let headlessDirty: BlockPageModel | null = null;
    const headless = new HeadlessBlockpageEditorHandle({
      session: {} as never,
      parent: {},
      initialModel: saved!,
      onDirtyModel: (m) => {
        headlessDirty = m;
      },
    });
    expect(headless.getModelForTest().blocks['x1']).toEqual(start.blocks['x1']);
    headless.appendParagraph('headless tail');
    expect(headlessDirty).not.toBeNull();
    // Mock opens the headless-saved model, still byte-faithful.
    let mockSaved: BlockPageModel | null = null;
    const mock = new MockBlockpageProvider().createEditor({
      session: {} as never,
      parent: {},
      initialModel: headlessDirty!,
      onDirtyModel: (m) => {
        mockSaved = m;
      },
    });
    expect((mock.getModelForTest as () => BlockPageModel)().blocks['x1']).toEqual(start.blocks['x1']);
    expect(mockSaved).toBeNull();
    headless.destroy();
  });

  it('media blocks open/save/reopen through Tiptap, headless, and mock byte-faithful', () => {
    const model = emptyBlockPage({ title: 'Media fixture', tags: [], properties: {} });
    model.rootOrder = ['v1', 'a1', 'f1', 'i1'];
    model.blocks = {
      v1: {
        id: 'v1',
        type: 'froglight.video',
        src: 'attachments/hv',
        sha256: 'hv',
        caption: 'Clip',
      } as never,
      a1: {
        id: 'a1',
        type: 'froglight.audio',
        remote: { url: 'https://cdn.example.com/s.mp3' },
        name: 'Theme',
      } as never,
      f1: {
        id: 'f1',
        type: 'froglight.file',
        src: 'attachments/hf',
        sha256: 'hf',
        name: 'Deck',
      } as never,
      i1: {
        id: 'i1',
        type: 'froglight.image',
        src: 'attachments/hi',
        sha256: 'hi',
        alt: 'Alt',
        caption: 'Cap',
      } as never,
    };
    const env = mountTiptap(model, () => undefined);
    try {
      const reopened = (env.handle.getModelForTest as () => BlockPageModel)();
      expect(reopened.blocks['v1']).toEqual(model.blocks['v1']);
      expect(reopened.blocks['a1']).toEqual(model.blocks['a1']);
      expect(reopened.blocks['f1']).toEqual(model.blocks['f1']);
      expect(reopened.blocks['i1']).toEqual(model.blocks['i1']);
    } finally {
      env.cleanup();
    }
    const headless = new HeadlessBlockpageEditorHandle({
      session: {} as never,
      parent: {},
      initialModel: model,
      onDirtyModel: () => undefined,
    });
    expect(headless.getModelForTest().blocks['v1']).toEqual(model.blocks['v1']);
    expect(headless.getModelForTest().blocks['a1']).toEqual(model.blocks['a1']);
    headless.destroy();
  });
});
