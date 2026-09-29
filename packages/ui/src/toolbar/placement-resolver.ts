/**
 * Unified toolbar placement resolver.
 *
 * Pure function over the flat semantic control pool plus the active
 * placement contributions for one pane. The resolver never mutates, never
 * touches DOM or editor types, and never branches on document kind itself —
 * kind/context filtering already happened in the placement registry query.
 *
 * Rules:
 * - Only controls present in `pool` render; placement ids absent from the
 *   snapshot are skipped without gaps (context-conditional controls).
 * - The resolved layout holds at most one visible instance of a semantic
 *   control id. Later placements claiming an already-owned id are skipped
 *   and reported in `diagnostics` instead of rendering twice.
 * - Controls with no placement do not render. Kinds without any matching
 *   placement degrade to an empty/minimal top bar rather than a flat
 *   full-width fallback row.
 */

import type {
  DocumentToolControl,
  SurfaceToolRole,
} from '@froglight/foundation';
import { isExclusiveActiveToolControl } from '@froglight/foundation';
import type { DocumentToolbarContext } from '../document-toolbar-registry.js';
import {
  groupCategoriesByStripGroup,
  settingsForTool,
  slotIdForItem,
  stripGroupIdForCategory,
  type ResolvedToolbarGraph,
  type ResolvedToolbarSettings,
} from './composition-registry.js';
import {
  type ToolbarAnchor,
  type ToolbarCompactMode,
  type ToolbarPlacementContribution,
} from './placement-registry.js';

export type FloatingToolbarAnchor = Exclude<ToolbarAnchor, 'topbar-center'>;

/** Execution owner for one semantic control id. Exactly one owner wins. */
export type ToolbarControlOwner =
  | { readonly kind: 'provider' }
  | { readonly kind: 'shell'; readonly command: 'undo' | 'redo' }
  | { readonly kind: 'contribution'; readonly contributionId: string };

/** Semantic control together with its resolved execution owner. */
export interface OwnedToolbarControl {
  readonly control: DocumentToolControl;
  readonly owner: ToolbarControlOwner;
}

/** One placement group preserved through resolution and rendering. */
export interface ResolvedToolbarGroup {
  readonly id: string;
  readonly anchor: ToolbarAnchor;
  readonly order: number;
  readonly priority: number;
  readonly compact: ToolbarCompactMode;
  readonly controls: readonly OwnedToolbarControl[];
}

/** Resolved unified layout for one pane snapshot. */
export interface ResolvedToolbarLayout {
  /** Primary document tools in the pane top-bar center, in placement order. */
  readonly topbarCenter: readonly DocumentToolControl[];
  /** Pane-scoped floating islands by geometric anchor. */
  readonly floating: Readonly<
    Record<FloatingToolbarAnchor, readonly DocumentToolControl[]>
  >;
  /**
   * Development/test diagnostics: duplicate conflicting claims. Each entry
   * names the skipped placement and the already-owned control id.
   */
  readonly diagnostics: readonly string[];
  /** Pool control ids with no placement; not rendered. */
  readonly unplaced: readonly string[];
  /**
   * Group-level render model preserving placement identity, anchor, order,
   * priority, and compaction policy. `topbarCenter`/`floating` above are
   * flattened views of these groups for backward compatibility; new code
   * should consume `groups` to preserve group boundaries through
   * responsive compaction.
   */
  readonly groups: readonly ResolvedToolbarGroup[];
  /** Owned controls flattened in render order (execution routing). */
  readonly owned: readonly OwnedToolbarControl[];
}

/**
 * Assemble one owned pool from provider, shell, and contribution controls.
 *
 * Ownership precedence (exactly one effective owner per semantic id):
 * 1. provider, 2. shell, 3. plugin contribution (first contribution wins).
 *
 * A contribution claiming a provider/shell-owned id never intercepts
 * execution while the higher-precedence control remains visible; the
 * duplicate is reported in `diagnostics` instead.
 */
