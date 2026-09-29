/**
 * Transient text-overlay lifecycle tests (hardening).
 *
 * The overlay container is React-owned; the editor node stays
 * engine-owned ephemeral DOM. Commits are exactly-once; keystrokes never
 * touch the model.
 *
 * tap/double-click/Enter enter edit with caret + OSK focus; Enter
 * commits single-line and inserts newlines multiline (Ctrl/Cmd+Enter
 * commits); Esc commits; click-away commits without loss.
 * IME commits exactly once; copy/paste preserves chars and breaks.
 * geometry parity (effective size / wrapWidth box) and
 * keyboard-inset clamping without WebView resize.
 */

import { describe, expect, it } from 'vitest';
import {
  createTextOverlay,
  isUsableWrapWidth,
  normalizeOverlayText,
  overlayBoldOf,
  overlayEffectiveSizeOf,
  overlayEffectiveSizeWithAppearance,
  overlayItalicOf,
  overlayWrapWidthOf,
  readKeyboardInsetPx,
} from './text-overlay.js';

function makeContainer(): HTMLDivElement {
  const root = document.createElement('div');
  document.body.appendChild(root);
  return root;
}

const CAMERA = { x: 0, y: 0, zoom: 1 };

describe('SurfaceTextOverlay', () => {
  it('keeps the draft alive in formatting controls and updates its appearance in place', () => {
    const container = makeContainer();
    const toolbar = document.createElement('input');
    document.body.appendChild(toolbar);
    const commits: string[] = [];
    const overlay = createTextOverlay({
      overlayRoot: container,
      keepOpenForTarget: (target) => target === toolbar,
      onCommitCreate: (_point, text) => commits.push(text),
      onCommitEdit: () => undefined,
    });
    overlay.openRequest({
      kind: 'create',
      surfacePoint: { x: 10, y: 20 },
      camera: CAMERA,
    });
    const input =
      container.querySelector<HTMLInputElement>('.fl-ink-text-input')!;
    input.value = 'Uncommitted draft';
    toolbar.focus();
    expect(overlay.isOpen()).toBe(true);
    expect(commits).toEqual([]);
    overlay.updateAppearance({
      size: 48,
      color: '#336699',
      appearance: { bold: true },
    });
    expect(container.querySelector('.fl-ink-text-input')).toBe(input);
    expect(input.value).toBe('Uncommitted draft');
    expect(input.style.fontSize).toBe('48px');
    expect(input.style.fontWeight).toBe('700');
    document.body.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true }),
    );
    expect(commits).toEqual(['Uncommitted draft']);
    overlay.dispose();
    toolbar.remove();
    container.remove();
  });
  it('previews a resized edit box and commits its wrap width once', () => {
    const container = makeContainer();
    const commits: Array<[string, string, number | undefined]> = [];
    const overlay = createTextOverlay({
      overlayRoot: container,
      onCommitCreate: () => undefined,
      onCommitEdit: (id, text, width) => {
        commits.push([id, text, width]);
      },
    });
    overlay.openEdit({
      objectId: 'existing',
      surfacePoint: { x: 20, y: 30 },
      camera: CAMERA,
      text: 'Existing text',
      appearance: { wrapWidth: 120 },
      maxWrapWidth: 150,
    });
    const input =
      container.querySelector<HTMLTextAreaElement>('.fl-ink-text-input')!;
    const handle = container.querySelector<HTMLButtonElement>(
      '.fl-ink-text-resize-handle',
    )!;
    expect(input).not.toBeNull();
    expect(handle).not.toBeNull();
    Object.defineProperty(input, 'getBoundingClientRect', {
      value: () => ({
        width: Number.parseFloat(input.style.width),
        height: 25,
      }),
    });
    handle.dispatchEvent(
      new MouseEvent('pointerdown', { bubbles: true, clientX: 100 }),
    );
    handle.dispatchEvent(
      new MouseEvent('pointermove', { bubbles: true, clientX: 160 }),
    );
    handle.dispatchEvent(
      new MouseEvent('pointerup', { bubbles: true, clientX: 160 }),
    );
    expect(input.style.width).toBe('150px');
    overlay.close(true);
    expect(commits).toEqual([['existing', 'Existing text', 150]]);
    expect(container.querySelector('.fl-ink-text-resize-handle')).toBeNull();
    overlay.dispose();
    container.remove();
  });
  it('positions the editor from live camera math and focuses it with caret at end', () => {
    const container = makeContainer();
    const overlay = createTextOverlay({
      overlayRoot: container,
      onCommitCreate: () => undefined,
      onCommitEdit: () => undefined,
    });
    overlay.openRequest({
      kind: 'create',
      surfacePoint: { x: 10, y: 20 },
      camera: { x: 0, y: 0, zoom: 2 },
    });
    const input =
      container.querySelector<HTMLInputElement>('.fl-ink-text-input');
    expect(input).not.toBeNull();
    expect(input!.style.left).toBe('20px');
    expect(input!.style.top).toBe('40px');
    expect(document.activeElement).toBe(input);
    overlay.dispose();
    container.remove();
  });

  it('commits single-line text verbatim on Enter (no trimming)', () => {
    const container = makeContainer();
    const committed: Array<{ point: { x: number; y: number }; text: string }> =
      [];
    const overlay = createTextOverlay({
      overlayRoot: container,
      onCommitCreate: (point, text) => committed.push({ point, text }),
      onCommitEdit: () => undefined,
    });
    overlay.openRequest({
      kind: 'create',
      surfacePoint: { x: 5, y: 7 },
      camera: CAMERA,
    });
    const input =
      container.querySelector<HTMLInputElement>('.fl-ink-text-input')!;
    input.value = '  Glycolysis  ';
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    // leading/trailing spaces survive (no trim); only truly blank
    // commits are dropped.
    expect(committed).toEqual([
      { point: { x: 5, y: 7 }, text: '  Glycolysis  ' },
    ]);
    expect(container.querySelector('.fl-ink-text-input')).toBeNull();
    overlay.dispose();
    container.remove();
  });

  it('commits on Escape instead of discarding', () => {
    const container = makeContainer();
    const committed: string[] = [];
    const overlay = createTextOverlay({
      overlayRoot: container,
      onCommitCreate: (_point, text) => committed.push(text),
      onCommitEdit: () => undefined,
    });
    overlay.openRequest({
      kind: 'create',
      surfacePoint: { x: 1, y: 1 },
      camera: CAMERA,
    });
    const input =
      container.querySelector<HTMLInputElement>('.fl-ink-text-input')!;
    input.value = 'kept';
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    expect(committed).toEqual(['kept']);
    expect(container.querySelector('.fl-ink-text-input')).toBeNull();
    overlay.dispose();
    container.remove();
  });

  it('ignores blank and whitespace-only commits without a model update', () => {
    const container = makeContainer();
    let commits = 0;
    const overlay = createTextOverlay({
      overlayRoot: container,
      onCommitCreate: () => (commits += 1),
      onCommitEdit: () => undefined,
    });
    overlay.openRequest({
      kind: 'create',
      surfacePoint: { x: 2, y: 3 },
      camera: CAMERA,
    });
    const input =
      container.querySelector<HTMLInputElement>('.fl-ink-text-input')!;
    input.value = '   ';
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    expect(commits).toBe(0);
    expect(container.querySelector('.fl-ink-text-input')).toBeNull();
    overlay.dispose();
    container.remove();
  });

  it('reopening commits the pending text instead of discarding it (no-loss)', () => {
    const container = makeContainer();
    const committed: string[] = [];
    const overlay = createTextOverlay({
      overlayRoot: container,
      onCommitCreate: (_point, text) => committed.push(text),
      onCommitEdit: () => undefined,
    });
    overlay.openRequest({
      kind: 'create',
      surfacePoint: { x: 0, y: 0 },
      camera: CAMERA,
    });
    container.querySelector<HTMLInputElement>('.fl-ink-text-input')!.value =
      'first';
    overlay.openRequest({
      kind: 'create',
      surfacePoint: { x: 9, y: 9 },
      camera: CAMERA,
    });
    expect(committed).toEqual(['first']);
    expect(container.querySelectorAll('.fl-ink-text-input')).toHaveLength(1);
    overlay.dispose();
    container.remove();
  });

  it('commits click-away blur without loss, exactly once', () => {
    const container = makeContainer();
    const committed: string[] = [];
    const overlay = createTextOverlay({
      overlayRoot: container,
      onCommitCreate: (_point, text) => committed.push(text),
      onCommitEdit: () => undefined,
    });
    overlay.openRequest({
      kind: 'create',
      surfacePoint: { x: 0, y: 0 },
      camera: CAMERA,
    });
    const input =
      container.querySelector<HTMLInputElement>('.fl-ink-text-input')!;
    input.value = 'away';
    input.dispatchEvent(new FocusEvent('blur'));
    // A trailing Enter after blur must not double-commit.
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    expect(committed).toEqual(['away']);
    overlay.dispose();
    container.remove();
  });

  it('uses a textarea when a valid wrapWidth is present, input otherwise', () => {
    const container = makeContainer();
    const overlay = createTextOverlay({
      overlayRoot: container,
      onCommitCreate: () => undefined,
      onCommitEdit: () => undefined,
    });
    overlay.openEdit({
      objectId: 't-1',
      surfacePoint: { x: 0, y: 0 },
      camera: CAMERA,
      text: 'wrapped',
      appearance: { wrapWidth: 120 },
    });
    const area = container.querySelector<HTMLTextAreaElement>(
      'textarea.fl-ink-text-area',
    );
    expect(area).not.toBeNull();
    expect(area!.style.width).toBe('120px');
    overlay.close(false);

    overlay.openEdit({
      objectId: 't-2',
      surfacePoint: { x: 0, y: 0 },
      camera: CAMERA,
      text: 'single',
    });
    expect(container.querySelector('textarea')).toBeNull();
    expect(container.querySelector('input.fl-ink-text-input')).not.toBeNull();
    // Invalid wrapWidth degrades to single-line (rule, layout-only).
    overlay.close(false);
    overlay.openEdit({
      objectId: 't-3',
      surfacePoint: { x: 0, y: 0 },
      camera: CAMERA,
      text: 'bad-wrap',
      appearance: { wrapWidth: -5 },
    });
    expect(container.querySelector('textarea')).toBeNull();
    overlay.dispose();
    container.remove();
  });

  it('multiline Enter inserts a newline while Ctrl+Enter commits', () => {
    const container = makeContainer();
    const committed: string[] = [];
    const overlay = createTextOverlay({
      overlayRoot: container,
      onCommitCreate: () => undefined,
      onCommitEdit: (_id, text) => committed.push(text),
    });
    overlay.openEdit({
      objectId: 't-1',
      surfacePoint: { x: 0, y: 0 },
      camera: CAMERA,
      text: 'a',
      appearance: { wrapWidth: 200 },
    });
    const area = container.querySelector<HTMLTextAreaElement>('textarea')!;
    area.value = 'a\nb';
    area.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    // Plain Enter stays native (newline) — no commit yet.
    expect(committed).toEqual([]);
    expect(container.querySelector('textarea')).not.toBeNull();
    area.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        ctrlKey: true,
      }),
    );
    expect(committed).toEqual(['a\nb']);
    expect(container.querySelector('textarea')).toBeNull();
    overlay.dispose();
    container.remove();
  });

  it('IME Enter during composition never commits early and lands exactly once', () => {
    const container = makeContainer();
    const committed: string[] = [];
    const overlay = createTextOverlay({
      overlayRoot: container,
      onCommitCreate: (_point, text) => committed.push(text),
      onCommitEdit: () => undefined,
    });
    overlay.openRequest({
      kind: 'create',
      surfacePoint: { x: 0, y: 0 },
      camera: CAMERA,
    });
    const input =
      container.querySelector<HTMLInputElement>('.fl-ink-text-input')!;
    input.value = 'あ';
    input.dispatchEvent(new CompositionEvent('compositionstart'));
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    expect(committed).toEqual([]);
    expect(container.querySelector('.fl-ink-text-input')).not.toBeNull();
    input.dispatchEvent(new CompositionEvent('compositionend'));
    // compositionend alone never commits — the explicit gesture does.
    expect(committed).toEqual([]);
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    expect(committed).toEqual(['あ']);
    // Convergent blur after commit stays exactly-once.
    input.dispatchEvent(new FocusEvent('blur'));
    expect(committed).toEqual(['あ']);
    overlay.dispose();
    container.remove();
  });

  it('preserves mid-string multiline paste content verbatim', () => {
    const container = makeContainer();
    const committed: string[] = [];
    const overlay = createTextOverlay({
      overlayRoot: container,
      onCommitCreate: () => undefined,
      onCommitEdit: (_id, text) => committed.push(text),
    });
    overlay.openEdit({
      objectId: 't-1',
      surfacePoint: { x: 0, y: 0 },
      camera: CAMERA,
      text: 'ac',
      appearance: { wrapWidth: 200 },
    });
    const area = container.querySelector<HTMLTextAreaElement>('textarea')!;
    // Simulate a mid-string multiline paste: caret between 'a' and 'c'.
    area.value = 'aX\nY\nZc';
    area.dispatchEvent(new Event('input', { bubbles: true }));
    // Per-keystroke input never commits (no full-document re-render).
    expect(committed).toEqual([]);
    area.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        ctrlKey: true,
      }),
    );
    expect(committed).toEqual(['aX\nY\nZc']);
    overlay.dispose();
    container.remove();
  });

  it('normalizes CRLF to LF on commit without trimming', () => {
    expect(normalizeOverlayText('a\r\nb\rc')).toBe('a\nb\nc');
    const container = makeContainer();
    const committed: string[] = [];
    const overlay = createTextOverlay({
      overlayRoot: container,
      onCommitCreate: () => undefined,
      onCommitEdit: (_id, text) => committed.push(text),
    });
    // NOTE: single-line <input> strips line breaks natively on value
    // assignment, so CRLF normalization is proven through the multiline
    // path where newlines survive assignment.
    overlay.openEdit({
      objectId: 't-1',
      surfacePoint: { x: 0, y: 0 },
      camera: CAMERA,
      text: '',
      appearance: { wrapWidth: 200 },
    });
    container.querySelector<HTMLTextAreaElement>('textarea')!.value = 'x\r\ny';
    container.querySelector('textarea')!.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true,
        ctrlKey: true,
      }),
    );
    expect(committed).toEqual(['x\ny']);
    overlay.dispose();
    container.remove();
  });

  it('clamps to the host keyboard inset without resizing the WebView', () => {
    const container = makeContainer();
    // Host-owned inset: the overlay only reads it.
    document.documentElement.style.setProperty(
      '--fl-keyboard-inset-height',
      '300px',
    );
    try {
      const overlay = createTextOverlay({
        overlayRoot: container,
        onCommitCreate: () => undefined,
        onCommitEdit: () => undefined,
      });
      overlay.openRequest({
        kind: 'create',
        surfacePoint: { x: 0, y: 10 },
        camera: CAMERA,
      });
      const input =
        container.querySelector<HTMLInputElement>('.fl-ink-text-input')!;
      expect(input.dataset.keyboardClamped).toBe('true');
      expect(input.style.maxHeight.endsWith('px')).toBe(true);
      // The overlay never writes inset vars itself (host-owned).
      expect(
        document.documentElement.style.getPropertyValue(
          '--fl-keyboard-inset-height',
        ),
      ).toBe('300px');
      overlay.dispose();
    } finally {
      document.documentElement.style.removeProperty(
        '--fl-keyboard-inset-height',
      );
      container.remove();
    }
    expect(readKeyboardInsetPx()).toBe(0);
  });

  it('mirrors canvas geometry: font size scales with zoom, edit opens at record origin', () => {
    const container = makeContainer();
    const overlay = createTextOverlay({
      overlayRoot: container,
      onCommitCreate: () => undefined,
      onCommitEdit: () => undefined,
    });
    overlay.openEdit({
      objectId: 't-9',
      surfacePoint: { x: 40, y: 80 },
      camera: { x: 0, y: 0, zoom: 2 },
      text: 'big',
      size: 20,
    });
    const input =
      container.querySelector<HTMLInputElement>('.fl-ink-text-input')!;
    expect(input.style.fontSize).toBe('40px');
    expect(input.style.left).toBe('80px');
    expect(input.style.top).toBe('160px');
    expect(overlay.currentMode()).toBe('edit');
    expect(overlay.editingId()).toBe('t-9');
    overlay.dispose();
    container.remove();
  });

  it('create previews at the canonical default size, ignoring pen stroke width', () => {
    // Create commits store no size, so the canvas renders at the
    // default (16). The preview must match — using the live pen stroke
    // width here (e.g. 3.5px) would jump geometry on every commit.
    // Storing a size would change canonical bytes and needs a format
    // decision, so the preview ignores `penSize` instead.
    const container = makeContainer();
    const overlay = createTextOverlay({
      overlayRoot: container,
      onCommitCreate: () => undefined,
      onCommitEdit: () => undefined,
    });
    overlay.openRequest({
      kind: 'create',
      surfacePoint: { x: 0, y: 0 },
      camera: CAMERA,
      penSize: 3.5,
    });
    const input =
      container.querySelector<HTMLInputElement>('.fl-ink-text-input')!;
    expect(input.style.fontSize).toBe(
      `${overlayEffectiveSizeOf(undefined) * CAMERA.zoom}px`,
    );
    expect(input.style.fontSize).toBe('16px');
    overlay.close(false);

    overlay.openRequest({
      kind: 'create',
      surfacePoint: { x: 0, y: 0 },
      camera: { x: 0, y: 0, zoom: 2 },
      penSize: 8,
    });
    const zoomed =
      container.querySelector<HTMLInputElement>('.fl-ink-text-input')!;
    expect(zoomed.style.fontSize).toBe('32px');
    overlay.dispose();
    container.remove();
  });

  it('create stays single-line: native input owns line-break stripping (declared)', () => {
    // Create overlays never take a wrapWidth, so they always open a
    // single-line `<input>` (never a `<textarea>`). The native control
    // strips line breaks on assignment, so a multiline paste into a
    // create collapses before commit; the commit then preserves verbatim
    // whatever the control holds (no reintroduced breaks, no trimming).
    const container = makeContainer();
    const committed: string[] = [];
    const overlay = createTextOverlay({
      overlayRoot: container,
      onCommitCreate: (_point, text) => committed.push(text),
      onCommitEdit: () => undefined,
    });
    overlay.openRequest({
      kind: 'create',
      surfacePoint: { x: 0, y: 0 },
      camera: CAMERA,
      penSize: 3.5,
    });
    const input =
      container.querySelector<HTMLInputElement>('.fl-ink-text-input')!;
    expect(input.tagName).toBe('INPUT');
    expect(container.querySelector('textarea')).toBeNull();
    input.value = 'aX\nY\nZc';
    // Native single-line sanitization owns the breaks (jsdom collapses).
    expect(input.value.includes('\n')).toBe(false);
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    expect(committed).toEqual([input.value]);
    expect(committed[0]!.includes('\n')).toBe(false);
    overlay.dispose();
    container.remove();
  });
});

