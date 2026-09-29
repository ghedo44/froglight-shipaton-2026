/**
 * Shared surface toolbar builder (problem 6, spec #52).
 *
 * Ink, Notebook, and Whiteboard providers expose the same Surface activity
 * (draw tools, stroke style, eraser radius, image insertion, zoom cluster,
 * fit) through three separately maintained Document Tools snapshots. This
 * module owns that shareable subset behind the provider-neutral Document
 * Tools seam: one place for control shapes and command routing, with
 * per-family ids, labels, icons, groups, presets, and ranges declared as
 * configuration at each call site.
 *
 * Family-specific controls stay provider-local: Notebook pager and PDF-page
 * controls, Ink bounded-frame sizing, and PNG export variants never enter
 * this builder. No DOM, Canvas, or engine types cross it — adapters bridge
 * their engine handle to the narrow `SurfaceToolbarHost` interface.
 */

import type { DocumentToolControl, SurfaceToolRole } from './tools.js';
import { SURFACE_TOOL_IDS } from '../surfaces/tools.js';
import type { AlignEdge, DistributeAxis } from '../surfaces/controller.js';
import type { ReorderDirection } from '../surfaces/tools.js';
import type {
  SelectionContextSnapshot,
  SelectionStyle,
} from '../surfaces/tools.js';
import { DEFAULT_ERASER_MODE } from '../surfaces/ink/eraser-geometry.js';
import type { EraserMode } from '../surfaces/ink/eraser-geometry.js';
import { ERASER_SEMANTIC_ROLE_BY_MODE } from '../surfaces/ink/presets.js';
import type {
  InkPresetToolId,
  InkSlotFamily,
  InkToolPreset,
} from '../surfaces/ink/presets.js';

/** Shared zoom factor for zoom-in/out across Surface families. */
export const SURFACE_TOOLBAR_ZOOM_STEP = 1.2;

/**
 * Shared Surface style palette: the single pen-color source for
 * Ink, Notebook, and Whiteboard toolbar snapshots, settings popovers, and
 * style controls. Providers alias (not copy) these so the three families
 * cannot drift into per-document palettes.
 */
export const SURFACE_SHARED_SWATCHES = [
  '#37352f',
  '#7c6cf0',
  '#c4554d',
  '#448361',
  '#a08430',
] as const;

/** Shared fast stroke widths backing every Surface family's style controls. */
export const SURFACE_SHARED_WIDTHS = [2, 3.5, 6] as const;

/**
 * Per-family shelf slot defaults.
 *
 * The pen family reuses the shared fast widths verbatim (the provider
 * `widths` option stays the single source for popover options); the
 * highlighter triple centers on the tuned `HIGHLIGHTER_BRUSH` base size
 * (14pt in `surfaces/ink/brush.ts`) because a 2pt marker is nearly
 * invisible. Reversible product detail: user edits persist per family in
 * the toolbar customization envelope and override these.
 */
export const SURFACE_PEN_SLOT_WIDTHS = [2, 3.5, 6] as const;
export const SURFACE_HIGHLIGHTER_SLOT_WIDTHS = [8, 14, 20] as const;

/**
 * Default shelf color slots per family. Pen slots take the
 * first three shared swatches; highlighter slots lead with the tuned
 * `HIGHLIGHTER_BRUSH` marker yellow (`#ffd54f`) and share the next two
 * hues so cross-family switching stays recognizable. Independence is
 * storage-level (separate per-family maps) — defaults may overlap.
 */
export const SURFACE_PEN_SLOT_SWATCHES = [
  '#37352f',
  '#7c6cf0',
  '#c4554d',
] as const;
export const SURFACE_HIGHLIGHTER_SLOT_SWATCHES = [
  '#ffd54f',
  '#7c6cf0',
  '#c4554d',
] as const;

/**
 * Translucency for highlighter slot glyphs (icons). Matches
 * the tuned `HIGHLIGHTER_BRUSH` opacity so the shelf dot reads as a
 * marker, not as the pen's opaque dot. Presentation only.
 */
export const SURFACE_HIGHLIGHTER_GLYPH_OPACITY = 0.35;

/**
 * Default size-slot triple for one slot family. Pen-family tools
 * share the pen triple; the highlighter resolves its own.
 * Returns a fresh array per call; callers must not mutate the constants.
 */
export function surfaceSlotWidthsForFamily(
  family: InkSlotFamily,
): readonly number[] {
  return family === 'highlighter'
    ? [...SURFACE_HIGHLIGHTER_SLOT_WIDTHS]
    : [...SURFACE_PEN_SLOT_WIDTHS];
}

/**
 * Default color-slot triple for one slot family.
 * Returns a fresh array per call.
 */
export function surfaceSlotSwatchesForFamily(
  family: InkSlotFamily,
): readonly string[] {
  return family === 'highlighter'
    ? [...SURFACE_HIGHLIGHTER_SLOT_SWATCHES]
    : [...SURFACE_PEN_SLOT_SWATCHES];
}

/** Shared eraser-size range backing every Surface family's eraser controls. */
export const SURFACE_SHARED_ERASER_RANGE = {
  min: 2,
  max: 40,
  step: 1,
} as const;

/**
 * Canonical Surface draw slot: one entry per shared Write/Erase/Select/
 * Shapes/Insert grammar tool. Providers map their engine tool ids onto
 * these slots; presentation (label, icon, group, coarse role, semantic
 * role) and ordering come from the shared table below, never from
 * per-family literals.
 */
export type SharedSurfaceDrawSlot =
  | 'pen'
  | 'fountain'
  | 'brush'
  | 'pencil'
  | 'highlighter'
  | 'eraser'
  | 'select'
  | 'lasso'
  | 'line'
  | 'triangle'
  | 'diamond'
  | 'rectangle'
  | 'ellipse'
  | 'text';

/** Engine tool id per canonical slot (the only per-family input). */
export type SharedSurfaceDrawDialect = Record<
  Exclude<SharedSurfaceDrawSlot, 'triangle' | 'diamond'>,
  string
> &
  Partial<Record<'triangle' | 'diamond', string>>;

