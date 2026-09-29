/**
 * Pane-local geometry for provider-owned Block Page overlays.
 *
 * Anchors arrive in viewport coordinates (DOMRect / ProseMirror coords),
 * while the overlays are absolutely positioned inside the scrolling editor
 * host. Keeping this conversion pure makes slash, resource, table, block
 * action, and source-editor overlays share the same flip/shift/clamp rules.
 */

export interface OverlayRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

export interface BlockpageOverlayGeometry {
  readonly anchor: OverlayRect;
  readonly host: OverlayRect;
  readonly scrollLeft: number;
  readonly scrollTop: number;
  readonly clientWidth: number;
  readonly clientHeight: number;
  readonly overlayWidth: number;
  readonly overlayHeight: number;
  readonly preferred?: 'below' | 'above';
  readonly align?: 'start' | 'center';
  readonly inset?: number;
  readonly gap?: number;
}

export interface BlockpageOverlayPosition {
  readonly left: number;
  readonly top: number;
  readonly placement: 'below' | 'above';
  readonly maxWidth: number;
  readonly maxHeight: number;
}

/**
 * Convert a viewport anchor to the host's scroll-content coordinate space,
 * then flip and clamp it inside the currently visible host scrollport.
 */
export function computeBlockpageOverlayPosition(
  geometry: BlockpageOverlayGeometry,
): BlockpageOverlayPosition {
  const inset = geometry.inset ?? 8;
  const gap = geometry.gap ?? 6;
  const preferred = geometry.preferred ?? 'below';
  const align = geometry.align ?? 'start';
  const maxWidth = Math.max(0, geometry.clientWidth - inset * 2);
  const maxHeight = Math.max(0, geometry.clientHeight - inset * 2);
  const width = Math.min(Math.max(0, geometry.overlayWidth), maxWidth);
  const height = Math.min(Math.max(0, geometry.overlayHeight), maxHeight);

  const minX = geometry.scrollLeft + inset;
  const maxX = geometry.scrollLeft + geometry.clientWidth - inset - width;
  const minY = geometry.scrollTop + inset;
  const maxY = geometry.scrollTop + geometry.clientHeight - inset - height;

  const anchorLeft =
    geometry.anchor.left - geometry.host.left + geometry.scrollLeft;
  const anchorTop =
    geometry.anchor.top - geometry.host.top + geometry.scrollTop;
  const anchorBottom =
    geometry.anchor.bottom - geometry.host.top + geometry.scrollTop;
  const wantedLeft =
    align === 'center'
      ? anchorLeft + geometry.anchor.width / 2 - width / 2
      : anchorLeft;
  const left = maxX < minX ? minX : Math.max(minX, Math.min(wantedLeft, maxX));

  const belowTop = anchorBottom + gap;
  const aboveTop = anchorTop - height - gap;
  const fitsBelow = belowTop <= maxY;
  const fitsAbove = aboveTop >= minY;
  const placement =
    preferred === 'below'
      ? fitsBelow || !fitsAbove
        ? 'below'
        : 'above'
      : fitsAbove || !fitsBelow
        ? 'above'
        : 'below';
  const wantedTop = placement === 'below' ? belowTop : aboveTop;
  const top = maxY < minY ? minY : Math.max(minY, Math.min(wantedTop, maxY));

  return { left, top, placement, maxWidth, maxHeight };
}

/** DOM adapter for the pure geometry above. */
export function positionBlockpageOverlay(
  host: HTMLElement,
  overlay: HTMLElement,
  anchor: OverlayRect,
  options?: {
    readonly preferred?: 'below' | 'above';
    readonly align?: 'start' | 'center';
    readonly inset?: number;
    readonly gap?: number;
    readonly maxHeight?: number;
  },
): BlockpageOverlayPosition {
  const requestedInset = options?.inset ?? 8;
  // Leave a small paint allowance for fractional host edges and menu chrome.
  // Without it, a full-height listbox can clip its bottom border by 2–3px
  // even though its content-box geometry is mathematically inside the host.
  const paintAllowance = 4;
  const inset = requestedInset + paintAllowance;
  overlay.style.maxWidth = `${Math.max(0, host.clientWidth - inset * 2)}px`;
  overlay.style.maxHeight = `${Math.max(0, Math.min(host.clientHeight - inset * 2, options?.maxHeight ?? Infinity))}px`;
  const hostRect = host.getBoundingClientRect();
  const overlayRect = overlay.getBoundingClientRect();
  const position = computeBlockpageOverlayPosition({
    anchor,
    host: {
      left: hostRect.left,
      top: hostRect.top,
      right: hostRect.right,
      bottom: hostRect.bottom,
      width: hostRect.width,
      height: hostRect.height,
    },
    scrollLeft: host.scrollLeft,
    scrollTop: host.scrollTop,
    clientWidth: host.clientWidth,
    clientHeight: host.clientHeight,
    // CSS entry animations transform the painted rect. Position from the
    // stable layout box so a menu measured at scale(.98) cannot grow a few
    // pixels outside the host when the animation settles.
    overlayWidth: overlay.offsetWidth || overlayRect.width,
    overlayHeight: overlay.offsetHeight || overlayRect.height,
    ...(options?.preferred !== undefined
      ? { preferred: options.preferred }
      : {}),
    ...(options?.align !== undefined ? { align: options.align } : {}),
    inset,
    ...(options?.gap !== undefined ? { gap: options.gap } : {}),
  });
  overlay.style.left = `${Math.round(position.left)}px`;
  overlay.style.top = `${Math.round(position.top)}px`;
  overlay.dataset.placement = position.placement;
  return position;
}
