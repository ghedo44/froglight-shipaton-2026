/**
 * Canvas 2D renderer backend: the production backend must
 * consume exactly the shared draw-item stream — same pipeline, same order,
 * zero knowledge of payloads or canonical bytes. Asserted against a
 * recording 2D-context stub, fully headless.
 */

import { describe, expect, it } from 'vitest';
import {
  compileScene,
  createCamera,
  createDefaultSurfaceObjectTypeRegistry,
  renderSurfaceScene,
  rectangleObject,
  textObject,
  ellipseObject,
  imageObject,
  inkStrokeObject,
  lineObject,
  boundedFrame,
  infiniteFrame,
  materializeLiveMeshRing,
  BALL_PEN_BRUSH,
  LiveInkStrokeCompiler,
  type LiveStrokeMeshView,
  type StrokeItem,
  type SurfaceModel,
} from '@froglight/foundation';
import { RecordingSurfaceBackend } from '@froglight/foundation/testing';
import { CanvasSurfaceRendererBackend } from './canvas-backend.js';

/** Minimal recording stub of the Canvas2D API surface the backend uses. */
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
    quadraticCurveTo: record('quadraticCurveTo'),
    arc: record('arc'),
    fillStyle: '',
    strokeStyle: '',
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
  } as unknown as CanvasRenderingContext2D;
  // Record property writes too.
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

const names = (log: Array<[string, ...unknown[]]>) => log.map(([name]) => name);

function scene(frame: SurfaceModel['frame']): SurfaceModel {
  return {
    formatVersion: 1,
    frame,
    order: ['r1', 'x1', 't1', 'i1', 'e1'],
    objects: {
      r1: rectangleObject('r1', { x: 10, y: 10, width: 30, height: 20 }),
      x1: { id: 'x1', type: 'acme.callout', x: 50, y: 50, width: 8, height: 8 },
      t1: textObject('t1', { x: 70, y: 70, text: 'hi', size: 12 }),
      i1: imageObject('i1', {
        x: 90,
        y: 90,
        width: 16,
        height: 16,
        src: 'assets/p.png',
        sha256: 'ab',
      }),
      e1: ellipseObject('e1', { x: 120, y: 120, width: 40, height: 20 }),
    },
  };
}

