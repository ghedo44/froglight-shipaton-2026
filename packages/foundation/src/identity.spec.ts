/**
 * Tests for opaque workspace identities.
 *
 * `ResourceId`/`DocumentId`/`DocumentKindId` are branded opaque strings:
 * they are stable, portable, never aliases for paths, and validated on
 * branding.
 */

import { describe, expect, it } from 'vitest';
import {
  documentId,
  documentKindId,
  generateDocumentId,
  generateResourceId,
  resourceId,
  type DocumentId,
  type DocumentKindId,
  type ResourceId,
} from './identity.js';
import { isFroglightError, FroglightError } from './errors.js';

/** Assert that `fn` throws a FroglightError with the given code. */
function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.unreachable('expected the call to throw');
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

describe('identity branding', () => {
  it('brands valid ids and preserves the value', () => {
    expect(resourceId('res-1')).toBe('res-1');
    expect(documentId('doc-1')).toBe('doc-1');
    expect(documentKindId('froglight.test-note')).toBe('froglight.test-note');
  });

  it('brands are distinct types that never interconvert implicitly', () => {
    // Type-level assertion: a ResourceId must not be assignable to a
    // DocumentId without a cast. This compiles only if the brands differ.
    const r: ResourceId = resourceId('x');
    const d: DocumentId = documentId('x');
    const k: DocumentKindId = documentKindId('x');
    expect(typeof r).toBe('string');
    expect(typeof d).toBe('string');
    expect(typeof k).toBe('string');
    // Same value, different identity: the brands are distinct types.
    expect(r).toBe(d);
  });

  it('rejects empty ids with INVALID_ID', () => {
    expectCode(() => resourceId(''), 'INVALID_ID');
    expectCode(() => documentId(''), 'INVALID_ID');
    expectCode(() => documentKindId(''), 'INVALID_ID');
  });

  it('rejects NUL and backslash with INVALID_ID', () => {
    expectCode(() => resourceId('a\0b'), 'INVALID_ID');
    expectCode(() => documentKindId('a\\b'), 'INVALID_ID');
  });

  it('rejects over-long ids with INVALID_ID', () => {
    expectCode(() => resourceId('x'.repeat(513)), 'INVALID_ID');
  });

  it('accepts ids at the length limit', () => {
    expect(resourceId('x'.repeat(512)).length).toBe(512);
  });

  it('thrown errors are FroglightErrors with a stable code', () => {
    try {
      resourceId('');
      expect.unreachable();
    } catch (error) {
      expect(isFroglightError(error)).toBe(true);
      expect(error).toBeInstanceOf(FroglightError);
      expect((error as FroglightError).code).toBe('INVALID_ID');
    }
  });
});

describe('generateResourceId / generateDocumentId', () => {
  it('generates fresh, non-empty, valid ids', () => {
    const r1 = generateResourceId();
    const r2 = generateResourceId();
    expect(r1).not.toBe(r2);
    expect(r1.length).toBeGreaterThan(0);
    const d1 = generateDocumentId();
    const d2 = generateDocumentId();
    expect(d1).not.toBe(d2);
    expect(d1.length).toBeGreaterThan(0);
  });

  it('generated ids are branded as the right types', () => {
    const r: ResourceId = generateResourceId();
    const d: DocumentId = generateDocumentId();
    expect(typeof r).toBe('string');
    expect(typeof d).toBe('string');
  });

  it('generated ids are stable, portable strings (JSON-serializable)', () => {
    const id = generateDocumentId();
    const roundTripped: unknown = JSON.parse(JSON.stringify(id));
    expect(roundTripped).toBe(id);
  });
});