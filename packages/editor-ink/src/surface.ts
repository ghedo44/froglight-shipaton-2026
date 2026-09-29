import type { ErasurePreparation } from '@froglight/foundation';
import { createErasurePreparation } from './surface/erasure-preparation.js';
/**
 * Shared ink surface engine - document-agnostic drawing component.
 *
 * mountInkSurface edits one SurfaceModel over a dirty bridge; ink,
 * whiteboard, notebook, and future spatial documents embed it instead of
 * growing parallel drawing stacks. No document-kind concepts live here:
 * providers own sessions, persistence, and toolbar profiles.
 */

import {
  createDefaultSurfaceObjectTypeRegistry,
  textV2Lines,
  textBoldOf,
  textItalicOf,
  textRoleOf,
  createDefaultSurfaceToolRegistry,
  brushPresetForKind,
  DEFAULT_ERASER_RADIUS_VIEW,
  frameBounds,
  normalizeEraserMode,
  renderSurfaceScene,
  templateBackgroundDrawItems,
  textObject,
  InkPresetStore,
  SurfaceStyleLibrary,
  InkToolController,
  HIGHLIGHTER_PRESET,
  INK_DEFAULT_WIDTH,
  resolveBrushSpec,
  SURFACE_TOOL_IDS,
  SURFACE_SHARED_SWATCHES,
  SURFACE_SHARED_WIDTHS,
  isValidSeedBounds,
  DerivedReopenStore,
  contentRevisionFromOpenMetadata,
  createLiveCachedCompiledRestore,
  deriveSurfaceTextSelectionState,
  liveIsDirty,
  persistLiveReopenGeometry,
  resolvePreparedBackgroundPackUnit,
  resolvePreparedBackgroundPackUnitForLogical,
  acknowledgeBackgroundPackRendezvousKeys,
  backgroundPackRendezvousKeysForIds,
  resolveReopenSeeds,
  scheduleBackgroundPackForPreparedUnit,
  seedBoundsFromOpenMetadata,
  type AlignEdge,
  type Bounds,
  type Camera,
  type ColdSchedulerStats,
  type ConnectorAnchor,
  type ConnectorPath,
  type ConnectorIndexStats,
  type DistributeAxis,
  type DocumentAssetStore,
  type DrawItem,
  type EraserMode,
  type EraserStyleRef,
  type EraserPreset,
  type GesturePreferences,
  type IncrementalSceneStats,
  type InkPresetToolId,
  type InkBrushKind,
  type InkToolPreset,
  type SurfaceStylePreset,
  type LineArrowSetting,
  type LassoPreset,
  type LineArrows,
  type PenGestureOptions,
  type PenStyleRef,
  type Point,
  type ReorderDirection,
  type SelectionContextSnapshot,
  type SelectionDragSession,
  type SelectionStyle,
  type SurfaceControllerStats,
  type SurfaceDerivedCache,
  type SurfaceModel,
  type SurfaceObjectRecord,
  type SurfaceReopenBinding,
  type SurfaceRulerState,
  type SurfaceSpatialIndexStats,
  type SurfaceTool,
  type SurfaceToolRegistry,
  type SurfaceTextSelectionState,
  type SettingsService,
  type StylusInputPolicy,
  SURFACE_TEXT_DEFAULT_COLOR,
  TEXT_DEFAULT_WRAP_WIDTH,
} from '@froglight/foundation';
import {
  CanvasSurfaceRendererBackend,
  type SurfaceImageResolver,
} from '@froglight/surface-default';
import { createSurfaceImageCache, type DecodedImage } from './images.js';
import {
  boundedCamera,
  clampFrameSize,
  fitCameraToFrame,
  fitInsetForPresentation,
  zoomCameraAroundPoint,
} from './surface/camera.js';
export {
  MAX_FRAME_SIZE,
  MAX_ZOOM,
  MIN_FRAME_SIZE,
  MIN_ZOOM,
} from './surface/camera.js';
import { createInkShapeTools, INK_TOOL_IDS } from './surface/shape-tools.js';
export { INK_TOOL_IDS };
// Intentional provider-extension contract: the whiteboard card tool is
// built on the shared two-point constructor. Nothing else is re-exported
// from the shape internals.
export { twoPointShapeTool } from './surface/shape-tools.js';
import { SurfaceGestureHistory } from './surface/history.js';
import {
  createTextOverlay,
  normalizeOverlayText,
} from './surface/text-overlay.js';
import {
  createPointerController,
  type PointerTransportStats,
} from './surface/pointer-controller.js';
import type { PredictionPolicyOptions } from './surface/prediction-policy.js';
import { createImageIngester } from './surface/image-ingest.js';
import { createRenderScheduler } from './surface/render-loop.js';
import { createCommittedSceneRenderer } from './surface/committed-renderer.js';
import { ensureProductionBackgroundPackWorkerInstalled } from './surface/background-pack-worker.js';
import { surfacePaper } from './paper.js';
import {
  createSurfaceCursorPresenter,
  cursorToolKind,
  type SurfaceCursorTool,
} from './surface/cursor.js';

/** Adjustable eraser range exposed through the semantic toolbar. */
export const MIN_ERASER_RADIUS = 2;
export const MAX_ERASER_RADIUS = 40;
/** Border hit zone in CSS pixels for the Paint-style page resize. */

// Structural styles are owned by the colocated React skeleton
// (react/InkSurfaceSkeleton.module.css, @layer components). The engine
// consumes React-owned DOM refs and never injects styles.

export const SWATCHES = SURFACE_SHARED_SWATCHES;
export const WIDTH_DOTS = SURFACE_SHARED_WIDTHS;

// Shape creation tools, gesture history, camera math, pointer routing,
// text overlay, frame resize, image ingest, and render scheduling live in
// dedicated internal modules under ./surface/. This file is the
// public facade / lifecycle assembly for the existing mountInkSurface seam.

// --- The reusable surface editing component ---

export interface InkSurfaceOptions {
  readonly model: SurfaceModel;
  /** Reject text placement outside a bounded document page. */
  readonly restrictTextToFrame?: boolean;
  /** Dirty bridge to the owning session (or any persistence owner). */
  readonly markDirty: () => void;
  /**
   * React-owned skeleton committed by InkSurfaceSkeleton.
   * React owns all Froglight-visible presentation structure; the engine
   * consumes refs and never creates visible DOM. Ephemeral engine nodes
   * (offscreen canvases, text overlay, file picker, export infra) stay
   * engine-owned and are explicitly exempt.
   */
  readonly host: InkSkeleton;
  readonly initialTool?: string;
  readonly stylusInput?: StylusInputPolicy;
  /** Start previews read-only without briefly claiming drawing ownership. */
  readonly readOnly?: boolean;
  /** Host override for platforms that can reliably suppress the OS cursor. */
  readonly supportsCustomCursor?: () => boolean;
  /** Ephemeral camera restored by a containing pager; never canonical. */
  readonly initialCamera?: Camera;
  /** Live pen swatch/width state shared with semantic tool controls. */
  readonly penStyle?: PenStyleRef;
  /** Live eraser sizing shared with semantic tool controls. */
  readonly eraserStyle?: EraserStyleRef;
  /**
   * Disposable decode-time Ink bounds seeds (cold-open repair):
   * when supplied and structurally valid, the interaction controller
   * seeds its spatial index directly instead of rescanning every Ink
   * sample on first query. Derived-only — never canonical, never saved.
   * Absent/invalid seeds fall back to normal lazy derivation. Providers
   * read this from `session.openMetadata` (`surface.seedBounds`).
   */
  readonly seedBounds?: ReadonlyMap<string, Bounds | null>;
  /**
   * Shared settings backing for per-tool presets (slice 3). Surfaces
   * sharing one service share user defaults without sharing live editor
   * objects; each mount still owns its store. Omit for memory-only
   * presets seeded from `penStyle`/`eraserStyle`.
   */
  readonly presetSettings?: SettingsService;
  /**
   * Pen-gesture recognizers (slice 7: draw-and-hold shapes, scribble to
   * erase, circle to lasso). All off unless enabled here; the settings
   * UX to toggle them arrives with slice 8.
   */
  readonly penGestures?: PenGestureOptions;
  /**
   * Narrow extra-tools extension seam (review slice 4): Whiteboard
   * contributes Card through this factory receiving the same live style
   * refs as the core tools. Replacing the complete core registry is no
   * longer allowed — `mountInkSurface` always owns the core tools.
   */
  readonly extraTools?: (styles: SurfaceLiveStyles) => readonly SurfaceTool[];
  /** Optional derived paper/background draw items. */
  readonly backgroundItems?: () => readonly DrawItem[];
  /** Clip rasterization to this host viewport; fit/input still use the full page. */
  readonly renderViewport?: HTMLElement;
  /**
   * Ephemeral straightedge ruler (slice 10): shown as an overlay guide
   * with pen-family snap. Never canonical, never dirty, never history.
   */
  readonly ruler?: SurfaceRulerState | null;
  /**
   * Paint owns a sheet on a workbench; paged containers embed the same
   * interaction engine directly into paper they already frame.
   */
  readonly presentation?: 'paint-stage' | 'embedded-paper' | 'embedded-overlay';
  /** Defaults to true for the Paint stage and false for embedded paper. */
  readonly frameResizable?: boolean;
  /**
   * Standalone sheets own wheel pan/zoom. Embedded pages leave wheel input
   * to their containing pager while retaining touch pan and pinch zoom.
   */
  readonly navigationMode?: 'standalone' | 'embedded' | 'locked';
  /** Embedded container navigation, such as Notebook's vertical page stack. */
  readonly onEmbeddedPan?: ((deltaView: Point) => void) | undefined;
  /** Embedded container pinch; factor/translation are incremental view deltas. */
  readonly onEmbeddedZoom?:
    | ((gesture: {
        readonly factor: number;
        readonly point: Point;
        readonly translation: Point;
        readonly source?: 'wheel' | 'touch';
      }) => void)
    | undefined;
  /**
   * Embedded release/cancel (parity): pager-owned fling/settle.
   * Optional when the containing pager does not handle release velocity.
   */
  readonly onEmbeddedPanEnd?: ((velocity: Point) => void) | undefined;
  readonly onEmbeddedZoomEnd?: (() => void) | undefined;
  readonly onEmbeddedCancel?: (() => void) | undefined;
  /**
   * Embedded plain-wheel (gutter parity): native scroll owns the
   * gesture; the host preserves an open preview and cancels synthetic motion
   * only when no preview owns it. Split from `onEmbeddedCancel` (true abort
   * discards) so plain-wheel never discards an active preview.
   */
  readonly onEmbeddedWheel?: (() => void) | undefined;
  /** Parent owns finger pan/pinch; pen and mouse remain local authoring input. */
  readonly delegateTouchNavigation?: boolean;
  /** Provider-maintained decoded asset cache for image objects. */
  readonly imageResolver?: SurfaceImageResolver;
  /**
   * Asset ingestion for image objects. When present,
   * `froglight.image` objects resolve through a shared cache and image
   * insertion becomes available; absent leaves images as placeholders.
   */
  readonly assets?: DocumentAssetStore | null;
  /** Decode override for the internal image cache (tests). */
  readonly decodeImage?: (bytes: Uint8Array) => Promise<DecodedImage | null>;
  /** Filename stem for PNG export. */
  readonly exportName?: string;
  /**
   * Derived reopen-cache binding (final scalability pass): a
   * provider-owned `DerivedReopenStore`, this mount's document identity,
   * and LIVE session accessors (`getContentRevision`/`isDirty`). Mount
   * restores validated packed vectors (zero B-spline compiles) when the
   * session is clean; teardown queues warm-vector persistence
   * asynchronously under the revision current at that moment. A dirty
   * session neither consumes nor persists cache data. Absent means
   * memory-only seeds via `seedBounds` (or plain lazy derivation). Never
   * canonical.
   */
  readonly reopen?: SurfaceReopenBinding & {
    /**
     * Already-acquired per-document cache (from `resolveMountReopen`):
     * reused instead of acquiring twice per mount. Absent means the
     * mount acquires it (idempotent).
     */
    readonly cache?: SurfaceDerivedCache;
  };
  /**
   * Prediction policy (pen-only bounded tail, 20 CSS-px horizon). Internal
   * /dev kill switch for physical debugging: pass `{ enabled: false }`
   * to disable prediction without changing source; confirmed drawing
   * stays byte-identical. Defaults to pen-only bounded prediction.
   */
  readonly predictionPolicy?: PredictionPolicyOptions;
  /** Worker port override for deterministic assembled-editor tests. */
  readonly erasurePreparation?: ErasurePreparation;
}

