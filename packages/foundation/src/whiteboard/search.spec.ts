import { describe, expect, it } from 'vitest';
import { emptySurface, cardObject, resourceEmbedObject, textObject } from '../surfaces/model.js';
import { infiniteFrame } from '../surfaces/model.js';
import { projectWhiteboardForSearch } from './search.js';

describe('whiteboard search projection', () => {
  it('indexes text and card content plus embed cachedTitle, not flattened preview', () => {
    const model = emptySurface(infiniteFrame());
    model.objects.t1 = textObject('t1', { x: 0, y: 0, text: 'quicksort' });
    model.objects.c1 = cardObject('c1', { x: 10, y: 10, width: 200, height: 100, text: 'kanban ideas' });
    model.objects.e1 = resourceEmbedObject('e1', {
      x: 50,
      y: 50,
      width: 300,
      height: 200,
      target: { documentId: 'doc1', kindId: 'froglight.markdown', resourceId: 'res1' },
      cachedTitle: 'Referenced note title',
    });
    model.order.push('t1', 'c1', 'e1');

    const proj = projectWhiteboardForSearch(model);
    expect(proj.body).toContain('quicksort');
    expect(proj.body).toContain('kanban ideas');
    expect(proj.body).toContain('Referenced note title');
    // Should not contain rendered preview content (not stored)
    expect(proj.body).not.toContain('preview-internal-content');
    expect(proj.anchors.map((a) => a.address)).toEqual(['t1', 'c1', 'e1']);
  });

  it('ignores empty text', () => {
    const model = emptySurface(infiniteFrame());
    model.objects.t1 = textObject('t1', { x: 0, y: 0, text: '   ' });
    model.order.push('t1');
    const proj = projectWhiteboardForSearch(model);
    expect(proj.body).toBe('');
    expect(proj.anchors).toHaveLength(0);
  });
});
