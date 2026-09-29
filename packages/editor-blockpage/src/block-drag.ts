import { Fragment, type Node as PMNode } from '@tiptap/pm/model';
import { closeHistory } from '@tiptap/pm/history';
import { Selection, type Transaction } from '@tiptap/pm/state';
import { BlockDragPreview, dragLayoutRect } from './block-drag-preview.js';
import {
  blocksToItem,
  isList,
  itemToBlocks,
  splitListAt,
} from './list-structure.js';
import type { EditorView } from '@tiptap/pm/view';

/** A drag owns one immutable document snapshot. Edits cancel it, never reinterpret it. */
export interface BlockDragSource {
  doc: PMNode;
  from: number;
  to: number;
  content: Fragment;
  kind: 'block' | 'list-item';
  element: HTMLElement;
}

export function blockDragSource(
  view: EditorView,
  element: HTMLElement,
): BlockDragSource | null {
  let result: BlockDragSource | null = null;
  view.state.doc.descendants((node, pos, parent, index) => {
    if (result !== null) return false;
    if (view.nodeDOM(pos) !== element) return true;
    const kind = node.type.name === 'listItem' ? 'list-item' : 'block';
    // Summary paragraphs and list-item text are structural, not independent blocks.
    if (
      !parent ||
      (index === 0 && ['toggle', 'listItem'].includes(parent.type.name))
    )
      return false;
    const follower = parent.maybeChild(index + 1);
    const id: unknown = node.attrs.blockId ?? node.attrs.listId;
    const content = Fragment.fromArray(
      follower?.type.name === 'blockGroup' && follower.attrs.owner === id
        ? [node, follower]
        : [node],
    );
    result = {
      doc: view.state.doc,
      from: pos,
      to: pos + content.size,
      content,
      kind,
      element,
    };
    return false;
  });
  return result;
}

/** Validate and commit exactly the same boundary used by the indicator. */
export function blockDropTransaction(
  view: EditorView,
  source: BlockDragSource,
  pos: number,
  mode?: 'block' | 'list-item' | 'split-list',
): Transaction | null {
  if (view.state.doc !== source.doc || pos < 0 || pos > source.doc.content.size)
    return null;
  mode ??= isList(source.doc.resolve(pos).parent) ? 'list-item' : 'block';
  const lifting = source.kind === 'list-item' && mode !== 'list-item';
  if (
    (pos > source.from && pos < source.to) ||
    (!lifting && (pos === source.from || pos === source.to))
  )
    return null;
  const parent = source.doc.resolve(pos).parent;
  let content = source.content;
  if (lifting)
    content = itemToBlocks(source.content.firstChild!, view.state.schema);
  else if (source.kind === 'block' && mode === 'list-item') {
    const item = blocksToItem(content, view.state.schema);
    if (item === null) return null;
    content = item;
  }
  if (
    mode !== 'split-list' &&
    !parent.canReplace(
      source.doc.resolve(pos).index(),
      source.doc.resolve(pos).index(),
      content,
    )
  )
    return null;
  const $source = source.doc.resolve(source.from);
  let from = source.from;
  let to = source.to;
  // Removing the last item removes its list, rather than synthesizing an empty item.
  if (source.kind === 'list-item' && $source.parent.childCount === 1) {
    from = $source.before();
    to = $source.after();
    if (pos > from && pos < to && !lifting) return null;
  }
  const tr = closeHistory(view.state.tr).delete(from, to);
  const destination = tr.mapping.map(pos, pos < from ? -1 : 1);
  if (mode === 'split-list' && isList(tr.doc.resolve(destination).parent)) {
    if (splitListAt(tr, destination, content) === null) return null;
  } else {
    const $destination = tr.doc.resolve(destination);
    if (
      !$destination.parent.canReplace(
        $destination.index(),
        $destination.index(),
        content,
      )
    )
      return null;
    tr.insert(destination, content);
    tr.setSelection(Selection.near(tr.doc.resolve(destination + 1)));
  }
  return tr;
}

interface DropBoundary {
  mode: 'block' | 'list-item' | 'split-list';
  pos: number;
  top: number;
  left: number;
  width: number;
}

