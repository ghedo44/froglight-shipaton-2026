/**
 * Active Tool settings schema (slice 8): per-tool property controls as
 * plain snapshot data for the second-tap popover, plus command routing.
 * React renders; providers interpret. No DOM or engine types cross it.
 *
 * Hosts (Ink, Notebook, Whiteboard) adapt their surface handle: the
 * active engine tool id selects the schema, presets supply values, and
 * `executeSurfaceToolSettingsControl` routes popover actions back into
 * `setTool`/preset patches. Unknown tools yield no controls; unknown
 * ids, fields, and values route to false without side effects.
 */

import type { DocumentToolControl } from './tools.js';
import type { SavedStyleCardData, SavedStylePresetData } from './tools.js';
import {
  ERASER_FILTERS,
  LASSO_MODES,
  type EraserFilter,
  type LassoMode,
} from '../surfaces/ink/eraser-geometry.js';
import {
  brushPresetForKind,
  type InkBrushKind,
} from '../surfaces/ink/brush.js';
import type {
  EraserPreset,
  GesturePreferences,
  InkPresetToolId,
  InkSlotFamily,
  InkToolPreset,
  LineArrowSetting,
  LassoPreset,
} from '../surfaces/ink/presets.js';
import { inkSlotFamilyForTool } from '../surfaces/ink/presets.js';
import type { SurfaceStylePreset } from '../surfaces/ink/style-library.js';

/** Provider-neutral settings source over per-tool presets. */
export interface SurfaceToolSettingsHost {
  /** Active engine tool id (e.g. `froglight.ink.pen`). */
  activeToolId(): string;
  /**
   * Settled exclusive tool for schema selection.
   *
   * Same fallback pattern as `SurfaceToolbarHost`: when present,
   * `activeSettingsKey` resolves the schema from this instead of
   * `activeToolId()`, so a held temporary tool never flips the slot
   * editor mid-gesture and slot edits route to the settled preset —
   * matching the settled draw `active` and style values. Hosts without
   * a temporary seam omit it; readers fall back to `activeToolId()`.
   */
  settledActiveToolId?(): string;
  /** Activate an engine tool by id. */
  setTool(toolId: string): void;
  /** One drawing tool's preset (fresh object per call).
   *
   * Live color/size are family-scoped (pen vs
   * highlighter) — every pen-family tool reports the same converged
   * pair; opacity, straight-line hold, and brush tuning stay per-tool.
   */
  toolPreset(tool: InkPresetToolId): InkToolPreset;
  /** Merge a patch into one drawing tool's preset.
   *
   * Color/size patches fan out inside the tool's
   * family (pen vs highlighter); advanced tuning patches stay per-tool.
   */
  setToolPreset(tool: InkPresetToolId, patch: Partial<InkToolPreset>): void;
  savedStyles?(tool: InkPresetToolId): readonly SurfaceStylePreset[];
  currentStyleId?(tool: InkPresetToolId): string | null;
  saveCurrentStyle?(tool: InkPresetToolId, name: string): string | null;
  applySavedStyle?(id: string): boolean;
  updateSavedStyle?(id: string): boolean;
  renameSavedStyle?(id: string, name: string): boolean;
  favoriteSavedStyle?(id: string, favorite: boolean): boolean;
  reorderSavedStyles?(tool: InkPresetToolId, ids: readonly string[]): boolean;
  deleteSavedStyle?(id: string): boolean;
  resetSavedStyle?(tool: InkPresetToolId): boolean;
  savedStyleModified?(tool: InkPresetToolId): boolean;
  cornerRadius?(): number;
  setCornerRadius?(value: number): void;
  shapeAppearance?(): 'fill' | 'outline';
  setShapeAppearance?(value: 'fill' | 'outline'): void;
  lineArrows?(): LineArrowSetting;
  setLineArrows?(arrows: LineArrowSetting): void;
  /** Current eraser preset (fresh object per call). */
  eraserPreset(): EraserPreset;
  /** Merge a patch into the eraser preset. */
  setEraserPreset(patch: Partial<EraserPreset>): void;
  /** Current lasso preset (fresh object per call). */
  lassoPreset(): LassoPreset;
  /** Merge a patch into the lasso preset. */
  setLassoPreset(patch: Partial<LassoPreset>): void;
  /** Recent color choices, most-recent-first. */
  recentColors(): string[];
  /** Gesture preferences (optional; controls hide when absent). */
  gestures?(): GesturePreferences;
  /** Merge a patch into the gesture preferences. */
  setGestures?(patch: Partial<GesturePreferences>): void;
}

export interface SurfaceToolSettingsOptions {
  /** Control-id prefix (e.g. `ink` for `ink.settings.pen.size`). */
  readonly prefix: string;
  /** Full palette swatches; recent colors merge ahead of these. */
  readonly swatches: readonly string[];
  /** Fast size presets; the first three label Thin/Medium/Thick. */
  readonly widths: readonly number[];
  readonly eraserMin?: number;
  readonly eraserMax?: number;
  readonly eraserStep?: number;
  /** Control group; defaults to `settings`. */
  readonly group?: string;
}

/** Settings schema key: preset tool plus the eraser/lasso pseudo-tools. */
type SettingsToolKey = InkPresetToolId | 'eraser' | 'lasso' | 'line' | 'shape';

const DRAW_TOOLS: readonly InkPresetToolId[] = [
  'pen',
  'fountain',
  'brush',
  'pencil',
  'highlighter',
];

