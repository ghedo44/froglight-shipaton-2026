/**
 * Pencil quick-palette model.
 *
 * Pure, framework-free builder converting a provider-neutral
 * `DocumentToolSnapshot` into Pencil-palette presentation data. Ink,
 * Notebook, and Whiteboard remain provider-neutral: the palette never
 * duplicates color/width constants and never inspects editor-engine objects.
 */

import type {
  DocumentToolControl,
  DocumentToolSnapshot,
  SurfaceToolRole,
  ToolbarActivationRole,
} from '@froglight/foundation';
import { isExclusiveActiveToolControl } from '@froglight/foundation';
import type { ToolbarCustomizationStore } from './toolbar/toolbar-customization.js';
import type { MenuEntry } from './menu.js';
import type { ResolvedToolbarGraph } from './toolbar/composition-registry.js';
import type {
  OwnedToolbarControl,
  ToolbarControlOwner,
} from './toolbar/placement-resolver.js';

export type StylusPaletteFocusMode = 'full' | 'color' | 'attributes';

export interface StylusPaletteTool {
  readonly id: string;
  readonly label: string;
  readonly shortLabel?: string;
  readonly icon?: string;
  readonly toolRole?: SurfaceToolRole;
  /**
   * Provider-neutral semantic identity copied from the source control
   * The compact squeeze tier policy keys on this plus
   * `toolRole` — never on control-id shapes — so pen siblings, shapes,
   * inserts, and community actions classify by meaning, not by id text.
   */
  readonly semanticRole?: string;
  readonly active: boolean;
  readonly disabled?: boolean;
  /**
   * Exclusive-tool vs toggle semantics copied from the source control
   * Palette `activeToolId` ignores `toggle`-active tools;
   * absent preserves the legacy `active === true` behavior.
   */
  readonly activationRole?: ToolbarActivationRole;
  /**
   * Resolved execution owner from the assembled owned pool. Present when
   * the model was built from `ownedPool`; absent for legacy snapshot-only
   * callers (hook falls back to the provider channel).
   */
  readonly owner?: ToolbarControlOwner;
}

export interface StylusPaletteColorControl {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly options: readonly string[];
}

export interface StylusPaletteWidthControl {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly options: readonly {
    readonly value: string;
    readonly label: string;
  }[];
}

export interface StylusPaletteEraserControl {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly step: number;
}
export interface StylusPaletteStyleControl {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly options: readonly {
    readonly value: string;
    readonly label: string;
  }[];
}

export interface StylusPaletteModel {
  readonly tools: readonly StylusPaletteTool[];
  readonly activeToolId: string | null;
  readonly color: StylusPaletteColorControl | null;
  readonly width: StylusPaletteWidthControl | null;
  readonly eraserSize: StylusPaletteEraserControl | null;
  readonly styles: StylusPaletteStyleControl | null;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly focusMode: StylusPaletteFocusMode;
  /** Registry contributions rendered in a "More" section. */
  readonly contributions: readonly MenuEntry[];
  /**
   * Owned controls backing the visible palette (tools + style controls) in
   * palette order. Absent/empty for legacy snapshot-only models (including
   * hand-built overlay fixtures). The shell hook routes every palette
   * selection through the preserved owner when present (provider via
   * `executeEditorTool`, shell via `execEditorCommand`, contribution via
   * `executeOwned`) and falls back to the provider channel otherwise.
   */
  readonly owned?: readonly OwnedToolbarControl[];
}

export interface StylusPaletteModelOptions {
  readonly slots?: Pick<
    ToolbarCustomizationStore,
    'slotColorsForFamily' | 'slotSizesForFamily' | 'slotSizesForEraser'
  >;
  readonly canUndo?: boolean;
  readonly canRedo?: boolean;
  readonly focusMode?: StylusPaletteFocusMode;
  readonly contributions?: readonly MenuEntry[];
  readonly composition?: ResolvedToolbarGraph;
  /**
   * Full assembled owned pool (provider + shell + trusted + community) as
   * resolved by `assembleOwnedPool`. When present, tools carry their
   * preserved owner and `owned` mirrors the backing entries. When absent,
   * the builder keeps the legacy snapshot-only behavior (surface-tool
   * filter, no owners, empty `owned`).
   */
  readonly ownedPool?: readonly OwnedToolbarControl[];
}