/** Model children supply positions; nodeDOM supplies geometry. Decorations never count. */
export function blockDropBoundary(
  view: EditorView,
  source: BlockDragSource,
  x: number,
  y: number,
): DropBoundary | null {
  let chosen: DropBoundary | null = null;
  const visit = (parent: PMNode, pos: number, root: boolean): void => {
    const list = ['bulletList', 'orderedList'].includes(parent.type.name);
    const scope =
      root || list || ['toggle', 'blockGroup'].includes(parent.type.name);
    const element = root ? view.dom : view.nodeDOM(pos);
    if (
      !(element instanceof HTMLElement) ||
      element.getClientRects().length === 0
    )
      return;
    if (parent.attrs.collapsed === true) return;
    const rect = dragLayoutRect(element, view.dom);
    const start = root ? 0 : pos + 1;
    const skip = ['toggle', 'listItem'].includes(parent.type.name) ? 1 : 0;
    const children: Array<{ pos: number; rect: DOMRect }> = [];
    let end = start;
    parent.forEach((child, offset, index) => {
      end = start + offset + child.nodeSize;
      if (index < skip) return;
      const dom = view.nodeDOM(start + offset);
      if (!(dom instanceof HTMLElement) || dom.getClientRects().length === 0)
        return;
      // A group belongs to the preceding block and cannot be split off by a drop.
      if (child.type.name === 'blockGroup' && children.length > 0) {
        const previous = children[children.length - 1]!;
        const group = dragLayoutRect(dom, view.dom);
        previous.rect = new DOMRect(
          previous.rect.left,
          previous.rect.top,
          previous.rect.width,
          group.bottom - previous.rect.top,
        );
        return;
      }
      children.push({
        pos: start + offset,
        rect: dragLayoutRect(dom, view.dom),
      });
    });
    const title = skip ? view.nodeDOM(start) : null;
    const top =
      title instanceof HTMLElement
        ? children.length === 0
          ? rect.top + rect.height / 2
          : dragLayoutRect(title, view.dom).bottom
        : rect.top;
    const left = root
      ? rect.left
      : parent.type.name === 'toggle'
        ? rect.left + 28
        : (children[0]?.rect.left ?? rect.left);
    if (
      scope &&
      (root ||
        (x >= (list ? rect.left - 12 : left - 12) &&
          x <= rect.right + 12 &&
          y >= top &&
          y <= rect.bottom))
    ) {
      const mode = list
        ? x < (children[0]?.rect.left ?? rect.left + 28) - 8
          ? 'split-list'
          : 'list-item'
        : 'block';
      let boundary: DropBoundary = {
        mode,
        pos: end,
        top: children.at(-1)?.rect.bottom ?? top + 4,
        left,
        width: Math.max(40, rect.right - left),
      };
      for (let index = 0; index < children.length; index++) {
        const child = children[index]!;
        if (y <= child.rect.top + child.rect.height / 2) {
          const before = children[index - 1];
          boundary = {
            ...boundary,
            pos: child.pos,
            top: before
              ? (before.rect.bottom + child.rect.top) / 2
              : child.rect.top,
          };
          break;
        }
      }
      if (mode === 'split-list')
        boundary = { ...boundary, left: rect.left, width: rect.width };
      // Invalid/no-op boundaries clear feedback instead of promising a different move.
      chosen =
        blockDropTransaction(view, source, boundary.pos, boundary.mode) === null
          ? null
          : boundary;
    }
    parent.forEach((child, offset) => {
      const childPos = start + offset;
      if (childPos >= source.from && childPos < source.to) return;
      if (!child.isLeaf && !child.isTextblock) visit(child, childPos, false);
    });
  };
  visit(view.state.doc, -1, true);
  return chosen;
}

