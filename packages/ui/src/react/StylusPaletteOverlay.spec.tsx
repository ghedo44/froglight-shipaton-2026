// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KeyboardInsetStore } from '@froglight/foundation';
import type { StylusPaletteModel } from '../stylus-palette-model.js';
import { attachKeyboardShell, detachKeyboardShell } from '../platform/keyboard-inset.js';
import { disposePaletteHost, showStylusPalette } from './StylusPaletteOverlay.jsx';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function model(): StylusPaletteModel {
  return {
    tools: [
      { id: 'ink.tool.pen', label: 'Pen', toolRole: 'pen', active: true },
      { id: 'ink.tool.eraser', label: 'Eraser', toolRole: 'eraser', active: false },
    ],
    activeToolId: 'ink.tool.pen',
    color: { id: 'ink.color', label: 'Stroke color', value: '#111', options: ['#111', '#222'] },
    width: {
      id: 'ink.width',
      label: 'Stroke width',
      value: '3.5',
      options: [{ value: '3.5', label: '3.5 px' }],
    },
    eraserSize: { id: 'ink.eraser-radius', label: 'Eraser size', value: 10, min: 2, max: 40, step: 1 },
    styles: null,
    canUndo: true,
    canRedo: false,
    focusMode: 'full',
    contributions: [],
  };
}

function click(label: string): void {
  const button = document.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement;
  expect(button).not.toBeNull();
  act(() => button.click());
}

afterEach(() => {
  disposePaletteHost();
  document.body.innerHTML = '';
});

