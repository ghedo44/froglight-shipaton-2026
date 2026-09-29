import { describe, expect, it } from 'vitest';
import { parseFrontmatter, serializeFrontmatter } from './frontmatter.js';

describe('parseFrontmatter', () => {
  it('parses YAML frontmatter at start', () => {
    const raw = '---\ntitle: Hello\ntags: [a, b]\n---\nBody';
    const res = parseFrontmatter(raw);
    expect(res.raw).not.toBeNull();
    expect(res.frontmatter).toEqual({ title: 'Hello', tags: ['a', 'b'] });
    expect(res.body).toBe('Body');
  });

  it('returns no frontmatter when file does not start with ---', () => {
    const raw = 'Title\n---\nnot frontmatter';
    const res = parseFrontmatter(raw);
    expect(res.raw).toBeNull();
    expect(res.body).toBe(raw);
  });

  it('preserves raw block for malformed YAML but frontmatter null', () => {
    // Hard malformed case: key without colon
    const raw2 = '---\nbad line without colon\n---\nBody';
    const res2 = parseFrontmatter(raw2);
    expect(res2.raw).not.toBeNull();
    expect(res2.frontmatter).toBeNull();
    expect(res2.body).toBe('Body');
  });

  it('handles closing with...', () => {
    const raw = '---\ntitle: Hi\n...\nBody';
    const res = parseFrontmatter(raw);
    expect(res.frontmatter).toEqual({ title: 'Hi' });
    expect(res.body).toBe('Body');
  });

  it('handles empty frontmatter', () => {
    const raw = '---\n---\nBody';
    const res = parseFrontmatter(raw);
    expect(res.frontmatter).toEqual({});
    expect(res.body).toBe('Body');
  });

  it('round-trips verbatim when file has no mutation (preservation)', () => {
    const raw = '---\ntitle: A\nunknown: keepme\n---\nContent';
    const res = parseFrontmatter(raw);
    expect(res.raw).toBe('---\ntitle: A\nunknown: keepme\n---\n');
    expect(res.frontmatter).toEqual({ title: 'A', unknown: 'keepme' });
  });

  it('serializeFrontmatter produces ---\n block', () => {
    const out = serializeFrontmatter({ title: 'Hi', tags: ['a'] });
    expect(out).toBe('---\ntitle: Hi\ntags: ["a"]\n---\n');
  });
});
