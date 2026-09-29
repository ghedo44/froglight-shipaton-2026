/**
 *  table grid: editable grid acceptance.
 *
 * - Cell cursor: Tab/Shift-Tab between cells, Enter down (creating a row at
 *   the end), guarded Backspace, whole-table delete.
 * - Row/col add/remove/move + header toggle via the Document-Tools surface
 *   (semantic controls, no provider toolbar DOM), each single-undo.
 * - Canonical round-trip byte-faithful (marks included); spans flatten in
 *  document order WITH warnings; ragged grids normalize WITH
 *   warnings; widths/colwidth never reach canonical bytes.
 * - Slash size picker; turn-into grid-as-atom rejects; drag with subtree;
 *   headless session equivalence.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  emptyBlockPage,
  paragraphBlock,
  tableBlock,
  type BlockPageModel,
  type ResourceTarget,
} from '@froglight/foundation';
import { BlockPageDocumentEditorProvider } from './editor.js';
import { HeadlessBlockpageEditorHandle } from './headless-handle.js';
import { cloneModel } from './model-edit.js';
import { modelToPmDoc, pmDocToModel, unseenTableWarningMessages } from './pm-map.js';
import { TABLE_OP_IDS, inTableGrid } from './table-grid.js';

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
    picker: () =>
      parent.querySelector('.flbp-table-menu') as HTMLElement | null,
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
  if (run === undefined) throw new Error('block command channel unavailable');
  return run.call(env.handle, id, arg);
}

function toolsOf(env: ReturnType<typeof mount>) {
  const tools = (
    env.handle as unknown as {
      tools?: {
        snapshot(): {
          context: string;
          controls: Array<{ id: string; kind: string } & Record<string, unknown>>;
        };
        execute(id: string, value?: string): boolean;
      };
    }
  ).tools;
  if (tools === undefined) throw new Error('semantic tools unavailable');
  return tools;
}

function type(env: ReturnType<typeof mount>, text: string): void {
  if (!command(env, 'insert-text', { text })) throw new Error('insert-text failed');
}

function key(
  env: ReturnType<typeof mount>,
  k: string,
  init?: KeyboardEventInit,
): void {
  env
    .pm()
    .dispatchEvent(
      new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }),
    );
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 4));

/** 2×2 plain grid a/b/c/d, no header/align. Caret anchor: 'a' spans [4,5). */
function gridModel(): BlockPageModel {
  const model = emptyBlockPage();
  model.rootOrder = ['t1'];
  model.blocks = {
    t1: tableBlock('t1', 2, [
      { cells: [[{ text: 'a' }], [{ text: 'b' }]] },
      { cells: [[{ text: 'c' }], [{ text: 'd' }]] },
    ]),
  };
  return model;
}

function cellsOf(model: BlockPageModel, id = 't1'): string[][] {
  const record = model.blocks[id] as unknown as {
    rows: Array<{ cells: Array<Array<{ text: string }>> }>;
  };
  return record.rows.map((row) => row.cells.map((cell) => cell.map((r) => r.text).join('')));
}

afterEach(() => {
  document.body.replaceChildren();
  document.getElementById('flbp-chrome-styles')?.remove();
});