describe('StylusPaletteOverlay', () => {
  it('renders tools with accessible labels and active state', () => {
    let handle: ReturnType<typeof showStylusPalette> | null = null;
    act(() => {
      handle = showStylusPalette(model(), { x: 100, y: 100 });
    });
    const dialog = document.querySelector('[role="dialog"][aria-label="Pencil palette"]');
    expect(dialog).not.toBeNull();
    const pen = document.querySelector('button[aria-label="Pen"]');
    expect(pen?.getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('button[aria-label="Eraser"]')).not.toBeNull();
    act(() => handle?.close());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('selects tools through the execution seam and never focuses inputs', () => {
    const onSelectTool = vi.fn();
    act(() => {
      showStylusPalette(model(), { x: 100, y: 100 }, { onSelectTool });
    });
    const pen = document.querySelector('button[aria-label="Pen"]') as HTMLButtonElement;
    act(() => pen.click());
    expect(onSelectTool).toHaveBeenCalledWith('ink.tool.pen');
    expect(document.activeElement?.tagName).not.toBe('INPUT');
  });

  it('closes on Escape and outside interaction', () => {
    act(() => {
      showStylusPalette(model(), { x: 100, y: 100 });
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('updates the anchor without remounting', () => {
    let handle: ReturnType<typeof showStylusPalette> | null = null;
    act(() => {
      handle = showStylusPalette(model(), { x: 100, y: 100 });
    });
    const before = document.querySelector('[role="dialog"]');
    act(() => handle?.updateAnchor({ x: 200, y: 220 }));
    const after = document.querySelector('[role="dialog"]');
    expect(after).not.toBeNull();
    expect(after).toBe(before);
  });

  it('uses existing color options without duplicating constants', () => {
    const onSelectColor = vi.fn();
    act(() => {
      showStylusPalette(model(), { x: 50, y: 50 }, { onSelectColor });
    });
    click('Stroke color');
    const swatch = document.querySelector('button[aria-label="Color #222"]') as HTMLButtonElement;
    expect(swatch).not.toBeNull();
    act(() => swatch.click());
    expect(onSelectColor).toHaveBeenCalledWith('ink.color', '#222');
  });

  it('presents the compact crescent with toolbar semantics and tiers', () => {
    act(() => {
      showStylusPalette(model(), { x: 400, y: 400 });
    });
    const crescent = document.querySelector('[role="toolbar"][aria-label="Drawing tools"]');
    expect(crescent).not.toBeNull();
    const pen = document.querySelector('button[aria-label="Pen"]');
    expect(pen?.getAttribute('data-squeeze-tier')).toBe('primary');
    // Dialog carries the edge-aware orientation for the crescent tail/arc.
    expect(
      document.querySelector('[role="dialog"]')?.getAttribute('data-squeeze-orientation'),
    ).toMatch(/^(above|below|left|right)$/);
  });

  it('keeps tip clearance: the panel rests beside the tip with a tip ring on it', () => {
    act(() => {
      showStylusPalette(model(), { x: 400, y: 400 });
    });
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
    expect(dialog).not.toBeNull();
    // The panel is offset from the raw anchor (never centered over the tip).
    const left = Number.parseFloat(dialog.style.left);
    const top = Number.parseFloat(dialog.style.top);
    expect(Number.isFinite(left) && Number.isFinite(top)).toBe(true);
    expect(left !== 400 || top !== 400).toBe(true);
    // A hollow, non-interactive ring marks the raw Pencil point itself.
    const tip = Array.from(document.querySelectorAll('div')).find(
      (node) =>
        (node as HTMLElement).style.left === '400px' &&
        (node as HTMLElement).style.top === '400px' &&
        node.getAttribute('aria-hidden') === 'true',
    ) as HTMLElement | undefined;
    expect(tip).toBeDefined();
    expect(tip?.style.pointerEvents ?? 'none').not.toBe('auto');
  });




  it('moves focus along the crescent with arrow keys', () => {
    act(() => {
      showStylusPalette(model(), { x: 400, y: 400 });
    });
    const pen = document.querySelector('button[aria-label="Pen"]') as HTMLButtonElement;
    const eraser = document.querySelector('button[aria-label="Eraser"]') as HTMLButtonElement;
    act(() => pen.focus());
    expect(document.activeElement).toBe(pen);
    act(() => {
      pen.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(eraser);
  });

  it('closes on outside interaction', () => {
    act(() => {
      showStylusPalette(model(), { x: 400, y: 400 });
    });
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    const backdrop = document.querySelector('div[class*="backdrop"]') as HTMLElement;
    expect(backdrop).not.toBeNull();
    act(() => {
      backdrop.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('shows exactly the requested five tools and their settings on one arc', () => {
    const fullTools: StylusPaletteModel['tools'] = [
      { id: 'ink.tool.pen.ball', label: 'Pen', toolRole: 'pen', semanticRole: 'surface.pen.ball', active: true },
      { id: 'ink.tool.pen.fountain', label: 'Fountain Pen', toolRole: 'pen', semanticRole: 'surface.pen.fountain', active: false },
      { id: 'ink.tool.pen.brush', label: 'Brush Pen', toolRole: 'pen', semanticRole: 'surface.pen.brush', active: false },
      { id: 'ink.tool.pen.pencil', label: 'Pencil', toolRole: 'pen', semanticRole: 'surface.pencil', active: false },
      { id: 'ink.tool.highlighter', label: 'Highlighter', toolRole: 'highlighter', semanticRole: 'surface.highlighter', active: false },
      { id: 'ink.tool.eraser', label: 'Eraser', toolRole: 'eraser', semanticRole: 'surface.erase', active: false },
      { id: 'ink.tool.select', label: 'Select', toolRole: 'select', semanticRole: 'surface.select', active: false },
      { id: 'ink.tool.lasso', label: 'Lasso', toolRole: 'lasso', semanticRole: 'surface.lasso', active: false },
      { id: 'ink.tool.shape.line', label: 'Line', toolRole: 'shape', semanticRole: 'surface.shape.line', active: false },
      { id: 'ink.tool.shape.rectangle', label: 'Rectangle', toolRole: 'shape', semanticRole: 'surface.shape.rectangle', active: false },
      { id: 'ink.tool.insert.text', label: 'Text', toolRole: 'text', semanticRole: 'surface.insert.text', active: false },
      { id: 'community.example.diagram.diamond.command', label: 'Decision diamond', semanticRole: 'community.example.diagram.diamond', active: false },
    ];
    act(() => {
      showStylusPalette(
        { ...model(), tools: fullTools, activeToolId: 'ink.tool.pen.ball' },
        { x: 400, y: 400 },
      );
    });
    const crescent = document.querySelector('[role="toolbar"][aria-label="Drawing tools"]');
    expect(crescent).not.toBeNull();
    const tools = Array.from(crescent?.querySelectorAll('[data-squeeze-tier="primary"]') ?? []);
    expect(tools.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Pen', 'Fountain Pen', 'Highlighter', 'Lasso', 'Eraser',
    ]);
    expect(document.querySelectorAll('[role="toolbar"]')).toHaveLength(1);
    expect(crescent?.querySelectorAll('button')).toHaveLength(7);
    expect(document.querySelector('button[aria-label="Rectangle"]')).toBeNull();
  });

  it('tracks the active tool inside the bounded crescent', () => {
    const tools: StylusPaletteModel['tools'] = [
      { id: 'ink.tool.pen.ball', label: 'Pen', toolRole: 'pen', semanticRole: 'surface.pen.ball', active: false },
      { id: 'ink.tool.pen.fountain', label: 'Fountain Pen', toolRole: 'pen', semanticRole: 'surface.pen.fountain', active: true },
      { id: 'ink.tool.highlighter', label: 'Highlighter', toolRole: 'highlighter', semanticRole: 'surface.highlighter', active: false },
      { id: 'ink.tool.eraser', label: 'Eraser', toolRole: 'eraser', semanticRole: 'surface.erase', active: false },
      { id: 'ink.tool.select', label: 'Select', toolRole: 'select', semanticRole: 'surface.select', active: false },
      { id: 'ink.tool.shape.line', label: 'Line', toolRole: 'shape', semanticRole: 'surface.shape.line', active: false },
    ];
    act(() => {
      showStylusPalette(
        { ...model(), tools, activeToolId: 'ink.tool.pen.fountain' },
        { x: 400, y: 400 },
      );
    });
    const crescent = document.querySelector('[role="toolbar"][aria-label="Drawing tools"]');
    const fountain = crescent?.querySelector('button[aria-label="Fountain Pen"]');
    expect(fountain).not.toBeNull();
    expect(fountain?.getAttribute('aria-pressed')).toBe('true');
    expect(crescent?.querySelector('button[aria-label="Pen"]')).not.toBeNull();
  });

  it('updateModel reflects tool and color changes without remounting', () => {
    let handle: ReturnType<typeof showStylusPalette> | null = null;
    act(() => {
      handle = showStylusPalette(model(), { x: 400, y: 400 });
    });
    const before = document.querySelector('[role="dialog"]');
    expect(before).not.toBeNull();
    expect(
      document.querySelector('button[aria-label="Pen"]')?.getAttribute('aria-pressed'),
    ).toBe('true');

    const next: StylusPaletteModel = {
      ...model(),
      tools: [
        { id: 'ink.tool.pen', label: 'Pen', toolRole: 'pen', active: false },
        { id: 'ink.tool.eraser', label: 'Eraser', toolRole: 'eraser', active: true },
      ],
      activeToolId: 'ink.tool.eraser',
      color: { id: 'ink.color', label: 'Stroke color', value: '#222', options: ['#111', '#222'] },
      styles: {
        id: 'ink.saved',
        label: 'Saved styles',
        value: 'b',
        options: [
          { value: 'a', label: 'Atelier' },
          { value: 'b', label: 'Notes' },
        ],
      },
      canUndo: false,
      canRedo: true,
      focusMode: 'full',
    };
    act(() => handle?.updateModel?.(next));
    const after = document.querySelector('[role="dialog"]');
    expect(after).toBe(before);
    expect(
      document.querySelector('button[aria-label="Pen"]')?.getAttribute('aria-pressed'),
    ).toBe('false');
    expect(
      document.querySelector('button[aria-label="Eraser"]')?.getAttribute('aria-pressed'),
    ).toBe('true');
    click('Stroke color');
    expect(document.querySelector('button[aria-label="Color #222"]')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('updateModel after close never resurrects the palette', () => {
    let handle: ReturnType<typeof showStylusPalette> | null = null;
    act(() => {
      handle = showStylusPalette(model(), { x: 400, y: 400 });
    });
    act(() => handle?.close());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    act(() => handle?.updateModel?.({ ...model(), canRedo: true }));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it('dismisses if a viewport resize puts the fixed center outside the viewport', async () => {
    const realWidth = window.innerWidth;
    act(() => { showStylusPalette(model(), { x: 900, y: 400 }); });
    try {
      await act(async () => {
        Object.defineProperty(window, 'innerWidth', { value: 500, configurable: true });
        window.dispatchEvent(new Event('resize'));
      });
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    } finally {
      Object.defineProperty(window, 'innerWidth', { value: realWidth, configurable: true });
    }
  });

  it('dismisses when the keyboard covers the fixed center, even without resize', async () => {
    const store = new KeyboardInsetStore();
    const detach = attachKeyboardShell({ store, doc: document });
    try {
      act(() => { showStylusPalette(model(), { x: 512, y: 600 }); });
      await act(async () => {
        store.handleNativeEvent('target', { height: 300, durationMs: 0 });
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(document.querySelector('[role="dialog"]')).toBeNull();
    } finally {
      detach();
      detachKeyboardShell();
    }
  });

  it('exposes hover titles on icon-only tools and swatches', () => {
    act(() => {
      showStylusPalette(model(), { x: 100, y: 100 });
    });
    // The crescent is icon-only: sighted hover/Pencil-hover users get the
    // same name screen readers get via aria-label.
    expect(
      document
        .querySelector('button[aria-label="Pen"]')
        ?.getAttribute('title'),
    ).toBe('Pen');
    expect(
      document
        .querySelector('button[aria-label="Eraser"]')
        ?.getAttribute('title'),
    ).toBe('Eraser');
    click('Stroke color');
    expect(
      document
        .querySelector('button[aria-label="Color #222"]')
        ?.getAttribute('title'),
    ).toBe('Color #222');
  });

  it('edits three color and size slots on the same arc, then returns to tools', () => {
    const onSelectColor = vi.fn();
    const onSelectWidth = vi.fn();
    const slots: StylusPaletteModel = {
      ...model(),
      color: { id: 'ink.color', label: 'Stroke color', value: '#111', options: ['#111', '#222', '#333'] },
      width: { id: 'ink.width', label: 'Stroke width', value: '2', options: [
        { value: '2', label: '2 px' }, { value: '4', label: '4 px' }, { value: '8', label: '8 px' },
      ] },
    };
    act(() => showStylusPalette(slots, { x: 400, y: 400 }, { onSelectColor, onSelectWidth }));
    const panel = document.querySelector('[role="dialog"]');
    click('Stroke color');
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(document.querySelectorAll('[aria-label="Color presets"] button[aria-label^="Color #"]')).toHaveLength(3);
    click('Color #333');
    expect(onSelectColor).toHaveBeenCalledWith('ink.color', '#333');
    click('Stroke width');
    expect(document.querySelector('[aria-label="Size presets"]')).not.toBeNull();
    click('8 px');
    expect(onSelectWidth).toHaveBeenCalledWith('ink.width', '8');
    click('Back to drawing tools');
    expect(document.querySelector('[role="dialog"]')).toBe(panel);
    expect(document.querySelector('button[aria-label="Pen"]')).not.toBeNull();
  });

  it('opens the requested Apple settings section directly on the arc', () => {
    act(() => showStylusPalette({ ...model(), focusMode: 'color' }, { x: 400, y: 400 }));
    expect(document.querySelector('[aria-label="Color presets"]')).not.toBeNull();
    act(() => showStylusPalette({ ...model(), focusMode: 'attributes' }, { x: 400, y: 400 }));
    expect(document.querySelector('[aria-label="Size presets"]')).not.toBeNull();
  });

});