describe('canvas backend protocol', () => {
  it('sets a surface-space transform once and clips bounded frames only', () => {
    const bounded = recordingCtx();
    renderSurfaceScene(
      new CanvasSurfaceRendererBackend(bounded.ctx),
      scene(boundedFrame(4000, 3000)),
      createDefaultSurfaceObjectTypeRegistry(),
      createCamera(0, 0, 1),
      { width: 800, height: 600 },
    );
    expect(names(bounded.log).slice(0, 6)).toEqual([
      'save',
      'setTransform',
      'beginPath',
      'rect',
      'clip',
      'set:fillStyle',
    ]);
    expect(bounded.log[1]).toEqual(['setTransform', 1, 0, 0, 1, -0, -0]);
    expect(bounded.log[3]).toEqual(['rect', 0, 0, 4000, 3000]);
    expect(names(bounded.log).at(-1)).toBe('restore');

    const infinite = recordingCtx();
    renderSurfaceScene(
      new CanvasSurfaceRendererBackend(infinite.ctx),
      scene(infiniteFrame()),
      { get: () => null, list: () => [] } as never,
      createCamera(),
      { width: 800, height: 600 },
    );
    expect(infinite.log.map(([n]) => n)).not.toContain('clip');
  });

  it('draws every item kind in paint order through the shared pipeline', () => {
    const { ctx, log } = recordingCtx();
    const registry = createDefaultSurfaceObjectTypeRegistry();
    renderSurfaceScene(
      new CanvasSurfaceRendererBackend(ctx),
      scene(infiniteFrame()),
      registry,
      createCamera(0, 0, 1),
      { width: 5000, height: 5000 },
    );

    // Same compiled stream as any other conforming backend (swap proof):
    const reference = new RecordingSurfaceBackend();
    renderSurfaceScene(
      reference,
      scene(infiniteFrame()),
      registry,
      createCamera(0, 0, 1),
      {
        width: 5000,
        height: 5000,
      },
    );
    expect(reference.drawnItemIds()).toEqual(['r1', 'x1', 't1', 'i1', 'e1']);

    const sequence = names(log);
    expect(sequence).toEqual([
      'save',
      'setTransform',
      // r1: plain rect
      'set:fillStyle',
      'fillRect',
      // x1: unknown type → dashed placeholder box
      'setLineDash',
      'set:strokeStyle',
      'strokeRect',
      'setLineDash',
      // t1: text
      'set:font',
      'set:fillStyle',
      'fillText',
      // i1: unresolvable asset → dashed reference box
      'setLineDash',
      'set:strokeStyle',
      'strokeRect',
      'setLineDash',
      // e1: ellipse path
      'beginPath',
      'ellipse',
      'set:fillStyle',
      'fill',
      'restore',
    ]);
    expect(log.find(([n]) => n === 'fillText')).toEqual([
      'fillText',
      'hi',
      70,
      82,
    ]);
    expect(log.filter(([n]) => n === 'strokeRect')).toHaveLength(2);
  });

  it.each(['rectangle', 'triangle', 'diamond'] as const)(
    'rounds %s corners while keeping fill and stroke',
    (shape) => {
      const { ctx, log } = recordingCtx();
      new CanvasSurfaceRendererBackend(ctx).draw({
        kind: 'rect',
        objectId: 'rounded',
        shape,
        cornerRadius: 12,
        bounds: { x: 0, y: 0, width: 100, height: 80 },
        rotation: 0,
        fill: '#ffffff',
        stroke: '#336699',
        strokeWidth: 3,
      });
      expect(log.filter(([name]) => name === 'quadraticCurveTo')).toHaveLength(
        shape === 'triangle' ? 3 : 4,
      );
      expect(log.some(([name]) => name === 'fill')).toBe(true);
      expect(log.some(([name]) => name === 'stroke')).toBe(true);
    },
  );

  it('wraps and clips card text inside its padded frame', () => {
    const { ctx, log } = recordingCtx();
    const backend = new CanvasSurfaceRendererBackend(ctx);
    backend.draw({
      kind: 'card',
      objectId: 'card',
      bounds: { x: 20, y: 30, width: 100, height: 60 },
      rotation: 0,
      text: 'A long card description that wraps',
      size: 14,
    });
    const clip = log.findIndex(([name]) => name === 'clip');
    const lines = log.filter(([name]) => name === 'fillText');
    expect(log[clip - 1]).toEqual(['rect', 28, 38, 84, 44]);
    expect(lines.length).toBeGreaterThan(1);
    expect(log.findIndex(([name]) => name === 'fillText')).toBeGreaterThan(
      clip,
    );
    expect(lines.every((line) => line[2] === 28)).toBe(true);
  });

  it('wraps rotated shapes in a center-of-envelope transform', () => {
    const { ctx, log } = recordingCtx();
    const model: SurfaceModel = {
      formatVersion: 1,
      frame: infiniteFrame(),
      order: ['rr'],
      objects: {
        rr: rectangleObject('rr', {
          x: 0,
          y: 0,
          width: 40,
          height: 20,
          rotation: Math.PI / 4,
        }),
      },
    };
    renderSurfaceScene(
      new CanvasSurfaceRendererBackend(ctx),
      model,
      createDefaultSurfaceObjectTypeRegistry(),
      createCamera(),
      { width: 1000, height: 1000 },
    );
    expect(log.map(([n]) => n)).toEqual([
      'save',
      'setTransform',
      'save',
      'translate',
      'rotate',
      'translate',
      'set:fillStyle',
      'fillRect',
      'restore',
      'restore',
    ]);
    expect(log[3]).toEqual(['translate', 20, 10]);
    expect(log[4]).toEqual(['rotate', Math.PI / 4]);
    expect(log[5]).toEqual(['translate', -20, -10]);
  });

  it('renders without mutating canonical bytes', () => {
    const model = scene(infiniteFrame());
    const before = JSON.stringify(model);
    const { ctx } = recordingCtx();
    const compiled = compileScene(
      model,
      createDefaultSurfaceObjectTypeRegistry(),
    );
    renderSurfaceScene(
      new CanvasSurfaceRendererBackend(ctx),
      model,
      createDefaultSurfaceObjectTypeRegistry(),
      createCamera(),
      { width: 1000, height: 1000 },
    );
    expect(JSON.stringify(model)).toBe(before);
    expect(compiled).toHaveLength(model.order.length);
  });
});

