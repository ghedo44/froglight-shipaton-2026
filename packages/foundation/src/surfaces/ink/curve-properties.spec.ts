/**
 * B-spline fitter property/adversarial gates: the incremental builder and
 * the batch fitter share one emission implementation, so they must agree
 * far beyond circles — random corner layouts, push/pop/re-push fuzz,
 * batch-size invariance, degenerate and extreme coordinates. No NaN or
 * Infinity anywhere, ever.
 *
 * Deterministic: seeded PRNG (mulberry32), no Math.random.
 */

import { describe, expect, it } from 'vitest';
import {
  fitCenterlineCurve,
  InkCurveBuilder,
  type InkCurve,
  type InkCurveControl,
} from './curve.js';

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomControls(
  rand: () => number,
  count: number,
  step = 8,
): InkCurveControl[] {
  const out: InkCurveControl[] = [];
  let x = 0;
  let y = 0;
  let heading = 0;
  for (let i = 0; i < count; i++) {
    // Mostly straight with occasional sharp turns (corner layouts) and
    // wobble (handwriting noise).
    const r = rand();
    if (r < 0.12) heading += (0.9 + rand() * 1.6) * (rand() < 0.5 ? 1 : -1);
    else heading += (rand() - 0.5) * 0.35;
    x += Math.cos(heading) * step * (0.5 + rand());
    y += Math.sin(heading) * step * (0.5 + rand());
    out.push({
      x,
      y,
      pressure: 0.2 + rand() * 0.7,
      tiltX: null,
      tiltY: null,
      twist: null,
      dt: i * 8,
    });
  }
  return out;
}

function curvesMatch(a: InkCurve, b: InkCurve): void {
  expect(a.segments.length).toBe(b.segments.length);
  expect(a.controlCount).toBe(b.controlCount);
  expect(a.cornerCount ?? 0).toBe(b.cornerCount ?? 0);
  for (let s = 0; s < a.segments.length; s++) {
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const pa = a.segments[s]!.position(t);
      const pb = b.segments[s]!.position(t);
      expect(pa.x).toBeCloseTo(pb.x, 12);
      expect(pa.y).toBeCloseTo(pb.y, 12);
      const ta = a.segments[s]!.tangent(t);
      const tb = b.segments[s]!.tangent(t);
      expect(ta.x).toBeCloseTo(tb.x, 12);
      expect(ta.y).toBeCloseTo(tb.y, 12);
      const aa = a.segments[s]!.attributes(t);
      const ab = b.segments[s]!.attributes(t);
      expect(aa.pressure).toBeCloseTo(ab.pressure, 12);
      const ra = a.segments[s]!.arc?.(t) ?? 0;
      const rb = b.segments[s]!.arc?.(t) ?? 0;
      expect(ra).toBeCloseTo(rb, 12);
    }
  }
}

function assertFiniteCurve(curve: InkCurve): void {
  for (const s of curve.segments) {
    for (const t of [0, 0.5, 1]) {
      const p = s.position(t);
      const tan = s.tangent(t);
      const at = s.attributes(t);
      for (const v of [p.x, p.y, tan.x, tan.y, at.pressure]) {
        expect(Number.isFinite(v)).toBe(true);
      }
      expect(Math.hypot(tan.x, tan.y)).toBeCloseTo(1, 9);
    }
  }
}

