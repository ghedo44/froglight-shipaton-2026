import { describe, expect, it } from 'vitest';
import { extractLinks, extractTags } from './links.js';

describe('extractLinks', () => {
  it('extracts markdown links and images', () => {
    const body = 'See [foo](notes/b.md) and ![alt](img.png) and [web](https://example.com)';
    const links = extractLinks(body);
    expect(links).toHaveLength(3);
    expect(links[0].destination).toBe('notes/b.md');
    expect(links[0].kind).toBe('markdown-link');
    expect(links[1].kind).toBe('markdown-image');
    expect(links[2].destination).toBe('https://example.com');
  });

  it('extracts wiki-links with fragment and alias', () => {
    const body = '[[MyDoc]] [[Path/Doc#Heading|Alias]]';
    const links = extractLinks(body);
    expect(links).toHaveLength(2);
    expect(links[0].destination).toBe('MyDoc');
    expect(links[1].destination).toBe('Path/Doc');
    expect(links[1].fragment).toBe('Heading');
    expect(links[1].alias).toBe('Alias');
  });

  it('classifies wiki embeds separately from navigation links', () => {
    expect(extractLinks('![[Note#^block]] [[Note]] ![[Pixel.png|100x145]]')).toMatchObject([
      { kind: 'wiki-embed', destination: 'Note', fragment: '^block' },
      { kind: 'wiki-link', destination: 'Note' },
      { kind: 'wiki-embed', destination: 'Pixel.png', alias: '100x145' },
    ]);
  });

  it('ignores incomplete wiki syntax', () => {
    const body = '[[unclosed';
    expect(extractLinks(body)).toHaveLength(0);
  });
});

describe('extractTags', () => {
  it('extracts inline #tags but not headings', () => {
    const body = '# Heading\nThis has #tagOne and #tag-two.';
    const tags = extractTags(body);
    expect(tags).toEqual(['tagOne', 'tag-two']);
  });
});
