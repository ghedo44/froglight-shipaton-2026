/**
 * Pencil squeeze palette overlay (radial).
 *
 * Compact spatial (radial/crescent) projection of the same semantic graph,
 * ownership, and style state as the normal toolbar — not a second store.
 * The binder resolves the squeeze composition against the full owned pool;
 * this module presents five stable tools (pen, fountain pen, highlighter,
 * lasso, eraser) and the selected tool's size and color on one compact arc.
 * Preset choices replace the tool segment of that same arc.
 *
 * Geometry: the circle center is the opening Pencil position. The rail
 * flips quadrant near edges without translating that center. Holding the
 * squeeze never drags the palette.
 *
 * React owns the DOM; the binder depends only on
 * `showStylusPalette(model, anchor): StylusPaletteHandle`. The palette
 * never steals focus and never summons the keyboard; a Pencil tap on it
 * never creates a canvas stroke underneath.
 */

import { createElement, useLayoutEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import type {
  StylusAccessoryMenuAnchor,
  StylusPaletteHandle,
} from '../stylus-accessory.js';
import {
  placeCenteredSqueezeArc,
  type StylusSafeInsets,
} from '../stylus-palette-geometry.js';
import {
  type StylusPaletteModel,
  type StylusPaletteTool,
} from '../stylus-palette-model.js';
import { currentKeyboardInsetTarget } from '../platform/keyboard-inset.js';
import styles from './StylusPaletteOverlay.module.css';
import { Icon } from './Icon.jsx';

export interface StylusPaletteCallbacks {
  readonly onSelectTool?: (id: string) => void;
  readonly onSelectColor?: (id: string, value: string) => void;
  readonly onSelectWidth?: (id: string, value: string) => void;
  readonly onSelectEraserSize?: (id: string, value: string) => void;
  readonly onSelectStyle?: (id: string, value: string) => void;
  readonly onUndo?: () => void;
  readonly onRedo?: () => void;
  readonly onSelectMenuEntry?: (index: number) => void;
  /**
   * Close lifecycle: invoked exactly once when the palette closes for
   * any reason (outside pointer DOWN, Escape, programmatic/binder close).
   * The binder reconciles its toggle session through it so the next squeeze
   * `began` opens fresh instead of toggling a dead handle. Never throws
   * outward (failures report via `onError`).
   */
  readonly onClose?: () => void;
  /**
   *  diagnostics: overlay-internal failures (replace/close/notify)
   * degrade + report here instead of throwing outward. Optional; absent
   * stays silent.
   */
  readonly onError?: (message: string) => void;
}

interface ActivePalette {
  model: StylusPaletteModel;
  anchor: StylusAccessoryMenuAnchor;
  callbacks: StylusPaletteCallbacks;
  onClose: () => void;
}

let paletteRoot: Root | null = null;
let paletteCloser: (() => void) | null = null;

function acquirePaletteRoot(): Root {
  if (paletteRoot !== null) return paletteRoot;
  const host = document.createElement('div');
  host.className = 'froglight-stylus-palette-host';
  document.body.appendChild(host);
  paletteRoot = createRoot(host);
  return paletteRoot;
}

function clearPalette(): void {
  if (paletteRoot === null) return;
  flushSync(() => {
    paletteRoot!.render(createElement('span', { style: { display: 'none' } }));
  });
}

export function disposePaletteHost(): void {
  if (paletteRoot === null) return;
  paletteRoot.unmount();
  paletteRoot = null;
  document.querySelector('.froglight-stylus-palette-host')?.remove();
}

export function closeActivePalette(): void {
  paletteCloser?.();
}

/**
 * Show the squeeze crescent near `anchor`. Returns a handle whose
 * `updateAnchor` moves the existing panel without remounting. Selection
 * executes and stays open (the binder refreshes in place); outside pointer
 * DOWN and Escape close without focusing anything (the palette never
 * summons the keyboard). Every close path funnels through `close()` and
 * notifies `callbacks.onClose` exactly once so the binder session
 * reconciles; close paths never throw (degrade + `onError`).
 */
export function showStylusPalette(
  model: StylusPaletteModel,
  anchor: StylusAccessoryMenuAnchor,
  callbacks: StylusPaletteCallbacks = {},
): StylusPaletteHandle {
  // Replacing close must never break the new open: the previous handle
  // closes first, and a throwing predecessor degrades + reports.
  try {
    paletteCloser?.();
  } catch (error) {
    notifyPaletteError(
      callbacks,
      `stylus palette replace failed: ${messageOf(error)}`,
    );
  }
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    if (paletteCloser === closer) paletteCloser = null;
    try {
      clearPalette();
    } catch (error) {
      notifyPaletteError(
        callbacks,
        `stylus palette close failed: ${messageOf(error)}`,
      );
    }
    try {
      callbacks.onClose?.();
    } catch (error) {
      notifyPaletteError(
        callbacks,
        `stylus palette close notify failed: ${messageOf(error)}`,
      );
    }
  };
  const closer = (): void => close();
  const active: ActivePalette = { model, anchor, callbacks, onClose: closer };
  const root = acquirePaletteRoot();
  flushSync(() => {
    root.render(
      createElement(StylusPalettePanel, {
        active,
        initialAnchor: anchor,
        initialModel: model,
      }),
    );
  });
  paletteCloser = closer;
  // Anchor/model updates re-render the same panel (no remount): the handle
  // keeps live updaters wired through a module-level slot. Repairs 4+5:
  // `updateModel` pushes in place; a missing channel would be a guarded
  // no-op (binder side), and updates after close never resurrect.
  const updaters = paletteUpdaters.get(active);
  return {
    updateAnchor(next: StylusAccessoryMenuAnchor): void {
      if (closed) return;
      updaters?.updateAnchor(next);
    },
    updateModel(next: StylusPaletteModel): void {
      if (closed) return;
      updaters?.updateModel(next);
    },
    close,
    get closed() {
      return closed;
    },
  };
}

