/**
 * table grid edge — columnCount sanitization, blockId stability,
 * and header/align rendering + preservation.
 *
 * Policy: header/align ride verbatim in the canonical record and now RENDER
 * (header row as <th>, per-cell text-align) while round-tripping
 * byte-faithful through pm-map. Corrupt columnCounts (NaN/Infinity/<=0)
 * degrade to a single column without throwing or hanging, carried
 * carried over from the retired atom).
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  emptyBlockPage,
  type BlockPageModel,
} from '@froglight/foundation';
import { BlockPageDocumentEditorProvider } from './editor.js';
import { modelToPmDoc, pmDocToModel } from './pm-map.js';

function mount(model: BlockPageModel) {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const handle = new BlockPageDocumentEditorProvider().createEditor({
    session: {} as never,
    parent,
    initialModel: model,
    onDirtyModel: () => undefined,
  });
  return {
    parent,
    handle,
    table: () =>
      parent.querySelector('table[data-flbp-grid]') as HTMLElement | null,
    cleanup: () => {
      handle.destroy();
      parent.remove();
    },
  };
}

function tableModel(columnCount: unknown): BlockPageModel {
  const model = emptyBlockPage();
  model.rootOrder = ['t1'];
  model.blocks = {
    t1: {
      id: 't1',
      type: 'froglight.table',
      columnCount,
      header: true,
      align: ['left', 'right'],
      rows: [{ cells: [[{ text: 'a' }], [{ text: 'b' }]] }],
    } as never,
  };
  return model;
}

afterEach(() => {
  document.body.replaceChildren();
  document.getElementById('flbp-chrome-styles')?.remove();
});

describe('table grid edge', () => {
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -3]) {
    it(`sanitizes columnCount ${String(bad)} to >=1 column without throwing`, () => {
      const env = mount(tableModel(bad));
      try {
        const el = env.table();
        expect(el).not.toBeNull();
        expect(el!.querySelectorAll('td, th').length).toBeGreaterThanOrEqual(1);
      } finally {
        env.cleanup();
      }
    });
  }

  it('renders blockId/header/align distinctly in the grid DOM', () => {
    const env = mount(tableModel(2));
    try {
      const el = env.table()!;
      expect(el.getAttribute('data-block-id')).toBe('t1');
      expect(el.getAttribute('data-header')).toBe('true');
      expect(JSON.parse(el.getAttribute('data-align') ?? 'null')).toEqual([
        'left',
        'right',
      ]);
      // Header row renders as th (distinct), body as td.
      expect(el.querySelectorAll('th').length).toBe(2);
      const cells = [...el.querySelectorAll('th')];
      expect(cells[0]!.textContent).toBe('a');
      expect(cells[1]!.textContent).toBe('b');
    } finally {
      env.cleanup();
    }
  });

  it('renders per-column alignment on header cells', () => {
    const env = mount(tableModel(2));
    try {
      const cells = [...env.table()!.querySelectorAll('th')];
      expect(cells.length).toBe(2);
      // Canonical align ['left', 'right'] renders per column on the th row.
      expect(cells[0]!.getAttribute('style')).toContain('text-align: left');
      expect(cells[1]!.getAttribute('style')).toContain('text-align: right');
    } finally {
      env.cleanup();
    }
  });

  it('never renders unknown align values but preserves them verbatim', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['t1'];
    model.blocks = {
      t1: {
        id: 't1',
        type: 'froglight.table',
        columnCount: 2,
        // NOTE: no `header` key — decode normalizes `header: false` to
        // absent (both mean no header row), so the fixture omits it to
        // stay byte-comparable through the round-trip.
        align: ['justify', 42],
        rows: [{ cells: [[{ text: 'a' }], [{ text: 'b' }]] }],
      } as never,
    };
    const env = mount(model);
    try {
      const el = env.table()!;
      // Table-level align rides verbatim even when unrenderable.
      expect(JSON.parse(el.getAttribute('data-align') ?? 'null')).toEqual([
        'justify',
        42,
      ]);
      // Neither cell renders a text-align style for unknown values.
      for (const cell of el.querySelectorAll('td')) {
        expect(cell.getAttribute('style') ?? '').not.toContain('text-align');
      }
    } finally {
      env.cleanup();
    }
    // Canonical round-trip keeps the unknown entries byte-faithful.
    const rebuilt = pmDocToModel(modelToPmDoc(model)).model;
    expect(rebuilt.blocks['t1']).toEqual(model.blocks['t1']);
    expect(JSON.stringify(rebuilt.blocks['t1'])).not.toContain('colwidth');
  });

  it('preserves header/align through the canonical grid round-trip', () => {
    const model = tableModel(2);
    const rebuilt = pmDocToModel(modelToPmDoc(model)).model;
    expect(rebuilt.blocks['t1']).toMatchObject({
      header: true,
      align: ['left', 'right'],
      columnCount: 2,
    });
    expect(rebuilt.blocks['t1']).toEqual(model.blocks['t1']);
  });

  it('keeps cell edits on the same blockId', () => {
    const env = mount(tableModel(2));
    try {
      const run = env.handle.blockCommand;
      expect(run).toBeDefined();
      // Caret into the first cell text (doc 0 > table 0 > row 1 > cell 2 >
      // para 3 > text 'a' at [4,5)) and type through the real pipeline.
      run!.call(env.handle, 'set-selection', { from: 4, to: 4 });
      expect(run!.call(env.handle, 'insert-text', { text: 'X' })).toBe(true);
      const next = env.handle.getModelForTest!();
      expect(next.rootOrder).toEqual(['t1']);
      const record = next.blocks['t1'] as unknown as {
        rows: Array<{ cells: Array<Array<{ text: string }>> }>;
      };
      expect(JSON.stringify(record.rows)).toContain('X');
      // blockId stable, header/align untouched by the cell edit.
      expect(next.blocks['t1']).toMatchObject({
        header: true,
        align: ['left', 'right'],
        columnCount: 2,
      });
    } finally {
      env.cleanup();
    }
  });
});