export function assembleOwnedPool(input: {
  readonly providerControls: readonly DocumentToolControl[];
  readonly shellControls?: readonly DocumentToolControl[];
  readonly shellOwner?: (id: string) => ToolbarControlOwner | null;
  readonly contributions?: readonly {
    readonly contributionId: string;
    readonly controls: readonly DocumentToolControl[];
  }[];
}): {
  readonly ownedPool: readonly OwnedToolbarControl[];
  readonly diagnostics: readonly string[];
} {
  const { providerControls, shellControls = [], contributions = [] } = input;
  const shellOwnerFor =
    input.shellOwner ??
    ((id: string): ToolbarControlOwner | null => {
      if (id === 'shell.history.undo')
        return { kind: 'shell', command: 'undo' };
      if (id === 'shell.history.redo')
        return { kind: 'shell', command: 'redo' };
      return null;
    });
  const ownedById = new Map<string, OwnedToolbarControl>();
  const diagnostics: string[] = [];

  for (const control of providerControls) {
    if (!ownedById.has(control.id))
      ownedById.set(control.id, { control, owner: { kind: 'provider' } });
  }
  for (const control of shellControls) {
    if (ownedById.has(control.id)) {
      diagnostics.push(
        `duplicate toolbar control '${control.id}' claimed by shell (already provider-owned)`,
      );
      continue;
    }
    const owner = shellOwnerFor(control.id);
    if (owner === null) {
      diagnostics.push(
        `unknown shell-owned toolbar control '${control.id}' has no owner (rejected)`,
      );
      continue;
    }
    ownedById.set(control.id, { control, owner });
  }
  for (const entry of contributions) {
    for (const control of entry.controls) {
      const existing = ownedById.get(control.id);
      if (existing !== undefined) {
        const ownerLabel =
          existing.owner.kind === 'provider'
            ? 'provider'
            : existing.owner.kind === 'shell'
              ? 'shell'
              : `contribution '${existing.owner.contributionId}'`;
        diagnostics.push(
          `duplicate toolbar control '${control.id}' claimed by contribution '${entry.contributionId}' (already owned by ${ownerLabel})`,
        );
        continue;
      }
      ownedById.set(control.id, {
        control,
        owner: { kind: 'contribution', contributionId: entry.contributionId },
      });
    }
  }
  return { ownedPool: [...ownedById.values()], diagnostics };
}

/** Shell-owned history controls participating in placement resolution. */
export function shellHistoryOwnedControls(input: {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
}): readonly OwnedToolbarControl[] {
  const { canUndo, canRedo } = input;
  const undo: DocumentToolControl = {
    kind: 'button',
    id: 'shell.history.undo',
    group: 'history',
    label: 'Undo',
    shortLabel: 'Undo',
    icon: 'undo',
    ...(canUndo ? {} : { disabled: true as const }),
  };
  const redo: DocumentToolControl = {
    kind: 'button',
    id: 'shell.history.redo',
    group: 'history',
    label: 'Redo',
    shortLabel: 'Redo',
    icon: 'redo',
    ...(canRedo ? {} : { disabled: true as const }),
  };
  return [
    { control: undo, owner: { kind: 'shell', command: 'undo' } },
    { control: redo, owner: { kind: 'shell', command: 'redo' } },
  ];
}

