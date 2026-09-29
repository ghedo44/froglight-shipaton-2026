/**
 * Pure drop-target mapping for tab dragging.
 *
 * Geometry (which pane/zone/index the pointer is over) is resolved by the
 * drag hook through `dock-interactions` utilities; this module maps the
 * resolved target onto the controller's move operation. Edge drops split,
 * center/tab drops move into the pane.
 */

import type { DockMoveTargetView } from '../../../workbench-view.js';

/** Where a dragged tab may land inside a pane. */
export type DropZone = 'center' | 'left' | 'right' | 'top' | 'bottom' | 'tab';

export interface DropTarget {
  readonly pane: string;
  readonly zone: DropZone;
  readonly index?: number;
}

export function resolveDropTarget(target: DropTarget): DockMoveTargetView {
  switch (target.zone) {
    case 'left':
      return { kind: 'split', pane: target.pane, direction: 'left' };
    case 'right':
      return { kind: 'split', pane: target.pane, direction: 'right' };
    case 'top':
      return { kind: 'split', pane: target.pane, direction: 'up' };
    case 'bottom':
      return { kind: 'split', pane: target.pane, direction: 'down' };
    default:
      return {
        kind: 'pane',
        pane: target.pane,
        ...(target.index !== undefined ? { index: target.index } : {}),
      };
  }
}
