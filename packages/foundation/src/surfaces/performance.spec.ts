/**
 * Architectural performance smoke (testing decisions): a
 * ten-thousand-object payload must decode, compile, and cull within a
 * generous CI budget. Frame rates are never asserted; only that the
 * pipeline scales without pathological behavior and that culling stays
 * functionally correct at volume.
 */

import { describe, expect, it } from 'vitest';
import { utf8Decode } from '../encoding.js';
import {
  canonicalSurfaceJson,
  decodeSurfacePayload,
  SURFACE_LIMITS,
} from './codec.js';
import { createCamera } from './geometry.js';
import {
  rectangleObject,
  textObject,
  boundedFrame,
  inkStrokeObject,
  type SurfaceModel,
} from './model.js';
import { createDefaultSurfaceObjectTypeRegistry } from './objects.js';
import { compileScene, renderSurfaceScene } from './render.js';
import { RecordingSurfaceBackend } from '../testing/headless-surface-backend.js';

const OBJECT_COUNT = 10_000;

function bigModel(): SurfaceModel {
  const objects: SurfaceModel['objects'] = {};
  const order: string[] = [];
  for (let i = 0; i < OBJECT_COUNT; i++) {
    if (i % 10 === 0) {
      objects[`t${i}`] = textObject(`t${i}`, {
        x: i % 2000,
        y: i % 1500,
        text: `obj ${i}`,
      });
    } else {
      objects[`r${i}`] = rectangleObject(`r${i}`, {
        x: i % 2000,
        y: i % 1500,
        width: 8,
        height: 8,
      });
    }
    order.push(i % 10 === 0 ? `t${i}` : `r${i}`);
  }
  return { formatVersion: 1, frame: boundedFrame(4000, 3000), order, objects };
}

describe('ten-thousand-object smoke', () => {
  it('decode → compile → render stays well inside the CI budget', () => {
    const model = bigModel();
    const bytes = new TextEncoder().encode(canonicalSurfaceJson(model));

    const started = performance.now();
    const decoded = decodeSurfacePayload(bytes);
    const compiled = compileScene(
      decoded.model,
      createDefaultSurfaceObjectTypeRegistry(),
    );
    const backend = new RecordingSurfaceBackend();
    renderSurfaceScene(
      backend,
      decoded.model,
      createDefaultSurfaceObjectTypeRegistry(),
      createCamera(500, 500, 1),
      { width: 1000, height: 800 },
    );
    const elapsed = performance.now() - started;

    // Generous headless-CI budget; this guards against accidental O(n²)
    // or accidental full-scene dispatch regressions, not real frame rates.
    // Sized for shared runners (parallel vitest workers contend for CPU;
    // an O(n²) regression still blows past by 10×+).
    expect(elapsed).toBeLessThan(20_000);
    expect(utf8Decode(bytes)).toContain(`"froglight.rectangle"`);
    expect(compiled).toHaveLength(OBJECT_COUNT);

    // Functional culling at volume: only the viewport slice is dispatched
    // (the fixture's modulo grid puts ~28% of objects under this camera).
    const drawn = backend.drawnItemIds().length;
    expect(drawn).toBeGreaterThan(OBJECT_COUNT / 10);
    expect(drawn).toBeLessThan(OBJECT_COUNT / 3);
  });
});

describe('ink stroke smoke', () => {
  it('a max-length stroke plus many strokes decode → compile → cull within budget', () => {
    // NOTE: 200x500pt + 10kpt strokes through the approximating fitter
    // need more than the 5s default on loaded runners; the 10s elapsed
    // budget asserted below is the real gate (timeout here is 60s).
    // Compact zigzag strokes banded along x, so culling has real work.
    const strokeWith = (id: string, baseX: number, count: number) =>
      inkStrokeObject(id, {
        points: Array.from({ length: count }, (_, i) => ({
          x: baseX + (i % 20) * 2,
          y: Math.floor(i / 20) * 10,
        })),
        width: 3,
      });

    const objects: SurfaceModel['objects'] = {};
    const order: string[] = [];
    for (let i = 0; i < 200; i++) {
      objects[`s${i}`] = strokeWith(`s${i}`, i * 60, 500);
      order.push(`s${i}`);
    }
    // One stroke at the per-stroke point cap, parked far below the camera.
    const bigSamples: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < SURFACE_LIMITS.maxStrokePoints; i++) {
      bigSamples.push({ x: (i % 40) * 5, y: 2800 + Math.floor(i / 40) });
    }
    objects.big = inkStrokeObject('big', { points: bigSamples, width: 3 });
    order.push('big');
    const model: SurfaceModel = {
      formatVersion: 1,
      frame: boundedFrame(12000, 3000),
      order,
      objects,
    };
    const bytes = new TextEncoder().encode(canonicalSurfaceJson(model));

    const started = performance.now();
    const decoded = decodeSurfacePayload(bytes);
    const compiled = compileScene(
      decoded.model,
      createDefaultSurfaceObjectTypeRegistry(),
    );
    const backend = new RecordingSurfaceBackend();
    renderSurfaceScene(
      backend,
      decoded.model,
      createDefaultSurfaceObjectTypeRegistry(),
      createCamera(500, 0, 1),
      { width: 1000, height: 800 },
    );
    const elapsed = performance.now() - started;

    // Generous headless-CI budget; this guards against accidental O(n²)
    // or accidental full-scene dispatch regressions, not real frame rates.
    // Sized for shared runners (parallel vitest workers contend for CPU;
    // an O(n²) regression still blows past by 10×+).
    expect(elapsed).toBeLessThan(20_000);
    expect(compiled).toHaveLength(order.length);
    // Culling stays functional at ink volume: only a slice dispatches
    // (camera sees surface x ∈ [500, 1500], y ∈ [0, 800]).
    const drawn = backend.drawnItemIds().length;
    expect(drawn).toBeGreaterThan(5);
    expect(drawn).toBeLessThan(order.length / 2);
  }, 60000);
});
