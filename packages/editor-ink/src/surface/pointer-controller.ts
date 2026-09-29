/**
 * Pointer/wheel/keyboard state machine.
 *
 * Owns pointer tracking, gesture modes, pinch/pan math wiring, object and
 * frame resize sessions, text-tool dispatch, and keyboard shortcuts.
 * Pure classification (palm rejection, delegation, axis normalization) lives
 * in ./pointer.js; camera/frame math lives in ./camera.js and
 * ./frame-resize.js. This controller only wires those seams to the live
 * InkToolController/model/DOM ports — surface.ts keeps lifecycle assembly,
 * rendering, and the public handle.
 */

import {
  frameBounds,
  createDefaultSurfaceObjectTypeRegistry,
  GESTURE_THRESHOLDS,
  SURFACE_TOOL_IDS,
  viewToSurface,
  type Camera,
  type InkInputBatch,
  type NormalizedPointerEvent,
  type Point,
  type SurfaceObjectTypeRegistry,
  type SurfaceModel,
  type SelectionContextSnapshot,
} from '@froglight/foundation';
import { INK_TOOL_IDS } from './shape-tools.js';
import {
  clampZoom,
  MAX_ZOOM,
  MIN_ZOOM,
  resistedCameraBeyondBounds,
  zoomCameraAroundPointUnclamped,
} from './camera.js';
import {
  borderHitMode as queryBorderHitMode,
  computeResizedFrame,
  frameRectView as queryFrameRectView,
  HANDLE_CURSORS,
  reanchorCameraForResize,
  type FrameRectView,
  type ResizeMode,
} from './frame-resize.js';
import {
  shouldIgnorePointerDown,
  shouldRejectTouchDuringDraw,
  viewPointFromRect,
  type PointerMode,
  type PointerType,
} from './pointer.js';
import {
  NAVIGATION_PHYSICS,
  VelocityTracker,
  elasticZoom,
  primaryTouchPair,
  startSpringMotion,
  stepDecay,
  stepMotion,
  type MotionState,
  type PrimaryTouchIds,
} from '../navigation/index.js';
import {
  normalizeInkInputBatch,
  normalizeInkPointerEvent,
  normalizeInkPointerUpBatch,
} from './ink-input.js';
import {
  clipPredictedToHorizon,
  shouldPredictForPointerType,
  type PredictionPolicyOptions,
} from './prediction-policy.js';
import { DrawInputCoalescer } from './input-coalescer.js';
import type {
  SurfaceCursorAction,
  SurfaceCursorPresenter,
  SurfaceCursorSample,
} from './cursor.js';

export type NavigationMode = 'standalone' | 'embedded' | 'locked';

export interface PointerToolControllerPort {
  camera(): Camera;
  setCamera(camera: Camera): void;
  pointerDown(
    event: NormalizedPointerEvent,
    selectionGesture?: boolean | 'touch',
  ): void;
  isAuthoringTool?(): boolean;
  touchSelectionTarget?(
    viewPoint: Point,
  ):
    | { readonly kind: 'selection' }
    | { readonly kind: 'object'; readonly id: string }
    | null;
  selectionContext?(): SelectionContextSnapshot | null;
  pointerMove(event: NormalizedPointerEvent): void;
  pointerUp(event: NormalizedPointerEvent): void;
  pointerCancel(): void;
  pointerRunEnd?(event: NormalizedPointerEvent): void;
  pointerRunStart?(event: NormalizedPointerEvent): void;
  pointerRunsComplete?(): void;
  /**
   * Hold signal for the active draw gesture (draw-and-hold). Providers
   * without it simply never arm conversions.
   */
  gestureHold?(): void;
  /**
   * Batch fast path for coalesced input: one call per DOM event. Providers
   * without it receive per-sample `pointerMove` calls instead.
   */
  pointerBatch?(events: readonly NormalizedPointerEvent[]): void;
  /**
   * Ephemeral predicted tail for the live gesture. Providers without it
   * simply show no tail; it must never commit canonical content.
   */
  pointerPredicted?(events: readonly NormalizedPointerEvent[]): void;
  panBy(deltaView: Point): void;
  selection(): readonly string[];
  setSelection(ids: readonly string[]): void;
  hitTest?(surfacePoint: Point): string | null;
  resizeObject(
    id: string,
    size: { readonly width?: number; readonly height?: number },
  ): void;
}

export interface PointerControllerDeps {
  readonly objectRegistry?: SurfaceObjectTypeRegistry;
  readonly model: SurfaceModel;
  readonly controller: PointerToolControllerPort;
  readonly canvas: HTMLCanvasElement;
  /** Full-page coordinate box when the bitmap is a clipped rendering window. */
  readonly coordinateElement?: HTMLElement;
  readonly page: HTMLElement;
  readonly badge: HTMLElement;
  readonly cursorPresenter?: SurfaceCursorPresenter;
  readonly navigationMode: NavigationMode;
  readonly cameraInteractive: boolean;
  readonly frameResizable: boolean;
  readonly delegateTouchNavigation?: boolean;
  readonly isReadOnly: () => boolean;
  readonly isDestroyed: () => boolean;
  readonly isUserNavigated: () => boolean;
  readonly setUserNavigated: (value: boolean) => void;
  readonly getActiveToolId: () => string;
  readonly beginHistoryGesture: () => void;
  readonly commitHistoryGesture: () => void;
  readonly cancelHistoryGesture: () => void;
  readonly canRebaseFrameContent?: () => boolean;
  readonly previewFrameContentTranslation?: (delta: Point | null) => void;
  readonly commitFrameContentTranslation?: (delta: Point) => void;
  readonly clampToSheet: (camera: Camera) => Camera;
  /**
   * Committed zoom path (toolbar/buttons/programmatic): clamps, commits,
   * dirties/history-notifies via `commitCamera`. Wheel/pinch gestures must
   * NOT use this — they publish ephemeral elastic visuals (`elasticZoom` +
   * `transientCamera`, never dirty/history) and settle through the shared
   * spring. Kept as a dep (not dead): toolbar wiring in `surface.ts`.
   */
  readonly setZoomFactor: (zoom: number, anchor?: Point) => void;
  readonly syncZoomState: () => void;
  readonly scheduleRender: () => void;
  readonly invalidateScene: () => void;
  readonly fitToView: () => void;
  readonly notifyTools: () => void;
  readonly markDirty: () => void;
  readonly openTextOverlay: (surfacePoint: Point) => void;
  /** Enter-to-edit: opens the single selected text object.*/
  readonly openTextOverlayAtSelection: () => boolean;
  /** True while the ephemeral text editor is open (re-entrancy guard). */
  readonly isTextOverlayOpen: () => boolean;
  readonly requestUndo: () => boolean;
  readonly requestRedo: () => boolean;
  readonly requestDeleteSelection?: () => void;
  readonly requestSetTool: (toolId: string) => void;
  /** Injectable accessibility policy; defaults to the platform media query. */
  readonly reducedMotion?: () => boolean;
  /**
   * Input transport selection: `auto` (default) uses `pointerrawupdate`
   * when the canvas exposes it, else `pointermove`; `always`/`never`
   * force one path (tests, diagnostics).
   */
  readonly pointerRawUpdate?: 'auto' | 'always' | 'never';
  /**
   * rAF-coalesced draw input (production-readiness item 2, single shared
   * frame since the transport/prediction repair): when true, draw-mode
   * `pointerrawupdate`/`pointermove` batches buffer cheaply and publish
   * once per SHARED render frame instead of running the full live geometry
   * pipeline synchronously per DOM event. Confirmed samples are never
   * dropped (buffered in order); predictions keep only the latest set.
   * Defaults to false so headless unit tests keep synchronous dispatch;
   * production `surface.ts` enables it and drains the buffer at the top
   * of its single render-scheduler frame (one flush + one paint).
   */
  readonly coalesceDrawInput?: boolean;
  /**
   * Prediction policy (forward-flash repair): master switch, screen-space
   * horizon, lookahead horizon, and per-pointer-type opt-ins. Defaults to
   * pen-only bounded prediction (`20 CSS px`, `32 ms` lookahead).
   */
  readonly predictionPolicy?: PredictionPolicyOptions;
  readonly onEmbeddedPan?: (deltaView: Point) => void;
  readonly onEmbeddedZoom?: (gesture: {
    readonly factor: number;
    readonly point: Point;
    readonly translation: Point;
    readonly source?: 'wheel' | 'touch';
  }) => void;
  /**
   * Embedded release/cancel (parity, pager-owned settle).
   * `onEmbeddedPanEnd` carries the controller-tracked release velocity
   * (view px/ms, same sign as forwarded deltas); the pager owns its clock.
   */
  readonly onEmbeddedPanEnd?: (velocity: Point) => void;
  readonly onEmbeddedZoomEnd?: () => void;
  readonly onEmbeddedCancel?: () => void;
  /**
   * Embedded plain-wheel (gutter parity): native scroll owns the
   * gesture; the host preserves an open preview. Split from
   * `onEmbeddedCancel` (true abort discards) so plain-wheel never discards
   * an active preview.
   */
  readonly onEmbeddedWheel?: () => void;
}

export interface PointerTransportStats {
  /** Confirmed samples accepted via `pointerrawupdate`. */
  readonly rawConfirmed: number;
  /** Confirmed samples accepted via `pointermove`. */
  readonly moveConfirmed: number;
  /** Move confirmed samples suppressed while raw owns confirmed input. */
  readonly moveSuppressedRawOwned: number;
  /** Raw confirmed samples suppressed after move fallback owns input. */
  readonly rawSuppressedMoveOwned: number;
  /** Times the move fallback latched (unavailable + mid-gesture stalls). */
  readonly rawFallbackActivations: number;
  /** Predicted samples received (pre-policy, pre-horizon). */
  readonly predictedReceived: number;
  /** Predicted samples retained after policy + horizon clipping. */
  readonly predictedRetained: number;
  /** Screen-space (CSS-px) length of the last retained prediction. */
  readonly predictedScreenLengthPx: number;
  /** Coalescer flushes that published geometry (≤ shared frames). */
  readonly inputFlushes: number;
}

export interface PointerControllerHandle {
  claimTouchInteraction(event: PointerEvent): boolean;
  cancelTouchInteraction(): void;
  attach(root: HTMLElement): void;
  detach(): void;
  resetForReadOnly(): void;
  onKeyDown(event: KeyboardEvent): void;
  onKeyUp(event: KeyboardEvent): void;
  /**
   * Synchronously flush buffered draw input WITHOUT scheduling another
   * frame (single-rAF invariant). Tests drive shared frames explicitly
   * through this; production `pointerup` and the render scheduler's
   * `onFrame` flush through the same path before commit/paint. No-op
   * when coalescing is off or empty. Never schedules.
   */
  flushPendingInput(): void;
  /**
   * Shared-frame drain used by the render scheduler's `onFrame`:
   * identical to `flushPendingInput()` (dispatch only, never schedules).
   * Kept as a named alias so `surface.ts` reads as
   * `flushPendingInputWithoutSchedulingRender(); render();`.
   */
  flushPendingInputWithoutSchedulingRender(): void;
  /** True when unflushed coalesced input is pending. */
  hasPendingInput(): boolean;
  /** Advance post-release navigation from the existing shared render frame. */
  advanceNavigation(timeMs: number): boolean;
  /** True while camera state is a live gesture/animation rather than settled. */
  hasTransientNavigation(): boolean;
  /** Re-resolve a stationary pointer after tool/preset/zoom/layout changes. */
  refreshCursor(): void;
  /** Transport + prediction diagnostics (dev/test counters). */
  transportStats(): PointerTransportStats;
  debugState(): {
    readonly mode: PointerMode;
    readonly pointers: ReadonlyArray<{ id: number; x: number; y: number }>;
  };
}

interface ResizeSession {
  readonly mode: ResizeMode;
  readonly startFrame: { width: number; height: number };
  readonly startCamera: Camera;
  readonly startView: Point;
  changed: boolean;
  contentDelta: Point;
}

