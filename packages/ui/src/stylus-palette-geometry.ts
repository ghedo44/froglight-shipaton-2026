/**
 * Pencil palette geometry.
 *
 * Pure placement: the native anchor is not necessarily the final palette
 * center. Raw Pencil anchors and rendered centers stay separate so edge
 * clamping never corrupts the model.
 */

export interface StylusAnchor {
  readonly x: number;
  readonly y: number;
}

export interface StylusSize {
  readonly width: number;
  readonly height: number;
}

export interface StylusViewport {
  readonly width: number;
  readonly height: number;
}

export interface StylusSafeInsets {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

export interface PlacedStylusPalette {
  readonly left: number;
  readonly top: number;
  readonly center: StylusAnchor;
  /** Vector from the rendered center back to the raw Pencil anchor. */
  readonly marker: StylusAnchor;
}

export const STYLUS_PALETTE_MARGIN = 12;

/**
 *  squeeze crescent: the radial palette never centers on the Pencil
 * tip (that would cover the drawing point). It rests beside the tip with a
 * fixed clearance so the tip stays visible, flipping to the side with room
 * near edges and above the software keyboard.
 */
export const SQUEEZE_TIP_CLEARANCE = 36;

export type SqueezeCrescentOrientation = 'above' | 'below' | 'left' | 'right';

export interface SqueezeCrescentPlacement extends PlacedStylusPalette {
  readonly orientation: SqueezeCrescentOrientation;
  /** Fixed gap kept between the Pencil tip and the palette edge. */
  readonly tipClearance: number;
}

interface UsableRect {
  readonly minLeft: number;
  readonly maxLeft: number;
  readonly minTop: number;
  readonly maxTop: number;
}

function usableRect(
  palette: StylusSize,
  viewport: StylusViewport,
  safeInsets: StylusSafeInsets,
  keyboardInset: number,
): UsableRect {
  const margin = STYLUS_PALETTE_MARGIN;
  const minLeft = safeInsets.left + margin;
  const maxLeft = Math.max(
    minLeft,
    viewport.width - safeInsets.right - margin - palette.width,
  );
  const minTop = safeInsets.top + margin;
  const usableBottom =
    viewport.height - safeInsets.bottom - keyboardInset - margin;
  const maxTop = Math.max(minTop, usableBottom - palette.height);
  return { minLeft, maxLeft, minTop, maxTop };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function finishSqueezePlacement(
  left: number,
  top: number,
  anchor: StylusAnchor,
  palette: StylusSize,
  orientation: SqueezeCrescentOrientation,
): SqueezeCrescentPlacement {
  const roundedLeft = Math.round(left);
  const roundedTop = Math.round(top);
  const center = {
    x: roundedLeft + palette.width / 2,
    y: roundedTop + palette.height / 2,
  };
  const marker = { x: anchor.x - center.x, y: anchor.y - center.y };
  return {
    left: roundedLeft,
    top: roundedTop,
    center,
    marker,
    orientation,
    tipClearance: SQUEEZE_TIP_CLEARANCE,
  };
}

/**
 * Place the squeeze crescent beside the Pencil anchor with tip clearance.
 *
 * Preference is `above` (palette rests above the tip so the drawing point
 * stays visible below it), flipping to `below` near the top edge or the
 * keyboard, then to the roomier side near horizontal edges. Every
 * interactive target stays inside the usable rect (safe areas + visible
 * keyboard region); `marker` preserves the visual relationship back to the
 * raw Pencil point and `orientation` drives the crescent tail/arc.
 */
export function placeSqueezeCrescent(
  anchor: StylusAnchor,
  palette: StylusSize,
  viewport: StylusViewport,
  safeInsets: StylusSafeInsets = { top: 0, bottom: 0, left: 0, right: 0 },
  keyboardInset = 0,
): SqueezeCrescentPlacement {
  const clearance = SQUEEZE_TIP_CLEARANCE;
  const usable = usableRect(palette, viewport, safeInsets, keyboardInset);
  const usableBottom =
    viewport.height - safeInsets.bottom - keyboardInset - STYLUS_PALETTE_MARGIN;
  const usableTop = safeInsets.top + STYLUS_PALETTE_MARGIN;
  const usableLeft = safeInsets.left + STYLUS_PALETTE_MARGIN;
  const usableRight =
    viewport.width - safeInsets.right - STYLUS_PALETTE_MARGIN;

  const spaceAbove = anchor.y - clearance - usableTop;
  const spaceBelow = usableBottom - anchor.y - clearance;
  const spaceLeft = anchor.x - clearance - usableLeft;
  const spaceRight = usableRight - anchor.x - clearance;

  const fitsAbove = spaceAbove >= palette.height;
  const fitsBelow = spaceBelow >= palette.height;
  const fitsLeft = spaceLeft >= palette.width;
  const fitsRight = spaceRight >= palette.width;

  let orientation: SqueezeCrescentOrientation;
  if (fitsAbove) {
    orientation = 'above';
  } else if (fitsBelow) {
    orientation = 'below';
  } else if (fitsRight && !fitsLeft) {
    orientation = 'right';
  } else if (fitsLeft && !fitsRight) {
    orientation = 'left';
  } else if (fitsRight || fitsLeft) {
    orientation = spaceRight >= spaceLeft ? 'right' : 'left';
  } else {
    // Palette is taller than either vertical gap (tiny viewport or tall
    // keyboard): keep the vertical side with more room so the tip gap
    // survives; clamping below keeps every target inside.
    orientation = spaceAbove >= spaceBelow ? 'above' : 'below';
  }

  switch (orientation) {
    case 'above': {
      const left = clamp(
        anchor.x - palette.width / 2,
        usable.minLeft,
        usable.maxLeft,
      );
      return finishSqueezePlacement(
        left,
        clamp(
          anchor.y - clearance - palette.height,
          usable.minTop,
          usable.maxTop,
        ),
        anchor,
        palette,
        orientation,
      );
    }
    case 'below': {
      const left = clamp(
        anchor.x - palette.width / 2,
        usable.minLeft,
        usable.maxLeft,
      );
      return finishSqueezePlacement(
        left,
        clamp(anchor.y + clearance, usable.minTop, usable.maxTop),
        anchor,
        palette,
        orientation,
      );
    }
    case 'left': {
      const top = clamp(
        anchor.y - palette.height / 2,
        usable.minTop,
        usable.maxTop,
      );
      return finishSqueezePlacement(
        clamp(anchor.x - clearance - palette.width, usable.minLeft, usable.maxLeft),
        top,
        anchor,
        palette,
        orientation,
      );
    }
    case 'right': {
      const top = clamp(
        anchor.y - palette.height / 2,
        usable.minTop,
        usable.maxTop,
      );
      return finishSqueezePlacement(
        clamp(anchor.x + clearance, usable.minLeft, usable.maxLeft),
        top,
        anchor,
        palette,
        orientation,
      );
    }
  }
}

/**
 * Place the palette near the Pencil anchor, clamped into the usable
 * viewport (safe areas + visible keyboard region). Every interactive target
 * stays inside the usable rect; the marker preserves the visual
 * relationship to the original Pencil point when the palette shifts.
 */
export function placeStylusPalette(
  anchor: StylusAnchor,
  palette: StylusSize,
  viewport: StylusViewport,
  safeInsets: StylusSafeInsets = { top: 0, bottom: 0, left: 0, right: 0 },
  keyboardInset = 0,
): PlacedStylusPalette {
  const margin = STYLUS_PALETTE_MARGIN;
  const minLeft = safeInsets.left + margin;
  const maxLeft = Math.max(minLeft, viewport.width - safeInsets.right - margin - palette.width);
  const minTop = safeInsets.top + margin;
  const usableBottom = viewport.height - safeInsets.bottom - keyboardInset - margin;
  const maxTop = Math.max(minTop, usableBottom - palette.height);

  // Desired: palette centered on the Pencil anchor.
  const desiredLeft = anchor.x - palette.width / 2;
  const desiredTop = anchor.y - palette.height / 2;
  const left = Math.min(Math.max(desiredLeft, minLeft), maxLeft);
  const top = Math.min(Math.max(desiredTop, minTop), maxTop);
  const center = { x: left + palette.width / 2, y: top + palette.height / 2 };
  const marker = { x: anchor.x - center.x, y: anchor.y - center.y };
  return { left: Math.round(left), top: Math.round(top), center, marker };
}

/** Circular rail centered exactly on the opening Pencil position.
 * Choose the quadrant with room; never translate the center to fit a box.
 */
export function placeCenteredSqueezeArc(
  anchor: StylusAnchor,
  viewport: StylusViewport,
  safe: StylusSafeInsets,
  keyboardInset = 0,
): { left: number; top: number; flipX: boolean; flipY: boolean } {
  const leftRoom = anchor.x - safe.left;
  const rightRoom = viewport.width - safe.right - anchor.x;
  const topRoom = anchor.y - safe.top;
  const bottomRoom = viewport.height - safe.bottom - keyboardInset - anchor.y;
  const flipX = leftRoom < 244 && rightRoom > leftRoom;
  const flipY = topRoom < 244 && bottomRoom > topRoom;
  return {
    left: anchor.x - (flipX ? 32 : 216),
    top: anchor.y - (flipY ? 32 : 216),
    flipX, flipY,
  };
}