/** Engine-id last segment per draw tool (whiteboard dialects share it). */
const TOOL_SEGMENTS: Record<InkPresetToolId, string> = {
  pen: 'pen',
  fountain: 'fountain',
  brush: 'brush',
  pencil: 'pencil',
  highlighter: 'highlighter',
};

const KIND_OF_TOOL: Record<InkPresetToolId, InkBrushKind> = {
  pen: 'ball',
  fountain: 'fountain',
  brush: 'brush',
  pencil: 'pencil',
  highlighter: 'highlighter',
};

/** Pen type-selector values back to engine-id segments. */
const TYPE_SEGMENTS: Record<'ball' | 'fountain' | 'brush' | 'pencil', string> =
  {
    ball: 'pen',
    fountain: 'fountain',
    brush: 'brush',
    pencil: 'pencil',
  };

/**
 * Conditional advanced brush properties per pen-family tool. Only
 * only expose controls with real engine semantics for the
 * current brush family — no meaningless sliders).
 *
 * Grounded in the tuned bases in `surfaces/ink/brush.ts`:
 * - pressure/min/max + stabilization/streamline: every pen-family base has
 *   pressure enabled with a tuned response and nonzero smoothing.
 * - velocity-pressure: only the brush base derives pressure from velocity
 *   (`velocityPressure: true`); the other families are tuned with it off.
 * - tilt-effect: only the pencil base shades with barrel tilt
 *   (`tiltEffect: 0.8`); the pen bases are upright-pen tools (`0`).
 * - tip/tip-flatness/tip-angle/cap: only fountain (flat stub nib) and
 *   pencil (elliptical nib) vary nib geometry; ball/brush are fixed round.
 * - taper-start: only fountain/brush have a tuned start taper (ball/pencil
 *   start at full width); taper-end is tuned nonzero for all four.
 *
 * Emission only: `executeSurfaceToolSettingsControl` still routes every
 * field so stale clients/snapshots degrade to a working write instead of
 * a silent drop.
 */
type BrushAdvancedField =
  | 'pressure'
  | 'pressure-min'
  | 'pressure-max'
  | 'stabilization'
  | 'streamline'
  | 'velocity-pressure'
  | 'tilt-effect'
  | 'tip-flatness'
  | 'tip-angle'
  | 'taper-start'
  | 'taper-end'
  | 'tip'
  | 'cap';

const BRUSH_ADVANCED_SUPPORT: Record<
  InkPresetToolId,
  readonly BrushAdvancedField[]
> = {
  pen: [
    'pressure',
    'pressure-min',
    'pressure-max',
    'stabilization',
    'streamline',
    'taper-end',
  ],
  fountain: [
    'pressure',
    'pressure-min',
    'pressure-max',
    'stabilization',
    'streamline',
    'taper-start',
    'taper-end',
    'tip',
    'tip-flatness',
    'tip-angle',
    'cap',
  ],
  brush: [
    'pressure',
    'pressure-min',
    'pressure-max',
    'stabilization',
    'streamline',
    'velocity-pressure',
    'taper-start',
    'taper-end',
  ],
  pencil: [
    'pressure',
    'pressure-min',
    'pressure-max',
    'stabilization',
    'streamline',
    'tilt-effect',
    'taper-end',
    'tip',
    'tip-flatness',
    'tip-angle',
    'cap',
  ],
  highlighter: [],
};

const SIZE_LABELS = ['Thin', 'Medium', 'Thick'] as const;

/** 0–100 slider value ↔ pressure curve (base 0.5, full-scale 3.0). */
const PRESSURE_BASE = 0.5;
const PRESSURE_SCALE = 2.5;

function activeSettingsKey(
  host: SurfaceToolSettingsHost,
): SettingsToolKey | null {
  // Settled-first: the schema follows the same
  // settled tool as draw `active` and style values, so a held temporary
  // tool never swaps the slot editor underneath the active slot and edits
  // route to the settled preset. Hosts without a temporary seam omit the
  // method and fall back to the live tool (settled by construction).
  const id = host.settledActiveToolId?.() ?? host.activeToolId();
  const segment = id.slice(id.lastIndexOf('.') + 1);
  if (segment === 'eraser' || segment === 'lasso') return segment;
  if (segment === 'line') return 'line';
  if (['rect', 'ellipse', 'triangle', 'diamond'].includes(segment))
    return 'shape';
  for (const tool of DRAW_TOOLS) {
    if (segment === TOOL_SEGMENTS[tool]) return tool;
  }
  return null;
}

/**
 * Slot family for the active (settled) tool.
 *
 * Pen-family tools resolve `'pen'` (one shared slot set), the
 * highlighter resolves `'highlighter'` (independent set); eraser, lasso,
 * line, select, and unknown tools resolve `null` (no size/color slots).
 * Settled-first like `activeSettingsKey`: a held temporary tool never
 * flips the slot scope mid-gesture.
 */
export function activeSlotFamily(
  host: Pick<SurfaceToolSettingsHost, 'activeToolId' | 'settledActiveToolId'>,
): InkSlotFamily | null {
  const key = activeSettingsKey(host as SurfaceToolSettingsHost);
  if (
    key === null ||
    key === 'eraser' ||
    key === 'lasso' ||
    key === 'line' ||
    key === 'shape'
  )
    return null;
  return inkSlotFamilyForTool(key);
}

