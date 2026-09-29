/**
 * Image insertion/placement.
 *
 * Keeps shared decode/cache primitives in images.ts; moves file-to-asset
 * insertion, natural-size fit, object placement, and cache seeding here.
 * Depends on DocumentAssetStore and the existing SurfaceImageCache seam.
 */

import {
  imageObject,
  type Camera,
  type DocumentAssetStore,
  type Size,
  type SurfaceModel,
  type SurfaceObjectRecord,
} from '@froglight/foundation';
import {
  decodeImageBytes,
  fitImageBox,
  type DecodedImage,
} from '../images.js';

export type DecodedBitmap = DecodedImage | {
  readonly width: number;
  readonly height: number;
};

/** Center rule: bounded pages center on the sheet, infinite boards use viewport. */
export function computeImageCenter(
  frame: Size | null,
  camera: Camera,
  viewport: Size,
): { x: number; y: number } {
  if (frame !== null) {
    return { x: frame.width / 2, y: frame.height / 2 };
  }
  return {
    x: camera.x + viewport.width / (2 * camera.zoom),
    y: camera.y + viewport.height / (2 * camera.zoom),
  };
}

export interface ImagePlacement {
  readonly box: { width: number; height: number };
  readonly center: { x: number; y: number };
  readonly x: number;
  readonly y: number;
}

/** Deterministic fit + placement for one decoded bitmap. */
export function computeImagePlacement(
  natural: { readonly width: number; readonly height: number } | null,
  frame: Size | null,
  camera: Camera,
  viewport: Size,
): ImagePlacement {
  const validNatural =
    natural !== null && natural.width > 0 && natural.height > 0
      ? natural
      : null;
  const maxWidth =
    frame !== null
      ? frame.width * 0.5
      : validNatural !== null && validNatural.width > 0
        ? validNatural.width
        : viewport.width / camera.zoom;
  const box = fitImageBox(validNatural, maxWidth);
  const center = computeImageCenter(frame, camera, viewport);
  return {
    box,
    center,
    x: Math.round(center.x - box.width / 2),
    y: Math.round(center.y - box.height / 2),
  };
}

export interface ImageCachePort {
  seed(path: string, image: unknown): void;
}

export interface ImageIngesterDeps {
  readonly model: SurfaceModel;
  readonly assets: DocumentAssetStore | null;
  readonly decode?: (bytes: Uint8Array) => Promise<DecodedBitmap | null>;
  readonly imageCache: ImageCachePort | null;
  readonly getFrame: () => Size | null;
  readonly getCamera: () => Camera;
  readonly getViewport: () => Size;
  readonly beginGesture: () => void;
  readonly commitGesture: () => void;
  readonly addObject: (record: SurfaceObjectRecord) => void;
  readonly setSelection: (ids: readonly string[]) => void;
  readonly isReadOnly: () => boolean;
  readonly isDestroyed: () => boolean;
  /**
   * Deterministic id factory (tests). Production falls back to a
   * time/random suffix matching the pre-split engine behavior.
   */
  readonly newId?: () => string;
}

export interface ImageIngester {
  canInsert(): boolean;
  insertImage(file: File): Promise<string | null>;
}

/** File-to-asset insertion using the shared cache seam. */
export function createImageIngester(deps: ImageIngesterDeps): ImageIngester {
  function canInsert(): boolean {
    return (
      deps.assets !== null &&
      deps.imageCache !== null &&
      !deps.isReadOnly() &&
      !deps.isDestroyed()
    );
  }

  async function insertImage(file: File): Promise<string | null> {
    if (
      deps.assets === null ||
      deps.imageCache === null ||
      deps.isReadOnly() ||
      deps.isDestroyed()
    ) {
      return null;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const stored = await deps.assets.put(bytes, { suggestedName: file.name });
    const bitmap = await (deps.decode ?? decodeImageBytes)(bytes);
    if (deps.isDestroyed()) return null;
    if (bitmap !== null) deps.imageCache.seed(stored.path, bitmap);

    const frame = deps.getFrame();
    const camera = deps.getCamera();
    const viewport = deps.getViewport();
    const natural =
      bitmap !== null && bitmap.width > 0 && bitmap.height > 0
        ? { width: bitmap.width, height: bitmap.height }
        : null;
    const placement = computeImagePlacement(natural, frame, camera, viewport);
    const id =
      deps.newId?.() ??
      `img-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    deps.beginGesture();
    deps.addObject(
      imageObject(id, {
        x: placement.x,
        y: placement.y,
        width: placement.box.width,
        height: placement.box.height,
        src: stored.path,
        sha256: stored.sha256,
      }),
    );
    deps.setSelection([id]);
    deps.commitGesture();
    return id;
  }

  return { canInsert, insertImage };
}
