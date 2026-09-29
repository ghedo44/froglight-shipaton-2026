/**
 * Whiteboard surface reference operations.
 *
 * Pure `SurfaceModel` helpers for inserting and operating on
 * `froglight.resource-embed` records by pointer, touch, and keyboard. The
 * picker dialog (`@froglight/ui` picker) resolves a stable
 * `ResourceTarget`; these helpers place the frame at the expected surface
 * position, preserve it across replace, and delete only the reference on
 * remove. Dangling targets are never auto-deleted: the record stays until
 * an explicit replace/remove, and activation renders the distinct
 * placeholder owned by the shared `ResourceEmbedCard`.
 *
 * Presentation note: the canonical `ResourceEmbedGeometry.presentation`
 * member is owned by parallel and may be ABSENT here. Records
 * are therefore constructed WITHOUT the `presentation` member (via
 * `resourceEmbedObject`, which lacks it in this worktree), and reads go
 * through the tolerant local resolver below (absent → preview, unknown →
 * preview + verbatim, never crash). Never store browser URLs as identity —
 * stable `DocumentRef`/`ResourceTarget` only.
 */

import {
  isResourceTarget,
  resourceEmbedObject,
  SURFACE_OBJECT_TYPES,
  type ResourceTarget,
  type SurfaceModel,
  type SurfaceObjectRecord,
} from '@froglight/foundation';

/** Default embed frame when the host supplies no size. */
export const WHITEBOARD_EMBED_DEFAULT_SIZE = { width: 480, height: 320 } as const;

export interface WhiteboardEmbedPoint {
  readonly x: number;
  readonly y: number;
}

export interface WhiteboardEmbedPlacement extends WhiteboardEmbedPoint {
  readonly width?: number;
  readonly height?: number;
  readonly rotation?: number;
  readonly cachedTitle?: string;
  readonly cachedKind?: string;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function targetOf(record: SurfaceObjectRecord): ResourceTarget | null {
  return isResourceTarget(record.target)
    ? (record.target as ResourceTarget)
    : null;
}

/** True when the record is a `froglight.resource-embed` with a valid target. */
export function isWhiteboardEmbedRecord(
  record: SurfaceObjectRecord | undefined,
): boolean {
  if (record === undefined) return false;
  if (record.type !== SURFACE_OBJECT_TYPES.resourceEmbed) return false;
  return targetOf(record) !== null;
}

/**
 * Tolerant presentation read (defensive): absent → preview, known
 * link → link, anything else present → preview + verbatim. Never throws.
 * Owner-local mirror of the canonical UI `embed-presentation.ts` copy.
 * No foundation export exists and providers cannot import the UI plugin
 * layer, so keep behavior identical — the parity matrix in the spec
 * files locks it.
 */
export function resolveWhiteboardEmbedPresentation(
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

function freshEmbedId(): string {
  return `embed-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Insert a resource-embed at the expected surface position. The caller
 * supplies the surface point (pointer/touch hit, keyboard caret proxy, or
 * viewport center); this helper preserves it verbatim as the frame origin
 * so picker insertion lands where the user invoked it. Returns the new
 * object id. Throws `TypeError` on invalid targets or non-finite geometry.
 */
export function insertWhiteboardEmbed(
  model: SurfaceModel,
  target: ResourceTarget,
  at: WhiteboardEmbedPlacement,
  options: { readonly id?: string } = {},
): string {
  if (!isResourceTarget(target)) {
    throw new TypeError('insertWhiteboardEmbed: target must be a ResourceTarget');
  }
  if (!isFiniteNumber(at.x) || !isFiniteNumber(at.y)) {
    throw new TypeError('insertWhiteboardEmbed: placement x/y must be finite');
  }
  const width = at.width ?? WHITEBOARD_EMBED_DEFAULT_SIZE.width;
  const height = at.height ?? WHITEBOARD_EMBED_DEFAULT_SIZE.height;
  if (!isFiniteNumber(width) || width <= 0 || !isFiniteNumber(height) || height <= 0) {
    throw new TypeError('insertWhiteboardEmbed: width/height must be positive');
  }
  const id = options.id ?? freshEmbedId();
  if (id === '' || model.objects[id] !== undefined) {
    throw new TypeError('insertWhiteboardEmbed: id must be fresh and non-empty');
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
  model.objects[id] = record;
  model.order.push(id);
  return id;
}

/**
 * Replace the reference target while preserving the frame (x/y/width/
 * height/rotation). Unknown `presentation` members ride through verbatim on
 * the preserved record. Cached display (`cachedTitle`/`cachedKind`) is
 * cleared unless the caller supplies fresh values, so a replaced reference
 * never shows the previous target's title forever. Returns `false` when the
 * record is missing or not an embed; never creates a record.
 */
export function replaceWhiteboardEmbedTarget(
  model: SurfaceModel,
  id: string,
  next: ResourceTarget,
  options: { readonly cachedTitle?: string | null; readonly cachedKind?: string | null } = {},
): boolean {
  if (!isResourceTarget(next)) {
    throw new TypeError('replaceWhiteboardEmbedTarget: target must be valid');
  }
  const record = model.objects[id];
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
  model.objects[id] = preserved as SurfaceObjectRecord;
  return true;
}

/**
 * Remove only the reference record (order entry + object). Target content
 * is untouched and no other record is modified: deletion never cascades.
 * Only `froglight.resource-embed` records are removed: unknown ids and
 * wrong-type ids are a `false` no-op (never throws, never deletes).
 */
export function removeWhiteboardEmbed(model: SurfaceModel, id: string): boolean {
  const record = model.objects[id];
  if (record === undefined) return false;
  if (record.type !== SURFACE_OBJECT_TYPES.resourceEmbed) return false;
  delete model.objects[id];
  const at = model.order.indexOf(id);
  if (at !== -1) model.order.splice(at, 1);
  return true;
}

/**
 * Dangling check delegated to the host resolver: returns `true` when the
 * record exists but its target is missing/invalid per `exists`. Absent
 * records are not dangling (they are gone); invalid embed records count as
 * dangling so the placeholder — never auto-delete — can offer
 * replace/remove.
 */
export function isWhiteboardEmbedDangling(
  model: SurfaceModel,
  id: string,
  exists: (target: ResourceTarget) => boolean,
): boolean {
  const record = model.objects[id];
  if (record === undefined) return false;
  if (record.type !== SURFACE_OBJECT_TYPES.resourceEmbed) return false;
  const target = targetOf(record);
  if (target === null) return true;
  try {
    return !exists(target);
  } catch {
    return true;
  }
}
