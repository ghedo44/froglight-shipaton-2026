/**
 * Notebook kind behavior: recognition,
 * metadata mapping, and paged search with page-addressed anchors. Engine-free.
 */

import { describe, expect, it } from 'vitest';
import { utf8Decode } from '../encoding.js';
import {
  boundedFrame,
  emptySurface,
  textObject,
} from '../surfaces/model.js';
import { encodeNotebook } from './codec.js';
import {
  NOTEBOOK_FORMAT_VERSION,
  emptyNotebook,
  notebookPage,
  type NotebookModel,
} from './model.js';
import { notebookKind, notebookKindId } from './kind.js';

function modelWithPages(build: (model: NotebookModel) => void): NotebookModel {
  const model = emptyNotebook();
  build(model);
  return model;
}

describe('notebook kind identity', () => {
  it('recognizes its kind id and the.notebook extension', () => {
    expect(notebookKindId).toBeDefined();
    expect(notebookKind.recognize?.(notebookKindId)).toBe(true);
    expect(notebookKind.recognize?.('notes/journal.notebook')).toBe(true);
    expect(notebookKind.recognize?.('notes/journal.md')).toBe(false);
    expect(notebookKind.recognize?.(42)).toBe(false);
  });

  it('carries the canonical format version', () => {
    expect(NOTEBOOK_FORMAT_VERSION).toBe(1);
  });
});

describe('decode projections', () => {
  it('maps meta into normalized metadata and leaves relationships empty', () => {
    const model = modelWithPages((m) => {
      m.meta.title = 'Linear Algebra';
      m.meta.tags = ['school', 'math'];
      m.meta.properties = { semester: 'S1' };
    });
    const decoded = notebookKind.decode(encodeNotebook(model), {
      documentId: 'doc-1' as never,
      kindId: notebookKindId,
      location: { resourceId: 'r-1' as never },
    });
    expect(decoded.metadata).toEqual({
      title: 'Linear Algebra',
      tags: ['school', 'math'],
      properties: { semester: 'S1' },
    });
    expect(decoded.relationships).toEqual([]);
    expect(utf8Decode(notebookKind.encode(decoded.model as never, null as never))).toBeTruthy();
  });

  it('projects page labels and text objects in page order with page-addressed anchors', () => {
    const surfaceA = emptySurface(boundedFrame(100, 100));
    surfaceA.objects['t1'] = textObject('t1', { x: 0, y: 0, text: 'eigenvalues' });
    surfaceA.order.push('t1');
    const model = modelWithPages((m) => {
      const a = notebookPage('a', {
        label: 'Lecture 1',
        template: 'froglight.lined',
        surface: surfaceA,
      });
      const b = notebookPage('b');
      b.record.label = 'Homework';
      b.surface.objects['t2'] = textObject('t2', { x: 0, y: 0, text: 'problem set' });
      b.surface.order.push('t2');
      m.pages['a'] = a;
      m.pages['b'] = b;
      m.pageOrder.push('a', 'b');
    });

    const body = notebookKind.searchText!(model);
    expect(body).toContain('Lecture 1');
    expect(body).toContain('eigenvalues');
    expect(body).toContain('Homework');
    expect(body).toContain('problem set');

    const anchors = notebookKind.searchAnchors!(model);
    const eigen = anchors.find((anchor) => body.slice(anchor.start, anchor.end) === 'eigenvalues');
    expect(eigen?.address).toBe('a');
    const homework = anchors.find((anchor) => body.slice(anchor.start, anchor.end) === 'Homework');
    expect(homework?.address).toBe('b');
  });

  it('excludes opaque pages from the projection without failing', () => {
    const model = modelWithPages((m) => {
      const good = notebookPage('good');
      good.surface.objects['t1'] = textObject('t1', { x: 0, y: 0, text: 'visible' });
      good.surface.order.push('t1');
      m.pages['good'] = good;
      m.pageOrder.push('good');
      // Simulate codec-produced opaque entry.
      m.pages['broken'] = {
        kind: 'opaque',
        id: 'broken',
        raw: { id: 'broken', surface: {} },
      };
      m.pageOrder.push('broken');
    });
    expect(notebookKind.searchText!(model)).toBe('visible');
    expect(notebookKind.searchAnchors!(model)).toHaveLength(1);
  });
});
