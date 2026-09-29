/**
 * Notebook document kind `froglight.notebook`. Host- and editor-free; page content rides the shared
 * surface codec so format guarantees are defined in exactly one place.
 */

import { documentKindId, type DocumentKindId } from '../identity.js';
import type {
  DocumentKindDescriptor,
  DocumentTemplateCloneContext,
} from '../documents.js';
import { cloneTemplateValue } from '../documents.js';
import type { RelationshipInput } from '../relationships.js';
import type { NotebookModel } from './model.js';
import { SURFACE_SEED_BOUNDS_BY_PAGE_KEY } from '../surfaces/open-metadata.js';
import { cloneSurfaceTemplate } from '../surfaces/kind.js';
import { extractSurfaceEmbedRelationships } from '../surfaces/relationships.js';
import { decodeNotebook, decodeNotebookAsync, encodeNotebook, encodeNotebookAsync } from './codec.js';
import { extractNotebookMetadata } from './metadata.js';
import { projectNotebookForSearch } from './search.js';
import { appendPage, emptyNotebook, notebookPage } from './model.js';
import { structuredDocumentProperties } from '../resource-properties/model.js';

export const notebookKindId: DocumentKindId =
  documentKindId('froglight.notebook');

/**
 * Notebook embed edge type, owned here. The generic surface helper
 * takes an opaque `edgeType: string`; it defines no registry.
 */
export const NOTEBOOK_EMBED_EDGE_TYPE = 'notebook.embed' as const;

function cloneNotebookTemplate(
  model: NotebookModel,
  context: DocumentTemplateCloneContext,
): NotebookModel {
  const pageIds = new Map(
    Object.keys(model.pages).map((id) => [id, context.newInternalId()]),
  );
  const clone = cloneTemplateValue(model);
  clone.pageOrder = clone.pageOrder.map((id) => pageIds.get(id) ?? id);
  clone.pages = Object.fromEntries(
    Object.entries(clone.pages).map(([id, entry]) => {
      const nextId = pageIds.get(id) ?? id;
      if (entry.kind === 'opaque') {
        return [
          nextId,
          { ...entry, id: nextId, raw: { ...entry.raw, id: nextId } },
        ];
      }
      return [
        nextId,
        {
          ...entry,
          id: nextId,
          record: { ...entry.record, id: nextId },
          surface: cloneSurfaceTemplate(entry.surface, context),
        },
      ];
    }),
  );
  return clone;
}

/**
 * Format the composite notebook embed source address.
 *
 * Plain `${pageId}/${objectId}` join. Page and object ids are each opaque
 * non-empty strings that MAY contain `/`, so the composite is opaque too.
 */
export function formatNotebookEmbedAddress(
  pageId: string,
  objectId: string,
): string {
  return `${pageId}/${objectId}`;
}

/**
 * Best-effort legacy parse of a composite notebook embed address.
 *
 * Split rule (pinned): split on the FIRST `/` — `pageId` is the prefix before
 * it, `objectId` is the remainder (which may itself contain `/`). Returns
 * `null` for missing/empty/slash-free input.
 *
 * Opaque contract: consumers MUST use `metadata.pageId`/`metadata.objectId`
 * and never string-parse `source.address`. Slash-containing page ids are not
 * reversible via string (first-`/` split keeps the object suffix verbatim at
 * the cost of truncating a slashed page prefix); metadata stays authoritative.
 */
export function parseNotebookEmbedAddress(
  address: string | undefined | null,
): { pageId: string; objectId: string } | null {
  if (typeof address !== 'string' || address.length === 0) return null;
  const slash = address.indexOf('/');
  if (slash < 0) return null;
  return {
    pageId: address.slice(0, slash),
    objectId: address.slice(slash + 1),
  };
}

/**
 * Aggregate per-page `notebook.embed` edges in canonical page order.
 *
 * Each navigable page contributes its surface embeds via the shared helper
 * (paint order + out-of-order orphans within the page, invalid targets
 * skipped, dangling targets preserved). The edge source is page-addressed:
 * `source.address` is the opaque `formatNotebookEmbedAddress(pageId, objectId)`
 * so two pages containing the same object id stay distinct; `metadata`
 * carries both `{objectId, pageId}` and is the ONLY authoritative split —
 * never string-parse `source.address`: both ids may contain `/`,
 * so the composite is not reversible; see `parseNotebookEmbedAddress` for the
 * pinned best-effort first-`/` rule). Opaque pages contribute nothing (their
 * bytes are preserved verbatim but cannot be projected safely). Rebuildable
 * headless from canonical bytes: save → re-decode refreshes edges through the
 * workspace post-commit path.
 */
