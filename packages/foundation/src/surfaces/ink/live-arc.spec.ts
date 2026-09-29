/**
 * Live/committed arc unification: batch and incremental tessellation must
 * resolve taper from the same faired-control coordinate system (same
 * controls, same cumulative arc, same total). The live compiler used to
 * maintain a pre-fair stabilized arc as the taper denominator while the
 * numerator came from faired/B-spline controls — structurally wrong even
 * where the nib-relative taper cap hid the visual error. Both paths now
 * read the builder-owned faired arc, and frozen start-zone head widths
 * refresh against the settling running total (bounded by the nib-relative
 * cap) instead of keeping small-total fractional values.
 *
 * Comparisons are arc-aligned, never node-indexed: live and committed
 * tessellation may subdivide the same centerline differently (extra nodes
 * on the curve are correct, not error).
 */

import { describe, expect, it } from 'vitest';
import { BALL_PEN_BRUSH, brushPresetForKind } from './brush.js';
import { compileInkStroke } from './compiler.js';
import {
  controlArcLengths,
  InkCurveBuilder,
  type InkCurveControl,
} from './curve.js';
import {
  LiveInkStrokeCompiler,
  liveCompilerStats,
  resetLiveCompilerStats,
} from './live-compiler.js';
import { longHandwriting, sCurve } from './fixtures.js';
import type { InkSample } from '../model.js';

function feed(
  samples: InkSample[],
  batchSize: number,
  brush = BALL_PEN_BRUSH,
): LiveInkStrokeCompiler {
  const compiler = new LiveInkStrokeCompiler();
  compiler.begin(samples[0]!, brush);
  for (let i = 1; i < samples.length; i += batchSize) {
    compiler.append(samples.slice(i, i + batchSize));
  }
  return compiler;
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

describe('live/committed arc unification', () => {
  it('exposes the builder arc over pushed controls exactly', () => {
    const controls: InkCurveControl[] = [];
    for (let i = 0; i < 40; i++) {
      controls.push({
        x: i * 1.3,
        y: Math.sin(i / 5) * 4,
        pressure: 0.5,
        tiltX: null,
        tiltY: null,
        twist: null,
        dt: i * 8,
      });
    }
    const builder = new InkCurveBuilder();
    for (const c of controls) builder.push(c);
    const expected = controlArcLengths(controls);
    const owned = builder.controlArcLengths();
    expect(owned.length).toBe(expected.cumulative.length);
    for (let i = 0; i < expected.cumulative.length; i++) {
      expect(owned[i]).toBe(expected.cumulative[i]);
    }
    expect(builder.controlTotal()).toBe(expected.total);
  });

  it('shares one total: live and committed totals agree exactly', () => {
    const brush = brushPresetForKind('brush');
    for (const samples of [sCurve(), longHandwriting(600)]) {
      const compiler = feed(samples, 25, brush);
      const live = compiler.geometry();
      const committed = compiler.finish();
      const liveTotal = live.nodes[live.nodes.length - 1]!.controlArc;
      const commitTotal =
        committed.nodes[committed.nodes.length - 1]!.controlArc;
      // Same coordinate system: millesimal agreement (the last tip node
      // carries provisional-tip float noise ~1e-5; the pre-fix
      // pre-fair/post-fair skew reached several surface units).
      expect(Math.abs(liveTotal - commitTotal)).toBeLessThan(1e-3);
    }
  });

  it('agrees arc-aligned on taper width with streamline fairing', () => {
    // Brush pen: streamline 0.5 (strong fairing) + fractional taper zones.
    const brush = brushPresetForKind('brush');
    expect(brush.streamline).toBeGreaterThan(0);
    const samples = sCurve();
    const compiler = feed(samples, 7, brush);
    const live = compiler.geometry();
    const committed = compiler.finish();
    const lo = 0;
    const hi =
      Math.min(
        live.nodes[live.nodes.length - 1]!.controlArc,
        committed.nodes[committed.nodes.length - 1]!.controlArc,
      ) * 0.95;
    let worst = 0;
    for (let k = 0; k <= 200; k++) {
      const arc = lo + ((hi - lo) * k) / 200;
      worst = Math.max(
        worst,
        Math.abs(widthAt(live.nodes, arc) - widthAt(committed.nodes, arc)),
      );
    }
    // Same coordinate system: sub-hundredth agreement (was ~1.5 with the
    // pre-fair denominator skew).
    expect(worst).toBeLessThan(0.05);
  });

  it('holds on curved long strokes with strong fairing', () => {
    const brush = { ...brushPresetForKind('brush'), streamline: 0.8 };
    const samples = longHandwriting(1200);
    const compiler = feed(samples, 50, brush);
    const live = compiler.geometry();
    const committed = compiler.finish();
    const clean = compileInkStroke(samples, brush);
    expect(committed.polygon).toEqual(clean.polygon);
    // Start-zone head widths track the settling total: the systematic
    // small-total skew (measured 0.39 pre-fix) is gone.
    const hi =
      Math.min(
        live.nodes[live.nodes.length - 1]!.controlArc,
        committed.nodes[committed.nodes.length - 1]!.controlArc,
      ) * 0.95;
    let worst = 0;
    for (let k = 0; k <= 200; k++) {
      const arc = (hi * k) / 200;
      worst = Math.max(
        worst,
        Math.abs(widthAt(live.nodes, arc) - widthAt(committed.nodes, arc)),
      );
    }
    expect(worst).toBeLessThan(0.05);
  });

  it('keeps head width refreshes bounded by the nib-relative cap', () => {
    resetLiveCompilerStats();
    const brush = brushPresetForKind('brush');
    const samples = longHandwriting(1200);
    const compiler = feed(samples, 50, brush);
    compiler.geometry();
    const { headWidthRefreshes, headWidthNodes, tailUpdates } =
      liveCompilerStats();
    expect(tailUpdates).toBeGreaterThan(0);
    // Refresh work scales with appends × cap-bounded zone width — never
    // with stroke length.
    expect(headWidthNodes).toBeLessThan(tailUpdates * 64);
    expect(headWidthRefreshes).toBeLessThanOrEqual(tailUpdates);
  });
});
