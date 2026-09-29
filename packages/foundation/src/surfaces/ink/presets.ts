/**
 * Family-shared live preset state.
 *
 * Live color/size are shared inside the slot family: the four pen-family
 * tools (pen/fountain/brush/pencil) read and write the SAME live values,
 * so switching inside the family keeps them (Fountain Thick → Pen Thick);
 * the highlighter owns an independent pair. Opacity, straight-line hold,
 * and brush tuning stay per-tool; only color and size are shared.
 *
 * Sharing converges over the existing per-tool keys (`ink.preset.<tool>.*
 * — no new keys, reload persistence rides the existing store): reads take
 * the first defined value in canonical order (pen → fountain → brush →
 * pencil), writes fan out to every family member. Pre-existing divergent
 * presets therefore converge deterministically (pen wins) without throwing
 * and without touching any other field. Primitives persist through an
 * optional SettingsService under `ink.preset.*` keys — surfaces sharing
 * one service share user defaults without sharing live objects. Brush
 * tuning persists as one validated JSON record per tool
 * (`ink.preset.<tool>.brush`, the v1 shape below); corrupt records read
 * back as absent rather than throwing, so old sessions degrade to kind
 * defaults instead of breaking.
 *
 * Headless and serializable: snapshot()/restore() round-trip the full
 * state. `restore()` *replaces* the complete state — fields absent from
 * the snapshot are cleared, never merged; the four pen-family entries
 * converge pen-first into one shared pair before writing. Effect-owned:
 * dispose() cuts settings subscriptions.
 */

import type { SettingsService } from '../../settings.js';
import {
  DEFAULT_ERASER_MODE,
  ERASER_FILTERS,
  ERASER_MODES,
  LASSO_MODES,
  isEraserMode,
} from './eraser-geometry.js';
import type { EraserFilter, EraserMode, LassoMode } from './eraser-geometry.js';
import { INK_BRUSH_KINDS } from './brush.js';
import type { InkBrushKind, InkBrushOverrides } from './brush.js';

export type InkPresetToolId =
  | 'pen'
  | 'fountain'
  | 'brush'
  | 'pencil'
  | 'highlighter';

/**
 * Slot family for per-family size/color state and live sharing.
 *
 * The four pen-family tools (pen/fountain/brush/pencil) share one slot
 * set AND one live color/size pair, so switching inside the pen family
 * keeps the same sizes/colors; the highlighter owns an independent set
 * and an independent live pair. Opacity, straight-line hold, and brush
 * tuning stay per-tool (`InkPresetStore` never shares those) — the family
 * scopes live color/size plus the shelf slot *sets*, never advanced
 * tuning.
 */
export type InkSlotFamily = 'pen' | 'highlighter';

/** Pen-family tools share one slot set.*/
export const INK_PEN_FAMILY_TOOLS: readonly InkPresetToolId[] = [
  'pen',
  'fountain',
  'brush',
  'pencil',
] as const;

/**
 * Slot family for one preset tool id. Total over `InkPresetToolId`
 * (never undefined) so callers cannot fork pen/highlighter sets by
 * accident; unknown ids are rejected by the type, not guessed.
 */
export function inkSlotFamilyForTool(tool: InkPresetToolId): InkSlotFamily {
  return tool === 'highlighter' ? 'highlighter' : 'pen';
}

/**
 * Canonical member order per slot family.
 *
 * Reads converge in this order (pen first): the first defined color/size
 * across the members is the family's live value, so pre-existing
 * divergent presets resolve deterministically without throwing and
 * without a settled-tool context (the store never knows the active tool;
 * settled-first routing happens one layer up, in the toolbar builder and
 * the settings schema). Writes fan out to every member, so the converged
 * read stays stable and reload persistence rides the existing per-tool
 * keys. The highlighter family has one member: reads/writes are its own
 * keys, untouched by pen-family traffic and vice versa.
 */
const INK_FAMILY_MEMBERS: Record<InkSlotFamily, readonly InkPresetToolId[]> = {
  pen: INK_PEN_FAMILY_TOOLS,
  highlighter: ['highlighter'],
};

/** Converged live color/size for one family (first defined wins, cleaned). */
function readFamilyLive(
  get: (key: string) => string | number | boolean | null | undefined,
  family: InkSlotFamily,
  field: 'color' | 'size',
): string | number | undefined {
  for (const member of INK_FAMILY_MEMBERS[family]) {
    const raw = get(presetKey(member, field));
    const clean = field === 'color' ? cleanString(raw) : cleanPositive(raw);
    if (clean !== undefined) return clean;
  }
  return undefined;
}

