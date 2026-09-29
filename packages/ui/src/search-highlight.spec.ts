import { describe, expect, it } from 'vitest';
import { highlightMatches } from './search-ui.js';

describe('highlightMatches', () => {
  it('wraps matched prefixes in <mark>', () => {
    const html = highlightMatches('The quick brown fox', 'quick bro');
    expect(html).toBe('The <mark>quick</mark> <mark>bro</mark>wn fox');
  });

  it('is case-insensitive and marks every occurrence', () => {
    const html = highlightMatches('Frog jumps. frog lands.', 'frog');
    expect((html.match(/<mark>/g) ?? []).length).toBe(2);
  });

  it('escapes HTML in the excerpt', () => {
    const html = highlightMatches('<img src=x onerror=y>', 'img');
    expect(html).toContain('&lt;<mark>img</mark>');
    expect(html).not.toContain('<img');
  });

  it('escapes the query too', () => {
    const html = highlightMatches('a & b', '& b');
    expect(html).toBe('a <mark>&amp;</mark> <mark>b</mark>');
  });

  it('returns escaped text unchanged when nothing matches', () => {
    expect(highlightMatches('plain text', 'zzz')).toBe('plain text');
  });

  it('handles empty query', () => {
    expect(highlightMatches('plain text', '')).toBe('plain text');
  });
});
