/**
 * Stores per-user toolbar order, visibility, and fixed-slot preferences.
 *
 * Preferences overlay immutable defaults and stay in workspace settings,
 * outside canonical document data. Runtime tool memory remains session state.
 * Unknown contribution ids remain dormant so temporarily unavailable plugins
 * do not erase a user's settings.
 */

import type {
  Disposer,
  InkSlotFamily,
  SettingsService,
} from '@froglight/foundation';
import {
  surfaceSlotSwatchesForFamily,
  surfaceSlotWidthsForFamily,
} from '@froglight/foundation';
import {
  slotIdForItem,
  stripGroupIdForCategory,
  type ResolvedToolbarGraph,
  type SlottedToolbarItem,
  type StripGroupedCategory,
} from './composition-registry.js';

/** Storage key for toolbar layout preferences (settings envelope). */
export const TOOLBAR_CUSTOMIZATION_STORAGE_KEY = 'toolbar.customization';
/** Current persisted schema version. Bump with a tolerant loader, never a wipe. */
export const TOOLBAR_CUSTOMIZATION_VERSION = 1 as const;

/**
 * Default fixed-slot counts.
 *
 * The shelf renders exactly these positions per family; empty positions
 * render as fixed-width empty placeholders and never collapse, so muscle
 * memory holds. More live slots than positions overflow to More;
 * fewer live slots pad with `null` placeholders (see
 * `resolveFixedSlotPositions`). Counts are presentation defaults. Persisted
 * orders may include slots that are temporarily unavailable.
 */
export const DEFAULT_SIZE_SLOT_COUNT = 3 as const;
export const DEFAULT_COLOR_SLOT_COUNT = 3 as const;
export const DEFAULT_PEN_SLOT_COUNT = 4 as const;

/**
 * Resolver-ready user overrides. Every field is optional; absent/empty
 * means "follow registry defaults". Ids are stable contribution ids; unknown
 * ids are ignored at resolve time but preserved in storage.
 *
 * Slot fields key on EFFECTIVE slot ids as computed by
 * `slotIdForItem` (explicit `slotId` or, when absent/blank, the item id
 * itself — never guess from labels, icons, or id substrings).
 * defaults adopt concrete `slotId`s add-only; until then callers
 * pass item ids through the same helper and get singleton behavior.
 */
export interface ToolbarLayoutOverrides {
  /** Desired category order (all projections); unlisted keep default order after. */
  readonly categoryOrder?: readonly string[];
  /** Per-category desired item order (normal/compact/selection); unlisted keep default order after. */
  readonly itemOrder?: Readonly<Record<string, readonly string[]>>;
  /** Hidden category ids (all projections; hidden items stay out of `unresolved`). */
  readonly hiddenCategories?: readonly string[];
  /** Hidden item ids (all projections including squeeze; never reported dormant). */
  readonly hiddenItems?: readonly string[];
  /** Desired item order inside each category for the squeeze projection only. */
  readonly squeezeOrder?: readonly string[];
  /** Favorite tool item ids for future quick-shelf slots (presentation-only). */
  readonly favoriteTools?: readonly string[];
  /**
   * Desired order of size-slot effective ids (default 3 positions).
   * Registry order resolves first; this list only re-sorts. Unlisted slots
   * keep registry order after; unknown ids are ignored at resolve time but
   * preserved in storage (dormant-safe: they revive when the contribution
   * returns). Absent/empty means factory order. Never hides: use
   * `hiddenItems` by item id for visibility (dual-hide contract).
   */
  readonly slotSizes?: readonly string[];
  /**
   * Desired order of color-slot effective ids (default 3 positions).
   * Same overlay semantics as `slotSizes`.
   */
  readonly slotColors?: readonly string[];
  /**
   * Desired order of pen-slot effective ids, with four positions by default;
   * each holds pen identity+style independently). Same overlay semantics
   * as `slotSizes`.
   */
  readonly slotPens?: readonly string[];
  /**
   * Per-family size-slot value sets: the three quick
   * widths for the pen family (`slotSizesPen`, shared by
   * pen/fountain/brush/pencil so a pen-family switch keeps the same set)
   * and for the highlighter (`slotSizesHighlighter`, independent).
   * Positional: index N is slot N+1 of the fixed size row. Absent means
   * family defaults (`surfaceSlotWidthsForFamily`); stored lists longer
   * than `SLOT_VALUE_COUNT` truncate at resolve time (storage is not
   * capped at the presentation count, mirroring the order lists).
   */
  readonly slotSizesPen?: readonly number[];
  readonly slotSizesHighlighter?: readonly number[];
  readonly slotSizesEraser?: readonly number[];
  /**
   * Per-family color-slot value sets: same positional
   * semantics as the size sets, defaulting to
   * `surfaceSlotSwatchesForFamily`.
   */
  readonly slotColorsPen?: readonly string[];
  readonly slotColorsHighlighter?: readonly string[];
  readonly slotColorsText?: readonly string[];
}