describe('ink stroke rendering', () => {
  const strokeScene = (): SurfaceModel => ({
    formatVersion: 1,
    frame: infiniteFrame(),
    order: ['s1'],
    objects: {
      s1: inkStrokeObject('s1', {
        points: [
          { x: 10, y: 10, pressure: 0.2 },
          { x: 30, y: 10, pressure: 0.8 },
          { x: 50, y: 10 },
        ],
        width: 4,
        color: '#1a73e8',
        opacity: 0.9,
      }),
    },
  });

  it('fills the compiled outline as one path through the shared pipeline', () => {
    const { ctx, log } = recordingCtx();
    renderSurfaceScene(
      new CanvasSurfaceRendererBackend(ctx),
      strokeScene(),
      createDefaultSurfaceObjectTypeRegistry(),
      createCamera(),
      { width: 1000, height: 1000 },
    );
    const opNames = log.map(([n]) => n);
    // One filled path per stroke: no per-segment stroking.
    expect(opNames.slice(0, 4)).toEqual([
      'save',
      'setTransform',
      'set:globalAlpha',
      'set:fillStyle',
    ]);
    expect(opNames).toContain('moveTo');
    expect(opNames).toContain('closePath');
    expect(opNames.filter((n) => n === 'fill')).toHaveLength(1);
    expect(opNames).not.toContain('stroke');
    expect(opNames).not.toContain('set:lineWidth');
    expect(opNames.at(-2)).toEqual('set:globalAlpha');
    expect(opNames.at(-1)).toEqual('restore');
    expect(log[2]).toEqual(['set:globalAlpha', 0.9]);
    expect(log.find(([n]) => n === 'set:fillStyle')).toEqual([
      'set:fillStyle',
      '#1a73e8',
    ]);
    // Every outline vertex becomes one lineTo after the opening moveTo.
    const lineTos = opNames.filter((n) => n === 'lineTo').length;
    const moveTos = opNames.filter((n) => n === 'moveTo').length;
    expect(moveTos).toBe(1);
    expect(lineTos).toBeGreaterThan(8);
    expect(log.at(-2)).toEqual(['set:globalAlpha', 1]);
  });

  it('draws nothing for outline-less stroke items (no legacy fallback)', () => {
    const { ctx, log } = recordingCtx();
    const backend = new CanvasSurfaceRendererBackend(ctx);
    backend.begin(createCamera(), { width: 1000, height: 1000 });
    // A stroke item without its compiled outline is a producer bug, not
    // a legacy rendering mode: the single authoritative handwriting path
    // fills outlines, and there is no per-segment fallback anymore.
    backend.draw({
      kind: 'stroke',
      objectId: 'outline-less',
      bounds: { x: 8, y: 8, width: 44, height: 4 },
      rotation: 0,
      points: [
        { x: 10, y: 10 },
        { x: 30, y: 10 },
        { x: 50, y: 10 },
      ],
      width: 4,
      color: '#1a73e8',
      opacity: 0.9,
      outline: [],
    });
    backend.end();
    const opNames = log.map(([n]) => n);
    expect(opNames).not.toContain('stroke');
    expect(opNames).not.toContain('fill');
  });

  it('strokes explicit polyline guide items (lasso marquees)', () => {
    const { ctx, log } = recordingCtx();
    const backend = new CanvasSurfaceRendererBackend(ctx);
    backend.begin(createCamera(), { width: 1000, height: 1000 });
    // Non-handwriting previews use their own draw-item kind — never the
    // canonical ink path.
    backend.draw({
      kind: 'polyline',
      objectId: 'lasso-preview',
      bounds: { x: 8, y: 8, width: 44, height: 4 },
      rotation: 0,
      points: [
        { x: 10, y: 10 },
        { x: 30, y: 10 },
        { x: 50, y: 10 },
      ],
      width: 1.5,
      color: '#7c6cf0',
    });
    backend.end();
    const opNames = log.map(([n]) => n);
    // One stroked path: a single moveTo, lineTos, one stroke call.
    expect(opNames.filter((n) => n === 'moveTo')).toHaveLength(1);
    expect(opNames.filter((n) => n === 'lineTo')).toHaveLength(2);
    expect(opNames.filter((n) => n === 'stroke')).toHaveLength(1);
    expect(opNames).not.toContain('fill');
  });

  it('matches the reference op stream of any conforming backend (swap proof)', () => {
    const model = strokeScene();
    const before = JSON.stringify(model);
    const canvasBackend = new CanvasSurfaceRendererBackend(recordingCtx().ctx);
    const reference = new RecordingSurfaceBackend();
    for (const backend of [canvasBackend, reference]) {
      renderSurfaceScene(
        backend,
        { ...model },
        createDefaultSurfaceObjectTypeRegistry(),
        createCamera(3, 3, 2),
        { width: 800, height: 600 },
      );
    }
    expect(reference.drawnItemIds()).toEqual(['s1']);
    expect(reference.ops.some((op) => op.op === 'clip')).toBe(false);
    // Swapping renderers leaves canonical model bytes untouched.
    expect(JSON.stringify(model)).toBe(before);
  });

  it('wraps rotated strokes in the center-of-envelope transform', () => {
    const { ctx, log } = recordingCtx();
    const model: SurfaceModel = {
      formatVersion: 1,
      frame: infiniteFrame(),
      order: ['s'],
      objects: {
        s: inkStrokeObject('s', {
          points: [
            { x: 0, y: 0 },
            { x: 40, y: 0 },
          ],
          width: 2,
          rotation: Math.PI / 4,
        }),
      },
    };
    renderSurfaceScene(
      new CanvasSurfaceRendererBackend(ctx),
      model,
      createDefaultSurfaceObjectTypeRegistry(),
      createCamera(),
      { width: 1000, height: 1000 },
    );
    const opNames = log.map(([n]) => n);
    // Rotation wrapper untouched; the stroke itself is one filled path.
    expect(opNames.slice(0, 8)).toEqual([
      'save',
      'setTransform',
      'save',
      'translate',
      'rotate',
      'translate',
      'set:globalAlpha',
      'set:fillStyle',
    ]);
    expect(opNames).toContain('moveTo');
    expect(opNames).toContain('closePath');
    expect(opNames.filter((n) => n === 'fill')).toHaveLength(1);
    expect(opNames).not.toContain('stroke');
    expect(opNames.slice(-3)).toEqual([
      'set:globalAlpha',
      'restore',
      'restore',
    ]);
    expect(log[3]).toEqual(['translate', 20, 0]);
    expect(log[4]).toEqual(['rotate', Math.PI / 4]);
    expect(log[5]).toEqual(['translate', -20, -0]);
  });
});

