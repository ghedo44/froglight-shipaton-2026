import type { DocumentToolSnapshot } from '@froglight/foundation';
import { isExclusiveActiveToolControl } from '@froglight/foundation';
import type { WorkbenchEditorToolsPort } from '../workbench-ports.js';
import type {
  DocumentToolbarContext,
  DocumentToolbarRegistry,
} from '../document-toolbar-registry.js';
import type { ToolbarPlacementRegistry } from './placement-registry.js';
import {
  resolveToolbarComposition,
  settingsForTool,
  SURFACE_TEXT_CATEGORY_ID,
  SURFACE_TEXT_CREATION_ROLE,
  type ResolvedToolbarGraph,
  type ToolbarCompositionRegistry,
  type ToolbarCompositionSnapshot,
} from './composition-registry.js';
import {
  assembleOwnedPool,
  resolveToolbarGroups,
  shellHistoryOwnedControls,
  type OwnedToolbarControl,
  type ResolvedToolbarLayout,
} from './placement-resolver.js';

export async function executeOwnedControl(
  deps: {
    readonly tools: WorkbenchEditorToolsPort;
    readonly contributions: DocumentToolbarRegistry;
    readonly pane: string;
    readonly context: DocumentToolbarContext;
  },
  item: OwnedToolbarControl,
  value?: string,
): Promise<void> {
  switch (item.owner.kind) {
    case 'provider':
      await deps.tools.executeEditorTool(deps.pane, item.control.id, value);
      return;
    case 'shell':
      deps.tools.execEditorCommand(item.owner.command, deps.pane);
      return;
    case 'contribution':
      await deps.contributions.executeOwned(
        item.owner.contributionId,
        deps.context,
        item.control.id,
        value,
      );
      return;
  }
}

/**
 * Category containing the actually active tool in a resolved composition
 * graph. Pure derivation from provider snapshot state: categories with an
 * exclusive active tool control (`activationRole !== 'toggle'`).
 *
 * Alias-aware: the Text creation tool
 * (`surface.insert.text`) is dual-homed via `surface.insert.text` +
 * `surface.text.create` behind one provider control, so it is active in
 * BOTH `surface.insert` and `surface.text` at once. The canonical home is
 * `surface.text`: whenever that category holds the active creation tool,
 * attribute there — deterministically, independent of manual browsing —
 * so the shelf, the strip marker, and compact active-inclusion agree on
 * Text (not Insert). Every other duplicate keeps deterministic
 * Insert-first (first category in composition order); when a future alias
 * matches the browsed `selectedCategoryId`, that presenter wins so
 * browsing never ejects on activation. Format toggles (Bold active) never
 * drive an exclusive transition; controls without `activationRole`
 * keep the historic `active === true` behavior. Browse state
 * (`activeCategoryId`) stays separate: this derivation never reads the
 * manual selection except as the documented alias tiebreak.
 */
export function resolveActiveToolCategoryId(
  graph: ResolvedToolbarGraph | null,
  selectedCategoryId: string | null = null,
): string | null {
  if (graph === null) return null;
  const matched = graph.categories.filter((category) =>
    category.items.some((item) => isExclusiveActiveToolControl(item.control)),
  );
  if (matched.length === 0) return null;
  if (matched.length === 1) return matched[0]?.id ?? null;
  // Dual-homed alias: Text creation active in both presenters at once.
  // Canonical home wins even unbrowsed so Insert-first never steals Text.
  const textMatch = matched.find(
    (category) =>
      category.id === SURFACE_TEXT_CATEGORY_ID &&
      category.items.some(
        (item) =>
          isExclusiveActiveToolControl(item.control) &&
          item.control.semanticRole === SURFACE_TEXT_CREATION_ROLE,
      ),
  );
  if (textMatch !== undefined) return textMatch.id;
  // Future aliases: the browsed presenter wins when it holds the active
  // tool; otherwise deterministic composition order (Insert-first).
  if (
    selectedCategoryId !== null &&
    matched.some((category) => category.id === selectedCategoryId)
  ) {
    return selectedCategoryId;
  }
  return (
    graph.categories.find((category) =>
      matched.some((candidate) => candidate.id === category.id),
    )?.id ??
    matched[0]?.id ??
    null
  );
}

