/**
 * Keyboard-glide DOM helpers.
 *
 * Framework-free: no store, no React. The shell controller
 * (`keyboard-inset.ts`) owns when these run; this module owns how.
 */

/** Whether `el` is a text-entry element — one whose focus summons the keyboard. */
export function isKeyboardEditable(el: unknown): el is HTMLElement {
  return (
    typeof HTMLElement !== 'undefined' &&
    el instanceof HTMLElement &&
    (el.tagName === 'INPUT' ||
      el.tagName === 'TEXTAREA' ||
      el.isContentEditable)
  );
}

/**
 * Keep taps inside `node` from moving focus off an editable, so the chrome
 * around an input — buttons, panels, a scroll-to-bottom control — can be
 * tapped without dismissing the keyboard. `mousedown`, not `pointerdown`:
 * preventing `pointerdown`'s default suppresses the synthesized `click` on
 * iOS, so the tapped control would never activate. Returns an unregister
 * function.
 */
export function keepKeyboardOpen(node: HTMLElement): () => void {
  const onMousedown = (event: MouseEvent) => {
    if (!isKeyboardEditable(event.target)) event.preventDefault();
  };
  node.addEventListener('mousedown', onMousedown);
  return () => {
    node.removeEventListener('mousedown', onMousedown);
  };
}

/**
 * Roots the caret-visibility helper must never scroll: the application
 * chrome stays fixed while editor content may scroll.
 */
function isProtectedScrollRoot(el: Element, doc: Document): boolean {
  if (el === doc.documentElement || el === doc.body) return true;
  if (el.id === 'app') return true;
  if (el instanceof HTMLElement && el.classList.contains('froglight-overlay-host')) {
    return true;
  }
  if (el instanceof HTMLElement && el.hasAttribute('data-fl-component')) {
    const component = el.getAttribute('data-fl-component');
    if (component === 'workspace' || component === 'main') return true;
  }
  return false;
}

function isScrollableElement(el: HTMLElement): boolean {
  const view = el.ownerDocument.defaultView;
  const overflowY = view
    ? view.getComputedStyle(el).overflowY
    : el.style.overflowY;
  const scrollableStyle =
    overflowY === 'auto' || overflowY === 'scroll' || el.style.overflowY === 'auto' || el.style.overflowY === 'scroll';
  if (!scrollableStyle) return false;
  if (typeof el.scrollHeight === 'number' && typeof el.clientHeight === 'number') {
    if (el.scrollHeight === 0 && el.clientHeight === 0) {
      // Headless layout (no geometry engine): style intent alone decides.
      return true;
    }
    if (el.scrollHeight <= el.clientHeight) return false;
  }
  return true;
}

/**
 * Nearest Froglight/DOM scrollable ancestor of `start`, excluding protected
 * application roots. Returns null when only the shell would scroll.
 */
export function findInternalScrollableAncestor(
  start: HTMLElement,
  doc?: Document,
): HTMLElement | null {
  const owner = doc ?? start.ownerDocument;
  let cursor: HTMLElement | null = start.parentElement;
  while (cursor !== null) {
    if (isProtectedScrollRoot(cursor, owner)) return null;
    if (cursor.tagName === 'HTML' || cursor.tagName === 'BODY') return null;
    if (isScrollableElement(cursor)) return cursor;
    cursor = cursor.parentElement;
  }
  return null;
}

/**
 * Keep the focused editable visible after the final keyboard inset is
 * applied: when the caret/input intersects the keyboard-obscured area,
 * scroll the nearest internal ancestor just enough to expose it. Never
 * scrolls `<html>`, `<body>`, `#app`, or the workspace shell — application
 * chrome stays fixed and only editor content moves.
 */
export function ensureFocusedEditableVisible(
  doc: Document,
  keyboardHeight: number,
  viewportHeight?: number,
): boolean {
  if (keyboardHeight <= 0) return false;
  const active = doc.activeElement;
  if (!isKeyboardEditable(active)) return false;
  const view = doc.defaultView;
  const height = viewportHeight ?? view?.innerHeight ?? 0;
  if (height <= 0) return false;
  let rect: DOMRect | undefined;
  if (active.isContentEditable) {
    const selection = doc.getSelection();
    const focus = selection?.focusNode;
    if (!selection || !focus || !active.contains(focus)) return false;
    // Measure the moving end, including backward selections. The editable's
    // box may span the entire document and would scroll a visible caret away.
    const caret = doc.createRange();
    caret.setStart(focus, selection.focusOffset);
    caret.collapse(true);
    rect = Array.from(caret.getClientRects()).find((box) => box.height > 0);
    if (!rect) {
      // Empty paragraphs can have no collapsed range rect. Use their local
      // box, never the whole contenteditable as a fallback.
      const element = focus instanceof HTMLElement ? focus : focus.parentElement;
      if (element && element !== active) rect = element.getBoundingClientRect();
    }
    if (!rect || rect.height <= 0) return false;
  } else {
    rect = active.getBoundingClientRect();
  }
  const obscuredTop = height - keyboardHeight;
  if (rect.bottom <= obscuredTop) return false;
  const overlap = rect.bottom - obscuredTop + 8;
  const scroller = findInternalScrollableAncestor(active, doc);
  if (scroller === null) return false;
  try {
    scroller.scrollTop += overlap;
  } catch {
    return false;
  }
  return true;
}

/**
 * iOS caret guard. The caret is not painted with the web content: a
 * separate selection system in the UI process learns where content sits
 * from viewport updates the web process sends. A compositor transform
 * moves the text without producing one of those updates, so the caret is
 * left behind at a stale rect until some later event re-syncs the two.
 * WebKit's own answer for the equivalent `position: fixed` case is to hide
 * the caret while content moves rather than keep it correct — blank it for
 * the length of a glide and restore it once nodes are back in plain
 * layout. Only one element is ever blanked at a time.
 */
export function createCaretGuard(): {
  hide(el: HTMLElement): void;
  restore(): void;
} {
  let hiddenOn: HTMLElement | null = null;
  let colorBefore = '';
  return {
    hide(el: HTMLElement): void {
      if (hiddenOn === el) return;
      if (hiddenOn !== null) {
        hiddenOn.style.caretColor = colorBefore;
        hiddenOn = null;
        colorBefore = '';
      }
      hiddenOn = el;
      colorBefore = el.style.caretColor;
      el.style.caretColor = 'transparent';
    },
    restore(): void {
      if (hiddenOn === null) return;
      hiddenOn.style.caretColor = colorBefore;
      hiddenOn = null;
      colorBefore = '';
    },
  };
}