interface PaletteLiveUpdaters {
  readonly updateAnchor: (anchor: StylusAccessoryMenuAnchor) => void;
  readonly updateModel: (model: StylusPaletteModel) => void;
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message;
  return String(error);
}

/** diagnostics fan-out that can never throw back into the overlay.*/
function notifyPaletteError(
  callbacks: StylusPaletteCallbacks,
  message: string,
): void {
  try {
    callbacks.onError?.(message);
  } catch {
    // Diagnostics must never throw.
  }
}

const paletteUpdaters = new WeakMap<ActivePalette, PaletteLiveUpdaters>();

/** OS safe-area insets from platform tokens; 0 when unresolvable (tests). */
function readSafeInsets(): StylusSafeInsets {
  const none = { top: 0, bottom: 0, left: 0, right: 0 };
  try {
    const computed = getComputedStyle(document.documentElement);
    const px = (name: string): number => {
      const parsed = Number.parseFloat(computed.getPropertyValue(name));
      return Number.isFinite(parsed) ? parsed : 0;
    };
    return {
      top: px('--fl-safe-area-top'),
      bottom: px('--fl-safe-area-bottom'),
      left: px('--fl-safe-area-left'),
      right: px('--fl-safe-area-right'),
    };
  } catch {
    return none;
  }
}

interface CrescentPlacement {
  readonly left: number;
  readonly top: number;
  readonly flipX: boolean;
  readonly flipY: boolean;
}

