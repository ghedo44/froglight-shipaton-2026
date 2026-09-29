/**
 * Dock tree model: the workspace main area is a binary tree of pane splits.
 *
 * A leaf is one pane (a group of tabs with one active tab). An inner node
 * splits its subtree along a direction with a first/second ratio. The model
 * is pure and JSON-serializable so the whole dock layout can be persisted
 * as derived workspace state and restored verbatim.
 *
 * Directions are named like the user-facing commands: `right`/`left` place
 * the new pane beside the target (`horizontal` split), `down`/`up` stack it
 * (`vertical` split).
 */

export type DockDirection = 'horizontal' | 'vertical';
export type DockSide = 'before' | 'after';

export interface DockLeaf {
  readonly kind: 'leaf';
  readonly pane: string;
}

export interface DockSplit {
  readonly kind: 'split';
  readonly direction: DockDirection;
  /** Fraction (0.2–0.8) of the container given to `first`. */
  readonly ratio: number;
  readonly first: DockNode;
  readonly second: DockNode;
}

export type DockNode = DockLeaf | DockSplit;

export const DOCK_MIN_RATIO = 0.2;
export const DOCK_MAX_RATIO = 0.8;

export function leafPane(pane: string): DockLeaf {
  return { kind: 'leaf', pane };
}

export function rootLeaf(pane: string): DockLeaf {
  return leafPane(pane);
}

/** Every leaf pane id in visual order (depth-first, first → second). */
export function leafIds(root: DockNode | null): string[] {
  if (root === null) return [];
  if (root.kind === 'leaf') return [root.pane];
  return [...leafIds(root.first), ...leafIds(root.second)];
}

/** Side a new pane lands on, translated from a direction command. */
export function sideForDirection(
  direction: 'right' | 'down' | 'left' | 'up',
): { axis: DockDirection; side: DockSide } {
  switch (direction) {
    case 'right':
      return { axis: 'horizontal', side: 'after' };
    case 'down':
      return { axis: 'vertical', side: 'after' };
    case 'left':
      return { axis: 'horizontal', side: 'before' };
    case 'up':
      return { axis: 'vertical', side: 'before' };
  }
}

/**
 * Split `pane` along `axis`, placing the new (empty) pane on `side`.
 * Returns the new root and the created pane id.
 */
export function splitLeaf(
  root: DockNode | null,
  pane: string,
  direction: 'right' | 'down' | 'left' | 'up',
  newPaneId: string,
): { root: DockNode; created: string } {
  const { axis, side } = sideForDirection(direction);
  const created = newPaneId;
  const walk = (node: DockNode): DockNode => {
    if (node.kind === 'leaf') {
      if (node.pane !== pane) return node;
      const fresh = leafPane(created);
      return {
        kind: 'split',
        direction: axis,
        ratio: 0.5,
        first: side === 'before' ? fresh : node,
        second: side === 'before' ? node : fresh,
      };
    }
    return { ...node, first: walk(node.first), second: walk(node.second) };
  };
  if (root === null) return { root: leafPane(created), created };
  return { root: walk(root), created };
}

/** Remove a leaf; the parent split collapses into the sibling subtree. */
export function removeLeaf(root: DockNode | null, pane: string): DockNode | null {
  if (root === null) return null;
  if (root.kind === 'leaf') return root.pane === pane ? null : root;
  const first = removeLeaf(root.first, pane);
  const second = removeLeaf(root.second, pane);
  if (first === null) return second;
  if (second === null) return first;
  return { ...root, first, second };
}

/** Set the ratio of the split that directly contains `pane` (clamped). */
export function setLeafRatio(root: DockNode, pane: string, ratio: number): DockNode {
  const clamped = Math.min(DOCK_MAX_RATIO, Math.max(DOCK_MIN_RATIO, ratio));
  const walk = (node: DockNode): DockNode => {
    if (node.kind === 'leaf') return node;
    if (
      (node.first.kind === 'leaf' && node.first.pane === pane) ||
      (node.second.kind === 'leaf' && node.second.pane === pane)
    ) {
      return { ...node, ratio: clamped };
    }
    if (containsLeaf(node.first, pane)) return { ...node, first: walk(node.first) };
    if (containsLeaf(node.second, pane)) return { ...node, second: walk(node.second) };
    return node;
  };
  return walk(root);
}

/** A path from the dock root to a particular split node. */
export type DockSplitPath = readonly ('first' | 'second')[];

/** Set one exact split ratio without touching any ancestor or descendant. */
export function setSplitRatioAt(
  root: DockNode,
  path: DockSplitPath,
  ratio: number,
): DockNode {
  const clamped = Math.min(DOCK_MAX_RATIO, Math.max(DOCK_MIN_RATIO, ratio));
  if (root.kind === 'leaf') return root;
  if (path.length === 0) return { ...root, ratio: clamped };

  const [side, ...rest] = path;
  return {
    ...root,
    [side]: setSplitRatioAt(root[side], rest, ratio),
  };
}

/** Ratio of the split directly containing `pane`, when there is one. */
export function splitRatioOf(root: DockNode, pane: string): number | null {
  if (root.kind === 'leaf') return null;
  if (root.first.kind === 'leaf' && root.first.pane === pane) return root.ratio;
  if (root.second.kind === 'leaf' && root.second.pane === pane) return root.ratio;
  return splitRatioOf(root.first, pane) ?? splitRatioOf(root.second, pane);
}

/** Prune `pane` out of the tree; returns the pruned tree and the leaf itself. */
export function detachLeaf(
  root: DockNode | null,
  pane: string,
): { root: DockNode | null; subtree: DockLeaf | null } {
  const subtree = findLeaf(root, pane);
  if (subtree === null) return { root, subtree: null };
  return { root: removeLeaf(root, pane), subtree };
}

/** Insert `node` beside the leaf `pane` on `side` of the given axis. */
export function insertNode(
  root: DockNode | null,
  pane: string,
  axis: DockDirection,
  side: DockSide,
  node: DockNode,
): DockNode {
  const walk = (current: DockNode): DockNode => {
    if (current.kind === 'leaf') {
      if (current.pane !== pane) return current;
      return {
        kind: 'split',
        direction: axis,
        ratio: 0.5,
        first: side === 'before' ? node : current,
        second: side === 'before' ? current : node,
      };
    }
    return { ...current, first: walk(current.first), second: walk(current.second) };
  };
  if (root === null) return node;
  return walk(root);
}

export function findLeaf(root: DockNode | null, pane: string): DockLeaf | null {
  if (root === null) return null;
  if (root.kind === 'leaf') return root.pane === pane ? root : null;
  return findLeaf(root.first, pane) ?? findLeaf(root.second, pane);
}

export function containsLeaf(root: DockNode, pane: string): boolean {
  return findLeaf(root, pane) !== null;
}

/** First leaf in visual order — the dock's root pane (owns the titlebar strip). */
export function firstLeaf(root: DockNode | null): string | null {
  return leafIds(root)[0] ?? null;
}
