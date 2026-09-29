/**
 * Markdown document model.
 *
 *  keeps the model deliberately small and host-agnostic: the
 * canonical resource is the raw `.md` UTF-8 bytes. The model stores the
 * raw string verbatim so `encode(decode(bytes))` round-trips byte-identically
 * (modulo line-ending normalization to LF). Rich parsing (headings, links,
 * tags) is derived, never the storage representation.
 */

export interface MarkdownModel {
  /** Complete raw `.md` content, including any frontmatter block, exactly as edited. */
  readonly raw: string;
}

/** Construct a Markdown model from raw text. */
export function markdownModel(raw: string): MarkdownModel {
  return { raw };
}