function pressureValue(preset: InkToolPreset, kind: InkBrushKind): number {
  const base = brushPresetForKind(kind).pressure;
  const override = preset.brush?.pressure;
  const enabled = override?.enabled ?? base.enabled;
  if (!enabled) return 0;
  const curve =
    typeof override?.curve === 'number' && Number.isFinite(override.curve)
      ? override.curve
      : base.curve;
  return Math.round(((curve - PRESSURE_BASE) / PRESSURE_SCALE) * 100);
}

function percentValue(override: number | undefined, base: number): number {
  const value =
    typeof override === 'number' && Number.isFinite(override) ? override : base;
  return Math.round(value * 100);
}

function clampPercent(raw: number): number {
  return Math.min(Math.max(raw, 0), 100);
}

function sizeOptions(widths: readonly number[]): {
  readonly value: string;
  readonly label: string;
}[] {
  return widths.map((width, index) => ({
    value: String(width),
    label: index < SIZE_LABELS.length ? SIZE_LABELS[index]! : `${width} pt`,
  }));
}

function colorOptions(
  host: SurfaceToolSettingsHost,
  options: SurfaceToolSettingsOptions,
): string[] {
  const merged = [...host.recentColors(), ...options.swatches];
  return merged.filter((color, index) => merged.indexOf(color) === index);
}

function drawControls(
  host: SurfaceToolSettingsHost,
  options: SurfaceToolSettingsOptions,
  group: string,
  tool: InkPresetToolId,
): DocumentToolControl[] {
  const kind = KIND_OF_TOOL[tool];
  const base = brushPresetForKind(kind);
  // `tool` is the settled settings key, and the preset's
  // color/size are the family's converged live values — every pen-family
  // schema shows the same pair, the highlighter its own. Advanced tuning
  // below stays per-tool.
  const preset = host.toolPreset(tool);
  const key = TOOL_SEGMENTS[tool];
  const color: DocumentToolControl = {
    kind: 'color',
    id: `${options.prefix}.settings.${key}.color`,
    group,
    label: 'Color',
    value: preset.color ?? base.color,
    options: colorOptions(host, options),
    semanticRole: 'surface.settings.color',
  };
  const size: DocumentToolControl = {
    kind: 'choice',
    id: `${options.prefix}.settings.${key}.size`,
    group,
    label: 'Size',
    value: String(preset.size ?? base.size),
    options: sizeOptions(options.widths),
    semanticRole: 'surface.settings.size',
  };
  const styleControls = savedStyleControls(host, options, group, tool);
  if (tool === 'highlighter') {
    const opacity: DocumentToolControl = {
      kind: 'range',
      id: `${options.prefix}.settings.${key}.opacity`,
      group,
      label: 'Opacity',
      value: percentValue(preset.opacity, base.opacity),
      min: 10,
      max: 100,
      step: 1,
    };
    const straight: DocumentToolControl = {
      kind: 'button',
      id: `${options.prefix}.settings.${key}.straight`,
      group,
      label: 'Straight-line hold',
      shortLabel: 'Straight',
      active: preset.straight === true,
    };
    return [...styleControls, color, size, opacity, straight];
  }
  const brush = preset.brush;
  const type: DocumentToolControl = {
    kind: 'choice',
    id: `${options.prefix}.settings.${key}.type`,
    group,
    label: 'Pen type',
    value: kind,
    options: [
      { value: 'ball', label: 'Ball' },
      { value: 'fountain', label: 'Fountain' },
      { value: 'brush', label: 'Brush' },
      { value: 'pencil', label: 'Pencil' },
    ],
    semanticRole: 'surface.settings.pen-type',
  };
  const range = (
    field:
      | 'pressure'
      | 'pressure-min'
      | 'pressure-max'
      | 'stabilization'
      | 'streamline'
      | 'tilt-effect'
      | 'tip-flatness'
      | 'tip-angle'
      | 'taper-start'
      | 'taper-end',
    label: string,
    value: number,
  ): DocumentToolControl => ({
    kind: 'range',
    id: `${options.prefix}.settings.${key}.${field}`,
    group,
    label,
    value,
    min: 0,
    max: 100,
    step: 1,
  });
  const tip: DocumentToolControl = {
    kind: 'choice',
    id: `${options.prefix}.settings.${key}.tip`,
    group,
    label: 'Tip',
    value: brush?.tip?.shape ?? base.tip.shape,
    options: [
      { value: 'round', label: 'Round' },
      { value: 'flat', label: 'Flat' },
      { value: 'ellipse', label: 'Ellipse' },
    ],
  };
  const controls: DocumentToolControl[] = [...styleControls, type, size, color];
  const supported = new Set<string>(BRUSH_ADVANCED_SUPPORT[tool]);
  const advanced: DocumentToolControl[] = [];
  const pushAdvanced = (
    field: BrushAdvancedField,
    control: DocumentToolControl,
  ): void => {
    if (supported.has(field)) advanced.push(control);
  };
  pushAdvanced(
    'pressure',
    range('pressure', 'Pressure response', pressureValue(preset, kind)),
  );
  pushAdvanced(
    'pressure-min',
    range(
      'pressure-min',
      'Pressure minimum',
      percentValue(brush?.pressure?.minFactor, base.pressure.minFactor) / 3,
    ),
  );
  pushAdvanced(
    'pressure-max',
    range(
      'pressure-max',
      'Pressure maximum',
      percentValue(brush?.pressure?.maxFactor, base.pressure.maxFactor) / 3,
    ),
  );
  pushAdvanced(
    'stabilization',
    range(
      'stabilization',
      'Stabilization',
      percentValue(brush?.stabilization, base.stabilization),
    ),
  );
  pushAdvanced(
    'streamline',
    range(
      'streamline',
      'Streamline',
      percentValue(brush?.streamline, base.streamline),
    ),
  );
  pushAdvanced('velocity-pressure', {
    kind: 'button',
    id: `${options.prefix}.settings.${key}.velocity-pressure`,
    group,
    label: 'Velocity pressure',
    shortLabel: 'Velocity',
    active: brush?.velocityPressure ?? base.velocityPressure,
  });
  pushAdvanced(
    'tilt-effect',
    range(
      'tilt-effect',
      'Tilt effect',
      percentValue(brush?.tiltEffect, base.tiltEffect),
    ),
  );
  pushAdvanced(
    'tip-flatness',
    range(
      'tip-flatness',
      'Tip flatness',
      Math.round((1 - (brush?.tip?.aspect ?? base.tip.aspect ?? 1)) * 100),
    ),
  );
  pushAdvanced(
    'tip-angle',
    range(
      'tip-angle',
      'Tip angle',
      Math.round(
        (((brush?.tip?.angle ?? base.tip.angle ?? 0) + Math.PI) /
          (Math.PI * 2)) *
          100,
      ),
    ),
  );
  pushAdvanced(
    'taper-start',
    range(
      'taper-start',
      'Taper start',
      percentValue(brush?.taperStart, base.taperStart ?? 0),
    ),
  );
  pushAdvanced(
    'taper-end',
    range(
      'taper-end',
      'Taper end',
      percentValue(brush?.taperEnd, base.taperEnd ?? 0),
    ),
  );
  pushAdvanced('tip', tip);
  pushAdvanced('cap', {
    kind: 'choice',
    id: `${options.prefix}.settings.${key}.cap`,
    group,
    label: 'Cap style',
    value: brush?.tip?.cap ?? base.tip.cap ?? 'round',
    options: [
      { value: 'round', label: 'Round' },
      { value: 'butt', label: 'Flat' },
    ],
  });
  controls.push(...advanced);
  // Pen-gesture toggles (pen tool only: the registry wires gestures to the
  // pen capture tool; other pen-family tools show no gesture controls so no
  // control advertises behavior it cannot trigger).
  if (tool === 'pen' && host.gestures !== undefined) {
    const prefs = host.gestures();
    const toggle = (
      field: 'gesture-draw-hold' | 'gesture-scribble' | 'gesture-circle',
      label: string,
      shortLabel: string,
      active: boolean,
    ): DocumentToolControl => ({
      kind: 'button',
      id: `${options.prefix}.settings.pen.${field}`,
      group,
      label,
      shortLabel,
      active,
    });
    controls.push(
      toggle(
        'gesture-draw-hold',
        'Draw-and-hold shapes',
        'Hold shapes',
        prefs.drawAndHold === true,
      ),
      toggle(
        'gesture-scribble',
        'Scribble to erase',
        'Scribble',
        prefs.scribbleErase === true,
      ),
      toggle(
        'gesture-circle',
        'Circle for lasso',
        'Circle lasso',
        prefs.circleLasso === true,
      ),
    );
  }
  return controls;
}