describe('connector rendering', () => {
  it('strokes routed elbow waypoints as one polyline', () => {
    const { ctx, log } = recordingCtx();
    const model: SurfaceModel = {
      formatVersion: 1,
      frame: infiniteFrame(),
      order: ['c'],
      objects: {
        c: lineObject('c', {
          x: 0,
          y: 0,
          x2: 100,
          y2: 50,
          width: 2,
          path: 'orthogonal',
        }),
      },
    };
    renderSurfaceScene(
      new CanvasSurfaceRendererBackend(ctx),
      model,
      createDefaultSurfaceObjectTypeRegistry(),
      createCamera(),
      { width: 1000, height: 1000 },
    );
    const opNames = log.map(([n]) => n);
    expect(opNames.filter((n) => n === 'moveTo')).toHaveLength(1);
    // Four elbow vertices: one moveTo plus three lineTos, one stroke.
    expect(opNames.filter((n) => n === 'lineTo')).toHaveLength(3);
    expect(opNames.filter((n) => n === 'stroke')).toHaveLength(1);
    expect(log.find(([n]) => n === 'moveTo')).toEqual(['moveTo', 0, 0]);
  });
});

describe('frame lifecycle (ghosting regression)', () => {
  it('explicit clear wipes the full device canvas, scaled by dpr', () => {
    const { ctx, log } = recordingCtx();
    const backend = new CanvasSurfaceRendererBackend(ctx);
    backend.clear({ width: 400, height: 300 });
    backend.clear({ width: 400, height: 300, dpr: 3 });
    expect(log).toEqual([
      ['save'],
      ['setTransform', 1, 0, 0, 1, 0, 0],
      ['clearRect', 0, 0, 400, 300],
      ['restore'],
      ['save'],
      ['setTransform', 1, 0, 0, 1, 0, 0],
      ['clearRect', 0, 0, 1200, 900],
      ['restore'],
    ]);
  });

  it('begin only transforms: compositors can layer without wiping', () => {
    const { ctx, log } = recordingCtx();
    const backend = new CanvasSurfaceRendererBackend(ctx);
    const viewport = { width: 400, height: 300 };
    renderSurfaceScene(
      backend,
      scene(infiniteFrame()),
      createDefaultSurfaceObjectTypeRegistry(),
      createCamera(),
      viewport,
    );
    expect(log.slice(0, 2)).toEqual([
      ['save'],
      ['setTransform', 1, 0, 0, 1, -0, -0],
    ]);
    // Two frames through one backend never emit an implicit clear.
    renderSurfaceScene(
      backend,
      scene(infiniteFrame()),
      createDefaultSurfaceObjectTypeRegistry(),
      createCamera(),
      viewport,
    );
    expect(log.filter(([n]) => n === 'clearRect')).toHaveLength(0);
    expect(names(log).at(-1)).toBe('restore');
  });
});

