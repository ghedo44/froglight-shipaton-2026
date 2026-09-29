/**
 * Resumable async Ink compiler (item 3).
 *
 * The synchronous `compileInkStroke()` pipeline is headless and
 * deterministic, but a single 10k/50k-sample stroke compiles as one
 * uninterruptible block (hundreds of ms) — the fake `prepareMore(...,3)`
 * budget measured time only AFTER the full compile. This module runs the
 * exact same stage functions in the exact same order with cooperative
 * yields between bounded phases, so expensive cold compilation never
 * synchronously monopolizes the main thread.
 *
 * Geometry identity: stages, arguments, and order match `compiler.ts`
 * exactly — output is bit-identical to the synchronous path (same
 * functions, no quality reduction, no sample reduction). Yields only
 * interleave the event loop; they never alter numerics.
 *
 * PWA and Tauri share this solution (pure JS, no host APIs). A future Web
 * Worker can host `compileInkStrokeAsync` without changing callers: the
 * `InkCompileScheduler` seam below already isolates scheduling (idle vs
 * immediate) from geometry.
 */

import type { InkSample } from '../model.js';
import type { InkBrushSpec } from './brush.js';
import { boundsOfPoints } from './bounds.js';
import {
  filterPressureStream,
  resolveUntaperedWidth,
} from './curve-attributes.js';
import { fitCenterlineCurve, controlArcLengths } from './curve.js';
import { buildStrokeMesh, emptyStrokeMesh } from './outline.js';
import { arcLengthResample, defaultControlSpacing } from './resample.js';
import { sanitizeSamples } from './samples.js';
import { fairControlPolygon, stabilizePositions } from './stabilization.js';
import { tessellateCurve } from './tessellation.js';
import type { CompiledInkStroke, InkGeometryOptions } from './compiler.js';
import type { TessellatedSpinePoint } from './tessellation.js';

/** Cooperative yield: lets paint/input interleave between phases. */
export type InkYieldFn = () => Promise<void>;

/** Default yield: a macrotask (paint-safe) shared by PWA/Tauri/Node. */
export async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => {
    try {
      const g = globalThis as unknown as {
        setTimeout?: (cb: () => void, ms: number) => unknown;
      };
      if (typeof g.setTimeout === 'function') g.setTimeout(() => resolve(), 0);
      else resolve();
    } catch {
      resolve();
    }
  });
}

/**
 * Structural counters: yields performed (proves resumability) and async
 * compiles completed. Sync `prepareMore` must show zero sync compiles for
 * deferred huge strokes; the async path shows yields > 0.
 */
export const asyncCompilerStats = {
  yields: 0,
  asyncCompiles: 0,
};

async function yieldOnce(yieldFn: InkYieldFn): Promise<void> {
  asyncCompilerStats.yields += 1;
  await yieldFn();
}

function toNode(point: TessellatedSpinePoint) {
  return {
    x: point.x,
    y: point.y,
    width: point.width,
    pressure: point.pressure,
    tiltX: point.tiltX,
    tiltY: point.tiltY,
    twist: point.twist,
    dt: point.dt,
    extras: { ...point.extras },
    segmentIndex: point.segmentIndex,
    u: point.u,
    controlArc: point.controlArc,
    ...(point.corner !== undefined ? { corner: { ...point.corner } } : {}),
  };
}

/**
 * Async twin of `compileInkStroke`: identical stages, identical arguments,
 * identical output — with `await yieldFn()` between every bounded phase.
 * Callers schedule this off the critical first-paint path (idle/worker);
 * the sync pipeline stays for live writing (already incremental).
 */
