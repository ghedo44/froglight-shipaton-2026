/**
 * Outline mesh gates: nib response, caps, high-curvature joins, and the
 * absence of invalid geometry (NaN, spikes, holes, flipped runs).
 */

import { describe, expect, it } from 'vitest';
import {
  BALL_PEN_BRUSH,
  HIGHLIGHTER_BRUSH,
  resolveBrushSpec,
} from './brush.js';
import { compileInkStroke } from './compiler.js';
import { buildStrokeMesh } from './outline.js';
import { boundsOfPoints } from './bounds.js';
import { sharpCorner, sCurve } from './fixtures.js';
import type { TessellatedSpinePoint } from './tessellation.js';
import type { InkSample } from '../model.js';
import type { Point } from '../geometry.js';

function spinePoint(
  x: number,
  y: number,
  tx: number,
  ty: number,
  width: number,
): TessellatedSpinePoint {
  return {
    x,
    y,
    tx,
    ty,
    width,
    pressure: 0.5,
    tiltX: null,
    tiltY: null,
    twist: null,
    dt: null,
    extras: {},
    controlArc: x,
    segmentIndex: 0,
    u: 0.5,
  };
}

function straightSpine(width = 4, n = 5): TessellatedSpinePoint[] {
  return Array.from({ length: n }, (_, i) =>
    spinePoint(i * 10, 0, 1, 0, width),
  );
}

function polygonArea(polygon: readonly Point[]): number {
  let area = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    area += a.x * b.y - b.x * a.y;
  }
  return Math.abs(area) / 2;
}

function expectValidRing(ring: readonly Point[], minArea = 0): void {
  expect(ring.length).toBeGreaterThanOrEqual(3);
  for (const p of ring) {
    expect(Number.isFinite(p.x)).toBe(true);
    expect(Number.isFinite(p.y)).toBe(true);
  }
  expect(polygonArea(ring)).toBeGreaterThan(minArea);
}