/** Resolve owned pool into group-level render model (no flattening). */
export function resolveToolbarGroups(input: {
  readonly placements: readonly ToolbarPlacementContribution[];
  readonly ownedPool: readonly OwnedToolbarControl[];
  readonly context: DocumentToolbarContext;
}): {
  readonly groups: readonly ResolvedToolbarGroup[];
  readonly diagnostics: readonly string[];
  readonly unplaced: readonly string[];
  readonly owned: readonly OwnedToolbarControl[];
} {
  const { placements, ownedPool, context } = input;
  const byId = new Map(ownedPool.map((owned) => [owned.control.id, owned]));
  const ordered = [...placements].sort(
    (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id),
  );
  const groups: ResolvedToolbarGroup[] = [];
  const claimed = new Set<string>();
  const diagnostics: string[] = [];
  const ownedInOrder: OwnedToolbarControl[] = [];

  for (const placement of ordered) {
    if (
      placement.kindIds !== undefined &&
      !placement.kindIds.includes(context.kindId)
    )
      continue;
    if (placement.when?.(context) === false) continue;
    const controls: OwnedToolbarControl[] = [];
    for (const id of placement.controlIds) {
      const owned = byId.get(id);
      if (owned === undefined) continue;
      if (claimed.has(id)) {
        diagnostics.push(
          `duplicate toolbar control '${id}' claimed by '${placement.id}' (already owned)`,
        );
        continue;
      }
      claimed.add(id);
      controls.push(owned);
      ownedInOrder.push(owned);
    }
    if (controls.length === 0) continue;
    groups.push({
      id: placement.id,
      anchor: placement.anchor,
      order: placement.order ?? 0,
      priority: placement.priority ?? 0,
      compact: placement.compact ?? 'auto',
      controls,
    });
  }

  const unplaced = ownedPool
    .filter((owned) => !claimed.has(owned.control.id))
    .map((owned) => owned.control.id);

  return { groups, diagnostics, unplaced, owned: ownedInOrder };
}

/**
 * Pure responsive planner: split groups into visible vs overflow without
 * creating a second full-width row and without splitting group boundaries.
 *
 * - `compact: 'never'` groups are always visible (required).
 * - `compact: 'always'` groups always overflow.
 * - `compact: 'auto'` groups survive by descending `priority` (then `order`,
 *   then `id` for determinism); lower-priority groups overflow first.
 * - `availableWidth` is the toolbar surface budget; `measuredWidths` maps
 *   placement id → measured width. Missing widths count as 0 (visible).
 * - When anything overflows, the overflow trigger (`overflowWidth` +
 *   `overflowGap`) is reserved from the same budget and visible auto groups
 *   are recomputed so the trigger itself fits. The trigger is a real
 *   `.fl-document-tool` (30px min on fine pointers, 40px on coarse), so
 *   callers pass a pointer-aware `overflowWidth` instead of relying on the
 *   40px default on desktop, where it overflowed one group too early.
 * - `hysteresis` with `overflowIds` (the previous overflow membership)
 *   handicaps returning groups by extra pixels, so 1px dither around the
 *   threshold cannot flip the menu every frame. Both default to off, which
 *   keeps the planner a pure function of the current widths.
 */