/**
 * Executable control id of the active tool in a resolved composition
 * graph, if any. Used to detect real tool changes across snapshots
 * (squeeze, double-tap, shortcuts, provider commands, temporary eraser,
 * plugins, restore) independently of manual category browsing.
 * Toggle-active controls (Bold) never count; legacy controls without
 * `activationRole` keep the historic `active === true` behavior.
 */
export function resolveActiveToolControlId(
  graph: ResolvedToolbarGraph | null,
): string | null {
  if (graph === null) return null;
  for (const category of graph.categories) {
    for (const item of category.items) {
      if (isExclusiveActiveToolControl(item.control)) return item.control.id;
    }
  }
  return null;
}

/**
 * Semantic role of the active tool in a resolved composition graph, if any
 * in the composition graph.
 *
 * Settings scoping keys on this role — never on UI strings or control-id
 * suffixes. Toggle-active controls (Bold) never count; legacy controls
 * without `activationRole` keep the historic `active === true` behavior via
 * `isExclusiveActiveToolControl`, shared with the category/control derivations
 * above so all three agree on the same active tool (including same-category
 * Pen → Pencil switches that keep the category but change the role).
 */
export function resolveActiveToolSemanticRole(
  graph: ResolvedToolbarGraph | null,
): string | null {
  if (graph === null) return null;
  for (const category of graph.categories) {
    for (const item of category.items) {
      if (isExclusiveActiveToolControl(item.control))
        return item.control.semanticRole ?? null;
    }
  }
  return null;
}

/**
 * Expanded category driving the shelf: manual selection wins while it
 * still names a live category, otherwise fall back to the active-tool
 * category, otherwise the first category. Callers reconcile stale manual
 * selections on real tool changes (see provider effect below). The
 * active-tool fallback stays alias-aware (Text creation attributes to
 * `surface.text`) so an unbrowsed Text-active graph expands on Text.
 */
export function resolveExpandedCategoryId(
  graph: ResolvedToolbarGraph | null,
  selectedCategoryId: string | null,
): string | null {
  const categories = graph?.categories ?? [];
  if (categories.length === 0) return null;
  if (
    selectedCategoryId !== null &&
    categories.some((category) => category.id === selectedCategoryId)
  )
    return selectedCategoryId;
  return (
    resolveActiveToolCategoryId(graph, selectedCategoryId) ??
    categories[0]?.id ??
    null
  );
}

/**
 * Semantic roles of composition settings entries that are dormant in the
 * resolved graph. Presentation consults this set so a
 * settings control whose target tool is gone never surfaces in the popover:
 * `graph.settings` is the dormancy authority; the owned pool alone is not.
 * Controls with no composition settings entry are unaffected.
 */
function dormantCompositionSettingsRoles(input: {
  readonly snapshot: ToolbarCompositionSnapshot;
  readonly unresolved: readonly string[];
}): ReadonlySet<string> {
  const dormant = new Set(input.unresolved);
  const roles = new Set<string>();
  const collect = (
    entries:
      | readonly { readonly id: string; readonly semanticRole: string }[]
      | undefined,
  ): void => {
    for (const entry of entries ?? [])
      if (dormant.has(entry.id)) roles.add(entry.semanticRole);
  };
  collect(input.snapshot.settings);
  for (const extension of input.snapshot.extensions ?? [])
    collect(extension.settings);
  return roles;
}

/**
 * Every semantic role claimed by a composition settings entry (live or
 * dormant), from the snapshot plus kind extensions.
 *
 * Distinguishes composition-backed controls (scoped to the active tool via
 * `settingsForTool`) from controls with no composition entry (which
 * keep the unplaced `group === 'settings'` behavior unchanged, e.g.
 * first-party Surface settings built per-active-tool by the provider and
 * specs without a composition).
 */
function compositionSettingsRoles(
  snapshot: ToolbarCompositionSnapshot,
): ReadonlySet<string> {
  const roles = new Set<string>();
  for (const entry of snapshot.settings ?? []) roles.add(entry.semanticRole);
  for (const extension of snapshot.extensions ?? [])
    for (const entry of extension.settings ?? []) roles.add(entry.semanticRole);
  return roles;
}