function copyPresetForCard(preset: InkToolPreset): SavedStylePresetData {
  const out: Record<string, unknown> = {};
  if (typeof preset.color === 'string' && preset.color.trim() !== '')
    out.color = preset.color;
  if (typeof preset.size === 'number' && Number.isFinite(preset.size))
    out.size = preset.size;
  if (typeof preset.opacity === 'number' && Number.isFinite(preset.opacity))
    out.opacity = preset.opacity;
  const brush = preset.brush;
  if (brush !== undefined && typeof brush === 'object') {
    const copy: Record<string, unknown> = {};
    if (typeof brush.kind === 'string') copy.kind = brush.kind;
    if (typeof brush.color === 'string') copy.color = brush.color;
    if (typeof brush.size === 'number' && Number.isFinite(brush.size))
      copy.size = brush.size;
    if (typeof brush.opacity === 'number' && Number.isFinite(brush.opacity))
      copy.opacity = brush.opacity;
    if (brush.pressure !== undefined && typeof brush.pressure === 'object') {
      const p = brush.pressure;
      const pressure: Record<string, unknown> = {};
      if (typeof p.enabled === 'boolean') pressure.enabled = p.enabled;
      if (typeof p.minFactor === 'number' && Number.isFinite(p.minFactor))
        pressure.minFactor = p.minFactor;
      if (typeof p.maxFactor === 'number' && Number.isFinite(p.maxFactor))
        pressure.maxFactor = p.maxFactor;
      if (typeof p.curve === 'number' && Number.isFinite(p.curve))
        pressure.curve = p.curve;
      if (Object.keys(pressure).length > 0) copy.pressure = pressure;
    }
    if (
      typeof brush.stabilization === 'number' &&
      Number.isFinite(brush.stabilization)
    )
      copy.stabilization = brush.stabilization;
    if (
      typeof brush.streamline === 'number' &&
      Number.isFinite(brush.streamline)
    )
      copy.streamline = brush.streamline;
    if (typeof brush.velocityPressure === 'boolean')
      copy.velocityPressure = brush.velocityPressure;
    if (
      typeof brush.tiltEffect === 'number' &&
      Number.isFinite(brush.tiltEffect)
    )
      copy.tiltEffect = brush.tiltEffect;
    if (
      typeof brush.taperStart === 'number' &&
      Number.isFinite(brush.taperStart)
    )
      copy.taperStart = brush.taperStart;
    if (typeof brush.taperEnd === 'number' && Number.isFinite(brush.taperEnd))
      copy.taperEnd = brush.taperEnd;
    if (brush.tip !== undefined && typeof brush.tip === 'object') {
      const tip: Record<string, unknown> = {};
      if (
        brush.tip.shape === 'round' ||
        brush.tip.shape === 'flat' ||
        brush.tip.shape === 'ellipse'
      )
        tip.shape = brush.tip.shape;
      if (
        typeof brush.tip.angle === 'number' &&
        Number.isFinite(brush.tip.angle)
      )
        tip.angle = brush.tip.angle;
      if (
        typeof brush.tip.aspect === 'number' &&
        Number.isFinite(brush.tip.aspect)
      )
        tip.aspect = brush.tip.aspect;
      if (brush.tip.cap === 'round' || brush.tip.cap === 'butt')
        tip.cap = brush.tip.cap;
      if (Object.keys(tip).length > 0) copy.tip = tip;
    }
    if (Object.keys(copy).length > 0) out.brush = copy;
  }
  return out as SavedStylePresetData;
}

