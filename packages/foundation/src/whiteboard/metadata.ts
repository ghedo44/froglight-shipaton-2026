/**
 * Whiteboard metadata extraction — normalized metadata mirrors other families
 * (title/tags/created) while retaining format-appropriate canonical storage.
 * Whiteboard payload has no dedicated `meta` envelope in v1; title/tags can
 * be carried as unknown top-level fields (`meta` bag) or derived from content.
 */

import type { JsonValue, NormalizedMetadata } from '../metadata.js';
import type { SurfaceModel } from '../surfaces/model.js';

export function extractWhiteboardMetadata(
  model: SurfaceModel,
): Omit<NormalizedMetadata, 'documentId'> {
  const unknown = (model as SurfaceModel & { unknownFields?: Record<string, JsonValue> }).unknownFields;
  const metaRaw = unknown?.meta;
  const meta = typeof metaRaw === 'object' && metaRaw !== null && !Array.isArray(metaRaw) ? (metaRaw as Record<string, JsonValue>) : undefined;

  let title: string | undefined;
  let tags: string[] | undefined;
  let properties: Record<string, JsonValue> | undefined;

  if (meta !== undefined) {
    if (typeof meta.title === 'string' && meta.title.trim() !== '') title = meta.title.trim();
    if (Array.isArray(meta.tags)) {
      const filtered = meta.tags.filter((t): t is string => typeof t === 'string');
      if (filtered.length > 0) tags = filtered;
    }
    if (typeof meta.properties === 'object' && meta.properties !== null && !Array.isArray(meta.properties)) {
      const entries = Object.entries(meta.properties as Record<string, JsonValue>);
      if (entries.length > 0) properties = Object.fromEntries(entries);
    }
  }

  // Derive title from first text/card when no explicit meta title.
  if (title === undefined) {
    for (const id of model.order) {
      const record = model.objects[id];
      if (!record) continue;
      if ((record.type === 'froglight.text' || record.type === 'froglight.card') && typeof record.text === 'string' && record.text.trim() !== '') {
        title = record.text.trim().slice(0, 200);
        break;
      }
      if (record.type === 'froglight.resource-embed' && typeof record.cachedTitle === 'string' && record.cachedTitle.trim() !== '') {
        title = record.cachedTitle.trim().slice(0, 200);
        break;
      }
    }
  }

  return {
    ...(title !== undefined ? { title } : {}),
    ...(tags !== undefined ? { tags } : {}),
    ...(properties !== undefined ? { properties } : {}),
  };
}
