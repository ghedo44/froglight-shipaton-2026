/**
 * Notebook page surface reference operations.
 *
 * React-scope owner helpers for `froglight.resource-embed` records inside
 * one notebook page surface. The pager (`../pager.ts`, `../editor.ts`) is
 * out of scope for this task, so this module operates purely on the
 * canonical `NotebookModel`: given a page id it resolves the page surface
 * and delegates frame/target lifecycle to the same contract as the
 * whiteboard owner (expected-position insert, frame-preserving replace,
 * reference-only removal, dangling preservation, and presentation reads.
 * The shared `ResourceEmbedCard` owns activation
 * rendering; the shared picker owns discovery.
 *
 * Presentation note: records are constructed WITHOUT the `presentation`
 * member — parallel owns the canonical field. Reads tolerate
 * absent/unknown values (absent → preview, unknown → preview + verbatim,
 * never crash). Stable `DocumentRef`/`ResourceTarget` only, never browser
 * URLs.
 */

import {
  isNavigablePage,
  isResourceTarget,
  resourceEmbedObject,
  SURFACE_OBJECT_TYPES,
  type NotebookModel,
  type NotebookPageId,
  type ResourceTarget,
  type SurfaceModel,
  type SurfaceObjectRecord,
} from '@froglight/foundation';

export const NOTEBOOK_EMBED_DEFAULT_SIZE = { width: 480, height: 320 } as const;