/**
 * Versioned persisted payload. Unknown top-level fields are preserved
 * verbatim across commits so future schema additions round-trip through
 * old loaders.
 */
export interface ToolbarCustomizationV1 extends ToolbarLayoutOverrides {
  readonly version: 1;
}

const MAX_IDS = 200;
const MAX_ID_LENGTH = 128;

/**
 * Fixed size/color slot positions per family: the value
 * sets resolve to exactly this many entries (stored surplus truncates,
 * short rows pad with family defaults).
 */
export const SLOT_VALUE_COUNT = 3 as const;
/** Storage cap for value sets (forward-compat; presentation truncates). */
const MAX_SLOT_VALUES = 12;
const MAX_COLOR_LENGTH = 64;
/** Sanity cap for a slot width in pt (never a product limit). */
const MAX_SLOT_SIZE = 200;

/** Tolerant per-entry cleaning: corrupt values drop, valid ones survive. */
function cleanSizeList(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: number[] = [];
  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) continue;
    if (entry <= 0 || entry > MAX_SLOT_SIZE) continue;
    out.push(entry);
    if (out.length >= MAX_SLOT_VALUES) break;
  }
  return out;
}

function cleanColorList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const color = entry.trim();
    if (color.length === 0 || color.length > MAX_COLOR_LENGTH) continue;
    out.push(color);
    if (out.length >= MAX_SLOT_VALUES) break;
  }
  return out;
}

/**
 * Resolve one family's size triple: stored values
 * first (truncated to `SLOT_VALUE_COUNT`), short rows padded with the
 * family defaults. Pure structure — never throws, never mutates.
 */
export function resolveSlotSizesForFamily(
  family: InkSlotFamily,
  stored: readonly number[] | undefined,
): readonly [number, number, number] {
  const defaults = surfaceSlotWidthsForFamily(family);
  const out: number[] = [];
  for (let index = 0; index < SLOT_VALUE_COUNT; index += 1) {
    const live = stored?.[index];
    out.push(
      typeof live === 'number' && Number.isFinite(live) && live > 0
        ? live
        : (defaults[index] ?? defaults[defaults.length - 1] ?? 3.5),
    );
  }
  return out as [number, number, number];
}

/** Resolve one family's color triple (same contract as the size sets). */
export function resolveSlotColorsForFamily(
  family: InkSlotFamily,
  stored: readonly string[] | undefined,
): readonly [string, string, string] {
  const defaults = surfaceSlotSwatchesForFamily(family);
  const out: string[] = [];
  for (let index = 0; index < SLOT_VALUE_COUNT; index += 1) {
    const live = stored?.[index];
    out.push(
      typeof live === 'string' && live.trim() !== ''
        ? live
        : (defaults[index] ?? defaults[defaults.length - 1] ?? '#37352f'),
    );
  }
  return out as [string, string, string];
}

function cleanIdList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const id = entry.trim();
    if (id.length === 0 || id.length > MAX_ID_LENGTH || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_IDS) break;
  }
  return out;
}

function cleanItemOrder(value: unknown): Record<string, string[]> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return undefined;
  const out: Record<string, string[]> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const categoryId = key.trim();
    if (categoryId.length === 0 || categoryId.length > MAX_ID_LENGTH) continue;
    const ids = cleanIdList(entry);
    if (ids !== undefined) out[categoryId] = ids;
  }
  return out;
}

