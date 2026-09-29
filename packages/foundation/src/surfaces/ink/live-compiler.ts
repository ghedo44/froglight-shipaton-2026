/**
 * Incremental live-stroke geometry compiler over the continuous
 * smooth-stroke pipeline.
 *
 * The full `compileInkStroke()` pipeline is O(n) per call, so invoking it
 * for every confirmed input batch is O(n²) over a long stroke. This module
 * owns the Froglight incremental path used by live preview gestures:
 *
 * - confirmed samples append incrementally through retained stage state
 *   (cleanup tail, capture-stream stabilization EMA, pressure prefilter,
 *   arc-length grid carry, control history, incremental curve builder):
 *   only new work plus a fixed tail window is recomputed — append cost is
 *   O(new + tail), never O(history);
 * - B-spline locality is what makes the tail exact: a span reads 4
 *   controls and corner detection reads ±3, so only the last few spans
 *   can observe an append (corner flags for the frozen prefix never
 *   change — their full window is historic). The frozen head is
 *   position-exact, not approximately right;
 * - predicted samples continue the ACTUAL live frontier statefully: a
 *   bounded tail snapshot (sanitation anchor, pressure prefilter,
 *   resample grid carry, stabilizer EMA, working tails, builder tail)
 *   runs the same incremental stage composition in scratch space, so no
 *   filter/grid/fairing restarts and no seam where prediction joins the
 *   confirmed stroke. The published tail is continuation-only (flush butt
 *   seam under the live tip cap) — confirmed context is never repainted,
 *   so translucent tools cannot double-paint history. O(1) per predicted
 *   event, never retained;
 * - confirming over a prediction discards the prediction without
 *   perturbing earlier confirmed geometry (the confirmed pipeline never
 *   observes predicted samples);
 * - `finish()` runs one clean full `compileInkStroke()` pass, so committed
 *   geometry matches a fresh compile exactly (zero tolerance gap);
 * - one stroke, one brush: `begin()` snapshots the resolved brush and the
 *   whole gesture runs under it — no mid-gesture updates, so the commit
 *   can never reshape what the preview drew (see `brush()`);
 * - DOM-free, persistence-free, no per-sample array copies in the hot path.
 *
 * Approximation contract (preview only, resolved exactly at `finish()`):
 * taper zones are nib-relative and capped (`TAPER_ZONE_CAP_SIZE_MULTIPLE`),
 * and the tail splice refreshes every span within the refresh horizon, so
 * live widths converge to commit widths everywhere outside a bounded
 * transient tip region. Arc truth is shared, not approximate: taper
 * resolves from the builder-owned cumulative/total arc of the actual
 * faired controls (`InkCurveBuilder.controlArcLengths()/controlTotal()`),
 * the identical coordinate system the committed compiler uses — batch and
 * live never mix a faired numerator with a pre-fair denominator.
 * Velocity-derived pressure (`velocityPressure` with no hardware pressure)
 * uses the same causal physical speed response on the dense cleaned stream
 * in live and full compilation. Its time-based EMA is batching- and
 * device-frequency-independent, so frozen widths never need global
 * renormalization when later speed extrema arrive.
 *
 * Per-batch publish note: `append()` returns a chunk view over retained
 * mesh state (frozen head refs + bounded mutable tail, epoch-guarded) —
 * never a materialized ring. Publishing costs O(new + tail) with zero
 * history-sized copies; a complete polygon is assembled only by the
 * explicit snapshot APIs (`geometry()`, `liveOutline()`), which increment
 * `ringMaterializations` so the structural gate can pin the hot path.
 * What never happens per batch is a historic re-fit or a full-ring copy.
 */

import type { Bounds, Point } from '../geometry.js';
import type { InkSample } from '../model.js';
import type { InkBrushSpec } from './brush.js';
import { boundsOfPoints } from './bounds.js';
import {
  compileInkStroke,
  type CompiledInkStroke,
  type InkStrokeNode,
} from './compiler.js';
import {
  filterPressureObservation,
  initialPressureFilterCarry,
  NEUTRAL_PRESSURE,
  normalizeTaperZones,
  resolveUntaperedWidth,
  resolveWidth,
  TAPER_ZONE_CAP_SIZE_MULTIPLE,
  type PressureFilterCarry,
} from './curve-attributes.js';
import {
  InkCurveBuilder,
  type InkCurve,
  type InkCurveControl,
} from './curve.js';
import {
  CORNER_EVIDENCE_SPACING,
  hasSourceCornerEvidence,
} from './corner-evidence.js';
import {
  buildStrokeMesh,
  CAP_SEGMENTS,
  emptyStrokeMesh,
  roundCapFan,
} from './outline.js';
import {
  appendResampled,
  defaultControlSpacing,
  initialResampleCarry,
  type ResampleCarry,
} from './resample.js';
import {
  initialStabilizerCarry,
  fairControlPolygon,
  stabilizeOne,
  type StabilizerCarry,
} from './stabilization.js';
import {
  sameWorkingSample,
  toWorkingSample,
  type WorkingSample,
} from './samples.js';
import { tessellateCurve, type TessellatedSpinePoint } from './tessellation.js';
import type { LiveStrokeMeshView } from '../draw.js';

/**
 * Tail window (control points) recomputed per append. Covers the fairing
 * neighborhood (±2), the B-spline stencil (±2 with corner lookahead), the
 * curve builder's refit horizon, and pressure-EMA settling with margin.
 * Fixed bound ⇒ append geometry work is O(new + tail), never O(history).
 */
export const LIVE_COMPILER_TAIL_WINDOW = 24;

/**
 * Span refresh horizon for tail tessellation splicing. Every append
 * re-tessellates all still-unpublished spans plus this many trailing
 * published spans (mutable tail: corner flicker, fairing settling, and
 * live-total taper widths). Crucially the horizon is measured back from
 * the published frontier — never a fixed offset from the stroke end — so
 * large per-append batches cannot strand whole span ranges untessellated
 * (the pre-fix fixed `segCount - 30` slice dropped spans whenever one
 * append added more than 30, punching holes in long-stroke previews).
 * Covers the taper cap zone (~23 spans at any brush size) with margin;
 * bounded ⇒ append work stays O(new + horizon).
 */
export const LIVE_TAIL_REFRESH_SPANS = 72;

/**
 * Tail controls snapshotted for a prediction scratch builder AND its
 * working tails (resampled/stabilized). ONE shared length with a shared
 * global base is load-bearing: the fair-slice pop/push composition
 * assumes builder and working arrays run in parallel coordinates exactly
 * like the live path. Covers the B-spline stencil (±2), corner detection
 * (±3 with persistence), fairing (±2 per pass) and tessellation span
 * coverage with margin — tip spans always see complete local context.
 * Bounded ⇒ prediction work is O(1) per event regardless of stroke
 * length.
 */
export const LIVE_PREDICT_SNAPSHOT_TAIL = 24;
/** Defensive cap on predicted samples processed per call (bounded work). */
export const LIVE_PREDICT_MAX_SAMPLES = 64;

/** Deterministic operation counters for performance regression tests.
 *  `fullCompiles` counts clean full-pipeline runs; `tailUpdates` counts
 *  incremental appends. An O(n²) implementation shows fullCompiles ∝
 *  batches; the incremental path shows fullCompiles ≤ 2 per gesture.
 *  `ringMaterializations` counts full-history ring builds (explicit
 *  snapshot APIs only — never the per-batch publish path); the structural
 *  gate asserts it stays bounded while batches scale. */
export interface LiveCompilerStats {
  fullCompiles: number;
  tailUpdates: number;
  predictedCompiles: number;
  /**
   * Head start-zone taper refreshes (bounded width-only updates; see
   * `#refreshHeadTaperWidths`). Cumulative nodes refreshed live in
   * `headWidthNodes`.
   */
  headWidthRefreshes: number;
  headWidthNodes: number;
  /** Confirmed samples appended (cumulative input size). */
  samplesAppended: number;
  /** Curve spans re-tessellated across all tail rebuilds (tail work). */
  tailSpansRetessellated: number;
  /** Frozen-head stability epoch invalidations (cache drops). */
  meshEpochInvalidations: number;
  /**
   * Full-history ring materializations (`geometry()`/`liveOutline()`).
   * Per-batch publishes never increment this — see `LiveInkPreviewUpdate`.
   */
  ringMaterializations: number;
}

