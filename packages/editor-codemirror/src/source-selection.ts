import { EditorView, ViewPlugin } from '@codemirror/view';
import type { DocumentToolSnapshot } from '@froglight/foundation';

/** Native selection keeps source editors aligned with flowing Block Page text. */
export const sourceSelectionTheme = EditorView.theme({
  '.cm-content': { caretColor: 'var(--fl-accent)' },
  '.cm-content ::selection, .cm-content::selection': {
    backgroundColor: 'var(--fl-accent-soft)',
  },
});

export function sourceSelectionAnchor(
  view: EditorView,
): DocumentToolSnapshot['contextualAnchor'] {
  const selection = view.state.selection.main;
  const touchCaret = window.matchMedia?.('(pointer: coarse)').matches === true;
  if (!view.hasFocus || (selection.empty && !touchCaret)) return undefined;
  const start = view.coordsAtPos(selection.from);
  const end = view.coordsAtPos(selection.to);
  if (!start || !end) return undefined;
  const viewport = view.scrollDOM.getBoundingClientRect();
  const top = Math.min(start.top, end.top);
  const bottom = Math.max(start.bottom, end.bottom);
  if (bottom < viewport.top || top > viewport.bottom) return undefined;
  const left = Math.min(start.left, end.left);
  const right = Math.max(start.right, end.right);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Scroll and focus changes move contextual tools without changing source. */
export function watchSourceSelection(notify: () => void) {
  return ViewPlugin.define((view) => {
    let frame = 0;
    let previous: string | undefined | null = null;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const next = JSON.stringify(sourceSelectionAnchor(view));
        if (next === previous) return;
        previous = next;
        notify();
      });
    };
    view.scrollDOM.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    return {
      update(update) {
        if (update.docChanged || update.selectionSet || update.focusChanged)
          previous = null;
        if (
          update.focusChanged ||
          update.geometryChanged ||
          update.selectionSet
        )
          schedule();
      },
      destroy() {
        cancelAnimationFrame(frame);
        view.scrollDOM.removeEventListener('scroll', schedule);
        window.removeEventListener('resize', schedule);
      },
    };
  });
}
