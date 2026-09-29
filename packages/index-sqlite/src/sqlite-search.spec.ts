/**
 * File-backed SQLite FTS5 index: persistence, rebuild equivalence, recovery.
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DocumentId } from '@froglight/foundation';
import type { DocumentLocation } from '@froglight/foundation';
import { createSqliteSearchService } from './sqlite-search.js';

function location(resourceId: string): DocumentLocation {
  return {
    resourceId: resourceId as unknown as DocumentLocation['resourceId'],
  };
}

describe('SqliteSearchService (node:sqlite FTS5)', () => {
  it('indexes and prefix-searches documents', async () => {
    const svc = await createSqliteSearchService({ path: ':memory:' });
    if (!svc) throw new Error('node:sqlite unavailable — required on Node 24');
    try {
      svc.indexDocument(
        'doc-1' as DocumentId,
        location('a.md'),
        '# Hello\nworld offline note',
      );
      svc.indexDocument(
        'doc-2' as DocumentId,
        location('b.md'),
        '# Other\nunrelated content',
      );
      expect(svc.indexedIds()).toHaveLength(2);
      const hits = svc.search({ text: 'off' });
      expect(hits.map((h) => h.documentId)).toContain('doc-1' as DocumentId);
      expect(hits.map((h) => h.documentId)).not.toContain(
        'doc-2' as DocumentId,
      );
    } finally {
      svc.close();
    }
  });

  it('persists across reopen over the same file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'froglight-sqlite-'));
    const file = join(dir, 'index.db');
    const first = await createSqliteSearchService({ path: file });
    if (!first)
      throw new Error('node:sqlite unavailable — required on Node 24');
    first.indexDocument(
      'doc-1' as DocumentId,
      location('a.md'),
      '# Persist\nsurvives restart',
    );
    first.close();

    const second = await createSqliteSearchService({ path: file });
    if (!second)
      throw new Error('node:sqlite unavailable — required on Node 24');
    try {
      expect(second.indexedIds()).toContain('doc-1' as DocumentId);
      expect(second.search({ text: 'persist' })).toHaveLength(1);
    } finally {
      second.close();
    }
  });

  it('clear + rebuild converges with incremental indexing', async () => {
    const svc = await createSqliteSearchService({ path: ':memory:' });
    if (!svc) throw new Error('node:sqlite unavailable — required on Node 24');
    try {
      svc.indexDocument(
        'a' as DocumentId,
        location('a.md'),
        '# Alpha\nfirst doc',
      );
      svc.indexDocument(
        'b' as DocumentId,
        location('b.md'),
        '# Beta\nsecond doc',
      );
      const before = svc.search({ text: 'doc' }).map((h) => h.documentId);
      const cleared = svc.clear();
      expect(cleared).toBe(2);
      expect(svc.indexedIds()).toHaveLength(0);
      // Rebuild from canonical resources (same inputs, same order).
      svc.indexDocument(
        'a' as DocumentId,
        location('a.md'),
        '# Alpha\nfirst doc',
      );
      svc.indexDocument(
        'b' as DocumentId,
        location('b.md'),
        '# Beta\nsecond doc',
      );
      expect(svc.search({ text: 'doc' }).map((h) => h.documentId)).toEqual(
        before,
      );
    } finally {
      svc.close();
    }
  });

  it('remove drops the document from results', async () => {
    const svc = await createSqliteSearchService({ path: ':memory:' });
    if (!svc) throw new Error('node:sqlite unavailable — required on Node 24');
    try {
      svc.indexDocument(
        'gone' as DocumentId,
        location('g.md'),
        '# Gone\ntemporary',
      );
      expect(svc.search({ text: 'tempor' })).toHaveLength(1);
      svc.remove('gone' as DocumentId);
      expect(svc.search({ text: 'tempor' })).toHaveLength(0);
    } finally {
      svc.close();
    }
  });
});
