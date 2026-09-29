/** A semantic control rendered by the shared document toolbar. */

/** Coarse surface-tool role for accessory/menu routing. */
export type SurfaceToolRole =
  | 'select'
  | 'pen'
  | 'highlighter'
  | 'eraser'
  | 'lasso'
  | 'shape'
  | 'text';

/**
 * Exclusive-tool vs toggle activation semantics.
 *
 * - `'tool'`: an exclusive editing tool (Surface pen/eraser, future
 *   families). Its `active` state drives exclusive-tool reconciliation
 *   (active category/control, squeeze selection).
 * - `'toggle'`: a non-exclusive format/state toggle (Bold/Italic, …). Its
 *   `active` state is visual only and never drives exclusive-tool
 *   reconciliation.
 *
 * Optional for compatibility: controls without this field preserve the
 * historic behavior where any `active === true` button counts as the
 * active tool. That fallback is legacy — providers should migrate to an
 * explicit role so format toggles stop masquerading as exclusive tools
 * and future non-Surface families resolve cleanly.
 */
export type ToolbarActivationRole = 'tool' | 'toggle';

/**
 * Plain brush-tip data for saved-style previews.
 *
 * Mirrors the serializable subset of `InkBrushOverrides['tip']` without
 * importing engine types into the generic toolbar seam: the provider copies
 * values, React resolves them through the real brush spec for previews.
 */
export interface SavedStyleTipData {
  readonly shape?: 'round' | 'flat' | 'ellipse';
  readonly angle?: number;
  readonly aspect?: number;
  readonly cap?: 'round' | 'butt';
}

/**
 * Plain pressure data for saved-style previews.
 *
 * Mirrors the serializable subset of `InkBrushOverrides['pressure']`.
 */
export interface SavedStylePressureData {
  readonly enabled?: boolean;
  readonly minFactor?: number;
  readonly maxFactor?: number;
  readonly curve?: number;
}

/**
 * Plain working-preset data for saved-style previews.
 *
 * Mirrors the serializable subset of `InkToolPreset` (`color`/`size`/
 * `opacity`/`brush`) without importing engine types into the generic seam.
 * Providers copy values; React never mutates them.
 */
export interface SavedStylePresetData {
  readonly color?: string;
  readonly size?: number;
  readonly opacity?: number;
  readonly brush?: {
    readonly kind?: string;
    readonly color?: string;
    readonly size?: number;
    readonly opacity?: number;
    readonly pressure?: SavedStylePressureData;
    readonly stabilization?: number;
    readonly streamline?: number;
    readonly velocityPressure?: boolean;
    readonly tiltEffect?: number;
    readonly taperStart?: number;
    readonly taperEnd?: number;
    readonly tip?: SavedStyleTipData;
  };
}

/**
 * Structured saved-style entry for visual cards.
 *
 * The existing `choice` options labels (`Favorite · name, color, size pt`)
 * are insufficient for previews (they lose brush kind, opacity, pressure,
 * tip) and force fragile label parsing. This additive payload carries the
 * same styles structurally while preserving `value`/`options`/`label` for
 * legacy renderers (stylus palette, old snapshots). Absent on pre-D+E
 * snapshots; the shared UI falls back to generic rendering then.
 */
export interface SavedStyleCardData {
  readonly id: string;
  readonly name: string;
  /** Preset tool id (`pen`/`fountain`/`brush`/`pencil`/`highlighter`). */
  readonly toolKind: string;
  readonly favorite: boolean;
  readonly preset: SavedStylePresetData;
}

export type ToolbarSemanticMetadata = {
  /**
   * Provider-neutral identity used by toolbar composition. The executable
   * `id` remains provider-owned; presenters must never infer this value from
   * an id suffix.
   */
  readonly semanticRole?: string;
};