/**
 * Control-id key per canonical slot. Ink/Notebook omit this (keys default
 * to the full engine tool id, their established dialect); Whiteboard
 * passes its short keys (`pen`, `line`, …) so its provider-owned control
 * ids — referenced by placement predicates and existing hosts — stay
 * stable while sharing all presentation with the family.
 */
export type SharedSurfaceDrawKeys = Partial<
  Record<SharedSurfaceDrawSlot, string>
>;

interface SharedSurfaceDrawPresentation {
  readonly label: string;
  readonly icon: string;
  readonly toolRole: SurfaceToolRole;
  readonly semanticRole: string;
}

/**
 * Canonical Surface presentation + ordering. Order
 * follows the shared composition categories (Write pens, Erase, Select
 * pair, Shapes trio, Insert text) so snapshot order, shelf order, and
 * composition order agree across Ink, Notebook, and Whiteboard.
 *
 * Icons use only approved registry names shared with the UI icon set:
 * the pen family carries one distinct glyph per tool — Ball Pen keeps
 * `pen`, Fountain Pen uses `fountain` (wide nib + slit), Brush Pen
 * uses `brush` (curved bristle), Pencil uses `pencil` (wood cone +
 * ferrule) — so equivalent tools resolve to the same icon everywhere
 * while staying visually distinct from each other.
 */
const SHARED_SURFACE_DRAW_TABLE: Record<
  SharedSurfaceDrawSlot,
  SharedSurfaceDrawPresentation
> = {
  pen: {
    label: 'Pen',
    icon: 'pen',
    toolRole: 'pen',
    semanticRole: 'surface.pen.ball',
  },
  fountain: {
    label: 'Fountain Pen',
    icon: 'fountain',
    toolRole: 'pen',
    semanticRole: 'surface.pen.fountain',
  },
  brush: {
    label: 'Brush Pen',
    icon: 'brush',
    toolRole: 'pen',
    semanticRole: 'surface.pen.brush',
  },
  pencil: {
    label: 'Pencil',
    icon: 'pencil',
    toolRole: 'pen',
    semanticRole: 'surface.pencil',
  },
  highlighter: {
    label: 'Highlighter',
    icon: 'highlighter',
    toolRole: 'highlighter',
    semanticRole: 'surface.highlighter',
  },
  eraser: {
    label: 'Eraser',
    icon: 'eraser',
    toolRole: 'eraser',
    semanticRole: 'surface.erase',
  },
  select: {
    label: 'Select',
    icon: 'cursor',
    toolRole: 'select',
    semanticRole: 'surface.select',
  },
  lasso: {
    label: 'Lasso',
    icon: 'lasso',
    toolRole: 'lasso',
    semanticRole: 'surface.lasso',
  },
  line: {
    label: 'Line',
    icon: 'arrow-line',
    toolRole: 'shape',
    semanticRole: 'surface.shape.line',
  },
  rectangle: {
    label: 'Rectangle',
    icon: 'rect',
    toolRole: 'shape',
    semanticRole: 'surface.shape.rectangle',
  },
  ellipse: {
    label: 'Ellipse',
    icon: 'ellipse',
    toolRole: 'shape',
    semanticRole: 'surface.shape.ellipse',
  },
  triangle: {
    label: 'Triangle',
    icon: 'triangle',
    toolRole: 'shape',
    semanticRole: 'surface.shape.triangle',
  },
  diamond: {
    label: 'Diamond',
    icon: 'diamond',
    toolRole: 'shape',
    semanticRole: 'surface.shape.diamond',
  },
  text: {
    label: 'Text',
    icon: 'type',
    toolRole: 'text',
    semanticRole: 'surface.insert.text',
  },
};

/** Canonical slot order: Write pens, Erase, Select pair, Shapes, Text. */
const SHARED_SURFACE_DRAW_ORDER: readonly SharedSurfaceDrawSlot[] = [
  'pen',
  'fountain',
  'brush',
  'pencil',
  'highlighter',
  'eraser',
  'select',
  'lasso',
  'line',
  'rectangle',
  'ellipse',
  'triangle',
  'diamond',
  'text',
];

/**
 * Build the twelve shared Surface draw-tool entries from one family's
 * engine tool ids. Presentation and ordering are canonical; only `key`
 * (control-id suffix) and `toolId` vary by family dialect.
 */
export function createSharedSurfaceDrawTools(
  toolIds: SharedSurfaceDrawDialect,
  keys?: SharedSurfaceDrawKeys,
): SurfaceToolbarDrawTool[] {
  return SHARED_SURFACE_DRAW_ORDER.flatMap((slot) => {
    const toolId = toolIds[slot];
    if (toolId === undefined) return [];
    const presentation = SHARED_SURFACE_DRAW_TABLE[slot];
    return {
      key: keys?.[slot] ?? toolId,
      toolId,
      label: presentation.label,
      icon: presentation.icon,
      group: 'draw',
      toolRole: presentation.toolRole,
      semanticRole: presentation.semanticRole,
    };
  });
}

/**
 * Eraser mode order: Stroke removes whole strokes; Precision erases
 * only the swept footprint.
 */
export const SURFACE_ERASER_MODES: readonly EraserMode[] = [
  'stroke',
  'precision',
] as const;

interface SurfaceEraserPresentation {
  readonly label: string;
  readonly icon: string;
}

/**
 * Per-mode presentation for the eraser tools. The
 * engine stays one eraser (`SURFACE_TOOL_IDS.eraser`); the secondary
 * toolbar exposes two tools with a fixed preset mode each. Labels and
 * icons are distinct per tool (the Stroke tool keeps the legacy `eraser`
 * glyph); the coarse `toolRole` stays `eraser` for all three and the
 * semantic roles come from the single `ERASER_SEMANTIC_ROLE_BY_MODE`
 * source so preset migration and toolbar identity cannot drift apart.
 */
const SURFACE_ERASER_TABLE: Record<EraserMode, SurfaceEraserPresentation> = {
  stroke: { label: 'Stroke Eraser', icon: 'eraser' },
  precision: { label: 'Precision Eraser', icon: 'eraser-precision' },
};

