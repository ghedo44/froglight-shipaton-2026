/**
 * Metadata extraction for LaTeX.
 *
 * Title comes from `\title{}` (falling back to the first section, then the
 * filename). Author is carried in properties. Derived only; canonical source
 * is never modified.
 */

import type { JsonValue, NormalizedMetadata } from '../metadata.js';
import type { DocumentId } from '../identity.js';
import type { LaTeXStructure } from './structure.js';

export interface ExtractLaTeXMetadataInput {
  readonly documentId: DocumentId;
  readonly structure: LaTeXStructure;
  /** Fallback filename-like title when the document declares none. */
  readonly fallbackTitle?: string;
}

export function extractLaTeXMetadata(
  input: ExtractLaTeXMetadataInput,
): Omit<NormalizedMetadata, 'documentId'> {
  const { structure } = input;

  let title: string | undefined;
  if (structure.title !== undefined) {
    title = structure.title;
  } else if (structure.sections.length > 0 && structure.sections[0]!.title !== '') {
    title = structure.sections[0]!.title;
  } else if (input.fallbackTitle !== undefined) {
    title = input.fallbackTitle;
  }

  const properties: Record<string, JsonValue> = {};
  if (structure.author !== undefined) properties['author'] = structure.author;
  if (structure.documentClass !== undefined) properties['documentClass'] = structure.documentClass;

  return {
    ...(title !== undefined ? { title } : {}),
    ...(Object.keys(properties).length > 0 ? { properties } : {}),
  };
}