const stats: LiveCompilerStats = {
  fullCompiles: 0,
  tailUpdates: 0,
  predictedCompiles: 0,
  headWidthRefreshes: 0,
  headWidthNodes: 0,
  samplesAppended: 0,
  tailSpansRetessellated: 0,
  meshEpochInvalidations: 0,
  ringMaterializations: 0,
};

/** Live counters (mutated in place; snapshot via `liveCompilerStats()`). */
export function liveCompilerCounters(): LiveCompilerStats {
  return stats;
}

/** Snapshot the current counters without resetting. */
export function liveCompilerStats(): LiveCompilerStats {
  return { ...stats };
}

/** Reset counters (tests/benchmarks). */
export function resetLiveCompilerStats(): void {
  stats.fullCompiles = 0;
  stats.tailUpdates = 0;
  stats.predictedCompiles = 0;
  stats.headWidthRefreshes = 0;
  stats.headWidthNodes = 0;
  stats.samplesAppended = 0;
  stats.tailSpansRetessellated = 0;
  stats.meshEpochInvalidations = 0;
  stats.ringMaterializations = 0;
}

/** Incremental geometry delta published per append (plain data). */
export interface LiveInkGeometryUpdate {
  /** Current confirmed outline ring (smooth continuous mesh). */
  readonly polygon: readonly Point[];
  /** AABB of the polygon. */
  readonly bounds: Bounds;
  /** Tessellated spine vertex count behind the polygon. */
  readonly nodeCount: number;
  /** True when the tail window covered the whole stroke (exact). */
  readonly exact: boolean;
}

/**
 * Lightweight per-batch publish (plain data, no history-sized copies).
 * `append()` returns this instead of a materialized ring: the mesh view
 * references retained compiler state (epoch-guarded, see
 * `LiveStrokeMeshView`), so per-batch publish work is O(new + bounded
 * tail). A complete polygon is materialized only through the explicit
 * snapshot APIs (`geometry()`, `liveOutline()`), which increment
 * `ringMaterializations`.
 */
export interface LiveInkPreviewUpdate {
  /** AABB of the live stroke. */
  readonly bounds: Bounds;
  /** Tessellated spine vertex count. */
  readonly nodeCount: number;
  /** True when the tail window covered the whole stroke (exact). */
  readonly exact: boolean;
  /** Publish version (bumps per geometry-recomputing append). */
  readonly version: number;
  /**
   * Chunk view for strokes with ≥2 spine nodes (live refs, no copy).
   * Null for dots/empty strokes — see `ring`.
   */
  readonly mesh: LiveStrokeMeshView | null;
  /**
   * Materialized ring for dots/empty strokes only (bounded O(1) points).
   * Null whenever `mesh` is present.
   */
  readonly ring: readonly Point[] | null;
}

/**
 * Ephemeral predicted tail as MUTABLE-TAIL REPLACEMENT (never canonical
 * geometry, never history). Carries the revised mutable tail plus the new
 * continuation past the frontier — future samples can reshape the existing
 * mutable tail for an approximating B-spline, so appending past the tip
 * alone would leave a stale tail visible. The renderer draws the stable
 * confirmed head (indices below `replaceFromSpineIndex`) plus this
 * replacement tail, suppressing the old mutable tail (no double-paint
 * under translucent tools). Bounded size (snapshot tail + capped
 * predictions), O(1) per event, never retained.
 */
export interface PredictedTailUpdate {
  /** Replacement-tail ring (butt seam at the head boundary, live cap at tip). */
  readonly polygon: readonly Point[];
  /** AABB of the replacement ring. */
  readonly bounds: Bounds;
  /** Replacement spine node count (seam anchor + revised tail + predicted). */
  readonly nodeCount: number;
  /**
   * Replacement spine nodes (seam anchor + revised tail + predicted,
   * bounded). Positions/widths twin-match the tail that confirming the
   * predicted samples would produce — the structural proof of state
   * continuation, including mutable-tail revision (see the A/B parity
   * test).
   */
  readonly nodes: readonly InkStrokeNode[];
  /** Live frontier position at prediction time (diagnostics only). */
  readonly frontier: Point;
  /** Live publish version continued (diagnostics/stale checks). */
  readonly baseVersion: number;
  /**
   * Explicit seam: confirmed spine index where replacement starts.
   * Renderer draws confirmed head [0, replaceFromSpineIndex) plus
   * `nodes`/`polygon`; old mutable tail at/after this index is
   * suppressed (replaced, never repainted).
   */
  readonly replaceFromSpineIndex: number;
  /** Global control-arc at the seam (arc-based equivalent of the index). */
  readonly replaceFromArc: number;
  /**
   * Alias for `nodes` (explicit name for the replacement-tail contract).
   * Same array, never a copy — read-only view.
   */
  readonly replacementTail: readonly InkStrokeNode[];
}

/**
 * Froglight-owned incremental live-stroke compiler. One instance per
 * active gesture; confirmed and predicted paths share nothing mutable.
 */
export class LiveInkStrokeCompiler {
  #brush: InkBrushSpec | null = null;
  #spacing = 0;
  #cap: 'round' | 'butt' = 'round';
  /** Minimal sanitation: exact duplicates only (see samples.ts). */
  #minDistance = 0;
  #confirmed: InkSample[] = [];
  #cleaned: WorkingSample[] = [];
  /** Fine, brush-independent arc grid used only to validate hard corners. */
  #cornerSource: WorkingSample[] = [];
  #cornerResample: ResampleCarry = initialResampleCarry();
  #stabilizer: StabilizerCarry = initialStabilizerCarry(0);
  #resample: ResampleCarry = initialResampleCarry();
  /** Pressure-filtered cleaned samples (full history, parallel to #cleaned). */
  #pressured: WorkingSample[] = [];
  /** Pressure EMA over the cleaned stream (retained). */
  #prefilter: PressureFilterCarry = initialPressureFilterCarry();
  /** Resampled controls (full history; provisional tip included). */
  #controls: WorkingSample[] = [];
  /** Post-resample stabilized controls (full history, parallel to #controls). */
  #stabilizedFull: WorkingSample[] = [];
  /** Incremental fitted centerline over faired controls (full history). */
  #builder = new InkCurveBuilder();
  /** Tessellated spine (frozen head + recomputed tail). */
  #spine: TessellatedSpinePoint[] = [];
  /**
   * Builder-absolute span count reflected in #spine. The tail splice
   * re-tessellates from here (minus refresh horizon), so per-append
   * growth of any size stays fully covered — never stranded.
   */
  #publishedSpans = 0;
  /**
   * Spine-index frontier with valid mesh sides (#left/#right/#fans).
   * The mesh rebuild heals everything from here, so unbounded per-append
   * growth can never strand side ranges behind a fixed tail horizon.
   */
  #meshedUpTo = 0;
  /**
   * First side index the last mesh rebuild may have rewritten (entries
   * below are retained verbatim). The bounds scan covers from here, so
   * splice-aligned rebuilds on large batches — which reach far deeper
   * than the fixed tail scan window — can never strand rewritten sides
   * outside the scanned range (under-covering cull bounds).
   */
  #meshScanFloor = 0;
  #left: Point[] = [];
  #right: Point[] = [];
  #leftFans = new Map<number, Point[]>();
  #rightFans = new Map<number, Point[]>();
  #startFan: Point[] = [];
  #endFan: Point[] = [];
  #bounds: Bounds = { x: 0, y: 0, width: 0, height: 0 };
  #confirmedCount = 0;
  #started = false;
  /**
   * Publish version (bumps per geometry-recomputing append; duplicate-only
   * appends reuse the version so paints replay backend caches).
   */
  #publishVersion = 0;
  /**
   * Frozen-head stability epoch (bumps when entries below #frozenSpine
   * are rewritten — corner finalization inside the refresh horizon or a
   * settled start-zone width refresh — so backends drop cached head
   * geometry).
   */
  #meshEpoch = 0;
  /**
   * Count of leading stable spine nodes. Indices below this in
   * #left/#right (and fans keyed below it) are never rewritten while the
   * epoch is constant; the mutable tail starts here.
   */
  #frozenSpine = 0;