describe('outline mesh', () => {
  it('builds a closed filled ring with round caps', () => {
    const mesh = buildStrokeMesh(straightSpine(), 'round');
    expect(mesh.left).toHaveLength(5);
    expect(mesh.right).toHaveLength(5);
    expectValidRing(mesh.ring, 10);
    // Round caps extend past the endpoints by the nib radius.
    const bounds = boundsOfPoints(mesh.ring);
    expect(bounds.x).toBeCloseTo(-2, 6);
    expect(bounds.x + bounds.width).toBeCloseTo(42, 6);
  });

  it('ends marker ribbons flush with butt caps', () => {
    const mesh = buildStrokeMesh(straightSpine(14, 3), 'butt');
    expectValidRing(mesh.ring, 10);
    const bounds = boundsOfPoints(mesh.ring);
    expect(bounds.x).toBeCloseTo(0, 6);
    expect(bounds.x + bounds.width).toBeCloseTo(20, 6);
    expect(bounds.height).toBeCloseTo(14, 6);
  });

  it('miters ordinary corners crisply (faithful sharp handwriting)', () => {
    // 90° turn with unit tangents: true miter extends 1/cos(45°) ≈ 1.41×.
    const spine = [
      spinePoint(0, 0, 1, 0, 4),
      spinePoint(10, 0, Math.SQRT1_2, Math.SQRT1_2, 4),
      spinePoint(20, 10, 0, 1, 4),
    ];
    const mesh = buildStrokeMesh(spine, 'butt');
    expectValidRing(mesh.ring, 10);
    expect(mesh.leftFans.size).toBe(0);
    expect(mesh.rightFans.size).toBe(0);
    // Outer corner reaches past the plain offset (miter, not bevel).
    const bounds = boundsOfPoints(mesh.ring);
    expect(bounds.x + bounds.width).toBeGreaterThan(20);
  });

  it('wraps near-reversal cusps without spikes or invalid geometry', () => {
    // Near-reversal cusp over two spans: joins derive from the
    // span-averaged tangent field, so the turn reads below the miter
    // fallback angle and traces via tight micro-miters instead of a
    // ~23-unit chord miter (half 2 / cos(85°)). Genuine hairpins in real
    // strokes subdivide further through tessellation; the guarantee here
    // is structural: bounded edges, finite vertices, positive area.
    const turn = (170 * Math.PI) / 180;
    const spine = [
      spinePoint(0, 0, 1, 0, 4),
      spinePoint(10, 0, Math.cos(turn / 2), Math.sin(turn / 2), 4),
      spinePoint(
        10 + Math.cos(turn),
        Math.sin(turn),
        Math.cos(turn),
        Math.sin(turn),
        4,
      ),
    ];
    const mesh = buildStrokeMesh(spine, 'round');
    expectValidRing(mesh.ring, 1);
    // No spike: every ring edge stays on the nib scale.
    for (let i = 0; i < mesh.ring.length; i++) {
      const a = mesh.ring[i]!;
      const b = mesh.ring[(i + 1) % mesh.ring.length]!;
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeLessThan(16);
    }
  });

  it('keeps sharp-corner strokes inside the nib-expanded envelope', () => {
    const brush = resolveBrushSpec({ stabilization: 0, streamline: 0 });
    const compiled = compileInkStroke(sharpCorner(), brush, { spacing: 5 });
    expectValidRing(compiled.polygon, 10);
    const pad = 3 / 2 + 1;
    expect(compiled.bounds.x).toBeGreaterThanOrEqual(0 - pad);
    expect(compiled.bounds.y).toBeGreaterThanOrEqual(0 - pad);
    expect(compiled.bounds.x + compiled.bounds.width).toBeLessThanOrEqual(
      100 + pad,
    );
    expect(compiled.bounds.y + compiled.bounds.height).toBeLessThanOrEqual(
      100 + pad,
    );
  });

  it('varies width smoothly under pressure transitions (no stair-steps)', () => {
    const brush = resolveBrushSpec({
      size: 4,
      stabilization: 0,
      streamline: 0,
      taperStart: 0,
      taperEnd: 0,
      pressure: { enabled: true, minFactor: 0.5, maxFactor: 2, curve: 1 },
    });
    const samples = sCurve().map((s, i) => ({
      ...s,
      pressure: 0.5 + Math.sin(i / 5) * 0.4,
    }));
    const compiled = compileInkStroke(samples, brush);
    const widths = compiled.nodes.map((n) => n.width);
    for (let i = 1; i < widths.length; i++) {
      const rel =
        Math.abs(widths[i]! - widths[i - 1]!) / Math.max(widths[i]!, 1e-9);
      expect(rel).toBeLessThan(0.35);
    }
  });

  it('emits no outline barbs on jittered sparse input (mouse regression)', () => {
    // Sparse jittered capture (no pressure axes): residual centerline
    // noise must never amplify through joins into visible barbs. Joins
    // derive from the span-averaged tangent field — never from chord
    // turns — so micro-joints trace the offset curve instead of spiking.
    // Deterministic hash jitter (no Math.random).
    const jitter = (i: number): number => {
      const x = Math.sin(i * 12.9898) * 43758.5453;
      return (x - Math.floor(x)) * 2 - 1;
    };
    const samples: InkSample[] = [];
    for (let i = 0; i < 40; i++) {
      samples.push({
        x: i * 8,
        y: 100 + Math.sin(i / 5) * 30 + jitter(i) * 1.5,
      });
    }
    const compiled = compileInkStroke(samples, BALL_PEN_BRUSH);
    // Spike height of every ring vertex against its neighbors' chord,
    // restricted to non-trivial edges (cap micro-facets excluded): the
    // old chord-miter defect read ~1.0 surface units here.
    let maxSpike = 0;
    const ring = compiled.polygon;
    for (let i = 1; i + 1 < ring.length; i++) {
      const a = ring[i - 1]!;
      const b = ring[i]!;
      const c = ring[i + 1]!;
      const dx = c.x - a.x;
      const dy = c.y - a.y;
      const len = Math.hypot(dx, dy);
      const edge = Math.min(
        Math.hypot(b.x - a.x, b.y - a.y),
        Math.hypot(c.x - b.x, c.y - b.y),
      );
      if (edge <= 0.3) continue;
      const dist =
        len > 1e-12
          ? Math.abs((b.x - a.x) * dy - (b.y - a.y) * dx) / len
          : Math.hypot(b.x - a.x, b.y - a.y);
      maxSpike = Math.max(maxSpike, dist);
    }
    expect(maxSpike).toBeLessThan(0.3);
    expectValidRing(compiled.polygon, 10);
  });

  it('stamps round dots and square marker taps', () => {
    const dot = compileInkStroke(
      [{ x: 7, y: 9, pressure: 0.5 }],
      BALL_PEN_BRUSH,
    );
    expect(dot.nodes).toHaveLength(1);
    expect(dot.polygon.length).toBeGreaterThanOrEqual(8);
    const marker = compileInkStroke([{ x: 5, y: 5 }], HIGHLIGHTER_BRUSH);
    expect(marker.polygon).toHaveLength(4);
    expect(marker.bounds).toEqual({ x: -2, y: -2, width: 14, height: 14 });
  });

  it('never emits NaN or zero-area rings on handwriting fixtures', () => {
    const brush = resolveBrushSpec({ stabilization: 0.15, streamline: 0.2 });
    const compiled = compileInkStroke(sCurve(), brush);
    expectValidRing(compiled.polygon, 10);
    // Bounds contain the full ring (caps and joins included).
    for (const p of compiled.polygon) {
      expect(p.x).toBeGreaterThanOrEqual(compiled.bounds.x - 1e-9);
      expect(p.x).toBeLessThanOrEqual(
        compiled.bounds.x + compiled.bounds.width + 1e-9,
      );
      expect(p.y).toBeGreaterThanOrEqual(compiled.bounds.y - 1e-9);
      expect(p.y).toBeLessThanOrEqual(
        compiled.bounds.y + compiled.bounds.height + 1e-9,
      );
    }
  });

  it('collapses zero-width runs to the centerline without corrupting', () => {
    const mesh = buildStrokeMesh(straightSpine(0, 4), 'round');
    for (const p of mesh.ring) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
      expect(p.y).toBeCloseTo(0, 9);
    }
  });
});