/** Role priority for primary palette tools (pen-first, select-last). */
const ROLE_PRIORITY: Record<string, number> = {
  pen: 0,
  highlighter: 1,
  eraser: 2,
  lasso: 3,
  select: 4,
};

function toolRoleOf(
  control: DocumentToolSnapshot['controls'][number],
): SurfaceToolRole | undefined {
  if (control.kind !== 'button') return undefined;
  if (control.toolRole !== undefined) return control.toolRole;
  return undefined;
}

function isSurfaceToolButton(
  control: DocumentToolSnapshot['controls'][number],
): control is Extract<
  DocumentToolSnapshot['controls'][number],
  { kind: 'button' }
> {
  // Explicit provider metadata only: surface draw tools carry
  // `role: 'surface-tool'`. Never infer from control-id prefixes or
  // `semanticRole` string shapes; unknown provider dialects stay inert
  // rather than guessing.
  if (control.kind !== 'button') return false;
  return control.role === 'surface-tool';
}

/** Explicit semantic roles for palette style controls (no id parsing, no untagged fallback).*/
const COLOR_ROLES = new Set([
  'surface.style.color',
  'surface.settings.color',
]);
const WIDTH_ROLES = new Set(['surface.style.width', 'surface.settings.size']);
const ERASER_SIZE_ROLES = new Set([
  'surface.erase.size',
  'surface.settings.eraser-size',
]);
const SAVED_STYLE_ROLES = new Set(['surface.style.saved']);

/**
 * Maximum favorite styles in the squeeze quick-style region. Mirrors the
 * shelf cap shape (`selectShelfQuicks` slices to three) but keeps the
 * squeeze budget of four established before: favorites-only, never
 * filled from non-favorites.
 */
export const SQUEEZE_MAX_FAVORITE_STYLES = 4;

/**
 *  favorites-first projection (15,21).
 *
 * The squeeze quick-style region shows favorites — never the first-N saved
 * styles. Authority is the structured `savedStyles` payload from the
 * style-library contract (`SavedStyleCardData{favorite}`, library order =
 * user order via `setFavorite`/`reorder`):
 *
 * - favorites in `savedStyles` order (user order, reorder-preserving);
 * - non-favorites never occupy a slot (favorites-only, capped);
 * - deleted styles disappear (joined against live `options`: a favorite
 *   without a matching option, or an option without a matching favorite,
 *   never synthesizes a slot);
 * - the working style (`value === ''`) never masquerades (always excluded;
 *   `value` itself is preserved verbatim so a working/non-favorite current
 *   simply presses nothing);
 * - pure projection: no library mutation on open, shared cross-document
 *   state stays live because every open/refresh rebuilds from the current
 *   snapshot (the binder `refreshSqueezePalette` options comparison pushes
 *   favorite/reorder/delete changes in place).
 *
 * Legacy snapshots without the structured payload keep the prior
 * first-N slice explicitly (isolated compat): without
 * `savedStyles` there is no favorite signal to project, and label-prefix
 * parsing is forbidden (never parse display labels).
 */
function projectSqueezeFavoriteStyles(
  control: Extract<DocumentToolControl, { kind: 'choice' }>,
): readonly { readonly value: string; readonly label: string }[] {
  const withoutWorking = control.options.filter(
    (option) => option.value !== '',
  );
  const saved = control.savedStyles;
  if (saved === undefined) {
    return withoutWorking.slice(0, SQUEEZE_MAX_FAVORITE_STYLES);
  }
  const optionByValue = new Map(
    withoutWorking.map((option) => [option.value, option]),
  );
  const projected: { readonly value: string; readonly label: string }[] = [];
  const seen = new Set<string>();
  for (const style of saved) {
    if (style.favorite !== true) continue;
    if (style.id === '' || seen.has(style.id)) continue;
    const option = optionByValue.get(style.id);
    if (option === undefined) continue;
    seen.add(style.id);
    projected.push(option);
    if (projected.length >= SQUEEZE_MAX_FAVORITE_STYLES) break;
  }
  return projected;
}

