import { afterEach, describe, expect, it } from 'vitest';
import { Editor } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { pmDocToModel } from './pm-map.js';
import { enterToggleSummary } from './toggle-interaction.js';
import { StarterKit } from '@tiptap/starter-kit';
import { froglightExtensions } from './extensions.js';
import {
  BlockDragController,
  blockDragSource,
  blockDropBoundary,
  blockDropTransaction,
} from './block-drag.js';

const editors: Editor[] = [];
function mount(content: object[]) {
  const editor = new Editor({
    extensions: [
      StarterKit.configure({
        bulletList: false,
        orderedList: false,
        listItem: false,
      }),
      ...froglightExtensions(),
    ],
    content: { type: 'doc', content },
  });
  document.body.appendChild(editor.view.dom);
  editors.push(editor);
  return editor;
}
const p = (text: string) => ({
  type: 'paragraph',
  attrs: { blockId: text },
  content: [{ type: 'text', text }],
});
const item = (text: string) => ({ type: 'listItem', content: [p(text)] });
const list = (id: string, ...items: string[]) => ({
  type: 'bulletList',
  attrs: { listId: id },
  content: items.map(item),
});
const toggle = (id: string, ...children: string[]) => ({
  type: 'toggle',
  attrs: { blockId: id },
  content: [p(id), ...children.map(p)],
});
function source(editor: Editor, selector: string) {
  const element = editor.view.dom.querySelector<HTMLElement>(selector)!;
  return blockDragSource(editor.view, element)!;
}
function position(editor: Editor, id: string) {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (node.attrs.blockId === id || node.attrs.listId === id) {
      found = pos;
      return false;
    }
    return true;
  });
  if (found < 0) throw new Error(`Missing ${id}`);
  return found;
}
afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy());
  document.body.replaceChildren();
});

