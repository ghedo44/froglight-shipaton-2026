/**
 * Relationship extraction for block pages.
 *
 * Link marks carrying vault-relative or workspace-absolute paths become
 * `blockpage.link` edges with synthetic targets the workspace-layer
 * resolver maps to real documents (same convention as Markdown edges).
 * `http(s)`/`mailto` links stay external and emit no edge.
 */

import type { DocumentLocation } from '../documents.js';
import type { RelationshipInput } from '../relationships.js';
import {
  isLinkMark,
  isResourceMark,
  isResourceTarget,
  inlineRunsOf,
  childrenOf,
  type BlockPageModel,
  type BlockRecord,
  type Run,
} from './model.js';

const EXTERNAL_HREF = /^(https?:\/\/|mailto:)/i;

export interface ExtractBlockPageRelationshipsInput {
  readonly source: DocumentLocation;
  readonly model: BlockPageModel;
}

function* runsInDocumentOrder(model: BlockPageModel): Generator<{ block: BlockRecord; run: Run }> {
  const visited = new Set<string>();
  function* visit(id: string): Generator<{ block: BlockRecord; run: Run }> {
    if (visited.has(id)) return;
    visited.add(id);
    const record = model.blocks[id];
    if (record === undefined) return;
    for (const run of inlineRunsOf(record)) yield { block: record, run };
    for (const child of childrenOf(record)) yield* visit(child);
  }
  for (const id of model.rootOrder) yield* visit(id);
  for (const id of Object.keys(model.blocks)) yield* visit(id);
}

/** Extract relationships from a block page model. Engine-free. */
export function extractBlockPageRelationships(
  input: ExtractBlockPageRelationshipsInput,
): RelationshipInput[] {
  const edges: RelationshipInput[] = [];
  for (const { block, run } of runsInDocumentOrder(input.model)) {
    const marks = run.marks;
    if (marks === undefined) continue;
    for (const mark of marks) {
      if (isResourceMark(mark)) {
        edges.push(resourceEdge('blockpage.link', input.source, block.id, mark.target));
        continue;
      }
      if (!isLinkMark(mark)) continue;
      if (EXTERNAL_HREF.test(mark.href)) continue;
      const hash = mark.href.indexOf('#');
      const hrefPath = hash === -1 ? mark.href : mark.href.slice(0, hash);
      const fragment = hash === -1 ? '' : mark.href.slice(hash + 1);
      edges.push({
        type: 'blockpage.link',
        source: { ...input.source, address: block.id },
        target: {
          documentId: hrefPath as never,
          kindId: 'froglight.blockpage' as never,
          location: {
            resourceId: hrefPath as never,
            ...(fragment !== '' ? { address: fragment } : {}),
          },
        },
        metadata: {
          href: mark.href,
          ...(fragment !== '' ? { fragment } : {}),
          blockId: block.id,
        },
      });
    }
  }
  for (const block of Object.values(input.model.blocks)) {
    if (!isResourceTarget(block.target)) continue;
    // Media locators (`src`/integrity hash, opt-in `remote.url`) are asset
    // references, not document references: they project no edges. In
    // particular `remote.url` is never a ResourceTarget (it carries no
    // stable document/resource identity) and remote URL bytes never become
    // relationship targets.
    const type =
      block.type === 'froglight.resource-link' ? 'blockpage.link' :
      block.type === 'froglight.resource-embed' ? 'blockpage.embed' :
      block.type === 'froglight.transclusion' ? 'blockpage.transclusion' :
      block.type === 'froglight.linked-view' ? 'blockpage.linked-view' : null;
    if (type !== null) edges.push(resourceEdge(type, input.source, block.id, block.target));
  }
  return edges;
}

function resourceEdge(
  type: string,
  source: DocumentLocation,
  blockId: string,
  target: import('./model.js').ResourceTarget,
): RelationshipInput {
  return {
    type,
    source: { ...source, address: blockId },
    target: {
      documentId: target.documentId as never,
      kindId: target.kindId as never,
      location: {
        resourceId: target.resourceId as never,
        ...(target.address !== undefined ? { address: target.address } : {}),
      },
    },
    metadata: { blockId },
  };
}
