/**
 * Notebook page surface adapter (#43).
 *
 * Notebook pages embed the document-agnostic Ink surface provider. This
 * adapter is the single Notebook-specific policy layer over
 * `mountInkSurface`: Notebook→Ink tool-id translation,
 * `embedded-paper` vs `embedded-overlay` presentation selection,
 * frame-resize disablement for pages, embedded touch/pan/zoom delegation,
 * and template background mapping. It must not grow PDF document loading,
 * thumbnail scheduling, export rendering, or pager state — those live in
 * `pager/` collaborators. Derived PNG rendering moved to
 * `pager/export.ts` (re-exported through the package barrel).
 */

import {
  type StylusInputPolicy,
  SURFACE_TOOL_IDS,
  type AlignEdge,
  type Bounds,
  type DistributeAxis,
  type DrawItem,
  type EraserMode,
  type EraserPreset,
  type EraserStyleRef,
  type GesturePreferences,
  type InkPresetToolId,
  type InkToolPreset,
  type LineArrowSetting,
  type LassoPreset,
  type PenStyleRef,
  type ReorderDirection,
  type SelectionContextSnapshot,
  type SelectionStyle,
  type SurfaceTextSelectionState,
  type SettingsService,
  type SurfaceDerivedCache,
  type SurfaceModel,
  type SurfaceReopenBinding,
  type SurfaceRulerState,
  type SurfaceStylePreset,
} from '@froglight/foundation';
import { type SurfaceImageResolver } from '@froglight/surface-default';
import {
  INK_TOOL_IDS,
  InkSurfaceSkeleton,
  mountInkSurface,
  type InkSkeleton,
  type InkSurfaceHandle,
} from '@froglight/editor-ink';

export { InkSurfaceSkeleton, type InkSkeleton };

export const PAGE_TOOL_IDS = {
  ...SURFACE_TOOL_IDS,
  rect: INK_TOOL_IDS.rect,
  triangle: INK_TOOL_IDS.triangle,
  diamond: INK_TOOL_IDS.diamond,
  ellipse: INK_TOOL_IDS.ellipse,
  line: INK_TOOL_IDS.line,
  text: 'froglight.notebook.text',
} as const;

export interface PageSurfaceOptions {
  readonly model: SurfaceModel;
  readonly markDirty: () => void;
  /**
   * Disposable decode-time Ink bounds seeds for this page. They seed the
   * spatial index without rescanning samples during cold-open repair.
   * Absent/invalid seeds fall back to normal lazy derivation.
   */
  readonly seedBounds?: ReadonlyMap<string, Bounds | null>;
  /**
   * Derived reopen-cache binding (final pass): provider-owned store plus
   * this page's document identity and LIVE session revision/dirty
   * accessors. Restores validated packed vectors with zero compiles when
   * clean; teardown queues warm-vector persistence. Absent means
   * seeds-only (or plain derivation).
   */
  readonly reopen?: SurfaceReopenBinding & {
    /** Already-acquired per-document cache (avoids a second lookup). */
    readonly cache?: SurfaceDerivedCache;
  };
  /**
   * React- or engine-owned ink host. The top-level pager chrome is React;
   * per-page ink hosts are engine-owned dynamic content created inside
   * lazily mounted page shells (see pager.ts createPageInkHost). Either way
   * the surface engine consumes a committed skeleton via `host` and never
   * creates visible DOM itself.
   */
  readonly host: InkSkeleton;
  readonly penStyle?: PenStyleRef;
  /** Shared eraser sizing (passes through to the ink surface engine). */
  readonly eraserStyle?: EraserStyleRef;
  /** Shared settings backing for per-tool presets (pass-through). */
  readonly presetSettings?: SettingsService;
  readonly stylusInput?: StylusInputPolicy;
  readonly readOnly?: boolean;
  /** Ephemeral straightedge ruler (slice 10, pass-through). */
  readonly ruler?: SurfaceRulerState | null;
  /** Plain-data paper compiled per notebook template. */
  readonly backgroundItems?: () => readonly DrawItem[];
  /** Clip rasterization to this host viewport; fit/input still use the full page. */
  readonly renderViewport?: HTMLElement;
  /** Leave the surface transparent when the host renders a PDF page below it. */
  readonly transparentBase?: boolean;
  /** Provider-maintained decoded asset cache. */
  readonly imageResolver?: SurfaceImageResolver;
  readonly initialTool?: string;
  readonly onPageStackPan?:
    | ((deltaView: { x: number; y: number }) => void)
    | undefined;
  readonly onPageStackPanEnd?:
    | ((velocity: { x: number; y: number }) => void)
    | undefined;
  readonly onPageStackCancel?: (() => void) | undefined;
}

