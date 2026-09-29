/**
 * Tests for the in-memory derived metadata index.
 *
 * Metadata is derived state: a projection rebuilt from document
 * content, sorted deterministically by documentId.
 */

import { describe, expect, it } from 'vitest';
import { InMemoryMetadataService } from './metadata.js';
import { documentId } from './identity.js';
import { FroglightError, isFroglightError } from './errors.js';

describe('InMemoryMetadataService', () => {
  it('reverses and reactivates owned property overlays without recycling derived values', () => {
    const service = new InMemoryMetadataService();
    const id = documentId('owned');
    service.upsert(id, { properties: { source: true, region: 'source' } });
    const first = service.propertyProjection();
    first.set(id, { region: 'overlay' });
    expect(service.get(id).properties).toEqual({
      source: true,
      region: 'overlay',
    });
    first.set(id, {});
    expect(service.get(id).properties?.region).toBe('source');
    first.dispose();
    first.dispose();
    expect(() => first.set(id, { region: 'stale' })).toThrow(/disposed/);
    const second = service.propertyProjection();
    second.set(id, { region: 'replacement' });
    expect(service.list()[0]?.properties?.region).toBe('replacement');
    second.dispose();
    expect(service.get(id).properties?.region).toBe('source');
  });
  it('upserts and gets normalized metadata', () => {
    const service = new InMemoryMetadataService();
    const id = documentId('doc-1');
    service.upsert(id, {
      title: 'Hello',
      tags: ['a'],
      createdMillis: 1,
      modifiedMillis: 2,
    });
    const entry = service.get(id);
    expect(entry.documentId).toBe('doc-1');
    expect(entry.title).toBe('Hello');
    expect(entry.tags).toEqual(['a']);
    expect(entry.createdMillis).toBe(1);
    expect(entry.modifiedMillis).toBe(2);
  });

  it('stores kind-specific properties verbatim', () => {
    const service = new InMemoryMetadataService();
    const id = documentId('doc-1');
    const properties = { nested: { value: [1, 2, 3] }, flag: true };
    service.upsert(id, { properties });
    expect(service.get(id).properties).toEqual(properties);
  });

  it('omits undefined fields rather than storing them', () => {
    const service = new InMemoryMetadataService();
    const id = documentId('doc-1');
    service.upsert(id, {});
    const entry = service.get(id);
    expect(entry).toEqual({ documentId: 'doc-1' });
    expect('title' in entry).toBe(false);
  });

  it('upsert replaces the previous entry wholesale', () => {
    const service = new InMemoryMetadataService();
    const id = documentId('doc-1');
    service.upsert(id, { title: 'A', tags: ['x'] });
    service.upsert(id, { modifiedMillis: 9 });
    const entry = service.get(id);
    expect(entry.title).toBeUndefined();
    expect(entry.modifiedMillis).toBe(9);
  });

  it('get throws NOT_FOUND when absent', () => {
    const service = new InMemoryMetadataService();
    try {
      service.get(documentId('missing'));
      expect.unreachable();
    } catch (error) {
      expect(isFroglightError(error)).toBe(true);
      expect(error).toBeInstanceOf(FroglightError);
      expect((error as FroglightError).code).toBe('NOT_FOUND');
    }
  });

  it('remove is a no-op when absent', () => {
    const service = new InMemoryMetadataService();
    expect(() => service.remove(documentId('missing'))).not.toThrow();
  });

  it('lists entries sorted deterministically by documentId', () => {
    const service = new InMemoryMetadataService();
    service.upsert(documentId('doc-c'), { title: 'C' });
    service.upsert(documentId('doc-a'), { title: 'A' });
    service.upsert(documentId('doc-b'), { title: 'B' });
    expect(service.list().map((e) => e.documentId)).toEqual([
      'doc-a',
      'doc-b',
      'doc-c',
    ]);
  });

  it('clear removes all entries and returns the count', () => {
    const service = new InMemoryMetadataService();
    service.upsert(documentId('doc-a'), { title: 'A' });
    service.upsert(documentId('doc-b'), { title: 'B' });
    expect(service.clear()).toBe(2);
    expect(service.list()).toEqual([]);
    expect(service.clear()).toBe(0);
  });

  it('returned entries are copies (no external mutation)', () => {
    const service = new InMemoryMetadataService();
    service.upsert(documentId('doc-a'), { title: 'A' });
    const first = service.get(documentId('doc-a'));
    const list = service.list();
    (first as { title?: string }).title = 'MUTATED';
    expect(service.get(documentId('doc-a')).title).toBe('A');
    expect(list[0]?.title).toBe('A');
  });
});