/**
 * Build the two shared eraser tools from one family's engine eraser id
 * Every entry carries the SAME engine `toolId` (one
 * shared eraser engine with a fixed `eraserMode`: executing an entry
 * fixes the eraser preset mode and activates the engine. Only `key`
 * (control-id suffix) varies by family dialect — Ink/Notebook default to
 * `<engine-id>.<mode>`, Whiteboard passes short keys.
 *
 * Settled exclusivity: the three entries share one engine id, so the
 * settled-tool comparison (`settledActiveToolId`) keeps treating the
 * erasers as one exclusive settled tool; the preset mode pins exactly
 * one of the two active within it.
 */
export function createSharedSurfaceEraserTools(
  eraserToolId: string,
  keys?: Partial<Record<EraserMode, string>>,
): SurfaceToolbarDrawTool[] {
  return SURFACE_ERASER_MODES.map((mode) => {
    const presentation = SURFACE_ERASER_TABLE[mode];
    return {
      key: keys?.[mode] ?? `${eraserToolId}.${mode}`,
      toolId: eraserToolId,
      label: presentation.label,
      icon: presentation.icon,
      group: 'draw',
      toolRole: 'eraser' as const,
      semanticRole: ERASER_SEMANTIC_ROLE_BY_MODE[mode],
      eraserMode: mode,
    };
  });
}

/**
 * Minimal engine state the builder reads and writes. Satisfied structurally
 * by the ink/whiteboard surface handle; Notebook adapters map `fitToView`
 * to the pager zoom reset and may wrap `setTool` for PDF source-select mode.
 */
export interface SurfaceToolbarHost {
  activeToolId(): string;
  setTool(toolId: string): void;
  /**
   * Settled exclusive tool for toolbar reconciliation.
   *
   * When present, `buildSurfaceDrawControls` and the contextual style
   * preset source derive `active` from this instead of `activeToolId()`:
   * temporary entries (`enterTemporaryTool` — stylus double-tap, barrel
   * hold, eraser-end) never move the settled tool, so the snapshot keeps
   * reporting the pre-hold tool while temp is held and sticky per-group
   * memory ignores temp by construction. Manual selection (`setTool`)
   * always moves it, so Write/Erase flips stay honest. Hosts without a
   * temporary seam (Notebook pager) omit it; readers fall back to
   * `activeToolId()`, which is settled by construction there.
   */
  settledActiveToolId?(): string;
  penColor(): string;
  setPenColor(color: string): void;
  penWidth(): number;
  setPenWidth(width: number): void;
  /** Optional per-tool preset seam. When present, contextual style controls
   * edit the active brush (for example a highlighter) instead of always
   * mutating the pen default.
   *
   * Live color/size are family-scoped (pen vs
   * highlighter) — reads report the settled family's converged pair and
   * writes fan out inside the family — while opacity, straight-line hold,
   * and brush tuning stay per-tool. Hosts delegate to `InkPresetStore`,
   * which owns that contract; this builder only routes via the settled
   * active tool below. */
  toolPreset?(tool: InkPresetToolId): InkToolPreset;
  setToolPreset?(tool: InkPresetToolId, patch: Partial<InkToolPreset>): void;
  eraserRadius(): number;
  setEraserRadius(radius: number): void;
  /**
   * Current eraser preset mode for the two toolbar erasers.
   *
   * Read live from the eraser preset: `buildSurfaceDrawControls` pins
   * exactly one of the two fixed-mode eraser entries active against it,
   * and `executeSurfaceToolbarControl` fixes it before activating the
   * single eraser engine. Hosts without the seam omit it; readers treat
   * absence as `DEFAULT_ERASER_MODE` (`stroke`), so legacy single-eraser
   * hosts keep the Stroke tool active.
   */
  eraserMode?(): EraserMode;
  /** Fix the eraser preset mode (best-effort; engine activation follows). */
  setEraserMode?(mode: EraserMode): void;
  zoomFactor(): number;
  setZoomFactor(zoom: number): void;
  canInsertImage(): boolean;
  chooseImage(): void;
  fitToView(): void;
  /**
   * Selection ids for arrange-control enablement (slice 9). Hosts
   * without selection verbs omit the arrange group entirely.
   */
  selectionIds?(): readonly string[];
  alignSelection?(edge: AlignEdge): string[];
  distributeSelection?(axis: DistributeAxis): string[];
  reorderSelection?(where: ReorderDirection): string[];
  setLocked?(ids: readonly string[], locked: boolean): string[];
  groupSelection?(): string[];
  ungroupSelection?(): string[];
  duplicateSelection?(): string[];
  deleteSelection?(): string[];
  connectSelected?(): string | null;
  selectionContext?(): SelectionContextSnapshot | null;
  moveSelectionBy?(delta: { x: number; y: number }): readonly string[];
  scaleSelection?(factor: number): readonly string[];
  rotateSelection?(deltaRadians: number): readonly string[];
  setSelectionStyle?(style: SelectionStyle): string[];
}

/** One draw tool entry: `key` is the control-id suffix, `toolId` the engine id. */
export interface SurfaceToolbarDrawTool {
  readonly key: string;
  readonly toolId: string;
  readonly label: string;
  readonly shortLabel?: string;
  readonly icon: string;
  readonly group?: string;
  /**
   * Fixed eraser preset mode for the eraser entries.
   * Present only on the two entries from
   * `createSharedSurfaceEraserTools` (same engine `toolId`, one mode
   * each); absent everywhere else. Execution fixes this mode before
   * activating the engine; `active` additionally requires the live
   * preset mode to match, so exactly one eraser reads active.
   */
  readonly eraserMode?: EraserMode;
  /**
   * Declared coarse role. Call sites declare this for family-specific tools
   * (shapes, text, cards); the eight core `froglight.ink.*` tools default
   * from their engine id. Unknown ids carry no role rather than guessing.
   */
  readonly toolRole?: SurfaceToolRole;
  /** Exact provider-neutral toolbar identity for family-specific tools. */
  readonly semanticRole?: string;
}

export interface SurfaceToolbarDrawOptions {
  readonly prefix: string;
  readonly tools: readonly SurfaceToolbarDrawTool[];
  readonly isActive?: (toolId: string) => boolean;
}

