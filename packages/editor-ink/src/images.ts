/**
 * Shared surface image plumbing: decodes
 * `froglight.image` asset bytes into `CanvasImageSource` bitmaps keyed by
 * vault-relative asset path. Every surface container (.ink, whiteboard,
 * notebook pages) resolves images through this one module — canonical
 * bytes never embed rasters, and bitmap resolution stays above the
 * renderer backend seam (backends only ever see draw items).
 */

import {
  isWorkspacePath,
  SURFACE_OBJECT_TYPES,
  type DocumentAssetStore,
  type SurfaceModel,
} from '@froglight/foundation';
import type { SurfaceImageResolver } from '@froglight/surface-default';

/** Display box for an image, in surface units. */
export interface ImageBox {
  readonly width: number;
  readonly height: number;
}

/** A decoded bitmap that reports its natural pixel size. */
export type DecodedImage = CanvasImageSource & {
  readonly width: number;
  readonly height: number;
};

/**
 * Aspect-preserving display box at most `maxWidth` surface units wide.
 * Images that already fit keep their natural size (never upscaled);
 * undecodable or degenerate images degrade to a 4:3 box at the limit.
 */
export function fitImageBox(
  natural: { readonly width: number; readonly height: number } | null,
  maxWidth: number,
): ImageBox {
  const limit = Math.max(1, Math.round(maxWidth));
  if (natural === null || natural.width <= 0 || natural.height <= 0) {
    return { width: limit, height: Math.max(1, Math.round((limit * 3) / 4)) };
  }
  const width = Math.min(natural.width, limit);
  return {
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round((natural.height / natural.width) * width)),
  };
}

/**
 * Upper bound for one bitmap decode. Environments that expose image
 * primitives but never load (jsdom, exotic hosts) would otherwise hang
 * the Image fallback forever; browsers decode far inside this budget.
 */
const IMAGE_DECODE_TIMEOUT_MS = 4_000;

/**
 * Decode image bytes to a bitmap; resolves null on any failure (or when
 * decoding exceeds the timeout) so callers keep rendering placeholders.
 * Never rejects.
 */
export async function decodeImageBytes(
  bytes: Uint8Array,
  options: { timeoutMs?: number } = {},
): Promise<DecodedImage | null> {
  const buffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const blob = new Blob([buffer], { type: 'image/*' });
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(blob);
    } catch {
      return null;
    }
  }
  if (
    typeof Image === 'undefined' ||
    typeof URL.createObjectURL !== 'function'
  ) {
    return null;
  }
  const image = new Image();
  const objectUrl = URL.createObjectURL(blob);
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(
      () => resolve(null),
      Math.max(1, options.timeoutMs ?? IMAGE_DECODE_TIMEOUT_MS),
    );
  });
  try {
    const loaded = new Promise<DecodedImage>((resolve, reject) => {
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('asset image failed to decode'));
    });
    image.src = objectUrl;
    const decodeStep =
      typeof image.decode === 'function'
        ? image.decode().then(() => image)
        : loaded;
    return await Promise.race([decodeStep, loaded, timeout]);
  } catch {
    return null;
  } finally {
    if (timer !== null) clearTimeout(timer);
    URL.revokeObjectURL(objectUrl);
  }
}

export interface SurfaceImageCacheOptions {
  readonly assets: DocumentAssetStore;
  /** Invoked after each image finishes loading (success or failure). */
  readonly onReady?: () => void;
  /** Decode override (tests); defaults to decodeImageBytes. */
  readonly decode?: (bytes: Uint8Array) => Promise<DecodedImage | null>;
}

export interface SurfaceImageCache {
  /**
   * Live resolver for renderer backends: asset path → decoded source,
   * null (unresolvable), or undefined (still loading → placeholder).
   */
  readonly resolver: SurfaceImageResolver;
  /** Load one asset path; resolves when the load settles, never rejects. */
  request(path: string): Promise<void>;
  /** Kick off loads for every image object in the surface. */
  requestSurface(surface: SurfaceModel): Promise<void>;
  /** Publish an already-decoded bitmap (e.g. right after insertion). */
  seed(path: string, image: CanvasImageSource): void;
  /** Stop publishing; pending loads settle silently. */
  dispose(): void;
}

export function createSurfaceImageCache(
  options: SurfaceImageCacheOptions,
): SurfaceImageCache {
  const cache = new Map<string, CanvasImageSource | null | undefined>();
  const loads = new Map<string, Promise<void>>();
  const decode = options.decode ?? decodeImageBytes;
  let disposed = false;

  function settle(path: string, image: CanvasImageSource | null): void {
    if (disposed) return;
    cache.set(path, image);
    options.onReady?.();
  }

  function request(path: string): Promise<void> {
    if (disposed) return Promise.resolve();
    const existing = loads.get(path);
    if (existing !== undefined) return existing;
    if (cache.has(path)) return Promise.resolve();
    const load = Promise.resolve()
      .then(() => {
        if (!isWorkspacePath(path)) throw new Error('invalid asset path');
        return options.assets.read(path);
      })
      .then((bytes) => decode(bytes))
      .catch(() => null)
      .then((image) => settle(path, image))
      .finally(() => loads.delete(path));
    loads.set(path, load);
    return load;
  }

  return {
    resolver: cache,
    request,
    requestSurface(surface) {
      const requests: Promise<void>[] = [];
      for (const id of surface.order) {
        const object = surface.objects[id];
        if (
          object?.type === SURFACE_OBJECT_TYPES.image &&
          typeof object.src === 'string'
        ) {
          requests.push(request(object.src));
        }
      }
      return Promise.all(requests).then(() => undefined);
    },
    seed(path, image) {
      settle(path, image);
    },
    dispose() {
      disposed = true;
      cache.clear();
    },
  };
}
