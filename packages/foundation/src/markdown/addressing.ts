/**
 * Heading/block addressing.
 *
 * Portable `DocumentLocation.address` is a single string slug or `^block-id`.
 * Slugs are lowercased, non-alnum collapsed, deduped per document.
 * `^block-id` markers are explicit and win over heading slugs.
 */

/** A derived heading. */
export interface HeadingInfo {
  readonly level: number;
  readonly text: string;
  readonly slug: string;
  readonly line: number;
}

/** A derived block marker. */
export interface BlockInfo {
  readonly id: string; // includes leading ^
  readonly line: number;
}

/**
 * Slugify heading text: lowercased, trimmed, NFKD fold, non-letter/digit collapsed to '-'.
 * Keeps Unicode letters/digits via \p{L}\p{N}.
 */
export function slugify(text: string): string {
  const nfkd = text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  const lower = nfkd.toLowerCase().trim();
  // Replace any run of characters that are not letters/digits with -
  const replaced = lower.replace(/[^\p{L}\p{N}]+/gu, '-');
  const collapsed = replaced.replace(/^-+|-+$/g, '').replace(/-+/g, '-');
  return collapsed;
}

/** Extract headings from Markdown body (ATX headings `#` only for v1). */
export function extractHeadings(body: string): HeadingInfo[] {
  const lines = body.split('\n');
  const counts = new Map<string, number>();
  const headings: HeadingInfo[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const m = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (m === null) {
      continue;
    }
    const level = m[1].length;
    const text = m[2].trim();
    if (text === '') {
      continue;
    }
    let base = slugify(text);
    if (base === '') {
      base = `heading-${i}`;
    }
    const seen = counts.get(base) ?? 0;
    counts.set(base, seen + 1);
    const slug = seen === 0 ? base : `${base}-${seen}`;
    headings.push({ level, text, slug, line: i });
  }
  return headings;
}

/** Extract explicit block ids `^block-id` at end of line. */
export function extractBlocks(body: string): BlockInfo[] {
  const lines = body.split('\n');
  const blocks: BlockInfo[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    // Matches trailing ^id (alnum, -, _, +). Require space before ^ or start.
    const m = line.match(/(?:^|\s)\^([A-Za-z0-9_-]+)\s*$/);
    if (m !== null) {
      const id = `^${m[1]}`;
      blocks.push({ id, line: i });
    }
  }
  return blocks;
}

/**
 * Build address index for a document body: mapping from slug or block id to line.
 * Block ids take precedence over heading slugs when they share a line.
 */
export function buildAddressIndex(body: string): Map<string, number> {
  const map = new Map<string, number>();
  const headings = extractHeadings(body);
  for (const h of headings) {
    if (!map.has(h.slug)) {
      map.set(h.slug, h.line);
    }
  }
  const blocks = extractBlocks(body);
  for (const b of blocks) {
    map.set(b.id, b.line);
  }
  return map;
}