/**
 * Converge one color/size from a restore/import snapshot across the pen
 * family (pen-first, cleaned per field so a valid color never drags a
 * corrupt sibling size along). Never throws; untrusted payloads degrade
 * to absent.
 */
function convergeSnapshotField(
  presets: readonly (InkToolPreset | undefined)[],
  field: 'color' | 'size',
): string | number | undefined {
  for (const preset of presets) {
    const raw = preset?.[field];
    const clean = field === 'color' ? cleanString(raw) : cleanPositive(raw);
    if (clean !== undefined) return clean;
  }
  return undefined;
}

/** Arrowheads used by the shared straight-line creation tool. */
export type LineArrowSetting = 'none' | 'start' | 'end' | 'both';

const PRESET_TOOLS: readonly InkPresetToolId[] = [
  'pen',
  'fountain',
  'brush',
  'pencil',
  'highlighter',
];

/**
 * Stored per drawing tool: style primitives plus session brush tuning.
 *
 * `color`/`size` are family-shared live values — the
 * four pen-family entries always read the same converged pair (see
 * `INK_FAMILY_MEMBERS`), the highlighter reads its own. `opacity`,
 * `straight`, and `brush` stay per-tool.
 */
export interface InkToolPreset {
  readonly color?: string;
  readonly size?: number;
  readonly opacity?: number;
  readonly brush?: InkBrushOverrides;
  /** Hold-to-straighten gesture (highlighter straight-line mode). */
  readonly straight?: boolean;
}

/** Eraser preset: radius, behavior mode, content filter, auto-return. */
export interface EraserPreset {
  readonly radius?: number;
  readonly mode?: EraserMode;
  readonly filter?: EraserFilter;
  /** Return to the previous tool when a temporary eraser gesture ends. */
  readonly autoReturn?: boolean;
}

/**
 * Toolbar semantic role per eraser mode. The single
 * engine eraser (`SURFACE_TOOL_IDS.eraser`) stays; the secondary toolbar
 * exposes two tools with a fixed preset mode each. Single source of
 * truth for the mode↔role mapping shared by the toolbar builder and the
 * composition (literals duplicated there stay in sync through spec pins).
 */
export const ERASER_SEMANTIC_ROLE_BY_MODE: Record<EraserMode, string> = {
  stroke: 'surface.erase.stroke',
  precision: 'surface.erase.precision',
};

/** Inverse of `ERASER_SEMANTIC_ROLE_BY_MODE` (absent for foreign roles). */
export const ERASER_MODE_BY_SEMANTIC_ROLE: Record<string, EraserMode> = {
  'surface.erase.stroke': 'stroke',
  'surface.erase.precision': 'precision',
};

/**
 * Normalize an optional persisted eraser mode. Unknown, corrupt, or absent
 * values fall back to `DEFAULT_ERASER_MODE` (`stroke`). Never throws; callers
 * keep the stored preset and derive the active tool from this value.
 */
export function normalizeEraserMode(value: unknown): EraserMode {
  return isEraserMode(value) ? value : DEFAULT_ERASER_MODE;
}

/**
 * Active eraser toolbar role for one eraser preset: the fixed-mode tool
 * matching the normalized stored mode, `stroke` when absent or invalid.
 */
export function eraserSemanticRoleForPreset(
  preset: EraserPreset | undefined,
): string {
  return ERASER_SEMANTIC_ROLE_BY_MODE[normalizeEraserMode(preset?.mode)];
}

/** Lasso preset: marquee shape plus content filter. */
export interface LassoPreset {
  readonly mode?: LassoMode;
  readonly filter?: EraserFilter;
}

/**
 * Pen-gesture preferences (slice 7 product contract): all off by default
 * (conservative against false positives); toggled in Active Tool settings,
 * persisted per user, shared across Ink/Notebook/Whiteboard through the
 * shared settings service, and read live by capture tools so mounted
 * surfaces update immediately.
 */
export interface GesturePreferences {
  /** Draw-and-hold converts held strokes to shapes (line/rect/ellipse/arrow). */
  readonly drawAndHold?: boolean;
  /** Scribble over ink erases the scribbled strokes. */
  readonly scribbleErase?: boolean;
  /** Drawn circles become lasso selections. */
  readonly circleLasso?: boolean;
}

/** Versioned user-level tool preferences backing the preset store. */
export const INK_TOOL_PREFERENCES_VERSION = 1;

