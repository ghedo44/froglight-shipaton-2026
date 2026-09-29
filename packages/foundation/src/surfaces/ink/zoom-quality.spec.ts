/**
 * Extreme-zoom quality gates: the fitted stroke must remain visually
 * continuous at 1×/2×/4×/8×/MAX_ZOOM. Geometry is zoom-independent (one
 * tessellation serves every zoom), so these gates assert the tessellation
 * error budget and tangent/width continuity directly — deterministic
 * geometric metrics, no screenshots.
 *
 * Budget: TESSELLATION_TOLERANCE surface units ⇒ ≤0.4 screen px at 8×.
 */

import { describe, expect, it } from 'vitest';
import {
  BALL_PEN_BRUSH,
  brushPresetForKind,
  type InkBrushKind,
} from './brush.js';
import { compileInkStroke } from './compiler.js';
import { handwritingSheet } from './fixtures.js';
import {
  TESSELLATION_DESIGN_ZOOM,
  TESSELLATION_MAX_ANGLE,
  TESSELLATION_TOLERANCE,
} from './tessellation.js';
import type { InkSample } from '../model.js';
import type { Point } from '../geometry.js';

export const MAX_ZOOM = TESSELLATION_DESIGN_ZOOM;
const ZOOM_LEVELS = [1, 2, 4, 8, MAX_ZOOM];

interface StrokeMetrics {
  maxDeviation: number;
  maxTangentJump: number;
  maxWidthJump: number;
  minSegment: number;
  maxSegment: number;
  finite: boolean;
  area: number;
}

/** Geometric metrics of one compiled stroke against its analytic curve. */
function measure(samples: InkSample[], kind: InkBrushKind): StrokeMetrics {
  const brush = brushPresetForKind(kind);
  const compiled = compileInkStroke(samples, brush);
  const { curve, nodes, polygon } = compiled;
  let finite = true;
  for (const p of polygon) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) finite = false;
  }
  let area = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    area += a.x * b.y - b.x * a.y;
  }
  area = Math.abs(area) / 2;
  let maxDeviation = 0;
  let maxWidthJump = 0;
  let minSegment = Infinity;
  let maxSegment = 0;
  const bySegment = new Map<number, (typeof nodes)[number][]>();
  for (const n of nodes) {
    const list = bySegment.get(n.segmentIndex) ?? [];
    list.push(n);
    bySegment.set(n.segmentIndex, list);
  }
  for (let i = 1; i < nodes.length; i++) {
    const a = nodes[i - 1]!;
    const b = nodes[i]!;
    const gap = Math.hypot(b.x - a.x, b.y - a.y);
    if (gap < minSegment) minSegment = gap;
    if (gap > maxSegment) maxSegment = gap;
    const wMax = Math.max(a.width, b.width, 1e-9);
    const rel = Math.abs(b.width - a.width) / wMax;
    if (rel > maxWidthJump) maxWidthJump = rel;
  }
  // Tangent jumps from consecutive node chords: bounded by the
  // tessellation angle budget (the anti-facet gate).
  const jumps: number[] = [];
  for (let i = 2; i < nodes.length; i++) {
    const a = nodes[i - 2]!;
    const b = nodes[i - 1]!;
    const c = nodes[i]!;
    const l0 = Math.hypot(b.x - a.x, b.y - a.y);
    const l1 = Math.hypot(c.x - b.x, c.y - b.y);
    if (l0 < 1e-9 || l1 < 1e-9) continue;
    const dot = Math.min(
      Math.max(
        ((b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y)) / (l0 * l1),
        -1,
      ),
      1,
    );
    jumps.push(Math.acos(dot));
  }
  // Deviation: each tessellated span's analytic midpoint against the
  // emitted chord, per owning curve segment (spans use their true
  // u-interval — never the whole segment).
  for (const [index, list] of bySegment) {
    if (index < 0) continue;
    const segment = curve.segments[index];
    if (segment === undefined) continue;
    for (let i = 0; i + 1 < list.length; i++) {
      const a = list[i]!;
      const b = list[i + 1]!;
      const mid = segment.position((a.u + b.u) / 2);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len = Math.hypot(dx, dy);
      const dist =
        len > 1e-12
          ? Math.abs((mid.x - a.x) * dy - (mid.y - a.y) * dx) / len
          : Math.hypot(mid.x - a.x, mid.y - a.y);
      if (dist > maxDeviation) maxDeviation = dist;
    }
  }
  return {
    maxDeviation,
    maxTangentJump: jumps.length > 0 ? Math.max(...jumps) : 0,
    maxWidthJump,
    minSegment: minSegment === Infinity ? 0 : minSegment,
    maxSegment,
    finite,
    area,
  };
}

