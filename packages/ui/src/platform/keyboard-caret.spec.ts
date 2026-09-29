// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ensureFocusedEditableVisible,
  findInternalScrollableAncestor,
} from './keyboard-caret.js';

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('findInternalScrollableAncestor', () => {
  it('finds the nearest internal scroller', () => {
    const scroller = document.createElement('div');
    scroller.style.overflowY = 'auto';
    const inner = document.createElement('div');
    const input = document.createElement('input');
    inner.append(input);
    scroller.append(inner);
    document.body.append(scroller);
    expect(findInternalScrollableAncestor(input)).toBe(scroller);
  });

  it('never returns protected application roots', () => {
    const app = document.createElement('div');
    app.id = 'app';
    app.style.overflowY = 'auto';
    const input = document.createElement('input');
    app.append(input);
    document.body.append(app);
    expect(findInternalScrollableAncestor(input)).toBeNull();

    document.body.innerHTML = '';
    const workspace = document.createElement('div');
    workspace.setAttribute('data-fl-component', 'workspace');
    workspace.style.overflowY = 'auto';
    const textarea = document.createElement('textarea');
    workspace.append(textarea);
    document.body.append(workspace);
    expect(findInternalScrollableAncestor(textarea)).toBeNull();
  });
});

describe('ensureFocusedEditableVisible', () => {
  it.each([false, true])('reveals the selection focus in a long editable (backward=%s)', (backward) => {
    const scroller = document.createElement('div');
    scroller.style.overflowY = 'auto';
    const editor = document.createElement('div');
    editor.contentEditable = 'true';
    editor.tabIndex = 0;
    Object.defineProperty(editor, 'isContentEditable', { value: true });
    editor.textContent = 'first paragraph and last paragraph';
    scroller.append(editor);
    document.body.append(scroller);
    editor.focus();
    editor.getBoundingClientRect = () => new DOMRect(0, 100, 400, 2000);
    const text = editor.firstChild!;
    const selection = document.getSelection()!;
    selection.setBaseAndExtent(text, backward ? 20 : 0, text, 0);
    const rangeRect = vi.spyOn(document, 'createRange').mockImplementation(() => {
      const range = new Range();
      range.getClientRects = () => [new DOMRect(0, 100, 0, 20)] as unknown as DOMRectList;
      return range;
    });
    expect(ensureFocusedEditableVisible(document, 300, 800)).toBe(false);
    expect(scroller.scrollTop).toBe(0);
    expect(rangeRect).toHaveBeenCalled();
    expect(selection.focusOffset).toBe(0);
  });

  it('scrolls the internal ancestor just enough to expose the caret', () => {
    const scroller = document.createElement('div');
    scroller.style.overflowY = 'auto';
    scroller.scrollTop = 0;
    const input = document.createElement('input');
    scroller.append(input);
    document.body.append(scroller);
    input.focus();
    // Place the caret below the keyboard-obscured line.
    input.getBoundingClientRect = () =>
      ({ bottom: 780, top: 760, left: 0, right: 100, width: 100, height: 20 }) as DOMRect;
    Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
    const scrolled = ensureFocusedEditableVisible(document, 300, 800);
    expect(scrolled).toBe(true);
    // 780 - (800 - 300) + 8 = 288
    expect(scroller.scrollTop).toBe(288);
    // Application roots never scroll.
    expect(document.documentElement.scrollTop).toBe(0);
    expect(document.body.scrollTop).toBe(0);
  });

  it('does nothing when the caret is already visible or no inset', () => {
    const scroller = document.createElement('div');
    scroller.style.overflowY = 'auto';
    const input = document.createElement('input');
    scroller.append(input);
    document.body.append(scroller);
    input.focus();
    input.getBoundingClientRect = () =>
      ({ bottom: 400, top: 380, left: 0, right: 100, width: 100, height: 20 }) as DOMRect;
    expect(ensureFocusedEditableVisible(document, 300, 800)).toBe(false);
    expect(ensureFocusedEditableVisible(document, 0, 800)).toBe(false);
    expect(scroller.scrollTop).toBe(0);
  });
});
