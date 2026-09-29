import { describe, expect, it } from 'vitest';
import {
  SurfaceDeltaCollector,
  applySurfaceDocumentDelta,
  mergeSurfaceDocumentDeltas,
  surfaceCheckpointUnits,
  restoreSurfaceCheckpoint,
} from './surface-persistence.js';
import {
  emptySurface,
  infiniteFrame,
  inkStrokeObject,
} from './surfaces/model.js';
import { publishSurfaceObjects } from './surfaces/transactions.js';
import { emptyNotebook, notebookPage, appendPage } from './notebooks/model.js';
import { cloneTemplateValue } from './documents.js';
import { encodeNotebook } from './notebooks/codec.js';

const stroke = (id: string) =>
  inkStrokeObject(id, { points: [{ x: 1, y: 2, pressure: 0.5 }], width: 2 });

describe('incremental Surface persistence', () => {
  it('captures one new record without reading samples or scanning old object ids', () => {
    const model = emptySurface(infiniteFrame());
    for (let i = 0; i < 20_000; i++) {
      const id = `old-${i}`;
      model.order.push(id);
      model.objects[id] = stroke(id);
    }
    const collector = new SurfaceDeltaCollector(model, false);
    Object.defineProperty(model.objects['old-0'], 'points', {
      get: () => {
        throw new Error('unchanged samples read');
      },
    });
    Object.defineProperty(model.order, Symbol.iterator, {
      value: () => {
        throw new Error('full order scanned');
      },
    });
    model.objects.new = stroke('new');
    model.order.push('new');
    publishSurfaceObjects(model, ['new']);
    const delta = collector.take();
    expect(Object.keys(delta.surfaces[0]!.objects)).toEqual(['new']);
    expect(delta.surfaces[0]!.order).toEqual([
      { index: 20_000, removed: [], inserted: ['new'] },
    ]);
    collector.dispose();
  });

  it('keeps unchanged pages by reference and preserves metadata, frames and unknown payloads', () => {
    const model = emptyNotebook('Notebook');
    for (const id of ['page', 'shell', 'a/b'])
      appendPage(model, notebookPage(id));
    model.unknownFields = { vendor: { keep: true } };
    const mirror = cloneTemplateValue(model);
    const untouched = mirror.pages.shell;
    const collector = new SurfaceDeltaCollector(model, true);
    collector.seed();
    const page = model.pages['a/b']!;
    if (page.kind !== 'page') throw new Error('fixture');
    page.record.label = 'Edited';
    page.surface.frame.width = 1000;
    page.surface.objects.new = stroke('new');
    page.surface.order.push('new');
    publishSurfaceObjects(page.surface, ['new']);
    const next = applySurfaceDocumentDelta(
      mirror,
      collector.take(),
      true,
    ) as typeof model;
    if (untouched?.kind !== 'page' || next.pages.shell?.kind !== 'page')
      throw new Error('fixture');
    expect(next.pages.shell.surface).toBe(untouched.surface);
    expect(encodeNotebook(next)).toEqual(encodeNotebook(model));
    const restored = restoreSurfaceCheckpoint(
      new Map(
        [...surfaceCheckpointUnits(next, true)].map(([key, value]) => [
          key,
          cloneTemplateValue(value),
        ]),
      ),
      true,
    );
    expect(encodeNotebook(restored as typeof model)).toEqual(
      encodeNotebook(model),
    );
    collector.dispose();
  });

  it('coalesces a queued prefix, record replacements, deletions and order edits losslessly', () => {
    const model = emptySurface(infiniteFrame());
    const mirror = cloneTemplateValue(model);
    const collector = new SurfaceDeltaCollector(model, false);
    model.objects.a = stroke('a');
    model.order.push('a');
    const first = collector.take();
    model.objects.b = stroke('b');
    model.order.push('b');
    model.objects.a!.width = 7;
    publishSurfaceObjects(model, ['a']);
    const second = collector.take();
    delete model.objects.b;
    model.order.splice(1, 1);
    const last = collector.take();
    const combined = mergeSurfaceDocumentDeltas(
      mergeSurfaceDocumentDeltas(first, second),
      last,
    );
    expect(applySurfaceDocumentDelta(mirror, combined, false)).toEqual(model);
    collector.dispose();
  });

  it('includes a newly added page once when coalescing before a slow journal accepts it', () => {
    const model = emptyNotebook('Notebook');
    const mirror = cloneTemplateValue(model);
    const collector = new SurfaceDeltaCollector(model, true);
    collector.seed();
    appendPage(model, notebookPage('new-page'));
    const first = collector.take();
    const page = model.pages['new-page']!;
    if (page.kind !== 'page') throw new Error('fixture');
    page.surface.objects.a = stroke('a');
    page.surface.order.push('a');
    const next = applySurfaceDocumentDelta(
      mirror,
      mergeSurfaceDocumentDeltas(first, collector.take()),
      true,
    );
    expect(encodeNotebook(next as typeof model)).toEqual(encodeNotebook(model));
    collector.dispose();
  });
});

it('replaces an existing page surface without replaying queued edits from its previous model', () => {
  const model = emptyNotebook('Notebook');
  appendPage(model, notebookPage('page'));
  const mirror = cloneTemplateValue(model);
  const collector = new SurfaceDeltaCollector(model, true);
  collector.seed();
  const old = model.pages.page!;
  if (old.kind !== 'page') throw new Error('fixture');
  old.surface.objects.old = stroke('old');
  old.surface.order.push('old');
  const first = collector.take();
  const replacement = notebookPage('page');
  replacement.surface.objects.replacement = stroke('replacement');
  replacement.surface.order.push('replacement');
  model.pages.page = replacement;
  const combined = mergeSurfaceDocumentDeltas(first, collector.take());
  const next = applySurfaceDocumentDelta(mirror, combined, true);
  expect(encodeNotebook(next as typeof model)).toEqual(encodeNotebook(model));
  collector.dispose();
});