export interface SurfaceToolbarStyleOptions {
  readonly prefix: string;
  readonly swatches: readonly string[];
  readonly widths: readonly number[];
  readonly colorLabel?: string;
  readonly widthLabel?: string;
  readonly eraserLabel?: string;
  readonly eraserMin?: number;
  readonly eraserMax?: number;
  readonly eraserStep?: number;
}

export interface SurfaceToolbarZoomOptions {
  readonly prefix: string;
  readonly min?: number;
  readonly max?: number;
  readonly step?: number;
  readonly sliderStep?: number;
  readonly label?: string;
  readonly sliderLabel?: string;
  readonly resetLabel?: (zoomPct: number) => string;
  readonly disabled?: boolean;
}

export interface SurfaceToolbarImageOptions {
  readonly prefix: string;
  readonly label?: string;
  readonly shortLabel?: string;
  readonly icon?: string;
}

export interface SurfaceToolbarFitOptions {
  readonly prefix: string;
  readonly label?: string;
  readonly shortLabel?: string;
}

export interface SurfaceToolbarExecuteOptions {
  readonly prefix: string;
  readonly tools: readonly SurfaceToolbarDrawTool[];
  readonly arrangeIdPrefix?: string;
}

export function buildSurfaceDrawControls(
  host: SurfaceToolbarHost,
  options: SurfaceToolbarDrawOptions,
): DocumentToolControl[] {
  // Settled-first: temp entries never drive exclusive-tool
  // reconciliation. An explicit `isActive` override (Notebook PDF
  // source-select policy) still wins when provided.
  const settledActiveToolId = settledToolIdOf(host);
  const baseIsActive =
    options.isActive ?? ((toolId: string) => settledActiveToolId === toolId);
  // Eraser mode pin: the two fixed-mode entries share one
  // engine id (one exclusive settled tool), so the live preset mode picks
  // exactly one of them active. The explicit override still gates when
  // provided (combined, never replaced). Hosts without the mode seam read
  // as the default mode, keeping the Stroke tool active.
  const activeEraserMode = host.eraserMode?.() ?? DEFAULT_ERASER_MODE;
  const isActive = (tool: SurfaceToolbarDrawTool): boolean =>
    baseIsActive(tool.toolId) &&
    (tool.eraserMode === undefined || tool.eraserMode === activeEraserMode);
  return options.tools.map((tool) => {
    const toolRole = tool.toolRole ?? coreSurfaceToolRole(tool.toolId);
    return {
      kind: 'button',
      id: `${options.prefix}.tool.${tool.key}`,
      group: tool.group ?? 'draw',
      label: tool.label,
      shortLabel: tool.shortLabel ?? tool.label,
      icon: tool.icon,
      active: isActive(tool),
      role: 'surface-tool' as const,
      activationRole: 'tool' as const,
      toolId: tool.toolId,
      ...((tool.semanticRole ?? surfaceSemanticRole(tool.toolId) !== undefined)
        ? {
            semanticRole: tool.semanticRole ?? surfaceSemanticRole(tool.toolId),
          }
        : {}),
      ...(toolRole !== undefined ? { toolRole } : {}),
    };
  });
}

function surfaceSemanticRole(toolId: string): string | undefined {
  switch (toolId) {
    case SURFACE_TOOL_IDS.pen:
      return 'surface.pen.ball';
    case SURFACE_TOOL_IDS.fountain:
      return 'surface.pen.fountain';
    case SURFACE_TOOL_IDS.brush:
      return 'surface.pen.brush';
    case SURFACE_TOOL_IDS.pencil:
      return 'surface.pencil';
    case SURFACE_TOOL_IDS.highlighter:
      return 'surface.highlighter';
    case SURFACE_TOOL_IDS.eraser:
      return 'surface.erase';
    case SURFACE_TOOL_IDS.lasso:
      return 'surface.lasso';
    case SURFACE_TOOL_IDS.select:
      return 'surface.select';
  }
  return undefined;
}

/**
 * Coarse role for the eight core engine tool ids, matched exactly.
 * The pen family (ball, fountain, brush, pencil) shares `pen` — no
 * `pencil`/`brush` coarse role exists — so squeeze ordering and
 * accessory routing agree across Ink, Notebook, and Whiteboard without
 * per-call-site tables. Icons stay distinct per tool (pen/fountain/
 * brush/pencil/highlighter); only the coarse role is shared. Family-
 * specific tools (shapes, text, cards) must declare their role at the
 * call site; unknown ids carry no role rather than guessing wrong.
 */
function coreSurfaceToolRole(toolId: string): SurfaceToolRole | undefined {
  switch (toolId) {
    case SURFACE_TOOL_IDS.select:
      return 'select';
    case SURFACE_TOOL_IDS.pen:
    case SURFACE_TOOL_IDS.fountain:
    case SURFACE_TOOL_IDS.brush:
    case SURFACE_TOOL_IDS.pencil:
      return 'pen';
    case SURFACE_TOOL_IDS.highlighter:
      return 'highlighter';
    case SURFACE_TOOL_IDS.eraser:
      return 'eraser';
    case SURFACE_TOOL_IDS.lasso:
      return 'lasso';
    default:
      return undefined;
  }
}

export function buildSurfaceStyleControls(
  host: SurfaceToolbarHost,
  options: SurfaceToolbarStyleOptions,
): DocumentToolControl[] {
  // Settled-first like the draw `active` above: style
  // values follow the settled tool, never a held temporary entry. The
  // The preset itself is family-shared: every pen-family tool
  // reports the same converged color/size, so switching inside the
  // family keeps these values; the highlighter reports its own pair.
  const activeTool = activePresetTool(host);
  const preset =
    activeTool !== null ? host.toolPreset?.(activeTool) : undefined;
  const activeBaseColor = preset?.color;
  const activeBaseWidth = preset?.size;
  return [
    {
      kind: 'color',
      id: `${options.prefix}.color`,
      group: 'style',
      label: options.colorLabel ?? 'Stroke color',
      value: activeBaseColor ?? host.penColor(),
      options: options.swatches,
      semanticRole: 'surface.style.color',
    },
    {
      kind: 'choice',
      id: `${options.prefix}.width`,
      group: 'style',
      label: options.widthLabel ?? 'Stroke width',
      value: String(activeBaseWidth ?? host.penWidth()),
      options: options.widths.map((width) => ({
        value: String(width),
        label: `${width} px`,
      })),
      semanticRole: 'surface.style.width',
    },
    ...(host.eraserMode?.() === 'precision'
      ? [
          {
            kind: 'range' as const,
            id: `${options.prefix}.eraser-radius`,
            group: 'style',
            label: options.eraserLabel ?? 'Eraser size',
            value: host.eraserRadius(),
            min: options.eraserMin ?? 2,
            max: options.eraserMax ?? 40,
            step: options.eraserStep ?? 1,
            semanticRole: 'surface.erase.size',
          },
        ]
      : []),
  ];
}