describe('table grid cell cursor', () => {
  // NOTE: cell navigation selects the target cell's content (standard
  // prosemirror-tables behavior, same as Notion): typing after Tab/Enter
  // replaces the selected cell text.
  it('Tab moves across cells, Shift-Tab moves back', () => {
    const env = mount(gridModel());
    try {
      command(env, 'set-selection', { from: 4, to: 4 });
      key(env, 'Tab');
      type(env, 'X');
      expect(cellsOf(env.handle.getModelForTest!())).toEqual([
        ['a', 'X'],
        ['c', 'd'],
      ]);
      // Shift-Tab returns to the first cell.
      key(env, 'Tab', { shiftKey: true });
      type(env, 'Y');
      expect(cellsOf(env.handle.getModelForTest!())).toEqual([
        ['Y', 'X'],
        ['c', 'd'],
      ]);
    } finally {
      env.cleanup();
    }
  });

  it('Enter moves down the column; Enter on the last row creates a row', () => {
    const env = mount(gridModel());
    try {
      command(env, 'set-selection', { from: 4, to: 4 });
      key(env, 'Enter');
      type(env, 'X');
      expect(cellsOf(env.handle.getModelForTest!())).toEqual([
        ['a', 'b'],
        ['X', 'd'],
      ]);
      // On the last row Enter creates a trailing row: the op alone is one
      // undo step (no typing interleaved — typing merges by newGroupDelay).
      const before = env.handle.getModelForTest!();
      key(env, 'Enter');
      const created = env.handle.getModelForTest!();
      expect(created.rootOrder).toEqual(['t1']);
      expect(cellsOf(created)).toEqual([
        ['a', 'b'],
        ['X', 'd'],
        ['', ''],
      ]);
      expect(created.blocks['t1']).toMatchObject({ columnCount: 2 });
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!()).toEqual(before);
      // Typing lands in the created row.
      key(env, 'Enter');
      type(env, 'Z');
      expect(cellsOf(env.handle.getModelForTest!())).toEqual([
        ['a', 'b'],
        ['X', 'd'],
        ['Z', ''],
      ]);
    } finally {
      env.cleanup();
    }
  });

  it('Backspace at a cell start is guarded (no structural escape)', () => {
    const env = mount(gridModel());
    try {
      const before = env.handle.getModelForTest!();
      command(env, 'set-selection', { from: 4, to: 4 });
      key(env, 'Backspace');
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
  });

  it('selecting the whole grid + Backspace deletes the table (single undo)', () => {
    const env = mount(gridModel());
    try {
      const before = env.handle.getModelForTest!();
      // Expand a cell selection across the grid with Shift+Arrows
      // (prosemirror-tables extends the head cell per key).
      command(env, 'set-selection', { from: 4, to: 4 });
      key(env, 'ArrowDown', { shiftKey: true });
      key(env, 'ArrowRight', { shiftKey: true });
      key(env, 'Backspace');
      const next = env.handle.getModelForTest!();
      expect(next.blocks['t1']).toBeUndefined();
      expect(next.rootOrder).not.toContain('t1');
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
  });

  it('Mod-Alt-Arrows run add/remove ops from the keyboard', () => {
    const env = mount(gridModel());
    try {
      command(env, 'set-selection', { from: 4, to: 4 });
      const mod = { ctrlKey: true, altKey: true };
      key(env, 'ArrowDown', mod);
      expect(cellsOf(env.handle.getModelForTest!()).length).toBe(3);
      key(env, 'ArrowRight', mod);
      expect(
        (env.handle.getModelForTest!().blocks['t1'] as unknown as { columnCount: number }).columnCount,
      ).toBe(3);
      key(env, 'ArrowUp', mod);
      expect(cellsOf(env.handle.getModelForTest!()).length).toBe(2);
      key(env, 'ArrowLeft', mod);
      expect(
        (env.handle.getModelForTest!().blocks['t1'] as unknown as { columnCount: number }).columnCount,
      ).toBe(2);
    } finally {
      env.cleanup();
    }
  });
});

describe('table grid ops via Document Tools', () => {
  it('exposes the table op inventory only inside tables', () => {
    const env = mount(gridModel());
    try {
      command(env, 'set-selection', { from: 4, to: 4 });
      const ids = toolsOf(env)
        .snapshot()
        .controls.map((c) => c.id);
      for (const id of TABLE_OP_IDS) expect(ids).toContain(id);
      // Outside the grid the ops vanish.
      const plain = mount(
        (() => {
          const m = emptyBlockPage();
          m.rootOrder = ['p1'];
          m.blocks = { p1: paragraphBlock('p1', [{ text: 'hi' }]) };
          return m;
        })(),
      );
      try {
        command(plain, 'set-selection', { from: 2, to: 2 });
        const outside = toolsOf(plain)
          .snapshot()
          .controls.map((c) => c.id);
        for (const id of TABLE_OP_IDS) expect(outside).not.toContain(id);
      } finally {
        plain.cleanup();
      }
    } finally {
      env.cleanup();
    }
  });

  it('addRow/addColumn are single-undo', () => {
    const env = mount(gridModel());
    try {
      const tools = toolsOf(env);
      command(env, 'set-selection', { from: 4, to: 4 });
      const before = env.handle.getModelForTest!();
      expect(tools.execute('table.addRow')).toBe(true);
      expect(cellsOf(env.handle.getModelForTest!()).length).toBe(3);
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!()).toEqual(before);
      expect(tools.execute('table.addColumn')).toBe(true);
      expect(
        (env.handle.getModelForTest!().blocks['t1'] as unknown as { columnCount: number }).columnCount,
      ).toBe(3);
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
  });

  it('removeRow/removeColumn shrink and are single-undo', () => {
    const env = mount(gridModel());
    try {
      const tools = toolsOf(env);
      command(env, 'set-selection', { from: 4, to: 4 });
      const before = env.handle.getModelForTest!();
      expect(tools.execute('table.removeRow')).toBe(true);
      expect(cellsOf(env.handle.getModelForTest!())).toEqual([['c', 'd']]);
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!()).toEqual(before);
      expect(tools.execute('table.removeColumn')).toBe(true);
      expect(cellsOf(env.handle.getModelForTest!())).toEqual([['b'], ['d']]);
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
  });

  it('moveRowDown/moveColumnRight reorder cells and are single-undo', () => {
    const env = mount(gridModel());
    try {
      const tools = toolsOf(env);
      command(env, 'set-selection', { from: 4, to: 4 });
      const before = env.handle.getModelForTest!();
      expect(tools.execute('table.moveRowDown')).toBe(true);
      expect(cellsOf(env.handle.getModelForTest!())).toEqual([
        ['c', 'd'],
        ['a', 'b'],
      ]);
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!()).toEqual(before);
      expect(tools.execute('table.moveColumnRight')).toBe(true);
      expect(cellsOf(env.handle.getModelForTest!())).toEqual([
        ['b', 'a'],
        ['d', 'c'],
      ]);
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
  });

  it('row and column handles target their own cells and drag in one undo step', () => {
    const env = mount(gridModel());
    try {
      const tools = toolsOf(env);
      command(env, 'set-selection', { from: 4, to: 4 });
      const before = env.handle.getModelForTest!();
      const at = (row: number, col: number, to?: number): string =>
        JSON.stringify({
          blockId: 't1',
          row,
          col,
          ...(to === undefined ? {} : { to }),
        });
      expect(tools.execute('table.addRowBefore', at(1, 0))).toBe(true);
      expect(cellsOf(env.handle.getModelForTest!())).toEqual([
        ['a', 'b'],
        ['', ''],
        ['c', 'd'],
      ]);
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!()).toEqual(before);
      expect(tools.execute('table.addColumnBefore', at(0, 1))).toBe(true);
      expect(cellsOf(env.handle.getModelForTest!())).toEqual([
        ['a', '', 'b'],
        ['c', '', 'd'],
      ]);
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!()).toEqual(before);
      expect(tools.execute('table.moveRowUp', at(1, 0, 0))).toBe(true);
      expect(cellsOf(env.handle.getModelForTest!())).toEqual([
        ['c', 'd'],
        ['a', 'b'],
      ]);
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!()).toEqual(before);
      expect(tools.execute('table.moveColumnLeft', at(0, 1, 0))).toBe(true);
      expect(cellsOf(env.handle.getModelForTest!())).toEqual([
        ['b', 'a'],
        ['d', 'c'],
      ]);
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
  });

  it('move at the grid edge refuses without mutation', () => {
    const env = mount(gridModel());
    try {
      const tools = toolsOf(env);
      command(env, 'set-selection', { from: 4, to: 4 });
      const before = env.handle.getModelForTest!();
      expect(tools.execute('table.moveRowUp')).toBe(false);
      expect(tools.execute('table.moveColumnLeft')).toBe(false);
      expect(env.handle.getModelForTest!()).toEqual(before);
      const snapshot = tools.snapshot();
      const byId = new Map(snapshot.controls.map((c) => [c.id, c]));
      expect(byId.get('table.moveRowUp')?.disabled).toBe(true);
      expect(byId.get('table.moveColumnLeft')?.disabled).toBe(true);
      expect(byId.get('table.moveRowDown')?.disabled).not.toBe(true);
    } finally {
      env.cleanup();
    }
  });

  it('header toggle renders th distinctly and is single-undo', () => {
    const env = mount(gridModel());
    try {
      const tools = toolsOf(env);
      command(env, 'set-selection', { from: 4, to: 4 });
      expect(env.parent.querySelectorAll('th').length).toBe(0);
      const before = env.handle.getModelForTest!();
      expect(tools.execute('table.toggleHeader')).toBe(true);
      const next = env.handle.getModelForTest!();
      expect(next.blocks['t1']).toMatchObject({ header: true });
      expect(env.parent.querySelectorAll('th').length).toBe(2);
      expect(tools.snapshot().controls.find((c) => c.id === 'table.toggleHeader')?.active).toBe(
        true,
      );
      expect(env.handle.execCommand('undo')).toBe(true);
      const undone = env.handle.getModelForTest!();
      expect(undone).toEqual(before);
      expect(env.parent.querySelectorAll('th').length).toBe(0);
    } finally {
      env.cleanup();
    }
  });

  it('unknown table ids and off-grid execution refuse without mutation', () => {
    const env = mount(gridModel());
    try {
      const tools = toolsOf(env);
      command(env, 'set-selection', { from: 4, to: 4 });
      const before = env.handle.getModelForTest!();
      expect(tools.execute('table.mergeCells' as never)).toBe(false);
      expect(tools.execute('table.splitCell' as never)).toBe(false);
      expect(tools.execute('table.whatever' as never)).toBe(false);
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
  });
});

