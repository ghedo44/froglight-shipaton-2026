import { describe, expect, it } from 'vitest';
import { InMemorySearchService } from './service.js';
import { resourceId, documentId } from '../identity.js';

describe('InMemorySearchService', () => {
  it('indexes and searches with title boost', () => {
    const svc = new InMemorySearchService();
    svc.indexDocument(documentId('doc-1'), { resourceId: resourceId('res-1') }, '# Hello\nBody about cats');
    svc.indexDocument(documentId('doc-2'), { resourceId: resourceId('res-2') }, '---\ntitle: Dogs\n---\nBody about dogs');
    const results = svc.search({ text: 'Hello' });
    expect(results[0].documentId).toBe('doc-1');
    const catRes = svc.search({ text: 'cats' });
    expect(catRes[0].documentId).toBe('doc-1');
  });

  it('returns prefix matches while the query is being typed', () => {
    const svc = new InMemorySearchService();
    svc.indexDocument(
      documentId('doc-welcome'),
      { resourceId: resourceId('res-welcome') },
      '# Welcome\nStart here',
    );

    for (const query of ['w', 'we', 'wel', 'welc', 'welcome']) {
      expect(svc.search({ text: query }).map((result) => result.documentId)).toContain('doc-welcome');
    }
  });

  it('supports clear and rebuild equivalence', () => {
    const svc = new InMemorySearchService();
    svc.indexDocument(documentId('doc-a'), { resourceId: resourceId('res-a') }, 'alpha beta');
    svc.indexDocument(documentId('doc-b'), { resourceId: resourceId('res-b') }, 'beta gamma');
    const before = svc.search({ text: 'beta' }).map((r) => r.documentId).sort();
    svc.clear();
    expect(svc.search({ text: 'beta' })).toHaveLength(0);
    svc.indexDocument(documentId('doc-a'), { resourceId: resourceId('res-a') }, 'alpha beta');
    svc.indexDocument(documentId('doc-b'), { resourceId: resourceId('res-b') }, 'beta gamma');
    const after = svc.search({ text: 'beta' }).map((r) => r.documentId).sort();
    expect(after).toEqual(before);
  });

  it('searches tags and frontmatter', () => {
    const svc = new InMemorySearchService();
    svc.indexDocument(documentId('doc-1'), { resourceId: resourceId('res-1') }, '---\ntags: [important]\n---\nContent');
    const res = svc.search({ text: 'important' });
    expect(res).toHaveLength(1);
  });
});
