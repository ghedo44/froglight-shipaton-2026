/**
 * Prediction transport policy + screen-space horizon clipping.
 *
 * Browser `getPredictedEvents()` lookahead is untrusted: it can jump many
 * centimeters ahead of the confirmed frontier (the flashing forward line).
 * Predictions are ephemeral preview-only state — they never commit — but
 * rendering them unbounded still flashes a line ahead of the pointer.
 *
 * Policy (product):
 * - pen   → bounded prediction enabled (horizon-clipped below)
 * - mouse → prediction disabled (no lookahead benefit, only flash risk)
 * - touch → disabled unless explicitly justified via `allowTouch`
 *
 * Horizon (both apply, whichever trims first):
 * - time lookahead: `predicted.time - confirmedHighWater <= maxLookaheadMs`
 *   (≈ one frame; default 32ms). Stale predictions (`time < highWater`)
 *   are already dropped by the transport; this caps far-future lookahead.
 * - screen distance: cumulative VIEW-space (CSS px, i.e. screen space —
 *   never surface units) length from the confirmed frontier, trimmed
 *   sample-by-sample until `<= maxScreenPx` (default 20px, within the
 *   16–24px product band).
 *
 * View space IS screen space here: `viewPointFromRect` yields CSS px
 * relative to the canvas, before any camera/zoom mapping. Clipping in
 * view units therefore holds the visible horizon constant across zoom
 * (0.25×–8×): the same prediction retains the same samples at any zoom,
 * while a surface-unit horizon would stretch/shrink on screen.
 *
 * DOM-free and headless-testable: callers supply plain points/times.
 */

import type { NormalizedPointerEvent } from '@froglight/foundation';

/** Default visible prediction horizon (CSS px, within the 16–24 band). */
export const PREDICTION_MAX_SCREEN_PX = 20;

/** Default lookahead horizon (≈ one frame at 60fps plus slack). */
export const PREDICTION_MAX_LOOKAHEAD_MS = 32;

/** Pointer types with bounded prediction enabled by default. */
export type PredictionPointerType = 'pen' | 'mouse' | 'touch' | (string & {});

export interface PredictionPolicyOptions {
  /** Master switch (debug/test kill-switch). Default true. */
  readonly enabled?: boolean;
  /** Visible horizon in CSS px. Default {@link PREDICTION_MAX_SCREEN_PX}. */
  readonly maxScreenPx?: number;
  /** Lookahead horizon in ms. Default {@link PREDICTION_MAX_LOOKAHEAD_MS}. */
  readonly maxLookaheadMs?: number;
  /** Opt-in for mouse predictions (default false). */
  readonly allowMouse?: boolean;
  /** Opt-in for touch predictions (default false, needs justification). */
  readonly allowTouch?: boolean;
}

export interface PredictionClipResult {
  /** Retained predictions (prefix of the input, in order). */
  readonly retained: readonly NormalizedPointerEvent[];
  /** Cumulative screen-space (view/CSS-px) length of `retained`. */
  readonly screenLengthPx: number;
  /** Input count before clipping (diagnostics). */
  readonly received: number;
}

/**
 * True when predictions may render for this pointer type under the policy.
 * Unknown types default to disabled (fail closed — no flash risk).
 */
export function shouldPredictForPointerType(
  pointerType: PredictionPointerType | string,
  options: PredictionPolicyOptions = {},
): boolean {
  if (options.enabled === false) return false;
  if (pointerType === 'pen') return true;
  if (pointerType === 'mouse') return options.allowMouse === true;
  if (pointerType === 'touch') return options.allowTouch === true;
  return false;
}

/**
 * Clip predictions to the time + screen-space horizons.
 *
 * - Drops far-future samples (`time - highWater > maxLookaheadMs`) when
 *   both timestamps are finite (timestamp-less samples skip the time gate
 *   and are governed by the distance gate only).
 * - Trims cumulatively from `frontier` (the last confirmed VIEW point):
 *   samples are kept in order while the running
 *   `frontier→p0→p1…` length stays within `maxScreenPx`; the first sample
 *   that would exceed the horizon (and everything after it) is dropped.
 * - Non-finite points are dropped (never rendered).
 *
 * Pure: no DOM, no camera, no mutation.
 */
export function clipPredictedToHorizon(
  predicted: readonly NormalizedPointerEvent[],
  frontier: { readonly x: number; readonly y: number } | null,
  confirmedHighWater: number,
  options: PredictionPolicyOptions = {},
): PredictionClipResult {
  const received = predicted.length;
  if (received === 0 || frontier === null) {
    return { retained: [], screenLengthPx: 0, received };
  }
  const maxPx =
    typeof options.maxScreenPx === 'number' &&
    Number.isFinite(options.maxScreenPx) &&
    options.maxScreenPx >= 0
      ? options.maxScreenPx
      : PREDICTION_MAX_SCREEN_PX;
  const maxLookahead =
    typeof options.maxLookaheadMs === 'number' &&
    Number.isFinite(options.maxLookaheadMs) &&
    options.maxLookaheadMs >= 0
      ? options.maxLookaheadMs
      : PREDICTION_MAX_LOOKAHEAD_MS;

  const retained: NormalizedPointerEvent[] = [];
  let length = 0;
  let prev = { x: frontier.x, y: frontier.y };
  for (const sample of predicted) {
    if (!Number.isFinite(sample.point.x) || !Number.isFinite(sample.point.y)) {
      continue;
    }
    if (
      typeof sample.time === 'number' &&
      Number.isFinite(sample.time) &&
      Number.isFinite(confirmedHighWater) &&
      sample.time - confirmedHighWater > maxLookahead
    ) {
      // Far-future lookahead: drop this sample and everything after it
      // (predictions are ordered; later ones are only farther ahead).
      break;
    }
    const step = Math.hypot(sample.point.x - prev.x, sample.point.y - prev.y);
    if (!Number.isFinite(step)) continue;
    if (length + step > maxPx) break;
    length += step;
    retained.push(sample);
    prev = { x: sample.point.x, y: sample.point.y };
  }
  return { retained, screenLengthPx: length, received };
}