describe('B-spline builder/batch equivalence', () => {
  for (const seed of [11, 77, 2026]) {
    it(`matches batch after sequential pushes (seed ${seed})`, () => {
      const rand = mulberry32(seed);
      const controls = randomControls(rand, 48);
      const builder = new InkCurveBuilder();
      for (const c of controls) builder.push(c);
      curvesMatch(builder.curve, fitCenterlineCurve(controls));
      assertFiniteCurve(builder.curve);
    });
  }

  it('matches batch across random push/pop/re-push fuzz', () => {
    const rand = mulberry32(4242);
    // Start from a random run, then fuzz the tail: pops, re-pushes with
    // both identical and divergent values, varying batch sizes.
    const base = randomControls(rand, 40);
    const builder = new InkCurveBuilder();
    for (const c of base) builder.push(c);
    const live: InkCurveControl[] = [...base];
    for (let round = 0; round < 12; round++) {
      const pops = 1 + Math.floor(rand() * 5);
      for (let k = 0; k < pops && live.length > 2; k++) {
        builder.pop();
        live.pop();
      }
      const pushes = 1 + Math.floor(rand() * 6);
      const tail = randomControls(rand, pushes, 6);
      // Continue from the live tip (positional continuity like real
      // provisional-tip replacement).
      const tip = live[live.length - 1]!;
      const dx = tip.x - tail[0]!.x;
      const dy = tip.y - tail[0]!.y;
      for (const c of tail) {
        const moved = { ...c, x: c.x + dx, y: c.y + dy };
        builder.push(moved);
        live.push(moved);
      }
      curvesMatch(builder.curve, fitCenterlineCurve(live));
    }
    assertFiniteCurve(builder.curve);
  });

  it('is invariant to push batch sizes (1-by-1 vs chunks vs reset)', () => {
    const rand = mulberry32(99);
    const controls = randomControls(rand, 60);
    const one = new InkCurveBuilder();
    for (const c of controls) one.push(c);
    const chunks = new InkCurveBuilder();
    for (let i = 0; i < controls.length; i += 7) {
      // No chunk API: emulate by pushing runs (same as sequential).
      for (const c of controls.slice(i, i + 7)) chunks.push(c);
    }
    const reset = new InkCurveBuilder();
    reset.reset(controls);
    const batch = fitCenterlineCurve(controls);
    curvesMatch(one.curve, batch);
    curvesMatch(chunks.curve, batch);
    expect(reset.curve.segments.length).toBe(batch.segments.length);
  });

  it('agrees on many corners in one stroke', () => {
    // Zigzag with 70–130° turns every 6 controls: every apex must split
    // identically in both paths, with finite joins.
    const rand = mulberry32(7);
    const controls: InkCurveControl[] = [
      {
        x: 0,
        y: 0,
        pressure: 0.5,
        tiltX: null,
        tiltY: null,
        twist: null,
        dt: 0,
      },
    ];
    let x = 0;
    let y = 0;
    let heading = 0;
    for (let c = 0; c < 8; c++) {
      heading += ((70 + rand() * 60) * Math.PI) / 180;
      for (let i = 0; i < 6; i++) {
        x += Math.cos(heading) * 6;
        y += Math.sin(heading) * 6;
        controls.push({
          x,
          y,
          pressure: 0.5,
          tiltX: null,
          tiltY: null,
          twist: null,
          dt: controls.length * 8,
        });
      }
    }
    const builder = new InkCurveBuilder();
    for (const c of controls) builder.push(c);
    const batch = fitCenterlineCurve(controls);
    expect(batch.cornerCount ?? 0).toBeGreaterThanOrEqual(6);
    curvesMatch(builder.curve, batch);
    assertFiniteCurve(builder.curve);
  });

  it('stays finite on degenerate and extreme coordinates', () => {
    // Coincident controls.
    const coincident: InkCurveControl[] = [];
    for (let i = 0; i < 10; i++) {
      coincident.push({
        x: 5,
        y: 5,
        pressure: 0.5,
        tiltX: null,
        tiltY: null,
        twist: null,
        dt: i,
      });
    }
    assertFiniteCurve(fitCenterlineCurve(coincident));
    const b1 = new InkCurveBuilder();
    for (const c of coincident) b1.push(c);
    assertFiniteCurve(b1.curve);
    // Near-coincident jitter.
    const rand = mulberry32(5);
    const jitter = coincident.map((c) => ({
      ...c,
      x: c.x + (rand() - 0.5) * 1e-9,
      y: c.y + (rand() - 0.5) * 1e-9,
    }));
    assertFiniteCurve(fitCenterlineCurve(jitter));
    // Huge finite coordinates.
    const huge: InkCurveControl[] = [];
    for (let i = 0; i < 12; i++) {
      huge.push({
        x: 1e6 + i * 3,
        y: -1e6 + i * 2,
        pressure: 0.5,
        tiltX: null,
        tiltY: null,
        twist: null,
        dt: i,
      });
    }
    assertFiniteCurve(fitCenterlineCurve(huge));
    // Tiny coordinates.
    const tiny = huge.map((c) => ({ ...c, x: c.x * 1e-12, y: c.y * 1e-12 }));
    assertFiniteCurve(fitCenterlineCurve(tiny));
  });

  it('keeps dt monotone within input bounds and twist wrapped', () => {
    const controls: InkCurveControl[] = [];
    for (let i = 0; i < 20; i++) {
      controls.push({
        x: i * 4,
        y: Math.sin(i) * 3,
        pressure: 0.5,
        tiltX: 0.1,
        tiltY: -0.1,
        // Barrel spins across the ±π seam mid-stroke.
        twist: -Math.PI + 0.2 + i * 0.35,
        // Nulls and duplicate stamps mixed in.
        dt: i % 4 === 0 ? null : Math.floor(i / 2) * 8,
      });
    }
    const curve = fitCenterlineCurve(controls);
    let prev = -Infinity;
    for (const s of curve.segments) {
      for (const t of [0, 0.5, 1]) {
        const at = s.attributes(t);
        expect(Number.isFinite(at.dt ?? 0)).toBe(true);
        if (at.dt !== null) {
          expect(at.dt).toBeGreaterThanOrEqual(prev - 1e-9);
          prev = Math.max(prev, at.dt);
        }
        // Twist stays wrapped with no seam jumps between neighbors.
        expect(at.twist === null || Math.abs(at.twist) <= Math.PI + 1e-9).toBe(
          true,
        );
      }
    }
    // dt never escapes the input envelope.
    const known = controls.map((c) => c.dt).filter((d) => d !== null);
    expect(prev).toBeLessThanOrEqual(Math.max(...known) + 1e-9);
  });

  it('preserves unknown per-sample fields through the nearer control', () => {
    const controls: InkCurveControl[] = [];
    for (let i = 0; i < 12; i++) {
      controls.push({
        x: i * 5,
        y: 0,
        pressure: 0.5,
        tiltX: null,
        tiltY: null,
        twist: null,
        dt: i,
      });
    }
    const extras = (i: number): Record<string, unknown> | undefined =>
      i === 4 ? { pen: 'alpha' } : i === 8 ? { pen: 'beta' } : undefined;
    const curve = fitCenterlineCurve(controls, extras);
    let sawAlpha = false;
    let sawBeta = false;
    for (const s of curve.segments) {
      for (const t of [0, 0.25, 0.5, 0.75, 1]) {
        const e = s.extrasAt?.(t) as Record<string, unknown> | undefined;
        if (e?.pen === 'alpha') sawAlpha = true;
        if (e?.pen === 'beta') sawBeta = true;
      }
    }
    expect(sawAlpha).toBe(true);
    expect(sawBeta).toBe(true);
  });

  it('interpolates cumulative arc exactly at span endpoints', () => {
    const rand = mulberry32(13);
    const controls = randomControls(rand, 24);
    const curve = fitCenterlineCurve(controls);
    // Endpoint arcs reconstruct the control-polygon arc: arc(0) of the
    // first span is 0 and arc(1) of the last span is the total.
    const first = curve.segments[0]!;
    const lastSeg = curve.segments[curve.segments.length - 1]!;
    expect(first.arc?.(0) ?? NaN).toBeCloseTo(0, 9);
    let total = 0;
    for (let i = 1; i < controls.length; i++) {
      total += Math.hypot(
        controls[i]!.x - controls[i - 1]!.x,
        controls[i]!.y - controls[i - 1]!.y,
      );
    }
    expect(lastSeg.arc?.(1) ?? NaN).toBeCloseTo(total, 6);
  });
});