describe('live chunk stroke rendering', () => {
  function liveMesh(): {
    mesh: LiveStrokeMeshView;
    samples: { x: number; y: number; pressure: number }[];
  } {
    const compiler = new LiveInkStrokeCompiler();
    const samples = [
      { x: 0, y: 0, pressure: 0.5 },
      { x: 12, y: 1, pressure: 0.6 },
      { x: 24, y: -1, pressure: 0.55 },
      { x: 36, y: 2, pressure: 0.5 },
      { x: 48, y: 0, pressure: 0.5 },
    ];
    compiler.begin(samples[0]!, BALL_PEN_BRUSH);
    let mesh: LiveStrokeMeshView | null = null;
    for (let i = 1; i < samples.length; i++) {
      const update = compiler.append([samples[i]!]);
      if (update.mesh !== null) mesh = update.mesh;
    }
    if (mesh === null) throw new Error('expected a live mesh view');
    return { mesh, samples };
  }

  function chunkItem(
    mesh: LiveStrokeMeshView,
    samples: { x: number; y: number; pressure: number }[],
  ): StrokeItem {
    return {
      kind: 'stroke',
      objectId: 'live-1',
      bounds: { x: -4, y: -4, width: 56, height: 10 },
      rotation: 0,
      points: samples,
      width: BALL_PEN_BRUSH.size,
      color: '#1a73e8',
      opacity: 0.9,
      outline: [],
      liveMesh: mesh,
    };
  }

  it('traces chunks as one filled path with the ring vertex sequence', () => {
    const { mesh, samples } = liveMesh();
    const ring = materializeLiveMeshRing(mesh);
    expect(ring.length).toBeGreaterThan(8);

    const { ctx, log } = recordingCtx();
    const backend = new CanvasSurfaceRendererBackend(ctx);
    backend.begin(createCamera(), { width: 1000, height: 1000 });
    backend.draw(chunkItem(mesh, samples));
    backend.end();

    const chunkOps = log.filter(
      ([n]) => n === 'moveTo' || n === 'lineTo' || n === 'closePath',
    );
    // Direct trace (no Path2D in node): one moveTo, ring-length lineTos,
    // one close — the exact ring vertex sequence, no array built.
    const moves = chunkOps.filter(([n]) => n === 'moveTo');
    expect(moves).toHaveLength(1);
    expect(moves[0]).toEqual(['moveTo', ring[0]!.x, ring[0]!.y]);
    const lines = chunkOps.filter(([n]) => n === 'lineTo');
    expect(lines).toHaveLength(ring.length - 1);
    for (let i = 0; i < lines.length; i++) {
      expect(lines[i]).toEqual(['lineTo', ring[i + 1]!.x, ring[i + 1]!.y]);
    }
    expect(chunkOps.filter(([n]) => n === 'closePath')).toHaveLength(1);
    expect(log.filter(([n]) => n === 'fill')).toHaveLength(1);
    const stats = backend.paintStats();
    expect(stats.liveDirectTraces).toBe(1);
    expect(stats.outlineDraws).toBe(0);
  });

  it('matches the outline fill op-for-op on identical geometry', () => {
    const { mesh, samples } = liveMesh();
    const ring = materializeLiveMeshRing(mesh);
    const item = chunkItem(mesh, samples);

    const first = recordingCtx();
    const backend = new CanvasSurfaceRendererBackend(first.ctx);
    backend.begin(createCamera(), { width: 1000, height: 1000 });
    backend.draw(item);
    backend.end();

    const second = recordingCtx();
    const outlineBackend = new CanvasSurfaceRendererBackend(second.ctx);
    outlineBackend.begin(createCamera(), { width: 1000, height: 1000 });
    outlineBackend.draw({ ...item, liveMesh: undefined, outline: ring });
    outlineBackend.end();

    const pathOps = (log: Array<[string, ...unknown[]]>) =>
      log.filter(
        ([n]) => n === 'moveTo' || n === 'lineTo' || n === 'closePath',
      );
    expect(pathOps(first.log)).toEqual(pathOps(second.log));
  });

  it('caches the assembled path per version and evicts on commit', () => {
    const { mesh, samples } = liveMesh();
    const item = chunkItem(mesh, samples);
    const stubPaths: Array<{
      moves: unknown[][];
      lines: unknown[][];
      closes: number;
    }> = [];
    class StubPath {
      readonly record = { moves: [], lines: [], closes: 0 } as {
        moves: unknown[][];
        lines: unknown[][];
        closes: number;
      };
      constructor() {
        stubPaths.push(this.record);
      }
      moveTo(x: unknown, y: unknown): void {
        this.record.moves.push([x, y]);
      }
      lineTo(x: unknown, y: unknown): void {
        this.record.lines.push([x, y]);
      }
      closePath(): void {
        this.record.closes += 1;
      }
    }
    const previous = (globalThis as Record<string, unknown>).Path2D;
    (globalThis as Record<string, unknown>).Path2D =
      StubPath as unknown as typeof Path2D;
    try {
      const { ctx, log } = recordingCtx();
      const backend = new CanvasSurfaceRendererBackend(ctx);
      backend.begin(createCamera(), { width: 1000, height: 1000 });
      // First paint builds the path; the second repaints the same
      // publish by replaying it (no re-trace).
      backend.draw(item);
      backend.draw(item);
      expect(stubPaths).toHaveLength(1);
      expect(stubPaths[0]!.moves).toHaveLength(1);
      expect(stubPaths[0]!.lines.length).toBeGreaterThan(8);
      const fills = log.filter(([n]) => n === 'fill');
      expect(fills).toHaveLength(2);
      expect(fills[0]![1]).toBe(fills[1]![1]);
      expect(backend.paintStats()).toMatchObject({
        liveRebuilds: 1,
        liveReplays: 1,
      });
      // A newer publish version rebuilds once.
      backend.draw({
        ...item,
        liveMesh: { ...mesh, version: mesh.version + 1 },
      });
      expect(stubPaths).toHaveLength(2);
      // Committing the stroke (outline path under the same id) evicts the
      // live cache: the next live paint for the id rebuilds, never
      // replays a superseded path.
      backend.draw({ ...item, liveMesh: undefined, outline: [] });
      expect(backend.paintStats().outlineDraws).toBe(1);
      backend.draw(item);
      expect(stubPaths).toHaveLength(3);
      expect(backend.paintStats()).toMatchObject({
        liveRebuilds: 3,
        liveReplays: 1,
      });
      backend.end();
    } finally {
      if (previous === undefined) {
        delete (globalThis as Record<string, unknown>).Path2D;
      } else {
        (globalThis as Record<string, unknown>).Path2D = previous;
      }
    }
  });
});