export interface InkSurfaceHandle {
  readonly root: HTMLElement;
  setReadOnly(readOnly: boolean): void;
  setTool(toolId: string): void;
  activeToolId(): string;
  /**
   * Settled exclusive tool for toolbar reconciliation: the
   * last explicit selection. Temporary entries never move it; the live
   * `activeToolId()` reports temp while held.
   */
  settledActiveToolId(): string;
  penColor(): string;
  setPenColor(color: string): void;
  penWidth(): number;
  setPenWidth(width: number): void;
  /** Read one tool's preset (slice 3 seam for the settings UX). */
  toolPreset(tool: InkPresetToolId): InkToolPreset;
  /** Patch one tool's preset without touching live gestures. */
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
  /** Arrowheads used by newly created straight lines. */
  cornerRadius(): number;
  setCornerRadius(value: number): void;
  shapeAppearance(): 'fill' | 'outline';
  setShapeAppearance(value: 'fill' | 'outline'): void;
  lineArrows(): LineArrowSetting;
  setLineArrows(arrows: LineArrowSetting): void;
  /** Recent color choices, most-recent-first (slice 8 fast presets). */
  recentColors(): string[];
  /** Record a color choice in the recent-colors MRU. */
  pushRecentColor(color: string): void;
  /** Current eraser preset (slice 8 settings host). */
  eraserPreset(): EraserPreset;
  /** Merge a patch into the eraser preset. */
  setEraserPreset(patch: Partial<EraserPreset>): void;
  /** Current lasso preset (slice 8 settings host). */
  lassoPreset(): LassoPreset;
  /** Merge a patch into the lasso preset. */
  setLassoPreset(patch: Partial<LassoPreset>): void;
  /** Gesture preferences (slice 7 product contract, persisted). */
  gestures(): GesturePreferences;
  /** Merge a patch into the gesture preferences. */
  setGestures(patch: Partial<GesturePreferences>): void;
  /**
   * Enter a tool temporarily (stylus double-tap, eraser end): the
   * current tool restores on `exitTemporaryTool`.
   */
  enterTemporaryTool(toolId: string): void;
  /** Restore the tool active before the last temporary entry. */
  exitTemporaryTool(): boolean;
  /** Union bounds of the current selection; null when empty. */
  selectionBounds(): Bounds | null;
  /** Move selected objects by a document-space delta as one undoable edit. */
  moveSelectionBy(delta: Point): string[];
  /** Selection envelope mapped to viewport CSS pixels for contextual UI. */
  selectionViewportBounds(): Bounds | null;
  /** Semantic selection snapshot for context UI; null without geometry. */
  selectionContext(): SelectionContextSnapshot | null;
  /** Duplicate the selection on top; the selection follows the copies. */
  duplicateSelection(): string[];
  /** Delete the selection and clear it. */
  deleteSelection(): string[];
  /** Recolor/restyle the selection by type. */
  setSelectionStyle(style: SelectionStyle): string[];
  /** Text formatting for the selection, or the next text object when none is selected. */
  textStyleState(): SurfaceTextSelectionState;
  /** Apply text formatting to selected text, or remember it for the next text object. */
  setTextStyle(style: SelectionStyle): string[];
  /** Move the selection in paint order. */
  reorderSelection(where: ReorderDirection): string[];
  /** Uniformly scale the selection about a pivot (default: center). */
  scaleSelection(factor: number, center?: Point): string[];
  /** Rotate the selection about a pivot (default: center). */
  rotateSelection(deltaRadians: number, center?: Point): string[];
  /** Align the selection to its union edge/center (slice 9). */
  alignSelection(edge: AlignEdge): string[];
  /** Distribute the selection with equal gaps along an axis (slice 9). */
  distributeSelection(axis: DistributeAxis): string[];
  /** Set or clear the locked flag on objects (slice 9). */
  setLocked(ids: readonly string[], locked: boolean): string[];
  /** Group the selection; empty when not groupable (slice 9). */
  groupSelection(): string[];
  /** Dissolve selected groups back to members (slice 9). */
  ungroupSelection(): string[];
  /** Create a bound connector between objects or points (slice 9). */
  connectEndpoints(
    source: { objectId: string; anchor?: ConnectorAnchor } | { point: Point },
    target: { objectId: string; anchor?: ConnectorAnchor } | { point: Point },
    style?: {
      path?: ConnectorPath;
      arrows?: LineArrows;
      color?: string;
      width?: number;
      opacity?: number;
    },
  ): string;
  /** Rebind one connector end (slice 9). */
  rebindConnector(
    id: string,
    end: 'source' | 'target',
    binding:
      | { objectId: string; anchor?: ConnectorAnchor }
      | { point: Point }
      | null,
  ): boolean;
  /** Connect the selected pair center-to-center (slice 9). */
  connectSelected(style?: {
    path?: ConnectorPath;
    arrows?: LineArrows;
    color?: string;
    width?: number;
    opacity?: number;
  }): string | null;
  eraserRadius(): number;
  setEraserRadius(radius: number): void;
  /**
   * Current eraser preset mode for the two toolbar erasers.
   *
   * Read live from the eraser preset via `normalizeEraserMode` (tolerant:
   * corrupt/absent modes fall back to `DEFAULT_ERASER_MODE`, never throws)
   * so `buildSurfaceDrawControls` pins exactly one of the two fixed-mode
   * entries active. The single eraser engine is unchanged.
   */
  eraserMode(): EraserMode;
  /** Fix the eraser preset mode (best-effort; engine activation follows). */
  setEraserMode(mode: EraserMode): void;
  /** Ephemeral straightedge state; `null` means hidden (slice 10). */
  rulerState(): SurfaceRulerState | null;
  /** Replace the ephemeral ruler; never marks dirty or history. */
  setRuler(ruler: SurfaceRulerState | null): void;
  undo(): boolean;
  redo(): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
  setSelection(ids: readonly string[]): void;
  /** Pager adapter: claim contextual touch or dismiss selection and delegate. */
  claimTouchInteraction(event: PointerEvent): boolean;
  cancelTouchInteraction(): void;
  /** Current selection ids for arrange-control enablement (slice 9). */
  selectionIds(): readonly string[];
  canInsertImage(): boolean;
  /** Store + place an image object; returns its id, or null when unavailable. */
  insertImage(file: File): Promise<string | null>;
  /** Open a file picker and insert the chosen image (when available). */
  chooseImage(): void;
  zoomReset(): void;
  zoomFactor(): number;
  setZoomFactor(zoom: number): void;
  camera(): Camera;
  frameSize(): { width: number; height: number } | null;
  resizeFrame(width: number, height: number): boolean;
  fitToView(): void;
  exportPng(): void;
  refreshViewport(): void;
  /** Refresh resolved assets; changed ids synchronize external canonical writes. */
  refresh(changedIds?: readonly string[]): void;
  flush(): void;
  /**
   * Test-only canonical-mutation notifier for survivor rendezvous.
   *
   * No mounted public verb can delete/replace a SINGLE chunk of a logical
   * stroke in isolation (every selection verb expands through
   * `resolveGroupMembers`; eraser-whole expands the same way; eraser-split
   * deliberately drops logical identity), so destructive single-chunk tests
   * perform the real Foundation capture/mutate/invalidate boundary directly
   * and then notify the mounted surface that THESE ids mutated. Mutation-
   * notify only — never the background scheduler.
   */
  notifyCanonicalMutationForTests(ids: readonly string[]): void;
  /**
   * Development/test diagnostics (live-writing repair + scalability):
   * shared-frame paint count plus transport/prediction counters plus
   * history/scene/committed/controller/spatial/connector structural
   * counters for the large-document and large-selection gates.
   */
  diagnostics(): {
    readonly renderFrames: number;
    readonly transport: PointerTransportStats;
    readonly history: import('./surface/history.js').SurfaceHistoryCounters;
    readonly scene: IncrementalSceneStats;
    readonly committed: {
      readonly fullCacheRebuilds: number;
      readonly newlyDrawnCommittedItems: number;
      readonly dragPromotions: number;
      readonly translationFullRepaints: number;
      readonly committedItemsRepainted: number;
      readonly progressPending: number;
      readonly priorityReorders: number;
      /** Items prepared by the viewport-bounded first paint. */
      readonly firstPaintVisible: number | null;
      /** Sample cost spent by the viewport-bounded first paint. */
      readonly firstPaintCost: number | null;
      /** Renderer creation → first useful paint (ms). */
      readonly firstPaintMs: number | null;
    };
    readonly cold: ColdSchedulerStats;
    readonly controller: SurfaceControllerStats;
    readonly spatial: SurfaceSpatialIndexStats;
    readonly connectors: ConnectorIndexStats;
    readonly drag: SelectionDragSession | null;
    /** Packed-vector reopen restore counts (final pass diagnostics). */
    readonly reopenCompiled: {
      /** Restored packed vectors (= `cachedPackedRestored`, kept alias). */
      readonly hits: number;
      /** Missing packed vectors (= `cachedPackedRestoreMisses`). */
      readonly misses: number;
      /** Packed entries restored + still packed for this mount. */
      readonly cachedPackedAvailable: number;
      /** Packed entries lazily unpacked for prepared objects. */
      readonly cachedPackedRestored: number;
      /** Objects entering preparation with no valid packed entry. */
      readonly cachedPackedRestoreMisses: number;
      /** Packed entries still packed (not yet claimed). */
      readonly cachedPackedRestorePending: number;
      /** Main-thread ms spent unpacking/installing restored vectors. */
      readonly cachedPackedRestoreMs: number;
      /** Packed bytes unpacked from the cache (integration pressure). */
      readonly cachedPackedRestoredBytes: number;
      /** Spine nodes materialized from restored packed vectors. */
      readonly cachedPackedRestoredNodes: number;
      /** Restore attempts skipped because the live session is dirty. */
      readonly cachedPackedRestoreDirtySkips: number;
      /** Restore attempts skipped for missing live revision. */
      readonly cachedPackedRestoreRevisionSkips: number;
      /** Stale durable hydrations discarded (R0 after R1). */
      readonly staleHydrationsDiscarded: number;
    };
  };
  onDidChange(listener: () => void): { dispose(): void };
  destroy(): void;
}

/** Visible skeleton elements: owned by React, consumed by the engine. */
export interface InkSkeleton {
  readonly root: HTMLDivElement;
  readonly page: HTMLDivElement;
  readonly canvas: HTMLCanvasElement;
  readonly badge: HTMLDivElement;
  readonly pointerIndicator: HTMLDivElement;
  /** React-owned text-overlay container.*/
  readonly overlayRoot: HTMLDivElement;
}

/** Live style refs shared by core tools, extras, and toolbar setters. */
export interface SurfaceLiveStyles {
  readonly pen: PenStyleRef;
  readonly eraser: EraserStyleRef;
}

/**
 * Resolve disposable decode-time Ink bounds for a mount from a session's
 * open metadata (cold-open repair). Returns the validated seed
 * map, or null when the session carries none (or carries malformed
 * seeds — the mount then derives normally). Shared by the Ink,
 * Whiteboard, and Notebook providers so the session→mount glue has one
 * tested implementation.
 */
export function seedBoundsFromSession(session: {
  readonly openMetadata?: Readonly<Record<string, unknown>>;
}): ReadonlyMap<string, Bounds | null> | null {
  if (session.openMetadata === undefined) return null;
  try {
    return seedBoundsFromOpenMetadata(session.openMetadata);
  } catch {
    return null;
  }
}

/**
 * Provider-facing reopen binding for one mount: seeds plus the live
 * session binding the derived cache validates against. Null revision /
 * documentId means the cache is unusable for this mount (decode seeds
 * apply directly). `cache` is the already-acquired per-document cache
 * (acquire is idempotent, but threading it through avoids a second
 * lookup per mount). `binding` is null whenever identity/revision is
 * unavailable; otherwise it carries live revision/dirty accessors that
 * mount/destroy consult at their own time.
 */
export interface MountReopen {
  readonly seeds: ReadonlyMap<string, Bounds | null> | null;
  readonly documentId: string | null;
  readonly revision: string | null;
  readonly cache: SurfaceDerivedCache | null;
  readonly binding: SurfaceReopenBinding | null;
}

/**
 * Session view consumed by `resolveMountReopen`. The revision and dirty
 * accessors are preferred (LIVE session state); `openMetadata` remains
 * the fallback for direct `kind.decode`/fake-session callers.
 */
export interface ReopenSessionView {
  readonly openMetadata?: Readonly<Record<string, unknown>>;
  readonly document?: { readonly documentId?: unknown };
  /** Live session-owned content revision getter. */
  readonly getContentRevision?: () => string | null;
  /** Live dirty getter; `true` disables cache reads and writes. */
  readonly isDirty?: () => boolean;
}

function readLiveRevision(session: ReopenSessionView): string | null {
  const fallback =
    session.openMetadata === undefined
      ? null
      : contentRevisionFromOpenMetadata(session.openMetadata);
  if (session.getContentRevision === undefined) return fallback;
  try {
    const revision = session.getContentRevision();
    if (typeof revision === 'string' && revision.length > 0) return revision;
    // Getters on fake/legacy session shapes may be absent values while
    // openMetadata still carries the kind/session revision token.
    return fallback;
  } catch {
    return null;
  }
}

function readLiveDirty(session: ReopenSessionView): boolean {
  if (session.isDirty === undefined) return false;
  try {
    return session.isDirty();
  } catch {
    // Fail closed: a throwing dirty probe must prevent cache association.
    return true;
  }
}

