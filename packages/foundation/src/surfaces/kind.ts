/**
 * Ink page document kind `froglight.ink`: one bounded
 * surface payload as the canonical resource. Host- and
 * editor-free; the codec is the shared surface payload codec, so format
 * guarantees (versioning, preservation, limits) are defined in exactly
 * one place.
 */

import { documentKindId, type DocumentKindId } from '../identity.js';
import { FroglightError } from '../errors.js';
import type {
  DocumentKindDescriptor,
  DocumentTemplateCloneContext,
} from '../documents.js';
import { cloneTemplateValue } from '../documents.js';
import { decodeSurfacePayload, decodeSurfacePayloadAsync, encodeSurfacePayload } from './codec.js';
import { SURFACE_SEED_BOUNDS_KEY } from './open-metadata.js';
import { extractSurfaceEmbedRelationships } from './relationships.js';
import { surfaceDocumentTitle, writeSurfaceDocumentTitle, surfaceDocumentProperties } from './title.js';
import {
  SURFACE_OBJECT_TYPES,
  emptySurface,
  boundedFrame,
  type SurfaceModel,
  type SurfaceObjectRecord,
} from './model.js';

export const inkPageKindId: DocumentKindId = documentKindId('froglight.ink');

function requireBoundedInk(model: SurfaceModel): void {
  if (model.frame.kind !== 'bounded') {
    throw new FroglightError(
      'RECORD_CORRUPT',
      '.ink documents require a bounded canvas',
    );
  }
}

function remapBinding(
  value: unknown,
  ids: ReadonlyMap<string, string>,
): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return value;
  const binding = value as Record<string, unknown>;
  return typeof binding.objectId === 'string' && ids.has(binding.objectId)
    ? { ...binding, objectId: ids.get(binding.objectId)! }
    : value;
}

/** Clone a Surface template while keeping external resource/asset references explicit. */
export function cloneSurfaceTemplate(
  model: SurfaceModel,
  context: DocumentTemplateCloneContext,
): SurfaceModel {
  const ids = new Map(
    Object.keys(model.objects).map((id) => [id, context.newInternalId()]),
  );
  const clone = cloneTemplateValue(model);
  clone.order = clone.order.map((id) => ids.get(id) ?? id);
  clone.objects = Object.fromEntries(
    Object.entries(clone.objects).map(([id, record]) => {
      const nextId = ids.get(id) ?? id;
      const next = record as SurfaceObjectRecord & Record<string, unknown>;
      (next as Record<string, unknown>).id = nextId;
      if (
        next.type === SURFACE_OBJECT_TYPES.group &&
        Array.isArray(next.children)
      ) {
        next.children = next.children.map((child) =>
          typeof child === 'string' ? (ids.get(child) ?? child) : child,
        );
      }
      if (
        next.type === SURFACE_OBJECT_TYPES.stroke &&
        typeof next.logicalId === 'string' &&
        ids.has(next.logicalId)
      ) {
        next.logicalId = ids.get(next.logicalId)!;
      }
      if (next.type === SURFACE_OBJECT_TYPES.line) {
        next.source = remapBinding(next.source, ids);
        next.target = remapBinding(next.target, ids);
      }
      return [nextId, next];
    }),
  );
  return clone;
}

/**
 * Ink embed edge type, owned here. The generic surface
 * helper takes an opaque `edgeType: string`; it defines no registry.
 */
export const INK_EMBED_EDGE_TYPE = 'ink.embed' as const;

export const inkPageKind: DocumentKindDescriptor<SurfaceModel> = {
  documentProperties: surfaceDocumentProperties,
  id: inkPageKindId,
  creation: {
    label: 'Ink page',
    extension: '.ink',
    createInitialModel: (title) => {
      const model = emptySurface(boundedFrame(800, 600));
      if (title !== '') writeSurfaceDocumentTitle(model, title);
      return model;
    },
  },
  cloneTemplate: cloneSurfaceTemplate,
  documentTitle: {
    read: (model) => surfaceDocumentTitle(model),
    write: (model, title) => writeSurfaceDocumentTitle(model, title),
  },
  // Extension-first recognition, mirroring the block-page rule; content
  // sniffing happens implicitly at decode time.
  recognize: (kindId) =>
    kindId === inkPageKindId ||
    (typeof kindId === 'string' && kindId.endsWith('.ink')),
  decode: (data, ref) => {
    const result = decodeSurfacePayload(data);
    requireBoundedInk(result.model);
    const source = { resourceId: ref.location.resourceId } as never;
    const relationships = extractSurfaceEmbedRelationships({
      source,
      model: result.model,
      edgeType: INK_EMBED_EDGE_TYPE,
    });
    return {
      model: result.model,
      metadata: {
        ...(surfaceDocumentTitle(result.model) !== null
          ? { title: surfaceDocumentTitle(result.model)! }
          : {}),
      },
      relationships,
      warnings: result.warnings,
      // Disposable decode-time Ink bounds: the session exposes
      // these to the mounting editor so the spatial index seeds without a
      // second full sample scan. Never canonical, never persisted.
      // The canonical content revision is owned by the session layer
      // (`DOCUMENT_CONTENT_REVISION_KEY`), not recomputed here.
      openMetadata: {
        [SURFACE_SEED_BOUNDS_KEY]: result.seedBounds,
      },
    };
  },
  decodeAsync: async (data, ref, isCurrent) => {
    const result = await decodeSurfacePayloadAsync(data, isCurrent);
    if (result === null || !isCurrent()) return null;
    requireBoundedInk(result.model);
    const source = { resourceId: ref.location.resourceId } as never;
    const relationships = extractSurfaceEmbedRelationships({
      source,
      model: result.model,
      edgeType: INK_EMBED_EDGE_TYPE,
    });
    const title = surfaceDocumentTitle(result.model);
    return {
      model: result.model,
      metadata: { ...(title !== null ? { title } : {}) },
      relationships,
      warnings: result.warnings,
      openMetadata: { [SURFACE_SEED_BOUNDS_KEY]: result.seedBounds },
    };
  },
  encode: (model) => {
    requireBoundedInk(model);
    return encodeSurfacePayload(model);
  },
  projectCommitted: (model, ref) => ({
    metadata: { ...(surfaceDocumentTitle(model) !== null ? { title: surfaceDocumentTitle(model)! } : {}) },
    relationships: extractSurfaceEmbedRelationships({
      source: { resourceId: ref.location.resourceId } as never,
      model,
      edgeType: INK_EMBED_EDGE_TYPE,
    }),
    searchText: inkPageKind.searchText!(model),
    searchAnchors: [],
  }),
  searchText: (model) => {
    const parts: string[] = [];
    for (const id of model.order) {
      const record = model.objects[id];
      if (record?.type !== SURFACE_OBJECT_TYPES.text) continue;
      if (typeof record.text === 'string' && record.text !== '') {
        parts.push(record.text);
      }
    }
    return parts.join('\n');
  },
};
