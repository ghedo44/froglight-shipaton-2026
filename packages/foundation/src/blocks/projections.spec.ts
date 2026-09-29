/**
 * Derived-projection fixtures for block pages: metadata, relationships,
 * and search projection. Engine-free.
 */

import { describe, expect, it } from 'vitest';
import {
  codeBlock,
  emptyBlockPage,
  headingBlock,
  listBlock,
  paragraphBlock,
  type BlockPageModel,
} from './model.js';
import { extractBlockPageMetadata } from './metadata.js';
import { extractBlockPageRelationships } from './relationships.js';
import { projectBlockPageForSearch } from './search.js';
import { documentId as newDocumentIdBranded } from '../identity.js';
import { documentId } from '../identity.js';

function sampleModel(): BlockPageModel {
  const model = emptyBlockPage({ title: 'Spec', tags: ['a', 'b'], properties: { mood: 'fine' } });
  model.rootOrder = ['h1', 'p1', 'c1'];
  model.blocks = {
    h1: headingBlock('h1', 1, [{ text: 'Intro' }]),
    p1: paragraphBlock('p1', [
      { text: 'see ' },
      { text: 'other', marks: [{ type: 'link', href: 'b.blockpage#tgt' }] },
      { text: ' and ' },
      { text: 'web', marks: [{ type: 'link', href: 'https://example.com' }] },
    ]),
    c1: codeBlock('c1', 'const x = 1;', 'ts'),
  };
  return model;
}

describe('block page metadata projection', () => {
  it('projects title/tags/properties from meta', () => {
    const metadata = extractBlockPageMetadata({ documentId: documentId('d1'), model: sampleModel() });
    expect(metadata).toEqual({ title: 'Spec', tags: ['a', 'b'], properties: { mood: 'fine' } });
  });

  it('omits absent fields instead of writing nulls', () => {
    const metadata = extractBlockPageMetadata({ documentId: documentId('d1'), model: emptyBlockPage() });
    expect(metadata).toEqual({});
  });
});

describe('block page relationship extraction', () => {
  it('emits internal link-mark edges with fragment addresses, skipping externals', () => {
    const source = { resourceId: 'res-1' as never };
    const edges = extractBlockPageRelationships({ source, model: sampleModel() });
    expect(edges).toHaveLength(1);
    expect(edges[0]?.type).toBe('blockpage.link');
    expect(edges[0]?.metadata?.href).toBe('b.blockpage#tgt');
    expect(edges[0]?.metadata?.fragment).toBe('tgt');
    expect(edges[0]?.source).toEqual({ ...source, address: 'p1' });
  });

  it('emits no edges for documents without link marks', () => {
    const edges = extractBlockPageRelationships({
      source: { resourceId: 'res-1' as never },
      model: emptyBlockPage(),
    });
    expect(edges).toEqual([]);
  });
});

describe('block page search projection', () => {
  it('concatenates body text in traversal order including lists and code', () => {
    const model = sampleModel();
    const list = listBlock('l1', false, [{ runs: [{ text: 'item one' }] }]);
    model.rootOrder.push('l1');
    model.blocks.l1 = list;
    const projection = projectBlockPageForSearch(model, 'doc-1');
    expect(projection.body).toContain('Intro');
    expect(projection.body).toContain('other');
    expect(projection.body).toContain('const x = 1;');
    expect(projection.body).toContain('item one');
    expect(projection.title).toBe('Spec');
    expect(projection.tags).toEqual(['a', 'b']);
  });

  it('produces anchors aligned with body offsets per block', () => {
    const model = sampleModel();
    const projection = projectBlockPageForSearch(model, newDocumentIdBranded('d9'));
    const introAnchor = projection.anchors.find((anchor) => anchor.address === 'h1');
    expect(introAnchor).toBeDefined();
    expect(projection.body.slice(introAnchor!.start, introAnchor!.end)).toBe('Intro');
    const codeAnchor = projection.anchors.find((anchor) => anchor.address === 'c1');
    expect(codeAnchor).toBeDefined();
    expect(projection.body.slice(codeAnchor!.start, codeAnchor!.end)).toBe('const x = 1;');
  });
});
