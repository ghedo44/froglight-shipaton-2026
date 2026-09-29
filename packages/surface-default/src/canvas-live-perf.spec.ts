/**
 * Renderer-level live performance (repair items 4 + 6).
 *
 * Foundation counters alone cannot catch history-sized Canvas work: the
 * backend must structurally render `cached frozen head + small mutable
 * tail`, never retracing the full stroke per frame. Deterministic
 * counters pin this:
 *
 * - live vertices traced (JS moveTo/lineTo for live paths);
 * - full live path rebuilds (entire spine retraced);
 * - frozen-head rebuilds (occasional intentional head updates);
 * - mutable-tail rebuilds (one per published version, bounded).
 *
 * Long-stroke sweep (100 / 1k / 5k / 10k samples, many small batches /
 * rAF-style updates): normal per-frame renderer work stays bounded and
 * does not scale with total history. Translucent Highlighter head/tail
 * uses a single fill (no overlap-darkening from two fills).
 */

import { describe, expect, it } from 'vitest';
import {
  BALL_PEN_BRUSH,
  INK_BRUSH_KINDS,
  brushPresetForKind,
  HIGHLIGHTER_BRUSH,
  LiveInkStrokeCompiler,
  createCamera,
  type LiveStrokeMeshView,
  type StrokeItem,
} from '@froglight/foundation';
import { CanvasSurfaceRendererBackend } from './canvas-backend.js';
import type { InkSample } from '@froglight/foundation';

/** Recording 2D stub (headless, no Path2D by default). */
function recordingCtx(): {
  ctx: CanvasRenderingContext2D;
  log: Array<[string, ...unknown[]]>;
} {
  const log: Array<[string, ...unknown[]]> = [];
  const record =
    (name: string) =>
    (...args: unknown[]) =>
      void log.push([name, ...args]);
  const ctx = {
    save: record('save'),
    restore: record('restore'),
    beginPath: record('beginPath'),
    closePath: record('closePath'),
    clip: record('clip'),
    fill: record('fill'),
    stroke: record('stroke'),
    rect: record('rect'),
    fillRect: record('fillRect'),
    strokeRect: record('strokeRect'),
    fillText: record('fillText'),
    ellipse: record('ellipse'),
    translate: record('translate'),
    rotate: record('rotate'),
    setTransform: record('setTransform'),
    setLineDash: record('setLineDash'),
    clearRect: record('clearRect'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    arc: record('arc'),
    fillStyle: '',
    strokeStyle: '',
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
  } as unknown as CanvasRenderingContext2D;
  for (const prop of [
    'fillStyle',
    'strokeStyle',
    'font',
    'lineWidth',
    'lineCap',
    'lineJoin',
    'globalAlpha',
  ] as const) {
    let value: unknown = '';
    Object.defineProperty(ctx, prop, {
      get: () => value,
      set: (next: unknown) => {
        value = next;
        log.push([`set:${prop}`, next]);
      },
    });
  }
  return { ctx, log };
}

/** Test Path2D with native-style addPath (head replay traces zero JS). */
class StubPathWithAdd {
  readonly moves: unknown[][] = [];
  readonly lines: unknown[][] = [];
  closes = 0;
  readonly added: StubPathWithAdd[] = [];
  moveTo(x: unknown, y: unknown): void {
    this.moves.push([x, y]);
  }
  lineTo(x: unknown, y: unknown): void {
    this.lines.push([x, y]);
  }
  closePath(): void {
    this.closes += 1;
  }
  addPath(path: StubPathWithAdd): void {
    this.added.push(path);
  }
}

function withStubPath<T>(fn: () => T): T {
  const previous = (globalThis as Record<string, unknown>).Path2D;
  (globalThis as Record<string, unknown>).Path2D =
    StubPathWithAdd as unknown as typeof Path2D;
  try {
    return fn();
  } finally {
    if (previous === undefined) {
      delete (globalThis as Record<string, unknown>).Path2D;
    } else {
      (globalThis as Record<string, unknown>).Path2D = previous;
    }
  }
}

function diagonal(count: number): InkSample[] {
  const out: InkSample[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ x: i * 0.7, y: i * 0.45, pressure: 0.5 });
  }
  return out;
}

function liveItem(
  objectId: string,
  mesh: LiveStrokeMeshView,
  opacity?: number,
): StrokeItem {
  return {
    kind: 'stroke',
    objectId,
    bounds: { x: 0, y: 0, width: 10000, height: 10000 },
    rotation: 0,
    points: [],
    width: BALL_PEN_BRUSH.size,
    ...(opacity !== undefined ? { opacity } : {}),
    outline: [],
    liveMesh: mesh,
  };
}

