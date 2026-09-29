/**
 * Block page outline extractor for heading blocks.
 *
 * Eligibility: heading blocks are always admitted (even with empty text)
 * with verbatim levels (1-6) and verbatim labels. Everything else is
 * excluded: paragraph/quote/toggle/callout/code body blocks, list/table/
 * image/divider blocks, resource-link/embed blocks, transclusion/
 * linked-view blocks, unknown (opaque/future) types, structurally invalid
 * records, and internals (child records nested under list items or the
 * generic `children` member — the outline is a flat top-level traversal
 * in `rootOrder`, with unreachable top-level records appended in map
 * order for recovered documents, mirroring the search projection).
 * Internals never outline, even when they also sit in `blocks`: every id
 * reachable through `childrenOf` (the same recursion the search projection
 * uses to visit children) is marked visited without emitting a row, so the
 * unreachable sweep only picks up truly-unreachable top-level records.
 *
 * Label chain (pinned):
 * - heading blocks: `runs` joined verbatim (marks ignored);
 * - `^` vocabulary: `^block-id`-looking sequences are literal
 *   plain text in labels and are never stripped; the row address is the
 *   block id itself.
 *
 * The model is only read through shared accessors and is never mutated,
 * so unknown fields round-trip untouched.
 */

import {
  BLOCK_PAGE_BLOCK_TYPES,
  blockPageKindId,
  childrenOf,
  runsOf,
  type BlockPageModel,
  type BlockRecord,
} from '@froglight/foundation';
import type { DocumentOutlineEntry, OutlineExtractInput, OutlineExtractor } from './types.js';

function plainTextOf(record: BlockRecord): string | null {
  const runs = runsOf(record);
  if (runs === null) return null;
  return runs.map((run) => run.text).join('');
}

function entryForBlock(id: string, record: BlockRecord): DocumentOutlineEntry | null {
  if (record.type === BLOCK_PAGE_BLOCK_TYPES.heading) {
    const text = plainTextOf(record);
    if (text === null) return null;
    const level = record.level;
    if (typeof level !== 'number' || !Number.isInteger(level) || level < 1 || level > 6) return null;
    return { id, address: id, level, label: text, kind: 'heading' };
  }
  return null;
}

/** Extract the flat top-level outline; never mutates the model. */
export function extractBlockPageOutline(model: BlockPageModel): readonly DocumentOutlineEntry[] {
  const entries: DocumentOutlineEntry[] = [];
  const seen = new Set<string>();
  // Mark every transitively nested child as an internal without emitting a
  // row: mirrors the search projection's recursion into
  // `childrenOf`, so the unreachable sweep below only picks up
  // truly-unreachable top-level records. `seen` guards against cycles.
  const markNestedVisited = (id: string): void => {
    const record = model.blocks[id];
    if (record === undefined) return;
    for (const child of childrenOf(record)) {
      if (seen.has(child)) continue;
      seen.add(child);
      markNestedVisited(child);
    }
  };
  const visitTopLevel = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const record = model.blocks[id];
    if (record === undefined) return;
    const entry = entryForBlock(id, record);
    if (entry !== null) entries.push(entry);
    markNestedVisited(id);
  };
  for (const id of model.rootOrder) visitTopLevel(id);
  // Unreachable top-level records still outline (recovered documents).
  for (const id of Object.keys(model.blocks)) visitTopLevel(id);
  return entries;
}

export const blockPageOutlineExtractor: OutlineExtractor = {
  kindId: blockPageKindId,
  extract: (input: OutlineExtractInput) => extractBlockPageOutline(input.model as BlockPageModel),
};