function savedStyleControls(
  host: SurfaceToolSettingsHost,
  options: SurfaceToolSettingsOptions,
  group: string,
  tool: InkPresetToolId,
): DocumentToolControl[] {
  if (host.savedStyles === undefined || host.currentStyleId === undefined)
    return [];
  const styles = host.savedStyles(tool);
  const current = host.currentStyleId(tool);
  const cardData: readonly SavedStyleCardData[] = styles.map((style) => ({
    id: style.id,
    name: style.name,
    toolKind: style.toolKind,
    favorite: style.favorite,
    preset: copyPresetForCard(style.preset),
  }));
  const modified = host.savedStyleModified?.(tool) === true;
  const workingPreset = copyPresetForCard(host.toolPreset(tool));
  const controls: DocumentToolControl[] = [
    {
      kind: 'choice',
      id: `${options.prefix}.settings.${tool}.saved-style`,
      group,
      label: 'Saved styles',
      value: current ?? '',
      options: [
        { value: '', label: 'Working style' },
        ...styles.map((style) => ({
          value: style.id,
          label: `${style.favorite ? 'Favorite · ' : ''}${style.name}, ${style.preset.color ?? 'default color'}, ${style.preset.size ?? 'default'} pt`,
        })),
      ],
      semanticRole: 'surface.style.saved',
      savedStyles: cardData,
      savedStyleModified: modified,
      workingPreset,
    },
    {
      kind: 'input',
      id: `${options.prefix}.settings.${tool}.save-style`,
      group,
      label: 'Style name',
      placeholder: 'Style name',
      actionLabel: 'Save as new',
      semanticRole: 'surface.settings.save-style',
    },
  ];
  if (current !== null) {
    const selected = styles.find((style) => style.id === current);
    controls.push({
      kind: 'input',
      id: `${options.prefix}.settings.${tool}.rename-style`,
      group,
      label: 'Rename saved style',
      value: selected?.name,
      actionLabel: 'Rename',
    });
    controls.push({
      kind: 'button',
      id: `${options.prefix}.settings.${tool}.favorite-style`,
      group,
      label:
        selected?.favorite === true
          ? 'Remove from favorites'
          : 'Add to favorites',
      shortLabel: selected?.favorite === true ? 'Unfavorite' : 'Favorite',
      active: selected?.favorite === true,
    });
    const position = styles.findIndex((style) => style.id === current);
    controls.push({
      kind: 'button',
      id: `${options.prefix}.settings.${tool}.move-style-earlier`,
      group,
      label: 'Move saved style earlier',
      shortLabel: 'Move earlier',
      disabled: position <= 0,
    });
    controls.push({
      kind: 'button',
      id: `${options.prefix}.settings.${tool}.move-style-later`,
      group,
      label: 'Move saved style later',
      shortLabel: 'Move later',
      disabled: position < 0 || position === styles.length - 1,
    });
    controls.push({
      kind: 'button',
      id: `${options.prefix}.settings.${tool}.update-style`,
      group,
      label:
        host.savedStyleModified?.(tool) === true
          ? 'Update modified preset'
          : 'Update preset',
      shortLabel: 'Update preset',
      disabled: host.savedStyleModified?.(tool) !== true,
    });
    controls.push({
      kind: 'button',
      id: `${options.prefix}.settings.${tool}.delete-style`,
      group,
      label: 'Delete saved style',
      shortLabel: 'Delete',
    });
    controls.push({
      kind: 'button',
      id: `${options.prefix}.settings.${tool}.reset-style`,
      group,
      label: 'Reset working style to saved preset',
      shortLabel: 'Reset',
      disabled: host.savedStyleModified?.(tool) !== true,
    });
  }
  return controls;
}

const FILTER_LABELS: Record<EraserFilter, string> = {
  all: 'All',
  ink: 'Ink',
  highlighter: 'Highlighter',
  shapes: 'Shapes',
  images: 'Images',
  text: 'Text',
};

