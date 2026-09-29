/** Shared workspace presentation and ordinary-UI gesture policy. */

export type WorkspaceLayoutMode = 'compact' | 'medium' | 'wide';
export type WorkspacePointer = 'mouse' | 'touch' | 'pen';

export interface WorkspaceInteractionCapabilities {
  readonly pointer: WorkspacePointer;
  /**
   * Touch available: primary `(pointer: coarse)` OR `(any-pointer: coarse)`.
   * Hybrid hosts (iPad + trackpad, touchscreen laptops) report a fine
   * primary pointer while touch stays available — density must follow this
   * flag, never the primary pointer alone.
   */
  readonly coarse: boolean;
  readonly supportsHover: boolean;
  /**
   * Raw `(any-pointer: coarse)` availability. `coarse` above already folds
   * it in; this field preserves the distinction for diagnostics/tests.
   */
  readonly anyCoarse: boolean;
  /** Raw `(any-hover: hover)` availability. */
  readonly anyHover: boolean;
}

export interface WorkspacePresentationPolicy {
  readonly layout: WorkspaceLayoutMode;
  readonly showActivityRail: boolean;
  readonly showBottomNavigation: boolean;
  readonly sidebarMode: 'drawer' | 'overlay' | 'persistent';
  readonly inspectorMode: 'drawer' | 'overlay' | 'persistent';
  readonly allowVisibleSplit: boolean;
  readonly controlDensity: 'compact' | 'touch';
}

export const COMPACT_MAX_WIDTH = 760;
export const WIDE_MIN_WIDTH = 1180;
export const MIN_SPLIT_CONTENT_WIDTH = 800;
export const TAB_TOUCH_LONG_PRESS_MS = 350;

export function workspaceLayoutMode(width: number): WorkspaceLayoutMode {
  if (width <= COMPACT_MAX_WIDTH) return 'compact';
  if (width < WIDE_MIN_WIDTH) return 'medium';
  return 'wide';
}

export function workspacePresentationPolicy(input: {
  readonly width: number;
  readonly capabilities: WorkspaceInteractionCapabilities;
}): WorkspacePresentationPolicy {
  const layout = workspaceLayoutMode(input.width);
  return {
    layout,
    showActivityRail: layout !== 'compact',
    showBottomNavigation: layout === 'compact',
    sidebarMode:
      layout === 'wide'
        ? 'persistent'
        : layout === 'medium'
          ? 'overlay'
          : 'drawer',
    inspectorMode:
      layout === 'wide'
        ? 'persistent'
        : layout === 'medium'
          ? 'overlay'
          : 'drawer',
    allowVisibleSplit:
      layout !== 'compact' && input.width >= MIN_SPLIT_CONTENT_WIDTH,
    // Density follows touch AVAILABILITY (`coarse` folds in any-pointer, so
    // hybrid fine-primary + touch still resolves touch), never primary
    // identity alone. A `touch` pointer with a fine primary (hybrid) also
    // resolves touch. Pen is fine-only by construction (see
    // `currentInteractionCapabilities`) and stays dense.
    controlDensity:
      input.capabilities.coarse || input.capabilities.pointer === 'touch'
        ? 'touch'
        : 'compact',
  };
}

export function pointerDragSlop(pointer: string): number {
  if (pointer === 'touch') return 12;
  if (pointer === 'pen') return 6;
  return 4;
}

export function currentInteractionCapabilities(): WorkspaceInteractionCapabilities {
  // Touch availability (not primary-pointer identity) drives density:
  // `(any-pointer: coarse)` catches hybrid hosts whose primary pointer is
  // fine (iPad + trackpad, touchscreen laptops) but where finger taps must
  // still land ≥44px targets. Pen stays on the fine path (never coarse) —
  // taps ride the ordinary click path with no device sniffing.
  const primaryCoarse =
    window.matchMedia?.('(pointer: coarse)').matches ?? false;
  const anyCoarse =
    window.matchMedia?.('(any-pointer: coarse)').matches ?? false;
  const supportsHover = window.matchMedia?.('(hover: hover)').matches ?? false;
  const anyHover = window.matchMedia?.('(any-hover: hover)').matches ?? false;
  return {
    pointer: primaryCoarse ? 'touch' : 'mouse',
    coarse: primaryCoarse || anyCoarse,
    supportsHover,
    anyCoarse,
    anyHover,
  };
}
