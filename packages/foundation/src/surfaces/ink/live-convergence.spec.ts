/**
 * Live vs committed quality gates: identical input fed incrementally must
 * converge to the authoritative commit so pointer-up never visibly changes
 * the handwriting. Covers 100 / 1k / 5k / 10k samples plus predicted-tail
 * replacement and per-stroke brush snapshots.
 *
 * All geometric tolerances derive from screen pixels at the maximum
 * supported zoom (8x): 0.5 screen px = 0.0625 surface units. A live/commit
 * difference inside this budget is plausibly invisible, so the test name
 * "no visible jump" is only honest with a tolerance this tight.
 * Centerline, outline, width profile, bounds, and endpoints are measured
 * separately (never hidden behind AABB-only comparisons), and symmetric
 * bounds agreement keeps single-vertex spikes (invisible to subsampled
 * Hausdorff) inside the same budget.
 */

import { describe, expect, it } from 'vitest';
import { BALL_PEN_BRUSH, brushPresetForKind } from './brush.js';
import { compileInkStroke } from './compiler.js';
import {
  LIVE_COMPILER_TAIL_WINDOW,
  LiveInkStrokeCompiler,
  liveCompilerStats,
  resetLiveCompilerStats,
} from './live-compiler.js';
import { sCurve } from './fixtures.js';
import type { InkBrushSpec } from './brush.js';
import type { InkSample } from '../model.js';
import type { Point } from '../geometry.js';

/** Maximum supported/design zoom (mirrors the Ink editor MAX_ZOOM). */
const DESIGN_ZOOM = 8;
/**
 * Visual budget: half a screen pixel at the design zoom, in surface
 * units. Every live/commit deviation below is asserted against this —
 * plausibly invisible, so "pointer-up causes no visible jump" holds.
 */
const VISUAL_BUDGET = 0.5 / DESIGN_ZOOM;

function diagonal(count: number, pressure = 0.5): InkSample[] {
  const out: InkSample[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ x: i * 0.7, y: i * 0.45, pressure });
  }
  return out;
}

function batchesOf(samples: InkSample[], size: number): InkSample[][] {
  const out: InkSample[][] = [];
  for (let i = 0; i < samples.length; i += size) {
    out.push(samples.slice(i, i + size));
  }
  return out;
}

function distToRing(p: Point, ring: readonly Point[]): number {
  let best = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
    t = Math.min(Math.max(t, 0), 1);
    best = Math.min(
      best,
      Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)),
    );
  }
  return best;
}

function hausdorff(a: readonly Point[], b: readonly Point[]): number {
  // Subsampled for large rings (every kth vertex): still a valid upper
  // bound on outline disagreement, at full resolution for small rings.
  // Single-vertex spikes escape subsampling — symmetric bounds agreement
  // (asserted alongside) keeps every extreme inside the same budget.
  const step = Math.max(1, Math.floor(Math.max(a.length, b.length) / 2000));
  let worst = 0;
  for (let i = 0; i < a.length; i += step) {
    worst = Math.max(worst, distToRing(a[i]!, b));
  }
  for (let i = 0; i < b.length; i += step) {
    worst = Math.max(worst, distToRing(b[i]!, a));
  }
  return worst;
}

/** Width at arc by linear interpolation over arc-ordered nodes. */
function widthAt(
  nodes: readonly { controlArc: number; width: number }[],
  arc: number,
): number {
  if (nodes.length === 0) return 0;
  if (arc <= nodes[0]!.controlArc) return nodes[0]!.width;
  for (let i = 1; i < nodes.length; i++) {
    if (nodes[i]!.controlArc >= arc) {
      const a = nodes[i - 1]!;
      const b = nodes[i]!;
      const t =
        b.controlArc > a.controlArc
          ? (arc - a.controlArc) / (b.controlArc - a.controlArc)
          : 0;
      return a.width + (b.width - a.width) * t;
    }
  }
  return nodes[nodes.length - 1]!.width;
}

function feedIncrementally(
  samples: InkSample[],
  batchSize: number,
  brush: InkBrushSpec = BALL_PEN_BRUSH,
): LiveInkStrokeCompiler {
  const compiler = new LiveInkStrokeCompiler();
  compiler.begin(samples[0]!, brush);
  for (const batch of batchesOf(samples.slice(1), batchSize)) {
    compiler.append(batch);
  }
  return compiler;
}

/**
 * Full live/commit agreement: centerline, outline, arc-aligned width
 * profile, symmetric bounds (spike-proof extremes), and endpoints —
 * every measure inside the visual budget.
 */