export function buildSurfaceZoomControls(
  host: SurfaceToolbarHost,
  options: SurfaceToolbarZoomOptions,
): DocumentToolControl[] {
  const zoom = Math.round(host.zoomFactor() * 100);
  const min = options.min ?? 25;
  const max = options.max ?? 800;
  const label = options.label ?? 'Zoom';
  const sliderLabel = options.sliderLabel ?? 'Zoom slider';
  const resetLabel =
    options.resetLabel?.(zoom) ?? `Zoom ${zoom}%, activate to reset to 100%`;
  const disabled = options.disabled === true ? { disabled: true as const } : {};
  return [
    {
      kind: 'button',
      id: `${options.prefix}.zoom-out`,
      group: 'view',
      label: 'Zoom out',
      shortLabel: '−',
      icon: 'minus',
      ...disabled,
    },
    {
      kind: 'button',
      id: `${options.prefix}.zoom-reset`,
      group: 'view',
      label: resetLabel,
      shortLabel: `${zoom}%`,
      ...disabled,
    },
    {
      kind: 'number',
      id: `${options.prefix}.zoom`,
      group: 'view',
      label,
      value: zoom,
      min,
      max,
      step: options.step ?? 1,
      suffix: '%',
      ...disabled,
    },
    {
      kind: 'range',
      id: `${options.prefix}.zoom-slider`,
      group: 'view',
      label: sliderLabel,
      value: zoom,
      min,
      max,
      step: options.sliderStep ?? 5,
      ...disabled,
    },
    {
      kind: 'button',
      id: `${options.prefix}.zoom-in`,
      group: 'view',
      label: 'Zoom in',
      shortLabel: '+',
      icon: 'plus',
      ...disabled,
    },
  ];
}

export function buildSurfaceImageControl(
  host: SurfaceToolbarHost,
  options: SurfaceToolbarImageOptions,
): DocumentToolControl {
  return {
    kind: 'button',
    id: `${options.prefix}.image`,
    group: 'insert',
    label: options.label ?? 'Insert image',
    shortLabel: options.shortLabel ?? 'Image',
    ...(options.icon !== undefined ? { icon: options.icon } : {}),
    disabled: !host.canInsertImage(),
    semanticRole: 'surface.insert.image',
  };
}

export function buildSurfaceFitControl(
  options: SurfaceToolbarFitOptions,
): DocumentToolControl {
  return {
    kind: 'button',
    id: `${options.prefix}.fit`,
    group: 'view',
    label: options.label ?? 'Fit',
    shortLabel: options.shortLabel ?? 'Fit',
    semanticRole: 'surface.view.fit',
  };
}

export interface SurfaceToolbarArrangeOptions {
  readonly prefix: string;
  readonly group?: string;
  readonly idPrefix?: string;
  readonly swatches?: readonly string[];
  readonly widths?: readonly number[];
}

/**
 * Selection arrangement controls (slice 9, whiteboard): align,
 * distribute, paint order, lock/unlock, group/ungroup, duplicate, and
 * quick-connect. Hosts without the optional arrange verbs get no
 * controls — Notebook gains them when its pager wires selection verbs.
 */
