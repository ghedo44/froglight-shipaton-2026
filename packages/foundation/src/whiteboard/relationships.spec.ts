import { describe, expect, it } from 'vitest';
import { emptySurface, cardObject, resourceEmbedObject, textObject } from '../surfaces/model.js';
import { infiniteFrame } from '../surfaces/model.js';
import { extractWhiteboardRelationships } from './relationships.js';
import { resourceId } from '../identity.js';

describe('whiteboard relationships', () => {
  it('emits one typed embed edge per resource-embed', () => {
    const model = emptySurface(infiniteFrame());
    model.objects.c1 = cardObject('c1', { x: 0, y: 0, width: 100, height: 100, text: 'hi' });
    model.objects.e1 = resourceEmbedObject('e1', {
      x: 10,
      y: 10,
      width: 200,
      height: 150,
      target: { documentId: 'doc1', kindId: 'froglight.markdown', resourceId: 'res1' },
    });
    model.objects.e2 = resourceEmbedObject('e2', {
      x: 20,
      y: 20,
      width: 200,
      height: 150,
      target: { documentId: 'doc2', kindId: 'froglight.notebook', resourceId: 'res2', address: 'page1' },
    });
    model.order.push('c1', 'e1', 'e2');

    const source = { resourceId: resourceId('res-whiteboard') };
    const edges = extractWhiteboardRelationships({ source: source as never, model });
    expect(edges).toHaveLength(2);
    expect(edges[0]!.type).toBe('whiteboard.embed');
    expect(edges[0]!.source.address).toBe('e1');
    expect(edges[0]!.target.documentId).toBe('doc1');
    expect(edges[1]!.target.location.address).toBe('page1');
  });

  it('includes out-of-order embeds for preservation case', () => {
    const model = emptySurface(infiniteFrame());
    model.objects.e1 = resourceEmbedObject('e1', {
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      target: { documentId: 'd', kindId: 'k', resourceId: 'r' },
    });
    // e1 not in order -> still emits edge
    const edges = extractWhiteboardRelationships({ source: { resourceId: resourceId('x') } as never, model });
    expect(edges).toHaveLength(1);
  });

  it('ignores non-embed types', () => {
    const model = emptySurface(infiniteFrame());
    model.objects.t1 = textObject('t1', { x: 0, y: 0, text: 'hello' });
    model.order.push('t1');
    const edges = extractWhiteboardRelationships({ source: { resourceId: resourceId('x') } as never, model });
    expect(edges).toHaveLength(0);
  });
});
