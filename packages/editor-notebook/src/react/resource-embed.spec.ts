// @vitest-environment jsdom
// Notebook page surface reference specs (react scope).
import { describe, expect, it } from 'vitest';
import {
  appendPage,
  boundedFrame,
  emptyNotebook,
  emptySurface,
  notebookPage,
  rectangleObject,
  type ResourceTarget,
} from '@froglight/foundation';
import {
  insertNotebookEmbed,
  isNotebookEmbedDangling,
  isNotebookEmbedRecord,
  removeNotebookEmbed,
  replaceNotebookEmbedTarget,
  resolveNotebookEmbedPresentation,
} from './resource-embed.js';

function target(resourceId = 'resA'): ResourceTarget {
  return {
    documentId: 'docA',
    kindId: 'froglight.markdown',
    resourceId,
  } as ResourceTarget;
}

function fixture() {
  const model = emptyNotebook('Embed fixture');
  appendPage(
    model,
    notebookPage('p1', { surface: emptySurface(boundedFrame(800, 600)) }),
  );
  return model;
}

describe('notebook page resource embeds', () => {
  it('inserts at the expected page-surface position', () => {
    const model = fixture();
    const id = insertNotebookEmbed(model, 'p1', target(), { x: 40, y: 60 });
    expect(id).not.toBeNull();
    const surface = (
      model.pages['p1'] as unknown as {
        surface: { objects: Record<string, never> };
      }
    ).surface as unknown as {
      objects: Record<string, Record<string, unknown>>;
      order: string[];
    };
    expect(surface.order).toContain(id);
    expect(surface.objects[id!]).toMatchObject({
      type: 'froglight.resource-embed',
      x: 40,
      y: 60,
      width: 480,
      height: 320,
    });
    expect(JSON.stringify(surface.objects[id!])).not.toContain('http');
    expect('presentation' in (surface.objects[id!] as object)).toBe(false);
    expect(
      isNotebookEmbedRecord(
        surface.objects[id!] as unknown as Parameters<typeof isNotebookEmbedRecord>[0],
      ),
    ).toBe(true);
  });

  it('returns null for missing or opaque pages without creating state', () => {
    const model = fixture();
    expect(insertNotebookEmbed(model, 'absent', target(), { x: 0, y: 0 })).toBeNull();
    expect(replaceNotebookEmbedTarget(model, 'absent', 'x', target())).toBe(false);
    expect(removeNotebookEmbed(model, 'absent', 'x')).toBe(false);
  });

  it('replaces the target while preserving the frame and clearing stale cache', () => {
    const model = fixture();
    const id = insertNotebookEmbed(model, 'p1', target('resA'), {
      x: 5,
      y: 6,
      width: 100,
      height: 90,
      cachedTitle: 'Stale',
    })!;
    expect(replaceNotebookEmbedTarget(model, 'p1', id, target('resB'))).toBe(true);
    const surface = (
      model.pages['p1'] as unknown as {
        surface: { objects: Record<string, { target: unknown }> };
      }
    ).surface;
    expect(surface.objects[id]!.target).toEqual(target('resB'));
    expect('cachedTitle' in (surface.objects[id] as object)).toBe(false);
  });

  it('replaces cached display only when fresh values are supplied', () => {
    const model = fixture();
    const id = insertNotebookEmbed(model, 'p1', target('resA'), {
      x: 0,
      y: 0,
      cachedTitle: 'Stale',
    })!;
    expect(
      replaceNotebookEmbedTarget(model, 'p1', id, target('resB'), {
        cachedTitle: 'Fresh',
      }),
    ).toBe(true);
    const surface = (
      model.pages['p1'] as unknown as {
        surface: { objects: Record<string, Record<string, unknown>> };
      }
    ).surface;
    expect(surface.objects[id]!.cachedTitle).toBe('Fresh');
  });

  it('removes only the reference and never cascades', () => {    const model = fixture();
    const keep = insertNotebookEmbed(model, 'p1', target('keep'), { x: 0, y: 0 })!;
    const drop = insertNotebookEmbed(model, 'p1', target('drop'), { x: 10, y: 10 })!;
    expect(removeNotebookEmbed(model, 'p1', drop)).toBe(true);
    const surface = (
      model.pages['p1'] as unknown as {
        surface: { objects: Record<string, unknown>; order: string[] };
      }
    ).surface;
    expect(surface.objects[drop]).toBeUndefined();
    expect(surface.order).not.toContain(drop);
    expect(surface.objects[keep]).toBeDefined();
  });

  it('refuses to remove unknown ids and wrong-type records', () => {
    const model = fixture();
    const keep = insertNotebookEmbed(model, 'p1', target('keep'), { x: 0, y: 0 })!;
    const surface = (
      model.pages['p1'] as unknown as {
        surface: { objects: Record<string, unknown>; order: string[] };
      }
    ).surface;
    surface.objects['rect-1'] = rectangleObject('rect-1', {
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    });
    surface.order.push('rect-1');
    expect(removeNotebookEmbed(model, 'p1', 'absent')).toBe(false);
    expect(removeNotebookEmbed(model, 'p1', 'rect-1')).toBe(false);
    expect(surface.objects['rect-1']).toBeDefined();
    expect(surface.order).toContain('rect-1');
    expect(surface.objects[keep]).toBeDefined();
    expect(surface.order).toContain(keep);
  });

  it('never auto-deletes dangling frames', () => {
    const model = fixture();
    const id = insertNotebookEmbed(model, 'p1', target(), { x: 0, y: 0 })!;
    expect(isNotebookEmbedDangling(model, 'p1', id, () => false)).toBe(true);
    expect(isNotebookEmbedDangling(model, 'p1', id, () => true)).toBe(false);
    const surface = (
      model.pages['p1'] as unknown as { surface: { objects: Record<string, unknown> } }
    ).surface;
    expect(surface.objects[id]).toBeDefined();
  });

  it('reads presentation tolerantly', () => {
    expect(
      resolveNotebookEmbedPresentation({
        id: 'x',
        type: 'froglight.resource-embed',
      } as never).mode,
    ).toBe('preview');
    expect(
      resolveNotebookEmbedPresentation({
        id: 'x',
        type: 'froglight.resource-embed',
        presentation: 'link',
      } as never).mode,
    ).toBe('link');
  });

  // parity matrix: keep identical across ui
  // `ResourceEmbedCard.spec.tsx`, whiteboard `resource-embed.spec.ts`, and
  // notebook (here). See ui `embed-presentation.ts` for why the owner-local
  // mirror exists instead of a shared foundation import.
  it.each([
    [{}, 'preview', false],
    [{ presentation: 'preview' }, 'preview', false],
    [{ presentation: 'link' }, 'link', false],
    [{ presentation: { mode: 'preview' } }, 'preview', false],
    [{ presentation: { mode: 'link' } }, 'link', false],
    [{ presentation: 'hologram' }, 'preview', true],
    [{ presentation: { mode: 'hologram' } }, 'preview', true],
    [{ presentation: 42 }, 'preview', true],
    [{ presentation: null }, 'preview', true],
    [{ presentation: ['preview'] }, 'preview', true],
  ] as Array<[Record<string, unknown>, string, boolean]>)(
    'parity %j -> %s (unknown=%s)',
    (extra, mode, unknown) => {
      const resolved = resolveNotebookEmbedPresentation({
        id: 'parity',
        type: 'froglight.resource-embed',
        ...extra,
      } as never);
      expect(resolved.mode).toBe(mode);
      expect(resolved.unknown).toBe(unknown);
      if (unknown) expect(resolved.raw).toEqual(extra.presentation);
    },
  );
});
