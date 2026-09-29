// Stable link codec specs (copy-link resolves to same location).
import { describe, expect, it } from 'vitest';
import {
  formatResourceLink,
  parseResourceLink,
} from './resource-link.js';

describe('resource link codec', () => {
  it('round-trips a target without address', () => {
    const target = {
      documentId: 'docA',
      kindId: 'froglight.markdown',
      resourceId: 'resA',
    } as never;
    const text = formatResourceLink(target);
    expect(text).not.toContain('http');
    expect(parseResourceLink(text)).toEqual(target);
  });

  it('round-trips a target with address', () => {
    const target = {
      documentId: 'docA',
      kindId: 'froglight.notebook',
      resourceId: 'resA',
      address: 'pg-1',
    } as never;
    expect(parseResourceLink(formatResourceLink(target))).toEqual(target);
  });

  it('rejects browser URLs, blanks, and malformed JSON without throwing', () => {
    expect(parseResourceLink('')).toBeNull();
    expect(parseResourceLink('   ')).toBeNull();
    expect(parseResourceLink('https://example.com/doc')).toBeNull();
    expect(parseResourceLink('froglight://doc/res')).toBeNull();
    expect(parseResourceLink('not json')).toBeNull();
    expect(parseResourceLink('{"documentId":""}')).toBeNull();
    expect(parseResourceLink('{"documentId":"d","kindId":"k"}')).toBeNull();
  });

  it('emits canonical key order so identical targets copy identically', () => {
    const target = {
      resourceId: 'resA',
      kindId: 'froglight.markdown',
      documentId: 'docA',
    } as never;
    expect(formatResourceLink(target)).toBe(
      '{"documentId":"docA","kindId":"froglight.markdown","resourceId":"resA"}',
    );
  });

  it('omits empty addresses so format output always parses', () => {
    const withEmpty = {
      documentId: 'd',
      kindId: 'k',
      resourceId: 'r',
      address: '',
    } as never;
    const text = formatResourceLink(withEmpty);
    // Byte-equality with the app codec output for the same target
    // (packages/application/src/link-resolution.ts:108-117 pins the same
    // fixture by value): empty addresses are never serialized as `""`.
    expect(text).toBe('{"documentId":"d","kindId":"k","resourceId":"r"}');
    expect(text).not.toContain('"address"');
    // format→parse round-trip: an empty address normalizes to absent.
    expect(parseResourceLink(text)).toEqual({
      documentId: 'd',
      kindId: 'k',
      resourceId: 'r',
    });
    // No parser accepts an explicit empty address (`isResourceTarget`
    // rejects `""`), so the omitted form is the only valid wire form.
    expect(
      parseResourceLink(
        '{"documentId":"d","kindId":"k","resourceId":"r","address":""}',
      ),
    ).toBeNull();
  });

  it('returns null for non-string input without throwing', () => {
    for (const bad of [null, undefined, 42, {}, []] as never[]) {
      expect(() => parseResourceLink(bad)).not.toThrow();
      expect(parseResourceLink(bad)).toBeNull();
    }
  });
});
