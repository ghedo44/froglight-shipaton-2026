/**
 * Shared surface image plumbing conformance: aspect-preserving display
 * boxes, graceful decode degradation, and the asset-path → bitmap cache
 * every surface container resolves `froglight.image` objects through.
 */

import { describe, expect, it } from 'vitest';
import {
  emptySurface,
  imageObject,
  workspacePath,
  SURFACE_OBJECT_TYPES,
  type DocumentAssetStore,
} from '@froglight/foundation';
import {
  createSurfaceImageCache,
  decodeImageBytes,
  fitImageBox,
  type DecodedImage,
} from './images.js';

type RecordingAssetStore = DocumentAssetStore & { reads: string[] };

function memoryAssetStore(): RecordingAssetStore {
  const stored = new Map<string, Uint8Array>([
    [workspacePath('attachments/abc'), new Uint8Array([1, 2, 3])],
  ]);
  const reads: string[] = [];
  return {
    reads,
    async put() {
      throw new Error('not needed');
    },
    async read(path) {
      reads.push(path);
      const bytes = stored.get(path);
      if (bytes === undefined) throw new Error(`no asset at ${path}`);
      return bytes;
    },
  };
}

function bitmap(tag: string): DecodedImage {
  return { tag, width: 4, height: 2 } as unknown as DecodedImage;
}

describe('fitImageBox', () => {
  it('downscales large images to the box preserving aspect', () => {
    expect(fitImageBox({ width: 2000, height: 1000 }, 800)).toEqual({
      width: 800,
      height: 400,
    });
  });

  it('keeps the natural size of images that already fit', () => {
    expect(fitImageBox({ width: 300, height: 150 }, 800)).toEqual({
      width: 300,
      height: 150,
    });
  });

  it('degrades undecodable or degenerate images to a 4:3 box', () => {
    expect(fitImageBox(null, 800)).toEqual({ width: 800, height: 600 });
    expect(fitImageBox({ width: 0, height: 0 }, 800)).toEqual({
      width: 800,
      height: 600,
    });
  });
});

describe('decodeImageBytes', () => {
  it('resolves null instead of rejecting when nothing can decode', async () => {
    // jsdom exposes Image + object URLs but never fires image load events,
    // so the decode timeout must degrade to null; a rejection or hang here
    // would freeze rendering.
    await expect(
      decodeImageBytes(new Uint8Array([1, 2, 3]), { timeoutMs: 50 }),
    ).resolves.toBeNull();
  });
});

describe('createSurfaceImageCache', () => {
  it('loads an asset through the store and publishes the bitmap', async () => {
    const assets = memoryAssetStore();
    let readyCount = 0;
    const cache = createSurfaceImageCache({
      assets,
      onReady: () => (readyCount += 1),
      decode: async () => bitmap('decoded'),
    });

    await cache.request('attachments/abc');

    expect(cache.resolver.get('attachments/abc')).toEqual(bitmap('decoded'));
    expect(readyCount).toBe(1);
  });

  it('caches failures as null so placeholders render without retry loops', async () => {
    const assets = memoryAssetStore();
    const cache = createSurfaceImageCache({
      assets,
      decode: async () => null,
    });

    await cache.request('attachments/abc');
    await cache.request('attachments/abc');

    expect(cache.resolver.get('attachments/abc')).toBeNull();
    expect(assets.reads).toEqual(['attachments/abc']);
  });

  it('deduplicates in-flight loads of the same path', async () => {
    const assets = memoryAssetStore();
    const cache = createSurfaceImageCache({
      assets,
      decode: async () => bitmap('decoded'),
    });

    await Promise.all([
      cache.request('attachments/abc'),
      cache.request('attachments/abc'),
    ]);

    expect(assets.reads).toEqual(['attachments/abc']);
  });

  it('resolves missing assets to null without throwing', async () => {
    const assets = memoryAssetStore();
    const cache = createSurfaceImageCache({
      assets,
      decode: async () => bitmap('decoded'),
    });

    await cache.request('attachments/missing');

    expect(cache.resolver.get('attachments/missing')).toBeNull();
  });

  it('rejects unsafe paths before touching the store', async () => {
    const assets = memoryAssetStore();
    const cache = createSurfaceImageCache({
      assets,
      decode: async () => bitmap('decoded'),
    });

    await cache.request('../escape');

    expect(cache.resolver.get('../escape')).toBeNull();
    expect(assets.reads).toEqual([]);
  });

  it('requestSurface loads every image object in the surface', async () => {
    const assets = memoryAssetStore();
    const cache = createSurfaceImageCache({
      assets,
      decode: async () => bitmap('decoded'),
    });
    const surface = emptySurface();
    const first = imageObject('img-1', {
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      src: 'attachments/abc',
      sha256: 'abc',
    });
    surface.order.push(first.id);
    surface.objects[first.id] = first;

    await cache.requestSurface(surface);

    expect(assets.reads).toEqual(['attachments/abc']);
  });

  it('seeds already-decoded bitmaps (insertion flow)', () => {
    const cache = createSurfaceImageCache({
      assets: memoryAssetStore(),
      onReady: () => undefined,
    });

    cache.seed('attachments/abc', bitmap('fresh'));

    expect(cache.resolver.get('attachments/abc')).toEqual(bitmap('fresh'));
  });

  it('stops publishing after dispose', async () => {
    const assets = memoryAssetStore();
    let readyCount = 0;
    const cache = createSurfaceImageCache({
      assets,
      onReady: () => (readyCount += 1),
      decode: async () => bitmap('decoded'),
    });

    cache.dispose();
    await cache.request('attachments/abc');

    expect(assets.reads).toEqual([]);
    expect(readyCount).toBe(0);
    expect(cache.resolver.size).toBe(0);
  });

  it('exposes the resolver as a plain readonly map for renderer backends', () => {
    const cache = createSurfaceImageCache({ assets: memoryAssetStore() });
    expect(cache.resolver).toBeInstanceOf(Map);
    expect(cache.resolver.get('attachments/nothing')).toBeUndefined();
    expect(SURFACE_OBJECT_TYPES.image).toBe('froglight.image');
  });
});