/**
 * Build the Pencil palette model from a provider snapshot. Returns null for
 * non-surface editors (no surface tools) so the binder stays inert in
 * Markdown/settings/etc. Never duplicates provider color/width constants:
 * style controls use the toolbar slot store when supplied, otherwise the
 * options in the provider snapshot.
 *
 * When `ownedPool` is present, tools carry their preserved execution owner
 * and `owned` mirrors the backing entries so the shell hook routes through
 * the original owner. When `composition` (squeeze projection) is present,
 * squeeze membership comes from the composition graph alone (explicit
 * `projections`/`semanticRole`, never id-shape inference): every button in
 * the projected graph becomes a palette tool, including community
 * `showInSqueeze` contributions that are not `surface-tool` buttons.
 *
 *  decision: squeeze style controls (color/width/eraserSize/saved
 * styles) are composition-driven too, not documented non-composition quick
 * state. Tools were already projection-driven while styles resolved from
 * the raw pool/snapshot, so a style hidden from squeeze in composition
 * still appeared in the palette — accidental, not designed. With a
 * composition present, a style control now resolves only when its
 * semanticRole is projected into the squeeze graph (see the squeeze-only
 * style items in `toolbar/default-composition.ts`); `focusMode`
 * (showColorPalette/showInkAttributes/showContextualPalette) then selects
 * which projected styles the overlay presents. Owner routing is unchanged:
 * styles still resolve from the owned pool and keep their owner in
 * `owned`. Without a composition, the legacy pool/snapshot role match is
 * preserved. keeps this contract and only changes presentation
 * geometry; widening style projections to normal/compact belongs to
 *  (composition-driven shelf/popover).
 */
