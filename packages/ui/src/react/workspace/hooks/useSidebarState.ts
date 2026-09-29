/**
 * Sidebar presentation state: visibility, widths, and active inspector panel.
 *
 * Widths and the inspector preference persist through the workspace settings
 * service; the resize-drag lifecycle (pointer capture, keyboard stepping)
 * lives here with them. Mobile drawer behavior belongs to
 * `useResponsiveWorkspace`; the composition root wires the two together
 * (`setInspectorOpen`, `toggleSidebarView`).
 */

import { useCallback, useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { WorkspaceSettingsService } from '../../../workspace-settings.js';

export type SidebarSide = 'left' | 'right';

export const SIDEBAR_WIDTH = { default: 264, min: 220, max: 420 } as const;
export const RIGHT_SIDEBAR_WIDTH = {
  default: 284,
  min: 240,
  max: 420,
} as const;
const SIDEBAR_RESIZE_STEP = 16;

export interface SidebarResizeState {
  readonly side: SidebarSide;
  readonly startX: number;
  readonly startWidth: number;
  readonly element: HTMLElement;
  readonly pointerId: number;
}

function clampWidth(
  value: number,
  bounds: { min: number; max: number },
): number {
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(value)));
}

export interface SidebarState {
  readonly sidebarVisible: boolean;
  readonly setSidebarVisible: Dispatch<SetStateAction<boolean>>;
  readonly rightSidebarVisible: boolean;
  readonly setRightSidebarVisible: Dispatch<SetStateAction<boolean>>;
  readonly sidebarWidth: number;
  readonly rightSidebarWidth: number;
  readonly rightSidebarPanel: string;
  readonly setRightSidebarPanel: (panel: string) => void;
  readonly setSidebarSize: (side: SidebarSide, value: number) => void;
  readonly sidebarResize: SidebarResizeState | null;
  readonly beginSidebarResize: (
    side: SidebarSide,
    event: {
      readonly button: number;
      readonly clientX: number;
      readonly pointerId: number;
      readonly currentTarget: HTMLElement;
      preventDefault(): void;
    },
  ) => void;
  readonly stepSidebarSize: (side: SidebarSide, direction: 1 | -1) => void;
  readonly edgeSidebarSize: (side: SidebarSide, edge: 'min' | 'max') => void;
}

export function useSidebarState(input: {
  readonly settings: WorkspaceSettingsService | null;
}): SidebarState {
  const { settings } = input;
  const [sidebarVisible, setSidebarVisible] = useState(
    () => window.innerWidth > 760,
  );
  const [rightSidebarVisible, setRightSidebarVisible] = useState<boolean>(
    () =>
      window.innerWidth > 760 &&
      (settings?.get('workspace.rightSidebar.visible', false) ?? false),
  );
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    clampWidth(
      settings?.get('workspace.sidebar.width', SIDEBAR_WIDTH.default) ??
        SIDEBAR_WIDTH.default,
      SIDEBAR_WIDTH,
    ),
  );
  const [rightSidebarWidth, setRightSidebarWidth] = useState(() =>
    clampWidth(
      settings?.get(
        'workspace.rightSidebar.width',
        RIGHT_SIDEBAR_WIDTH.default,
      ) ?? RIGHT_SIDEBAR_WIDTH.default,
      RIGHT_SIDEBAR_WIDTH,
    ),
  );
  const [rightSidebarPanel, setRightSidebarPanelState] = useState<string>(
    () => settings?.get('workspace.rightSidebar.panel', 'outline') ?? 'outline',
  );
  const [sidebarResize, setSidebarResize] = useState<SidebarResizeState | null>(
    null,
  );

  useEffect(() => {
    if (sidebarResize === null) return;
    const onMove = (event: PointerEvent): void => {
      const delta = event.clientX - sidebarResize.startX;
      if (sidebarResize.side === 'left') {
        const width = clampWidth(
          sidebarResize.startWidth + delta,
          SIDEBAR_WIDTH,
        );
        setSidebarWidth(width);
        settings?.set('workspace.sidebar.width', width);
      } else {
        const width = clampWidth(
          sidebarResize.startWidth - delta,
          RIGHT_SIDEBAR_WIDTH,
        );
        setRightSidebarWidth(width);
        settings?.set('workspace.rightSidebar.width', width);
      }
    };
    const onEnd = (): void => {
      if (sidebarResize.element.hasPointerCapture?.(sidebarResize.pointerId)) {
        sidebarResize.element.releasePointerCapture?.(sidebarResize.pointerId);
      }
      setSidebarResize(null);
    };
    const onLostCapture = (): void => setSidebarResize(null);
    const onNextPointerDown = (event: PointerEvent): void => {
      if (event.target !== sidebarResize.element) onEnd();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onEnd);
    window.addEventListener('pointercancel', onEnd);
    window.addEventListener('blur', onEnd);
    document.addEventListener('pointerdown', onNextPointerDown, true);
    sidebarResize.element.addEventListener('lostpointercapture', onLostCapture);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onEnd);
      window.removeEventListener('pointercancel', onEnd);
      window.removeEventListener('blur', onEnd);
      document.removeEventListener('pointerdown', onNextPointerDown, true);
      sidebarResize.element.removeEventListener(
        'lostpointercapture',
        onLostCapture,
      );
    };
  }, [sidebarResize, settings]);

  function setSidebarSize(side: SidebarSide, value: number): void {
    if (side === 'left') {
      const width = clampWidth(value, SIDEBAR_WIDTH);
      setSidebarWidth(width);
      settings?.set('workspace.sidebar.width', width);
    } else {
      const width = clampWidth(value, RIGHT_SIDEBAR_WIDTH);
      setRightSidebarWidth(width);
      settings?.set('workspace.rightSidebar.width', width);
    }
  }

  const setRightSidebarPanel = useCallback(
    (panel: string): void => {
      setRightSidebarPanelState(panel);
      settings?.set('workspace.rightSidebar.panel', panel);
    },
    [settings],
  );

  function beginSidebarResize(
    side: SidebarSide,
    event: {
      readonly button: number;
      readonly clientX: number;
      readonly pointerId: number;
      readonly currentTarget: HTMLElement;
      preventDefault(): void;
    },
  ): void {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setSidebarResize({
      side,
      startX: event.clientX,
      startWidth: side === 'left' ? sidebarWidth : rightSidebarWidth,
      element: event.currentTarget,
      pointerId: event.pointerId,
    });
  }

  function stepSidebarSize(side: SidebarSide, direction: 1 | -1): void {
    const width = side === 'left' ? sidebarWidth : rightSidebarWidth;
    setSidebarSize(side, width + direction * SIDEBAR_RESIZE_STEP);
  }

  function edgeSidebarSize(side: SidebarSide, edge: 'min' | 'max'): void {
    const bounds = side === 'left' ? SIDEBAR_WIDTH : RIGHT_SIDEBAR_WIDTH;
    setSidebarSize(side, edge === 'min' ? bounds.min : bounds.max);
  }

  return {
    sidebarVisible,
    setSidebarVisible,
    rightSidebarVisible,
    setRightSidebarVisible,
    sidebarWidth,
    rightSidebarWidth,
    rightSidebarPanel,
    setRightSidebarPanel,
    setSidebarSize,
    sidebarResize,
    beginSidebarResize,
    stepSidebarSize,
    edgeSidebarSize,
  };
}
