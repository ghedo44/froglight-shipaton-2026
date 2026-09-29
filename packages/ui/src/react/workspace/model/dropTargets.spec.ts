import { describe, expect, it } from 'vitest';
import { resolveDropTarget } from './dropTargets.js';

describe('resolveDropTarget', () => {
  it('maps edge zones to fresh splits beside the target pane', () => {
    expect(resolveDropTarget({ pane: 'a', zone: 'left' })).toEqual({
      kind: 'split',
      pane: 'a',
      direction: 'left',
    });
    expect(resolveDropTarget({ pane: 'a', zone: 'right' })).toEqual({
      kind: 'split',
      pane: 'a',
      direction: 'right',
    });
    expect(resolveDropTarget({ pane: 'a', zone: 'top' })).toEqual({
      kind: 'split',
      pane: 'a',
      direction: 'up',
    });
    expect(resolveDropTarget({ pane: 'a', zone: 'bottom' })).toEqual({
      kind: 'split',
      pane: 'a',
      direction: 'down',
    });
  });

  it('maps center and tab zones to moves into the target pane', () => {
    expect(resolveDropTarget({ pane: 'a', zone: 'center' })).toEqual({
      kind: 'pane',
      pane: 'a',
    });
    expect(resolveDropTarget({ pane: 'b', zone: 'tab', index: 2 })).toEqual({
      kind: 'pane',
      pane: 'b',
      index: 2,
    });
  });

  it('omits the index when a tab drop carries none', () => {
    expect(resolveDropTarget({ pane: 'b', zone: 'tab' })).toEqual({
      kind: 'pane',
      pane: 'b',
    });
  });
});