export interface PageSurfaceHandle {
  readonly root: HTMLElement;
  setReadOnly(readOnly: boolean): void;
  setTool(toolId: string): void;
  activeToolId(): string;
  /**
   * Settled exclusive tool in page dialect: forwarded from
   * the page's surface with Notebook→Ink id translation, so toolbar
   * reconciliation ignores temporary entries on every family.
   */
  settledActiveToolId(): string;
  /** Ephemeral straightedge state; `null` means hidden (slice 10). */
  rulerState(): SurfaceRulerState | null;
  /** Replace the ephemeral ruler; never marks dirty or history. */
  setRuler(ruler: SurfaceRulerState | null): void;
  /** Read one tool's preset (slice 8 settings host). */
  toolPreset(tool: InkPresetToolId): InkToolPreset;
  /** Merge a patch into one tool's preset. */
  setToolPreset(tool: InkPresetToolId, patch: Partial<InkToolPreset>): void;
  savedStyles(tool: InkPresetToolId): readonly SurfaceStylePreset[];
  currentStyleId(tool: InkPresetToolId): string | null;
  saveCurrentStyle(tool: InkPresetToolId, name: string): string | null;
  applySavedStyle(id: string): boolean;
  updateSavedStyle(id: string): boolean;
  renameSavedStyle(id: string, name: string): boolean;
  favoriteSavedStyle(id: string, favorite: boolean): boolean;
  reorderSavedStyles(tool: InkPresetToolId, ids: readonly string[]): boolean;
  deleteSavedStyle(id: string): boolean;
  resetSavedStyle(tool: InkPresetToolId): boolean;
  savedStyleModified(tool: InkPresetToolId): boolean;
  cornerRadius(): number;
  setCornerRadius(value: number): void;
  shapeAppearance(): 'fill' | 'outline';
  setShapeAppearance(value: 'fill' | 'outline'): void;
  lineArrows(): LineArrowSetting;
  setLineArrows(arrows: LineArrowSetting): void;
  /** Recent color choices, most-recent-first. */
  recentColors(): string[];
  /** Current eraser preset. */
  eraserPreset(): EraserPreset;
  /** Merge a patch into the eraser preset. */
  setEraserPreset(patch: Partial<EraserPreset>): void;
  /**
   * Current eraser preset mode for the two toolbar erasers.
   * Forwarded from the page's surface preset store (tolerant migration,
   * never throws); the single eraser engine is unchanged.
   */
  eraserMode(): EraserMode;
  /** Fix the eraser preset mode (best-effort; engine activation follows). */
  setEraserMode(mode: EraserMode): void;
  /** Current lasso preset. */
  lassoPreset(): LassoPreset;
  /** Merge a patch into the lasso preset. */
  setLassoPreset(patch: Partial<LassoPreset>): void;
  /** Gesture preferences (slice 7 product contract). */
  gestures(): GesturePreferences;
  /** Merge a patch into the gesture preferences. */
  setGestures(patch: Partial<GesturePreferences>): void;
  undo(): boolean;
  redo(): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
  selectionIds(): readonly string[];
  /**
   * Replace the ephemeral selection (never canonical, never dirty, never
   * history). Test + toolbar seam for the text write path: production
   * selection still arrives via pointer gestures; this only forwards to
   * the shared engine so specs can seed honest selection state.
   */
  setSelection(ids: readonly string[]): void;
  claimTouchInteraction(event: PointerEvent): boolean;
  cancelTouchInteraction(): void;
  selectionViewportBounds(): Bounds | null;
  selectionContext(): SelectionContextSnapshot | null;
  moveSelectionBy(delta: { x: number; y: number }): string[];
  scaleSelection(factor: number): string[];
  rotateSelection(deltaRadians: number): string[];
  setSelectionStyle(style: SelectionStyle): string[];
  textStyleState(): SurfaceTextSelectionState;
  setTextStyle(style: SelectionStyle): string[];
  alignSelection(edge: AlignEdge): string[];
  distributeSelection(axis: DistributeAxis): string[];
  reorderSelection(where: ReorderDirection): string[];
  setLocked(ids: readonly string[], locked: boolean): string[];
  groupSelection(): string[];
  ungroupSelection(): string[];
  duplicateSelection(): string[];
  deleteSelection(): string[];
  connectSelected(): string | null;
  frameSize(): { width: number; height: number } | null;
  resizeFrame(width: number, height: number): boolean;
  exportPng(): void;
  refreshViewport(): void;
  refresh(changedIds?: readonly string[]): void;
  flush(): void;
  onDidChange(listener: () => void): { dispose(): void };
  destroy(): void;
}

