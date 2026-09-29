export interface RectLike {
  readonly left: number;
  readonly width: number;
  readonly top: number;
  readonly height: number;
}

/**
 * Resolve a strip insertion slot from tab midpoints. Slots, rather than tabs,
 * make before/after intent explicit and also support an empty strip.
 */
export function tabInsertionIndex(
  tabs: readonly RectLike[],
  clientX: number,
): number {
  for (let index = 0; index < tabs.length; index += 1) {
    const tab = tabs[index];
    if (tab === undefined) continue;
    if (clientX < tab.left + tab.width / 2) return index;
  }
  return tabs.length;
}

/**
 * Convert the divider centre to a fraction of the usable content span.
 * The divider gutter itself is excluded so 25% means 25% of pane content.
 */
export function splitRatioFromPointer(input: {
  readonly direction: 'horizontal' | 'vertical';
  readonly clientX: number;
  readonly clientY: number;
  readonly container: RectLike;
  readonly dividerSize: number;
}): number | null {
  const horizontal = input.direction === 'horizontal';
  const span = horizontal ? input.container.width : input.container.height;
  const start = horizontal ? input.container.left : input.container.top;
  const pointer = horizontal ? input.clientX : input.clientY;
  const usable = span - input.dividerSize;
  if (usable <= 0) return null;
  return (pointer - start - input.dividerSize / 2) / usable;
}
