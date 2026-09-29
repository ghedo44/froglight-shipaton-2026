/**
 * Notebook pager: vertical continuous scrolling over lazily
 * mounted bounded-surface pages. Each visible page embeds the shared
 * document-agnostic surface editing component (`mountInkSurface`) with
 * provider-local gesture history and a shared pager-owned zoom; a single notebook-
 * level semantic controls drive the focused page. Page structure (add/duplicate/
 * delete/reorder/templates) mutates canonical `NotebookModel`
 * data only — this component owns no persistence, revisions, or search.
 *
 * The pager orchestrates focused collaborators and owns page-shell
 * lifecycle plus canonical page mutations: `pager/pdf-base.ts` (PDF
 * document pool, page-base mounting, outline), `pager/export.ts` (PNG render/export),
 * `pager/zoom.ts` (pure stack zoom math), and `pager/image-insert.ts`
 * (asset insertion). `page-surface.ts` remains the sole Notebook-specific
 * adapter over `mountInkSurface`.
 */

import {
  type StylusInputPolicy,
  baseOf,
  createDefaultSurfaceObjectTypeRegistry,
  DEFAULT_ERASER_MODE,
  DEFAULT_ERASER_RADIUS_VIEW,
  frameBounds,
  isNavigablePage,
  isValidPaperOptions,
  isValidRulerState,
  labelOf,
  templateOf,
  paperOptionsOf,
  setPaperOptions,
  navigablePageIds,
  notebookPage as makePage,
  templateBackgroundDrawItems,
  DEFAULT_NOTEBOOK_TEMPLATE,
  NOTEBOOK_LIMITS,
  orientSize,
  contentRevisionFromOpenMetadata,
  pageSeedBoundsFromOpenMetadata,
  pageSizePreset,
  resolveReopenSeeds,
  RULER_DEFAULT_LENGTH,
  setPageTemplate,
  type DocumentAssetStore,
  type DrawItem,
  type EraserMode,
  type EraserPreset,
  type EraserStyleRef,
  type GesturePreferences,
  type InkPresetToolId,
  type InkToolPreset,
  type SurfaceStylePreset,
  type SurfaceTextSelectionState,
  type LineArrowSetting,
  type LassoPreset,
  type NotebookModel,
  type NotebookPageOrientation,
  type NotebookPaperOptions,
  type PenStyleRef,
  type SettingsService,
  type StoredAsset,
  type SurfaceModel,
  type SurfaceObjectTypeRegistry,
  type SurfaceRulerState,
  type PdfProvider,
  type PdfSourceInteractionMode,
  type AlignEdge,
  type Bounds,
  type DerivedReopenStore,
  type DistributeAxis,
  type ReorderDirection,
  type SelectionContextSnapshot,
  type SelectionStyle,
  type SurfaceReopenBinding,
  SURFACE_SHARED_SWATCHES,
  SURFACE_SHARED_WIDTHS,
} from '@froglight/foundation';
import {
  createSurfaceImageCache,
  decodeImageBytes,
  inverseRubberBand,
  NAVIGATION_PHYSICS,
  rubberBand,
  primaryTouchPair,
  stepDecay,
  stepSpring,
  VelocityTracker,
  type DecodedImage,
  type InkSkeleton,
  type PrimaryTouchIds,
  type SurfaceImageCache,
  type TouchContact,
} from '@froglight/editor-ink';
import {
  PAGE_TOOL_IDS,
  createPageInkHost,
  mountPageSurface,
  type PageSurfaceHandle,
} from './page-surface.js';
import { deriveSurfaceTextSelectionState } from './text-selection.js';
import { createPdfBaseManager } from './pager/pdf-base.js';
import {
  downloadCurrentNotebookPageAsPng,
  downloadNotebookPagesAsPng,
  cancelledExportError,
  renderNotebookPageImage,
} from './pager/export.js';
import { insertImageIntoCurrentPage } from './pager/image-insert.js';
import { notebookNavigationTiming } from './pager/navigation.js';
import {
  beginPinchPreview,
  clampNotebookZoom,
  NOTEBOOK_MAX_ZOOM,
  NOTEBOOK_MIN_ZOOM,
  rebasePinchPreview,
  stepPinchPreview,
  stepPinchPreviewWithFactor,
  touchCentroid,
  type PinchPreview,
  type ZoomPoint,
} from './pager/zoom.js';

/**
 * Shared Surface pen palette/widths: Notebook aliases the family
 * table instead of maintaining its own, so Ink, Notebook, and Whiteboard
 * style controls stay identical. Paper tints (`NOTEBOOK_PAPER_COLORS`)
 * remain Notebook-local — they describe page furniture, not stroke style.
 */
export const NOTEBOOK_INK_COLORS = SURFACE_SHARED_SWATCHES;
export const NOTEBOOK_INK_WIDTHS = SURFACE_SHARED_WIDTHS;

export const NOTEBOOK_PAPER_LABELS: Record<string, string> = {
  froglight_blank: '',
  'froglight.blank': 'Blank',
  'froglight.lined': 'Ruled',
  'froglight.grid': 'Grid',
  'froglight.dots': 'Dots',
  'froglight.cornell': 'Cornell',
} as unknown as Record<string, string>;

/** Standard paper sizes offered by the notebook page-settings UI. */
export const NOTEBOOK_PAGE_SIZE_LABELS: Record<string, string> = {
  'froglight.a4': 'A4',
  'froglight.letter': 'Letter',
  'froglight.legal': 'Legal',
  'froglight.square': 'Square',
};

/** Paper tint swatches for the page-settings color control. */
export const NOTEBOOK_PAPER_COLORS = [
  '#ffffff',
  '#faf7ef',
  '#f3ede0',
  '#eef2f5',
  '#e9eaee',
] as const;

// Structural styles are owned by the colocated React chrome
// (react/NotebookChrome.module.css, @layer components). The pager consumes
// React-owned stable nodes and never injects styles.
const NOTEBOOK_MAX_PAGE_WIDTH = 840;

let pageCounter = 0;