export function buildSurfaceArrangeControls(
  host: SurfaceToolbarHost,
  options: SurfaceToolbarArrangeOptions,
): DocumentToolControl[] {
  const group = options.group ?? 'arrange';
  const controlId = (name: string): string =>
    `${options.prefix}.${options.idPrefix ?? ''}${name}`;
  const selectionStyleId = (name: string): string =>
    `${options.prefix}.selection.${name}`;
  const count = host.selectionIds?.().length ?? 0;
  const controls: DocumentToolControl[] = [];
  const selection = host.selectionContext?.() ?? null;
  if (selection !== null && host.moveSelectionBy !== undefined) {
    for (const axis of ['x', 'y'] as const) {
      controls.push({
        kind: 'number',
        id: selectionStyleId(`position-${axis}`),
        semanticRole: `surface.selection.${axis}`,
        group,
        label: axis.toUpperCase(),
        value: Math.round(selection.bounds[axis] * 10) / 10,
        min: -20_000,
        max: 20_000,
        step: 0.1,
        suffix: 'px',
      });
    }
  }
  if (selection !== null && host.scaleSelection !== undefined) {
    for (const dimension of ['width', 'height'] as const) {
      controls.push({
        kind: 'number',
        id: selectionStyleId(`bounds-${dimension}`),
        semanticRole: `surface.selection.${dimension}`,
        group,
        label:
          dimension === 'width'
            ? 'Width (proportional)'
            : 'Height (proportional)',
        value: Math.round(selection.bounds[dimension] * 10) / 10,
        min: 0.1,
        max: 20_000,
        step: 0.1,
        suffix: 'px',
      });
    }
  }
  if (selection?.rotation !== undefined && host.rotateSelection !== undefined) {
    controls.push({
      kind: 'number',
      id: selectionStyleId('rotation'),
      semanticRole: 'surface.selection.rotation',
      group,
      label: 'Rotation',
      value: Math.round((selection.rotation * 1800) / Math.PI) / 10,
      min: -360,
      max: 360,
      step: 1,
      suffix: '°',
    });
  }
  if (selection !== null && host.setSelectionStyle !== undefined) {
    if (selection.card !== undefined) {
      controls.push({
        kind: 'color',
        id: selectionStyleId('fill'),
        group,
        label: 'Card background',
        semanticRole: 'surface.selection.fill',
        value: selection.card.fill,
        options: options.swatches ?? ['#ffffff', '#fff1b8', '#dcefe3'],
        slotFamily: 'pen',
      });
      controls.push({
        kind: 'number',
        id: selectionStyleId('text-size'),
        group,
        label: 'Card font size',
        semanticRole: 'surface.selection.text-size',
        value: selection.card.size,
        min: 8,
        max: 128,
        step: 1,
      });
    }
    if (selection.connector !== undefined) {
      controls.push({
        kind: 'choice',
        id: selectionStyleId('line-path'),
        group,
        label: 'Connector path',
        semanticRole: 'surface.selection.line-path',
        value: selection.connector.path,
        options: [
          { value: 'straight', label: 'Straight' },
          { value: 'orthogonal', label: 'Elbow' },
          { value: 'curved', label: 'Curved' },
        ],
      });
      controls.push({
        kind: 'choice',
        id: selectionStyleId('line-arrows'),
        group,
        label: 'Arrowheads',
        semanticRole: 'surface.selection.line-arrows',
        value: selection.connector.arrows,
        options: [
          { value: 'none', label: 'None' },
          { value: 'start', label: 'Start' },
          { value: 'end', label: 'End' },
          { value: 'both', label: 'Both' },
        ],
      });
    }
    if (selection.cornerRadius !== undefined) {
      controls.push({
        kind: 'number',
        id: selectionStyleId('radius'),
        group,
        label: 'Corner radius',
        semanticRole: 'surface.selection.radius',
        value: selection.cornerRadius,
        min: 0,
        max: 200,
        step: 1,
        suffix: 'px',
        disabled: selection.canRoundCorners === false,
      });
    }
    if (selection.shape !== undefined) {
      controls.push({
        kind: 'choice',
        id: selectionStyleId('shape'),
        group,
        label: 'Shape',
        semanticRole: 'surface.selection.shape',
        value: selection.shape,
        options: ['rectangle', 'triangle', 'diamond'].map((value) => ({
          value,
          label: value[0]!.toUpperCase() + value.slice(1),
        })),
      });
    }

    if (selection.shapeAppearance !== undefined) {
      controls.push({
        kind: 'choice',
        id: selectionStyleId('shape-appearance'),
        group,
        semanticRole: 'surface.selection.shape-appearance',
        label: 'Shape appearance',
        icon: 'shapes',
        value:
          selection.shapeAppearance === 'mixed'
            ? 'fill'
            : selection.shapeAppearance,
        options: [
          { value: 'fill', label: 'Filled' },
          { value: 'outline', label: 'Border only' },
        ],
      });
    }
    if (options.swatches !== undefined && selection.color !== undefined) {
      controls.push({
        kind: 'color',
        id: selectionStyleId('color'),
        semanticRole: 'surface.selection.color',
        slotFamily: selection.kinds.every((kind) => kind === 'highlighter')
          ? 'highlighter'
          : 'pen',
        group,
        label:
          selection.card !== undefined
            ? 'Card text color'
            : selection.connector !== undefined ||
                selection.shapeAppearance === 'outline'
              ? 'Stroke color'
              : selection.kinds.includes('shapes')
                ? 'Fill color'
                : 'Selection color',
        value: selection.color,
        options: options.swatches,
      });
    }
    if (options.widths !== undefined && selection.width !== undefined) {
      controls.push({
        kind: 'choice',
        id: selectionStyleId('width'),
        semanticRole: 'surface.selection.stroke-width',
        slotFamily: selection.kinds.every((kind) => kind === 'highlighter')
          ? 'highlighter'
          : 'pen',
        group,
        label: 'Selection width',
        icon: 'sliders',
        value: String(selection.width),
        options: options.widths.map((width) => ({
          value: String(width),
          label: `${width} px`,
        })),
      });
    }
    if (selection.opacity !== undefined) {
      controls.push({
        kind: 'range',
        id: selectionStyleId('opacity'),
        semanticRole: 'surface.selection.opacity',
        group,
        label: 'Selection opacity',
        value: selection.opacity,
        min: 0.1,
        max: 1,
        step: 0.1,
      });
    }
  }
  if (host.alignSelection !== undefined) {
    controls.push({
      kind: 'choice',
      id: controlId('align'),
      group,
      label: 'Align selection',
      icon: 'align',
      value: '',
      options: [
        { value: 'left', label: 'Left' },
        { value: 'centerX', label: 'Center' },
        { value: 'right', label: 'Right' },
        { value: 'top', label: 'Top' },
        { value: 'centerY', label: 'Middle' },
        { value: 'bottom', label: 'Bottom' },
      ],
      disabled: count < 2,
    });
  }
  if (host.distributeSelection !== undefined) {
    controls.push({
      kind: 'choice',
      id: controlId('distribute'),
      group,
      label: 'Distribute',
      icon: 'distribute',
      value: '',
      options: [
        { value: 'x', label: 'Horizontally' },
        { value: 'y', label: 'Vertically' },
      ],
      disabled: count < 3,
    });
  }
  if (host.reorderSelection !== undefined) {
    controls.push({
      kind: 'choice',
      id: controlId('order'),
      group,
      label: 'Arrange order',
      icon: 'layers',
      value: '',
      options: [
        { value: 'front', label: 'Bring to front' },
        { value: 'forward', label: 'Bring forward' },
        { value: 'backward', label: 'Send backward' },
        { value: 'back', label: 'Send to back' },
      ],
      disabled: count < 1,
    });
  }
  if (host.setLocked !== undefined) {
    controls.push({
      kind: 'button',
      id: controlId('lock'),
      group,
      label: 'Lock selection',
      shortLabel: 'Lock',
      icon: 'lock',
      disabled: count < 1,
    });
    controls.push({
      kind: 'button',
      id: controlId('unlock'),
      group,
      label: 'Unlock selection',
      shortLabel: 'Unlock',
      icon: 'unlock',
      disabled: count < 1,
    });
  }
  if (host.groupSelection !== undefined) {
    controls.push({
      kind: 'button',
      id: controlId('group'),
      group,
      label: 'Group selection',
      shortLabel: 'Group',
      icon: 'group',
      disabled: count < 2,
    });
  }
  if (host.ungroupSelection !== undefined) {
    controls.push({
      kind: 'button',
      id: controlId('ungroup'),
      group,
      label: 'Ungroup selection',
      shortLabel: 'Ungroup',
      icon: 'ungroup',
      disabled: count < 1,
    });
  }
  if (host.duplicateSelection !== undefined) {
    controls.push({
      kind: 'button',
      id: controlId('duplicate'),
      semanticRole: 'surface.selection.duplicate',
      group,
      label: 'Duplicate selection',
      shortLabel: 'Duplicate',
      icon: 'copy',
      disabled: count < 1,
    });
  }
  if (host.deleteSelection !== undefined) {
    controls.push({
      kind: 'button',
      id: controlId('delete'),
      semanticRole: 'surface.selection.delete',
      group,
      label: 'Delete selection',
      shortLabel: 'Delete',
      icon: 'trash',
      disabled: count < 1,
    });
  }
  if (host.connectSelected !== undefined) {
    controls.push({
      kind: 'button',
      id: controlId('connect'),
      group,
      label: 'Connect selected objects',
      shortLabel: 'Connect',
      icon: 'link',
      disabled: count < 2,
    });
  }
  return controls;
}

