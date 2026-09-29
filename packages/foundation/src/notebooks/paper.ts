/**
 * Notebook paper options and page sizes (slice 10, richer paper).
 *
 * Canonical paper customization rides the template base as an optional
 * additive `paper` record (`{ spacing?, paperColor? }`); absent means the
 * template default. Music/staff paper is explicitly deferred — unknown
 * template ids still render blank and round-trip verbatim.
 *
 * Standard sizes and orientation are helpers over the canonical Surface
 * frame: presets resolve to width/height pairs, orientation swaps them.
 * The pager applies them as ordinary frame resizes; no new canonical
 * members are introduced for sizes.
 *
 * Headless and engine-free: no DOM, Canvas, or editor types.
 */

export type NotebookPaperOptions = {
  /**
   * Rule/dot/grid gap override in surface units. Positive finite; when
   * absent the template default applies.
   */
  readonly spacing?: number;
  /** Page fill color as a CSS string; absent means white paper. */
  readonly paperColor?: string;
};

/** Valid spacing range in surface units (presentation guard, not a limit). */
export const PAPER_SPACING_MIN = 8;
export const PAPER_SPACING_MAX = 200;

/** Maximum CSS color string length (mirrors text-length caution). */
export const PAPER_COLOR_MAX_LENGTH = 1000;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * True when `value` is a structurally valid paper options record.
 * Unknown members are allowed (preserved verbatim by the codec); only the
 * known members are validated.
 */
export function isValidPaperOptions(value: unknown): value is NotebookPaperOptions {
  if (value === undefined) return true;
  if (!isPlainRecord(value)) return false;
  if (value.spacing !== undefined) {
    if (typeof value.spacing !== 'number' || !Number.isFinite(value.spacing)) {
      return false;
    }
    if (value.spacing < PAPER_SPACING_MIN || value.spacing > PAPER_SPACING_MAX) {
      return false;
    }
  }
  if (value.paperColor !== undefined) {
    if (typeof value.paperColor !== 'string' || value.paperColor === '') {
      return false;
    }
    if (value.paperColor.length > PAPER_COLOR_MAX_LENGTH) return false;
  }
  return true;
}

/**
 * Clean one paper options record: keep valid known members, preserve
 * unknown members verbatim. Returns `undefined` when nothing survives.
 */
export function normalizePaperOptions(
  value: unknown,
): NotebookPaperOptions | undefined {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === 'spacing' || key === 'paperColor') continue;
    out[key] = entry;
  }
  if (
    typeof value.spacing === 'number' &&
    Number.isFinite(value.spacing) &&
    value.spacing >= PAPER_SPACING_MIN &&
    value.spacing <= PAPER_SPACING_MAX
  ) {
    out.spacing = value.spacing;
  }
  if (
    typeof value.paperColor === 'string' &&
    value.paperColor !== '' &&
    value.paperColor.length <= PAPER_COLOR_MAX_LENGTH
  ) {
    out.paperColor = value.paperColor;
  }
  return Object.keys(out).length === 0 ? undefined : (out as NotebookPaperOptions);
}

/** Resolve the effective spacing for a template default. */
export function resolvePaperSpacing(
  options: NotebookPaperOptions | undefined,
  defaultGap: number,
): number {
  const spacing = options?.spacing;
  if (
    typeof spacing === 'number' &&
    Number.isFinite(spacing) &&
    spacing >= PAPER_SPACING_MIN &&
    spacing <= PAPER_SPACING_MAX
  ) {
    return spacing;
  }
  return defaultGap;
}

/** Resolve the effective paper fill; `undefined` means white paper. */
export function resolvePaperColor(
  options: NotebookPaperOptions | undefined,
): string | undefined {
  const color = options?.paperColor;
  return typeof color === 'string' && color !== '' ? color : undefined;
}

// --- Standard page sizes (surface units; applied as frame resizes) ---

/** Canonical page-size presets (A4 proportions stay the product default). */
export const NOTEBOOK_PAGE_SIZES = {
  'froglight.a4': { width: 1240, height: 1754 },
  'froglight.letter': { width: 1275, height: 1650 },
  'froglight.legal': { width: 1275, height: 2100 },
  'froglight.square': { width: 1240, height: 1240 },
} as const;

export type NotebookPageSizeId = keyof typeof NOTEBOOK_PAGE_SIZES;

export const NOTEBOOK_PAGE_SIZE_IDS = Object.keys(
  NOTEBOOK_PAGE_SIZES,
) as NotebookPageSizeId[];

export type NotebookPageOrientation = 'portrait' | 'landscape';

export interface NotebookPageDimensions {
  readonly width: number;
  readonly height: number;
}

/** Resolve one size preset; `null` for unknown ids (never throws). */
export function pageSizePreset(id: string): NotebookPageDimensions | null {
  const preset = (NOTEBOOK_PAGE_SIZES as Record<string, NotebookPageDimensions>)[id];
  return preset === undefined ? null : { ...preset };
}

/** Orientation of concrete dimensions (square counts as portrait). */
export function orientationOf(size: NotebookPageDimensions): NotebookPageOrientation {
  return size.height >= size.width ? 'portrait' : 'landscape';
}

/**
 * Apply an orientation to concrete dimensions: portrait keeps
 * width ≤ height, landscape keeps width ≥ height (swap when needed).
 */
export function orientSize(
  size: NotebookPageDimensions,
  orientation: NotebookPageOrientation,
): NotebookPageDimensions {
  if (orientation === 'portrait') {
    return size.width <= size.height
      ? { ...size }
      : { width: size.height, height: size.width };
  }
  return size.width >= size.height
    ? { ...size }
    : { width: size.height, height: size.width };
}
