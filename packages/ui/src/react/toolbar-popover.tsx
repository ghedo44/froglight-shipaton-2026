/**
 * Pane-scoped toolbar popover geometry (review slice 2).
 *
 * Popovers portal into one React-owned layer per pane (never as descendants
 * of horizontally scrollable islands, which would clip them) and position
 * relative to their trigger with flip/shift/clamp inside pane bounds plus
 * safe-area insets. Reused by all toolbar popovers (Markdown/Block links,
 * LaTeX diagnostics, compact overflow menus).
 */

import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';

/**
 * First keyboard-focusable descendant (buttons, selects, inputs, links,
 * and explicit tabindex stops — never disabled or tabindex="-1").
 * Shared by toolbar menus and settings popovers so keyboard users land
 * inside the disclosure they just opened (portaled content sits after the
 * trigger in tab order, so leaving focus on the trigger would strand
 * keyboard travel). No-op when nothing is focusable.
 */
export function focusFirstFocusable(container: HTMLElement | null): boolean {
  if (container === null) return false;
  const target = container.querySelector<HTMLElement>(
    'button:not(:disabled), select:not(:disabled), input:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
  );
  if (target === null) return false;
  target.focus();
  return true;
}

/**
 * Roving arrow-key travel for toolbar menus and menu-like groups
 * (keyboard navigation). ArrowDown/ArrowUp move across the
 * enabled buttons in DOM order with wraparound; Home/End jump to the
 * ends. Returns true when the key was handled (callers preventDefault).
 * Tab order already matches DOM order, so this only accelerates travel.
 *
 * Roving is button-only: when the key originates inside a native select,
 * slider, or text input, the event is left alone so the control keeps its
 * own arrow behavior (option travel, value stepping, caret movement).
 */
export function handleMenuListKeyDown(
  event: React.KeyboardEvent,
  container: HTMLElement | null,
): boolean {
  if (
    event.key !== 'ArrowDown' &&
    event.key !== 'ArrowUp' &&
    event.key !== 'ArrowRight' &&
    event.key !== 'ArrowLeft' &&
    event.key !== 'Home' &&
    event.key !== 'End'
  ) {
    return false;
  }
  const target = event.target;
  if (
    !(target instanceof HTMLElement) ||
    target.closest('button, [role="menuitem"]') === null
  ) {
    return false;
  }
  if (container === null) return false;
  const buttons = Array.from(
    container.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'),
  );
  if (buttons.length === 0) return false;
  const current = document.activeElement as HTMLElement | null;
  const index = buttons.findIndex((button) => button === current);
  if (event.key === 'Home') {
    buttons[0]?.focus();
    return true;
  }
  if (event.key === 'End') {
    buttons[buttons.length - 1]?.focus();
    return true;
  }
  const vertical = event.key === 'ArrowDown' || event.key === 'ArrowUp';
  const horizontal = event.key === 'ArrowRight' || event.key === 'ArrowLeft';
  if (!vertical && !horizontal) return false;
  const delta =
    event.key === 'ArrowDown' || event.key === 'ArrowRight' ? 1 : -1;
  const next =
    index < 0
      ? delta > 0
        ? buttons[0]
        : buttons[buttons.length - 1]
      : buttons[(index + delta + buttons.length) % buttons.length];
  next?.focus();
  return true;
}

/**
 * Move focus into a freshly opened disclosure (menu/popover) once, on the
 * open transition only — never on mount-when-closed and never while open.
 * Mouse/pen users are unaffected visually (`:focus-visible` stays off for
 * pointer-initiated focus); keyboard users avoid tabbing through the whole
 * toolbar to reach portaled content.
 */
export function useFocusFirstOnOpen(
  open: boolean,
  containerRef: React.RefObject<HTMLElement | null>,
): void {
  const wasOpen = useRef(open);
  useEffect(() => {
    const previously = wasOpen.current;
    wasOpen.current = open;
    if (!open || previously) return;
    focusFirstFocusable(containerRef.current);
  }, [open, containerRef]);
}

/** Rect in a shared coordinate space (viewport via getBoundingClientRect). */
export interface ToolbarPopoverRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface ToolbarPopoverGeometry {
  readonly trigger: ToolbarPopoverRect;
  readonly pane: ToolbarPopoverRect;
  readonly popover: { readonly width: number; readonly height: number };
  readonly preferred: ToolbarPopoverPlacement;
  readonly inset: number;
  readonly gap?: number;
}

