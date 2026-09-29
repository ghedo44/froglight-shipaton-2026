import { describe, expect, it } from 'vitest';
import {
  INK_BRUSH_KINDS,
  brushPresetForKind,
  resolveBrushSpec,
} from './brush.js';
import { compileInkStroke } from './compiler.js';
import { capsuleFootprint, erasureContours, pointVisible } from './erasure.js';
import { LiveInkStrokeCompiler } from './live-compiler.js';
import { buildStrokeMesh } from './outline.js';
import type { TessellatedSpinePoint } from './tessellation.js';

describe('stroke appearance is stable', () => {
  for (const kind of INK_BRUSH_KINDS) {
    it(`${kind}: tight turns cover their centerline`, () => {
      const brush = resolveBrushSpec({ size: 40 }, brushPresetForKind(kind));
      const samples = Array.from({ length: 201 }, (_, i) => ({
        x: 100 + 12 * Math.cos((i * Math.PI) / 100),
        y: 100 + 12 * Math.sin((i * Math.PI) / 100),
        pressure: 0.7,
        dt: i * 8,
      }));
      const stroke = compileInkStroke(samples, brush);
      const holes = stroke.nodes.filter(
        (n) => !pointVisible([stroke.polygon], n),
      );
      expect(holes).toHaveLength(0);
      let gaps = 0;
      for (let i = 10; i < stroke.nodes.length - 10; i++) {
        const n = stroke.nodes[i]!;
        const tangent = stroke.curve.segments[n.segmentIndex!]!.tangent(n.u!);
        const dx = tangent.x,
          dy = tangent.y;
        const length = Math.hypot(dx, dy);
        for (const sign of [-1, 1]) {
          const p = {
            x: n.x - ((sign * dy) / length) * n.width * 0.4,
            y: n.y + ((sign * dx) / length) * n.width * 0.4,
          };
          if (!pointVisible([stroke.polygon], p)) gaps++;
        }
      }
      expect(gaps).toBe(0);
      // The same folded ribbon must survive clipping and live publication.
      const clipped = erasureContours(stroke.polygon, [
        [capsuleFootprint({ x: 125, y: 100 }, { x: 125, y: 100 }, 3)],
      ]);
      const live = new LiveInkStrokeCompiler();
      live.begin(samples[0]!, brush);
      for (let i = 1; i < samples.length; i += 7)
        live.append(samples.slice(i, i + 7));
      const preview = live.geometry();
      for (let x = 80.25; x < 120; x += 2) {
        for (let y = 80.25; y < 120; y += 2) {
          const p = { x, y };
          const expected = pointVisible([stroke.polygon], p);
          expect(pointVisible(clipped, p)).toBe(expected);
          expect(pointVisible([preview.polygon], p)).toBe(expected);
        }
      }
    });

    it(`${kind}: a distant eraser cut leaves overlap fill unchanged`, () => {
      const brush = resolveBrushSpec({ size: 20 }, brushPresetForKind(kind));
      const samples = Array.from({ length: 401 }, (_, i) => ({
        x: 100 + 50 * Math.sin((i * Math.PI) / 100),
        y: 100 + 30 * Math.sin((i * Math.PI) / 50),
        pressure: 0.7,
        dt: i * 8,
      }));
      const stroke = compileInkStroke(samples, brush);
      const cut = erasureContours(stroke.polygon, [
        [capsuleFootprint({ x: 145, y: 100 }, { x: 145, y: 100 }, 4)],
      ]);
      let changed = 0;
      for (let x = 60.25; x < 130; x += 2) {
        for (let y = 60.25; y < 140; y += 2) {
          if (
            pointVisible([stroke.polygon], { x, y }) !==
            pointVisible(cut, { x, y })
          )
            changed++;
        }
      }
      expect(changed).toBe(0);
    });

    it(`${kind}: extending an explicitly tapered stroke does not thin its already written start`, () => {
      const brush = resolveBrushSpec(
        { size: 10, taperStart: 0.2, taperEnd: 0.3 },
        brushPresetForKind(kind),
      );
      const samples = Array.from({ length: 201 }, (_, i) => ({
        x: i,
        y: 0,
        pressure: 0.7,
        dt: i * 8,
      }));
      const live = new LiveInkStrokeCompiler();
      live.begin(samples[0]!, brush);
      live.append(samples.slice(1, 81));
      const before = live.geometry().nodes.filter((n) => n.x < 15);
      live.append(samples.slice(81));
      const after = live.geometry().nodes;
      const widthAt = (nodes: typeof after, x: number) => {
        const i = nodes.findIndex((p) => p.x >= x);
        const b = nodes[i]!;
        const a = nodes[Math.max(0, i - 1)]!;
        return a.x === b.x
          ? b.width
          : a.width + ((b.width - a.width) * (x - a.x)) / (b.x - a.x);
      };
      for (let x = 1; x < 14; x++) {
        expect(widthAt(after, x)).toBeCloseTo(widthAt(before, x), 3);
      }
    });
  }

  it.each([170, 180, -170, -180])(
    'covers the forward nib at a %s degree reversal',
    (degrees) => {
      const angle = (degrees * Math.PI) / 180;
      const node = (
        x: number,
        y: number,
        tx: number,
        ty: number,
      ): TessellatedSpinePoint => ({
        x,
        y,
        tx,
        ty,
        width: 40,
        pressure: 0.5,
        tiltX: null,
        tiltY: null,
        twist: null,
        dt: null,
        extras: {},
        controlArc: 0,
        segmentIndex: 0,
        u: 0,
      });
      const apex = {
        ...node(100, 0, 1, 0),
        corner: {
          inTx: 1,
          inTy: 0,
          outTx: Math.cos(angle),
          outTy: Math.sin(angle),
        },
      };
      const mesh = buildStrokeMesh([
        node(0, 0, 1, 0),
        apex,
        node(
          100 + 100 * Math.cos(angle),
          100 * Math.sin(angle),
          Math.cos(angle),
          Math.sin(angle),
        ),
      ]);
      expect(pointVisible([mesh.ring], { x: 118, y: 0 })).toBe(true);
      expect(pointVisible([mesh.ring], { x: 122, y: 0 })).toBe(false);
    },
  );

  it('keeps wide round dots within a subpixel chord error budget', () => {
    const stroke = compileInkStroke(
      [{ x: 0, y: 0 }],
      resolveBrushSpec({ size: 80, pressure: { enabled: false } }),
    );
    for (let i = 0; i < stroke.polygon.length; i++) {
      const a = stroke.polygon[i]!;
      const b = stroke.polygon[(i + 1) % stroke.polygon.length]!;
      expect(
        40 - Math.hypot((a.x + b.x) / 2, (a.y + b.y) / 2),
      ).toBeLessThanOrEqual(0.025);
    }
  });
});
