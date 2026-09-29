import { describe, expect, it } from 'vitest';
import { buildAddressIndex, extractBlocks, extractHeadings, slugify } from './addressing.js';

describe('slugify', () => {
  it('lowercases and collapses', () => {
    expect(slugify('Hello World!')).toBe('hello-world');
    expect(slugify('  Foo  Bar  ')).toBe('foo-bar');
  });

  it('handles unicode and accents', () => {
    expect(slugify('Café')).toBe('cafe');
  });

  it('deduplicates headings', () => {
    const body = '# Hello\n# Hello\n# Hello';
    const heads = extractHeadings(body);
    expect(heads.map((h) => h.slug)).toEqual(['hello', 'hello-1', 'hello-2']);
  });
});

describe('extractHeadings', () => {
  it('extracts ATX headings', () => {
    const body = '# One\nText\n## Two\n### Three ###';
    const heads = extractHeadings(body);
    expect(heads).toHaveLength(3);
    expect(heads[0].level).toBe(1);
    expect(heads[1].level).toBe(2);
    expect(heads[2].text).toBe('Three');
  });
});

describe('extractBlocks', () => {
  it('extracts ^block-id', () => {
    const body = 'Paragraph ^myBlock1\nNext line\nAnother ^x2';
    const blocks = extractBlocks(body);
    expect(blocks.map((b) => b.id)).toEqual(['^myBlock1', '^x2']);
  });
});

describe('buildAddressIndex', () => {
  it('maps slug and block id separately', () => {
    const body = '# Hello\nParagraph ^hello';
    const idx = buildAddressIndex(body);
    expect(idx.get('hello')).toBe(0);
    expect(idx.get('^hello')).toBe(1);
  });
});
