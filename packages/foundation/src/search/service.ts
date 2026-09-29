/**
 * Derived workspace search service.
 *
 * The in-memory implementation is intentionally provider-neutral and is the
 * reference behavior for later SQLite/FTS providers. Query tokens are prefix
 * matched so search is useful while the user is still typing.
 */

import type { DocumentId } from '../identity.js';
import type { DocumentLocation } from '../documents.js';
import type { DocumentSearchAnchor } from '../documents.js';
import { projectMarkdownForSearch, tokenize } from '../markdown/search.js';

export interface SearchQuery {
  readonly text: string;
  readonly limit?: number;
}

export interface SearchResult {
  readonly documentId: DocumentId;
  readonly location: DocumentLocation;
  readonly score: number;
  readonly excerpt: string;
  readonly title?: string;
}

export interface SearchService {
  /** Index or reindex one textual projection. */
  indexDocument(
    documentId: DocumentId,
    location: DocumentLocation,
    raw: string,
    anchors?: readonly DocumentSearchAnchor[],
  ): void;
  remove(documentId: DocumentId): void;
  clear(): number;
  indexedIds(): readonly DocumentId[];
  search(query: SearchQuery): readonly SearchResult[];
}

/** In-memory BM25-ish FTS with prefix-as-you-type matching. */
export class InMemorySearchService implements SearchService {
  readonly #docs = new Map<
    string,
    {
      location: DocumentLocation;
      indexText: string;
      title: string;
      body: string;
      tags: readonly string[];
      anchors?: readonly DocumentSearchAnchor[];
    }
  >();
  #df = new Map<string, number>();
  #tf = new Map<string, Map<string, number>>();

  indexDocument(
    documentId: DocumentId,
    location: DocumentLocation,
    raw: string,
    anchors?: readonly DocumentSearchAnchor[],
  ): void {
    const projection = projectMarkdownForSearch(raw, documentId);
    const tokens = tokenize(projection.indexText);

    const oldTf = this.#tf.get(documentId);
    if (oldTf !== undefined) {
      for (const term of oldTf.keys()) this.#decrementDf(term);
    }

    const frequencies = new Map<string, number>();
    for (const token of tokens) {
      frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    }
    for (const term of frequencies.keys()) {
      this.#df.set(term, (this.#df.get(term) ?? 0) + 1);
    }

    this.#tf.set(documentId, frequencies);
    this.#docs.set(documentId, {
      location: { ...location },
      indexText: projection.indexText,
      title: projection.title,
      body: projection.body,
      tags: projection.tags,
      ...(anchors !== undefined && anchors.length > 0 ? { anchors } : {}),
    });
  }

  remove(documentId: DocumentId): void {
    const oldTf = this.#tf.get(documentId);
    if (oldTf !== undefined) {
      for (const term of oldTf.keys()) this.#decrementDf(term);
      this.#tf.delete(documentId);
    }
    this.#docs.delete(documentId);
  }

  clear(): number {
    const count = this.#docs.size;
    this.#docs.clear();
    this.#tf.clear();
    this.#df.clear();
    return count;
  }

  indexedIds(): readonly DocumentId[] {
    return [...this.#docs.keys()] as DocumentId[];
  }

  search(query: SearchQuery): readonly SearchResult[] {
    const queryTokens = tokenize(query.text);
    if (queryTokens.length === 0 || this.#docs.size === 0) return [];

    const documentCount = this.#docs.size;
    const results: SearchResult[] = [];

    for (const [documentId, doc] of this.#docs) {
      const frequencies = this.#tf.get(documentId);
      if (frequencies === undefined) continue;

      let score = 0;
      let matched = false;
      const titleTokens = tokenize(doc.title);
      const tagTokens = doc.tags.flatMap((tag) => tokenize(tag));

      for (const queryToken of queryTokens) {
        const matches = [...frequencies.entries()].filter(([term]) =>
          term.startsWith(queryToken),
        );
        if (matches.length === 0) continue;
        matched = true;

        const titleBoost = titleTokens.some((term) => term.startsWith(queryToken)) ? 2 : 1;
        const tagBoost = tagTokens.some((term) => term.startsWith(queryToken)) ? 1.5 : 1;

        for (const [term, count] of matches) {
          const df = this.#df.get(term) ?? 1;
          const idf = Math.log((documentCount - df + 0.5) / (df + 0.5) + 1);
          const tfNorm = count / (count + 1);
          // Exact terms rank slightly above longer prefix completions.
          const prefixBoost = term === queryToken ? 1.15 : 1;
          score += tfNorm * idf * titleBoost * tagBoost * prefixBoost;
        }
      }

      if (!matched) continue;
      const match = buildExcerpt(doc.body, queryTokens);
      const address = doc.anchors !== undefined ? anchorFor(doc.anchors, match.start) : undefined;
      results.push({
        documentId: documentId as DocumentId,
        location: address !== undefined ? { ...doc.location, address } : { ...doc.location },
        score,
        excerpt: match.excerpt,
        title: doc.title || undefined,
      });
    }

    results.sort((a, b) => b.score - a.score || (a.documentId < b.documentId ? -1 : 1));
    return results.slice(0, query.limit ?? 20);
  }

  #decrementDf(term: string): void {
    const current = this.#df.get(term) ?? 0;
    if (current <= 1) this.#df.delete(term);
    else this.#df.set(term, current - 1);
  }
}

function buildExcerpt(body: string, queryTokens: readonly string[]): { excerpt: string; start: number } {
  const lower = body.toLowerCase();
  let index = -1;
  let token = '';
  for (const queryToken of queryTokens) {
    const position = lower.indexOf(queryToken);
    if (position !== -1 && (index === -1 || position < index)) {
      index = position;
      token = queryToken;
    }
  }
  if (index === -1) return { excerpt: body.slice(0, 120), start: 0 };
  const start = Math.max(0, index - 40);
  const end = Math.min(body.length, index + token.length + 80);
  return {
    excerpt: `${start > 0 ? '…' : ''}${body.slice(start, end).replace(/\n/g, ' ')}${end < body.length ? '…' : ''}`,
    start: index,
  };
}

/** Address of the anchor covering a body offset (nearest preceding wins). */
function anchorFor(anchors: readonly DocumentSearchAnchor[], offset: number): string | undefined {
  let best: DocumentSearchAnchor | undefined;
  for (const anchor of anchors) {
    if (anchor.start <= offset && offset < anchor.end) return anchor.address;
    if (anchor.start <= offset && (best === undefined || anchor.start > best.start)) best = anchor;
  }
  return best?.address;
}