export interface SurfaceToolbarExportOptions {
  readonly prefix: string;
  /** Control-id suffix such as `export` or `export-all`. */
  readonly id?: string;
  readonly group: string;
  readonly label: string;
  readonly shortLabel?: string;
}

/**
 * Emits one derived PNG export button. Export commands stay provider-local
 * (each family renders different pages through different engines), so this
 * shares only the control shape — routing the id is the adapter's job.
 */
export function buildSurfaceExportControl(
  options: SurfaceToolbarExportOptions,
): DocumentToolControl {
  return {
    kind: 'button',
    id: `${options.prefix}.${options.id ?? 'export'}`,
    group: options.group,
    label: options.label,
    shortLabel: options.shortLabel ?? options.label,
  };
}

/**
 * Routes one shared-subset command id. Returns false for family-specific
 * ids (frame sizing, pager controls, exports) and foreign prefixes so the
 * adapter can try its own handlers next. Retired ids (such as the removed
 * Whiteboard Arrow alias) take this same documented unknown-command path:
 * they resolve to false instead of silently invoking another tool.
 */
export function executeSurfaceToolbarControl(
  host: SurfaceToolbarHost,
  options: SurfaceToolbarExecuteOptions,
  id: string,
  value?: string,
): boolean {
  const toolPrefix = `${options.prefix}.tool.`;
  if (id.startsWith(toolPrefix)) {
    const tool = options.tools.find(
      (entry) => entry.key === id.slice(toolPrefix.length),
    );
    if (tool === undefined) return false;
    // Eraser routing: fix the preset mode before
    // activating the single eraser engine. Best-effort when the host
    // lacks the mode seam — engine activation still follows.
    if (tool.eraserMode !== undefined) host.setEraserMode?.(tool.eraserMode);
    host.setTool(tool.toolId);
    return true;
  }
  const prefix = options.prefix;
  const arrangeId = (name: string): string =>
    `${prefix}.${options.arrangeIdPrefix ?? ''}${name}`;
  if (
    value !== undefined &&
    (id === `${prefix}.selection.position-x` ||
      id === `${prefix}.selection.position-y`)
  ) {
    const axis = id.endsWith('-x') ? 'x' : 'y';
    const target = Number(value);
    const bounds = host.selectionContext?.()?.bounds;
    if (
      bounds === undefined ||
      host.moveSelectionBy === undefined ||
      !Number.isFinite(target)
    )
      return false;
    host.moveSelectionBy(
      axis === 'x'
        ? { x: target - bounds.x, y: 0 }
        : { x: 0, y: target - bounds.y },
    );
    return true;
  }
  if (
    value !== undefined &&
    (id === `${prefix}.selection.bounds-width` ||
      id === `${prefix}.selection.bounds-height`)
  ) {
    const dimension = id.endsWith('.width') ? 'width' : 'height';
    const target = Number(value);
    const bounds = host.selectionContext?.()?.bounds;
    if (
      bounds === undefined ||
      host.scaleSelection === undefined ||
      !Number.isFinite(target) ||
      target <= 0 ||
      bounds[dimension] <= 0
    )
      return false;
    host.scaleSelection(target / bounds[dimension]);
    return true;
  }
  if (id === `${prefix}.selection.rotation` && value !== undefined) {
    const target = Number(value);
    const current = host.selectionContext?.()?.rotation;
    if (
      host.rotateSelection === undefined ||
      current === undefined ||
      !Number.isFinite(target)
    )
      return false;
    host.rotateSelection((target * Math.PI) / 180 - current);
    return true;
  }

  if (
    id === `${prefix}.selection.radius` &&
    value !== undefined &&
    Number.isFinite(Number(value)) &&
    Number(value) >= 0
  ) {
    host.setSelectionStyle?.({ cornerRadius: Number(value) });
    return true;
  }
  if (id === `${prefix}.selection.fill` && value) {
    host.setSelectionStyle?.({ fill: value });
    return true;
  }
  if (id === `${prefix}.selection.text-size` && Number(value) > 0) {
    host.setSelectionStyle?.({ textSize: Number(value) });
    return true;
  }
  if (
    id === `${prefix}.selection.line-path` &&
    (value === 'straight' || value === 'orthogonal' || value === 'curved')
  ) {
    host.setSelectionStyle?.({ linePath: value });
    return true;
  }
  if (
    id === `${prefix}.selection.line-arrows` &&
    (value === 'none' ||
      value === 'start' ||
      value === 'end' ||
      value === 'both')
  ) {
    host.setSelectionStyle?.({ lineArrows: value });
    return true;
  }
  if (
    id === `${prefix}.selection.shape` &&
    (value === 'rectangle' ||
      value === 'rounded' ||
      value === 'triangle' ||
      value === 'diamond')
  ) {
    host.setSelectionStyle?.({ shape: value });
    return true;
  }
  if (id === `${prefix}.selection.color` && value !== undefined) {
    if (host.setSelectionStyle === undefined || value === '') return false;
    host.setSelectionStyle({ color: value });
    return true;
  }
  if (id === `${prefix}.selection.width` && value !== undefined) {
    const width = Number(value);
    if (
      host.setSelectionStyle === undefined ||
      !Number.isFinite(width) ||
      width <= 0
    )
      return false;
    host.setSelectionStyle({ width });
    return true;
  }
  if (id === `${prefix}.selection.opacity` && value !== undefined) {
    const opacity = Number(value);
    if (host.setSelectionStyle === undefined || !Number.isFinite(opacity))
      return false;
    host.setSelectionStyle({ opacity });
    return true;
  }
  if (
    id === `${prefix}.selection.shape-appearance` &&
    (value === 'fill' || value === 'outline')
  ) {
    if (host.setSelectionStyle === undefined) return false;
    host.setSelectionStyle({ shapeAppearance: value });
    return true;
  }
  if (id === `${prefix}.color` && value !== undefined) {
    if (value === '') return false;
    const activeTool = activePresetTool(host);
    // Family write: the preset store fans color/size out
    // inside the settled tool's family (pen vs highlighter), so one edit
    // moves every sibling tool's live values.
    if (activeTool !== null && host.setToolPreset !== undefined)
      host.setToolPreset(activeTool, { color: value });
    else host.setPenColor(value);
    return true;
  }
  if (id === `${prefix}.width` && value !== undefined) {
    const width = Number(value);
    if (!Number.isFinite(width) || width <= 0) return false;
    const activeTool = activePresetTool(host);
    // Same family-write contract as `.color` above.
    if (activeTool !== null && host.setToolPreset !== undefined)
      host.setToolPreset(activeTool, { size: width });
    else host.setPenWidth(width);
    return true;
  }
  if (id === `${prefix}.eraser-radius` && value !== undefined) {
    const radius = Number(value);
    if (!Number.isFinite(radius) || radius <= 0) return false;
    host.setEraserRadius(radius);
    return true;
  }
  if (
    (id === `${prefix}.zoom` || id === `${prefix}.zoom-slider`) &&
    value !== undefined
  ) {
    const zoom = Number(value) / 100;
    if (!Number.isFinite(zoom) || zoom <= 0) return false;
    host.setZoomFactor(zoom);
    return true;
  }
  if (id === `${prefix}.zoom-in`) {
    const next = host.zoomFactor() * SURFACE_TOOLBAR_ZOOM_STEP;
    if (!Number.isFinite(next) || next <= 0) return false;
    host.setZoomFactor(next);
    return true;
  }
  if (id === `${prefix}.zoom-out`) {
    const next = host.zoomFactor() / SURFACE_TOOLBAR_ZOOM_STEP;
    if (!Number.isFinite(next) || next <= 0) return false;
    host.setZoomFactor(next);
    return true;
  }
  if (id === `${prefix}.zoom-reset`) {
    host.setZoomFactor(1);
    return true;
  }
  if (id === `${prefix}.image`) {
    if (!host.canInsertImage()) return false;
    host.chooseImage();
    return true;
  }
  if (id === `${prefix}.fit`) {
    host.fitToView();
    return true;
  }
  if (id === arrangeId('align') && value !== undefined) {
    if (host.alignSelection === undefined || !isAlignEdge(value)) return false;
    host.alignSelection(value);
    return true;
  }
  if (id === arrangeId('distribute') && value !== undefined) {
    if (
      host.distributeSelection === undefined ||
      (value !== 'x' && value !== 'y')
    ) {
      return false;
    }
    host.distributeSelection(value);
    return true;
  }
  if (id === arrangeId('order') && value !== undefined) {
    if (host.reorderSelection === undefined || !isReorderDirection(value)) {
      return false;
    }
    host.reorderSelection(value);
    return true;
  }
  if (id === arrangeId('lock')) {
    const ids = host.selectionIds?.() ?? [];
    if (host.setLocked === undefined || ids.length === 0) return false;
    host.setLocked(ids, true);
    return true;
  }
  if (id === arrangeId('unlock')) {
    const ids = host.selectionIds?.() ?? [];
    if (host.setLocked === undefined || ids.length === 0) return false;
    host.setLocked(ids, false);
    return true;
  }
  if (id === arrangeId('group')) {
    if (host.groupSelection === undefined) return false;
    host.groupSelection();
    return true;
  }
  if (id === arrangeId('ungroup')) {
    if (host.ungroupSelection === undefined) return false;
    host.ungroupSelection();
    return true;
  }
  if (id === arrangeId('duplicate')) {
    if (host.duplicateSelection === undefined) return false;
    host.duplicateSelection();
    return true;
  }
  if (id === arrangeId('delete')) {
    if (host.deleteSelection === undefined) return false;
    host.deleteSelection();
    return true;
  }
  if (id === arrangeId('connect')) {
    if (host.connectSelected === undefined) return false;
    host.connectSelected();
    return true;
  }
  return false;
}

