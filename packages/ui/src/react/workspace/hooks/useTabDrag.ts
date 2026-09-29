/**
 * Tab-drag lifecycle: pointer-based dragging for mouse and touch.
 *
 * Mouse/pen movement or a touch long press promotes to a drag. Each pane
 * offers a center zone (move as tab) and four edge zones (split); strip entries
 * reorder at a geometric insertion slot. Geometry comes from the pure
 * `dock-interactions` utilities; the controller commits the resolved move.
 * Phones reorder tabs in the visible strip only — never pane-edge splits.
 */

import { useEffect, useRef, useState } from 'react';
import type {
  WorkbenchDockPort,
  WorkbenchStatePort,
} from '../../../workbench-ports.js';
import { tabInsertionIndex } from '../../../dock-interactions.js';
import { resolveDropTarget, type DropTarget } from '../model/dropTargets.js';
import type { Notify } from './useToast.js';
import styles from '../../WorkspaceView.module.css';
import {
  TAB_TOUCH_LONG_PRESS_MS,
  pointerDragSlop,
  type WorkspacePointer,
} from '../interaction-policy.js';

export interface DragState {
  readonly tabId: string;
  readonly fromPane: string;
  readonly pointerId: number;
  readonly pointerType: WorkspacePointer;
  readonly startX: number;
  readonly startY: number;
  readonly x: number;
  readonly y: number;
  readonly phase: 'dragging';
}

interface PressState {
  readonly tabId: string;
  readonly fromPane: string;
  readonly pointerId: number;
  readonly pointerType: WorkspacePointer;
  readonly startX: number;
  readonly startY: number;
  readonly source: HTMLElement;
  phase: 'pressed' | 'dragging' | 'cancelled';
}