/** Create the pointer/wheel/keyboard handler owning all gesture state. */
export function createPointerController(
  deps: PointerControllerDeps,
): PointerControllerHandle {
  const coordinateElement = deps.coordinateElement ?? deps.canvas;
  type Track = { readonly x: number; readonly y: number };
  // Embedded navigation moves the canvas itself. Track contacts in client
  // space so scrolling/preview transforms cannot feed back into the next delta.
  // Standalone surfaces keep their fixed canvas-local navigation coordinates.
  const pointers = new Map<number, Track>();
  const navigationPoint = (event: PointerEvent, view: Point): Point =>
    deps.navigationMode === 'embedded'
      ? { x: event.clientX, y: event.clientY }
      : view;
  /** Pointer type per tracked id (pen-preempts-pan needs the kinds). */
  const pointerKinds = new Map<number, PointerType>();
  // A tap is provisional until lift. Navigation owns the contact in the
  // meantime, including delegated Notebook capture. Movement, cancellation,
  // another contact or a tool change invalidates the same shared intent.
  type TouchTapAction =
    | { kind: 'select'; id: string }
    | { kind: 'edit-selection' }
    | { kind: 'text'; point: Point };
  let touchTap: {
    pointerId: number;
    x: number;
    y: number;
    toolId: string;
    action: TouchTapAction;
  } | null = null;
  const rememberTouchTap = (
    event: PointerEvent,
    action: TouchTapAction,
  ): void => {
    touchTap = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      toolId: deps.getActiveToolId(),
      action,
    };
  };
  const trackTouchTap = (event: PointerEvent): void => {
    if (touchTap === null) return;
    if (
      (event.type === 'pointerdown' &&
        event.pointerId !== touchTap.pointerId) ||
      (event.pointerId === touchTap.pointerId &&
        (event.type === 'pointercancel' ||
          !Number.isFinite(event.clientX) ||
          !Number.isFinite(event.clientY) ||
          Math.hypot(event.clientX - touchTap.x, event.clientY - touchTap.y) >
            12))
    )
      touchTap = null;
  };
  const finishTouchTap = (
    event: PointerEvent,
    ownedGestureEnded = false,
  ): void => {
    trackTouchTap(event);
    if (touchTap === null || touchTap.pointerId !== event.pointerId) return;
    if (touchTap.action.kind === 'edit-selection' && !ownedGestureEnded) return;
    const { action, toolId } = touchTap;
    touchTap = null;
    if (
      deps.isDestroyed() ||
      deps.isReadOnly() ||
      toolId !== deps.getActiveToolId()
    )
      return;
    if (action.kind === 'select') deps.controller.setSelection([action.id]);
    else if (action.kind === 'edit-selection')
      deps.openTextOverlayAtSelection();
    else deps.openTextOverlay(action.point);
    deps.notifyTools();
    deps.scheduleRender();
  };
  const onDocumentTouchUp = (event: PointerEvent): void =>
    finishTouchTap(event);
  const rememberTouchIntent = (
    event: PointerEvent,
    view: Point,
    target: ReturnType<
      NonNullable<PointerToolControllerPort['touchSelectionTarget']>
    >,
  ): void => {
    if (target?.kind === 'selection') {
      rememberTouchTap(event, { kind: 'edit-selection' });
    } else if (target?.kind === 'object') {
      rememberTouchTap(event, { kind: 'select', id: target.id });
    } else if (
      target === null &&
      deps.getActiveToolId() === INK_TOOL_IDS.text
    ) {
      rememberTouchTap(event, {
        kind: 'text',
        point: viewToSurface(deps.controller.camera(), view),
      });
    }
  };
  let mode: PointerMode = 'idle';
  let drawPointerId: number | null = null;
  let panLast: Point | null = null;
  /** Unresisted touch-pan camera; resistance is derived from total excess. */
  let panRawCamera: Camera | null = null;
  let panEmbedded = false;
  let panTouch = false;
  const panVelocity = new VelocityTracker();
  let primaryTouchIds: PrimaryTouchIds | null = null;
  let pinchStart: {
    readonly centroid: Point;
    readonly distance: number;
    readonly camera: Camera;
    readonly anchor: Point;
  } | null = null;
  let pinchSettleTarget: Camera | null = null;
  type NavigationAnimation =
    | { kind: 'decay'; velocity: Point; lastTimeMs: number }
    | {
        kind: 'spring';
        target: Camera;
        x: MotionState;
        y: MotionState;
        zoom: MotionState;
        lastTimeMs: number;
      };
  let navigationAnimation: NavigationAnimation | null = null;
  let objectResize: {
    readonly pointerId: number;
    readonly id: string;
    readonly startView: Point;
    readonly startWidth: number;
    readonly startHeight: number;
  } | null = null;
  let resizeSession: ResizeSession | null = null;
  let spaceHeld = false;
  let attached = false;
  let lastCursorSample: Omit<SurfaceCursorSample, 'action'> | null = null;
  /** Pending draw-and-hold timer; cleared on move/up/cancel/detach. */
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * rAF-coalesced draw buffer (single shared frame): cheap per-event
   * pushes, one expensive `dispatchInputBatch` per SHARED render frame.
   * Only used when `deps.coalesceDrawInput` is true; otherwise draw
   * dispatches synchronously (legacy headless path).
   */
  const drawCoalescer = new DrawInputCoalescer();

  const resizeCursorAction = (cursor: string): SurfaceCursorAction => {
    if (cursor === 'nwse-resize' || cursor === 'nesw-resize') return cursor;
    if (cursor === 'ns-resize' || cursor === 'ew-resize') return cursor;
    return 'tool';
  };

  const resizeRegistry =
    deps.objectRegistry ?? createDefaultSurfaceObjectTypeRegistry();
  function resizeTargetAt(view: Point, pointerType: PointerType = 'mouse') {
    const touch = pointerType === 'touch';
    const tool = deps.getActiveToolId();
    if (
      !touch &&
      tool !== SURFACE_TOOL_IDS.select &&
      tool !== INK_TOOL_IDS.text
    )
      return null;
    const point = viewToSurface(deps.controller.camera(), view);
    const selected = deps.controller.selection();
    // A finger may resize the visible selection with any active tool, but
    // an unselected object's border must remain eligible for scrolling.
    if (touch && selected.length !== 1) return null;
    const id =
      selected.length === 1 ? selected[0] : deps.controller.hitTest?.(point);
    if (id == null) return null;
    const record = deps.model.objects[id];
    if (
      record === undefined ||
      record.locked === true ||
      Number(record.rotation ?? 0) !== 0
    )
      return null;
    if (
      ![
        'froglight.text',
        'froglight.card',
        'froglight.image',
        'froglight.rectangle',
        'froglight.ellipse',
      ].includes(record.type)
    )
      return null;
    const bounds = resizeRegistry.get(record.type)?.boundsOf?.(record);
    if (bounds == null) return null;
    const zoom = deps.controller.camera().zoom;
    const right = Math.abs(point.x - bounds.x - bounds.width) * zoom;
    const bottom = Math.abs(point.y - bounds.y - bounds.height) * zoom;
    const textEdge =
      record.type === 'froglight.text' &&
      right <= (touch ? 14 : 4) &&
      point.y >= bounds.y &&
      point.y <= bounds.y + bounds.height;
    const cornerRadius = touch ? 14 : 6;
    if (!textEdge && !(right <= cornerRadius && bottom <= cornerRadius))
      return null;
    return { id, bounds, text: record.type === 'froglight.text' };
  }

  function cursorActionAt(view: Point): SurfaceCursorAction {
    if (mode === 'resize-object')
      return deps.model.objects[objectResize?.id ?? '']?.type ===
        'froglight.text'
        ? 'ew-resize'
        : 'nwse-resize';
    if (mode === 'resize' && resizeSession !== null)
      return resizeCursorAction(HANDLE_CURSORS[resizeSession.mode]);
    if (mode === 'pan') return 'grabbing';
    if (deps.isReadOnly()) return deps.cameraInteractive ? 'grab' : 'tool';
    if (spaceHeld && deps.cameraInteractive) return 'grab';
    const edge = hitResizeBorder(view);
    if (edge !== null) return resizeCursorAction(HANDLE_CURSORS[edge]);
    const resizeTarget = resizeTargetAt(view);
    if (resizeTarget !== null)
      return resizeTarget.text ? 'ew-resize' : 'nwse-resize';
    if (
      deps.getActiveToolId() === SURFACE_TOOL_IDS.select ||
      deps.getActiveToolId() === INK_TOOL_IDS.text
    ) {
      try {
        const hit = deps.controller.hitTest?.(
          viewToSurface(deps.controller.camera(), view),
        );
        if (
          hit != null &&
          (deps.getActiveToolId() === INK_TOOL_IDS.text ||
            deps.controller.selection().includes(hit))
        )
          return 'move-selection';
      } catch {
        // A cursor hit test is advisory and must never break input.
      }
    }
    return 'tool';
  }

  function publishCursorSample(
    event: Pick<
      PointerEvent,
      'pointerId' | 'pointerType' | 'clientX' | 'clientY'
    >,
    view: Point,
    contact: boolean,
  ): void {
    if (event.pointerType === 'touch') return;
    lastCursorSample = {
      pointerId: event.pointerId,
      pointerType: event.pointerType || 'mouse',
      clientX: event.clientX,
      clientY: event.clientY,
      view,
      contact,
    };
    deps.cursorPresenter?.update({
      ...lastCursorSample,
      action: cursorActionAt(view),
    });
  }

  function refreshCursorPresentation(): void {
    const sample = lastCursorSample;
    if (sample === null) return;
    const rect = coordinateElement.getBoundingClientRect();
    const scaleX = rect.width / Math.max(coordinateElement.clientWidth, 1);
    const scaleY = rect.height / Math.max(coordinateElement.clientHeight, 1);
    const view = {
      x: (sample.clientX - rect.left) / Math.max(scaleX, Number.EPSILON),
      y: (sample.clientY - rect.top) / Math.max(scaleY, Number.EPSILON),
    };
    deps.cursorPresenter?.update({
      ...sample,
      view,
      action: cursorActionAt(view),
    });
  }

  /**
   * Authoritative confirmed-transport ownership (live-writing repair).
   *
   * `pointerrawupdate` fires ahead of the echoing `pointermove` for the
   * same input. Consuming confirmed samples from BOTH transports and
   * deduplicating only exact identities still reorders: a raw `P4`
   * followed by a coalesced move `[P2, P3, P4]` appends `P2, P3` AFTER
   * `P4` (`P1→P4→P2→P3`), drawing long split/chord segments — visually
   * amplified below 1× zoom. The transports are never merged after the
   * fact. Instead one transport owns confirmed input per gesture:
   *
   * - raw supported + raw seen → `raw` owns; move confirmed suppressed
   *   (moves still supply predictions + non-drawing UI).
   * - raw unsupported, or raw genuinely stops arriving → `move` owns
   *   (fallback, latched for the gesture; raw suppressed thereafter).
   * - gesture start → `undecided`: moves flow until the first raw claims
   *   ownership, or `UNDECIDED_FALLBACK_MOVES` fresh moves without any raw
   *   latch the fallback (raw-never-fires case loses nothing — moves were
   *   already flowing).
   */
  type TransportOwner = 'undecided' | 'raw' | 'move';
  let transportOwner: TransportOwner = 'undecided';
  /** Consecutive fresh moves with no interleaving raw (stall detector). */
  let movesWithoutRaw = 0;
  /** Pointer type of the active draw gesture (prediction policy). */
  let drawPointerType: string | null = null;
  let drawSelectionGesture = false;
  let clippedDrawLast: NormalizedPointerEvent | null = null;
  let clippedDrawActive = false;
  let clippedDrawStarted = false;
  /** Last accepted confirmed VIEW point (prediction horizon frontier). */
  let lastConfirmedView: Point | null = null;
  /** Latest confirmed contact sample, retained as plain data for lift axes. */
  let lastConfirmedSample: NormalizedPointerEvent | null = null;
  const transportCounters = {
    rawConfirmed: 0,
    moveConfirmed: 0,
    moveSuppressedRawOwned: 0,
    rawSuppressedMoveOwned: 0,
    rawFallbackActivations: 0,
    predictedReceived: 0,
    predictedRetained: 0,
    predictedScreenLengthPx: 0,
    inputFlushes: 0,
  };
  /** Moves without raw before the undecided→move fallback latches. */
  const UNDECIDED_FALLBACK_MOVES = 2;
  /**
   * Monotonic stall timeout for the raw→move fallback (PointerEvent
   * transport time). Raw and its echoing move share the same `timeStamp`,
   * so an echo arrives with ~0ms elapsed; genuinely stalled moves arrive
   * with increasingly later stamps and no interleaving raw. One frame of
   * slack (≈2×16ms) separates jitter from a genuine stall without
   * counting bare events.
   */
  const RAW_STALL_TIMEOUT_MS = 32;
  /**
   * Safety net when transport timestamps are missing/untrusted: latch
   * after this many consecutive fresh moves even if elapsed time cannot
   * be computed. Never the primary criterion — elapsed time governs
   * whenever stamps are available.
   */
  const RAW_STALL_MAX_MOVES = 5;
  /** Release threshold, never a truncation cap on a captured DOM batch. */
  const MAX_FALLBACK_CANDIDATES = 64;
  /**
   * Buffered move candidates while raw owns confirmed input. Fresh
   * pointermove batches are stored here INSTEAD of being committed, so
   * the first stalled move is never lost. Raw resuming discards them;
   * a genuine stall latches ownership and releases them in safe order.
   */
  let fallbackCandidates: NormalizedPointerEvent[] = [];
  /** Latest confirmed sample owned by raw, used to trim equal-time move overlap. */
  let lastRawSample: NormalizedPointerEvent | null = null;
  /** Max confirmed `time` of the last raw batch (transport clock). */
  let lastRawTime: number | null = null;
  /** Wall-clock of the last raw batch (missing-stamp fallback). */
  let lastRawWallTime = 0;
  /** Currently displayed prediction snapshot (duplicate suppression + explicit clears). */
  let displayedPrediction: readonly NormalizedPointerEvent[] = [];

  function resetTransport(): void {
    transportOwner = 'undecided';
    movesWithoutRaw = 0;
    drawPointerType = null;
    lastConfirmedView = null;
    lastConfirmedSample = null;
    fallbackCandidates = [];
    lastRawSample = null;
    lastRawTime = null;
    lastRawWallTime = 0;
    displayedPrediction = [];
  }

  function latchMoveFallback(): void {
    if (transportOwner === 'move') return;
    transportOwner = 'move';
    movesWithoutRaw = 0;
    transportCounters.rawFallbackActivations += 1;
  }

  function maxTimeOf(
    samples: readonly NormalizedPointerEvent[],
  ): number | null {
    let max: number | null = null;
    for (const s of samples) {
      if (typeof s.time === 'number' && Number.isFinite(s.time)) {
        max = max === null ? s.time : Math.max(max, s.time);
      }
    }
    return max;
  }

  /**
   * True when the raw stall has lasted past the fallback condition:
   * primarily elapsed transport time since the last raw frontier, with a
   * bounded move-count safety net when stamps are missing/untrusted.
   */
  function stallElapsedExceeded(
    currentMaxTime: number | null,
    moves: number,
  ): boolean {
    if (currentMaxTime !== null && lastRawTime !== null) {
      if (currentMaxTime - lastRawTime >= RAW_STALL_TIMEOUT_MS && moves >= 1) {
        return true;
      }
      // Timestamps say "not yet" — only an extreme count overrides.
      return moves >= RAW_STALL_MAX_MOVES;
    }
    // No transport clock: wall time, else bare count as last resort.
    if (typeof performance !== 'undefined') {
      try {
        if (
          performance.now() - lastRawWallTime >= RAW_STALL_TIMEOUT_MS &&
          moves >= 1
        ) {
          return true;
        }
      } catch {
        // Fall through to count-only.
      }
    }
    return moves >= RAW_STALL_MAX_MOVES;
  }

  /**
   * Consume candidates into the safe release set: in arrival order, drop
   * exact echoes and any sample temporally behind the last raw frontier
   * (`time < confirmedHighWater`). Spatial backtracks with newer stamps
   * are legitimate drawing and are kept — only stale time is dropped, so
   * `P4 → older P2/P3` can never be appended. When coalesced ordering
   * cannot be trusted (stale interior present), this naturally prefers
   * the ordered outer positions: stale history drops, fresh frontier+
   * survives.
   */
  function consumeSafeForRelease(
    candidates: readonly NormalizedPointerEvent[],
  ): NormalizedPointerEvent[] {
    const out: NormalizedPointerEvent[] = [];
    for (const sample of candidates) {
      if (!isFresh(sample)) continue;
      if (
        sample.time !== undefined &&
        Number.isFinite(confirmedHighWater) &&
        sample.time < confirmedHighWater
      ) {
        continue;
      }
      out.push(sample);
      markConsumed(sample);
    }
    return out;
  }

  function bufferFallbackCandidates(
    fresh: readonly NormalizedPointerEvent[],
  ): void {
    for (const s of fresh) {
      fallbackCandidates.push(s);
    }
  }

  function clearFallbackCandidatesAsSuppressed(): void {
    if (fallbackCandidates.length > 0) {
      transportCounters.moveSuppressedRawOwned += fallbackCandidates.length;
    }
    fallbackCandidates = [];
  }

  /**
   * Drain the coalescer and dispatch geometry WITHOUT scheduling another
   * frame (single-rAF invariant). The caller already owns the frame:
   * `surface.ts` runs `flush…(); render();` inside its one render-scheduler
   * callback, and `pointerup`/tests flush synchronously before commit.
   *
   * Shared-frame revalidation: raw samples may have advanced the
   * confirmed frontier AFTER the latest prediction was received, so the
   * buffered prediction is re-clipped against the LATEST frontier here
   * (stale time + echo + distance horizon). A prediction that is now
   * behind or beyond the horizon renders nothing — confirmed input is
   * unaffected.
   */
  function drainCoalescedInputWithoutScheduling(): void {
    const flushed = drawCoalescer.flush();
    if (flushed === null) return;
    transportCounters.inputFlushes += 1;
    let predicted = flushed.predicted;
    if (predicted.length > 0) {
      const policy: PredictionPolicyOptions = deps.predictionPolicy ?? {};
      // Revalidate against the LATEST frontier: drop predictions that are
      // now stale (time behind confirmed) or echoes of confirmed input
      // that arrived after the prediction. Do NOT echo-check against
      // earlier predictions here: each move is a complete replacement
      // snapshot, so repeated lookahead remains valid.
      const revalidated = predicted.filter((sample) => {
        if (
          sample.time !== undefined &&
          Number.isFinite(confirmedHighWater) &&
          sample.time < confirmedHighWater
        ) {
          return false;
        }
        return !echoOf(sample, recentConfirmed);
      });
      if (revalidated.length === 0) {
        predicted = [];
        transportCounters.predictedScreenLengthPx = 0;
      } else {
        const clipped = clipPredictedToHorizon(
          revalidated,
          lastConfirmedView,
          confirmedHighWater,
          policy,
        );
        predicted = [...clipped.retained];
        transportCounters.predictedScreenLengthPx = clipped.screenLengthPx;
      }
    }
    dispatchInputBatch({ confirmed: flushed.confirmed, predicted });
  }

  function flushCoalescedInputWithoutScheduling(): void {
    if (deps.isDestroyed()) return;
    drainCoalescedInputWithoutScheduling();
  }

  /**
   * Raw-transport entry: confirmed input only, never a prediction source.
   * Leaves the pending prediction snapshot untouched so a raw event can
   * never clear or replace the move-owned tail.
   */
  function submitRawConfirmed(fresh: readonly NormalizedPointerEvent[]): void {
    if (fresh.length === 0) return;
    if (
      deps.coalesceDrawInput === true &&
      deps.getActiveToolId() !== SURFACE_TOOL_IDS.eraser
    ) {
      drawCoalescer.pushConfirmed(fresh);
      deps.scheduleRender();
      return;
    }
    dispatchInputBatch({ confirmed: fresh, predicted: [] });
    deps.scheduleRender();
  }

  /**
   * Move-transport entry: confirmed input plus an explicit prediction
   * snapshot (empty clears the previous tail).
   */
  function submitMoveBatch(
    fresh: readonly NormalizedPointerEvent[],
    predicted: readonly NormalizedPointerEvent[],
  ): void {
    if (
      fresh.length === 0 &&
      samePrediction(predicted) &&
      !drawCoalescer.hasPending()
    )
      return;
    if (
      deps.coalesceDrawInput === true &&
      deps.getActiveToolId() !== SURFACE_TOOL_IDS.eraser
    ) {
      drawCoalescer.pushConfirmed(fresh);
      drawCoalescer.replacePredictionSnapshot(predicted);
    } else {
      dispatchInputBatch({ confirmed: fresh, predicted });
    }
    // Empty lookahead is also a visual update: withdraw the displayed tail.
    deps.scheduleRender();
  }

  function clearHoldTimer(): void {
    if (holdTimer !== null) {
      clearTimeout(holdTimer);
      holdTimer = null;
    }
  }

  function prefersReducedMotion(): boolean {
    if (deps.reducedMotion !== undefined) return deps.reducedMotion();
    try {
      return matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      return false;
    }
  }

  function sameCamera(a: Camera, b: Camera): boolean {
    return a.x === b.x && a.y === b.y && a.zoom === b.zoom;
  }

  function publishCamera(camera: Camera): void {
    deps.controller.setCamera(camera);
    deps.setUserNavigated(true);
    refreshCursorPresentation();
  }

  function transientCamera(raw: Camera): Camera {
    return resistedCameraBeyondBounds(raw, deps.clampToSheet(raw));
  }

  function cancelNavigationAnimation(settle: boolean): void {
    navigationAnimation = null;
    if (settle) {
      const current = deps.controller.camera();
      const legal = deps.clampToSheet(current);
      if (!sameCamera(current, legal)) publishCamera(legal);
    }
  }

  /**
   *  centralized ownership: every teardown/interrupt path clears
   * the animation through `cancelNavigationAnimation` — never a direct
   * `navigationAnimation = null` outside the stepper. Discard (`false`)
   * keeps the transient camera (interrupt/survivor/pinch handoff/embedded
   * pager-owned settle); settle (`true`) legalizes via `cancelNavigation-
   * Animation(true)` (detach/read-only/full cancel). Call helpers here,
   * never redefine wheel/cancel semantics at call sites.
   */
  function discardNavigationAnimation(): void {
    cancelNavigationAnimation(false);
  }

  /**
   *  impossible-state guard: pinch
   * requires a live touch pair, decay/spring requires an attached live
   * controller. Fails loudly in dev via `console.assert` and self-heals
   * without throwing so teardown never breaks production.
   */
  function assertNavigationInvariant(where: string): void {
    try {
      if (mode === 'pinch') {
        let touchCount = 0;
        for (const kind of pointerKinds.values()) {
          if (kind === 'touch') touchCount += 1;
        }
        console.assert(
          touchCount > 0,
          `[pointer-controller] ${where}: pinch without touch pair`,
        );
      }
      if (navigationAnimation !== null && (!attached || deps.isDestroyed())) {
        console.assert(
          false,
          `[pointer-controller] ${where}: animation after detach/destroy`,
        );
      }
    } catch {
      // Asserts never break teardown.
    }
  }

  /**
   * Hand active finger navigation to a newly arriving authoring pointer.
   * Touch tracks are navigation-only, so abandoning them commits no model
   * input. Clear the gesture before releasing capture: a synchronous lost
   * capture callback then observes idle navigation rather than reviving it.
   */
  function terminateActiveTouchNavigation(): void {
    if (mode !== 'pinch' && !(mode === 'pan' && panTouch)) return;
    // capture embedded ownership BEFORE clearing (same predicate
    // as resetGestureState) so pen/mouse preemption can forward a true-abort
    // cancel to the pager — otherwise the pager strands preview/owner state.
    const wasEmbedded =
      (mode === 'pan' && panTouch && panEmbedded) ||
      (mode === 'pinch' && deps.navigationMode === 'embedded');
    const touchIds = [...pointerKinds.entries()]
      .filter(([, kind]) => kind === 'touch')
      .map(([id]) => id);
    for (const id of touchIds) {
      pointers.delete(id);
      pointerKinds.delete(id);
    }
    mode = 'idle';
    pinchStart = null;
    primaryTouchIds = null;
    panLast = null;
    panRawCamera = null;
    panEmbedded = false;
    panTouch = false;
    panVelocity.reset();
    deps.page.classList.remove('panning');
    for (const id of touchIds) {
      try {
        deps.canvas.releasePointerCapture?.(id);
      } catch {
        // Capture may already be gone; local gesture ownership is cleared.
      }
    }
    // Forward exactly once (never throws into the preempt path). The caller
    // already settles local animation; the pager owns preview/settle/fling.
    if (wasEmbedded) {
      try {
        deps.onEmbeddedCancel?.();
      } catch {
        // Forwarding must never break authoring preemption.
      }
    }
  }

  function velocityWouldLeaveBounds(camera: Camera, velocity: Point): boolean {
    const probe = {
      ...camera,
      x: camera.x + velocity.x / camera.zoom,
      y: camera.y + velocity.y / camera.zoom,
    };
    return !sameCamera(probe, deps.clampToSheet(probe));
  }

  function beginSpring(
    velocity: Point,
    timeMs: number,
    forceForEdgeMomentum = false,
    targetOverride?: Camera,
  ): boolean {
    const current = deps.controller.camera();
    const target = targetOverride ?? deps.clampToSheet(current);
    const constrained = !sameCamera(current, target);
    if (
      !constrained &&
      !(forceForEdgeMomentum && velocityWouldLeaveBounds(current, velocity))
    ) {
      discardNavigationAnimation();
      return false;
    }
    if (prefersReducedMotion()) {
      publishCamera(target);
      navigationAnimation = null;
      return false;
    }
    navigationAnimation = {
      kind: 'spring',
      target,
      x: startSpringMotion(
        current.x * target.zoom,
        target.x * target.zoom,
        velocity.x,
      ),
      y: startSpringMotion(
        current.y * target.zoom,
        target.y * target.zoom,
        velocity.y,
      ),
      zoom: startSpringMotion(Math.log(current.zoom), Math.log(target.zoom)),
      lastTimeMs: Number.isFinite(timeMs) ? timeMs : 0,
    };
    return true;
  }

  function beginPanRelease(timeMs: number, releaseView: Point): void {
    const velocity = panVelocity.velocityAt(timeMs, {
      x: -releaseView.x,
      y: -releaseView.y,
    });
    panVelocity.reset();
    const current = deps.controller.camera();
    const legal = deps.clampToSheet(current);
    if (prefersReducedMotion()) {
      publishCamera(legal);
      navigationAnimation = null;
      return;
    }
    // Once the bounded camera is visibly displaced, release belongs to the
    // return spring immediately. A brief pointer reversal must not turn that
    // correction into a long decay before the page starts coming home.
    if (!sameCamera(current, legal)) {
      if (beginSpring({ x: 0, y: 0 }, timeMs)) deps.scheduleRender();
      return;
    }
    if (
      Math.hypot(velocity.x, velocity.y) >=
      NAVIGATION_PHYSICS.decayStopVelocityPxPerMs
    ) {
      if (velocityWouldLeaveBounds(current, velocity)) {
        beginSpring(velocity, timeMs, true);
      } else {
        navigationAnimation = {
          kind: 'decay',
          velocity,
          lastTimeMs: Number.isFinite(timeMs) ? timeMs : 0,
        };
      }
      deps.scheduleRender();
      return;
    }
    const target = pinchSettleTarget;
    pinchSettleTarget = null;
    if (beginSpring(velocity, timeMs, false, target ?? undefined))
      deps.scheduleRender();
  }

  function touchPair(previous: PrimaryTouchIds | null = primaryTouchIds) {
    return primaryTouchPair(
      [...pointers.entries()]
        .filter(([id]) => pointerKinds.get(id) === 'touch')
        .map(([id, point]) => ({ id, ...point })),
      previous,
    );
  }

  function rebasePinch(previous: PrimaryTouchIds | null = null): boolean {
    const pair = touchPair(previous);
    if (pair === null) return false;
    primaryTouchIds = [pair[0].id, pair[1].id];
    const centroid = {
      x: (pair[0].x + pair[1].x) / 2,
      y: (pair[0].y + pair[1].y) / 2,
    };
    const camera = deps.controller.camera();
    pinchStart = {
      centroid,
      distance: Math.max(
        Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y),
        1,
      ),
      camera,
      anchor: viewToSurface(camera, centroid),
    };
    mode = 'pinch';
    panVelocity.reset();
    return true;
  }

  /**
   * Drop all in-flight gesture state (detach, read-only transitions).
   * Pointer tracks belong to the event stream, never to the model, so
   * abandoning them mid-gesture only ends the gesture — it never commits
   * or corrupts canonical data.
   */
  function resetGestureState(preserveCursor = false): void {
    touchTap = null;
    // detach/read-only during an embedded gesture forwards cancel
    // so the pager clears its preview — safe when the pager is already
    // gone (it guards destroyed) and never throws into teardown.
    // single teardown owner for all gesture/navigation state
    // (detach + read-only funnel here). Settles via
    // cancelNavigationAnimation(true), clears panning chrome, forwards
    // Cancel at most once per embedded gesture (wasEmbedded sampled before
    // clearing, so a second reset sees idle and forwards nothing — no
    // double-commit, no double-Cancel).
    const wasEmbedded =
      (mode === 'pan' && panTouch && panEmbedded) ||
      (mode === 'pinch' && deps.navigationMode === 'embedded');
    const resetMode = mode;
    const resizeStartCamera = resizeSession?.startCamera;
    if (resetMode === 'resize' || resetMode === 'resize-object') {
      deps.cancelHistoryGesture();
    } else if (resetMode !== 'idle') {
      try {
        deps.controller.pointerCancel();
      } catch {
        // Teardown still owns the remaining local cleanup.
      }
    }
    deps.previewFrameContentTranslation?.(null);
    if (resizeStartCamera !== undefined)
      deps.controller.setCamera(resizeStartCamera);
    deps.badge.style.display = 'none';
    pointers.clear();
    pointerKinds.clear();
    mode = 'idle';
    drawPointerId = null;
    drawPointerType = null;
    clippedDrawLast = null;
    clippedDrawActive = false;
    clippedDrawStarted = false;
    pinchStart = null;
    objectResize = null;
    resizeSession = null;
    panLast = null;
    panRawCamera = null;
    panEmbedded = false;
    panTouch = false;
    panVelocity.reset();
    primaryTouchIds = null;
    cancelNavigationAnimation(true);
    spaceHeld = false;
    clearHoldTimer();
    drawCoalescer.reset();
    resetTransport();
    if (preserveCursor && lastCursorSample !== null) {
      lastCursorSample = { ...lastCursorSample, contact: false };
      refreshCursorPresentation();
    } else {
      lastCursorSample = null;
      deps.cursorPresenter?.reset();
    }
    deps.page.classList.remove('panning');
    if (wasEmbedded) {
      try {
        deps.onEmbeddedCancel?.();
      } catch {
        // Teardown/reset must never throw.
      }
    }
    assertNavigationInvariant('resetGestureState');
  }

  function scheduleHoldTimer(): void {
    clearHoldTimer();
    holdTimer = setTimeout(() => {
      holdTimer = null;
      // Fire only for a still-down draw gesture; lifts and cancels
      // always clear first, so this is exactly the hold moment.
      if (mode === 'draw' && drawPointerId !== null) {
        deps.controller.gestureHold?.();
      }
    }, GESTURE_THRESHOLDS.holdMs);
  }

  function viewPoint(event: PointerEvent | WheelEvent | MouseEvent): Point {
    // Per-event rect read, no caching: nothing mutates DOM between
    // pointer events on the draw path (no per-sample renders, IPC, or
    // style writes), so layout stays clean and the read never forces a
    // reflow. Caching would risk stale coordinates across mid-gesture
    // resizes for zero measurable gain.
    return viewPointFromRect(event, coordinateElement.getBoundingClientRect());
  }

  /**
   * Dispatch one normalized batch: confirmed samples as a single batch
   * (or per-sample moves for providers without batch support), predicted
   * samples through the ephemeral-only path. Duplicate tails suppress
   * (no re-render); explicit empty tails clear the displayed prediction.
   */
  function samePrediction(samples: readonly NormalizedPointerEvent[]): boolean {
    return (
      samples.length === displayedPrediction.length &&
      samples.every((sample, i) => {
        const previous = displayedPrediction[i]!;
        return (
          sample.time === previous.time &&
          identityMatches(sample, snapshotMark(previous))
        );
      })
    );
  }

  function captureRectView(): FrameRectView | null {
    if (drawSelectionGesture) return null;
    const toolId = deps.getActiveToolId();
    if (
      toolId !== SURFACE_TOOL_IDS.pen &&
      toolId !== SURFACE_TOOL_IDS.fountain &&
      toolId !== SURFACE_TOOL_IDS.brush &&
      toolId !== SURFACE_TOOL_IDS.pencil &&
      toolId !== SURFACE_TOOL_IDS.highlighter
    )
      return null;
    const frame = frameBounds(deps.model.frame);
    if (
      frame === null ||
      deps.controller.pointerRunEnd === undefined ||
      deps.controller.pointerRunStart === undefined ||
      deps.controller.pointerRunsComplete === undefined
    )
      return null;
    const camera = deps.controller.camera();
    return {
      x: -camera.x * camera.zoom,
      y: -camera.y * camera.zoom,
      width: frame.width * camera.zoom,
      height: frame.height * camera.zoom,
    };
  }

  function pointInsideRect(point: Point, rect: FrameRectView): boolean {
    return (
      point.x >= rect.x &&
      point.x <= rect.x + rect.width &&
      point.y >= rect.y &&
      point.y <= rect.y + rect.height
    );
  }

  function segmentInsideInterval(
    a: Point,
    b: Point,
    rect: FrameRectView,
  ): { enter: number; exit: number } | null {
    let enter = 0;
    let exit = 1;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    for (const [p, q] of [
      [-dx, a.x - rect.x],
      [dx, rect.x + rect.width - a.x],
      [-dy, a.y - rect.y],
      [dy, rect.y + rect.height - a.y],
    ] as const) {
      if (p === 0) {
        if (q < 0) return null;
        continue;
      }
      const t = q / p;
      if (p < 0) enter = Math.max(enter, t);
      else exit = Math.min(exit, t);
      if (enter > exit) return null;
    }
    return { enter, exit };
  }

  function interpolateEvent(
    a: NormalizedPointerEvent,
    b: NormalizedPointerEvent,
    t: number,
  ): NormalizedPointerEvent {
    const mix = (x: number, y: number): number => x + (y - x) * t;
    const optional = (x: number | undefined, y: number | undefined) =>
      x === undefined || y === undefined ? undefined : mix(x, y);
    const pressure = optional(a.pressure, b.pressure);
    const twist = optional(a.twist, b.twist);
    const time = optional(a.time, b.time);
    const tilt =
      a.tilt === undefined || b.tilt === undefined
        ? undefined
        : { x: mix(a.tilt.x, b.tilt.x), y: mix(a.tilt.y, b.tilt.y) };
    return {
      point: { x: mix(a.point.x, b.point.x), y: mix(a.point.y, b.point.y) },
      ...(b.shift !== undefined ? { shift: b.shift } : {}),
      ...(pressure !== undefined ? { pressure } : {}),
      ...(twist !== undefined ? { twist } : {}),
      ...(time !== undefined ? { time } : {}),
      ...(tilt !== undefined ? { tilt } : {}),
    };
  }

  function dispatchClippedConfirmed(
    samples: readonly NormalizedPointerEvent[],
  ): void {
    const rect = captureRectView();
    if (rect === null) {
      if (samples.length > 0) {
        if (deps.controller.pointerBatch !== undefined)
          deps.controller.pointerBatch(samples);
        else for (const sample of samples) deps.controller.pointerMove(sample);
      }
      return;
    }
    const pending: NormalizedPointerEvent[] = [];
    const flush = () => {
      if (pending.length === 0) return;
      if (deps.controller.pointerBatch !== undefined)
        deps.controller.pointerBatch(pending.splice(0));
      else
        for (const sample of pending.splice(0))
          deps.controller.pointerMove(sample);
    };
    const startRun = (event: NormalizedPointerEvent) => {
      if (clippedDrawStarted) deps.controller.pointerRunStart?.(event);
      else {
        deps.controller.pointerDown(event);
        clippedDrawStarted = true;
      }
      clippedDrawActive = true;
    };
    for (const sample of samples) {
      const previous = clippedDrawLast;
      if (previous === null) {
        clippedDrawLast = sample;
        if (pointInsideRect(sample.point, rect)) startRun(sample);
        continue;
      }
      const interval = segmentInsideInterval(
        previous.point,
        sample.point,
        rect,
      );
      const wasInside = pointInsideRect(previous.point, rect);
      const isInside = pointInsideRect(sample.point, rect);
      if (interval === null) {
        flush();
        if (clippedDrawActive) {
          deps.controller.pointerRunEnd?.(previous);
          clippedDrawActive = false;
        }
      } else if (wasInside && isInside) {
        pending.push(sample);
      } else if (wasInside) {
        const exit = interpolateEvent(previous, sample, interval.exit);
        pending.push(exit);
        flush();
        deps.controller.pointerRunEnd?.(exit);
        clippedDrawActive = false;
      } else if (isInside) {
        flush();
        const entry = interpolateEvent(previous, sample, interval.enter);
        startRun(entry);
        pending.push(sample);
      } else if (interval.enter < interval.exit) {
        flush();
        const entry = interpolateEvent(previous, sample, interval.enter);
        const exit = interpolateEvent(previous, sample, interval.exit);
        startRun(entry);
        pending.push(exit);
        flush();
        deps.controller.pointerRunEnd?.(exit);
        clippedDrawActive = false;
      }
      clippedDrawLast = sample;
    }
    flush();
  }

  function clippedPredicted(
    samples: readonly NormalizedPointerEvent[],
    rect: FrameRectView,
  ): readonly NormalizedPointerEvent[] {
    if (!clippedDrawActive || clippedDrawLast === null) return [];
    const visible: NormalizedPointerEvent[] = [];
    let previous = clippedDrawLast;
    for (const sample of samples) {
      const interval = segmentInsideInterval(
        previous.point,
        sample.point,
        rect,
      );
      if (interval === null) break;
      if (pointInsideRect(sample.point, rect)) {
        visible.push(sample);
        previous = sample;
        continue;
      }
      visible.push(interpolateEvent(previous, sample, interval.exit));
      break;
    }
    return visible;
  }

  function dispatchInputBatch(batch: InkInputBatch): void {
    if (batch.confirmed.length > 0) dispatchClippedConfirmed(batch.confirmed);
    if (
      !samePrediction(batch.predicted) ||
      (batch.confirmed.length > 0 && batch.predicted.length > 0)
    ) {
      const rect = captureRectView();
      const visiblePrediction =
        rect === null
          ? batch.predicted
          : clippedPredicted(batch.predicted, rect);
      deps.controller.pointerPredicted?.(visiblePrediction);
      displayedPrediction = visiblePrediction;
      return;
    }
    displayedPrediction = batch.predicted;
  }

  /** Confirmed leading samples of an ending gesture (the last one goes to up). */
  function dispatchBatchHead(samples: InkInputBatch['confirmed']): void {
    dispatchClippedConfirmed(samples);
  }

  function finishDrawGesture(sample: NormalizedPointerEvent): void {
    if (captureRectView() === null) {
      deps.controller.pointerUp(sample);
      return;
    }
    dispatchClippedConfirmed([sample]);
    if (clippedDrawActive) {
      deps.controller.pointerUp(sample);
    } else if (clippedDrawStarted) {
      deps.controller.pointerRunsComplete?.();
    }
    clippedDrawLast = null;
    clippedDrawActive = false;
    clippedDrawStarted = false;
  }

  /**
   * Raw-movement transport (slice 4): `pointerrawupdate` fires ahead of
   * the echoing `pointermove` for the same input. Both normalize to the
   * same batch type; the echo is dropped by timestamp so no sample is
   * ever processed twice and none is lost.
   */
  function supportsRawUpdate(): boolean {
    const mode = deps.pointerRawUpdate ?? 'auto';
    if (mode === 'never') return false;
    if (mode === 'always') return true;
    try {
      return 'onpointerrawupdate' in deps.canvas;
    } catch {
      return false;
    }
  }

  /** Last consumed sample identities per gesture (bounded echo window). */
  interface DedupMark {
    time: number;
    point: Point;
    pressure?: number;
    tilt?: { readonly x: number; readonly y: number };
    twist?: number;
  }
  /**
   * Bounded identity window behind the dedup filter (repair pass item
   * 13). Timestamps are transport metadata, never sample identity:
   * browsers repeat them, move them backwards, and interleave raw/move
   * transports — so an echo is recognized only by full identity
   * (time + point + axes) against recently consumed samples. Distinct
   * samples are never dropped however their timestamps compare, which
   * keeps coalesced overlap, repeated/identical timestamps, backwards
   * clocks, and future-dated predictions from losing confirmed input.
   */
  const DEDUP_WINDOW = 32;
  const recentConfirmed: DedupMark[] = [];
  /** Max confirmed timestamp this gesture (stale-prediction guard only). */
  let confirmedHighWater = -Infinity;
  /** Recent predicted identities: transport echoes re-render nothing. */

  function resetDedup(): void {
    recentConfirmed.length = 0;
    confirmedHighWater = -Infinity;
    resetTransport();
  }

  function identityMatches(
    sample: NormalizedPointerEvent,
    mark: DedupMark,
  ): boolean {
    return (
      sample.point.x === mark.point.x &&
      sample.point.y === mark.point.y &&
      sample.pressure === mark.pressure &&
      tiltMatches(sample.tilt, mark.tilt) &&
      sample.twist === mark.twist
    );
  }

  function echoOf(
    sample: NormalizedPointerEvent,
    window: readonly DedupMark[],
  ): boolean {
    if (sample.time === undefined) return false;
    for (const mark of window) {
      if (mark.time === sample.time && identityMatches(sample, mark)) {
        return true;
      }
    }
    return false;
  }

  function tiltMatches(
    a: NormalizedPointerEvent['tilt'],
    b: NormalizedPointerEvent['tilt'],
  ): boolean {
    if (a === undefined || b === undefined) return a === b;
    return a.x === b.x && a.y === b.y;
  }

  /** True unless this sample already arrived via the other transport. */
  function isFresh(sample: NormalizedPointerEvent): boolean {
    // Identity-first dedup: only an exact echo (same time AND same
    // point+axes within the recent window) is stale. Anything else —
    // newer, older, or same-time-but-distinct — is new information and
    // must reach canonical capture.
    if (sample.time === undefined) return true;
    return !echoOf(sample, recentConfirmed);
  }

  function markConsumed(sample: NormalizedPointerEvent): void {
    lastConfirmedView = { x: sample.point.x, y: sample.point.y };
    lastConfirmedSample = sample;
    if (sample.time === undefined) return;
    const mark: DedupMark = {
      time: sample.time,
      point: { ...sample.point },
      ...(sample.pressure !== undefined ? { pressure: sample.pressure } : {}),
      ...(sample.tilt !== undefined ? { tilt: { ...sample.tilt } } : {}),
      ...(sample.twist !== undefined ? { twist: sample.twist } : {}),
    };
    if (mark.time > confirmedHighWater) confirmedHighWater = mark.time;
    recentConfirmed.push(mark);
    if (recentConfirmed.length > DEDUP_WINDOW) recentConfirmed.shift();
  }

  /** Drop already-consumed samples; records the new high-water mark. */
  function consumeFresh(
    samples: readonly NormalizedPointerEvent[],
  ): NormalizedPointerEvent[] {
    const fresh = samples.filter(isFresh);
    for (const sample of fresh) markConsumed(sample);
    return fresh;
  }

  /**
   * Authoritative confirmed intake for the raw transport. When the move
   * fallback owns the gesture, raw confirmed samples are suppressed
   * (counted, never consumed) so two confirmed streams can never
   * interleave into `P1→P4→P2→P3` reorderings. Otherwise the first raw
   * claims ownership and consumes normally. A raw arrival while raw-owned
   * proves the transport is alive: any buffered move candidates were
   * echoes/stale and are discarded (counted as suppressed, never
   * committed).
   */
  function acceptRawConfirmed(
    samples: readonly NormalizedPointerEvent[],
  ): NormalizedPointerEvent[] {
    if (samples.length === 0) return [];
    if (transportOwner === 'move') {
      const fresh = samples.filter(isFresh);
      transportCounters.rawSuppressedMoveOwned += fresh.length;
      return [];
    }
    if (transportOwner === 'undecided') {
      transportOwner = 'raw';
      movesWithoutRaw = 0;
    } else {
      movesWithoutRaw = 0;
    }
    // Raw is alive: buffered move candidates were premature — discard.
    clearFallbackCandidatesAsSuppressed();
    const maxT = maxTimeOf(samples);
    if (maxT !== null) lastRawTime = maxT;
    try {
      if (typeof performance !== 'undefined')
        lastRawWallTime = performance.now();
    } catch {
      // Wall clock unavailable; transport stamps govern.
    }
    const fresh = consumeFresh(samples);
    if (fresh.length > 0) lastRawSample = fresh[fresh.length - 1] ?? null;
    transportCounters.rawConfirmed += fresh.length;
    return fresh;
  }

  /**
   * Release buffered fallback candidates plus the triggering batch in
   * safe order (filtered against the raw frontier, never behind it).
   * Returns the consumable release set (already marked consumed).
   */
  function releaseFallbackBuffer(
    triggering: readonly NormalizedPointerEvent[],
  ): NormalizedPointerEvent[] {
    const combined: NormalizedPointerEvent[] = [
      ...fallbackCandidates,
      ...triggering,
    ];
    fallbackCandidates = [];
    const safe = consumeSafeForRelease(combined);
    transportCounters.moveConfirmed += safe.length;
    return safe;
  }

  /**
   * Authoritative confirmed intake for the move transport.
   *
   * While raw owns confirmed input, fresh move batches are BUFFERED as
   * fallback candidates (never committed yet) — the first stalled move
   * is preserved, not lost. Raw resuming discards the buffer; raw
   * remaining absent past the elapsed-time fallback condition latches
   * move ownership and releases the buffer in safe order (frontier-
   * filtered, never `P4 → older P2/P3`). Pure echoes and hold-still
   * repeats never buffer nor advance the detector. In `undecided`, moves
   * flow immediately and latch the fallback after the initial count
   * (raw-never-fires case — nothing was suppressed, nothing lost).
   */
  function acceptMoveConfirmed(
    samples: readonly NormalizedPointerEvent[],
  ): NormalizedPointerEvent[] {
    if (samples.length === 0) return [];
    if (transportOwner === 'raw') {
      const fresh: NormalizedPointerEvent[] = [];
      const freshIndices: number[] = [];
      for (let index = 0; index < samples.length; index += 1) {
        const sample = samples[index]!;
        if (!isFresh(sample)) continue;
        fresh.push(sample);
        freshIndices.push(index);
      }
      if (fresh.length === 0) return [];
      // Stale coalesced history behind the raw frontier is never
      // buffered: it is suppressed immediately (counted) so a later
      // release cannot append `P4 → older P2/P3`. Only frontier-ahead
      // samples become fallback candidates.
      // Some transports round several samples to the same timestamp. A
      // move batch can then contain older coalesced points at the exact raw
      // frontier time. Time alone cannot order those points: retain only the
      // equal-time suffix after the last raw sample echoed in this batch.
      // Strictly newer samples remain safe even when the overlap anchor has
      // fallen outside the browser's coalescing window.
      let rawAnchor = -1;
      if (lastRawSample !== null) {
        for (let i = 0; i < samples.length; i += 1) {
          if (identityMatches(samples[i]!, snapshotMark(lastRawSample)))
            rawAnchor = i;
        }
      }
      const ahead: NormalizedPointerEvent[] = [];
      for (let i = 0; i < fresh.length; i += 1) {
        const sample = fresh[i]!;
        if (
          sample.time !== undefined &&
          Number.isFinite(confirmedHighWater) &&
          sample.time < confirmedHighWater
        ) {
          continue;
        }
        if (
          sample.time !== undefined &&
          Number.isFinite(confirmedHighWater) &&
          sample.time === confirmedHighWater &&
          (rawAnchor < 0 || freshIndices[i]! <= rawAnchor)
        ) {
          continue;
        }
        ahead.push(sample);
      }
      if (ahead.length < fresh.length) {
        transportCounters.moveSuppressedRawOwned += fresh.length - ahead.length;
      }
      if (ahead.length === 0) return [];
      const progressed = ahead.some(
        (s) =>
          lastConfirmedView === null ||
          s.point.x !== lastConfirmedView.x ||
          s.point.y !== lastConfirmedView.y,
      );
      if (!progressed) return [];
      // Buffer first (lossless), then test the stall condition. The
      // triggering move's own samples join the release set so move #1 is
      // never stranded while move #2 flows.
      bufferFallbackCandidates(ahead);
      movesWithoutRaw += 1;
      const currentMax = maxTimeOf(samples);
      if (
        fallbackCandidates.length >= MAX_FALLBACK_CANDIDATES ||
        stallElapsedExceeded(currentMax, movesWithoutRaw)
      ) {
        latchMoveFallback();
        return releaseFallbackBuffer([]);
      }
      return [];
    }
    const fresh = consumeFresh(samples);
    transportCounters.moveConfirmed += fresh.length;
    if (transportOwner === 'undecided') {
      if (fresh.length > 0) {
        movesWithoutRaw += 1;
        if (movesWithoutRaw >= UNDECIDED_FALLBACK_MOVES) latchMoveFallback();
      }
    }
    return fresh;
  }

  function snapshotMark(sample: NormalizedPointerEvent): DedupMark {
    return {
      time: sample.time ?? 0,
      point: { ...sample.point },
      ...(sample.pressure !== undefined ? { pressure: sample.pressure } : {}),
      ...(sample.tilt !== undefined ? { tilt: { ...sample.tilt } } : {}),
      ...(sample.twist !== undefined ? { twist: sample.twist } : {}),
    };
  }

  /**
   * Drop predicted samples that have already become confirmed.
   * Each move supplies a complete replacement snapshot —
   * plus strictly-stale lookahead (older than every confirmed sample),
   * which would otherwise jump the tail backwards. Same-time-distinct
   * predictions still render. Never advances confirmed state:
   * future-dated lookahead must not swallow real samples.
   *
   * Then the product policy + horizons apply (forward-flash repair):
   * per-pointer-type enablement first (mouse/touch default off), then the
   * time lookahead (≈ one frame) and the cumulative SCREEN-space (CSS-px,
   * never surface units) distance horizon from the confirmed frontier.
   * Extreme browser predictions far ahead are trimmed to the horizon;
   * the kill-switch (`enabled: false`) drops everything while leaving
   * confirmed drawing byte-identical.
   */
  function freshPredicted(
    samples: readonly NormalizedPointerEvent[],
  ): readonly NormalizedPointerEvent[] {
    transportCounters.predictedReceived += samples.length;
    // Empty input is an explicit clear (event B ends Q).
    if (samples.length === 0) return [];
    const policy: PredictionPolicyOptions = deps.predictionPolicy ?? {};
    if (!shouldPredictForPointerType(drawPointerType ?? 'pen', policy)) {
      transportCounters.predictedScreenLengthPx = 0;
      return [];
    }
    const candidates = samples.filter((sample) => {
      if (sample.time !== undefined && sample.time < confirmedHighWater) {
        return false;
      }
      return !echoOf(sample, recentConfirmed);
    });
    // Each event replaces the entire snapshot. Stale/confirmed lookahead
    // must withdraw an old tail; repeated valid lookahead stays present.
    if (candidates.length === 0) {
      transportCounters.predictedScreenLengthPx = 0;
      return [];
    }
    const clipped = clipPredictedToHorizon(
      candidates,
      lastConfirmedView,
      confirmedHighWater,
      policy,
    );
    transportCounters.predictedRetained += clipped.retained.length;
    transportCounters.predictedScreenLengthPx = clipped.screenLengthPx;
    return [...clipped.retained];
  }

  function hitResizeBorder(
    view: Point,
    pointerType = 'mouse',
  ): ResizeMode | null {
    if (!deps.frameResizable) return null;
    const frame = frameBounds(deps.model.frame);
    if (frame === null) return null;
    return queryBorderHitMode(
      view,
      queryFrameRectView(deps.controller.camera(), frame),
      true,
      pointerType,
    );
  }

  function showResizeBadge(view: Point, width: number, height: number): void {
    deps.badge.textContent = `${Math.round(width)} × ${Math.round(height)}`;
    deps.badge.style.left = `${view.x + 14}px`;
    deps.badge.style.top = `${view.y + 14}px`;
    deps.badge.style.display = 'block';
  }

  function applyFrameResize(resizeMode: ResizeMode, view: Point): void {
    const session = resizeSession;
    if (session === null) return;
    const camera = session.startCamera;
    const dxUnits = (view.x - session.startView.x) / camera.zoom;
    const dyUnits = (view.y - session.startView.y) / camera.zoom;
    const computed = computeResizedFrame(
      session.startFrame,
      resizeMode,
      dxUnits,
      dyUnits,
    );
    deps.model.frame = { ...deps.model.frame, ...computed.frame };
    session.changed = computed.changed;
    session.contentDelta = {
      x: -computed.originAdjustX,
      y: -computed.originAdjustY,
    };
    deps.previewFrameContentTranslation?.(session.contentDelta);
    deps.controller.setCamera(
      reanchorCameraForResize(
        camera,
        computed.originAdjustX,
        computed.originAdjustY,
      ),
    );
    showResizeBadge(view, computed.frame.width, computed.frame.height);
    deps.invalidateScene();
  }

  function clearSelection(): void {
    if (deps.controller.selection().length === 0) return;
    deps.controller.setSelection([]);
    deps.notifyTools();
    deps.scheduleRender();
  }

  function cancelTouchInteraction(): void {
    const touchResize =
      mode === 'resize-object' &&
      objectResize !== null &&
      pointerKinds.get(objectResize.pointerId) === 'touch';
    if (!touchResize && (mode !== 'draw' || drawPointerType !== 'touch'))
      return;
    const ids = [...pointers.keys()];
    resetGestureState();
    for (const id of ids) {
      try {
        deps.canvas.releasePointerCapture?.(id);
      } catch {
        /* Already released. */
      }
    }
    deps.notifyTools();
    deps.scheduleRender();
  }

  function claimTouchInteraction(event: PointerEvent): boolean {
    if (
      event.pointerType !== 'touch' ||
      deps.isDestroyed() ||
      deps.isReadOnly() ||
      mode !== 'idle'
    )
      return false;
    const view = viewPoint(event);
    // Selected resize handles take precedence even just outside the body.
    if (resizeTargetAt(view, 'touch') !== null) {
      onPointerDown(event, true);
      return pointers.has(event.pointerId);
    }
    const target = deps.controller.touchSelectionTarget?.(view) ?? null;
    rememberTouchIntent(event, view, target);
    if (target?.kind === 'object') {
      clearSelection();
      return false;
    }
    if (target === null) {
      clearSelection();
      return false;
    }
    onPointerDown(event, true);
    return pointers.has(event.pointerId);
  }

  function onPointerDown(event: PointerEvent, claimedTouch = false): void {
    if (
      shouldIgnorePointerDown({
        pointerType: event.pointerType as PointerType,
        delegateTouchNavigation: deps.delegateTouchNavigation && !claimedTouch,
        destroyed: deps.isDestroyed(),
      })
    ) {
      return;
    }
    if (
      typeof event.clientX !== 'number' ||
      typeof event.clientY !== 'number' ||
      !Number.isFinite(event.clientX) ||
      !Number.isFinite(event.clientY)
    ) {
      return;
    }
    if (pointers.has(event.pointerId)) return;
    if (
      event.pointerType === 'touch' &&
      mode === 'draw' &&
      drawPointerType !== 'touch'
    )
      return;
    const rect = coordinateElement.getBoundingClientRect();
    const view = viewPointFromRect(event, rect);
    // A new touch inherits the visually current transient camera. Non-touch
    // input owns authoring precedence: terminate any active finger gesture,
    // discard released motion, and legalize the camera before routing down.
    if (event.pointerType === 'touch') cancelNavigationAnimation(false);
    else {
      cancelTouchInteraction();
      terminateActiveTouchNavigation();
      cancelNavigationAnimation(true);
    }
    pointers.set(event.pointerId, navigationPoint(event, view));
    pointerKinds.set(event.pointerId, event.pointerType as PointerType);
    publishCursorSample(event, view, true);

    const touchObjectResize =
      event.pointerType === 'touch' && pointers.size === 1 && !deps.isReadOnly()
        ? resizeTargetAt(view, 'touch')
        : null;
    const touchResizeEdge =
      touchObjectResize === null &&
      event.pointerType === 'touch' &&
      pointers.size === 1 &&
      !deps.isReadOnly() &&
      deps.canRebaseFrameContent?.() !== false
        ? hitResizeBorder(view, 'touch')
        : null;
    const touchTarget =
      event.pointerType === 'touch' &&
      pointers.size === 1 &&
      !deps.isReadOnly() &&
      touchResizeEdge === null &&
      touchObjectResize === null
        ? (deps.controller.touchSelectionTarget?.(view) ?? null)
        : null;
    if (
      event.pointerType === 'touch' &&
      pointers.size === 1 &&
      touchResizeEdge === null &&
      touchObjectResize === null &&
      !deps.isReadOnly()
    )
      rememberTouchIntent(event, view, touchTarget);
    const touchMovesSelection =
      touchTarget?.kind === 'selection' || touchObjectResize !== null;
    if (
      event.pointerType === 'touch' &&
      pointers.size === 1 &&
      touchResizeEdge === null &&
      touchObjectResize === null &&
      touchTarget?.kind !== 'selection'
    )
      clearSelection();
    if (
      event.pointerType === 'touch' &&
      deps.cameraInteractive &&
      touchResizeEdge === null &&
      !touchMovesSelection
    ) {
      if (
        drawPointerType !== 'touch' &&
        shouldRejectTouchDuringDraw({
          mode,
          pointerType: event.pointerType,
          cameraInteractive: deps.cameraInteractive,
        })
      ) {
        pointers.delete(event.pointerId);
        return;
      }
      if (touchPair(null) !== null) {
        if (mode === 'resize-object') {
          deps.cancelHistoryGesture();
          objectResize = null;
          mode = 'idle';
          deps.invalidateScene();
          deps.notifyTools();
        }
        if (mode === 'draw' && drawPointerType === 'touch') {
          deps.controller.pointerCancel();
          drawCoalescer.reset();
          clearHoldTimer();
          drawPointerId = null;
          drawPointerType = null;
          drawSelectionGesture = false;
          deps.notifyTools();
          deps.scheduleRender();
        }
        event.preventDefault();
        deps.canvas.setPointerCapture?.(event.pointerId);
        deps.page.classList.add('panning');
        // Survivor re-pinch (embedded 2->1 stays in pinch with cleared
        // baseline) must rebase to the new pair; an active 2-finger pinch
        // keeps its primary pair so a third finger never jumps the zoom.
        if (mode !== 'pinch' || pinchStart === null) rebasePinch(null);
      } else if (deps.navigationMode === 'embedded') {
        event.preventDefault();
        deps.canvas.setPointerCapture?.(event.pointerId);
        deps.page.classList.add('panning');
        mode = 'pan';
        panLast = navigationPoint(event, view);
        // embedded forwarder only: never snapshot local camera —
        // the pager owns preview/settle. Velocity still tracks locally so
        // the release forward carries a diagnostic velocity.
        panRawCamera = null;
        panEmbedded = true;
        panTouch = true;
        panVelocity.reset();
        const point = navigationPoint(event, view);
        panVelocity.add(event.timeStamp, { x: -point.x, y: -point.y });
      } else {
        event.preventDefault();
        deps.canvas.setPointerCapture?.(event.pointerId);
        deps.page.classList.add('panning');
        mode = 'pan';
        panLast = navigationPoint(event, view);
        panRawCamera = deps.controller.camera();
        panEmbedded = false;
        panTouch = true;
        panVelocity.reset();
        const point = navigationPoint(event, view);
        panVelocity.add(event.timeStamp, { x: -point.x, y: -point.y });
      }
      return;
    }

    event.preventDefault();

    // preventDefault suppresses the browser's focus transfer. Reclaim the
    // React-owned surface root so shortcuts work after choosing a tool;
    // preventScroll keeps Notebook's page stack and camera stationary.
    boundRoot?.focus({ preventScroll: true });

    const explicitPan =
      deps.cameraInteractive &&
      (deps.isReadOnly() || spaceHeld || event.button === 1);
    if (explicitPan) {
      deps.canvas.setPointerCapture?.(event.pointerId);
      mode = 'pan';
      panLast = navigationPoint(event, view);
      panEmbedded = deps.navigationMode === 'embedded';
      panRawCamera = panEmbedded ? null : deps.controller.camera();
      // Reuse the pager-owned pan/release path for desktop navigation on an
      // embedded page. It must never mutate the page's private camera.
      panTouch = panEmbedded;
      panVelocity.reset();
      const point = navigationPoint(event, view);
      panVelocity.add(event.timeStamp, { x: -point.x, y: -point.y });
      // The Notebook pager owns embedded navigation. Claiming the page's
      // private camera here disables its resize-time fit when the pager later
      // changes page size, leaving the page bitmap CSS-scaled and soft.
      if (!panEmbedded) deps.setUserNavigated(true);
      deps.page.classList.add('panning');
      return;
    }

    if (deps.isReadOnly()) {
      pointers.delete(event.pointerId);
      pointerKinds.delete(event.pointerId);
      return;
    }

    const target =
      event.pointerType === 'touch' ? touchObjectResize : resizeTargetAt(view);
    const surfacePoint = viewToSurface(deps.controller.camera(), view);
    const textSelectionHandle =
      event.pointerType !== 'touch' &&
      deps.getActiveToolId() === INK_TOOL_IDS.text &&
      deps.controller
        .selectionContext?.()
        ?.handles?.some(
          (handle) =>
            Math.hypot(handle.x - surfacePoint.x, handle.y - surfacePoint.y) *
              deps.controller.camera().zoom <=
            10,
        ) === true;
    if (
      event.pointerType !== 'touch' &&
      target === null &&
      !textSelectionHandle &&
      deps.controller.isAuthoringTool?.() === true
    )
      clearSelection();
    if (pointers.size === 1 && target !== null) {
      deps.controller.setSelection([target.id]);
      deps.canvas.setPointerCapture?.(event.pointerId);
      deps.beginHistoryGesture();
      touchTap = null;
      objectResize = {
        pointerId: event.pointerId,
        id: target.id,
        startView: view,
        startWidth: target.bounds.width,
        startHeight: target.bounds.height,
      };
      mode = 'resize-object';
      return;
    }

    if (
      pointers.size === 1 &&
      deps.getActiveToolId() === INK_TOOL_IDS.text &&
      event.pointerType !== 'touch'
    ) {
      const point = viewToSurface(deps.controller.camera(), view);
      const hit = deps.controller.hitTest?.(point) ?? null;
      if (hit === null && !textSelectionHandle) {
        deps.openTextOverlay(point);
        pointers.delete(event.pointerId);
        pointerKinds.delete(event.pointerId);
        return;
      }
    }

    const edge = touchResizeEdge ?? hitResizeBorder(view);
    if (edge !== null && pointers.size === 1) {
      if (deps.canRebaseFrameContent?.() === false) {
        pointers.delete(event.pointerId);
        return;
      }
      deps.canvas.setPointerCapture?.(event.pointerId);
      deps.beginHistoryGesture();
      deps.setUserNavigated(true);
      resizeSession = {
        mode: edge,
        startFrame: frameBounds(deps.model.frame) ?? {
          width: 800,
          height: 600,
        },
        startCamera: deps.controller.camera(),
        startView: view,
        changed: false,
        contentDelta: { x: 0, y: 0 },
      };
      mode = 'resize';
      return;
    }

    deps.canvas.setPointerCapture?.(event.pointerId);

    if (pointers.size === 1) {
      mode = 'draw';
      drawSelectionGesture = touchMovesSelection;
      drawPointerId = event.pointerId;
      resetDedup();
      // Set after resetDedup: resetTransport() clears per-gesture policy
      // state, and the down pointer type selects it.
      drawPointerType = (event.pointerType as string) ?? 'pen';
      drawCoalescer.reset();
      const down = normalizeInkPointerEvent(event, rect);
      if (down === null) {
        // Malformed down coords: never start a stuck draw gesture.
        pointers.delete(event.pointerId);
        mode = 'idle';
        drawPointerId = null;
        drawPointerType = null;
        return;
      }
      // The down point is the prediction-horizon frontier until the first
      // confirmed move/raw sample extends it.
      lastConfirmedView = { x: down.point.x, y: down.point.y };
      lastConfirmedSample = down;
      clippedDrawLast = null;
      clippedDrawActive = false;
      clippedDrawStarted = false;
      if (captureRectView() === null)
        deps.controller.pointerDown(
          down,
          drawSelectionGesture
            ? 'touch'
            : deps.getActiveToolId() === INK_TOOL_IDS.text,
        );
      else dispatchClippedConfirmed([down]);
      deps.scheduleRender();
      if (drawSelectionGesture) deps.notifyTools();
      else scheduleHoldTimer();
      return;
    }
  }

  /**
   * Raw-movement authoritative path: `pointerrawupdate` OWNS confirmed
   * input for the gesture and is never a prediction source. Moves supply
   * predictions + hover UI while raw owns; the move fallback takes over
   * only after the elapsed-time stall condition. Runs only mid-draw for
   * the draw pointer; anything else stays on the pointermove path.
   */
  function onPointerRawUpdate(event: PointerEvent): void {
    if (deps.isDestroyed()) return;
    if (mode !== 'draw' || event.pointerId !== drawPointerId) return;
    if (!pointers.has(event.pointerId)) return;
    if (
      typeof event.clientX !== 'number' ||
      typeof event.clientY !== 'number' ||
      !Number.isFinite(event.clientX) ||
      !Number.isFinite(event.clientY)
    ) {
      return;
    }
    const rect = coordinateElement.getBoundingClientRect();
    const view = viewPointFromRect(event, rect);
    pointers.set(event.pointerId, navigationPoint(event, view));
    publishCursorSample(event, view, true);
    const batch = normalizeInkInputBatch(event, rect);
    const fresh = acceptRawConfirmed(batch.confirmed);
    submitRawConfirmed(fresh);
  }

  /**
   * Stable Event-typed listener: `pointerrawupdate` is absent from this
   * TS version's DOM event map, so the generic overload applies.
   * Raw-update events are PointerEvents per spec; the cast is exact.
   */
  function onRawUpdateEvent(event: Event): void {
    onPointerRawUpdate(event as PointerEvent);
  }

  function onPointerMove(event: PointerEvent): void {
    if (deps.isDestroyed()) return;
    // One geometry read per DOM event: every coalesced/predicted sample in
    // this event normalizes against the same rect (hot-path requirement).
    const rect = coordinateElement.getBoundingClientRect();
    if (
      typeof event.clientX !== 'number' ||
      typeof event.clientY !== 'number' ||
      !Number.isFinite(event.clientX) ||
      !Number.isFinite(event.clientY)
    ) {
      return;
    }
    const view = viewPointFromRect(event, rect);
    publishCursorSample(event, view, pointers.has(event.pointerId));
    if (!pointers.has(event.pointerId)) {
      if (deps.cursorPresenter === undefined) {
        const hovered = hitResizeBorder(view);
        deps.page.style.cursor =
          hovered === null ? '' : HANDLE_CURSORS[hovered];
      }
      return;
    }
    pointers.set(event.pointerId, navigationPoint(event, view));

    if (mode === 'resize-object' && objectResize !== null) {
      const record = deps.model.objects[objectResize.id];
      if (record !== undefined) {
        const camera = deps.controller.camera();
        deps.controller.resizeObject(objectResize.id, {
          width: Math.max(
            record.type === 'froglight.card' ? 64 : 1,
            objectResize.startWidth +
              (view.x - objectResize.startView.x) / camera.zoom,
          ),
          ...(record.type === 'froglight.text'
            ? {}
            : {
                height: Math.max(
                  record.type === 'froglight.card' ? 32 : 1,
                  objectResize.startHeight +
                    (view.y - objectResize.startView.y) / camera.zoom,
                ),
              }),
        });
        deps.scheduleRender();
      }
      return;
    }
    if (mode === 'resize' && resizeSession !== null) {
      applyFrameResize(resizeSession.mode, view);
      return;
    }
    if (!pointers.has(event.pointerId) || mode === 'idle') return;

    if (mode === 'draw' && event.pointerId !== drawPointerId) return;
    if (mode === 'draw') {
      const batch = normalizeInkInputBatch(event, rect);
      // Authoritative transport: while raw owns, move confirmed batches
      // buffer as fallback candidates (lossless); the elapsed-time stall
      // releases them in safe order. Predictions always flow from moves
      // (raw is never a prediction source) and an empty snapshot clears.
      const fresh = acceptMoveConfirmed(batch.confirmed);
      // Predicted tails filter against the same mark but never advance
      // it: future-dated lookahead must not swallow real samples, yet an
      // echoed move must not re-render an identical tail either. Policy +
      // horizons then trim the flash-ahead tail (pen-only, screen-space).
      const predicted = freshPredicted(batch.predicted);
      submitMoveBatch(fresh, predicted);
      // Any movement restarts the hold clock.
      scheduleHoldTimer();
      return;
    }
    if (mode === 'pan' && panLast !== null) {
      const point = navigationPoint(event, view);
      const delta = { x: panLast.x - point.x, y: panLast.y - point.y };
      pinchSettleTarget = null;
      // embedded forwarder only: forward the delta (both axes),
      // keep local velocity tracking, but never touch local camera and
      // never schedule a local render — the pager owns the frame.
      if (panEmbedded) deps.onEmbeddedPan?.(delta);
      else {
        const raw = panRawCamera ?? deps.controller.camera();
        panRawCamera = {
          ...raw,
          x: raw.x + delta.x / raw.zoom,
          y: raw.y + delta.y / raw.zoom,
        };
        publishCamera(transientCamera(panRawCamera));
      }
      panVelocity.add(event.timeStamp, { x: -point.x, y: -point.y });
      panLast = point;
      if (!panEmbedded) deps.scheduleRender();
      return;
    }
    if (mode === 'pinch') {
      const pair = touchPair();
      if (pair === null) {
        // 2->1 survivor fallback (embedded): forward the remaining
        // single-finger moves as pan deltas so the pager preview.translation
        // tracks the survivor (pager survivor branch owns the translation).
        // Runs even with a cleared pinch baseline (survivor handoff nulls it
        // so re-pinch rebases cleanly); single commit via ZoomEnd, never a
        // competing local publish/render.
        if (
          deps.navigationMode === 'embedded' &&
          panEmbedded &&
          deps.onEmbeddedPan !== undefined
        ) {
          const survivor = [...pointers.entries()].find(
            ([id]) => pointerKinds.get(id) === 'touch',
          )?.[1];
          if (survivor !== undefined) {
            if (panLast !== null) {
              const delta = {
                x: panLast.x - survivor.x,
                y: panLast.y - survivor.y,
              };
              if (delta.x !== 0 || delta.y !== 0) {
                deps.onEmbeddedPan(delta);
                panVelocity.add(event.timeStamp, {
                  x: -survivor.x,
                  y: -survivor.y,
                });
              }
            }
            panLast = survivor;
          }
        }
        return;
      }
      if (pinchStart === null) {
        // Baseline cleared for the 2->1 survivor handoff (so re-pinch rebases
        // cleanly on next down). A 2-finger move arriving here without a
        // baseline re-anchors defensively instead of crashing; the next move
        // is incremental from the fresh baseline.
        rebasePinch(null);
        return;
      }
      const nextCentroid = {
        x: (pair[0].x + pair[1].x) / 2,
        y: (pair[0].y + pair[1].y) / 2,
      };
      const nextDistance = Math.max(
        Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y),
        1,
      );
      const start = pinchStart;
      const factor = nextDistance / start.distance;
      if (
        deps.navigationMode === 'embedded' &&
        deps.onEmbeddedZoom !== undefined
      ) {
        // embedded forwarder only: incremental factor/translation
        // plus local rebase, never elastic/publish locally.
        deps.onEmbeddedZoom({
          factor,
          // Keep the callback's canvas-local anchor contract; only deltas
          // and pair distances use the stable client coordinate space.
          point: {
            x: nextCentroid.x - rect.left,
            y: nextCentroid.y - rect.top,
          },
          translation: {
            x: nextCentroid.x - start.centroid.x,
            y: nextCentroid.y - start.centroid.y,
          },
          source: 'touch',
        });
        pinchStart = {
          centroid: nextCentroid,
          distance: nextDistance,
          camera: start.camera,
          anchor: start.anchor,
        };
        return;
      }
      const requestedZoom = factor * start.camera.zoom;
      const legalZoom = clampZoom(requestedZoom);
      const outwardAtSaturatedLimit =
        (start.camera.zoom >= MAX_ZOOM && requestedZoom > MAX_ZOOM) ||
        (start.camera.zoom <= MIN_ZOOM && requestedZoom < MIN_ZOOM);
      const zoom = outwardAtSaturatedLimit
        ? start.camera.zoom
        : elasticZoom(requestedZoom, MIN_ZOOM, MAX_ZOOM).visualZoom;
      pinchSettleTarget = deps.clampToSheet(
        zoomCameraAroundPointUnclamped(
          start.camera,
          legalZoom,
          start.centroid,
          nextCentroid,
        ),
      );
      publishCamera(
        transientCamera(
          zoomCameraAroundPointUnclamped(
            start.camera,
            zoom,
            start.centroid,
            nextCentroid,
          ),
        ),
      );
      deps.scheduleRender();
    }
  }

  /**
   * Settle draw/pan modes when one pointer lifts.
   * A draw ending with pointers still down never sticks in 'draw': a
   * remaining touch resumes panning (pen lifts while touch remains),
   * anything else idles so the next gesture starts clean. A pan with a
   * remaining pointer keeps panning from the live track.
   */
  function settleAfterDraw(): void {
    drawPointerId = null;
    drawPointerType = null;
    if (pointers.size === 0) {
      mode = 'idle';
      panLast = null;
      panRawCamera = null;
      panEmbedded = false;
      panTouch = false;
      deps.page.classList.remove('panning');
      return;
    }
    const remaining = [...pointers.entries()];
    if (mode === 'pan') {
      panLast = remaining[0]![1];
      // embedded never snapshots local camera.
      panRawCamera = panEmbedded ? null : deps.controller.camera();
      return;
    }
    const allTouch = remaining.every(
      ([id]) => pointerKinds.get(id) === 'touch',
    );
    if (allTouch && deps.cameraInteractive) {
      mode = 'pan';
      panLast = remaining[0]![1];
      panEmbedded = deps.navigationMode === 'embedded';
      panRawCamera = panEmbedded ? null : deps.controller.camera();
      panTouch = true;
      deps.page.classList.add('panning');
      return;
    }
    mode = 'idle';
    panLast = null;
    panRawCamera = null;
    panEmbedded = false;
    panTouch = false;
    deps.page.classList.remove('panning');
  }

  function onPointerUp(event: PointerEvent, interrupted = false): void {
    if (deps.isDestroyed()) return;
    try {
      let cursorView: Point | null = null;
      const cursorPoint = (): Point => (cursorView ??= viewPoint(event));
      const endedStandalonePan = mode === 'pan' && !panEmbedded;
      // capture embedded ownership BEFORE settle mutates mode.
      const wasEmbeddedPan = mode === 'pan' && panTouch && panEmbedded;
      const wasEmbeddedPinch =
        mode === 'pinch' && deps.navigationMode === 'embedded';
      const liftedPrimary = primaryTouchIds?.includes(event.pointerId) === true;
      pointers.delete(event.pointerId);
      pointerKinds.delete(event.pointerId);

      if (
        mode === 'draw' &&
        !interrupted &&
        touchTap?.pointerId === event.pointerId &&
        touchTap.action.kind === 'edit-selection'
      ) {
        // A selected-object tap activates it after lift. Roll back finger
        // jitter before opening the editor; a real drag invalidated the tap.
        deps.controller.pointerCancel();
        drawCoalescer.reset();
        resetDedup();
        clearHoldTimer();
        settleAfterDraw();
        finishTouchTap(event, true);
        deps.scheduleRender();
        return;
      }

      if (mode === 'resize') {
        if (pointers.size === 0) {
          const changed = resizeSession?.changed === true;
          const contentDelta = resizeSession?.contentDelta ?? { x: 0, y: 0 };
          if (changed) deps.commitFrameContentTranslation?.(contentDelta);
          deps.previewFrameContentTranslation?.(null);
          mode = 'idle';
          resizeSession = null;
          deps.badge.style.display = 'none';
          deps.commitHistoryGesture();
          if (changed) {
            deps.markDirty();
            deps.notifyTools();
          }
          deps.invalidateScene();
        }
        publishCursorSample(event, cursorPoint(), false);
        return;
      }
      if (mode === 'resize-object') {
        if (pointers.size === 0) {
          mode = 'idle';
          objectResize = null;
          deps.commitHistoryGesture();
        }
        deps.scheduleRender();
        publishCursorSample(event, cursorPoint(), false);
        return;
      }
      if (mode === 'draw' && event.pointerId === drawPointerId) {
        // Gesture-end resolution (lossless):
        // 1. flush pending shared-frame confirmed input;
        // 2. resolve any raw-stall fallback candidates;
        // 3. consume genuinely new ordered pointerup/coalesced samples;
        // 4. send the final sample through pointerUp;
        // 5. commit (caller-owned history runs inside pointerUp).
        // Predictions are meaningless at gesture end and are dropped
        // before the up flush. No confirmed movement may disappear at lift,
        // even when raw stopped immediately before pointerup.
        if (
          deps.coalesceDrawInput === true &&
          deps.getActiveToolId() !== SURFACE_TOOL_IDS.eraser
        ) {
          drawCoalescer.dropPredictions();
          flushCoalescedInputWithoutScheduling();
        }
        const rect = coordinateElement.getBoundingClientRect();
        cursorView = interrupted
          ? (lastConfirmedSample?.point ?? null)
          : viewPointFromRect(event, rect);
        const upBatch = interrupted
          ? []
          : normalizeInkPointerUpBatch(
              event,
              rect,
              fallbackCandidates[fallbackCandidates.length - 1] ??
                lastConfirmedSample,
            ).confirmed;
        let confirmed: NormalizedPointerEvent[];
        if (transportOwner === 'raw') {
          // Raw owned until lift: buffered move candidates plus the up
          // batch may hold the only record of P5→P6. Release the safe
          // prefix (never behind the raw frontier); genuinely new up
          // samples close the gesture instead of being dropped as echoes.
          const bufferedSafe =
            fallbackCandidates.length > 0
              ? (() => {
                  const combined = [...fallbackCandidates];
                  fallbackCandidates = [];
                  const safe = consumeSafeForRelease(combined);
                  if (safe.length > 0) {
                    latchMoveFallback();
                    transportCounters.moveConfirmed += safe.length;
                  } else {
                    transportCounters.moveSuppressedRawOwned += combined.length;
                  }
                  return safe;
                })()
              : [];
          const upSafe = consumeSafeForRelease(upBatch);
          if (upSafe.length > 0 && bufferedSafe.length === 0) {
            // No buffered moves but the up itself advanced: raw stopped
            // immediately before lift — latch so the tail is preserved.
            latchMoveFallback();
          }
          transportCounters.moveConfirmed += upSafe.length;
          // Buffered safe samples were already marked above; dispatch the
          // full ordered tail (buffered + up) with the last sample closing
          // via pointerUp. Stale up echoes contribute nothing.
          confirmed = [...bufferedSafe, ...upSafe];
        } else {
          confirmed = consumeFresh(upBatch);
          transportCounters.moveConfirmed += confirmed.length;
        }
        dispatchBatchHead(confirmed.slice(0, -1));
        const last = confirmed[confirmed.length - 1];
        if (last !== undefined) {
          finishDrawGesture(last);
        } else {
          const fallback =
            lastConfirmedSample ?? normalizeInkPointerEvent(event, rect);
          if (fallback !== null) finishDrawGesture(fallback);
          else deps.controller.pointerCancel();
        }
        // Selection-only gestures do not emit a model mutation. Publish their
        // final state once so contextual toolbar actions follow the selection.
        deps.notifyTools();
        resetDedup();
        clearHoldTimer();
        drawCoalescer.reset();
      }
      if (mode === 'draw' && event.pointerId !== drawPointerId) return;
      // Draw/pan settle; pinch keeps its own branch.
      if (mode === 'draw' || mode === 'pan') settleAfterDraw();
      if (endedStandalonePan && pointers.size === 0)
        beginPanRelease(event.timeStamp, cursorPoint());
      if (mode === 'pinch') {
        const remainingPair = touchPair(primaryTouchIds);
        if (remainingPair !== null) {
          if (liftedPrimary) rebasePinch(primaryTouchIds);
        } else {
          discardNavigationAnimation();
          pinchStart = null;
          primaryTouchIds = null;
          const remaining = [...pointers.entries()].find(
            ([id]) => pointerKinds.get(id) === 'touch',
          )?.[1];
          if (remaining !== undefined) {
            if (wasEmbeddedPinch) {
              // 2->1 survivor: keep the pager preview open until the
              // last lift (single commit via ZoomEnd) while forwarding the
              // survivor's moves as pan deltas so pager preview.translation
              // tracks (pager survivor branch). panLast seeds the delta so
              // the first survivor move is not lost. Matches the cancel-path
              // handoff (unified forward, both stay in pinch for embedded).
              mode = 'pinch';
              panLast = remaining;
              panRawCamera = null;
              panEmbedded = true;
              panTouch = true;
              panVelocity.reset();
              panVelocity.add(event.timeStamp, {
                x: -remaining.x,
                y: -remaining.y,
              });
            } else {
              mode = 'pan';
              panLast = remaining;
              // embedded never snapshots local camera.
              panEmbedded = deps.navigationMode === 'embedded';
              panRawCamera = panEmbedded ? null : deps.controller.camera();
              panTouch = true;
              panVelocity.reset();
              panVelocity.add(event.timeStamp, {
                x: -remaining.x,
                y: -remaining.y,
              });
            }
          } else {
            mode = 'idle';
            panLast = null;
            panRawCamera = null;
            panEmbedded = false;
            panTouch = false;
            deps.page.classList.remove('panning');
            // pager absorbs the settle — forward instead of a local
            // release animation. Never populates navigationAnimation.
            if (wasEmbeddedPinch) deps.onEmbeddedZoomEnd?.();
          }
        }
      }
      // embedded pan release forwards velocity; never a local
      // beginPanRelease, never a local animation/render.
      if (wasEmbeddedPan && pointers.size === 0 && mode === 'idle') {
        try {
          const releaseView = cursorPoint();
          const velocity = panVelocity.velocityAt(event.timeStamp, {
            x: -releaseView.x,
            y: -releaseView.y,
          });
          deps.onEmbeddedPanEnd?.(velocity);
        } catch {
          try {
            deps.onEmbeddedPanEnd?.({ x: 0, y: 0 });
          } catch {
            // Forwarding must never break pointerup.
          }
        } finally {
          panVelocity.reset();
        }
      }
      // embedded gestures are pager-rendered; skip the local frame.
      if (wasEmbeddedPan || wasEmbeddedPinch) {
        // Still clear a stale animation defensively (never set for embedded,
        // but a preceding standalone gesture could have left one).
        if (pointers.size === 0) discardNavigationAnimation();
        publishCursorSample(event, cursorPoint(), false);
        return;
      }
      if (interrupted) {
        lastCursorSample = null;
        deps.cursorPresenter?.reset();
      } else publishCursorSample(event, cursorPoint(), false);
      deps.scheduleRender();
    } catch (error) {
      if (mode === 'draw' && event.pointerId === drawPointerId) {
        try {
          deps.controller.pointerCancel();
        } finally {
          resetDedup();
          clearHoldTimer();
          drawCoalescer.reset();
          settleAfterDraw();
          pointers.delete(event.pointerId);
          pointerKinds.delete(event.pointerId);
          deps.scheduleRender();
        }
      }
      throw error;
    }
  }

  /**
   * Retain confirmed freehand Pencil input on OS interruption. Cancellation
   * has no trustworthy final coordinates or predictions. Other authoring
   * gestures (selection, shapes, resizing) still roll back their previews.
   */
  function onPointerCancel(event: PointerEvent): void {
    if (deps.isDestroyed()) return;
    const tool = deps.getActiveToolId();
    if (
      mode === 'draw' &&
      event.pointerId === drawPointerId &&
      drawPointerType === 'pen' &&
      [
        SURFACE_TOOL_IDS.pen,
        SURFACE_TOOL_IDS.fountain,
        SURFACE_TOOL_IDS.brush,
        SURFACE_TOOL_IDS.pencil,
        SURFACE_TOOL_IDS.highlighter,
      ].some((id) => id === tool)
    ) {
      onPointerUp(event, true);
      return;
    }
    // capture embedded ownership before state is cleared.
    const wasEmbedded =
      (mode === 'pan' && panTouch && panEmbedded) ||
      (mode === 'pinch' && deps.navigationMode === 'embedded');
    const liftedPrimary = primaryTouchIds?.includes(event.pointerId) === true;
    pointers.delete(event.pointerId);
    pointerKinds.delete(event.pointerId);
    if (lastCursorSample?.pointerId === event.pointerId) {
      lastCursorSample = null;
      deps.cursorPresenter?.reset();
    }
    try {
      deps.canvas.releasePointerCapture?.(event.pointerId);
    } catch {
      // Capture may already be released; cancellation must still close.
    }

    if (mode === 'resize' || mode === 'resize-object') {
      if (pointers.size === 0) {
        const startCamera = resizeSession?.startCamera;
        mode = 'idle';
        resizeSession = null;
        objectResize = null;
        deps.previewFrameContentTranslation?.(null);
        deps.badge.style.display = 'none';
        deps.cancelHistoryGesture();
        if (startCamera !== undefined) {
          deps.controller.setCamera(startCamera);
        }
        deps.notifyTools();
        deps.invalidateScene();
      }
      return;
    }
    if (mode === 'draw' && event.pointerId === drawPointerId) {
      // Cancel discards unflushed previews too (never committed).
      drawCoalescer.reset();
      deps.controller.pointerCancel();
      clippedDrawLast = null;
      clippedDrawActive = false;
      clippedDrawStarted = false;
      resetDedup();
      clearHoldTimer();
    }
    if (mode === 'draw' && event.pointerId !== drawPointerId) return;
    // Selection drags route through the same controller port: abort their
    // drag state as well so a cancelled drag never sticks.
    if (mode !== 'draw' && mode !== 'idle') {
      try {
        deps.controller.pointerCancel();
      } catch {
        // Ports without cancel support still get state cleanup below.
      }
    }
    // A cancelled draw settles like a lift (no commit, no stuck mode).
    if (mode === 'draw' || mode === 'pan') settleAfterDraw();
    drawPointerId = null;
    drawPointerType = null;
    if (pointers.size === 0) {
      mode = 'idle';
      panLast = null;
      panRawCamera = null;
      panEmbedded = false;
      panTouch = false;
      pinchStart = null;
      primaryTouchIds = null;
      objectResize = null;
      resizeSession = null;
      deps.badge.style.display = 'none';
      deps.page.classList.remove('panning');
      cancelNavigationAnimation(true);
    } else if (mode === 'pinch') {
      const pair = touchPair(primaryTouchIds);
      if (pair !== null) {
        if (liftedPrimary) rebasePinch(primaryTouchIds);
      } else {
        discardNavigationAnimation();
        pinchStart = null;
        primaryTouchIds = null;
        const remaining = [...pointers.entries()].find(
          ([id]) => pointerKinds.get(id) === 'touch',
        )?.[1];
        if (remaining !== undefined) {
          // survivor parity with the up path: embedded stays in pinch
          // (single commit via ZoomEnd/Cancel) while forwarding survivor
          // moves as pan deltas; standalone hands to pan with a camera
          // snapshot. Both forward deterministically (never freeze).
          if (deps.navigationMode === 'embedded') {
            mode = 'pinch';
            panLast = remaining;
            panRawCamera = null;
            panEmbedded = true;
            panTouch = true;
            panVelocity.reset();
          } else {
            mode = 'pan';
            panLast = remaining;
            // embedded never snapshots local camera.
            panEmbedded = false;
            panRawCamera = deps.controller.camera();
            panTouch = true;
            panVelocity.reset();
          }
        } else {
          mode = 'idle';
          panLast = null;
          panRawCamera = null;
          panEmbedded = false;
          panTouch = false;
          deps.page.classList.remove('panning');
        }
      }
    }
    // embedded cancel forwards only when the gesture ends (no
    // survivors); a cancelled finger with a remaining survivor continues
    // forwarding pans like the up path (unified forward) — never a local
    // animation/render.
    if (wasEmbedded) {
      if (pointers.size === 0) {
        try {
          deps.onEmbeddedCancel?.();
        } catch {
          // Forwarding must never break cancel.
        } finally {
          panVelocity.reset();
          discardNavigationAnimation();
        }
        return;
      }
      discardNavigationAnimation();
      return;
    }
    deps.scheduleRender();
  }

  function onLostPointerCapture(event: PointerEvent): void {
    // split like the pager (cancel=discard, lost=legalize):
    // authoring follows the interruption policy (retain confirmed pen ink,
    // roll back other previews); finger navigation legalizes like a
    // release via the single `onPointerUp` path so decay/spring arms instead
    // of snap-discarding (no forked physics, no second rAF).
    if (!pointers.has(event.pointerId)) {
      // A normal pointerup removes the pointer first and restores a hover
      // sample. Chromium then delivers lostpointercapture asynchronously;
      // that acknowledgement must not erase the valid hover affordance.
      // Cancellation clears the sample itself, while an unexpected loss for
      // a still-tracked pointer follows the abort path below.
      return;
    }
    if (mode === 'draw' || mode === 'resize' || mode === 'resize-object') {
      onPointerCancel(event);
      return;
    }
    onPointerUp(event);
  }

  function onPointerLeave(event: PointerEvent): void {
    deps.cursorPresenter?.leave(event.pointerId);
    if (lastCursorSample?.pointerId === event.pointerId)
      lastCursorSample = null;
  }

  function onWheel(event: WheelEvent): void {
    if (deps.isDestroyed() || !deps.cameraInteractive) return;
    if (deps.navigationMode === 'embedded') {
      // wheel split: ctrl/meta previews via the pager preview path
      // (debounce commit pager-side, never per-tick). preventDefault ONLY
      // for ctrl/meta — plain wheel stays native. Plain wheel forwards to
      // `onEmbeddedWheel` (gutter parity: preserve an open preview, cancel
      // synthetic motion only when no preview owns it) — never
      // `onEmbeddedCancel`, which is the true-abort path and would discard
      // an active preview.
      if (
        (event.ctrlKey || event.metaKey) &&
        deps.onEmbeddedZoom !== undefined
      ) {
        event.preventDefault();
        const deltaY =
          typeof event.deltaY === 'number' && Number.isFinite(event.deltaY)
            ? event.deltaY
            : 0;
        deps.onEmbeddedZoom({
          factor: Math.exp(-deltaY * 0.002),
          point: viewPoint(event),
          translation: { x: 0, y: 0 },
          source: 'wheel',
        });
      } else if (!event.ctrlKey && !event.metaKey) {
        try {
          deps.onEmbeddedWheel?.();
        } catch {
          // Native scroll must never break on a forwarding throw.
        }
      }
      return;
    }
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      // Elastic presentation with a hard logical limit. The settled target
      // is anchored independently from the overshoot camera; repeated
      // outward ticks at a saturated target are complete no-ops.
      const rawDeltaY = event.deltaY;
      if (typeof rawDeltaY !== 'number' || !Number.isFinite(rawDeltaY)) return;
      if (rawDeltaY === 0) return;
      const anchor = viewPoint(event);
      if (!Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) return;
      const factor = Math.exp(-rawDeltaY * 0.002);
      if (!Number.isFinite(factor) || factor <= 0) return;
      const current = deps.controller.camera();
      if (
        !Number.isFinite(current.x) ||
        !Number.isFinite(current.y) ||
        !Number.isFinite(current.zoom) ||
        current.zoom <= 0
      ) {
        return;
      }
      const logicalCurrent =
        navigationAnimation?.kind === 'spring'
          ? navigationAnimation.target
          : current;
      const requestedZoom = logicalCurrent.zoom * factor;
      if (!Number.isFinite(requestedZoom) || requestedZoom <= 0) return;
      const effectiveZoom = clampZoom(requestedZoom);
      deps.setUserNavigated(true);
      if (effectiveZoom === logicalCurrent.zoom) return;
      discardNavigationAnimation();
      const visualZoom = elasticZoom(
        requestedZoom,
        MIN_ZOOM,
        MAX_ZOOM,
      ).visualZoom;
      const transient = transientCamera(
        zoomCameraAroundPointUnclamped(logicalCurrent, visualZoom, anchor),
      );
      const target = deps.clampToSheet(
        zoomCameraAroundPointUnclamped(logicalCurrent, effectiveZoom, anchor),
      );
      if (prefersReducedMotion()) {
        if (!sameCamera(current, target)) publishCamera(target);
        deps.scheduleRender();
        return;
      }
      publishCamera(transient);
      const timeMs = typeof event.timeStamp === 'number' ? event.timeStamp : 0;
      beginSpring({ x: 0, y: 0 }, timeMs, false, target);
      deps.scheduleRender();
    } else {
      // Finite-guard plain-wheel deltas like the embedded
      // ctrl-wheel path above — non-finite deltas are ignored so NaN can
      // never poison an infinite camera via panBy.
      const deltaX =
        typeof event.deltaX === 'number' && Number.isFinite(event.deltaX)
          ? event.deltaX
          : 0;
      const deltaY =
        typeof event.deltaY === 'number' && Number.isFinite(event.deltaY)
          ? event.deltaY
          : 0;
      if (deltaX === 0 && deltaY === 0) return;
      deps.setUserNavigated(true);
      // a plain-wheel pan during an active wheel-spring
      // must discard the armed settle first (keep camera, single
      // owner via `discardNavigationAnimation` — same helper as the touch-
      // down and wheel paths, never a direct null). Otherwise the stale
      // spring target (computed pre-pan) jumps the camera back on the next
      // `advanceNavigation` and swallows the pan.
      discardNavigationAnimation();
      deps.controller.panBy({ x: deltaX, y: deltaY });
      deps.controller.setCamera(deps.clampToSheet(deps.controller.camera()));
      deps.scheduleRender();
    }
  }

  function advanceNavigation(timeMs: number): boolean {
    // Read-only is an authoring permission, not a navigation availability
    // gate: release inertia / settle springs run identically in read-only
    // (ephemeral camera preview, zero dirty/history). Only detach/destroy
    // aborts without stepping; decay after detach never runs —
    // the single owner is the attached shared frame); mid-flight read-only
    // flips keep settling.
    const animation = navigationAnimation;
    if (animation === null || deps.isDestroyed() || !attached) {
      // Detached/destroyed teardown already settled via resetGestureState;
      // never step a stale animation (no double-drive, no second rAF).
      assertNavigationInvariant('advanceNavigation:detached');
      navigationAnimation = null;
      return false;
    }
    assertNavigationInvariant('advanceNavigation:step');
    const safeTime = Number.isFinite(timeMs)
      ? Math.max(timeMs, animation.lastTimeMs)
      : animation.lastTimeMs;
    const deltaTimeMs = safeTime - animation.lastTimeMs;
    if (deltaTimeMs <= 0) return true;

    if (animation.kind === 'decay') {
      const next = stepDecay(animation.velocity, deltaTimeMs);
      const current = deps.controller.camera();
      const raw = {
        ...current,
        x: current.x + next.displacement.x / current.zoom,
        y: current.y + next.displacement.y / current.zoom,
      };
      const legal = deps.clampToSheet(raw);
      publishCamera(resistedCameraBeyondBounds(raw, legal));
      if (!sameCamera(raw, legal)) {
        return beginSpring(next.velocity, safeTime, true);
      }
      if (next.active) {
        navigationAnimation = {
          kind: 'decay',
          velocity: next.velocity,
          lastTimeMs: safeTime,
        };
        return true;
      }
      navigationAnimation = null;
      return beginSpring(next.velocity, safeTime);
    }

    const x = stepMotion(animation.x, deltaTimeMs);
    const y = stepMotion(animation.y, deltaTimeMs);
    const zoom = stepMotion(animation.zoom, deltaTimeMs);
    if (x.kind === 'idle' && y.kind === 'idle' && zoom.kind === 'idle') {
      publishCamera(animation.target);
      navigationAnimation = null;
      return false;
    }
    const nextZoom = Math.exp(zoom.value);
    publishCamera({
      x: x.value / animation.target.zoom,
      y: y.value / animation.target.zoom,
      zoom: Number.isFinite(nextZoom) ? nextZoom : animation.target.zoom,
    });
    navigationAnimation = {
      ...animation,
      x,
      y,
      zoom,
      lastTimeMs: safeTime,
    };
    return true;
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (deps.isDestroyed() || deps.isReadOnly()) return;
    const meta = event.metaKey || event.ctrlKey;
    if (meta && event.key.toLowerCase() === 'z') {
      // Exactly-once undo/redo: the pager root above also handles meta+z
      // by delegating to this same page history. Without stopping
      // propagation one keypress pops TWO entries (e.g. a drag revert plus
      // the previous stroke creation). Focus outside the surface never
      // reaches this listener, so the pager still covers chrome focus.
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) deps.requestRedo();
      else deps.requestUndo();
      return;
    }
    if (meta) return;
    if (
      (event.key === 'Delete' || event.key === 'Backspace') &&
      !deps.isTextOverlayOpen() &&
      !event.isComposing &&
      deps.controller.selection().length > 0 &&
      deps.requestDeleteSelection !== undefined
    ) {
      if (
        event.target instanceof Element &&
        event.target.closest('input, textarea, [contenteditable="true"]')
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      deps.requestDeleteSelection();
      return;
    }
    if (event.key === 'Enter') {
      // Enter-to-edit: a single selected text object opens
      // for edit with caret + OSK. The overlay itself stops propagation
      // for its own Enter handling, so this only fires when closed.
      // Never hijacks IME composition or an already-open editor.
      if (event.isComposing !== true && !deps.isTextOverlayOpen()) {
        try {
          if (deps.openTextOverlayAtSelection()) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
        } catch {
          // Enter-to-edit never breaks shortcuts.
        }
      }
    }
    if (deps.cameraInteractive && event.key === ' ') {
      spaceHeld = true;
      if (deps.cursorPresenter === undefined) deps.page.style.cursor = 'grab';
      refreshCursorPresentation();
      event.preventDefault();
      return;
    }
    const toolKeys: Record<string, string> = {
      v: SURFACE_TOOL_IDS.select,
      p: SURFACE_TOOL_IDS.pen,
      f: SURFACE_TOOL_IDS.fountain,
      b: SURFACE_TOOL_IDS.brush,
      n: SURFACE_TOOL_IDS.pencil,
      h: SURFACE_TOOL_IDS.highlighter,
      e: SURFACE_TOOL_IDS.eraser,
      l: SURFACE_TOOL_IDS.lasso,
      r: INK_TOOL_IDS.rect,
      o: INK_TOOL_IDS.ellipse,
      c: INK_TOOL_IDS.line,
      t: INK_TOOL_IDS.text,
    };
    const toolId = toolKeys[event.key.toLowerCase()];
    if (toolId !== undefined) deps.requestSetTool(toolId);
  }

  function onKeyUp(event: KeyboardEvent): void {
    if (event.key === ' ') {
      spaceHeld = false;
      if (deps.cursorPresenter === undefined) deps.page.style.cursor = '';
      refreshCursorPresentation();
    }
  }

  // Text-tool overlay state is owned by surface.ts via openTextOverlay dep;
  // hover cursor + badge affordances above are the only DOM writes here
  // besides panning chrome (all engine-exempt ephemeral state).

  /**
   * Double-click-to-edit: select/text tools only, so pen
   * double-taps never hijack into text. Routes through the same
   * hit-test→edit path as tap; empty-space double-click with the text
   * tool re-opens create (empty commits are no-ops).
   */
  function onDoubleClick(event: MouseEvent): void {
    if (deps.isDestroyed() || deps.isReadOnly()) return;
    if (deps.isTextOverlayOpen()) return;
    const tool = deps.getActiveToolId();
    if (tool !== SURFACE_TOOL_IDS.select && tool !== INK_TOOL_IDS.text) {
      return;
    }
    try {
      const view = viewPoint(event);
      const point = viewToSurface(deps.controller.camera(), view);
      if (
        tool === SURFACE_TOOL_IDS.select &&
        deps.controller.hitTest?.(point) == null
      )
        return;
      deps.openTextOverlay(point);
    } catch {
      // Double-click-to-edit never breaks pointer handling.
    }
  }

  // Key handlers are exposed so the orchestrator wires them to the React-owned
  // root; all gesture state stays inside this controller.
  let boundRoot: HTMLElement | null = null;
  const onViewportChange = (): void => refreshCursorPresentation();
  const onWindowBlur = (): void => {
    touchTap = null;
    lastCursorSample = null;
    deps.cursorPresenter?.reset();
    spaceHeld = false;
    if (mode !== 'idle' || pointers.size > 0) resetGestureState();
  };
  const onVisibilityChange = (): void => {
    if (document.visibilityState !== 'visible') onWindowBlur();
  };
  const editableKeyTarget = (target: EventTarget | null): boolean => {
    if (!(target instanceof HTMLElement)) return false;
    return (
      target.isContentEditable ||
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement
    );
  };
  const ownsDocumentSpace = (): boolean => {
    const active = document.activeElement;
    return (
      lastCursorSample !== null ||
      (boundRoot !== null &&
        active instanceof Node &&
        boundRoot.contains(active))
    );
  };
  const onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (
      event.key !== ' ' ||
      editableKeyTarget(event.target) ||
      (boundRoot !== null &&
        event.target instanceof Node &&
        boundRoot.contains(event.target)) ||
      !ownsDocumentSpace()
    )
      return;
    onKeyDown(event);
  };
  const onDocumentKeyUp = (event: KeyboardEvent): void => {
    if (event.key !== ' ' || !spaceHeld) return;
    onKeyUp(event);
  };
  // WebKit can show its loupe even on a non-selectable canvas. This surface
  // and its Notebook pager own navigation via Pointer Events, so cancelling
  // native touch selection does not take scrolling away from the app.
  const onTouchStart = (event: TouchEvent): void => {
    if (event.cancelable) event.preventDefault();
  };

  return {
    attach(root: HTMLElement) {
      if (attached) return;
      attached = true;
      boundRoot = root;
      deps.canvas.addEventListener('pointerdown', onPointerDown);
      deps.canvas.addEventListener('touchstart', onTouchStart, {
        passive: false,
      });
      deps.canvas.addEventListener('pointermove', onPointerMove);
      deps.canvas.addEventListener('pointerleave', onPointerLeave);
      if (supportsRawUpdate()) {
        deps.canvas.addEventListener('pointerrawupdate', onRawUpdateEvent);
      }
      deps.canvas.addEventListener('pointerup', onPointerUp);
      deps.canvas.addEventListener('pointercancel', onPointerCancel);
      deps.canvas.addEventListener('lostpointercapture', onLostPointerCapture);
      deps.canvas.addEventListener('wheel', onWheel, { passive: false });
      deps.canvas.addEventListener('dblclick', onDoubleClick);
      root.addEventListener('keydown', onKeyDown);
      root.addEventListener('keyup', onKeyUp);
      document.addEventListener('keydown', onDocumentKeyDown);
      document.addEventListener('keyup', onDocumentKeyUp);
      document.addEventListener('pointerdown', trackTouchTap, true);
      document.addEventListener('pointermove', trackTouchTap, true);
      document.addEventListener('pointercancel', trackTouchTap, true);
      document.addEventListener('pointerup', onDocumentTouchUp, true);
      window.addEventListener('blur', onWindowBlur);
      window.addEventListener('resize', onViewportChange);
      window.addEventListener('scroll', onViewportChange, true);
      document.addEventListener('visibilitychange', onVisibilityChange);
    },
    detach() {
      if (!attached) return;
      attached = false;
      deps.canvas.removeEventListener('pointerdown', onPointerDown);
      deps.canvas.removeEventListener('touchstart', onTouchStart);
      deps.canvas.removeEventListener('pointermove', onPointerMove);
      deps.canvas.removeEventListener('pointerleave', onPointerLeave);
      deps.canvas.removeEventListener('pointerrawupdate', onRawUpdateEvent);
      deps.canvas.removeEventListener('pointerup', onPointerUp);
      deps.canvas.removeEventListener('pointercancel', onPointerCancel);
      deps.canvas.removeEventListener(
        'lostpointercapture',
        onLostPointerCapture,
      );
      deps.canvas.removeEventListener('wheel', onWheel);
      deps.canvas.removeEventListener('dblclick', onDoubleClick);
      boundRoot?.removeEventListener('keydown', onKeyDown);
      boundRoot?.removeEventListener('keyup', onKeyUp);
      document.removeEventListener('keydown', onDocumentKeyDown);
      document.removeEventListener('keyup', onDocumentKeyUp);
      document.removeEventListener('pointerdown', trackTouchTap, true);
      document.removeEventListener('pointermove', trackTouchTap, true);
      document.removeEventListener('pointercancel', trackTouchTap, true);
      document.removeEventListener('pointerup', onDocumentTouchUp, true);
      window.removeEventListener('blur', onWindowBlur);
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      boundRoot = null;
      // Unmounting mid-gesture (notebook page transition, surface
      // teardown) must not wedge the next gesture on re-attach: in-flight
      // pointer tracks belong to a dead canvas, so drop them exactly like
      // a read-only reset instead of leaving a stuck draw/pan mode behind.
      // single teardown owner is resetGestureState (settles via
      // cancelNavigationAnimation(true), forwards Cancel once for embedded,
      // clears panning chrome). Post-conditions: hasTransient false,
      // advanceNavigation false, 0 owned frames (shared rAF lives in
      // surface.ts only — this controller never schedules its own).
      resetGestureState();
      assertNavigationInvariant('detach');
    },
    claimTouchInteraction,
    cancelTouchInteraction,
    resetForReadOnly() {
      resetGestureState(true);
    },
    flushPendingInput() {
      // Single-rAF invariant: draining never schedules another frame.
      if (deps.isDestroyed()) return;
      flushCoalescedInputWithoutScheduling();
    },
    flushPendingInputWithoutSchedulingRender() {
      if (deps.isDestroyed()) return;
      flushCoalescedInputWithoutScheduling();
    },
    hasPendingInput() {
      return drawCoalescer.hasPending();
    },
    advanceNavigation,
    hasTransientNavigation() {
      // detached/destroyed owns no transient — single owner is
      // the attached live controller (shared render frame in surface.ts).
      if (!attached || deps.isDestroyed()) return false;
      return (
        mode === 'pinch' ||
        (mode === 'pan' && panTouch) ||
        navigationAnimation !== null
      );
    },
    refreshCursor() {
      refreshCursorPresentation();
    },
    transportStats(): PointerTransportStats {
      return { ...transportCounters };
    },
    onKeyDown,
    onKeyUp,
    debugState() {
      return {
        mode,
        pointers: [...pointers.entries()].map(([id, p]) => ({
          id,
          x: p.x,
          y: p.y,
        })),
      };
    },
  };
}
