/**
 * Cold Ink compilation worker.
 *
 * Runs the SAME headless `compileInkStroke` implementation as the
 * main thread (shared module, no geometry fork) for one canonical stroke
 * per message, then transfers packed derived geometry back. The
 * scheduler (`ColdInkCompileScheduler`) owns queueing, priority, and
 * staleness; this file only compiles serially and never holds state
 * between messages beyond the in-flight compile.
 *
 * Transport is packed transferable typed arrays (never `InkSample[]` /
 * `Point[]` object graphs): input buffers transfer in, output buffers
 * transfer out. Live writing never routes here: pointer input stays on
 * the main-thread incremental compiler. Bundled by Vite as a separate
 * entry via `new Worker(new URL('./ink-compile.worker.ts', import.meta.url))`.
 */

/// <reference lib="webworker" />

import {
  compileInkStroke,
  packCompiledInk,
  packedResponseTransfer,
  unpackInkSamples,
  validatePackedSamples,
  type PackedInkCompileRequest,
  type PackedInkCompiledResponse,
  type PackedInkCompileResponse,
} from '@froglight/foundation';

function now(): number {
  try {
    return performance.now();
  } catch {
    return Date.now();
  }
}

function fail(
  request: Pick<
    PackedInkCompileRequest,
    'requestId' | 'objectId' | 'generation'
  >,
  error: unknown,
): PackedInkCompileResponse {
  return {
    type: 'compile-error',
    requestId: request.requestId,
    objectId: request.objectId,
    generation: request.generation,
    error: error instanceof Error ? error.message : String(error),
  };
}

self.onmessage = (event: MessageEvent<PackedInkCompileRequest>) => {
  const request = event.data as PackedInkCompileRequest;
  if (
    request === null ||
    typeof request !== 'object' ||
    request.type !== 'compile-ink' ||
    typeof request.requestId !== 'string' ||
    typeof request.brush !== 'object' ||
    request.brush === null ||
    validatePackedSamples(
      (request as Partial<PackedInkCompileRequest>)
        .samples as PackedInkCompileRequest['samples'],
    ) !== null
  ) {
    try {
      const fallback = (request ?? {}) as Partial<PackedInkCompileRequest>;
      self.postMessage(
        fail(
          {
            requestId:
              typeof fallback.requestId === 'string' ? fallback.requestId : '',
            objectId:
              typeof fallback.objectId === 'string' ? fallback.objectId : '',
            generation:
              typeof fallback.generation === 'number' ? fallback.generation : 0,
          },
          'malformed compile-ink request',
        ) satisfies PackedInkCompileResponse,
      );
    } catch {
      // Posting must never throw the worker loop.
    }
    return;
  }
  const unpackStart = now();
  let samples;
  try {
    samples = unpackInkSamples(request.samples);
  } catch (error) {
    try {
      self.postMessage(fail(request, error));
    } catch {
      // Posting must never throw the worker loop.
    }
    return;
  }
  const workerUnpackMs = now() - unpackStart;
  const start = now();
  try {
    const compiled = compileInkStroke(
      samples,
      request.brush,
      request.options ?? {},
    );
    const compileMs = now() - start;
    const packStart = now();
    const { packed, bytes } = packCompiledInk(compiled);
    const packMs = now() - packStart;
    const response: PackedInkCompiledResponse = {
      type: 'compiled-ink',
      requestId: request.requestId,
      objectId: request.objectId,
      generation: request.generation,
      compiled: packed,
      workerUnpackMs,
      compileMs,
      packMs,
      outputBytes: bytes,
    };
    self.postMessage(response, packedResponseTransfer(response));
  } catch (error) {
    try {
      self.postMessage(fail(request, error));
    } catch {
      // Posting must never throw the worker loop.
    }
  }
};