/**
 * Resolve the full mount reopen binding (final pass): decode
 * seeds resolved through the derived reopen cache (valid entries win),
 * plus document identity and the live session revision/dirty contract
 * for packed-vector restore/persist. Falls back to plain decode seeds
 *  whenever identity, revision, or cache is unavailable —
 * opening never depends on the cache. A dirty session trusts neither
 * decode seeds nor cache entries (they describe the last saved bytes,
 * not the unsaved model).
 *
 * Providers own one `DerivedReopenStore` each (it spans opens; mounts
 * must not own it) and call this per mount, passing `reopen` through to
 * `mountInkSurface` (or `seedBounds` for memory-only mounts).
 */
export function resolveMountReopen(
  store: DerivedReopenStore,
  session: ReopenSessionView,
): MountReopen {
  const documentId = ((): string | null => {
    const rawId = session.document?.documentId;
    return typeof rawId === 'string' && rawId.length > 0 ? rawId : null;
  })();
  const revision = readLiveRevision(session);
  const dirty = readLiveDirty(session);
  const decodeSeeds = dirty ? null : seedBoundsFromSession(session);
  if (revision === null || documentId === null) {
    return {
      seeds: decodeSeeds,
      documentId,
      revision,
      cache: null,
      binding: null,
    };
  }
  const binding: SurfaceReopenBinding = {
    store,
    documentId,
    getContentRevision: session.getContentRevision ?? (() => revision),
    isDirty: session.isDirty ?? (() => false),
  };
  if (decodeSeeds === null) {
    return { seeds: null, documentId, revision, cache: null, binding };
  }
  try {
    const cache = store.acquire(documentId, revision);
    const resolved = resolveReopenSeeds({
      documentId,
      revision,
      decodeSeeds,
      cache,
    });
    // Seed backfill is queued, never awaited: opening stays non-blocking.
    store.persist(documentId);
    return { seeds: resolved.seeds, documentId, revision, cache, binding };
  } catch {
    return { seeds: decodeSeeds, documentId, revision, cache: null, binding };
  }
}

/**
 * Resolve effective mount seeds through the derived reopen cache
 * valid cache entries win, decode seeds fill the rest and
 * backfill the cache for the next open. Falls back to plain decode
 * seeds whenever the document identity, revision, or cache
 * is unavailable — opening never depends on the cache.
 *
 * Providers own one `DerivedReopenStore` each (it spans opens; mounts
 * must not own it) and call this per mount. Prefer `resolveMountReopen`
 * + the `reopen` mount port for packed-vector restore; this stays for
 * memory-only mounts.
 */
export function resolveMountSeeds(
  store: DerivedReopenStore,
  session: ReopenSessionView,
): ReadonlyMap<string, Bounds | null> | null {
  return resolveMountReopen(store, session).seeds;
}