/** Resolve only known preset-backed brush ids; shapes/text retain pen style. */
function activePresetTool(host: SurfaceToolbarHost): InkPresetToolId | null {
  if (host.toolPreset === undefined) return null;
  const live = settledToolIdOf(host);
  const segment = live.slice(live.lastIndexOf('.') + 1);
  return segment === 'pen' ||
    segment === 'fountain' ||
    segment === 'brush' ||
    segment === 'pencil' ||
    segment === 'highlighter'
    ? segment
    : null;
}

/**
 * Settled exclusive tool id for toolbar derivation: the
 * host-reported settled tool when present, else the live tool (settled by
 * construction on hosts without a temporary seam).
 */
function settledToolIdOf(host: SurfaceToolbarHost): string {
  return host.settledActiveToolId?.() ?? host.activeToolId();
}

const ALIGN_EDGES: readonly string[] = [
  'left',
  'centerX',
  'right',
  'top',
  'centerY',
  'bottom',
];

function isAlignEdge(value: string): value is AlignEdge {
  return ALIGN_EDGES.includes(value);
}

const REORDER_DIRECTIONS: readonly string[] = [
  'front',
  'forward',
  'backward',
  'back',
];

function isReorderDirection(value: string): value is ReorderDirection {
  return REORDER_DIRECTIONS.includes(value);
}
