// @vitest-environment jsdom
/**
 * Outside dismissal and close lifecycle for the squeeze
 * palette overlay.
 *
 * - Outside pointer DOWN (mouse/touch/Pencil unified pointer path) closes;
 *   taps inside the panel never reach the outside-close edge.
 * - Every internal action (tool/style/color/width/eraser/history/More)
 *   executes through its callback, keeps the palette open, and never
 *   notifies `onClose`.
 * - Close never steals focus, never summons the keyboard (no inputs
 *   focused), and never lets a Pencil gesture draw through (absorbed at the
 *   overlay layer).
 * - The backdrop never remains after close; close is idempotent (`onClose`
 *   exactly once); overlay-internal failures degrade + report via `onError`
 *  instead of throwing outward.
 */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StylusPaletteModel } from '../stylus-palette-model.js';
import {
  disposePaletteHost,
  showStylusPalette,
} from './StylusPaletteOverlay.jsx';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function model(): StylusPaletteModel {
  return {
    tools: [
      { id: 'ink.tool.pen', label: 'Pen', toolRole: 'pen', active: true },
      {
        id: 'ink.tool.eraser',
        label: 'Eraser',
        toolRole: 'eraser',
        active: false,
      },
    ],
    activeToolId: 'ink.tool.pen',
    color: {
      id: 'ink.color',
      label: 'Stroke color',
      value: '#111',
      options: ['#111', '#222'],
    },
    width: {
      id: 'ink.width',
      label: 'Stroke width',
      value: '3.5',
      options: [{ value: '3.5', label: '3.5 px' }],
    },
    eraserSize: {
      id: 'ink.eraser-radius',
      label: 'Eraser size',
      value: 10,
      min: 2,
      max: 40,
      step: 1,
    },
    styles: {
      id: 'ink.saved',
      label: 'Saved styles',
      value: 'a',
      options: [{ value: 'b', label: 'Notes' }],
    },
    canUndo: true,
    canRedo: true,
    focusMode: 'full',
    contributions: [{ label: 'Acme recipe', run: vi.fn() }],
  };
}

function backdrop(): HTMLElement | null {
  return document.querySelector(
    'div[class*="backdrop"]',
  ) as HTMLElement | null;
}

function dialog(): HTMLElement | null {
  return document.querySelector(
    '[role="dialog"][aria-label="Pencil palette"]',
  ) as HTMLElement | null;
}

function outsidePointerDown(target: Element): void {
  target.dispatchEvent(
    new PointerEvent('pointerdown', { bubbles: true, cancelable: true }),
  );
}

afterEach(() => {
  disposePaletteHost();
  document.body.innerHTML = '';
});