const KNOWN_FIELDS = new Set([
  'version',
  'categoryOrder',
  'itemOrder',
  'hiddenCategories',
  'hiddenItems',
  'squeezeOrder',
  'favoriteTools',
  'slotSizes',
  'slotColors',
  'slotPens',
  'slotSizesPen',
  'slotSizesHighlighter',
  'slotSizesEraser',
  'slotColorsPen',
  'slotColorsHighlighter',
  'slotColorsText',
]);

function isEmptyOverrides(value: ToolbarCustomizationV1): boolean {
  return (
    (value.categoryOrder === undefined || value.categoryOrder.length === 0) &&
    (value.itemOrder === undefined ||
      Object.keys(value.itemOrder).length === 0) &&
    (value.hiddenCategories === undefined ||
      value.hiddenCategories.length === 0) &&
    (value.hiddenItems === undefined || value.hiddenItems.length === 0) &&
    (value.squeezeOrder === undefined || value.squeezeOrder.length === 0) &&
    (value.favoriteTools === undefined || value.favoriteTools.length === 0) &&
    (value.slotSizes === undefined || value.slotSizes.length === 0) &&
    (value.slotColors === undefined || value.slotColors.length === 0) &&
    (value.slotPens === undefined || value.slotPens.length === 0) &&
    (value.slotSizesPen === undefined || value.slotSizesPen.length === 0) &&
    (value.slotSizesHighlighter === undefined ||
      value.slotSizesHighlighter.length === 0) &&
    (value.slotSizesEraser === undefined ||
      value.slotSizesEraser.length === 0) &&
    (value.slotColorsPen === undefined || value.slotColorsPen.length === 0) &&
    (value.slotColorsHighlighter === undefined ||
      value.slotColorsHighlighter.length === 0) &&
    (value.slotColorsText === undefined || value.slotColorsText.length === 0)
  );
}

/**
 * Tolerant loader: corrupt/foreign-version/non-object payloads degrade to
 * defaults without throwing, so old or future settings never break startup.
 * Unknown fields are captured separately for verbatim preservation.
 */
export function parseToolbarCustomization(raw: string | undefined): {
  readonly customization: ToolbarCustomizationV1;
  readonly unknownFields: Record<string, unknown>;
} {
  const fallback: ToolbarCustomizationV1 = {
    version: TOOLBAR_CUSTOMIZATION_VERSION,
  };
  if (typeof raw !== 'string' || raw === '') {
    return { customization: fallback, unknownFields: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { customization: fallback, unknownFields: {} };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { customization: fallback, unknownFields: {} };
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== TOOLBAR_CUSTOMIZATION_VERSION) {
    // Foreign-version payloads still degrade to defaults without throwing,
    // but their unknown fields round-trip verbatim so a
    // later commit never drops a future schema's additions.
    const unknownFields: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(record)) {
      if (!KNOWN_FIELDS.has(key)) unknownFields[key] = value;
    }
    return { customization: fallback, unknownFields };
  }
  const customization: Record<string, unknown> = {
    version: TOOLBAR_CUSTOMIZATION_VERSION,
  };
  const categoryOrder = cleanIdList(record.categoryOrder);
  if (categoryOrder !== undefined && categoryOrder.length > 0)
    customization.categoryOrder = categoryOrder;
  const itemOrder = cleanItemOrder(record.itemOrder);
  if (itemOrder !== undefined && Object.keys(itemOrder).length > 0)
    customization.itemOrder = itemOrder;
  for (const field of [
    'hiddenCategories',
    'hiddenItems',
    'squeezeOrder',
    'favoriteTools',
    'slotSizes',
    'slotColors',
    'slotPens',
  ] as const) {
    const ids = cleanIdList(record[field]);
    if (ids !== undefined && ids.length > 0) customization[field] = ids;
  }
  // Per-family value sets: additive v1 fields — old payloads
  // simply omit them (factory defaults), corrupt entries drop
  // individually, and the loader never throws on foreign shapes.
  for (const field of [
    'slotSizesPen',
    'slotSizesHighlighter',
    'slotSizesEraser',
  ] as const) {
    const sizes = cleanSizeList(record[field]);
    if (sizes !== undefined && sizes.length > 0) customization[field] = sizes;
  }
  for (const field of [
    'slotColorsPen',
    'slotColorsHighlighter',
    'slotColorsText',
  ] as const) {
    const colors = cleanColorList(record[field]);
    if (colors !== undefined && colors.length > 0)
      customization[field] = colors;
  }
  const unknownFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!KNOWN_FIELDS.has(key)) unknownFields[key] = value;
  }
  return {
    customization: customization as unknown as ToolbarCustomizationV1,
    unknownFields,
  };
}

