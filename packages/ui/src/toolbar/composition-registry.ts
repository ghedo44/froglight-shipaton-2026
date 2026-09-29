/** Provider-neutral toolbar structure; command execution remains provider-owned. */
import type { DocumentToolControl } from '@froglight/foundation';
import { createServiceToken, definePlugin } from '@froglight/runtime';
import type { ToolbarLayoutOverrides } from './toolbar-customization.js';

export type ToolbarProjection = 'normal' | 'squeeze' | 'selection' | 'compact';
export interface ToolbarCategoryContribution {
  readonly id: string;
  readonly familyId: string;
  readonly label: string;
  readonly icon: string;
  readonly order?: number;
  readonly priority?: number;
  readonly before?: readonly string[];
  readonly after?: readonly string[];
  /**
   * Main-strip group membership.
   *
   * Optional and additive: categories sharing a `groupId` present as ONE
   * main-strip group (one active indicator per group; the group reflects
   * its active sibling). Absent (or blank) means the category is its own
   * singleton group keyed by category id, so graphs without grouping
   * resolve identically to before.
   *
   * Structure only: a stable identity string for presenters to
   * key ephemeral sticky last-used memory. Never participates in semanticRole control
   * matching, ordering, or execution routing.
   */
  readonly groupId?: string;
}
export interface ToolbarItemContribution {
  readonly id: string;
  readonly categoryId: string;
  readonly semanticRole: string;
  readonly order?: number;
  readonly priority?: number;
  readonly before?: readonly string[];
  readonly after?: readonly string[];
  readonly projections?: readonly ToolbarProjection[];
  /**
   * Stable secondary-shelf slot identity.
   *
   * Optional and additive: GoodNotes-style fixed slots key their position
   * and per-slot overrides on this id (consumers: customization,
   *  shelf renderer). Absent (or blank) means no fixed slot — the
   * item renders in verbatim composition order keyed by item id.
   *
   * Never re-sorts: `order`/`priority`/`before`/`after` plus user-order
   * overrides stay the sole ordering authority.
   * Structure only: never participates in semanticRole control matching
   * or execution routing.
   */
  readonly slotId?: string;
}
export interface ToolbarKindExtension {
  readonly id: string;
  readonly kindIds: readonly string[];
  readonly familyIds?: readonly string[];
  readonly categories?: readonly ToolbarCategoryContribution[];
  readonly items?: readonly ToolbarItemContribution[];
  readonly settings?: readonly ToolbarSettingsContribution[];
}
/**
 * Trusted settings extension for another tool.
 *
 * `targetSemanticRole` names the tool this settings control belongs to;
 * `semanticRole` names the settings control itself. Both must resolve
 * against the owned control pool in the same projection, otherwise the
 * settings item stays dormant (`unresolved`) and revives when the target
 * and its control return. Execution ownership stays with the control's
 * owner (provider/shell/contribution) — the composition carries structure
 * only, never callbacks.
 */
export interface ToolbarSettingsContribution {
  readonly id: string;
  readonly targetSemanticRole: string;
  readonly semanticRole: string;
  readonly order?: number;
  readonly priority?: number;
  readonly before?: readonly string[];
  readonly after?: readonly string[];
  readonly projections?: readonly ToolbarProjection[];
}
export interface ToolbarCompositionSnapshot {
  readonly categories: readonly ToolbarCategoryContribution[];
  readonly items: readonly ToolbarItemContribution[];
  readonly settings?: readonly ToolbarSettingsContribution[];
  readonly extensions: readonly ToolbarKindExtension[];
}
export interface ToolbarCompositionRegistry {
  registerCategory(value: ToolbarCategoryContribution): { dispose(): void };
  registerItem(value: ToolbarItemContribution): { dispose(): void };
  registerSettings(value: ToolbarSettingsContribution): { dispose(): void };
  registerKindExtension(value: ToolbarKindExtension): { dispose(): void };
  snapshot(): ToolbarCompositionSnapshot;
  onDidChange(listener: () => void): { dispose(): void };
}
export interface ResolvedToolbarItem {
  readonly id: string;
  readonly semanticRole: string;
  readonly order: number;
  readonly priority: number;
  readonly projections: readonly ToolbarProjection[];
  readonly control: DocumentToolControl;
  /**
   * Verbatim passthrough of the contributed `slotId`.
   * Present only when the contribution declared one, so graphs without
   * slot metadata resolve identically to before.
   */
  readonly slotId?: string;
}
export interface ResolvedToolbarCategory {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly familyId: string;
  readonly order: number;
  readonly priority: number;
  readonly items: readonly ResolvedToolbarItem[];
  /**
   * Verbatim passthrough of the contributed `groupId`.
   * Present only when the contribution declared one, so graphs without
   * grouping metadata resolve identically to before. Consumers needing
   * the effective key (explicit or singleton fallback) must use
   * `stripGroupIdForCategory`, never guess.
   */
  readonly groupId?: string;
}
export interface ResolvedToolbarSettings {
  readonly id: string;
  readonly targetSemanticRole: string;
  readonly semanticRole: string;
  readonly order: number;
  readonly priority: number;
  readonly projections: readonly ToolbarProjection[];
  readonly control: DocumentToolControl;
}
export interface ResolvedToolbarGraph {
  readonly familyIds: readonly string[];
  readonly categories: readonly ResolvedToolbarCategory[];
  readonly settings: readonly ResolvedToolbarSettings[];
  readonly unresolved: readonly string[];
  readonly diagnostics: readonly string[];
}