export function planToolbarCompaction(
  groups: readonly ResolvedToolbarGroup[],
  availableWidth: number,
  measuredWidths: ReadonlyMap<string, number> | Record<string, number>,
  options: {
    readonly overflowWidth?: number;
    readonly overflowGap?: number;
    readonly hysteresis?: number;
    readonly overflowIds?: ReadonlySet<string>;
  } = {},
): {
  readonly visible: readonly ResolvedToolbarGroup[];
  readonly overflow: readonly ResolvedToolbarGroup[];
} {
  const overflowWidth = options.overflowWidth ?? 40;
  const overflowGap = options.overflowGap ?? 4;
  const hysteresis = options.hysteresis ?? 0;
  const overflowIds = options.overflowIds;
  const widthOf = (id: string): number => {
    if (measuredWidths instanceof Map) return measuredWidths.get(id) ?? 0;
    return (measuredWidths as Record<string, number>)[id] ?? 0;
  };
  // Recently-overflowed auto groups budget harder to return; everything
  // else budgets at measured size. Required/always groups are unaffected.
  const effectiveWidthOf = (group: ResolvedToolbarGroup): number =>
    hysteresis > 0 &&
    group.compact !== 'never' &&
    group.compact !== 'always' &&
    overflowIds?.has(group.id) === true
      ? widthOf(group.id) + hysteresis
      : widthOf(group.id);
  if (!Number.isFinite(availableWidth) || availableWidth < 0) {
    return { visible: groups, overflow: [] };
  }
  const required = groups.filter((group) => group.compact === 'never');
  const alwaysOverflow = groups.filter((group) => group.compact === 'always');
  const auto = groups.filter(
    (group) => group.compact !== 'never' && group.compact !== 'always',
  );
  const requiredWidth = required.reduce(
    (sum, group) => sum + widthOf(group.id),
    0,
  );
  // Highest priority survives longest.
  const byPriority = [...auto].sort(
    (a, b) =>
      b.priority - a.priority || a.order - b.order || a.id.localeCompare(b.id),
  );
  const selectWithBudget = (budget: number): Set<string> => {
    const selected = new Set<string>();
    let remaining = budget;
    for (const group of byPriority) {
      // Hysteresis gates re-entry but never spends budget: a returning
      // group occupies its measured width, not the handicapped one.
      const width = widthOf(group.id);
      if (effectiveWidthOf(group) <= remaining) {
        selected.add(group.id);
        remaining -= width;
      }
    }
    return selected;
  };
  // First pass: fit without reserving the trigger.
  let selected = selectWithBudget(availableWidth - requiredWidth);
  let overflowCount =
    alwaysOverflow.length + auto.filter((g) => !selected.has(g.id)).length;
  // Second pass: when anything overflows, reserve trigger + gap and refit.
  if (overflowCount > 0) {
    const reserved = overflowWidth + overflowGap;
    // `compact: always` proves the trigger is required from the start.
    selected = selectWithBudget(availableWidth - requiredWidth - reserved);
    overflowCount =
      alwaysOverflow.length + auto.filter((g) => !selected.has(g.id)).length;
    // Required groups alone may exceed the budget: keep them visible and
    // still expose the trigger so overflow stays reachable.
    if (overflowCount === 0) {
      selected = selectWithBudget(availableWidth - requiredWidth);
    }
  }
  const visibleUnsorted: ResolvedToolbarGroup[] = [
    ...required,
    ...auto.filter((group) => selected.has(group.id)),
  ];
  const overflowUnsorted: ResolvedToolbarGroup[] = [
    ...alwaysOverflow,
    ...auto.filter((group) => !selected.has(group.id)),
  ];
  // Preserve deterministic render order (order, then id) for both lists.
  const byOrder = (a: ResolvedToolbarGroup, b: ResolvedToolbarGroup): number =>
    a.order - b.order || a.id.localeCompare(b.id);
  return {
    visible: [...visibleUnsorted].sort(byOrder),
    overflow: [...overflowUnsorted].sort(byOrder),
  };
}

/**
 * Shelf capacity planning.
 *
 * The composition shelf is NOT governed by the 760 compact boolean at
 * medium widths: when the pane budget cannot fit family + settings +
 * quicks, lower-priority cells move to the explicit More menu behind
 * `ToolbarPopoverPortal` (settings disclosure is `required` and never hides
 * in invisible scroll; horizontal scroll remains only the pathological
 * fallback). Reuses `planToolbarCompaction` over synthetic groups so the
 * trigger reserve, priority order, and hysteresis share one semantics with
 * the geometric islands — never a second breakpoint, never a window query.
 *
 * Priority contract (descending priority): active tool (100, required) >
 * settings disclosure (95, required) > family tools (90) > favorites (70)
 * > widths (60) > colors (55) > modes (40).
 */
export interface ShelfCapacityCell {
  readonly id: string;
  /** Stable shelf render order (not priority order). */
  readonly order: number;
  /** Higher survives longer (see contract above). */
  readonly priority: number;
  /** Estimated cell width in px (capability-aware unit, see estimator). */
  readonly width: number;
  /** Required cells (active tool, settings disclosure) never overflow. */
  readonly required?: boolean;
}

export function planShelfCells(
  cells: readonly ShelfCapacityCell[],
  availableWidth: number,
  options: {
    readonly overflowWidth?: number;
    readonly overflowGap?: number;
    readonly hysteresis?: number;
    readonly overflowIds?: ReadonlySet<string>;
  } = {},
): {
  readonly visible: readonly string[];
  readonly overflow: readonly string[];
} {
  const groups: ResolvedToolbarGroup[] = cells.map((cell) => ({
    id: cell.id,
    anchor: 'float.top-center',
    order: cell.order,
    priority: cell.priority,
    compact: cell.required === true ? 'never' : 'auto',
    controls: [],
  }));
  const widths = new Map(cells.map((cell) => [cell.id, cell.width] as const));
  const planned = planToolbarCompaction(
    groups,
    availableWidth,
    widths,
    options,
  );
  return {
    visible: planned.visible.map((group) => group.id),
    overflow: planned.overflow.map((group) => group.id),
  };
}