function StylusPalettePanel(props: {
  active: ActivePalette;
  initialAnchor: StylusAccessoryMenuAnchor;
  initialModel: StylusPaletteModel;
}): React.ReactElement {
  const { active } = props;
  const [anchor, setAnchor] = useState(props.initialAnchor);
  // Repairs 4+5 live model: the presented model is panel state, not the
  // opening prop — `updateModel` pushes in place without remounting.
  const [model, setModel] = useState(props.initialModel);
  const [placement, setPlacement] = useState<CrescentPlacement | null>(null);
  // Repairs 4+5 geometry liveness: viewport/keyboard/safe-area changes bump
  // this tick so placement recomputes without remounting. No per-frame
  // rebuild, no ResizeObserver per control — one window/visualViewport
  // subscription for the open palette.
  const [viewportTick, setViewportTick] = useState(0);
  const [section, setSection] = useState<'tools' | 'color' | 'width'>(
    props.initialModel.focusMode === 'color'
      ? 'color'
      : props.initialModel.focusMode === 'attributes'
        ? 'width'
        : 'tools',
  );
  const panelRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    paletteUpdaters.set(active, {
      updateAnchor: setAnchor,
      updateModel: setModel,
    });
    return () => {
      paletteUpdaters.delete(active);
    };
  }, [active]);

  useLayoutEffect(() => {
    const onViewport = (): void => {
      setViewportTick((tick) => tick + 1);
    };
    window.addEventListener('resize', onViewport);
    window.addEventListener('orientationchange', onViewport);
    const viewport = window.visualViewport ?? null;
    viewport?.addEventListener('resize', onViewport);
    viewport?.addEventListener('scroll', onViewport);
    // keyboard/safe-area: the keyboard shell writes
    // `--fl-keyboard-inset-height` (and safe-area tokens) on
    // `documentElement.style` synchronously at intent time, which does not
    // always fire resize (visualViewport may already cover it in some
    // hosts). One MutationObserver on that single element bumps the same
    // tick — no per-control observer, no polling, no per-frame rebuild.
    // Resize/visualViewport remain the Split View/Stage Manager/orientation
    // signals; the observer is the inset-without-resize backstop.
    let observer: MutationObserver | null = null;
    try {
      if (typeof MutationObserver !== 'undefined') {
        observer = new MutationObserver(onViewport);
        observer.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['style'],
        });
      }
    } catch {
      observer = null;
    }
    return () => {
      window.removeEventListener('resize', onViewport);
      window.removeEventListener('orientationchange', onViewport);
      viewport?.removeEventListener('resize', onViewport);
      viewport?.removeEventListener('scroll', onViewport);
      try {
        observer?.disconnect();
      } catch {
        // Teardown must never throw.
      }
    };
  }, []);

  useLayoutEffect(() => {
    const safe = readSafeInsets();
    const keyboard = currentKeyboardInsetTarget();
    if (
      anchor.x < safe.left ||
      anchor.x > window.innerWidth - safe.right ||
      anchor.y < safe.top ||
      anchor.y > window.innerHeight - safe.bottom - keyboard
    ) {
      let current = true;
      queueMicrotask(() => {
        if (current) active.onClose();
      });
      return () => {
        current = false;
      };
    }
    setPlacement(
      placeCenteredSqueezeArc(
        anchor,
        { width: window.innerWidth, height: window.innerHeight },
        safe,
        keyboard,
      ),
    );
    return undefined;
  }, [active, anchor, viewportTick, model]);

  useLayoutEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      const owner =
        event.target instanceof Element
          ? event.target.closest(
              '[role="dialog"], [role="alertdialog"], [role="menu"]',
            )
          : null;
      if (owner !== null && owner !== panelRef.current) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        active.onClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [active]);

  const stopStrokeThrough = (event: React.SyntheticEvent): void => {
    // A Pencil tap on the palette must never create a canvas stroke
    // underneath it: absorb the gesture at the overlay layer. The backdrop
    // covers the viewport (`touch-action: none`) so the canvas never sees
    // the pointer at all.
    event.stopPropagation();
  };

  /** Arrow-key travel along the crescent; Tab order already matches. */
  const onCrescentKeyDown = (event: React.KeyboardEvent): void => {
    if (
      event.key !== 'ArrowRight' &&
      event.key !== 'ArrowLeft' &&
      event.key !== 'ArrowDown' &&
      event.key !== 'ArrowUp' &&
      event.key !== 'Home' &&
      event.key !== 'End'
    ) {
      return;
    }
    const toolbar = event.currentTarget as HTMLElement;
    const buttons = Array.from(
      toolbar.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
    );
    if (buttons.length === 0) return;
    const current = document.activeElement as HTMLElement | null;
    const index = buttons.findIndex((button) => button === current);
    event.preventDefault();
    event.stopPropagation();
    if (event.key === 'Home') {
      buttons[0]?.focus();
      return;
    }
    if (event.key === 'End') {
      buttons[buttons.length - 1]?.focus();
      return;
    }
    const delta =
      event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
    const next =
      index < 0
        ? delta > 0
          ? buttons[0]
          : buttons[buttons.length - 1]
        : buttons[(index + delta + buttons.length) % buttons.length];
    next?.focus();
  };

  const { callbacks } = active;
  // Semantic roles keep the five positions stable across editor providers.
  // Incomplete provider graphs simply omit unavailable tools.
  const primary = [
    model.tools.find((tool) => tool.semanticRole === 'surface.pen.ball') ??
      model.tools.find((tool) => tool.toolRole === 'pen'),
    model.tools.find((tool) => tool.semanticRole === 'surface.pen.fountain'),
    model.tools.find((tool) => tool.toolRole === 'highlighter'),
    model.tools.find((tool) => tool.toolRole === 'lasso'),
    model.tools.find((tool) => tool.toolRole === 'eraser' && tool.active) ??
      model.tools.find((tool) => tool.toolRole === 'eraser'),
  ].filter(
    (tool, index, tools): tool is StylusPaletteTool =>
      tool !== undefined && tools.indexOf(tool) === index,
  );
  const visibleSection =
    section === 'color' && model.color !== null
      ? 'color'
      : section === 'width' && model.width !== null
        ? 'width'
        : 'tools';
  const position = (index: number): React.CSSProperties => ({
    left: 216 - 184 * Math.cos((index * Math.PI) / 12),
    top: 216 - 184 * Math.sin((index * Math.PI) / 12),
  });
  const button = (
    key: string,
    label: string,
    index: number,
    content: React.ReactNode,
    onClick: () => void,
    pressed = false,
    disabled = false,
    tier?: string,
  ): React.ReactElement =>
    createElement(
      'button',
      {
        key,
        type: 'button',
        className: styles['stylus-palette-tool'],
        'aria-label': label,
        title: label,
        'aria-pressed': pressed,
        'data-squeeze-tier': tier,
        style: {
          ...position(index),
          transform: `translate(-50%, -50%) scale(${placement?.flipX ? -1 : 1}, ${placement?.flipY ? -1 : 1})`,
        },
        disabled,
        onClick: (event: React.MouseEvent) => {
          event.stopPropagation();
          onClick();
        },
      },
      content,
    );
  const swatch = (color: string): React.ReactElement =>
    createElement('span', {
      className: styles['stylus-palette-swatch'],
      style: { backgroundColor: color },
      'aria-hidden': true,
    });
  const sizeDot = (value: string): React.ReactElement =>
    createElement('span', {
      className: styles['stylus-palette-size-dot'],
      'aria-hidden': true,
      style: {
        width: Math.min(20, Math.max(3, Number(value) || 3)),
        height: Math.min(20, Math.max(3, Number(value) || 3)),
      },
    });
  const arcButtons: React.ReactElement[] = [];
  if (visibleSection === 'tools') {
    primary.forEach((tool, index) =>
      arcButtons.push(
        button(
          tool.id,
          tool.label,
          index,
          tool.icon
            ? createElement(Icon, { name: tool.icon, size: 24 })
            : (tool.shortLabel ?? tool.label),
          () => callbacks.onSelectTool?.(tool.id),
          tool.active,
          tool.disabled,
          'primary',
        ),
      ),
    );
  } else {
    arcButtons.push(
      button(
        'back',
        'Back to drawing tools',
        0,
        createElement(Icon, { name: 'undo', size: 22 }),
        () => setSection('tools'),
      ),
    );
    if (visibleSection === 'color' && model.color) {
      const color = model.color;
      color.options
        .slice(0, 3)
        .forEach((value, index) =>
          arcButtons.push(
            button(
              `color-${index}`,
              `Color ${value}`,
              index + 1,
              swatch(value),
              () => callbacks.onSelectColor?.(color.id, value),
              color.value === value,
            ),
          ),
        );
    } else if (model.width) {
      const width = model.width;
      width.options
        .slice(0, 3)
        .forEach((option, index) =>
          arcButtons.push(
            button(
              `width-${index}`,
              option.label,
              index + 1,
              createElement(
                'span',
                { className: styles['stylus-palette-size'] },
                sizeDot(option.value),
                createElement('span', null, option.label),
              ),
              () => callbacks.onSelectWidth?.(width.id, option.value),
              width.value === option.value,
            ),
          ),
        );
    }
  }
  const settingsStart =
    visibleSection === 'tools' ? primary.length : arcButtons.length;
  if (model.width)
    arcButtons.push(
      button(
        'width',
        model.width.label,
        settingsStart,
        createElement(Icon, { name: 'sliders', size: 22 }),
        () => setSection(visibleSection === 'width' ? 'tools' : 'width'),
        visibleSection === 'width',
      ),
    );
  if (model.color)
    arcButtons.push(
      button(
        'color',
        model.color.label,
        settingsStart + (model.width ? 1 : 0),
        swatch(model.color.value),
        () => setSection(visibleSection === 'color' ? 'tools' : 'color'),
        visibleSection === 'color',
      ),
    );
  const lastPosition = position(Math.max(0, arcButtons.length - 1));

  return createElement(
    'div',
    {
      className: styles['stylus-palette-backdrop'],
      onPointerDown: (event: React.PointerEvent) => {
        event.stopPropagation();
        // Outside interaction closes; taps on the panel itself stop
        // propagation below and never reach here.
        if (
          (event.target as HTMLElement).closest(
            `.${styles['stylus-palette']}`,
          ) === null
        ) {
          active.onClose();
        }
      },
    },
    // Tip ring: hollow marker over the raw Pencil point (the crescent
    // itself keeps tip clearance). Decorative, never interactive.
    createElement('div', {
      className: styles['stylus-palette-tip'],
      'aria-hidden': true,
      style: { left: anchor.x, top: anchor.y },
    }),
    createElement(
      'div',
      {
        ref: panelRef,
        className: styles['stylus-palette'],
        role: 'dialog',
        'aria-label': 'Pencil palette',
        'data-squeeze-orientation': placement?.flipY ? 'below' : 'above',
        'data-focus-mode': model.focusMode,
        style:
          placement !== null
            ? { left: placement.left, top: placement.top }
            : { left: anchor.x, top: anchor.y },
        onPointerDown: stopStrokeThrough,
        onPointerUp: stopStrokeThrough,
        onTouchStart: stopStrokeThrough,
        onMouseDown: (event: React.MouseEvent) => {
          // Keep focus where it is: the palette never focuses inputs and
          // never summons the software keyboard.
          event.preventDefault();
          event.stopPropagation();
        },
      },
      createElement(
        'div',
        {
          className: styles['stylus-palette-crescent'],
          style: {
            transform: `scale(${placement?.flipX ? -1 : 1}, ${placement?.flipY ? -1 : 1})`,
          },
          role: 'toolbar',
          'aria-label':
            visibleSection === 'tools'
              ? 'Drawing tools'
              : visibleSection === 'color'
                ? 'Color presets'
                : 'Size presets',
          onKeyDown: onCrescentKeyDown,
        },
        createElement(
          'svg',
          {
            className: styles['stylus-palette-arc'],
            viewBox: '0 0 248 248',
            'aria-hidden': true,
          },
          createElement('path', {
            d: `M32 216 A184 184 0 0 1 ${lastPosition.left} ${lastPosition.top}`,
          }),
        ),
        ...arcButtons,
      ),
    ),
  );
}