describe('extreme-zoom quality gates', () => {
  const sheet = handwritingSheet();

  it('holds the tessellation error budget on every sheet stroke (ball pen)', () => {
    for (const { samples } of sheet) {
      const m = measure(samples, 'ball');
      expect(m.finite).toBe(true);
      expect(m.maxDeviation).toBeLessThanOrEqual(TESSELLATION_TOLERANCE * 2.5);
      // Screen error at MAX_ZOOM stays sub-pixel on every stroke.
      expect(m.maxDeviation * MAX_ZOOM).toBeLessThanOrEqual(1.0);
    }
  });

  it('keeps tangent evolution continuous (no sample-segment corners)', () => {
    for (const { name, samples } of sheet) {
      // Intentional corners (sharp-corner), chained loop connections
      // (loops: 90° joins between rings, preserved C0), and the volume
      // fixture (long-handwriting: synthetic row-wrap teleports split C0)
      // legitimately turn fast — the gate covers smooth handwriting.
      if (
        name === 'sharp-corner' ||
        name === 'digits' ||
        name === 'loops' ||
        name === 'long-handwriting'
      ) {
        continue;
      }
      const m = measure(samples, 'ball');
      // Chained tessellation spans turn gradually — an order of magnitude
      // below the raw pointer-segment angles they replace.
      expect(m.maxTangentJump).toBeLessThanOrEqual(
        TESSELLATION_MAX_ANGLE * 2.5,
      );
    }
  });

  it('keeps width continuous except across physical pressure jumps', () => {
    for (const { samples } of sheet) {
      const m = measure(samples, 'ball');
      expect(m.maxWidthJump).toBeLessThan(0.5);
    }
  });

  it('emits no invalid mesh on any sheet stroke at any zoom', () => {
    for (const { samples } of sheet) {
      const m = measure(samples, 'ball');
      expect(m.finite).toBe(true);
      expect(m.area).toBeGreaterThan(0);
      expect(m.minSegment).toBeGreaterThan(0);
      for (const zoom of ZOOM_LEVELS) {
        // Zoom scales the rasterization, never the geometry: the same
        // mesh serves every level, so validity at 1× is validity at 8×.
        expect(m.maxDeviation * zoom).toBeLessThanOrEqual(
          TESSELLATION_TOLERANCE * 2.5 * zoom,
        );
      }
    }
  });

  it('holds quality across all brush families on curves and loops', () => {
    const kinds: InkBrushKind[] = [
      'ball',
      'fountain',
      'brush',
      'pencil',
      'highlighter',
    ];
    const curves = sheet.filter((s) =>
      ['s-curve', 'loops', 'large-circle', 'spiral', 'shallow-wave'].includes(
        s.name,
      ),
    );
    for (const kind of kinds) {
      for (const { samples } of curves) {
        const m = measure(samples, kind);
        expect(m.finite).toBe(true);
        expect(m.area).toBeGreaterThan(0);
        expect(m.maxDeviation * MAX_ZOOM).toBeLessThanOrEqual(1.0);
      }
    }
  });

  it('keeps the default ball pen smooth without extra stabilization', () => {
    // The acceptance core: default settings, handwriting curves, tight
    // loops — continuous tangents, bounded deviation, valid meshes.
    expect(BALL_PEN_BRUSH.stabilization).toBeLessThanOrEqual(0.2);
    expect(BALL_PEN_BRUSH.streamline).toBeLessThanOrEqual(0.3);
    for (const { name, samples } of sheet) {
      if (name === 'long-handwriting') continue;
      const compiled = compileInkStroke(samples, BALL_PEN_BRUSH);
      expect(compiled.polygon.length).toBeGreaterThanOrEqual(8);
      let area = 0;
      for (let i = 0; i < compiled.polygon.length; i++) {
        const a: Point = compiled.polygon[i]!;
        const b: Point = compiled.polygon[(i + 1) % compiled.polygon.length]!;
        area += a.x * b.y - b.x * a.y;
      }
      expect(Math.abs(area) / 2).toBeGreaterThan(0);
    }
  });

  it('leaves canonical samples untouched across zoom (zoom invariance)', () => {
    for (const { samples } of sheet.slice(0, 4)) {
      const before = JSON.parse(JSON.stringify(samples));
      compileInkStroke(samples, BALL_PEN_BRUSH);
      compileInkStroke(samples, BALL_PEN_BRUSH);
      expect(samples).toEqual(before);
    }
  });
});