function eraserControls(
  host: SurfaceToolSettingsHost,
  options: SurfaceToolSettingsOptions,
  group: string,
): DocumentToolControl[] {
  // Stroke removes the whole touched stroke regardless of radius. Only
  // Precision exposes a size; both modes retain filter and auto-return.
  const preset = host.eraserPreset();
  return [
    ...(preset.mode === 'precision'
      ? [
          {
            kind: 'range',
            id: `${options.prefix}.settings.eraser.radius`,
            group,
            label: 'Eraser size',
            value: preset.radius ?? 12,
            min: options.eraserMin ?? 2,
            max: options.eraserMax ?? 40,
            step: options.eraserStep ?? 1,
            semanticRole: 'surface.settings.eraser-size',
          } as const,
        ]
      : []),
    {
      kind: 'choice',
      id: `${options.prefix}.settings.eraser.filter`,
      group,
      label: 'Erase content',
      value: preset.filter ?? 'all',
      options: ERASER_FILTERS.map((filter) => ({
        value: filter,
        label: FILTER_LABELS[filter],
      })),
      semanticRole: 'surface.settings.eraser-filter',
    },
    {
      kind: 'button',
      id: `${options.prefix}.settings.eraser.auto-return`,
      group,
      label: 'Return to previous tool',
      shortLabel: 'Auto-return',
      active: preset.autoReturn === true,
      semanticRole: 'surface.settings.eraser-auto-return',
    },
  ];
}

function lassoControls(
  host: SurfaceToolSettingsHost,
  options: SurfaceToolSettingsOptions,
  group: string,
): DocumentToolControl[] {
  const preset = host.lassoPreset();
  return [
    {
      kind: 'choice',
      id: `${options.prefix}.settings.lasso.mode`,
      group,
      label: 'Lasso mode',
      value: preset.mode ?? 'freehand',
      options: LASSO_MODES.map((mode) => ({
        value: mode,
        label: mode === 'freehand' ? 'Freehand' : 'Rectangle',
      })),
      semanticRole: 'surface.settings.lasso-mode',
    },
    {
      kind: 'choice',
      id: `${options.prefix}.settings.lasso.filter`,
      group,
      label: 'Select content',
      value: preset.filter ?? 'all',
      options: ERASER_FILTERS.map((filter) => ({
        value: filter,
        label: FILTER_LABELS[filter],
      })),
      semanticRole: 'surface.settings.lasso-filter',
    },
  ];
}

function shapeStyleControls(
  host: SurfaceToolSettingsHost,
  options: SurfaceToolSettingsOptions,
  group: string,
): DocumentToolControl[] {
  const preset = host.toolPreset('pen');
  return [
    {
      kind: 'color',
      id: `${options.prefix}.settings.shape.color`,
      group,
      label: 'Shape color',
      semanticRole: 'surface.settings.color',
      slotFamily: 'pen',
      value: preset.color ?? '#37352f',
      options: options.swatches,
    },
    {
      kind: 'choice',
      id: `${options.prefix}.settings.shape.width`,
      group,
      label: 'Border width',
      semanticRole: 'surface.settings.size',
      slotFamily: 'pen',
      value: String(preset.size ?? 2),
      options: options.widths.map((width) => ({
        value: String(width),
        label: `${width} px`,
      })),
    },
  ];
}

function lineControls(
  host: SurfaceToolSettingsHost,
  options: SurfaceToolSettingsOptions,
  group: string,
): DocumentToolControl[] {
  if (host.lineArrows === undefined) return [];
  return [
    {
      kind: 'choice',
      id: `${options.prefix}.settings.line.arrows`,
      group,
      label: 'Arrowheads',
      semanticRole: 'surface.shape.arrows',
      value: host.lineArrows(),
      options: [
        { value: 'none', label: 'None' },
        { value: 'start', label: 'Start' },
        { value: 'end', label: 'End' },
        { value: 'both', label: 'Both' },
      ],
    },
  ];
}

/**
 * Property controls for the active tool. Pen-family tools expose type,
 * size, color, plus the conditional advanced subset with real engine
 * semantics for that family (`BRUSH_ADVANCED_SUPPORT`); the highlighter
 * exposes color, size, opacity, and straight-line hold; the eraser
 * exposes radius, filter, and auto-return, with no mode
 * dropdown — the mode is fixed per toolbar tool); the lasso exposes mode
 * and filter. Select and unknown tools yield nothing.
 */
export function buildActiveToolSettingsControls(
  host: SurfaceToolSettingsHost,
  options: SurfaceToolSettingsOptions,
): DocumentToolControl[] {
  const group = options.group ?? 'settings';
  const key = activeSettingsKey(host);
  if (key === null) return [];
  if (key === 'eraser') return eraserControls(host, options, group);
  if (key === 'lasso') return lassoControls(host, options, group);
  if (key === 'line')
    return [
      ...shapeStyleControls(host, options, group),
      ...lineControls(host, options, group),
    ];
  if (key === 'shape')
    return [
      ...shapeStyleControls(host, options, group),
      {
        kind: 'number',
        id: `${options.prefix}.settings.shape.radius`,
        group,
        label: 'Corner radius',
        semanticRole: 'surface.shape.radius',
        value: host.cornerRadius?.() ?? 0,
        min: 0,
        max: 200,
        step: 1,
        suffix: 'px',
        disabled: host.activeToolId().endsWith('.ellipse'),
      },
      {
        kind: 'choice',
        id: `${options.prefix}.settings.shape.appearance`,
        group,
        label: 'Shape fill',
        semanticRole: 'surface.shape.appearance',
        value: host.shapeAppearance?.() ?? 'fill',
        options: [
          { value: 'fill', label: 'Filled' },
          { value: 'outline', label: 'No fill' },
        ],
      },
    ];
  return drawControls(host, options, group, key);
}