export type DocumentToolControl = (
  | {
      readonly kind: 'button';
      readonly id: string;
      readonly group: string;
      readonly label: string;
      readonly shortLabel?: string;
      readonly icon?: string;
      readonly active?: boolean;
      /**
       * Provider-computed indeterminate state for selections spanning
       * ambiguous/mixed formatting. When true, the shared renderer exposes
       * `aria-pressed="mixed"` instead of claiming active/inactive. The
       * provider computes it; React never walks editor selections to derive
       * it. Used consistently across Markdown and Block Page.
       */
      readonly mixed?: boolean;
      readonly disabled?: boolean;
      /** Optional color dot (e.g. the live pen color on a tool category). */
      readonly swatch?: string;
      /**
       * Semantic surface-tool metadata: providers tag draw-tool
       * buttons so accessory binders match on meaning instead of parsing
       * control-id strings. Absent on non-surface controls.
       */
      readonly role?: 'surface-tool';
      /** Engine tool id (e.g. `froglight.ink.eraser`). */
      readonly toolId?: string;
      /** Coarse tool role for accessory/menu routing. */
      readonly toolRole?: SurfaceToolRole;
      /**
       * Exclusive-tool vs toggle semantics. Surface draw
       * tools emit `'tool'`; writing format toggles (Bold/Italic, …)
       * emit `'toggle'` and never drive exclusive-tool reconciliation.
       * Absent means legacy: `active === true` still counts as the
       * active tool (see `ToolbarActivationRole`). UI interprets; the
       * provider still computes `active`/`mixed`.
       */
      readonly activationRole?: ToolbarActivationRole;
    }
  | {
      readonly kind: 'choice';
      /** Shared customizable width slots for surface objects. */
      readonly slotFamily?: 'pen' | 'highlighter';
      readonly id: string;
      readonly group: string;
      readonly label: string;
      /** Compact glyph for action-style choices such as align/order. */
      readonly icon?: string;
      readonly value: string;
      readonly options: readonly {
        readonly value: string;
        readonly label: string;
      }[];
      readonly disabled?: boolean;
      /**
       * Structured saved styles for visual cards (additive).
       * Present only on `surface.style.saved` controls emitted by
       * `buildActiveToolSettingsControls`. Legacy renderers ignore it and
       * keep using `value`/`options`; the visual cards require it to avoid
       * parsing display labels for color/size/brush semantics.
       */
      readonly savedStyles?: readonly SavedStyleCardData[];
      /**
       * Working-vs-saved modified flag (additive). True when the
       * live working preset differs from the selected saved style; drives
       * the "Current style modified" indicator without inferring from
       * sibling button disabled states.
       */
      readonly savedStyleModified?: boolean;
      /**
       * Live working preset for the current-tool preview. Additive plain
       * copy of `toolPreset(tool)`; lets the cards show a
       * working-style preview without reconstructing brush state from many
       * sibling range controls.
       */
      readonly workingPreset?: SavedStylePresetData;
    }
  | {
      readonly kind: 'color';
      readonly id: string;
      readonly group: string;
      readonly label: string;
      readonly value: string;
      readonly options: readonly string[];
      /** Shared customizable palette for the selected content family. */
      readonly slotFamily?: 'pen' | 'highlighter';
      readonly disabled?: boolean;
    }
  | {
      readonly kind: 'input';
      readonly id: string;
      readonly group: string;
      readonly label: string;
      readonly placeholder?: string;
      readonly actionLabel: string;
      /**
       * Provider-computed initial value for focus-preserving popovers (e.g.
       * the existing link target when the caret/selection is inside a link).
       * The shared UI owns popover lifecycle; the provider owns value
       * semantics. Absent means empty.
       */
      readonly value?: string;
      /** Compact trigger icon for popover presentation (e.g. `link`). */
      readonly icon?: string;
      /** Provider-computed active state (e.g. caret inside a link). */
      readonly active?: boolean;
      readonly disabled?: boolean;
    }
  | {
      readonly kind: 'number';
      readonly id: string;
      readonly group: string;
      readonly label: string;
      readonly value: number;
      readonly min?: number;
      readonly max?: number;
      readonly step?: number;
      readonly suffix?: string;
      readonly disabled?: boolean;
    }
  | {
      readonly kind: 'table';
      readonly id: string;
      readonly group: string;
      readonly label: string;
      readonly columns: number;
      readonly rows: number;
      readonly header: boolean;
      readonly maxColumns: number;
      readonly maxRows: number;
      readonly disabled?: boolean;
    }
  | {
      readonly kind: 'range';
      readonly id: string;
      readonly group: string;
      readonly label: string;
      readonly value: number;
      readonly min: number;
      readonly max: number;
      readonly step: number;
      readonly disabled?: boolean;
    }
  | {
      readonly kind: 'status';
      readonly id: string;
      readonly group: string;
      readonly label: string;
    }
  | {
      readonly kind: 'diagnostics';
      readonly id: string;
      readonly group: string;
      /**
       * Compact accessible summary composed by the provider (e.g.
       * `LaTeX · no issues`, `LaTeX · 2 issues`, or
       * `LaTeX preview unavailable`). Rendered as visible text so state
       * never depends on color alone; also used as the trigger's
       * accessible name.
       */
      readonly label: string;
      /**
       * Provider-computed availability/count state. The shared renderer
       * never parses diagnostics itself; it renders the trigger and the
       * on-demand entry list from these plain fields.
       *
       * `pending` means analysis has not yet completed for the current
       * source version (never report `clean` prematurely); `unavailable`
       * means analysis cannot be performed.
       */
      readonly state:
        | 'pending'
        | 'unavailable'
        | 'clean'
        | 'notes'
        | 'errors'
        | 'failed';
      readonly errorCount: number;
      readonly noteCount: number;
      /** True when `entries` is a truncated view of a larger total. */
      readonly truncated?: boolean;
      /** Full diagnostic count when truncated (entries.length < total). */
      readonly totalCount?: number;
      /**
       * Plain diagnostic entries (message/code/path/line only). Renderer
       * handles, HTML, and resolver objects never cross this seam.
       * Entries with `navigable: true` execute a provider navigation
       * command with the entry id as the value.
       */
      readonly entries: readonly {
        readonly id: string;
        readonly message: string;
        readonly code: string;
        readonly path?: string;
        readonly line?: number;
        readonly navigable: boolean;
      }[];
    }
) &
  ToolbarSemanticMetadata;