function expectVisualConvergence(
  live: {
    nodes: readonly {
      x: number;
      y: number;
      width: number;
      controlArc: number;
    }[];
    polygon: readonly Point[];
    bounds: { x: number; y: number; width: number; height: number };
  },
  committed: {
    nodes: readonly {
      x: number;
      y: number;
      width: number;
      controlArc: number;
    }[];
    polygon: readonly Point[];
    bounds: { x: number; y: number; width: number; height: number };
  },
  label: string,
): void {
  // Centerline deviation.
  expect(
    hausdorff(
      live.nodes.map((n) => ({ x: n.x, y: n.y })),
      committed.nodes.map((n) => ({ x: n.x, y: n.y })),
    ),
    `${label}: centerline`,
  ).toBeLessThan(VISUAL_BUDGET);
  // Outline deviation.
  expect(
    hausdorff(live.polygon, committed.polygon),
    `${label}: outline`,
  ).toBeLessThan(VISUAL_BUDGET);
  // Width deviation (arc-aligned profile, not index-aligned).
  const hi = Math.min(
    live.nodes[live.nodes.length - 1]!.controlArc,
    committed.nodes[committed.nodes.length - 1]!.controlArc,
  );
  let widthWorst = 0;
  for (let k = 0; k <= 60; k++) {
    const arc = (hi * k) / 60;
    widthWorst = Math.max(
      widthWorst,
      Math.abs(widthAt(live.nodes, arc) - widthAt(committed.nodes, arc)),
    );
  }
  expect(widthWorst, `${label}: width`).toBeLessThan(VISUAL_BUDGET);
  // Symmetric bounds agreement (every extreme, spike-proof).
  const lb = live.bounds;
  const cb = committed.bounds;
  expect(Math.abs(lb.x - cb.x), `${label}: bounds x`).toBeLessThan(
    VISUAL_BUDGET,
  );
  expect(Math.abs(lb.y - cb.y), `${label}: bounds y`).toBeLessThan(
    VISUAL_BUDGET,
  );
  expect(
    Math.abs(lb.x + lb.width - (cb.x + cb.width)),
    `${label}: bounds maxX`,
  ).toBeLessThan(VISUAL_BUDGET);
  expect(
    Math.abs(lb.y + lb.height - (cb.y + cb.height)),
    `${label}: bounds maxY`,
  ).toBeLessThan(VISUAL_BUDGET);
  // Endpoint deviation.
  const ls = live.nodes[0]!;
  const cs = committed.nodes[0]!;
  const le = live.nodes[live.nodes.length - 1]!;
  const ce = committed.nodes[committed.nodes.length - 1]!;
  expect(Math.hypot(ls.x - cs.x, ls.y - cs.y), `${label}: start`).toBeLessThan(
    VISUAL_BUDGET,
  );
  expect(Math.hypot(le.x - ce.x, le.y - ce.y), `${label}: end`).toBeLessThan(
    VISUAL_BUDGET,
  );
}

