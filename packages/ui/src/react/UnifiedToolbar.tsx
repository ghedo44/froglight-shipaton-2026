/**
 * Unified document toolbar.
 *
 * One in-flow top-bar center plus a pane-scoped floating-toolbar layer with
 * eight stable geometric anchors. React owns presentation only: the owned
 * semantic control pool (provider snapshot + shell history + document-toolbar
 * contributions with explicit execution ownership) is resolved through the
 * UI-owned placement registry into group-level render models, and every
 * control renders through the shared semantic renderer in `tool-controls.tsx`.
 *
 * - Top-bar center renders the composition category strip whenever the
 *   composition graph resolves (composition owns primary tools); without a
 *   composition it falls back to topbar-center placement groups. No repeated
 *   document title, no visible context label: snapshot context survives only
 *   as accessible metadata.
 * - The floating overlay is pointer-transparent except for actual toolbar
 *   islands, so it never blocks editing, drawing, selection, or gestures.
 * - Provider-local undo/redo rides the editor command channel as
 *   shell-owned semantic controls (`shell.history.undo`/`redo`) participating
 *   in normal placement resolution at `float.top-left`.
 * - Placement groups survive through the renderer with id/anchor/order/
 *   priority/compact intact; responsive compaction preserves higher-priority
 *   groups and overflows lower-priority `compact: 'auto'` groups inside the
 *   same surface (never a second full-width row).
 * - Compact structure (category-strip slicing, shelf budgets) keys on the
 *   real available pane width via `useToolbarCompact`, never
 *   on the window width alone; the window query survives only as the
 *   first-paint/unmeasured fallback.
 * - Unplaced controls do not render; duplicate placement claims keep one
 *   visible owner and report a development/test diagnostic. The composition
 *   shelf owns top-center quick properties, so first-party top-center
 *   placements are absent. The shelf skips controls already claimed by a
 *   geometric island at any anchor and reports a combined diagnostic, so
 *   each control renders in one layer. Notebook page management projects into
 *   the right sidebar.
 *   Custom hosts should not add placements that duplicate composition-owned
 *   tool properties, even under a different id with the same user-facing
 *   property label.
 */

import {
  Fragment,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import type {
  DocumentToolControl,
  DocumentToolSnapshot,
  InkPresetToolId,
  InkSlotFamily,
} from '@froglight/foundation';
import {
  inkSlotFamilyForTool,
  isExclusiveActiveToolControl,
  type SavedStyleCardData,
} from '@froglight/foundation';
import { savedStyleA11yLabel } from './saved-style-cards.jsx';
import { BlockTableHandles } from './BlockTableHandles.js';
import { BlockMediaPanel } from './BlockMediaPanel.js';
import { useKeyboardInset } from './useKeyboardInset.js';
import { toolbarControlIcon } from './toolbar-control-icon.js';
import type { WorkbenchEditorToolsPort } from '../workbench-ports.js';
import type { DocumentToolbarRegistry } from '../document-toolbar-registry.js';
import type { ToolbarPlacementRegistry } from '../toolbar/placement-registry.js';
import type { ToolbarAnchor } from '../toolbar/placement-registry.js';
import {
  groupCategoriesByStripGroup,
  slotIdForItem,
  stripGroupIdForCategory,
  SURFACE_INSERT_CATEGORY_ID,
  SURFACE_TEXT_CATEGORY_ID,
  SURFACE_TEXT_CREATION_ROLE,
  type ResolvedToolbarItem,
  type ToolbarCompositionRegistry,
} from '../toolbar/composition-registry.js';
import {
  partitionGroupedShelf,
  planToolbarCompaction,
  verbatimShelfItemOrder,
  type ResolvedToolbarGroup,
  type ResolvedToolbarLayout,
  type ShelfCapacityCell,
} from '../toolbar/placement-resolver.js';
import {
  activeOverflowSlots,
  groupControls,
  isShelfSlotActive,
  renderControl,
  SHELF_PEN_SLOT_COUNT,
  ShelfSlotShelf,
  ShelfSlotEditPopover,
  ToolbarDisclosureProvider,
  useToolbarDisclosure,
  type ShelfSlotEntry,
} from './tool-controls.jsx';
import { ToolbarCustomizationStore } from '../toolbar/toolbar-customization.js';
import type { SurfaceToolSettingsSource } from './tool-controls.jsx';
import {
  ToolbarPopoverPortal,
  computeToolbarPopoverPosition,
  handleMenuListKeyDown,
  useFocusFirstOnOpen,
  useToolbarPopoverPosition,
} from './toolbar-popover.jsx';
import {
  COMPACT_MAX_WIDTH,
  workspacePresentationPolicy,
  type WorkspaceInteractionCapabilities,
  type WorkspaceLayoutMode,
} from './workspace/interaction-policy.js';
import styles from './UnifiedToolbar.module.css';
import { Icon } from './Icon.jsx';

export interface UnifiedToolbarProps {
  readonly tools: WorkbenchEditorToolsPort;
  readonly contributions: DocumentToolbarRegistry;
  readonly placements: ToolbarPlacementRegistry;
  readonly composition?: ToolbarCompositionRegistry;
  readonly pane: string;
  readonly documentId: string;
  readonly kindId: string;
  /**
   * Shelf slot value store. When omitted the
   * shelf owns a memory-only store (factory triples, session edits) so
   * size/color slots still resolve per family without a settings backend.
   * A future persistence pass may thread a settings-backed store from the
   * pane; the shelf subscribes and re-renders on every store change either
   * way.
   */
  readonly slotCustomization?: ToolbarCustomizationStore;
}

export interface UnifiedToolbarLayout {
  readonly snapshot: DocumentToolSnapshot | null;
  readonly layout: ResolvedToolbarLayout;
  readonly groups: readonly ResolvedToolbarGroup[];
  /**
   * Full assembled owned pool by control id (provider + shell +
   * contributions), independent of legacy placement claims. Composition
   * presentation executes through this map so a semantically resolved item
   * never fails to render/execute merely because no legacy placement
   * claimed it. `layout.owned` remains the placed subset for legacy
   * geometric islands.
   */
  readonly ownedById: ReadonlyMap<string, OwnedToolbarControl>;
  /**
   * Unplaced `settings`-group controls for the active tool (slice 8).
   * Surface-tool buttons reunite them in the second-tap popover.
   * Owned end-to-end (provider/shell/contribution): execution resolves
   * through the preserved owner via `executeOwned`, never a hardcoded
   * provider channel.: controls claimed by a dormant composition
   * settings entry (target tool gone) are excluded — `graph.settings`
   * is the dormancy authority.: composition-backed settings are
   * additionally scoped to the active tool via `settingsForTool` — a
   * settings entry for tool T never presents while sibling U is active.
   * Controls with no composition settings entry keep the legacy unplaced
   * behavior unchanged.
   */
  readonly settingsControls: readonly OwnedToolbarControl[];
  readonly compositionGraph: ResolvedToolbarGraph | null;
  /**
   * Expanded (browsable) category driving the contextual shelf.
   * Manual selection persists while the active tool is unchanged; an
   * external tool change (squeeze, double-tap, shortcut, provider
   * command, temporary eraser, plugin, restore) reconciles it back to
   * the category containing the active tool so the UI never presents a
   * stale category as the active tool context.
   */
  readonly activeCategoryId: string | null;
  /**
   * Category containing the actually active tool, independent of manual
   * browsing. The strip uses it to keep real tool state visible even
   * while the shelf browses another category.
   */
  readonly activeToolCategoryId: string | null;
  /** Executable control id of the active tool, if any. */
  readonly activeToolControlId: string | null;
  readonly setActiveCategoryId: (id: string) => void;
  readonly execute: (id: string, value?: string) => void;
  readonly executeOwned: (item: OwnedToolbarControl, value?: string) => void;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly undo: () => void;
  readonly redo: () => void;
}

/**
 * Route execution through the resolved owner (no fallback probing).
 * The resolved control already knows which channel owns it.
 */
export {
  BUILT_IN_HISTORY_PLACEMENT,
  computeUnifiedToolbarModel,
  executeOwnedControl,
  resolveActiveToolCategoryId,
  resolveActiveToolControlId,
  resolveActiveToolSemanticRole,
  resolveExpandedCategoryId,
  shelfSettingsForCategory,
} from '../toolbar/unified-toolbar-model.js';
import {
  computeUnifiedToolbarModel,
  executeOwnedControl,
  resolveActiveToolCategoryId,
  resolveActiveToolControlId,
  resolveActiveToolSemanticRole,
  resolveExpandedCategoryId,
  shelfSettingsForCategory,
  sanitizeToolbarDiagnostic,
  toolbarErrorMessage,
  SURFACE_SELECT_ROLE,
} from '../toolbar/unified-toolbar-model.js';
import type { OwnedToolbarControl } from '../toolbar/placement-resolver.js';
import type { ResolvedToolbarGraph } from '../toolbar/composition-registry.js';

/** Subscribe without letting a throwing registry break mount. */
function safeSubscribe(
  subscribe: () => { dispose(): void },
  onThrow: (error: unknown) => void,
): { dispose(): void } {
  try {
    return subscribe();
  } catch (error) {
    onThrow(error);
    return { dispose: () => undefined };
  }
}

/** Teardown that never throws back into React. */
function safeDispose(disposer: { dispose(): void }): void {
  try {
    disposer.dispose();
  } catch {
    // Teardown must never throw.
  }
}

function reportDiagnostics(diagnostics: readonly string[]): void {
  if (
    diagnostics.length > 0 &&
    typeof process !== 'undefined' &&
    process.env?.['NODE_ENV'] !== 'production'
  ) {
    for (const diagnostic of diagnostics) {
      try {
        // Diagnostics carry sanitized messages only (no stacks); the channel
        // itself must never throw back into dispatch/teardown.
        console.error(`[toolbar-placement] ${diagnostic}`);
      } catch {
        // Reporting must never break toolbar dispatch.
      }
    }
  }
}

function reportToolbarDispatchFailure(error: unknown, what: string): void {
  try {
    reportDiagnostics([
      sanitizeToolbarDiagnostic(
        `${what} failed: ${toolbarErrorMessage(error)}`,
      ),
    ]);
  } catch {
    // Never throw from dispatch.
  }
}

const UnifiedToolbarModelContext = createContext<UnifiedToolbarLayout | null>(
  null,
);
const ContextualShelfContext = createContext<{
  open: boolean;
  setOpen: (open: boolean) => void;
} | null>(null);

/**
 * Reconcile manual category browsing with real tool changes (squeeze,
 * double-tap, shortcuts, provider commands, temporary eraser, plugins,
 * restore). Browsing persists while both the active-tool category and the
 * active-tool control are unchanged; a real exclusive-tool change clears a
 * stale manual selection so the shelf never presents the previous category
 * as the active tool context — including same-category switches such as
 * Pen → Pencil that keep `surface.write` but change the control id.
 * Toggle-active controls (Bold) never drive an exclusive transition
 * because both derivations already use `isExclusiveActiveToolControl`.
 * Shared by the provider and standalone fallback paths so both reconcile
 * identically.
 *
 * Alias guard: Text creation (`surface.insert.text`) is
 * dual-homed in `surface.insert` + `surface.text` behind one control.
 * Browsing either presenter, then activating Text, keeps the browsed
 * shelf (no eject to the other presenter): when the active semantic role
 * is the creation role and the manual selection names either presenter,
 * the selection is current by definition and must survive. The strip
 * still marks the canonical `surface.text` via `activeToolCategoryId`
 * while `aria-pressed` follows the browsed shelf — browse/active
 * separation preserved.
 *
 * Select is the neutral surface mode. A deliberate primary-category
 * change activates Select while leaving the requested category browsed,
 * so that transition must not immediately reconcile the shelf back to the
 * Select category.
 */
function useReconcileActiveCategorySelection(
  activeToolCategoryId: string | null,
  activeToolControlId: string | null,
  selectedCategoryId: string | null,
  setSelectedCategoryId: (value: string | null) => void,
  enabled: boolean,
  activeToolSemanticRole: string | null = null,
): void {
  const previousRef = useRef<{
    readonly category: string | null;
    readonly control: string | null;
  } | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const previous = previousRef.current;
    previousRef.current = {
      category: activeToolCategoryId,
      control: activeToolControlId,
    };
    if (previous === null) return;
    if (activeToolCategoryId === null) return;
    if (
      previous.category === activeToolCategoryId &&
      previous.control === activeToolControlId
    )
      return;
    if (
      selectedCategoryId !== null &&
      selectedCategoryId !== activeToolCategoryId
    ) {
      if (activeToolSemanticRole === SURFACE_SELECT_ROLE) return;
      // Dual-homed Text creation: either presenter counts as current when
      // Text is the active tool — browsing Text then activating Text must
      // keep the shelf on Text (and symmetrically for Insert).
      if (
        activeToolSemanticRole === SURFACE_TEXT_CREATION_ROLE &&
        (selectedCategoryId === SURFACE_TEXT_CATEGORY_ID ||
          selectedCategoryId === SURFACE_INSERT_CATEGORY_ID)
      ) {
        return;
      }
      setSelectedCategoryId(null);
    }
  }, [
    activeToolCategoryId,
    activeToolControlId,
    selectedCategoryId,
    setSelectedCategoryId,
    enabled,
    activeToolSemanticRole,
  ]);
}

/**
 * Tracks the last-used tool for each strip group during this mount.
 *
 * The `useRef` map is never persisted and is cleared on unmount. Entries
 * are namespaced by a caller-supplied scope key
 * plus the EFFECTIVE strip-group id: `record`/`recall` take the scope
 * from the same props that key the pane model (`kindId` + `documentId`
 * at the call site), so an ink pen remembered in one document/kind can
 * never leak into a notebook/whiteboard document in the same pane
 * (per-family/instance scope). The strip-group segment itself keys
 * via `stripGroupIdForCategory` (declared `groupId` or the category id)
 * — never by raw `groupId`, labels, icons, or id substrings — so
 * `surface.shapes` + `surface.insert` share one Insert key while Pen
 * (`surface.write`), Highlighter (`surface.highlighter`) and Eraser
 * (`surface.erase`) stay isolated by
 * construction (cross-group writes are impossible: `record` writes only
 * the keys of groups holding the active control, `recall` reads only the
 * clicked group's key). A scope change clears the map before any read/write,
 * so stale entries fall back to the first-live default and never misroute an
 * execution.
 *
 * Dual-homed alias: the Text creation control
 * (`surface.insert.text`) lives in BOTH `surface.insert` and
 * `surface.text` behind one provider control. `record` writes the entry
 * under EVERY effective strip-group key holding the control (Insert AND
 * Text here, each under its own presenter), and the restore path prefers
 * the remembered presenter with a same-group live-holder fallback — so a
 * first-match lookup can never pin Insert and starve the Text group.
 * Every other control resolves to exactly one group key, as before.
 *
 * Pen semantics: re-selecting Pen restores the last pen
 * sibling (ball/fountain/brush/pencil) executed in this session.
 * Eraser semantics: re-selecting Eraser restores the last eraser
 * tool; the eraser mode/size preset itself rides provider state (we never
 * write settings, so `autoReturn` and mode presets are untouched).
 * No-hijack: recording the Eraser activation writes only the Eraser
 * key, leaving the Pen key (and its subtype) intact.
 * Temp/toggle: only settled exclusive tools write memory. Toggle
 * controls (`activationRole === 'toggle'`, e.g. Bold) never count because
 * every entry point keys on `isExclusiveActiveToolControl`
 * (active-tool derivations share it); temporary/hold activations that
 * never settle as the exclusive snapshot tool never reach `record`, and
 * this module never touches `autoReturn` or any setting value.
 */
export interface StripGroupRemembered {
  readonly categoryId: string;
  readonly controlId: string;
}

export function useStripGroupMemory(scopeKey: string): {
  readonly record: (
    graph: ResolvedToolbarGraph | null,
    activeControlId: string | null,
  ) => void;
  readonly recall: (stripGroupKey: string) => StripGroupRemembered | null;
} {
  const stateRef = useRef<{
    scope: string;
    map: Map<string, StripGroupRemembered>;
  }>({ scope: scopeKey, map: new Map() });
  const ensureScope = (scope: string): Map<string, StripGroupRemembered> => {
    const state = stateRef.current;
    if (state.scope !== scope) {
      const fresh = { scope, map: new Map<string, StripGroupRemembered>() };
      stateRef.current = fresh;
      return fresh.map;
    }
    return state.map;
  };
  const record = useCallback(
    (
      graph: ResolvedToolbarGraph | null,
      activeControlId: string | null,
    ): void => {
      const memory = ensureScope(scopeKey);
      if (graph === null || activeControlId === null) return;
      const holders = graph.categories.filter((category) =>
        category.items.some((item) => item.control.id === activeControlId),
      );
      if (holders.length === 0) return;
      // Exclusive-only gate: toggles and non-tool controls never write.
      // `activeControlId` already derives via `isExclusiveActiveToolControl`
      // (resolveActiveToolControlId), so this re-check is belt-and-braces
      // against future callers passing a toggle id directly. One control id
      // always carries one activation role (dual-homed presenters share the
      // provider control), so gating on the first holder is exact.
      const gated = holders[0]?.items.find(
        (item) => item.control.id === activeControlId,
      );
      if (gated === undefined || !isExclusiveActiveToolControl(gated.control))
        return;
      // One entry per EFFECTIVE strip-group key holding the control:
      // ordinary tools write exactly one key, as before; the dual-homed Text
      // creation alias writes both its presenter groups (Insert + Text).
      const seenKeys = new Set<string>();
      for (const category of holders) {
        const key = `${scopeKey}::${stripGroupIdForCategory(category)}`;
        if (seenKeys.has(key)) continue;
        seenKeys.add(key);
        memory.set(key, {
          categoryId: category.id,
          controlId: activeControlId,
        });
      }
    },
    [scopeKey],
  );
  const recall = useCallback(
    (stripGroupKey: string): StripGroupRemembered | null =>
      ensureScope(scopeKey).get(`${scopeKey}::${stripGroupKey}`) ?? null,
    [scopeKey],
  );
  return useMemo(() => ({ record, recall }), [record, recall]);
}

/**
 * Shared layout-model builder for the provider and standalone fallback
 * paths. `computed` is the single `computeUnifiedToolbarModel` result for
 * the pane; execution always resolves through the full assembled owned pool
 * (never the placement-claimed subset) so semantic items stay executable
 * even when no legacy placement claims their control.
 */
function buildUnifiedToolbarLayout(input: {
  readonly computed: ReturnType<typeof computeUnifiedToolbarModel>;
  readonly tools: WorkbenchEditorToolsPort;
  readonly contributions: DocumentToolbarRegistry;
  readonly pane: string;
  readonly selectedCategoryId: string | null;
  readonly activeToolCategoryId: string | null;
  readonly activeToolControlId: string | null;
  readonly setSelectedCategoryId: (id: string) => void;
}): UnifiedToolbarLayout {
  const {
    computed,
    tools,
    contributions,
    pane,
    selectedCategoryId,
    activeToolCategoryId,
    activeToolControlId,
    setSelectedCategoryId,
  } = input;
  // `layout.diagnostics` already merges assembled + resolved +
  // composition (duplicate roles, ordering cycles, unresolved items), so one
  // report covers all three without a second channel.
  reportDiagnostics(computed.layout.diagnostics);
  // Composition execution uses the full assembled pool, never the
  // placement-claimed subset: semantic items stay executable even when
  // no legacy placement claims their provider control.
  const ownedById = computed.ownedById;
  const execute = (id: string, value?: string): void => {
    const owned = ownedById.get(id);
    if (owned === undefined) return;
    // dispatch never throws outward; async rejections degrade +
    // report through the same dev channel instead of unhandled rejections.
    try {
      const result = executeOwnedControl(
        { tools, contributions, pane, context: computed.context },
        owned,
        value,
      );
      if (result instanceof Promise) {
        result.catch((error: unknown) =>
          reportToolbarDispatchFailure(error, 'toolbar execute'),
        );
      }
    } catch (error) {
      reportToolbarDispatchFailure(error, 'toolbar execute');
    }
  };
  const executeOwnedImpl = (
    item: OwnedToolbarControl,
    value?: string,
  ): void => {
    try {
      const result = executeOwnedControl(
        { tools, contributions, pane, context: computed.context },
        item,
        value,
      );
      if (result instanceof Promise) {
        result.catch((error: unknown) =>
          reportToolbarDispatchFailure(error, 'toolbar execute'),
        );
      }
    } catch (error) {
      reportToolbarDispatchFailure(error, 'toolbar execute');
    }
  };
  const activeCategoryId = resolveExpandedCategoryId(
    computed.compositionGraph,
    selectedCategoryId,
  );
  return {
    snapshot: computed.snapshot,
    layout: computed.layout,
    groups: computed.layout.groups,
    ownedById,
    settingsControls: computed.settingsControls,
    compositionGraph: computed.compositionGraph,
    activeCategoryId,
    activeToolCategoryId,
    activeToolControlId,
    setActiveCategoryId: setSelectedCategoryId,
    execute,
    executeOwned: executeOwnedImpl,
    canUndo: computed.canUndo,
    canRedo: computed.canRedo,
    // history dispatch never throws outward; failures degrade +
    // report instead of breaking toolbar interaction.
    undo: () => {
      try {
        tools.execEditorCommand('undo', pane);
      } catch (error) {
        reportToolbarDispatchFailure(error, 'toolbar undo');
      }
    },
    redo: () => {
      try {
        tools.execEditorCommand('redo', pane);
      } catch (error) {
        reportToolbarDispatchFailure(error, 'toolbar redo');
      }
    },
  };
}