describe('canvas live rendering stays tail-bounded', () => {
  for (const total of [100, 1000, 5000, 10000]) {
    it(
      `${total} samples in small batches: per-frame tail work bounded, not history-scaled`,
      () => {
        withStubPath(() => {
          const { ctx, log } = recordingCtx();
          const backend = new CanvasSurfaceRendererBackend(ctx);
          const compiler = new LiveInkStrokeCompiler();
          const samples = diagonal(total);
          compiler.begin(samples[0]!, BALL_PEN_BRUSH);
          backend.begin(createCamera(), { width: 1000, height: 1000 });
          // rAF-style: many small batches (16 samples) per frame.
          const batchSize = 16;
          const perFrameTail: number[] = [];
          let frames = 0;
          for (let i = 1; i < samples.length; i += batchSize) {
            const update = compiler.append(samples.slice(i, i + batchSize));
            if (update.mesh === null) continue;
            const before = backend.paintStats();
            backend.draw(liveItem('long-live', update.mesh));
            const after = backend.paintStats();
            const deltaVertices =
              after.liveVerticesTraced - before.liveVerticesTraced;
            perFrameTail.push(deltaVertices);
            frames += 1;
            // Single fill per paint (head + tail combined, never two
            // fills that could double-darken translucent tools).
            const fills = log.filter(([n]) => n === 'fill').length;
            expect(fills).toBe(frames);
          }
          backend.end();
          const stats = backend.paintStats();
          // One mutable-tail rebuild per published version (bounded).
          expect(stats.mutableTailRebuilds).toBe(frames);
          // Full-history rebuilds happen only while the stroke still fits
          // the tail window (frozenSpine==0, history itself bounded) plus
          // the first frozen build — never per frame once frozen. Bound
          // them well below frame count to catch O(n)-per-frame
          // regressions (which would rebuild fully every frame).
          expect(stats.fullLivePathRebuilds).toBeLessThanOrEqual(
            Math.max(8, Math.floor(frames / 5)),
          );
          expect(stats.frozenHeadRebuilds).toBeLessThanOrEqual(
            Math.max(4, Math.floor(frames / 10)),
          );
          // Per-frame tail work bounded: 95th percentile well below
          // history size (does not scale with total). Tail window (24
          // controls ≈ ≤600 spine vertices with fans/caps) bounds this;
          // assert generously (≤1500) to avoid brittleness while still
          // catching O(n) regressions (which would trace thousands at
          // 5k/10k).
          const sorted = [...perFrameTail].sort((a, b) => a - b);
          const p95 =
            sorted.length > 0
              ? sorted[
                  Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))
                ]!
              : 0;
          expect(p95).toBeLessThanOrEqual(1500);
          // Late frames (deep history) cost no more than early frames:
          // median of last 10% within 3× median of first 10% (plus small
          // slack for head-rebuild frames).
          if (perFrameTail.length >= 20) {
            const first = perFrameTail.slice(
              0,
              Math.floor(perFrameTail.length * 0.1),
            );
            const last = perFrameTail.slice(
              Math.floor(perFrameTail.length * 0.9),
            );
            const median = (arr: number[]): number => {
              const s = [...arr].sort((a, b) => a - b);
              return s[Math.floor(s.length / 2)]!;
            };
            expect(median(last)).toBeLessThanOrEqual(median(first) * 3 + 200);
          }
        });
      },
      total >= 5000 ? 120000 : 60000,
    );
  }

  it('renders translucent Highlighter head+tail with a single fill (no overlap-darkening)', () => {
    withStubPath(() => {
      const { ctx, log } = recordingCtx();
      const backend = new CanvasSurfaceRendererBackend(ctx);
      const compiler = new LiveInkStrokeCompiler();
      const samples = diagonal(2000);
      compiler.begin(samples[0]!, HIGHLIGHTER_BRUSH);
      backend.begin(createCamera(), { width: 1000, height: 1000 });
      let lastMesh: LiveStrokeMeshView | null = null;
      for (let i = 1; i < samples.length; i += 32) {
        const update = compiler.append(samples.slice(i, i + 32));
        if (update.mesh !== null) lastMesh = update.mesh;
      }
      if (lastMesh === null) throw new Error('expected a live mesh');
      const beforeFills = log.filter(([n]) => n === 'fill').length;
      // Highlighter opacity (<1): head + tail must share one fill —
      // two fills of overlapping geometry would darken the seam.
      backend.draw(liveItem('hl-live', lastMesh, 0.5));
      const afterFills = log.filter(([n]) => n === 'fill').length;
      expect(afterFills - beforeFills).toBe(1);
      backend.end();
      // Bounded tail work even for translucent tools.
      const stats = backend.paintStats();
      expect(stats.mutableTailRebuilds).toBeGreaterThan(0);
      expect(stats.fullLivePathRebuilds).toBeLessThanOrEqual(2);
    });
  });
});

