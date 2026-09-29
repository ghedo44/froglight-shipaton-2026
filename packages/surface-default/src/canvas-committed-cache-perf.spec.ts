import { describe, expect, it } from 'vitest';
import { createCamera, type DrawItem } from '@froglight/foundation';
import { CanvasSurfaceRendererBackend } from './canvas-backend.js';

function recordingCtx() {
  const log: Array<[string, ...unknown[]]> = [];
  const record = (name: string) => (...args: unknown[]) => void log.push([name, ...args]);
  const ctx = {
    save: record('save'), restore: record('restore'), setTransform: record('setTransform'),
    beginPath: record('beginPath'), moveTo: record('moveTo'), lineTo: record('lineTo'),
    closePath: record('closePath'), fill: record('fill'), translate: record('translate'),
    fillStyle: '', globalAlpha: 1,
  } as unknown as CanvasRenderingContext2D;
  return { ctx, log };
}

function packedItem(
  polygonXY: Float64Array,
  sourceOffset = { x: 0, y: 0 },
  objectId = 'dense-stroke',
): DrawItem {
  return {
    kind: 'packed-stroke', objectId,
    bounds: { x: 0, y: 0, width: 100, height: 100 }, rotation: 0,
    packed: { polygonXY } as never, sourceOffset,
  } as DrawItem;
}

describe('committed canvas path reuse', () => {
  it('reuses a packed outline path across camera repaints and rebuilds on geometry or offset change', () => {
    const paths: Array<{ ops: Array<[string, number, number]> }> = [];
    class StubPath {
      readonly ops: Array<[string, number, number]> = [];
      constructor() { paths.push(this); }
      moveTo(x: number, y: number): void { this.ops.push(['moveTo', x, y]); }
      lineTo(x: number, y: number): void { this.ops.push(['lineTo', x, y]); }
      closePath(): void { /* no coordinates */ }
    }
    const previous = (globalThis as Record<string, unknown>).Path2D;
    (globalThis as Record<string, unknown>).Path2D = StubPath as unknown as typeof Path2D;
    try {
      const { ctx, log } = recordingCtx();
      const backend = new CanvasSurfaceRendererBackend(ctx);
      const polygon = new Float64Array([0, 0, 10, 0, 10, 10, 0, 10]);
      backend.begin(createCamera(), { width: 100, height: 100 });
      const first = packedItem(polygon);
      backend.draw(first);
      backend.draw(first);
      expect(paths).toHaveLength(1);
      expect(log.filter(([name]) => name === 'moveTo' || name === 'lineTo')).toHaveLength(0);
      const fills = log.filter(([name]) => name === 'fill');
      expect(fills).toHaveLength(2);
      expect(fills[0]![1]).toBe(fills[1]![1]);

      backend.draw(packedItem(new Float64Array([0, 0, 20, 0, 20, 20])));
      backend.draw(packedItem(polygon, { x: 5, y: 0 }));
      expect(paths).toHaveLength(3);
      expect(paths[2]!.ops[1]).toEqual(['lineTo', 15, 0]);
      backend.end();
    } finally {
      if (previous === undefined) delete (globalThis as Record<string, unknown>).Path2D;
      else (globalThis as Record<string, unknown>).Path2D = previous;
    }
  });

  it('retains direct tracing when Path2D is unavailable', () => {
    const previous = (globalThis as Record<string, unknown>).Path2D;
    delete (globalThis as Record<string, unknown>).Path2D;
    try {
      const { ctx, log } = recordingCtx();
      const backend = new CanvasSurfaceRendererBackend(ctx);
      const item = packedItem(new Float64Array([0, 0, 10, 0, 10, 10]));
      backend.begin(createCamera(), { width: 100, height: 100 });
      backend.draw(item);
      backend.draw(item);
      backend.end();
      expect(log.filter(([name]) => name === 'moveTo')).toHaveLength(2);
      expect(log.filter(([name]) => name === 'lineTo')).toHaveLength(4);
      expect(log.filter(([name]) => name === 'fill')).toHaveLength(2);
    } finally {
      if (previous === undefined) delete (globalThis as Record<string, unknown>).Path2D;
      else (globalThis as Record<string, unknown>).Path2D = previous;
    }
  });

  it('keeps a ten-stroke visible set warm and declines oversized retention', () => {
    let pathBuilds = 0;
    class CountingPath {
      constructor() { pathBuilds += 1; }
      moveTo(): void { /* count is sufficient */ }
      lineTo(): void { /* count is sufficient */ }
      closePath(): void { /* count is sufficient */ }
    }
    const previous = (globalThis as Record<string, unknown>).Path2D;
    (globalThis as Record<string, unknown>).Path2D = CountingPath as unknown as typeof Path2D;
    try {
      const { ctx } = recordingCtx();
      const backend = new CanvasSurfaceRendererBackend(ctx);
      backend.begin(createCamera(), { width: 100, height: 100 });
      const ordinary = Array.from({ length: 10 }, (_, index) =>
        packedItem(new Float64Array([0, 0, 10, 0, 10, 10]), { x: 0, y: 0 }, `visible-${index}`),
      );
      ordinary.forEach((item) => backend.draw(item));
      ordinary.forEach((item) => backend.draw(item));
      expect(pathBuilds).toBe(10);
      expect(backend.paintStats()).toMatchObject({
        committedPathBuilds: 10,
        committedPathReplays: 10,
      });

      // The cap is on retained vertex weight, not a count of objects. A
      // path over budget uses direct Canvas commands without Path2D allocation.
      ctx.moveTo = () => undefined;
      ctx.lineTo = () => undefined;
      ctx.closePath = () => undefined;
      const oversized = packedItem(new Float64Array(524_290));
      backend.draw(oversized);
      backend.draw(oversized);
      expect(pathBuilds).toBe(10);
      expect(backend.paintStats().committedPathReplays).toBe(10);
      backend.end();
    } finally {
      if (previous === undefined) delete (globalThis as Record<string, unknown>).Path2D;
      else (globalThis as Record<string, unknown>).Path2D = previous;
    }
  });
});
