/**
 * Derived handwriting recognition: the host-free
 * recognizer contract plus a wrapping SearchService that merges
 * recognized lines into indexing as derived state. Canonical bytes are
 * never touched; clearing the store removes every trace until recognition
 * runs again (rebuildable-derived semantics).
 */

import type { DocumentId } from '../identity.js';
import type { DocumentLocation } from '../documents.js';
import type { DocumentSearchAnchor } from '../documents.js';
import type {
  SearchQuery,
  SearchResult,
  SearchService,
} from '../search/service.js';
import { SURFACE_OBJECT_TYPES, type SurfaceObjectRecord } from '../surfaces/model.js';
import type { NotebookModel } from './model.js';
import { isNavigablePage } from './model.js';

/** One recognized text line and the strokes that produced it. */
export interface RecognizedHandwritingLine {
  readonly pageId: string;
  readonly strokeIds: readonly string[];
  readonly text: string;
}

/** Pages offered to a recognizer: stroke records grouped per navigable page. */
export interface HandwritingQueryPage {
  readonly pageId: string;
  readonly strokes: readonly SurfaceObjectRecord[];
}

/**
 * Host-free handwriting recognizer. Implementations are replaceable
 * providers; running one is always an explicit user action.
 * Deterministic and engine-free in tests.
 */
export interface HandwritingRecognizer {
  readonly id: string;
  recognize(
    pages: readonly HandwritingQueryPage[],
  ): Promise<readonly RecognizedHandwritingLine[]> | readonly RecognizedHandwritingLine[];
}

/** Collect stroke records per navigable page from a notebook model. */
export function notebookHandwritingQueries(
  model: NotebookModel,
): HandwritingQueryPage[] {
  const pages: HandwritingQueryPage[] = [];
  for (const id of model.pageOrder) {
    const entry = model.pages[id];
    if (!isNavigablePage(entry)) continue;
    const strokes = entry.surface.order
      .map((objectId) => entry.surface.objects[objectId])
      .filter((record): record is SurfaceObjectRecord =>
        record?.type === SURFACE_OBJECT_TYPES.stroke,
      );
    if (strokes.length > 0) pages.push({ pageId: id, strokes });
  }
  return pages;
}

/**
 * Wrapping SearchService holding derived handwriting lines per document
 * and merging them into every subsequent `indexDocument` call with
 * page-addressed anchors. The inner service stays authoritative for all
 * other behavior.
 */
export class HandwritingAwareSearchService implements SearchService {
  readonly #inner: SearchService;
  readonly #lines = new Map<DocumentId, readonly RecognizedHandwritingLine[]>();

  constructor(inner: SearchService) {
    this.#inner = inner;
  }

  /** Store (or, with `null`, clear) derived lines for one document. */
  setHandwriting(documentId: DocumentId, lines: readonly RecognizedHandwritingLine[] | null): void {
    if (lines === null || lines.length === 0) this.#lines.delete(documentId);
    else this.#lines.set(documentId, lines);
  }

  /** Derived lines currently held for one document. */
  handwritingFor(documentId: DocumentId): readonly RecognizedHandwritingLine[] {
    return this.#lines.get(documentId) ?? [];
  }

  /** Drop all derived lines (restart/rebuild policy). */
  clearHandwriting(): void {
    this.#lines.clear();
  }

  indexDocument(
    documentId: DocumentId,
    location: DocumentLocation,
    raw: string,
    anchors?: readonly DocumentSearchAnchor[],
  ): void {
    const stored = this.#lines.get(documentId);
    if (stored === undefined || stored.length === 0) {
      this.#inner.indexDocument(documentId, location, raw, anchors);
      return;
    }
    let text = raw;
    const mergedAnchors: DocumentSearchAnchor[] = [...(anchors ?? [])];
    for (const line of stored) {
      if (line.text === '') continue;
      const start = text.length + 1; // accounting for the separator below
      text += `\n${line.text}`;
      mergedAnchors.push({ address: line.pageId, start, end: start + line.text.length });
    }
    this.#inner.indexDocument(documentId, location, text, mergedAnchors);
  }

  remove(documentId: DocumentId): void {
    this.#lines.delete(documentId);
    this.#inner.remove(documentId);
  }

  clear(): number {
    this.clearHandwriting();
    return this.#inner.clear();
  }

  indexedIds(): readonly DocumentId[] {
    return this.#inner.indexedIds();
  }

  search(query: SearchQuery): readonly SearchResult[] {
    return this.#inner.search(query);
  }
}