/**
 * Grouped composition projections keep stable secondary and single-row
 * floating secondary placement, with family choices from composition and
 * item order preserved verbatim.
 *
 * One `ResolvedToolbarGraph` per pane is the single model: `normal`,
 * `compact`, `squeeze`, and `selection` are views over the same resolved
 * categories/items/settings, never separate stores. Every helper below is
 * pure (no DOM, no editor types, no registration, no callbacks): structure
 * carries identity/order/dormancy only, and callers map back through the
 * assembled owned pool so the provider/shell/contribution owner still
 * routes execution. Control matching keys on
 * `semanticRole` alone; ordering keys on the already-resolved
 * `order`/`priority`/`before`/`after` plus user-order overlays alone —
 * grouping/slot metadata never re-sorts, never matches, never executes.
 * React owns all visible presentation.
 *
 * Lifecycle invariant holds vacuously: this section adds no registration
 * API, so there is nothing to activate/dispose/reactivate and no
 * provider-swap cascade to orphan.
 */

/**
 * Single-row bound for the grouped squeeze crescent.
 *
 * Mirrors `SQUEEZE_MAX_PRIMARY` in `stylus-palette-model.ts` (five fills
 * one overlay grid row exactly; six would wrap into a second row and break
 * the arc). Kept as a separate constant to avoid a runtime cycle
 * (`stylus-palette-model.ts` already imports this module); the spec pins
 * equality so the two can never diverge silently.
 */
export const GROUPED_SQUEEZE_MAX_PRIMARY = 5;

/** Minimal squeeze source: grouping metadata rides through untouched. */
export type GroupedSqueezeEntry = {
  readonly id: string;
  readonly control: DocumentToolControl;
  readonly slotId?: string;
};

export type GroupedSqueezeTier = 'primary' | 'secondary';

type SqueezeTierProbe = {
  readonly toolRole?: SurfaceToolRole;
  readonly semanticRole?: string;
};

/**
 * True for the contextual shape/insert family: coarse `shape`/`text`
 * roles plus `surface.shape.*` / `surface.insert.*` semantic roles (the
 * latter covers insert controls such as image/card that carry no coarse
 * `toolRole`). Semantic-role prefixes — not control-id text — are the
 * explicit semantic concern here; community `community.*` roles never
 * match. Mirrors `stylus-palette-model.ts` so both tiers agree.
 */
function isGroupedContextualProbe(probe: SqueezeTierProbe): boolean {
  if (probe.toolRole === 'shape' || probe.toolRole === 'text') return true;
  const role = probe.semanticRole;
  if (role === undefined) return false;
  return (
    role.startsWith('surface.shape.') || role.startsWith('surface.insert.')
  );
}

function isGroupedSelectProbe(probe: SqueezeTierProbe): boolean {
  return probe.toolRole === 'select' || probe.toolRole === 'lasso';
}

function probeOf(entry: GroupedSqueezeEntry): SqueezeTierProbe {
  const control = entry.control;
  if (control.kind !== 'button') return { toolRole: undefined };
  return {
    toolRole: control.toolRole,
    ...(control.semanticRole !== undefined
      ? { semanticRole: control.semanticRole }
      : {}),
  };
}

/**
 * Base per-item eligibility (no list context): crescent-eligible drawing
 * families only. `shape`/`text` are deliberately secondary here; the
 * compact selector (`splitGroupedSqueezeItems`) promotes at most one
 * contextual back to primary. Role-less community actions are always
 * secondary so commands are never misrepresented as drawing tools.
 * Mirrors `squeezeToolTier` (`stylus-palette-model.ts`).
 */
