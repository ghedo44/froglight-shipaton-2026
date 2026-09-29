/**
 * rAF-coalesced draw input buffer (production-readiness item 2).
 *
 * Rapid repetitive circles at 120/240Hz fire many `pointerrawupdate` /
 * `pointermove` events per animation frame. Running the full live geometry
 * pipeline (fairing → B-spline tail → tessellation → mesh rebuild → Canvas
 * tail) synchronously per event stalls the main thread: the preview stops
 * updating, then a large catch-up block appears.
 *
 * This buffer separates cheap capture from expensive publication:
 *
 * ```text
 * pointer events → dedup (cheap, per event) → pending buffer + latest
 *   prediction → once per rAF: single confirmed batch + latest prediction
 *   → one live geometry publication → paint
 * ```
 *
 * - Confirmed samples are never dropped: every fresh sample is appended in
 *   order; coalescing only groups them into fewer, larger batches.
 * - Predictions are ephemeral: only the latest set is kept; intermediate
 *   predictions are replaced/discarded between frames.
 * - `flush()` is idempotent and synchronous for `pointerup` (pending
 *   confirmed samples commit before the final up).
 *
 * DOM-free and headless-testable: the pointer controller owns scheduling
 * (rAF), this module owns buffering + deterministic counters.
 */

import type { NormalizedPointerEvent } from '@froglight/foundation';

export interface DrawInputCoalescerStats {
  /** Batches pushed (one per DOM event). */
  pushes: number;
  /** Flushes that published geometry (≤ frames). */
  flushes: number;
  /** Confirmed samples buffered across all pushes. */
  confirmedBuffered: number;
  /** Confirmed samples flushed (must equal buffered on completion). */
  confirmedFlushed: number;
  /** Predicted pushes received. */
  predictedPushes: number;
  /** Predicted pushes replaced before flush (ephemeral, expected). */
  predictedReplaced: number;
  /** Predicted samples flushed (latest only). */
  predictedFlushed: number;
  /** Flushes that found nothing pending (coalesced away). */
  emptyFlushes: number;
}

export interface DrawInputFlush {
  readonly confirmed: readonly NormalizedPointerEvent[];
  readonly predicted: readonly NormalizedPointerEvent[];
}

/**
 * Buffers draw-mode input between frames. Cheap per event (array pushes);
 * expensive work happens only in `flush()` (one batch per frame).
 *
 * Transport ownership:
 * - `pushConfirmed` buffers confirmed input (both `pointerrawupdate` and
 *   `pointermove` confirmed paths use it; raw never touches predictions).
 * - `replacePredictionSnapshot` replaces the ephemeral prediction state
 *   (only the `pointermove` transport calls it). An empty array EXPLICITLY
 *   clears the previous prediction — a move with no lookahead ends the
 *   old tail instead of letting it linger for another frame.
 */
export class DrawInputCoalescer {
  private pendingConfirmed: NormalizedPointerEvent[] = [];
  private pendingPredicted: NormalizedPointerEvent[] = [];
  private predictionChanged = false;
  private readonly stats: DrawInputCoalescerStats = {
    pushes: 0,
    flushes: 0,
    confirmedBuffered: 0,
    confirmedFlushed: 0,
    predictedPushes: 0,
    predictedReplaced: 0,
    predictedFlushed: 0,
    emptyFlushes: 0,
  };

  /** Buffer confirmed samples (cheap append, never dropped). */
  pushConfirmed(confirmed: readonly NormalizedPointerEvent[]): void {
    this.stats.pushes += 1;
    if (confirmed.length > 0) {
      for (const s of confirmed) this.pendingConfirmed.push(s);
      this.stats.confirmedBuffered += confirmed.length;
    }
  }

  /**
   * Replace the ephemeral prediction snapshot. An empty array explicitly
   * clears the previous prediction (stale tails never survive a move
   * that carries no lookahead).
   */
  replacePredictionSnapshot(
    predicted: readonly NormalizedPointerEvent[],
  ): void {
    this.predictionChanged = true;
    if (predicted.length > 0) {
      this.stats.predictedPushes += 1;
      if (this.pendingPredicted.length > 0) this.stats.predictedReplaced += 1;
      // Ephemeral: keep only the latest prediction set.
      this.pendingPredicted = [...predicted];
    } else {
      // Explicit clear: a prediction-less move ends the old tail.
      if (this.pendingPredicted.length > 0) this.stats.predictedReplaced += 1;
      this.pendingPredicted = [];
    }
  }

  /**
   * Buffer one DOM event's fresh samples (already deduped, cheap).
   * Combined convenience: confirmed appended, prediction snapshot
   * replaced (empty clears). Prefer the split methods for explicit
   * transport ownership (`pointerrawupdate` must NOT touch predictions).
   */
  push(
    confirmed: readonly NormalizedPointerEvent[],
    predicted: readonly NormalizedPointerEvent[],
  ): void {
    this.pushConfirmed(confirmed);
    this.replacePredictionSnapshot(predicted);
  }

  /** True when unflushed input is pending. */
  hasPending(): boolean {
    return this.pendingConfirmed.length > 0 || this.predictionChanged;
  }

  /** Pending confirmed count (diagnostics). */
  pendingCount(): number {
    return this.pendingConfirmed.length;
  }

  /**
   * Drain the buffer as one flush (one expensive publication). Returns null
   * when nothing is pending. Clears prediction state even when only
   * predictions were pending (they are ephemeral per frame).
   */
  flush(): DrawInputFlush | null {
    if (!this.hasPending()) {
      this.stats.emptyFlushes += 1;
      return null;
    }
    const out: DrawInputFlush = {
      confirmed: this.pendingConfirmed,
      predicted: this.pendingPredicted,
    };
    this.stats.flushes += 1;
    this.stats.confirmedFlushed += this.pendingConfirmed.length;
    this.stats.predictedFlushed += this.pendingPredicted.length;
    this.pendingConfirmed = [];
    this.pendingPredicted = [];
    this.predictionChanged = false;
    return out;
  }

  /** Discard pending predictions without touching confirmed (pointerup). */
  dropPredictions(): void {
    this.pendingPredicted = [];
  }

  statsSnapshot(): DrawInputCoalescerStats {
    return { ...this.stats };
  }

  reset(): void {
    this.pendingConfirmed = [];
    this.pendingPredicted = [];
    this.predictionChanged = false;
    this.stats.pushes = 0;
    this.stats.flushes = 0;
    this.stats.confirmedBuffered = 0;
    this.stats.confirmedFlushed = 0;
    this.stats.predictedPushes = 0;
    this.stats.predictedReplaced = 0;
    this.stats.predictedFlushed = 0;
    this.stats.emptyFlushes = 0;
  }
}
