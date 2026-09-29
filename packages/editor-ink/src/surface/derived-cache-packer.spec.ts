// @vitest-environment jsdom
/**
 * Off-main-thread persistence packer (dense-document pass, item 2).
 *
 * The worker receives already-packed geometry plus translation metadata,
 * performs the world-coordinate rebase and binary container construction,
 * and transfers the result bytes back. Buffers the caller exclusively
 * owns are transferred; retained/shared buffers stay intact.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  derivedCacheKey,
  compiledStrokeForRecord,
  emptySurface,
  boundedFrame,
  inkStrokeObject,
  packCompiledInk,
  type DerivedCachePackRequest,
} from '@froglight/foundation';
import {
  createDerivedCachePackWorker,
  packDerivedCacheContainer,
} from './derived-cache-packer.js';

interface PackWorkerMessage extends DerivedCachePackRequest {
  readonly type: 'pack-derived-cache';
  readonly requestId: string;
}

class FakeWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly transfers: ArrayBuffer[][] = [];
  fail = false;

  postMessage(message: PackWorkerMessage, transfer: ArrayBuffer[] = []): void {
    this.transfers.push(transfer);
    // Simulate real transfer detaching the sender's buffers.
    const cloned = structuredClone(message, { transfer });
    queueMicrotask(() => {
      if (this.fail) {
        this.onmessage?.({
          data: {
            type: 'pack-derived-cache-error',
            requestId: cloned.requestId,
            error: 'worker exploded',
          },
        });
        return;
      }
      const bytes = packDerivedCacheContainer(cloned);
      this.onmessage?.({
        data: {
          type: 'packed-derived-cache',
          requestId: cloned.requestId,
          bytes,
        },
      });
    });
  }

  terminate(): void {
    // No-op.
  }
}

function packedTemplate(samples: number) {
  const model = emptySurface(boundedFrame(2000, 2000));
  const points = Array.from({ length: samples }, (_, i) => ({
    x: i * 2,
    y: Math.sin(i / 5) * 5,
    pressure: 0.5,
    dt: i * 8,
  }));
  model.objects['s0'] = inkStrokeObject('s0', { points, width: 3 });
  const compiled = compiledStrokeForRecord(model.objects['s0']!);
  expect(compiled).not.toBeNull();
  return packCompiledInk(compiled!).packed;
}

describe('derived-cache persistence worker packer', () => {
  const originalWorker = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
  let fake: FakeWorker | null = null;

  afterEach(() => {
    if (originalWorker === undefined) {
      delete (globalThis as { Worker?: unknown }).Worker;
    } else {
      Object.defineProperty(globalThis, 'Worker', originalWorker);
    }
    fake = null;
    vi.restoreAllMocks();
  });

  function installFakeWorker(): FakeWorker {
    fake = new FakeWorker();
    Object.defineProperty(globalThis, 'Worker', {
      value: function () {
        return fake;
      },
      configurable: true,
      writable: true,
    });
    return fake;
  }

  it('packs through the worker and transfers exclusively-owned buffers', async () => {
    const worker = installFakeWorker();
    const packer = createDerivedCachePackWorker();
    expect(packer).not.toBeNull();

    const retained = packedTemplate(60);
    const fresh = packedTemplate(60);
    const request: DerivedCachePackRequest = {
      documentId: 'doc',
      revision: 'rev',
      bounds: [],
      compiled: [
        {
          key: derivedCacheKey('doc', 'retained', 'rev'),
          packed: retained,
          tx: 0,
          ty: 0,
          transfer: false,
        },
        {
          key: derivedCacheKey('doc', 'fresh', 'rev'),
          packed: fresh,
          tx: 4,
          ty: -3,
          transfer: true,
        },
      ],
    };
    // Reference container computed BEFORE the transfer detaches buffers.
    const expected = packDerivedCacheContainer(request);
    const bytes = await packer!.pack(request);
    // Retained buffers survive (shared with the record/cache).
    expect(retained.nodeXY.byteLength).toBeGreaterThan(0);
    // Exclusively-owned buffers transferred (detached on the main thread).
    expect(fresh.nodeXY.byteLength).toBe(0);
    expect(worker.transfers).toHaveLength(1);
    expect(worker.transfers[0]!.length).toBeGreaterThan(0);

    // The worker's container matches a direct world-rebased serialization.
    expect(bytes).toEqual(expected);
  });

  it('rejects when the worker reports an error (store falls back)', async () => {
    const worker = installFakeWorker();
    worker.fail = true;
    const packer = createDerivedCachePackWorker();
    expect(packer).not.toBeNull();
    await expect(
      packer!.pack({
        documentId: 'doc',
        revision: 'rev',
        bounds: [],
        compiled: [],
      }),
    ).rejects.toThrow('worker exploded');
  });

  it('returns null when workers are unavailable', () => {
    delete (globalThis as { Worker?: unknown }).Worker;
    expect(createDerivedCachePackWorker()).toBeNull();
  });
});