/** Records actual subpaths, including native-style frozen-head replay. */
class RingPath {
  readonly rings: Array<Array<{ x: number; y: number }>> = [];
  moveTo(x: number, y: number): void {
    this.rings.push([{ x, y }]);
  }
  lineTo(x: number, y: number): void {
    this.rings[this.rings.length - 1]!.push({ x, y });
  }
  closePath(): void {
    /* implicit closure */
  }
  addPath(path: RingPath): void {
    this.rings.push(...path.rings.map((r) => [...r]));
  }
}

function filled(
  rings: ReadonlyArray<ReadonlyArray<{ x: number; y: number }>>,
  x: number,
  y: number,
): boolean {
  let winding = 0;
  for (const ring of rings)
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i]!,
        b = ring[(i + 1) % ring.length]!;
      const cross = (b.x - a.x) * (y - a.y) - (x - a.x) * (b.y - a.y);
      if (a.y <= y && b.y > y && cross > 0) winding++;
      else if (a.y > y && b.y <= y && cross < 0) winding--;
    }
  return winding !== 0;
}

const previewCases = INK_BRUSH_KINDS.flatMap((kind) =>
  [-1, 1].flatMap((direction) =>
    ['cached', 'uncached', 'immediate'].map((mode) => ({
      kind,
      direction,
      mode,
    })),
  ),
);

class UncachedRingPath extends RingPath {
  constructor() {
    super();
    Object.defineProperty(this, 'addPath', { value: undefined });
  }
}

it.each(previewCases)(
  '$kind / $direction / $mode: live overlapping fill matches the compiler before pointer-up',
  ({ kind, direction, mode }) => {
    const previous = globalThis.Path2D;
    Object.defineProperty(globalThis, 'Path2D', {
      configurable: true,
      writable: true,
      value:
        mode === 'immediate'
          ? undefined
          : mode === 'cached'
            ? RingPath
            : UncachedRingPath,
    });
    try {
      const { ctx, log } = recordingCtx();
      const direct = new RingPath();
      if (mode === 'immediate') {
        ctx.beginPath = () => {
          direct.rings.length = 0;
        };
        ctx.moveTo = (x, y) => direct.moveTo(x, y);
        ctx.lineTo = (x, y) => direct.lineTo(x, y);
        ctx.closePath = () => direct.closePath();
      }
      const backend = new CanvasSurfaceRendererBackend(ctx);
      const compiler = new LiveInkStrokeCompiler();
      const brush = { ...brushPresetForKind(kind), size: 40 };
      const samples = Array.from({ length: 1001 }, (_, i) => ({
        x: 100 + 12 * Math.cos(i / 10),
        y: 100 + 12 * Math.sin((direction * i) / 10),
        dt: i * 8,
      }));
      compiler.begin(samples[0]!, brush);
      backend.begin(createCamera(), { width: 300, height: 300 });
      for (let i = 1; i < samples.length; i += 20) {
        const update = compiler.append(samples.slice(i, i + 20));
        if (update.mesh === null) throw new Error('missing live mesh');
        backend.draw(liveItem('scribble', update.mesh, brush.opacity));
        if (i % 100 !== 1) continue;
        const path =
          mode === 'immediate'
            ? direct
            : log.filter(([name]) => name === 'fill').at(-1)?.[1];
        if (!(path instanceof RingPath)) throw new Error('missing canvas fill');
        const expected = [compiler.geometry().polygon];
        let mismatches = 0;
        for (let x = 73.23; x < 130; x += 3.71)
          for (let y = 73.37; y < 130; y += 3.71) {
            if (filled(path.rings, x, y) !== filled(expected, x, y))
              mismatches++;
          }
        expect(mismatches, `preview after ${i + 20} samples`).toBe(0);
      }
      backend.end();
    } finally {
      globalThis.Path2D = previous;
    }
  },
);
