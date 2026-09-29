/**
 * Markdown outline extractor.
 *
 * Slugs are reused verbatim from `extractHeadings` (ATX-only, deduped per
 * document), so outline addresses always match the shared addressing
 * contract and no slug logic is duplicated here. Empty ATX headings (which
 * `extractHeadings` skips) fall back to `heading-<line>`, mirroring the
 * `slugify`-empty fallback in addressing (`heading-<line>`), with a numeric
 * suffix only when the fallback collides with an existing slug.
 *
 * `^` vocabulary: trailing `^block-id` markers are literal
 * plain text inside labels and slugs; they are never stripped or resolved
 * here. Navigation still targets the heading slug.
 */

import {
  extractHeadings,
  markdownKindId,
  type MarkdownModel,
} from '@froglight/foundation';
import type { DocumentOutlineEntry, OutlineExtractInput, OutlineExtractor } from './types.js';

const EMPTY_ATX_PATTERN = /^(#{1,6})\s*#*\s*$/;

function rawOf(model: unknown): string {
  if (typeof model === 'string') return model;
  if (typeof model === 'object' && model !== null && typeof (model as MarkdownModel).raw === 'string') {
    return (model as MarkdownModel).raw;
  }
  return '';
}

function uniqueSlug(base: string, used: ReadonlySet<string>): string {
  if (!used.has(base)) return base;
  let counter = 1;
  while (used.has(`${base}-${counter}`)) counter += 1;
  return `${base}-${counter}`;
}

/** Extract ATX headings; empty headings map to `heading-<line>`. */
export function extractMarkdownOutline(model: MarkdownModel | string): readonly DocumentOutlineEntry[] {
  const raw = rawOf(model);
  const headings = extractHeadings(raw);
  const byLine = new Map<number, { level: number; text: string; slug: string }>();
  for (const heading of headings) byLine.set(heading.line, heading);

  const used = new Set<string>();
  const entries: DocumentOutlineEntry[] = [];
  const lines = raw.split('\n');
  for (let line = 0; line < lines.length; line += 1) {
    const derived = byLine.get(line);
    if (derived !== undefined) {
      const slug = uniqueSlug(derived.slug, used);
      used.add(slug);
      entries.push({ id: slug, address: slug, level: derived.level, label: derived.text, kind: 'heading' });
      continue;
    }
    const match = lines[line].match(EMPTY_ATX_PATTERN);
    if (match === null) continue;
    const slug = uniqueSlug(`heading-${line}`, used);
    used.add(slug);
    entries.push({ id: slug, address: slug, level: match[1].length, label: '', kind: 'heading' });
  }
  return entries;
}

export const markdownOutlineExtractor: OutlineExtractor = {
  kindId: markdownKindId,
  extract: (input: OutlineExtractInput) => extractMarkdownOutline(input.model as MarkdownModel | string),
};