function freshPageId(): string {
  pageCounter += 1;
  return `pg-${pageCounter}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Visible pager skeleton elements: owned by React, consumed by the engine. */
export interface NotebookPagerSkeleton {
  readonly root: HTMLDivElement;
  readonly imgInput: HTMLInputElement;
  readonly pdfInput: HTMLInputElement;
  readonly pdfImportStatus: HTMLDivElement;
  readonly main: HTMLDivElement;
  readonly scroll: HTMLDivElement;
  readonly stack: HTMLDivElement;
}

export interface NotebookPagerOptions {
  /** The live canonical notebook model (mutated in place). */
  readonly model: NotebookModel;
  /** Dirty bridge to the owning session. */
  readonly markDirty: () => void;
  /**
   * Disposable decode-time metadata from the session (cold-open repair,
   * per-page Ink bounds seeds that let each mounting page skip
   * its sample rescan. Absent for models that did not decode from bytes.
   */
  readonly openMetadata?: Readonly<Record<string, unknown>>;
  /**
   * Derived reopen cache pool + document identity: each page
   * resolves its seeds through the cache at mount (valid entries win,
   * decode seeds fill gaps and backfill). Both or neither; absent keeps
   * the decode-seed path. `derivedSession` carries the LIVE
   * session revision/dirty contract; without it the pager
   * falls back to the `openMetadata` snapshot.
   */
  readonly derivedStore?: DerivedReopenStore;
  readonly documentId?: string;
  readonly derivedSession?: {
    getContentRevision(): string | null;
    isDirty(): boolean;
  };
  /**
   * React-owned pager skeleton committed by NotebookChrome.
   * React owns all Froglight-visible stable presentation; the engine
   * consumes refs and appends only engine-owned dynamic content (page
   * shells, PDF bases, empty notes) into them.
   */
  readonly host: NotebookPagerSkeleton;
  /** Shared pen swatch/width state across pages. */
  readonly penStyle?: PenStyleRef;
  /** Shared eraser sizing across pages. */
  readonly eraserStyle?: EraserStyleRef;
  /** Asset ingestion for image placement; absent disables the action. */
  readonly assets?: DocumentAssetStore | null;
  /**
   * Shared settings backing for per-tool presets.
   * Every mounted page receives the same service, so user defaults are
   * shared across pages without sharing live editor objects; new pages
   * mount with the current user preset. Absent keeps memory-only presets
   * mirrored through the shared style refs.
   */
  readonly presetSettings?: SettingsService;
  readonly stylusInput?: StylusInputPolicy;
  /** Decode override for image assets (tests); defaults to the shared decoder. */
  readonly decodeImage?: (bytes: Uint8Array) => Promise<DecodedImage | null>;
  /** Immutable PDF page-base provider; absent renders a recoverable placeholder. */
  readonly pdfProvider?: PdfProvider | null;
  readonly importPdf?: (
    notebook: NotebookModel,
    bytes: Uint8Array,
    at: number,
    selectedPageIndexes?: readonly number[],
    password?: string,
  ) => Promise<void>;
  readonly selectPdfPages?: () => Promise<readonly number[] | undefined | null>;
  readonly promptForPdfPassword?: (
    reason: 'required' | 'incorrect',
  ) => Promise<string | null>;
  /** Explicit application navigation for source PDF links. */
  readonly openExternalLink?: (url: string) => void | Promise<void>;
}

export interface NotebookPagerHandle {
  readonly root: HTMLElement;
  setReadOnly(readOnly: boolean): void;
  pageCount(): number;
  currentPageIndex(): number;
  currentPageId(): string | null;
  pageSummaries(): readonly {
    readonly id: string;
    readonly label: string;
    readonly current: boolean;
  }[];
  jumpToPage(index: number): void;
  jumpToAddress(address: string): void;
  sourceOutline(): readonly {
    readonly pageId: string;
    readonly label: string;
  }[];
  addPage(
    templateId?: string,
    afterIndex?: number,
    paper?: NotebookPaperOptions,
  ): string;
  duplicatePage(index: number): string | null;
  deletePage(index: number): boolean;
  reorderPage(from: number, to: number): void;
  setTemplate(index: number, templateId: string): void;
  setTool(toolId: string): void;
  setSourceInteractionMode(mode: PdfSourceInteractionMode): void;
  sourceInteractionMode(): PdfSourceInteractionMode;
  currentBaseKind(): 'template' | 'pdf-page' | null;
  activeToolId(): string;
  /**
   * Settled exclusive tool for toolbar reconciliation.
   * The pager has no temporary seam: manual `setTool` fans out to every
   * mounted page, so settled equals the active page's settled tool (page
   * dialect), falling back to the selected id with no page mounted.
   */
  settledActiveToolId?(): string;
  penColor(): string;
  setPenColor(color: string): void;
  penWidth(): number;
  setPenWidth(width: number): void;
  eraserRadius(): number;
  setEraserRadius(radius: number): void;
  /**
   * Current eraser preset mode for the two toolbar erasers.
   * Reads serve the active page (default when none is mounted, never
   * throws); writes fan out to every mounted page like `setEraserPreset`.
   * The single eraser engine is unchanged — this only selects which of the
   * three tools reads active.
   */
  eraserMode(): EraserMode;
  /** Fix the eraser preset mode (best-effort; engine activation follows). */
  setEraserMode(mode: EraserMode): void;
  /**
   * Preset accessors for the slice 8 settings host. Reads serve the
   * active page (defaults when none is mounted); writes fan out to all
   * mounted pages and mirror the shared style refs that seed new pages.
   */
  toolPreset(tool: InkPresetToolId): InkToolPreset;
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
  recentColors(): string[];
  eraserPreset(): EraserPreset;
  setEraserPreset(patch: Partial<EraserPreset>): void;
  lassoPreset(): LassoPreset;
  setLassoPreset(patch: Partial<LassoPreset>): void;
  gestures(): GesturePreferences;
  setGestures(patch: Partial<GesturePreferences>): void;
  selectionIds(): readonly string[];
  selectionViewportBounds(): Bounds | null;
  selectionContext(): SelectionContextSnapshot | null;
  moveSelectionBy(delta: { x: number; y: number }): string[];
  scaleSelection(factor: number): string[];
  rotateSelection(deltaRadians: number): string[];
  /**
   * Replace the focused page's ephemeral selection (never canonical, never
   * dirty, never history). Test + toolbar seam for the write path.
   */
  setSelection(ids: readonly string[]): void;
  /**
   * Grouped-text selection state for the toolbar snapshot. It is derived
   * from the focused page's records and is presentation-only. The live
   * selection is dormant (`hasText: false`) when there is no text. The write
   * path consumes the same contract.
   */
  textSelectionState(): SurfaceTextSelectionState;
  setSelectionStyle(style: SelectionStyle): string[];
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
  currentTemplate(): string;
  /**
   * Paper options of the current page (`undefined` means template
   * defaults). Slice 10 richer paper: spacing override + paper tint.
   */
  paperOptions(): NotebookPaperOptions | undefined;
  /** Replace the current page's paper options (one dirty mutation). */
  setPaperOptions(paper: NotebookPaperOptions | undefined): void;
  /**
   * Ephemeral straightedge ruler (slice 10): pager-owned like zoom,
   * forwarded to every mounted page. Never canonical, never dirty.
   */
  rulerState(): SurfaceRulerState | null;
  /** Replace the ephemeral ruler; fan-out to mounted pages, no dirty. */
  setRuler(ruler: SurfaceRulerState | null): void;
  /** Center a visible horizontal ruler on the current page. */
  centerRuler(): void;
  /** Resize the current page to a standard size preset. */
  applyPageSize(sizeId: string): boolean;
  /** Portrait/landscape the current page (swap when needed). */
  setPageOrientation(orientation: NotebookPageOrientation): boolean;
  undo(): boolean;
  redo(): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
  /**
   * Reset the stack zoom to 100%.
   *
   * Animated: seeds the single preview slot and settles via the shared
   * zoom-spring (one motion frame). `zoomFactor()` stays stale at the
   * committed value during the animation; observe the settled value via
   * `onDidChange` or the next `snapshot()` after the spring settles.
   * Reduced-motion commits instantly. Ephemeral only — never dirty.
   */
  zoomReset(): void;
  /** Committed stack zoom (stale during an animated settle; see `setZoomFactor`). */
  zoomFactor(): number;
  /**
   * Drive the stack zoom to an absolute factor: buttons/slider call this
   * with absolute slider values, not deltas.
   *
   * Animated via the single preview slot + single zoom-spring frame (same
   * path as gestures). `zoomFactor()` stays stale during the animation;
   * await the settled value via `onDidChange`/next snapshot (tests: pump
   * `frames.settle()` with the mocked timing, or real-rAF settle with the
   * default timing). Rapid scrubs coalesce: each call discards the prior
   * in-flight preview via the shared cancel path and arms one frame, so the
   * last target wins with a single commit (no stacking, no loss of the last
   * write). Reduced-motion or no-op commits instantly. Ephemeral only.
   */
  setZoomFactor(zoom: number): void;
  currentPageSize(): { width: number; height: number } | null;
  resizeCurrentPage(width: number, height: number): boolean;
  scrollByPages(delta: number): void;
  insertImageFile(file: File): Promise<void>;
  chooseImage(): void;
  canInsertImage(): boolean;
  choosePdf(position: 'before' | 'after'): void;
  canInsertPdf(): boolean;
  exportCurrentPagePng(): void;
  exportNotebookPng(): void;
  renderPageImage(
    pageId: string,
    dpi: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
  flush(): void;
  onDidChange(listener: () => void): { dispose(): void };
  destroy(): void;
}

export function mountNotebook(
  options: NotebookPagerOptions,
): NotebookPagerHandle {
  const model: NotebookModel = options.model;
  const markDirty = options.markDirty;
  // Cold-open repair: per-page decode-time bounds seeds, when
  // the session preserved them. Pages mount lazily; each consumes only
  // its own page's seeds.
  const openMetadata = options.openMetadata;
  const penStyle: PenStyleRef = options.penStyle ?? {
    color: NOTEBOOK_INK_COLORS[0],
    width: NOTEBOOK_INK_WIDTHS[1],
  };
  const eraserStyle: EraserStyleRef = options.eraserStyle ?? {
    radius: DEFAULT_ERASER_RADIUS_VIEW,
  };
  const objectRegistry: SurfaceObjectTypeRegistry =
    createDefaultSurfaceObjectTypeRegistry();
  const pendingTasks = new Set<Promise<unknown>>();
  const toolListeners = new Set<() => void>();
  /**
   * Pager-owned cancellation for long-running derived operations (PNG
   * exports). Aborted exactly once during pager destruction so in-flight
   * export work stops promptly instead of pointlessly rendering doomed
   * pages; the per-export scope below also honors an optional caller
   * signal (e.g. the editor-contract `renderPageImage` path).
   */
  const exportAbort = new AbortController();
  let notebookZoom = 1;
  let selectedToolId: string = PAGE_TOOL_IDS.pen;
  let shapeAppearance: 'fill' | 'outline' = 'fill';
  let cornerRadius = 0;
  let readOnly = false;
  /**
   * Ephemeral straightedge (slice 10): pager-owned like zoom, shared by
   * every mounted page surface. Never canonical, never dirty, never
   * history — ink drawn against it commits as ordinary strokes.
   */
  let ruler: SurfaceRulerState | null = null;

  function trackTask<T>(task: Promise<T>): Promise<T> {
    pendingTasks.add(task);
    void task.then(
      () => pendingTasks.delete(task),
      () => pendingTasks.delete(task),
    );
    return task;
  }

  /**
   * Run a derived export operation under the pager-owned cancellation
   * scope, linked with an optional caller signal. The returned signal
   * aborts when either the pager is destroyed or the caller cancels; the
   * link listeners are released when the operation settles so long-lived
   * pagers do not accumulate them.
   */
  function withExportScope<T>(
    caller: AbortSignal | undefined,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (exportAbort.signal.aborted) {
      return Promise.reject(cancelledExportError());
    }
    if (caller === undefined) return run(exportAbort.signal);
    if (caller.aborted) {
      return Promise.reject(cancelledExportError());
    }
    const linked = new AbortController();
    const onAbort = (): void => {
      try {
        linked.abort();
      } catch {
        // Aborting is best-effort; settlement paths already tolerate it.
      }
    };
    exportAbort.signal.addEventListener('abort', onAbort);
    caller.addEventListener('abort', onAbort);
    let task: Promise<T>;
    try {
      task = run(linked.signal);
    } catch (error) {
      exportAbort.signal.removeEventListener('abort', onAbort);
      caller.removeEventListener('abort', onAbort);
      throw error;
    }
    const cleanup = (): void => {
      exportAbort.signal.removeEventListener('abort', onAbort);
      caller.removeEventListener('abort', onAbort);
    };
    void task.then(cleanup, cleanup);
    return task;
  }

  const decodeImage = options.decodeImage ?? decodeImageBytes;

  function refreshMountedImages(): void {
    if (destroyed) return;
    for (const handle of mounted.values()) handle.refresh();
  }

  function requestPageImages(surface: SurfaceModel): Promise<void> {
    return trackTask(images.requestSurface(surface));
  }

  // One disposable Surface image cache per mounted editor, shared by page
  // surfaces and export rendering — the bespoke pager
  // load-map is gone in favor of `createSurfaceImageCache`.
  const images: SurfaceImageCache =
    options.assets != null
      ? createSurfaceImageCache({
          assets: options.assets,
          decode: decodeImage,
          onReady: () => void refreshMountedImages(),
        })
      : {
          resolver: new Map(),
          request: () => Promise.resolve(),
          requestSurface: () => Promise.resolve(),
          seed: () => undefined,
          dispose: () => undefined,
        };

  function resolveInternalLinkTarget(
    assetSha256: string,
    pageIndex: number,
  ): number {
    return navigablePageIds(model).findIndex((candidateId) => {
      const candidate = model.pages[candidateId];
      if (!isNavigablePage(candidate)) return false;
      const candidateBase = baseOf(candidate);
      return (
        candidateBase.kind === 'pdf-page' &&
        candidateBase.asset.sha256 === assetSha256 &&
        candidateBase.pageIndex === pageIndex
      );
    });
  }

  // --- Visible skeleton: React-owned ---
  // The stable pager chrome is committed by NotebookChrome. The engine
  // appends only engine-owned dynamic content (page shells,
  // PDF bases, empty notes) into it.
  const { root, imgInput, pdfInput, pdfImportStatus, scroll, stack } =
    options.host;

  imgInput.addEventListener('change', () => {
    const file = imgInput.files?.[0];
    if (file !== undefined)
      void api.insertImageFile(file).catch(() => undefined);
    imgInput.value = '';
  });
  let pendingPdfPosition: 'before' | 'after' = 'after';
  pdfInput.addEventListener('change', () => {
    const file = pdfInput.files?.[0];
    if (file === undefined || options.importPdf === undefined) return;
    const currentId = navigablePageIds(model)[currentPageIndex()];
    const currentOrderIndex =
      currentId === undefined
        ? model.pageOrder.length
        : model.pageOrder.indexOf(currentId);
    const at =
      pendingPdfPosition === 'before'
        ? Math.max(0, currentOrderIndex)
        : Math.max(0, currentOrderIndex + 1);
    pdfImportStatus.hidden = true;
    pdfImportStatus.textContent = '';
    trackTask(
      file
        .arrayBuffer()
        .then(async (buffer) => {
          const selectedPageIndexes = await options.selectPdfPages?.();
          if (selectedPageIndexes === null) return false;
          const bytes = new Uint8Array(buffer);
          let password: string | undefined;
          for (;;) {
            try {
              await options.importPdf!(
                model,
                bytes,
                at,
                selectedPageIndexes,
                password,
              );
              break;
            } catch (error) {
              const code =
                typeof error === 'object' && error !== null
                  ? (error as { code?: unknown }).code
                  : undefined;
              if (
                (code !== 'PDF_PASSWORD_REQUIRED' &&
                  code !== 'PDF_PASSWORD_INCORRECT') ||
                options.promptForPdfPassword === undefined
              ) {
                throw error;
              }
              const entered = await options.promptForPdfPassword(
                code === 'PDF_PASSWORD_INCORRECT' ? 'incorrect' : 'required',
              );
              if (entered === null) return false;
              password = entered;
            }
          }
          return true;
        })
        .then((imported) => {
          if (destroyed || !imported) return;
          markDirty();
          rebuildShells();
          scrollToIndex(at);
        }),
    ).catch((error: unknown) => {
      if (destroyed) return;
      const detail =
        error instanceof Error && error.message !== ''
          ? ` ${error.message}`
          : '';
      pdfImportStatus.textContent = `PDF import failed.${detail}`;
      pdfImportStatus.hidden = false;
    });
    pdfInput.value = '';
  });

  // --- Engine-owned empty note (appended into the React-owned stack) ---
  const emptyNote = document.createElement('div');
  emptyNote.className = 'fl-nb-empty';
  emptyNote.textContent = 'This notebook has no readable pages.';

  // --- Page shells & lazy mounting ---
  let shells: HTMLElement[] = [];
  const mounted = new Map<string, PageSurfaceHandle>();
  let sourceInteractionMode: PdfSourceInteractionMode = 'surface-authoring';
  let sourceOutline: readonly {
    readonly pageId: string;
    readonly label: string;
  }[] = [];
  let destroyed = false;

  const pdfBases = createPdfBaseManager({
    ...(options.assets != null ? { assets: options.assets } : {}),
    ...(options.pdfProvider != null
      ? { pdfProvider: options.pdfProvider }
      : {}),
    ...(options.promptForPdfPassword !== undefined
      ? { promptForPassword: options.promptForPdfPassword }
      : {}),
    ...(options.openExternalLink !== undefined
      ? { openExternalLink: options.openExternalLink }
      : {}),
    resolveInternalLink: resolveInternalLinkTarget,
    navigateToPageIndex: (index) => scrollToIndex(index),
    sourceInteraction: () => sourceInteractionMode === 'source-select',
    isActive: () => !destroyed,
    trackTask,
  });

  const sharedCollaboratorEnv = {
    pdfDocumentFor: (asset: StoredAsset) => pdfBases.openDocument(asset),
    isActive: () => !destroyed,
  };

  const exportEnv = {
    objectRegistry,
    imageResolver: images.resolver,
    backgroundFor,
    requestPageImages,
    ...sharedCollaboratorEnv,
  };

  const imageInsertEnv = {
    model,
    assets: options.assets,
    decode: decodeImage,
    seedImage: (path: string, image: CanvasImageSource) =>
      images.seed(path, image),
    markDirty,
    afterInsert: (pageId: string, objectId: string) => {
      mounted.get(pageId)?.refresh([objectId]);
      scheduleToolSync();
    },
    ...sharedCollaboratorEnv,
  };

  function pdfBasePages(): {
    readonly pageId: string;
    readonly asset: StoredAsset;
    readonly pageIndex: number;
  }[] {
    const pages: {
      pageId: string;
      asset: StoredAsset;
      pageIndex: number;
    }[] = [];
    for (const pageId of navigablePageIds(model)) {
      const entry = model.pages[pageId];
      if (!isNavigablePage(entry)) continue;
      const base = baseOf(entry);
      if (base.kind !== 'pdf-page') continue;
      pages.push({ pageId, asset: base.asset, pageIndex: base.pageIndex });
    }
    return pages;
  }

  function loadSourceOutline(): Promise<void> {
    return trackTask(
      pdfBases
        .loadOutline(pdfBasePages())
        .then((projected) => {
          if (destroyed) return;
          sourceOutline = projected;
          syncToolState();
        })
        .catch(() => undefined),
    );
  }

  function applySourceInteractionMode(): void {
    const selecting = sourceInteractionMode === 'source-select';
    scroll.style.touchAction = selecting ? 'pan-x pan-y' : 'none';
    for (const [pageId, surface] of mounted) {
      const entry = model.pages[pageId];
      const isPdf = isNavigablePage(entry) && baseOf(entry).kind === 'pdf-page';
      surface.root.style.pointerEvents = selecting && isPdf ? 'none' : 'auto';
      surface.setReadOnly(readOnly || (selecting && isPdf));
    }
    pdfBases.setBaseInteraction();
  }

  function basePageWidth(): number {
    const measured =
      scroll.clientWidth || scroll.getBoundingClientRect().width || 0;
    if (measured <= 0) return NOTEBOOK_MAX_PAGE_WIDTH;
    const responsiveRatio = measured <= 720 ? 0.94 : 0.86;
    return Math.min(measured * responsiveRatio, NOTEBOOK_MAX_PAGE_WIDTH);
  }

  function refreshMountedViewports(): void {
    if (destroyed) return;
    for (const handle of mounted.values()) handle.refreshViewport();
  }

  function layoutPageStack(): void {
    stack.style.setProperty('--fl-nb-zoom', String(notebookZoom));
    const width = Math.round(basePageWidth() * notebookZoom);
    for (const shell of shells) shell.style.width = `${width}px`;
    pdfBases.noteLayoutChanged((pageId) =>
      shells.find((shell) => shell.dataset.pageId === pageId),
    );
    root.dataset.zoom = String(Math.round(notebookZoom * 100));
    refreshMountedViewports();
  }

  type NotebookZoomAnchor =
    | {
        readonly kind: 'page' | 'page-gutter';
        readonly pageId: string;
        readonly u: number;
        readonly v: number;
        readonly clientX: number;
        readonly clientY: number;
      }
    | {
        readonly kind: 'stack';
        readonly u: number;
        readonly v: number;
        readonly clientX: number;
        readonly clientY: number;
      };

  function shellAcrossPoint(point: ZoomPoint): HTMLElement | null {
    const hit = document.elementFromPoint?.(point.x, point.y);
    const hitShell = hit?.closest<HTMLElement>('.fl-nb-shell');
    if (hitShell !== null && hitShell !== undefined && stack.contains(hitShell))
      return hitShell;
    let low = 0;
    let high = shells.length - 1;
    while (low <= high) {
      const index = Math.floor((low + high) / 2);
      const shell = shells[index];
      if (shell === undefined) break;
      const bounds = shell.getBoundingClientRect();
      if (point.y < bounds.top) high = index - 1;
      else if (point.y > bounds.bottom) low = index + 1;
      else return shell;
    }
    return null;
  }

  function captureZoomAnchor(point: ZoomPoint): NotebookZoomAnchor {
    // A horizontal page gutter still belongs spatially to the page crossing
    // that Y coordinate. Keep the unbounded U value so commit can center the
    // page while returning the visual difference as a residual transform;
    // the existing pan spring then carries that preview smoothly to center.
    const shell = shellAcrossPoint(point);
    if (shell !== null) {
      const bounds = shell.getBoundingClientRect();
      if (bounds.width > 0 && bounds.height > 0) {
        return {
          kind:
            point.x < bounds.left || point.x > bounds.right
              ? 'page-gutter'
              : 'page',
          pageId: shell.dataset.pageId ?? '',
          u: (point.x - bounds.left) / bounds.width,
          v: (point.y - bounds.top) / bounds.height,
          clientX: point.x,
          clientY: point.y,
        };
      }
    }
    const bounds = stack.getBoundingClientRect();
    return {
      kind: 'stack',
      u: bounds.width > 0 ? (point.x - bounds.left) / bounds.width : 0.5,
      v: bounds.height > 0 ? (point.y - bounds.top) / bounds.height : 0.5,
      clientX: point.x,
      clientY: point.y,
    };
  }

  function resolveZoomAnchor(anchor: NotebookZoomAnchor): ZoomPoint | null {
    const target =
      anchor.kind === 'page' || anchor.kind === 'page-gutter'
        ? shells.find((shell) => shell.dataset.pageId === anchor.pageId)
        : stack;
    if (target === undefined) return null;
    const bounds = target.getBoundingClientRect();
    return {
      x: bounds.left + bounds.width * anchor.u,
      y: bounds.top + bounds.height * anchor.v,
    };
  }

  function setNotebookZoom(
    requested: number,
    suppliedAnchor?: NotebookZoomAnchor,
  ): ZoomPoint {
    const next = clampNotebookZoom(notebookZoom, requested);
    const scrollRect = scroll.getBoundingClientRect();
    const anchor =
      suppliedAnchor ??
      captureZoomAnchor({
        x: scrollRect.left + (scroll.clientWidth || scrollRect.width) / 2,
        y: scrollRect.top + (scroll.clientHeight || scrollRect.height) / 2,
      });

    notebookZoom = next;
    layoutPageStack();
    const resolved = resolveZoomAnchor(anchor);
    if (resolved !== null) {
      if (anchor.kind === 'page-gutter') {
        const page = shells.find(
          (shell) => shell.dataset.pageId === anchor.pageId,
        );
        if (page !== undefined) {
          const pageBounds = page.getBoundingClientRect();
          const viewportCenterX =
            scrollRect.left + (scroll.clientWidth || scrollRect.width) / 2;
          scroll.scrollLeft +=
            pageBounds.left + pageBounds.width / 2 - viewportCenterX;
        }
      } else scroll.scrollLeft += resolved.x - anchor.clientX;
      scroll.scrollTop += resolved.y - anchor.clientY;
    }
    const corrected = resolveZoomAnchor(anchor);
    syncToolState();
    return corrected === null
      ? { x: 0, y: 0 }
      : {
          x: anchor.clientX - corrected.x,
          y: anchor.clientY - corrected.y,
        };
  }

  const navigationTouches = new Map<number, TouchContact>();
  const pagePointers = new Map<number, HTMLCanvasElement>();
  let claimedPageTouch: {
    surface: PageSurfaceHandle;
    event: PointerEvent;
  } | null = null;

  function cancelPageTouch(): PointerEvent | null {
    const claim = claimedPageTouch;
    if (claim === null) return null;
    claimedPageTouch = null;
    claim.surface.cancelTouchInteraction();
    return claim.event;
  }

  function trackPageTouch(event: PointerEvent): void {
    if (claimedPageTouch?.event.pointerId === event.pointerId)
      claimedPageTouch.event = event;
  }
  let nativePageNavigationPending = false;
  let navigationLast: ZoomPoint | null = null;
  let pinchPreview: PinchPreview | null = null;
  let pinchIds: PrimaryTouchIds | null = null;
  let pinchAnchor: NotebookZoomAnchor | null = null;
  let pinchInitialTranslation = { x: 0, y: 0 };
  let panExcess = { x: 0, y: 0 };
  let panTranslation = { x: 0, y: 0 };
  const PULL_ADD_THRESHOLD = 192;
  const pullCue = document.createElement('div');
  pullCue.className = 'fl-nb-pull-add';
  pullCue.setAttribute('role', 'status');
  pullCue.innerHTML = `
    <svg class="fl-nb-pull-add-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5m-6 6 6-6 6 6" /></svg>
    <svg class="fl-nb-pull-add-page" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8l-5-5Z" /><path d="M14 3v5h5m-7 3v6m-3-3h6" /></svg>`;
  const pullCueLabel = document.createElement('span');
  pullCueLabel.className = 'fl-nb-pull-add-label';
  pullCue.appendChild(pullCueLabel);
  pullCue.hidden = true;
  options.host.main.appendChild(pullCue);
  let armedPull: 'before' | 'after' | null = null;
  function updatePullCue(): void {
    const ids = navigablePageIds(model);
    const gestureActive = navigationTouches.size === 1 || embeddedPanActive;
    const canAdd =
      !readOnly &&
      ids.length > 0 &&
      Object.keys(model.pages).length < NOTEBOOK_LIMITS.maxPages &&
      gestureActive;
    const atTop = scroll.scrollTop <= 0;
    const atBottom =
      scroll.scrollTop >= scroll.scrollHeight - scroll.clientHeight - 1;
    const direction =
      canAdd && atTop && panExcess.y >= PULL_ADD_THRESHOLD
        ? 'before'
        : canAdd && atBottom && panExcess.y <= -PULL_ADD_THRESHOLD
          ? 'after'
          : null;
    armedPull = direction;
    const progress = Math.min(1, Math.abs(panExcess.y) / PULL_ADD_THRESHOLD);
    pullCue.hidden = !canAdd || progress === 0;
    pullCue.style.setProperty('--fl-pull-progress', String(progress));
    pullCue.dataset.armed = String(direction !== null);
    pullCue.dataset.edge = panExcess.y > 0 ? 'top' : 'bottom';
    const label =
      direction !== null
        ? 'Release to add page'
        : pullCue.hidden
          ? ''
          : '+ Add page';
    if (pullCueLabel.textContent !== label) pullCueLabel.textContent = label;
  }
  function commitPullToAdd(): boolean {
    const direction = armedPull;
    armedPull = null;
    pullCue.hidden = true;
    if (direction === null || readOnly) return false;
    const index = currentPageIndex();
    const template = api.currentTemplate();
    panVelocity.reset();
    panExcess = { x: 0, y: 0 };
    panTranslation = { x: 0, y: 0 };
    publishPanTransform();
    api.addPage(template, direction === 'before' ? -1 : index);
    return true;
  }
  const panVelocity = new VelocityTracker();
  const timing = notebookNavigationTiming(scroll);
  // Mouse/pen hand-tool drags still arrive as page-local deltas.
  let embeddedPanActive = false;
  let embeddedPanCursor = { x: 0, y: 0 };
  /** A gutter touch pair is replacing the toolbar's synthetic zoom pair. */
  let touchZoomTakeoverPending = false;
  /** Wheel previews commit after idle; finger previews commit on release. */
  let wheelZoomActive = false;
  /** Ctrl-wheel debounce: preview per tick, commit once idle.*/
  let wheelDebounce: ReturnType<typeof setTimeout> | null = null;
  const WHEEL_COMMIT_IDLE_MS = 120;
  type PagerMotion =
    | { readonly kind: 'idle' }
    | { kind: 'pan-spring'; velocityX: number; velocityY: number }
    | { kind: 'decay'; velocityX: number; velocityY: number }
    | { kind: 'zoom-spring'; velocity: number };
  let pagerMotion: PagerMotion = { kind: 'idle' };
  let motionFrame: number | null = null;
  let motionTime = 0;

  function publishPanTransform(): void {
    if (panTranslation.x === 0 && panTranslation.y === 0) {
      stack.style.transform = '';
      stack.style.transformOrigin = '';
      refreshMountedViewports();
      return;
    }
    stack.style.transformOrigin = '0px 0px';
    stack.style.transform = `translate(${panTranslation.x}px, ${panTranslation.y}px) scale(1)`;
    refreshMountedViewports();
  }

  function cancelPagerMotion(clearTranslation = true): void {
    if (motionFrame !== null) timing.cancelFrame(motionFrame);
    motionFrame = null;
    pagerMotion = { kind: 'idle' };
    if (clearTranslation) {
      panExcess = { x: 0, y: 0 };
      panTranslation = { x: 0, y: 0 };
      if (pinchPreview === null) publishPanTransform();
    } else {
      panExcess = {
        x: inverseRubberBand(panTranslation.x),
        y: inverseRubberBand(panTranslation.y),
      };
    }
  }

  /**
   *  centralized ownership: the single
   * motion-frame owner is `scheduleMotion`/`cancelPagerMotion`, the single
   * teardown owner is `cancelNavigation`. Wheel/cancel call sites reuse
   * these helpers (never redefine semantics, never add a second rAF).
   * Impossible states fail loudly in dev and self-heal without throwing.
   */
  function assertPagerNavigationInvariant(where: string): void {
    try {
      // Only a committed zoom-spring may coexist with an open preview;
      // decay/pan-spring with a preview would double-drive the transform.
      if (
        (pagerMotion.kind === 'decay' || pagerMotion.kind === 'pan-spring') &&
        pinchPreview !== null
      ) {
        console.assert(
          false,
          `[pager] ${where}: decay/spring with open pinch preview`,
        );
      }
      if (wheelZoomActive && pinchPreview === null) {
        console.assert(false, `[pager] ${where}: gutter wheel owns no preview`);
      }
      if (wheelZoomActive && pinchIds !== null) {
        console.assert(
          false,
          `[pager] ${where}: background ids with gutter-owned preview`,
        );
      }
      // Destroy owns no motion: the shared frame is cancelled, never stepped.
      if (destroyed && (motionFrame !== null || pagerMotion.kind !== 'idle')) {
        console.assert(false, `[pager] ${where}: motion after destroy`);
      }
    } catch {
      // Asserts never break teardown.
    }
  }

  function scheduleMotion(): void {
    if (motionFrame !== null || pagerMotion.kind === 'idle' || destroyed)
      return;
    motionFrame = timing.requestFrame(stepPagerMotion);
  }

  function beginPanSpring(): void {
    if (panTranslation.x === 0 && panTranslation.y === 0) return;
    if (timing.reducedMotion === true) {
      panExcess = { x: 0, y: 0 };
      panTranslation = { x: 0, y: 0 };
      publishPanTransform();
      return;
    }
    pagerMotion = { kind: 'pan-spring', velocityX: 0, velocityY: 0 };
    motionTime = timing.now();
    scheduleMotion();
  }

  function consumeScrollDelta(delta: ZoomPoint): void {
    let scrollDelta = { ...delta };
    const unwind = (excess: number, requestedScroll: number) => {
      const contentDelta = -requestedScroll;
      if (excess === 0 || Math.sign(excess) === Math.sign(contentDelta))
        return { excess, requestedScroll };
      const next = excess + contentDelta;
      if (next === 0 || Math.sign(next) !== Math.sign(excess)) {
        return { excess: 0, requestedScroll: -next };
      }
      return { excess: next, requestedScroll: 0 };
    };
    const horizontal = unwind(panExcess.x, scrollDelta.x);
    const vertical = unwind(panExcess.y, scrollDelta.y);
    panExcess = { x: horizontal.excess, y: vertical.excess };
    scrollDelta = {
      x: horizontal.requestedScroll,
      y: vertical.requestedScroll,
    };
    const before = { x: scroll.scrollLeft, y: scroll.scrollTop };
    scroll.scrollLeft += scrollDelta.x;
    scroll.scrollTop += scrollDelta.y;
    const consumed = {
      x: scroll.scrollLeft - before.x,
      y: scroll.scrollTop - before.y,
    };
    // scroll offsets can round to CSS pixels. A rounding remainder while
    // scrolling is not an elastic edge and must not stop release inertia.
    const unconsumed = (requested: number, actual: number): number => {
      const remainder = requested - actual;
      return actual !== 0 && Math.abs(remainder) < 1 ? 0 : remainder;
    };
    panExcess = {
      x: panExcess.x - unconsumed(scrollDelta.x, consumed.x),
      y: panExcess.y - unconsumed(scrollDelta.y, consumed.y),
    };
    panTranslation = {
      x: rubberBand(panExcess.x),
      y: rubberBand(panExcess.y),
    };
    publishPanTransform();
    updatePullCue();
  }

  function stepPagerMotion(timestamp: number): void {
    motionFrame = null;
    if (destroyed || pagerMotion.kind === 'idle') return;
    assertPagerNavigationInvariant('stepPagerMotion:step');
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
      // Non-finite rAF timestamps must never poison motionTime (NaN would
      // stick deltaTime and stall the single motion frame). Reuse the last
      // motionTime and reschedule without stepping; the next finite tick
      // continues the same motion (no stuck loop, no second rAF).
      scheduleMotion();
      return;
    }
    const deltaTime = Math.max(0, Math.min(timestamp - motionTime, 64));
    motionTime = timestamp;
    if (pagerMotion.kind === 'zoom-spring') {
      const preview = pinchPreview;
      if (preview === null) {
        pagerMotion = { kind: 'idle' };
        return;
      }
      const next = stepSpring(
        preview.targetZoom,
        pagerMotion.velocity,
        preview.settledZoom,
        deltaTime,
      );
      preview.targetZoom = next.value;
      preview.scale = next.value / preview.baseZoom;
      pagerMotion.velocity = next.velocity;
      stack.style.transform = `translate(${preview.translation.x}px, ${preview.translation.y}px) scale(${preview.scale})`;
      refreshMountedViewports();
      root.dataset.zoom = String(Math.round(next.value * 100));
      if (!next.active) {
        pagerMotion = { kind: 'idle' };
        finalizePinchPreview();
        return;
      }
    } else if (pagerMotion.kind === 'decay') {
      // Settle an elastic edge independently of inertia on the other axis.
      // A slightly diagonal vertical swipe must not lose its vertical fling
      // just because the fitted page has no horizontal scroll range.
      const springX =
        panTranslation.x !== 0
          ? stepSpring(panTranslation.x, pagerMotion.velocityX, 0, deltaTime)
          : null;
      const springY =
        panTranslation.y !== 0
          ? stepSpring(panTranslation.y, pagerMotion.velocityY, 0, deltaTime)
          : null;
      const next = stepDecay(
        { x: pagerMotion.velocityX, y: pagerMotion.velocityY },
        deltaTime,
      );
      consumeScrollDelta({
        x: springX === null ? -next.displacement.x : 0,
        y: springY === null ? -next.displacement.y : 0,
      });
      if (springX !== null) {
        panTranslation.x = springX.value;
        panExcess.x = inverseRubberBand(springX.value);
      }
      if (springY !== null) {
        panTranslation.y = springY.value;
        panExcess.y = inverseRubberBand(springY.value);
      }
      pagerMotion.velocityX = springX?.velocity ?? next.velocity.x;
      pagerMotion.velocityY = springY?.velocity ?? next.velocity.y;
      if (springX !== null || springY !== null) publishPanTransform();
      const activeX =
        springX?.active ??
        Math.abs(next.velocity.x) >=
          NAVIGATION_PHYSICS.decayStopVelocityPxPerMs;
      const activeY =
        springY?.active ??
        Math.abs(next.velocity.y) >=
          NAVIGATION_PHYSICS.decayStopVelocityPxPerMs;
      if (!activeX && !activeY) {
        pagerMotion = { kind: 'idle' };
        beginPanSpring();
        return;
      }
    } else {
      const x = stepSpring(
        panTranslation.x,
        pagerMotion.velocityX,
        0,
        deltaTime,
      );
      const y = stepSpring(
        panTranslation.y,
        pagerMotion.velocityY,
        0,
        deltaTime,
      );
      panTranslation = { x: x.value, y: y.value };
      pagerMotion.velocityX = x.velocity;
      pagerMotion.velocityY = y.velocity;
      publishPanTransform();
      if (!x.active && !y.active) {
        panExcess = { x: 0, y: 0 };
        pagerMotion = { kind: 'idle' };
        return;
      }
    }
    scheduleMotion();
  }

  function selectedPinchPoints(): readonly ZoomPoint[] | null {
    const pair = primaryTouchPair(navigationTouches.values(), pinchIds);
    if (pair === null) return null;
    pinchIds = [pair[0].id, pair[1].id];
    return pair;
  }

  function startPinchPreview(): void {
    const touches = selectedPinchPoints();
    if (touches === null) return;
    const scrollRect = scroll.getBoundingClientRect();
    const stackOrigin = {
      x: scrollRect.left + stack.offsetLeft - scroll.scrollLeft,
      y: scrollRect.top + stack.offsetTop - scroll.scrollTop,
    };
    pinchPreview = beginPinchPreview(notebookZoom, touches, {
      x: stackOrigin.x,
      y: stackOrigin.y,
    });
    pinchAnchor = captureZoomAnchor(pinchPreview.startCentroid);
    pinchInitialTranslation = { ...panTranslation };
    pinchPreview.baseTranslation = { ...panTranslation };
    pinchPreview.translation = { ...panTranslation };
  }

  function updatePinchPreview(): void {
    const preview = pinchPreview;
    if (preview === null) return;
    const touches = selectedPinchPoints();
    if (touches === null) return;
    const stepped = stepPinchPreview(preview, touches);
    preview.targetZoom = stepped.targetZoom;
    preview.scale = stepped.scale;
    preview.translation = stepped.translation;
    stack.style.transformOrigin = `${preview.point.x}px ${preview.point.y}px`;
    stack.style.transform = `translate(${stepped.translation.x}px, ${stepped.translation.y}px) scale(${stepped.scale})`;
    refreshMountedViewports();
    root.dataset.zoom = String(Math.round(stepped.targetZoom * 100));
  }

  function finalizePinchPreview(): void {
    const preview = pinchPreview;
    if (preview === null) return;
    pinchPreview = null;
    pinchIds = null;
    touchZoomTakeoverPending = false;
    wheelZoomActive = false;
    stack.style.transform = '';
    stack.style.transformOrigin = '';
    const anchor = pinchAnchor;
    pinchAnchor = null;
    const residual = setNotebookZoom(
      preview.settledZoom,
      anchor === null
        ? undefined
        : {
            ...anchor,
            clientX:
              anchor.clientX +
              preview.translation.x -
              pinchInitialTranslation.x,
            clientY:
              anchor.clientY +
              preview.translation.y -
              pinchInitialTranslation.y,
          },
    );
    panExcess = residual;
    panTranslation = residual;
    pinchInitialTranslation = { x: 0, y: 0 };
    publishPanTransform();
    if (navigationTouches.size === 0) beginPanSpring();
    if (!destroyed) reconcileVisibilityAfterPinch();
  }

  function commitPinchPreview(): void {
    const preview = pinchPreview;
    if (preview === null) return;
    pinchIds = null;
    if (
      timing.reducedMotion !== true &&
      navigationTouches.size === 0 &&
      Math.abs(preview.targetZoom - preview.settledZoom) > 0.000_001
    ) {
      // Single motion frame: interrupt any prior synthetic motion from the
      // current visual position before arming the zoom-spring (no double
      // rAF — the old frame is cancelled, the new one scheduled).
      if (pagerMotion.kind !== 'idle') cancelPagerMotion(false);
      pagerMotion = { kind: 'zoom-spring', velocity: 0 };
      motionTime = timing.now();
      scheduleMotion();
      return;
    }
    finalizePinchPreview();
  }

  function clearWheelDebounce(): void {
    if (wheelDebounce !== null) {
      clearTimeout(wheelDebounce);
      wheelDebounce = null;
    }
  }

  function scheduleWheelCommit(): void {
    clearWheelDebounce();
    wheelDebounce = setTimeout(() => {
      wheelDebounce = null;
      if (destroyed) return;
      if (pinchPreview === null) {
        wheelZoomActive = false;
        return;
      }
      commitPinchPreview();
    }, WHEEL_COMMIT_IDLE_MS);
  }

  /** Wheel input supplies a centroid and factors rather than a touch pair. */
  function startWheelZoomPreview(clientPoint: ZoomPoint): void {
    if (destroyed || pinchPreview !== null) return;
    if (sourceInteractionMode === 'source-select') return;
    if (
      typeof clientPoint.x !== 'number' ||
      typeof clientPoint.y !== 'number' ||
      !Number.isFinite(clientPoint.x) ||
      !Number.isFinite(clientPoint.y)
    ) {
      return;
    }
    // Preserve an in-flight touch pinch: a background pair owns the slot.
    if (pinchIds !== null || navigationTouches.size > 0) return;
    if (pagerMotion.kind !== 'idle') cancelPagerMotion(false);
    // Wheel input interrupts a released page pan.
    if (embeddedPanActive) {
      embeddedPanActive = false;
      embeddedPanCursor = { x: 0, y: 0 };
      panVelocity.reset();
    }
    const half = 25;
    const synthetic: ZoomPoint[] = [
      { x: clientPoint.x - half, y: clientPoint.y },
      { x: clientPoint.x + half, y: clientPoint.y },
    ];
    const scrollRect = scroll.getBoundingClientRect();
    const stackOrigin = {
      x: scrollRect.left + stack.offsetLeft - scroll.scrollLeft,
      y: scrollRect.top + stack.offsetTop - scroll.scrollTop,
    };
    pinchPreview = beginPinchPreview(notebookZoom, synthetic, stackOrigin);
    pinchAnchor = captureZoomAnchor({
      x: clientPoint.x,
      y: clientPoint.y,
    });
    pinchInitialTranslation = { ...panTranslation };
    pinchPreview.baseTranslation = { ...panTranslation };
    pinchPreview.translation = { ...panTranslation };
    wheelZoomActive = true;
    assertPagerNavigationInvariant('startGutterPinch');
  }

  function handleWheelZoom(factor: number, point: ZoomPoint): void {
    if (destroyed) return;
    if (sourceInteractionMode === 'source-select') return;
    const safeFactor =
      typeof factor === 'number' && Number.isFinite(factor) && factor > 0
        ? factor
        : 1;
    if (safeFactor === 1) return;
    if (
      pinchPreview === null &&
      ((notebookZoom <= NOTEBOOK_MIN_ZOOM && safeFactor < 1) ||
        (notebookZoom >= NOTEBOOK_MAX_ZOOM && safeFactor > 1))
    ) {
      return;
    }
    if (
      typeof point.x !== 'number' ||
      typeof point.y !== 'number' ||
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y)
    ) {
      return;
    }
    if (pinchPreview === null) {
      startWheelZoomPreview(point);
      if (pinchPreview === null) return;
    } else if (!wheelZoomActive) {
      // Fingers and toolbar animations keep their current preview.
      return;
    }
    // Single motion frame: an owned gutter step interrupts any synthetic
    // motion (decay/pan-spring/zoom-spring) from the current visual
    // position before writing the shared preview.
    if (pagerMotion.kind !== 'idle') cancelPagerMotion(false);
    const preview = pinchPreview;
    if (preview === null) return;
    const stepped = stepPinchPreviewWithFactor(preview, safeFactor, {
      x: 0,
      y: 0,
    });
    preview.targetZoom = stepped.targetZoom;
    preview.scale = stepped.scale;
    preview.translation = stepped.translation;
    stack.style.transformOrigin = `${preview.point.x}px ${preview.point.y}px`;
    stack.style.transform = `translate(${stepped.translation.x}px, ${stepped.translation.y}px) scale(${stepped.scale})`;
    refreshMountedViewports();
    root.dataset.zoom = String(Math.round(stepped.targetZoom * 100));
    scheduleWheelCommit();
  }

  function handleEmbeddedPan(delta: { x: number; y: number }): void {
    if (destroyed) return;
    if (sourceInteractionMode === 'source-select') return;
    const dx =
      typeof delta.x === 'number' && Number.isFinite(delta.x) ? delta.x : 0;
    const dy =
      typeof delta.y === 'number' && Number.isFinite(delta.y) ? delta.y : 0;
    if (dx === 0 && dy === 0) return;
    if (navigationTouches.size > 0 || pinchPreview !== null) return;
    if (pagerMotion.kind !== 'idle') cancelPagerMotion(false);
    if (!embeddedPanActive) {
      embeddedPanActive = true;
      embeddedPanCursor = { x: 0, y: 0 };
      panVelocity.reset();
      panVelocity.add(timing.now(), { ...embeddedPanCursor });
    }
    embeddedPanCursor = {
      x: embeddedPanCursor.x - dx,
      y: embeddedPanCursor.y - dy,
    };
    panVelocity.add(timing.now(), { ...embeddedPanCursor });
    consumeScrollDelta({ x: dx, y: dy });
  }

  function releasePan(velocity: ZoomPoint): void {
    // Velocity on an overscrolled axis belongs to the edge, not a fling.
    const freeVelocity = {
      x: panTranslation.x === 0 ? velocity.x : 0,
      y: panTranslation.y === 0 ? velocity.y : 0,
    };
    if (
      timing.reducedMotion !== true &&
      Math.hypot(freeVelocity.x, freeVelocity.y) >=
        NAVIGATION_PHYSICS.decayStopVelocityPxPerMs
    ) {
      pagerMotion = {
        kind: 'decay',
        velocityX: freeVelocity.x,
        velocityY: freeVelocity.y,
      };
      motionTime = timing.now();
      scheduleMotion();
    } else beginPanSpring();
  }

  function handleEmbeddedPanEnd(): void {
    if (destroyed || !embeddedPanActive) return;
    embeddedPanActive = false;
    const velocity = panVelocity.velocityAt(timing.now(), embeddedPanCursor);
    panVelocity.reset();
    if (commitPullToAdd()) return;
    releasePan(velocity);
  }

  function consumePlainWheel(): void {
    if (pinchPreview !== null) return;
    // Defensive: a stale gutter flag with no preview must never survive to
    // steal the next preview (single-commit invariant).
    if (wheelZoomActive) wheelZoomActive = false;
    clearWheelDebounce();
    if (embeddedPanActive) {
      embeddedPanActive = false;
      panVelocity.reset();
    }
    if (pagerMotion.kind === 'decay' || pagerMotion.kind === 'pan-spring')
      cancelPagerMotion(false);
  }

  function handleEmbeddedCancel(): void {
    if (destroyed || !embeddedPanActive) return;
    embeddedPanActive = false;
    if (navigationTouches.size === 0 && pinchPreview === null)
      cancelNavigation();
  }

  function cancelNavigation(): void {
    cancelPageTouch();
    const capturedIds = [...navigationTouches.keys()];
    navigationTouches.clear();
    for (const pointerId of capturedIds) {
      try {
        if (scroll.hasPointerCapture?.(pointerId))
          scroll.releasePointerCapture?.(pointerId);
      } catch {
        // Capture may already have been released by the browser.
      }
    }
    clearWheelDebounce();
    cancelPagerMotion();
    navigationLast = null;
    panVelocity.reset();
    pinchPreview = null;
    pinchIds = null;
    pinchAnchor = null;
    pinchInitialTranslation = { x: 0, y: 0 };
    embeddedPanActive = false;
    embeddedPanCursor = { x: 0, y: 0 };
    touchZoomTakeoverPending = false;
    wheelZoomActive = false;
    armedPull = null;
    pullCue.hidden = true;
    stack.style.transform = '';
    stack.style.transformOrigin = '';
    root.dataset.zoom = String(Math.round(notebookZoom * 100));
    refreshMountedViewports();
    // Full abort discards without commit: never apply transform-polluted IO
    // entries. Clears even when destroyed (no rearm after destroy).
    discardSuppressedVisibilityAndRearm();
    // post-conditions: 0 frames,
    // idle motion, no preview, clean transform, no embedded ownership —
    // single commit preserved (never finalize here).
    assertPagerNavigationInvariant('cancelNavigation');
  }

  function commitSettledZoom(requested: number, point?: ZoomPoint): void {
    if (destroyed) return;
    const target = clampNotebookZoom(notebookZoom, requested);
    // Reduced-motion or no-op: instant settled commit, zero residual frames
    // (ephemeral only — never markDirty/history/persist).
    if (
      timing.reducedMotion === true ||
      Math.abs(target - notebookZoom) < 0.000_001
    ) {
      cancelNavigation();
      const anchor = point === undefined ? undefined : captureZoomAnchor(point);
      setNotebookZoom(target, anchor);
      return;
    }
    // Animated settled zoom: buttons/slider drive the
    // same single preview slot + single motion frame as gestures. Capture a
    // viewport-center (or supplied-point) anchor via the unified
    // capture/resolve path, seed a synthetic preview so `transformOrigin`
    // aligns with commit anchor math, then settle via the shared
    // zoom-spring. Outside-page stack anchors commit through the same
    // finalize path, whose scroll-clamp residual springs back as a smooth
    // animated recenter (no hard cut). Interrupts any in-flight gesture
    // (button overrides) without a second rAF.
    cancelNavigation();
    const scrollRect = scroll.getBoundingClientRect();
    const viewportCenter: ZoomPoint = {
      x: scrollRect.left + (scroll.clientWidth || scrollRect.width) / 2,
      y: scrollRect.top + (scroll.clientHeight || scrollRect.height) / 2,
    };
    const anchorPoint =
      point !== undefined &&
      typeof point.x === 'number' &&
      typeof point.y === 'number' &&
      Number.isFinite(point.x) &&
      Number.isFinite(point.y)
        ? point
        : viewportCenter;
    const anchor = captureZoomAnchor(anchorPoint);
    const half = 25;
    const synthetic: ZoomPoint[] = [
      { x: anchorPoint.x - half, y: anchorPoint.y },
      { x: anchorPoint.x + half, y: anchorPoint.y },
    ];
    const stackOrigin = {
      x: scrollRect.left + stack.offsetLeft - scroll.scrollLeft,
      y: scrollRect.top + stack.offsetTop - scroll.scrollTop,
    };
    pinchPreview = beginPinchPreview(notebookZoom, synthetic, stackOrigin);
    pinchAnchor = anchor;
    pinchInitialTranslation = { ...panTranslation };
    pinchPreview.baseTranslation = { ...panTranslation };
    pinchPreview.translation = { ...panTranslation };
    // Button target is already settled (clamped); the spring animates the
    // visual target toward it. No wheel-ownership flag: wheel ticks
    // preserve this preview, a new touch takes it over via rebase.
    pinchPreview.settledZoom = target;
    pinchIds = null;
    stack.style.transformOrigin = `${pinchPreview.point.x}px ${pinchPreview.point.y}px`;
    stack.style.transform = `translate(${pinchPreview.translation.x}px, ${pinchPreview.translation.y}px) scale(${pinchPreview.scale})`;
    refreshMountedViewports();
    root.dataset.zoom = String(Math.round(pinchPreview.targetZoom * 100));
    pagerMotion = { kind: 'zoom-spring', velocity: 0 };
    motionTime = timing.now();
    scheduleMotion();
    assertPagerNavigationInvariant('commitSettledZoom:animate');
  }

  function isPdfSourceSelectionTarget(target: EventTarget | null): boolean {
    return (
      sourceInteractionMode === 'source-select' &&
      target instanceof Element &&
      target.closest('.fl-pdf-text-layer') !== null
    );
  }

  /**
   * `scrollIntoView({ behavior: 'smooth' })` can still be moving a page after
   * visibility tracking has made its canvas interactive. Freeze that one
   * programmatic scroll in the capture phase so Surface samples every point from
   * the same canvas geometry. The event continues unchanged to mouse, pen,
   * and touch authoring/navigation owners.
   */
  function stopPageNavigationBeforeCanvasInput(event: PointerEvent): void {
    // Focused Surface editors and their controls keep native input ownership.
    if (
      event.target instanceof Element &&
      event.target.closest(
        'input, textarea, select, button, [contenteditable="true"]',
      ) !== null
    )
      return;
    if (
      event.pointerType === 'touch' &&
      claimedPageTouch !== null &&
      claimedPageTouch.event.pointerId !== event.pointerId
    ) {
      const previous = cancelPageTouch();
      if (previous !== null) onNavigationPointerDown(previous);
    }
    const canvasTarget =
      event.target instanceof HTMLCanvasElement &&
      event.target.classList.contains('fl-ink-canvas');
    if (canvasTarget && nativePageNavigationPending) {
      nativePageNavigationPending = false;
      scroll.scrollTo({
        left: scroll.scrollLeft,
        top: scroll.scrollTop,
        behavior: 'auto',
      });
    }
    if (canvasTarget && event.pointerType !== 'touch') {
      cancelPageTouch();
      pagePointers.set(event.pointerId, event.target as HTMLCanvasElement);
      if (navigationTouches.size > 0) cancelNavigation();
    }
    if (
      event.pointerType !== 'touch' ||
      navigationTouches.size > 0 ||
      pagePointers.size > 0 ||
      sourceInteractionMode !== 'surface-authoring'
    )
      return;
    const targetSurface = canvasTarget
      ? [...mounted.values()].find((surface) =>
          surface.root.contains(event.target as Node),
        )
      : undefined;
    let dismissedElsewhere = false;
    for (const surface of mounted.values()) {
      if (surface === targetSurface || surface.selectionIds().length === 0)
        continue;
      surface.setSelection([]);
      dismissedElsewhere = true;
    }
    // Surface owns hit testing, dismissal and the ephemeral drag. The pager
    // retains every other touch, including a down outside another page's selection.
    if (!dismissedElsewhere && targetSurface?.claimTouchInteraction(event))
      claimedPageTouch = { surface: targetSurface, event };
  }

  function onPagePointerEnd(event: PointerEvent): void {
    if (claimedPageTouch?.event.pointerId === event.pointerId)
      claimedPageTouch = null;
    pagePointers.delete(event.pointerId);
  }

  function onNavigationPointerDown(event: PointerEvent): void {
    if (
      event.pointerType !== 'touch' ||
      pagePointers.size > 0 ||
      claimedPageTouch?.event.pointerId === event.pointerId
    )
      return;
    if (
      typeof event.clientX !== 'number' ||
      typeof event.clientY !== 'number' ||
      !Number.isFinite(event.clientX) ||
      !Number.isFinite(event.clientY)
    ) {
      return;
    }
    if (
      sourceInteractionMode === 'source-select' &&
      event.target instanceof Element &&
      event.target.closest('.fl-ps') !== null
    )
      return;
    if (isPdfSourceSelectionTarget(event.target)) {
      cancelNavigation();
      return;
    }
    if (wheelZoomActive) return;
    embeddedPanActive = false;
    if (pagerMotion.kind === 'zoom-spring' && pinchPreview !== null) {
      touchZoomTakeoverPending = true;
    }
    if (pagerMotion.kind !== 'idle') {
      cancelPagerMotion(false);
    }
    event.preventDefault();
    scroll.setPointerCapture?.(event.pointerId);
    navigationTouches.set(event.pointerId, {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    });
    if (navigationTouches.size === 1) {
      navigationLast = { x: event.clientX, y: event.clientY };
      panVelocity.reset();
      panVelocity.add(timing.now(), navigationLast);
    } else if (navigationTouches.size === 2) {
      if (pinchPreview === null) startPinchPreview();
      else {
        const touches = selectedPinchPoints();
        if (touches !== null) {
          if (touchZoomTakeoverPending) {
            // The toolbar preview captured the viewport center. Once real
            // fingers take over, commit against their page point instead;
            // retaining the synthetic anchor makes the page jump on lift.
            pinchAnchor = captureZoomAnchor(touchCentroid(touches));
            pinchInitialTranslation = { ...pinchPreview.translation };
            touchZoomTakeoverPending = false;
          }
          rebasePinchPreview(pinchPreview, touches);
        }
      }
      panVelocity.reset();
    }
  }

  function onNavigationPointerMove(event: PointerEvent): void {
    if (!navigationTouches.has(event.pointerId)) return;
    if (
      typeof event.clientX !== 'number' ||
      typeof event.clientY !== 'number' ||
      !Number.isFinite(event.clientX) ||
      !Number.isFinite(event.clientY)
    ) {
      return;
    }
    if (wheelZoomActive) return;
    event.preventDefault();
    navigationTouches.set(event.pointerId, {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
    });
    if (navigationTouches.size >= 2) {
      if (pinchPreview === null) startPinchPreview();
      updatePinchPreview();
      return;
    }
    const contact = navigationTouches.values().next().value as
      | TouchContact
      | undefined;
    if (contact === undefined) return;
    const next = { x: contact.x, y: contact.y };
    if (pinchPreview !== null) {
      if (navigationLast !== null) {
        pinchPreview.translation = {
          x: pinchPreview.translation.x + next.x - navigationLast.x,
          y: pinchPreview.translation.y + next.y - navigationLast.y,
        };
        pinchPreview.baseTranslation = pinchPreview.translation;
        stack.style.transform = `translate(${pinchPreview.translation.x}px, ${pinchPreview.translation.y}px) scale(${pinchPreview.scale})`;
        refreshMountedViewports();
      }
      navigationLast = next;
      return;
    }
    if (navigationLast !== null) {
      consumeScrollDelta({
        x: navigationLast.x - next.x,
        y: navigationLast.y - next.y,
      });
    }
    navigationLast = next;
    panVelocity.add(timing.now(), next);
  }

  function onNavigationPointerEnd(event: PointerEvent): void {
    if (!navigationTouches.delete(event.pointerId)) return;
    if (wheelZoomActive) return;
    const wasPinching = pinchPreview !== null;
    if (pinchPreview !== null) {
      const pair = primaryTouchPair(navigationTouches.values(), pinchIds);
      if (pair === null) {
        if (navigationTouches.size === 0) commitPinchPreview();
      } else {
        pinchIds = [pair[0].id, pair[1].id];
        rebasePinchPreview(pinchPreview, pair);
      }
    }
    const contact = navigationTouches.values().next().value as
      | TouchContact
      | undefined;
    navigationLast =
      navigationTouches.size === 1 && contact !== undefined
        ? { x: contact.x, y: contact.y }
        : null;
    if (navigationLast !== null) {
      panVelocity.reset();
      panVelocity.add(timing.now(), navigationLast);
    } else if (pinchPreview === null && !wasPinching) {
      if (commitPullToAdd()) return;
      const velocity = panVelocity.velocityAt(timing.now(), {
        x: event.clientX,
        y: event.clientY,
      });
      panVelocity.reset();
      releasePan(velocity);
    }
  }

  function onNavigationPointerCancel(event: PointerEvent): void {
    if (!navigationTouches.has(event.pointerId)) return;
    cancelNavigation();
  }

  /**
   * Background capture loss: the browser took capture, so
   * legalize like a release instead of discarding — rebase a surviving
   * pinch pair, commit the last finger once, or arm decay/spring for a pan.
   * Reuses the single `onNavigationPointerEnd` path (no forked physics, no
   * second rAF). Split: cancel=discard, lost=legalize, wheel=preserve.
   */
  function onNavigationLostCapture(event: PointerEvent): void {
    // A page's capture loss bubbles here during Surface → pager takeover.
    // Only loss of the pager's own capture ends its navigation contact.
    if (event.target !== scroll || !navigationTouches.has(event.pointerId))
      return;
    onNavigationPointerEnd(event);
  }

  const suppressedVisibility = new Map<HTMLElement, boolean>();
  // Prepare the next page while it is still below the fold, then keep nearby
  // pages warm while scrolling. The observer releases pages outside this
  // bounded buffer so long notebooks do not retain every editor surface.
  const shellObserver =
    typeof IntersectionObserver === 'function'
      ? new IntersectionObserver(
          (entries) => {
            if (destroyed) return;
            if (pinchPreview !== null) {
              for (const entry of entries)
                suppressedVisibility.set(
                  entry.target as HTMLElement,
                  entry.isIntersecting,
                );
              return;
            }
            for (const entry of entries) {
              const pageId = (entry.target as HTMLElement).dataset.pageId;
              if (pageId === undefined) continue;
              if (entry.isIntersecting)
                mountPage(pageId, entry.target as HTMLElement);
              else unmountPage(pageId);
            }
          },
          {
            root: scroll,
            // IO percentages are based on root width even on the vertical
            // axis. Use the actual viewport height for portrait phones.
            rootMargin: `${Math.max(scroll.clientHeight, 1)}px 0px`,
          },
        )
      : null;

  function reconcileVisibilityAfterPinch(): void {
    if (shellObserver === null) {
      refreshFallbackVisiblePage();
      return;
    }
    for (const [shell, isIntersecting] of suppressedVisibility) {
      const pageId = shell.dataset.pageId;
      if (pageId === undefined) continue;
      if (isIntersecting) mountPage(pageId, shell);
      else unmountPage(pageId);
    }
    suppressedVisibility.clear();
    // Re-arm every persistent shell so IntersectionObserver reports current
    // post-layout visibility without synchronous per-page geometry reads.
    for (const shell of shells) {
      shellObserver.unobserve(shell);
      shellObserver.observe(shell);
    }
  }

  /**
   * Discard IO entries suppressed during a pinch when the preview is
   * cancelled/destroyed without commit (never apply transform-polluted
   * entries). Re-arms persistent shells so the next report is fresh; the
   * next pinch reconcile therefore never sees stale entries and rebuilds
   * never retain detached shell refs.
   */
  function discardSuppressedVisibilityAndRearm(): void {
    if (suppressedVisibility.size === 0) return;
    suppressedVisibility.clear();
    if (shellObserver !== null && !destroyed) {
      for (const shell of shells) {
        shellObserver.unobserve(shell);
        shellObserver.observe(shell);
      }
    }
  }

  const layoutObserver =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => layoutPageStack())
      : null;
  layoutObserver?.observe(scroll);

  function frameSizeOf(
    entry: NotebookModel['pages'][string],
  ): { width: number; height: number } | null {
    return isNavigablePage(entry) ? frameBounds(entry.surface.frame) : null;
  }

  function backgroundFor(pageId: string): () => readonly DrawItem[] {
    return () => {
      const entry = model.pages[pageId];
      if (!isNavigablePage(entry)) return [];
      const size = frameBounds(entry.surface.frame);
      if (size === null) return [];
      return templateBackgroundDrawItems(
        templateOf(entry),
        size.width,
        size.height,
        paperOptionsOf(entry),
      );
    };
  }

  function renderPageImage(
    pageId: string,
    dpi: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    return withExportScope(signal, (scope) =>
      renderNotebookPageImage(exportEnv, model, pageId, dpi, scope),
    );
  }

  /**
   * Effective mount seeds for one page: decode-time seeds
   * resolved through the derived reopen cache when the provider supplied
   * one with a document identity. Valid cache entries win; decode seeds
   * fill gaps and backfill. Any missing piece falls back to decode seeds
   * (or null) — mounting never depends on the cache.
   */
  /**
   * Session-owned content revision for derived-cache validation: read LIVE
   * when the provider supplied accessors, computed once
   * when bytes enter the session layer otherwise. Null when unavailable
   * (cache unusable).
   */
  function pageRevision(): string | null {
    const live = options.derivedSession;
    if (live !== undefined) {
      try {
        const revision = live.getContentRevision();
        return typeof revision === 'string' && revision.length > 0
          ? revision
          : null;
      } catch {
        return null;
      }
    }
    if (openMetadata === undefined) return null;
    return contentRevisionFromOpenMetadata(openMetadata);
  }

  /** Live dirty probe; a throwing accessor fails closed (cache off). */
  function pageDirty(): boolean {
    const live = options.derivedSession;
    if (live === undefined) return false;
    try {
      return live.isDirty();
    } catch {
      return true;
    }
  }

  function resolvePageSeeds(
    pageId: string,
    pageSeeds: ReadonlyMap<string, Bounds | null> | null,
  ): ReadonlyMap<string, Bounds | null> | null {
    if (pageSeeds === null) return null;
    const store = options.derivedStore;
    const documentId = options.documentId;
    if (store === undefined || documentId === undefined) return pageSeeds;
    // Dirty session: decode seeds describe the last saved bytes, not the
    // in-memory page. Derive normally instead of trusting them.
    if (pageDirty()) return null;
    const revision = pageRevision();
    if (revision === null) return pageSeeds;
    try {
      const cache = store.acquire(documentId, revision);
      const resolved = resolveReopenSeeds({
        documentId,
        revision,
        decodeSeeds: pageSeeds,
        cache,
      });
      // Seed backfill is queued, never awaited: page mounts stay light.
      store.persist(documentId);
      return resolved.seeds;
    } catch {
      return pageSeeds;
    }
  }

  function mountPage(pageId: string, host: HTMLElement): void {
    if (destroyed || mounted.has(pageId) || !scroll.contains(host)) return;
    const entry = model.pages[pageId];
    if (!isNavigablePage(entry)) return;
    const base = baseOf(entry);
    if (base.kind === 'pdf-page') {
      pdfBases.mountBase(pageId, host, {
        asset: base.asset,
        pageIndex: base.pageIndex,
        pageBox: base.pageBox,
      });
    }
    void requestPageImages(entry.surface);
    // Engine-owned dynamic page content: page shells
    // are created lazily by the pager as the user scrolls — React owns only
    // the stable pager chrome (root/main/scroll/stack/thumbs), never the
    // per-page lifecycle. The embedded ink nodes below are therefore built
    // imperatively inside the engine-owned shell and handed to the shared
    // surface engine via `host`. This is the deliberate, documented
    // exception for dynamically created notebook pages; it must not be used
    // for stable chrome.
    const transparentBase = baseOf(entry).kind === 'pdf-page';
    const inkSkeleton: InkSkeleton = createPageInkHost(host, transparentBase);
    // Cold-open repair: this page's decode-time bounds
    // seed the mounted surface without rescanning its samples. Absent
    // after edits (new pages, reloaded models) — the mount then derives
    // normally. With a derived store, valid cache entries win and decode
    // seeds backfill for the next open.
    const pageSeeds =
      openMetadata !== undefined
        ? pageSeedBoundsFromOpenMetadata(openMetadata, pageId)
        : null;
    const seedBounds = resolvePageSeeds(pageId, pageSeeds);
    // Page-scoped derived identity for packed-vector restore: object ids
    // are page-local, so the page joins the notebook identity (bounds
    // seeding above keeps its coarser document scope). The binding reads
    // the LIVE session revision/dirty contract at restore/persist time.
    const pageDocumentId =
      options.documentId !== undefined
        ? `${options.documentId}/${pageId}`
        : null;
    const pageBinding: SurfaceReopenBinding | null =
      options.derivedStore !== undefined && pageDocumentId !== null
        ? {
            store: options.derivedStore,
            documentId: pageDocumentId,
            getContentRevision: () => pageRevision(),
            isDirty: () => pageDirty(),
          }
        : null;
    const handle = mountPageSurface({
      model: entry.surface,
      markDirty,
      host: inkSkeleton,
      stylusInput: options.stylusInput,
      readOnly,
      renderViewport: scroll,
      ...(seedBounds !== null ? { seedBounds } : {}),
      ...(pageBinding !== null ? { reopen: pageBinding } : {}),
      penStyle,
      eraserStyle,
      ...(options.presetSettings !== undefined
        ? { presetSettings: options.presetSettings }
        : {}),
      backgroundItems: backgroundFor(pageId),
      transparentBase,
      imageResolver: images.resolver,
      initialTool: selectedToolId,
      ...(ruler !== null ? { ruler } : {}),
      onPageStackPan: (delta) => {
        handleEmbeddedPan(delta);
      },
      onPageStackPanEnd: handleEmbeddedPanEnd,
      onPageStackCancel: () => {
        handleEmbeddedCancel();
      },
    });
    handle.setReadOnly(readOnly);
    handle.setShapeAppearance(shapeAppearance);
    handle.setCornerRadius(cornerRadius);
    handle.onDidChange(() => {
      scheduleToolSync();
    });
    handle.root.style.position = 'absolute';
    handle.root.style.inset = '0';
    handle.root.style.zIndex = '1';
    mounted.set(pageId, handle);
    applySourceInteractionMode();
  }

  function unmountPage(pageId: string): void {
    pdfBases.unmountBase(pageId);
    const handle = mounted.get(pageId);
    if (handle !== undefined) {
      if (claimedPageTouch?.surface === handle) cancelPageTouch();
      for (const [pointerId, canvas] of pagePointers) {
        if (handle.root.contains(canvas)) pagePointers.delete(pointerId);
      }
      handle.destroy();
      mounted.delete(pageId);
    }
  }

  function rebuildShells(): void {
    const ids = navigablePageIds(model);
    for (const key of [...mounted.keys()]) unmountPage(key);
    for (const shell of shells) shellObserver?.unobserve(shell);
    // Old shells are detached: drop any suppressed IO refs so the next
    // pinch reconcile never applies stale entries.
    suppressedVisibility.clear();
    stack.replaceChildren();
    shells = [];
    if (ids.length === 0) {
      stack.appendChild(emptyNote);
      scheduleToolSync();
      return;
    }
    // Engine-owned dynamic page shells: pages are
    // created, destroyed, and reordered as the model changes and the user
    // scrolls — React owns only the stable pager chrome and never the
    // per-page lifecycle. Per-page aspect comes from canonical frame data
    // at creation time, so it stays an inline style.
    ids.forEach((id) => {
      const size = frameSizeOf(model.pages[id]) ?? {
        width: 1240,
        height: 1754,
      };
      const shell = document.createElement('figure');
      shell.className = 'fl-nb-shell';
      shell.style.aspectRatio = `${size.width} / ${size.height}`;
      shell.dataset.pageId = id;

      stack.appendChild(shell);
      shells.push(shell);
    });
    layoutPageStack();
    if (shellObserver === null) refreshFallbackVisiblePage();
    else for (const shell of shells) shellObserver.observe(shell);
    scheduleToolSync();
  }

  function refreshFallbackVisiblePage(): void {
    if (shellObserver !== null || shells.length === 0) return;
    const current = currentPageIndex();
    shells.forEach((shell, index) => {
      const pageId = shell.dataset.pageId;
      if (pageId === undefined) return;
      if (index === current) mountPage(pageId, shell);
      else unmountPage(pageId);
    });
  }

  function currentPageIndex(): number {
    const ids = navigablePageIds(model);
    if (ids.length === 0) return 0;
    const viewTop = scroll.getBoundingClientRect().top;
    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    shells.forEach((shell, index) => {
      const rect = shell.getBoundingClientRect();
      const distance = Math.abs(rect.top - viewTop);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = index;
      }
    });
    return Math.min(best, ids.length - 1);
  }

  function activeHandle(): PageSurfaceHandle | null {
    const ids = navigablePageIds(model);
    return mounted.get(ids[currentPageIndex()] ?? '') ?? null;
  }

  function scrollToIndex(index: number): void {
    const clamped = Math.max(0, Math.min(shells.length - 1, index));
    const shell = shells[clamped];
    if (shell === undefined || typeof shell.scrollIntoView !== 'function')
      return;
    nativePageNavigationPending = true;
    shell.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function scheduleToolSync(): void {
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        if (!destroyed) syncToolState();
      });
    } else {
      syncToolState();
    }
  }

  function syncToolState(): void {
    const current = currentPageIndex();
    shells.forEach((shell, index) => {
      shell.dataset.current = String(index === current);
    });
    for (const listener of toolListeners) listener();
  }

  function insertAfterNavigableIndex(id: string, index: number): void {
    const ids = navigablePageIds(model);
    const anchorId = ids[index];
    const anchorIndex =
      anchorId === undefined ? -1 : model.pageOrder.indexOf(anchorId);
    model.pageOrder.splice(
      index < 0
        ? 0
        : anchorIndex === -1
          ? model.pageOrder.length
          : anchorIndex + 1,
      0,
      id,
    );
  }

  // --- Public API ---
  const api: NotebookPagerHandle = {
    root,
    setReadOnly(value) {
      cancelNavigation();
      readOnly = value;
      root.dataset.readOnly = String(value);
      applySourceInteractionMode();
    },
    pageCount: () => navigablePageIds(model).length,
    currentPageIndex,
    currentPageId: () => navigablePageIds(model)[currentPageIndex()] ?? null,
    pageSummaries: () =>
      navigablePageIds(model).map((id, index) => ({
        id,
        label: `Page ${index + 1}`,
        current: index === currentPageIndex(),
      })),
    jumpToPage(index) {
      const ids = navigablePageIds(model);
      if (ids.length === 0 || !Number.isFinite(index)) return;
      scrollToIndex(Math.trunc(index));
    },
    jumpToAddress(address) {
      const index = navigablePageIds(model).indexOf(address);
      if (index !== -1) scrollToIndex(index);
    },
    sourceOutline: () => sourceOutline,
    flush() {
      for (const handle of mounted.values()) handle.flush();
    },

    addPage(
      templateId = DEFAULT_NOTEBOOK_TEMPLATE,
      afterIndex?: number,
      paper?: NotebookPaperOptions,
    ): string {
      if (Object.keys(model.pages).length >= NOTEBOOK_LIMITS.maxPages) {
        throw new Error(`notebook page limit is ${NOTEBOOK_LIMITS.maxPages}`);
      }
      // New pages inherit the current page's paper options unless the
      // caller passes explicit ones — custom spacing/tint follows the
      // template choice without extra gestures.
      const currentId = navigablePageIds(model)[currentPageIndex()];
      const currentEntry =
        currentId === undefined ? undefined : model.pages[currentId];
      const inherited = isNavigablePage(currentEntry)
        ? paperOptionsOf(currentEntry)
        : undefined;
      const resolvedPaper = paper ?? inherited;
      const id = freshPageId();
      const page = makePage(id, {
        template: templateId,
        ...(resolvedPaper !== undefined ? { paper: { ...resolvedPaper } } : {}),
      });
      if (isNavigablePage(currentEntry)) {
        page.surface.frame = { ...currentEntry.surface.frame };
      }
      model.pages[id] = page;
      const at = afterIndex ?? currentPageIndex();
      insertAfterNavigableIndex(id, at);
      markDirty();
      rebuildShells();
      scrollToIndex(at + 1);
      return id;
    },

    duplicatePage(index: number): string | null {
      if (Object.keys(model.pages).length >= NOTEBOOK_LIMITS.maxPages) {
        throw new Error(`notebook page limit is ${NOTEBOOK_LIMITS.maxPages}`);
      }
      const ids = navigablePageIds(model);
      const sourceId = ids[index];
      if (sourceId === undefined) return null;
      const entry = model.pages[sourceId];
      if (!isNavigablePage(entry)) return null;
      const id = freshPageId();
      const copiedSurface: SurfaceModelCopy = JSON.parse(
        JSON.stringify(entry.surface),
      );
      const page = makePage(id, { surface: copiedSurface });
      const srcLabel = labelOf(entry);
      if (srcLabel !== undefined) page.record.label = srcLabel + ' (copy)';
      // v2 paper/template lives under `record.base` and copies through the
      // generic loop below; no v1 `record.template` handling remains.
      for (const [key, value] of Object.entries(entry.record)) {
        if (
          key === 'id' ||
          key === 'label' ||
          key === 'template' ||
          key === 'surface'
        )
          continue;
        page.record[key] = JSON.parse(JSON.stringify(value));
      }
      model.pages[id] = page;
      insertAfterNavigableIndex(id, index);
      markDirty();
      rebuildShells();
      scrollToIndex(index + 1);
      return id;
    },

    deletePage(index: number): boolean {
      const ids = navigablePageIds(model);
      if (ids.length <= 1) return false;
      const id = ids[index];
      if (id === undefined) return false;
      unmountPage(id);
      delete model.pages[id];
      const orderIndex = model.pageOrder.indexOf(id);
      if (orderIndex !== -1) model.pageOrder.splice(orderIndex, 1);
      markDirty();
      rebuildShells();
      scrollToIndex(Math.max(0, index - 1));
      return true;
    },

    reorderPage(from, to) {
      const ids = navigablePageIds(model);
      const id = ids[from];
      if (id === undefined || from === to || to < 0 || to >= ids.length) return;
      model.pageOrder.splice(model.pageOrder.indexOf(id), 1);
      // Anchor is computed AFTER removal so target indices stay meaningful.
      const remaining = navigablePageIds(model);
      if (to >= remaining.length) {
        model.pageOrder.push(id);
      } else {
        const anchorId = remaining[to];
        if (anchorId !== undefined) {
          model.pageOrder.splice(model.pageOrder.indexOf(anchorId), 0, id);
        } else {
          model.pageOrder.push(id);
        }
      }
      markDirty();
      rebuildShells();
      // Reorder keeps the same entry objects alive, so entry-identity stale
      // checks cannot detect it: invalidate (generation bump, plus a
      // synchronous rebuild when visible) so pending PDF completions from
      // the previous order are rejected and callbacks capture new indices.
      scrollToIndex(to);
    },

    setTemplate(index, templateId) {
      const ids = navigablePageIds(model);
      const id = ids[index];
      if (id === undefined) return;
      const entry = model.pages[id];
      if (!isNavigablePage(entry)) return;
      if (baseOf(entry).kind === 'pdf-page') return;
      setPageTemplate(entry, templateId);
      markDirty();
      // Paper is presentation: remount so backgrounds recompile.
      const shell = shells[index];
      unmountPage(id);
      if (shell !== undefined) {
        const shellRect = shell.getBoundingClientRect();
        const scrollRect = scroll.getBoundingClientRect();
        if (
          shellObserver === null ||
          (shellRect.bottom >= scrollRect.top - 600 &&
            shellRect.top <= scrollRect.bottom + 600)
        ) {
          mountPage(id, shell);
        }
      }
      scheduleToolSync();
    },

    setTool(toolId) {
      cancelPageTouch();
      selectedToolId = toolId;
      sourceInteractionMode = 'surface-authoring';
      for (const handle of mounted.values()) handle.setTool(toolId);
      applySourceInteractionMode();
      syncToolState();
    },
    setSourceInteractionMode(mode) {
      cancelNavigation();
      sourceInteractionMode = mode;
      applySourceInteractionMode();
      syncToolState();
    },
    sourceInteractionMode: () => sourceInteractionMode,
    currentBaseKind() {
      const id = navigablePageIds(model)[currentPageIndex()];
      const entry = id === undefined ? undefined : model.pages[id];
      return isNavigablePage(entry) ? baseOf(entry).kind : null;
    },
    activeToolId() {
      return activeHandle()?.activeToolId() ?? selectedToolId;
    },
    settledActiveToolId() {
      return activeHandle()?.settledActiveToolId() ?? selectedToolId;
    },
    selectionIds() {
      return activeHandle()?.selectionIds() ?? [];
    },
    setSelection(ids) {
      activeHandle()?.setSelection(ids);
    },
    selectionViewportBounds() {
      return activeHandle()?.selectionViewportBounds() ?? null;
    },
    selectionContext() {
      return activeHandle()?.selectionContext() ?? null;
    },
    moveSelectionBy(delta) {
      return activeHandle()?.moveSelectionBy(delta) ?? [];
    },
    scaleSelection(factor) {
      return activeHandle()?.scaleSelection(factor) ?? [];
    },
    rotateSelection(deltaRadians) {
      return activeHandle()?.rotateSelection(deltaRadians) ?? [];
    },
    textSelectionState() {
      return (
        activeHandle()?.textStyleState() ??
        deriveSurfaceTextSelectionState(null, [])
      );
    },
    setSelectionStyle(style) {
      return activeHandle()?.setSelectionStyle(style) ?? [];
    },
    setTextStyle(style) {
      return activeHandle()?.setTextStyle(style) ?? [];
    },
    alignSelection(edge) {
      return activeHandle()?.alignSelection(edge) ?? [];
    },
    distributeSelection(axis) {
      return activeHandle()?.distributeSelection(axis) ?? [];
    },
    reorderSelection(where) {
      return activeHandle()?.reorderSelection(where) ?? [];
    },
    setLocked(ids, locked) {
      return activeHandle()?.setLocked(ids, locked) ?? [];
    },
    groupSelection() {
      return activeHandle()?.groupSelection() ?? [];
    },
    ungroupSelection() {
      return activeHandle()?.ungroupSelection() ?? [];
    },
    duplicateSelection() {
      return activeHandle()?.duplicateSelection() ?? [];
    },
    deleteSelection() {
      return activeHandle()?.deleteSelection() ?? [];
    },
    connectSelected() {
      return activeHandle()?.connectSelected() ?? null;
    },
    penColor: () => penStyle.color ?? NOTEBOOK_INK_COLORS[0],
    setPenColor(color) {
      penStyle.color = color;
      // Route through the shared preset store so the choice persists and
      // seeds pages mounted later (not just live refs).
      for (const handle of mounted.values())
        handle.setToolPreset('pen', { color });
      syncToolState();
    },
    penWidth: () => penStyle.width ?? NOTEBOOK_INK_WIDTHS[1],
    setPenWidth(width) {
      if (!Number.isFinite(width) || width <= 0) return;
      penStyle.width = width;
      for (const handle of mounted.values())
        handle.setToolPreset('pen', { size: width });
      syncToolState();
    },
    eraserRadius: () => eraserStyle.radius ?? DEFAULT_ERASER_RADIUS_VIEW,
    setEraserRadius(radius) {
      if (!Number.isFinite(radius) || radius <= 0) return;
      eraserStyle.radius = radius;
      syncToolState();
    },
    eraserMode: () => activeHandle()?.eraserMode() ?? DEFAULT_ERASER_MODE,
    setEraserMode(mode) {
      for (const handle of mounted.values()) handle.setEraserMode(mode);
      syncToolState();
    },
    // Slice 8 settings host: reads serve the active page (empty
    // defaults when none is mounted, so the schema falls back to brush
    // bases); writes fan out to every mounted page and mirror the
    // shared style refs that seed pages mounted later.
    toolPreset: (tool) => activeHandle()?.toolPreset(tool) ?? {},
    setToolPreset(tool, patch) {
      for (const handle of mounted.values()) handle.setToolPreset(tool, patch);
      if (tool === 'pen') {
        if (patch.color !== undefined) penStyle.color = patch.color;
        if (patch.size !== undefined) penStyle.width = patch.size;
      }
      syncToolState();
    },
    savedStyles: (tool) => activeHandle()?.savedStyles(tool) ?? [],
    currentStyleId: (tool) => activeHandle()?.currentStyleId(tool) ?? null,
    saveCurrentStyle(tool, name) {
      const id = activeHandle()?.saveCurrentStyle(tool, name) ?? null;
      if (id !== null) syncToolState();
      return id;
    },
    applySavedStyle(id) {
      const applied = activeHandle()?.applySavedStyle(id) ?? false;
      if (applied) syncToolState();
      return applied;
    },
    updateSavedStyle(id) {
      const updated = activeHandle()?.updateSavedStyle(id) ?? false;
      if (updated) syncToolState();
      return updated;
    },
    renameSavedStyle(id, name) {
      const renamed = activeHandle()?.renameSavedStyle(id, name) ?? false;
      if (renamed) syncToolState();
      return renamed;
    },
    favoriteSavedStyle(id, favorite) {
      const changed = activeHandle()?.favoriteSavedStyle(id, favorite) ?? false;
      if (changed) syncToolState();
      return changed;
    },
    reorderSavedStyles(tool, ids) {
      const reordered = activeHandle()?.reorderSavedStyles(tool, ids) ?? false;
      if (reordered) syncToolState();
      return reordered;
    },
    deleteSavedStyle(id) {
      const deleted = activeHandle()?.deleteSavedStyle(id) ?? false;
      if (deleted) syncToolState();
      return deleted;
    },
    resetSavedStyle(tool) {
      const reset = activeHandle()?.resetSavedStyle(tool) ?? false;
      if (reset) syncToolState();
      return reset;
    },
    savedStyleModified: (tool) =>
      activeHandle()?.savedStyleModified(tool) ?? false,
    cornerRadius: () => cornerRadius,
    setCornerRadius(value) {
      if (!Number.isFinite(value) || value < 0) return;
      cornerRadius = value;
      for (const handle of mounted.values()) handle.setCornerRadius(value);
      syncToolState();
    },
    shapeAppearance: () => shapeAppearance,
    setShapeAppearance(value) {
      shapeAppearance = value;
      for (const handle of mounted.values()) handle.setShapeAppearance(value);
      syncToolState();
    },
    lineArrows: () => activeHandle()?.lineArrows() ?? 'end',
    setLineArrows(arrows) {
      for (const handle of mounted.values()) handle.setLineArrows(arrows);
      syncToolState();
    },
    recentColors: () => activeHandle()?.recentColors() ?? [],
    eraserPreset: () => activeHandle()?.eraserPreset() ?? {},
    setEraserPreset(patch) {
      for (const handle of mounted.values()) handle.setEraserPreset(patch);
      if (patch.radius !== undefined) eraserStyle.radius = patch.radius;
      syncToolState();
    },
    lassoPreset: () => activeHandle()?.lassoPreset() ?? {},
    setLassoPreset(patch) {
      for (const handle of mounted.values()) handle.setLassoPreset(patch);
      syncToolState();
    },
    gestures: () => activeHandle()?.gestures() ?? {},
    setGestures(patch) {
      for (const handle of mounted.values()) handle.setGestures(patch);
      syncToolState();
    },
    currentTemplate() {
      const id = navigablePageIds(model)[currentPageIndex()];
      const entry = id === undefined ? undefined : model.pages[id];
      return isNavigablePage(entry)
        ? (templateOf(entry) ?? DEFAULT_NOTEBOOK_TEMPLATE)
        : DEFAULT_NOTEBOOK_TEMPLATE;
    },
    paperOptions() {
      const id = navigablePageIds(model)[currentPageIndex()];
      const entry = id === undefined ? undefined : model.pages[id];
      return isNavigablePage(entry) ? paperOptionsOf(entry) : undefined;
    },
    setPaperOptions(paper) {
      const id = navigablePageIds(model)[currentPageIndex()];
      const entry = id === undefined ? undefined : model.pages[id];
      if (!isNavigablePage(entry)) return;
      if (baseOf(entry).kind === 'pdf-page') return;
      if (paper !== undefined && !isValidPaperOptions(paper)) return;
      setPaperOptions(entry, paper);
      markDirty();
      // Paper is presentation: remount the current page so backgrounds
      // recompile, then refresh toolbar state.
      const index = currentPageIndex();
      const shell = shells[index];
      if (id !== undefined) unmountPage(id);
      if (id !== undefined && shell !== undefined) {
        const shellRect = shell.getBoundingClientRect();
        const scrollRect = scroll.getBoundingClientRect();
        if (
          shellObserver === null ||
          (shellRect.bottom >= scrollRect.top - 600 &&
            shellRect.top <= scrollRect.bottom + 600)
        ) {
          mountPage(id, shell);
        }
      }
      scheduleToolSync();
    },
    rulerState: () => ruler,
    setRuler(next) {
      if (next !== null && !isValidRulerState(next)) return;
      ruler = next;
      for (const handle of mounted.values()) handle.setRuler(next);
      scheduleToolSync();
    },
    centerRuler() {
      const id = navigablePageIds(model)[currentPageIndex()];
      const entry = id === undefined ? undefined : model.pages[id];
      const size = isNavigablePage(entry)
        ? frameBounds(entry.surface.frame)
        : null;
      const cx = size === null ? 0 : size.width / 2;
      const cy = size === null ? 0 : size.height / 2;
      const angle = ruler !== null ? ruler.angle : 0;
      const length =
        ruler !== null && Number.isFinite(ruler.length) && ruler.length > 0
          ? ruler.length
          : RULER_DEFAULT_LENGTH;
      api.setRuler({ visible: true, x: cx, y: cy, angle, length });
    },
    applyPageSize(sizeId) {
      const preset = pageSizePreset(sizeId);
      if (preset === null) return false;
      return api.resizeCurrentPage(preset.width, preset.height);
    },
    setPageOrientation(orientation) {
      const size = api.currentPageSize();
      if (size === null) return false;
      const next = orientSize(size, orientation);
      if (next.width === size.width && next.height === size.height) return true;
      return api.resizeCurrentPage(next.width, next.height);
    },
    undo() {
      const ok = activeHandle()?.undo() ?? false;
      scheduleToolSync();
      return ok;
    },
    redo() {
      const ok = activeHandle()?.redo() ?? false;
      scheduleToolSync();
      return ok;
    },
    canUndo: () => activeHandle()?.canUndo() ?? false,
    canRedo: () => activeHandle()?.canRedo() ?? false,
    zoomReset() {
      commitSettledZoom(1);
    },
    zoomFactor: () => notebookZoom,
    setZoomFactor(zoom) {
      commitSettledZoom(zoom);
    },
    currentPageSize() {
      const id = navigablePageIds(model)[currentPageIndex()];
      const entry = id === undefined ? undefined : model.pages[id];
      return isNavigablePage(entry) ? frameBounds(entry.surface.frame) : null;
    },
    resizeCurrentPage(width, height) {
      const index = currentPageIndex();
      const id = navigablePageIds(model)[index];
      const entry = id === undefined ? undefined : model.pages[id];
      if (id === undefined || !isNavigablePage(entry)) return false;
      if (baseOf(entry).kind === 'pdf-page') return false;
      const mountedHandle = mounted.get(id);
      let changed = false;
      if (mountedHandle !== undefined) {
        changed = mountedHandle.resizeFrame(width, height);
      } else {
        const current = frameBounds(entry.surface.frame);
        const nextWidth = Math.min(Math.max(Math.round(width), 64), 20_000);
        const nextHeight = Math.min(Math.max(Math.round(height), 64), 20_000);
        if (
          current !== null &&
          (current.width !== nextWidth || current.height !== nextHeight)
        ) {
          entry.surface.frame = {
            ...entry.surface.frame,
            kind: 'bounded',
            width: nextWidth,
            height: nextHeight,
          };
          markDirty();
          changed = true;
        }
      }
      if (changed) {
        const shell = shells[index];
        const size = frameBounds(entry.surface.frame);
        if (shell !== undefined && size !== null)
          shell.style.aspectRatio = `${size.width} / ${size.height}`;
        scheduleToolSync();
      }
      return changed;
    },
    scrollByPages(delta) {
      scrollToIndex(currentPageIndex() + delta);
    },

    async insertImageFile(file) {
      return trackTask(
        insertImageIntoCurrentPage(
          imageInsertEnv,
          currentPageIndex(),
          file,
          freshPageId,
        ),
      );
    },
    chooseImage() {
      if (options.assets != null) imgInput.click();
    },
    canInsertImage: () => options.assets != null,
    choosePdf(position) {
      if (options.importPdf === undefined) return;
      pendingPdfPosition = position;
      pdfInput.click();
    },
    canInsertPdf: () => options.importPdf !== undefined,

    exportCurrentPagePng() {
      if (destroyed) return;
      const id = navigablePageIds(model)[currentPageIndex()];
      const entry = id === undefined ? undefined : model.pages[id];
      if (!id || !isNavigablePage(entry)) return;
      trackTask(
        withExportScope(undefined, (scope) =>
          downloadCurrentNotebookPageAsPng(
            exportEnv,
            model,
            {
              pageId: id,
              index: currentPageIndex(),
            },
            undefined,
            scope,
          ),
        ),
      );
    },

    exportNotebookPng() {
      if (destroyed) return;
      const ids = navigablePageIds(model);
      const entries = ids.map((id, index) => ({ pageId: id, index }));
      trackTask(
        withExportScope(undefined, (scope) =>
          downloadNotebookPagesAsPng(
            exportEnv,
            model,
            entries,
            undefined,
            scope,
          ),
        ),
      );
    },

    renderPageImage,

    onDidChange(listener) {
      toolListeners.add(listener);
      return { dispose: () => toolListeners.delete(listener) };
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      // centralized destroy (single owner): cancelNavigation
      // discards via the shared helper (0 frames, idle, no preview, clean
      // transform, no double-commit), then derived work aborts and shells
      // unmount. No new rAF is ever scheduled after this point
      // (scheduleMotion guards destroyed).
      cancelNavigation();
      try {
        console.assert(
          motionFrame === null,
          '[pager] destroy: motion frame not cleared',
        );
        console.assert(
          pagerMotion.kind === 'idle',
          '[pager] destroy: motion not idle',
        );
        console.assert(
          pinchPreview === null,
          '[pager] destroy: preview not cleared',
        );
        console.assert(
          stack.style.transform === '',
          '[pager] destroy: transform not cleared',
        );
      } catch {
        // Asserts never break teardown.
      }
      assertPagerNavigationInvariant('destroy');
      // Abort pager-owned derived work first: in-flight PNG exports observe
      // the scope signal after every async boundary and stop promptly; their
      // staging PDF handles are still destroyed via `finally`.
      try {
        exportAbort.abort();
      } catch {
        // Aborting is best-effort; export settlement already tolerates it.
      }
      shellObserver?.disconnect();
      // Defensive: cancelNavigation already discarded via the shared helper,
      // but destroy must never retain detached shell refs (IO leak).
      suppressedVisibility.clear();
      for (const key of [...mounted.keys()]) unmountPage(key);
      pdfBases.destroy();
      images.dispose();
      pendingTasks.clear();
      toolListeners.clear();
      layoutObserver?.disconnect();
      scroll.removeEventListener('scroll', onScroll);
      scroll.removeEventListener(
        'pointerdown',
        stopPageNavigationBeforeCanvasInput,
        true,
      );
      scroll.removeEventListener('wheel', onWheel);
      cancelPageTouch();
      scroll.removeEventListener('pointermove', trackPageTouch, true);
      scroll.removeEventListener('pointerdown', onNavigationPointerDown);
      scroll.removeEventListener('pointermove', onNavigationPointerMove);
      scroll.removeEventListener('pointerup', onNavigationPointerEnd);
      scroll.removeEventListener('pointerup', onPagePointerEnd, true);
      scroll.removeEventListener('pointercancel', onPagePointerEnd, true);
      scroll.removeEventListener('lostpointercapture', onPagePointerEnd, true);
      pagePointers.clear();
      scroll.removeEventListener('pointercancel', onNavigationPointerCancel);
      scroll.removeEventListener('lostpointercapture', onNavigationLostCapture);
      root.removeEventListener('keydown', onKeyDown);
      root.remove();
    },
  };

  const onScroll = (): void => {
    refreshMountedViewports();
    refreshFallbackVisiblePage();
    scheduleToolSync();
  };
  // One wheel listener covers pages and gutter; ordinary wheel stays native.
  const onWheel = (event: WheelEvent): void => {
    if (destroyed) return;
    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      const deltaY =
        typeof event.deltaY === 'number' && Number.isFinite(event.deltaY)
          ? event.deltaY
          : 0;
      if (deltaY === 0) return;
      const clientX = event.clientX;
      const clientY = event.clientY;
      if (
        typeof clientX !== 'number' ||
        typeof clientY !== 'number' ||
        !Number.isFinite(clientX) ||
        !Number.isFinite(clientY)
      ) {
        return;
      }
      handleWheelZoom(Math.exp(-deltaY * 0.002), {
        x: clientX,
        y: clientY,
      });
      return;
    }
    consumePlainWheel();
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    const meta = event.metaKey || event.ctrlKey;
    if (meta && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) api.redo();
      else api.undo();
      return;
    }
    if (meta) return;
    if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
      event.preventDefault();
      api.scrollByPages(-1);
    } else if (event.key === 'ArrowRight' || event.key === 'PageDown') {
      event.preventDefault();
      api.scrollByPages(1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      api.jumpToPage(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      api.jumpToPage(api.pageCount() - 1);
    }
  };
  scroll.addEventListener('scroll', onScroll, { passive: true });
  scroll.addEventListener(
    'pointerdown',
    stopPageNavigationBeforeCanvasInput,
    true,
  );
  scroll.addEventListener('wheel', onWheel, { passive: false });
  scroll.addEventListener('pointermove', trackPageTouch, true);
  scroll.addEventListener('pointerdown', onNavigationPointerDown);
  scroll.addEventListener('pointermove', onNavigationPointerMove);
  scroll.addEventListener('pointerup', onNavigationPointerEnd);
  scroll.addEventListener('pointerup', onPagePointerEnd, true);
  scroll.addEventListener('pointercancel', onPagePointerEnd, true);
  scroll.addEventListener('lostpointercapture', onPagePointerEnd, true);
  scroll.addEventListener('pointercancel', onNavigationPointerCancel);
  scroll.addEventListener('lostpointercapture', onNavigationLostCapture);
  root.addEventListener('keydown', onKeyDown);

  rebuildShells();
  loadSourceOutline();
  return api;
}

type SurfaceModelCopy = NotebookModel['pages'][string] extends never
  ? never
  : SurfaceModel;