export interface ToolbarPopoverPosition {
  readonly left: number;
  readonly top: number;
  readonly placement: ToolbarPopoverPlacement;
  /** Maximum painted size that still fits inside the owning pane. */
  readonly maxWidth: number;
  readonly maxHeight: number;
}

export type ToolbarPopoverPlacement = 'below' | 'above' | 'left' | 'right';

/**
 * Pure positioner: prefer the requested side, flip vertically when there is
 * not enough room, shift horizontally near pane edges, clamp to pane bounds
 * with safe-area insets. Never escapes the pane.
 */
export function computeToolbarPopoverPosition(
  geometry: ToolbarPopoverGeometry,
): ToolbarPopoverPosition {
  const gap = geometry.gap ?? 8;
  const { trigger, pane, popover, preferred, inset } = geometry;
  const minX = pane.x + inset;
  const maxX = pane.x + pane.width - inset - popover.width;
  const minY = pane.y + inset;
  const maxY = pane.y + pane.height - inset - popover.height;

  if (preferred === 'left' || preferred === 'right') {
    const rightLeft = trigger.x + trigger.width + gap;
    const leftLeft = trigger.x - popover.width - gap;
    const fitsRight = rightLeft + popover.width <= pane.x + pane.width - inset;
    const fitsLeft = leftLeft >= minX;
    const placement =
      preferred === 'right'
        ? fitsRight || !fitsLeft
          ? 'right'
          : 'left'
        : fitsLeft || !fitsRight
          ? 'left'
          : 'right';
    const left = placement === 'right' ? rightLeft : leftLeft;
    const centeredY = trigger.y + trigger.height / 2 - popover.height / 2;
    return {
      left: maxX < minX ? minX : Math.max(minX, Math.min(left, maxX)),
      top: maxY < minY ? minY : Math.max(minY, Math.min(centeredY, maxY)),
      placement,
      maxWidth: Math.max(0, pane.width - inset * 2),
      maxHeight: Math.max(0, pane.height - inset * 2),
    };
  }

  // Horizontal: center on the trigger, then shift to stay inside.
  const centeredX = trigger.x + trigger.width / 2 - popover.width / 2;
  const clampedX =
    maxX < minX ? minX : Math.max(minX, Math.min(centeredX, maxX));

  const belowTop = trigger.y + trigger.height + gap;
  const aboveTop = trigger.y - popover.height - gap;
  const fitsBelow = belowTop + popover.height <= pane.y + pane.height - inset;
  const fitsAbove = aboveTop >= pane.y + inset;

  let placement: 'below' | 'above';
  let top: number;
  if (preferred === 'below') {
    if (fitsBelow || !fitsAbove) {
      placement = 'below';
      top = belowTop;
    } else {
      placement = 'above';
      top = aboveTop;
    }
  } else {
    if (fitsAbove || !fitsBelow) {
      placement = 'above';
      top = aboveTop;
    } else {
      placement = 'below';
      top = belowTop;
    }
  }
  // Clamp vertically so tall popovers never escape (scroll internally).
  const clampedY = maxY < minY ? minY : Math.max(minY, Math.min(top, maxY));
  return {
    left: clampedX,
    top: clampedY,
    placement,
    maxWidth: Math.max(0, pane.width - inset * 2),
    maxHeight: Math.max(0, pane.height - inset * 2),
  };
}

/** Pane-scoped popover layer (one per pane, provided by the Pane). */
const ToolbarPopoverLayerContext = createContext<HTMLElement | null>(null);

export function useToolbarPopoverLayer(): HTMLElement | null {
  return useContext(ToolbarPopoverLayerContext);
}

/**
 * Scope providing one popover layer for a pane. Renders the layer as a
 * pane-body sibling (not inside scrollable islands) and provides it to
 * toolbar popovers for `createPortal`.
 */
export function ToolbarPopoverScope(props: {
  readonly children: React.ReactNode;
}): React.ReactElement {
  const [layer, setLayer] = useState<HTMLElement | null>(null);
  return (
    <ToolbarPopoverLayerContext.Provider value={layer}>
      {props.children}
      <div
        data-popover-layer=""
        ref={setLayer}
        style={{
          position: 'absolute',
          inset: 0,
          zIndex: 4,
          pointerEvents: 'none',
        }}
      />
    </ToolbarPopoverLayerContext.Provider>
  );
}

