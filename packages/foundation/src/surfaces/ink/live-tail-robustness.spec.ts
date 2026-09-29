/**
 * Live tail robustness: splice coverage on large per-append batches plus
 * width convergence on long strokes.
 *
 * Two length-scaling live-preview defects lived here:
 *
 * 1. Span stranding: the tail splice re-tessellated a fixed offset from
 *    the stroke end, so any append adding more spans than the window left
 *    whole span ranges untessellated — holes and jump lines in the preview
 *    that only the commit repaired. The splice now tracks the published
 *    frontier, so growth of any size stays fully covered.
 * 2. Frozen taper widths: fractional tip-taper zones grow with total
 *    length while frozen head nodes keep early small-total widths, so long
 *    previews rendered dramatically thinner than their commits. Taper
 *    zones are now nib-relative and capped, inside the bounded tail
 *    refresh horizon, and frozen start-zone head widths refresh against
 *    the settling total.
 *
 * Tolerances are screen-derived (0.5px at 8x zoom = 0.0625 surface
 * units), matching the convergence gates.
 */

import { describe, expect, it } from 'vitest';
import { BALL_PEN_BRUSH } from './brush.js';
import { compileInkStroke } from './compiler.js';
import {
  LiveInkStrokeCompiler,
  liveCompilerStats,
  resetLiveCompilerStats,
} from './live-compiler.js';
import type { InkSample } from '../model.js';
import type { Point } from '../geometry.js';

/** Visual budget: 0.5 screen px at 8x zoom, in surface units. */
const VISUAL_BUDGET = 0.5 / 8;

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

function directedHausdorff(
  from: readonly Point[],
  to: readonly Point[],
): number {
  if (from.length === 0 || to.length === 0) return Infinity;
  let worst = 0;
  const step = Math.max(1, Math.floor(from.length / 400));
  for (let i = 0; i < from.length; i += step) {
    worst = Math.max(worst, distToRing(from[i]!, to));
  }
  return worst;
}

function longMixedStroke(): InkSample[] {
  const out: InkSample[] = [];
  let dt = 0;
  for (let rep = 0; rep < 8; rep++) {
    const baseX = rep * 260;
    for (let i = 0; i < 160; i++) {
      const t = i / 159;
      out.push({
        x: baseX + t * 200,
        y: 100 + Math.sin(t * Math.PI * 2 + rep * 0.8) * 30,
        pressure: 0.5 + Math.sin(i / 17) * 0.08,
        dt,
      });
      dt += 8;
    }
    for (let i = 1; i <= 24; i++) {
      out.push({ x: baseX + 200, y: 100 + i * 3, pressure: 0.5, dt });
      dt += 8;
    }
  }
  return out;
}

describe('live splice robustness on large batches', () => {
  for (const batchSize of [50, 100, 200]) {
    it(`covers every span at batch size ${batchSize} (no holes, no jump lines)`, () => {
      // NOTE: edge-to-edge Hausdorff over multi-thousand-vertex rings is
      // honest verification work; the 60s timeout below is headroom for
      // loaded runners (same precedent as the 5k/10k convergence gates).
      resetLiveCompilerStats();
      const samples = longMixedStroke();
      const compiler = new LiveInkStrokeCompiler();
      compiler.begin(samples[0]!, BALL_PEN_BRUSH);
      for (let i = 1; i < samples.length; i += batchSize) {
        compiler.append(samples.slice(i, i + batchSize));
        const live = compiler.geometry();
        // Never blank mid-gesture, never non-finite.
        expect(live.polygon.length).toBeGreaterThan(0);
        for (const p of live.polygon) {
          expect(Number.isFinite(p.x)).toBe(true);
          expect(Number.isFinite(p.y)).toBe(true);
        }
      }
      const live = compiler.geometry();
      const committed = compiler.finish();
      const clean = compileInkStroke(samples, BALL_PEN_BRUSH);
      expect(committed.polygon).toEqual(clean.polygon);
      // Live covers the same ink (no stranded spans): tight in both
      // directions at the visual budget, plus symmetric bounds agreement
      // (spike-proof extremes).
      expect(directedHausdorff(live.polygon, committed.polygon)).toBeLessThan(
        VISUAL_BUDGET,
      );
      expect(directedHausdorff(committed.polygon, live.polygon)).toBeLessThan(
        VISUAL_BUDGET,
      );
      expect(Math.abs(live.bounds.x - committed.bounds.x)).toBeLessThan(
        VISUAL_BUDGET,
      );
      expect(
        Math.abs(
          live.bounds.x +
            live.bounds.width -
            committed.bounds.x -
            committed.bounds.width,
        ),
      ).toBeLessThan(VISUAL_BUDGET);
      expect(liveCompilerStats().fullCompiles).toBe(1);
    }, 60000);
  }
});

describe('live width convergence on long strokes', () => {
  it('keeps frozen head widths at commit widths (no thin preview)', () => {
    const out: InkSample[] = [];
    for (let i = 0; i < 2500; i++) {
      out.push({
        x: i * 1.2,
        y: 100 + Math.sin(i / 40) * 20,
        pressure: 0.55,
        dt: i * 8,
      });
    }
    const compiler = new LiveInkStrokeCompiler();
    compiler.begin(out[0]!, BALL_PEN_BRUSH);
    for (let i = 1; i < out.length; i += 50) {
      compiler.append(out.slice(i, i + 50));
    }
    const live = compiler.geometry();
    const committed = compiler.finish();
    const ln = live.nodes;
    const cn = committed.nodes;
    // Same spine density live and committed (no stranded spans).
    expect(Math.abs(ln.length - cn.length)).toBeLessThanOrEqual(
      Math.ceil(cn.length * 0.05),
    );
    // Frozen head (first 90% by arc) matches commit widths within the
    // visual budget in absolute units; the transient tip region converges
    // at finish(). Arc-aligned (never node-indexed: tessellation may
    // subdivide the same centerline differently).
    const hi =
      Math.min(ln[ln.length - 1]!.controlArc, cn[cn.length - 1]!.controlArc) *
      0.9;
    const widthAt = (
      nodes: readonly { controlArc: number; width: number }[],
      arc: number,
    ): number => {
      if (arc <= nodes[0]!.controlArc) return nodes[0]!.width;
      for (let k = 1; k < nodes.length; k++) {
        if (nodes[k]!.controlArc >= arc) {
          const a = nodes[k - 1]!;
          const b = nodes[k]!;
          const t =
            b.controlArc > a.controlArc
              ? (arc - a.controlArc) / (b.controlArc - a.controlArc)
              : 0;
          return a.width + (b.width - a.width) * t;
        }
      }
      return nodes[nodes.length - 1]!.width;
    };
    expect(hi).toBeGreaterThan(100);
    let thin = 0;
    for (let k = 0; k <= 100; k++) {
      const arc = (hi * k) / 100;
      const dw = Math.abs(widthAt(ln, arc) - widthAt(cn, arc));
      expect(dw).toBeLessThan(VISUAL_BUDGET);
      if (widthAt(ln, arc) < widthAt(cn, arc) - VISUAL_BUDGET) thin++;
    }
    expect(thin).toBe(0);
  });
});
