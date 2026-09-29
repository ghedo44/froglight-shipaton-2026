/**
 * Derived handwriting recognition: an explicit,
 * host-free recognizer contract plus a wrapping SearchService that merges
 * recognized lines into indexing as derived state. Canonical bytes are
 * never touched; clearing the store (restart/rebuild policy) removes every
 * trace until recognition runs again.
 */

import { describe, expect, it } from 'vitest';
import { InMemorySearchService } from '../search/service.js';
import type { DocumentSearchAnchor } from '../documents.js';
import {
  HandwritingAwareSearchService,
  type RecognizedHandwritingLine,
} from './recognition.js';

describe('HandwritingAwareSearchService', () => {
  const location = { resourceId: 'r1' as never };

  function baseIndex(inner: InMemorySearchService): void {
    const anchors: DocumentSearchAnchor[] = [{ address: 'p1', start: 0, end: 5 }];
    inner.indexDocument('d1' as never, location, 'typed words', anchors);
  }

  it('behaves as a plain passthrough without stored handwriting', () => {
    const inner = new InMemorySearchService();
    const service = new HandwritingAwareSearchService(inner);
    baseIndex(inner);
    expect(service.indexedIds()).toEqual(['d1']);
    expect(service.search({ text: 'typed' })).toHaveLength(1);
    // No derived hit exists.
    expect(service.search({ text: 'scrawled' })).toHaveLength(0);
  });

  it('merges stored recognized lines into subsequent indexing with page addresses', () => {
    const inner = new InMemorySearchService();
    const service = new HandwritingAwareSearchService(inner);
    baseIndex(inner);

    const lines: RecognizedHandwritingLine[] = [
      { pageId: 'p2', strokeIds: ['s1', 's2'], text: 'scrawled derivation' },
    ];
    service.setHandwriting('d1' as never, lines);
    // Post-commit re-projection flows through the same public seam.
    service.indexDocument('d1' as never, location, 'typed words', [
      { address: 'p1', start: 0, end: 5 },
    ]);

    const hits = service.search({ text: 'scrawled' });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.location.address).toBe('p2');
    // Base content still searchable.
    expect(service.search({ text: 'typed' })).toHaveLength(1);
  });

  it('drops every trace when cleared, matching the rebuildable-derived contract', () => {
    const inner = new InMemorySearchService();
    const service = new HandwritingAwareSearchService(inner);
    service.setHandwriting('d1' as never, [
      { pageId: 'p2', strokeIds: ['s1'], text: 'secret scribble' },
    ]);
    service.indexDocument('d1' as never, location, 'typed', []);
    expect(service.search({ text: 'scribble' })).toHaveLength(1);

    service.clearHandwriting();
    service.indexDocument('d1' as never, location, 'typed', []);
    expect(service.search({ text: 'scribble' })).toHaveLength(0);
    expect(service.search({ text: 'typed' })).toHaveLength(1);
  });
});
