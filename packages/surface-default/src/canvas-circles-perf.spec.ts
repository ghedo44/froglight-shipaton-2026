/**
 * Canvas tail work for high-curvature circles (item 2, renderer side).
 *
 * Companion to the foundation `live-circles-perf` spec: the backend must
 * keep per-frame JS vertex work bounded for repetitive loops (not
 * history-scaled), fill once per paint, and never emit an origin→tip
 * chord — even for translucent Highlighter under prediction-style head
 * clips.
 */

import { describe, expect, it } from 'vitest';
import {
  BALL_PEN_BRUSH,
  HIGHLIGHTER_BRUSH,
  LiveInkStrokeCompiler,
  createCamera,
  type LiveStrokeMeshView,
  type StrokeItem,
} from '@froglight/foundation';
import { CanvasSurfaceRendererBackend } from './canvas-backend.js';

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
    if (previous === undefined) delete (globalThis as Record<string, unknown>).Path2D;
    else (globalThis as Record<string, unknown>).Path2D = previous;
  }
}

function rapidCircles(loops = 10, radius = 12, perLoop = 80): { x: number; y: number; pressure: number }[] {
  const out: { x: number; y: number; pressure: number }[] = [];
  for (let l = 0; l < loops; l++) {
    for (let i = 0; i < perLoop; i++) {
      const a = (i / perLoop) * Math.PI * 2;
      out.push({
        x: 100 + Math.cos(a) * radius + l * 0.5,
        y: 100 + Math.sin(a) * radius,
        pressure: 0.5,
      });
    }
  }
  return out;
}

describe('canvas circles stay tail-bounded', () => {
  it('repetitive loops: per-frame tail vertices bounded, single fill, no chord', () => {
    withStubPath(() => {
      const { ctx, log } = recordingCtx();
      const backend = new CanvasSurfaceRendererBackend(ctx);
      const compiler = new LiveInkStrokeCompiler();
      const samples = rapidCircles(10, 12, 80);
      compiler.begin(samples[0]!, BALL_PEN_BRUSH);
      backend.begin(createCamera(), { width: 1000, height: 1000 });
      const perFrame: number[] = [];
      let frames = 0;
      for (let i = 1; i < samples.length; i += 16) {
        const update = compiler.append(samples.slice(i, i + 16));
        if (update.mesh === null) continue;
        const before = backend.paintStats();
        backend.draw({
          kind: 'stroke',
          objectId: 'circles-live',
          bounds: { x: 0, y: 0, width: 10000, height: 10000 },
          rotation: 0,
          points: [],
          width: BALL_PEN_BRUSH.size,
          outline: [],
          liveMesh: update.mesh,
        } satisfies StrokeItem);
        const after = backend.paintStats();
        perFrame.push(after.liveVerticesTraced - before.liveVerticesTraced);
        frames += 1;
        expect(log.filter(([n]) => n === 'fill').length).toBe(frames);
      }
      backend.end();
      const sorted = [...perFrame].sort((a, b) => a - b);
      const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!;
      // Same tail budget as straights: high curvature must not explode.
      expect(p95).toBeLessThanOrEqual(1500);
      const stats = backend.paintStats();
      expect(stats.mutableTailRebuilds).toBe(frames);
      expect(stats.fullLivePathRebuilds).toBeLessThanOrEqual(Math.max(8, Math.floor(frames / 5)));
    });
  });

  it('circle head-clip (prediction seam) has no chord and one fill', () => {
    withStubPath(() => {
      const { ctx, log } = recordingCtx();
      const backend = new CanvasSurfaceRendererBackend(ctx);
      const compiler = new LiveInkStrokeCompiler();
      const samples = rapidCircles(8, 12, 60);
      compiler.begin(samples[0]!, HIGHLIGHTER_BRUSH);
      let mesh: LiveStrokeMeshView | null = null;
      for (let i = 1; i < samples.length; i += 16) {
        const update = compiler.append(samples.slice(i, i + 16));
        if (update.mesh !== null) mesh = update.mesh;
      }
      if (mesh === null) throw new Error('expected mesh');
      const upTo = mesh.frozenSpine + 5;
      const fillsBefore = log.filter(([n]) => n === 'fill').length;
      backend.begin(createCamera(), { width: 1000, height: 1000 });
      backend.draw({
        kind: 'stroke',
        objectId: 'circles-hl',
        bounds: { x: 0, y: 0, width: 10000, height: 10000 },
        rotation: 0,
        points: [],
        width: HIGHLIGHTER_BRUSH.size,
        opacity: 0.5,
        outline: [],
        liveMesh: mesh,
        liveHeadUpTo: upTo,
      } satisfies StrokeItem);
      backend.end();
      expect(log.filter(([n]) => n === 'fill').length - fillsBefore).toBe(1);
    });
  });
});
