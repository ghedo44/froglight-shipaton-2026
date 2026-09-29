/**
 * LaTeX outline extractor.
 *
 * Sections only: `extractLaTeXStructure` (the canonical foundation parser,
 * shared with metadata/search/relationships) already yields plain-text
 * titles (`latexToPlainText`), comment masking, optional-argument skipping,
 * and starred sections at the same level — so labels, citations, includes,
 * graphics, and bibliography targets never become rows by construction
 * (only `structure.sections` is read). Levels reuse the structure mapping
 * verbatim (section=1, subsection=2, subsubsection=3); part/chapter (0) and
 * paragraph and below (4+) are excluded.
 *
 * Addresses are markdown-style slugs (`slugify` from the shared addressing
 * contract) deduped per document: the first occurrence keeps the bare slug,
 * later collisions take `slug-1`, `slug-2`, ... — the same global used-set
 * scheme as `extractMarkdownOutline` (`extractHeadings` still uses per-base
 * counts). Empty titles are skipped (matching `resolveLatexAddress`, which
 * the provider reveal side uses); titles whose slug is empty fall back
 * to `section-<line>`. The model is only read and never mutated, so unknown
 * fields round-trip untouched.
 *
 * Headless and engine-free: foundation string parsing only, no editor, DOM,
 * or host types. The outline module stays usable with any (replaceable)
 * LaTeX provider, and the reveal side resolves with the same comment-masked
 * canonical foundation parser.
 */

import {
  extractLaTeXStructure,
  latexKindId,
  slugify,
  type LaTeXModel,
} from '@froglight/foundation';
import type { DocumentOutlineEntry, OutlineExtractInput, OutlineExtractor } from './types.js';

function rawOf(model: unknown): string {
  if (typeof model === 'string') return model;
  if (typeof model === 'object' && model !== null && typeof (model as LaTeXModel).raw === 'string') {
    return (model as LaTeXModel).raw;
  }
  return '';
}

/** Markdown-style dedup: first `base`, then `base-1`, `base-2`, ... skipping globally used slugs. */
function uniqueSlug(base: string, used: ReadonlySet<string>): string {
  if (!used.has(base)) return base;
  let counter = 1;
  while (used.has(`${base}-${counter}`)) counter += 1;
  return `${base}-${counter}`;
}

/** Extract section/subsection/subsubsection rows; never mutates the model. */
export function extractLatexOutline(model: LaTeXModel | string): readonly DocumentOutlineEntry[] {
  const raw = rawOf(model);
  const { sections } = extractLaTeXStructure(raw);
  const used = new Set<string>();
  const entries: DocumentOutlineEntry[] = [];
  for (const section of sections) {
    if (section.level < 1 || section.level > 3) continue;
    if (section.title === '') continue;
    let base = slugify(section.title);
    if (base === '') base = `section-${section.line}`;
    const slug = uniqueSlug(base, used);
    used.add(slug);
    entries.push({ id: slug, address: slug, level: section.level, label: section.title, kind: 'heading' });
  }
  return entries;
}

export const latexOutlineExtractor: OutlineExtractor = {
  kindId: latexKindId,
  extract: (input: OutlineExtractInput) => extractLatexOutline(input.model as LaTeXModel | string),
};