/**
 * User toolbar customization preferences over the shared settings service.
 * Memory-only without a service (tests/headless); persisted as one JSON
 * string otherwise. Introducing this key never disturbs other settings:
 * every other key round-trips untouched, and absent/corrupt payloads read
 * as defaults until the user explicitly changes something.
 */
export class ToolbarCustomizationStore {
  readonly #settings: SettingsService | null;
  #customization: ToolbarCustomizationV1;
  #unknownFields: Record<string, unknown>;
  readonly #listeners = new Set<() => void>();
  readonly #subscription: Disposer | null;
  #committing = false;
  #disposed = false;

  constructor(options: { readonly settings?: SettingsService } = {}) {
    this.#settings = options.settings ?? null;
    const parsed = parseToolbarCustomization(
      this.#settings?.get(TOOLBAR_CUSTOMIZATION_STORAGE_KEY) as
        | string
        | undefined,
    );
    this.#customization = parsed.customization;
    this.#unknownFields = parsed.unknownFields;
    this.#subscription =
      this.#settings?.onChange((key) => {
        if (this.#disposed || this.#committing) return;
        if (key !== TOOLBAR_CUSTOMIZATION_STORAGE_KEY) return;
        const next = parseToolbarCustomization(
          this.#settings?.get(TOOLBAR_CUSTOMIZATION_STORAGE_KEY) as
            | string
            | undefined,
        );
        this.#customization = next.customization;
        this.#unknownFields = next.unknownFields;
        this.#listeners.forEach((listener) => listener());
      }) ?? null;
  }

  /** Current preferences (fresh object and fresh arrays per call; unknown fields excluded). */
  snapshot(): ToolbarCustomizationV1 {
    const out: Record<string, unknown> = {
      version: TOOLBAR_CUSTOMIZATION_VERSION,
    };
    const copyList = (ids: readonly string[] | undefined): string[] | null =>
      ids !== undefined ? [...ids] : null;
    for (const field of [
      'categoryOrder',
      'hiddenCategories',
      'hiddenItems',
      'squeezeOrder',
      'favoriteTools',
      'slotSizes',
      'slotColors',
      'slotPens',
    ] as const) {
      const copied = copyList(this.#customization[field]);
      if (copied !== null) out[field] = copied;
    }
    for (const field of [
      'slotSizesPen',
      'slotSizesHighlighter',
      'slotSizesEraser',
      'slotColorsPen',
      'slotColorsHighlighter',
      'slotColorsText',
    ] as const) {
      const stored = this.#customization[field];
      if (stored !== undefined) out[field] = [...stored];
    }
    if (this.#customization.itemOrder !== undefined) {
      out.itemOrder = Object.fromEntries(
        Object.entries(this.#customization.itemOrder).map(([key, ids]) => [
          key,
          [...ids],
        ]),
      );
    }
    return out as unknown as ToolbarCustomizationV1;
  }

  /** Resolver-ready override view (fresh arrays per call); `{}` when the user customized nothing. */
  overrides(): ToolbarLayoutOverrides {
    if (isEmptyOverrides(this.#customization)) return {};
    const out: Record<string, unknown> = {};
    const copyList = (ids: readonly string[] | undefined): string[] | null =>
      ids !== undefined ? [...ids] : null;
    for (const field of [
      'categoryOrder',
      'hiddenCategories',
      'hiddenItems',
      'squeezeOrder',
      'favoriteTools',
      'slotSizes',
      'slotColors',
      'slotPens',
    ] as const) {
      const copied = copyList(this.#customization[field]);
      if (copied !== null) out[field] = copied;
    }
    for (const field of [
      'slotSizesPen',
      'slotSizesHighlighter',
      'slotSizesEraser',
      'slotColorsPen',
      'slotColorsHighlighter',
      'slotColorsText',
    ] as const) {
      const stored = this.#customization[field];
      if (stored !== undefined) out[field] = [...stored];
    }
    if (
      this.#customization.itemOrder !== undefined &&
      Object.keys(this.#customization.itemOrder).length > 0
    ) {
      out.itemOrder = Object.fromEntries(
        Object.entries(this.#customization.itemOrder).map(([key, ids]) => [
          key,
          [...ids],
        ]),
      );
    }
    return out as unknown as ToolbarLayoutOverrides;
  }

  setCategoryOrder(ids: readonly string[]): void {
    this.#replace({ categoryOrder: cleanIdList([...ids]) ?? [] });
  }

  setItemOrder(categoryId: string, ids: readonly string[]): void {
    const cleanCategory = categoryId.trim();
    if (cleanCategory.length === 0) return;
    const next = { ...(this.#customization.itemOrder ?? {}) };
    const cleaned = cleanIdList([...ids]) ?? [];
    if (cleaned.length === 0) delete next[cleanCategory];
    else next[cleanCategory] = cleaned;
    this.#replace(
      Object.keys(next).length > 0
        ? { itemOrder: next }
        : { itemOrder: undefined },
    );
  }

  setHiddenCategories(ids: readonly string[]): void {
    this.#replace({ hiddenCategories: cleanIdList([...ids]) ?? [] });
  }

  setHiddenItems(ids: readonly string[]): void {
    this.#replace({ hiddenItems: cleanIdList([...ids]) ?? [] });
  }

  setSqueezeOrder(ids: readonly string[]): void {
    this.#replace({ squeezeOrder: cleanIdList([...ids]) ?? [] });
  }

  setFavoriteTools(ids: readonly string[]): void {
    this.#replace({ favoriteTools: cleanIdList([...ids]) ?? [] });
  }

  setSlotSizes(ids: readonly string[]): void {
    this.#replace({ slotSizes: cleanIdList([...ids]) ?? [] });
  }

  setSlotColors(ids: readonly string[]): void {
    this.#replace({ slotColors: cleanIdList([...ids]) ?? [] });
  }

  setSlotPens(ids: readonly string[]): void {
    this.#replace({ slotPens: cleanIdList([...ids]) ?? [] });
  }

  /**
   * Resolved size triple for one slot family: stored
   * values first, family defaults padding short rows. Fresh array per
   * call; pen-family tools share the `'pen'` set.
   */
  slotSizesForFamily(family: InkSlotFamily): readonly [number, number, number] {
    const field =
      family === 'highlighter' ? 'slotSizesHighlighter' : 'slotSizesPen';
    return resolveSlotSizesForFamily(family, this.#customization[field]);
  }

  /** Precision Eraser size presets, independent from pen widths. */
  slotSizesForEraser(): readonly [number, number, number] {
    const defaults = [4, 12, 28] as const;
    const stored = this.#customization.slotSizesEraser;
    return defaults.map((fallback, index) => {
      const value = stored?.[index];
      return typeof value === 'number' && value >= 2 && value <= 40
        ? value
        : fallback;
    }) as [number, number, number];
  }

  setEraserSlotSizeAt(index: number, value: number): boolean {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= SLOT_VALUE_COUNT ||
      !Number.isFinite(value) ||
      value < 2 ||
      value > 40
    )
      return false;
    const next = [...this.slotSizesForEraser()];
    next[index] = value;
    this.#replace({ slotSizesEraser: next });
    return true;
  }

  /** Resolved color triple for one slot family (same contract as sizes). */
  slotColorsForFamily(
    family: InkSlotFamily,
  ): readonly [string, string, string] {
    const field =
      family === 'highlighter' ? 'slotColorsHighlighter' : 'slotColorsPen';
    return resolveSlotColorsForFamily(family, this.#customization[field]);
  }

  /** Three text colors, independent from drawing presets. */
  slotColorsForText(): readonly [string, string, string] {
    const defaults = ['#37352f', '#7c6cf0', '#c4554d'] as const;
    const stored = this.#customization.slotColorsText;
    return defaults.map((color, index) => stored?.[index] ?? color) as [
      string,
      string,
      string,
    ];
  }

  setTextSlotColorAt(index: number, color: string): boolean {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= SLOT_VALUE_COUNT ||
      typeof color !== 'string' ||
      color.trim() === '' ||
      color.length > MAX_COLOR_LENGTH
    )
      return false;
    const next = [...this.slotColorsForText()];
    next[index] = color.trim();
    this.#replace({ slotColorsText: next });
    return true;
  }

  /** Replace one family's whole size set (cleaned; empty clears to defaults). */
  setSlotSizesForFamily(
    family: InkSlotFamily,
    values: readonly number[],
  ): void {
    const cleaned = cleanSizeList([...values]) ?? [];
    const field =
      family === 'highlighter' ? 'slotSizesHighlighter' : 'slotSizesPen';
    this.#replace({ [field]: cleaned } as {
      readonly slotSizesPen?: readonly number[];
      readonly slotSizesHighlighter?: readonly number[];
    });
  }

  /** Replace one family's whole color set (cleaned; empty clears to defaults). */
  setSlotColorsForFamily(
    family: InkSlotFamily,
    values: readonly string[],
  ): void {
    const cleaned = cleanColorList([...values]) ?? [];
    const field =
      family === 'highlighter' ? 'slotColorsHighlighter' : 'slotColorsPen';
    this.#replace({ [field]: cleaned } as {
      readonly slotColorsPen?: readonly string[];
      readonly slotColorsHighlighter?: readonly string[];
      readonly slotColorsText?: readonly string[];
    });
  }

  /**
   * Single-slot size edit for the slot modal: replaces only
   * `index` (0-based) in the family's set, preserving siblings; pads with
   * family defaults when the stored list is short. Returns false (no
   * commit) for out-of-range indices or invalid values.
   */
  setSlotSizeAt(family: InkSlotFamily, index: number, value: number): boolean {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= SLOT_VALUE_COUNT ||
      typeof value !== 'number' ||
      !Number.isFinite(value) ||
      value <= 0 ||
      value > MAX_SLOT_SIZE
    ) {
      return false;
    }
    const next = [...this.slotSizesForFamily(family)];
    next[index] = value;
    this.setSlotSizesForFamily(family, next);
    return true;
  }

  /**
   * Single-slot color edit for the slot modal: same
   * preserve-siblings contract as `setSlotSizeAt`.
   */
  setSlotColorAt(family: InkSlotFamily, index: number, color: string): boolean {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= SLOT_VALUE_COUNT ||
      typeof color !== 'string' ||
      color.trim() === '' ||
      color.trim().length > MAX_COLOR_LENGTH
    ) {
      return false;
    }
    const next = [...this.slotColorsForFamily(family)];
    next[index] = color.trim();
    this.setSlotColorsForFamily(family, next);
    return true;
  }

  /** Reversible: clears all customization back to registry defaults. */
  reset(): void {
    if (this.#disposed) return;
    this.#customization = { version: TOOLBAR_CUSTOMIZATION_VERSION };
    this.#commit();
  }

  onChange(listener: () => void): { dispose(): void } {
    this.#listeners.add(listener);
    return { dispose: () => this.#listeners.delete(listener) };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#subscription?.dispose();
    this.#listeners.clear();
  }

  #replace(patch: {
    readonly categoryOrder?: readonly string[];
    readonly itemOrder?: Readonly<Record<string, readonly string[]>>;
    readonly hiddenCategories?: readonly string[];
    readonly hiddenItems?: readonly string[];
    readonly squeezeOrder?: readonly string[];
    readonly favoriteTools?: readonly string[];
    readonly slotSizes?: readonly string[];
    readonly slotColors?: readonly string[];
    readonly slotPens?: readonly string[];
    readonly slotSizesPen?: readonly number[];
    readonly slotSizesHighlighter?: readonly number[];
    readonly slotSizesEraser?: readonly number[];
    readonly slotColorsPen?: readonly string[];
    readonly slotColorsHighlighter?: readonly string[];
    readonly slotColorsText?: readonly string[];
  }): void {
    if (this.#disposed) return;
    const merged: ToolbarLayoutOverrides = {
      ...this.#customization,
      ...patch,
    };
    const next: Record<string, unknown> = {
      version: TOOLBAR_CUSTOMIZATION_VERSION,
    };
    const copyList = (ids: readonly string[] | undefined): string[] | null =>
      ids !== undefined && ids.length > 0 ? [...ids] : null;
    for (const field of [
      'categoryOrder',
      'hiddenCategories',
      'hiddenItems',
      'squeezeOrder',
      'favoriteTools',
      'slotSizes',
      'slotColors',
      'slotPens',
    ] as const) {
      const copied = copyList(merged[field]);
      if (copied !== null) next[field] = copied;
    }
    const copyValues = (
      values: readonly number[] | readonly string[] | undefined,
    ): (number | string)[] | null =>
      values !== undefined && values.length > 0 ? [...values] : null;
    for (const field of [
      'slotSizesPen',
      'slotSizesHighlighter',
      'slotSizesEraser',
      'slotColorsPen',
      'slotColorsHighlighter',
      'slotColorsText',
    ] as const) {
      const copied = copyValues(merged[field]);
      if (copied !== null) next[field] = copied;
    }
    if (
      merged.itemOrder !== undefined &&
      Object.keys(merged.itemOrder).length > 0
    ) {
      next.itemOrder = Object.fromEntries(
        Object.entries(merged.itemOrder).map(([categoryId, ids]) => [
          categoryId,
          [...ids],
        ]),
      );
    }
    this.#customization = next as unknown as ToolbarCustomizationV1;
    this.#commit();
  }

  #commit(): void {
    this.#committing = true;
    try {
      this.#settings?.set(
        TOOLBAR_CUSTOMIZATION_STORAGE_KEY,
        JSON.stringify({ ...this.#unknownFields, ...this.#customization }),
      );
    } finally {
      this.#committing = false;
    }
    this.#listeners.forEach((listener) => listener());
  }
}

