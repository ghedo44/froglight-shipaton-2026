/**
 * Tests for the in-memory relationship graph.
 *
 * Relationships are derived state: a projection rebuilt from
 * document content. This service is editor-neutral and JSON-serializable.
 */

import { describe, expect, it } from 'vitest';
import { InMemoryRelationshipService, type RelationshipInput } from './relationships.js';
import { documentId, resourceId } from './identity.js';
import { FroglightError, isFroglightError } from './errors.js';

const input = (overrides: Partial<RelationshipInput> = {}): RelationshipInput => ({
  type: 'test.link',
  source: { resourceId: resourceId('res-a') },
  target: {
    documentId: documentId('doc-b'),
    kindId: 'froglight.test-note' as never,
    location: { resourceId: resourceId('res-b') },
  },
  ...overrides,
});

/** Assert that `fn` throws a FroglightError with the given code. */
function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.unreachable('expected the call to throw');
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

describe('InMemoryRelationshipService', () => {
  it('add returns a stable id and stores the relationship', () => {
    const service = new InMemoryRelationshipService();
    const id = service.add(input());
    const stored = service.get(id);
    expect(id).toMatch(/^rel-\d+$/);
    expect(stored.type).toBe('test.link');
    expect(stored.source).toEqual({ resourceId: 'res-a' });
    expect(stored.target.documentId).toBe('doc-b');
  });

  it('ids are unique across adds', () => {
    const service = new InMemoryRelationshipService();
    const a = service.add(input());
    const b = service.add(input());
    expect(a).not.toBe(b);
  });

  it('normalizes undefined addresses out of stored shapes', () => {
    const service = new InMemoryRelationshipService();
    service.add(input({ source: { resourceId: resourceId('res-a'), address: undefined } }));
    const [stored] = service.list();
    expect(stored.source).toEqual({ resourceId: 'res-a' });
    expect('address' in stored.source).toBe(false);
  });

  it('preserves addresses when present', () => {
    const service = new InMemoryRelationshipService();
    service.add(input({ source: { resourceId: resourceId('res-a'), address: 'cell/2' } }));
    const [stored] = service.list();
    expect(stored.source).toEqual({ resourceId: 'res-a', address: 'cell/2' });
  });

  it('defaults metadata to an empty object', () => {
    const service = new InMemoryRelationshipService();
    service.add(input());
    expect(service.list()[0]?.metadata).toEqual({});
  });

  it('get throws NOT_FOUND when absent', () => {
    const service = new InMemoryRelationshipService();
    expectCode(() => service.get('rel-999'), 'NOT_FOUND');
  });

  it('remove deletes by id and throws NOT_FOUND for unknown ids', () => {
    const service = new InMemoryRelationshipService();
    const id = service.add(input());
    service.remove(id);
    expect(service.list()).toEqual([]);
    expectCode(() => service.remove(id), 'NOT_FOUND');
  });

  it('list preserves insertion order', () => {
    const service = new InMemoryRelationshipService();
    service.add(input({ type: 'first' }));
    service.add(input({ type: 'second' }));
    expect(service.list().map((r) => r.type)).toEqual(['first', 'second']);
  });

  it('bySource filters on the source resource', () => {
    const service = new InMemoryRelationshipService();
    service.add(input({ type: 'a', source: { resourceId: resourceId('res-a') } }));
    service.add(input({ type: 'b', source: { resourceId: resourceId('res-b') } }));
    service.add(input({ type: 'a2', source: { resourceId: resourceId('res-a') } }));
    const byA = service.bySource(resourceId('res-a'));
    expect(byA.map((r) => r.type).sort()).toEqual(['a', 'a2']);
    expect(service.bySource(resourceId('res-zzz'))).toEqual([]);
  });

  it('byTarget filters on the target document', () => {
    const service = new InMemoryRelationshipService();
    service.add(input({ type: 'x', target: { documentId: documentId('doc-1'), kindId: 'k' as never, location: { resourceId: resourceId('r1') } } }));
    service.add(input({ type: 'y', target: { documentId: documentId('doc-2'), kindId: 'k' as never, location: { resourceId: resourceId('r2') } } }));
    expect(service.byTarget(documentId('doc-1')).map((r) => r.type)).toEqual(['x']);
  });

  it('removeBySource removes only that source and returns the count', () => {
    const service = new InMemoryRelationshipService();
    service.add(input({ source: { resourceId: resourceId('res-a') } }));
    service.add(input({ source: { resourceId: resourceId('res-a') } }));
    service.add(input({ source: { resourceId: resourceId('res-b') } }));
    expect(service.removeBySource(resourceId('res-a'))).toBe(2);
    expect(service.list()).toHaveLength(1);
    expect(service.list()[0]?.source.resourceId).toBe('res-b');
  });

  it('clear removes all relationships and returns the count', () => {
    const service = new InMemoryRelationshipService();
    service.add(input());
    service.add(input());
    expect(service.clear()).toBe(2);
    expect(service.list()).toEqual([]);
    expect(service.clear()).toBe(0);
  });

  it('list/get/bySource/byTarget return copies', () => {
    const service = new InMemoryRelationshipService();
    const id = service.add(input());
    const direct = service.get(id);
    const fromList = service.list()[0];
    const fromSource = service.bySource(resourceId('res-a'))[0];
    (direct as { type: string }).type = 'MUTATED';
    (fromList as { type: string }).type = 'MUTATED';
    (fromSource as { type: string }).type = 'MUTATED';
    expect(service.get(id).type).toBe('test.link');
  });

  it('thrown errors are FroglightErrors with a stable code', () => {
    const service = new InMemoryRelationshipService();
    try {
      service.get('rel-999');
      expect.unreachable();
    } catch (error) {
      expect(isFroglightError(error)).toBe(true);
      expect(error).toBeInstanceOf(FroglightError);
      expect((error as FroglightError).code).toBe('NOT_FOUND');
    }
  });
});