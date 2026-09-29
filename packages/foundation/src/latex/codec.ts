/**
 * LaTeX codec: canonical `.tex` bytes <-> LaTeXModel.
 *
 * The model is raw-string-based so round-tripping is byte-identical. Decode
 * derives metadata and relationships from the structure parser only; the
 * preview provider is never involved in storage.
 */

import type { DocumentRef, DecodedDocument } from '../documents.js';
import { utf8Decode, utf8Encode } from '../encoding.js';
import type { LaTeXModel } from './model.js';
import { extractLaTeXStructure } from './structure.js';
import { extractLaTeXMetadata } from './metadata.js';
import { extractLaTeXRelationships } from './relationships.js';

export function decodeLaTeX(
  data: Uint8Array,
  ref: DocumentRef,
  options?: { fallbackTitleFromPath?: string },
): DecodedDocument<LaTeXModel> & { model: LaTeXModel } {
  const raw = utf8Decode(data);
  const model: LaTeXModel = { raw };
  const structure = extractLaTeXStructure(raw);
  const metadata = extractLaTeXMetadata({
    documentId: ref.documentId,
    structure,
    fallbackTitle: options?.fallbackTitleFromPath,
  });
  const relationships = extractLaTeXRelationships({ source: ref.location, structure });
  return { model, metadata: metadata as Record<string, unknown>, relationships };
}

export function encodeLaTeX(model: LaTeXModel, _ref: DocumentRef): Uint8Array {
  return utf8Encode(model.raw);
}

/** Derive fallback title from a WorkspacePath (filename without directory/extension). */
export function latexFallbackTitleFromPath(path: string): string {
  const parts = path.split('/');
  const name = parts[parts.length - 1] ?? path;
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  return base === '' ? name : base;
}