/**
 * Authorized Text creation alias.
 *
 * Creation identity is the exact semanticRole `surface.insert.text`,
 * served from two categories (`surface.insert` item `surface.insert.text`
 * + `surface.text` item `surface.text.create`) behind one provider
 * control. This is the SOLE authorized dual presenter: strip/shelf show
 * one visible shelf at a time (never both), squeeze dedupes by control
 * id, and customization hides by item id. Never conflate on label `Text`,
 * toolRole `text`, group `text`, id substring `.text`, or icon `type`.
 */
export const SURFACE_TEXT_CREATION_ROLE = 'surface.insert.text' as const;
export const SURFACE_INSERT_CATEGORY_ID = 'surface.insert' as const;
export const SURFACE_TEXT_CATEGORY_ID = 'surface.text' as const;
export const SURFACE_TEXT_INSERT_ITEM_ID = 'surface.insert.text' as const;
export const SURFACE_TEXT_CREATE_ITEM_ID = 'surface.text.create' as const;

type Entry<T> = { readonly value: T; readonly previous: Entry<T> | null };
export const toolbarCompositionToken =
  createServiceToken<ToolbarCompositionRegistry>(
    'froglight.toolbar-composition',
  );

export function createToolbarCompositionRegistry(): {
  readonly registry: ToolbarCompositionRegistry;
  dispose(): void;
} {
  const categories = new Map<string, Entry<ToolbarCategoryContribution>>();
  const items = new Map<string, Entry<ToolbarItemContribution>>();
  const extensions = new Map<string, Entry<ToolbarKindExtension>>();
  const settings = new Map<string, Entry<ToolbarSettingsContribution>>();
  const listeners = new Set<() => void>();
  const notify = (): void => listeners.forEach((listener) => listener());
  const register = <T>(map: Map<string, Entry<T>>, id: string, value: T) => {
    const previous = map.get(id) ?? null;
    const entry: Entry<T> = { value, previous };
    map.set(id, entry);
    notify();
    let disposed = false;
    return {
      dispose(): void {
        if (disposed) return;
        disposed = true;
        if (map.get(id) !== entry) return;
        if (previous === null) map.delete(id);
        else map.set(id, previous);
        notify();
      },
    };
  };
  const registry: ToolbarCompositionRegistry = {
    registerCategory: (value) => register(categories, value.id, value),
    registerItem: (value) => register(items, value.id, value),
    registerSettings: (value) => register(settings, value.id, value),
    registerKindExtension: (value) => register(extensions, value.id, value),
    snapshot: () => ({
      categories: [...categories.values()].map((entry) => entry.value),
      items: [...items.values()].map((entry) => entry.value),
      settings: [...settings.values()].map((entry) => entry.value),
      extensions: [...extensions.values()].map((entry) => entry.value),
    }),
    onDidChange(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
  return {
    registry,
    dispose(): void {
      categories.clear();
      items.clear();
      settings.clear();
      extensions.clear();
      listeners.clear();
    },
  };
}

const byOrder = (
  a: { id: string; order?: number; priority?: number },
  b: { id: string; order?: number; priority?: number },
) =>
  // Higher priority sorts first (responsive survival + trusted reorder);
  // order breaks priority ties; id keeps determinism. Existing defaults
  // correlate order/priority, and priority-less entries tie at 0 so order
  // alone decides — backward compatible.
  (b.priority ?? 0) - (a.priority ?? 0) ||
  (a.order ?? 0) - (b.order ?? 0) ||
  a.id.localeCompare(b.id);

function orderWithConstraints<
  T extends {
    id: string;
    before?: readonly string[];
    after?: readonly string[];
  },
>(entries: readonly T[], diagnostics: string[], cycleMessage: string): T[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const edges = new Map(entries.map((entry) => [entry.id, new Set<string>()]));
  for (const entry of entries) {
    for (const id of entry.before ?? [])
      if (byId.has(id)) edges.get(entry.id)?.add(id);
    for (const id of entry.after ?? [])
      if (byId.has(id)) edges.get(id)?.add(entry.id);
  }
  const incoming = new Map(entries.map((entry) => [entry.id, 0]));
  for (const targets of edges.values())
    for (const target of targets)
      incoming.set(target, (incoming.get(target) ?? 0) + 1);
  const ready = entries
    .filter((entry) => incoming.get(entry.id) === 0)
    .sort(byOrder);
  const result: T[] = [];
  while (ready.length > 0) {
    const entry = ready.shift();
    if (entry === undefined) break;
    result.push(entry);
    for (const target of edges.get(entry.id) ?? []) {
      const next = (incoming.get(target) ?? 0) - 1;
      incoming.set(target, next);
      if (next === 0) {
        const candidate = byId.get(target);
        if (candidate !== undefined) ready.push(candidate);
        ready.sort(byOrder);
      }
    }
  }
  if (result.length === entries.length) return result;
  diagnostics.push(cycleMessage);
  return [...entries].sort(byOrder);
}

function orderItems(
  items: readonly ToolbarItemContribution[],
  diagnostics: string[],
): ToolbarItemContribution[] {
  return orderWithConstraints(
    items,
    diagnostics,
    'toolbar item ordering cycle; falling back to order and id',
  );
}

function orderCategories(
  categories: readonly ToolbarCategoryContribution[],
  diagnostics: string[],
): ToolbarCategoryContribution[] {
  return orderWithConstraints(
    categories,
    diagnostics,
    'toolbar category ordering cycle; falling back to order and id',
  );
}

function orderSettings(
  entries: readonly ToolbarSettingsContribution[],
  diagnostics: string[],
): ToolbarSettingsContribution[] {
  return orderWithConstraints(
    entries,
    diagnostics,
    'toolbar settings ordering cycle; falling back to order and id',
  );
}

/**
 * Reorder entries by an explicit user order list (customization
 * seam): listed ids come first in listed order; unlisted entries keep their
 * incoming relative order after. Unknown ids never match, so they are
 * ignored — never an error, never a reorder of unrelated entries.
 */
export function applyUserOrder<T>(
  entries: readonly T[],
  order: readonly string[] | undefined,
  idOf: (entry: T) => string,
): T[] {
  if (order === undefined || order.length === 0) return [...entries];
  const rank = new Map(order.map((id, index) => [id, index]));
  return [...entries]
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => {
      const rankA = rank.get(idOf(a.entry));
      const rankB = rank.get(idOf(b.entry));
      if (rankA !== undefined && rankB !== undefined) return rankA - rankB;
      if (rankA !== undefined) return -1;
      if (rankB !== undefined) return 1;
      return a.index - b.index;
    })
    .map((wrapped) => wrapped.entry);
}

export function resolveToolbarComposition(input: {
  readonly snapshot: ToolbarCompositionSnapshot;
  readonly kindId: string;
  readonly controls: readonly DocumentToolControl[];
  readonly projection?: ToolbarProjection;
  /**
   * Reversible user override overlay: category/item/squeeze
   * ordering plus visibility. The registry snapshot is never mutated and
   * defaults resolve identically when this is absent. Unknown ids are
   * ignored (dormant-safe); user-hidden entries stay out of `unresolved`
   * because hiding is deliberate, not a missing plugin.
   */
  readonly overrides?: ToolbarLayoutOverrides;
}): ResolvedToolbarGraph {
  const projection = input.projection ?? 'normal';
  const overrides = input.overrides;
  const hiddenCategories = new Set(overrides?.hiddenCategories ?? []);
  const hiddenItems = new Set(overrides?.hiddenItems ?? []);
  const extensions = (input.snapshot.extensions ?? []).filter((entry) =>
    entry.kindIds.includes(input.kindId),
  );
  const familyIds = [
    ...new Set(extensions.flatMap((entry) => entry.familyIds ?? [])),
  ];
  const categoryPool = [
    ...(input.snapshot.categories ?? []).filter((entry) =>
      familyIds.includes(entry.familyId),
    ),
    ...extensions.flatMap((entry) => entry.categories ?? []),
  ].filter(
    (entry) => entry.id === 'surface.select' || !hiddenCategories.has(entry.id),
  );
  const categoryById = new Map(categoryPool.map((entry) => [entry.id, entry]));
  const itemPool = [
    ...(input.snapshot.items ?? []),
    ...extensions.flatMap((entry) => entry.items ?? []),
  ];
  const settingsPool = [
    ...(input.snapshot.settings ?? []),
    ...extensions.flatMap((entry) => entry.settings ?? []),
  ];
  const controlsByRole = new Map<string, DocumentToolControl>();
  const diagnostics: string[] = [];
  for (const control of input.controls) {
    if (control.semanticRole === undefined) continue;
    if (controlsByRole.has(control.semanticRole))
      diagnostics.push(
        `duplicate semantic toolbar role '${control.semanticRole}'`,
      );
    else controlsByRole.set(control.semanticRole, control);
  }
  const unresolved: string[] = [];
  const grouped = new Map<string, ResolvedToolbarItem[]>();
  for (const item of orderItems(itemPool, diagnostics)) {
    if (hiddenItems.has(item.id) && item.id !== 'surface.select.lasso')
      continue;
    if (
      hiddenCategories.has(item.categoryId) &&
      item.categoryId !== 'surface.select'
    )
      continue;
    if (!categoryById.has(item.categoryId)) {
      unresolved.push(item.id);
      continue;
    }
    const projections = item.projections ?? ['normal', 'compact'];
    if (!projections.includes(projection)) continue;
    const control = controlsByRole.get(item.semanticRole);
    if (control === undefined) {
      unresolved.push(item.id);
      continue;
    }
    const list = grouped.get(item.categoryId) ?? [];
    list.push({
      id: item.id,
      semanticRole: item.semanticRole,
      order: item.order ?? 0,
      priority: item.priority ?? 0,
      projections,
      control,
      // Additive passthrough only: slot identity never affects whether an
      // item resolves, its order, or its owner. Conditional spread keeps
      // graphs without slot metadata byte-identical to before.
      ...(item.slotId !== undefined ? { slotId: item.slotId } : {}),
    });
    grouped.set(item.categoryId, list);
  }
  const categories = applyUserOrder(
    orderCategories([...categoryById.values()], diagnostics).flatMap(
      (entry): ResolvedToolbarCategory[] => {
        const categoryItems = grouped.get(entry.id) ?? [];
        return categoryItems.length === 0
          ? []
          : [
              {
                id: entry.id,
                label: entry.label,
                icon: entry.icon,
                familyId: entry.familyId,
                order: entry.order ?? 0,
                priority: entry.priority ?? 0,
                // Additive passthrough only: group membership never affects
                // whether a category resolves, its order, or its items.
                // Conditional spread keeps graphs without grouping metadata
                // byte-identical to before.
                ...(entry.groupId !== undefined
                  ? { groupId: entry.groupId }
                  : {}),
                // override: the squeeze projection follows
                // `squeezeOrder` when present, otherwise the shared
                // `itemOrder`; every other projection follows `itemOrder`.
                // Both are within-category overlays — grouping never breaks.
                items: applyUserOrder(
                  categoryItems,
                  projection === 'squeeze' &&
                    overrides?.squeezeOrder !== undefined
                    ? overrides.squeezeOrder
                    : overrides?.itemOrder?.[entry.id],
                  (item) => item.id,
                ),
              },
            ];
      },
    ),
    overrides?.categoryOrder,
    (category) => category.id,
  );
  // Duplicate-presenter diagnostic: one semanticRole served
  // from two live items is a second visible owner for the same tool and
  // must stay deliberate. The SOLE authorized exception is the Text
  // creation alias (`surface.insert.text` via `surface.insert.text` and
  // `surface.text.create`): strip/shelf show one shelf at a
  // time, squeeze dedupes by control id, customization hides by item id.
  // Every other duplicate presenter reports here (never silent).
  {
    const presenterByRole = new Map<string, string[]>();
    for (const category of categories) {
      for (const item of category.items) {
        const list = presenterByRole.get(item.semanticRole) ?? [];
        list.push(item.id);
        presenterByRole.set(item.semanticRole, list);
      }
    }
    for (const [role, ids] of presenterByRole) {
      if (ids.length < 2) continue;
      const uniqueIds = [...new Set(ids)].sort();
      if (
        role === SURFACE_TEXT_CREATION_ROLE &&
        uniqueIds.length === 2 &&
        uniqueIds[0] === SURFACE_TEXT_INSERT_ITEM_ID &&
        uniqueIds[1] === SURFACE_TEXT_CREATE_ITEM_ID
      ) {
        continue;
      }
      diagnostics.push(
        `duplicate presenter for semantic role '${role}' (${uniqueIds.join(', ')})`,
      );
    }
  }
  // Resolved tool roles in this projection: the dormancy authority for
  // settings. A settings entry is live only when its target tool resolved
  // here (same projection, live category, live control) and its own
  // control is present. Otherwise it stays dormant in `unresolved` and
  // revives automatically when the target returns — never a crash, never
  // an orphan execution.
  const resolvedRoles = new Set(
    categories.flatMap((category) =>
      category.items.map((item) => item.semanticRole),
    ),
  );
  const settings: ResolvedToolbarSettings[] = [];
  for (const entry of orderSettings(settingsPool, diagnostics)) {
    const projections = entry.projections ?? ['normal', 'compact'];
    if (!projections.includes(projection)) continue;
    if (!resolvedRoles.has(entry.targetSemanticRole)) {
      unresolved.push(entry.id);
      continue;
    }
    const control = controlsByRole.get(entry.semanticRole);
    if (control === undefined) {
      unresolved.push(entry.id);
      continue;
    }
    settings.push({
      id: entry.id,
      targetSemanticRole: entry.targetSemanticRole,
      semanticRole: entry.semanticRole,
      order: entry.order ?? 0,
      priority: entry.priority ?? 0,
      projections,
      control,
    });
  }
  return { familyIds, categories, settings, unresolved, diagnostics };
}

/**
 * Semantic settings grouping.
 *
 * The resolved graph is the dormancy authority; this helper is the
 * presentation authority for *which* live settings belong to *which* tool.
 * Presenters must scope `settingsControls` through it — never by flattening
 * `group === 'settings'` globally and never by guessing from UI strings or
 * control-id suffixes. Structure carries no execution: callers map the
 * returned entries back through the owned pool (`ownedById`) so the
 * provider/shell/contribution owner still routes via `executeOwned`.
 */
export function groupSettingsByTarget(
  settings: readonly ResolvedToolbarSettings[],
): ReadonlyMap<string, readonly ResolvedToolbarSettings[]> {
  const grouped = new Map<string, ResolvedToolbarSettings[]>();
  for (const entry of settings) {
    const list = grouped.get(entry.targetSemanticRole) ?? [];
    list.push(entry);
    grouped.set(entry.targetSemanticRole, list);
  }
  return grouped;
}

/**
 * Live settings for one target tool semantic role. Empty when the graph is
 * absent, the target is absent/null, or the target has no live settings
 * (dormant entries live in `graph.unresolved`, never here). Restores
 * automatically when the target returns because `graph.settings` does.
 */
export function settingsForTool(
  graph: ResolvedToolbarGraph | null,
  targetSemanticRole: string | null | undefined,
): readonly ResolvedToolbarSettings[] {
  if (graph === null) return [];
  if (targetSemanticRole === null || targetSemanticRole === undefined)
    return [];
  if (targetSemanticRole === '') return [];
  return graph.settings.filter(
    (entry) => entry.targetSemanticRole === targetSemanticRole,
  );
}

/**
 * Grouped main-strip contract (grouped strip, stable
 * secondary, add-only; run decisions ).
 *
 * Grouping/slot metadata is structure only — stable identity strings for
 * presenters to key rendering, sticky memory, and overrides. It never
 * owns command execution: control matching keys on
 * `semanticRole` alone, ordering keys on
 * `order`/`priority`/`before`/`after` plus user-order overlays alone, and
 * dormancy (missing category/control → `unresolved`, revive on return)
 * is metadata-agnostic.
 *
 * Consumer map:
 * - strip/stickiness: `groupCategoriesByStripGroup(graph.categories)`
 *   for one-active-indicator-per-group; sticky last-used memory is keyed
 *  by strip-group id in an EPHEMERAL session store owned by
 *  (deliberately not implemented here, never persisted).
 * - resolver projections: preserve grouping through projections;
 *   grouping never breaks `before`/`after` or user-order overlays.
 * - shelf renderer: fixed GoodNotes-style slots keyed by
 *   `slotIdForItem`; active is marked IN PLACE, never moved first
 *  (verbatim order — the resolved sequence is the authority).
 * - customization: group/slot ids adopted by defaults become
 *  stable customization keys as defaults are added; overrides stay a
 *   reversible overlay, never a registry mutation.
 * - default composition: assigns `groupId`/`slotId` additively;
 *   existing contribution ids are never renamed or repurposed.
 */

/** Minimal structural shape carrying strip-group identity. */
export type StripGroupedCategory = {
  readonly id: string;
  readonly groupId?: string;
};

/** Minimal structural shape carrying shelf-slot identity. */
export type SlottedToolbarItem = {
  readonly id: string;
  readonly slotId?: string;
};

function effectiveKey(declared: string | undefined, fallback: string): string {
  const trimmed = declared?.trim();
  return trimmed !== undefined && trimmed !== '' ? trimmed : fallback;
}

/**
 * Effective main-strip group id for one category: the declared `groupId`,
 * or the category id itself when absent/blank (singleton group).
 *
 * The single fallback rule every consumer must share — never
 * reimplement locally, never guess from labels, icons, or id substrings.
 */
export function stripGroupIdForCategory(
  category: StripGroupedCategory,
): string {
  return effectiveKey(category.groupId, category.id);
}

/**
 * Effective shelf slot id for one item: the declared `slotId`, or the
 * item id itself when absent/blank (unslotted items keep verbatim order
 * keyed by item id).
 *
 * The single fallback rule every consumer must share.
 */
export function slotIdForItem(item: SlottedToolbarItem): string {
  return effectiveKey(item.slotId, item.id);
}

/**
 * Bucket resolved (or contributed) categories by effective strip group,
 * preserving resolved order verbatim: first-seen group order, member
 * order untouched within each group.
 *
 * Pure structure: returns the input entries grouped for presentation.
 * Callers map back through the owned pool so the provider/shell/
 * contribution owner still routes via execution — this helper never
 * touches controls, commands, or active state.
 */
export function groupCategoriesByStripGroup<T extends StripGroupedCategory>(
  categories: readonly T[],
): ReadonlyMap<string, readonly T[]> {
  const grouped = new Map<string, T[]>();
  for (const category of categories) {
    const key = stripGroupIdForCategory(category);
    const list = grouped.get(key) ?? [];
    list.push(category);
    grouped.set(key, list);
  }
  return grouped;
}

export type ToolbarCompositionPluginConfig = Readonly<
  Record<string, unknown>
> & {
  readonly categories?: readonly ToolbarCategoryContribution[];
  readonly items?: readonly ToolbarItemContribution[];
  readonly settings?: readonly ToolbarSettingsContribution[];
  readonly extensions?: readonly ToolbarKindExtension[];
};
export const toolbarCompositionPlugin =
  definePlugin<ToolbarCompositionPluginConfig>({
    id: 'froglight.toolbar-composition',
    activate(ctx) {
      const created = createToolbarCompositionRegistry();
      const disposers = [
        ...(ctx.config.categories ?? []).map((value) =>
          created.registry.registerCategory(value),
        ),
        ...(ctx.config.items ?? []).map((value) =>
          created.registry.registerItem(value),
        ),
        ...(ctx.config.settings ?? []).map((value) =>
          created.registry.registerSettings(value),
        ),
        ...(ctx.config.extensions ?? []).map((value) =>
          created.registry.registerKindExtension(value),
        ),
      ];
      ctx.provide(toolbarCompositionToken, created.registry);
      ctx.effect(() => () => {
        for (const disposer of disposers) disposer.dispose();
        created.dispose();
      });
    },
  });