export function buildStylusPaletteModel(
  snapshot: DocumentToolSnapshot | null,
  options: StylusPaletteModelOptions = {},
): StylusPaletteModel | null {
  if (snapshot === null) return null;
  const ownedPool = options.ownedPool;
  const ownedById = new Map<string, OwnedToolbarControl>(
    (ownedPool ?? []).map((owned) => [owned.control.id, owned]),
  );
  const ownerOf = (
    control: DocumentToolControl,
  ): { owner: ToolbarControlOwner } | Record<string, never> => {
    const owned = ownedById.get(control.id);
    return owned !== undefined ? { owner: owned.owner } : {};
  };
  const tools: StylusPaletteTool[] = [];
  const projectedControls =
    options.composition === undefined
      ? (ownedPool !== undefined
          ? ownedPool.map((owned) => owned.control)
          : snapshot.controls)
      : options.composition.categories.flatMap((category) =>
          category.items.map((item) => item.control),
        );
  // dual-homed presenters (Text creation via Insert + Text)
  // resolve to ONE provider control appearing twice in composition order.
  // Dedupe by control id, first occurrence wins (composition order), so
  // the squeeze palette never shows Text twice and the crescent budget
  // counts it once. Same rule applies to the legacy pool path below.
  const seenProjectedIds = new Set<string>();
  const dedupedProjectedControls: DocumentToolControl[] = [];
  for (const control of projectedControls) {
    if (seenProjectedIds.has(control.id)) continue;
    seenProjectedIds.add(control.id);
    dedupedProjectedControls.push(control);
  }
  const useCompositionMembership = options.composition !== undefined;
  for (const control of dedupedProjectedControls) {
    if (control.kind !== 'button') continue;
    // Squeeze membership is the composition graph (explicit projections +
    // semanticRole). Without a composition, keep the legacy surface-tool
    // filter so unknown dialects stay inert rather than guessing from ids.
    if (!useCompositionMembership && !isSurfaceToolButton(control)) continue;
    const role = toolRoleOf(control);
    tools.push({
      id: control.id,
      label: control.label,
      ...(control.shortLabel !== undefined
        ? { shortLabel: control.shortLabel }
        : {}),
      ...(control.icon !== undefined ? { icon: control.icon } : {}),
      ...(role !== undefined ? { toolRole: role } : {}),
      ...(control.semanticRole !== undefined
        ? { semanticRole: control.semanticRole }
        : {}),
      active: control.active === true,
      ...(control.kind === 'button' &&
      control.activationRole !== undefined
        ? { activationRole: control.activationRole }
        : {}),
      ...(control.disabled === true ? { disabled: true as const } : {}),
      ...ownerOf(control),
    });
  }
  if (tools.length === 0) return null;
  // Composition is the single ordering authority: when a resolved graph is
  // present, `projectedControls` already carries category order + item order
  // (including before/after) and must be preserved verbatim. The coarse
  // ROLE_PRIORITY sort below is legacy snapshot-only behavior (no
  // composition) so unknown dialects keep a stable pen-first presentation.
  if (!useCompositionMembership) {
    // Primary roles first (pen/highlighter/eraser/lasso/select), then
    // family-specific drawing tools in snapshot order.
    tools.sort((a, b) => {
      const pa =
        a.toolRole !== undefined ? (ROLE_PRIORITY[a.toolRole] ?? 10) : 10;
      const pb =
        b.toolRole !== undefined ? (ROLE_PRIORITY[b.toolRole] ?? 10) : 10;
      return pa - pb;
    });
  }
  // Exclusive-tool reconciliation only: toggle-active tools stay visually
  // active but never become the palette's activeToolId. Legacy tools
  // without activationRole keep the historic `active === true` behavior
  // (see `isExclusiveActiveToolControl`).
  const controlById = new Map(
    dedupedProjectedControls.map((entry) => [entry.id, entry]),
  );
  const active =
    tools.find((tool) => {
      const source = controlById.get(tool.id);
      return (
        source !== undefined && isExclusiveActiveToolControl(source)
      );
    }) ?? null;

  let color: StylusPaletteColorControl | null = null;
  let width: StylusPaletteWidthControl | null = null;
  let eraserSize: StylusPaletteEraserControl | null = null;
  let styles: StylusPaletteStyleControl | null = null;
  // Style controls resolve from the same owned pool as tools when present
  // (explicit semanticRole match, never id inference), so plugin-owned
  // style controls keep their owner in `owned` below.: with a
  // squeeze composition, membership is projection-driven — a style control
  // whose semanticRole is not projected into the squeeze graph stays
  // hidden, exactly like a tool with showInSqueeze=false. The projected
  // role set (not control identity) is the gate so pool/snapshot skew
  // cannot leak an unprojected style; the palette's quick-preferred,
  // settings-fallback priority within COLOR/WIDTH/ERASER sets is unchanged.
  const styleControls =
    ownedPool !== undefined
      ? ownedPool.map((owned) => owned.control)
      : snapshot.controls;
  const projectedStyleRoles =
    options.composition !== undefined
      ? new Set(
          options.composition.categories.flatMap((category) =>
            category.items.map((item) => item.semanticRole),
          ),
        )
      : null;
  for (const control of styleControls) {
    if (
      projectedStyleRoles !== null &&
      (control.semanticRole === undefined ||
        !projectedStyleRoles.has(control.semanticRole))
    ) {
      continue;
    }
    const role = control.semanticRole;
    if (control.kind === 'color' && color === null) {
      // Explicit semantic roles only: quick color
      // (`surface.style.color`) wins; settings color
      // (`surface.settings.color`) fills when quick is absent. An untagged
      // color (no semanticRole) stays inert — never id-suffix inference,
      // never an implicit color fallback.
      if (role !== undefined && COLOR_ROLES.has(role)) {
        color = {
          id: control.id,
          label: control.label,
          value: control.value,
          options: control.options,
        };
      }
    } else if (
      control.kind === 'choice' &&
      styles === null &&
      role !== undefined &&
      SAVED_STYLE_ROLES.has(role)
    ) {
      const projected = projectSqueezeFavoriteStyles(control);
      // Empty quick list hides (no favorite slots occupied): leave `styles`
      // null so the overlay renders no Saved-styles section rather than an
      // empty header. Non-empty keeps the provider `value` verbatim —
      // working (`''`) or non-favorite currents simply press nothing.
      if (projected.length > 0) {
        styles = {
          id: control.id,
          label: control.label,
          value: control.value,
          options: projected,
        };
      }
    } else if (
      control.kind === 'choice' &&
      width === null &&
      role !== undefined &&
      WIDTH_ROLES.has(role)
    ) {
      width = {
        id: control.id,
        label: control.label,
        value: control.value,
        options: control.options,
      };
    } else if (
      control.kind === 'range' &&
      eraserSize === null &&
      role !== undefined &&
      ERASER_SIZE_ROLES.has(role)
    ) {
      eraserSize = {
        id: control.id,
        label: control.label,
        value: control.value,
        min: control.min,
        max: control.max,
        step: control.step,
      };
    }
  }

  // Resolve the same user-edited triples as the pane toolbar. Controls keep
  // their execution owner; slot values are presentation preferences only.
  if (options.slots !== undefined) {
    const family =
      active?.toolRole === 'highlighter'
        ? 'highlighter'
        : active?.toolRole === 'pen' ||
            active?.semanticRole?.startsWith('surface.shape.')
          ? 'pen'
          : null;
    if (family !== null) {
      if (color !== null)
        color = {
          ...color,
          options: options.slots.slotColorsForFamily(family),
        };
      if (width !== null)
        width = {
          ...width,
          options: options.slots
            .slotSizesForFamily(family)
            .map((value) => ({ value: String(value), label: `${value} px` })),
        };
      eraserSize = null;
    } else {
      color = null;
      width =
        active?.toolRole === 'eraser' && eraserSize !== null
          ? {
              id: eraserSize.id,
              label: eraserSize.label,
              value: String(eraserSize.value),
              options: options.slots
                .slotSizesForEraser()
                .map((value) => ({
                  value: String(value),
                  label: `${value} px`,
                })),
            }
          : null;
      eraserSize = null;
      styles = null;
    }
  }

  return {
    tools,
    activeToolId: active?.id ?? null,
    color,
    width,
    eraserSize,
    styles,
    canUndo: options.canUndo ?? false,
    canRedo: options.canRedo ?? false,
    focusMode: options.focusMode ?? 'full',
    contributions: options.contributions ?? [],
    owned: collectPaletteOwned({
      tools,
      color,
      width,
      eraserSize,
      styles,
      ownedById,
    }),
  };
}