export function extractNotebookEmbedRelationships(
  model: NotebookModel,
  ref: { location: { resourceId: unknown } },
): RelationshipInput[] {
  const baseSource = { resourceId: ref.location.resourceId } as never;
  const relationships: RelationshipInput[] = [];
  for (const pageId of model.pageOrder) {
    const entry = model.pages[pageId];
    if (entry === undefined || entry.kind !== 'page') continue;
    const pageEdges = extractSurfaceEmbedRelationships({
      source: baseSource,
      model: entry.surface,
      edgeType: NOTEBOOK_EMBED_EDGE_TYPE,
    });
    for (const edge of pageEdges) {
      const rawObjectId = (edge.metadata as { objectId?: unknown }).objectId;
      const leaf =
        typeof rawObjectId === 'string' && rawObjectId.length > 0
          ? rawObjectId
          : (edge.source.address ?? '');
      relationships.push({
        ...edge,
        source: {
          ...edge.source,
          address: formatNotebookEmbedAddress(pageId, leaf),
        },
        metadata: { ...edge.metadata, pageId },
      });
    }
  }
  return relationships;
}

export const notebookKind: DocumentKindDescriptor<NotebookModel> = {
  documentProperties: structuredDocumentProperties,
  id: notebookKindId,
  creation: {
    label: 'Notebook',
    extension: '.notebook',
    createInitialModel: (title) => {
      const notebook = emptyNotebook(title);
      appendPage(notebook, notebookPage('page-1'));
      return notebook;
    },
  },
  cloneTemplate: cloneNotebookTemplate,
  documentTitle: {
    read: (model) =>
      typeof model.meta.title === 'string' ? model.meta.title : null,
    write: (model, title) => {
      model.meta.title = title;
    },
  },
  // Extension-first recognition, mirroring the block-page/ink rule;
  // content sniffing happens implicitly at decode time (a non-conforming
  // payload fails RECORD_CORRUPT rather than being misparsed).
  recognize: (kindId) =>
    kindId === notebookKindId ||
    (typeof kindId === 'string' && kindId.endsWith('.notebook')),
  decode: (data, ref) => {
    const result = decodeNotebook(data);
    return {
      model: result.model,
      metadata: extractNotebookMetadata(result.model) as Record<
        string,
        unknown
      >,
      relationships: extractNotebookEmbedRelationships(result.model, ref),
      warnings: result.warnings,
      // Disposable per-page decode-time Ink bounds: the pager
      // exposes each page's seeds to its mounting surface. Never canonical.
      // The whole-document content revision is owned by the session layer
      // (`DOCUMENT_CONTENT_REVISION_KEY`), not rescanned here.
      openMetadata: {
        [SURFACE_SEED_BOUNDS_BY_PAGE_KEY]: result.seedBoundsByPage,
      },
    };
  },
  decodeAsync: async (data, ref, isCurrent) => {
    const result = await decodeNotebookAsync(data, isCurrent);
    if (result === null || !isCurrent()) return null;
    return {
      model: result.model,
      metadata: extractNotebookMetadata(result.model) as Record<string, unknown>,
      relationships: extractNotebookEmbedRelationships(result.model, ref),
      warnings: result.warnings,
      openMetadata: { [SURFACE_SEED_BOUNDS_BY_PAGE_KEY]: result.seedBoundsByPage },
    };
  },
  encode: (model) => encodeNotebook(model),
  encodeAsync: (model, _ref, isCurrent) => encodeNotebookAsync(model, isCurrent),
  projectCommitted: (model, ref) => {
    const projection = projectNotebookForSearch(model, '');
    return {
      metadata: extractNotebookMetadata(model) as Record<string, unknown>,
      relationships: extractNotebookEmbedRelationships(model, ref),
      searchText: projection.body,
      searchAnchors: projection.anchors.map((anchor) => ({
        address: anchor.address,
        start: anchor.start,
        end: anchor.end,
      })),
    };
  },
  searchText: (model) => projectNotebookForSearch(model, '').body,
  searchAnchors: (model) => projectNotebookForSearch(model, '').anchors,
};

export { NOTEBOOK_FORMAT_VERSION } from './codec.js';
