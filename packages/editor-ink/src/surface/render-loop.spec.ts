/**
 * Render-scheduling tests.
 *
 * Invalidation coalesces as before and renderer backends continue to
 * consume draw items plus image resolution only. Scheduler tests use fake
 * clocks/ports; DOM mounting stays in the black-box handle suite.
 */

import { describe, expect, it, vi } from 'vitest';
import { buildRenderCacheKey, createRenderScheduler } from './render-loop.js';

describe('buildRenderCacheKey', () => {
  it('changes when scene, camera, or size change', () => {
    const base = buildRenderCacheKey(
      1,
      { x: 0, y: 0, zoom: 1 },
      { width: 800, height: 600, dpr: 1 },
    );
    const sceneBump = buildRenderCacheKey(
      2,
      { x: 0, y: 0, zoom: 1 },
      { width: 800, height: 600, dpr: 1 },
    );
    const cameraMove = buildRenderCacheKey(
      1,
      { x: 5, y: 0, zoom: 1 },
      { width: 800, height: 600, dpr: 1 },
    );
    const resize = buildRenderCacheKey(
      1,
      { x: 0, y: 0, zoom: 1 },
      { width: 801, height: 600, dpr: 1 },
    );
    expect(sceneBump).not.toBe(base);
    expect(cameraMove).not.toBe(base);
    expect(resize).not.toBe(base);
    expect(
      buildRenderCacheKey(
        1,
        { x: 0, y: 0, zoom: 1 },
        { width: 800, height: 600, dpr: 1 },
      ),
    ).toBe(base);
  });
});

describe('createRenderScheduler', () => {
  it('coalesces multiple invalidations into one frame', () => {
    let frames = 0;
    const pending: Array<() => void> = [];
    const scheduler = createRenderScheduler({
      requestFrame: (cb) => {
        pending.push(cb);
        return pending.length;
      },
      cancelFrame: () => undefined,
      onFrame: () => {
        frames += 1;
      },
    });
    scheduler.schedule();
    scheduler.schedule();
    scheduler.schedule();
    expect(pending).toHaveLength(1);
    expect(scheduler.isScheduled()).toBe(true);
    pending[0]!();
    expect(frames).toBe(1);
    expect(scheduler.isScheduled()).toBe(false);
    scheduler.dispose();
  });

  it('schedules a new frame after the previous one runs', () => {
    const callbacks: Array<() => void> = [];
    const scheduler = createRenderScheduler({
      requestFrame: (cb) => {
        callbacks.push(cb);
        return callbacks.length;
      },
      cancelFrame: () => undefined,
      onFrame: () => undefined,
    });
    scheduler.schedule();
    expect(callbacks).toHaveLength(1);
    callbacks[0]!();
    scheduler.schedule();
    expect(callbacks).toHaveLength(2);
    scheduler.dispose();
  });

  it('forwards the owning animation-frame timestamp', () => {
    let callback: ((timeMs?: number) => void) | null = null;
    let observed = -1;
    const scheduler = createRenderScheduler({
      requestFrame: (next) => {
        callback = next;
        return 1;
      },
      cancelFrame: () => undefined,
      onFrame: (timeMs) => {
        observed = timeMs;
      },
    });
    scheduler.schedule();
    (callback as ((timeMs?: number) => void) | null)?.(123.5);
    expect(observed).toBe(123.5);
    scheduler.dispose();
  });

  it('cancels a pending frame on dispose without running it', () => {
    const onFrame = vi.fn();
    let cancelled: number | null = null;
    const scheduler = createRenderScheduler({
      requestFrame: () => 7,
      cancelFrame: (id) => {
        cancelled = id;
      },
      onFrame,
    });
    scheduler.schedule();
    scheduler.dispose();
    expect(cancelled).toBe(7);
    expect(onFrame).not.toHaveBeenCalled();
  });

  it('ignores schedule calls after dispose', () => {
    let requests = 0;
    const scheduler = createRenderScheduler({
      requestFrame: () => {
        requests += 1;
        return requests;
      },
      cancelFrame: () => undefined,
      onFrame: () => undefined,
    });
    scheduler.dispose();
    scheduler.schedule();
    expect(requests).toBe(0);
  });
});
