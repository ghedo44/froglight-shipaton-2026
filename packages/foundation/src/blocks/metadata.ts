/**
 * Metadata extraction for block pages.
 *
 * Normalized metadata comes from the document `meta` section with the same
 * tolerance rules as workspace records; unknown meta fields are preserved
 * by the codec and simply not promoted here.
 */

import type { JsonValue, NormalizedMetadata } from '../metadata.js';
import type { DocumentId } from '../identity.js';
import type { BlockPageModel } from './model.js';

export interface ExtractBlockPageMetadataInput {
  readonly documentId: DocumentId;
  readonly model: BlockPageModel;
}

/** Extract normalized metadata from a block page model. Engine-free. */
export function extractBlockPageMetadata(
  input: ExtractBlockPageMetadataInput,
): Omit<NormalizedMetadata, 'documentId'> {
  const title = input.model.meta.title;
  const tagsRaw = input.model.meta.tags;
  const propertiesRaw = input.model.meta.properties;

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