  /** Begin a gesture with its first confirmed sample and resolved brush. */
  begin(sample: InkSample, brush: InkBrushSpec): void {
    this.reset();
    this.#brush = brush;
    this.#spacing = defaultControlSpacing(brush.size);
    this.#cap = brush.tip.cap ?? 'round';
    this.#stabilizer = initialStabilizerCarry(brush.stabilization);
    this.#builder.setCornerEvidence((controlIndex) =>
      hasSourceCornerEvidence(
        this.#cornerSource,
        this.#cornerResample.prevArc,
        controlIndex,
        this.#spacing,
      ),
    );
    this.#started = true;
    this.append([sample]);
  }

  /**
   * Append confirmed samples incrementally. Returns a lightweight publish
   * (chunk view, no history-sized copies); the head stays frozen, the
   * tail window is recomputed. Per-batch work is O(new + bounded tail).
   */
  append(samples: readonly InkSample[]): LiveInkPreviewUpdate {
    if (!this.#started || this.#brush === null) {
      return {
        bounds: { x: 0, y: 0, width: 0, height: 0 },
        nodeCount: 0,
        exact: true,
        version: this.#publishVersion,
        mesh: null,
        ring: [],
      };
    }
    for (const s of samples) this.#confirmed.push({ ...s });
    this.#confirmedCount += samples.length;
    stats.samplesAppended += samples.length;
    stats.tailUpdates += 1;
    // Sanitation is incremental: each sample compares against the last
    // kept one (O(1)), exactly like the batch pass over the same stream.
    let addedClean = 0;
    let lastKept = this.#cleaned[this.#cleaned.length - 1];
    const freshClean: WorkingSample[] = [];
    for (let i = 0; i < samples.length; i++) {
      const w = toWorkingSample(samples[i]!);
      if (w === null) continue;
      if (lastKept !== undefined && sameWorkingSample(lastKept, w)) continue;
      if (
        lastKept !== undefined &&
        Math.hypot(w.x - lastKept.x, w.y - lastKept.y) < this.#minDistance
      ) {
        continue;
      }
      this.#cleaned.push(w);
      freshClean.push(w);
      lastKept = w;
      addedClean++;
    }
    if (addedClean === 0) return this.#publishPreview();
    appendResampled(
      this.#cornerResample,
      freshClean,
      CORNER_EVIDENCE_SPACING,
      this.#cornerSource,
    );
    // Pressure resolves on the dense cleaned stream. Hardware axes use the
    // established jitter EMA; missing axes on velocity brushes use the
    // same causal speed response/time EMA as the full compiler. Both are
    // batch-invariant and exact here, before resampling.
    const brush = this.#brush;
    const freshPressured: WorkingSample[] = [];
    for (const w of freshClean) {
      const pressureIndex = this.#pressured.length;
      const filtered = filterPressureObservation(
        this.#prefilter,
        w.pressure,
        this.#cleaned[pressureIndex - 1] ?? null,
        w,
        brush,
      );
      const copy: WorkingSample = {
        ...w,
        pressure: filtered,
        extras: { ...w.extras },
      };
      this.#pressured.push(copy);
      freshPressured.push(copy);
    }
    // Resample onto the absolute grid (at most one provisional pop, then
    // pushes). The stabilized mirror pops alongside below.
    const { popped } = appendResampled(
      this.#resample,
      freshPressured,
      this.#spacing,
      this.#controls,
    );
    // Stabilize the newly pushed controls through retained EMA state
    // (O(new), exact). Tip lag stays a fraction of one grid step; the
    // provisional pop truncates the mirror.
    if (popped === 1) {
      this.#stabilizedFull.pop();
      const tail = this.#stabilizedFull[this.#stabilizedFull.length - 1];
      if (tail === undefined) {
        this.#stabilizer = initialStabilizerCarry(brush.stabilization);
      } else {
        this.#stabilizer.x = tail.x;
        this.#stabilizer.y = tail.y;
        this.#stabilizer.started = true;
      }
    }
    const newStart = this.#stabilizedFull.length;
    for (let i = newStart; i < this.#controls.length; i++) {
      this.#stabilizedFull.push(
        stabilizeOne(this.#stabilizer, this.#controls[i]!),
      );
    }
    this.#rebuildTail(brush);
    return this.#publishPreview();
  }

  /**
   * Lightweight publish for the hot path: chunk view over retained mesh
   * state, no history-sized copies. Dots (and empty strokes) materialize
   * their tiny ring inline (bounded O(1)).
   */
  #publishPreview(): LiveInkPreviewUpdate {
    const exact = this.#controls.length <= LIVE_COMPILER_TAIL_WINDOW;
    if (this.#spine.length >= 2) {
      return {
        bounds: { ...this.#bounds },
        nodeCount: this.#spine.length,
        exact,
        version: this.#publishVersion,
        mesh: this.#meshView(),
        ring: null,
      };
    }
    return {
      bounds: { ...this.#bounds },
      nodeCount: this.#spine.length,
      exact,
      version: this.#publishVersion,
      mesh: null,
      ring: this.#assembleRing(),
    };
  }

  /** Chunk view over retained mesh state (live refs, epoch-guarded). */
  #meshView(): LiveStrokeMeshView {
    return {
      version: this.#publishVersion,
      epoch: this.#meshEpoch,
      frozenSpine: this.#frozenSpine,
      spineLength: this.#spine.length,
      left: this.#left,
      right: this.#right,
      leftFans: this.#leftFans,
      rightFans: this.#rightFans,
      startCap: this.#startFan,
      endCap: this.#endFan,
      cap: this.#cap,
    };
  }

  /**
   * Ephemeral predicted tail continuing the ACTUAL live state. A bounded
   * tail snapshot (sanitation anchor, pressure prefilter, resample grid
   * carry, stabilizer EMA, working tails, builder tail) is cloned into
   * scratch state and the predictions run through the same incremental
   * stage composition — resample grid phase, filter settling, fairing and
   * curve context are inherited at the frontier, never restarted — so the
   * continuation meets the confirmed stroke with no seam and pixel-matches
   * the tail that confirming those samples would produce.
   *
   * Returns the CONTINUATION ONLY (seam-anchored at the live frontier
   * with a flush butt start under the live tip cap): confirmed context is
   * never repainted, so translucent tools cannot double-paint history.
   * Confirmed pipeline state is never touched: predictions never enter
   * canonical samples, never mark dirty, never persist, and confirming
   * over them reproduces the prediction-free result exactly. O(1) per
   * call regardless of stroke length (bounded snapshot + capped input).
   */
  appendPredicted(samples: readonly InkSample[]): PredictedTailUpdate {
    const brush = this.#brush;
    const tip = this.#spine[this.#spine.length - 1];
    if (!this.#started || brush === null || tip === undefined) {
      return {
        polygon: [],
        bounds: { x: 0, y: 0, width: 0, height: 0 },
        nodeCount: 0,
        nodes: [],
        frontier: { x: 0, y: 0 },
        baseVersion: this.#publishVersion,
        replaceFromSpineIndex: 0,
        replaceFromArc: 0,
        replacementTail: [],
      };
    }
    stats.predictedCompiles += 1;
    const frontier: Point = { x: tip.x, y: tip.y };
    const capped = samples.slice(0, LIVE_PREDICT_MAX_SAMPLES);
    if (capped.length === 0) {
      const seamNode = {
        x: tip.x,
        y: tip.y,
        width: tip.width,
        pressure: tip.pressure,
        tiltX: tip.tiltX,
        tiltY: tip.tiltY,
        twist: tip.twist,
        dt: tip.dt,
        extras: { ...tip.extras },
        segmentIndex: tip.segmentIndex,
        u: tip.u,
        controlArc: tip.controlArc,
      };
      return {
        polygon: [],
        bounds: { ...this.#bounds },
        nodeCount: 1,
        nodes: [seamNode],
        frontier,
        baseVersion: this.#publishVersion,
        replaceFromSpineIndex: this.#spine.length,
        replaceFromArc: tip.controlArc,
        replacementTail: [seamNode],
      };
    }
    return this.#predictContinuation(capped, brush, tip);
  }

  /**
   * Current confirmed mesh chunks without materialization (O(1)): the
   * predicted path republishes confirmed geometry with a suppressed tip
   * cap while a prediction is visible. Null before the stroke meshes.
   */
  confirmedMesh(): LiveStrokeMeshView | null {
    if (!this.#started || this.#brush === null || this.#spine.length < 2) {
      return null;
    }
    return this.#meshView();
  }

  /** Current confirmed bounds without materialization (O(1)). */
  confirmedBounds(): Bounds {
    return { ...this.#bounds };
  }

  #predictContinuation(
    samples: readonly InkSample[],
    brush: InkBrushSpec,
    tip: TessellatedSpinePoint,
  ): PredictedTailUpdate {
    const frontier: Point = { x: tip.x, y: tip.y };
    const liveTotal = this.#builder.controlTotal();
    const frozenSpine = this.#frozenSpine;
    const spineLength = this.#spine.length;
    const toNode = (p: TessellatedSpinePoint): InkStrokeNode => ({
      x: p.x,
      y: p.y,
      width: p.width,
      pressure: p.pressure,
      tiltX: p.tiltX,
      tiltY: p.tiltY,
      twist: p.twist,
      dt: p.dt,
      extras: { ...p.extras },
      segmentIndex: p.segmentIndex,
      u: p.u,
      controlArc: p.controlArc,
      ...(p.corner !== undefined ? { corner: { ...p.corner } } : {}),
    });
    const seamNode = toNode(tip);
    const seamOnly: PredictedTailUpdate = {
      polygon: [],
      bounds: { ...this.#bounds },
      nodeCount: 1,
      nodes: [seamNode],
      frontier,
      baseVersion: this.#publishVersion,
      replaceFromSpineIndex: spineLength,
      replaceFromArc: liveTotal,
      replacementTail: [seamNode],
    };
    // Bounded scratch state cloned from the live frontier (copies only —
    // live arrays and carries are never aliased).
    const lastKept = this.#cleaned[this.#cleaned.length - 1];
    const prefilter: PressureFilterCarry = { ...this.#prefilter };
    const resample: ResampleCarry = {
      ...this.#resample,
      prev:
        this.#resample.prev !== null
          ? {
              ...this.#resample.prev,
              extras: { ...this.#resample.prev.extras },
            }
          : null,
    };
    const cornerResample: ResampleCarry = {
      ...this.#cornerResample,
      prev:
        this.#cornerResample.prev !== null
          ? {
              ...this.#cornerResample.prev,
              extras: { ...this.#cornerResample.prev.extras },
            }
          : null,
    };
    const cloneWorking = (w: WorkingSample): WorkingSample => ({
      ...w,
      extras: { ...w.extras },
    });
    // 192 half-unit marks cover the 24-control prediction snapshot plus
    // both evidence radii at the maximum 3-unit production spacing.
    const cornerSourceStart = Math.max(0, this.#cornerSource.length - 192);
    const cornerSourceStartArc = cornerSourceStart * CORNER_EVIDENCE_SPACING;
    const cornerSource = this.#cornerSource
      .slice(cornerSourceStart)
      .map(cloneWorking);
    const stabilizer: StabilizerCarry = { ...this.#stabilizer };
    const controls = this.#controls
      .slice(-LIVE_PREDICT_SNAPSHOT_TAIL)
      .map(cloneWorking);
    const stabilized = this.#stabilizedFull
      .slice(-LIVE_PREDICT_SNAPSHOT_TAIL)
      .map(cloneWorking);
    // Sanitize predictions against the live anchor (same rules as the
    // confirmed path: invalid/exact-duplicate/min-distance only).
    let anchor = lastKept;
    const freshClean: WorkingSample[] = [];
    for (const sample of samples) {
      const w = toWorkingSample(sample);
      if (w === null) continue;
      if (anchor !== undefined && sameWorkingSample(anchor, w)) continue;
      if (
        anchor !== undefined &&
        Math.hypot(w.x - anchor.x, w.y - anchor.y) < this.#minDistance
      ) {
        continue;
      }
      freshClean.push(w);
      anchor = w;
    }
    if (freshClean.length === 0) return seamOnly;
    appendResampled(
      cornerResample,
      freshClean,
      CORNER_EVIDENCE_SPACING,
      cornerSource,
    );
    // Pressure continues the same dense-stream filter state as confirmed
    // input; prediction never restarts velocity or hardware smoothing.
    const freshPressured: WorkingSample[] = [];
    let pressurePrevious = lastKept ?? null;
    for (const w of freshClean) {
      const filtered = filterPressureObservation(
        prefilter,
        w.pressure,
        pressurePrevious,
        w,
        brush,
      );
      freshPressured.push({
        ...w,
        pressure: filtered,
        extras: { ...w.extras },
      });
      pressurePrevious = w;
    }
    // Resample onto the CONTINUED absolute grid (the carry holds the live
    // phase; the provisional pop lands inside scratch state).
    const { popped } = appendResampled(
      resample,
      freshPressured,
      this.#spacing,
      controls,
    );
    if (popped === 1) {
      stabilized.pop();
      const tail = stabilized[stabilized.length - 1];
      if (tail === undefined) {
        stabilizer.x = 0;
        stabilizer.y = 0;
        stabilizer.started = false;
      } else {
        stabilizer.x = tail.x;
        stabilizer.y = tail.y;
        stabilizer.started = true;
      }
    }
    // Stabilize every new grid mark through the continued EMA.
    const stabilizedBase = stabilized.length;
    for (let i = stabilizedBase; i < controls.length; i++) {
      stabilized.push(stabilizeOne(stabilizer, controls[i]!));
    }
    if (stabilized.length === 0) return seamOnly;
    // Scratch curve builder from the live builder tail with a GLOBAL arc
    // base, so rebased snapshots keep the live taper domain (widths come
    // out as-if-confirmed — no seam pinch, twin-identical subdivision).
    const snapshot = this.#builder.tailSnapshot(LIVE_PREDICT_SNAPSHOT_TAIL);
    if (snapshot.length === 0) return seamOnly;
    const cumView = this.#builder.controlArcLengths();
    const snapshotStart =
      cumView.length > snapshot.length ? cumView.length - snapshot.length : 0;
    const arcBase =
      cumView.length > snapshot.length
        ? cumView[cumView.length - snapshot.length]!
        : 0;
    const scratch = new InkCurveBuilder();
    scratch.setCornerEvidence((controlIndex) =>
      hasSourceCornerEvidence(
        cornerSource,
        cornerResample.prevArc,
        controlIndex,
        this.#spacing,
        cornerSourceStartArc,
      ),
    );
    scratch.reset(
      snapshot.map((s) => s.control),
      (i) => ({ ...snapshot[i]!.extras }),
      arcBase,
      snapshotStart,
    );
    // Fair the scratch tail with the same slice composition as the live
    // tail rebuild (bounded; slice math is self-consistent for any
    // total, so the scratch mirrors the confirmed path exactly).
    const total = stabilized.length;
    const rawTailStart = Math.max(0, total - LIVE_COMPILER_TAIL_WINDOW);
    const sliceStart = Math.max(0, rawTailStart - 2);
    const keepFaired = sliceStart > 0 ? sliceStart + 2 : 0;
    const held = scratch.controlCount;
    const popTo = Math.min(held >= 2 ? held - 2 : held, keepFaired);
    while (scratch.controlCount > popTo) {
      scratch.pop();
    }
    const needFrom = popTo;
    const sliceStart2 = Math.max(0, Math.min(sliceStart, needFrom - 2));
    const slice = stabilized.slice(sliceStart2);
    const faired = fairControlPolygon(slice, brush.streamline);
    const drop = needFrom - sliceStart2;
    const tailFaired = faired.slice(drop);
    const scratchExtras: Record<string, unknown>[] = snapshot.map((s) => ({
      ...s.extras,
    }));
    while (scratchExtras.length > scratch.controlCount) {
      scratchExtras.pop();
    }
    for (let i = 0; i < tailFaired.length; i++) {
      const s = tailFaired[i]!;
      scratch.push(
        {
          x: s.x,
          y: s.y,
          pressure: s.pressure ?? NEUTRAL_PRESSURE,
          tiltX: s.tiltX,
          tiltY: s.tiltY,
          twist: s.twist,
          dt: s.dt,
        },
        s.extras,
      );
      scratchExtras.push({ ...s.extras });
    }
    if (scratch.controlCount < 2) return seamOnly;
    // Tessellate the scratch tail with GLOBAL arcs and the as-if-confirmed
    // total: widths resolve in the live taper domain, so subdivision and
    // widths twin-match the tail that confirming would produce.
    const fresh = tessellateCurve(
      {
        segments: scratch.curve.segments,
        controlCount: scratch.controlCount,
        dot: null,
      },
      brush,
      scratch.controlArcLengths(),
      scratch.controlTotal(),
      {},
      0,
      (i) => scratchExtras[i],
    );
    // Mutable-tail replacement (not continuation-only): the scratch tail
    // covers the snapshot region plus predictions with GLOBAL arcs, so
    // fresh nodes near the tip revise what confirming would revise.
    // Future samples reshape only a bounded revision horizon back from
    // the tip (fairing ±2, B-spline stencil ±2, corner window ±3 plus
    // persistence — well under 8 controls); the snapshot's oldest ~8
    // controls are beyond that horizon AND use start-clamped knots in
    // the scratch (vs uniform in the full history), so they must stay
    // with the head. The seam therefore starts 8 controls after the
    // snapshot start (or at the stroke start for tiny strokes): head is
    // stable, replacement is revised tail + continuation, both bounded.
    // This keeps twin-identical subdivision (uniform knots on both sides)
    // and bounds replacement work to O(tail).
    const SKIP_PREFIX_CONTROLS = 8;
    const seamControlIndex = Math.min(
      cumView.length - 1,
      snapshotStart + SKIP_PREFIX_CONTROLS,
    );
    const replaceArc =
      cumView.length > 0 ? cumView[Math.max(0, seamControlIndex)]! : arcBase;
    // Live seam index: first spine node at/after the snapshot arc.
    // Head is [0, replaceFrom); replacement starts with the last head
    // node as seam anchor (exact, no gap) followed by revised tail.
    let replaceFrom = spineLength;
    for (let i = 0; i < this.#spine.length; i++) {
      if (this.#spine[i]!.controlArc >= replaceArc - 1e-6) {
        replaceFrom = i;
        break;
      }
    }
    // Never revise the frozen head: clamp the seam at/after it (the
    // snapshot always covers the mutable tail, so this is a no-op in
    // practice — defense-in-depth for short strokes where frozen==0).
    if (replaceFrom < frozenSpine) replaceFrom = frozenSpine;
    // Clamp the seam into the mutable tail (never into the frozen head
    // beyond what the snapshot covers): replacement must stay bounded.
    // When the snapshot covers only the tip, replaceFrom lands in the
    // tail; when the stroke is short, it lands at 0 (full replacement
    // of a tiny stroke is still bounded).
    const seamAnchor: TessellatedSpinePoint =
      replaceFrom > 0 && replaceFrom < this.#spine.length
        ? {
            ...this.#spine[replaceFrom - 1]!,
            extras: { ...this.#spine[replaceFrom - 1]!.extras },
          }
        : { ...tip, extras: { ...tip.extras } };
    // Revised tail: every fresh node at/after the seam arc (covers the
    // stale mutable region plus the predicted continuation). Bounded:
    // snapshot tail (≤24 controls) + capped predictions (≤64 samples).
    const revised = fresh.filter((p) => p.controlArc >= replaceArc - 1e-6);
    if (revised.length === 0) return seamOnly;
    // Drop a duplicated seam node when the scratch starts exactly at the
    // anchor arc (shared edge, not overlapping area).
    const tailNodes: TessellatedSpinePoint[] =
      Math.abs(revised[0]!.controlArc - seamAnchor.controlArc) < 1e-6 &&
      Math.hypot(revised[0]!.x - seamAnchor.x, revised[0]!.y - seamAnchor.y) <
        1e-6
        ? revised.slice(1)
        : revised;
    const spine: TessellatedSpinePoint[] = [seamAnchor, ...tailNodes];
    const mesh = buildStrokeMesh(spine, this.#cap, 'butt');
    const ring = mesh.ring.map((p) => ({ ...p }));
    const nodes = spine.map(toNode);
    return {
      polygon: ring,
      bounds: boundsOfPoints(ring),
      nodeCount: spine.length,
      nodes,
      frontier,
      baseVersion: this.#publishVersion,
      replaceFromSpineIndex: replaceFrom,
      replaceFromArc: replaceArc,
      replacementTail: nodes,
    };
  }

  /** Current confirmed live geometry (materialized snapshot). */
  geometry(): CompiledInkStroke {
    const curve: InkCurve =
      this.#builder.controlCount >= 2
        ? this.#builder.curve
        : {
            segments: [],
            controlCount: this.#builder.controlCount,
            dot:
              this.#spine.length > 0
                ? {
                    x: this.#spine[0]!.x,
                    y: this.#spine[0]!.y,
                    attributes: {
                      pressure: this.#spine[0]!.pressure,
                      tiltX: this.#spine[0]!.tiltX,
                      tiltY: this.#spine[0]!.tiltY,
                      twist: this.#spine[0]!.twist,
                      dt: this.#spine[0]!.dt,
                    },
                  }
                : null,
          };
    const ring = this.#assembleRing();
    stats.ringMaterializations += 1;
    return {
      curve,
      mesh: {
        left: this.#left.map((p) => ({ ...p })),
        right: this.#right.map((p) => ({ ...p })),
        leftFans: new Map(this.#leftFans),
        rightFans: new Map(this.#rightFans),
        ring,
      },
      nodes: this.#spine.map((s) => ({
        x: s.x,
        y: s.y,
        width: s.width,
        pressure: s.pressure,
        tiltX: s.tiltX,
        tiltY: s.tiltY,
        twist: s.twist,
        dt: s.dt,
        extras: { ...s.extras },
        segmentIndex: s.segmentIndex,
        u: s.u,
        controlArc: s.controlArc,
        ...(s.corner !== undefined ? { corner: { ...s.corner } } : {}),
      })),
      polygon: ring.map((p) => ({ ...p })),
      bounds: { ...this.#bounds },
    };
  }

  /**
   * Current confirmed outline + bounds with full ring materialization.
   * Explicit snapshot API (predicted path, diagnostics, tests) — counts a
   * ring materialization. The per-batch hot path (`append()`) never calls
   * this; it publishes chunk views instead.
   */
  liveOutline(): LiveInkGeometryUpdate {
    return this.#update();
  }

  /**
   * Commit: one clean full `compileInkStroke()` over the confirmed samples
   * so stored geometry matches a fresh compile exactly.
   */
  finish(): CompiledInkStroke {
    stats.fullCompiles += 1;
    if (!this.#started || this.#brush === null) {
      return {
        curve: { segments: [], controlCount: 0, dot: null },
        mesh: emptyStrokeMesh(),
        nodes: [],
        polygon: [],
        bounds: { x: 0, y: 0, width: 0, height: 0 },
      };
    }
    return compileInkStroke(this.#confirmed, this.#brush);
  }

  /**
   * The gesture brush is immutable: `begin()` snapshots the resolved brush
   * and the whole gesture — resample spacing, stabilization, streamline,
   * taper, nib, pressure response — runs under that snapshot. There is
   * deliberately no mid-gesture update: a size change that kept the old
   * spacing grid while `finish()` recompiled under the new brush reshaped
   * committed centerlines (pointer-up jump), and any consistent rebuild
   * would re-jitter the live stroke. Settings edits apply to the NEXT
   * stroke (see the capture tool, which re-snapshots per pointer-down).
   */
  brush(): InkBrushSpec | null {
    return this.#brush;
  }

  /** Confirmed sample count appended (including working-dropped). */
  confirmedCount(): number {
    return this.#confirmedCount;
  }

  reset(): void {
    this.#brush = null;
    this.#spacing = 0;
    this.#cap = 'round';
    this.#confirmed = [];
    this.#cleaned = [];
    this.#cornerSource = [];
    this.#cornerResample = initialResampleCarry();
    this.#pressured = [];
    this.#prefilter = initialPressureFilterCarry();
    this.#stabilizer = initialStabilizerCarry(0);
    this.#resample = initialResampleCarry();
    this.#controls = [];
    this.#stabilizedFull = [];
    this.#builder = new InkCurveBuilder();
    this.#spine = [];
    this.#publishedSpans = 0;
    this.#meshedUpTo = 0;
    this.#meshScanFloor = 0;
    this.#left = [];
    this.#right = [];
    this.#leftFans = new Map();
    this.#rightFans = new Map();
    this.#startFan = [];
    this.#endFan = [];
    this.#bounds = { x: 0, y: 0, width: 0, height: 0 };
    this.#confirmedCount = 0;
    this.#started = false;
    this.#publishVersion = 0;
    this.#meshEpoch = 0;
    this.#frozenSpine = 0;
  }

  // --- incremental pipeline (all loops bounded by new + tail) ---

  #rebuildTail(brush: InkBrushSpec): void {
    const total = this.#stabilizedFull.length;
    if (total === 0) {
      this.#publishedSpans = 0;
      this.#meshedUpTo = 0;
      return;
    }
    // Dot phase: a single control stamps the nib at full width. Its
    // pressure already resolved in the pre-resample filter stage.
    if (total === 1) {
      const only = this.#stabilizedFull[0]!;
      const pressure = only.pressure ?? NEUTRAL_PRESSURE;
      this.#builder.reset(
        [
          {
            x: only.x,
            y: only.y,
            pressure,
            tiltX: only.tiltX,
            tiltY: only.tiltY,
            twist: only.twist,
            dt: only.dt,
          },
        ],
        () => ({ ...only.extras }),
      );
      const width = resolveUntaperedWidth(
        pressure,
        brush,
        0,
        only.twist,
        only.tiltX,
        only.tiltY,
      );
      this.#spine = [
        {
          x: only.x,
          y: only.y,
          tx: 1,
          ty: 0,
          width,
          pressure,
          tiltX: only.tiltX,
          tiltY: only.tiltY,
          twist: only.twist,
          dt: only.dt,
          extras: { ...only.extras },
          controlArc: 0,
          segmentIndex: -1,
          u: 0,
        },
      ];
      const mesh = buildStrokeMesh(this.#spine, this.#cap);
      this.#left = mesh.left.map((p) => ({ ...p }));
      this.#right = mesh.right.map((p) => ({ ...p }));
      this.#leftFans = new Map();
      this.#rightFans = new Map();
      this.#startFan = [];
      this.#endFan = [];
      // Dot bounds come from the stamped ring itself (the offset sides
      // degenerate to the center point for single-sample spines).
      this.#bounds = boundsOfPoints(mesh.ring);
      this.#publishedSpans = 0;
      this.#meshedUpTo = 1;
      return;
    }
    // Truncate the fitted centerline to the frozen prefix; the tail
    // window (plus fairing lookbehind) is refit below. Builder and
    // stabilized history stay parallel: both hold one entry per control.
    // Gap-freedom first: when one append adds more controls than the tail
    // window (fast moves, coalesced/up flushes, batched tests), popping to
    // keepFaired alone would strand a noncontiguous hole in the builder
    // (missing middles that later spans bridge as wild jump lines). Pop
    // only down to keepFaired AND extend the refair slice back to cover
    // everything after the builder's end, so pushes always continue the
    // retained prefix contiguously. Per-append work stays O(new + tail).
    // Tip refair second: slice-endpoint outputs (the raw tip copy and its
    // neighbor) match batch endpoints only while they ARE the tip — once
    // interior they must be refaired, so the last two controls are always
    // re-pushed even when the fairing horizon would retain them.
    const rawTailStart = Math.max(0, total - LIVE_COMPILER_TAIL_WINDOW);
    const sliceStart = Math.max(0, rawTailStart - 2);
    const keepFaired = sliceStart > 0 ? sliceStart + 2 : 0;
    const held = this.#builder.controlCount;
    const popTo = Math.min(held >= 2 ? held - 2 : held, keepFaired);
    while (this.#builder.controlCount > popTo) {
      this.#builder.pop();
    }
    // Refair the tail slice (radius-2 locality ⇒ the frozen prefix is
    // exact) and push it through the incremental curve builder. Fairing
    // preserves the pre-resolved pressures.
    const needFrom = popTo;
    const sliceStart2 = Math.max(0, Math.min(sliceStart, needFrom - 2));
    const slice = this.#stabilizedFull.slice(sliceStart2);
    const faired = fairControlPolygon(slice, brush.streamline);
    const drop = needFrom - sliceStart2;
    const tailFaired = faired.slice(drop);
    for (let i = 0; i < tailFaired.length; i++) {
      const s = tailFaired[i]!;
      const control: InkCurveControl = {
        x: s.x,
        y: s.y,
        pressure: s.pressure ?? NEUTRAL_PRESSURE,
        tiltX: s.tiltX,
        tiltY: s.tiltY,
        twist: s.twist,
        dt: s.dt,
      };
      this.#builder.push(control, s.extras);
    }
    // Re-tessellate from the published frontier (not a fixed offset from
    // the stroke end): all still-unpublished spans plus a bounded refresh
    // of the mutable tail. Fixed end-relative slicing stranded whole span
    // ranges whenever one append added more than the window (holes + jump
    // lines in long-stroke previews that only the commit repaired).
    const segCount = this.#builder.curve.segments.length;
    const segKeep = Math.max(
      0,
      Math.min(this.#publishedSpans, segCount) - LIVE_TAIL_REFRESH_SPANS,
    );
    const controls = this.#stabilizedFull;
    // One authoritative arc: the cumulative/total arc of the actual faired
    // controls owned by the builder — the same coordinate system the
    // committed compiler resolves taper from (same controls, same arc,
    // same total). The pre-fair stabilized arc is never a denominator.
    // Include one completed lookbehind span so the splice joint is
    // tessellated with both its incoming and outgoing runs. Starting the
    // slice exactly at `segKeep` turns that joint into the slice's u=0
    // endpoint, which cannot carry the authoritative hard-corner tag and
    // can erase a previously detected corner as the head freezes.
    const tessellateFrom = Math.max(0, segKeep - 1);
    const fresh = tessellateCurve(
      {
        segments: this.#builder.curve.segments.slice(tessellateFrom),
        controlCount: this.#builder.controlCount,
        dot: null,
      },
      brush,
      this.#builder.controlArcLengths(),
      this.#builder.controlTotal(),
      {},
      tessellateFrom,
      (i) => controls[i]?.extras,
    );
    const spliceStart = this.#spliceSpine(fresh, segKeep);
    // Spine now covers builder spans [0 .. published): the splice keeps
    // labels below segKeep and fresh tessellation labels its spans
    // absolutely, so the frontier is the max fresh label + 1 (or segKeep
    // when fresh is empty).
    let frontier = segKeep;
    for (const p of fresh) {
      if (p.segmentIndex + 1 > frontier) frontier = p.segmentIndex + 1;
    }
    this.#publishedSpans = frontier;
    stats.tailSpansRetessellated += Math.max(0, segCount - tessellateFrom);
    // Frozen-head accounting for chunk publishes: spine nodes below
    // spliceStart - 1 are never rewritten by the splice (the joint node
    // itself takes the fresh width), so the stable head count is
    // spliceStart - 1. A regression (corner finalization moving the splice
    // back, pop-path rewinds) invalidates the stability epoch so backends
    // drop cached head geometry.
    const frozenCandidate = Math.max(0, spliceStart - 1);
    if (frozenCandidate < this.#frozenSpine) {
      this.#meshEpoch += 1;
      stats.meshEpochInvalidations += 1;
    }
    this.#frozenSpine = Math.min(frozenCandidate, this.#spine.length);
    this.#publishVersion += 1;
    // Mesh rebuild aligns to the splice's first-fresh NODE index (not the
    // span frontier: spans subdivide into varying node counts, so span
    // units must never address node-indexed sides).
    this.#rebuildMeshTail(spliceStart);
    this.#refreshHeadTaperWidths(brush);
    this.#recomputeBounds();
  }

  /**
   * Splice freshly tessellated tail points over the frozen head. Fresh
   * tessellation includes the completed `segKeep - 1` lookbehind span, so
   * the joint takes current endpoint identity and hard-corner metadata as
   * well as the fresh width. This is authoritative even when a preview
   * corner is later removed; stale joint metadata is never retained.
   * Returns the first fresh node index in the final spine (for mesh-tail
   * alignment below).
   */
  #spliceSpine(fresh: TessellatedSpinePoint[], segKeep: number): number {
    if (segKeep <= 0 || this.#spine.length === 0) {
      this.#spine = fresh;
      return 0;
    }
    let s = this.#spine.length;
    while (s > 0 && this.#spine[s - 1]!.segmentIndex >= segKeep) s--;
    // s is the first index with segmentIndex >= segKeep (the joint when
    // s > 0 belongs to segKeep - 1 and is position-shared with fresh[0]).
    const joint = s > 0 ? s - 1 : -1;
    this.#spine.length = s;
    if (fresh.length > 0) {
      if (joint >= 0) {
        // The lookbehind span ends at the retained joint. Use that endpoint
        // as a whole: u=1 and corner state belong to the incoming segment,
        // while the sliced tail's first u=0 point has no incoming context.
        let tailStart = 0;
        while (
          tailStart < fresh.length &&
          fresh[tailStart]!.segmentIndex < segKeep
        ) {
          tailStart += 1;
        }
        const hasLookbehind = tailStart > 0;
        const freshJoint = fresh[hasLookbehind ? tailStart - 1 : 0]!;
        this.#spine[joint] = freshJoint;
        for (let i = hasLookbehind ? tailStart : 1; i < fresh.length; i++) {
          this.#spine.push(fresh[i]!);
        }
      } else {
        for (const p of fresh) this.#spine.push(p);
      }
    }
    return s;
  }

  /** First spine index covered by the mesh tail rebuild. */
  #meshTailStart(): number {
    return Math.max(
      0,
      this.#spine.length - (LIVE_COMPILER_TAIL_WINDOW * 4 + 16),
    );
  }

  /**
   * Rebuild mesh sides from `fromNode` to the spine end, with one
   * lookbehind point for join context. Sides, miter vertices, and
   * round-fan joins come from the same `buildStrokeMesh` the commit path
   * uses — the live splice only remaps its spine-indexed fans into
   * retained space, so live joins match committed joins without a second
   * implementation. The rebuild starts no later than the splice frontier
   * (and heals any previously short sides up to it), so per-append growth
   * of any size stays fully meshed — a fixed tail-only horizon stranded
   * whole side ranges on large appends, punching outline holes that only
   * the commit repaired. Work is O(new + refreshed tail), never O(history).
   */
  #rebuildMeshTail(fromNode: number = this.#meshTailStart()): void {
    const n = this.#spine.length;
    if (n === 0) {
      this.#left = [];
      this.#right = [];
      this.#leftFans = new Map();
      this.#rightFans = new Map();
      this.#startFan = [];
      this.#endFan = [];
      this.#meshedUpTo = 0;
      this.#meshScanFloor = 0;
      return;
    }
    if (n === 1) {
      const mesh = buildStrokeMesh(this.#spine, this.#cap);
      this.#left = mesh.left.map((p) => ({ ...p }));
      this.#right = mesh.right.map((p) => ({ ...p }));
      this.#leftFans = new Map();
      this.#rightFans = new Map();
      this.#startFan = [];
      this.#endFan = [];
      this.#meshedUpTo = 1;
      this.#meshScanFloor = 0;
      return;
    }
    const need = Math.min(this.#meshedUpTo, Math.max(0, fromNode));
    const tailStart = Math.max(0, need - 1);
    const lookbehind = tailStart > 0 ? 1 : 0;
    const sliceBase = tailStart - lookbehind;
    const slice = this.#spine.slice(sliceBase);
    const mesh = buildStrokeMesh(slice, this.#cap);
    // Drop retained state covered by the recomputed region.
    const keepSides = lookbehind === 1 ? sliceBase + 1 : 0;
    this.#left.length = Math.min(this.#left.length, keepSides);
    this.#right.length = Math.min(this.#right.length, keepSides);
    for (const key of [...this.#leftFans.keys()]) {
      if (key >= keepSides) this.#leftFans.delete(key);
    }
    for (const key of [...this.#rightFans.keys()]) {
      if (key >= keepSides) this.#rightFans.delete(key);
    }
    const skip = lookbehind === 1 ? 1 : 0;
    for (let i = skip; i < mesh.left.length; i++) {
      this.#left.push({ ...mesh.left[i]! });
      this.#right.push({ ...mesh.right[i]! });
    }
    // Entries below keepSides are retained verbatim; everything from
    // here may have been rewritten (see #meshScanFloor).
    this.#meshScanFloor = keepSides;
    // Fan keys remap from slice space to spine space (the lookbehind's
    // own fan, if any, stays frozen with the head).
    for (const [key, fan] of mesh.leftFans) {
      if (key < skip) continue;
      this.#leftFans.set(
        sliceBase + key,
        fan.map((p) => ({ ...p })),
      );
    }
    for (const [key, fan] of mesh.rightFans) {
      if (key < skip) continue;
      this.#rightFans.set(
        sliceBase + key,
        fan.map((p) => ({ ...p })),
      );
    }
    this.#meshedUpTo = n;
    this.#refreshCaps();
  }

  /** Recompute round end/start caps from the live spine ends (O(1)). */
  #refreshCaps(): void {
    this.#startFan = [];
    this.#endFan = [];
    if (this.#cap === 'butt' || this.#spine.length < 2) return;
    const first = this.#spine[0]!;
    const last = this.#spine[this.#spine.length - 1]!;
    const leftFirst = this.#left[0];
    const rightFirst = this.#right[0];
    const leftLast = this.#left[this.#left.length - 1];
    const rightLast = this.#right[this.#right.length - 1];
    if (
      leftFirst === undefined ||
      rightFirst === undefined ||
      leftLast === undefined ||
      rightLast === undefined
    ) {
      return;
    }
    const firstC = { x: first.x, y: first.y };
    const lastC = { x: last.x, y: last.y };
    const lastDir = Math.atan2(
      lastC.y - this.#spine[this.#spine.length - 2]!.y,
      lastC.x - this.#spine[this.#spine.length - 2]!.x,
    );
    const firstDir = Math.atan2(
      firstC.y - this.#spine[1]!.y,
      firstC.x - this.#spine[1]!.x,
    );
    this.#endFan = roundCapFan(
      lastC,
      Math.max(last.width, 0) / 2,
      Math.atan2(leftLast.y - lastC.y, leftLast.x - lastC.x),
      Math.atan2(rightLast.y - lastC.y, rightLast.x - lastC.x),
      Number.isFinite(lastDir) ? lastDir : 0,
      CAP_SEGMENTS,
    );
    this.#startFan = roundCapFan(
      firstC,
      Math.max(first.width, 0) / 2,
      Math.atan2(rightFirst.y - firstC.y, rightFirst.x - firstC.x),
      Math.atan2(leftFirst.y - firstC.y, leftFirst.x - firstC.x),
      Number.isFinite(firstDir) ? firstDir : Math.PI,
      CAP_SEGMENTS,
    );
  }

  /** Refresh the bounded start zone after tail topology settles. The zone
   * itself is fixed in nib units; extending the stroke never stretches it.
   */
  #refreshHeadTaperWidths(brush: InkBrushSpec): void {
    if (this.#spine.length < 3 || brush.taperStart <= 0) return;
    const total = this.#builder.controlTotal();
    if (!(total > 0)) return;
    const { startLen } = normalizeTaperZones(brush.taperStart, brush.taperEnd);
    if (!(startLen > 0)) return;
    const cap = TAPER_ZONE_CAP_SIZE_MULTIPLE * Math.max(brush.size, 1e-9);
    const zone = startLen * cap;
    if (!(zone > 0)) return;
    // First spine index at/after the zone edge; +1 join-context node so
    // the zone edge keeps a true join (never an endpoint-style offset).
    let edge = this.#spine.length - 1;
    for (let i = 0; i < this.#spine.length; i++) {
      if (this.#spine[i]!.controlArc >= zone) {
        edge = i;
        break;
      }
    }
    const end = Math.min(
      edge,
      this.#spine.length - 1,
      this.#left.length - 1,
      this.#right.length - 1,
    );
    if (end < 2) return;
    let changed = false;
    for (let i = 0; i <= end; i++) {
      const s = this.#spine[i]!;
      const width = resolveWidth(
        s.pressure,
        brush,
        s.controlArc,
        total,
        Math.atan2(s.ty, s.tx),
        s.twist,
        s.tiltX,
        s.tiltY,
      );
      if (width !== s.width) {
        this.#spine[i] = { ...s, width };
        changed = true;
      }
    }
    if (!changed) return;
    stats.headWidthRefreshes += 1;
    stats.headWidthNodes += end + 1;
    // Head entries below the frozen frontier were rewritten: invalidate
    // the stability epoch so backends drop cached head geometry. (Topology
    // never changes here, so the frozen count itself stays valid.)
    this.#meshEpoch += 1;
    stats.meshEpochInvalidations += 1;
    // Rebuild mesh sides over the zone slice (join context included) and
    // splice them over the retained head sides; zone fans recomputed with
    // them. Slice indices equal global indices (base 0).
    const contextEnd = Math.min(end + 1, this.#spine.length - 1);
    const slice = this.#spine.slice(0, contextEnd + 1);
    const mesh = buildStrokeMesh(slice, this.#cap);
    for (let i = 0; i <= end; i++) {
      this.#left[i] = { ...mesh.left[i]! };
      this.#right[i] = { ...mesh.right[i]! };
    }
    for (const key of [...this.#leftFans.keys()]) {
      if (key <= end) this.#leftFans.delete(key);
    }
    for (const key of [...this.#rightFans.keys()]) {
      if (key <= end) this.#rightFans.delete(key);
    }
    for (const [key, fan] of mesh.leftFans) {
      if (key <= end)
        this.#leftFans.set(
          key,
          fan.map((p) => ({ ...p })),
        );
    }
    for (const [key, fan] of mesh.rightFans) {
      if (key <= end)
        this.#rightFans.set(
          key,
          fan.map((p) => ({ ...p })),
        );
    }
    this.#refreshCaps();
    // Expand-only bounds cover over the refreshed sides (widths only grow
    // here as the total settles toward the cap; tail work never shrinks).
    const bounds = this.#bounds;
    let minX = bounds.x;
    let minY = bounds.y;
    let maxX = bounds.x + bounds.width;
    let maxY = bounds.y + bounds.height;
    if (!Number.isFinite(minX) || bounds.width === 0) {
      minX = Infinity;
      minY = Infinity;
      maxX = -Infinity;
      maxY = -Infinity;
    }
    for (let i = 0; i <= end; i++) {
      for (const p of [this.#left[i]!, this.#right[i]!]) {
        if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
    }
    if (Number.isFinite(minX)) {
      this.#bounds = {
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
      };
    }
  }

  #assembleRing(): Point[] {
    const n = this.#left.length;
    if (n === 0) return [];
    if (n === 1) {
      const mesh = buildStrokeMesh(this.#spine, this.#cap);
      return mesh.ring.map((p) => ({ ...p }));
    }
    const leftRun: Point[] = [];
    for (let i = 0; i < this.#left.length; i++) {
      leftRun.push(this.#left[i]!);
      const fan = this.#leftFans.get(i);
      if (fan !== undefined) leftRun.push(...fan);
    }
    const rightRun: Point[] = [];
    for (let i = 0; i < this.#right.length; i++) {
      rightRun.push(this.#right[i]!);
      const fan = this.#rightFans.get(i);
      if (fan !== undefined) rightRun.push(...fan);
    }
    rightRun.reverse();
    if (this.#cap === 'butt') return [...leftRun, ...rightRun];
    return [...leftRun, ...this.#endFan, ...rightRun, ...this.#startFan];
  }

  #recomputeBounds(): void {
    // Incremental expand-only: scan everything the mesh rebuild may have
    // rewritten (from #meshScanFloor) plus the fixed tail window — never
    // the whole stroke. Bounds never shrink mid-gesture — removed tail
    // extrema leave conservative over-cover, always safe for
    // culling/preview. Full resets happen only in reset() (rare),
    // keeping live appends O(touched tail). The commit pass resolves
    // exact bounds.
    const tailStart = this.#meshTailStart();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let hasExisting = false;
    if (tailStart === 0 || this.#bounds.width === 0) {
      // Full scan (first build or explicit reset).
    } else {
      minX = this.#bounds.x;
      minY = this.#bounds.y;
      maxX = this.#bounds.x + this.#bounds.width;
      maxY = this.#bounds.y + this.#bounds.height;
      hasExisting = true;
    }
    const start = hasExisting
      ? Math.min(tailStart, this.#meshScanFloor, this.#left.length)
      : 0;
    const scan = (p: Point): void => {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return;
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    };
    for (let i = start; i < this.#left.length; i++) {
      scan(this.#left[i]!);
      scan(this.#right[i]!);
    }
    // Round-join fans can extend past the offset runs at cusps; they are
    // few (miter-limit fallbacks only), so scanning all of them is O(1)
    // in practice and keeps bounds containing the assembled ring.
    for (const fan of this.#leftFans.values()) {
      for (const p of fan) scan(p);
    }
    for (const fan of this.#rightFans.values()) {
      for (const p of fan) scan(p);
    }
    // Round caps extend past the end spine nodes: include both cap fans so
    // published bounds always contain the assembled ring (butt caps need
    // no expansion beyond the ribbon itself).
    for (const p of this.#endFan) scan(p);
    for (const p of this.#startFan) scan(p);
    if (!Number.isFinite(minX)) {
      this.#bounds = { x: 0, y: 0, width: 0, height: 0 };
      return;
    }
    this.#bounds = {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
    };
  }

  /**
   * Explicit full-ring snapshot (diagnostics, predicted-path fallback,
   * tests). Counts a ring materialization — never call this per input
   * batch; publish chunk views via `append()` instead.
   */
  #update(): LiveInkGeometryUpdate {
    stats.ringMaterializations += 1;
    return {
      polygon: this.#assembleRing(),
      bounds: { ...this.#bounds },
      nodeCount: this.#spine.length,
      exact: this.#controls.length <= LIVE_COMPILER_TAIL_WINDOW,
    };
  }
}