/**
 * Position a popover relative to its trigger inside pane bounds.
 * Recomputes on pane/popover/trigger resize, viewport resize, scroll
 * (capture), and trigger movement.
 */
export function useToolbarPopoverPosition(input: {
  readonly triggerRef: React.RefObject<HTMLElement | null>;
  readonly popoverRef: React.RefObject<HTMLElement | null>;
  readonly preferred?: ToolbarPopoverPlacement;
  readonly inset?: number;
  readonly enabled: boolean;
}): ToolbarPopoverPosition | null {
  const { triggerRef, popoverRef, enabled } = input;
  const preferred = input.preferred;
  const inset = input.inset ?? 8;
  const [position, setPosition] = useState<ToolbarPopoverPosition | null>(null);

  useLayoutEffect(() => {
    if (!enabled) {
      setPosition(null);
      return;
    }
    const trigger = triggerRef.current;
    const popover = popoverRef.current;
    if (trigger === null || popover === null) return;
    // Pane bounds from the closest pane ancestor (pane-scoped, not global).
    const paneElement =
      trigger.closest('[data-pane]') ??
      trigger.closest('[data-popover-layer]')?.parentElement;
    if (paneElement === null || paneElement === undefined) return;

    const measure = (): void => {
      const t = triggerRef.current;
      const p = popoverRef.current;
      const pane = t?.closest('[data-pane]') as HTMLElement | null;
      if (
        t === null ||
        t === undefined ||
        p === null ||
        p === undefined ||
        pane === null
      )
        return;
      const triggerRect = t.getBoundingClientRect();
      const paneRect = pane.getBoundingClientRect();
      const popoverRect = p.getBoundingClientRect();
      // Popover may report 0 before paint; fall back to offset sizes.
      const popoverWidth =
        popoverRect.width > 0
          ? popoverRect.width
          : ((p as unknown as { offsetWidth?: number }).offsetWidth ?? 0);
      const popoverHeight =
        popoverRect.height > 0
          ? popoverRect.height
          : ((p as unknown as { offsetHeight?: number }).offsetHeight ?? 0);
      if (popoverWidth === 0 && popoverHeight === 0) return;
      const dock = t.closest('[data-dock]')?.getAttribute('data-dock');
      const placement =
        preferred ??
        (dock === 'left' ? 'right' : dock === 'right' ? 'left' : 'below');
      setPosition(
        computeToolbarPopoverPosition({
          trigger: {
            x: triggerRect.x,
            y: triggerRect.y,
            width: triggerRect.width,
            height: triggerRect.height,
          },
          pane: {
            x: paneRect.x,
            y: paneRect.y,
            width: paneRect.width,
            height: paneRect.height,
          },
          popover: { width: popoverWidth, height: popoverHeight },
          preferred: placement,
          inset,
        }),
      );
    };

    measure();
    const Observer =
      typeof ResizeObserver === 'function' ? ResizeObserver : null;
    const observer = Observer !== null ? new Observer(() => measure()) : null;
    observer?.observe(trigger);
    observer?.observe(popover);
    const paneEl = trigger.closest('[data-pane]');
    if (paneEl !== null) observer?.observe(paneEl);
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    // Trigger movement (e.g., toolbar compaction) repositions over a bounded
    // number of post-open frames: mount, measure after layout, optional
    // stabilization — then observers + resize/scroll take over. No prolonged
    // polling.
    let frames = 0;
    let frame = requestAnimationFrame(function poll() {
      measure();
      frames += 1;
      if (frames >= 3) return;
      frame = requestAnimationFrame(poll);
    });
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
      cancelAnimationFrame(frame);
    };
  }, [triggerRef, popoverRef, enabled, preferred, inset]);

  return position;
}

/** Portal popover content into the pane-scoped layer when available. */
export function ToolbarPopoverPortal(props: {
  readonly children: React.ReactNode;
}): React.ReactElement | null {
  const layer = useToolbarPopoverLayer();
  const fallbackRef = useRef<HTMLSpanElement | null>(null);
  const [, force] = useState(0);
  useEffect(() => {
    // Re-render once so portal target resolves after the layer commits.
    force((count) => count + 1);
  }, []);
  void fallbackRef;
  if (layer !== null) {
    return createPortal(props.children, layer) as unknown as React.ReactElement;
  }
  // Fallback for standalone toolbar usage outside a Pane (tests): render
  // inline so popover lifecycle still works without a layer.
  return <>{props.children}</>;
}
