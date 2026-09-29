/**
 * Search projection for LaTeX.
 *
 * The indexed text is the declared title (when present) plus the document
 * body (after `\begin{document}`) with comments masked out. Preamble/package
 * noise stays out of the index. Anchors align hit ranges to portable label
 * addresses: the comment mask preserves offsets 1:1 with the
 * raw source, so label offsets computed on the masked text map directly into
 * the projection.
 */

import { maskTeXComments, readCommandArgument, latexToPlainText } from './tex-scan.js';
import type { DocumentSearchAnchor } from '../documents.js';

function projectionParts(raw: string): { readonly prefix: string; readonly body: string; readonly bodyStart: number } {
  const masked = maskTeXComments(raw);
  let prefix = '';
  const titleMatch = /\\title(?![a-zA-Z])/.exec(masked);
  if (titleMatch !== null) {
    const arg = readCommandArgument(masked, titleMatch.index + titleMatch[0].length);
    if (arg !== null) {
      const title = latexToPlainText(arg.arg);
      if (title !== '') prefix = `${title}\n`;
    }
  }
  const begin = masked.indexOf('\\begin{document}');
  if (begin === -1) return { prefix, body: masked, bodyStart: 0 };
  const bodyStart = begin + '\\begin{document}'.length;
  const end = masked.indexOf('\\end{document}', bodyStart);
  return { prefix, body: end === -1 ? masked.slice(bodyStart) : masked.slice(bodyStart, end), bodyStart };
}

/** Title + comment-masked body text used for full-text search. */
export function latexSearchText(raw: string): string {
  const { prefix, body } = projectionParts(raw);
  return prefix + body;
}

/** Offset in the masked raw source where the indexed body begins (-1 if whole source). */
export function latexSearchProjectionStart(raw: string): number {
  return projectionParts(raw).bodyStart;
}

/**
 * Anchors aligning `latexSearchText` ranges to portable label addresses.
 * Each label covers the projection range from its own position up to the
 * next label (or the end of the projection).
 */
export function latexSearchAnchors(raw: string): readonly DocumentSearchAnchor[] {
  const projection = latexSearchText(raw);
  const { prefix, bodyStart } = projectionParts(raw);
  const masked = maskTeXComments(raw);
  const labelPattern = /\\label\{([^}]*)\}/g;
  const hits: { name: string; rawOffset: number }[] = [];
  let match = labelPattern.exec(masked);
  while (match !== null) {
    const name = match[1]!.trim();
    if (name !== '') hits.push({ name, rawOffset: match.index });
    match = labelPattern.exec(masked);
  }
  hits.sort((a, b) => a.rawOffset - b.rawOffset);
  const anchors: DocumentSearchAnchor[] = [];
  for (const [index, hit] of hits.entries()) {
    const rawOffset = hit.rawOffset - bodyStart;
    if (rawOffset < 0) continue;
    const start = prefix.length + rawOffset;
    if (start >= projection.length) continue;
    const nextRaw = index + 1 < hits.length ? hits[index + 1]!.rawOffset - bodyStart : raw.length - bodyStart;
    const end = Math.min(Math.max(prefix.length + nextRaw, start + 1), projection.length);
    anchors.push({ address: hit.name, start, end });
  }
  return anchors;
}
