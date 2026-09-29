/**
 * Render-loop scheduling.
 *
 * Owns invalidation/coalescing and cache-key computation. Background item
 * assembly, cache-canvas lifecycle, image-resolver consumption, and backend
 * invocation continue through the existing renderer-backend seam — this
 * module only decides *when* a frame runs, never *what* pixels mean.
 */

import type { Camera, Size } from '@froglight/foundation';

export type RenderViewport = Size & { readonly dpr: number };

/** Frame identity: scene version + camera + backing size. */
export function buildRenderCacheKey(
  sceneVersion: number,
  camera: Camera,
  viewport: RenderViewport,
): string {
  return `${sceneVersion}|${camera.x}|${camera.y}|${camera.zoom}|${viewport.width}x${viewport.height}@${viewport.dpr}`;
}

export interface RenderSchedulerPorts {
  readonly requestFrame: (callback: (timeMs?: number) => void) => number;
  readonly cancelFrame: (id: number) => void;
  readonly onFrame: (timeMs: number) => void;
}

export interface RenderScheduler {
  schedule(): void;
  isScheduled(): boolean;
  dispose(): void;
}

/**
 * rAF-coalesced invalidation. Multiple schedule() calls before the frame
 * runs collapse into one onFrame invocation.
 */
export function createRenderScheduler(
  ports: RenderSchedulerPorts,
): RenderScheduler {
  let frameRequest: number | null = null;
  let disposed = false;

  function schedule(): void {
    if (disposed || frameRequest !== null) return;
    // Sentinel blocks re-entry while the port runs a synchronous callback
    // (fake clocks in unit tests). Real rAF is async and follows the same path.
    frameRequest = 0;
    let assigned: number | null = null;
    let firedSync = false;
    let synchronousTime = 0;
    const id = ports.requestFrame((timeMs) => {
      const frameTime =
        typeof timeMs === 'number' && Number.isFinite(timeMs)
          ? timeMs
          : performance.now();
      if (assigned === null) {
        firedSync = true;
        synchronousTime = frameTime;
        return;
      }
      frameRequest = null;
      if (disposed) return;
      ports.onFrame(frameTime);
    });
    assigned = id;
    if (firedSync) {
      frameRequest = null;
      if (!disposed) ports.onFrame(synchronousTime);
    } else {
      frameRequest = id;
    }
  }

  return {
    schedule,
    isScheduled: () => frameRequest !== null,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      if (frameRequest !== null) {
        ports.cancelFrame(frameRequest);
        frameRequest = null;
      }
    },
  };
}