export function groupedSqueezeTierForEntry(
  entry: GroupedSqueezeEntry,
): GroupedSqueezeTier {
  const probe = probeOf(entry);
  switch (probe.toolRole) {
    case 'pen':
    case 'highlighter':
    case 'eraser':
    case 'select':
    case 'lasso':
      return 'primary';
    default:
      return 'secondary';
  }
}

/**
 * Dedupe grouped squeeze entries by executable control id, first
 * occurrence wins in composition order.
 *
 * The Text creation alias (`surface.insert.text` via `surface.insert.text`
 * + `surface.text.create`) resolves to ONE provider control
 * behind two items; without this step Text would count twice toward the
 * bounded crescent and render twice. Same rule as
 * `buildStylusPaletteModel`/`splitSqueezeTools`: dedupe by control id,
 * never by label/toolRole/group/id substring. Input order (already
 * category order + item order including `before`/`after`/user-order) is
 * preserved verbatim; entries pass through by reference with grouping
 * (`slotId`) untouched.
 */
export function dedupeGroupedSqueezeEntries<T extends GroupedSqueezeEntry>(
  entries: readonly T[],
): readonly T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  for (const entry of entries) {
    if (seen.has(entry.control.id)) continue;
    seen.add(entry.control.id);
    deduped.push(entry);
  }
  return deduped;
}

function resolveGroupedSqueezeActiveId<T extends GroupedSqueezeEntry>(
  entries: readonly T[],
  activeControlId?: string | null,
): string | null {
  if (activeControlId !== undefined && activeControlId !== null)
    return activeControlId;
  for (const entry of entries) {
    if (isExclusiveActiveToolControl(entry.control)) return entry.control.id;
  }
  return null;
}

/**
 * Bounded single-row squeeze split over grouped composition entries
 * (acceptance: squeeze bounds + dedupe + order; no second
 * row).
 *
 * Five stable slots cover the full Surface grammar without crowding: one
 * pen-family representative (active pen, else first pen in composition
 * order — siblings never consume extra slots), Highlighter, Eraser, one
 * select-family representative (active select/lasso, else first — never
 * both), and one contextual shape/insert representative (active
 * shape/insert, else the first shape/insert in composition order). The
 * active surface tool is always included when it carries a `toolRole`;
 * role-less community commands never promote (they are actions, not
 * drawing tools). Safety net: an active surface tool outside the five
 * families (future coarse roles) still joins rather than vanishing.
 *
 * Guarantees:
 * - dedupes by control id first (Text alias counts once);
 * - `primary.length <= GROUPED_SQUEEZE_MAX_PRIMARY` always (no second
 *   row; overflow spills to `secondary` in composition order);
 * - per-tier composition order preserved verbatim (primary in incoming
 *   order, secondary the remainder in incoming order — never
 *   active-first);
 * - grouping passthrough preserved (returned entries are the input
 *   entries, `slotId` untouched);
 * - membership keys on `toolRole` + `semanticRole` only, never on
 *  control-id/label/icon/group text;
 * - structure only: no owners, no callbacks, no execution.
 */