describe('document-position block dragging', () => {
  it('lifts an individual item outside its list as a paragraph', () => {
    const editor = mount([list('list', 'Alpha', 'Beta'), p('Tail')]);
    const drag = source(editor, '[data-list-id="list"] > li:last-child');
    const tr = blockDropTransaction(
      editor.view,
      drag,
      editor.state.doc.content.size,
    );
    expect(tr).not.toBeNull();
    editor.view.dispatch(tr!);
    expect(editor.state.doc.lastChild!.type.name).toBe('paragraph');
    expect(editor.state.doc.lastChild!.textContent).toBe('Beta');
    expect(editor.state.doc.firstChild!.childCount).toBe(1);
  });

  it('keeps owned paragraph children when adding a block to a list and saving', () => {
    const editor = mount([
      p('Parent'),
      { type: 'blockGroup', attrs: { owner: 'Parent' }, content: [p('Child')] },
      list('list', 'A', 'B'),
    ]);
    const drag = source(editor, 'p[data-block-id="Parent"]');
    const row = source(editor, 'li:last-child');
    const tr = blockDropTransaction(editor.view, drag, row.from, 'list-item');
    expect(tr).not.toBeNull();
    editor.view.dispatch(tr!);
    const { model } = pmDocToModel(editor.state.doc.toJSON());
    expect(model.blocks.list).toMatchObject({
      items: [
        { runs: [{ text: 'A' }] },
        { runs: [{ text: 'Parent' }], children: ['Child'] },
        { runs: [{ text: 'B' }] },
      ],
    });
    expect(model.blocks.Child).toMatchObject({
      type: 'froglight.paragraph',
      runs: [{ text: 'Child' }],
    });
  });

  it('splits a list around a heading or converts the same heading into an item explicitly', () => {
    for (const mode of ['split-list', 'list-item'] as const) {
      const editor = mount([
        {
          type: 'heading',
          attrs: { blockId: 'Heading', level: 2 },
          content: [{ type: 'text', text: 'Heading' }],
        },
        list('list', 'A', 'B'),
        p('Tail'),
      ]);
      const before = editor.state.doc.toJSON();
      const drag = source(editor, 'h2');
      const row = source(editor, 'li:last-child');
      const tr = blockDropTransaction(editor.view, drag, row.from, mode)!;
      editor.view.dispatch(tr);
      if (mode === 'split-list')
        expect(
          editor.state.doc.content.content.map((node) => node.type.name),
        ).toEqual(['bulletList', 'heading', 'bulletList', 'paragraph']);
      else
        expect(
          editor.state.doc.firstChild!.content.content.map(
            (node) => node.textContent,
          ),
        ).toEqual(['A', 'Heading', 'B']);
      editor.commands.undo();
      expect(editor.state.doc.toJSON()).toEqual(before);
    }
  });

  it('toggle Enter splits summaries into siblings while preserving the original children', () => {
    const editor = mount([toggle('Summary', 'Child'), p('Tail')]);
    const before = editor.state.doc.toJSON();
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 5)),
    );
    expect(enterToggleSummary(editor.view)).toBe(true);
    expect(editor.state.doc.child(0).firstChild!.textContent).toBe('Sum');
    expect(editor.state.doc.child(0).lastChild!.textContent).toBe('Child');
    expect(editor.state.doc.child(1).firstChild!.textContent).toBe('mary');
    expect(editor.state.doc.child(1).childCount).toBe(1);
    editor.commands.undo();
    expect(editor.state.doc.toJSON()).toEqual(before);
  });

  it('moves to the exact boundary after a toggle and undoes in one step', () => {
    const editor = mount([p('Move'), toggle('Toggle'), p('Tail')]);
    const before = editor.state.doc.toJSON();
    const drag = source(editor, '[data-block-id="Move"]');
    const tr = blockDropTransaction(
      editor.view,
      drag,
      position(editor, 'Tail'),
    )!;
    editor.view.dispatch(tr);
    expect(
      editor.state.doc.content.content.map((node) => node.attrs.blockId),
    ).toEqual(['Toggle', 'Move', 'Tail']);
    editor.commands.undo();
    expect(editor.state.doc.toJSON()).toEqual(before);
  });

  it('moves toggle children out to the root and between toggle scopes', () => {
    const editor = mount([
      toggle('One', 'Child'),
      toggle('Two', 'Other'),
      p('Tail'),
    ]);
    const before = editor.state.doc.toJSON();
    editor.view.dispatch(
      blockDropTransaction(
        editor.view,
        source(editor, '[data-block-id="Child"]'),
        position(editor, 'Other'),
      )!,
    );
    expect(editor.state.doc.firstChild!.childCount).toBe(1);
    expect(editor.state.doc.child(1).textContent).toBe('TwoChildOther');
    editor.view.dispatch(
      blockDropTransaction(
        editor.view,
        source(editor, '[data-block-id="Child"]'),
        0,
      )!,
    );
    expect(editor.state.doc.firstChild!.textContent).toBe('Child');
    editor.commands.undo();
    editor.commands.undo();
    expect(editor.state.doc.toJSON()).toEqual(before);
  });

  it('moves only the chosen list item, including its subtree, into another list', () => {
    const editor = mount([
      {
        type: 'bulletList',
        attrs: { listId: 'one' },
        content: [
          { type: 'listItem', content: [p('Parent'), list('nested', 'Child')] },
        ],
      },
      list('two', 'Other'),
      p('Tail'),
    ]);
    const before = editor.state.doc.toJSON();
    const drag = source(editor, '[data-list-id="one"] > li');
    expect(drag.kind).toBe('list-item');
    editor.view.dispatch(
      blockDropTransaction(editor.view, drag, position(editor, 'two') + 1)!,
    );
    expect(editor.state.doc.childCount).toBe(2);
    expect(editor.state.doc.firstChild!.attrs.listId).toBe('two');
    expect(editor.state.doc.firstChild!.childCount).toBe(2);
    expect(editor.state.doc.firstChild!.firstChild!.textContent).toBe(
      'ParentChild',
    );
    editor.commands.undo();
    expect(editor.state.doc.toJSON()).toEqual(before);
  });

  it('rejects no-ops, incompatible atomic/list destinations, descendant cycles and stale sources', () => {
    const editor = mount([
      toggle('Toggle', 'Child'),
      list('list', 'A', 'B'),
      p('Tail'),
    ]);
    const drag = source(editor, '[data-flbp-toggle]');
    expect(blockDropTransaction(editor.view, drag, drag.from)).toBeNull();
    expect(blockDropTransaction(editor.view, drag, drag.to)).toBeNull();
    expect(
      blockDropTransaction(editor.view, drag, position(editor, 'Child')),
    ).toBeNull();
    const row = source(editor, 'li');
    expect(blockDropTransaction(editor.view, row, 0)).not.toBeNull();
    expect(blockDropTransaction(editor.view, drag, row.from)).toBeNull();
    editor.commands.insertContent('Changed');
    expect(
      blockDropTransaction(editor.view, drag, editor.state.doc.content.size),
    ).toBeNull();
  });

  it('does not let structural title/row paragraphs acquire their own drag lifecycle', () => {
    const editor = mount([toggle('Toggle'), list('list', 'A')]);
    expect(
      blockDragSource(
        editor.view,
        editor.view.dom.querySelector<HTMLElement>('[data-flbp-toggle] > p')!,
      ),
    ).toBeNull();
    expect(
      blockDragSource(
        editor.view,
        editor.view.dom.querySelector<HTMLElement>('li > p')!,
      ),
    ).toBeNull();
    expect(source(editor, '[data-list-id]').kind).toBe('block');
  });

  it('uses model positions despite decoration siblings and does not extend empty-toggle hit areas into the next block', () => {
    const editor = mount([p('Move'), toggle('Toggle'), p('Tail')]);
    const pm = editor.view.dom;
    const rect = (
      el: HTMLElement,
      x: number,
      y: number,
      width: number,
      height: number,
    ) => {
      el.getBoundingClientRect = () => new DOMRect(x, y, width, height);
      el.getClientRects = () =>
        [el.getBoundingClientRect()] as unknown as DOMRectList;
    };
    rect(pm, 100, 100, 500, 200);
    rect(pm.children[0] as HTMLElement, 100, 100, 500, 30);
    rect(pm.children[1] as HTMLElement, 100, 140, 500, 30);
    rect(pm.children[1]!.firstElementChild as HTMLElement, 100, 140, 500, 30);
    rect(pm.children[2] as HTMLElement, 100, 174, 500, 30);
    const widget = document.createElement('button');
    pm.insertBefore(widget, pm.children[1]!);
    const boundary = blockDropBoundary(
      editor.view,
      source(editor, '[data-block-id="Move"]'),
      200,
      176,
    )!;
    expect(boundary.pos).toBe(position(editor, 'Tail'));
    expect(boundary.top).toBe(172);
  });
  it('keeps an owned child group with its block during reparenting', () => {
    const editor = mount([
      p('Owner'),
      { type: 'blockGroup', attrs: { owner: 'Owner' }, content: [p('Child')] },
      toggle('Target'),
      p('Tail'),
    ]);
    const before = editor.state.doc.toJSON();
    const drag = source(editor, '[data-block-id="Owner"]');
    expect(drag.content.childCount).toBe(2);
    const target = editor.state.doc.nodeAt(position(editor, 'Target'))!;
    editor.view.dispatch(
      blockDropTransaction(
        editor.view,
        drag,
        position(editor, 'Target') + target.nodeSize - 1,
      )!,
    );
    expect(editor.state.doc.firstChild!.childCount).toBe(3);
    expect(editor.state.doc.firstChild!.textContent).toBe('TargetOwnerChild');
    editor.commands.undo();
    expect(editor.state.doc.toJSON()).toEqual(before);
  });

  it.each(['pointercancel', 'lostpointercapture', 'blur', 'destroy', 'edit'])(
    'cleans up an active drag on %s and ignores other pointer IDs',
    (reason) => {
      const editor = mount([p('First'), p('Second')]);
      const host = document.createElement('div');
      document.body.appendChild(host);
      host.appendChild(editor.view.dom);
      const controller = new BlockDragController(host, editor.view);
      const handle = document.createElement('button');
      host.appendChild(handle);
      const element = editor.view.dom.firstElementChild as HTMLElement;
      let taps = 0;
      handle.addEventListener('pointerdown', (event) =>
        controller.start(event, element, () => taps++),
      );
      const pointer = (type: string, pointerId: number, clientX = 0) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        for (const [key, value] of Object.entries({
          pointerId,
          clientX,
          clientY: 0,
          button: 0,
          isPrimary: true,
        })) {
          Object.defineProperty(event, key, { value });
        }
        handle.dispatchEvent(event);
      };
      pointer('pointerdown', 1);
      pointer('pointermove', 2, 100);
      pointer('pointerup', 2, 100);
      expect(controller.busy).toBe(true);
      expect(document.querySelector('.flbp-drag-preview')).toBeNull();
      pointer('pointermove', 1, 100);
      expect(document.querySelector('.flbp-drag-preview')).not.toBeNull();
      if (reason === 'blur') window.dispatchEvent(new Event('blur'));
      else if (reason === 'destroy') controller.destroy();
      else if (reason === 'edit') {
        editor.commands.insertContent('Edit');
        controller.update();
      } else pointer(reason, 1);
      expect(controller.busy).toBe(false);
      expect(taps).toBe(0);
      expect(
        document.querySelector('.flbp-drag-preview, .flbp-drop-preview'),
      ).toBeNull();
      expect(element.classList.contains('flbp-drag-source')).toBe(false);
      controller.destroy();
    },
  );
});