/**
 *  compact squeeze tiers (25): the main crescent
 * stays a single grid row — never a second/third row — while pen
 * siblings, shapes, inserts, and community actions remain reachable in
 * the secondary strip / More without being misrepresented as drawing
 * tools.
 *
 * - `primary`: the compact crescent (at most `SQUEEZE_MAX_PRIMARY`, one
 *   grid row of five). Five stable slots cover the full Surface grammar
 *   without crowding: one pen-family representative (active pen, else
 *   first pen in composition order — siblings never consume extra slots),
 *   Highlighter, Eraser, one select-family representative (active
 *   select/lasso, else first — never both), and one contextual
 *   shape/insert representative (active shape/insert, else the first
 *   shape/insert in composition order). The active surface tool is always
 *   included when it carries a `toolRole`; role-less community commands
 *   never promote (they are actions, not drawing tools).
 * - `secondary`: every other squeeze-projected tool in composition order —
 *   non-active pen siblings, the non-active select sibling, non-contextual
 *   shapes/inserts, and role-less community `showInSqueeze` actions with
 *   the same owner routing.
 * - `More`: `StylusMenuRegistry` entries (`model.contributions`) — the More
 *   section, unchanged.
 *
 * Tiering is presentation-only and composition-order preserving: the
 * primary set is emitted in incoming (composition) order, and the
 * secondary set keeps incoming order for the remainder. Membership keys
 * on explicit semantic metadata (`toolRole` + `semanticRole`) — never on
 * control-id text shapes. Stable IDs/owners are untouched; there is no
 * second store.
 */
