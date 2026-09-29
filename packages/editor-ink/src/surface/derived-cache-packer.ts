/**
 * Worker-backed derived-cache packer (dense-document pass, item 2).
 *
 * Hosts wire `createDerivedCachePackWorker` into `DerivedReopenStore`;
 * teardown persistence then hands already-packed warm geometry plus the
 * required translation/revision metadata to the worker, which performs
 * world-coordinate rebase and binary container construction off the UI
 * thread. Buffers created during the persistence pass (`transfer: true`)
 * transfer ownership; retained/shared buffers are structured-cloned.
 *
 * Unsupported hosts (jsdom/tests, no Worker) return null and the store
 * falls back to the cooperative main-thread packer. Never throws.
 */

import {
  packDerivedCacheOnMain,
  packLazyManifestContainer,
  rebasePackedCompiledInk,
  serializeDerivedCacheBinary,
  type DerivedCacheLazyPackResult,
  type DerivedCachePackEntry,
  type DerivedCachePackRequest,
  type DerivedCachePacker,
} from '@froglight/foundation';

interface PackWorkerResponse {
  readonly type: 'packed-derived-cache' | 'pack-derived-cache-error';
  readonly requestId: string;
  readonly bytes?: Uint8Array;
  readonly error?: string;
}

interface PackLazyWorkerResponse {
  readonly type: 'packed-derived-cache-lazy' | 'pack-derived-cache-error';
  readonly requestId: string;
  readonly manifest?: Uint8Array;
  readonly entries?: { objectId: string; bytes: Uint8Array }[];
  readonly error?: string;
}

/**
 * Pure container construction shared by the worker entry and parity
 * tests: world-coordinate rebase + one binary cache container.
 */
export function packDerivedCacheContainer(
  request: DerivedCachePackRequest,
): Uint8Array {
  const compiled = request.compiled.map((entry) => ({
    key: entry.key,
    packed:
      entry.tx === 0 && entry.ty === 0
        ? entry.packed
        : rebasePackedCompiledInk(entry.packed, entry.tx, entry.ty),
  }));
  return serializeDerivedCacheBinary({
    bounds: request.bounds,
    compiled,
  });
}

/**
 * Pure truly-lazy packing shared by the worker and tests: world-coordinate
 * rebase + per-entry standalone binaries + lightweight manifest/index.
 * Entries arrive already packed (retained); unpacked live records are never
 * packed here (callers skip them).
 */
export function packLazyManifest(
  request: DerivedCachePackRequest,
): DerivedCacheLazyPackResult {
  return packLazyManifestContainer(request);
}

/** Distinct backing buffers of one packed entry (for transfer). */
function transferOf(entry: DerivedCachePackEntry): ArrayBuffer[] {
  if (!entry.transfer) return [];
  const out = new Set<ArrayBuffer>();
  for (const value of Object.values(entry.packed)) {
    if (ArrayBuffer.isView(value)) out.add(value.buffer as ArrayBuffer);
  }
  return [...out];
}

let counter = 0;

class WorkerDerivedCachePacker implements DerivedCachePacker {
  readonly #worker: Worker;
  readonly #pending = new Map<
    string,
    { resolve: (bytes: Uint8Array) => void; reject: (error: Error) => void }
  >();
  readonly #pendingLazy = new Map<
    string,
    {
      resolve: (result: DerivedCacheLazyPackResult) => void;
      reject: (error: Error) => void;
    }
  >();

  constructor(worker: Worker) {
    this.#worker = worker;
    worker.onmessage = (
      event: MessageEvent<PackWorkerResponse | PackLazyWorkerResponse>,
    ) => {
      const response = event.data as
        | PackWorkerResponse
        | PackLazyWorkerResponse;
      if (response?.type === 'packed-derived-cache-lazy') {
        const pending = this.#pendingLazy.get(response.requestId ?? '');
        if (pending === undefined) return;
        this.#pendingLazy.delete(response.requestId);
        if (response.manifest !== undefined && response.entries !== undefined) {
          pending.resolve({
            manifest: response.manifest,
            entries: response.entries,
          });
        } else {
          pending.reject(
            new Error(response.error ?? 'derived-cache worker pack failed'),
          );
        }
        return;
      }
      const legacy = response as PackWorkerResponse;
      const pending = this.#pending.get(legacy?.requestId ?? '');
      if (pending === undefined) return;
      this.#pending.delete(legacy.requestId);
      if (legacy.type === 'packed-derived-cache' && legacy.bytes) {
        pending.resolve(legacy.bytes);
      } else {
        pending.reject(
          new Error(legacy.error ?? 'derived-cache worker pack failed'),
        );
      }
    };
    worker.onerror = () => {
      const error = new Error('derived-cache worker error');
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
      for (const pending of this.#pendingLazy.values()) pending.reject(error);
      this.#pendingLazy.clear();
    };
  }

  pack(request: DerivedCachePackRequest): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      counter += 1;
      const requestId = `derived-pack-${counter}`;
      const transfer: ArrayBuffer[] = [];
      for (const entry of request.compiled) {
        transfer.push(...transferOf(entry));
      }
      try {
        this.#worker.postMessage(
          { type: 'pack-derived-cache', ...request, requestId },
          transfer,
        );
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      this.#pending.set(requestId, { resolve, reject });
    });
  }

  packLazy(
    request: DerivedCachePackRequest,
  ): Promise<DerivedCacheLazyPackResult> {
    return new Promise<DerivedCacheLazyPackResult>((resolve, reject) => {
      counter += 1;
      const requestId = `derived-pack-lazy-${counter}`;
      const transfer: ArrayBuffer[] = [];
      for (const entry of request.compiled) {
        transfer.push(...transferOf(entry));
      }
      try {
        this.#worker.postMessage(
          { type: 'pack-derived-cache-lazy', ...request, requestId },
          transfer,
        );
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      this.#pendingLazy.set(requestId, { resolve, reject });
    });
  }

  dispose(): void {
    try {
      this.#worker.terminate();
    } catch {
      // Termination never throws.
    }
  }
}

/**
 * Construct the persistence worker, or null when workers are unavailable
 * (jsdom/tests/unsupported hosts fall back to the cooperative
 * main-thread packer — teardown never breaks).
 */
export function createDerivedCachePackWorker(): DerivedCachePacker | null {
  try {
    if (typeof Worker !== 'function') return null;
    const worker = new Worker(
      new URL('./derived-cache.worker.ts', import.meta.url),
      { type: 'module' },
    );
    return new WorkerDerivedCachePacker(worker);
  } catch {
    return null;
  }
}

/** Exposed for parity tests: cooperative main-thread packer. */
export { packDerivedCacheOnMain };
