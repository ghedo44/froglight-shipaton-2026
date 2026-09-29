/**
 * Image insertion/placement tests.
 *
 * Shared decode/cache primitives stay in images.ts; file-to-asset
 * insertion, natural-size fit, object placement, and cache seeding are
 * covered here with deterministic fixtures and a fake DocumentAssetStore.
 */

import { describe, expect, it } from 'vitest';
import {
  boundedFrame,
  emptySurface,
  workspacePath,
  type SurfaceModel,
  type SurfaceObjectRecord,
} from '@froglight/foundation';
import {
  computeImageCenter,
  computeImagePlacement,
  createImageIngester,
} from './image-ingest.js';

function pngFile(): File {
  return new File([new Uint8Array([137, 80, 78, 71])], 'photo.png', {
    type: 'image/png',
  });
}

describe('computeImageCenter', () => {
  it('centers on the bounded sheet when a frame exists', () => {
    expect(
      computeImageCenter(
        { width: 800, height: 600 },
        { x: 0, y: 0, zoom: 1 },
        { width: 800, height: 600 },
      ),
    ).toEqual({ x: 400, y: 300 });
  });

  it('drops at the viewport center for infinite boards', () => {
    expect(
      computeImageCenter(null, { x: 10, y: 20, zoom: 2 }, { width: 800, height: 600 }),
    ).toEqual({ x: 10 + 800 / 4, y: 20 + 600 / 4 });
  });
});

describe('computeImagePlacement', () => {
  it('fits the natural bitmap inside the 50%-width box untouched', () => {
    const placement = computeImagePlacement(
      { width: 400, height: 200 },
      { width: 800, height: 600 },
      { x: 0, y: 0, zoom: 1 },
      { width: 800, height: 600 },
    );
    expect(placement.box).toEqual({ width: 400, height: 200 });
    expect(placement.x).toBe(200);
    expect(placement.y).toBe(200);
  });

  it('degrades degenerate bitmaps to a 4:3 box at the limit', () => {
    const placement = computeImagePlacement(
      null,
      { width: 800, height: 600 },
      { x: 0, y: 0, zoom: 1 },
      { width: 800, height: 600 },
    );
    expect(placement.box.width).toBe(400);
    expect(placement.box.height).toBe(300);
  });
});

describe('createImageIngester', () => {
  function setup(model: SurfaceModel) {
    const puts: Array<{ name: string; bytes: Uint8Array }> = [];
    const stored = new Map<string, Uint8Array>();
    const seeded = new Map<string, unknown>();
    const assets = {
      async put(bytes: Uint8Array, options?: { suggestedName?: string }) {
        puts.push({ name: options?.suggestedName ?? '', bytes });
        const path = workspacePath(`attachments/hash-${puts.length}`);
        stored.set(path, bytes);
        return { path, sha256: `sha-${puts.length}` };
      },
      async read(path: string) {
        const bytes = stored.get(path);
        if (bytes === undefined) throw new Error('missing asset');
        return bytes;
      },
    };
    const bitmap = { width: 400, height: 200, tag: 'bitmap' } as unknown as import('./image-ingest.js').DecodedBitmap;
    let gestures = 0;
    const added: string[] = [];
    const ingester = createImageIngester({
      model,
      assets,
      decode: async () => bitmap,
      imageCache: { seed: (path: string, image: unknown) => seeded.set(path, image) },
      getFrame: () => ({ width: 800, height: 600 }),
      getCamera: () => ({ x: 0, y: 0, zoom: 1 }),
      getViewport: () => ({ width: 800, height: 600 }),
      beginGesture: () => (gestures += 1),
      commitGesture: () => undefined,
      addObject: (record: SurfaceObjectRecord) => {
        model.objects[record.id] = record;
        model.order.push(record.id);
        added.push(record.id);
      },
      setSelection: () => undefined,
      isReadOnly: () => false,
      isDestroyed: () => false,
      newId: () => 'img-1',
    });
    return { ingester, puts, seeded, model, getGestures: () => gestures };
  }

  it('stores one asset, places deterministically, and seeds the cache', async () => {
    const model = emptySurface(boundedFrame(800, 600));
    const { ingester, puts, seeded } = setup(model);
    expect(ingester.canInsert()).toBe(true);
    const id = await ingester.insertImage(pngFile());
    expect(id).toBe('img-1');
    expect(puts).toHaveLength(1);
    expect(puts[0]!.name).toBe('photo.png');
    const record = model.objects['img-1']! as unknown as { width: number; height: number; x: number; y: number };
    expect(record.width).toBe(400);
    expect(record.height).toBe(200);
    expect(record.x).toBe(200);
    expect(record.y).toBe(200);
    expect(seeded.size).toBe(1);
  });

  it('returns null without an asset store or when read-only', async () => {
    const model = emptySurface(boundedFrame(800, 600));
    const { ingester } = setup(model);
    const bare = createImageIngester({
      model,
      assets: null,
      decode: async () => null,
      imageCache: null,
      getFrame: () => ({ width: 800, height: 600 }),
      getCamera: () => ({ x: 0, y: 0, zoom: 1 }),
      getViewport: () => ({ width: 800, height: 600 }),
      beginGesture: () => undefined,
      commitGesture: () => undefined,
      addObject: () => undefined,
      setSelection: () => undefined,
      isReadOnly: () => true,
      isDestroyed: () => false,
      newId: () => 'img-x',
    });
    expect(bare.canInsert()).toBe(false);
    await expect(bare.insertImage(pngFile())).resolves.toBeNull();
    expect(model.order).toHaveLength(0);
    expect(ingester.canInsert()).toBe(true);
  });
});
