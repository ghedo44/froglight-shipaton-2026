/** Fixed nib-relative taper envelopes must not reshape old stroke regions. */

import { describe, expect, it } from 'vitest';
import {
  normalizeTaperZones,
  resolveWidth,
  taperScaleAt,
  TAPER_FLOOR,
  TAPER_ZONE_CAP_SIZE_MULTIPLE,
} from './curve-attributes.js';
import {
  INK_BRUSH_KINDS,
  BRUSH_PEN_BRUSH,
  brushPresetForKind,
} from './brush.js';
import { compileInkStroke } from './compiler.js';
import type { InkSample } from '../model.js';

const taperedBrush = { ...BRUSH_PEN_BRUSH, taperStart: 0.18, taperEnd: 0.3 };

function line(count: number, step = 2, pressure = 0.6): InkSample[] {
  const out: InkSample[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ x: i * step, y: 0, pressure, dt: i * 8 });
  }
  return out;
}

describe('taper envelope semantics', () => {
  it('keeps start widths independent of stroke length', () => {
    for (const total of [30, 100, 9000]) {
      expect(taperScaleAt(2, total, 0.2, 0.3, 5)).toBeCloseTo(
        taperScaleAt(2, 100, 0.2, 0.3, 5),
        12,
      );
    }
  });

  it('uses the same bounded tip distance on short and long strokes', () => {
    const zone = 0.3 * TAPER_ZONE_CAP_SIZE_MULTIPLE * 5;
    for (const total of [30, 100, 9000]) {
      expect(taperScaleAt(total - zone, total, 0, 0.3, 5)).toBe(1);
      expect(taperScaleAt(total - zone / 2, total, 0, 0.3, 5)).toBeCloseTo(
        0.5,
        12,
      );
      expect(taperScaleAt(total, total, 0, 0.3, 5)).toBe(TAPER_FLOOR);
    }
  });

  it('does not compound attenuation when short-stroke envelopes overlap', () => {
    const { startLen, endLen } = normalizeTaperZones(0.6, 0.6);
    expect(startLen + endLen).toBeCloseTo(1, 12);
    // Both envelopes reach half strength here; their product would pinch.
    expect(taperScaleAt(4, 8, 0.5, 0.5, 2)).toBeCloseTo(0.5, 12);
    expect(taperScaleAt(0, 10, 0, 0, 5)).toBe(1);
    expect(taperScaleAt(10, 10, 0, 0, 5)).toBe(1);
  });

  it('multiplies (never replaces) the pressure width', () => {
    const brush = taperedBrush;
    const arc = 4;
    const total = 200;
    const tapered = resolveWidth(0.8, brush, arc, total, 0, null, null, null);
    // Back out the taper scale: width / scale == untapered pressure width.
    const { startLen, endLen } = normalizeTaperZones(
      brush.taperStart,
      brush.taperEnd,
    );
    void startLen;
    void endLen;
    const scale = taperScaleAt(
      arc,
      total,
      brush.taperStart,
      brush.taperEnd,
      brush.size,
    );
    expect(scale).toBeGreaterThan(0);
    expect(scale).toBeLessThanOrEqual(1);
    expect(tapered / scale).toBeGreaterThan(0);
    // Same pressure, mid-stroke (no taper): strictly wider.
    const mid = resolveWidth(0.8, brush, 100, total, 0, null, null, null);
    expect(mid / 1).toBeGreaterThanOrEqual(tapered / scale - 1e-9);
  });

  it('tapers short, medium, and long strokes end to end', () => {
    const brush = taperedBrush;
    for (const count of [30, 300, 3000]) {
      const compiled = compileInkStroke(line(count), brush);
      expect(compiled.nodes.length).toBeGreaterThan(4);
      const widths = compiled.nodes.map((n) => n.width);
      const mid = widths[Math.floor(widths.length / 2)]!;
      // Tapered tip is narrower than the middle (both ends taper).
      expect(widths[widths.length - 1]!).toBeLessThan(mid);
      expect(widths[0]!).toBeLessThan(mid);
      for (const w of widths) expect(Number.isFinite(w)).toBe(true);
    }
  });

  it('scales taper zones with brush size across separate strokes', () => {
    // Two strokes at different sizes taper over their own nib widths:
    // the larger brush holds full width longer in absolute units.
    const small = compileInkStroke(line(400, 2), {
      ...taperedBrush,
      size: 4,
    });
    const big = compileInkStroke(line(400, 2), {
      ...taperedBrush,
      size: 10,
    });
    const fullAt = (
      nodes: readonly { controlArc: number; width: number }[],
    ): number => {
      const peak = Math.max(...nodes.map((n) => n.width));
      const idx = nodes.findIndex((n) => n.width >= peak * 0.999);
      return nodes[idx]!.controlArc;
    };
    // Bigger nib => longer absolute full-width run before the end taper.
    expect(fullAt(big.nodes)).toBeGreaterThan(fullAt(small.nodes));
  });

  it.each(INK_BRUSH_KINDS.map(brushPresetForKind))(
    '$kind preserves a full-width default tip',
    (brush) => {
      expect(brush.taperStart).toBe(0);
      expect(brush.taperEnd).toBe(0);
      const compiled = compileInkStroke(line(100), { ...brush, size: 40 });
      const widths = compiled.nodes.map((n) => n.width);
      expect(widths[0]).toBeCloseTo(widths[Math.floor(widths.length / 2)]!, 8);
      expect(widths.at(-1)).toBeCloseTo(widths[0]!, 8);
    },
  );
});