describe('H4-1 outside pointer DOWN closes reliably', () => {
  it('backdrop pointerdown closes, removes the backdrop, notifies onClose once', () => {
    const onClose = vi.fn();
    act(() => {
      showStylusPalette(model(), { x: 400, y: 400 }, { onClose });
    });
    expect(dialog()).not.toBeNull();
    const host = backdrop();
    expect(host).not.toBeNull();
    act(() => {
      outsidePointerDown(host as HTMLElement);
    });
    expect(dialog()).toBeNull();
    expect(backdrop()).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Escape closes, removes the backdrop, notifies onClose once', () => {
    const onClose = vi.fn();
    act(() => {
      showStylusPalette(model(), { x: 400, y: 400 }, { onClose });
    });
    expect(dialog()).not.toBeNull();
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(dialog()).toBeNull();
    expect(backdrop()).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('programmatic close notifies onClose once; repeat closes stay idempotent', () => {
    const onClose = vi.fn();
    let handle: ReturnType<typeof showStylusPalette> | null = null;
    act(() => {
      handle = showStylusPalette(model(), { x: 100, y: 100 }, { onClose });
    });
    act(() => handle?.close());
    act(() => handle?.close());
    expect(dialog()).toBeNull();
    expect(backdrop()).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('replacing the palette closes the predecessor and notifies its onClose', () => {
    const firstClose = vi.fn();
    const secondClose = vi.fn();
    let second: ReturnType<typeof showStylusPalette> | null = null;
    act(() => {
      showStylusPalette(model(), { x: 100, y: 100 }, { onClose: firstClose });
    });
    act(() => {
      second = showStylusPalette(
        model(),
        { x: 200, y: 200 },
        { onClose: secondClose },
      );
    });
    expect(firstClose).toHaveBeenCalledTimes(1);
    expect(secondClose).not.toHaveBeenCalled();
    expect(dialog()).not.toBeNull();
    act(() => second?.close());
    expect(secondClose).toHaveBeenCalledTimes(1);
  });
});

describe('H4-1 inside interaction never outside-closes', () => {
  it('pointer DOWN on the panel stays open and never notifies onClose', () => {
    const onClose = vi.fn();
    act(() => {
      showStylusPalette(model(), { x: 400, y: 400 }, { onClose });
    });
    const panel = dialog();
    expect(panel).not.toBeNull();
    act(() => {
      outsidePointerDown(panel as HTMLElement);
    });
    expect(dialog()).not.toBeNull();
    expect(backdrop()).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('tool selection executes, stays open, and never notifies onClose', () => {
    const onSelectTool = vi.fn();
    const onClose = vi.fn();
    act(() => {
      showStylusPalette(
        model(),
        { x: 400, y: 400 },
        { onSelectTool, onClose },
      );
    });
    act(() => {
      (
        document.querySelector(
          'button[aria-label="Eraser"]',
        ) as HTMLButtonElement
      ).click();
    });
    expect(onSelectTool).toHaveBeenCalledWith('ink.tool.eraser');
    expect(dialog()).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('style/color/width/eraser/history/More execute and keep the palette open', () => {
    const callbacks = {
      onSelectColor: vi.fn(),
      onSelectWidth: vi.fn(),
      onSelectStyle: vi.fn(),
      onSelectEraserSize: vi.fn(),
      onUndo: vi.fn(),
      onRedo: vi.fn(),
      onSelectMenuEntry: vi.fn(),
      onClose: vi.fn(),
    };
    act(() => {
      showStylusPalette(model(), { x: 400, y: 400 }, callbacks);
    });
    act(() => {
      (
        document.querySelector(
          'button[aria-label="Color #222"]',
        ) as HTMLButtonElement
      ).click();
    });
    expect(callbacks.onSelectColor).toHaveBeenCalledWith('ink.color', '#222');
    act(() => {
      (
        document.querySelector(
          'button[aria-label="3.5 px"]',
        ) as HTMLButtonElement
      ).click();
    });
    expect(callbacks.onSelectWidth).toHaveBeenCalledWith('ink.width', '3.5');
    act(() => {
      (
        document.querySelector(
          'button[aria-label="Notes"]',
        ) as HTMLButtonElement
      ).click();
    });
    expect(callbacks.onSelectStyle).toHaveBeenCalledWith('ink.saved', 'b');
    const eraser = document.querySelector(
      'input[aria-label="Eraser size"]',
    ) as HTMLInputElement;
    expect(eraser).not.toBeNull();
    act(() => {
      (document.querySelector('button[aria-label="Undo"]') as HTMLButtonElement).click();
    });
    expect(callbacks.onUndo).toHaveBeenCalledTimes(1);
    act(() => {
      (document.querySelector('button[aria-label="Redo"]') as HTMLButtonElement).click();
    });
    expect(callbacks.onRedo).toHaveBeenCalledTimes(1);
    act(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      buttons.find((button) => button.textContent === 'Acme recipe')?.click();
    });
    expect(callbacks.onSelectMenuEntry).toHaveBeenCalledWith(0);
    expect(dialog()).not.toBeNull();
    expect(callbacks.onClose).not.toHaveBeenCalled();
  });
});

describe('H4-1 focus, keyboard, and stroke-through safety', () => {
  it('outside close and Escape never move focus and never focus an input', () => {
    const probe = document.createElement('button');
    probe.textContent = 'probe';
    document.body.appendChild(probe);
    probe.focus();
    expect(document.activeElement).toBe(probe);
    act(() => {
      showStylusPalette(model(), { x: 400, y: 400 });
    });
    expect(document.activeElement).toBe(probe);
    act(() => {
      outsidePointerDown(backdrop() as HTMLElement);
    });
    expect(document.activeElement).toBe(probe);
    act(() => {
      showStylusPalette(model(), { x: 400, y: 400 });
    });
    act(() => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(document.activeElement).toBe(probe);
    expect(document.activeElement?.tagName).not.toBe('INPUT');
  });

  it('leaves Escape to a nested modal that owns the focused target', () => {
    act(() => {
      showStylusPalette(model(), { x: 400, y: 400 });
    });
    const nested = document.createElement('div');
    nested.setAttribute('role', 'dialog');
    const input = document.createElement('input');
    nested.append(input);
    document.body.append(nested);
    input.focus();
    const event = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    act(() => input.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
    expect(dialog()).not.toBeNull();
    nested.remove();
  });

  it('panel mousedown is default-prevented so clicks never steal focus or summon the keyboard', () => {
    act(() => {
      showStylusPalette(model(), { x: 400, y: 400 });
    });
    const panel = dialog() as HTMLElement;
    let prevented = false;
    act(() => {
      const event = new MouseEvent('mousedown', {
        bubbles: true,
        cancelable: true,
      });
      panel.dispatchEvent(event);
      prevented = event.defaultPrevented;
    });
    expect(prevented).toBe(true);
  });

  it('Pencil pointer gestures on the panel never reach underlying content', () => {
    const strokes: string[] = [];
    document.addEventListener('pointerdown', (event) => {
      strokes.push((event as PointerEvent).pointerType);
    });
    act(() => {
      showStylusPalette(model(), { x: 400, y: 400 });
    });
    act(() => {
      (dialog() as HTMLElement).dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          pointerType: 'pen',
        }),
      );
    });
    expect(strokes).toEqual([]);
    expect(dialog()).not.toBeNull();
  });

  it('outside pointerdown is absorbed at the overlay layer', () => {
    const seen: string[] = [];
    document.addEventListener('pointerdown', () => {
      seen.push('document');
    });
    const onClose = vi.fn();
    act(() => {
      showStylusPalette(model(), { x: 400, y: 400 }, { onClose });
    });
    act(() => {
      outsidePointerDown(backdrop() as HTMLElement);
    });
    expect(seen).toEqual([]);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('H6-OVL overlay failures degrade with diagnostics, never throw', () => {
  it('a throwing onClose still closes and reports via onError', () => {
    const onError = vi.fn();
    const onClose = vi.fn(() => {
      throw new Error('host boom');
    });
    let dispatchThrew = false;
    act(() => {
      showStylusPalette(model(), { x: 100, y: 100 }, { onClose, onError });
    });
    act(() => {
      try {
        outsidePointerDown(backdrop() as HTMLElement);
      } catch {
        dispatchThrew = true;
      }
    });
    expect(dispatchThrew).toBe(false);
    expect(dialog()).toBeNull();
    expect(backdrop()).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0]?.[0])).toContain(
      'stylus palette close notify failed',
    );
  });

  it('a throwing onError never breaks close', () => {
    let dispatchThrew = false;
    act(() => {
      showStylusPalette(model(), { x: 100, y: 100 }, {
        onClose: () => {
          throw new Error('host boom');
        },
        onError: () => {
          throw new Error('diagnostics boom');
        },
      });
    });
    act(() => {
      try {
        outsidePointerDown(backdrop() as HTMLElement);
      } catch {
        dispatchThrew = true;
      }
    });
    expect(dispatchThrew).toBe(false);
    expect(dialog()).toBeNull();
    expect(backdrop()).toBeNull();
  });
});