function readNumber(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function isEraserFilter(value: string): value is EraserFilter {
  return (ERASER_FILTERS as readonly string[]).includes(value);
}

function isLassoMode(value: string): value is LassoMode {
  return (LASSO_MODES as readonly string[]).includes(value);
}

/**
 * Route one settings control action. Toggle buttons (straight-line
 * hold, eraser auto-return) flip on activation and ignore `value`;
 * every other control requires a valid `value`. Unknown ids, fields,
 * tools, and values return false without touching the host.
 *
 *  card extension (backward compatible): `favorite-style` and
 * `delete-style` accept an optional style id as `value` to target a
 * non-selected card directly (visual cards star/delete any card without
 * forcing a selection change). Absent/empty `value` preserves the legacy
 * current-style behavior for the generic form renderer.
 */
export function executeSurfaceToolSettingsControl(
  host: SurfaceToolSettingsHost,
  options: SurfaceToolSettingsOptions,
  id: string,
  value?: string,
): boolean {
  const rest = id.startsWith(`${options.prefix}.settings.`)
    ? id.slice(`${options.prefix}.settings.`.length)
    : null;
  if (rest === null) return false;
  const dot = rest.indexOf('.');
  if (dot < 0) return false;
  const toolKey = rest.slice(0, dot);
  const field = rest.slice(dot + 1);
  if (toolKey === 'shape') {
    if (
      field === 'radius' &&
      value !== undefined &&
      Number.isFinite(Number(value)) &&
      Number(value) >= 0
    ) {
      host.setCornerRadius?.(Number(value));
      return true;
    }
    if (field === 'appearance' && (value === 'fill' || value === 'outline')) {
      host.setShapeAppearance?.(value);
      return true;
    }
    if (field === 'color' && value) {
      host.setToolPreset('pen', { color: value });
      return true;
    }
    if (field === 'width' && Number(value) > 0) {
      host.setToolPreset('pen', { size: Number(value) });
      return true;
    }
    return false;
  }
  if (
    toolKey !== 'pen' &&
    toolKey !== 'fountain' &&
    toolKey !== 'brush' &&
    toolKey !== 'pencil' &&
    toolKey !== 'highlighter' &&
    toolKey !== 'eraser' &&
    toolKey !== 'lasso' &&
    toolKey !== 'line'
  ) {
    return false;
  }
  const tool = toolKey as SettingsToolKey;
  if (tool === 'eraser') return executeEraser(host, field, value);
  if (tool === 'lasso') return executeLasso(host, field, value);
  if (tool === 'line') {
    if (
      field !== 'arrows' ||
      (value !== 'none' &&
        value !== 'start' &&
        value !== 'end' &&
        value !== 'both')
    ) {
      return false;
    }
    if (host.setLineArrows === undefined) return false;
    host.setLineArrows(value);
    return true;
  }
  if (tool === 'shape') return false;
  return executeDraw(host, tool, field, value);
}

function executeDraw(
  host: SurfaceToolSettingsHost,
  tool: InkPresetToolId,
  field: string,
  value: string | undefined,
): boolean {
  if (field === 'saved-style') {
    return (
      value !== undefined &&
      value !== '' &&
      host.applySavedStyle?.(value) === true
    );
  }
  if (field === 'save-style') {
    return value !== undefined && host.saveCurrentStyle?.(tool, value) != null;
  }
  if (field === 'update-style') {
    const id = host.currentStyleId?.(tool);
    return id != null && host.updateSavedStyle?.(id) === true;
  }
  if (field === 'rename-style') {
    const id = host.currentStyleId?.(tool);
    return (
      id != null &&
      value !== undefined &&
      host.renameSavedStyle?.(id, value) === true
    );
  }
  if (field === 'favorite-style') {
    const styles = host.savedStyles?.(tool) ?? [];
    // Card path: explicit style id toggles that card without reselecting.
    if (value !== undefined && value !== '') {
      const target = styles.find((style) => style.id === value);
      if (target === undefined) return false;
      return host.favoriteSavedStyle?.(value, !target.favorite) === true;
    }
    const id = host.currentStyleId?.(tool);
    const selected = styles.find((style) => style.id === id);
    return (
      id != null &&
      selected !== undefined &&
      host.favoriteSavedStyle?.(id, !selected.favorite) === true
    );
  }
  if (field === 'move-style-earlier' || field === 'move-style-later') {
    const id = host.currentStyleId?.(tool);
    const ids = host.savedStyles?.(tool).map((style) => style.id) ?? [];
    const from = id == null ? -1 : ids.indexOf(id);
    const to = field === 'move-style-earlier' ? from - 1 : from + 1;
    if (from < 0 || to < 0 || to >= ids.length) return false;
    [ids[from], ids[to]] = [ids[to]!, ids[from]!];
    return host.reorderSavedStyles?.(tool, ids) === true;
  }
  if (field === 'delete-style') {
    // Card path: explicit style id deletes that card without reselecting.
    if (value !== undefined && value !== '') {
      const exists = host
        .savedStyles?.(tool)
        .some((style) => style.id === value);
      if (exists !== true) return false;
      return host.deleteSavedStyle?.(value) === true;
    }
    const id = host.currentStyleId?.(tool);
    return id != null && host.deleteSavedStyle?.(id) === true;
  }
  if (field === 'reset-style') return host.resetSavedStyle?.(tool) === true;
  if (field === 'type') {
    if (
      value !== 'ball' &&
      value !== 'fountain' &&
      value !== 'brush' &&
      value !== 'pencil'
    ) {
      return false;
    }
    const active = host.activeToolId();
    const base = active.slice(0, active.lastIndexOf('.') + 1);
    host.setTool(`${base}${TYPE_SEGMENTS[value]}`);
    return true;
  }
  if (field === 'size') {
    const size = readNumber(value);
    if (size === null || size <= 0) return false;
    // Family write: the preset store fans this out inside the
    // tool's family, so a stale popover writing its own tool key still
    // lands on the shared pair.
    host.setToolPreset(tool, { size });
    return true;
  }
  if (field === 'color') {
    if (value === undefined || value.trim() === '') return false;
    // Same family-write contract as `size` above.
    host.setToolPreset(tool, { color: value });
    return true;
  }
  if (tool === 'highlighter') {
    if (field === 'opacity') {
      const percent = readNumber(value);
      if (percent === null) return false;
      host.setToolPreset(tool, {
        opacity: clampPercent(percent) / 100,
      });
      return true;
    }
    if (field === 'straight') {
      const current = host.toolPreset(tool).straight === true;
      host.setToolPreset(tool, { straight: !current });
      return true;
    }
    return false;
  }
  if (field === 'pressure') {
    const percent = readNumber(value);
    if (percent === null) return false;
    const clamped = clampPercent(percent);
    host.setToolPreset(tool, {
      brush: {
        pressure:
          clamped === 0
            ? { enabled: false }
            : {
                enabled: true,
                curve: PRESSURE_BASE + (clamped / 100) * PRESSURE_SCALE,
              },
      },
    });
    return true;
  }
  if (field === 'pressure-min' || field === 'pressure-max') {
    const percent = readNumber(value);
    if (percent === null) return false;
    const key = field === 'pressure-min' ? 'minFactor' : 'maxFactor';
    host.setToolPreset(tool, {
      brush: { pressure: { [key]: (clampPercent(percent) / 100) * 3 } },
    });
    return true;
  }
  if (field === 'velocity-pressure') {
    const current =
      host.toolPreset(tool).brush?.velocityPressure ??
      brushPresetForKind(KIND_OF_TOOL[tool]).velocityPressure;
    host.setToolPreset(tool, { brush: { velocityPressure: !current } });
    return true;
  }
  if (
    field === 'tilt-effect' ||
    field === 'tip-flatness' ||
    field === 'tip-angle'
  ) {
    const percent = readNumber(value);
    if (percent === null) return false;
    const normalized = clampPercent(percent) / 100;
    if (field === 'tilt-effect')
      host.setToolPreset(tool, { brush: { tiltEffect: normalized } });
    else if (field === 'tip-flatness')
      host.setToolPreset(tool, { brush: { tip: { aspect: 1 - normalized } } });
    else
      host.setToolPreset(tool, {
        brush: { tip: { angle: normalized * Math.PI * 2 - Math.PI } },
      });
    return true;
  }
  const brushField =
    field === 'stabilization'
      ? 'stabilization'
      : field === 'streamline'
        ? 'streamline'
        : field === 'taper-start'
          ? 'taperStart'
          : field === 'taper-end'
            ? 'taperEnd'
            : null;
  if (brushField !== null) {
    const percent = readNumber(value);
    if (percent === null) return false;
    host.setToolPreset(tool, {
      brush: { [brushField]: clampPercent(percent) / 100 },
    });
    return true;
  }
  if (field === 'tip') {
    if (value !== 'round' && value !== 'flat' && value !== 'ellipse') {
      return false;
    }
    host.setToolPreset(tool, { brush: { tip: { shape: value } } });
    return true;
  }
  if (field === 'cap') {
    if (value !== 'round' && value !== 'butt') return false;
    host.setToolPreset(tool, { brush: { tip: { cap: value } } });
    return true;
  }
  // Pen-gesture toggles (pen only): flip on activation, ignore value.
  if (tool === 'pen' && host.setGestures !== undefined) {
    if (field === 'gesture-draw-hold') {
      const current = host.gestures?.().drawAndHold === true;
      host.setGestures({ drawAndHold: !current });
      return true;
    }
    if (field === 'gesture-scribble') {
      const current = host.gestures?.().scribbleErase === true;
      host.setGestures({ scribbleErase: !current });
      return true;
    }
    if (field === 'gesture-circle') {
      const current = host.gestures?.().circleLasso === true;
      host.setGestures({ circleLasso: !current });
      return true;
    }
  }
  return false;
}

function executeEraser(
  host: SurfaceToolSettingsHost,
  field: string,
  value: string | undefined,
): boolean {
  if (field === 'radius') {
    const radius = readNumber(value);
    if (radius === null || radius <= 0) return false;
    host.setEraserPreset({ radius });
    return true;
  }
  // no `mode` route — the mode is fixed per toolbar tool.
  // Legacy `...eraser.mode` writes resolve to false without side effects
  // (stale snapshots degrade to a no-op, never a crash, never a silent
  // write to another preset).
  if (field === 'filter') {
    if (value === undefined || !isEraserFilter(value)) return false;
    host.setEraserPreset({ filter: value });
    return true;
  }
  if (field === 'auto-return') {
    const current = host.eraserPreset().autoReturn === true;
    host.setEraserPreset({ autoReturn: !current });
    return true;
  }
  return false;
}

function executeLasso(
  host: SurfaceToolSettingsHost,
  field: string,
  value: string | undefined,
): boolean {
  if (field === 'mode') {
    if (value === undefined || !isLassoMode(value)) return false;
    host.setLassoPreset({ mode: value });
    return true;
  }
  if (field === 'filter') {
    if (value === undefined || !isEraserFilter(value)) return false;
    host.setLassoPreset({ filter: value });
    return true;
  }
  return false;
}
