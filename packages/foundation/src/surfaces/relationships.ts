/**
 * Extract relationships from a Surface model for its owning document kind.
 * The caller owns the edge type; this helper validates that it is non-empty
 * and stamps it onto each edge. It visits ordered objects first, then
 * preserved orphans, skips invalid targets, and maps valid targets to
 * `DocumentRef` values with the surface object id as metadata. Target
 * existence and deletion are handled downstream, so dangling targets remain
 * represented. Embed presentation affects rendering, not relationship
 * identity or extraction.
 */

import type { DocumentLocation } from '../documents.js';
import type { RelationshipInput } from '../relationships.js';
import { isResourceTarget } from '../blocks/model.js';
import type { SurfaceModel, SurfaceObjectRecord } from './model.js';

export interface ExtractSurfaceEmbedRelationshipsInput {
  readonly source: DocumentLocation;
  readonly model: SurfaceModel;
  /**
   * Opaque typed edge owned by the calling kind (e.g. `'whiteboard.embed'`).
   * Stamped verbatim; must be a non-empty string.
   */
  readonly edgeType: string;
}

/**
 * Extract one typed embed edge per valid `froglight.resource-embed` object.
 * Engine-free. See module contract above.
 */
export function extractSurfaceEmbedRelationships(
  input: ExtractSurfaceEmbedRelationshipsInput,
): RelationshipInput[] {
  if (typeof input.edgeType !== 'string' || input.edgeType.length === 0) {
    throw new TypeError(
      'extractSurfaceEmbedRelationships: edgeType must be a non-empty string',
    );
  }
  const edges: RelationshipInput[] = [];
  const ordered = new Set<string>(input.model.order);
  for (const id of input.model.order) {
    const record = input.model.objects[id];
    if (record === undefined) continue;
    const edge = surfaceEmbedEdge(input.source, input.edgeType, id, record);
    if (edge !== null) edges.push(edge);
  }
  // Out-of-order orphans project too (opaque preservation keeps them alive).
  for (const id of Object.keys(input.model.objects)) {
    if (ordered.has(id)) continue;
    const record = input.model.objects[id];
    if (record === undefined) continue;
    const edge = surfaceEmbedEdge(input.source, input.edgeType, id, record);
    if (edge !== null) edges.push(edge);
  }
  return edges;
}

function surfaceEmbedEdge(
  source: DocumentLocation,
  edgeType: string,
  id: string,
  record: SurfaceObjectRecord,
): RelationshipInput | null {
  if (record.type !== 'froglight.resource-embed') return null;
  if (!isResourceTarget(record.target)) return null;
  const target = record.target as {
    documentId: string;
    kindId: string;
    resourceId: string;
    address?: string;
  };
  return {
    type: edgeType,
    source: { ...source, address: id },
    target: {
      documentId: target.documentId as never,
      kindId: target.kindId as never,
      location: {
        resourceId: target.resourceId as never,
        ...(target.address !== undefined ? { address: target.address } : {}),
      },
    },
    metadata: { objectId: id },
  };
}

// --- Presentation normalization (rendering hint for, no UI here) ---

/** Rendering mode for a resource-embed frame. Absent defaults to `preview`. */
export type ResourceEmbedPresentationMode = 'preview' | 'link';

export interface ResolvedResourceEmbedPresentation {
  /** Effective rendering mode (`preview` unless explicitly `link`). */
  readonly mode: ResourceEmbedPresentationMode;
  /** Verbatim `presentation` member when present, else `undefined`. */
  readonly raw: unknown;
  /** True when present but not a known preview/link value (degraded). */
  readonly unknown: boolean;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalize the optional `presentation` member of a resource-embed record.
 *
 * - absent → `{mode:'preview', unknown:false}` (the default frame);
 * - `'preview'` / `{mode:'preview'}` → preview;
 * - `'link'` / `{mode:'link'}` → link (compact presentation);
 * - anything else present → `{mode:'preview', unknown:true, raw}` — preview
 *   rendering with the raw value preserved verbatim (codec keeps it
 *   byte-stable; extraction still emits the edge).
 *
 * Literal and `{mode}` shapes are accepted. Unknown shapes render as preview
 * while retaining their raw value.
 */
export function resolveResourceEmbedPresentation(
  record: SurfaceObjectRecord,
): ResolvedResourceEmbedPresentation {
  const raw = (record as Record<string, unknown>).presentation;
  if (raw === undefined) return { mode: 'preview', raw: undefined, unknown: false };
  if (raw === 'preview') return { mode: 'preview', raw, unknown: false };
  if (raw === 'link') return { mode: 'link', raw, unknown: false };
  if (isPlainRecord(raw)) {
    if (raw.mode === 'preview') return { mode: 'preview', raw, unknown: false };
    if (raw.mode === 'link') return { mode: 'link', raw, unknown: false };
  }
  return { mode: 'preview', raw, unknown: true };
}

/** Effective rendering mode shorthand for `resolveResourceEmbedPresentation`. */
export function resourceEmbedPresentationModeOf(
  record: SurfaceObjectRecord,
): ResourceEmbedPresentationMode {
  return resolveResourceEmbedPresentation(record).mode;
}
