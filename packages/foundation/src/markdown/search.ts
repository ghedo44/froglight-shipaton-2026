/**
 * Search extractors for Markdown: normalized text projection.
 *
 *  is over body text + frontmatter title/tags/properties.
 */

import { parseFrontmatter } from './frontmatter.js';

export interface SearchDocument {
  readonly documentId: string;
  readonly title: string;
  readonly tags: readonly string[];
  readonly body: string;
  /** Combined text for indexing (title boosted via duplication). */
  readonly indexText: string;
}

/** Build a SearchDocument projection from raw Markdown. */
export function projectMarkdownForSearch(raw: string, documentId: string): SearchDocument {
  const { frontmatter, body } = parseFrontmatter(raw);
  const title = (frontmatter !== null && typeof frontmatter.title === 'string' ? frontmatter.title : '') as string;
  const tags = frontmatter !== null && Array.isArray(frontmatter.tags)
    ? (frontmatter.tags.filter((t): t is string => typeof t === 'string') as string[])
    : ([] as string[]);
  // Include code blocks — not stripped.

  // Also collect string properties from frontmatter
  const propTexts: string[] = [];
  if (frontmatter !== null) {
    for (const [k, v] of Object.entries(frontmatter)) {
      if (k === 'title' || k === 'tags') {
        continue;
      }
      if (typeof v === 'string') {
        propTexts.push(v);
      } else if (Array.isArray(v)) {
        for (const item of v) {
          if (typeof item === 'string') {
            propTexts.push(item);
          }
        }
      }
    }
  }
  // Title boost: duplicate title tokens once.
  const titleBoost = title ? `${title} ${title}` : '';
  const indexParts = [titleBoost, tags.join(' '), body, propTexts.join(' ')].filter(Boolean);
  const indexText = indexParts.join('\n');
  return { documentId, title, tags, body, indexText };
}

/** Normalize query/text: NFKC-ish lowercasing + word breaking. */
export function tokenize(text: string): string[] {
  const nfkd = text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  const lower = nfkd.toLowerCase();
  // Split on non-letter/digit/underscore
  return lower
    .split(/[^\p{L}\p{N}_]+/gu)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}
