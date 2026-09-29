/**
 * Regression: flickering straight line from stroke start to current tip.
 *
 * Root cause: `#fillLiveHeadOnly()` did `combined.addPath(frozenHead)` then
 * immediately `lineTo()` without `moveTo()`. A closed cached head leaves
 * the Path2D current point at its start (stroke origin), so the first
 * prefix `lineTo` emitted an implicit origin→tip chord that flickered with
 * prediction on/off and head-cache state.
 *
 * Fix: the mutable prefix is its own closed subpath starting with an
 * explicit `moveTo(seam)` sharing exactly the seam edge [frozenSpine-1].
 * This spec uses a browser-faithful Path2D fake (addPath preserves current
 * point at head start) to prove no chord can be emitted, for Ball Pen and
 * translucent Highlighter, with prediction disabled/enabled/replaced.
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

/** Browser-faithful Path2D fake: tracks current point across addPath. */
class ChordDetectingPath {
  readonly ops: Array<{ op: string; x?: number; y?: number }> = [];
  readonly added: ChordDetectingPath[] = [];
  current: { x: number; y: number } | null = null;
  /** Implicit chords: lineTo without prior moveTo in this subpath. */
  readonly chords: Array<{ from: { x: number; y: number }; to: { x: number; y: number } }> = [];
  private needsMove = true;

  moveTo(x: number, y: number): void {
    this.ops.push({ op: 'moveTo', x, y });
    this.current = { x, y };
    this.needsMove = false;
  }

  lineTo(x: number, y: number): void {
    if (this.needsMove || this.current === null) {
      // Real browsers draw from the current point (head start after
      // addPath of a closed path) — record the chord for assertion.
      const from = this.current ?? { x: 0, y: 0 };
      this.chords.push({ from: { ...from }, to: { x, y } });
    }
    this.ops.push({ op: 'lineTo', x, y });
    this.current = { x, y };
    this.needsMove = false;
  }

  closePath(): void {
    this.ops.push({ op: 'closePath' });
    // Closed subpath: current point returns to subpath start (browser).
    const first = this.ops.find((o) => o.op === 'moveTo');
    if (first?.x !== undefined && first?.y !== undefined) {
      this.current = { x: first.x, y: first.y };
    }
    this.needsMove = true;
  }

  addPath(path: ChordDetectingPath): void {
    this.added.push(path);
    for (const o of path.ops) this.ops.push({ ...o });
    // Browser semantics: after addPath of a closed head, the current point
    // is the head's start (stroke origin). The next subpath MUST moveTo.
    if (path.current !== null) this.current = { ...path.current };
    this.needsMove = true;
  }
}

function withChordPath<T>(fn: () => T): { result: T; paths: ChordDetectingPath[] } {
  const previous = (globalThis as Record<string, unknown>).Path2D;
  const paths: ChordDetectingPath[] = [];
  class Tracked extends ChordDetectingPath {
    constructor() {
      super();
      paths.push(this);
    }
  }
  (globalThis as Record<string, unknown>).Path2D = Tracked as unknown as typeof Path2D;
  try {
    const result = fn();
    return { result, paths };
  } finally {
    if (previous === undefined) delete (globalThis as Record<string, unknown>).Path2D;
    else (globalThis as Record<string, unknown>).Path2D = previous;
  }
}

function recordingCtx(): { ctx: CanvasRenderingContext2D; fills: unknown[] } {
  const fills: unknown[] = [];
  const noop = (..._args: unknown[]): void => {
    void _args;
  };
  const ctx = {
    save: () => void noop(),
    restore: () => void noop(),
    beginPath: () => void noop(),
    closePath: () => void noop(),
    clip: () => void noop(),
    fill: (p?: unknown) => void fills.push(p),
    stroke: () => void noop(),
    rect: () => void noop(),
    fillRect: () => void noop(),
    strokeRect: () => void noop(),
    fillText: () => void noop(),
    ellipse: () => void noop(),
    translate: () => void noop(),
    rotate: () => void noop(),
    setTransform: () => void noop(),
    setLineDash: () => void noop(),
    clearRect: () => void noop(),
    moveTo: () => void noop(),
    lineTo: () => void noop(),
    fillStyle: '',
    globalAlpha: 1,
  } as unknown as CanvasRenderingContext2D;
  return { ctx, fills };
}

function diagonal(count: number): { x: number; y: number; pressure: number }[] {
  const out: { x: number; y: number; pressure: number }[] = [];
  for (let i = 0; i < count; i++) out.push({ x: i * 0.7, y: i * 0.45, pressure: 0.5 });
  return out;
}