/**
 * Built-in shell history placement. History is
 * shell-owned semantic controls at a real geometric anchor, not a hard-coded
 * zone. Built in so empty registries (e.g. test harnesses) still resolve
 * history; a registry placement with the same id overrides it so plugins
 * can move/replace policy without provider internals.
 */
export const BUILT_IN_HISTORY_PLACEMENT = {
  id: 'froglight.toolbar-placement.history',
  anchor: 'float.top-left',
  order: 0,
  controlIds: ['shell.history.undo', 'shell.history.redo'],
  priority: 100,
  compact: 'never',
} as const;

/**
 *  fail-soft probes (toolbar side, mirrors `stylus-accessory.ts`
 * `safeSnapshot`/`safePane`/`safeContext`/`safeEntries`/`safeFlag`).
 *
 * Every external provider/registry read routes through these so an ACTUAL
 * throw degrades to an empty value plus a sanitized `layout.diagnostics`
 * entry — never a crash, never a throw from dispatch/teardown. OPTIONAL
 * absent (no composition registry) stays silent by construction (callers
 * skip the probe). Messages carry `Error.message` only (single line,
 * capped): stacks and object dumps never reach `layout.diagnostics`, and
 * diagnostics never render as visible toolbar UI (dev console channel
 * only via `reportDiagnostics`).
 */
export function toolbarErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message !== '') return error.message;
  return String(error);
}

export function sanitizeToolbarDiagnostic(message: string): string {
  const singleLine = message.replace(/[\r\n]+/g, ' ').trim();
  return singleLine.length > 500
    ? `${singleLine.slice(0, 497)}...`
    : singleLine;
}

function safeSnapshot(
  read: () => DocumentToolSnapshot | null,
  onThrow: (error: unknown) => void,
): DocumentToolSnapshot | null {
  try {
    return read();
  } catch (error) {
    onThrow(error);
    return null;
  }
}

function safePane(
  read: () => string,
  onThrow: (error: unknown) => void,
  fallback: string,
): string {
  try {
    return read();
  } catch (error) {
    onThrow(error);
    return fallback;
  }
}

function safeContext(
  read: () => DocumentToolbarContext,
  onThrow: (error: unknown) => void,
  fallback: DocumentToolbarContext,
): DocumentToolbarContext {
  try {
    return read();
  } catch (error) {
    onThrow(error);
    return fallback;
  }
}

function safeEntries<T>(
  read: () => T,
  onThrow: (error: unknown) => void,
  fallback: T,
): T {
  try {
    return read();
  } catch (error) {
    // Registry failures degrade to the fallback (usually empty), never a crash.
    onThrow(error);
    return fallback;
  }
}

function safeFlag(
  read: () => boolean,
  onThrow: (error: unknown) => void,
): boolean {
  try {
    return read();
  } catch (error) {
    onThrow(error);
    return false;
  }
}

/** Empty shelf settings when browsing a non-active category. */
const EMPTY_SHELF_SETTINGS: readonly OwnedToolbarControl[] = [];

/**
 * Select interaction mode carries no drawable preset and has no settings.
 *
 * Notebook pdfBacked source-select diverges by policy:
 * draw marks Select active via the PDF override while the settled
 * schema/values stay pen. Checking only whether the category is browsed
 * would then
 * present pen quicks/settings in the Select shelf. The shelf suppresses
 * them: when the exclusive active tool is `surface.select`, the Select
 * shelf shows tools only (zero pen quicks/settings). This also guards
 * against stale lasso settings from a provider snapshot. Draw keeps
 * showing Select and provider values stay pen (documented divergence) —
 * only the shelf quicks are suppressed. Keys on the exact `surface.select`
 * semantic role — never labels, icons, or id substrings (kind-blind shell).
 * Lasso (`surface.lasso`) keeps its mode/filter quicks.
 */
export const SURFACE_SELECT_ROLE = 'surface.select' as const;

