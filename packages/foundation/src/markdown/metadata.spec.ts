import { describe, expect, it } from 'vitest';
import { extractMarkdownMetadata } from './metadata.js';
import { documentId } from '../identity.js';

describe('extractMarkdownMetadata', () => {
  it('prefers frontmatter title over heading', () => {
    const raw = '---\ntitle: FM Title\n---\n# Heading Title\nBody';
    const meta = extractMarkdownMetadata({ documentId: documentId('doc-1'), raw });
    expect(meta.title).toBe('FM Title');
  });

  it('falls back to first heading', () => {
    const raw = '# My Heading\nBody';
    const meta = extractMarkdownMetadata({ documentId: documentId('doc-2'), raw });
    expect(meta.title).toBe('My Heading');
  });

  it('merges frontmatter tags and inline tags deduped', () => {
    const raw = '---\ntags: [a, b]\n---\nBody #b #c';
    const meta = extractMarkdownMetadata({ documentId: documentId('doc-3'), raw });
    expect(meta.tags).toEqual(['a', 'b', 'c']);
  });

  it('exposes frontmatter properties without title/tags', () => {
    const raw = '---\ntitle: T\ncustom: 123\nunknown: keep\n---\nBody';
    const meta = extractMarkdownMetadata({ documentId: documentId('doc-4'), raw });
    expect(meta.properties).toEqual({ custom: 123, unknown: 'keep' });
  });

  it('produces undefined title when none', () => {
    const raw = 'Just body #tag';
    const meta = extractMarkdownMetadata({ documentId: documentId('doc-5'), raw, fallbackTitle: 'file.md' });
    // fallback provided
    expect(meta.title).toBe('file.md');
  });
});
