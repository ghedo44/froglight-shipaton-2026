import { describe, expect, it } from 'vitest';
import {
  dockLeafIds,
  dockStripRows,
  isDockLeaf,
  type DockNodeView,
} from './dock-tree.js';

const leaf = (pane: string): DockNodeView => ({ kind: 'leaf', pane });
const h = (ratio: number, first: DockNodeView, second: DockNodeView): DockNodeView => ({
  kind: 'split',
  direction: 'horizontal',
  ratio,
  first,
  second,
});
const v = (ratio: number, first: DockNodeView, second: DockNodeView): DockNodeView => ({
  kind: 'split',
  direction: 'vertical',
  ratio,
  first,
  second,
});

describe('dock tree view helpers', () => {
  it('lists leaves in visual order', () => {
    const tree = h(0.5, leaf('main'), v(0.5, leaf('p2'), leaf('p3')));
    expect(dockLeafIds(tree)).toEqual(['main', 'p2', 'p3']);
    expect(dockLeafIds(null)).toEqual([]);
  });

  it('detects leaves', () => {
    expect(isDockLeaf(leaf('main'))).toBe(true);
    expect(isDockLeaf(h(0.5, leaf('a'), leaf('b')))).toBe(false);
  });

  it('side-by-side panes share one strip row with their width fractions', () => {
    const tree = h(0.6, leaf('main'), leaf('p2'));
    expect(dockStripRows(tree)).toEqual([
      [
        { pane: 'main', left: 0, width: 0.6 },
        { pane: 'p2', left: 0.6, width: 0.4 },
      ],
    ]);
  });

  it('a vertical split gives the lower pane its own strip row', () => {
    const tree = v(0.5, leaf('main'), leaf('p2'));
    expect(dockStripRows(tree)).toEqual([
      [{ pane: 'main', left: 0, width: 1 }],
      [{ pane: 'p2', left: 0, width: 1 }],
    ]);
  });

  it('lower-band rows start at the offset of their column', () => {
    // main (left half) | right half stacked: p2 above p3
    const tree = h(0.5, leaf('main'), v(0.5, leaf('p2'), leaf('p3')));
    const rows = dockStripRows(tree);
    expect(rows[0]).toEqual([
      { pane: 'main', left: 0, width: 0.5 },
      { pane: 'p2', left: 0.5, width: 0.5 },
    ]);
    // p3's strip row starts where main ends — the shell emits a spacer.
    expect(rows[1]).toEqual([{ pane: 'p3', left: 0.5, width: 0.5 }]);
  });

  it('weights multiply through nested splits', () => {
    const tree = h(0.5, leaf('main'), h(0.5, leaf('p2'), leaf('p3')));
    expect(dockStripRows(tree)).toEqual([
      [
        { pane: 'main', left: 0, width: 0.5 },
        { pane: 'p2', left: 0.5, width: 0.25 },
        { pane: 'p3', left: 0.75, width: 0.25 },
      ],
    ]);
  });

  it('handles an empty dock', () => {
    expect(dockStripRows(null)).toEqual([]);
  });
});
