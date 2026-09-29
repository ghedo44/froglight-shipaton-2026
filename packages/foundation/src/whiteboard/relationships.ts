/**
 * Whiteboard relationship extraction — typed `embed` edges via the shared
 * surface helper, rebuildable headless from canonical model.
 * Each `froglight.resource-embed` projects one `whiteboard.embed` edge.
 * Thin wrapper: ordering/filter/mapping live in
 * `../surfaces/relationships.js` so whiteboard/ink/notebook stay identical.
 * Edge-type ownership: the `'whiteboard.embed'` literal is owned
 * here, not by the generic helper (which takes an opaque `edgeType: string`).
 */

import type { DocumentLocation } from '../documents.js';
import type { RelationshipInput } from '../relationships.js';
import type { SurfaceModel } from '../surfaces/model.js';
import { extractSurfaceEmbedRelationships } from '../surfaces/relationships.js';

/** Whiteboard embed edge type, owned by this wrapper.*/
export const WHITEBOARD_EMBED_EDGE_TYPE = 'whiteboard.embed' as const;

export interface ExtractWhiteboardRelationshipsInput {
  readonly source: DocumentLocation;
  readonly model: SurfaceModel;
}

export function extractWhiteboardRelationships(
  input: ExtractWhiteboardRelationshipsInput,
): RelationshipInput[] {
  return extractSurfaceEmbedRelationships({
    source: input.source,
    model: input.model,
    edgeType: WHITEBOARD_EMBED_EDGE_TYPE,
  });
}
