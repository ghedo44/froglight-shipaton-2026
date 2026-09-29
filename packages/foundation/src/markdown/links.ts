/**
 * Link extraction.
 *
 * Scans Markdown body for:
 * - Standard links `[text](destination)` (including `![alt](src)` handled as same capture but type embed)
 * - Wiki-links `[[dest]]`, `[[dest#fragment]]`, `[[dest|alias]]`, `[[dest#frag|alias]]`
 *
 * Uses host-free regex (no parser AST leak). Returns raw hrefs with optional fragments and alias.
 */

export type LinkKind = 'markdown-link' | 'markdown-image' | 'wiki-link' | 'wiki-embed';

export interface ExtractedLink {
  readonly kind: LinkKind;
  /** Raw destination as written (e.g. `notes/b.md`, `My Doc`, `https://example.com`). */
  readonly destination: string;
  /** Fragment after `#` when present. */
  readonly fragment?: string;
  /** Alias after `|` for wiki-links, or link text for markdown links. */
  readonly alias?: string;
  /** Full match text for excerpt purposes. */
  readonly raw: string;
  /** Zero-based line index. */
  readonly line: number;
}

/** Regex for markdown links/images: `[text](dest)` and `![alt](src)` . */
const MARKDOWN_LINK_RE = /(!?)\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/** Regex for wiki-links. */
const WIKI_LINK_RE = /(!?)\[\[([^\]|#\]]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g;

/** Inline tag regex `#tag` (used elsewhere but simple helper). */
const TAG_RE = /(?:^|\s)#([A-Za-z0-9_-]+)\b/g;

/** Extract all wiki-links + markdown links from body, in document order. */
export function extractLinks(body: string): ExtractedLink[] {
  const links: ExtractedLink[] = [];
  const lines = body.split('\n');
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx += 1) {
    const line = lines[lineIdx];
    // Markdown links
    let m: RegExpExecArray | null;
    // Need to reset lastIndex per line for global regexes.
    MARKDOWN_LINK_RE.lastIndex = 0;
    while ((m = MARKDOWN_LINK_RE.exec(line)) !== null) {
      const isImage = m[1] === '!';
      const dest = m[3].trim();
      if (dest === '') {
        continue;
      }
      // Strip optional < > around dest.
      const cleaned = dest.startsWith('<') && dest.endsWith('>') ? dest.slice(1, -1) : dest;
      // Split fragment for markdown links too (e.g. `doc.md#heading`)
      const hash = cleaned.indexOf('#');
      const destination = hash === -1 ? cleaned : cleaned.slice(0, hash);
      const fragment = hash === -1 ? undefined : cleaned.slice(hash + 1);
      links.push({
        kind: isImage ? 'markdown-image' : 'markdown-link',
        destination,
        fragment: fragment || undefined,
        alias: m[2] || undefined,
        raw: m[0],
        line: lineIdx,
      });
    }
    WIKI_LINK_RE.lastIndex = 0;
    while ((m = WIKI_LINK_RE.exec(line)) !== null) {
      const dest = m[2].trim();
      if (dest === '') {
        continue;
      }
      links.push({
        kind: m[1] === '!' ? 'wiki-embed' : 'wiki-link',
        destination: dest,
        fragment: m[3]?.trim() || undefined,
        alias: m[4]?.trim() || undefined,
        raw: m[0],
        line: lineIdx,
      });
    }
  }
  return links;
}

/** Extract inline tags `#tag` from body (GFM-style). */
export function extractTags(body: string): string[] {
  const tags: string[] = [];
  let m: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;
  // Search whole body
  while ((m = TAG_RE.exec(body)) !== null) {
    // Avoid matching headings: line starts with # heading is not a tag.
    // TAG_RE already requires ^ or whitespace before #, so heading "# Foo" won't match due to # at column 0 with no preceding whitespace, but our regex uses (?:^|\s) so it would match start. Filter heading hashes?
    // For simplicity, filter if line is a heading.
    // Check line context: if preceding char is start and following word is heading text, skip?
    // We already extract tags from body; headings will not be mistaken because we check the line start.
    // Keep simple: skip if the tag is part of a heading line that starts with '# '.
    const idx = m.index;
    const lineStart = body.lastIndexOf('\n', idx - 1) + 1;
    const line = body.slice(lineStart, body.indexOf('\n', idx));
    if (/^\s*#{1,6}\s/.test(line)) {
      continue;
    }
    tags.push(m[1]);
  }
  // Deduplicate preserving order.
  const seen = new Set<string>();
  const dedup: string[] = [];
  for (const t of tags) {
    if (!seen.has(t)) {
      seen.add(t);
      dedup.push(t);
    }
  }
  return dedup;
}

/** Split href into path part and fragment for resolution. */
export function splitHref(href: string): { path: string; fragment?: string } {
  const hash = href.indexOf('#');
  if (hash === -1) {
    return { path: href };
  }
  return { path: href.slice(0, hash), fragment: href.slice(hash + 1) };
}