export function useTabDrag(input: {
  readonly state: WorkbenchStatePort;
  readonly dock: WorkbenchDockPort;
  readonly mobile: boolean;
  readonly notify: Notify;
}): {
  readonly drag: DragState | null;
  readonly ghost: { x: number; y: number } | null;
  readonly dropTarget: DropTarget | null;
  readonly startTabDrag: (
    event: React.PointerEvent<HTMLElement>,
    pane: string,
    tabId: string,
  ) => void;
  readonly onPaneZoneEnter: (pane: string, zone: DropTarget['zone']) => void;
  readonly clearDropTarget: (pane: string) => void;
} {
  const { state, dock, mobile, notify } = input;
  const [drag, setDrag] = useState<DragState | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);

  const dragStart = useRef<PressState | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearHold(): void {
    if (holdTimer.current !== null) clearTimeout(holdTimer.current);
    holdTimer.current = null;
  }
  /** Mirror of the freshest drag state for stable event handlers. */
  const dragMirror = useRef<{
    drag: DragState | null;
    dropTarget: DropTarget | null;
  }>({
    drag,
    dropTarget,
  });
  dragMirror.current = { drag, dropTarget };

  function dropTargetAt(clientX: number, clientY: number): DropTarget | null {
    if (typeof document.elementFromPoint !== 'function') return null;
    const element = document.elementFromPoint(clientX, clientY);
    if (element === null) return null;

    // Pointer capture and fast pointer movement can keep the browser event
    // target on the source tab. Resolve the actual element under the pointer
    // as well, so a drag still lands when it skips the zone's enter event.
    // Phones keep tab dragging solely for reordering in the visible tab bar.
    // Never resolve a pane-edge zone there, even if a stale DOM node remains
    // while the responsive layout is changing.
    if (mobile) {
      const strip = element.closest<HTMLElement>(`.${styles.tabstrip}`);
      const pane = strip?.dataset.paneStrip;
      if (strip === null || pane === undefined) return null;
      const tabs = [
        ...strip.querySelectorAll<HTMLElement>(`.${styles['fl-tab']}`),
      ];
      return {
        pane,
        zone: 'tab',
        index: tabInsertionIndex(
          tabs.map((tab) => tab.getBoundingClientRect()),
          clientX,
        ),
      };
    }

    const zoneElement = element.closest<HTMLElement>(
      `.${styles['fl-dropzone']}`,
    );
    if (zoneElement !== null) {
      const pane = zoneElement.closest<HTMLElement>(`.${styles['fl-pane']}`)
        ?.dataset.pane;
      const zone = zoneElement.dataset.zone as DropTarget['zone'] | undefined;
      if (pane !== undefined && zone !== undefined) {
        return { pane, zone };
      }
    }

    const strip = element.closest<HTMLElement>(`.${styles.tabstrip}`);
    const pane = strip?.dataset.paneStrip;
    if (strip !== null && pane !== undefined) {
      const tabs = [
        ...strip.querySelectorAll<HTMLElement>(`.${styles['fl-tab']}`),
      ];
      return {
        pane,
        zone: 'tab',
        index: tabInsertionIndex(
          tabs.map((tab) => tab.getBoundingClientRect()),
          clientX,
        ),
      };
    }
    return null;
  }

  function promote(start: PressState, x: number, y: number): void {
    start.phase = 'dragging';
    start.source.setPointerCapture?.(start.pointerId);
    const promoted: DragState = {
      tabId: start.tabId,
      fromPane: start.fromPane,
      pointerId: start.pointerId,
      pointerType: start.pointerType,
      startX: start.startX,
      startY: start.startY,
      x,
      y,
      phase: 'dragging',
    };
    dragMirror.current.drag = promoted;
    setDrag(promoted);
    setGhost({ x, y });
    const target = dropTargetAt(x, y);
    dragMirror.current.dropTarget = target;
    setDropTarget(target);
    document.body.classList.add('fl-dragging');
  }

  // Tab drag lifecycle: movement/hold → drag; drop zones report the target.
  // Listeners stay subscribed for the shell's lifetime; the refs decide
  // whether a move promotes to a drag and whether an up commits a move.
  useEffect(() => {
    const onMove = (event: PointerEvent): void => {
      const start = dragStart.current;
      if (start === null || event.pointerId !== start.pointerId) return;
      if (dragMirror.current.drag === null) {
        const distance = Math.hypot(
          event.clientX - start.startX,
          event.clientY - start.startY,
        );
        const slop = pointerDragSlop(start.pointerType);
        if (distance > slop) {
          if (start.pointerType === 'touch') {
            // Movement before the hold belongs to native horizontal scrolling.
            clearHold();
            start.phase = 'cancelled';
            dragStart.current = null;
          } else {
            promote(start, event.clientX, event.clientY);
          }
        }
        return;
      }
      // While dragging: keep the browser from selecting text or scrolling.
      event.preventDefault();
      setGhost({ x: event.clientX, y: event.clientY });
      const target = dropTargetAt(event.clientX, event.clientY);
      if (target !== null || typeof document.elementFromPoint === 'function') {
        setDropTarget(target);
      }
    };
    const onUp = (event: PointerEvent): void => {
      const press = dragStart.current;
      if (press === null || event.pointerId !== press.pointerId) return;
      clearHold();
      const current = dragMirror.current.drag;
      const hitTarget = dropTargetAt(event.clientX, event.clientY);
      const target =
        hitTarget ??
        (typeof document.elementFromPoint === 'function'
          ? null
          : dragMirror.current.dropTarget);
      document.body.classList.remove('fl-dragging');
      setGhost(null);
      if (current !== null) {
        // Consume only the compatibility click synthesized for this drag.
        // The listener is removed at the end of this event turn, so a later
        // intentional tap can never inherit suppression state.
        const consume = (click: MouseEvent): void => {
          click.preventDefault();
          click.stopImmediatePropagation();
        };
        press.source.addEventListener('click', consume, {
          capture: true,
          once: true,
        });
        queueMicrotask(() =>
          press.source.removeEventListener('click', consume, true),
        );
      }
      if (
        current !== null &&
        target !== null &&
        // Mobile may only reorder tabs in its single visible tab strip.
        (!mobile || target.zone === 'tab')
      ) {
        if (target.zone === 'tab') {
          // Reorder within the same strip, or move into another pane's strip.
          let index = target.index;
          if (target.pane === current.fromPane && index !== undefined) {
            const source = state
              .paneStates()
              .find((pane) => pane.pane === current.fromPane);
            const sourceIndex =
              source?.tabs.findIndex((tab) => tab.id === current.tabId) ?? -1;
            // Geometry reports an insertion slot in the original strip;
            // moveTab accepts a final index after the source tab is removed.
            if (sourceIndex !== -1 && sourceIndex < index) index -= 1;
          }
          void dock
            .moveTab(current.fromPane, current.tabId, {
              kind: 'pane',
              pane: target.pane,
              index,
            })
            .catch((error: unknown) => {
              console.error('Move tab failed', error);
              notify("Couldn't move the tab.", 'error');
            });
        } else if (
          target.zone !== 'center' ||
          target.pane !== current.fromPane
        ) {
          // Edge drops split even when the source and target are the same pane.
          // That is the primary gesture for creating a side-by-side layout.
          // Host rebinding after the move reconciles through the host port
          // (reattach on host mismatch), so no hosts travel with the move.
          void dock
            .moveTab(current.fromPane, current.tabId, resolveDropTarget(target))
            .catch((error: unknown) => {
              console.error('Move tab failed', error);
              notify("Couldn't move the tab.", 'error');
            });
        }
      }
      dragStart.current = null;
      if (press.source.hasPointerCapture?.(press.pointerId))
        press.source.releasePointerCapture(press.pointerId);
      if (current !== null) {
        dragMirror.current.drag = null;
        dragMirror.current.dropTarget = null;
        setDrag(null);
        setDropTarget(null);
      }
    };
    const onCancel = (event?: PointerEvent): void => {
      const press = dragStart.current;
      if (press !== null && event && event.pointerId !== press.pointerId)
        return;
      clearHold();
      if (press !== null) press.phase = 'cancelled';
      if (press?.source.hasPointerCapture?.(press.pointerId))
        press.source.releasePointerCapture(press.pointerId);
      dragStart.current = null;
      dragMirror.current.drag = null;
      dragMirror.current.dropTarget = null;
      setDrag(null);
      setDropTarget(null);
      setGhost(null);
      document.body.classList.remove('fl-dragging');
    };
    // Pointer preventDefault cannot stop browser panning. Keep native scroll
    // until the hold claims this touch, then cancel touchmove before it pans.
    const onTouchMove = (event: TouchEvent): void => {
      if (
        dragStart.current?.pointerType === 'touch' &&
        dragStart.current.phase === 'dragging' &&
        event.cancelable
      ) {
        event.preventDefault();
      }
    };
    const onTouchStart = (event: TouchEvent): void => {
      if (event.touches.length > 1) onCancel();
    };
    const onContextMenu = (event: MouseEvent): void => {
      const press = dragStart.current;
      if (
        press?.pointerType === 'touch' &&
        event.target instanceof Node &&
        press.source.contains(event.target)
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    const onBlur = (): void => onCancel();
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('contextmenu', onContextMenu, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('lostpointercapture', onCancel);
    return () => {
      clearHold();
      const press = dragStart.current;
      dragStart.current = null;
      if (press?.source.hasPointerCapture?.(press.pointerId))
        press.source.releasePointerCapture(press.pointerId);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('contextmenu', onContextMenu, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('lostpointercapture', onCancel);
      document.body.classList.remove('fl-dragging');
    };
  }, [state, dock, mobile, notify]);

  function startTabDrag(
    event: React.PointerEvent<HTMLElement>,
    pane: string,
    tabId: string,
  ): void {
    if (
      event.button !== 0 ||
      event.isPrimary === false ||
      dragStart.current !== null
    )
      return;
    const pointerType: WorkspacePointer =
      event.pointerType === 'touch' || event.pointerType === 'pen'
        ? event.pointerType
        : 'mouse';
    const start: PressState = {
      tabId,
      fromPane: pane,
      pointerId: event.pointerId,
      pointerType,
      startX: event.clientX,
      startY: event.clientY,
      source: event.currentTarget,
      phase: 'pressed',
    };
    dragStart.current = start;
    if (pointerType === 'touch') {
      holdTimer.current = setTimeout(() => {
        holdTimer.current = null;
        if (dragStart.current === start && start.phase === 'pressed')
          promote(start, start.startX, start.startY);
      }, TAB_TOUCH_LONG_PRESS_MS);
    }
    // A short press remains a click; movement or the hold promotes a drag.
    setDrag(null);
  }

  function onPaneZoneEnter(pane: string, zone: DropTarget['zone']): void {
    if (mobile) return;
    if (dragMirror.current.drag === null) return;
    setDropTarget({ pane, zone });
  }

  function clearDropTarget(pane: string): void {
    setDropTarget((current) => (current?.pane === pane ? null : current));
  }

  return {
    drag,
    ghost,
    dropTarget,
    startTabDrag,
    onPaneZoneEnter,
    clearDropTarget,
  };
}