/** Provider-neutral state for the active thing inside an editor. */
export interface DocumentToolSnapshot {
  /** Stable semantic context such as `paragraph`, `heading`, `ink`, or `page`. */
  readonly context: string;
  readonly controls: readonly DocumentToolControl[];
  /** Optional derived page browser data. Images are rebuildable previews. */
  readonly pages?: readonly {
    readonly id: string;
    readonly label: string;
    readonly thumbnail?: string;
    readonly current: boolean;
  }[];
  /**
   * Optional viewport-space rectangle for object-bound contextual controls.
   * Plain coordinates keep editor/canvas DOM behind the provider seam.
   */
  readonly contextualAnchor?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

/**
 * Optional semantic tool interface implemented by editor handles.
 *
 * The shared React shell renders controls; the provider keeps editor-library
 * state and translates plain command ids/values. No DOM or editor type crosses
 * this seam.
 */
export interface DocumentEditorTools {
  snapshot(): DocumentToolSnapshot;
  execute(id: string, value?: string): boolean | Promise<boolean>;
  onDidChange(listener: () => void): { dispose(): void };
}

/**
 * True when a control represents the currently active exclusive editing
 * tool. Provider-computed `active` is preserved; the shared
 * UI interprets it through `activationRole`:
 *
 * - `activationRole === 'toggle'` never counts, even when `active`.
 * - `activationRole === 'tool'` counts when `active`.
 * - Absent (`undefined`) preserves the historic fallback where any
 *   `active === true` button counts (legacy for snapshots that predate
 *   the field; new providers must be explicit).
 *
 * Non-button kinds never count. `mixed` alone never counts.
 */
export function isExclusiveActiveToolControl(
  control: DocumentToolControl,
): boolean {
  if (control.kind !== 'button') return false;
  if (control.active !== true) return false;
  if (control.activationRole === 'toggle') return false;
  return true;
}
