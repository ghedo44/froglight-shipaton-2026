import type { EditorView } from '@tiptap/pm/view';

/** Hit testing always sees the original document geometry, never animated displacement. */
export function dragLayoutRect(
  element: HTMLElement,
  root: HTMLElement,
): DOMRect {
  const rect = element.getBoundingClientRect();
  let offset = 0;
  for (
    let current: HTMLElement | null = element;
    current;
    current = current.parentElement
  ) {
    const transform = getComputedStyle(current).transform;
    if (transform && transform !== 'none')
      offset += new DOMMatrixReadOnly(transform).m42;
    if (current === root) break;
  }
  return new DOMRect(rect.x, rect.y - offset, rect.width, rect.height);
}

/** Animation is presentation only: no editor DOM children or document positions change. */
export class BlockDragPreview {
  #animations = new Map<HTMLElement, Animation>();
  #key = '';
  constructor(readonly view: EditorView) {}

  show(pos: number | null, height: number, from: number, to: number): void {
    const key = `${pos}:${height}`;
    if (key === this.#key) return;
    this.#key = key;
    const targets = new Set<HTMLElement>();
    if (pos !== null)
      this.view.state.doc.descendants((node, at) => {
        if (at >= from && at < to) return false;
        const element = this.view.nodeDOM(at);
        if (
          at >= pos &&
          element instanceof HTMLElement &&
          element.getClientRects().length &&
          node.isBlock &&
          node.type.name !== 'tableRow' &&
          node.type.name !== 'tableCell'
        ) {
          targets.add(element);
          return false;
        }
        return true;
      });
    const reduced =
      typeof matchMedia === 'function' &&
      matchMedia('(prefers-reduced-motion: reduce)').matches;
    for (const element of new Set([...targets, ...this.#animations.keys()])) {
      if (typeof element.animate !== 'function') continue;
      const current = getComputedStyle(element).transform;
      this.#animations.get(element)?.cancel();
      const animation = element.animate(
        [
          { transform: current === 'none' ? 'translateY(0px)' : current },
          { transform: `translateY(${targets.has(element) ? height : 0}px)` },
        ],
        {
          duration: reduced ? 0 : 160,
          easing: 'cubic-bezier(.2,.8,.2,1)',
          fill: 'both',
        },
      );
      this.#animations.set(element, animation);
    }
  }

  destroy(): void {
    for (const animation of this.#animations.values()) animation.cancel();
    this.#animations.clear();
    this.#key = '';
  }
}