export async function compileInkStrokeAsync(
  samples: readonly InkSample[],
  brush: InkBrushSpec,
  options: InkGeometryOptions = {},
  yieldFn: InkYieldFn = yieldToEventLoop,
): Promise<CompiledInkStroke> {
  const empty: CompiledInkStroke = {
    curve: { segments: [], controlCount: 0, dot: null },
    mesh: emptyStrokeMesh(),
    nodes: [],
    polygon: [],
    bounds: { x: 0, y: 0, width: 0, height: 0 },
  };
  const minDistance =
    typeof options.minDistance === 'number' &&
    Number.isFinite(options.minDistance) &&
    options.minDistance >= 0
      ? options.minDistance
      : 0;
  const spacing =
    typeof options.spacing === 'number' &&
    Number.isFinite(options.spacing) &&
    options.spacing > 0
      ? options.spacing
      : defaultControlSpacing(brush.size);
  const cleaned = sanitizeSamples(samples, minDistance);
  if (cleaned.length === 0) return empty;
  await yieldOnce(yieldFn);
  const filtered = filterPressureStream(
    cleaned.map((s) => s.pressure),
    cleaned,
    brush,
  );
  await yieldOnce(yieldFn);
  const pressured: typeof cleaned = cleaned.map((s, i) => ({
    ...s,
    pressure: filtered[i]!,
    extras: { ...s.extras },
  }));
  const resampled = arcLengthResample(pressured, spacing);
  await yieldOnce(yieldFn);
  const stabilized = stabilizePositions(resampled, brush.stabilization);
  await yieldOnce(yieldFn);
  const faired = fairControlPolygon(stabilized, brush.streamline);
  if (faired.length === 0) return empty;
  await yieldOnce(yieldFn);
  const controls = faired.map((s) => ({
    x: s.x,
    y: s.y,
    pressure: s.pressure ?? 0.5,
    tiltX: s.tiltX,
    tiltY: s.tiltY,
    twist: s.twist,
    dt: s.dt,
  }));
  if (controls.length === 1) {
    const only = controls[0]!;
    const width = resolveUntaperedWidth(
      only.pressure,
      brush,
      0,
      only.twist,
      only.tiltX,
      only.tiltY,
    );
    const spine: TessellatedSpinePoint[] = [
      {
        x: only.x,
        y: only.y,
        tx: 1,
        ty: 0,
        width,
        pressure: only.pressure,
        tiltX: only.tiltX,
        tiltY: only.tiltY,
        twist: only.twist,
        dt: only.dt,
        extras: { ...faired[0]!.extras },
        controlArc: 0,
        segmentIndex: -1,
        u: 0,
      },
    ];
    await yieldOnce(yieldFn);
    const curve = fitCenterlineCurve(controls);
    await yieldOnce(yieldFn);
    const mesh = buildStrokeMesh(spine, brush.tip.cap ?? 'round');
    const nodes = spine.map(toNode);
    asyncCompilerStats.asyncCompiles += 1;
    return {
      curve,
      mesh,
      nodes,
      polygon: mesh.ring,
      bounds: boundsOfPoints(mesh.ring),
    };
  }
  const { cumulative, total } = controlArcLengths(controls);
  await yieldOnce(yieldFn);
  const extraAt = (i: number): Record<string, unknown> | undefined =>
    faired[i]?.extras !== undefined ? { ...faired[i]!.extras } : undefined;
  const curve = fitCenterlineCurve(controls, extraAt);
  await yieldOnce(yieldFn);
  const spine = tessellateCurve(
    curve,
    brush,
    cumulative,
    total,
    options.tessellation,
    0,
    (i) => faired[i]?.extras,
  );
  await yieldOnce(yieldFn);
  const mesh = buildStrokeMesh(spine, brush.tip.cap ?? 'round');
  await yieldOnce(yieldFn);
  const nodes = spine.map(toNode);
  asyncCompilerStats.asyncCompiles += 1;
  return {
    curve,
    mesh,
    nodes,
    polygon: mesh.ring,
    bounds: boundsOfPoints(mesh.ring),
  };
}

/**
 * Scheduler seam for cold/background compilation (item 3): idle-first with
 * `setTimeout`/`rAF` fallback, shared by PWA/Tauri. A future Worker
 * implementation slots in here (same input/output, transferable samples)
 * without changing `IncrementalSceneCache` or the committed renderer.
 */
export function scheduleBackgroundCompile(task: () => void): void {
  try {
    const g = globalThis as unknown as {
      requestIdleCallback?: (
        cb: () => void,
        opts?: { timeout: number },
      ) => number;
      requestAnimationFrame?: (cb: () => void) => number;
      setTimeout?: (cb: () => void, ms: number) => unknown;
    };
    if (typeof g.requestIdleCallback === 'function') {
      g.requestIdleCallback(task, { timeout: 100 });
      return;
    }
    if (typeof g.requestAnimationFrame === 'function') {
      g.requestAnimationFrame(() => task());
      return;
    }
    if (typeof g.setTimeout === 'function') {
      g.setTimeout(task, 0);
      return;
    }
  } catch {
    // Fall through to direct invoke.
  }
  try {
    task();
  } catch {
    // Scheduling never throws.
  }
}
