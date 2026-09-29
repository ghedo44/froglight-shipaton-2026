/**
 * Dock tree view types and rendering helpers.
 *
 * Structural mirror of the application-layer dock model (the ui package
 * depends on no application code): a binary tree of pane splits the shell
 * renders directly from `WorkbenchDockPort.dockState()`.
 */

export type DockDirectionView = 'horizontal' | 'vertical';

export interface DockLeafView {
  readonly kind: 'leaf';
  readonly pane: string;
}

export interface DockSplitView {
  readonly kind: 'split';
  readonly direction: DockDirectionView;
  /** Fraction (0.2–0.8) of the container given to `first`. */
  readonly ratio: number;
  readonly first: DockNodeView;
  readonly second: DockNodeView;
}

export type DockNodeView = DockLeafView | DockSplitView;

export function isDockLeaf(node: DockNodeView): node is DockLeafView {
  return node.kind === 'leaf';
}

/** Every leaf pane id in visual order (depth-first, first → second). */
export function dockLeafIds(root: DockNodeView | null): string[] {
  if (root === null) return [];
  if (root.kind === 'leaf') return [root.pane];
  return [...dockLeafIds(root.first), ...dockLeafIds(root.second)];
}

/** One pane strip slot inside a top-bar row: horizontal placement as fractions. */
export interface DockStripSegment {
  readonly pane: string;
  /** Distance from the main column's left edge (0–1). */
  readonly left: number;
  /** Width fraction of the main column (0–1). */
  readonly width: number;
}

/**
 * The top bar mirrors the dock's horizontal bands: one strip row per band
 * of simultaneously visible panes, each segment carrying its left offset
 * and width fraction so strips align exactly above (and beside) their
 * panes. A vertical split pushes its second subtree into a new row that
 * starts at that subtree's left offset; horizontal splits multiply widths.
 */
/**
 * The first band of a subtree — the strip row that sits directly above it
 * (band 0 in the window's top bar; deeper bands render above their panes
 * inside the main area).
 */
export function dockBandStrips(root: DockNodeView | null): DockStripSegment[] {
  return dockStripRows(root)[0] ?? [];
}

export function dockStripRows(root: DockNodeView | null): DockStripSegment[][] {
  const rects: { pane: string; x: number; y: number; w: number }[] = [];
  const walk = (node: DockNodeView | null, x: number, y: number, w: number): void => {
    if (node === null) return;
    if (node.kind === 'leaf') {
      rects.push({ pane: node.pane, x, y, w });
      return;
    }
    if (node.direction === 'horizontal') {
      walk(node.first, x, y, w * node.ratio);
      walk(node.second, x + w * node.ratio, y, w * (1 - node.ratio));
      return;
    }
    walk(node.first, x, y, w);
    walk(node.second, x, y + 1, w);
  };
  walk(root, 0, 0, 1);
  const rows: DockStripSegment[][] = [];
  for (const rect of rects) {
    (rows[rect.y] ??= []).push({ pane: rect.pane, left: rect.x, width: rect.w });
  }
  for (const row of rows) row.sort((a, b) => a.left - b.left);
  return rows.filter((row) => row !== undefined);
}

/** True when `pane` is a leaf inside `root`'s subtree. */
export function dockHasLeaf(root: DockNodeView | null, pane: string): boolean {
  return dockLeafIds(root).includes(pane);
}