export function mountInkSurface(options: InkSurfaceOptions): InkSurfaceHandle {
  // Production background-pack lane (package-level facility, not per-Surface):
  // idempotent — the first mount installs the shared Ink Worker factory once
  // and later mounts never replace it (replacement would terminate the live
  // Worker and cause cross-surface interference). Destroy never uninstalls.
  // Worker-unavailable/jsdom/headless degrades to SKIP via a null factory
  // result. Tests inject fakes through the Foundation setter; this call never
  // overwrites an already-installed factory.
  try {
    ensureProductionBackgroundPackWorkerInstalled();
  } catch {
    // Production wiring never breaks mounting.
  }
  const model = options.model;
  const presentation = options.presentation ?? 'paint-stage';
  const frameResizable =
    options.frameResizable ?? presentation === 'paint-stage';
  const navigationMode =
    options.navigationMode ??
    (presentation === 'paint-stage' ? 'standalone' : 'embedded');
  const cameraInteractive = navigationMode !== 'locked';
  const penStyle: PenStyleRef = options.penStyle ?? {
    color: SWATCHES[0],
    width: WIDTH_DOTS[1],
  };
  const eraserStyle: EraserStyleRef = options.eraserStyle ?? {
    radius: DEFAULT_ERASER_RADIUS_VIEW,
  };

  // Per-tool presets are the live source for capture tools; the legacy
  // refs seed a fresh store and stay mirrored for external holders.
  // Direct external mutation of those refs no longer steers tools —
  // setters and the preset store are the contract.
  const presetStore = new InkPresetStore(
    options.presetSettings !== undefined
      ? { settings: options.presetSettings }
      : {},
  );
  const styleLibrary = new SurfaceStyleLibrary({
    presets: presetStore,
    ...(options.presetSettings !== undefined
      ? { settings: options.presetSettings }
      : {}),
  });
  // Seed only unset fields: the first mount establishes shared defaults,
  // later mounts with the same service keep them.
  const seedPen = presetStore.getTool('pen');
  if (
    (seedPen.color === undefined && penStyle.color !== undefined) ||
    (seedPen.size === undefined && penStyle.width !== undefined)
  ) {
    presetStore.setTool('pen', {
      ...(seedPen.color === undefined && penStyle.color !== undefined
        ? { color: penStyle.color }
        : {}),
      ...(seedPen.size === undefined && penStyle.width !== undefined
        ? { size: penStyle.width }
        : {}),
    });
  }
  if (
    presetStore.getEraser().radius === undefined &&
    eraserStyle.radius !== undefined
  ) {
    presetStore.setEraser({ radius: eraserStyle.radius });
  }
  // Highlighter starts independent (own default color), never following
  // pen state; size/opacity fall back to the highlighter statics below.
  if (presetStore.getTool('highlighter').color === undefined) {
    presetStore.setTool('highlighter', { color: HIGHLIGHTER_PRESET.color });
  }

  // Core registry is always owned here with the same live style refs
  // exposed through the toolbar setters. Extras (e.g. Whiteboard Card)
  // share those refs.
  const registry: SurfaceToolRegistry = createDefaultSurfaceToolRegistry({
    eraserRadiusView: DEFAULT_ERASER_RADIUS_VIEW,
    presets: presetStore,
    ...(options.penGestures !== undefined
      ? { penGestures: options.penGestures }
      : {}),
  });
  let shapeAppearance: 'fill' | 'outline' = 'fill';
  let cornerRadius = 0;
  for (const tool of createInkShapeTools(penStyle, {
    lineArrows: () => presetStore.getLineArrows(),
    cornerRadius: () => cornerRadius,
    shapeAppearance: () => shapeAppearance,
  })) {
    registry.register(tool);
  }
  const liveStyles: SurfaceLiveStyles = { pen: penStyle, eraser: eraserStyle };
  if (options.extraTools !== undefined) {
    for (const tool of options.extraTools(liveStyles)) {
      registry.register(tool);
    }
  }
  // --- Visible skeleton: React-owned ---
  // The engine never creates visible DOM. Ephemeral engine nodes (offscreen
  // cache canvas below, text overlay, file picker, export canvas) stay
  // engine-owned and are explicitly exempt from the React rule.
  const { root, page, canvas, badge } = options.host;

  // --- Controller + rendering state ---
  let sceneVersion = 0;
  let destroyed = false;
  let readOnly = options.readOnly ?? false;
  let releaseDrawing: (() => void) | undefined;
  let releaseTextEntry: (() => void) | undefined;
  const syncDrawingContext = (): void => {
    if (readOnly || destroyed) {
      releaseDrawing?.();
      releaseDrawing = undefined;
    } else {
      releaseDrawing ??= options.stylusInput?.acquireInputContext('drawing');
    }
  };
  const toolListeners = new Set<() => void>();
  let pointerHandler: {
    flushPendingInputWithoutSchedulingRender(): void;
    advanceNavigation(timeMs: number): boolean;
    hasTransientNavigation(): boolean;
    refreshCursor(): void;
  } | null = null;
  const notifyTools = (): void => {
    pointerHandler?.refreshCursor();
    for (const listener of toolListeners) listener();
  };

  const textFontFamily =
    getComputedStyle(root).getPropertyValue('--fl-font-sans').trim() ||
    'sans-serif';
  const textMetrics = document.createElement('canvas').getContext('2d');
  const sharedObjectRegistry = createDefaultSurfaceObjectTypeRegistry({
    ...(typeof textMetrics?.measureText === 'function'
      ? {
          measureText: (record, text, size) => {
            const bold = textBoldOf(record) || textRoleOf(record) === 'heading';
            textMetrics.font = `${textItalicOf(record) ? 'italic ' : ''}${bold ? 'bold ' : ''}${size}px ${textFontFamily}`;
            return textMetrics.measureText(text).width;
          },
        }
      : {}),
  });
  const history = new SurfaceGestureHistory(
    model,
    sharedObjectRegistry as never,
  );
  const presetNotifications = presetStore.onChange(() => notifyTools());
  const invalidateScene = (): void => {
    sceneVersion += 1;
    scheduleRender();
  };

  // Image objects resolve through the shared cache; an explicitly supplied
  // resolver (e.g. the notebook pager's cross-page cache) takes precedence.
  const assets = options.assets ?? null;
  const imageCache =
    assets !== null && options.imageResolver === undefined
      ? createSurfaceImageCache({
          assets,
          onReady: invalidateScene,
          ...(options.decodeImage !== undefined
            ? { decode: options.decodeImage }
            : {}),
        })
      : null;
  const imageResolver = options.imageResolver ?? imageCache?.resolver;

  // Derived reopen binding + LIVE lazy packed-cache restore source (closure
  // pass): resolved BEFORE the renderer so the scene cache gets the restore
  // seam at construction. The source captures only the live binding — every
  // restore attempt re-reads dirty/revision and acquires the CURRENT cache,
  // so an R0 hydration can never serve geometry after R1 is current. Mount
  // performs NO whole-document unpack — packed entries install only as
  // objects enter viewport / progressive preparation priority. A dirty
  // session trusts nothing.
  const reopenOption = options.reopen;
  const reopenBinding: SurfaceReopenBinding | null =
    reopenOption !== undefined && reopenOption.documentId.length > 0
      ? reopenOption
      : null;
  let cachedRestore: ReturnType<typeof createLiveCachedCompiledRestore> | null =
    null;

  // --- Commit/prepared background-pack rendezvous (order-independent) ---
  // A geometry-changing commit and the committed scene's prepared
  // acknowledgement may arrive in either order:
  //   commit → prepared   (ordinary pen: commit at pointer-up, prepare on
  //                        the next committed frame)
  //   prepared → commit   (eraser mutations flush and render mid-gesture
  //                        before pointer-up; non-pointer history verbs may
  //                        also prepare before an explicit commit lands)
  // Scheduling runs only when a unit exists in BOTH domains; whichever side
  // arrives last triggers it. Entries are consumed when their unit
  // schedules (or resolves as already covered); FIFO caps keep stale keys
  // bounded.
  //
  // Keys are discriminated so a surviving logical unit remains representable
  // even when the directly mutated id no longer exists:
  //   `r:<id>` — single stroke record
  //   `l:<logicalId>` — logical stroke (current members resolved at schedule
  //     time via the model-scoped membership index, never a document scan).
  // Deleting B from L=A+B+C publishes `l:L` (via remembered ownership) on
  // both sides, so the surviving A+C joint re-queues instead of being lost.
  const BACKGROUND_PACK_RENDEZVOUS_CAP = 1024;
  const committedGeometryPending = new Set<string>();
  const preparedGeometryPending = new Set<string>();

  function notePending(set: Set<string>, ids: readonly string[]): void {
    for (const id of ids) {
      if (set.has(id)) continue;
      set.add(id);
      while (set.size > BACKGROUND_PACK_RENDEZVOUS_CAP) {
        const oldest = set.values().next().value;
        if (oldest === undefined) break;
        set.delete(oldest);
      }
    }
  }

  /**
   * Map mutated record ids to rendezvous keys via the shared Foundation
   * seam (model-scoped ownership index, never a document scan). Live
   * singles map to `r:<id>`; live chunks map to `l:<logical>` plus the
   * remembered old logical on replacement; deleted ids map to the
   * remembered old logical (survivor path).
   */
  function backgroundPackKeysForIds(ids: readonly string[]): string[] {
    try {
      return backgroundPackRendezvousKeysForIds(model, ids);
    } catch {
      return [];
    }
  }

  /**
   * Publish a geometry-changing canonical commit for background packing.
   * Only Ink stroke records participate; pure translations never call this
   * (zero-copy transform only) and irrelevant object types are filtered.
   * Destructive mutations publish the old logical identity (survivor path)
   * as well as any new/current identity.
   */
  function publishGeometryCommit(ids: readonly string[]): void {
    const keys = backgroundPackKeysForIds(ids);
    if (keys.length === 0) return;
    notePending(committedGeometryPending, keys);
    scheduleBackgroundPackRendezvous();
  }

  /**
   * Committed-scene preparation acknowledgement (scene-prepared ids).
   * Mapped through the same logical-key seam so a prepared acknowledgement
   * over a deleted id still resolves its surviving logical unit once the
   * committed scene has prepared the surviving membership.
   */
  function noteGeometryPrepared(ids: readonly string[]): void {
    const keys = backgroundPackKeysForIds(ids);
    if (keys.length === 0) return;
    notePending(preparedGeometryPending, keys);
    scheduleBackgroundPackRendezvous();
  }

  /**
   * Schedule units that exist in both commit and prepared domains.
   * Logical keys resolve to ONE prepared unit (joint Worker job, one
   * retained packed identity on every member); single keys use the ordinary
   * record path. A single that is not yet rich-warm keeps its rendezvous
   * markers so a later prepared pass can schedule it — a miss must never
   * consume the commit. Fully deleted logicals (no surviving members)
   * resolve to null and are dropped harmlessly.
   */
  function scheduleBackgroundPackRendezvous(): void {
    let hasIntersection = false;
    for (const key of committedGeometryPending) {
      if (preparedGeometryPending.has(key)) {
        hasIntersection = true;
        break;
      }
    }
    if (!hasIntersection) return;
    const consumed = new Set<string>();
    for (const key of committedGeometryPending) {
      if (!preparedGeometryPending.has(key) || consumed.has(key)) continue;
      if (key.startsWith('l:')) {
        const logicalId = key.slice(2);
        const unit = resolvePreparedBackgroundPackUnitForLogical(
          model,
          logicalId,
        );
        if (unit === null) {
          // Fully deleted/non-stroke logical: drop stale rendezvous.
          consumed.add(key);
          continue;
        }
        if (!scheduleBackgroundPackForPreparedUnit(unit, model)) continue;
        consumed.add(key);
        // Consume any peer single keys for the same members (defensive:
        // both sides now emit logical keys, but older queued singles for
        // the same members must not linger).
        if (unit.kind === 'logical') {
          for (const record of unit.records) consumed.add(`r:${record.id}`);
        }
        continue;
      }
      const id = key.startsWith('r:') ? key.slice(2) : key;
      const unit = resolvePreparedBackgroundPackUnit(model, id);
      if (unit === null) {
        // Deleted/non-stroke: drop the stale rendezvous harmlessly.
        consumed.add(key);
        continue;
      }
      if (!scheduleBackgroundPackForPreparedUnit(unit, model)) continue;
      consumed.add(key);
      if (unit.kind === 'logical') {
        consumed.add(`l:${unit.logicalId}`);
        for (const record of unit.records) {
          consumed.add(record.id);
          consumed.add(`r:${record.id}`);
        }
      }
    }
    for (const id of consumed) {
      committedGeometryPending.delete(id);
      preparedGeometryPending.delete(id);
    }
    // incremental retirement: historically replaced-away logicals whose
    // survivor publication just crossed the rendezvous (scheduled above, or
    // dropped as fully-deleted/non-stroke) retire from the Foundation
    // per-record pending sets. Only CONSUMED keys retire — unscheduled
    // (false) markers were never added to `consumed` and keep both their
    // rendezvous markers and their Foundation pending state for a later
    // prepared pass. Never breaks the rendezvous.
    if (consumed.size > 0) {
      try {
        acknowledgeBackgroundPackRendezvousKeys(model, [...consumed]);
      } catch {
        // Retirement never breaks scheduling.
      }
    }
  }

  /** Canonical content mutation: scene invalidation + geometry commit publication. */
  function publishContentMutation(ids: readonly string[]): void {
    committed.notifyContentMutated(ids);
    publishGeometryCommit(ids);
  }

  /**
   * Test-only canonical-mutation notifier for survivor rendezvous.
   *
   * Why this seam exists: no mounted public verb can delete/replace a SINGLE
   * chunk of a logical stroke in isolation. Every selection verb funnels
   * through `resolveGroupMembers` (one logical stroke behaves as one
   * selection identity), so `deleteSelection` on L-B deletes the whole
   * L=A+B+C; the eraser whole-stroke path expands logical ids the same way;
   * partial erasing retains the complete logical source with a mask. A test that needs "remove middle B, survivors A+C keep
   * L" must therefore perform the real Foundation capture/mutate/invalidate
   * boundary directly (the same `#before` → mutate → `#indexMutated` path
   * every tool funnels through) and then notify the mounted surface that
   * THESE ids mutated.
   *
   * Mutation-notify only, never the background scheduler: controller index
   * sync + scene version/mark-dirty + committed invalidation + geometry-commit
   * publication + one render frame (so the committed renderer's prepared side
   * can acknowledge on its next frame). The commit/prepared rendezvous and
   * the Worker scheduling it triggers stay fully production. O(mutated ids),
   * never O(document).
   *
   * Single-invalidation ownership: the controller sync above runs
   * `#indexMutated`, which performs THE post-mutation
   * `invalidateCompiledForIds` for these ids (exactly like every tool's
   * `#synced` path). Callers must capture pre-mutation ownership
   * (`captureGeometryOwnershipForIds`, mirroring `#before`) and mutate, but
   * must NOT pre-invalidate: a second invalidation after a same-id
   * non-stroke replacement reads back the already-overwritten (null)
   * ownership, treats it as a same-logical edit, and retires the survivor
   * tombstone — the rendezvous would then emit no key for the destructive
   * id. (Deletion tolerates a double invalidate only because a missing
   * record keeps its remembered mapping; replacement does not.)
   *
   * Seam disposition (rapid/L→M follow-up): this seam STAYS. `mountInkSurface`
   * defines no general `testHooks`/harness option (only narrow test ports
   * like `decodeImage`), so hiding the notifier would require either
   * production runtime branching (forbidden) or type-only indirection that
   * leaves the runtime surface identical while adding call-site friction.
   * A future single-chunk-capable tool verb should drive these paths through
   * the handle and let this seam retire with its tests.
   */
  function notifyCanonicalMutationForTests(ids: readonly string[]): void {
    if (ids.length === 0) return;
    try {
      controller.notifyExternalMutation(ids);
    } catch {
      // Index refresh never breaks notification.
    }
    sceneVersion += 1;
    options.markDirty();
    publishContentMutation(ids);
    scheduleRender();
  }

  if (reopenBinding !== null) {
    try {
      // Live source: no captured revision/cache. Dirty/null-revision mounts
      // still attach the source — it misses safely until clean.
      cachedRestore = createLiveCachedCompiledRestore(reopenBinding);
    } catch {
      // Restore never breaks mounting; misses compile normally.
      cachedRestore = null;
    }
  }

  // Committed render pipeline: backing/cache canvas lifecycle,
  // viewport/DPR sync, backend construction, cache rebuild, background
  // rendering, image-resolver consumption, and cached-scene compositing live
  // in the dedicated collaborator. Created before the controller so the
  // mutation recorder can forward content ids incrementally (O(new), never
  // O(document)) instead of discarding them behind a global version bump.
  const committed = createCommittedSceneRenderer({
    model,
    objectRegistry: sharedObjectRegistry,
    presentation,
    page,
    canvas,
    root,
    ...(options.renderViewport !== undefined
      ? { renderViewport: options.renderViewport }
      : {}),
    ...(options.backgroundItems !== undefined
      ? { backgroundItems: options.backgroundItems }
      : {}),
    ...(imageResolver !== undefined ? { imageResolver } : {}),
    ...(imageCache !== null ? { imageCache } : { imageCache: null }),
    frameResizable,
    isReadOnly: () => readOnly,
    compiledRestore: cachedRestore,
    // Viewport-oriented lazy open (Slice 7/9): spatial-index query for
    // visible + prefetch, so initial paint compiles only the viewport.
    queryVisible: (bounds) => {
      try {
        return controller.spatialQuery(bounds);
      } catch {
        return [...model.order];
      }
    },
    // Progressive fill repaints (Slice 8): offscreen slices request a
    // coalesced frame when they have new geometry to show.
    scheduleRender: () => scheduleRender(),
    onContentPrepared: (ids) => {
      noteGeometryPrepared(ids);
    },
  });

  let committingStrokePreviews: readonly DrawItem[] = [];
  const controller = new InkToolController({
    model,
    objectRegistry: sharedObjectRegistry,
    toolRegistry: registry,
    ...(options.ruler !== undefined && options.ruler !== null
      ? { ruler: options.ruler }
      : {}),
    erasurePreparation:
      options.erasurePreparation ??
      (typeof Worker === 'function' ? createErasurePreparation() : undefined),
    onErasureRefinement: (refinement, publish) =>
      history.refineErasure(refinement, () => {
        if (!destroyed)
          committed.notifyContentMutated([
            ...refinement.before.map((record) => record.id),
            ...refinement.after.map((record) => record.id),
          ]);
        publish();
      }),
    onGestureStart: () => history.beginGesture(),
    onGestureEnd: () => {
      committed.retainStrokePreviews(committingStrokePreviews);
      committingStrokePreviews = [];
      history.commitGesture();
      // Publish this gesture's committed geometry ids into the
      // commit/prepared rendezvous (order-independent: preparation may have
      // already happened mid-gesture). Pure translations publish nothing —
      // zero-copy transformed derived geometry is never recompiled or
      // re-packed. Composites publish ONLY follower patch ids; primaries
      // stay on the translated path. Deletion-only ids disappear
      // harmlessly at resolution.
      const change = history.lastChange();
      if (change.kind === 'patch') {
        publishGeometryCommit(change.ids);
      } else if (change.kind === 'translate-patch') {
        publishGeometryCommit(change.patchIds);
      }
      const createdCard = model.objects[model.order.at(-1) ?? ''];
      if (
        controller.activeToolId().endsWith('.card') &&
        createdCard?.type === 'froglight.card' &&
        change.kind === 'patch' &&
        change.ids.includes(createdCard.id)
      ) {
        openTextEditOverlay(createdCard.id, createdCard, true);
        controller.setSelection([createdCard.id]);
        notifyTools();
      }
      scheduleRender();
    },
    onGestureCancel: () => {
      committingStrokePreviews = [];
      history.cancelGesture();
      const restored = history.lastChangeIds();
      controller.notifyExternalMutation(restored);
      committed.notifyContentMutated(restored);
      if (restored.length > 0) options.markDirty();
      scheduleRender();
    },
    onBeforeMutate: (ids) => {
      const previews = controller
        .previewItems()
        .filter(
          (item) =>
            ids.includes(item.objectId) &&
            model.objects[item.objectId] === undefined,
        );
      if (previews.length > 0)
        committingStrokePreviews = [...committingStrokePreviews, ...previews];
      history.recordBeforeMany(ids);
      committed.notifyContentMutated(ids);
    },
    onBeforeTranslate: (ids, dx, dy) => {
      history.recordTranslate(ids, dx, dy);
      committed.notifyTranslated(ids, dx, dy);
    },
    onActiveToolChange: () => {
      notifyTools();
      scheduleRender();
    },
    onMutate: () => {
      sceneVersion += 1;
      options.markDirty();
      notifyTools();
      scheduleRender();
    },
  });

  const brushCursorTools: Partial<
    Record<
      string,
      {
        readonly preset: InkPresetToolId;
        readonly kind: InkBrushKind;
        readonly fallbackSize: number;
      }
    >
  > = {
    [SURFACE_TOOL_IDS.pen]: {
      preset: 'pen',
      kind: 'ball',
      fallbackSize: INK_DEFAULT_WIDTH,
    },
    [SURFACE_TOOL_IDS.fountain]: {
      preset: 'fountain',
      kind: 'fountain',
      fallbackSize: INK_DEFAULT_WIDTH,
    },
    [SURFACE_TOOL_IDS.brush]: {
      preset: 'brush',
      kind: 'brush',
      fallbackSize: INK_DEFAULT_WIDTH,
    },
    [SURFACE_TOOL_IDS.pencil]: {
      preset: 'pencil',
      kind: 'pencil',
      fallbackSize: INK_DEFAULT_WIDTH,
    },
    [SURFACE_TOOL_IDS.highlighter]: {
      preset: 'highlighter',
      kind: 'highlighter',
      fallbackSize: HIGHLIGHTER_PRESET.width,
    },
  };
  const resolveCursorTool = (): SurfaceCursorTool => {
    if (readOnly) return { kind: 'unknown' };
    const toolId = controller.activeToolId();
    const kind = cursorToolKind(toolId);
    if (kind === 'brush') {
      const entry = brushCursorTools[toolId];
      if (entry === undefined) return { kind: 'unknown' };
      const preset = presetStore.getTool(entry.preset);
      return {
        kind: 'brush',
        brush: resolveBrushSpec(
          {
            ...preset.brush,
            size: preset.size ?? entry.fallbackSize,
          },
          brushPresetForKind(entry.kind),
        ),
      };
    }
    if (kind === 'eraser') {
      const preset = presetStore.getEraser();
      const mode = normalizeEraserMode(preset.mode);
      return {
        kind: 'eraser',
        radiusView:
          mode === 'precision'
            ? (preset.radius ??
              eraserStyle.radius ??
              DEFAULT_ERASER_RADIUS_VIEW)
            : DEFAULT_ERASER_RADIUS_VIEW,
        mode,
      };
    }
    if (kind === 'lasso') {
      return {
        kind: 'lasso',
        mode: presetStore.getLasso().mode ?? 'freehand',
      };
    }
    return { kind };
  };
  const cursorPresenter = createSurfaceCursorPresenter({
    canvas,
    ...(options.renderViewport !== undefined
      ? { coordinateElement: page }
      : {}),
    indicator: options.host.pointerIndicator,
    resolveTool: resolveCursorTool,
    camera: () => controller.camera(),
    ...(options.supportsCustomCursor !== undefined
      ? { supportsCustomCursor: options.supportsCustomCursor }
      : {}),
  });

  // Cold-open repair: seed the spatial/derived indexes from
  // decode-time bounds when the provider preserved them through the
  // session. Seeding is O(objects) with no sample scans; absent or
  // malformed seeds keep the lazy derivation path. Never throws.
  if (
    options.seedBounds !== undefined &&
    isValidSeedBounds(options.seedBounds)
  ) {
    try {
      // Text bounds depend on the mounted font; decode-time estimates cannot
      // seed its interactive geometry. Stroke seeds remain reusable.
      controller.seedIndexesFromDecode(
        new Map(
          [...options.seedBounds].filter(
            ([id]) => model.objects[id]?.type !== 'froglight.text',
          ),
        ),
      );
    } catch {
      // Seeding never breaks mounting; first query rebuilds normally.
    }
  }

  // Packed-vector restore (final pass, item 1; dense-document pass): the
  // lazy restore source attached above unpacks cached vectors only as
  // objects enter preparation priority — mount and async hydration never
  // walk the whole document. Misses compile via the Worker cold lane. The
  // binding is LIVE: revision and dirty state are re-read at every use, so
  // a save that happens while mounted changes what teardown persists. A
  // dirty session is never restored from (its model does not match the
  // saved bytes). Async host storage (OPFS/Tauri) hydrates afterwards and
  // the source claims those entries lazily; no synchronous whole-cache
  // restore is triggered. Never throws.
  if (reopenBinding !== null) {
    try {
      void reopenBinding.store
        .hydrate(reopenBinding.documentId)
        .then((installed) => {
          if (!installed || destroyed) return;
          if (liveIsDirty(reopenBinding)) return;
          // New entries arrived after mount: request a frame so the
          // viewport-first preparation path can claim them lazily.
          invalidateScene();
        });
    } catch {
      // Restore never breaks mounting; misses compile normally.
    }
  }

  /** False until the user pans/zooms manually; auto-fit yields then. */
  let userNavigated = false;

  /**
   * Settled exclusive tool for toolbar reconciliation.
   * Tracks the last explicit `doSetTool` selection only: temporary
   * entries (`enterTemporaryTool`) leave it untouched so snapshot `active`
   * keeps reporting the pre-hold tool while temp is held. Updated after
   * `controller.setTool` succeeds, so a rejected id never diverges it.
   */
  let settledToolId: string = controller.activeToolId();

  function resize(): void {
    committed.resize();
    scheduleRender();
  }

  /** Fit reference for bounded sheets; infinite/degenerate frames have none. */
  function fitReference(): Camera | null {
    const frame = frameBounds(model.frame);
    const size = committed.viewport();
    if (frame === null || size.width === 0 || size.height === 0) return null;
    return fitCameraToFrame(
      frame,
      { width: size.width, height: size.height },
      fitInsetForPresentation(presentation),
      presentation === 'paint-stage' ? 'navigation' : 'embedded',
    );
  }

  /**
   * Scale and center the bounded page to fill the editor pane — the
   * Paint model: the canvas IS the window, not a small box at 100%.
   * Camera math lives in ./surface/camera.js; this only coordinates lifecycle.
   */
  function fitToView(): void {
    const next = fitReference();
    if (next === null) {
      // Infinite/degenerate frames have no fit target (whiteboard): still
      // clear navigation so later auto-fit decisions see the settled state.
      // No camera move and no frame — retain the zoom notification gate.
      if (userNavigated) {
        userNavigated = false;
        syncZoomState();
      }
      return;
    }
    controller.setCamera(next);
    userNavigated = false;
    scheduleRender();
    syncZoomState();
  }

  /** Keep a finite sheet reachable without permitting an infinite desk. */
  function clampCameraToSheet(camera: Camera): Camera {
    // The pager owns embedded navigation. Input interruption must not clamp
    // the geometric fit back to the standalone user zoom range.
    if (navigationMode === 'embedded') return fitReference() ?? camera;
    const size = committed.viewport();
    return boundedCamera(
      camera,
      frameBounds(model.frame),
      { width: size.width, height: size.height },
      presentation === 'paint-stage' ? 0.7 : undefined,
    );
  }

  function commitCamera(camera: Camera): void {
    controller.setCamera(clampCameraToSheet(camera));
    userNavigated = true;
    scheduleRender();
    // Camera-driven notifications remain behind the zoom-percent gate.
    syncZoomState();
  }

  function setZoomFactor(zoom: number, anchor?: Point): void {
    if (!Number.isFinite(zoom)) return;
    const current = controller.camera();
    const size = committed.viewport();
    const point = anchor ?? { x: size.width / 2, y: size.height / 2 };
    commitCamera(zoomCameraAroundPoint(current, zoom, point));
  }

  function resizeFrame(width: number, height: number): boolean {
    const frame = frameBounds(model.frame);
    if (frame === null) return false;
    const next = {
      width: clampFrameSize(width),
      height: clampFrameSize(height),
    };
    if (next.width === frame.width && next.height === frame.height)
      return false;
    model.frame = { ...model.frame, kind: 'bounded', ...next };
    options.markDirty();
    sceneVersion += 1;
    if (userNavigated)
      controller.setCamera(clampCameraToSheet(controller.camera()));
    else fitToView();
    notifyTools();
    scheduleRender();
    return true;
  }

  // Single shared input+render frame (live-writing repair): pointer events
  // buffer cheaply in the pointer controller and schedule this scheduler;
  // the frame drains confirmed input + latest prediction, publishes live
  // geometry once, then paints once — never two rAFs (no input frame plus
  // render frame). `pointerHandler` is assigned below; `onFrame` runs only
  // after mount, so the closure is safe.
  let renderFrames = 0;
  let frameContentTranslation: Point | null = null;
  let lastDragPosition = '';
  function render(): void {
    if (destroyed) return;
    // The pager settles its transform into layout before this rAF, while
    // ResizeObserver delivers afterwards. Fit and repaint together so the
    // first settled frame cannot combine the new raster with the old camera.
    if (committed.syncSize()) {
      if (!userNavigated) {
        const next = fitReference();
        if (next !== null) {
          controller.setCamera(next);
          syncZoomState();
        }
      }
      pointerHandler?.refreshCursor();
    }
    renderFrames += 1;
    const drag = controller.selectionDrag();
    const editingId = textOverlayHandle.editingId();
    if (editingId !== null) {
      committed.render(
        controller.camera(),
        sceneVersion,
        controller.previewItems(),
        [],
        {
          ids: [editingId],
          dx: 0,
          dy: 0,
          hidden: true,
        },
      );
    } else if (drag !== null) {
      committed.render(
        controller.camera(),
        sceneVersion,
        controller.previewItems(),
        controller.selection(),
        {
          ids: [
            ...drag.logicalIds,
            ...drag.followers.map((item) => item.objectId),
          ],
          followers: drag.followers,
          dx: drag.delta.x,
          dy: drag.delta.y,
          translatedBounds: controller.dragTranslatedBounds(),
        },
        undefined,
        frameContentTranslation,
      );
    } else {
      committed.render(
        controller.camera(),
        sceneVersion,
        controller.previewItems(),
        controller.selection(),
        null,
        // Cached selection union (Slice 10): pan/selection frames skip
        // per-stroke sample rescans for chrome.
        controller.selectionBoundsCached(),
        frameContentTranslation,
      );
    }
    const dragPosition = drag === null ? '' : `${drag.delta.x}:${drag.delta.y}`;
    if (dragPosition !== lastDragPosition) {
      lastDragPosition = dragPosition;
      notifyTools();
    }
    if (pointerHandler?.hasTransientNavigation() !== true) syncZoomState();
  }

  // Invalidation coalesces through the shared render scheduler;
  // the orchestrator only decides *when* a frame runs, the committed
  // renderer owns *what* pixels mean.
  const renderScheduler = createRenderScheduler({
    requestFrame: (cb) => requestAnimationFrame(cb),
    cancelFrame: (id) => cancelAnimationFrame(id),
    onFrame: (timeMs) => {
      // Conceptually: `pointerHandler.flushPendingInputWithoutSchedulingRender(); render();`
      // — drain the newest confirmed state + latest prediction immediately
      // before paint, then paint once. The flush never schedules another
      // frame, so bursts collapse to one flush + one paint per visible frame.
      pointerHandler?.flushPendingInputWithoutSchedulingRender();
      const navigationActive =
        pointerHandler?.advanceNavigation(timeMs) === true;
      render();
      if (navigationActive) scheduleRender();
    },
  });
  function scheduleRender(): void {
    if (destroyed) return;
    renderScheduler.schedule();
  }

  let lastZoomPercent = -1;
  let textCreationStyle: SelectionStyle = {};

  function pendingTextStyleState(): SurfaceTextSelectionState {
    const size = textCreationStyle.textSize ?? 16;
    const role = textCreationStyle.textRole;
    const style =
      role !== 'heading'
        ? 'body'
        : size >= 24
          ? 'h1'
          : size >= 20
            ? 'h2'
            : 'h3';
    return {
      hasText: true,
      style,
      size,
      bold: { active: textCreationStyle.textBold === true, mixed: false },
      italic: { active: textCreationStyle.textItalic === true, mixed: false },
      align:
        textCreationStyle.textAlign === 'center' ||
        textCreationStyle.textAlign === 'end'
          ? textCreationStyle.textAlign
          : 'start',
      color:
        textCreationStyle.color ?? penStyle.color ?? SURFACE_TEXT_DEFAULT_COLOR,
      wrap: { active: textCreationStyle.textWrap === true, mixed: false },
    };
  }

  function currentTextStyleState(): SurfaceTextSelectionState {
    const selected = deriveSurfaceTextSelectionState(
      model,
      controller.selection(),
    );
    return controller.selection().length > 0
      ? selected
      : pendingTextStyleState();
  }

  function textRecordAppearance(
    wrapWidth?: number,
  ): Record<string, unknown> | undefined {
    const appearance: Record<string, unknown> = {};
    if (textCreationStyle.textBold === true) appearance.bold = true;
    if (textCreationStyle.textItalic === true) appearance.italic = true;
    if (
      textCreationStyle.textAlign === 'start' ||
      textCreationStyle.textAlign === 'center' ||
      textCreationStyle.textAlign === 'end'
    ) {
      appearance.align = textCreationStyle.textAlign;
    }
    if (wrapWidth !== undefined || textCreationStyle.textWrap === true) {
      appearance.wrapWidth = wrapWidth ?? TEXT_DEFAULT_WRAP_WIDTH;
    }
    return Object.keys(appearance).length > 0 ? appearance : undefined;
  }
  function syncZoomState(): void {
    const percent = Math.round(controller.camera().zoom * 100);
    const zoomChanged = percent !== lastZoomPercent;
    if (zoomChanged) lastZoomPercent = percent;
    if (zoomChanged) notifyTools();
  }

  /** Direct object commit for flows outside the tool context (text). */
  function addObjectDirect(record: SurfaceObjectRecord): void {
    history.recordBefore(record.id);
    model.objects[record.id] = record;
    model.order.push(record.id);
    try {
      controller.notifyExternalMutation([record.id]);
    } catch {
      // Index refresh never breaks direct commits.
    }
    publishContentMutation([record.id]);
    sceneVersion += 1;
    options.markDirty();
    scheduleRender();
  }

  // --- Inline text editing overlay ---
  // Lifecycle lives in ./surface/text-overlay.js; this only wires commit.
  // React owns the container: the engine mounts the ephemeral
  // editor inside `overlayRoot` and never creates visible structure
  // itself.
  const textOverlayHandle = createTextOverlay({
    overlayRoot: options.host.overlayRoot,
    focusReturn: root,
    onOpenChange: () => {
      if (textOverlayHandle.isOpen()) {
        releaseTextEntry ??=
          options.stylusInput?.acquireInputContext('text-entry');
      } else {
        releaseTextEntry?.();
        releaseTextEntry = undefined;
      }
      if (!textOverlayHandle.isOpen()) controller.setSelection([]);
      scheduleRender();
      notifyTools();
    },
    keepOpenForTarget: (target) => {
      if (!(target instanceof Element)) return false;
      const pane = root.closest('[data-pane]');
      return (
        (pane === null || pane.contains(target)) &&
        target.closest(
          '[data-active-tool-menu], [data-anchor="float.selection"], [data-selection-toolbar], [data-popover-layer]',
        ) !== null
      );
    },
    onCommitCreate: (surfacePoint, text, wrapWidth) => {
      const normalized = normalizeOverlayText(text);
      if (normalized === '' || normalized.trim() === '') return;
      const id = `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      history.beginGesture();
      try {
        const appearance = textRecordAppearance(wrapWidth);
        addObjectDirect(
          textObject(id, {
            x: surfacePoint.x,
            y: surfacePoint.y,
            text: normalized,
            color: textCreationStyle.color ?? penStyle.color,
            ...(textCreationStyle.textRole === 'body' ||
            textCreationStyle.textRole === 'heading'
              ? { role: textCreationStyle.textRole }
              : {}),
            ...(textCreationStyle.textSize !== undefined
              ? { size: textCreationStyle.textSize }
              : {}),
            ...(appearance !== undefined ? { appearance } : {}),
          }),
        );
        history.commitGesture();
        controller.setSelection([]);
        notifyTools();
        scheduleRender();
      } catch (error) {
        try {
          history.cancelGesture();
        } catch {
          // Cancel never breaks commit.
        }
        throw error;
      }
    },
    onCommitEdit: (objectId, text, wrapWidth) => {
      const record = model.objects[objectId];
      if (
        record === undefined ||
        (record.type !== 'froglight.text' &&
          record.type !== 'froglight.card') ||
        typeof record.text !== 'string'
      ) {
        return;
      }
      const normalized = normalizeOverlayText(text);
      // No-op (including normalization-only equivalence with legacy CRLF
      // bytes): no history entry, no dirty, no render. Legacy bytes stay
      // verbatim until the user makes a real change.
      const priorWidth =
        typeof record.appearance === 'object' && record.appearance !== null
          ? (record.appearance as Record<string, unknown>).wrapWidth
          : undefined;
      const cardHeight =
        record.type === 'froglight.card'
          ? Math.max(
              Number(record.height),
              textV2Lines(
                normalized,
                Number(record.size ?? 14),
                Math.max(24, Number(record.width) - 16),
              ).length *
                Number(record.size ?? 14) *
                1.25 +
                16,
            )
          : undefined;
      if (
        (cardHeight === undefined || cardHeight === record.height) &&
        normalizeOverlayText(record.text) === normalized &&
        (wrapWidth === undefined || wrapWidth === priorWidth)
      )
        return;
      history.beginGesture();
      try {
        history.recordBefore(objectId);
        // In-place text swap only: role/color/appearance/rotation/size
        // and every unknown member survive verbatim.
        (record as Record<string, unknown>).text = normalized;
        if (record.type === 'froglight.card') {
          (record as Record<string, unknown>).height = cardHeight;
        }
        if (wrapWidth !== undefined && record.type !== 'froglight.card') {
          (record as Record<string, unknown>).appearance = {
            ...(typeof record.appearance === 'object' &&
            record.appearance !== null
              ? (record.appearance as Record<string, unknown>)
              : {}),
            wrapWidth,
          };
        }
        try {
          controller.notifyExternalMutation([objectId]);
        } catch {
          // Index refresh never breaks direct commits.
        }
        publishContentMutation([objectId]);
        sceneVersion += 1;
        options.markDirty();
        scheduleRender();
        history.commitGesture();
      } catch (error) {
        try {
          history.cancelGesture();
        } catch {
          // Cancel never breaks commit.
        }
        throw error;
      }
    },
  });

  function openTextEditOverlay(
    objectId: string,
    record: SurfaceObjectRecord,
    selectAll: boolean,
  ): boolean {
    if (
      (record.type !== 'froglight.text' && record.type !== 'froglight.card') ||
      typeof record.text !== 'string' ||
      typeof record.x !== 'number' ||
      typeof record.y !== 'number'
    ) {
      return false;
    }

    const isCard = record.type === 'froglight.card';
    const textPage =
      options.restrictTextToFrame === true ? frameBounds(model.frame) : null;
    const maxWrapWidth =
      textPage !== null &&
      record.x >= 0 &&
      record.x < textPage.width - (isCard ? 32 : 24)
        ? textPage.width - record.x - (isCard ? 8 : 0)
        : undefined;
    textOverlayHandle.openEdit({
      objectId,
      // Card text is rendered with an 8px inset from the card frame.
      surfacePoint: {
        x: record.x + (isCard ? 8 : 0),
        y: record.y + (isCard ? 8 : 0),
      },
      camera: controller.camera(),
      text: record.text,
      // Cards render at 14px when size is absent; plain Surface text keeps
      // its existing Surface text fallback inside the overlay.
      size: isCard && record.size === undefined ? 14 : record.size,
      color: typeof record.color === 'string' ? record.color : undefined,
      appearance: isCard
        ? { wrapWidth: Math.max(24, Number(record.width) - 16) }
        : record.appearance,
      ...(isCard
        ? {
            maxWrapWidth: Math.max(24, Number(record.width) - 16),
            maxHeight: Math.max(16, Number(record.height) - 16),
            resizable: false,
          }
        : {}),
      role: isCard ? undefined : (record as Record<string, unknown>).role,
      ...(!isCard && maxWrapWidth !== undefined ? { maxWrapWidth } : {}),
      ...(selectAll ? { selectAll: true } : {}),
    });
    return true;
  }

  function openTextOverlay(
    surfacePoint: Point,
    openOptions: { selectAll?: boolean } = {},
  ): void {
    if (readOnly || destroyed) return;
    // Tap on existing text edits it in place; empty space creates.
    // `hitTest` already excludes locked objects (they never hit).
    try {
      const hit = controller.hitTest(surfacePoint);
      if (hit !== null) {
        const record = model.objects[hit];
        if (
          record !== undefined &&
          openTextEditOverlay(hit, record, openOptions.selectAll === true)
        ) {
          try {
            controller.setSelection([hit]);
          } catch {
            // Selection never breaks open.
          }
          scheduleRender();
          return;
        }
        return;
      }
    } catch {
      // Hit-testing never breaks open; fall through to create.
    }
    let pageTextWidth: number | undefined;
    const textPage = frameBounds(model.frame);
    if (textPage !== null && options.restrictTextToFrame === true) {
      if (
        surfacePoint.x < 0 ||
        surfacePoint.y < 0 ||
        surfacePoint.x > textPage.width - 24 ||
        surfacePoint.y >
          textPage.height - (textCreationStyle.textSize ?? 16) * 1.25
      )
        return;
      pageTextWidth = Math.min(
        TEXT_DEFAULT_WRAP_WIDTH,
        Math.max(24, textPage.width - surfacePoint.x),
      );
    }
    controller.setSelection([]);
    textOverlayHandle.openRequest({
      kind: 'create',
      surfacePoint,
      camera: controller.camera(),
      penColor: penStyle.color,
      penSize: penStyle.width,
      size: textCreationStyle.textSize,
      color: textCreationStyle.color ?? penStyle.color,
      role: textCreationStyle.textRole,
      appearance: textRecordAppearance(pageTextWidth),
      ...(pageTextWidth !== undefined && textPage !== null
        ? { maxWrapWidth: textPage.width - surfacePoint.x }
        : {}),
      ...(openOptions.selectAll === true ? { selectAll: true } : {}),
    });
  }

  /**
   * Enter-to-edit: a single selected text object opens for edit.
   * Returns true when an editor opened.
   */
  function openTextOverlayAtSelection(selectAll = false): boolean {
    if (readOnly || destroyed || textOverlayHandle.isOpen()) return false;
    let selected: readonly string[];
    try {
      selected = controller.selection();
    } catch {
      return false;
    }
    if (selected.length !== 1) return false;
    const id = selected[0]!;
    const record = model.objects[id];
    return record !== undefined
      ? openTextEditOverlay(id, record, selectAll)
      : false;
  }

  function closeTextOverlay(commitPending: boolean): void {
    textOverlayHandle.close(commitPending);
  }

  function syncTextOverlayAppearance(): void {
    if (!textOverlayHandle.isOpen()) return;
    const id = textOverlayHandle.editingId();
    const record = id === null ? undefined : model.objects[id];
    textOverlayHandle.updateAppearance(
      record === undefined
        ? {
            size: textCreationStyle.textSize,
            color: textCreationStyle.color ?? penStyle.color,
            role: textCreationStyle.textRole,
            appearance: textRecordAppearance(),
          }
        : {
            size:
              record.type === 'froglight.card'
                ? (record.size ?? 14)
                : record.size,
            color: typeof record.color === 'string' ? record.color : undefined,
            role: record.role,
            appearance: record.appearance,
          },
    );
  }

  // --- Image insertion (#42) ---
  // File-to-asset insertion lives in ./surface/image-ingest.js.

  let imageInput: HTMLInputElement | null = null;

  const imageIngester = createImageIngester({
    model,
    assets,
    ...(options.decodeImage !== undefined
      ? { decode: options.decodeImage }
      : {}),
    ...(imageCache !== null ? { imageCache } : { imageCache: null }),
    getFrame: () => frameBounds(model.frame),
    getCamera: () => controller.camera(),
    getViewport: () => {
      const size = committed.viewport();
      return { width: size.width, height: size.height };
    },
    beginGesture: () => history.beginGesture(),
    commitGesture: () => {
      history.commitGesture();
      const ids = history.lastChangeIds();
      try {
        controller.notifyExternalMutation(ids);
      } catch {
        // Index refresh never breaks image commits.
      }
      publishContentMutation(ids);
    },
    addObject: (record) => {
      history.recordBefore(record.id);
      model.objects[record.id] = record as SurfaceObjectRecord;
      model.order.push(record.id);
    },
    setSelection: (ids) => controller.setSelection(ids),
    isReadOnly: () => readOnly,
    isDestroyed: () => destroyed,
  });

  function canInsertImage(): boolean {
    return imageIngester.canInsert();
  }

  async function insertImageFile(file: File): Promise<string | null> {
    const id = await imageIngester.insertImage(file);
    if (id !== null) {
      publishContentMutation(
        history.lastChangeIds().length > 0 ? history.lastChangeIds() : [id],
      );
      options.markDirty();
      sceneVersion += 1;
      scheduleRender();
    }
    return id;
  }

  function chooseImage(): void {
    if (!canInsertImage()) return;
    if (imageInput === null) {
      // Engine-owned ephemeral file picker: hidden
      // input created once, clicked programmatically, never visible.
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      input.hidden = true;
      input.addEventListener('change', () => {
        const file = input.files?.[0];
        // Reset so picking the same file again still fires change.
        input.value = '';
        if (file !== undefined) void surfaceApi.insertImage(file);
      });
      root.appendChild(input);
      imageInput = input;
    }
    imageInput.click();
  }

  // --- Pointer/wheel/keyboard state machine ---
  // All gesture state lives in ./surface/pointer-controller.js; this only
  // supplies narrow ports and wires lifecycle. Pure classification stays in
  // ./surface/pointer.js, camera/frame math in ./surface/camera.js and
  // ./surface/frame-resize.js.

  function notifyHistoryChange(): void {
    // Split routing on the discriminated last change: primaries take the
    // translated path ONLY (no geometry recompile/publication), followers
    // take the ordinary mutation/content path.
    const change = history.lastChange();
    if (change.kind === 'translate') {
      try {
        controller.notifyTranslated(change.ids, change.dx, change.dy);
      } catch {
        try {
          controller.notifyExternalMutation(change.ids);
        } catch {
          // Index refresh never breaks undo/redo.
        }
      }
      committed.notifyTranslated(change.ids, change.dx, change.dy);
      return;
    }
    if (change.kind === 'translate-patch') {
      const { translate, patchIds } = change;
      try {
        controller.notifyTranslated(translate.ids, translate.dx, translate.dy);
      } catch {
        try {
          controller.notifyExternalMutation([...translate.ids]);
        } catch {
          // Index refresh never breaks undo/redo.
        }
      }
      committed.notifyTranslated(
        [...translate.ids],
        translate.dx,
        translate.dy,
      );
      try {
        controller.notifyExternalMutation(patchIds);
      } catch {
        // Index refresh never breaks undo/redo.
      }
      publishContentMutation(patchIds);
      return;
    }
    const ids = change.kind === 'patch' ? change.ids : [];
    try {
      controller.notifyExternalMutation(ids);
    } catch {
      // Index refresh never breaks undo/redo.
    }
    publishContentMutation(ids);
  }

  function doUndo(): boolean {
    // no-loss: pending text commits first so undo never discards
    // keystrokes (the commit becomes the latest gesture, which this undo
    // then reverts — redo restores it).
    closeTextOverlay(true);
    const ok = history.undo();
    if (ok) {
      notifyHistoryChange();
      controller.retryErasure();
      options.markDirty();
      notifyTools();
      invalidateScene();
    }
    return ok;
  }

  function doRedo(): boolean {
    closeTextOverlay(true);
    const ok = history.redo();
    if (ok) {
      notifyHistoryChange();
      controller.retryErasure();
      options.markDirty();
      notifyTools();
      invalidateScene();
    }
    return ok;
  }

  function doSetTool(toolId: string): void {
    // no-loss: switching tools commits pending text (never discards).
    closeTextOverlay(true);
    // An explicit choice is the settled exclusive tool; temporary entries
    // never move it. Publish it before tool-change notifications.
    settledToolId = toolId;
    controller.setTool(toolId);
    if (controller.isAuthoringTool()) controller.setSelection([]);
    notifyTools();
    scheduleRender();
  }

  /**
   * Run one selection verb inside a single history transaction: empty
   * results roll back without touching dirty state or undo history.
   * Committed-scene invalidation is incremental (content ids from the
   * patch, never a full rescan).
   *
   * `publishGeometry: false` marks verbs that change paint order or
   * grouping only (never Ink geometry): they still notify the committed
   * scene but must not enter the background-pack geometry lifecycle.
   */
  function selectionTransaction(
    run: () => string[],
    transactionOptions?: { publishGeometry?: boolean },
  ): string[] {
    history.beginGesture();
    try {
      const ids = run();
      if (ids.length > 0) {
        options.markDirty();
        notifyTools();
        scheduleRender();
        history.commitGesture();
        // Split routing on the discriminated last change. Pure patches
        // keep the existing external-mutation path (with the exact patch
        // set covering followers beyond the verb's `ids`); pure translates
        // take the translated path only; composites take BOTH.
        const change = history.lastChange();
        if (change.kind === 'translate') {
          try {
            controller.notifyTranslated(change.ids, change.dx, change.dy);
          } catch {
            // Index refresh never breaks verbs.
          }
          committed.notifyTranslated(change.ids, change.dx, change.dy);
        } else if (change.kind === 'translate-patch') {
          try {
            controller.notifyTranslated(
              change.translate.ids,
              change.translate.dx,
              change.translate.dy,
            );
          } catch {
            // Index refresh never breaks verbs.
          }
          committed.notifyTranslated(
            [...change.translate.ids],
            change.translate.dx,
            change.translate.dy,
          );
          const patchIds = change.patchIds;
          const finalPatchIds = patchIds.length > 0 ? patchIds : [];
          try {
            controller.notifyExternalMutation(finalPatchIds);
          } catch {
            // Index refresh never breaks verbs.
          }
          if (finalPatchIds.length > 0) {
            if (transactionOptions?.publishGeometry === false) {
              committed.notifyContentMutated(finalPatchIds);
            } else {
              publishContentMutation(finalPatchIds);
            }
          }
        } else {
          // Forward the exact patch set for the incremental scene cache
          // (covers followers/connectors beyond the verb's `ids`).
          const finalIds =
            change.kind === 'patch' && change.ids.length > 0
              ? [...change.ids]
              : ids;
          try {
            controller.notifyExternalMutation(finalIds);
          } catch {
            // Index refresh never breaks verbs.
          }
          if (transactionOptions?.publishGeometry === false) {
            committed.notifyContentMutated(finalIds);
          } else {
            publishContentMutation(finalIds);
          }
        }
      } else {
        history.cancelGesture();
      }
      return ids;
    } catch (error) {
      history.cancelGesture();
      throw error;
    }
  }

  const createdPointerHandler = createPointerController({
    objectRegistry: sharedObjectRegistry,
    model,
    controller,
    canvas,
    ...(options.renderViewport !== undefined
      ? { coordinateElement: page }
      : {}),
    page,
    badge,
    cursorPresenter,
    navigationMode,
    cameraInteractive,
    frameResizable,
    ...(options.delegateTouchNavigation !== undefined
      ? { delegateTouchNavigation: options.delegateTouchNavigation }
      : {}),
    isReadOnly: () => readOnly,
    isDestroyed: () => destroyed,
    isUserNavigated: () => userNavigated,
    setUserNavigated: (value: boolean) => {
      userNavigated = value;
    },
    getActiveToolId: () => controller.activeToolId(),
    beginHistoryGesture: () => history.beginGesture(),
    commitHistoryGesture: () => history.commitGesture(),
    cancelHistoryGesture: () => history.cancelGesture(),
    canRebaseFrameContent: () => controller.canTranslateAll(),
    previewFrameContentTranslation: (delta) => {
      frameContentTranslation = delta === null ? null : { ...delta };
      scheduleRender();
    },
    commitFrameContentTranslation: (delta) => {
      controller.translateAllBy(delta);
    },
    clampToSheet: (camera: Camera) => clampCameraToSheet(camera),
    setZoomFactor: (zoom: number, anchor?: Point) =>
      setZoomFactor(zoom, anchor),
    syncZoomState: () => syncZoomState(),
    scheduleRender: () => scheduleRender(),
    invalidateScene: () => invalidateScene(),
    fitToView: () => fitToView(),
    notifyTools: () => notifyTools(),
    markDirty: () => options.markDirty(),
    openTextOverlay: (surfacePoint: Point) => openTextOverlay(surfacePoint),
    openTextOverlayAtSelection: () => openTextOverlayAtSelection(false),
    isTextOverlayOpen: () => textOverlayHandle.isOpen(),
    requestUndo: () => doUndo(),
    requestRedo: () => doRedo(),
    requestDeleteSelection: () => {
      selectionTransaction(() => controller.deleteSelection());
    },
    requestSetTool: (toolId: string) => doSetTool(toolId),
    reducedMotion: () => {
      try {
        return matchMedia('(prefers-reduced-motion: reduce)').matches;
      } catch {
        return false;
      }
    },
    // Production draws coalesce into the ONE shared render frame: rapid
    // 120/240Hz input buffers cheaply and publishes once per visible frame
    // (one input flush + one paint). Confirmed samples are never dropped;
    // predictions keep only the latest horizon-clipped set. No separate
    // input-frame scheduler exists anymore (two-rAF latency retired).
    coalesceDrawInput: true,
    ...(options.predictionPolicy !== undefined
      ? { predictionPolicy: options.predictionPolicy }
      : {}),
    ...(options.onEmbeddedPan !== undefined
      ? { onEmbeddedPan: options.onEmbeddedPan }
      : {}),
    ...(options.onEmbeddedZoom !== undefined
      ? { onEmbeddedZoom: options.onEmbeddedZoom }
      : {}),
    ...(options.onEmbeddedPanEnd !== undefined
      ? { onEmbeddedPanEnd: options.onEmbeddedPanEnd }
      : {}),
    ...(options.onEmbeddedZoomEnd !== undefined
      ? { onEmbeddedZoomEnd: options.onEmbeddedZoomEnd }
      : {}),
    ...(options.onEmbeddedCancel !== undefined
      ? { onEmbeddedCancel: options.onEmbeddedCancel }
      : {}),
    ...(options.onEmbeddedWheel !== undefined
      ? { onEmbeddedWheel: options.onEmbeddedWheel }
      : {}),
  });
  pointerHandler = createdPointerHandler;

  const observer =
    typeof ResizeObserver === 'function'
      ? new ResizeObserver(() => {
          // Observer delivery is after rAF: allocating here clears pixels
          // immediately but postpones their replacement until the next frame.
          scheduleRender();
        })
      : null;
  observer?.observe(page);
  createdPointerHandler.attach(root);

  // --- Public handle ---

  const surfaceApi: InkSurfaceHandle = {
    root,
    setReadOnly(value) {
      readOnly = value;
      root.dataset.readOnly = String(value);
      if (value) {
        createdPointerHandler.resetForReadOnly();
        page.classList.remove('panning');
        closeTextOverlay(true);
      }
      syncDrawingContext();
      createdPointerHandler.refreshCursor();
      scheduleRender();
    },
    setTool(toolId: string): void {
      doSetTool(toolId);
    },
    activeToolId: () => controller.activeToolId(),
    // Settled exclusive tool: the last explicit selection.
    // Temporary entries never move it, so toolbar `active` ignores temp.
    settledActiveToolId: () => settledToolId,
    enterTemporaryTool: (toolId: string) =>
      controller.enterTemporaryTool(toolId),
    exitTemporaryTool: () => controller.exitTemporaryTool(),
    selectionBounds: () => controller.selectionBoundsCached(),
    moveSelectionBy: (delta: Point) =>
      selectionTransaction(() => [...controller.moveSelectionBy(delta)]),
    selectionViewportBounds: () => {
      const bounds =
        controller.dragTranslatedBounds() ?? controller.selectionBoundsCached();
      if (bounds === null) return null;
      const camera = controller.camera();
      const rect = page.getBoundingClientRect();
      const scaleX = rect.width / Math.max(page.clientWidth, 1);
      const scaleY = rect.height / Math.max(page.clientHeight, 1);
      return {
        x: rect.left + (bounds.x - camera.x) * camera.zoom * scaleX,
        y: rect.top + (bounds.y - camera.y) * camera.zoom * scaleY,
        width: bounds.width * camera.zoom * scaleX,
        height: bounds.height * camera.zoom * scaleY,
      };
    },
    selectionContext: () => controller.selectionContext(),
    duplicateSelection: () =>
      selectionTransaction(() => controller.duplicateSelection()),
    deleteSelection: () => {
      const removed = selectionTransaction(() => controller.deleteSelection());
      if (removed.length > 0) root.focus({ preventScroll: true });
      return removed;
    },
    setSelectionStyle: (style: SelectionStyle) => {
      const changed = selectionTransaction(() =>
        controller.setSelectionStyle(style),
      );
      syncTextOverlayAppearance();
      return changed;
    },
    textStyleState: () => currentTextStyleState(),
    setTextStyle: (style: SelectionStyle) => {
      const selected = deriveSurfaceTextSelectionState(
        model,
        controller.selection(),
      );
      if (selected.hasText) {
        const changed = selectionTransaction(() =>
          controller.setSelectionStyle(style),
        );
        syncTextOverlayAppearance();
        return changed;
      }
      textCreationStyle = { ...textCreationStyle, ...style };
      syncTextOverlayAppearance();
      notifyTools();
      return [];
    },
    reorderSelection: (where: ReorderDirection) =>
      selectionTransaction(() => controller.reorderSelection(where), {
        publishGeometry: false,
      }),
    scaleSelection: (factor: number, center?: Point) =>
      selectionTransaction(() => controller.scaleSelection(factor, center)),
    rotateSelection: (deltaRadians: number, center?: Point) =>
      selectionTransaction(() =>
        controller.rotateSelection(deltaRadians, center),
      ),
    alignSelection: (edge: AlignEdge) =>
      selectionTransaction(() => controller.alignSelection(edge)),
    distributeSelection: (axis: DistributeAxis) =>
      selectionTransaction(() => controller.distributeSelection(axis)),
    setLocked: (ids: readonly string[], locked: boolean) => {
      history.beginGesture();
      try {
        const mutated = controller.setLocked(ids, locked);
        if (mutated.length > 0) {
          options.markDirty();
          notifyTools();
          scheduleRender();
          history.commitGesture();
          committed.notifyContentMutated(history.lastChangeIds());
        } else {
          history.cancelGesture();
        }
        return mutated;
      } catch (error) {
        history.cancelGesture();
        throw error;
      }
    },
    groupSelection: () =>
      selectionTransaction(
        () => {
          const group = controller.groupSelection();
          return group === null ? [] : [group];
        },
        { publishGeometry: false },
      ),
    ungroupSelection: () =>
      selectionTransaction(() => controller.ungroupSelection(), {
        publishGeometry: false,
      }),
    connectEndpoints: (
      source: { objectId: string; anchor?: ConnectorAnchor } | { point: Point },
      target: { objectId: string; anchor?: ConnectorAnchor } | { point: Point },
      style?: {
        path?: ConnectorPath;
        arrows?: LineArrows;
        color?: string;
        width?: number;
        opacity?: number;
      },
    ) => {
      history.beginGesture();
      try {
        const id = controller.connectEndpoints(source, target, style);
        options.markDirty();
        notifyTools();
        scheduleRender();
        history.commitGesture();
        publishContentMutation(history.lastChangeIds());
        return id;
      } catch (error) {
        history.cancelGesture();
        throw error;
      }
    },
    rebindConnector: (
      id: string,
      end: 'source' | 'target',
      binding:
        | { objectId: string; anchor?: ConnectorAnchor }
        | { point: Point }
        | null,
    ) => {
      history.beginGesture();
      try {
        const ok = controller.rebindConnector(id, end, binding);
        if (ok) {
          options.markDirty();
          notifyTools();
          scheduleRender();
          history.commitGesture();
          publishContentMutation(history.lastChangeIds());
        } else {
          history.cancelGesture();
        }
        return ok;
      } catch (error) {
        history.cancelGesture();
        throw error;
      }
    },
    connectSelected: (style?: {
      path?: ConnectorPath;
      arrows?: LineArrows;
      color?: string;
      width?: number;
      opacity?: number;
    }) => {
      history.beginGesture();
      try {
        const id = controller.connectSelected(style);
        if (id !== null) {
          options.markDirty();
          notifyTools();
          scheduleRender();
          history.commitGesture();
          publishContentMutation(history.lastChangeIds());
        } else {
          history.cancelGesture();
        }
        return id;
      } catch (error) {
        history.cancelGesture();
        throw error;
      }
    },
    penColor: () => penStyle.color ?? SWATCHES[0],
    setPenColor: (color) => {
      penStyle.color = color;
      presetStore.setTool('pen', { color });
      presetStore.pushRecentColor(color);
      notifyTools();
    },
    penWidth: () => penStyle.width ?? WIDTH_DOTS[1],
    setPenWidth: (width) => {
      if (!Number.isFinite(width) || width <= 0) return;
      penStyle.width = width;
      presetStore.setTool('pen', { size: width });
      notifyTools();
    },
    eraserRadius: () => eraserStyle.radius ?? DEFAULT_ERASER_RADIUS_VIEW,
    setEraserRadius: (radius) => {
      if (!Number.isFinite(radius) || radius <= 0) return;
      eraserStyle.radius = radius;
      presetStore.setEraser({ radius });
      notifyTools();
    },
    eraserMode: () => normalizeEraserMode(presetStore.getEraser().mode),
    setEraserMode: (mode) => {
      presetStore.setEraser({ mode });
      notifyTools();
    },
    rulerState: () => controller.ruler(),
    setRuler: (ruler) => {
      controller.setRuler(ruler);
      notifyTools();
      scheduleRender();
    },
    /** Read one tool's preset (slice 3 seam for the settings UX). */
    toolPreset: (tool: InkPresetToolId): InkToolPreset =>
      presetStore.getTool(tool),
    /** Patch one tool's preset without touching live gestures. */
    setToolPreset: (tool: InkPresetToolId, patch: Partial<InkToolPreset>) => {
      presetStore.setTool(tool, patch);
      if (tool === 'pen') {
        if (patch.color !== undefined) penStyle.color = patch.color;
        if (patch.size !== undefined) penStyle.width = patch.size;
      }
      if (patch.color !== undefined) presetStore.pushRecentColor(patch.color);
      notifyTools();
    },
    savedStyles: (tool) => styleLibrary.styles(tool),
    currentStyleId: (tool) => styleLibrary.snapshot().currentStyleByTool[tool],
    saveCurrentStyle: (tool, name) => styleLibrary.saveCurrent(tool, name),
    applySavedStyle: (id) => {
      const applied = styleLibrary.apply(id);
      if (applied) notifyTools();
      return applied;
    },
    updateSavedStyle: (id) => {
      const updated = styleLibrary.update(id);
      if (updated) notifyTools();
      return updated;
    },
    renameSavedStyle: (id, name) => {
      const renamed = styleLibrary.rename(id, name);
      if (renamed) notifyTools();
      return renamed;
    },
    favoriteSavedStyle: (id, favorite) => {
      const changed = styleLibrary.setFavorite(id, favorite);
      if (changed) notifyTools();
      return changed;
    },
    reorderSavedStyles: (tool, ids) => {
      const reordered = styleLibrary.reorder(tool, ids);
      if (reordered) notifyTools();
      return reordered;
    },
    deleteSavedStyle: (id) => {
      const deleted = styleLibrary.delete(id);
      if (deleted) notifyTools();
      return deleted;
    },
    resetSavedStyle: (tool) => {
      const reset = styleLibrary.reset(tool);
      if (reset) notifyTools();
      return reset;
    },
    savedStyleModified: (tool) => styleLibrary.isModified(tool),
    cornerRadius: () => cornerRadius,
    shapeAppearance: () => shapeAppearance,
    setCornerRadius: (value) => {
      if (!Number.isFinite(value) || value < 0) return;
      cornerRadius = value;
      notifyTools();
    },
    setShapeAppearance: (value) => {
      shapeAppearance = value;
      notifyTools();
    },
    lineArrows: () => presetStore.getLineArrows(),
    setLineArrows: (arrows: LineArrowSetting) => {
      presetStore.setLineArrows(arrows);
      notifyTools();
    },
    /** Recent color choices, most-recent-first (slice 8 fast presets). */
    recentColors: () => presetStore.getRecentColors(),
    /** Record a color choice in the recent-colors MRU. */
    pushRecentColor: (color: string) => {
      presetStore.pushRecentColor(color);
    },
    /** Current eraser preset (slice 8 settings host). */
    eraserPreset: (): EraserPreset => presetStore.getEraser(),
    /** Merge a patch into the eraser preset. */
    setEraserPreset: (patch: Partial<EraserPreset>) => {
      presetStore.setEraser(patch);
      if (patch.radius !== undefined) eraserStyle.radius = patch.radius;
      notifyTools();
    },
    /** Current lasso preset (slice 8 settings host). */
    lassoPreset: (): LassoPreset => presetStore.getLasso(),
    /** Merge a patch into the lasso preset. */
    setLassoPreset: (patch: Partial<LassoPreset>) => {
      presetStore.setLasso(patch);
      notifyTools();
    },
    /** Gesture preferences (slice 7 product contract, persisted). */
    gestures: () => presetStore.getGestures(),
    /** Merge a patch into the gesture preferences. */
    setGestures: (patch) => {
      presetStore.setGestures(patch);
      notifyTools();
    },
    undo: () => doUndo(),
    redo: () => doRedo(),
    canUndo: () => history.canUndo(),
    canRedo: () => history.canRedo(),
    claimTouchInteraction: (event) =>
      createdPointerHandler.claimTouchInteraction(event),
    cancelTouchInteraction: () =>
      createdPointerHandler.cancelTouchInteraction(),
    setSelection: (ids) => {
      controller.setSelection(ids);
      notifyTools();
      scheduleRender();
    },
    selectionIds: () => controller.selection(),
    canInsertImage: () => canInsertImage(),
    insertImage: (file) => insertImageFile(file),
    chooseImage: () => chooseImage(),
    zoomFactor: () => controller.camera().zoom,
    setZoomFactor,
    camera: () => controller.camera(),
    frameSize: () => frameBounds(model.frame),
    resizeFrame,
    fitToView,
    zoomReset: () => fitToView(),
    exportPng: () => {
      if (typeof document === 'undefined') return;
      const frame = frameBounds(model.frame);
      const scale = 2;
      const size = committed.viewport();
      const region = frame ?? {
        width: Math.max(size.width / controller.camera().zoom, 1),
        height: Math.max(size.height / controller.camera().zoom, 1),
      };
      // Engine-owned ephemeral export canvas:
      // derived pixels only, never attached, never canonical.
      const out = document.createElement('canvas');
      out.width = Math.round(region.width * scale);
      out.height = Math.round(region.height * scale);
      const outCtx = out.getContext('2d');
      if (outCtx === null) return;
      outCtx.setTransform(scale, 0, 0, scale, 0, 0);
      outCtx.fillStyle = '#ffffff';
      outCtx.fillRect(0, 0, region.width, region.height);
      renderSurfaceScene(
        new CanvasSurfaceRendererBackend(outCtx, {
          images: imageResolver,
          fontFamily: textFontFamily,
        }),
        model,
        sharedObjectRegistry,
        { x: 0, y: 0, zoom: scale },
        { width: region.width * scale, height: region.height * scale, dpr: 1 },
        {
          backgroundItems:
            options.backgroundItems?.() ??
            (presentation === 'paint-stage'
              ? templateBackgroundDrawItems(
                  surfacePaper(model).template,
                  region.width,
                  region.height,
                  surfacePaper(model),
                )
              : undefined),
        },
      );
      const name = `${options.exportName ?? 'ink-page'}.png`;
      if (typeof out.toBlob === 'function') {
        out.toBlob((blob) => {
          if (blob === null || destroyed) return;
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url;
          link.download = name;
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1000);
        }, 'image/png');
      }
    },
    refreshViewport(): void {
      scheduleRender();
      createdPointerHandler.refreshCursor();
    },
    refresh(changedIds): void {
      if (changedIds !== undefined && changedIds.length > 0) {
        controller.notifyExternalMutation(changedIds);
        publishContentMutation(changedIds);
      }
      invalidateScene();
    },
    notifyCanonicalMutationForTests: (ids) => {
      notifyCanonicalMutationForTests(ids);
    },
    diagnostics: () => {
      const committedStats = committed.committedStats();
      return {
        renderFrames,
        transport: createdPointerHandler.transportStats(),
        history: history.historyStats(),
        scene: committedStats.scene,
        committed: {
          fullCacheRebuilds: committedStats.fullCacheRebuilds,
          newlyDrawnCommittedItems: committedStats.newlyDrawnCommittedItems,
          dragPromotions: committedStats.dragPromotions,
          translationFullRepaints: committedStats.translationFullRepaints,
          committedItemsRepainted: committedStats.committedItemsRepainted,
          progressPending: committedStats.progressPending,
          priorityReorders: committedStats.priorityReorders,
          firstPaintVisible: committedStats.firstPaintVisible,
          firstPaintCost: committedStats.firstPaintCost,
          firstPaintMs: committedStats.firstPaintMs,
        },
        cold: committedStats.cold,
        controller: controller.controllerStats(),
        spatial: controller.spatialIndexStats(),
        connectors: controller.connectorIndexStats(),
        drag: controller.selectionDrag(),
        reopenCompiled: (() => {
          const stats = cachedRestore?.stats() ?? {
            restored: 0,
            misses: 0,
            restoreMs: 0,
            restoredBytes: 0,
            restoredNodes: 0,
            dirtySkips: 0,
            revisionSkips: 0,
          };
          let staleHydrationsDiscarded = 0;
          try {
            if (reopenBinding !== null) {
              staleHydrationsDiscarded =
                reopenBinding.store.statsSnapshot().staleHydrationsDiscarded;
            }
          } catch {
            staleHydrationsDiscarded = 0;
          }
          return {
            hits: stats.restored,
            misses: stats.misses,
            cachedPackedAvailable: cachedRestore?.available() ?? 0,
            cachedPackedRestored: stats.restored,
            cachedPackedRestoreMisses: stats.misses,
            cachedPackedRestorePending: cachedRestore?.pending() ?? 0,
            cachedPackedRestoreMs: stats.restoreMs,
            cachedPackedRestoredBytes: stats.restoredBytes,
            cachedPackedRestoredNodes: stats.restoredNodes,
            cachedPackedRestoreDirtySkips: stats.dirtySkips,
            cachedPackedRestoreRevisionSkips: stats.revisionSkips,
            staleHydrationsDiscarded,
          };
        })(),
      };
    },
    flush(): void {
      closeTextOverlay(true);
    },
    onDidChange(listener) {
      toolListeners.add(listener);
      return { dispose: () => toolListeners.delete(listener) };
    },
    destroy(): void {
      if (destroyed) return;
      // no-loss: teardown commits pending text before disposal
      // (matches flush(); the notebook pager relies on this).
      closeTextOverlay(true);
      destroyed = true;
      releaseTextEntry?.();
      releaseTextEntry = undefined;
      syncDrawingContext();
      // Teardown persist (final pass, items 1 + 5): enqueue warm-vector
      // persistence under the LIVE session revision (null while dirty).
      // This call is constant-time — packing, binary serialization, and
      // the host write all run on the store's async lane after teardown,
      // and a revision that moves on before the job runs discards it.
      // Best-effort; teardown never fails.
      if (reopenBinding !== null) {
        try {
          persistLiveReopenGeometry(reopenBinding, model);
        } catch {
          // Persistence never breaks teardown.
        }
      }
      presetNotifications.dispose();
      styleLibrary.dispose();
      presetStore.dispose();
      committedGeometryPending.clear();
      preparedGeometryPending.clear();
      // centralized teardown (single shared-frame owner):
      // detach first so the pointer controller settles via the single
      // resetGestureState path (cancelNavigationAnimation + panning clear +
      // at-most-once embedded Cancel) while clamp/viewport ports are still
      // live; then dispose the ONE render scheduler (cancels any pending
      // rAF → 0 frames). This controller never owns its own frame.
      createdPointerHandler.detach();
      cursorPresenter.destroy();
      try {
        console.assert(
          createdPointerHandler.hasTransientNavigation() === false,
          '[surface] destroy: transient navigation not cleared',
        );
        console.assert(
          createdPointerHandler.advanceNavigation(0) === false,
          '[surface] destroy: navigation animation not cleared',
        );
      } catch {
        // Asserts never break teardown.
      }
      controller.destroy();
      renderScheduler.dispose();
      committed.dispose();
      void controller.drainErasure().then(
        () => history.dispose(),
        () => history.dispose(),
      );
      observer?.disconnect();
      imageCache?.dispose();
      toolListeners.clear();
      textOverlayHandle.dispose();
      root.remove();
    },
  };

  // Spatial/connector/derived indexes build lazily on first query, drag,
  // or hit-test — never on the mount critical path (provider readiness
  // and first paint must not wait for a full-document bounds scan).
  resize();
  if (options.initialCamera === undefined) {
    fitToView();
  } else {
    controller.setCamera(clampCameraToSheet(options.initialCamera));
    userNavigated = true;
  }
  syncZoomState();
  surfaceApi.setTool(options.initialTool ?? INK_TOOL_IDS.pen);
  scheduleRender();

  syncDrawingContext();
  return surfaceApi;
}

// --- Provider facade ---

/** Canvas 2D availability probe shared by spatial editors. */
export function hasCanvas2d(): boolean {
  try {
    if (typeof document === 'undefined') return false;
    const probe = document.createElement('canvas');
    const probeCtx = probe.getContext('2d');
    if (probeCtx === null || probeCtx === undefined) return false;
    return typeof (probeCtx as { fillRect?: unknown }).fillRect === 'function';
  } catch {
    return false;
  }
}