export type SqueezeToolTier = 'primary' | 'secondary';

/**
 * Maximum tools in the main crescent. Matches the overlay grid
 * (`repeat(5, …)` in `StylusPaletteOverlay.module.css`): five fills one
 * row exactly, six would wrap into a second row and break the smile/frown
 * arc (`nth-child(1..5)` transforms).
 */
export const SQUEEZE_MAX_PRIMARY = 5;

type SqueezeTierInput = Pick<
  StylusPaletteTool,
  'toolRole' | 'semanticRole'
>;

/**
 * True for the contextual shape/insert family: coarse `shape`/`text`
 * roles plus `surface.shape.*` / `surface.insert.*` semantic roles (the
 * latter covers insert controls such as image/card that carry no coarse
 * `toolRole`). Semantic-role prefixes — not control-id text — are the
 * explicit semantic concern here; community `community.*` roles never
 * match.
 */
function isSqueezeContextualRole(tool: SqueezeTierInput): boolean {
  if (tool.toolRole === 'shape' || tool.toolRole === 'text') return true;
  const role = tool.semanticRole;
  if (role === undefined) return false;
  return role.startsWith('surface.shape.') || role.startsWith('surface.insert.');
}

function isSelectFamilyRole(
  tool: SqueezeTierInput,
): boolean {
  return tool.toolRole === 'select' || tool.toolRole === 'lasso';
}

/**
 * Base per-tool eligibility (no list context): crescent-eligible drawing
 * families only. Narrower than the old over-broad `toolRole !== undefined`
 * check — `shape`/`text` are deliberately secondary here; the compact
 * selector (`splitSqueezeTools`) promotes at most one contextual back to
 * primary. Role-less community actions are always secondary so commands
 * are never misrepresented as drawing tools.
 */
