/**
 * Plain outline contracts.
 *
 * Headless and engine-free: entries are plain data (no editor, DOM, or
 * host types) so headless hosts and tests consume the same contract as
 * the sidebar panel.
 */

import type { DocumentKindId } from '@froglight/foundation';

/** One navigable row in a document outline. */
export interface DocumentOutlineEntry {
  /** Stable id unique within one outline (slug, block id, page id, ...). */
  readonly id: string;
  /** Portable in-document address for `DocumentLocation.address`. */
  readonly address: string;
  /** Heading level, or 1 for flat block/page/object rows. */
  readonly level: number;
  /** Human-readable row label (plain text, see per-kind label chains). */
  readonly label: string;
  /** Row family; absent means a generic row. */
  readonly kind?: 'heading' | 'block' | 'page' | 'object';
}

/**
 * Plain extractor input. The registry caches by document identity and
 * revision, or by a stable model hash when no revision is available.
 * Identity-free calls extract fresh rows without sharing cache slots.
 */
export interface OutlineExtractInput {
  readonly model: unknown;
  readonly revision?: string | number;
  readonly documentIdentity?: string;
}

/** Synchronous headless outline extractor for one document kind. */
export interface OutlineExtractor {
  readonly kindId: DocumentKindId;
  /** False for a registered placeholder that does not provide an outline yet. */
  readonly available?: boolean;
  extract(input: OutlineExtractInput): readonly DocumentOutlineEntry[];
}
