/**
 * Metadata extraction for Markdown.
 *
 * Normalized metadata is derived from frontmatter + first heading + inline tags.
 * No editor types; host-agnostic.
 */

import type { JsonValue, NormalizedMetadata } from '../metadata.js';
import type { DocumentId } from '../identity.js';
import { parseFrontmatter } from './frontmatter.js';
import { extractHeadings } from './addressing.js';
import { extractTags } from './links.js';

export interface ExtractMarkdownMetadataInput {
  readonly documentId: DocumentId;
  readonly raw: string;
  /** Fallback filename-like title when no heading/frontmatter title. */
  readonly fallbackTitle?: string;
}

/** Extract normalized metadata from raw Markdown. */
export function extractMarkdownMetadata(input: ExtractMarkdownMetadataInput): Omit<NormalizedMetadata, 'documentId'> {
  const { frontmatter, body } = parseFrontmatter(input.raw);
  const headings = extractHeadings(body);
  const inlineTags = extractTags(body);

  // Title: frontmatter title > first heading > fallback > undefined
  let title: string | undefined;
  if (frontmatter !== null && typeof frontmatter.title === 'string' && frontmatter.title.trim() !== '') {
    title = frontmatter.title.trim();
  } else if (headings.length > 0) {
    title = headings[0].text;
  } else if (input.fallbackTitle !== undefined) {
    title = input.fallbackTitle;
  }

  // Tags: frontmatter tags (array of strings) + inline #tags, deduped, order preserved.
  const fmTags: string[] =
    frontmatter !== null && Array.isArray(frontmatter.tags)
      ? (frontmatter.tags.filter((t): t is string => typeof t === 'string') as string[])
      : [];
  const allTags = [...fmTags];
  const seen = new Set(allTags);
  for (const t of inlineTags) {
    if (!seen.has(t)) {
      seen.add(t);
      allTags.push(t);
    }
  }

  // Properties: frontmatter as JsonValue map, minus title/tags which are promoted.
  let properties: Record<string, JsonValue> | undefined;
  if (frontmatter !== null) {
    const props: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(frontmatter)) {
      if (k === 'title' || k === 'tags') {
        continue;
      }
      props[k] = v as JsonValue;
    }
    if (Object.keys(props).length > 0) {
      properties = props;
    }
  }

  const tags = allTags.length > 0 ? allTags : undefined;

  return {
    ...(title !== undefined ? { title } : {}),
    ...(tags !== undefined ? { tags } : {}),
    ...(properties !== undefined ? { properties } : {}),
  };
}
