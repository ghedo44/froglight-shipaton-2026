/**
 * Metadata extraction for notebooks: normalized metadata
 * comes from the document `meta` section with the same tolerance rules as
 * workspace records; unknown meta fields are preserved by the codec and
 * simply not promoted here.
 */

import type { JsonValue, NormalizedMetadata } from '../metadata.js';
import type { NotebookModel } from './model.js';

/** Extract normalized metadata from a notebook model. Engine-free. */
export function extractNotebookMetadata(
  model: NotebookModel,
): Omit<NormalizedMetadata, 'documentId'> {
  const title = model.meta.title;
  const tagsRaw = model.meta.tags;
  const propertiesRaw = model.meta.properties;

  const normalizedTitle =
    typeof title === 'string' && title.trim() !== '' ? title.trim() : undefined;

  const tags = Array.isArray(tagsRaw)
    ? (tagsRaw.filter((tag): tag is string => typeof tag === 'string') as string[])
    : undefined;
  const normalizedTags = tags !== undefined && tags.length > 0 ? tags : undefined;

  let properties: Record<string, JsonValue> | undefined;
  if (typeof propertiesRaw === 'object' && propertiesRaw !== null && !Array.isArray(propertiesRaw)) {
    const entries = Object.entries(propertiesRaw as Record<string, JsonValue>);
    if (entries.length > 0) {
      properties = Object.fromEntries(entries);
    }
  }

  return {
    ...(normalizedTitle !== undefined ? { title: normalizedTitle } : {}),
    ...(normalizedTags !== undefined ? { tags: normalizedTags } : {}),
    ...(properties !== undefined ? { properties } : {}),
  };
}
