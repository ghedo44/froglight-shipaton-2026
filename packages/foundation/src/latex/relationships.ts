/**
 * Relationship extraction for LaTeX.
 *
 * Includes, bibliography targets, and local graphics become typed
 * `RelationshipInput` edges with synthetic path-keyed targets. Real
 * `DocumentRef` resolution happens in the workspace layer when the path
 * snapshot is available — the same pattern as Markdown links.
 */

import type { DocumentId, DocumentKindId, ResourceId } from '../identity.js';
import type { DocumentLocation } from '../documents.js';
import type { RelationshipInput } from '../relationships.js';
import type { LaTeXStructure } from './structure.js';

function syntheticTargetFor(path: string, address?: string): {
  documentId: DocumentId;
  kindId: DocumentKindId;
  location: { resourceId: ResourceId; address?: string };
} {
  return {
    documentId: path as unknown as DocumentId,
    kindId: 'froglight.latex' as DocumentKindId,
    location: {
      resourceId: path as unknown as ResourceId,
      ...(address !== undefined ? { address } : {}),
    },
  };
}

export interface ExtractLaTeXRelationshipsInput {
  readonly source: DocumentLocation;
  readonly structure: LaTeXStructure;
}

export function extractLaTeXRelationships(
  input: ExtractLaTeXRelationshipsInput,
): RelationshipInput[] {
  const edges: RelationshipInput[] = [];
  const { structure, source } = input;

  for (const include of structure.includes) {
    edges.push({
      type: 'latex.include',
      source,
      target: syntheticTargetFor(include.path),
      metadata: { path: include.path, kind: include.kind },
    });
  }

  for (const graphic of structure.graphics) {
    edges.push({
      type: 'latex.image',
      source,
      target: syntheticTargetFor(graphic.path),
      metadata: { path: graphic.path },
    });
  }

  for (const bibliography of structure.bibliographies) {
    for (const file of bibliography.files) {
      edges.push({
        type: 'latex.bibliography',
        source,
        target: syntheticTargetFor(file),
        metadata: {
          path: file,
          ...(bibliography.style !== undefined ? { style: bibliography.style } : {}),
        },
      });
    }
  }

  return edges;
}
