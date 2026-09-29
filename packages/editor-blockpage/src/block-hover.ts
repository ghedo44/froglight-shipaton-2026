import type { EditorView } from '@tiptap/pm/view';

/** Resolve the nearest visible content row, including when the pointer is in the gutter. */
export function blockAtPointerHeight(
  view: EditorView,
  y: number,
): HTMLElement | null {
  let closest: HTMLElement | null = null;
  let distance = Infinity;
  view.state.doc.descendants((node, pos, parent, index) => {
    const dom = view.nodeDOM(pos);
    if (!(dom instanceof HTMLElement) || dom.getClientRects().length === 0)
      return false;
    const structural =
      index === 0 &&
      parent &&
      ['toggle', 'listItem', 'blockquote', 'callout'].includes(
        parent.type.name,
      );
    const selectable =
      !structural && (node.attrs.blockId || node.type.name === 'listItem');
    if (selectable) {
      const row = dom.matches(
        'li, [data-flbp-toggle], blockquote, [data-flbp-callout]',
      )
        ? (dom.querySelector(':scope > p') ?? dom)
        : dom;
      const rect = row.getBoundingClientRect();
      const next = Math.max(rect.top - y, y - rect.bottom, 0);
      if (next <= distance) {
        closest = dom;
        distance = next;
      }
    }
    return (
      !node.isAtom &&
      node.type.name !== 'table' &&
      node.attrs.collapsed !== true
    );
  });
  return closest;
}