describe('overlay effective-value readers (forward-compatible)', () => {
  it('accepts only finite positive wrap widths within the cap', () => {
    expect(isUsableWrapWidth(120)).toBe(true);
    expect(isUsableWrapWidth(0)).toBe(false);
    expect(isUsableWrapWidth(-5)).toBe(false);
    expect(isUsableWrapWidth(Number.NaN)).toBe(false);
    expect(isUsableWrapWidth(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isUsableWrapWidth('120')).toBe(false);
    expect(overlayWrapWidthOf({ wrapWidth: 120 })).toBe(120);
    expect(overlayWrapWidthOf({ wrapWidth: 0 })).toBeNull();
    expect(overlayWrapWidthOf(null)).toBeNull();
    expect(overlayWrapWidthOf(undefined)).toBeNull();
  });

  it('defaults effective size to 16 for absent/invalid sizes', () => {
    expect(overlayEffectiveSizeOf(20)).toBe(20);
    expect(overlayEffectiveSizeOf(undefined)).toBe(16);
    expect(overlayEffectiveSizeOf(0)).toBe(16);
    expect(overlayEffectiveSizeOf(Number.NaN)).toBe(16);
  });

  it('reads additive traits and appearance-first size (overlay read)', () => {
    expect(overlayBoldOf({ bold: true })).toBe(true);
    expect(overlayBoldOf({})).toBe(false);
    expect(overlayBoldOf({ bold: 'yes' })).toBe(false);
    expect(overlayBoldOf(null)).toBe(false);
    expect(overlayItalicOf({ italic: true })).toBe(true);
    expect(overlayItalicOf({ italic: false })).toBe(false);
    expect(overlayEffectiveSizeWithAppearance(16, { size: 24 })).toBe(24);
    expect(overlayEffectiveSizeWithAppearance(20, null)).toBe(20);
    expect(overlayEffectiveSizeWithAppearance(undefined, { size: -5 })).toBe(
      16,
    );

    // Edit previews weight/style/size/align/wrap from the new traits.
    const container = makeContainer();
    const overlay = createTextOverlay({
      overlayRoot: container,
      onCommitCreate: () => undefined,
      onCommitEdit: () => undefined,
    });
    overlay.openEdit({
      objectId: 't-traits',
      surfacePoint: { x: 0, y: 0 },
      camera: CAMERA,
      text: 'hi',
      size: 16,
      role: 'heading',
      appearance: {
        bold: true,
        italic: true,
        align: 'center',
        wrapWidth: 120,
        size: 24,
      },
    });
    const area = container.querySelector<HTMLTextAreaElement>('textarea')!;
    expect(area).not.toBeNull();
    expect(area.style.fontWeight).toBe('700');
    expect(area.style.fontStyle).toBe('italic');
    expect(area.style.fontSize).toBe('24px');
    expect(area.style.textAlign).toBe('center');
    expect(area.style.width).toBe('120px');
    overlay.dispose();
    container.remove();

    // Bold-only body still previews bold without heading role.
    const plain = makeContainer();
    const second = createTextOverlay({
      overlayRoot: plain,
      onCommitCreate: () => undefined,
      onCommitEdit: () => undefined,
    });
    second.openEdit({
      objectId: 't-bold',
      surfacePoint: { x: 0, y: 0 },
      camera: CAMERA,
      text: 'hi',
      appearance: { bold: true },
    });
    const input = plain.querySelector<HTMLInputElement>('.fl-ink-text-input')!;
    expect(input.style.fontWeight).toBe('700');
    expect(input.style.fontStyle).toBe('normal');
    second.dispose();
    plain.remove();
  });
});