export function splitGroupedSqueezeItems<T extends GroupedSqueezeEntry>(
  entries: readonly T[],
  options: { readonly activeControlId?: string | null } = {},
): {
  readonly primary: readonly T[];
  readonly secondary: readonly T[];
} {
  const unique = dedupeGroupedSqueezeEntries(entries);
  if (unique.length === 0) return { primary: [], secondary: [] };
  const byControlId = new Map(unique.map((entry) => [entry.control.id, entry]));
  const activeId = resolveGroupedSqueezeActiveId(
    unique,
    options.activeControlId,
  );
  const active = activeId !== null ? (byControlId.get(activeId) ?? null) : null;
  // Only surface tools promote: a role-less active community command is
  // an action, not a drawing tool, and stays secondary.
  const activeSurfaceEntry =
    active !== null &&
    active.control.kind === 'button' &&
    active.control.toolRole !== undefined
      ? active
      : null;

  const indexOf = new Map(unique.map((entry, index) => [entry.id, index]));
  const firstOf = (predicate: (entry: T) => boolean): T | null =>
    unique.find(predicate) ?? null;
  const activeIn = (predicate: (entry: T) => boolean): T | null =>
    activeSurfaceEntry !== null && predicate(activeSurfaceEntry)
      ? activeSurfaceEntry
      : null;

  const isPen = (entry: T): boolean =>
    entry.control.kind === 'button' && entry.control.toolRole === 'pen';
  const penRep = activeIn(isPen) ?? firstOf(isPen);
  const highlighterRep =
    activeIn(
      (entry) =>
        entry.control.kind === 'button' &&
        entry.control.toolRole === 'highlighter',
    ) ??
    firstOf(
      (entry) =>
        entry.control.kind === 'button' &&
        entry.control.toolRole === 'highlighter',
    );
  const eraserRep =
    activeIn(
      (entry) =>
        entry.control.kind === 'button' && entry.control.toolRole === 'eraser',
    ) ??
    firstOf(
      (entry) =>
        entry.control.kind === 'button' && entry.control.toolRole === 'eraser',
    );
  const selectRep =
    activeIn((entry) => isGroupedSelectProbe(probeOf(entry))) ??
    firstOf((entry) => isGroupedSelectProbe(probeOf(entry)));
  const contextualRep =
    activeIn((entry) => isGroupedContextualProbe(probeOf(entry))) ??
    firstOf((entry) => isGroupedContextualProbe(probeOf(entry)));

  let primaryIds = new Set<string>();
  for (const rep of [
    penRep,
    highlighterRep,
    eraserRep,
    selectRep,
    contextualRep,
  ]) {
    if (rep !== null) primaryIds.add(rep.id);
  }
  if (activeSurfaceEntry !== null && !primaryIds.has(activeSurfaceEntry.id)) {
    primaryIds.add(activeSurfaceEntry.id);
  }

  const orderByIndex = (a: T, b: T): number =>
    (indexOf.get(a.id) ?? 0) - (indexOf.get(b.id) ?? 0);
  let primary = unique
    .filter((entry) => primaryIds.has(entry.id))
    .sort(orderByIndex);
  if (primary.length > GROUPED_SQUEEZE_MAX_PRIMARY) {
    const activeKept = primary.filter(
      (entry) => entry.control.id === activeSurfaceEntry?.control.id,
    );
    const rest = primary.filter(
      (entry) => entry.control.id !== activeSurfaceEntry?.control.id,
    );
    primary = [...activeKept, ...rest].slice(0, GROUPED_SQUEEZE_MAX_PRIMARY);
    primaryIds = new Set(primary.map((entry) => entry.id));
  }
  const secondary = unique
    .filter((entry) => !primaryIds.has(entry.id))
    .sort(orderByIndex);
  return { primary, secondary };
}

/**
 * Verbatim shelf order (stable secondary, verbatim).
 *
 * Returns the resolved items in composition order untouched: the resolved
 * sequence (category order + item order including `before`/`after` plus
 * user-order overlays) is the sole ordering authority. The active tool is
 * marked IN PLACE via `isExclusiveActiveToolControl` (aria-pressed /
 * data-contains-active-tool by presenters) and is NEVER moved first —
 * changing active/size/color/pen across 5+ switches leaves the sequence
 * identical. Grouping (`slotId`) rides through by reference; this helper
 * never re-sorts, never filters, never executes.
 */
export function verbatimShelfItemOrder<T>(items: readonly T[]): readonly T[] {
  return [...items];
}

/**
 * Exclusive active control id for shelf/squeeze marking (structure only).
 * Toggle-active controls never count; legacy controls without
 * `activationRole` keep the historic `active === true` behavior via
 * `isExclusiveActiveToolControl`, so shelf, strip, and squeeze agree on
 * the same active tool. Returns null when no exclusive tool is active.
 * Callers mark the matching entry in place; they never reorder for it.
 */