export function squeezeToolTier(tool: StylusPaletteTool): SqueezeToolTier {
  switch (tool.toolRole) {
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

export interface SplitSqueezeToolsOptions {
  /**
   * Exclusive active tool id (prefer `model.activeToolId`, which already
   * excludes toggle-active controls). Falls back to the first exclusive-
   * active tool in `tools` when absent. A role-less active id (community
   * command) never promotes — it stays secondary.
   */
  readonly activeToolId?: string | null;
}

function resolveSqueezeActiveId(
  tools: readonly StylusPaletteTool[],
  activeToolId?: string | null,
): string | null {
  if (activeToolId !== undefined && activeToolId !== null) return activeToolId;
  const flagged =
    tools.find(
      (tool) => tool.active && tool.activationRole !== 'toggle',
    ) ?? null;
  return flagged?.id ?? null;
}

export function splitSqueezeTools(
  tools: readonly StylusPaletteTool[],
  options: SplitSqueezeToolsOptions = {},
): {
  readonly primary: readonly StylusPaletteTool[];
  readonly secondary: readonly StylusPaletteTool[];
} {
  if (tools.length === 0) return { primary: [], secondary: [] };
  // dedupe by control id, first occurrence wins in composition
  // order. Dual-homed presenters (Text via Insert + Text) otherwise count
  // twice toward the bounded crescent and render duplicate entries.
  const seenIds = new Set<string>();
  const uniqueTools: StylusPaletteTool[] = [];
  for (const tool of tools) {
    if (seenIds.has(tool.id)) continue;
    seenIds.add(tool.id);
    uniqueTools.push(tool);
  }
  const byId = new Map(uniqueTools.map((tool) => [tool.id, tool]));
  const activeId = resolveSqueezeActiveId(uniqueTools, options.activeToolId);
  const active =
    activeId !== null ? (byId.get(activeId) ?? null) : null;
  // Only surface tools promote: a role-less active community command is an
  // action, not a drawing tool, and stays in the secondary strip.
  const activeSurfaceTool =
    active !== null && active.toolRole !== undefined ? active : null;

  const indexOf = new Map(uniqueTools.map((tool, index) => [tool.id, index]));
  const firstOf = (
    predicate: (tool: StylusPaletteTool) => boolean,
  ): StylusPaletteTool | null => uniqueTools.find(predicate) ?? null;
  const activeIn = (
    predicate: (tool: StylusPaletteTool) => boolean,
  ): StylusPaletteTool | null =>
    activeSurfaceTool !== null && predicate(activeSurfaceTool)
      ? activeSurfaceTool
      : null;

  const isPen = (tool: StylusPaletteTool): boolean => tool.toolRole === 'pen';
  // Five stable slots: pen rep, highlighter, eraser, select rep, one
  // contextual. Each slot holds at most one tool; the active surface tool
  // always occupies its own family's slot so it is never evicted.
  const penRep =
    activeIn(isPen) ?? firstOf(isPen);
  const highlighterRep =
    activeIn((tool) => tool.toolRole === 'highlighter') ??
    firstOf((tool) => tool.toolRole === 'highlighter');
  const eraserRep =
    activeIn((tool) => tool.toolRole === 'eraser') ??
    firstOf((tool) => tool.toolRole === 'eraser');
  const selectRep =
    activeIn(isSelectFamilyRole) ?? firstOf(isSelectFamilyRole);
  const contextualRep =
    activeIn(isSqueezeContextualRole) ?? firstOf(isSqueezeContextualRole);

  let primaryIds = new Set<string>();
  for (const rep of [penRep, highlighterRep, eraserRep, selectRep, contextualRep]) {
    if (rep !== null) primaryIds.add(rep.id);
  }
  // Safety net: an active surface tool outside the five families (future
  // coarse roles) still joins the crescent rather than vanishing.
  if (
    activeSurfaceTool !== null &&
    !primaryIds.has(activeSurfaceTool.id)
  ) {
    primaryIds.add(activeSurfaceTool.id);
  }

  // Composition order preserved verbatim per tier: primary in incoming
  // order, secondary the remainder in incoming order.
  const orderByIndex = (
    a: StylusPaletteTool,
    b: StylusPaletteTool,
  ): number => (indexOf.get(a.id) ?? 0) - (indexOf.get(b.id) ?? 0);
  let primary = uniqueTools
    .filter((tool) => primaryIds.has(tool.id))
    .sort(orderByIndex);
  // Bound the crescent to one grid row; overflow (only possible for
  // future families beyond the five slots) spills to the secondary strip
  // in composition order, active first-never-evicted.
  if (primary.length > SQUEEZE_MAX_PRIMARY) {
    const activeKept = primary.filter(
      (tool) => tool.id === activeSurfaceTool?.id,
    );
    const rest = primary.filter(
      (tool) => tool.id !== activeSurfaceTool?.id,
    );
    primary = [...activeKept, ...rest].slice(0, SQUEEZE_MAX_PRIMARY);
    primaryIds = new Set(primary.map((tool) => tool.id));
  }
  const secondary = uniqueTools
    .filter((tool) => !primaryIds.has(tool.id))
    .sort(orderByIndex);
  return { primary, secondary };
}

/**
 * Owned entries backing the visible palette (tools + style controls) in
 * palette order. Used by the shell hook to route every selection through
 * the preserved owner. Empty for legacy snapshot-only models.
 */
function collectPaletteOwned(input: {
  readonly tools: readonly StylusPaletteTool[];
  readonly color: StylusPaletteColorControl | null;
  readonly width: StylusPaletteWidthControl | null;
  readonly eraserSize: StylusPaletteEraserControl | null;
  readonly styles: StylusPaletteStyleControl | null;
  readonly ownedById: ReadonlyMap<string, OwnedToolbarControl>;
}): readonly OwnedToolbarControl[] {
  const seen = new Set<string>();
  const owned: OwnedToolbarControl[] = [];
  const push = (id: string | null): void => {
    if (id === null || seen.has(id)) return;
    seen.add(id);
    const entry = input.ownedById.get(id);
    if (entry !== undefined) owned.push(entry);
  };
  for (const tool of input.tools) push(tool.id);
  push(input.color?.id ?? null);
  push(input.styles?.id ?? null);
  push(input.width?.id ?? null);
  push(input.eraserSize?.id ?? null);
  return owned;
}