/**
 * Reorder entries by an explicit slot order list.
 *
 * Registry constraints (`order`/`priority`/`before`/`after`) resolve first
 * in the input sequence; this overlay only re-sorts that resolved result:
 * listed EFFECTIVE slot ids (via `slotIdForItem`, never a local fallback)
 * come first in listed order; unlisted entries keep their incoming relative
 * order after. Unknown ids never match, so they are ignored — never an
 * error, never a reorder of unrelated entries — but stay preserved in
 * storage (dormant-safe: they revive when the contribution returns).
 *
 * With no order (absent/empty) the input sequence returns verbatim, so
 * no-override graphs stay byte-identical. Structure only: never affects
 * semanticRole matching, execution routing, or dormancy.
 */
export function applySlotOrder<T extends SlottedToolbarItem>(
  entries: readonly T[],
  order: readonly string[] | undefined,
): T[] {
  if (order === undefined || order.length === 0) return [...entries];
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...entries]
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const rankA = rank.get(slotIdForItem(a.entry));
      const rankB = rank.get(slotIdForItem(b.entry));
      if (rankA !== undefined && rankB !== undefined) return rankA - rankB;
      if (rankA !== undefined) return -1;
      if (rankB !== undefined) return 1;
      return a.index - b.index;
    })
    .map((wrapped) => wrapped.entry);
}