export interface NotebookEmbedPlacement {
  readonly x: number;
  readonly y: number;
  readonly width?: number;
  readonly height?: number;
  readonly rotation?: number;
  readonly cachedTitle?: string;
  readonly cachedKind?: string;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function surfaceOf(model: NotebookModel, pageId: NotebookPageId): SurfaceModel | null {
  const entry = model.pages[pageId];
  if (!isNavigablePage(entry)) return null;
  return entry.surface;
}

function freshEmbedId(): string {
  return `embed-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** True when the record is a valid resource-embed. */
export function isNotebookEmbedRecord(
  record: SurfaceObjectRecord | undefined,
): boolean {
  if (record === undefined) return false;
  if (record.type !== SURFACE_OBJECT_TYPES.resourceEmbed) return false;
  return isResourceTarget(record.target);
}

/** Tolerant presentation read (defensive, mirrors whiteboard owner).
 * Owner-local mirror of the canonical UI `embed-presentation.ts` copy.
 * No foundation export exists and providers cannot import the UI plugin
 * layer, so keep behavior identical — the parity matrix in the spec
 * files locks it. */
export function resolveNotebookEmbedPresentation(
  record: SurfaceObjectRecord,
): { mode: 'preview' | 'link'; raw: unknown; unknown: boolean } {
  const raw = (record as Record<string, unknown>).presentation;
  if (raw === undefined) return { mode: 'preview', raw: undefined, unknown: false };
  if (raw === 'preview') return { mode: 'preview', raw, unknown: false };
  if (raw === 'link') return { mode: 'link', raw, unknown: false };
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const mode = (raw as Record<string, unknown>).mode;
    if (mode === 'preview') return { mode: 'preview', raw, unknown: false };
    if (mode === 'link') return { mode: 'link', raw, unknown: false };
  }
  return { mode: 'preview', raw, unknown: true };
}

/**
 * Insert a resource-embed into one notebook page surface at the expected
 * position. Returns the new object id, or `null` when the page is missing
 * or opaque (never creates pages, never throws for missing pages).
 */
export function insertNotebookEmbed(
  model: NotebookModel,
  pageId: NotebookPageId,
  target: ResourceTarget,
  at: NotebookEmbedPlacement,
  options: { readonly id?: string } = {},
): string | null {
  const surface = surfaceOf(model, pageId);
  if (surface === null) return null;
  if (!isResourceTarget(target)) {
    throw new TypeError('insertNotebookEmbed: target must be a ResourceTarget');
  }
  if (!isFiniteNumber(at.x) || !isFiniteNumber(at.y)) {
    throw new TypeError('insertNotebookEmbed: placement x/y must be finite');
  }
  const width = at.width ?? NOTEBOOK_EMBED_DEFAULT_SIZE.width;
  const height = at.height ?? NOTEBOOK_EMBED_DEFAULT_SIZE.height;
  if (!isFiniteNumber(width) || width <= 0 || !isFiniteNumber(height) || height <= 0) {
    throw new TypeError('insertNotebookEmbed: width/height must be positive');
  }
  const id = options.id ?? freshEmbedId();
  if (id === '' || surface.objects[id] !== undefined) {
    throw new TypeError('insertNotebookEmbed: id must be fresh and non-empty');
  }
  // owns the canonical `presentation` field: construct WITHOUT it.
  const record = resourceEmbedObject(id, {
    x: at.x,
    y: at.y,
    width,
    height,
    target: {
      documentId: target.documentId,
      kindId: target.kindId,
      resourceId: target.resourceId,
      ...(target.address !== undefined ? { address: target.address } : {}),
    },
    ...(at.rotation !== undefined ? { rotation: at.rotation } : {}),
    ...(at.cachedTitle !== undefined ? { cachedTitle: at.cachedTitle } : {}),
    ...(at.cachedKind !== undefined ? { cachedKind: at.cachedKind } : {}),
  });
  surface.objects[id] = record;
  surface.order.push(id);
  return id;
}

/** Frame-preserving target replace within one page surface. Cached display
 * (`cachedTitle`/`cachedKind`) is cleared unless the caller supplies fresh
 * values, so a replaced reference never shows the previous target's title
 * forever. */
export function replaceNotebookEmbedTarget(
  model: NotebookModel,
  pageId: NotebookPageId,
  id: string,
  next: ResourceTarget,
  options: { readonly cachedTitle?: string | null; readonly cachedKind?: string | null } = {},
): boolean {
  const surface = surfaceOf(model, pageId);
  if (surface === null) return false;
  if (!isResourceTarget(next)) {
    throw new TypeError('replaceNotebookEmbedTarget: target must be valid');
  }
  const record = surface.objects[id];
  if (record === undefined || record.type !== SURFACE_OBJECT_TYPES.resourceEmbed) {
    return false;
  }
  const preserved = { ...record } as Record<string, unknown>;
  preserved.target = {
    documentId: next.documentId,
    kindId: next.kindId,
    resourceId: next.resourceId,
    ...(next.address !== undefined ? { address: next.address } : {}),
  };
  if (typeof options.cachedTitle === 'string' && options.cachedTitle.trim() !== '') {
    preserved.cachedTitle = options.cachedTitle;
  } else {
    delete preserved.cachedTitle;
  }
  if (typeof options.cachedKind === 'string' && options.cachedKind.trim() !== '') {
    preserved.cachedKind = options.cachedKind;
  } else {
    delete preserved.cachedKind;
  }
  surface.objects[id] = preserved as SurfaceObjectRecord;
  return true;
}

/**
 * Remove only the reference record from one page surface. Never touches
 * target content or sibling records. Unknown ids, missing pages, and
 * wrong-type ids return `false` (no-op, never throws, never deletes).
 */
export function removeNotebookEmbed(
  model: NotebookModel,
  pageId: NotebookPageId,
  id: string,
): boolean {
  const surface = surfaceOf(model, pageId);
  if (surface === null) return false;
  const record = surface.objects[id];
  if (record === undefined) return false;
  if (record.type !== SURFACE_OBJECT_TYPES.resourceEmbed) return false;
  delete surface.objects[id];
  const at = surface.order.indexOf(id);
  if (at !== -1) surface.order.splice(at, 1);
  return true;
}

/** Dangling check for one page embed (never auto-deletes). */
export function isNotebookEmbedDangling(
  model: NotebookModel,
  pageId: NotebookPageId,
  id: string,
  exists: (target: ResourceTarget) => boolean,
): boolean {
  const surface = surfaceOf(model, pageId);
  if (surface === null) return false;
  const record = surface.objects[id];
  if (record === undefined) return false;
  if (record.type !== SURFACE_OBJECT_TYPES.resourceEmbed) return false;
  if (!isResourceTarget(record.target)) return true;
  try {
    return !exists(record.target as ResourceTarget);
  } catch {
    return true;
  }
}