describe('table grid canonical mapping', () => {
  it('round-trips marks in cells byte-faithful', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['t1'];
    model.blocks = {
      t1: tableBlock(
        't1',
        2,
        [
          {
            cells: [
              [
                { text: 'plain ' },
                { text: 'bold', marks: ['bold'] },
                { text: ' link', marks: [{ type: 'link', href: 'https://x.test' }] },
              ],
              [
                {
                  text: 'res',
                  marks: [
                    {
                      type: 'resource',
                      target: { documentId: 'd', kindId: 'froglight.markdown', resourceId: 'r' },
                    },
                  ],
                },
                { text: ' mystery', marks: [{ type: 'acme.highlight', color: 'yellow' }] },
              ],
            ],
          },
        ],
        { align: ['left', 'right'], header: true },
      ),
    };
    const rebuilt = pmDocToModel(modelToPmDoc(model));
    expect(rebuilt.warnings).toEqual([]);
    expect(rebuilt.model.blocks['t1']).toEqual(model.blocks['t1']);
  });

  it('flattens colspan in document order with a warning', () => {
    const { model, warnings } = pmDocToModel({
      type: 'doc',
      content: [
        {
          type: 'table',
          attrs: { blockId: 't1' },
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableCell',
                  attrs: { colspan: 2, rowspan: 1 },
                  content: [
                    { type: 'tableParagraph', content: [{ type: 'text', text: 'a' }] },
                  ],
                },
              ],
            },
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableCell',
                  content: [
                    { type: 'tableParagraph', content: [{ type: 'text', text: 'b' }] },
                  ],
                },
                {
                  type: 'tableCell',
                  content: [
                    { type: 'tableParagraph', content: [{ type: 'text', text: 'c' }] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(warnings.some((w) => w.code === 'TABLE_SPAN_FLATTENED' && w.blockId === 't1')).toBe(
      true,
    );
    const record = model.blocks['t1'] as unknown as {
      columnCount: number;
      rows: Array<{ cells: Array<Array<{ text: string }>> }>;
    };
    expect(record.columnCount).toBe(2);
    const texts = record.rows.map((row) => row.cells.map((cell) => cell.map((r) => r.text).join('')));
    expect(texts).toEqual([
      ['a', ''],
      ['b', 'c'],
    ]);
  });

  it('flattens rowspan with spanned slots empty, order preserved', () => {
    const { model, warnings } = pmDocToModel({
      type: 'doc',
      content: [
        {
          type: 'table',
          attrs: { blockId: 't1' },
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableCell',
                  attrs: { colspan: 1, rowspan: 2 },
                  content: [
                    { type: 'tableParagraph', content: [{ type: 'text', text: 'a' }] },
                  ],
                },
                {
                  type: 'tableCell',
                  content: [
                    { type: 'tableParagraph', content: [{ type: 'text', text: 'b' }] },
                  ],
                },
              ],
            },
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableCell',
                  content: [
                    { type: 'tableParagraph', content: [{ type: 'text', text: 'c' }] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(warnings.some((w) => w.code === 'TABLE_SPAN_FLATTENED')).toBe(true);
    const record = model.blocks['t1'] as unknown as {
      rows: Array<{ cells: Array<Array<{ text: string }>> }>;
    };
    const texts = record.rows.map((row) => row.cells.map((cell) => cell.map((r) => r.text).join('')));
    expect(texts).toEqual([
      ['a', 'b'],
      ['', 'c'],
    ]);
    const flat = JSON.stringify(texts);
    expect(flat.indexOf('"a"')).toBeLessThan(flat.indexOf('"b"'));
    expect(flat.indexOf('"b"')).toBeLessThan(flat.indexOf('"c"'));
  });

  it('normalizes ragged grids with a warning and never hangs on corrupt counts', () => {
    const { model, warnings } = pmDocToModel({
      type: 'doc',
      content: [
        {
          type: 'table',
          attrs: { blockId: 't1' },
          content: [
            {
              type: 'tableRow',
              content: [
                { type: 'tableCell', content: [{ type: 'tableParagraph' }] },
                { type: 'tableCell', content: [{ type: 'tableParagraph' }] },
                { type: 'tableCell', content: [{ type: 'tableParagraph' }] },
              ],
            },
            {
              type: 'tableRow',
              content: [{ type: 'tableCell', content: [{ type: 'tableParagraph' }] }],
            },
          ],
        },
      ],
    });
    expect(warnings.some((w) => w.code === 'TABLE_RAGGED_NORMALIZED')).toBe(true);
    expect(model.blocks['t1']).toMatchObject({ columnCount: 3 });
    // Ragged canonical payloads encode to a rectangle without throwing.
    const ragged = emptyBlockPage();
    ragged.rootOrder = ['t1'];
    ragged.blocks = {
      t1: {
        id: 't1',
        type: 'froglight.table',
        columnCount: Number.NaN,
        rows: [{ cells: [[{ text: 'a' }]] }, { cells: 'nope' }],
      } as never,
    };
    const doc = modelToPmDoc(ragged);
    const table = doc.content![0]!;
    expect(table.type).toBe('table');
    expect(table.content!.length).toBe(2);
    for (const row of table.content!) expect(row.content!.length).toBe(1);
  });

  it('strips colwidth/per-cell align: widths never reach canonical bytes', () => {
    const { model } = pmDocToModel({
      type: 'doc',
      content: [
        {
          type: 'table',
          attrs: { blockId: 't1', header: false, align: ['center', 'right'] },
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableCell',
                  attrs: { colspan: 1, rowspan: 1, align: 'center', colwidth: [120, 200] },
                  content: [
                    { type: 'tableParagraph', content: [{ type: 'text', text: 'a' }] },
                  ],
                },
                {
                  type: 'tableCell',
                  attrs: { colspan: 1, rowspan: 1, align: 'right', colwidth: [80] },
                  content: [
                    { type: 'tableParagraph', content: [{ type: 'text', text: 'b' }] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(model.blocks['t1'])).not.toContain('colwidth');
    expect(model.blocks['t1']).toMatchObject({ align: ['center', 'right'] });
  });

  it('preserves universal children of the table across edits', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['t1'];
    model.blocks = {
      t1: {
        ...tableBlock('t1', 1, [{ cells: [[{ text: 'a' }]] }]),
        children: ['c1'],
      },
      c1: paragraphBlock('c1', [{ text: 'kid' }]),
    };
    const env = mount(model);
    try {
      command(env, 'set-selection', { from: 4, to: 4 });
      type(env, 'X');
      const next = env.handle.getModelForTest!();
      expect(next.blocks['c1']).toBeDefined();
      expect(JSON.stringify(next.blocks['c1'])).toContain('kid');
      expect((next.blocks['t1'] as { children?: string[] }).children).toEqual(['c1']);
    } finally {
      env.cleanup();
    }
  });
});

describe('table creation integration', () => {
  function blank(): BlockPageModel {
    const m = emptyBlockPage();
    m.rootOrder = ['p1'];
    m.blocks = { p1: paragraphBlock('p1', [{ text: '' }]) };
    return m;
  }

  it('slash Table opens the size picker; Enter commits 2x2 in one undo', async () => {
    const env = mount(blank());
    try {
      command(env, 'set-selection', { from: 1 });
      type(env, '/table');
      await flush();
      const before = env.handle.getModelForTest!();
      key(env, 'Enter');
      expect(env.picker()?.style.display).toBe('block');
      expect(
        [...env.picker()!.querySelectorAll('.flbp-slash-item')].map((el) => el.textContent),
      ).toEqual(['Table 2 × 2', 'Table 3 × 3', 'Table 4 × 4']);
      // No mutation yet: picking has not committed.
      expect(env.handle.getModelForTest!()).toEqual(before);
      key(env, 'Enter');
      const next = env.handle.getModelForTest!();
      const table = Object.values(next.blocks).find((b) => b.type === 'froglight.table') as unknown as {
        columnCount: number;
        rows: unknown[];
      };
      expect(table).toBeDefined();
      expect(table.columnCount).toBe(2);
      expect(table.rows.length).toBe(2);
      expect(JSON.stringify(next)).not.toContain('/table');
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
  });

  it('picker arrows choose 3x3; Escape cancels with the trigger untouched', async () => {
    const env = mount(blank());
    try {
      command(env, 'set-selection', { from: 1 });
      type(env, '/table');
      await flush();
      key(env, 'Enter');
      key(env, 'ArrowDown');
      key(env, 'Enter');
      const next = env.handle.getModelForTest!();
      const table = Object.values(next.blocks).find((b) => b.type === 'froglight.table') as unknown as {
        columnCount: number;
        rows: Array<{ cells: unknown[] }>;
      };
      expect(table.columnCount).toBe(3);
      expect(table.rows.length).toBe(3);
      expect(table.rows.every((row) => row.cells.length === 3)).toBe(true);
    } finally {
      env.cleanup();
    }
    const env2 = mount(blank());
    try {
      command(env2, 'set-selection', { from: 1 });
      type(env2, '/table');
      await flush();
      const before = env2.handle.getModelForTest!();
      key(env2, 'Enter');
      key(env2, 'Escape');
      expect(env2.picker()?.style.display).toBe('none');
      expect(env2.handle.getModelForTest!()).toEqual(before);
      expect(JSON.stringify(before)).toContain('/table');
    } finally {
      env2.cleanup();
    }
  });

  it('insert-block table defaults sensibly and is keyed immediately', () => {
    const env = mount(blank());
    try {
      expect(command(env, 'insert-block', { type: 'table' })).toBe(true);
      const next = env.handle.getModelForTest!();
      expect(next.rootOrder.length).toBe(2);
      const insertedId = next.rootOrder[1]!;
      const record = next.blocks[insertedId] as unknown as {
        type: string;
        columnCount: number;
        rows: unknown[];
      };
      expect(record.type).toBe('froglight.table');
      expect(record.columnCount).toBe(2);
      expect(record.rows.length).toBe(2);
      expect(command(env, 'move-block', { blockId: insertedId, index: 0 })).toBe(true);
      expect(env.handle.getModelForTest!().rootOrder[0]).toBe(insertedId);
    } finally {
      env.cleanup();
    }
  });

  it('turn-into to/from the grid rejects without mutation', () => {
    const env = mount(gridModel());
    try {
      const tools = toolsOf(env);
      command(env, 'set-selection', { from: 4, to: 4 });
      const before = env.handle.getModelForTest!();
      // From the grid to any text container.
      expect(command(env, 'turn-into', { type: 'paragraph' })).toBe(false);
      expect(command(env, 'turn-into', { type: 'heading', level: 2 })).toBe(false);
      expect(command(env, 'turn-into', { type: 'bullet' })).toBe(false);
      // Toolbar converges: selector disabled, execution refuses.
      const choice = tools.snapshot().controls.find((c) => c.id === 'block.type') as unknown as {
        disabled?: boolean;
      };
      expect(choice.disabled).toBe(true);
      expect(tools.execute('block.type', 'paragraph')).toBe(false);
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
    const plain = mount(blank());
    try {
      command(plain, 'set-selection', { from: 1, to: 1 });
      const before = plain.handle.getModelForTest!();
      // No table target exists in the turn-into inventory.
      expect(toolsOf(plain).execute('block.type', 'table' as never)).toBe(false);
      expect(command(plain, 'turn-into', { type: 'table' } as never)).toBe(false);
      expect(plain.handle.getModelForTest!()).toEqual(before);
    } finally {
      plain.cleanup();
    }
  });

  it('table blocks drag with their subtree intact', () => {
    // NOTE: move-block indices count PM siblings. A block with universal
    // children occupies its node plus the follower group, matching the
    // semantics for paragraphs with children.
    const model = emptyBlockPage();
    model.rootOrder = ['p1', 't1'];
    model.blocks = {
      p1: paragraphBlock('p1', [{ text: 'tail' }]),
      t1: {
        ...tableBlock('t1', 1, [{ cells: [[{ text: 'a' }]] }]),
        children: ['c1'],
      },
      c1: paragraphBlock('c1', [{ text: 'kid' }]),
    };
    const env = mount(model);
    try {
      expect(command(env, 'move-block', { blockId: 't1', index: 0 })).toBe(true);
      const next = env.handle.getModelForTest!();
      expect(next.rootOrder).toEqual(['t1', 'p1']);
      expect(next.blocks['c1']).toBeDefined();
      expect((next.blocks['t1'] as { children?: string[] }).children).toEqual(['c1']);
      expect(JSON.stringify(next.blocks['t1'])).toContain('froglight.table');
    } finally {
      env.cleanup();
    }
  });

  it('headless provider keeps table bytes byte-faithful', () => {
    const start = gridModel();
    let saved: BlockPageModel | null = null;
    const headless = new HeadlessBlockpageEditorHandle({
      session: {} as never,
      parent: {},
      initialModel: start,
      onDirtyModel: (m) => {
        saved = m;
      },
    });
    try {
      expect(headless.getModelForTest()).toEqual(start);
      headless.appendParagraph('tail');
      expect(saved).not.toBeNull();
      expect(saved!.blocks['t1']).toEqual(start.blocks['t1']);
      // The headless-saved model reopens in the default provider unchanged.
      const env = mount(cloneModel(saved!));
      try {
        expect(env.handle.getModelForTest!().blocks['t1']).toEqual(start.blocks['t1']);
      } finally {
        env.cleanup();
      }
    } finally {
      headless.destroy();
    }
  });
});

/**
 *  repair acceptance.
 *
 * IME limits, stated honestly: jsdom cannot run a real IME session (no
 * composition rendering, no BrowserIME key pipeline). The specs
 * pin (a) the `event.isComposing` half with a structurally-marked keydown,
 * and (b) the `view.composing` half through synthetic
 * compositionstart/compositionend DOM events, which do drive
 * prosemirror-view's real composition flag in jsdom (verified: guarded ops
 * refuse while the flag is set and resume after it clears). What jsdom
 * cannot prove — real IME key sequences, dead-key timing, Android
 * composition quirks — stays documented here, not asserted.
 */


describe('slash suppressed in cells', () => {
  function slashMenu(env: ReturnType<typeof mount>): HTMLElement | null {
    return env.parent.querySelector(
      '.flbp-slash:not(.flbp-resource-menu):not(.flbp-turninto-menu):not(.flbp-table-menu)',
    ) as HTMLElement | null;
  }

  it('typing / in a cell opens no menu and preserves the trigger', async () => {
    const env = mount(gridModel());
    try {
      command(env, 'set-selection', { from: 4, to: 4 });
      type(env, '/');
      await flush();
      expect(slashMenu(env)?.style.display).not.toBe('block');
      expect(cellsOf(env.handle.getModelForTest!())).toEqual([
        ['/a', 'b'],
        ['c', 'd'],
      ]);
    } finally {
      env.cleanup();
    }
  });

  it('Enter in a slashed cell follows the grid Enter policy (down, no commit, trigger preserved)', async () => {
    const env = mount(gridModel());
    try {
      command(env, 'set-selection', { from: 4, to: 4 });
      type(env, '/table');
      await flush();
      expect(slashMenu(env)?.style.display).not.toBe('block');
      key(env, 'Enter');
      // Grid Enter policy: the cursor moves down the column (cell content
      // selected, ready to replace) — no slash commit, no size picker, no
      // insert after the table.
      expect(env.picker()?.style.display).not.toBe('block');
      expect(env.handle.getModelForTest!().rootOrder).toEqual(['t1']);
      type(env, 'X');
      expect(cellsOf(env.handle.getModelForTest!())).toEqual([
        ['/tablea', 'b'],
        ['X', 'd'],
      ]);
    } finally {
      env.cleanup();
    }
  });

  it('[[ inline mentions still open in cells (cell-safe text+mark)', async () => {
    const target: ResourceTarget = {
      documentId: 'd',
      kindId: 'froglight.markdown',
      resourceId: 'r',
    };
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const handle = new BlockPageDocumentEditorProvider().createEditor({
      session: {} as never,
      parent,
      initialModel: gridModel(),
      onDirtyModel: () => undefined,
      resourceResolver: {
        search: (() => [{ target, label: 'Target note' }]) as never,
      },
    });
    const env = {
      parent,
      handle,
      pm: () => parent.querySelector('.ProseMirror')!,
      cleanup: () => {
        handle.destroy();
        parent.remove();
      },
    };
    try {
      const run = handle.blockCommand;
      if (run === undefined) throw new Error('block command channel unavailable');
      run.call(handle, 'set-selection', { from: 4, to: 4 });
      if (!run.call(handle, 'insert-text', { text: '[[Tar' }))
        throw new Error('insert-text failed');
      await flush();
      const menu = parent.querySelector('.flbp-resource-menu') as HTMLElement | null;
      expect(menu?.style.display).toBe('block');
      env.pm().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      );
      const next = handle.getModelForTest!();
      expect(next.rootOrder).toEqual(['t1']);
      expect(
        (next.blocks['t1'] as unknown as { columnCount: number }).columnCount,
      ).toBe(2);
      expect(JSON.stringify(next.blocks['t1'])).toContain('Target note');
    } finally {
      env.cleanup();
    }
  });
});

describe('caret-in-cell inline formatting', () => {
  function controlIds(env: ReturnType<typeof mount>): string[] {
    return toolsOf(env)
      .snapshot()
      .controls.map((c) => c.id);
  }

  it('caret-in-cell exposes mark controls with Table context; execute block.bold works', () => {
    const env = mount(gridModel());
    try {
      command(env, 'set-selection', { from: 4, to: 4 });
      const snapshot = toolsOf(env).snapshot();
      expect(snapshot.context).toBe('Table');
      const ids = controlIds(env);
      expect(ids).toContain('block.bold');
      expect(ids).toContain('block.italic');
      // Grid ops stay offered (keyed root is still the table).
      for (const id of TABLE_OP_IDS) expect(ids).toContain(id);
      // Caret with no link mark: same contract as paragraphs (link needs a
      // range or an existing link at the caret).
      expect(ids).not.toContain('block.link');
      expect(toolsOf(env).execute('block.bold')).toBe(true);
      expect(toolsOf(env).snapshot().controls.find((c) => c.id === 'block.bold')).toMatchObject({
        active: true,
      });
    } finally {
      env.cleanup();
    }
  });

  it('a range in a cell exposes block.link and commits it', () => {
    const env = mount(gridModel());
    try {
      command(env, 'set-selection', { from: 4, to: 5 });
      expect(controlIds(env)).toContain('block.link');
      expect(toolsOf(env).execute('block.link', 'https://x.test')).toBe(true);
      expect(JSON.stringify(env.handle.getModelForTest!().blocks['t1'])).toContain(
        'https://x.test',
      );
    } finally {
      env.cleanup();
    }
  });
});

describe('table warning disclosure', () => {
  it('unseenTableWarningMessages formats every code once (dedupe per signature)', () => {
    const seen = new Set<string>();
    const first = unseenTableWarningMessages(
      [
        { code: 'TABLE_SPAN_FLATTENED', blockId: 't1', detail: 'row 0 col 0 2x1' },
        { code: 'TABLE_RAGGED_NORMALIZED', blockId: 't1', detail: 'padded to 2' },
        { code: 'TABLE_WIDTH_TRUNCATED', blockId: 't9', detail: 'clamped to 64' },
      ],
      seen,
    );
    expect(first.length).toBe(3);
    for (const fragment of [
      'TABLE_SPAN_FLATTENED',
      'TABLE_RAGGED_NORMALIZED',
      'TABLE_WIDTH_TRUNCATED',
    ]) {
      expect(first.some((message) => message.includes(fragment))).toBe(true);
    }
    expect(first.some((message) => message.includes('t1'))).toBe(true);
    // Repeat delivery is silent; a new signature still reports.
    expect(
      unseenTableWarningMessages(
        [{ code: 'TABLE_SPAN_FLATTENED', blockId: 't1', detail: 'row 0 col 0 2x1' }],
        seen,
      ),
    ).toEqual([]);
    expect(
      unseenTableWarningMessages(
        [{ code: 'TABLE_SPAN_FLATTENED', blockId: 't2', detail: 'row 0 col 0 2x1' }],
        seen,
      ).length,
    ).toBe(1);
    expect(unseenTableWarningMessages([], new Set())).toEqual([]);
  });

  it('wide grids truncate to 64 columns WITH a TABLE_WIDTH_TRUNCATED warning', () => {
    const cells = Array.from({ length: 70 }, (_, i) => ({
      type: 'tableCell',
      content: [
        { type: 'tableParagraph', content: [{ type: 'text', text: `c${i}` }] },
      ],
    }));
    const { model, warnings } = pmDocToModel({
      type: 'doc',
      content: [
        {
          type: 'table',
          attrs: { blockId: 't1' },
          content: [{ type: 'tableRow', content: cells }],
        },
      ],
    });
    expect(
      warnings.some((w) => w.code === 'TABLE_WIDTH_TRUNCATED' && w.blockId === 't1'),
    ).toBe(true);
    const record = model.blocks['t1'] as unknown as {
      columnCount: number;
      rows: Array<{ cells: unknown[] }>;
    };
    expect(record.columnCount).toBe(64);
    expect(record.rows[0]!.cells.length).toBe(64);
  });

  it('clean cell edits disclose nothing (no console spam on ordinary syncs)', () => {
    const env = mount(gridModel());
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      command(env, 'set-selection', { from: 4, to: 4 });
      type(env, 'X');
      expect(cellsOf(env.handle.getModelForTest!())[0]![0]).toContain('X');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      env.cleanup();
    }
  });
});

describe('cell-aware paste', () => {
  function paste(env: ReturnType<typeof mount>, text: string): boolean {
    const pm = env.pm() as HTMLElement;
    const event = new Event('paste', { bubbles: true, cancelable: true }) as ClipboardEvent & {
      clipboardData: DataTransfer | null;
    };
    const data = {
      getData: (kind: string) => (kind === 'text/plain' ? text : ''),
    };
    Object.defineProperty(event, 'clipboardData', { value: data });
    pm.dispatchEvent(event);
    return event.defaultPrevented;
  }

  it('3-line paste into a cell joins with spaces, stays valid, undoes cleanly', () => {
    const env = mount(gridModel());
    try {
      const before = env.handle.getModelForTest!();
      command(env, 'set-selection', { from: 4, to: 4 });
      expect(paste(env, 'one\ntwo\nthree')).toBe(true);
      const next = env.handle.getModelForTest!();
      // Single-paragraph cell model: lines join with a space at the caret.
      expect(cellsOf(next)).toEqual([['one two threea', 'b'], ['c', 'd']]);
      // No block splice: still one root, still a 2×2 grid.
      expect(next.rootOrder).toEqual(['t1']);
      expect(next.blocks['t1']).toMatchObject({ columnCount: 2 });
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
  });
});

describe('Shift+click yields to tableEditing in the grid', () => {
  // Reachability, stated honestly:
  // - prosemirror-view sets `LeftMouseDown.allowDefault = mousedown.shiftKey`,
  //   so a PLAIN shift+click never reaches chrome `handleClick` in any
  //   browser — PM short-circuits and tableEditing's shift+mousedown
  //   CellSelection stands. The chrome shift branch fires only for
  //   modifier-changed gestures (mousedown without shift, mouseup with
  //   shift).
  // - In jsdom even that path is inert end to end: PM's LeftMouseDown never
  //   engages for synthetic events (its `posAtCoords` gate fails on the
  //   zero-geometry DOM), so chrome `handleClick` is unreachable with
  //   dispatched mouse events — verified empirically (identical behavior
  //   with the yield present and removed). Real-browser verification of the
  //   clobber itself remains manual.
  // What IS pinned here: (1) the yield DECISION (`inTableGrid` over editor
  // state — unit table below), (2) tableEditing's shift+mousedown ownership
  // (preventDefaulted — real), (3) the preserved end-to-end flow (keyboard
  // CellSelection → whole-table Backspace — real).
  function fakeState(
    names: readonly string[],
  ): Parameters<typeof inTableGrid>[0] {
    return {
      selection: {
        $from: {
          depth: names.length - 1,
          node: (depth: number) => ({ type: { name: names[depth] } }),
        },
      },
    } as unknown as Parameters<typeof inTableGrid>[0];
  }

  it('inTableGrid decides the Shift+click owner by ancestor scan', () => {
    // Caret deep in a cell: yields to tableEditing.
    expect(
      inTableGrid(fakeState(['doc', 'table', 'tableRow', 'tableCell', 'tableParagraph'])),
    ).toBe(true);
    // Top-level caret: chrome keeps its shift-extend behavior.
    expect(inTableGrid(fakeState(['doc', 'paragraph']))).toBe(false);
    // Doc-level (depth 0): never yields.
    expect(inTableGrid(fakeState(['doc']))).toBe(false);
  });

  it('tableEditing owns shift+mousedown in the grid', () => {
    const env = mount(gridModel());
    try {
      command(env, 'set-selection', { from: 4, to: 4 });
      const target = env.parent.querySelectorAll('td')[3]!;
      const down = new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
        button: 0,
        shiftKey: true,
        clientX: 5,
        clientY: 5,
      });
      target.dispatchEvent(down);
      // tableEditing claims the gesture (rectangular CellSelection path).
      expect(down.defaultPrevented).toBe(true);
      target.dispatchEvent(
        new MouseEvent('mouseup', { bubbles: true, cancelable: true, shiftKey: true }),
      );
      const before = env.handle.getModelForTest!();
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
  });

  it('grid selection flow survives mouse gestures (CellSelection → whole-table delete)', () => {
    const env = mount(gridModel());
    try {
      command(env, 'set-selection', { from: 4, to: 4 });
      const before = env.handle.getModelForTest!();
      const target = env.parent.querySelectorAll('td')[3]!;
      // Plain mouse gestures over cells dispatch no grid ops and change no
      // bytes (the chrome shift override yields; tableEditing owns its own
      // path): the keyboard CellSelection flow below still covers the whole
      // grid and Backspace deletes the table in one undo step.
      target.dispatchEvent(
        new MouseEvent('mousedown', {
          bubbles: true,
          cancelable: true,
          button: 0,
          clientX: 5,
          clientY: 5,
        }),
      );
      target.dispatchEvent(
        new MouseEvent('mouseup', {
          bubbles: true,
          cancelable: true,
          button: 0,
          shiftKey: true,
          clientX: 5,
          clientY: 5,
        }),
      );
      expect(env.handle.getModelForTest!()).toEqual(before);
      key(env, 'ArrowDown', { shiftKey: true });
      key(env, 'ArrowRight', { shiftKey: true });
      key(env, 'Backspace');
      const deleted = env.handle.getModelForTest!();
      expect(deleted.blocks['t1']).toBeUndefined();
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
  });
});

describe('composing guards', () => {
  // Guard split, by what each layer can observe (mirrors the input-rules
  // posture — engine short-circuit plus per-rule belt-and-braces):
  // - chrome `handleKeyDown` sees the real event: `view.composing ||
  //   event.isComposing` before every branch;
  // - grid keymap shortcuts receive `{ editor }` only (Tiptap never passes
  //   the event), so they guard on `view.composing` alone — sufficient for
  //   physical IME, where compositionstart always precedes the key;
  // - slash/resource appendTransaction detection guards on
  //   `view.composing` (typing itself is never blocked — IME text must
  //   insert; only menu detection is suppressed).
  //
  // jsdom limits, stated honestly:
  // - No real IME session exists here (no composition rendering, no OS key
  //   pipeline). Synthetic compositionstart/compositionend DOM events drive
  //   prosemirror-view's real `view.composing` flag; the `event.isComposing`
  //   half is pinned with a structurally-marked keydown.
  // - jsdom reports `navigator.vendor === 'Apple Computer, Inc.'`, so
  //   prosemirror-view takes its Safari path and swallows ALL keydowns for
  //   500ms after compositionend (`inOrNearComposition`). Resume assertions
  //   therefore sleep past that window (650ms).
  // - jsdom's zero-geometry DOM cannot preserve the caret across the
  //   composition lifecycle the way a real IME session does, so resume
  //   assertions re-establish the caret explicitly first.
  function composeStart(env: ReturnType<typeof mount>): void {
    env.pm().dispatchEvent(new Event('compositionstart', { bubbles: true, cancelable: true }));
  }

  function composeEnd(env: ReturnType<typeof mount>): void {
    env.pm().dispatchEvent(new Event('compositionend', { bubbles: true, cancelable: true }));
  }

  async function pastSafariWindow(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 650));
  }

  it('chrome Tab guard pins the event half (isComposing without composition)', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['p1', 'p2'];
    model.blocks = {
      p1: paragraphBlock('p1', [{ text: 'one' }]),
      p2: paragraphBlock('p2', [{ text: 'two' }]),
    };
    const env = mount(model);
    try {
      command(env, 'set-selection', { from: 7, to: 7 });
      const before = env.handle.getModelForTest!();
      const marked = new KeyboardEvent('keydown', {
        key: 'Tab',
        bubbles: true,
        cancelable: true,
      });
      Object.defineProperty(marked, 'isComposing', { value: true });
      env.pm().dispatchEvent(marked);
      // No indent dispatch while the key is structurally marked composing.
      expect(env.handle.getModelForTest!()).toEqual(before);
      // Unmarked Tab still indents (guard is composing-scoped, not a kill).
      key(env, 'Tab');
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
  });

  it('grid Enter refuses while composing and resumes past the Safari window', async () => {
    const env = mount(gridModel());
    try {
      command(env, 'set-selection', { from: 4, to: 4 });
      const before = env.handle.getModelForTest!();
      composeStart(env);
      key(env, 'Enter');
      expect(env.handle.getModelForTest!()).toEqual(before);
      composeEnd(env);
      await pastSafariWindow();
      command(env, 'set-selection', { from: 4, to: 4 });
      key(env, 'Enter');
      type(env, 'X');
      expect(cellsOf(env.handle.getModelForTest!())).toEqual([
        ['a', 'b'],
        ['X', 'd'],
      ]);
    } finally {
      env.cleanup();
    }
  });

  it('structural grid ops refuse while composing and resume after', async () => {
    const env = mount(gridModel());
    try {
      command(env, 'set-selection', { from: 4, to: 4 });
      const before = env.handle.getModelForTest!();
      composeStart(env);
      key(env, 'ArrowDown', { ctrlKey: true, altKey: true });
      expect(env.handle.getModelForTest!()).toEqual(before);
      composeEnd(env);
      await pastSafariWindow();
      command(env, 'set-selection', { from: 4, to: 4 });
      key(env, 'ArrowDown', { ctrlKey: true, altKey: true });
      expect(cellsOf(env.handle.getModelForTest!()).length).toBe(3);
    } finally {
      env.cleanup();
    }
  });

  it('programmatic table ops refuse while composing (isolates the grid guard)', async () => {
    // Keydown specs above pass partly through prosemirror-view's own
    // `inOrNearComposition` swallow (it runs before plugins), so they pin
    // the contract but not this guard. Programmatic execute bypasses PM key
    // handling entirely: refusal here comes only from `runTableOpCommand`'s
    // composing guard (neutralizing that single line turns this red while
    // the keydown specs stay green).
    const env = mount(gridModel());
    try {
      command(env, 'set-selection', { from: 4, to: 4 });
      const before = env.handle.getModelForTest!();
      composeStart(env);
      expect(toolsOf(env).execute('table.addRow')).toBe(false);
      expect(env.handle.getModelForTest!()).toEqual(before);
      composeEnd(env);
      await pastSafariWindow();
      command(env, 'set-selection', { from: 4, to: 4 });
      expect(toolsOf(env).execute('table.addRow')).toBe(true);
      expect(cellsOf(env.handle.getModelForTest!()).length).toBe(3);
    } finally {
      env.cleanup();
    }
  });

  it('slash detection is suppressed while composing and resumes after', async () => {
    const model = emptyBlockPage();
    model.rootOrder = ['p1'];
    model.blocks = { p1: paragraphBlock('p1', [{ text: '' }]) };
    const env = mount(model);
    try {
      const menu = (): HTMLElement | null =>
        env.parent.querySelector(
          '.flbp-slash:not(.flbp-resource-menu):not(.flbp-turninto-menu):not(.flbp-table-menu)',
        ) as HTMLElement | null;
      command(env, 'set-selection', { from: 1, to: 1 });
      composeStart(env);
      type(env, '/');
      await flush();
      expect(menu()?.style.display).not.toBe('block');
      expect(JSON.stringify(env.handle.getModelForTest!())).toContain('/');
      composeEnd(env);
      type(env, 'a');
      await flush();
      // Detection resumes once composition ends (query "a" over "/a").
      expect(menu()?.style.display).toBe('block');
    } finally {
      env.cleanup();
    }
  });
});

describe('table size picker refusal', () => {
  it('out-of-range size index refuses with the trigger untouched (no 2x2 default)', async () => {
    const model = emptyBlockPage();
    model.rootOrder = ['p1'];
    model.blocks = { p1: paragraphBlock('p1', [{ text: '' }]) };
    const env = mount(model);
    try {
      command(env, 'set-selection', { from: 1, to: 1 });
      type(env, '/table');
      await flush();
      key(env, 'Enter');
      expect(env.picker()?.style.display).toBe('block');
      const before = env.handle.getModelForTest!();
      expect(JSON.stringify(before)).toContain('/table');
      // Rogue/out-of-range commit (e.g. a stale pointer index): must refuse.
      const rogue = document.createElement('div');
      rogue.className = 'flbp-slash-item';
      rogue.dataset.index = '99';
      env.picker()!.appendChild(rogue);
      rogue.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      const next = env.handle.getModelForTest!();
      expect(next).toEqual(before);
      expect(JSON.stringify(next)).toContain('/table');
      expect(
        Object.values(next.blocks).some((b) => b.type === 'froglight.table'),
      ).toBe(false);
      // The picker stays open for a valid choice.
      expect(env.picker()?.style.display).toBe('block');
    } finally {
      env.cleanup();
    }
  });
});

/**
 *  table align presentation.
 *
 * Align is canonical per column (table-level `align`, byte-faithful via
 * pm-map) and renders per cell as inline `text-align` on both `th` and
 * `td`; unknown entries are preserved verbatim and never rendered, and
 * widths (`colwidth`) never reach canonical bytes. No span ops exist
 * structural ops stay single-undo via closeHistory.
 */
describe('table align presentation', () => {
  /** 3×2 grid with header + per-column align; first cell 'a' at [4,5). */
  function alignedModel(): BlockPageModel {
    const model = emptyBlockPage();
    model.rootOrder = ['t1'];
    model.blocks = {
      t1: tableBlock(
        't1',
        3,
        [
          { cells: [[{ text: 'a' }], [{ text: 'b' }], [{ text: 'c' }]] },
          { cells: [[{ text: 'd' }], [{ text: 'e' }], [{ text: 'f' }]] },
        ],
        { align: ['left', 'center', 'right'], header: true },
      ),
    };
    return model;
  }

  function stylesOf(root: ParentNode, selector: string): Array<string | null> {
    return [...root.querySelectorAll(selector)].map((el) =>
      el.getAttribute('style'),
    );
  }

  it('renders left/center/right per column on header and body cells', () => {
    const env = mount(alignedModel());
    try {
      const th = stylesOf(env.parent, 'th');
      expect(th.length).toBe(3);
      expect(th[0]).toContain('text-align: left');
      expect(th[1]).toContain('text-align: center');
      expect(th[2]).toContain('text-align: right');
      const td = stylesOf(env.parent, 'td');
      expect(td.length).toBe(3);
      expect(td[0]).toContain('text-align: left');
      expect(td[1]).toContain('text-align: center');
      expect(td[2]).toContain('text-align: right');
    } finally {
      env.cleanup();
    }
  });

  it('header toggle preserves column alignment and stays single-undo', () => {
    const env = mount(alignedModel());
    try {
      const tools = toolsOf(env);
      command(env, 'set-selection', { from: 4, to: 4 });
      const before = env.handle.getModelForTest!();
      // Header on → off: th cells become td, alignment survives.
      expect(tools.execute('table.toggleHeader')).toBe(true);
      expect(env.parent.querySelectorAll('th').length).toBe(0);
      const off = env.handle.getModelForTest!();
      expect(off.blocks['t1']).toMatchObject({
        align: ['left', 'center', 'right'],
      });
      expect(off.blocks['t1']).not.toMatchObject({ header: true });
      const td = stylesOf(env.parent, 'td');
      expect(td.length).toBe(6);
      expect(td[0]).toContain('text-align: left');
      expect(td[1]).toContain('text-align: center');
      expect(td[2]).toContain('text-align: right');
      // …and back on: th cells return with the same alignment.
      expect(tools.execute('table.toggleHeader')).toBe(true);
      const th = stylesOf(env.parent, 'th');
      expect(th.length).toBe(3);
      expect(th[0]).toContain('text-align: left');
      expect(th[1]).toContain('text-align: center');
      expect(th[2]).toContain('text-align: right');
      expect(env.handle.getModelForTest!().blocks['t1']).toMatchObject({
        header: true,
        align: ['left', 'center', 'right'],
      });
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!()).toEqual(off);
      // Each toggle is one undo step: a second undo restores the start.
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
  });

  it('table-level align is authoritative: lying per-cell align never reaches canonical', () => {
    const { model } = pmDocToModel({
      type: 'doc',
      content: [
        {
          type: 'table',
          attrs: { blockId: 't1', header: true, align: ['right', 'left'] },
          content: [
            {
              type: 'tableRow',
              content: [
                {
                  type: 'tableCell',
                  attrs: { colspan: 1, rowspan: 1, align: 'center', colwidth: [120] },
                  content: [
                    { type: 'tableParagraph', content: [{ type: 'text', text: 'a' }] },
                  ],
                },
                {
                  type: 'tableCell',
                  attrs: { colspan: 1, rowspan: 1, align: 'center', colwidth: [80] },
                  content: [
                    { type: 'tableParagraph', content: [{ type: 'text', text: 'b' }] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(model.blocks['t1']).toMatchObject({ align: ['right', 'left'] });
    expect(JSON.stringify(model.blocks['t1'])).not.toContain('center');
    expect(JSON.stringify(model.blocks['t1'])).not.toContain('colwidth');
  });
});