/**
 * Fixed GoodNotes-style slot positions.
 *
 * Takes live effective slot ids in REGISTRY order (already
 * constraint-resolved) plus a user order overlay, re-sorts registry-first
 * (unknown order ids ignored dormant-safe), dedupes by first occurrence,
 * then pins to exactly `count` positions: live ids fill in order, missing
 * positions pad with `null` empty placeholders that render fixed-width and
 * never collapse. Live ids beyond `count` overflow to More — they
 * stay in the graph, just outside the fixed strip.
 *
 * Pure structure: no execution, no dormancy change, no canonical bytes.
 */
export function resolveFixedSlotPositions(
  liveSlotIds: readonly string[],
  order: readonly string[] | undefined,
  count: number,
): readonly (string | null)[] {
  const seen = new Set<string>();
  const live: string[] = [];
  for (const id of liveSlotIds) {
    if (typeof id !== 'string') continue;
    const trimmed = id.trim();
    if (trimmed === '' || seen.has(trimmed)) continue;
    seen.add(trimmed);
    live.push(trimmed);
  }
  const ordered =
    order === undefined || order.length === 0
      ? live
      : (() => {
          const rank = new Map(order.map((id, index) => [id, index]));
          return [...live]
            .map((id, index) => ({ id, index }))
            .sort((a, b) => {
              const rankA = rank.get(a.id);
              const rankB = rank.get(b.id);
              if (rankA !== undefined && rankB !== undefined)
                return rankA - rankB;
              if (rankA !== undefined) return -1;
              if (rankB !== undefined) return 1;
              return a.index - b.index;
            })
            .map((wrapped) => wrapped.id);
        })();
  const out: (string | null)[] = [];
  for (let index = 0; index < count; index += 1) {
    out.push(index < ordered.length ? (ordered[index] as string) : null);
  }
  return out;
}

