// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  appendPage,
  boundedFrame,
  emptyNotebook,
  emptySurface,
  isNavigablePage,
  notebookPage,
  workspacePath,
  type DocumentAssetStore,
  type NotebookModel,
} from '@froglight/foundation';
import {
  insertImageIntoCurrentPage,
  type ImageInsertEnvironment,
} from './image-insert.js';

function modelWithPage(): NotebookModel {
  const model = emptyNotebook();
  appendPage(
    model,
    notebookPage('p1', { surface: emptySurface(boundedFrame(800, 600)) }),
  );
  return model;
}

function fileWithBytes(bytes: Uint8Array<ArrayBuffer>): File {
  const file = new File([bytes], 'photo.png', { type: 'image/png' });
  Object.defineProperty(file, 'arrayBuffer', {
    value: async () => bytes.buffer.slice(0) as ArrayBuffer,
  });
  return file;
}

function baseEnv(model: NotebookModel): ImageInsertEnvironment & {
  seeded: Map<string, unknown>;
  calls: { dirtied: number; inserted: number };
  assets: DocumentAssetStore & { puts: number };
} {
  const seeded = new Map<string, unknown>();
  const calls = { dirtied: 0, inserted: 0 };
  const assets = {
    puts: 0,
    put: async (bytes: Uint8Array, options?: { suggestedName?: string }) => {
      assets.puts += 1;
      return {
        path: workspacePath(`attachments/${options?.suggestedName ?? 'file'}`),
        sha256: `hash-${bytes.length}`,
      };
    },
    read: async () => {
      throw new Error('unreadable in this fixture');
    },
  };
  const env = {
    seeded,
    calls,
    assets,
    model,
    decode: async () => ({ width: 200, height: 100 }) as never,
    seedImage: (path: string, image: CanvasImageSource) => {
      seeded.set(path, image);
    },
    markDirty: () => {
      calls.dirtied += 1;
    },
    afterInsert: () => {
      calls.inserted += 1;
    },
    isActive: () => true,
  };
  return env;
}

describe('insertImageIntoCurrentPage', () => {
  it('stores one asset, centers a half-width object, and seeds the cache', async () => {
    const model = modelWithPage();
    const env = baseEnv(model);
    await insertImageIntoCurrentPage(env, 0, fileWithBytes(new Uint8Array([1, 2, 3])), () => 'o1');
    expect(env.assets.puts).toBe(1);
    const entry = model.pages['p1'];
    expect(isNavigablePage(entry)).toBe(true);
    if (!isNavigablePage(entry)) return;
    expect(entry.surface.order).toEqual(['img-o1']);
    const object = entry.surface.objects['img-o1'] as unknown as {
      type: string;
      width: number;
      height: number;
      x: number;
      y: number;
      src: string;
    };
    // 200x100 bitmap already fits half the 800pt page: natural size kept,
    // centered at ((800-200)/2, (600-100)/2).
    expect(object.width).toBe(200);
    expect(object.height).toBe(100);
    expect(object.x).toBe(300);
    expect(object.y).toBe(250);
    expect(object.src).toBe('attachments/photo.png');
    expect(env.seeded.has('attachments/photo.png')).toBe(true);
    expect(env.calls.dirtied).toBe(1);
    expect(env.calls.inserted).toBe(1);
  });

  it('throws without a readable page', async () => {
    const model = emptyNotebook();
    const env = baseEnv(model);
    await expect(
      insertImageIntoCurrentPage(env, 0, fileWithBytes(new Uint8Array([1])), () => 'o1'),
    ).rejects.toThrow('no readable page');
    expect(env.assets.puts).toBe(0);
  });

  it('aborts silently when the pager dies mid-flight', async () => {
    const model = modelWithPage();
    let active = true;
    const env = { ...baseEnv(model), isActive: () => active };
    const pending = insertImageIntoCurrentPage(
      env,
      0,
      fileWithBytes(new Uint8Array([1])),
      () => 'o1',
    );
    active = false;
    await pending;
    const entry = model.pages['p1'];
    expect(isNavigablePage(entry) ? entry.surface.order : []).toEqual([]);
    expect(env.calls.dirtied).toBe(0);
  });

  it('aborts when the page is replaced underneath the async work', async () => {
    const model = modelWithPage();
    const env = baseEnv(model);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const assets = {
      ...env.assets,
      put: async (bytes: Uint8Array, options?: { suggestedName?: string }) => {
        const stored = await env.assets.put(bytes, options);
        await gate;
        return stored;
      },
    };
    const pending = insertImageIntoCurrentPage(
      { ...env, assets },
      0,
      fileWithBytes(new Uint8Array([1])),
      () => 'o1',
    );
    // Replace the page entry while the asset stores.
    const replacement = notebookPage('p1', {
      surface: emptySurface(boundedFrame(800, 600)),
    });
    model.pages['p1'] = replacement;
    release();
    await pending;
    expect(replacement.surface.order).toEqual([]);
    expect(env.calls.dirtied).toBe(0);
  });

  it('degrades to a 4:3 box when the bitmap cannot decode', async () => {
    const model = modelWithPage();
    const env = { ...baseEnv(model), decode: async () => null };
    await insertImageIntoCurrentPage(env, 0, fileWithBytes(new Uint8Array([1])), () => 'o1');
    const entry = model.pages['p1'];
    expect(isNavigablePage(entry)).toBe(true);
    if (!isNavigablePage(entry)) return;
    const object = entry.surface.objects['img-o1'] as unknown as {
      width: number;
      height: number;
    };
    expect(object.width).toBe(400);
    expect(object.height).toBe(300);
    expect(env.seeded.size).toBe(0);
    expect(env.calls.dirtied).toBe(1);
  });
});