/**
 * One pane-level toolbar model/provider. Compute once per pane and pass
 * down so `TopbarCenterTools` and `FloatingToolbarLayer` consume the same
 * render model with one subscription per source per pane.
 */
export function UnifiedToolbarProvider(
  props: UnifiedToolbarProps & { readonly children: React.ReactNode },
): React.ReactElement {
  const {
    tools,
    contributions,
    placements,
    composition,
    pane,
    documentId,
    kindId,
    children,
  } = props;
  const [tick, changed] = useReducer((count: number) => count + 1, 0);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(
    null,
  );
  const [contextualShelfOpen, setContextualShelfOpen] = useState(true);
  const [writingShelfOpen, setWritingShelfOpen] = useState(false);
  useEffect(() => setContextualShelfOpen(true), [documentId]);
  useEffect(() => {
    // a throwing registry must never break mount; teardown never
    // throws back into React. OPTIONAL absent (no composition) stays
    // silent — no probe, no diagnostic.
    const reportSubscribe = (error: unknown): void => {
      reportToolbarDispatchFailure(error, 'toolbar subscribe');
    };
    const disposers = [
      safeSubscribe(() => contributions.onDidChange(changed), reportSubscribe),
      safeSubscribe(() => placements.onDidChange(changed), reportSubscribe),
      safeSubscribe(() => tools.onDidChange(changed), reportSubscribe),
      ...(composition === undefined
        ? []
        : [
            safeSubscribe(
              () => composition.onDidChange(changed),
              reportSubscribe,
            ),
          ]),
    ];
    return () => {
      for (const disposer of disposers) safeDispose(disposer);
    };
  }, [contributions, placements, tools, composition]);

  const computed = useMemo(
    () =>
      computeUnifiedToolbarModel({
        tools,
        contributions,
        placements,
        ...(composition !== undefined ? { composition } : {}),
        pane,
        documentId,
        kindId,
      }),
    [
      tools,
      contributions,
      placements,
      composition,
      pane,
      documentId,
      kindId,
      tick,
    ],
  );
  const writingPresentation =
    computed.compositionGraph?.familyIds.includes('writing') ?? false;
  const activeToolCategoryId = resolveActiveToolCategoryId(
    computed.compositionGraph,
    selectedCategoryId,
  );
  const activeToolControlId = resolveActiveToolControlId(
    computed.compositionGraph,
  );
  const activeToolSemanticRole = resolveActiveToolSemanticRole(
    computed.compositionGraph,
  );
  useReconcileActiveCategorySelection(
    activeToolCategoryId,
    activeToolControlId,
    selectedCategoryId,
    setSelectedCategoryId,
    true,
    activeToolSemanticRole,
  );

  const model = useMemo(
    () =>
      buildUnifiedToolbarLayout({
        computed,
        tools,
        contributions,
        pane,
        selectedCategoryId,
        activeToolCategoryId,
        activeToolControlId,
        setSelectedCategoryId,
      }),
    [
      computed,
      tools,
      contributions,
      pane,
      selectedCategoryId,
      activeToolCategoryId,
      activeToolControlId,
    ],
  );

  // Recompute on every render would defeat the single-computation goal if
  // children subscribed separately; memo above plus context ensures one
  // subscription set per pane. The reducer tick forces a new memo via
  // parent rerender (tools/contributions/placements identity stable).
  // pane-scoped disclosure coordination (global exclusive-open
  // + resetKey-clear-all) lives here — one scope per pane, keyed by the
  // same pane:document resetKey every disclosure observes. Single model
  // per pane is preserved (this adds presentation coordination only, never
  // a second toolbar model).
  return (
    <UnifiedToolbarModelContext.Provider value={model}>
      <ContextualShelfContext.Provider
        value={{
          open: writingPresentation ? writingShelfOpen : contextualShelfOpen,
          setOpen: writingPresentation
            ? setWritingShelfOpen
            : setContextualShelfOpen,
        }}
      >
        <ToolbarDisclosureProvider resetKey={`${pane}:${documentId}`}>
          {children}
        </ToolbarDisclosureProvider>
      </ContextualShelfContext.Provider>
    </UnifiedToolbarModelContext.Provider>
  );
}

/** Resolve the flat semantic pool into the unified top-bar + floating layout. */
export function useUnifiedToolbarLayout(
  props: UnifiedToolbarProps,
): UnifiedToolbarLayout {
  const fromContext = useContext(UnifiedToolbarModelContext);
  // When mounted under UnifiedToolbarProvider (Pane), reuse the single
  // pane-level computation instead of subscribing again. The provider is
  // pane-scoped (one per Pane), so reuse is safe; document switches
  // recompute via provider props.
  const hasProvider = fromContext !== null;
  const {
    tools,
    contributions,
    placements,
    composition,
    pane,
    documentId,
    kindId,
  } = props;
  const [tick, changed] = useReducer((count: number) => count + 1, 0);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(
    null,
  );
  useEffect(() => {
    if (hasProvider) return;
    const reportSubscribe = (error: unknown): void => {
      reportToolbarDispatchFailure(error, 'toolbar subscribe');
    };
    const disposers = [
      safeSubscribe(() => contributions.onDidChange(changed), reportSubscribe),
      safeSubscribe(() => placements.onDidChange(changed), reportSubscribe),
      safeSubscribe(() => tools.onDidChange(changed), reportSubscribe),
      ...(composition === undefined
        ? []
        : [
            safeSubscribe(
              () => composition.onDidChange(changed),
              reportSubscribe,
            ),
          ]),
    ];
    return () => {
      for (const disposer of disposers) safeDispose(disposer);
    };
  }, [contributions, placements, tools, composition, hasProvider]);

  const computedFallback = useMemo(() => {
    // Truly single computation per pane: when a provider model exists,
    // reuse context without computing a fallback that would be discarded.
    if (hasProvider) return null;
    return computeUnifiedToolbarModel({
      tools,
      contributions,
      placements,
      ...(composition !== undefined ? { composition } : {}),
      pane,
      documentId,
      kindId,
    });
  }, [
    tools,
    contributions,
    placements,
    composition,
    pane,
    documentId,
    kindId,
    tick,
    hasProvider,
  ]);
  const fallbackActiveToolCategoryId = resolveActiveToolCategoryId(
    computedFallback?.compositionGraph ?? null,
    selectedCategoryId,
  );
  const fallbackActiveToolControlId = resolveActiveToolControlId(
    computedFallback?.compositionGraph ?? null,
  );
  const fallbackActiveToolSemanticRole = resolveActiveToolSemanticRole(
    computedFallback?.compositionGraph ?? null,
  );
  useReconcileActiveCategorySelection(
    fallbackActiveToolCategoryId,
    fallbackActiveToolControlId,
    selectedCategoryId,
    setSelectedCategoryId,
    !hasProvider,
    fallbackActiveToolSemanticRole,
  );

  const fallback = useMemo(() => {
    if (hasProvider && fromContext !== null) return fromContext;
    const computed = computedFallback;
    if (computed === null) {
      // Null only when hasProvider short-circuited the compute above; the
      // early return already reused the provider model. Narrow here to keep
      // the memo total without an extra computation.
      if (fromContext !== null) return fromContext;
      throw new Error('UnifiedToolbar: missing provider model and fallback');
    }
    return buildUnifiedToolbarLayout({
      computed,
      tools,
      contributions,
      pane,
      selectedCategoryId,
      activeToolCategoryId: fallbackActiveToolCategoryId,
      activeToolControlId: fallbackActiveToolControlId,
      setSelectedCategoryId,
    });
  }, [
    computedFallback,
    tools,
    contributions,
    pane,
    hasProvider,
    fromContext,
    selectedCategoryId,
    fallbackActiveToolCategoryId,
    fallbackActiveToolControlId,
  ]);

  if (hasProvider && fromContext !== null) return fromContext;
  return fallback;
}

const FLOATING_LABELS: Readonly<
  Record<Exclude<ToolbarAnchor, 'topbar-center'>, string>
> = {
  'float.top-left': 'Top left tools',
  'float.top-center': 'Top center tools',
  'float.top-right': 'Top right tools',
  'float.left-center': 'Left tools',
  'float.right-center': 'Right tools',
  'float.bottom-left': 'Bottom left tools',
  'float.bottom-center': 'Bottom center tools',
  'float.bottom-right': 'Bottom right tools',
  'float.selection': 'Selection tools',
};

/**
 * Resolve owned settings controls into the renderer source. Controls stay
 * bare data for presentation; execution routes through the preserved owner
 * (provider/shell/contribution) via `executeOwned`.
 */
function settingsSourceFor(
  settings: readonly OwnedToolbarControl[],
  executeOwned: UnifiedToolbarLayout['executeOwned'],
): SurfaceToolSettingsSource {
  const ownedById = new Map(settings.map((owned) => [owned.control.id, owned]));
  return {
    controls: settings.map((owned) => owned.control),
    execute: (id: string, value?: string): void => {
      const item = ownedById.get(id);
      if (item !== undefined) executeOwned(item, value);
    },
  };
}

/**
 * Render one placement group preserving id/anchor/order/priority/compact.
 * Within a placement, semantic sub-groups (`control.group`) render as before
 * so existing control grouping is preserved while placement boundaries stay
 * intact for responsive compaction.
 */
function renderPlacementGroup(
  group: ResolvedToolbarGroup,
  executeOwned: UnifiedToolbarLayout['executeOwned'],
  resetKey: string,
  settings?: readonly OwnedToolbarControl[],
): React.ReactElement {
  const controls = group.controls.map((owned) => owned.control);
  const ownedById = new Map(
    group.controls.map((owned) => [owned.control.id, owned]),
  );
  const settingsSource = settingsSourceFor(settings ?? [], executeOwned);
  return (
    <div
      className={styles['fl-document-tool-group']}
      data-placement={group.id}
      data-priority={group.priority}
      data-compact={group.compact}
      data-placement-anchor={group.anchor}
      data-order={group.order}
      key={group.id}
    >
      {groupControls(controls).map(([semanticGroup, entries]) => (
        <div
          className={styles['fl-document-tool-group']}
          data-group={semanticGroup}
          key={semanticGroup}
        >
          {entries.map((control) => {
            const owned = ownedById.get(control.id);
            const run = (id: string, value?: string): void => {
              if (owned !== undefined) executeOwned(owned, value);
            };
            if (control.id === 'block.type' && control.kind === 'choice') {
              return (
                <select
                  key={control.id}
                  className={styles['fl-writing-style-select']}
                  aria-label={control.label}
                  value={control.value}
                  disabled={control.disabled}
                  onChange={(event) =>
                    run(control.id, event.currentTarget.value)
                  }
                >
                  {control.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              );
            }
            return renderControl(control, run, resetKey, settingsSource);
          })}
        </div>
      ))}
    </div>
  );
}

/**
 * Overflow trigger staying inside the same toolbar surface (never a second
 * full-width row). Hidden groups remain reachable via a pane-scoped popover
 * menu (portaled to avoid island clipping, positioned with flip/shift/clamp).
 *
 * The menu is a labelled group, not `role="menu"`: its children are the
 * real heterogeneous toolbar controls (buttons, selects, sliders), which
 * cannot take menuitem roles. Only the homogeneous category overflow keeps
 * true menu semantics.
 */
function OverflowMenu(props: {
  readonly groups: readonly ResolvedToolbarGroup[];
  readonly executeOwned: UnifiedToolbarLayout['executeOwned'];
  readonly resetKey: string;
  readonly label: string;
  readonly settings?: readonly OwnedToolbarControl[];
}): React.ReactElement | null {
  const { groups, executeOwned, resetKey, label, settings } = props;
  const [open, setOpen] = useState(false);
  // Pane-global exclusive-open + resetKey-clear-all: island
  // overflows join the same pane scope as slot editors and shelf/category
  // More menus — opening one closes the rest, and pane:document switches
  // clear all. Portaled menu, Esc/outside, and focus return unchanged.
  const disclosure = useToolbarDisclosure({ resetKey, open, setOpen });
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const position = useToolbarPopoverPosition({
    triggerRef,
    popoverRef,
    enabled: open,
  });
  useFocusFirstOnOpen(open, popoverRef);
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        (triggerRef.current?.contains(target) ?? false) ||
        (popoverRef.current?.contains(target) ?? false)
      )
        return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);
  if (groups.length === 0) return null;
  return (
    <div
      className={styles['fl-document-tool-group']}
      data-overflow-trigger=""
      key="__overflow"
    >
      <button
        type="button"
        className={styles['fl-document-tool']}
        aria-label={label}
        aria-expanded={open}
        ref={triggerRef}
        onClick={() => {
          const next = !open;
          if (next) disclosure.claimOpen();
          else disclosure.release();
          setOpen(next);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && open) {
            event.preventDefault();
            setOpen(false);
            triggerRef.current?.focus();
          } else if (
            (event.key === 'ArrowDown' || event.key === 'Enter') &&
            !open
          ) {
            // Menu-button pattern: arrowing down opens and lands inside.
            event.preventDefault();
            disclosure.claimOpen();
            setOpen(true);
          }
        }}
      >
        <Icon name="more" size={16} />
      </button>
      {open ? (
        <ToolbarPopoverPortal>
          <div
            className={styles['fl-document-tool-popover']}
            role="group"
            aria-label={label}
            ref={popoverRef}
            data-popover-placement={position?.placement ?? 'below'}
            style={
              position !== null
                ? {
                    position: 'fixed',
                    left: position.left,
                    top: position.top,
                    maxWidth: position.maxWidth,
                    maxHeight: position.maxHeight,
                    overflow: 'auto',
                    transform: 'none',
                  }
                : { position: 'fixed' }
            }
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
                triggerRef.current?.focus();
                return;
              }
              if (handleMenuListKeyDown(event, popoverRef.current))
                event.preventDefault();
            }}
          >
            {groups.map((group) => (
              <div key={group.id}>
                {renderPlacementGroup(group, executeOwned, resetKey, settings)}
              </div>
            ))}
          </div>
        </ToolbarPopoverPortal>
      ) : null}
    </div>
  );
}

/**
 * OverflowMenu-style dismissal lifecycle for inline toolbar menus
 * (category More menu, shelf More tools menu): outside pointerdown
 * dismisses, without stealing the click target. Escape handling lives on
 * each trigger/menu pair next to this hook (close + return focus to the
 * trigger), matching the OverflowMenu trigger contract above.
 */
function useMenuDismissal(input: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly triggerRef: React.RefObject<HTMLButtonElement | null>;
  readonly menuRef: React.RefObject<HTMLDivElement | null>;
}): void {
  const { open, onClose, triggerRef, menuRef } = input;
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        (triggerRef.current?.contains(target) ?? false) ||
        (menuRef.current?.contains(target) ?? false)
      )
        return;
      onClose();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, onClose, triggerRef, menuRef]);
}

/**
 * True when touch is available anywhere: the primary
 * `(pointer: coarse)` query alone misclassifies hybrid hosts (iPad +
 * trackpad, touchscreen laptops) whose primary pointer is fine while finger
 * touch interactions still need to remain available. `(any-pointer: coarse)` catches those; JS
 * budgeting and the CSS hit policy below both derive from this availability
 * so they can never disagree.
 */
function coarsePointer(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function')
    return false;
  try {
    return (
      window.matchMedia('(pointer: coarse)').matches ||
      window.matchMedia('(any-pointer: coarse)').matches
    );
  } catch {
    return false;
  }
}

/**
 * Subscribe to one capability media query. Guards environments without
 * `matchMedia` (jsdom fallbacks, SSR) the same way the historic compact
 * hook did: unmatched means "not compact / fine pointer" until a real
 * host resolves otherwise.
 */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false,
  );
  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      typeof window.matchMedia !== 'function'
    )
      return;
    const media = window.matchMedia(query);
    const update = (): void => setMatches(media.matches);
    update();
    media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, [query]);
  return matches;
}

/** Window-width compact fallback (first paint / unmeasured panes). */
function useWindowCompact(): boolean {
  return useMediaQuery(TOOLBAR_COMPACT_QUERY);
}

/**
 * Reactive touch availability mirrors `coarsePointer()` and
 * re-renders when a touchscreen attaches/detaches or the primary pointer
 * flips, so the overflow reserve and shelf budgeting track the same
 * capability the CSS hit policy sees. One subscription per toolbar surface
 * (topbar + floating layer per pane), never per control.
 */
function useTouchAvailable(): boolean {
  const [touch, setTouch] = useState(coarsePointer);
  useEffect(() => {
    if (
      typeof window === 'undefined' ||
      typeof window.matchMedia !== 'function'
    )
      return;
    let primary: MediaQueryList | null = null;
    let anyPointer: MediaQueryList | null = null;
    try {
      primary = window.matchMedia('(pointer: coarse)');
      anyPointer = window.matchMedia('(any-pointer: coarse)');
    } catch {
      return;
    }
    const update = (): void => setTouch(coarsePointer());
    update();
    primary.addEventListener?.('change', update);
    anyPointer?.addEventListener?.('change', update);
    return () => {
      primary?.removeEventListener?.('change', update);
      anyPointer?.removeEventListener?.('change', update);
    };
  }, []);
  return touch;
}

/**
 * Pane-scoped toolbar presentation. Layout (compact/medium/wide) is
 * width-driven through
 * the shared workspace policy — `COMPACT_MAX_WIDTH` stays the single
 * source in `workspace/interaction-policy.js`, never a second toolbar
 * breakpoint — while interaction density is
 * input-driven. Pen reports through the ordinary fine-pointer path (no
 * UA/iPad detection): toolbar taps activate via click, never via a global
 * pen-as-draw gate.
 */
export interface ToolbarPanePresentation {
  readonly layout: WorkspaceLayoutMode;
  /** Width-driven structure decision: category strip + shelf compact. */
  readonly compact: boolean;
  /** Input capability hint; visual control geometry stays compact. */
  readonly density: 'compact' | 'touch';
}

export function resolveToolbarPanePresentation(input: {
  readonly width: number;
  readonly capabilities: WorkspaceInteractionCapabilities;
}): ToolbarPanePresentation {
  const policy = workspacePresentationPolicy(input);
  return {
    layout: policy.layout,
    compact: policy.layout === 'compact',
    density: policy.controlDensity,
  };
}

/**
 * Width source for the compact decision. An explicit positive `paneWidth`
 * (measured pane, toolbar container budget, or test geometry) always wins
 * over the window query: a ~500px split pane inside a wide window compacts
 * even though the viewport never crosses `COMPACT_MAX_WIDTH`. A missing or
 * non-positive width means "not yet measured" — jsdom reports 0
 * everywhere and the first paint precedes layout — so the caller falls
 * back to the window query instead of compacting the world.
 */
export function shouldCompactToolbar(input: {
  readonly paneWidth?: number;
  readonly windowCompact: boolean;
}): boolean {
  if (input.paneWidth !== undefined && input.paneWidth > 0)
    return input.paneWidth <= COMPACT_MAX_WIDTH;
  return input.windowCompact;
}

/**
 * Pane-aware compact decision replacing the window-only hook. Precedence:
 * explicit `paneWidth` prop → measured container/pane width → window
 * `TOOLBAR_COMPACT_QUERY` fallback. One media subscription per toolbar
 * surface (topbar + floating layer per pane), never per control.
 */
function useToolbarCompact(paneWidth?: number): boolean {
  const windowCompact = useWindowCompact();
  return shouldCompactToolbar({ paneWidth, windowCompact });
}