/** One handle-activated pointer sensor shared by all nesting levels and both drag kinds. */
export class BlockDragController {
  readonly #events = new AbortController();
  #gesture: {
    source: BlockDragSource;
    pointerId: number;
    handle: HTMLElement;
    x: number;
    y: number;
    originX: number;
    originY: number;
    grabX: number;
    grabY: number;
    active: boolean;
    tap: () => void;
  } | null = null;
  #ghost: HTMLElement | null = null;
  #layoutPreview: BlockDragPreview | null = null;
  #indicator: HTMLElement | null = null;
  #boundary: DropBoundary | null = null;
  #frame = 0;
  #suppressedUntil = 0;

  constructor(
    readonly host: HTMLElement,
    readonly view: EditorView,
  ) {
    const signal = this.#events.signal;
    host.addEventListener('pointermove', this.#move, { signal });
    host.addEventListener('pointerup', this.#up, { signal });
    host.addEventListener('pointercancel', this.#cancelPointer, { signal });
    host.addEventListener('lostpointercapture', this.#cancelPointer, {
      signal,
    });
    window.addEventListener('blur', this.cancel, { signal });
    window.addEventListener('scroll', this.#refresh, {
      capture: true,
      passive: true,
      signal,
    });
    window.addEventListener('resize', this.#refresh, { signal });
    host.ownerDocument.addEventListener(
      'keydown',
      (event) => {
        if (this.#gesture && event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          this.cancel();
        }
      },
      { capture: true, signal },
    );
  }

  get busy(): boolean {
    return this.#gesture !== null;
  }
  get suppressClick(): boolean {
    return Date.now() < this.#suppressedUntil;
  }

  start(event: PointerEvent, element: HTMLElement, tap: () => void): void {
    if (
      this.busy ||
      !this.view.editable ||
      event.button > 0 ||
      event.isPrimary === false
    )
      return;
    const source = blockDragSource(this.view, element);
    if (source === null) return;
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget as HTMLElement;
    const rect = element.getBoundingClientRect();
    this.#gesture = {
      source,
      handle,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      originX: event.clientX,
      originY: event.clientY,
      grabX: event.clientX - rect.left,
      grabY: event.clientY - rect.top,
      active: false,
      tap,
    };
    handle.setPointerCapture?.(event.pointerId);
  }

  #move = (event: PointerEvent): void => {
    const gesture = this.#gesture;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    gesture.x = event.clientX;
    gesture.y = event.clientY;
    if (
      !gesture.active &&
      Math.hypot(gesture.x - gesture.originX, gesture.y - gesture.originY) < 8
    )
      return;
    if (!gesture.active) {
      gesture.active = true;
      gesture.handle.classList.add('dragging');
      this.#layoutPreview = new BlockDragPreview(this.view);
      this.#createPreview(gesture.source.element);
      gesture.source.element.classList.add('flbp-drag-source');
      this.#frame = requestAnimationFrame(this.#tick);
    }
    this.#refresh();
  };

  #up = (event: PointerEvent): void => {
    const gesture = this.#gesture;
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    gesture.x = event.clientX;
    gesture.y = event.clientY;
    if (gesture.active) this.#refresh();
    const transaction =
      gesture.active && this.#boundary
        ? blockDropTransaction(
            this.view,
            gesture.source,
            this.#boundary.pos,
            this.#boundary.mode,
          )
        : null;
    this.cancel();
    if (transaction) {
      this.view.dispatch(transaction);
      this.view.focus();
    } else if (!gesture.active && this.view.state.doc === gesture.source.doc)
      gesture.tap();
  };

  #cancelPointer = (event: PointerEvent): void => {
    if (event.pointerId === this.#gesture?.pointerId) this.cancel();
  };

  cancel = (): void => {
    const gesture = this.#gesture;
    this.#gesture = null;
    if (gesture) {
      this.#suppressedUntil = Date.now() + 500;
      gesture.source.element.classList.remove('flbp-drag-source');
      gesture.handle.classList.remove('dragging');
      if (gesture.handle.hasPointerCapture?.(gesture.pointerId))
        gesture.handle.releasePointerCapture(gesture.pointerId);
    }
    cancelAnimationFrame(this.#frame);
    this.#layoutPreview?.destroy();
    this.#layoutPreview = null;
    this.#ghost?.remove();
    this.#indicator?.remove();
    this.#ghost = this.#indicator = null;
    this.#boundary = null;
  };

  /** Transactions, read-only changes and unmounts cannot leave a captured gesture alive. */
  update(): void {
    if (
      this.#gesture &&
      (!this.view.editable || this.view.state.doc !== this.#gesture.source.doc)
    )
      this.cancel();
  }

  destroy(): void {
    this.cancel();
    this.#events.abort();
  }

  #refresh = (): void => {
    const gesture = this.#gesture;
    if (!gesture?.active) return;
    this.update();
    if (!this.#gesture) return;
    const host = this.host.getBoundingClientRect();
    const { x, y } = gesture;
    this.#boundary =
      x < host.left || x > host.right || y < host.top || y > host.bottom
        ? null
        : blockDropBoundary(this.view, gesture.source, x, y);
    if (this.#ghost) {
      this.#ghost.style.left = `${x - gesture.grabX}px`;
      this.#ghost.style.top = `${y - gesture.grabY}px`;
    }
    const height = Math.max(
      28,
      gesture.source.element.getBoundingClientRect().height,
    );
    this.#layoutPreview?.show(
      this.#boundary?.pos ?? null,
      height + 12,
      gesture.source.from,
      gesture.source.to,
    );
    if (!this.#indicator) return;
    this.#indicator.style.height = `${height}px`;
    this.#indicator.hidden = this.#boundary === null;
    if (this.#boundary) {
      const { top, left, width, pos } = this.#boundary;
      this.#indicator.style.top = `${top - host.top + this.host.scrollTop}px`;
      this.#indicator.style.left = `${left - host.left + this.host.scrollLeft}px`;
      this.#indicator.style.width = `${width}px`;
      this.#indicator.dataset.dropPosition = String(pos);
      this.#indicator.dataset.dropMode = this.#boundary.mode;
      this.#indicator.setAttribute(
        'data-label',
        this.#boundary.mode === 'split-list'
          ? 'Split list'
          : this.#boundary.mode === 'list-item'
            ? 'Add to list'
            : 'Move block',
      );
    }
  };

  #tick = (): void => {
    const gesture = this.#gesture;
    if (!gesture?.active) return;
    const rect = this.host.getBoundingClientRect();
    const previousScroll = this.host.scrollTop;
    if (
      gesture.x >= rect.left &&
      gesture.x <= rect.right &&
      gesture.y >= rect.top &&
      gesture.y <= rect.bottom
    ) {
      const edge = 40;
      const speed =
        gesture.y < rect.top + edge
          ? -Math.ceil((rect.top + edge - gesture.y) / 4)
          : gesture.y > rect.bottom - edge
            ? Math.ceil((gesture.y - rect.bottom + edge) / 4)
            : 0;
      if (speed) this.host.scrollTop += speed;
    }
    if (this.host.scrollTop !== previousScroll) this.#refresh();
    if (this.#gesture) this.#frame = requestAnimationFrame(this.#tick);
  };

  #createPreview(source: HTMLElement): void {
    const ghost = document.createElement('div');
    ghost.className = 'flbp-drag-preview';
    ghost.setAttribute('aria-hidden', 'true');
    ghost.inert = true;
    ghost.style.width = `${source.getBoundingClientRect().width}px`;
    // Copy computed presentation so nested blocks and scoped host styles match the source.
    const clone = source.cloneNode(true) as HTMLElement;
    const originals = [source, ...source.querySelectorAll<HTMLElement>('*')];
    const copies = [clone, ...clone.querySelectorAll<HTMLElement>('*')];
    copies.forEach((copy, index) => {
      const style = getComputedStyle(originals[index]!);
      for (const property of style)
        copy.style.setProperty(property, style.getPropertyValue(property));
      for (const attribute of [
        'id',
        'contenteditable',
        'data-block-id',
        'data-list-id',
        'autofocus',
      ])
        copy.removeAttribute(attribute);
    });
    clone.style.margin = '0';
    clone.style.transform = 'none';
    clone.style.opacity = '1';
    clone
      .querySelectorAll('iframe, embed, object, .flbp-chevron')
      .forEach((el) => el.remove());
    ghost.appendChild(clone);
    this.host.ownerDocument.body.appendChild(ghost);
    this.#ghost = ghost;
    const indicator = document.createElement('div');
    indicator.className = 'flbp-drop-preview';
    indicator.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    text.className = 'flbp-drop-content';
    text.textContent =
      this.#gesture?.source.content.firstChild?.textContent ?? '';
    indicator.appendChild(text);
    this.host.appendChild(indicator);
    this.#indicator = indicator;
  }
}