/** Fixed size positions (default 3) from live size-slot ids + override.*/
export function resolveSizeSlotPositions(
  liveSlotIds: readonly string[],
  order: readonly string[] | undefined,
): readonly (string | null)[] {
  return resolveFixedSlotPositions(liveSlotIds, order, DEFAULT_SIZE_SLOT_COUNT);
}

/** Fixed color positions (default 3) from live color-slot ids + override.*/
export function resolveColorSlotPositions(
  liveSlotIds: readonly string[],
  order: readonly string[] | undefined,
): readonly (string | null)[] {
  return resolveFixedSlotPositions(
    liveSlotIds,
    order,
    DEFAULT_COLOR_SLOT_COUNT,
  );
}

/** Fixed pen positions (default 4) from live pen-slot ids + override.*/
export function resolvePenSlotPositions(
  liveSlotIds: readonly string[],
  order: readonly string[] | undefined,
): readonly (string | null)[] {
  return resolveFixedSlotPositions(liveSlotIds, order, DEFAULT_PEN_SLOT_COUNT);
}

/**
 * Bucket effective slot ids by effective strip group.
 *
 * Both keys use the single fallback rules — `stripGroupIdForCategory`
 * for the bucket, `slotIdForItem` for the member — never local fallbacks,
 * never guessing from labels, icons, or id substrings. Preserves resolved
 * order verbatim within each bucket (first-seen groups); empty
 * categories contribute no slots. Pure structure for grouped slot
 * containers and for scoping ephemeral per-group last-used memory
 * separately from these persisted overrides.
 */
export function groupSlotIdsByStripGroup(
  categories: readonly (StripGroupedCategory & {
    readonly items: readonly SlottedToolbarItem[];
  })[],
): ReadonlyMap<string, readonly string[]> {
  const grouped = new Map<string, string[]>();
  for (const category of categories) {
    const key = stripGroupIdForCategory(category);
    const list = grouped.get(key) ?? [];
    for (const item of category.items) {
      list.push(slotIdForItem(item));
    }
    grouped.set(key, list);
  }
  return grouped;
}

/**
 * Filter favorite tool ids to the ones resolved in the current graph, in
 * user order. Unknown or currently hidden ids are ignored (never an error);
 * they stay preserved in storage and revive when their contribution returns.
 */
export function resolveFavoriteToolIds(
  graph: ResolvedToolbarGraph,
  favoriteTools: readonly string[] | undefined,
): readonly string[] {
  if (favoriteTools === undefined || favoriteTools.length === 0) return [];
  const live = new Set(
    graph.categories.flatMap((category) =>
      category.items.map((item) => item.id),
    ),
  );
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of favoriteTools) {
    if (!live.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