export function shelfSettingsForCategory(input: {
  readonly browsedIsActive: boolean;
  readonly activeSemanticRole: string | null;
  readonly settingsControls: readonly OwnedToolbarControl[];
}): readonly OwnedToolbarControl[] {
  if (!input.browsedIsActive) return EMPTY_SHELF_SETTINGS;
  if (input.activeSemanticRole === SURFACE_SELECT_ROLE)
    return EMPTY_SHELF_SETTINGS;
  return input.settingsControls;
}

/** Pure assembly shared by the provider and single-surface hooks. */
export function computeUnifiedToolbarModel(input: {
  readonly tools: WorkbenchEditorToolsPort;
  readonly contributions: DocumentToolbarRegistry;
  readonly placements: ToolbarPlacementRegistry;
  readonly composition?: ToolbarCompositionRegistry;
  readonly pane: string;
  readonly documentId: string;
  readonly kindId: string;
}): {
  readonly snapshot: DocumentToolSnapshot | null;
  readonly context: DocumentToolbarContext;
  readonly layout: ResolvedToolbarLayout;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly settingsControls: readonly OwnedToolbarControl[];
  readonly compositionGraph: ResolvedToolbarGraph | null;
  /**
   * Full assembled owned pool (provider + shell + contributions) with one
   * execution owner per control id. Composition presentation must resolve
   * execution through this pool, never through `layout.owned` (which only
   * carries controls claimed by geometric placements). A semantically valid
   * composition item stays executable even when no geometric placement claims
   * its provider control.
   */
  readonly ownedPool: readonly OwnedToolbarControl[];
  readonly ownedById: ReadonlyMap<string, OwnedToolbarControl>;
} {
  const {
    tools,
    contributions,
    placements,
    composition,
    pane,
    documentId,
    kindId,
  } = input;
  // every external read degrades + reports; OPTIONAL absent stays
  // silent (composition undefined skips its probe entirely).
  const probeDiagnostics: string[] = [];
  const reportProbe = (message: string): void => {
    probeDiagnostics.push(sanitizeToolbarDiagnostic(message));
  };
  const paneId = safePane(
    () => pane,
    (error) =>
      reportProbe(`toolbar pane probe failed: ${toolbarErrorMessage(error)}`),
    pane,
  );
  const snapshot =
    safeSnapshot(
      () => tools.editorToolSnapshot(paneId) ?? null,
      (error) =>
        reportProbe(
          `toolbar tool snapshot probe failed: ${toolbarErrorMessage(error)}`,
        ),
    ) ?? null;
  const fallbackContext: DocumentToolbarContext = {
    pane: paneId,
    documentId,
    kindId,
    editor: snapshot,
  };
  const context: DocumentToolbarContext = safeContext(
    () => ({
      pane: paneId,
      documentId,
      kindId,
      editor: snapshot,
    }),
    (error) =>
      reportProbe(
        `toolbar context probe failed: ${toolbarErrorMessage(error)}`,
      ),
    fallbackContext,
  );
  const canUndo = safeFlag(
    () => tools.canExecEditorCommand('undo', paneId) !== false,
    (error) =>
      reportProbe(
        `toolbar history probe failed: ${toolbarErrorMessage(error)}`,
      ),
  );
  const canRedo = safeFlag(
    () => tools.canExecEditorCommand('redo', paneId) !== false,
    (error) =>
      reportProbe(
        `toolbar history probe failed: ${toolbarErrorMessage(error)}`,
      ),
  );
  const providerControls = snapshot?.controls ?? [];
  const shellOwned = safeEntries(
    () => shellHistoryOwnedControls({ canUndo, canRedo }),
    (error) =>
      reportProbe(
        `toolbar shell history failed: ${toolbarErrorMessage(error)}`,
      ),
    [] as ReturnType<typeof shellHistoryOwnedControls>,
  );
  const shellControls = shellOwned.map((owned) => owned.control);
  const contributionEntries = safeEntries(
    () => contributions.entries(context),
    (error) =>
      reportProbe(
        `toolbar contribution entries failed: ${toolbarErrorMessage(error)}`,
      ),
    [] as ReturnType<DocumentToolbarRegistry['entries']>,
  );
  const assembled = safeEntries(
    () =>
      assembleOwnedPool({
        providerControls,
        shellControls,
        contributions: contributionEntries,
      }),
    (error) =>
      reportProbe(
        `toolbar owned pool assembly failed: ${toolbarErrorMessage(error)}`,
      ),
    {
      ownedPool: [],
      diagnostics: [],
    } as unknown as ReturnType<typeof assembleOwnedPool>,
  );
  const registryPlacements = safeEntries(
    () => placements.placementsFor(context),
    (error) =>
      reportProbe(
        `toolbar placement resolution failed: ${toolbarErrorMessage(error)}`,
      ),
    [] as ReturnType<ToolbarPlacementRegistry['placementsFor']>,
  );
  const hasHistoryOverride = registryPlacements.some(
    (placement) => placement.id === BUILT_IN_HISTORY_PLACEMENT.id,
  );
  const effectivePlacements = hasHistoryOverride
    ? registryPlacements
    : [BUILT_IN_HISTORY_PLACEMENT, ...registryPlacements];
  const resolved = safeEntries(
    () =>
      resolveToolbarGroups({
        placements: effectivePlacements,
        ownedPool: assembled.ownedPool,
        context,
      }),
    (error) =>
      reportProbe(
        `toolbar group resolution failed: ${toolbarErrorMessage(error)}`,
      ),
    {
      groups: [],
      owned: [],
      unplaced: assembled.ownedPool.map((owned) => owned.control.id),
      diagnostics: [],
    } as unknown as ReturnType<typeof resolveToolbarGroups>,
  );
  // OPTIONAL absent stays silent: no composition registry means no probe,
  // no diagnostic. An available registry that throws degrades + reports.
  const compositionSnapshot =
    composition === undefined
      ? null
      : safeEntries(
          () => composition.snapshot(),
          (error) =>
            reportProbe(
              `toolbar composition snapshot failed: ${toolbarErrorMessage(error)}`,
            ),
          null as unknown as ReturnType<ToolbarCompositionRegistry['snapshot']>,
        );
  const compositionGraph = safeEntries(
    () =>
      compositionSnapshot === null
        ? null
        : resolveToolbarComposition({
            snapshot: compositionSnapshot,
            kindId,
            controls: assembled.ownedPool.map((owned) => owned.control),
          }),
    (error) =>
      reportProbe(
        `toolbar composition resolve failed: ${toolbarErrorMessage(error)}`,
      ),
    null as unknown as ResolvedToolbarGraph | null,
  );
  // Surface composition diagnostics instead of silent drops.
  // `ResolvedToolbarGraph.unresolved` (dormant cross-plugin items with a
  // missing category/control) and `diagnostics` (duplicate semantic roles,
  // ordering cycles) reuse the existing dev diagnostic channel by merging
  // into `layout.diagnostics`, which `buildUnifiedToolbarLayout` already
  // reports via `reportDiagnostics`. Stable ids preserved; no new channel.
  const compositionDiagnostics: readonly string[] =
    compositionGraph === null
      ? []
      : [
          ...compositionGraph.diagnostics,
          ...compositionGraph.unresolved.map(
            (id) => `unresolved toolbar item '${id}'`,
          ),
        ];
  // The `selection`
  // projection carries the table/media/math/column contextual edits that
  // the `float.selection` islands present. The shelf graph above can never
  // see them (projection gating skips before dormancy accounting), so
  // without this second resolution provider orphans stay silent outside
  // unit specs. Resolve it alongside the shelf graph and merge its
  // `unresolved` + `diagnostics` into the same dev channel verbatim.
  // OPTIONAL absent stays silent (null snapshot skips its probe entirely).
  const selectionGraph = safeEntries(
    () =>
      compositionSnapshot === null
        ? null
        : resolveToolbarComposition({
            snapshot: compositionSnapshot,
            kindId,
            controls: assembled.ownedPool.map((owned) => owned.control),
            projection: 'selection',
          }),
    (error) =>
      reportProbe(
        `toolbar selection resolve failed: ${toolbarErrorMessage(error)}`,
      ),
    null as unknown as ResolvedToolbarGraph | null,
  );
  const selectionDiagnostics: readonly string[] =
    selectionGraph === null
      ? []
      : [
          ...selectionGraph.diagnostics,
          ...selectionGraph.unresolved.map(
            (id) => `unresolved toolbar item '${id}'`,
          ),
        ];
  // Cross-layer single-owner rule: the
  // composition shelf and the geometric islands share one visible owner per
  // executable `control.id` (generic, all families, kind-blind — never
  // PDF-special-cased, never `slotKey`/label/icon inference). A composition
  // item whose control is already claimed by a geometric placement renders
  // only in the island (bottom-center nav wins as the primary nav
  // surface); `CompositionShelf` skips it below via the same claimed set.
  // Mirrors the placement-resolver claimed-set/already-owned pattern and
  // extends it cross-layer; reported here (single pane computation, never
  // per-surface render) so the duplicate is never silent. Sole exemption:
  // the Text creation role (`surface.insert.text`, single presenter via
  // `surface.text.create`) never hides and never reports
  // — strip/shelf show one shelf at a time and squeeze already dedupes by
  // control id.
  const geometricOwnerByControlId = new Map<string, string>();
  for (const group of resolved.groups) {
    // Topbar-center geometric placements never render alongside the
    // composition strip (TopbarCenterTools composition branch ignores
    // them), so they never own a visible control cross-layer. Only
    // floating islands compete with the shelf.
    if (group.anchor === 'topbar-center') continue;
    // A contextual placement without an anchor has no rendered island and
    // therefore cannot own controls against the composition shelf. Surface
    // text controls intentionally remain available there as creation
    // defaults until a real text selection supplies the anchor.
    if (
      group.anchor === 'float.selection' &&
      snapshot?.contextualAnchor === undefined
    ) {
      continue;
    }
    for (const owned of group.controls) {
      if (!geometricOwnerByControlId.has(owned.control.id)) {
        geometricOwnerByControlId.set(owned.control.id, group.id);
      }
    }
  }
  // Selection items share the same single-owner rule — an
  // island-claimed selection control renders only in the island. The
  // diagnostic names the `composition selection` presenter so shelf vs
  // selection sources stay distinguishable in the shared channel; the
  // Text-alias exemption is shared (vacuous for selection today, guards
  // the authorized alias if it ever gains a selection projection).
  const crossLayerSources: ReadonlyArray<{
    readonly graph: ResolvedToolbarGraph | null;
    readonly presenter: string;
  }> = [
    { graph: compositionGraph, presenter: 'composition shelf' },
    { graph: selectionGraph, presenter: 'composition selection' },
  ];
  const crossLayerDiagnostics: readonly string[] = crossLayerSources.flatMap(
    ({ graph, presenter }) =>
      graph === null
        ? []
        : graph.categories.flatMap((category) =>
            category.items.flatMap((item) => {
              const ownerPlacement = geometricOwnerByControlId.get(
                item.control.id,
              );
              if (ownerPlacement === undefined) return [];
              if (item.control.semanticRole === SURFACE_TEXT_CREATION_ROLE)
                return [];
              return [
                `duplicate toolbar control '${item.control.id}' in ${presenter} '${item.id}' (already owned by geometric placement '${ownerPlacement}')`,
              ];
            }),
          ),
  );
  const diagnostics = [
    ...probeDiagnostics,
    ...assembled.diagnostics,
    ...resolved.diagnostics,
    ...compositionDiagnostics,
    ...selectionDiagnostics,
    ...crossLayerDiagnostics,
  ];
  // Second-tap settings: unplaced `settings`-group
  // controls reunite with the active tool button. Resolved from the full
  // owned pool — `layout.owned` only carries placed controls. Ownership is
  // preserved end-to-end (provider/shell/contribution) so trusted plugin
  // settings for another tool execute via their contribution owner.
  // Composition settings entries gate their roles — a dormant
  // entry (target tool gone, id in `graph.unresolved`) hides its control
  // from the popover even though the control is still unplaced in the
  // pool. Controls with no composition settings entry keep the unplaced
  // settings behavior unchanged.
  // Composition-backed settings are additionally scoped to the
  // active tool — `settingsForTool(graph, activeRole)` is the semantic
  // authority, never a global `group === 'settings'` flatten and never UI
  // string/control-id guessing. T active → S available; sibling U active →
  // S not presented. Multiple entries targeting one tool all present; the
  // same-category Pen → Pencil switch swaps roles because the active
  // semantic role changes. No active tool → no composition-backed settings.
  const dormantSettingsRoles =
    compositionSnapshot === null || compositionGraph === null
      ? null
      : dormantCompositionSettingsRoles({
          snapshot: compositionSnapshot,
          unresolved: compositionGraph.unresolved,
        });
  const activeSettingsRole =
    compositionGraph === null
      ? null
      : resolveActiveToolSemanticRole(compositionGraph);
  const scopedSettingsRoles =
    compositionGraph === null
      ? null
      : new Set(
          settingsForTool(compositionGraph, activeSettingsRole).map(
            (entry) => entry.semanticRole,
          ),
        );
  const allCompositionSettingsRoles =
    compositionSnapshot === null
      ? null
      : compositionSettingsRoles(compositionSnapshot);
  const unplacedIds = new Set(resolved.unplaced);
  const settingsControls: readonly OwnedToolbarControl[] =
    assembled.ownedPool.filter((owned) => {
      if (!unplacedIds.has(owned.control.id)) return false;
      if (owned.control.group !== 'settings') return false;
      if (owned.control.semanticRole === undefined) {
        // Untagged controls cannot map to a composition entry: keep the
        // unplaced behavior (dormant gating cannot name them).
        return true;
      }
      if (
        dormantSettingsRoles === null ||
        scopedSettingsRoles === null ||
        allCompositionSettingsRoles === null
      )
        return true;
      if (dormantSettingsRoles.has(owned.control.semanticRole)) return false;
      if (!allCompositionSettingsRoles.has(owned.control.semanticRole))
        return true;
      return scopedSettingsRoles.has(owned.control.semanticRole);
    });
  // Flatten for backward-compatible `topbarCenter`/`floating` views.
  const topbarCenter = resolved.groups
    .filter((group) => group.anchor === 'topbar-center')
    .flatMap((group) => group.controls.map((owned) => owned.control));
  const floating = {
    'float.top-left': [] as OwnedToolbarControl[],
    'float.top-center': [] as OwnedToolbarControl[],
    'float.top-right': [] as OwnedToolbarControl[],
    'float.left-center': [] as OwnedToolbarControl[],
    'float.right-center': [] as OwnedToolbarControl[],
    'float.bottom-left': [] as OwnedToolbarControl[],
    'float.bottom-center': [] as OwnedToolbarControl[],
    'float.bottom-right': [] as OwnedToolbarControl[],
    'float.selection': [] as OwnedToolbarControl[],
  };
  for (const group of resolved.groups) {
    if (group.anchor === 'topbar-center') continue;
    floating[group.anchor as keyof typeof floating].push(...group.controls);
  }
  const layout: ResolvedToolbarLayout = {
    topbarCenter,
    floating: {
      'float.top-left': floating['float.top-left'].map(
        (owned) => owned.control,
      ),
      'float.top-center': floating['float.top-center'].map(
        (owned) => owned.control,
      ),
      'float.top-right': floating['float.top-right'].map(
        (owned) => owned.control,
      ),
      'float.left-center': floating['float.left-center'].map(
        (owned) => owned.control,
      ),
      'float.right-center': floating['float.right-center'].map(
        (owned) => owned.control,
      ),
      'float.bottom-left': floating['float.bottom-left'].map(
        (owned) => owned.control,
      ),
      'float.bottom-center': floating['float.bottom-center'].map(
        (owned) => owned.control,
      ),
      'float.bottom-right': floating['float.bottom-right'].map(
        (owned) => owned.control,
      ),
      'float.selection': floating['float.selection'].map(
        (owned) => owned.control,
      ),
    },
    diagnostics,
    unplaced: resolved.unplaced,
    groups: resolved.groups,
    owned: resolved.owned,
  };
  const ownedById = new Map(
    assembled.ownedPool.map((owned) => [owned.control.id, owned]),
  );
  return {
    snapshot,
    context,
    layout,
    canUndo,
    canRedo,
    settingsControls,
    compositionGraph,
    ownedPool: assembled.ownedPool,
    ownedById,
  };
}