export function exclusiveActiveControlIdForEntries(
  entries: readonly GroupedSqueezeEntry[],
): string | null {
  for (const entry of entries) {
    if (isExclusiveActiveToolControl(entry.control)) return entry.control.id;
  }
  return null;
}

/**
 * Effective main-strip group id.
 * Delegates to `stripGroupIdForCategory`: the declared `groupId`, or the
 * category id itself when absent/blank (singleton group). Never guess
 * from labels, icons, or id substrings.
 */
export function effectiveStripGroupIdForResolver(category: {
  readonly id: string;
  readonly groupId?: string;
}): string {
  return stripGroupIdForCategory(category);
}

/**
 * Effective shelf slot id.
 * Delegates to `slotIdForItem`: the declared `slotId`, or the item id
 * itself when absent/blank (unslotted items keep verbatim order keyed by
 * item id). Never re-sorts; ordering stays with
 * `order`/`priority`/`before`/`after` plus user-order overlays.
 */
export function effectiveShelfSlotIdForResolver(item: {
  readonly id: string;
  readonly slotId?: string;
}): string {
  return slotIdForItem(item);
}

/**
 * Bucket categories by effective strip group for the grouped main strip
 * (one-active-indicator-per-group, verbatim).
 *
 * Delegates to `groupCategoriesByStripGroup`: first-seen group order,
 * member order untouched within each group. Grouping is bucket-only and
 * never breaks `before`/`after` or user-order overlays (those already
 * resolved upstream in `resolveToolbarComposition`). Pure structure:
 * returns the input entries grouped for presentation; callers map back
 * through the owned pool so execution still routes via owners.
 */
export function bucketStripGroupsForResolver<
  T extends { readonly id: string; readonly groupId?: string },
>(categories: readonly T[]): ReadonlyMap<string, readonly T[]> {
  return groupCategoriesByStripGroup(categories);
}

/**
 * Shelf capacity is planned through the shared planner. Overflow goes to
 * More without a second row, while priority order and grouping are preserved.
 *
 * Delegates to `planShelfCells` (itself over `planToolbarCompaction`) so
 * the shelf shares one semantics with the geometric islands: trigger
 * reserve, priority survival, and hysteresis with sticky
 * `overflowIds` — never a second breakpoint, never a window query.
 * Priority contract (descending survival): active tool (100, required) >
 * settings disclosure (95, required) > family tools (90) > favorites (70)
 * > widths (60) > colors (55) > modes (40); callers build cells with
 * those priorities (see `estimateShelfCells`/`estimateShelfQuickBudgets`
 * in `UnifiedToolbar.tsx`). Overflowed cells render in the explicit More
 * menu behind `ToolbarPopoverPortal`, never in a second full-width row
 * and never in invisible scroll.
 */
export function partitionGroupedShelf(
  cells: readonly ShelfCapacityCell[],
  availableWidth: number,
  options: {
    readonly overflowWidth?: number;
    readonly overflowGap?: number;
    readonly hysteresis?: number;
    readonly overflowIds?: ReadonlySet<string>;
  } = {},
): {
  readonly visible: readonly string[];
  readonly overflow: readonly string[];
} {
  return planShelfCells(cells, availableWidth, options);
}

/**
 * Live settings for one target tool semantic role.
 *
 * Delegates to `settingsForTool`: the resolved graph is the dormancy
 * authority, so a settings entry is live only when its target tool
 * resolved in the same projection and its own control is present.
 * Otherwise it stays dormant in `graph.unresolved` and revives when the
 * target returns — never a crash, never an orphan execution. Empty when
 * the graph is absent, the role is absent/blank, or the target has no
 * live settings. Keys on `targetSemanticRole` alone — never on UI
 * strings or control-id suffixes. Structure only: callers map the
 * returned entries back through the owned pool (`ownedById`) so the
 * provider/shell/contribution owner still routes execution.
 */
export function liveSettingsForActiveTool(
  graph: ResolvedToolbarGraph | null,
  targetSemanticRole: string | null | undefined,
): readonly ResolvedToolbarSettings[] {
  return settingsForTool(graph, targetSemanticRole);
}