function liveMeshWithFrozen(samples: { x: number; y: number; pressure: number }[], brush = BALL_PEN_BRUSH): LiveStrokeMeshView {
  const compiler = new LiveInkStrokeCompiler();
  compiler.begin(samples[0]!, brush);
  let mesh: LiveStrokeMeshView | null = null;
  for (let i = 1; i < samples.length; i += 16) {
    const update = compiler.append(samples.slice(i, i + 16));
    if (update.mesh !== null) mesh = update.mesh;
  }
  if (mesh === null) throw new Error('expected frozen mesh');
  if (mesh.frozenSpine <= 0) throw new Error(`expected frozen head, got frozenSpine=${mesh.frozenSpine}`);
  return mesh;
}

function headItem(mesh: LiveStrokeMeshView, upTo: number, opacity?: number): StrokeItem {
  return {
    kind: 'stroke',
    objectId: 'chord-live',
    bounds: { x: -10, y: -10, width: 10000, height: 10000 },
    rotation: 0,
    points: [],
    width: BALL_PEN_BRUSH.size,
    color: '#1a73e8',
    ...(opacity !== undefined ? { opacity } : {}),
    outline: [],
    liveMesh: mesh,
    liveHeadUpTo: upTo,
  };
}

describe('prediction head prefix never emits an origin→tip chord', () => {
  it('Ball Pen head-only prefix starts a new subpath with moveTo (no chord)', () => {
    const mesh = liveMeshWithFrozen(diagonal(800), BALL_PEN_BRUSH);
    const upTo = mesh.frozenSpine + 8;
    const { paths } = withChordPath(() => {
      const { ctx } = recordingCtx();
      const backend = new CanvasSurfaceRendererBackend(ctx);
      backend.begin(createCamera(), { width: 1000, height: 1000 });
      backend.draw(headItem(mesh, upTo));
      backend.end();
    });
    // Combined path is paths[paths.length-1] (head builds are earlier).
    const combined = paths[paths.length - 1]!;
    expect(combined.added.length).toBe(1);
    expect(combined.chords).toHaveLength(0);
    // After the head replay, the first prefix op must be moveTo to the
    // seam (frozenSpine-1), not a lineTo from the head start.
    const headOps = combined.added[0]!.ops.length;
    const firstAfterHead = combined.ops[headOps]!;
    expect(firstAfterHead.op).toBe('moveTo');
    expect(firstAfterHead.x).toBeCloseTo(mesh.left[mesh.frozenSpine - 1]!.x, 9);
    expect(firstAfterHead.y).toBeCloseTo(mesh.left[mesh.frozenSpine - 1]!.y, 9);
    // Prefix shares the seam edge: it ends at the seam right point.
    const rightSeam = mesh.right[mesh.frozenSpine - 1]!;
    const hasSeamRight = combined.ops.some(
      (o) => o.op === 'lineTo' && o.x === rightSeam.x && o.y === rightSeam.y,
    );
    expect(hasSeamRight).toBe(true);
  });

  it('translucent Highlighter prefix is a single fill with no chord', () => {
    const mesh = liveMeshWithFrozen(diagonal(800), HIGHLIGHTER_BRUSH);
    const upTo = mesh.frozenSpine + 6;
    const { ctx, fills } = recordingCtx();
    const { paths } = withChordPath(() => {
      const backend = new CanvasSurfaceRendererBackend(ctx);
      backend.begin(createCamera(), { width: 1000, height: 1000 });
      backend.draw(headItem(mesh, upTo, 0.5));
      backend.end();
    });
    expect(fills).toHaveLength(1);
    const combined = paths[paths.length - 1]!;
    expect(combined.chords).toHaveLength(0);
    const headOps = combined.added[0]!.ops.length;
    expect(combined.ops[headOps]!.op).toBe('moveTo');
  });

  it('repeatedly replaced predictions never emit a chord', () => {
    const mesh = liveMeshWithFrozen(diagonal(1200), BALL_PEN_BRUSH);
    const { paths } = withChordPath(() => {
      const { ctx } = recordingCtx();
      const backend = new CanvasSurfaceRendererBackend(ctx);
      backend.begin(createCamera(), { width: 1000, height: 1000 });
      // Simulate prediction replacement: head clip moves as the seam moves.
      for (const delta of [4, 9, 2, 14, 7]) {
        backend.draw(headItem(mesh, mesh.frozenSpine + delta));
      }
      backend.end();
    });
    for (const p of paths) expect(p.chords).toHaveLength(0);
  });

  it('head+prefix union matches the direct prefix ring (no gap, no chord)', () => {
    const mesh = liveMeshWithFrozen(diagonal(600), BALL_PEN_BRUSH);
    const upTo = mesh.frozenSpine + 10;
    const { paths } = withChordPath(() => {
      const { ctx } = recordingCtx();
      const backend = new CanvasSurfaceRendererBackend(ctx);
      backend.begin(createCamera(), { width: 1000, height: 1000 });
      backend.draw(headItem(mesh, upTo));
      backend.end();
    });
    const combined = paths[paths.length - 1]!;
    // Two closed subpaths (head + prefix), each with its own moveTo.
    const moves = combined.ops.filter((o) => o.op === 'moveTo');
    expect(moves.length).toBe(2);
    const closes = combined.ops.filter((o) => o.op === 'closePath');
    expect(closes.length).toBe(2);
    // No segment connects the head start to the prefix: every lineTo's
    // predecessor in the same subpath is nearby (prefix edges are short;
    // an origin→tip chord would span hundreds of surface units).
    let subpathStart: { x: number; y: number } | null = null;
    let prev: { x: number; y: number } | null = null;
    for (const o of combined.ops) {
      if (o.op === 'moveTo') {
        subpathStart = { x: o.x!, y: o.y! };
        prev = { ...subpathStart };
      } else if (o.op === 'lineTo') {
        const dist = Math.hypot(o.x! - prev!.x, o.y! - prev!.y);
        // Stroke origin (0,0-ish) to tip (hundreds out) would be >200.
        // Legitimate outline edges are a few surface units.
        expect(dist).toBeLessThan(60);
        prev = { x: o.x!, y: o.y! };
      } else if (o.op === 'closePath') {
        prev = subpathStart;
      }
    }
  });

  it('software pixel check: no filled pixels along the origin→tip chord', () => {
    // Rasterize the combined head+prefix rings with even-odd fill on a
    // coarse grid; pixels along the straight origin→tip line outside the
    // true stroke must stay empty (a chord would fill them).
    const mesh = liveMeshWithFrozen(diagonal(500), BALL_PEN_BRUSH);
    const upTo = mesh.frozenSpine + 8;
    const { paths } = withChordPath(() => {
      const { ctx } = recordingCtx();
      const backend = new CanvasSurfaceRendererBackend(ctx);
      backend.begin(createCamera(), { width: 1000, height: 1000 });
      backend.draw(headItem(mesh, upTo));
      backend.end();
    });
    const combined = paths[paths.length - 1]!;
    expect(combined.chords).toHaveLength(0);
    // Split combined ops into two rings at the second moveTo.
    const moveIdx: number[] = [];
    combined.ops.forEach((o, i) => {
      if (o.op === 'moveTo') moveIdx.push(i);
    });
    expect(moveIdx.length).toBe(2);
    const ringOf = (from: number, to: number): { x: number; y: number }[] => {
      const pts: { x: number; y: number }[] = [];
      for (let i = from; i < to; i++) {
        const o = combined.ops[i]!;
        if (o.op === 'moveTo' || o.op === 'lineTo') pts.push({ x: o.x!, y: o.y! });
      }
      return pts;
    };
    const headRing = ringOf(moveIdx[0]!, moveIdx[1]!);
    const tailRing = ringOf(moveIdx[1]!, combined.ops.length);
    const pointInRing = (p: { x: number; y: number }, ring: { x: number; y: number }[]): boolean => {
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const a = ring[i]!;
        const b = ring[j]!;
        if (a.y === b.y) continue;
        if (p.y < Math.min(a.y, b.y) || p.y >= Math.max(a.y, b.y)) continue;
        const x = a.x + ((p.y - a.y) / (b.y - a.y)) * (b.x - a.x);
        if (x > p.x) inside = !inside;
      }
      return inside;
    };
    const origin = mesh.left[0]!;
    const tipLeft = mesh.left[upTo - 1]!;
    // Sample the chord midpoint region offset perpendicular to the stroke
    // (a true chord would fill the straight line; the real stroke curves
    // with the diagonal). Use points far from both rings.
    let chordPixels = 0;
    for (let t = 0.2; t < 0.9; t += 0.1) {
      const p = {
        x: origin.x + (tipLeft.x - origin.x) * t,
        // Offset 15 surface units perpendicular (well outside stroke width ~2).
        y: origin.y + (tipLeft.y - origin.y) * t + 15,
      };
      if (pointInRing(p, headRing) || pointInRing(p, tailRing)) chordPixels += 1;
    }
    expect(chordPixels).toBe(0);
  });
});
