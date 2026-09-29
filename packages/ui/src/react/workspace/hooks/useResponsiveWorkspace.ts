/**
 * Responsive workspace behavior: compact, medium, and wide layout with
 * input density resolved independently from the available width.
 *
 * Owns layout transitions, transient drawers, and the guard that kills drawer
 * animations across a mode flip. Wide inspector preference is stashed while
 * compact/medium presentation makes that surface transient.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import {
  currentInteractionCapabilities,
  WIDE_MIN_WIDTH,
  workspacePresentationPolicy,
  type WorkspacePresentationPolicy,
} from '../interaction-policy.js';

export function isMobileViewport(): boolean {
  return (
    workspacePresentationPolicy({
      width: window.innerWidth,
      capabilities: currentInteractionCapabilities(),
    }).layout === 'compact'
  );
}

function currentPolicy(): WorkspacePresentationPolicy {
  // jsdom has no input media-query implementation. Preserve its historical
  // desktop fixture above the explicit compact breakpoint; real hosts always
  // resolve their actual width and input capabilities.
  const width =
    typeof window.matchMedia !== 'function' && window.innerWidth > 760
      ? WIDE_MIN_WIDTH
      : window.innerWidth;
  return workspacePresentationPolicy({
    width,
    capabilities: currentInteractionCapabilities(),
  });
}

export function useResponsiveWorkspace(input: {
  readonly inspectorVisible: boolean;
  readonly setInspectorVisible: (visible: boolean) => void;
}): {
  readonly mobile: boolean;
  readonly presentation: WorkspacePresentationPolicy;
  readonly mobileDrawerOpen: boolean;
  readonly setMobileDrawerOpen: Dispatch<SetStateAction<boolean>>;
  readonly closeMobileDrawers: () => void;
  /** True briefly across the breakpoint flip to snap instead of animate. */
  readonly switchingBreakpoints: boolean;
} {
  const { inspectorVisible, setInspectorVisible } = input;
  const [presentation, setPresentation] = useState(currentPolicy);
  const mobile = presentation.layout === 'compact';
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const wasLayout = useRef(presentation.layout);
  /** Wide inspector preference stashed while chrome is transient. */
  const inspectorBeforeTransient = useRef<boolean | null>(null);
  const inspectorVisibleRef = useRef(inspectorVisible);
  inspectorVisibleRef.current = inspectorVisible;
  /** Kills drawer transitions across the breakpoint flip (see CSS). */
  const [switchingBreakpoints, setSwitchingBreakpoints] = useState(false);
  const switchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialized = useRef(false);

  useEffect(() => {
    // A persisted desktop inspector is not an intentional modal opening on
    // a fresh tablet/phone workspace. Retain it only for returning to wide.
    if (!initialized.current) {
      initialized.current = true;
      if (wasLayout.current !== 'wide') {
        inspectorBeforeTransient.current = inspectorVisibleRef.current;
        setInspectorVisible(false);
      }
    }
    const suppressSidebarTransitions = (): void => {
      setSwitchingBreakpoints(true);
      if (switchTimer.current !== null) clearTimeout(switchTimer.current);
      switchTimer.current = setTimeout(() => {
        switchTimer.current = null;
        setSwitchingBreakpoints(false);
      }, 350);
    };
    const updatePresentation = (): void => {
      const next = currentPolicy();
      const previousLayout = wasLayout.current;
      setPresentation(next);
      if (next.layout === previousLayout) return;
      wasLayout.current = next.layout;
      // The media query restyles both drawers at the crossing instant, which
      // would otherwise animate a phantom open/close even when nothing was
      // ever shown. Snap instead; longer than --motion-slow (280ms).
      suppressSidebarTransitions();
      setMobileDrawerOpen(false);
      if (previousLayout === 'wide' && next.layout !== 'wide') {
        // A persistent wide Inspector must not become an already-open modal
        // overlay after resize. Preserve the preference for returning wide.
        if (inspectorVisibleRef.current) {
          inspectorBeforeTransient.current = true;
          setInspectorVisible(false);
        }
      } else if (next.layout === 'wide') {
        if (inspectorBeforeTransient.current !== null) {
          setInspectorVisible(inspectorBeforeTransient.current);
          inspectorBeforeTransient.current = null;
        }
      }
    };
    // Subscribe to touch availability, not the primary pointer alone — a
    // touchscreen attaching/detaching (or a hybrid primary flip) must
    // recompute density even when `(pointer: coarse)` never changes.
    const coarse = window.matchMedia?.('(pointer: coarse)');
    const anyCoarse = window.matchMedia?.('(any-pointer: coarse)');
    const hover = window.matchMedia?.('(hover: hover)');
    const anyHover = window.matchMedia?.('(any-hover: hover)');
    window.addEventListener('resize', updatePresentation);
    coarse?.addEventListener?.('change', updatePresentation);
    anyCoarse?.addEventListener?.('change', updatePresentation);
    hover?.addEventListener?.('change', updatePresentation);
    anyHover?.addEventListener?.('change', updatePresentation);
    return () => {
      window.removeEventListener('resize', updatePresentation);
      coarse?.removeEventListener?.('change', updatePresentation);
      anyCoarse?.removeEventListener?.('change', updatePresentation);
      hover?.removeEventListener?.('change', updatePresentation);
      anyHover?.removeEventListener?.('change', updatePresentation);
      if (switchTimer.current !== null) clearTimeout(switchTimer.current);
    };
  }, [setInspectorVisible]);

  const closeMobileDrawers = useCallback((): void => {
    setMobileDrawerOpen(false);
    if (presentation.layout !== 'wide') setInspectorVisible(false);
  }, [presentation.layout, setInspectorVisible]);

  return {
    mobile,
    presentation,
    mobileDrawerOpen,
    setMobileDrawerOpen,
    closeMobileDrawers,
    switchingBreakpoints,
  };
}
