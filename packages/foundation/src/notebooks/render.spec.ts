/**
 * Notebook page rendering composition: template
 * backgrounds render beneath page objects through the same backend seam,
 * with identical culling — proven headlessly against the deterministic
 * recording backend.
 */

import { describe, expect, it } from 'vitest';
import { renderSurfaceScene } from '../surfaces/render.js';
import {
  boundedFrame,
  emptySurface,
  textObject,
} from '../surfaces/model.js';
import { createDefaultSurfaceObjectTypeRegistry } from '../surfaces/objects.js';
import type { RenderViewport } from '../surfaces/backend.js';
import type { Camera } from '../surfaces/geometry.js';
import { RecordingSurfaceBackend } from '../testing/index.js';
import { templateBackgroundDrawItems } from './templates.js';

describe('renderSurfaceScene with notebook backgrounds', () => {
  const camera: Camera = { x: 0, y: 0, zoom: 1 };
  const viewport: RenderViewport = { width: 400, height: 300, dpr: 1 };

  it('draws background items before scene objects', () => {
    const model = emptySurface(boundedFrame(400, 300));
    model.objects['t1'] = textObject('t1', { x: 10, y: 10, text: 'hi' });
    model.order.push('t1');
    const background = templateBackgroundDrawItems('froglight.grid', 400, 300);

    const backend = new RecordingSurfaceBackend();
    renderSurfaceScene(backend, model, createDefaultSurfaceObjectTypeRegistry(), camera, viewport, {
      backgroundItems: background,
    });

    const draws = backend.ops.filter((op) => op.op === 'draw');
    expect(draws.length).toBe(background.length + 1);
    // Every background item precedes the scene object.
    const firstSceneIndex = draws.findIndex((op) => op.op === 'draw' && op.item.objectId === 't1');
    expect(firstSceneIndex).toBe(background.length);
  });

  it('culls background items against the viewport like scene items', () => {
    const model = emptySurface(boundedFrame(2000, 2000));
    const background = templateBackgroundDrawItems('froglight.lined', 2000, 2000);
    const zoomed: Camera = { x: 1900, y: 1900, zoom: 1 };

    const backend = new RecordingSurfaceBackend();
    renderSurfaceScene(backend, model, createDefaultSurfaceObjectTypeRegistry(), zoomed, viewport, {
      backgroundItems: background,
    });
    const drawn = backend.ops.filter(
      (op) => op.op === 'draw' && op.item.kind === 'line',
    );
    // Only the last few rules of a 2000-unit ruled page are visible.
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.length).toBeLessThan(10);
  });
});
