/**
 * Derived-cache persistence worker (dense-document pass, item 2).
 *
 * Receives already-packed warm geometry plus the required translation /
 * revision metadata and performs, away from the UI thread:
 *
 * ```text
 * packed LOCAL geometry + (tx, ty)
 *   → world-coordinate rebase (interleaved XY fields only)
 *   → one compact binary cache container
 *   → transferred Uint8Array
 * ```
 *
 * The worker NEVER recompiles or re-packs geometry: entries arrive in the
 * SAME `PackedCompiledInk` representation the compile worker and durable
 * cache use. Buffers the main thread exclusively owns are transferred
 * (zero-copy); shared/retained buffers are structured-cloned by the
 * sender. Bundled by Vite as a separate entry via
 * `new Worker(new URL('./derived-cache.worker.ts', import.meta.url))`.
 */

/// <reference lib="webworker" />

import type {
  DerivedCacheLazyPackResult,
  DerivedCachePackRequest,
} from '@froglight/foundation';
import {
  packDerivedCacheContainer,
  packLazyManifest,
} from './derived-cache-packer.js';

interface PackWorkerRequest extends DerivedCachePackRequest {
  readonly type: 'pack-derived-cache' | 'pack-derived-cache-lazy';
  readonly requestId: string;
}

type PackWorkerResponse =
  | {
      readonly type: 'packed-derived-cache';
      readonly requestId: string;
      readonly bytes: Uint8Array;
    }
  | {
      readonly type: 'packed-derived-cache-lazy';
      readonly requestId: string;
      readonly manifest: Uint8Array;
      readonly entries: { objectId: string; bytes: Uint8Array }[];
    }
  | {
      readonly type: 'pack-derived-cache-error';
      readonly requestId: string;
      readonly error: string;
    };

self.onmessage = (event: MessageEvent<PackWorkerRequest>) => {
  const request = event.data;
  if (
    request === null ||
    typeof request !== 'object' ||
    (request.type !== 'pack-derived-cache' &&
      request.type !== 'pack-derived-cache-lazy') ||
    typeof request.requestId !== 'string' ||
    !Array.isArray(request.bounds) ||
    !Array.isArray(request.compiled)
  ) {
    // Malformed request: settle the main-side promise so it can fall back
    // to the cooperative packer instead of hanging teardown.
    try {
      const fallback = (request ?? {}) as Partial<PackWorkerRequest>;
      if (typeof fallback.requestId === 'string') {
        const response: PackWorkerResponse = {
          type: 'pack-derived-cache-error',
          requestId: fallback.requestId,
          error: 'malformed pack-derived-cache request',
        };
        self.postMessage(response);
      }
    } catch {
      // Posting must never throw the worker loop.
    }
    return;
  }
  try {
    if (request.type === 'pack-derived-cache-lazy') {
      const result: DerivedCacheLazyPackResult = packLazyManifest(request);
      const transfer: ArrayBuffer[] = [result.manifest.buffer as ArrayBuffer];
      for (const entry of result.entries) {
        transfer.push(entry.bytes.buffer as ArrayBuffer);
      }
      const response: PackWorkerResponse = {
        type: 'packed-derived-cache-lazy',
        requestId: request.requestId,
        manifest: result.manifest,
        entries: result.entries,
      };
      self.postMessage(response, transfer);
      return;
    }
    const bytes = packDerivedCacheContainer(request);
    const response: PackWorkerResponse = {
      type: 'packed-derived-cache',
      requestId: request.requestId,
      bytes,
    };
    self.postMessage(response, [bytes.buffer as ArrayBuffer]);
  } catch (error) {
    try {
      const response: PackWorkerResponse = {
        type: 'pack-derived-cache-error',
        requestId: request.requestId,
        error: error instanceof Error ? error.message : String(error),
      };
      self.postMessage(response);
    } catch {
      // Posting must never throw the worker loop.
    }
  }
};
