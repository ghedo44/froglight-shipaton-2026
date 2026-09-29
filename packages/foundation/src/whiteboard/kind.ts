/**
 * Whiteboard document kind `froglight.whiteboard`.
 * Canonical = one infinite Surface payload record. Host- and editor-free;
 * format guarantees live in exactly one place (surface codec).
 */

import { documentKindId, type DocumentKindId } from '../identity.js';
import type { DocumentKindDescriptor } from '../documents.js';
import type { SurfaceModel } from '../surfaces/model.js';
import { SURFACE_SEED_BOUNDS_KEY } from '../surfaces/open-metadata.js';
import { decodeWhiteboard, decodeWhiteboardAsync, encodeWhiteboard, encodeWhiteboardAsync } from './codec.js';
import { extractWhiteboardMetadata } from './metadata.js';
import { extractWhiteboardRelationships } from './relationships.js';
import { projectWhiteboardForSearch } from './search.js';
import { emptySurface, infiniteFrame } from '../surfaces/model.js';
import { cloneSurfaceTemplate } from '../surfaces/kind.js';
import {
  surfaceDocumentTitle,
  writeSurfaceDocumentTitle,
  surfaceDocumentProperties,
} from '../surfaces/title.js';

export const whiteboardKindId: DocumentKindId = documentKindId(
  'froglight.whiteboard',
);

export const whiteboardKind: DocumentKindDescriptor<SurfaceModel> = {
  documentProperties: surfaceDocumentProperties,
  id: whiteboardKindId,
  creation: {
    label: 'Whiteboard',
    extension: '.whiteboard',
    createInitialModel: (title) => {
      const model = emptySurface(infiniteFrame());
      if (title !== '') writeSurfaceDocumentTitle(model, title);
      return model;
    },
  },
  cloneTemplate: cloneSurfaceTemplate,
  documentTitle: {
    read: (model) => surfaceDocumentTitle(model),
    write: (model, title) => writeSurfaceDocumentTitle(model, title),
  },
  recognize: (kindId) =>
    kindId === whiteboardKindId ||
    (typeof kindId === 'string' && (kindId as string).endsWith('.whiteboard')),
  decode: (data, ref) => {
    const result = decodeWhiteboard(data);
    const source = { resourceId: ref.location.resourceId } as never;
    const relationships = extractWhiteboardRelationships({
      source,
      model: result.model,
    });
    return {
      model: result.model,
      metadata: extractWhiteboardMetadata(result.model) as Record<
        string,
        unknown
      >,
      relationships,
      warnings: result.warnings,
      // Disposable decode-time Ink bounds: see surfaces/kind.ts.
      // The content revision is owned by the session layer, not rescanned
      // here.
      openMetadata: {
        [SURFACE_SEED_BOUNDS_KEY]: result.seedBounds,
      },
    };
  },
  decodeAsync: async (data, ref, isCurrent) => {
    const result = await decodeWhiteboardAsync(data, isCurrent);
    if (result === null || !isCurrent()) return null;
    const source = { resourceId: ref.location.resourceId } as never;
    const relationships = extractWhiteboardRelationships({ source, model: result.model });
    return {
      model: result.model,
      metadata: extractWhiteboardMetadata(result.model) as Record<string, unknown>,
      relationships,
      warnings: result.warnings,
      openMetadata: { [SURFACE_SEED_BOUNDS_KEY]: result.seedBounds },
    };
  },
  encode: (model, _ref) => encodeWhiteboard(model as SurfaceModel),
  encodeAsync: (model, _ref, isCurrent) =>
    encodeWhiteboardAsync(model as SurfaceModel, isCurrent),
  projectCommitted: (model, ref) => {
    const surface = model as SurfaceModel;
    const source = { resourceId: ref.location.resourceId } as never;
    const searchProjection = projectWhiteboardForSearch(surface);
    return {
      metadata: extractWhiteboardMetadata(surface) as Record<string, unknown>,
      relationships: extractWhiteboardRelationships({ source, model: surface }),
      searchText: searchProjection.body,
      searchAnchors: searchProjection.anchors.map((anchor) => ({
        address: anchor.address,
        start: 0,
        end: anchor.excerpt.length,
      })),
    };
  },
  searchText: (model) => projectWhiteboardForSearch(model as SurfaceModel).body,
  searchAnchors: (model) => {
    const proj = projectWhiteboardForSearch(model as SurfaceModel);
    return proj.anchors.map((a) => ({
      address: a.address,
      start: 0,
      end: a.excerpt.length,
    }));
  },
};

export { WHITEBOARD_FORMAT_VERSION } from './codec.js';