function toInkToolId(toolId: string): string {
  return toolId === PAGE_TOOL_IDS.text ? INK_TOOL_IDS.text : toolId;
}

function toPageToolId(toolId: string): string {
  return toolId === INK_TOOL_IDS.text ? PAGE_TOOL_IDS.text : toolId;
}

/**
 * Engine-owned dynamic page ink host.
 *
 * Pager page shells are created lazily as the user scrolls; React owns only
 * the stable pager chrome and never the per-page lifecycle. These nodes use
 * the same `fl-ink-*` hooks as the React ink skeleton so the shared surface
 * engine consumes identical structure, but they are engine-owned dynamic
 * content — not stable presentation. The presentation mapping
 * (transparent PDF base → overlay, otherwise paper) is adapter policy: the
 * pager only reports whether the base is transparent.
 */
export function createPageInkHost(
  parent: HTMLElement,
  transparentBase: boolean,
): InkSkeleton {
  const root = document.createElement('div');
  root.className = 'fl-ink-root';
  root.dataset.presentation = transparentBase
    ? 'embedded-overlay'
    : 'embedded-paper';
  root.dataset.navigation = 'embedded';
  root.tabIndex = 0;

  const page = document.createElement('div');
  page.className = 'fl-ink-page';

  const canvas = document.createElement('canvas');
  canvas.className = 'fl-ink-canvas';
  page.appendChild(canvas);

  const badge = document.createElement('div');
  badge.className = 'fl-ink-badge';
  page.appendChild(badge);

  const pointerIndicator = document.createElement('div');
  pointerIndicator.className = 'fl-ink-pointer-indicator';
  pointerIndicator.setAttribute('aria-hidden', 'true');
  page.appendChild(pointerIndicator);

  // React-owned overlay container parity: engine-owned
  // dynamic page hosts mirror the React skeleton structure so the shared
  // surface engine consumes identical hooks.
  const overlayRoot = document.createElement('div');
  overlayRoot.className = 'fl-ink-text-overlay-root';
  overlayRoot.setAttribute('aria-hidden', 'true');
  page.appendChild(overlayRoot);

  root.appendChild(page);
  parent.appendChild(root);
  return { root, page, canvas, badge, pointerIndicator, overlayRoot };
}