/**
 * Observe the enclosing pane's content width for the compact decision.
 * The observer attaches to the closest `[data-pane]` ancestor (the pane
 * section), falling back to the referenced element itself for standalone
 * mounts. Loop-free by construction: the floating layer is absolutely
 * positioned (it never sizes its pane) and the topbar container is
 * parent-budgeted (`flex: 1` with internal scroll), so compacting the
 * toolbar never moves the width being observed. Returns `undefined` until
 * a positive width is observed so unmeasured hosts keep the window
 * fallback. One observer per toolbar surface, never per control.
 */
function usePaneWidth(
  ref: React.RefObject<HTMLElement | null>,
): number | undefined {
  const [width, setWidth] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const target =
      (typeof element.closest === 'function'
        ? element.closest('[data-pane]')
        : null) ?? element;
    const read = (): number | undefined => {
      const rect =
        typeof target.getBoundingClientRect === 'function'
          ? target.getBoundingClientRect()
          : null;
      if (rect !== null && rect.width > 0) return rect.width;
      const clientWidth = (target as unknown as { clientWidth?: number })
        .clientWidth;
      return clientWidth !== undefined && clientWidth > 0
        ? clientWidth
        : undefined;
    };
    setWidth((previous) => {
      const next = read();
      return previous === next ? previous : next;
    });
    if (typeof ResizeObserver !== 'function') return;
    const observer = new ResizeObserver(() => {
      setWidth((previous) => {
        const next = read();
        return previous === next ? previous : next;
      });
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/**
 * Compact breakpoint shared with the workspace presentation policy
 * (`COMPACT_MAX_WIDTH` in `workspace/interaction-policy.js`):
 * the toolbar consumes the same compact/medium/wide capability instead of
 * an independent `mobile` boolean. This query is the *window* fallback for
 * the pane-aware `useToolbarCompact` decision: whenever a real
 * pane/container width is measured it wins over this viewport query, so a
 * narrow split pane inside a wide window still compacts. Exported so specs
 * stub the exact query.
 */
export const TOOLBAR_COMPACT_QUERY = `(max-width: ${COMPACT_MAX_WIDTH}px)`;

// Compact categories are icon-only and share the desktop control width. Reserve the same 2px strip gap here so the
// projection never asks a measured header to scroll merely to show More.
const COMPACT_CATEGORY_WIDTH = 34;
const COMPACT_CATEGORY_GAP = 2;

function compactCategoryCapacity(
  categoryCount: number,
  availableWidth: number | undefined,
): number {
  // Keep the established first-paint projection until the strip has a real
  // measurement; the observer immediately replaces it with the budgeted
  // projection below in product hosts.
  if (availableWidth === undefined || !(availableWidth > 0))
    return Math.min(categoryCount, 3);
  const allWidth =
    categoryCount * COMPACT_CATEGORY_WIDTH +
    Math.max(0, categoryCount - 1) * COMPACT_CATEGORY_GAP;
  if (allWidth <= availableWidth) return categoryCount;
  // One slot remains for More whenever not every category fits.
  return Math.max(
    0,
    Math.floor(
      (availableWidth + COMPACT_CATEGORY_GAP) /
        (COMPACT_CATEGORY_WIDTH + COMPACT_CATEGORY_GAP),
    ) - 1,
  );
}

/** Shared visual density keeps the overflow reserve identical for every input. */
export function autoOverflowWidth(_coarse?: boolean): number {
  return 30;
}

const EMPTY_SET: ReadonlySet<string> = new Set<string>();

/**
 * Apply pure priority-based compaction to one toolbar surface. When
 * `availableWidth` is finite, lower-priority `compact: 'auto'` groups move
 * into the in-surface overflow menu; `compact: 'never'` groups are always
 * preserved and `compact: 'always'` groups always overflow. Callers that
 * pass `hysteresis` also get sticky overflow membership: a group that just
 * overflowed needs `hysteresis` extra pixels to return, so resizes hovering
 * on the threshold settle instead of flipping the menu every frame.
 */
export function useCompactedGroups(
  groups: readonly ResolvedToolbarGroup[],
  availableWidth?: number,
  measuredWidths?: ReadonlyMap<string, number> | Record<string, number>,
  options: {
    readonly overflowWidth?: number;
    readonly hysteresis?: number;
  } = {},
): {
  readonly visible: readonly ResolvedToolbarGroup[];
  readonly overflow: readonly ResolvedToolbarGroup[];
} {
  const { overflowWidth, hysteresis = 0 } = options;
  const [stickyIds, setStickyIds] = useState<ReadonlySet<string>>(EMPTY_SET);
  const result = useMemo(() => {
    if (availableWidth === undefined || measuredWidths === undefined) {
      return { visible: groups, overflow: [] as ResolvedToolbarGroup[] };
    }
    return planToolbarCompaction(groups, availableWidth, measuredWidths, {
      ...(overflowWidth !== undefined ? { overflowWidth } : {}),
      ...(hysteresis > 0 ? { hysteresis, overflowIds: stickyIds } : {}),
    });
  }, [
    groups,
    availableWidth,
    measuredWidths,
    overflowWidth,
    hysteresis,
    stickyIds,
  ]);
  // Track overflow membership for the next plan's hysteresis. The equality
  // guard keeps this stable: membership only changes when the plan changes
  // it, and the handicap only ever delays re-entry, so planning converges
  // instead of oscillating.
  useEffect(() => {
    if (hysteresis <= 0) return;
    if (availableWidth === undefined || measuredWidths === undefined) {
      setStickyIds((prev) => (prev.size === 0 ? prev : EMPTY_SET));
      return;
    }
    setStickyIds((prev) => {
      const next = new Set(result.overflow.map((group) => group.id));
      if (next.size === prev.size && [...next].every((id) => prev.has(id)))
        return prev;
      return next;
    });
  }, [result, hysteresis, availableWidth, measuredWidths]);
  return result;
}

/**
 * Pane-surface auto-measurement for real responsive compaction (not CSS
 * scroll alone). Measures the container's available width and each
 * placement group's width, then plans priority-based overflow inside the
 * same surface. In jsdom (no layout) widths are 0 so everything stays
 * visible; in production Chromium the overflow trigger appears when groups
 * no longer fit.
 */
/**
 * Structural measurement key: group/control identities, not just the count.
 * A label widening without add/remove still invalidates measurement.
 */
export function toolbarMeasurementKey(
  groups: readonly ResolvedToolbarGroup[],
): string {
  return groups
    .map(
      (group) =>
        `${group.id}:${group.controls.map((c) => c.control.id).join(',')}`,
    )
    .join('|');
}

/**
 * Merge fresh visible observations into the persistent width cache.
 * Positive widths overwrite; overflowed (unobserved) groups keep their
 * last-known width so the planner budgets them instead of reading 0.
 * Ids whose group left the model are pruned. Copy-on-write: the input
 * cache is never mutated.
 */
export function updateWidthCache(
  cache: ReadonlyMap<string, number>,
  observations: ReadonlyMap<string, number>,
  activeIds: ReadonlySet<string>,
): Map<string, number> {
  const next = new Map(cache);
  for (const [id, width] of observations) {
    if (width > 0) next.set(id, width);
    else if (!next.has(id)) next.set(id, width);
  }
  for (const id of [...next.keys()]) {
    if (!activeIds.has(id)) next.delete(id);
  }
  return next;
}

function useAutoToolbarWidths(groups: readonly ResolvedToolbarGroup[]): {
  readonly containerRef: (element: HTMLDivElement | null) => void;
  readonly availableWidth: number | undefined;
  readonly measuredWidths: ReadonlyMap<string, number> | undefined;
} {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const containerRef = useCallback((element: HTMLDivElement | null) => {
    setContainer(element);
  }, []);
  const [availableWidth, setAvailableWidth] = useState<number | undefined>(
    undefined,
  );
  const [measuredWidths, setMeasuredWidths] = useState<
    ReadonlyMap<string, number> | undefined
  >(undefined);
  const measurementKey = toolbarMeasurementKey(groups);
  // Persistent last-known widths: once a group overflows it leaves the
  // visible row, but the planner must keep budgeting its last measured
  // width (missing widths read as 0 and would make it reappear,
  // oscillating at the threshold). Entries are pruned only when their
  // group truly disappears from the model — never for merely overflowing.
  const widthCacheRef = useRef(new Map<string, number>());

  // Layout effect (not passive effect) so the first compaction commits
  // before paint: passive measurement caused a visible big→small flash on
  // narrow viewports (show-all first paint, then overflow). One
  // container-only observer keeps per-pane cost O(1): the previous
  // per-placement observers plus per-island window listeners meant nine
  // observers and nine resize listeners per pane firing
  // getBoundingClientRect loops into each other. Container width covers
  // window resizes, pane splits, and drawer flips; group add/remove
  // re-runs via measurementKey. Label-only widening without id changes
  // falls back to the CSS overflow-x scroll inside the same surface, so
  // nothing ever creates a second row.
  useLayoutEffect(() => {
    if (container === null) return;
    const element = container;
    let disposed = false;
    let frame = 0;
    const measure = (): void => {
      if (disposed) return;
      const rect =
        typeof element.getBoundingClientRect === 'function'
          ? element.getBoundingClientRect()
          : null;
      const available =
        rect !== null && rect.width > 0
          ? rect.width
          : ((element as unknown as { clientWidth?: number }).clientWidth ?? 0);
      const cache = widthCacheRef.current;
      const observed = new Map<string, number>();
      const nodes = element.querySelectorAll('[data-placement]');
      for (const node of nodes) {
        const id = (node as HTMLElement).getAttribute('data-placement');
        if (id === null) continue;
        // Skip overflow popover contents (they are not part of the
        // available row budget).
        const inOverflow =
          (node as HTMLElement).closest('[role="menu"]') !== null;
        if (inOverflow) continue;
        const childRect =
          typeof (node as HTMLElement).getBoundingClientRect === 'function'
            ? (node as HTMLElement).getBoundingClientRect()
            : null;
        const width =
          childRect !== null && childRect.width > 0
            ? childRect.width
            : ((node as unknown as { offsetWidth?: number }).offsetWidth ?? 0);
        if (!observed.has(id)) observed.set(id, width);
      }
      const next = updateWidthCache(
        cache,
        observed,
        new Set(groups.map((group) => group.id)),
      );
      // Only publish when something actually fits the planner contract:
      // jsdom reports 0 everywhere, which keeps everything visible.
      setAvailableWidth((prev) => (prev === available ? prev : available));
      setMeasuredWidths((prev) => {
        if (
          prev !== undefined &&
          prev.size === next.size &&
          [...next.entries()].every(([k, v]) => prev.get(k) === v)
        )
          return prev;
        return next;
      });
    };
    const schedule = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    // Synchronous first measure inside the layout effect: React re-renders
    // with the compacted model before the browser paints.
    measure();
    const Observer =
      typeof ResizeObserver === 'function' ? ResizeObserver : null;
    const observer = Observer !== null ? new Observer(schedule) : null;
    observer?.observe(element);
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [container, measurementKey]);

  return { containerRef, availableWidth, measuredWidths };
}

/**
 * First live exclusive tool in verbatim item order.
 *
 * The no-history default for an explicit strip click: the first item whose
 * control is a live, enabled, exclusive TOOL button
 * (`activationRole === 'tool'`, as settled via `buildSurfaceDrawControls`).
 * One-shot ACTIONS (Insert image / PDF before-after, Pages
 * overview/add/duplicate/delete/template, zoom/fit/exports — buttons with
 * `activationRole` missing or anything but `'tool'`) NEVER count, even
 * when live and enabled: auto-selecting them would fire a file picker or
 * a destructive page operation on a group click. Auto-select only real
 * tools (pen/eraser/selector/shape/text). Toggle controls
 * (`activationRole === 'toggle'`, e.g. Bold) never count, non-button
 * kinds (choice/color/range/input) never count, disabled controls never
 * count, and controls with no live owner in the assembled pool
 * (dormant/unresolved) never count — so the default is always an
 * executable settled tool, never a reorder (verbatim order untouched),
 * and never a misrouted execute. Returns `undefined` when the category
 * holds no live tool: action-only presenters (Insert, Pages) browse
 * WITHOUT executing, and fully dormant presenters keep the historic
 * browse-only limit.
 */
export function firstLiveStripCategoryTool(
  items: readonly ResolvedToolbarItem[],
  ownedById: ReadonlyMap<string, OwnedToolbarControl>,
): ResolvedToolbarItem | undefined {
  return items.find((item) => {
    const control = item.control;
    if (control.kind !== 'button') return false;
    // Only settled exclusive tools auto-select. Actions
    // (no `activationRole`, or anything but `'tool'`) never fire on a
    // group click — the shelf browses them instead. Strict `=== 'tool'`
    // (not merely `!== 'toggle'`): the legacy `active === true` fallback
    // must not smuggle a one-shot action into auto-execute.
    if (control.activationRole !== 'tool') return false;
    if (control.disabled === true) return false;
    return ownedById.has(control.id);
  });
}

const WRITING_DIRECT_ROLES = new Set([
  'writing.style',
  'writing.bold',
  'writing.italic',
  'writing.code',
  'writing.link',
  'latex.math.inline',
  'latex.math.display',
]);

function writingItems(graph: ResolvedToolbarGraph): {
  direct: ResolvedToolbarItem[];
  overflow: ResolvedToolbarItem[];
} {
  const items = graph.categories
    .flatMap((category) => category.items)
    .filter(
      (item, index, all) =>
        all.findIndex(
          (candidate) => candidate.control.id === item.control.id,
        ) === index,
    );
  return {
    direct: items.filter((item) => WRITING_DIRECT_ROLES.has(item.semanticRole)),
    overflow: items.filter(
      (item) => !WRITING_DIRECT_ROLES.has(item.semanticRole),
    ),
  };
}

/** Writing commands remain direct actions; the graph still owns membership and routing. */
function WritingDirectToolbar(props: {
  readonly graph: ResolvedToolbarGraph;
  readonly ownedById: UnifiedToolbarLayout['ownedById'];
  readonly executeOwned: UnifiedToolbarLayout['executeOwned'];
  readonly resetKey: string;
}): React.ReactElement {
  const { graph, ownedById, executeOwned, resetKey } = props;
  const contextualShelf = useContext(ContextualShelfContext);
  const { direct, overflow } = writingItems(graph);
  const renderItem = (item: ResolvedToolbarItem): React.ReactElement => {
    const owned = ownedById.get(item.control.id);
    if (
      item.semanticRole === 'writing.style' &&
      item.control.kind === 'choice'
    ) {
      const choice = item.control;
      return (
        <select
          key={item.id}
          className={styles['fl-writing-style-select']}
          aria-label={choice.label}
          title={choice.label}
          value={choice.value}
          disabled={choice.disabled}
          onChange={(event) => {
            if (owned !== undefined) executeOwned(owned, event.target.value);
          }}
        >
          {choice.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      );
    }
    return (
      <Fragment key={item.id}>
        {renderControl(
          item.control,
          (id, value) => {
            const target = ownedById.get(id) ?? owned;
            if (target !== undefined) executeOwned(target, value);
          },
          resetKey,
        )}
      </Fragment>
    );
  };
  return (
    <div
      className={`${styles['fl-topbar-center']} ${styles['fl-writing-direct']}`}
      role="toolbar"
      aria-label="Writing tools"
      data-toolbar="writing-direct"
    >
      {direct.map(renderItem)}
      {overflow.length > 0 ? (
        <div className={styles['fl-toolbar-overflow-wrap']}>
          <button
            type="button"
            className={styles['fl-toolbar-category']}
            aria-label="Insert and more"
            aria-expanded={contextualShelf?.open ?? false}
            onClick={() => contextualShelf?.setOpen(!contextualShelf.open)}
          >
            <Icon name="plus" size={17} />
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Primary document tools for the pane top-bar center. Null when unplaced. */
export function TopbarCenterTools(
  props: UnifiedToolbarProps & {
    readonly availableWidth?: number;
    readonly measuredWidths?:
      | ReadonlyMap<string, number>
      | Record<string, number>;
    /**
     * Real available pane width for the compact decision.
     * Wins over the measured container budget and the window fallback so
     * a narrow split pane inside a wide window compacts. When omitted the
     * auto-measured container width decides once layout reports it.
     */
    readonly paneWidth?: number;
  },
): React.ReactElement | null {
  const {
    snapshot,
    groups,
    executeOwned,
    ownedById,
    settingsControls,
    compositionGraph,
    activeCategoryId,
    activeToolCategoryId,
    activeToolControlId,
    setActiveCategoryId,
  } = useUnifiedToolbarLayout(props);
  const contextualShelf = useContext(ContextualShelfContext);
  // Scoped to this pane's document + kind: the same pane hosting
  // an ink document then a notebook/whiteboard document never restores
  // the other family's remembered sibling — the scope change clears the
  // map, and recall falls back to the first-live default, never to
  // a stale cross-family execute.
  const stripMemory = useStripGroupMemory(
    `${props.kindId}:${props.documentId}`,
  );
  // Record settled exclusive tools in per-strip-group memory.
  // Each strip group remembers its last
  // live tool (Write pens, two Erasers, Select pair, Insert shapes/tools,
  // Text creation, Notebook pages), cross-group writes are impossible by
  // key namespacing, and toggles/temp never write (exclusive-only gate
  // inside `record`).
  useEffect(() => {
    stripMemory.record(compositionGraph, activeToolControlId);
  }, [compositionGraph, activeToolControlId, stripMemory]);
  const [categoryOverflowOpen, setCategoryOverflowOpen] = useState(false);
  // Pane-global exclusive-open + resetKey-clear-all: the
  // category More joins the same pane scope as slot editors, shelf More,
  // and island overflows. Portaled menu, Esc/outside, and focus return
  // unchanged.
  const categoryDisclosure = useToolbarDisclosure({
    resetKey: `${props.pane}:${props.documentId}`,
    open: categoryOverflowOpen,
    setOpen: setCategoryOverflowOpen,
    surface: 'topbar-category-menu',
  });
  const categoryTriggerRef = useRef<HTMLButtonElement | null>(null);
  const categoryMenuRef = useRef<HTMLDivElement | null>(null);
  const closeCategoryOverflow = useCallback(() => {
    setCategoryOverflowOpen(false);
    categoryDisclosure.release();
  }, [categoryDisclosure]);
  useMenuDismissal({
    open: categoryOverflowOpen,
    onClose: closeCategoryOverflow,
    triggerRef: categoryTriggerRef,
    menuRef: categoryMenuRef,
  });
  // Portaled like every other toolbar menu: the strip scrolls internally
  // on narrow split panes, which would clip an inline absolute menu.
  // The pane layer fallback (tests/standalone) still renders in place.
  const categoryMenuPosition = useToolbarPopoverPosition({
    triggerRef: categoryTriggerRef,
    popoverRef: categoryMenuRef,
    enabled: categoryOverflowOpen,
  });
  useFocusFirstOnOpen(categoryOverflowOpen, categoryMenuRef);
  // Hooks must run unconditionally before any early return: the
  // composition branch below returns a different tree, and calling
  // measurement/compaction hooks only on the non-composition path changes
  // the hook count between renders ("Rendered fewer hooks than expected").
  const topbarGroups = useMemo(
    () => groups.filter((group) => group.anchor === 'topbar-center'),
    [groups],
  );
  const auto = useAutoToolbarWidths(topbarGroups);
  const effectiveWidth = props.availableWidth ?? auto.availableWidth;
  const effectiveMeasured = props.measuredWidths ?? auto.measuredWidths;
  // Pane-aware compact decision: the explicit pane width wins,
  // otherwise the auto-measured container budget decides once layout
  // reports it (a narrow split pane compacts inside a wide window), and
  // the window query covers first paint plus unmeasured hosts. The
  // container budget is parent-determined (flex:1 + internal scroll), so
  // deriving compactness from it cannot feed back into its own width.
  const compactComposition = useToolbarCompact(
    props.paneWidth ?? effectiveWidth,
  );
  // The auto-measured path budgets the compact trigger and settles
  // threshold dither with hysteresis; explicit test props retain planner defaults.
  const autoMeasured = props.availableWidth === undefined;
  const touchAvailable = useTouchAvailable();
  const { visible, overflow } = useCompactedGroups(
    topbarGroups,
    effectiveWidth,
    effectiveMeasured,
    autoMeasured
      ? { overflowWidth: autoOverflowWidth(touchAvailable), hysteresis: 8 }
      : {},
  );
  if (props.kindId === 'froglight.blockpage') {
    const marks = [
      'block.bold',
      'block.italic',
      'block.strike',
      'block.code',
      'block.link',
    ]
      .map((id) => ownedById.get(id))
      .filter((owned): owned is OwnedToolbarControl => owned !== undefined);
    return (
      <div
        className={styles['fl-blockpage-primary']}
        role="toolbar"
        aria-label="Writing format"
      >
        {marks.map((owned) => (
          <Fragment key={owned.control.id}>
            {renderControl(
              owned.control,
              (_id, value) => executeOwned(owned, value),
              `${props.pane}:${props.documentId}`,
            )}
          </Fragment>
        ))}
      </div>
    );
  }
  if (compositionGraph !== null && compositionGraph.categories.length > 0) {
    if (compositionGraph.familyIds.includes('writing')) {
      return (
        <WritingDirectToolbar
          graph={compositionGraph}
          ownedById={ownedById}
          executeOwned={executeOwned}
          resetKey={`${props.pane}:${props.documentId}`}
        />
      );
    }
    // Grouped strip: bucket via
    // `groupCategoriesByStripGroup` — first-seen group order, member order
    // verbatim. Each category still renders one button (so both Text
    // presenters stay visible in the strip while the shelf shows one),
    // but identity, indicators, and stickiness key on the EFFECTIVE
    // strip-group id via `stripGroupIdForCategory` — never raw `groupId`,
    // labels, icons, or id substrings (kind-blind shell: no `kindId`
    // branching anywhere in this branch). `surface.shapes` +
    // `surface.insert` share the Insert key (`surface.insert`) and its
    // memory; every other category is a singleton group keyed by its own
    // id. One active indicator per group holds because `aria-pressed`
    // follows the single browsed category while
    // `data-contains-active-tool` follows the single canonical
    // active-tool category (Text dual-homed attributes to `surface.text`
    // via `resolveActiveToolCategoryId`, never both).
    const stripGroups = groupCategoriesByStripGroup(
      compositionGraph.categories,
    );
    const activateStripCategory = (
      category: (typeof compositionGraph.categories)[number],
    ): void => {
      if (category.id === activeCategoryId) {
        contextualShelf?.setOpen(!contextualShelf.open);
        return;
      }
      contextualShelf?.setOpen(true);
      const key = stripGroupIdForCategory(category);
      const remembered = stripMemory.recall(key);
      if (remembered !== null && remembered.controlId !== activeToolControlId) {
        const target = ownedById.get(remembered.controlId);
        // Restore replays only settled exclusive tools.
        // A remembered one-shot action (legacy memory written before the
        // strict gate, e.g. an active overview) falls through to the
        // first-live/browse logic below instead of executing.
        const rememberedIsTool =
          target !== undefined &&
          target.control.kind === 'button' &&
          target.control.activationRole === 'tool';
        // Key-namespaced restore only: the remembered tool must still be
        // live AND belong to the clicked strip group (bucket membership,
        // never id-substring guessing). Cross-group writes are forbidden
        // by construction (we never touch another key). Alias-aware
        // the dual-homed Text creation control lives in both
        // `surface.insert` and `surface.text`, so the holder prefers the
        // remembered presenter and falls back to any same-group live
        // holder — a first-match lookup alone would pin Insert and starve
        // the Text group forever.
        const members = stripGroups.get(key) ?? [];
        const holdsControl = (
          candidate: (typeof compositionGraph.categories)[number],
        ): boolean =>
          candidate.items.some(
            (item) => item.control.id === remembered.controlId,
          ) && members.some((member) => member.id === candidate.id);
        const holder =
          compositionGraph.categories.find(
            (candidate) =>
              candidate.id === remembered.categoryId && holdsControl(candidate),
          ) ?? compositionGraph.categories.find(holdsControl);
        if (
          rememberedIsTool &&
          holder !== undefined &&
          compositionGraph.categories.some(
            (candidate) => candidate.id === remembered.categoryId,
          )
        ) {
          setActiveCategoryId(holder.id);
          executeOwned(target);
          return;
        }
      }
      // An explicit strip click on a tool group leaves a live tool of the
      // group active — never an
      // empty browse-only shelf — while an explicit click on an ACTION
      // group (Insert image/PDF, Pages overview/add/...) browses WITHOUT
      // executing. With history the remembered path above already fired;
      // without it the default is the FIRST live exclusive TOOL verbatim,
      // common to every tool group (Write/Erase/Select/Shapes/Text/Pages
      // with a settled tool). Settled exclusive only (actions/toggles/
      // non-tools/disabled/dormant never count, no reorder); scope stays
      // kindId:documentId session-only.
      const groupMembers = stripGroups.get(key) ?? [category];
      // Active tool already live in the clicked presenter: browse only, no
      // execute and no clobber — the shelf already shows the active tool.
      if (
        activeToolControlId !== null &&
        ownedById.has(activeToolControlId) &&
        category.items.some((item) => item.control.id === activeToolControlId)
      ) {
        setActiveCategoryId(category.id);
        return;
      }
      // No history: first live exclusive TOOL holder of the CLICKED
      // presenter verbatim; actions never auto-execute, so
      // every TOOL shelf stays reachable (a Write click defaults to its
      // first tool, Text creation auto-selects as the settled tool).
      const firstClicked = firstLiveStripCategoryTool(
        category.items,
        ownedById,
      );
      if (firstClicked !== undefined) {
        const target = ownedById.get(firstClicked.control.id);
        if (target !== undefined) {
          setActiveCategoryId(category.id);
          executeOwned(target);
          return;
        }
      }
      // The clicked presenter holds live controls but no
      // exclusive tool (action-only Insert/Pages shelf) — browse the
      // clicked shelf WITHOUT executing and WITHOUT falling back into a
      // sibling member's tool (an Insert click must never auto-select
      // Line from `surface.shapes`, a Pages click must never fire
      // overview/add/duplicate/delete). The sibling fallback below runs
      // ONLY for a fully dormant clicked presenter.
      const clickedHasLiveButton = category.items.some((item) => {
        const control = item.control;
        if (control.kind !== 'button') return false;
        if (control.disabled === true) return false;
        return ownedById.has(control.id);
      });
      if (clickedHasLiveButton) {
        setActiveCategoryId(category.id);
        // Action-only shelves have no tool to activate. Clear the previous
        // drawing/editing tool to the neutral Select cursor without firing
        // any action (Pages, Insert image/PDF, and future action groups).
        const select = [...ownedById.values()].find(
          (owned) =>
            owned.control.kind === 'button' &&
            owned.control.activationRole === 'tool' &&
            owned.control.semanticRole === SURFACE_SELECT_ROLE,
        );
        if (select !== undefined && select.control.id !== activeToolControlId) {
          executeOwned(select);
        }
        return;
      }
      // Clicked presenter dormant: same-group live-holder fallback (shelf
      // follows the holder) before giving up to browse-only.
      for (const member of groupMembers) {
        if (member.id === category.id) continue;
        const firstSibling = firstLiveStripCategoryTool(
          member.items,
          ownedById,
        );
        if (firstSibling === undefined) continue;
        const target = ownedById.get(firstSibling.control.id);
        if (target === undefined) continue;
        setActiveCategoryId(member.id);
        executeOwned(target);
        return;
      }
      // Dormancy limit: no live holder anywhere in the strip group — the
      // ONLY case that stays browse-only after an explicit click.
      setActiveCategoryId(category.id);
    };
    const active = compositionGraph.categories.find(
      (category) => category.id === activeCategoryId,
    );
    const compactCapacity = compactCategoryCapacity(
      compositionGraph.categories.length,
      effectiveWidth,
    );
    const compactLeading = compositionGraph.categories.slice(
      0,
      compactCapacity,
    );
    // The browsed category remains directly available even when the header
    // has room for fewer leading categories; all remaining categories stay
    // reachable through More.
    const compactCategories =
      compactCapacity === 0
        ? []
        : active === undefined || compactLeading.includes(active)
          ? compactLeading
          : [
              ...compositionGraph.categories.slice(
                0,
                Math.max(0, compactCapacity - 1),
              ),
              active,
            ];
    const visibleCategories = compactComposition
      ? compactCategories
      : compositionGraph.categories;
    const overflowCategories = compositionGraph.categories.filter(
      (category) => !visibleCategories.includes(category),
    );
    return (
      <div
        className={`${styles['fl-topbar-center']} ${styles['fl-toolbar-categories']}`}
        role="toolbar"
        aria-label="Document tool categories"
        data-toolbar="category-strip"
        // Pane-driven compact projection: mirrors the window
        // media query in CSS so a narrow pane compacts inside a wide
        // window instead of waiting for the viewport to cross 760px.
        data-compact={compactComposition ? 'true' : 'false'}
        ref={props.availableWidth === undefined ? auto.containerRef : undefined}
      >
        {visibleCategories.map((category) => (
          <button
            type="button"
            className={styles['fl-toolbar-category']}
            aria-label={category.label}
            title={category.label}
            aria-pressed={category.id === activeCategoryId}
            aria-expanded={
              category.id === activeCategoryId &&
              (contextualShelf?.open ?? true)
            }
            data-category={category.id}
            data-strip-group={stripGroupIdForCategory(category)}
            data-contains-active-tool={
              activeToolCategoryId !== null &&
              category.id === activeToolCategoryId
                ? 'true'
                : undefined
            }
            key={category.id}
            onClick={() => activateStripCategory(category)}
          >
            <Icon name={category.icon} size={17} />
          </button>
        ))}
        {overflowCategories.length > 0 ? (
          <div className={styles['fl-toolbar-overflow-wrap']}>
            <button
              type="button"
              className={styles['fl-toolbar-category']}
              aria-label="More tool categories"
              title="More tool categories"
              aria-haspopup="menu"
              aria-expanded={categoryOverflowOpen}
              ref={categoryTriggerRef}
              onClick={() => {
                const next = !categoryOverflowOpen;
                if (next) categoryDisclosure.claimOpen();
                else categoryDisclosure.release();
                setCategoryOverflowOpen(next);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape' && categoryOverflowOpen) {
                  event.preventDefault();
                  closeCategoryOverflow();
                  categoryTriggerRef.current?.focus();
                } else if (
                  (event.key === 'ArrowDown' || event.key === 'Enter') &&
                  !categoryOverflowOpen
                ) {
                  event.preventDefault();
                  categoryDisclosure.claimOpen();
                  setCategoryOverflowOpen(true);
                }
              }}
            >
              <Icon name="more" size={17} />
            </button>
            {categoryOverflowOpen ? (
              <ToolbarPopoverPortal>
                <div
                  className={styles['fl-toolbar-inline-menu']}
                  role="menu"
                  aria-label="More tool categories"
                  ref={categoryMenuRef}
                  data-popover-placement={
                    categoryMenuPosition?.placement ?? 'below'
                  }
                  style={
                    categoryMenuPosition !== null
                      ? {
                          position: 'fixed',
                          left: categoryMenuPosition.left,
                          top: categoryMenuPosition.top,
                          maxWidth: categoryMenuPosition.maxWidth,
                          maxHeight: categoryMenuPosition.maxHeight,
                          overflow: 'auto',
                          right: 'auto',
                          transform: 'none',
                        }
                      : { position: 'fixed' }
                  }
                  onKeyDown={(event) => {
                    // Menu-level Escape (keyboard users tabbed into the menu):
                    // close and return focus to the trigger.
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      closeCategoryOverflow();
                      categoryTriggerRef.current?.focus();
                      return;
                    }
                    if (handleMenuListKeyDown(event, categoryMenuRef.current))
                      event.preventDefault();
                  }}
                >
                  {overflowCategories.map((category) => (
                    <button
                      key={category.id}
                      type="button"
                      role="menuitem"
                      data-category={category.id}
                      data-strip-group={stripGroupIdForCategory(category)}
                      data-contains-active-tool={
                        activeToolCategoryId !== null &&
                        category.id === activeToolCategoryId
                          ? 'true'
                          : undefined
                      }
                      onClick={() => {
                        activateStripCategory(category);
                        closeCategoryOverflow();
                      }}
                    >
                      <Icon name={category.icon} size={17} /> {category.label}
                    </button>
                  ))}
                </div>
              </ToolbarPopoverPortal>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }
  // EXPLICIT FIRST-PAINT: when auto-measurement has not yet
  // produced widths, show all (jsdom + first paint); once measured,
  // priority overflow applies. This is deliberate responsive behavior —
  // not semantic inference and not an implicit role fallback.
  const showAll =
    props.availableWidth === undefined &&
    (effectiveWidth === undefined || effectiveMeasured === undefined);
  const visibleGroups = showAll ? topbarGroups : visible;
  const overflowGroups = showAll ? [] : overflow;
  if (visibleGroups.length === 0 && overflowGroups.length === 0) return null;
  const resetKey = `${props.pane}:${props.documentId}`;
  const settings: readonly OwnedToolbarControl[] = settingsControls;
  return (
    <div
      className={styles['fl-topbar-center']}
      role="toolbar"
      aria-label="Document primary tools"
      data-toolbar="topbar-center"
      ref={props.availableWidth === undefined ? auto.containerRef : undefined}
    >
      <span className="visually-hidden">{snapshot?.context ?? 'Document'}</span>
      {visibleGroups.map((group) =>
        renderPlacementGroup(group, executeOwned, resetKey, settings),
      )}
      {overflowGroups.length > 0 ? (
        <OverflowMenu
          groups={overflowGroups}
          executeOwned={executeOwned}
          resetKey={resetKey}
          label="More document tools"
          settings={settings}
        />
      ) : null}
    </div>
  );
}

/**
 * Contextual shelf quick state: high-frequency
 * controls derived from the active tool's unplaced settings so the shelf
 * handles favorites/widths/colors/modes without the full popover.
 * Pure derivation over owned settings controls (presentation only);
 * execution routes through the preserved owner via the settings source.
 */
export interface ShelfQuickState {
  readonly savedControl: Extract<
    DocumentToolControl,
    { kind: 'choice' }
  > | null;
  readonly favorites: readonly SavedStyleCardData[];
  readonly currentStyleId: string | null;
  readonly colorControl: Extract<DocumentToolControl, { kind: 'color' }> | null;
  readonly sizeControl: Extract<DocumentToolControl, { kind: 'choice' }> | null;
  readonly eraserModeControl: Extract<
    DocumentToolControl,
    { kind: 'choice' }
  > | null;
  readonly eraserRadiusControl: Extract<
    DocumentToolControl,
    { kind: 'range' }
  > | null;
  readonly lassoModeControl: Extract<
    DocumentToolControl,
    { kind: 'choice' }
  > | null;
}

function choiceByRole(
  settings: readonly OwnedToolbarControl[],
  role: string,
): Extract<DocumentToolControl, { kind: 'choice' }> | null {
  const found = settings
    .map((owned) => owned.control)
    .find((control) => control.semanticRole === role);
  return found !== undefined && found.kind === 'choice' ? found : null;
}

export function selectShelfQuicks(
  settings: readonly OwnedToolbarControl[],
): ShelfQuickState {
  const controls = settings.map((owned) => owned.control);
  const color = controls.find(
    (control) => control.semanticRole === 'surface.settings.color',
  );
  const eraserRadius = controls.find(
    (control) => control.semanticRole === 'surface.settings.eraser-size',
  );
  const saved = choiceByRole(settings, 'surface.style.saved');
  return {
    savedControl: saved,
    favorites:
      saved?.savedStyles?.filter((style) => style.favorite).slice(0, 3) ?? [],
    currentStyleId: saved !== null && saved.value !== '' ? saved.value : null,
    colorControl: color !== undefined && color.kind === 'color' ? color : null,
    sizeControl: choiceByRole(settings, 'surface.settings.size'),
    eraserModeControl: choiceByRole(settings, 'surface.settings.eraser-mode'),
    eraserRadiusControl:
      eraserRadius !== undefined && eraserRadius.kind === 'range'
        ? eraserRadius
        : null,
    lassoModeControl: choiceByRole(settings, 'surface.settings.lasso-mode'),
  };
}

type ShelfChoiceControl = Extract<DocumentToolControl, { kind: 'choice' }>;

/**
 * Draw-tool segment behind one composition semantic role. Only the
 * five ink preset tools map; everything else (eraser/lasso/shapes/text/
 * actions) resolves `null` — no size/color slots there. Semantic roles are
 * pinned provider-contract literals (same discipline as
 * `SURFACE_SELECT_ROLE`); never labels, icons, or id substrings.
 */
const SLOT_TOOL_BY_SEMANTIC_ROLE: Readonly<Record<string, InkPresetToolId>> = {
  'surface.pen.ball': 'pen',
  'surface.pen.fountain': 'fountain',
  'surface.pen.brush': 'brush',
  'surface.pencil': 'pencil',
  'surface.highlighter': 'highlighter',
};

function inkSlotFamilyForSurfaceControl(
  control: DocumentToolControl,
): InkSlotFamily | null {
  // Provider conduit identity first; semantic-role fallback for hosts whose
  // controls predate `toolRole` (legacy snapshots without conduits still
  // resolve their family — never id-shape guessing).
  if (control.kind === 'button') {
    if (control.toolRole === 'highlighter') return 'highlighter';
    if (control.toolRole === 'pen') return 'pen';
  }
  const role = control.semanticRole;
  if (role === undefined) return null;
  const tool = SLOT_TOOL_BY_SEMANTIC_ROLE[role];
  if (tool === undefined) return null;
  // Pen-vs-highlighter set ownership stays single-sourced here
  // pen-family tools share one set, the highlighter owns an
  // independent one.
  return inkSlotFamilyForTool(tool);
}

/**
 * Active slot family for the shelf.
 *
 * Settled-first by construction: the exclusive-active tool derives from
 * provider `active` flags, which providers compute from the settled tool
 * (`settledActiveToolId`) — a held temporary tool never flips the slot
 * scope mid-gesture. Pen-family tools resolve `'pen'` (one shared set,
 * pen switches keep the same sizes/colors); the highlighter
 * resolves `'highlighter'` (independent triple); every other
 * active tool (eraser, lasso, select, shapes, text, actions, none)
 * resolves `null` (no size/color slots). Shapes and lines share the pen triple.
 */
export function slotFamilyForShelf(
  model: UnifiedToolbarLayout,
): InkSlotFamily | null {
  const graph = model.compositionGraph;
  if (graph === null) return null;
  for (const category of graph.categories) {
    for (const item of category.items) {
      if (!isExclusiveActiveToolControl(item.control)) continue;
      return item.control.semanticRole?.startsWith('surface.shape.')
        ? 'pen'
        : inkSlotFamilyForSurfaceControl(item.control);
    }
  }
  return null;
}

function ShelfQuickGroup(props: {
  readonly label: string;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <div
      className={styles['fl-shelf-quick']}
      role="group"
      aria-label={props.label}
    >
      {props.children}
    </div>
  );
}

function ShelfFavoriteStyles(props: {
  readonly quicks: ShelfQuickState;
  readonly execute: (id: string, value?: string) => void;
  readonly onNavigate?: () => void;
}): React.ReactElement | null {
  const { quicks, execute, onNavigate } = props;
  if (quicks.savedControl === null || quicks.favorites.length === 0)
    return null;
  const savedId = quicks.savedControl.id;
  return (
    <ShelfQuickGroup label="Favorite styles">
      {quicks.favorites.map((style) => {
        const selected = style.id === quicks.currentStyleId;
        return (
          <button
            type="button"
            className={styles['fl-document-tool']}
            aria-label={savedStyleA11yLabel(style, selected)}
            aria-pressed={selected}
            title={style.name}
            key={style.id}
            onClick={() => {
              execute(savedId, style.id);
              onNavigate?.();
            }}
          >
            <span
              aria-hidden="true"
              className={styles['fl-document-tool-swatch']}
              style={
                style.preset.color !== undefined
                  ? { backgroundColor: style.preset.color }
                  : undefined
              }
            />
          </button>
        );
      })}
    </ShelfQuickGroup>
  );
}

function ShelfQuickWidths(props: {
  readonly control: ShelfChoiceControl;
  readonly execute: (id: string, value?: string) => void;
  readonly onNavigate?: () => void;
}): React.ReactElement {
  const { control, execute, onNavigate } = props;
  const values = control.options.map((option) => Number(option.value));
  const min = Math.min(...values);
  const max = Math.max(...values);
  return (
    <ShelfQuickGroup label="Quick widths">
      {control.options.map((option, index) => {
        const numeric = values[index] ?? 0;
        const height = max > min ? 2 + ((numeric - min) / (max - min)) * 6 : 4;
        return (
          <button
            type="button"
            className={styles['fl-document-tool']}
            aria-label={`${control.label}: ${option.label}`}
            aria-pressed={control.value === option.value}
            title={`${option.label} (${option.value} pt)`}
            key={option.value}
            onClick={() => {
              execute(control.id, option.value);
              onNavigate?.();
            }}
          >
            <span
              aria-hidden="true"
              className={styles['fl-width-bar']}
              style={{ height }}
            />
          </button>
        );
      })}
    </ShelfQuickGroup>
  );
}

function ShelfQuickColors(props: {
  readonly control: Extract<DocumentToolControl, { kind: 'color' }>;
  readonly execute: (id: string, value?: string) => void;
  readonly onNavigate?: () => void;
}): React.ReactElement {
  const { control, execute, onNavigate } = props;
  // Bounded: at most six quick dots; the full palette lives in the popover.
  const visible = control.options.slice(0, 6);
  return (
    <ShelfQuickGroup label="Quick colors">
      {visible.map((color) => (
        <button
          type="button"
          className={styles['fl-document-color']}
          aria-label={`Color: ${color}`}
          aria-pressed={control.value.toLowerCase() === color.toLowerCase()}
          title={color}
          disabled={control.disabled}
          style={{ backgroundColor: color }}
          key={color}
          onClick={() => {
            execute(control.id, color);
            onNavigate?.();
          }}
        />
      ))}
    </ShelfQuickGroup>
  );
}

function ShelfQuickChoice(props: {
  readonly label: string;
  readonly control: ShelfChoiceControl;
  readonly execute: (id: string, value?: string) => void;
  readonly onNavigate?: () => void;
}): React.ReactElement {
  const { label, control, execute, onNavigate } = props;
  const optionIcon = (value: string): string => {
    if (control.semanticRole === 'surface.settings.lasso-mode')
      return value === 'rectangle'
        ? 'rect'
        : value === 'object'
          ? 'cursor'
          : 'lasso';
    if (control.semanticRole === 'surface.settings.eraser-mode')
      return value === 'precision' ? 'eraser-precision' : 'eraser';
    return 'sliders';
  };
  return (
    <ShelfQuickGroup label={label}>
      {control.options.map((option) => (
        <button
          type="button"
          className={styles['fl-document-tool']}
          aria-label={`${control.label}: ${option.label}`}
          aria-pressed={control.value === option.value}
          title={option.label}
          disabled={control.disabled}
          key={option.value}
          onClick={() => {
            execute(control.id, option.value);
            onNavigate?.();
          }}
        >
          <Icon name={optionIcon(option.value)} size={16} />
        </button>
      ))}
    </ShelfQuickGroup>
  );
}

/** Precision Eraser size presets share the pen slots' live edit interaction. */
function ShelfEraserSize(props: {
  readonly control: Extract<DocumentToolControl, { kind: 'range' }>;
  readonly sizes: readonly [number, number, number];
  readonly execute: (id: string, value?: string) => void;
  readonly onEdit: (index: number, value: number) => void;
  readonly onNavigate?: () => void;
}): React.ReactElement {
  const { control, execute, onNavigate } = props;
  const [editing, setEditing] = useState<number | null>(null);
  const anchorRef = useRef<HTMLElement | null>(null);
  return (
    <ShelfQuickGroup label="Eraser size">
      {props.sizes.map((value, index) => {
        const fraction =
          (Math.max(control.min, Math.min(control.max, value)) - control.min) /
          Math.max(1, control.max - control.min);
        const diameter = Math.round(5 + fraction * 13);
        return (
          <button
            type="button"
            className={styles['fl-document-tool']}
            aria-label={`Eraser size slot ${index + 1}: ${value}`}
            aria-pressed={control.value === value}
            aria-haspopup={control.value === value ? 'dialog' : undefined}
            aria-expanded={editing === index}
            title={`${value} pt`}
            disabled={control.disabled}
            key={index}
            onClick={(event) => {
              if (control.value === value) {
                anchorRef.current = event.currentTarget;
                setEditing(editing === index ? null : index);
              } else {
                setEditing(null);
                execute(control.id, String(value));
                onNavigate?.();
              }
            }}
          >
            <span
              className={styles['fl-eraser-size-glyph']}
              style={{ width: diameter, height: diameter }}
              aria-hidden="true"
            />
          </button>
        );
      })}
      {editing !== null ? (
        <ShelfSlotEditPopover
          key={editing}
          kind="size"
          family="eraser"
          index={editing}
          sizeValue={props.sizes[editing] ?? control.value}
          colorValue="#37352f"
          sizeMin={control.min}
          sizeMax={control.max}
          sizeStep={control.step}
          anchorRef={anchorRef}
          onCommit={(commit) => {
            if (commit.sizeValue !== undefined)
              props.onEdit(editing, commit.sizeValue);
          }}
          onClose={() => {
            setEditing(null);
            anchorRef.current?.focus();
          }}
        />
      ) : null}
    </ShelfQuickGroup>
  );
}

/**
 * Shelf capacity budget.
 *
 * The shelf island is intrinsic-size, so it cannot budget its own
 * compaction (measuring it fed the visible/overflow decision back into the
 * measured width and flipped every frame). The pane budget below is
 * parent-determined — explicit `paneWidth` prop, else the layer-observed
 * `[data-pane]` width — so deriving the shelf partition from it cannot feed
 * back into its own width (no feedback loop, one observer per pane owned
 * by the layer). Calibrated against headless-Chromium shelf geometry; see
 * `apps/web/tests/toolbar-touch-medium.spec.ts`.
 */
export const SHELF_SIDE_RESERVE_TOUCH = 168;
export const SHELF_SIDE_RESERVE_FINE = 168;
/**
 * Island padding plus typical inter-cell gaps (calibrated: a full write
 * shelf measures ~913px touch against ~860px of summed cell estimates, so
 * ~48px covers padding + gaps; see
 * `apps/web/tests/toolbar-touch-medium.spec.ts`).
 */
export const SHELF_CHROME = 48;

/** Pane budget left for the shelf center slot after side islands + chrome. */
export function shelfCapacityBudget(paneWidth: number, touch: boolean): number {
  return (
    paneWidth -
    (touch ? SHELF_SIDE_RESERVE_TOUCH : SHELF_SIDE_RESERVE_FINE) -
    SHELF_CHROME
  );
}

/**
 * Shelf estimates share the compact CSS geometry across input methods.
 */
export interface ShelfQuickBudget {
  readonly id: string;
  readonly priority: number;
  readonly width: number;
}

/** Quick-cell budgets in canonical shelf order (favorites → widths → colors → modes). */
export function estimateShelfQuickBudgets(input: {
  readonly favoriteCount: number;
  readonly widthOptionCount: number;
  readonly colorDotCount: number;
  /** Non-empty mode cells in canonical order (eraser-mode, eraser-size, lasso-mode). */
  readonly modeOptionCounts: readonly number[];
  readonly touch: boolean;
}): ShelfQuickBudget[] {
  const unit = 30;
  const budgets: ShelfQuickBudget[] = [];
  if (input.favoriteCount > 0) {
    budgets.push({
      id: 'shelf:favorites',
      priority: 70,
      // Calibrated: swatch + bounded name ≈64px per style in BOTH
      // densities: fine names measured 134px for two
      // against a 128px estimate — text width dominates, so the unit is
      // density-independent).
      width: input.favoriteCount * 64 + 8,
    });
  }
  if (input.widthOptionCount > 0) {
    budgets.push({
      id: 'shelf:widths',
      priority: 60,
      // Compact buttons plus group spacing.
      width: input.widthOptionCount * unit + 16,
    });
  }
  if (input.colorDotCount > 0) {
    budgets.push({
      id: 'shelf:colors',
      priority: 55,
      // Compact color dots plus group spacing.
      width: input.colorDotCount * 25 + 8,
    });
  }
  input.modeOptionCounts.forEach((options, index) => {
    budgets.push({
      id: `shelf:mode:${index}`,
      priority: 40,
      width: Math.max(options, 1) * unit + 16,
    });
  });
  return budgets;
}

/** Conservative intrinsic widths after the shelf's icon-only projection. */
function shelfControlWidth(
  control: DocumentToolControl,
  _touch: boolean,
): number {
  const unit = 30;
  switch (control.kind) {
    case 'choice':
      return unit + 4;
    case 'number':
      return toolbarControlIcon(control) === undefined
        ? control.label.length * 8 + 88 + (control.suffix?.length ?? 0) * 8
        : unit + 72 + (control.suffix?.length ?? 0) * 8;
    case 'table':
      return unit + 4;
    case 'color':
      return (control.options?.length ?? 1) * 29 + 12;
    case 'range':
      return 140;
    case 'input':
      return toolbarControlIcon(control) === undefined ? 180 : unit + 4;
    case 'button':
      return unit + 4;
    case 'status':
      return control.label.length * 8 + 12;
    default:
      return unit + 4;
  }
}

function iconOnlyShelfControl<T extends DocumentToolControl>(control: T): T {
  if (
    (control.kind !== 'button' && control.kind !== 'choice') ||
    toolbarControlIcon(control) !== undefined ||
    ('swatch' in control && control.swatch !== undefined)
  )
    return control;
  return {
    ...control,
    icon: control.kind === 'choice' ? 'sliders' : 'spark',
  } as T;
}

export function estimateShelfCells(input: {
  /** Active-first family tool control ids in shelf render order. */
  readonly toolIds: readonly string[];
  readonly toolWidths?: ReadonlyMap<string, number>;
  readonly activeToolId: string | null;
  readonly hasSettings: boolean;
  readonly quickCells: readonly ShelfQuickBudget[];
  readonly touch: boolean;
}): ShelfCapacityCell[] {
  const unit = 30;
  const cells: ShelfCapacityCell[] = [];
  input.toolIds.forEach((controlId, index) => {
    cells.push({
      id: `shelf:tool:${controlId}`,
      order: index,
      priority: controlId === input.activeToolId ? 100 : 90,
      // Compact button plus group gap share.
      width: input.toolWidths?.get(controlId) ?? 34,
      ...(controlId === input.activeToolId ? { required: true } : {}),
    });
  });
  if (input.hasSettings) {
    cells.push({
      id: 'shelf:settings',
      order: input.toolIds.length,
      priority: 95,
      width: unit,
      required: true,
    });
  }
  input.quickCells.forEach((quick, index) => {
    cells.push({
      id: quick.id,
      order: input.toolIds.length + (input.hasSettings ? 1 : 0) + index,
      priority: quick.priority,
      width: quick.width,
    });
  });
  return cells;
}

function ActiveToolMenu(props: {
  readonly label: string;
  readonly shelfId?: string;
  readonly menuRef?: React.Ref<HTMLDivElement>;
  readonly onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
  readonly dock?: 'top' | 'right' | 'bottom' | 'left';
  readonly onDockPointerDown?: (
    pointerId: number,
    x: number,
    y: number,
  ) => void;
  readonly onDockCycle?: () => void;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <div
      ref={props.menuRef}
      className={`${styles['fl-floating-island']} ${styles['fl-tool-shelf']}`}
      role="toolbar"
      aria-label={props.label}
      data-anchor="float.top-center"
      data-active-tool-menu=""
      data-tool-shelf={props.shelfId}
      onKeyDown={props.onKeyDown}
    >
      {props.onDockPointerDown !== undefined ? (
        <button
          type="button"
          className={styles['fl-tool-shelf-grip']}
          aria-label={`Move active tool menu, docked ${props.dock ?? 'top'}`}
          title="Drag to dock the active tool menu"
          onPointerDown={(event) =>
            props.onDockPointerDown?.(
              event.pointerId,
              event.clientX,
              event.clientY,
            )
          }
          onClick={(event) => {
            if (event.detail === 0) props.onDockCycle?.();
          }}
        >
          <span aria-hidden="true">⋮⋮</span>
        </button>
      ) : null}
      {props.children}
    </div>
  );
}

function WritingShelf(props: {
  readonly model: UnifiedToolbarLayout;
  readonly resetKey: string;
  readonly dock?: 'top' | 'right' | 'bottom' | 'left';
  readonly onDockPointerDown?: (
    pointerId: number,
    x: number,
    y: number,
  ) => void;
  readonly onDockCycle?: () => void;
}): React.ReactElement | null {
  const graph = props.model.compositionGraph;
  const contextualShelf = useContext(ContextualShelfContext);
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!contextualShelf?.open) return;
    const dismiss = (event: PointerEvent): void => {
      const menu = menuRef.current;
      if (menu === null || !(event.target instanceof Node)) return;
      const trigger = menu
        .closest('[data-pane]')
        ?.querySelector(
          '[data-toolbar="writing-direct"] [aria-label="Insert and more"]',
        );
      if (!menu.contains(event.target) && !trigger?.contains(event.target))
        contextualShelf.setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [contextualShelf?.open, contextualShelf?.setOpen]);
  if (graph === null) return null;
  const { overflow } = writingItems(graph);
  if (overflow.length === 0) return null;
  return (
    <ActiveToolMenu
      label="Insert and more"
      shelfId="writing.secondary"
      menuRef={menuRef}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        contextualShelf?.setOpen(false);
        menuRef.current
          ?.closest('[data-pane]')
          ?.querySelector<HTMLButtonElement>(
            '[data-toolbar="writing-direct"] [aria-label="Insert and more"]',
          )
          ?.focus();
      }}
      dock={props.dock}
      onDockPointerDown={props.onDockPointerDown}
      onDockCycle={props.onDockCycle}
    >
      {overflow.map((item) => (
        <Fragment key={item.id}>
          {renderControl(
            iconOnlyShelfControl(item.control),
            (id, value) => {
              const target =
                props.model.ownedById.get(id) ??
                props.model.ownedById.get(item.control.id);
              if (target !== undefined) props.model.executeOwned(target, value);
              contextualShelf?.setOpen(false);
            },
            props.resetKey,
          )}
        </Fragment>
      ))}
    </ActiveToolMenu>
  );
}

function TextColorSlots(props: {
  readonly control: Extract<DocumentToolControl, { kind: 'color' }>;
  readonly colors: readonly [string, string, string];
  readonly onSelect: (color: string) => void;
  readonly onEdit: (index: number, color: string) => void;
}): React.ReactElement {
  const pickerRefs = useRef<(HTMLInputElement | null)[]>([]);
  return (
    <div
      className={styles['fl-document-colors']}
      role="group"
      aria-label={props.control.label}
    >
      {props.colors.map((color, index) => {
        const active =
          props.control.value.toLowerCase() === color.toLowerCase();
        return (
          <span className={styles['fl-text-color-slot']} key={index}>
            <button
              type="button"
              className={styles['fl-document-color']}
              aria-label={`Text color ${index + 1}: ${color}`}
              aria-pressed={active}
              title={active ? 'Edit text color' : `Use ${color}`}
              style={{ backgroundColor: color }}
              onClick={() => {
                if (active) {
                  const picker = pickerRefs.current[index];
                  try {
                    picker?.showPicker();
                  } catch {
                    picker?.click();
                  }
                } else props.onSelect(color);
              }}
            />
            <input
              ref={(node) => {
                pickerRefs.current[index] = node;
              }}
              className={styles['fl-text-color-picker']}
              type="color"
              aria-label={`Edit text color ${index + 1}`}
              value={/^#[0-9a-f]{6}$/i.test(color) ? color : '#37352f'}
              onChange={(event) =>
                props.onEdit(index, event.currentTarget.value)
              }
              tabIndex={-1}
            />
          </span>
        );
      })}
    </div>
  );
}

function CompositionShelf(props: {
  readonly model: UnifiedToolbarLayout;
  readonly resetKey: string;
  readonly dock?: 'top' | 'right' | 'bottom' | 'left';
  readonly onDockPointerDown?: (
    pointerId: number,
    x: number,
    y: number,
  ) => void;
  readonly onDockCycle?: () => void;
  /**
   * Pane-aware compact decision owned by `FloatingToolbarLayer` (Repair
   * 10): the shelf island is intrinsic-size, so it cannot budget its own
   * compaction — the layer measures the pane once and passes the verdict
   * down instead of each shelf subscribing its own observer.
   */
  readonly compact: boolean;
  /**
   * Measured pane budget for the capacity path (layer-observed
   * `[data-pane]` width or explicit prop), at compact widths too (delta:
   * capacity partitions below 760; the 760 compact structure is untouched).
   * `undefined` means unmeasured first-paint: the shelf keeps the legacy
   * projection until layout reports, exactly like the topbar show-all
   * first paint.
   */
  readonly paneWidth?: number;
  /** Touch availability for capability-aware cell estimates. */
  readonly touch?: boolean;
  /**
   * Shelf slot value store. Optional: without it
   * the shelf owns a memory-only `ToolbarCustomizationStore` (factory
   * triples, session edits). Threaded from `UnifiedToolbarProps`
   * (`slotCustomization`) by `FloatingToolbarLayer`.
   */
  readonly slotStore?: ToolbarCustomizationStore;
}): React.ReactElement | null {
  const { model, resetKey, compact } = props;
  const touchAvailable = props.touch ?? coarsePointer();
  const [moreOpen, setMoreOpen] = useState(false);
  // Pane-global exclusive-open + resetKey-clear-all: the shelf
  // More joins the same pane scope as slot editors, category More, and
  // island overflows — opening the shelf More closes an open slot editor
  // and vice versa. Portaled menu, Esc/outside, and focus return unchanged.
  const moreDisclosure = useToolbarDisclosure({
    resetKey,
    open: moreOpen,
    setOpen: setMoreOpen,
  });
  const [slotEdit, setSlotEdit] = useState<{
    kind: 'size' | 'color';
    family: InkSlotFamily;
    index: number;
  } | null>(null);
  const setSlotEditOpen = useCallback((open: boolean): void => {
    if (!open) setSlotEdit(null);
  }, []);
  const slotEditDisclosure = useToolbarDisclosure({
    resetKey,
    open: slotEdit !== null,
    setOpen: setSlotEditOpen,
  });
  const moreTriggerRef = useRef<HTMLButtonElement | null>(null);
  const moreMenuRef = useRef<HTMLDivElement | null>(null);
  const category = model.compositionGraph?.categories.find(
    (candidate) => candidate.id === model.activeCategoryId,
  );
  // Hooks must run before the early return below (same count every render).
  const closeMore = useCallback(() => {
    setMoreOpen(false);
    moreDisclosure.release();
  }, [moreDisclosure]);
  useMenuDismissal({
    open: moreOpen,
    onClose: closeMore,
    triggerRef: moreTriggerRef,
    menuRef: moreMenuRef,
  });
  // Portaled like every other toolbar menu: the shelf island scrolls
  // internally on narrow panes, which would clip an inline absolute menu.
  const moreMenuPosition = useToolbarPopoverPosition({
    triggerRef: moreTriggerRef,
    popoverRef: moreMenuRef,
    enabled: moreOpen,
  });
  useFocusFirstOnOpen(moreOpen, moreMenuRef);
  // slot-shelf store wiring. The shelf subscribes
  // to the store (injected or memory-only fallback) and re-renders on every
  // live slot commit. Hooks stay above
  // the `category === undefined` early return (stable count every render).
  const slotStoreFallback = useMemo(() => new ToolbarCustomizationStore(), []);
  const slotStore = props.slotStore ?? slotStoreFallback;
  const [slotStoreRevision, bumpSlotStore] = useReducer(
    (count: number) => count + 1,
    0,
  );
  useEffect(() => {
    const subscription = slotStore.onChange(() => bumpSlotStore());
    return () => subscription.dispose();
  }, [slotStore]);
  // Active slot family (settled-first): pen tools share one
  // set, the highlighter owns its triple, anything else gets no slots.
  const slotFamily = slotFamilyForShelf(model);
  const slotSizeTriple = useMemo(
    () =>
      slotFamily === null ? null : slotStore.slotSizesForFamily(slotFamily),
    [slotStore, slotFamily, slotStoreRevision],
  );
  const slotColorTriple = useMemo(
    () =>
      slotFamily === null ? null : slotStore.slotColorsForFamily(slotFamily),
    [slotStore, slotFamily, slotStoreRevision],
  );
  // Stable verbatim order: the resolved composition
  // sequence is the sole ordering authority — NEVER active-first.
  // `verbatimShelfItemOrder` returns the items untouched; the active tool
  // is marked IN PLACE via `aria-pressed`/`data-contains-active-tool` by
  // the renderers below. Changing active/size/color/pen across 5+
  // switches leaves this sequence identical (order-equality pinned by
  // the new grouped spec).
  const verbatimItems = useMemo(() => {
    if (category === undefined) return [];
    return verbatimShelfItemOrder(category.items);
  }, [category]);
  // The shelf skips controls already claimed by a floating island across
  // all families. Notebook management stays in the shelf and does not
  // overlap with an island. This extends the placement resolver's
  // claimed-set pattern across layers: the
  // geometric island keeps the control (bottom-center is the primary nav
  // surface), the shelf keeps verbatim order for the remainder. Keys on
  // the executable owner `control.id` only — never scope `slotKey`,
  // labels, icons, or id substrings. Sole exemption: the Text creation
  // role (`surface.insert.text`) stays in the composition shelf and is
  // never skipped or reported (see `computeUnifiedToolbarModel`).
  const geometricClaimedIds = useMemo(() => {
    const claimed = new Set<string>();
    for (const group of model.groups) {
      // Topbar-center legacy placements never render alongside the
      // composition strip, so they never hide shelf tools cross-layer.
      // Only floating islands compete with the shelf.
      if (group.anchor === 'topbar-center') continue;
      if (
        group.anchor === 'float.selection' &&
        model.snapshot?.contextualAnchor === undefined
      ) {
        continue;
      }
      for (const owned of group.controls) claimed.add(owned.control.id);
    }
    return claimed;
  }, [model.groups]);
  const shelfCandidates = useMemo(
    () =>
      verbatimItems.filter((item) => {
        // Text is already selected in the primary strip. Its shelf contains
        // properties, not a second activation of the same tool.
        if (
          category?.id === SURFACE_TEXT_CATEGORY_ID &&
          item.control.semanticRole === SURFACE_TEXT_CREATION_ROLE
        )
          return false;
        if (!geometricClaimedIds.has(item.control.id)) return true;
        return item.control.semanticRole === SURFACE_TEXT_CREATION_ROLE;
      }),
    [verbatimItems, geometricClaimedIds, category?.id],
  );
  // With a measured pane budget, compact and medium widths partition the
  // shelf by
  // estimated capacity (verbatim tools, required settings, priority
  // quicks) through the shared planner instead of hiding the excess in
  // invisible scroll. Unmeasured hosts (null model below) show the full
  // verbatim shelf on first paint. Keep the 760px compact structure
  // (icon-only strip, data-compact) — capacity
  // only partitions shelf cells within it. The budget is
  // parent-determined (explicit prop or layer-observed pane width), so
  // partitioning can never feed back into its own width.
  const capacityModel = useMemo(() => {
    if (category === undefined) return null;
    const paneWidth = props.paneWidth;
    if (paneWidth === undefined || !(paneWidth > 0)) return null;
    // Quick counts derive from the active tool's scoped settings, never the browsed
    // category), and the Select interaction mode (`surface.select`,
    // notebook pdfBacked source-select) contributes zero quicks —
    // mirroring the post-return `shelfSettingsControls` derivation below.
    const browsedActive =
      model.activeCategoryId !== null &&
      model.activeCategoryId === model.activeToolCategoryId;
    const shelfSettings = shelfSettingsForCategory({
      browsedIsActive: browsedActive,
      activeSemanticRole: resolveActiveToolSemanticRole(model.compositionGraph),
      settingsControls: model.settingsControls,
    });
    const prospective = selectShelfQuicks(
      category.id === SURFACE_TEXT_CATEGORY_ID ? [] : shelfSettings,
    );
    // Verbatim tool ids in composition order — priority-only
    // survival via the planner below, never active-first reordering.
    // cross-layer-skipped controls never consume budget and never
    // overflow — they live in the geometric island. Estimator budgets
    // (`estimateShelfCells`/`estimateShelfQuickBudgets`) are unchanged;
    // only the tool-id input is the deduped verbatim sequence.
    const verbatimIds = shelfCandidates.map((item) => item.control.id);
    // Canonical mode order (eraser-mode, eraser-size, lasso-mode) skipping
    // absent cells — the post-return render maps `shelf:mode:{i}` in this
    // same order, so ids align by construction.
    const modeOptionCounts: number[] = [];
    if (prospective.eraserModeControl !== null)
      modeOptionCounts.push(prospective.eraserModeControl.options.length);
    if (prospective.eraserRadiusControl !== null) modeOptionCounts.push(1);
    if (prospective.lassoModeControl !== null)
      modeOptionCounts.push(prospective.lassoModeControl.options.length);
    const cells = estimateShelfCells({
      toolIds: verbatimIds,
      toolWidths: new Map(
        shelfCandidates.map(({ control }) => [
          control.id,
          shelfControlWidth(control, touchAvailable),
        ]),
      ),
      activeToolId: model.activeToolControlId,
      hasSettings: false,
      quickCells: estimateShelfQuickBudgets({
        favoriteCount: prospective.favorites.length,
        widthOptionCount: prospective.sizeControl?.options.length ?? 0,
        colorDotCount: Math.min(
          prospective.colorControl?.options.length ?? 0,
          6,
        ),
        modeOptionCounts,
        touch: touchAvailable,
      }),
      touch: touchAvailable,
    });
    return {
      cells,
      budget: shelfCapacityBudget(paneWidth, touchAvailable),
      verbatimIds,
    };
  }, [category, shelfCandidates, props.paneWidth, model, touchAvailable]);
  // The trigger reserve matches the compact More button. Hysteresis settles
  // threshold dither — the same
  // planner contract as the geometric islands. Sticky overflow membership
  // mirrors `useCompactedGroups` (equality-guarded, converges).
  const [capacityStickyIds, setCapacityStickyIds] =
    useState<ReadonlySet<string>>(EMPTY_SET);
  const capacityPartition = useMemo(() => {
    if (capacityModel === null) return null;
    // Shared planner via the wrapper (never reimplemented here):
    // trigger reserve, priority survival, hysteresis with sticky ids.
    return partitionGroupedShelf(capacityModel.cells, capacityModel.budget, {
      overflowWidth: 30,
      overflowGap: 4,
      hysteresis: 8,
      overflowIds: capacityStickyIds,
    });
  }, [capacityModel, touchAvailable, capacityStickyIds]);
  useEffect(() => {
    if (capacityModel === null || capacityPartition === null) {
      setCapacityStickyIds((prev) => (prev.size === 0 ? prev : EMPTY_SET));
      return;
    }
    setCapacityStickyIds((prev) => {
      const next = new Set(capacityPartition.overflow);
      if (next.size === prev.size && [...next].every((id) => prev.has(id)))
        return prev;
      return next;
    });
  }, [capacityPartition, capacityModel]);
  const capacityVisibleIds =
    capacityPartition === null ? null : new Set(capacityPartition.visible);
  // A top-bar category menu owns the pane's shared disclosure while it is
  // open. Keep the contextual shelf out of that same pane until the claim
  // is released, rather than leaving a second interactive toolbar beneath
  // the menu. Other panes retain their independent disclosure scopes.
  if (category === undefined || moreDisclosure.hasTopbarCategoryClaim)
    return null;
  // Verbatim projections: unmeasured hosts show the full verbatim shelf
  // (show-all first paint); any measured pane — compact or not —
  // re-partitions through the capacity branch below (priority-only
  // survival, order preserved verbatim). The legacy compact `slice(0, 4)`
  // is deleted: active is marked in place, never moved.
  // the cross-layer-skipped sequence (`shelfCandidates`) is the
  // verbatim projection input — geometrically claimed controls never
  // appear inline nor in More; they render once in their island.
  let visibleItems = shelfCandidates;
  let overflowItems: typeof shelfCandidates = [];
  if (capacityModel !== null && capacityVisibleIds !== null) {
    const visibleIds = capacityVisibleIds;
    const byControlId = new Map(
      shelfCandidates.map((item) => [item.control.id, item] as const),
    );
    // Verbatim order preserved: walk the verbatim ids, keep the
    // planner's survivors inline and overflow the rest explicitly.
    const capacityOrdered: Array<(typeof shelfCandidates)[number]> = [];
    for (const id of capacityModel.verbatimIds) {
      const found = byControlId.get(id);
      if (found !== undefined) capacityOrdered.push(found);
    }
    visibleItems = capacityOrdered.filter((item) =>
      visibleIds.has(`shelf:tool:${item.control.id}`),
    );
    overflowItems = capacityOrdered.filter(
      (item) => !visibleIds.has(`shelf:tool:${item.control.id}`),
    );
  }
  // The shelf browses `model.activeCategoryId`
  // (manual selection wins while live, else the active-tool category), but
  // quicks/settings always derive from the ACTIVE tool's scoped
  // `settingsControls` — never from the browsed category. When the browsed
  // category is not the active-tool category, show tools only and hide
  // quicks/settings so Pen quicks never leak into a browsed Shapes shelf
  // and no misleading "Shapes settings" backed by Pen is synthesized.
  // Select interaction mode exposes only Lasso mode/filter settings;
  // pen quicks never render in its shelf. Draw keeps showing Select
  // and provider values stay pen (documented divergence); only the shelf
  // is suppressed. The strip keeps the quiet `data-contains-active-tool`
  // marker on the real active category while another is browsed (no
  // single-id merge).
  const browsedIsActiveCategory =
    model.activeCategoryId !== null &&
    model.activeCategoryId === model.activeToolCategoryId;
  const toolSettingsControls = shelfSettingsForCategory({
    browsedIsActive: browsedIsActiveCategory,
    activeSemanticRole: resolveActiveToolSemanticRole(model.compositionGraph),
    settingsControls: model.settingsControls,
  });
  const textSettings =
    category.id === SURFACE_TEXT_CATEGORY_ID && browsedIsActiveCategory
      ? [...model.ownedById.values()].filter((owned) =>
          owned.control.semanticRole?.startsWith('surface.text.'),
        )
      : [];
  const shelfSettingsControls = [...toolSettingsControls, ...textSettings];
  const settingsSource = settingsSourceFor(
    shelfSettingsControls,
    model.executeOwned,
  );
  // Text properties render as direct controls below, including its dedicated
  // three color slots. Do not project the generic five-swatch quick palette
  // from the same semantic color control a second time.
  const quicks = selectShelfQuicks(
    category.id === SURFACE_TEXT_CATEGORY_ID
      ? toolSettingsControls
      : shelfSettingsControls,
  );
  const runSetting = (id: string, value?: string): void => {
    settingsSource.execute(id, value);
  };
  // Fixed pen slots gate on the category holding pen conduits.
  // `toolRole` detection is unchanged: exactly the
  // `toolRole: 'pen'` conduits slot. Highlighter is in its own category and
  // uses the independent highlighter value family. Family MEMBERSHIP admits
  // two coincident signals: provider
  // metadata (`toolRole: 'pen'`) and composition metadata (a declared
  // `slotId`; a blank value stays absent. Effective keys still always route
  // through `slotIdForItem`. The fixed-slot renderer
  // additionally requires conduit identity (`hasPenConduits`) to
  // partition slotted vs unslotted siblings, so providers whose controls
  // predate `toolRole` keep the legacy verbatim buttons (no slots, no
  // loss) instead of guessing identity from id substrings.
  const isPenConduitItem = (item: (typeof category.items)[number]): boolean =>
    item.control.kind === 'button' && item.control.toolRole === 'pen';
  const hasPenConduits = category.items.some(isPenConduitItem);
  const renderShelfItem = (
    item: (typeof category.items)[number],
    onNavigate?: () => void,
  ): React.ReactNode => {
    const owned = model.ownedById.get(item.control.id);
    if (owned === undefined) return null;
    return (
      <div className={styles['fl-document-tool-group']} key={item.id}>
        {renderControl(
          iconOnlyShelfControl(item.control),
          (id, value) => {
            const target = model.ownedById.get(id);
            if (target !== undefined) model.executeOwned(target, value);
            onNavigate?.();
          },
          resetKey,
          settingsSource,
        )}
      </div>
    );
  };
  // Render fixed pen slots and partition overflow through the shelf.
  //
  // Presence-gated: wherever a category holds `toolRole: 'pen'`
  // conduits they render through `ShelfSlotShelf` at exactly
  // `SHELF_PEN_SLOT_COUNT` fixed positions — verbatim composition order,
  // active marked in place, empty positions padded with fixed-width
  // placeholders that never collapse. Highlighter has its own category and
  // renders there as a direct tool. Size (`surface.write.width` +
  // `surface.erase.size`, one null pad) and color (`surface.write.color`,
  // two null pads) families ride the `resolve*SlotPositions`
  // contracts upstream with the same null-pad semantics; the shelf
  // quicks here preserve their bounded inline + More presentation, so no
  // sibling shifts when a slot assigns.
  //
  // Capacity interplay: entries are pre-filtered by the capacity-visible
  // set (priority-only survival), so at 500/390 touch the overflowed pens
  // sit in the single shelf More menu in verbatim order while their fixed
  // positions show placeholders — never silently lost, never
  // reordered. Id domains: the executable command
  // owner is always `control.id` (first-tap and every settings-row route
  // by control id through the caller-bound owner channel); the stable
  // presentation/scope key is `slotIdForItem(entry)` (React keys,
  // `settingsForSlot` scoping, `data-slot-editor` markers).
  // Second activation: button entries reuse
  // `SurfaceToolButton` verbatim — first tap executes, second tap on the
  // active slot toggles its slot-scoped editor without re-executing
  // (Esc at both levels, outside dismissal, focus return, `resetKey`
  // pane:document remount, shelf-exclusive via `claimedOpenKey`).
  // `isActiveContext === false` (browsed != active) keeps slot
  // buttons executing but never opens editors.
  const penEntries: readonly ShelfSlotEntry[] = hasPenConduits
    ? visibleItems.filter(isPenConduitItem).map((item) => ({
        id: item.id,
        ...(item.slotId !== undefined ? { slotId: item.slotId } : {}),
        control: item.control,
      }))
    : [];
  const visibleNonPenItems = hasPenConduits
    ? visibleItems.filter((item) => !isPenConduitItem(item))
    : visibleItems;
  const executePenSlot = (id: string, value?: string): void => {
    const target = model.ownedById.get(id);
    if (target !== undefined) model.executeOwned(target, value);
  };
  const settingsForPenSlot = (): SurfaceToolSettingsSource => settingsSource;
  const renderPenFixedOverflow = (
    overflow: readonly ShelfSlotEntry[],
  ): React.ReactNode => {
    if (overflow.length === 0) return null;
    // Surplus fixed positions (no 5-pen family resolves today; defensive):
    // verbatim order, pressed from the single active truth
    // (`isShelfSlotActive`), stable keys via `slotIdForItem`, executed by
    // `control.id` through the owner channel, dismissed via the shelf
    // More lifecycle (`closeMore`). The container already carries
    // `data-overflow-count` + `data-active-overflow`.
    const overflowActive = activeOverflowSlots(overflow);
    void overflowActive;
    return (
      <>
        {overflow.map((entry) => {
          const owned = model.ownedById.get(entry.control.id);
          if (owned === undefined) return null;
          return (
            <div
              key={slotIdForItem(entry)}
              data-fixed-overflow="true"
              data-pressed={isShelfSlotActive(entry) ? 'true' : undefined}
            >
              {renderControl(
                entry.control,
                (id, value) => {
                  const target = model.ownedById.get(id);
                  if (target !== undefined)
                    model.executeOwned(target, value ?? entry.value);
                  closeMore();
                },
                resetKey,
                settingsSource,
              )}
            </div>
          );
        })}
      </>
    );
  };
  // The Text tool is in the primary strip; the shelf projects its owned
  // properties directly. The active text selection or pending style remains
  // the provider's single source of truth.
  const isTextShelf = category.id === SURFACE_TEXT_CATEGORY_ID;
  const textSettingCells = isTextShelf
    ? textSettings.map(({ control }) => (
        <div className={styles['fl-document-tool-group']} key={control.id}>
          {control.kind === 'color' ? (
            <TextColorSlots
              control={control}
              colors={slotStore.slotColorsForText()}
              onSelect={(color) => runSetting(control.id, color)}
              onEdit={(index, color) => {
                slotStore.setTextSlotColorAt(index, color);
                runSetting(control.id, color);
              }}
            />
          ) : (
            renderControl(control, runSetting, resetKey)
          )}
        </div>
      ))
    : [];
  // size/color slot shelves: when the settled
  // active tool is a pen-family tool or the highlighter, the bounded quick
  // widths/colors render as fixed `ShelfSlotShelf` rows driven by the store
  // triple for the active family — pen tools share one set; a
  // pen-family switch keeps the same sizes and colors. The highlighter
  // resolves its own triple (8/14/20 with the #ffd54f-led swatches at
  // marker translucency) instead of the raw provider options.
  // Tapping an inactive slot selects it; tapping the active slot opens
  // its live value editor, committing only that slot. The rows keep the
  // legacy `Quick widths`/`Quick colors` group labels, canonical order,
  // and capacity ids (`shelf:widths`/`shelf:colors`), so budgeting,
  // fixtures, and overflow behavior are unchanged. Size and color quick
  // controls are gated on the active category; when another category is
  // browsed, show tools only.
  // An active tool with size/color settings but no slot family keeps the
  // legacy provider-options quicks (never a silent loss).
  const sizeControl = quicks.sizeControl;
  const colorControl = quicks.colorControl;
  const sizeSlotEntries: readonly ShelfSlotEntry[] | null =
    slotFamily !== null &&
    slotSizeTriple !== null &&
    sizeControl !== null &&
    browsedIsActiveCategory
      ? slotSizeTriple.map((size, index) => ({
          id: `shelf:slot:size:${index}`,
          slotId: `shelf.slot.size.${index + 1}`,
          control: sizeControl,
          value: String(size),
          active: Number(sizeControl.value) === size,
        }))
      : null;
  const openQuickSlotEdit = (
    kind: 'size' | 'color',
    family: InkSlotFamily,
    index: number,
  ): void => {
    closeMore();
    slotEditDisclosure.claimOpen();
    setSlotEdit({ kind, family, index });
  };
  const closeQuickSlotEdit = (): void => {
    setSlotEdit(null);
    slotEditDisclosure.release();
    moreTriggerRef.current?.focus();
  };
  const renderSizeQuick = (menu: boolean): React.ReactNode => {
    const execute =
      menu === true
        ? (id: string, value?: string): void => {
            runSetting(id, value);
            closeMore();
          }
        : runSetting;
    if (sizeSlotEntries !== null && slotFamily !== null) {
      const family = slotFamily;
      return (
        <Fragment key="__widths">
          <SurfaceSizeSlots
            control={sizeControl!}
            family={family}
            store={slotStore}
            group={category}
            execute={execute}
            resetKey={resetKey}
            editable={!menu}
          />
          {menu ? (
            <ShelfQuickGroup label="Edit quick widths">
              {slotSizeTriple?.map((value, index) => (
                <button
                  key={index}
                  type="button"
                  className={styles['fl-document-tool']}
                  aria-label={`Edit quick width ${index + 1}`}
                  title={String(value)}
                  onClick={() => openQuickSlotEdit('size', family, index)}
                >{`Edit ${value} pt`}</button>
              ))}
            </ShelfQuickGroup>
          ) : null}
        </Fragment>
      );
    }
    if (sizeControl !== null) {
      return menu === true ? (
        <ShelfQuickWidths
          key="__widths"
          control={sizeControl}
          execute={execute}
          onNavigate={closeMore}
        />
      ) : (
        <ShelfQuickWidths
          key="__widths"
          control={sizeControl}
          execute={execute}
        />
      );
    }
    return null;
  };
  const renderColorQuick = (menu: boolean): React.ReactNode => {
    const execute =
      menu === true
        ? (id: string, value?: string): void => {
            runSetting(id, value);
            closeMore();
          }
        : runSetting;
    if (
      slotFamily !== null &&
      colorControl !== null &&
      browsedIsActiveCategory
    ) {
      const family = slotFamily;
      return (
        <Fragment key="__colors">
          <SurfaceColorSlots
            control={colorControl}
            family={family}
            store={slotStore}
            group={category}
            execute={execute}
            editable={!menu}
            resetKey={resetKey}
          />
          {menu ? (
            <ShelfQuickGroup label="Edit quick colors">
              {slotColorTriple?.map((value, index) => (
                <button
                  key={index}
                  type="button"
                  className={styles['fl-document-tool']}
                  aria-label={`Edit quick color ${index + 1}`}
                  title={String(value)}
                  onClick={() => openQuickSlotEdit('color', family, index)}
                >{`Edit color ${index + 1}`}</button>
              ))}
            </ShelfQuickGroup>
          ) : null}
        </Fragment>
      );
    }
    if (colorControl !== null) {
      return menu === true ? (
        <ShelfQuickColors
          key="__colors"
          control={colorControl}
          execute={execute}
          onNavigate={closeMore}
        />
      ) : (
        <ShelfQuickColors
          key="__colors"
          control={colorControl}
          execute={execute}
        />
      );
    }
    return null;
  };
  const favoritesCell =
    quicks.savedControl !== null && quicks.favorites.length > 0 ? (
      <ShelfFavoriteStyles
        key="__favorites"
        quicks={quicks}
        execute={runSetting}
      />
    ) : null;
  const widthsCell = renderSizeQuick(false);
  const colorsCell = renderColorQuick(false);
  const eraserModeCell =
    quicks.eraserModeControl !== null ? (
      <ShelfQuickChoice
        key="__eraser-mode"
        label="Eraser mode"
        control={quicks.eraserModeControl}
        execute={runSetting}
      />
    ) : null;
  const eraserSizeControl = quicks.eraserRadiusControl;
  const eraserSizeCell =
    eraserSizeControl !== null ? (
      <ShelfEraserSize
        key="__eraser-size"
        control={eraserSizeControl}
        sizes={slotStore.slotSizesForEraser()}
        execute={runSetting}
        onEdit={(index, value) => {
          if (slotStore.setEraserSlotSizeAt(index, value))
            runSetting(eraserSizeControl.id, String(value));
        }}
      />
    ) : null;
  const lassoModeCell =
    quicks.lassoModeControl !== null ? (
      <ShelfQuickChoice
        key="__lasso-mode"
        label="Lasso mode"
        control={quicks.lassoModeControl}
        execute={runSetting}
      />
    ) : null;
  // Wide: every quick cell inline (bounded by construction). Compact:
  // favorites stay inline; widths/colors/modes overflow. The selected
  // tool opens its own settings, so no permanent disclosure cell is needed.
  // The capacity path partitions these same cells by measured budget —
  // mode ids follow the canonical non-null order used by the estimator
  // (`shelf:mode:{i}`), so plan/render ids align by construction. The
  // compact/wide splits below survive only for unmeasured hosts.
  const modeCellNodes: React.ReactNode[] = [];
  if (eraserModeCell !== null) modeCellNodes.push(eraserModeCell);
  if (eraserSizeCell !== null) modeCellNodes.push(eraserSizeCell);
  if (lassoModeCell !== null) modeCellNodes.push(lassoModeCell);
  const quickCellEntries: readonly {
    readonly id: string;
    readonly node: React.ReactNode;
  }[] = [
    { id: 'shelf:favorites', node: favoritesCell },
    { id: 'shelf:widths', node: widthsCell },
    { id: 'shelf:colors', node: colorsCell },
    ...modeCellNodes.map((node, index) => ({
      id: `shelf:mode:${index}`,
      node,
    })),
  ];
  let inlineQuicks: readonly React.ReactNode[] = compact
    ? [favoritesCell]
    : [
        favoritesCell,
        widthsCell,
        colorsCell,
        eraserModeCell,
        eraserSizeCell,
        lassoModeCell,
      ];
  let overflowQuicks: readonly React.ReactNode[] = compact
    ? [widthsCell, colorsCell, eraserModeCell, eraserSizeCell, lassoModeCell]
    : [];
  if (capacityVisibleIds !== null) {
    const visibleIds = capacityVisibleIds;
    inlineQuicks = quickCellEntries
      .filter((entry) => entry.node !== null && visibleIds.has(entry.id))
      .map((entry) => entry.node);
    overflowQuicks = quickCellEntries
      .filter((entry) => entry.node !== null && !visibleIds.has(entry.id))
      .map((entry) => entry.node);
  }
  const hasOverflow =
    overflowItems.length > 0 || overflowQuicks.some((cell) => cell !== null);
  // Menu nodes include only cells the budget overflowed (the
  // legacy menu below re-renders every non-favorite quick, which would
  // duplicate inline cells when only some overflow). Mode ids walk the same
  // canonical non-null order as the estimator, so they align.
  const capacityMenuModes: React.ReactNode[] = [];
  if (capacityVisibleIds !== null) {
    const visibleIds = capacityVisibleIds;
    let modeIndex = 0;
    if (quicks.eraserModeControl !== null) {
      const id = `shelf:mode:${modeIndex++}`;
      const control = quicks.eraserModeControl;
      if (!visibleIds.has(id))
        capacityMenuModes.push(
          <ShelfQuickChoice
            key="__eraser-mode"
            label="Eraser mode"
            control={control}
            execute={runSetting}
            onNavigate={closeMore}
          />,
        );
    }
    if (quicks.eraserRadiusControl !== null) {
      const id = `shelf:mode:${modeIndex++}`;
      const control = quicks.eraserRadiusControl;
      if (!visibleIds.has(id))
        capacityMenuModes.push(
          <ShelfEraserSize
            key="__eraser-size"
            control={control}
            sizes={slotStore.slotSizesForEraser()}
            execute={runSetting}
            onEdit={(index, value) => {
              if (slotStore.setEraserSlotSizeAt(index, value))
                runSetting(control.id, String(value));
            }}
            onNavigate={closeMore}
          />,
        );
    }
    if (quicks.lassoModeControl !== null) {
      const id = `shelf:mode:${modeIndex++}`;
      const control = quicks.lassoModeControl;
      if (!visibleIds.has(id))
        capacityMenuModes.push(
          <ShelfQuickChoice
            key="__lasso-mode"
            label="Lasso mode"
            control={control}
            execute={runSetting}
            onNavigate={closeMore}
          />,
        );
    }
  }
  const capacityOverflowed = (id: string): boolean =>
    capacityVisibleIds !== null && !capacityVisibleIds.has(id);
  // a fully cross-layer-skipped shelf (PDF Pages nav) renders
  // nothing — never an empty toolbar island. The strip group
  // stays intact (normal projection untouched, no item drop)
  // and the geometric island keeps the controls; Select/Annotate shelves
  // stay reachable via the strip.
  // Quicks/settings already hide when browsed≠active, so
  // this only hides truly empty shelves.
  const hasShelfContent =
    penEntries.length > 0 ||
    visibleNonPenItems.length > 0 ||
    overflowItems.length > 0 ||
    textSettingCells.length > 0 ||
    favoritesCell !== null ||
    widthsCell !== null ||
    colorsCell !== null ||
    eraserModeCell !== null ||
    eraserSizeCell !== null ||
    lassoModeCell !== null;
  if (!hasShelfContent) return null;
  return (
    <ActiveToolMenu
      label={`${category.label} tools`}
      shelfId={category.id}
      dock={props.dock}
      onDockPointerDown={props.onDockPointerDown}
      onDockCycle={props.onDockCycle}
    >
      {penEntries.length > 0 ? (
        <ShelfSlotShelf
          kind="pen"
          label="Pen slots"
          group={category}
          entries={penEntries}
          count={SHELF_PEN_SLOT_COUNT}
          execute={executePenSlot}
          settingsForSlot={settingsForPenSlot}
          resetKey={resetKey}
          renderOverflow={renderPenFixedOverflow}
          isActiveContext={browsedIsActiveCategory}
        />
      ) : null}
      {visibleNonPenItems.map((item) => renderShelfItem(item))}
      {textSettingCells}
      {inlineQuicks}
      {toolSettingsControls
        .filter(
          ({ control }) =>
            control.semanticRole === 'surface.shape.radius' ||
            control.semanticRole === 'surface.shape.appearance' ||
            control.semanticRole === 'surface.shape.arrows',
        )
        .map(({ control }) => (
          <Fragment key={control.id}>
            {renderControl(control, runSetting, resetKey)}
          </Fragment>
        ))}
      {hasOverflow ? (
        <div className={styles['fl-toolbar-overflow-wrap']}>
          <button
            type="button"
            className={styles['fl-document-tool']}
            aria-label="More tools"
            aria-expanded={moreOpen}
            ref={moreTriggerRef}
            onClick={() => {
              const next = !moreOpen;
              if (next) moreDisclosure.claimOpen();
              else moreDisclosure.release();
              setMoreOpen(next);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && moreOpen) {
                event.preventDefault();
                closeMore();
                moreTriggerRef.current?.focus();
              } else if (
                (event.key === 'ArrowDown' || event.key === 'Enter') &&
                !moreOpen
              ) {
                event.preventDefault();
                moreDisclosure.claimOpen();
                setMoreOpen(true);
              }
            }}
          >
            <Icon name="more" size={18} />
          </button>
          {moreOpen ? (
            <ToolbarPopoverPortal>
              <div
                className={styles['fl-toolbar-inline-menu']}
                role="group"
                aria-label="More tools"
                ref={moreMenuRef}
                data-popover-placement={moreMenuPosition?.placement ?? 'below'}
                style={
                  moreMenuPosition !== null
                    ? {
                        position: 'fixed',
                        left: moreMenuPosition.left,
                        top: moreMenuPosition.top,
                        maxWidth: moreMenuPosition.maxWidth,
                        maxHeight: moreMenuPosition.maxHeight,
                        overflow: 'auto',
                        right: 'auto',
                        transform: 'none',
                      }
                    : { position: 'fixed' }
                }
                onKeyDown={(event) => {
                  // Menu-level Escape (keyboard users tabbed into the menu):
                  // close and return focus to the trigger.
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    closeMore();
                    moreTriggerRef.current?.focus();
                    return;
                  }
                  if (handleMenuListKeyDown(event, moreMenuRef.current))
                    event.preventDefault();
                }}
              >
                {overflowItems.map((item) => {
                  const owned = model.ownedById.get(item.control.id);
                  if (owned === undefined) return null;
                  return (
                    <div key={item.id}>
                      {renderControl(
                        item.control,
                        (id, value) => {
                          const target = model.ownedById.get(id);
                          if (target !== undefined)
                            model.executeOwned(target, value);
                          // Configuration stays open for successive edits and
                          // continuous controls. Only discrete actions dismiss.
                          if (item.control.kind === 'button') closeMore();
                        },
                        resetKey,
                        settingsSource,
                      )}
                    </div>
                  );
                })}
                {overflowQuicks.some((cell) => cell !== null) ? (
                  <div
                    className={styles['fl-document-tool-group']}
                    key="__overflow-quicks"
                  >
                    {capacityVisibleIds === null ? (
                      <>
                        {renderSizeQuick(true)}
                        {renderColorQuick(true)}
                        {quicks.eraserModeControl !== null ? (
                          <ShelfQuickChoice
                            label="Eraser mode"
                            control={quicks.eraserModeControl}
                            execute={runSetting}
                            onNavigate={closeMore}
                          />
                        ) : null}
                        {quicks.eraserRadiusControl !== null ? (
                          <ShelfEraserSize
                            control={quicks.eraserRadiusControl}
                            sizes={slotStore.slotSizesForEraser()}
                            execute={runSetting}
                            onEdit={(index, value) => {
                              const control = quicks.eraserRadiusControl;
                              if (
                                control !== null &&
                                slotStore.setEraserSlotSizeAt(index, value)
                              )
                                runSetting(control.id, String(value));
                            }}
                            onNavigate={closeMore}
                          />
                        ) : null}
                        {quicks.lassoModeControl !== null ? (
                          <ShelfQuickChoice
                            label="Lasso mode"
                            control={quicks.lassoModeControl}
                            execute={runSetting}
                            onNavigate={closeMore}
                          />
                        ) : null}
                      </>
                    ) : (
                      <>
                        {capacityOverflowed('shelf:favorites') &&
                        quicks.savedControl !== null &&
                        quicks.favorites.length > 0 ? (
                          <ShelfFavoriteStyles
                            quicks={quicks}
                            execute={runSetting}
                            onNavigate={closeMore}
                          />
                        ) : null}
                        {capacityOverflowed('shelf:widths')
                          ? renderSizeQuick(true)
                          : null}
                        {capacityOverflowed('shelf:colors')
                          ? renderColorQuick(true)
                          : null}
                        {capacityMenuModes}
                      </>
                    )}
                  </div>
                ) : null}
              </div>
            </ToolbarPopoverPortal>
          ) : null}
        </div>
      ) : null}
      {slotEdit !== null ? (
        <ShelfSlotEditPopover
          kind={slotEdit.kind}
          family={slotEdit.family}
          index={slotEdit.index}
          sizeValue={
            slotStore.slotSizesForFamily(slotEdit.family)[slotEdit.index]!
          }
          colorValue={
            slotStore.slotColorsForFamily(slotEdit.family)[slotEdit.index]!
          }
          anchorRef={moreTriggerRef}
          onClose={closeQuickSlotEdit}
          onCommit={(commit) => {
            if (commit.kind === 'size' && commit.sizeValue !== undefined)
              slotStore.setSlotSizeAt(
                slotEdit.family,
                slotEdit.index,
                commit.sizeValue,
              );
            if (commit.kind === 'color' && commit.colorValue !== undefined)
              slotStore.setSlotColorAt(
                slotEdit.family,
                slotEdit.index,
                commit.colorValue,
              );
          }}
        />
      ) : null}
    </ActiveToolMenu>
  );
}

/** One floating island with its own measured compaction budget. */
function FloatingIsland(props: {
  readonly anchor: Exclude<ToolbarAnchor, 'topbar-center'>;
  readonly groups: readonly ResolvedToolbarGroup[];
  readonly executeOwned: UnifiedToolbarLayout['executeOwned'];
  readonly resetKey: string;
  readonly settings?: readonly OwnedToolbarControl[];
  readonly availableWidth?: number;
  readonly measuredWidths?:
    | ReadonlyMap<string, number>
    | Record<string, number>;
}): React.ReactElement | null {
  const { anchor, groups, executeOwned, resetKey, settings } = props;
  const anchorGroups = useMemo(
    () => groups.filter((group) => group.anchor === anchor),
    [groups, anchor],
  );
  // Floating islands never auto-measure: an island is intrinsic-size, so its
  // own width cannot budget its own compaction — measuring it fed the
  // visible/overflow decision back into the measured width and flipped the
  // island between full controls and the overflow trigger every frame. The
  // island keeps its CSS internal scroll (single row, never overlapping),
  // which is stable by construction. Priority overflow stays available to
  // tests and callers through the explicit width props; the in-flow topbar
  // keeps auto-measurement because its flex:1 budget is stable.
  const { visible, overflow } = useCompactedGroups(
    anchorGroups,
    props.availableWidth,
    props.measuredWidths,
  );
  const measured = props.availableWidth !== undefined;
  const visibleGroups = measured ? visible : anchorGroups;
  const overflowGroups = measured ? overflow : [];
  if (anchorGroups.length === 0) return null;
  return (
    <div
      className={styles['fl-floating-island']}
      data-anchor={anchor}
      role="toolbar"
      aria-label={FLOATING_LABELS[anchor]}
    >
      {visibleGroups.map((group) =>
        renderPlacementGroup(group, executeOwned, resetKey, settings),
      )}
      {overflowGroups.length > 0 ? (
        <OverflowMenu
          groups={overflowGroups}
          executeOwned={executeOwned}
          resetKey={resetKey}
          label={`More ${FLOATING_LABELS[anchor].toLowerCase()}`}
          settings={settings}
        />
      ) : null}
    </div>
  );
}

/** One width-slot editor for drawing tools and selected objects. */
function SurfaceSizeSlots(props: {
  readonly control: Extract<DocumentToolControl, { kind: 'choice' }>;
  readonly family: InkSlotFamily;
  readonly store: ToolbarCustomizationStore;
  readonly execute: (id: string, value?: string) => void;
  readonly group: { readonly id: string; readonly groupId?: string };
  readonly resetKey: string;
  readonly editable?: boolean;
}): React.ReactElement {
  const { control, family, store, execute } = props;
  const [, refresh] = useReducer((revision) => revision + 1, 0);
  useEffect(() => {
    const subscription = store.onChange(refresh);
    return () => subscription.dispose();
  }, [store]);
  const sizes = store.slotSizesForFamily(family);
  return (
    <ShelfSlotShelf
      kind="size"
      family={family}
      label="Quick widths"
      group={props.group}
      entries={sizes.map((size, index) => ({
        id: `shelf:slot:size:${index}`,
        slotId: `shelf.slot.size.${index + 1}`,
        control,
        value: String(size),
        active: Number(control.value) === size,
      }))}
      execute={execute}
      settingsForSlot={() => ({
        controls: props.editable === false ? [] : [control],
        execute,
      })}
      slotSizes={sizes}
      resetKey={props.resetKey}
      isActiveContext
      {...(props.editable === false
        ? {}
        : {
            onEditSlotSize: (index: number, value: number) => {
              store.setSlotSizeAt(family, index, value);
              execute(control.id, String(value));
            },
          })}
    />
  );
}

/** Same palette, slot editing and store for drawing and selected objects. */
function SurfaceColorSlots(props: {
  readonly control: Extract<DocumentToolControl, { kind: 'color' }>;
  readonly family: InkSlotFamily;
  readonly store: ToolbarCustomizationStore;
  readonly execute: (id: string, value?: string) => void;
  readonly group: { readonly id: string; readonly groupId?: string };
  readonly resetKey: string;
  readonly editable?: boolean;
}): React.ReactElement {
  const { control, family, store, execute } = props;
  const [, refresh] = useReducer((revision: number) => revision + 1, 0);
  useEffect(() => {
    const subscription = store.onChange(refresh);
    return () => subscription.dispose();
  }, [store]);
  const colors = store.slotColorsForFamily(family);
  return (
    <ShelfSlotShelf
      kind="color"
      family={family}
      label="Quick colors"
      group={props.group}
      entries={colors.map((color, index) => ({
        id: `shelf:slot:color:${index}`,
        slotId: `shelf.slot.color.${index + 1}`,
        control,
        value: color,
        active: control.value.toLowerCase() === color.toLowerCase(),
      }))}
      execute={execute}
      settingsForSlot={() => ({
        controls: props.editable === false ? [] : [control],
        execute,
      })}
      slotColors={colors}
      {...(props.editable === false
        ? {}
        : {
            onEditSlotColor: (index: number, color: string) => {
              store.setSlotColorAt(family, index, color);
              execute(control.id, color);
            },
            onReorderSlotColor: (from: number, to: number) => {
              const next = [...store.slotColorsForFamily(family)];
              if (
                from < 0 ||
                from >= next.length ||
                to < 0 ||
                to >= next.length ||
                from === to
              )
                return;
              const [moved] = next.splice(from, 1);
              if (moved === undefined) return;
              next.splice(to, 0, moved);
              store.setSlotColorsForFamily(family, next);
            },
          })}
      resetKey={props.resetKey}
      isActiveContext
    />
  );
}

/** Selection keeps a short object menu; remaining commands stay in More. */
function SelectionObjectMenu(props: {
  readonly groups: readonly ResolvedToolbarGroup[];
  readonly executeOwned: UnifiedToolbarLayout['executeOwned'];
  readonly resetKey: string;
  readonly slotStore: ToolbarCustomizationStore;
}): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const controls = props.groups
    .filter((group) => group.anchor === 'float.selection')
    .flatMap((group) => group.controls)
    .filter(
      (owned, index, all) =>
        all.findIndex(
          (candidate) => candidate.control.id === owned.control.id,
        ) === index,
    );
  const hasText = controls.some(
    (owned) => owned.control.semanticRole?.startsWith('surface.text.') === true,
  );
  const primary = controls.filter((owned) => {
    const role = owned.control.semanticRole;
    return hasText
      ? ['style', 'size', 'bold', 'italic', 'color', 'align'].some(
          (name) => role === `surface.text.${name}`,
        )
      : [
          'color',
          'fill',
          'text-size',
          'shape',
          'line-path',
          'line-arrows',
          'shape-appearance',
          'radius',
          'stroke-width',
          'opacity',
          'duplicate',
          'delete',
        ].some((name) => role === `surface.selection.${name}`);
  });
  const rest = controls.filter((owned) => !primary.includes(owned));
  const close = (): void => setOpen(false);
  useMenuDismissal({ open, onClose: close, triggerRef, menuRef });
  const position = useToolbarPopoverPosition({
    triggerRef,
    popoverRef: menuRef,
    enabled: open,
  });
  if (controls.length === 0) return null;
  const control = (owned: OwnedToolbarControl): React.ReactElement => (
    <Fragment key={owned.control.id}>
      {owned.control.kind === 'color' &&
      owned.control.slotFamily !== undefined ? (
        <SurfaceColorSlots
          control={owned.control}
          family={owned.control.slotFamily}
          store={props.slotStore}
          execute={(_id, value) => props.executeOwned(owned, value)}
          group={{ id: 'surface.selection' }}
          resetKey={props.resetKey}
        />
      ) : owned.control.kind === 'choice' &&
        owned.control.slotFamily !== undefined ? (
        <SurfaceSizeSlots
          control={owned.control}
          family={owned.control.slotFamily}
          store={props.slotStore}
          execute={(_id, value) => props.executeOwned(owned, value)}
          group={{ id: 'surface.selection' }}
          resetKey={props.resetKey}
        />
      ) : (
        renderControl(
          owned.control,
          (_id, value) => props.executeOwned(owned, value),
          props.resetKey,
        )
      )}
    </Fragment>
  );
  return (
    <div
      className={styles['fl-floating-island']}
      data-anchor="float.selection"
      role="toolbar"
      aria-label="Object menu"
    >
      <div className={styles['fl-object-menu-primary']}>
        {primary.map(control)}
      </div>
      {rest.length > 0 ? (
        <div className={styles['fl-toolbar-overflow-wrap']}>
          <button
            type="button"
            className={styles['fl-document-tool']}
            aria-label="More object actions"
            aria-haspopup="dialog"
            aria-expanded={open}
            ref={triggerRef}
            onClick={() => setOpen((value) => !value)}
          >
            <Icon name="more" size={17} />
          </button>
          {open ? (
            <ToolbarPopoverPortal>
              <div
                className={`${styles['fl-document-tool-popover']} ${styles['fl-object-menu-more']}`}
                role="dialog"
                aria-label="More object actions"
                ref={menuRef}
                style={
                  position === null
                    ? { position: 'fixed' }
                    : {
                        position: 'fixed',
                        left: position.left,
                        top: position.top,
                        maxWidth: position.maxWidth,
                        maxHeight: position.maxHeight,
                        overflow: 'auto',
                        transform: 'none',
                      }
                }
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    close();
                    triggerRef.current?.focus();
                  }
                }}
              >
                {rest.map((owned) => (
                  <Fragment key={owned.control.id}>
                    {renderControl(
                      owned.control,
                      (_id, value) => {
                        props.executeOwned(owned, value);
                        close();
                      },
                      props.resetKey,
                    )}
                  </Fragment>
                ))}
              </div>
            </ToolbarPopoverPortal>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The source editor remains provider-owned; this surface only dispatches its command. */
function BlockSourceToolbar(props: {
  readonly groups: readonly ResolvedToolbarGroup[];
  readonly executeOwned: UnifiedToolbarLayout['executeOwned'];
}): React.ReactElement | null {
  const controls = props.groups
    .filter((group) => group.anchor === 'float.selection')
    .flatMap((group) => group.controls)
    .filter((owned) => /^(math|diagram)\.(edit|retry)$/.test(owned.control.id));
  if (controls.length === 0) return null;
  return (
    <div
      className={styles['fl-floating-island']}
      data-anchor="float.selection"
      role="toolbar"
      aria-label="Source block actions"
    >
      {controls.map((owned) => (
        <button
          key={owned.control.id}
          type="button"
          className={styles['fl-document-tool']}
          disabled={owned.control.kind === 'button' && owned.control.disabled}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => props.executeOwned(owned)}
        >
          {owned.control.id.endsWith('.edit') ? 'Edit source' : 'Retry preview'}
        </button>
      ))}
    </div>
  );
}

/**
 * Pane-scoped floating-toolbar overlay. The overlay itself never intercepts
 * pointer events; only toolbar islands do. Always mounted in edit mode so
 * the coordinate space is stable; islands render when they own controls.
 *
 * Collision handling is structural: each horizontal edge owns one full-width
 * flex strip (start/center/end slots), so same-edge islands share space
 * instead of overlapping — the center island compacts with internal scroll
 * when squeezed, and a second full-width toolbar row is never created.
 * Left/right-center anchors keep single isolated islands.
 *
 * History (`shell.history.undo`/`redo`) rides normal placement resolution
 * at `float.top-left` as shell-owned semantic controls, not a hard-coded
 * zone. Each island preserves its placement groups (id/order/priority/
 * compact) for responsive overflow.
 */
export function FloatingToolbarLayer(
  props: UnifiedToolbarProps & {
    readonly availableWidth?: number;
    readonly measuredWidths?:
      | ReadonlyMap<string, number>
      | Record<string, number>;
    /**
     * Real available pane width for the shelf compact decision (Repair
     * 10). Wins over the observed pane width and the window fallback so
     * a narrow split pane inside a wide window compacts. When omitted the
     * layer observes its enclosing `[data-pane]` once per pane.
     */
    readonly paneWidth?: number;
  },
): React.ReactElement {
  const model = useUnifiedToolbarLayout(props);
  const contextualShelf = useContext(ContextualShelfContext);
  const fallbackSlotStore = useMemo(() => new ToolbarCustomizationStore(), []);
  const slotStore = props.slotCustomization ?? fallbackSlotStore;
  const { groups, executeOwned, settingsControls, snapshot } = model;
  const writingPresentation =
    model.compositionGraph?.familyIds.includes('writing') ?? false;
  const writingHasShelf =
    props.kindId !== 'froglight.blockpage' &&
    writingPresentation &&
    model.compositionGraph !== null &&
    writingItems(model.compositionGraph).overflow.length > 0;
  const resetKey = `${props.pane}:${props.documentId}`;
  // One pane observation per floating layer: the shelf island
  // is intrinsic-size and cannot budget its own compaction, so the layer
  // measures the pane section and hands one boolean to the shelf.
  const layerRef = useRef<HTMLDivElement | null>(null);
  const [shelfDock, setShelfDock] = useState<
    'top' | 'right' | 'bottom' | 'left'
  >('top');
  useEffect(() => setShelfDock('top'), [resetKey]);
  const dragStart = useRef<{ pointerId: number; x: number; y: number } | null>(
    null,
  );
  const dragActive = useRef(false);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const [shelfDrag, setShelfDrag] = useState<{
    x: number;
    y: number;
    dock: 'top' | 'right' | 'bottom' | 'left';
  } | null>(null);
  const nearestShelfDock = useCallback((x: number, y: number) => {
    const bounds = layerRef.current?.getBoundingClientRect();
    if (bounds === undefined) return 'top' as const;
    const distances = [
      ['top', Math.abs(y - bounds.top)],
      ['right', Math.abs(bounds.right - x)],
      ['bottom', Math.abs(bounds.bottom - y)],
      ['left', Math.abs(x - bounds.left)],
    ] as const;
    return [...distances].sort((a, b) => a[1] - b[1])[0]?.[0] ?? 'top';
  }, []);
  const beginShelfDrag = useCallback(
    (pointerId: number, x: number, y: number) => {
      const layer = layerRef.current;
      if (layer === null) return;
      dragStart.current = { pointerId, x, y };
      dragActive.current = false;
      layer.setPointerCapture(pointerId);
    },
    [],
  );
  const moveShelfDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    const start = dragStart.current;
    if (start === null || start.pointerId !== event.pointerId) return;
    if (!dragActive.current) {
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < 5)
        return;
      dragActive.current = true;
    }
    const bounds = layerRef.current?.getBoundingClientRect();
    if (bounds === undefined) return;
    const dock = nearestShelfDock(event.clientX, event.clientY);
    const vertical = dock === 'left' || dock === 'right';
    const sameOrientation =
      shelfDrag !== null &&
      (shelfDrag.dock === 'left' || shelfDrag.dock === 'right') === vertical;
    const width = sameOrientation
      ? (previewRef.current?.offsetWidth ?? 0)
      : vertical
        ? 96
        : Math.min(520, bounds.width - 20);
    const height = sameOrientation
      ? (previewRef.current?.offsetHeight ?? 0)
      : vertical
        ? Math.min(520, bounds.height - 24)
        : 52;
    const clamp = (value: number, half: number, available: number): number =>
      Math.max(half + 8, Math.min(value, available - half - 8));
    setShelfDrag({
      dock,
      x: clamp(event.clientX - bounds.left, width / 2, bounds.width),
      y: clamp(event.clientY - bounds.top, height / 2, bounds.height),
    });
  };
  const endShelfDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (dragStart.current?.pointerId !== event.pointerId) return;
    if (dragActive.current)
      setShelfDock(nearestShelfDock(event.clientX, event.clientY));
    dragStart.current = null;
    dragActive.current = false;
    setShelfDrag(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const cancelShelfDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    if (dragStart.current?.pointerId !== event.pointerId) return;
    dragStart.current = null;
    dragActive.current = false;
    setShelfDrag(null);
  };
  const cycleShelfDock = useCallback(() => {
    setShelfDock(
      (current) =>
        (
          ({
            top: 'right',
            right: 'bottom',
            bottom: 'left',
            left: 'top',
          }) as const
        )[current],
    );
  }, []);
  const observedPaneWidth = usePaneWidth(layerRef);
  const shelfCompact = useToolbarCompact(props.paneWidth ?? observedPaneWidth);
  // One touch-availability subscription per floating layer (shared by
  // the shelf capacity budget); the pane width above is the single observer
  // per pane — the shelf never subscribes its own.
  const touchAvailable = useTouchAvailable();
  const shelfPaneWidth = props.paneWidth ?? observedPaneWidth;
  const keyboard = useKeyboardInset();
  const activeShelf = (
    dock: 'top' | 'right' | 'bottom' | 'left',
  ): React.ReactElement =>
    writingPresentation ? (
      <WritingShelf
        model={model}
        resetKey={resetKey}
        dock={dock}
        onDockPointerDown={beginShelfDrag}
        onDockCycle={cycleShelfDock}
      />
    ) : (
      <CompositionShelf
        model={model}
        resetKey={resetKey}
        compact={shelfCompact}
        paneWidth={shelfPaneWidth}
        touch={touchAvailable}
        dock={dock}
        onDockPointerDown={beginShelfDrag}
        onDockCycle={cycleShelfDock}
        slotStore={slotStore}
      />
    );
  const settings: readonly OwnedToolbarControl[] = settingsControls;
  // no stacked duplicate island for top-center quick properties.
  // The composition shelf owns top-center quick properties (favorites/
  // widths/colors/modes + settings popover) and no first-party
  // `float.top-center` placement remains, so the same user-facing property
  // cannot render twice even under different control ids (legacy
  // `ink.color` vs `ink.settings.pen.color`). Verified by the semantic
  // disjointness pin in `default-placements.spec.ts` (one visible
  // color/width presenter per active pen, one size presenter per eraser,
  // across Ink/Notebook/Whiteboard). extends the same single-owner
  // rule cross-layer: the shelf generically skips any control already
  // claimed geometrically (PDF Previous/Next — island keeps them; Text
  // role exempt; notebook management stays in the composition shelf. A
  // combined diagnostic reports other collisions. Custom
  // hosts must not register top-center placements duplicating
  // composition-owned tool properties.
  const island = (
    anchor: Exclude<ToolbarAnchor, 'topbar-center'>,
  ): React.ReactElement | null =>
    anchor === 'float.selection' &&
    props.kindId === 'froglight.blockpage' &&
    groups.some(
      (group) =>
        group.anchor === anchor &&
        group.controls.some((owned) => owned.control.id.startsWith('table.')),
    ) ? null : anchor === 'float.selection' &&
      props.kindId === 'froglight.blockpage' &&
      snapshot?.contextualAnchor !== undefined &&
      groups.some(
        (group) =>
          group.anchor === anchor &&
          group.controls.some((owned) => owned.control.id.startsWith('media.')),
      ) ? (
      <BlockMediaPanel
        anchor={snapshot.contextualAnchor}
        controls={groups
          .filter((group) => group.anchor === anchor)
          .flatMap((group) => group.controls)
          .filter((owned) => owned.control.id.startsWith('media.'))
          .map((owned) => ({
            id: owned.control.id,
            label: owned.control.label,
            ...(owned.control.kind === 'input' &&
            typeof owned.control.value === 'string'
              ? { value: owned.control.value }
              : {}),
            ...(owned.control.kind === 'button'
              ? { disabled: owned.control.disabled }
              : {}),
          }))}
        onAction={(id, value) => {
          const control = groups
            .filter((group) => group.anchor === anchor)
            .flatMap((group) => group.controls)
            .find((owned) => owned.control.id === id);
          if (control !== undefined) executeOwned(control, value);
        }}
      />
    ) : anchor === 'float.selection' &&
      props.kindId === 'froglight.blockpage' &&
      groups.some(
        (group) =>
          group.anchor === anchor &&
          group.controls.some((owned) =>
            /^(math|diagram)\./.test(owned.control.id),
          ),
      ) ? (
      <BlockSourceToolbar
        key={anchor}
        groups={groups}
        executeOwned={executeOwned}
      />
    ) : anchor === 'float.selection' &&
      ![
        'froglight.blockpage',
        'froglight.markdown',
        'froglight.latex',
      ].includes(props.kindId ?? '') ? (
      <SelectionObjectMenu
        key={anchor}
        groups={groups}
        executeOwned={executeOwned}
        resetKey={resetKey}
        slotStore={slotStore}
      />
    ) : anchor === 'float.selection' &&
      ['froglight.blockpage', 'froglight.markdown', 'froglight.latex'].includes(
        props.kindId ?? '',
      ) &&
      touchAvailable &&
      !keyboard.isOpen ? null : (
      <FloatingIsland
        key={anchor}
        anchor={anchor}
        groups={groups}
        executeOwned={executeOwned}
        resetKey={resetKey}
        settings={settings}
        {...(props.availableWidth !== undefined
          ? { availableWidth: props.availableWidth }
          : {})}
        {...(props.measuredWidths !== undefined
          ? { measuredWidths: props.measuredWidths }
          : {})}
      />
    );
  const slot = (
    anchor: Exclude<ToolbarAnchor, 'topbar-center'>,
    align: 'start' | 'center' | 'end',
  ): React.ReactElement => (
    <div
      className={`${styles['fl-floating-slot']} ${styles[`slot-${align}`]}`}
      key={anchor}
    >
      {island(anchor)}
    </div>
  );
  const topCenter = (() => {
    if (props.kindId === 'froglight.blockpage') return null;
    if (writingPresentation) {
      return (
        <div
          className={`${styles['fl-floating-slot']} ${styles['slot-center']} ${styles['fl-contextual-stack']}`}
          data-open={
            writingHasShelf && contextualShelf?.open ? 'true' : 'false'
          }
          aria-hidden={!writingHasShelf || !contextualShelf?.open}
          inert={!writingHasShelf || !contextualShelf?.open}
        >
          {writingHasShelf && shelfDock === 'top' && shelfDrag === null
            ? activeShelf('top')
            : null}
        </div>
      );
    }
    // the shelf owns top-center whenever a composition category
    // is expanded. The legacy `float.top-center` island renders only as a
    // fallback when no shelf category exists (hosts without a composition),
    // so Surface quick properties never stack a shelf plus an island.
    const hasShelfCategory =
      model.compositionGraph?.categories.some(
        (category) => category.id === model.activeCategoryId,
      ) === true;
    const shelfConcealed =
      hasShelfCategory && contextualShelf !== null && !contextualShelf.open;
    if (hasShelfCategory && shelfDock === 'top' && shelfDrag === null) {
      return (
        <div
          className={`${styles['fl-floating-slot']} ${styles['slot-center']} ${styles['fl-contextual-stack']}`}
          data-open={shelfConcealed ? 'false' : 'true'}
          aria-hidden={shelfConcealed}
          inert={shelfConcealed}
        >
          {activeShelf(shelfDock)}
        </div>
      );
    }
    if (hasShelfCategory) return null;
    return (
      <div
        className={`${styles['fl-floating-slot']} ${styles['slot-center']} ${styles['fl-contextual-stack']}`}
        data-open={shelfConcealed ? 'false' : 'true'}
        aria-hidden={shelfConcealed}
        inert={shelfConcealed}
      >
        <CompositionShelf
          model={model}
          resetKey={resetKey}
          compact={shelfCompact}
          paneWidth={shelfPaneWidth}
          touch={touchAvailable}
          slotStore={slotStore}
        />
        {island('float.top-center')}
      </div>
    );
  })();
  const dockedShelf =
    props.kindId !== 'froglight.blockpage' &&
    shelfDrag === null &&
    shelfDock !== 'top' &&
    (writingHasShelf ||
      model.compositionGraph?.categories.some(
        (category) => category.id === model.activeCategoryId,
      )) ? (
      <div
        className={styles['fl-docked-tool-menu']}
        data-dock={shelfDock}
        data-open={contextualShelf?.open === false ? 'false' : 'true'}
        aria-hidden={contextualShelf?.open === false}
        inert={contextualShelf?.open === false}
      >
        {activeShelf(shelfDock)}
      </div>
    ) : null;
  // Left/right-center anchors keep single isolated islands floating at the
  // pane's vertical middle; only one island can occupy each, so no slot
  // sharing is needed there.
  const sideSlot = (
    anchor: 'float.left-center' | 'float.right-center',
    side: 'left' | 'right',
  ): React.ReactElement => (
    <div
      className={`${styles['fl-floating-slot-float']} ${styles[`slot-${side}`]}`}
      key={anchor}
    >
      {island(anchor)}
    </div>
  );
  const anchor = snapshot?.contextualAnchor;
  const selectionMenuRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const menu = selectionMenuRef.current;
    const layer = layerRef.current;
    if (
      menu === null ||
      layer === null ||
      anchor === undefined ||
      props.kindId === 'froglight.blockpage'
    )
      return;
    const position = (): void => {
      const pane = layer.getBoundingClientRect();
      if (pane.width <= 0) return;
      const viewport = window.visualViewport;
      const left = Math.max(pane.left, viewport?.offsetLeft ?? 0);
      const top = Math.max(pane.top, viewport?.offsetTop ?? 0);
      const right = Math.min(
        pane.right,
        (viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth),
      );
      const bottom = Math.min(
        pane.bottom,
        (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight),
      );
      menu.style.maxWidth = `${Math.max(0, Math.min(520, right - left - 16))}px`;
      const bounds = menu.getBoundingClientRect();
      const placement = computeToolbarPopoverPosition({
        trigger: anchor,
        pane: { x: left, y: top, width: right - left, height: bottom - top },
        popover: bounds,
        preferred: 'above',
        inset: 8,
        gap: 12,
      });
      // The pane establishes a containing block. Translate viewport anchors
      // into the floating layer's coordinates, including split-pane offsets.
      menu.style.left = `${placement.left - pane.left}px`;
      menu.style.top = `${placement.top - pane.top}px`;
    };
    position();
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(position);
    observer?.observe(menu);
    observer?.observe(layer);
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    window.visualViewport?.addEventListener('resize', position);
    window.visualViewport?.addEventListener('scroll', position);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
      window.visualViewport?.removeEventListener('resize', position);
      window.visualViewport?.removeEventListener('scroll', position);
    };
  }, [anchor, props.kindId]);
  const tableActions = groups
    .filter((group) => group.anchor === 'float.selection')
    .flatMap((group) => group.controls)
    .filter((owned) => owned.control.id.startsWith('table.'));
  const selectionStyle =
    anchor === undefined
      ? undefined
      : {
          left: anchor.x + anchor.width / 2,
          top: anchor.y,
        };
  return (
    <div
      className={styles['fl-floating-layer']}
      data-floating-layer=""
      ref={layerRef}
      onPointerMove={moveShelfDrag}
      onPointerUp={endShelfDrag}
      onPointerCancel={cancelShelfDrag}
    >
      <div className={`${styles['fl-floating-strip']} ${styles['strip-top']}`}>
        {slot('float.top-left', 'start')}
        {topCenter}
        {slot('float.top-right', 'end')}
      </div>
      {shelfDrag !== null && props.kindId !== 'froglight.blockpage' ? (
        <div
          ref={previewRef}
          className={`${styles['fl-docked-tool-menu']} ${styles['fl-tool-menu-drag-preview']}`}
          data-dock={shelfDrag.dock}
          data-drag-preview=""
          style={{ left: shelfDrag.x, top: shelfDrag.y }}
          aria-hidden="true"
          inert
        >
          {activeShelf(shelfDrag.dock)}
        </div>
      ) : null}
      {shelfDock === 'left' || shelfDock === 'right' ? dockedShelf : null}
      {sideSlot('float.left-center', 'left')}
      {sideSlot('float.right-center', 'right')}
      {anchor !== undefined ? (
        <div
          className={styles['fl-selection-toolbar-slot']}
          ref={selectionMenuRef}
          style={selectionStyle}
          data-selection-toolbar=""
          data-selection-toolbar-kind={props.kindId}
        >
          {island('float.selection')}
        </div>
      ) : null}
      {props.kindId === 'froglight.blockpage' &&
      anchor !== undefined &&
      tableActions.length > 0 ? (
        <BlockTableHandles
          anchor={anchor}
          available={new Set(tableActions.map((owned) => owned.control.id))}
          onAction={(id, value) => {
            const action = tableActions.find(
              (owned) => owned.control.id === id,
            );
            if (action !== undefined) executeOwned(action, value);
          }}
        />
      ) : null}
      <div
        className={`${styles['fl-floating-strip']} ${styles['strip-bottom']}`}
      >
        {slot('float.bottom-left', 'start')}
        <div
          className={`${styles['fl-floating-slot']} ${styles['slot-center']}`}
        >
          {dockedShelf && shelfDock === 'bottom' ? dockedShelf : null}
          {island('float.bottom-center')}
        </div>
        {slot('float.bottom-right', 'end')}
      </div>
    </div>
  );
}
