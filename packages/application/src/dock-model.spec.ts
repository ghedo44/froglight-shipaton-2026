import { describe, expect, it } from 'vitest';
import {
  detachLeaf,
  insertNode,
  leafIds,
  leafPane,
  removeLeaf,
  rootLeaf,
  setLeafRatio,
  setSplitRatioAt,
  splitLeaf,
  splitRatioOf,
  type DockNode,
} from './dock-model.js';

describe('dock tree model', () => {
  it('starts as a single main leaf', () => {
    expect(leafIds(leafPane('main'))).toEqual(['main']);
    expect(rootLeaf('main')).toEqual({ kind: 'leaf', pane: 'main' });
  });

  it('split right wraps the pane in a horizontal split with a new right neighbor', () => {
    const { root, created } = splitLeaf(leafPane('main'), 'main', 'right', 'pane-2');
    expect(created).toBe('pane-2');
    expect(leafIds(root)).toEqual(['main', 'pane-2']);
    expect(root).toEqual({
      kind: 'split',
      direction: 'horizontal',
      ratio: 0.5,
      first: { kind: 'leaf', pane: 'main' },
      second: { kind: 'leaf', pane: 'pane-2' },
    });
  });

  it('split down creates a vertical split below the pane', () => {
    const { root } = splitLeaf(leafPane('main'), 'main', 'down', 'pane-2');
    expect(root).toMatchObject({ direction: 'vertical', first: { pane: 'main' }, second: { pane: 'pane-2' } });
  });

  it('split left/up places the new pane before the target', () => {
    const right = splitLeaf(leafPane('main'), 'main', 'right', 'p2').root;
    const left = splitLeaf(right, 'p2', 'left', 'p0').root;
    expect(leafIds(left)).toEqual(['main', 'p0', 'p2']);
    const down = splitLeaf(leafPane('main'), 'main', 'down', 'p2').root;
    const up = splitLeaf(down, 'p2', 'up', 'p0').root;
    expect(leafIds(up)).toEqual(['main', 'p0', 'p2']);
  });

  it('splits inside deeper trees keep the sibling subtree intact', () => {
    const one = splitLeaf(leafPane('main'), 'main', 'right', 'p2').root;
    const two = splitLeaf(one, 'main', 'down', 'p3').root;
    expect(leafIds(two)).toEqual(['main', 'p3', 'p2']);
    expect(two).toMatchObject({
      direction: 'horizontal',
      first: { direction: 'vertical' },
      second: { pane: 'p2' },
    });
  });

  it('removing a leaf replaces its parent split with the sibling subtree', () => {
    const one = splitLeaf(leafPane('main'), 'main', 'right', 'p2').root;
    expect(removeLeaf(one, 'p2')).toEqual({ kind: 'leaf', pane: 'main' });
    const two = splitLeaf(splitLeaf(leafPane('main'), 'main', 'right', 'p2').root, 'p2', 'down', 'p3').root;
    const removed = removeLeaf(two, 'p3');
    expect(leafIds(removed)).toEqual(['main', 'p2']);
  });

  it('removing the last leaf leaves an empty dock', () => {
    expect(removeLeaf(leafPane('main'), 'main')).toBeNull();
  });

  it('ratios live on the parent split and clamp to 0.2–0.8', () => {
    const { root } = splitLeaf(leafPane('main'), 'main', 'right', 'p2');
    const adjusted = setLeafRatio(root, 'main', 0.9);
    expect(splitRatioOf(adjusted, 'main')).toBe(0.8);
    expect(splitRatioOf(setLeafRatio(adjusted, 'main', 0.05), 'main')).toBe(0.2);
    expect(splitRatioOf(setLeafRatio(adjusted, 'main', 0.7), 'main')).toBe(0.7);
  });

  it('changes only the leaf split when a pane is nested', () => {
    const root = splitLeaf(
      splitLeaf(leafPane('main'), 'main', 'right', 'p2').root,
      'p2',
      'down',
      'p3',
    ).root;

    const adjusted = setLeafRatio(root, 'p2', 0.7);

    expect(adjusted).toMatchObject({ ratio: 0.5 });
    expect(splitRatioOf(adjusted, 'p2')).toBe(0.7);
  });

  it('changes only the split at an exact tree path', () => {
    const root = splitLeaf(
      splitLeaf(leafPane('main'), 'main', 'right', 'p2').root,
      'p2',
      'down',
      'p3',
    ).root;

    const adjusted = setSplitRatioAt(root, ['second'], 0.75);

    expect(adjusted).toMatchObject({ ratio: 0.5 });
    expect(adjusted).toMatchObject({ second: { ratio: 0.75 } });
  });

  it('detaching a leaf yields the pruned tree and the leaf', () => {
    const one = splitLeaf(leafPane('main'), 'main', 'right', 'p2').root;
    const detached = detachLeaf(one, 'main');
    expect(detached.subtree).toEqual({ kind: 'leaf', pane: 'main' });
    expect(detached.root).toEqual({ kind: 'leaf', pane: 'p2' });
  });

  it('inserting a node beside a leaf splits at the requested side', () => {
    const one = splitLeaf(leafPane('main'), 'main', 'right', 'p2').root;
    const detached = detachLeaf(one, 'main');
    if (detached.root === null || detached.subtree === null) throw new Error('expected a detached subtree');
    const inserted = insertNode(detached.root, 'p2', 'vertical', 'before', detached.subtree);
    expect(leafIds(inserted)).toEqual(['main', 'p2']);
    expect(inserted).toMatchObject({ direction: 'vertical', first: { pane: 'main' }, second: { pane: 'p2' } });
  });

  it('round-trips through plain JSON', () => {
    const one = splitLeaf(leafPane('main'), 'main', 'right', 'p2').root;
    const two = splitLeaf(one, 'p2', 'down', 'p3').root;
    const parsed = JSON.parse(JSON.stringify(two)) as DockNode;
    expect(parsed).toEqual(two);
    expect(leafIds(parsed)).toEqual(['main', 'p2', 'p3']);
  });
});