export function mountPageSurface(
  options: PageSurfaceOptions,
): PageSurfaceHandle {
  const surface: InkSurfaceHandle = mountInkSurface({
    model: options.model,
    stylusInput: options.stylusInput,
    readOnly: options.readOnly,
    markDirty: options.markDirty,
    host: options.host,
    ...(options.renderViewport !== undefined
      ? { renderViewport: options.renderViewport }
      : {}),
    ...(options.seedBounds !== undefined
      ? { seedBounds: options.seedBounds }
      : {}),
    ...(options.reopen !== undefined ? { reopen: options.reopen } : {}),
    ...(options.penStyle !== undefined ? { penStyle: options.penStyle } : {}),
    ...(options.eraserStyle !== undefined
      ? { eraserStyle: options.eraserStyle }
      : {}),
    ...(options.presetSettings !== undefined
      ? { presetSettings: options.presetSettings }
      : {}),
    ...(options.ruler !== undefined && options.ruler !== null
      ? { ruler: options.ruler }
      : {}),
    ...(options.initialTool !== undefined
      ? { initialTool: toInkToolId(options.initialTool) }
      : {}),
    presentation:
      options.transparentBase === true ? 'embedded-overlay' : 'embedded-paper',
    frameResizable: false,
    navigationMode: 'embedded',
    // Fingers navigate the whole notebook, including gaps and other pages.
    delegateTouchNavigation: true,
    ...(options.onPageStackPan !== undefined
      ? { onEmbeddedPan: options.onPageStackPan }
      : {}),
    ...(options.onPageStackPanEnd !== undefined
      ? { onEmbeddedPanEnd: options.onPageStackPanEnd }
      : {}),
    ...(options.onPageStackCancel !== undefined
      ? { onEmbeddedCancel: options.onPageStackCancel }
      : {}),
    ...(options.backgroundItems !== undefined
      ? { backgroundItems: options.backgroundItems }
      : {}),
    ...(options.imageResolver !== undefined
      ? { imageResolver: options.imageResolver }
      : {}),
  });
  surface.root.classList.add('fl-ps');
  return {
    root: surface.root,
    setReadOnly: (readOnly) => surface.setReadOnly(readOnly),
    setTool(toolId) {
      surface.setTool(toInkToolId(toolId));
    },
    activeToolId() {
      return toPageToolId(surface.activeToolId());
    },
    settledActiveToolId() {
      return toPageToolId(surface.settledActiveToolId());
    },
    rulerState: () => surface.rulerState(),
    setRuler: (ruler) => surface.setRuler(ruler),
    toolPreset: (tool) => surface.toolPreset(tool),
    setToolPreset: (tool, patch) => surface.setToolPreset(tool, patch),
    savedStyles: (tool) => surface.savedStyles(tool),
    currentStyleId: (tool) => surface.currentStyleId(tool),
    saveCurrentStyle: (tool, name) => surface.saveCurrentStyle(tool, name),
    applySavedStyle: (id) => surface.applySavedStyle(id),
    updateSavedStyle: (id) => surface.updateSavedStyle(id),
    renameSavedStyle: (id, name) => surface.renameSavedStyle(id, name),
    favoriteSavedStyle: (id, favorite) =>
      surface.favoriteSavedStyle(id, favorite),
    reorderSavedStyles: (tool, ids) => surface.reorderSavedStyles(tool, ids),
    deleteSavedStyle: (id) => surface.deleteSavedStyle(id),
    resetSavedStyle: (tool) => surface.resetSavedStyle(tool),
    savedStyleModified: (tool) => surface.savedStyleModified(tool),
    cornerRadius: () => surface.cornerRadius(),
    setCornerRadius: (value) => surface.setCornerRadius(value),
    shapeAppearance: () => surface.shapeAppearance(),
    setShapeAppearance: (value) => surface.setShapeAppearance(value),
    lineArrows: () => surface.lineArrows(),
    setLineArrows: (arrows) => surface.setLineArrows(arrows),
    recentColors: () => surface.recentColors(),
    eraserPreset: () => surface.eraserPreset(),
    setEraserPreset: (patch) => surface.setEraserPreset(patch),
    eraserMode: () => surface.eraserMode(),
    setEraserMode: (mode) => surface.setEraserMode(mode),
    lassoPreset: () => surface.lassoPreset(),
    setLassoPreset: (patch) => surface.setLassoPreset(patch),
    gestures: () => surface.gestures(),
    setGestures: (patch) => surface.setGestures(patch),
    undo: () => surface.undo(),
    redo: () => surface.redo(),
    canUndo: () => surface.canUndo(),
    canRedo: () => surface.canRedo(),
    selectionIds: () => surface.selectionIds(),
    setSelection: (ids) => surface.setSelection(ids),
    claimTouchInteraction: (event) => surface.claimTouchInteraction(event),
    cancelTouchInteraction: () => surface.cancelTouchInteraction(),
    selectionViewportBounds: () => surface.selectionViewportBounds(),
    selectionContext: () => surface.selectionContext(),
    moveSelectionBy: (delta) => surface.moveSelectionBy(delta),
    scaleSelection: (factor) => surface.scaleSelection(factor),
    rotateSelection: (deltaRadians) => surface.rotateSelection(deltaRadians),
    setSelectionStyle: (style) => surface.setSelectionStyle(style),
    textStyleState: () => surface.textStyleState(),
    setTextStyle: (style) => surface.setTextStyle(style),
    alignSelection: (edge) => surface.alignSelection(edge),
    distributeSelection: (axis) => surface.distributeSelection(axis),
    reorderSelection: (where) => surface.reorderSelection(where),
    setLocked: (ids, locked) => surface.setLocked(ids, locked),
    groupSelection: () => surface.groupSelection(),
    ungroupSelection: () => surface.ungroupSelection(),
    duplicateSelection: () => surface.duplicateSelection(),
    deleteSelection: () => surface.deleteSelection(),
    connectSelected: () => surface.connectSelected(),
    frameSize: () => surface.frameSize(),
    resizeFrame: (width, height) => surface.resizeFrame(width, height),
    exportPng: () => surface.exportPng(),
    refreshViewport: () => surface.refreshViewport(),
    refresh: (changedIds) => surface.refresh(changedIds),
    flush: () => surface.flush(),
    onDidChange: (listener) => surface.onDidChange(listener),
    destroy: () => {
      surface.flush();
      surface.destroy();
    },
  };
}