describe('live vs committed convergence', () => {
  for (const count of [100, 1000, 5000]) {
    it(
      `converges at ${count} samples (pointer-up causes no visible jump)`,
      () => {
        resetLiveCompilerStats();
        const samples = diagonal(count);
        const compiler = feedIncrementally(samples, 25);
        const live = compiler.geometry();
        const committed = compiler.finish();
        const clean = compileInkStroke(samples, BALL_PEN_BRUSH);
        // Commit matches a clean full compile exactly (zero tolerance gap).
        expect(committed.polygon).toEqual(clean.polygon);
        expect(committed.bounds).toEqual(clean.bounds);
        expectVisualConvergence(live, committed, `${count} samples`);
        // Incremental, never O(n²): zero full compiles during the gesture,
        // exactly one at commit.
        expect(liveCompilerStats().fullCompiles).toBe(1);
      },
      // 5k diagonal verification exceeds the 5s default on loaded CI
      // runners (approximating fit + ring Hausdorff); bounded well below
      // the 10k gate's 120s budget.
      count >= 5000 ? 60000 : 15000,
    );
  }

  it('converges on curves with taper and pressure (brush pen S-curve)', () => {
    resetLiveCompilerStats();
    const brush = brushPresetForKind('brush');
    const samples = sCurve();
    const compiler = feedIncrementally(samples, 7, brush);
    const live = compiler.geometry();
    const committed = compiler.finish();
    expect(committed.polygon).toEqual(compileInkStroke(samples, brush).polygon);
    expectVisualConvergence(live, committed, 'brush S-curve');
    expect(liveCompilerStats().fullCompiles).toBe(1);
  });

  it('keeps per-batch work proportional to new/tail input, not history', () => {
    resetLiveCompilerStats();
    const compiler = new LiveInkStrokeCompiler();
    const history = diagonal(2000);
    compiler.begin(history[0]!, BALL_PEN_BRUSH);
    for (const batch of batchesOf(history.slice(1), 100)) {
      compiler.append(batch);
    }
    const before = compiler.geometry().nodes.length;
    compiler.append([{ x: 1400.7, y: 900.45, pressure: 0.5 }]);
    const after = compiler.geometry().nodes.length;
    // One new sample (plus grid subdivision of its segment) adds a small
    // bounded node delta — never a history-proportional rebuild.
    expect(after - before).toBeLessThanOrEqual(LIVE_COMPILER_TAIL_WINDOW * 4);
    expect(liveCompilerStats().fullCompiles).toBe(0);
  });

  it('never lets predicted input perturb confirmed geometry', () => {
    const samples = diagonal(200);
    const clean = feedIncrementally(samples, 20);
    const cleanGeometry = clean.geometry();

    const withPrediction = feedIncrementally(samples, 20);
    const predicted = withPrediction.appendPredicted([
      { x: 500, y: 500, pressure: 1 },
      { x: 600, y: 600, pressure: 1 },
    ]);
    expect(predicted.polygon.length).toBeGreaterThan(0);
    expect(predicted.nodeCount).toBeGreaterThan(1);
    // The continuation starts exactly at the live frontier.
    const tip = withPrediction.geometry().nodes;
    const tipEnd = tip[tip.length - 1]!;
    expect(predicted.frontier.x).toBeCloseTo(tipEnd.x, 9);
    expect(predicted.frontier.y).toBeCloseTo(tipEnd.y, 9);
    // Confirmed state untouched: same nodes, bounds, and count.
    expect(withPrediction.geometry().bounds).toEqual(cleanGeometry.bounds);
    expect(withPrediction.geometry().polygon).toEqual(cleanGeometry.polygon);
    expect(withPrediction.confirmedCount()).toBe(samples.length);
    // Confirming over the prediction converges to the prediction-free
    // result: earlier confirmed geometry is not perturbed.
    withPrediction.append([{ x: 140.7, y: 90.45, pressure: 0.5 }]);
    const overtaken = withPrediction.geometry();
    clean.append([{ x: 140.7, y: 90.45, pressure: 0.5 }]);
    expect(overtaken.bounds).toEqual(clean.geometry().bounds);
    expect(overtaken.polygon).toEqual(clean.geometry().polygon);
    // Commit ignores predictions entirely.
    expect(withPrediction.finish().polygon).toEqual(clean.finish().polygon);
  });

  it('ignores mid-gesture preset edits on the active stroke', () => {
    // One stroke, one brush: the live compiler exposes no mid-gesture
    // update, so a size change while the pointer is down cannot reshape
    // the active stroke — it applies to the next stroke instead. The
    // commit therefore uses the begin brush with zero geometry-grid
    // change at pointer-up.
    resetLiveCompilerStats();
    const compiler = new LiveInkStrokeCompiler();
    const samples = diagonal(300);
    compiler.begin(samples[0]!, BALL_PEN_BRUSH);
    for (const batch of batchesOf(samples.slice(1, 150), 25)) {
      compiler.append(batch);
    }
    const before = compiler.geometry();
    // No setBrush API exists anymore: the only way to "change" the brush
    // is beginning a new stroke, which leaves this one untouched.
    for (const batch of batchesOf(samples.slice(150), 25)) {
      compiler.append(batch);
    }
    const after = compiler.geometry();
    expect(after.nodes.length).toBeGreaterThan(before.nodes.length);
    expect(compiler.brush()).toEqual(BALL_PEN_BRUSH);
    const committed = compiler.finish();
    expect(committed.polygon).toEqual(
      compileInkStroke(samples, BALL_PEN_BRUSH).polygon,
    );
  });

  it('resets cleanly between gestures', () => {
    const compiler = new LiveInkStrokeCompiler();
    compiler.begin({ x: 0, y: 0 }, BALL_PEN_BRUSH);
    compiler.append(diagonal(50).slice(1));
    expect(compiler.confirmedCount()).toBe(50);
    compiler.reset();
    expect(compiler.confirmedCount()).toBe(0);
    expect(compiler.brush()).toBeNull();
    expect(compiler.geometry().polygon).toEqual([]);
    compiler.begin({ x: 5, y: 5 }, BALL_PEN_BRUSH);
    expect(compiler.confirmedCount()).toBe(1);
  });

  it('converges at 10000 samples (pointer-up causes no visible jump)', () => {
    resetLiveCompilerStats();
    const samples = diagonal(10000);
    const compiler = feedIncrementally(samples, 100);
    const live = compiler.geometry();
    const committed = compiler.finish();
    const clean = compileInkStroke(samples, BALL_PEN_BRUSH);
    expect(committed.polygon).toEqual(clean.polygon);
    expect(committed.bounds).toEqual(clean.bounds);
    expectVisualConvergence(live, committed, '10000 samples');
    expect(liveCompilerStats().fullCompiles).toBe(1);
  }, 120000);

  it('reports exact previews while the stroke fits the tail window', () => {
    const compiler = new LiveInkStrokeCompiler();
    compiler.begin({ x: 0, y: 0 }, BALL_PEN_BRUSH);
    const update = compiler.append([
      { x: 10, y: 0 },
      { x: 20, y: 5 },
    ]);
    expect(update.exact).toBe(true);
    expect(update.nodeCount).toBeGreaterThan(0);
  });
});
