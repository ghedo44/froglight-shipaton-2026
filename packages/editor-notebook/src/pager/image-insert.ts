/**
 * Notebook image insertion.
 *
 * File→asset storage, natural-size fit, centered placement, and object
 * creation using the shared image helpers and the pager's image cache.
 * The pager keeps page-shell lifecycle; this helper owns insertion policy.
 */

import {
  frameBounds,
  imageObject,
  isNavigablePage,
  navigablePageIds,
  type DocumentAssetStore,
  type NotebookModel,
  type NotebookPage,
} from '@froglight/foundation';
import { fitImageBox, type DecodedImage } from '@froglight/editor-ink';

export interface ImageInsertEnvironment {
  readonly model: NotebookModel;
  readonly assets?: DocumentAssetStore | null;
  readonly decode: (bytes: Uint8Array) => Promise<DecodedImage | null>;
  /** Publish an already-decoded bitmap into the shared image cache. */
  readonly seedImage: (path: string, image: CanvasImageSource) => void;
  readonly markDirty: () => void;
  /** Runs after a successful insertion (thumbnail refresh, tool sync). */
  readonly afterInsert: (pageId: string, objectId: string) => void;
  readonly isActive: () => boolean;
}

/**
 * Insert an image file into the current navigable page, centered at half
 * page width. Matches standalone Surface behavior for decode, fit,
 * placement, and cache seeding. Throws when no asset store is bound or no
 * readable page exists; aborts silently when the pager dies mid-flight or
 * the page is replaced underneath the async work.
 */
export async function insertImageIntoCurrentPage(
  env: ImageInsertEnvironment,
  currentPageIndex: number,
  file: File,
  freshObjectId: () => string,
): Promise<void> {
  const assets = env.assets;
  if (assets == null)
    throw new Error('no asset store is bound to this profile');
  const ids = navigablePageIds(env.model);
  const id = ids[currentPageIndex];
  if (id === undefined) throw new Error('notebook has no readable page');
  const entry = env.model.pages[id];
  if (!isNavigablePage(entry)) throw new Error('current page is not readable');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!env.isActive() || env.model.pages[id] !== entry) return;
  const stored = await assets.put(bytes, { suggestedName: file.name });
  if (!env.isActive() || env.model.pages[id] !== entry) return;
  const bitmap = await env.decode(bytes);
  if (!env.isActive() || env.model.pages[id] !== entry) return;
  if (bitmap !== null) env.seedImage(stored.path, bitmap);
  insertDecodedImage(env, entry, bitmap, stored.path, stored.sha256, freshObjectId);
}

function insertDecodedImage(
  env: ImageInsertEnvironment,
  entry: NotebookPage,
  bitmap: DecodedImage | null,
  path: string,
  sha256: string,
  freshObjectId: () => string,
): void {
  const size = frameBounds(entry.surface.frame) ?? {
    width: 800,
    height: 600,
  };
  // Fit within half the page width, preserving the natural aspect.
  const box = fitImageBox(bitmap, size.width * 0.5);
  const objectId = 'img-' + freshObjectId();
  entry.surface.objects[objectId] = imageObject(objectId, {
    x: Math.round((size.width - box.width) / 2),
    y: Math.round((size.height - box.height) / 2),
    width: box.width,
    height: box.height,
    src: path,
    sha256,
  });
  entry.surface.order.push(objectId);
  env.markDirty();
  env.afterInsert(entry.id, objectId);
}
