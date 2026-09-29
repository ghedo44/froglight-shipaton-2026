import { describe, expect, it } from 'vitest';
import { documentId, documentKindId, resourceId } from '../identity.js';
import { decodeMarkdown, encodeMarkdown } from './codec.js';

describe('markdown codec', () => {
  it('round-trips verbatim', () => {
    const raw = '---\ntitle: Hello\n---\n# Hello\nBody [link](other.md) [[Wiki]]';
    const ref = { documentId: documentId('doc-a'), kindId: documentKindId('froglight.markdown'), location: { resourceId: resourceId('res-a') } };
    const decoded = decodeMarkdown(new TextEncoder().encode(raw), ref);
    const encoded = encodeMarkdown(decoded.model, ref);
    expect(new TextDecoder().decode(encoded)).toBe(raw);
  });

  it('extracts metadata title from heading', () => {
    const raw = '# My Title\nBody';
    const ref = { documentId: documentId('doc-b'), kindId: documentKindId('froglight.markdown'), location: { resourceId: resourceId('res-b') } };
    const decoded = decodeMarkdown(new TextEncoder().encode(raw), ref);
    expect((decoded.metadata as { title?: string }).title).toBe('My Title');
  });

  it('extracts relationships', () => {
    const raw = 'See [[Other]] and [foo](other.md)';
    const ref = { documentId: documentId('doc-c'), kindId: documentKindId('froglight.markdown'), location: { resourceId: resourceId('res-c') } };
    const decoded = decodeMarkdown(new TextEncoder().encode(raw), ref);
    expect(decoded.relationships).toHaveLength(2);
    expect(decoded.relationships[0].type).toBe('markdown.link');
    expect(decoded.relationships[1].type).toBe('markdown.link');
  });

  it('produces unknown-field-preserving encode (raw unchanged)', () => {
    const raw = '---\ntitle: T\nunknown: keep\n---\nBody';
    const ref = { documentId: documentId('doc-d'), kindId: documentKindId('froglight.markdown'), location: { resourceId: resourceId('res-d') } };
    const decoded = decodeMarkdown(new TextEncoder().encode(raw), ref);
    // Mutate model text slightly then encode? For raw model, we just keep raw.
    const second = encodeMarkdown(decoded.model, ref);
    expect(new TextDecoder().decode(second)).toBe(raw);
  });
});
