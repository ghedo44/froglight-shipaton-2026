/**
 *  paste integration: multiline splits/merges predictably with
 * no drops, sanitized HTML, code-context literal insert, and preservation
 * of opaque payloads + unknown marks elsewhere. Single undoable step.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  emptyBlockPage,
  paragraphBlock,
  codeBlock,
  type BlockPageModel,
} from '@froglight/foundation';
import { BlockPageDocumentEditorProvider } from './editor.js';

function mount(model: BlockPageModel) {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  let latest: BlockPageModel | null = null;
  const handle = new BlockPageDocumentEditorProvider().createEditor({
    session: {} as never,
    parent,
    initialModel: model,
    onDirtyModel: (next) => {
      latest = next;
    },
  });
  return {
    parent,
    handle,
    latest: () => latest as BlockPageModel | null,
    pm: () => parent.querySelector('.ProseMirror')!,
    cleanup: () => {
      handle.destroy();
      parent.remove();
    },
  };
}
function command(
  env: ReturnType<typeof mount>,
  id: string,
  arg?: unknown,
): boolean {
  const run = env.handle.blockCommand;
  if (run === undefined) throw new Error('no blockCommand');
  return run.call(env.handle, id, arg);
}
function allText(model: BlockPageModel): string {
  return model.rootOrder
    .map((id) => JSON.stringify(model.blocks[id]))
    .join('\n');
}
function paste(
  env: ReturnType<typeof mount>,
  text: string,
  html?: string,
): boolean {
  const view = (env.handle as unknown as { editorViewForTest?: never })
    .editorViewForTest;
  void view;
  const pm = env.pm() as HTMLElement;
  const event = new Event('paste', {
    bubbles: true,
    cancelable: true,
  }) as ClipboardEvent & {
    clipboardData: DataTransfer | null;
  };
  const data = {
    getData: (kind: string) =>
      kind === 'text/plain'
        ? text
        : kind === 'text/html' && html !== undefined
          ? html
          : '',
  };
  Object.defineProperty(event, 'clipboardData', { value: data });
  // Dispatch on the ProseMirror surface so handlePaste sees it.
  pm.dispatchEvent(event);
  return event.defaultPrevented;
}

function pressKey(
  env: ReturnType<typeof mount>,
  key: string,
  init: KeyboardEventInit = {},
): boolean {
  return env.pm().dispatchEvent(
    new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
      ...init,
    }),
  );
}

afterEach(() => {
  document.body.replaceChildren();
  document.getElementById('flbp-chrome-styles')?.remove();
});

describe('paste multiline splits/merges', () => {
  it('splits at a browser-collapsed caret immediately after select-all, then pastes and undoes rich text', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['p1'];
    model.blocks = {
      p1: paragraphBlock('p1', [{ text: 'Formatted text', marks: ['bold'] }]),
    };
    const env = mount(model);
    try {
      // Chromium moves the DOM caret on ArrowRight before ProseMirror's
      // selectionchange callback necessarily replaces its AllSelection.
      // A fast following Enter must use the visible collapsed caret.
      pressKey(env, 'a', { ctrlKey: true });
      const text = env.pm().querySelector('strong')?.firstChild;
      if (text === null || text === undefined)
        throw new Error('expected formatted text DOM');
      const range = document.createRange();
      range.setStart(text, text.textContent?.length ?? 0);
      range.collapse(true);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);

      pressKey(env, 'Enter');
      expect(env.handle.getModelForTest!().rootOrder).toHaveLength(2);
      expect(
        paste(
          env,
          'Formatted text',
          '<p data-pm-slice="1 1 []"><strong>Formatted text</strong></p>',
        ),
      ).toBe(true);
      const afterPaste = env.handle.getModelForTest!();
      expect(afterPaste.rootOrder).toHaveLength(2);
      expect(afterPaste.rootOrder.map((id) => afterPaste.blocks[id])).toEqual([
        paragraphBlock('p1', [{ text: 'Formatted text', marks: ['bold'] }]),
        expect.objectContaining({
          type: 'froglight.paragraph',
          runs: [{ text: 'Formatted text', marks: ['bold'] }],
        }),
      ]);
      expect(env.handle.execCommand('undo')).toBe(true);
      const afterUndo = env.handle.getModelForTest!();
      expect(afterUndo.rootOrder).toHaveLength(1);
      expect(afterUndo.blocks['p1']).toEqual(model.blocks['p1']);
      expect(env.handle.execCommand('redo')).toBe(true);
      expect(env.handle.getModelForTest!().rootOrder).toHaveLength(2);
    } finally {
      env.cleanup();
    }
  });

  it('splits a middle-of-paragraph paste and merges first/last lines', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['p1'];
    model.blocks = { p1: paragraphBlock('p1', [{ text: 'alphabeta' }]) };
    const env = mount(model);
    try {
      // Caret between alpha|beta (doc pos: 1 + 5).
      command(env, 'set-selection', { from: 6, to: 6 });
      expect(paste(env, 'one\ntwo\nthree')).toBe(true);
      const next = env.handle.getModelForTest!();
      const text = allText(next);
      expect(text).toContain('alphaone');
      expect(text).toContain('two');
      expect(text).toContain('threebeta');
      // No drops: every pasted line appears exactly once.
      expect((text.match(/one/g) ?? []).length).toBe(1);
      expect((text.match(/two/g) ?? []).length).toBe(1);
      expect((text.match(/three/g) ?? []).length).toBe(1);
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!().blocks['p1']).toEqual(
        model.blocks['p1'],
      );
    } finally {
      env.cleanup();
    }
  });

  it('keeps source-owned unknown metadata on the first multiline paste block', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['p1'];
    model.blocks = {
      p1: {
        ...paragraphBlock('p1', [{ text: 'alpha' }]),
        // `caption` is known to other core block types but unknown for a
        // paragraph; source-type filtering must preserve it too.
        caption: 'paragraph extension',
        vendorPayload: { keep: 'metadata' },
      },
    };
    const env = mount(model);
    try {
      command(env, 'set-selection', { from: 6, to: 6 });
      expect(paste(env, ' first\nsecond')).toBe(true);

      const paragraphs = [...env.pm().querySelectorAll('p')];
      expect(paragraphs).toHaveLength(2);
      expect(paragraphs[0]?.getAttribute('data-block-id')).toBe('p1');
      expect(paragraphs[0]?.getAttribute('data-flbp-preserved')).toBe(
        JSON.stringify({
          caption: 'paragraph extension',
          vendorPayload: { keep: 'metadata' },
        }),
      );
      // Pasted lines are new canonical owners and must not duplicate the
      // source block's extension payload.
      expect(paragraphs[1]?.hasAttribute('data-flbp-preserved')).toBe(false);

      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!().blocks['p1']).toEqual(
        model.blocks['p1'],
      );
    } finally {
      env.cleanup();
    }
  });

  it('preserves empty middle lines as empty blocks (no drops)', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['p1'];
    model.blocks = { p1: paragraphBlock('p1', [{ text: 'a' }]) };
    const env = mount(model);
    try {
      command(env, 'set-selection', { from: 2, to: 2 });
      expect(paste(env, 'x\n\ny')).toBe(true);
      const next = env.handle.getModelForTest!();
      // a+x | '' | y  -> at least 3 roots, one empty.
      expect(next.rootOrder.length).toBeGreaterThanOrEqual(3);
      const texts = next.rootOrder.map((id) => JSON.stringify(next.blocks[id]));
      expect(texts.join(' ')).toContain('x');
      expect(texts.join(' ')).toContain('y');
    } finally {
      env.cleanup();
    }
  });

  it('sanitizes HTML paste to text lines without executing scripts', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['p1'];
    model.blocks = { p1: paragraphBlock('p1', [{ text: '' }]) };
    const env = mount(model);
    try {
      command(env, 'set-selection', { from: 1, to: 1 });
      expect(
        paste(env, '', '<p>hello</p><script>alert(1)</script><p>world</p>'),
      ).toBe(true);
      const next = env.handle.getModelForTest!();
      const text = allText(next);
      expect(text).toContain('hello');
      expect(text).toContain('world');
      expect(text).not.toContain('alert');
      expect(text).not.toContain('script');
    } finally {
      env.cleanup();
    }
  });

  it('preserves supported inline marks from a matching rich clipboard flavor', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['p1'];
    model.blocks = { p1: paragraphBlock('p1', [{ text: '' }]) };
    const env = mount(model);
    try {
      command(env, 'set-selection', { from: 1, to: 1 });
      expect(
        paste(
          env,
          'omega',
          '<p data-pm-slice="1 1 []"><strong onclick="alert(1)">omega</strong></p>',
        ),
      ).toBe(true);
      expect(env.handle.getModelForTest!().blocks['p1']).toEqual(
        paragraphBlock('p1', [{ text: 'omega', marks: ['bold'] }]),
      );
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!().blocks['p1']).toEqual(
        model.blocks['p1'],
      );
    } finally {
      env.cleanup();
    }
  });

  it('preserves supported marks across rich clipboard paragraphs without a phantom blank block', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['p1'];
    model.blocks = { p1: paragraphBlock('p1', [{ text: '' }]) };
    const env = mount(model);
    try {
      command(env, 'set-selection', { from: 1, to: 1 });
      expect(
        paste(
          env,
          'alpha\n\nbeta',
          '<p data-pm-slice="1 1 []"><strong>alpha</strong></p><p><em>beta</em></p>',
        ),
      ).toBe(true);
      const next = env.handle.getModelForTest!();
      expect(next.rootOrder).toHaveLength(2);
      expect(next.blocks[next.rootOrder[0]!]).toEqual(
        paragraphBlock('p1', [{ text: 'alpha', marks: ['bold'] }]),
      );
      expect(next.blocks[next.rootOrder[1]!]).toMatchObject({
        type: 'froglight.paragraph',
        runs: [{ text: 'beta', marks: ['italic'] }],
      });
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!()).toEqual(model);
    } finally {
      env.cleanup();
    }
  });

  it('inserts literal newlines inside code blocks instead of splitting', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['c1'];
    model.blocks = { c1: codeBlock('c1', 'ab', 'js') };
    const env = mount(model);
    try {
      command(env, 'set-selection', { from: 2, to: 2 });
      expect(paste(env, 'X\nY')).toBe(true);
      const next = env.handle.getModelForTest!();
      expect(next.rootOrder).toEqual(['c1']);
      expect((next.blocks['c1'] as unknown as { text: string }).text).toBe(
        'aX\nYb',
      );
    } finally {
      env.cleanup();
    }
  });

  it('keeps opaque payloads and unknown marks byte-faithful across paste', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['p1', 'x1'];
    model.blocks = {
      p1: paragraphBlock('p1', [
        { text: 'keep ' },
        {
          text: 'mystery',
          marks: [{ type: 'acme.highlight', color: 'yellow' }],
        },
      ]),
      x1: { id: 'x1', type: 'acme.kanban', lanes: [1, 2] },
    };
    const env = mount(model);
    try {
      command(env, 'set-selection', { from: 2, to: 2 });
      expect(paste(env, 'A\nB')).toBe(true);
      const next = env.handle.getModelForTest!();
      expect(next.blocks['x1']).toEqual(model.blocks['x1']);
      expect(JSON.stringify(next)).toContain('acme.highlight');
    } finally {
      env.cleanup();
    }
  });
});
