/**
 * Block page document kind `froglight.blockpage`.
 * Host- and editor-free: no Tiptap/ProseMirror/DOM types.
 */

import { documentKindId, type DocumentKindId } from '../identity.js';
import type {
  DocumentKindDescriptor,
  DocumentTemplateCloneContext,
} from '../documents.js';
import { cloneTemplateValue } from '../documents.js';
import type { BlockPageModel, BlockRecord } from './model.js';
import {
  decodeBlockPage,
  decodeBlockPageAsync,
  encodeBlockPage,
  type DecodeBlockPageResult,
} from './codec.js';
import { extractBlockPageMetadata } from './metadata.js';
import { extractBlockPageRelationships } from './relationships.js';
import { projectBlockPageForSearch } from './search.js';
import { emptyBlockPage, paragraphBlock } from './model.js';
import { structuredDocumentProperties } from '../resource-properties/model.js';

export const blockPageKindId: DocumentKindId = documentKindId(
  'froglight.blockpage',
);

function remapBlockChildren(
  record: BlockRecord,
  ids: ReadonlyMap<string, string>,
): void {
  const remap = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map((id) => (typeof id === 'string' ? (ids.get(id) ?? id) : id))
      : value;
  const mutable = record as Record<string, unknown>;
  if (record.children !== undefined) mutable.children = remap(record.children);
  if (Array.isArray(record.items)) {
    mutable.items = record.items.map((item) => {
      if (typeof item !== 'object' || item === null || Array.isArray(item))
        return item;
      const copy = item as Record<string, unknown>;
      return copy.children === undefined
        ? copy
        : { ...copy, children: remap(copy.children) };
    });
  }
}

function cloneBlockPageTemplate(
  model: BlockPageModel,
  context: DocumentTemplateCloneContext,
): BlockPageModel {
  const ids = new Map(
    Object.keys(model.blocks).map((id) => [id, context.newInternalId()]),
  );
  const clone = cloneTemplateValue(model);
  clone.rootOrder = clone.rootOrder.map((id) => ids.get(id) ?? id);
  clone.blocks = Object.fromEntries(
    Object.entries(clone.blocks).map(([id, record]) => {
      const nextId = ids.get(id) ?? id;
      (record as Record<string, unknown>).id = nextId;
      remapBlockChildren(record, ids);
      return [nextId, record];
    }),
  );
  return clone;
}

export const blockPageKind: DocumentKindDescriptor<BlockPageModel> = {
  documentProperties: structuredDocumentProperties,
  id: blockPageKindId,
  creation: {
    label: 'Block page',
    extension: '.blockpage',
    createInitialModel: (title) => {
      const page = emptyBlockPage({ title });
      const first = paragraphBlock('p-1', []);
      page.rootOrder.push(first.id);
      page.blocks[first.id] = first;
      return page;
    },
  },
  cloneTemplate: cloneBlockPageTemplate,
  documentTitle: {
    read: (model) =>
      typeof model.meta.title === 'string' ? model.meta.title : null,
    write: (model, title) => {
      model.meta.title = title;
    },
  },
  // Extension-first recognition;
  // content sniffing is not expressible in this id-based hook and happens
  // implicitly at decode time (a non-.blockpage payload fails
  // RECORD_CORRUPT rather than being misparsed).
  recognize: (kindId) =>
    kindId === blockPageKindId ||
    (typeof kindId === 'string' && kindId.endsWith('.blockpage')),
  decode: (data, ref) => {
    const result = decodeBlockPage(data, ref) as DecodeBlockPageResult & {
      metadata: Record<string, unknown>;
    };
    // Derived projections are computed here so the workspace's generic
    // decode-driven projection path (post-commit and rebuild) stays
    // document-kind agnostic.
    return {
      ...result,
      metadata: extractBlockPageMetadata({
        documentId: ref.documentId,
        model: result.model,
      }) as Record<string, unknown>,
      relationships: extractBlockPageRelationships({
        source: ref.location,
        model: result.model,
      }),
    };
  },
  decodeAsync: async (data, ref, isCurrent) => {
    const decoded = await decodeBlockPageAsync(data, ref, isCurrent);
    if (decoded === null || !isCurrent()) return null;
    return {
      ...decoded,
      metadata: extractBlockPageMetadata({
        documentId: ref.documentId,
        model: decoded.model,
      }) as Record<string, unknown>,
      relationships: extractBlockPageRelationships({
        source: ref.location,
        model: decoded.model,
      }),
    };
  },
  encode: (model, ref) => encodeBlockPage(model, ref),
  searchText: (model) => projectBlockPageForSearch(model, '').body,
  searchAnchors: (model) => projectBlockPageForSearch(model, '').anchors,
};