/**
 * Complete meaningful tool preset, persisted per user (repair pass item
 * 7): every drawing tool's style primitives plus brush tuning, eraser
 * and lasso presets. `version` gates future migrations; loaders ignore
 * corrupt individual values so one bad value never resets the preset.
 */
export interface InkToolPreferencesV1 {
  readonly version: 1;
  readonly pen: InkToolPreset;
  readonly fountain: InkToolPreset;
  readonly brush: InkToolPreset;
  readonly pencil: InkToolPreset;
  readonly highlighter: InkToolPreset;
  readonly eraser: EraserPreset;
  readonly lasso: LassoPreset;
  readonly lineArrows?: LineArrowSetting;
  /** Added with the slice-7 product contract; absent means all off. */
  readonly gestures?: GesturePreferences;
}

/** Full preset snapshot: plain data, one entry per tool. */
export interface SurfaceToolPresetState {
  readonly pen: InkToolPreset;
  readonly fountain: InkToolPreset;
  readonly brush: InkToolPreset;
  readonly pencil: InkToolPreset;
  readonly highlighter: InkToolPreset;
  readonly eraser: EraserPreset;
  readonly lasso: LassoPreset;
  readonly lineArrows?: LineArrowSetting;
  /** Absent in old snapshots; restore treats absence as clear. */
  readonly gestures?: GesturePreferences;
}

type PrimitiveField =
  | 'color'
  | 'size'
  | 'opacity'
  | 'radius'
  | 'mode'
  | 'filter'
  | 'autoReturn'
  | 'straight';

const TOOL_FIELDS: Record<
  InkPresetToolId | 'eraser' | 'lasso',
  readonly PrimitiveField[]
> = {
  pen: ['color', 'size', 'opacity', 'straight'],
  fountain: ['color', 'size', 'opacity', 'straight'],
  brush: ['color', 'size', 'opacity', 'straight'],
  pencil: ['color', 'size', 'opacity', 'straight'],
  highlighter: ['color', 'size', 'opacity', 'straight'],
  eraser: ['radius', 'mode', 'filter', 'autoReturn'],
  lasso: ['mode', 'filter'],
};

/** Recent-colors MRU depth (persisted as one JSON string setting). */
export const RECENT_COLORS_LIMIT = 8;

const RECENT_COLORS_KEY = 'ink.recent.colors';
const LINE_ARROWS_KEY = 'ink.line.arrows';
const LINE_ARROWS: readonly LineArrowSetting[] = [
  'none',
  'start',
  'end',
  'both',
];

function cleanLineArrows(value: unknown): LineArrowSetting | undefined {
  return (LINE_ARROWS as readonly unknown[]).includes(value)
    ? (value as LineArrowSetting)
    : undefined;
}

function presetKey(
  tool: InkPresetToolId | 'eraser' | 'lasso',
  field: PrimitiveField,
): string {
  return `ink.preset.${tool}.${field}`;
}

function cleanEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | undefined {
  return typeof value === 'string' &&
    (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

function cleanMode(value: unknown): EraserMode | undefined {
  return cleanEnum(value, ERASER_MODES);
}

function cleanFilter(value: unknown): EraserFilter | undefined {
  return cleanEnum(value, ERASER_FILTERS);
}

function cleanLassoMode(value: unknown): LassoMode | undefined {
  return cleanEnum(value, LASSO_MODES);
}

function cleanFlag(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

function cleanPositive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function cleanOpacity(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(Math.max(value, 0), 1)
    : undefined;
}

function cleanFinite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function cleanUnit(value: unknown): number | undefined {
  const finite = cleanFinite(value);
  return finite === undefined ? undefined : Math.min(Math.max(finite, 0), 1);
}

/** Brush settings key: one validated JSON record per tool (v1). */
function brushKey(tool: InkPresetToolId): string {
  return `ink.preset.${tool}.brush`;
}

/**
 * Validate persisted brush tuning field-by-field: corrupt individual
 * values are dropped, valid ones survive. Unknown fields are ignored so
 * future tuning additions never break old loaders.
 */
function cleanBrushOverrides(value: unknown): InkBrushOverrides | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (
    typeof raw.kind === 'string' &&
    (INK_BRUSH_KINDS as readonly string[]).includes(raw.kind)
  ) {
    out.kind = raw.kind as InkBrushKind;
  }
  const color = cleanString(raw.color);
  if (color !== undefined) out.color = color;
  const size = cleanPositive(raw.size);
  if (size !== undefined) out.size = size;
  const opacity = cleanOpacity(raw.opacity);
  if (opacity !== undefined) out.opacity = opacity;
  if (
    typeof raw.pressure === 'object' &&
    raw.pressure !== null &&
    !Array.isArray(raw.pressure)
  ) {
    const p = raw.pressure as Record<string, unknown>;
    const pressure: Record<string, unknown> = {};
    if (typeof p.enabled === 'boolean') pressure.enabled = p.enabled;
    const minFactor = cleanFinite(p.minFactor);
    if (minFactor !== undefined && minFactor >= 0)
      pressure.minFactor = minFactor;
    const maxFactor = cleanFinite(p.maxFactor);
    if (maxFactor !== undefined && maxFactor >= 0)
      pressure.maxFactor = maxFactor;
    const curve = cleanFinite(p.curve);
    if (curve !== undefined && curve > 0) pressure.curve = curve;
    if (Object.keys(pressure).length > 0) out.pressure = pressure;
  }
  const stabilization = cleanUnit(raw.stabilization);
  if (stabilization !== undefined) out.stabilization = stabilization;
  const streamline = cleanUnit(raw.streamline);
  if (streamline !== undefined) out.streamline = streamline;
  if (typeof raw.velocityPressure === 'boolean') {
    out.velocityPressure = raw.velocityPressure;
  }
  const tiltEffect = cleanUnit(raw.tiltEffect);
  if (tiltEffect !== undefined) out.tiltEffect = tiltEffect;
  const taperStart = cleanUnit(raw.taperStart);
  if (taperStart !== undefined) out.taperStart = taperStart;
  const taperEnd = cleanUnit(raw.taperEnd);
  if (taperEnd !== undefined) out.taperEnd = taperEnd;
  if (
    typeof raw.tip === 'object' &&
    raw.tip !== null &&
    !Array.isArray(raw.tip)
  ) {
    const tipRaw = raw.tip as Record<string, unknown>;
    const tip: Record<string, unknown> = {};
    if (
      tipRaw.shape === 'round' ||
      tipRaw.shape === 'flat' ||
      tipRaw.shape === 'ellipse'
    ) {
      tip.shape = tipRaw.shape;
    }
    const angle = cleanFinite(tipRaw.angle);
    if (angle !== undefined) tip.angle = angle;
    const aspect = cleanUnit(tipRaw.aspect);
    if (aspect !== undefined) tip.aspect = aspect;
    if (tipRaw.cap === 'round' || tipRaw.cap === 'butt') {
      tip.cap = tipRaw.cap;
    }
    if (Object.keys(tip).length > 0) out.tip = tip;
  }
  return Object.keys(out).length > 0 ? (out as InkBrushOverrides) : undefined;
}

function readBrushRecord(
  backing: Pick<SettingsService, 'get'>,
  tool: InkPresetToolId,
): InkBrushOverrides | undefined {
  const raw = backing.get(brushKey(tool));
  if (typeof raw !== 'string') return undefined;
  try {
    return cleanBrushOverrides(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/**
 * Deep-merge a brush patch over the existing record: top-level keys
 * replace, nested `pressure`/`tip` objects merge key-by-key. Explicit
 * `null`/`undefined` values in the patch clear that key; other values
 * overwrite. Unknown future keys survive the merge and are filtered by
 * validation on write.
 */
function deepMergeBrush(
  existing: InkBrushOverrides,
  patch: InkBrushOverrides,
): InkBrushOverrides {
  const out: Record<string, unknown> = {
    ...(existing as Record<string, unknown>),
  };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === undefined || value === null) {
      delete out[key];
      continue;
    }
    if (
      (key === 'pressure' || key === 'tip') &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      typeof out[key] === 'object' &&
      out[key] !== null &&
      !Array.isArray(out[key])
    ) {
      out[key] = {
        ...(out[key] as Record<string, unknown>),
        ...(value as Record<string, unknown>),
      };
    } else {
      out[key] = value;
    }
  }
  return out as InkBrushOverrides;
}

/** Validate one tool preset from an untrusted payload (import path). */
function cleanToolPreset(value: unknown): InkToolPreset {
  if (typeof value !== 'object' || value === null) return {};
  const raw = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const color = cleanString(raw.color);
  if (color !== undefined) out.color = color;
  const size = cleanPositive(raw.size);
  if (size !== undefined) out.size = size;
  const opacity = cleanOpacity(raw.opacity);
  if (opacity !== undefined) out.opacity = opacity;
  const straight = cleanFlag(raw.straight);
  if (straight !== undefined) out.straight = straight;
  const brush = cleanBrushOverrides(raw.brush);
  if (brush !== undefined) out.brush = brush;
  return out as InkToolPreset;
}

/** Validate one eraser preset from an untrusted payload (import path). */
function cleanEraserPreset(value: unknown): EraserPreset {
  if (typeof value !== 'object' || value === null) return {};
  const raw = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const radius = cleanPositive(raw.radius);
  if (radius !== undefined) out.radius = radius;
  const mode = cleanMode(raw.mode);
  if (mode !== undefined) out.mode = mode;
  const filter = cleanFilter(raw.filter);
  if (filter !== undefined) out.filter = filter;
  const autoReturn = cleanFlag(raw.autoReturn);
  if (autoReturn !== undefined) out.autoReturn = autoReturn;
  return out as EraserPreset;
}

/** Validate one lasso preset from an untrusted payload (import path). */
function cleanLassoPreset(value: unknown): LassoPreset {
  if (typeof value !== 'object' || value === null) return {};
  const raw = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const mode = cleanLassoMode(raw.mode);
  if (mode !== undefined) out.mode = mode;
  const filter = cleanFilter(raw.filter);
  if (filter !== undefined) out.filter = filter;
  return out as LassoPreset;
}

/** Validate gesture preferences field-by-field (import/settings path). */
function cleanGesturePreferences(value: unknown): GesturePreferences {
  if (typeof value !== 'object' || value === null) return {};
  const raw = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of ['drawAndHold', 'scribbleErase', 'circleLasso'] as const) {
    const flag = cleanFlag(raw[key]);
    if (flag !== undefined) out[key] = flag;
  }
  return out as GesturePreferences;
}

function gestureKey(
  field: 'drawAndHold' | 'scribbleErase' | 'circleLasso',
): string {
  return `ink.gesture.${field}`;
}

export interface InkPresetStoreOptions {
  /** Persistence + cross-surface sharing; omitted keeps memory only. */
  readonly settings?: SettingsService;
}

export class InkPresetStore {
  readonly #settings: SettingsService | null;
  readonly #memory = new Map<string, string | number | boolean | null>();
  readonly #listeners = new Set<() => void>();
  readonly #settingsUnsub: { dispose(): void } | null;
  #disposed = false;
  /** True while applying our own writes (suppresses the settings echo). */
  #muted = false;

  constructor(options: InkPresetStoreOptions = {}) {
    this.#settings = options.settings ?? null;
    this.#settingsUnsub =
      this.#settings?.onChange((key) => {
        if (
          !this.#disposed &&
          !this.#muted &&
          (key.startsWith('ink.preset.') ||
            key.startsWith('ink.gesture.') ||
            key === 'ink.recent.colors' ||
            key === LINE_ARROWS_KEY)
        ) {
          this.#emit();
        }
      }) ?? null;
  }

  /**
   * Current preset for one drawing tool (fresh object per call).
   *
   * `color`/`size` are the family's converged live values
   * (pen-first across pen/fountain/brush/pencil; the highlighter reads
   * its own), so every pen-family tool reports the same pair and
   * switching inside the family keeps them. `opacity`, `straight`, and
   * `brush` stay per-tool.
   */
  getTool(tool: InkPresetToolId): InkToolPreset {
    const preset: Record<string, unknown> = {};
    const family = inkSlotFamilyForTool(tool);
    const backing = this.#backing();
    const color = readFamilyLive((key) => backing.get(key), family, 'color');
    if (color !== undefined) preset.color = color;
    const size = readFamilyLive((key) => backing.get(key), family, 'size');
    if (size !== undefined) preset.size = size;
    for (const field of TOOL_FIELDS[tool]) {
      if (field === 'color' || field === 'size') continue;
      const value = this.#read(tool, field);
      if (value !== undefined) preset[field] = value;
    }
    const brush = readBrushRecord(this.#backing(), tool);
    if (brush !== undefined) preset.brush = brush;
    return preset as InkToolPreset;
  }

  /**
   * Merge a patch into one tool's preset.
   *
   * `color`/`size` fan out to the whole family (pen vs
   * highlighter via `inkSlotFamilyForTool`), so editing any pen-family
   * tool moves all four siblings; clearing removes the family's values.
   * `opacity`, `straight`, and `brush` persist per-tool only.
   */
  setTool(tool: InkPresetToolId, patch: Partial<InkToolPreset>): void {
    if (this.#disposed) return;
    this.#muted = true;
    try {
      const family = inkSlotFamilyForTool(tool);
      if (patch.color !== undefined)
        this.#writeFamily(family, 'color', cleanString(patch.color) ?? null);
      if (patch.size !== undefined)
        this.#writeFamily(family, 'size', cleanPositive(patch.size) ?? null);
      if (patch.opacity !== undefined) {
        this.#write(tool, 'opacity', cleanOpacity(patch.opacity) ?? null);
      }
      if (patch.straight !== undefined) {
        const flag = cleanFlag(patch.straight);
        this.#write(tool, 'straight', flag ?? null);
      }
      if (patch.brush !== undefined) this.#writeBrush(tool, patch.brush, true);
    } finally {
      this.#muted = false;
    }
    this.#emit();
  }

  /**
   * Recent color choices, most-recent-first, deduplicated. Persisted as
   * one JSON string setting so MRU survives reloads; corrupt payloads
   * read back as empty rather than throwing.
   */
  getRecentColors(): string[] {
    const raw = this.#backing().get(RECENT_COLORS_KEY);
    if (typeof raw !== 'string') return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (entry): entry is string => typeof entry === 'string',
      );
    } catch {
      return [];
    }
  }

  /** Current arrowhead selection for newly created straight lines. */
  getLineArrows(): LineArrowSetting {
    return cleanLineArrows(this.#backing().get(LINE_ARROWS_KEY)) ?? 'end';
  }

  /** Set the arrowhead selection for newly created straight lines. */
  setLineArrows(arrows: LineArrowSetting): void {
    if (this.#disposed || !LINE_ARROWS.includes(arrows)) return;
    this.#muted = true;
    try {
      this.#backing().set(LINE_ARROWS_KEY, arrows);
    } finally {
      this.#muted = false;
    }
    this.#emit();
  }

  /** Push a color to the MRU front (no-op for blank input). */
  pushRecentColor(color: string): void {
    if (this.#disposed) return;
    const clean = cleanString(color);
    if (clean === undefined) return;
    const next = [
      clean,
      ...this.getRecentColors().filter((c) => c !== clean),
    ].slice(0, RECENT_COLORS_LIMIT);
    this.#muted = true;
    try {
      this.#backing().set(RECENT_COLORS_KEY, JSON.stringify(next));
    } finally {
      this.#muted = false;
    }
    this.#emit();
  }

  /** Current eraser preset (fresh object per call). */
  getEraser(): EraserPreset {
    const preset: Record<string, unknown> = {};
    const radius = this.#read('eraser', 'radius');
    if (typeof radius === 'number') preset.radius = radius;
    const mode = cleanMode(this.#readRaw('eraser', 'mode'));
    if (mode !== undefined) preset.mode = mode;
    const filter = cleanFilter(this.#readRaw('eraser', 'filter'));
    if (filter !== undefined) preset.filter = filter;
    const autoReturn = cleanFlag(this.#readRaw('eraser', 'autoReturn'));
    if (autoReturn !== undefined) preset.autoReturn = autoReturn;
    return preset as EraserPreset;
  }

  /** Merge a patch into the eraser preset. */
  setEraser(patch: Partial<EraserPreset>): void {
    if (this.#disposed) return;
    this.#muted = true;
    try {
      this.#writeEraser(patch, true);
    } finally {
      this.#muted = false;
    }
    this.#emit();
  }

  /** Full snapshot for serialize/restore round trips. */
  snapshot(): SurfaceToolPresetState {
    return {
      pen: this.getTool('pen'),
      fountain: this.getTool('fountain'),
      brush: this.getTool('brush'),
      pencil: this.getTool('pencil'),
      highlighter: this.getTool('highlighter'),
      eraser: this.getEraser(),
      lasso: this.getLasso(),
      lineArrows: this.getLineArrows(),
      gestures: this.getGestures(),
    };
  }

  /**
   * Versioned export of the full preset: the same
   * state as `snapshot()` inside a `{ version }` envelope for future
   * migrations and cross-surface/user-level persistence.
   */
  exportPreferences(): InkToolPreferencesV1 {
    return { version: INK_TOOL_PREFERENCES_VERSION, ...this.snapshot() };
  }

  /**
   * Import a versioned preferences payload: validated field-by-field,
   * corrupt individual values ignored, unknown `version` values rejected
   * without touching current state. Returns true when applied.
   */
  importPreferences(payload: unknown): boolean {
    if (typeof payload !== 'object' || payload === null) return false;
    const raw = payload as Record<string, unknown>;
    if (raw.version !== INK_TOOL_PREFERENCES_VERSION) return false;
    const state = {
      pen: cleanToolPreset(raw.pen),
      fountain: cleanToolPreset(raw.fountain),
      brush: cleanToolPreset(raw.brush),
      pencil: cleanToolPreset(raw.pencil),
      highlighter: cleanToolPreset(raw.highlighter),
      eraser: cleanEraserPreset(raw.eraser),
      lasso: cleanLassoPreset(raw.lasso),
      lineArrows: cleanLineArrows(raw.lineArrows),
      gestures: cleanGesturePreferences(raw.gestures),
    };
    this.restore(state);
    return true;
  }

  /**
   * Replace the complete current state. Fields
   * absent from the snapshot are cleared — nothing from the previous
   * state survives. Primitives and brush records persist when a settings
   * service is set.
   *
   * The four pen-family entries converge pen-first into one
   * shared color/size pair before writing (per field, so a valid pen
   * color never drags a corrupt sibling size along); absent everywhere
   * clears the family's pair. `opacity`, `straight`, and `brush` keep
   * per-tool replace semantics.
   */
  restore(state: SurfaceToolPresetState): void {
    if (this.#disposed) return;
    this.#muted = true;
    try {
      const backing = this.#backing();
      const penFamily = [
        state.pen,
        state.fountain,
        state.brush,
        state.pencil,
      ] as const;
      const familyColor = convergeSnapshotField(penFamily, 'color');
      const familySize = convergeSnapshotField(penFamily, 'size');
      this.#writeFamily('pen', 'color', familyColor ?? null);
      this.#writeFamily('pen', 'size', familySize ?? null);
      const highlighter = state.highlighter ?? {};
      this.#writeFamily(
        'highlighter',
        'color',
        cleanString(highlighter.color) ?? null,
      );
      this.#writeFamily(
        'highlighter',
        'size',
        cleanPositive(highlighter.size) ?? null,
      );
      for (const tool of PRESET_TOOLS) {
        const preset = state[tool] ?? {};
        this.#write(
          tool,
          'opacity',
          preset.opacity === undefined
            ? null
            : (cleanOpacity(preset.opacity) ?? null),
        );
        this.#write(
          tool,
          'straight',
          preset.straight === undefined
            ? null
            : (cleanFlag(preset.straight) ?? null),
        );
        this.#writeBrush(tool, preset.brush);
      }
      this.#writeEraser(state.eraser ?? {}, false);
      this.#writeLasso(state.lasso ?? {}, false);
      const lineArrows = cleanLineArrows(state.lineArrows);
      if (lineArrows === undefined) backing.remove(LINE_ARROWS_KEY);
      else backing.set(LINE_ARROWS_KEY, lineArrows);
      this.#writeGestures(state.gestures ?? {}, false);
      void backing;
    } finally {
      this.#muted = false;
    }
    this.#emit();
  }

  /** Current lasso preset (fresh object per call). */
  getLasso(): LassoPreset {
    const preset: Record<string, unknown> = {};
    const mode = cleanLassoMode(this.#readRaw('lasso', 'mode'));
    if (mode !== undefined) preset.mode = mode;
    const filter = cleanFilter(this.#readRaw('lasso', 'filter'));
    if (filter !== undefined) preset.filter = filter;
    return preset as LassoPreset;
  }

  /** Merge a patch into the lasso preset. */
  setLasso(patch: Partial<LassoPreset>): void {
    if (this.#disposed) return;
    this.#muted = true;
    try {
      this.#writeLasso(patch, true);
    } finally {
      this.#muted = false;
    }
    this.#emit();
  }

  /** Current gesture preferences (all off when unset). */
  getGestures(): GesturePreferences {
    const preset: Record<string, unknown> = {};
    for (const field of [
      'drawAndHold',
      'scribbleErase',
      'circleLasso',
    ] as const) {
      const value = cleanFlag(this.#backing().get(gestureKey(field)));
      if (value !== undefined) preset[field] = value;
    }
    return preset as GesturePreferences;
  }

  /** Merge a patch into the gesture preferences (persisted). */
  setGestures(patch: Partial<GesturePreferences>): void {
    if (this.#disposed) return;
    this.#muted = true;
    try {
      this.#writeGestures(patch, true);
    } finally {
      this.#muted = false;
    }
    this.#emit();
  }

  /** Subscribe to any preset change (local or via shared settings). */
  onChange(listener: () => void): { dispose(): void } {
    this.#listeners.add(listener);
    return {
      dispose: () => {
        this.#listeners.delete(listener);
      },
    };
  }

  /** Effect-owned teardown: cuts the settings subscription. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#settingsUnsub?.dispose();
    this.#listeners.clear();
  }

  #backing(): Pick<SettingsService, 'get' | 'set' | 'remove'> {
    if (this.#settings !== null) return this.#settings;
    const memory = this.#memory;
    return {
      get: (key: string) => memory.get(key),
      set: (key: string, value: string | number | boolean | null) => {
        memory.set(key, value);
      },
      remove: (key: string) => {
        memory.delete(key);
      },
    };
  }

  #read(
    tool: InkPresetToolId | 'eraser' | 'lasso',
    field: PrimitiveField,
  ): string | number | boolean | undefined {
    const value = this.#readRaw(tool, field);
    if (field === 'color') return cleanString(value);
    if (field === 'size' || field === 'radius') return cleanPositive(value);
    if (field === 'opacity') return cleanOpacity(value);
    if (field === 'straight' || field === 'autoReturn') return cleanFlag(value);
    return undefined;
  }

  #readRaw(
    tool: InkPresetToolId | 'eraser' | 'lasso',
    field: PrimitiveField,
  ): string | number | boolean | null | undefined {
    return this.#backing().get(presetKey(tool, field));
  }

  #write(
    tool: InkPresetToolId | 'eraser' | 'lasso',
    field: PrimitiveField,
    value: string | number | boolean | null,
  ): void {
    const key = presetKey(tool, field);
    const backing = this.#backing();
    if (value === null) backing.remove(key);
    else backing.set(key, value);
  }

  /**
   * Write one live color/size to every family member:
   * `null` removes all members' keys so a clear never resurrects a
   * sibling's stale value on the converged read.
   */
  #writeFamily(
    family: InkSlotFamily,
    field: 'color' | 'size',
    value: string | number | null,
  ): void {
    const backing = this.#backing();
    for (const member of INK_FAMILY_MEMBERS[family]) {
      const key = presetKey(member, field);
      if (value === null) backing.remove(key);
      else backing.set(key, value);
    }
  }

  #writeBrush(
    tool: InkPresetToolId,
    brush: InkBrushOverrides | undefined,
    merge = false,
  ): void {
    const backing = this.#backing();
    if (brush === undefined) {
      backing.remove(brushKey(tool));
      return;
    }
    // `merge=true` (setTool patches) keeps existing tuning; `merge=false`
    // (restore/import) replaces so absent fields clear.
    const base = merge ? (readBrushRecord(backing, tool) ?? {}) : {};
    const merged = merge ? deepMergeBrush(base, brush) : brush;
    const clean = cleanBrushOverrides(merged);
    if (clean === undefined) backing.remove(brushKey(tool));
    else backing.set(brushKey(tool), JSON.stringify(clean));
  }

  /** Write eraser fields; `merge=false` clears absent fields (restore). */
  #writeEraser(patch: Partial<EraserPreset>, merge: boolean): void {
    const put = (
      field: PrimitiveField,
      value: string | number | boolean | null,
    ): void => this.#write('eraser', field, value);
    if (patch.radius !== undefined) {
      put('radius', cleanPositive(patch.radius) ?? null);
    } else if (!merge) put('radius', null);
    if (patch.mode !== undefined) {
      put('mode', cleanMode(patch.mode) ?? null);
    } else if (!merge) put('mode', null);
    if (patch.filter !== undefined) {
      put('filter', cleanFilter(patch.filter) ?? null);
    } else if (!merge) put('filter', null);
    if (patch.autoReturn !== undefined) {
      put('autoReturn', cleanFlag(patch.autoReturn) ?? null);
    } else if (!merge) put('autoReturn', null);
  }

  /** Write lasso fields; `merge=false` clears absent fields (restore). */
  #writeLasso(patch: Partial<LassoPreset>, merge: boolean): void {
    if (patch.mode !== undefined) {
      this.#write('lasso', 'mode', cleanLassoMode(patch.mode) ?? null);
    } else if (!merge) this.#write('lasso', 'mode', null);
    if (patch.filter !== undefined) {
      this.#write('lasso', 'filter', cleanFilter(patch.filter) ?? null);
    } else if (!merge) this.#write('lasso', 'filter', null);
  }

  /** Write gesture flags; `merge=false` clears absent fields (restore). */
  #writeGestures(patch: Partial<GesturePreferences>, merge: boolean): void {
    const backing = this.#backing();
    for (const field of [
      'drawAndHold',
      'scribbleErase',
      'circleLasso',
    ] as const) {
      const value = patch[field];
      if (value !== undefined) {
        const flag = cleanFlag(value);
        if (flag === undefined) backing.remove(gestureKey(field));
        else backing.set(gestureKey(field), flag);
      } else if (!merge) {
        backing.remove(gestureKey(field));
      }
    }
  }

  #emit(): void {
    for (const listener of [...this.#listeners]) listener();
  }
}
