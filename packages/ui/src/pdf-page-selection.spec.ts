import { describe, expect, it } from 'vitest';
import { parsePdfPageSelection } from './pdf-page-selection.js';

describe('PDF page selection', () => {
  it('accepts all pages or one-based ranges and returns sorted zero-based indexes', () => {
    expect(parsePdfPageSelection('all')).toBeUndefined();
    expect(parsePdfPageSelection('3, 1-2, 2')).toEqual([0, 1, 2]);
  });

  it('rejects backward, zero, malformed, and oversized selections', () => {
    expect(() => parsePdfPageSelection('3-1')).toThrow('run forward');
    expect(() => parsePdfPageSelection('0')).toThrow('start at 1');
    expect(() => parsePdfPageSelection('one')).toThrow('Use page numbers');
    expect(() => parsePdfPageSelection('1-10001')).toThrow('10,000-page');
  });
});
