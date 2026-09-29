// Whiteboard surface reference specs: insertion at
// the expected position, replace/remove semantics, dangling preservation,
// and presentation reads.
import { describe, expect, it } from 'vitest';
import {
  emptySurface,
  infiniteFrame,
  rectangleObject,
  type ResourceTarget,
} from '@froglight/foundation';
import {
  insertWhiteboardEmbed,
  isWhiteboardEmbedDangling,
  isWhiteboardEmbedRecord,
  removeWhiteboardEmbed,
  replaceWhiteboardEmbedTarget,
  resolveWhiteboardEmbedPresentation,
  WHITEBOARD_EMBED_DEFAULT_SIZE,
} from './resource-embed.js';

function target(resourceId = 'resA'): ResourceTarget {
  return {
    documentId: 'docA',
    kindId: 'froglight.markdown',
    resourceId,
  } as ResourceTarget;
}

describe('whiteboard resource embeds', () => {
  it('inserts at the expected surface position with the default frame', () => {
    const model = emptySurface(infiniteFrame());
    const id = insertWhiteboardEmbed(model, target(), { x: 120, y: 80 });
    expect(model.order).toContain(id);
    const record = model.objects[id]!;
    expect(record).toMatchObject({
      type: 'froglight.resource-embed',
      x: 120,
      y: 80,
      width: WHITEBOARD_EMBED_DEFAULT_SIZE.width,
      height: WHITEBOARD_EMBED_DEFAULT_SIZE.height,
    });
    expect(record.target).toEqual(target());
    // No browser URLs as identity; no presentation member (owns it).
    expect(JSON.stringify(record)).not.toContain('http');
    expect('presentation' in record).toBe(false);
    expect(isWhiteboardEmbedRecord(record)).toBe(true);
  });

  it('preserves explicit placement geometry and cached display', () => {
    const model = emptySurface(infiniteFrame());
    const id = insertWhiteboardEmbed(
      model,
      { ...target(), address: 'h1' } as ResourceTarget,
      { x: 10, y: 20, width: 200, height: 140, cachedTitle: 'Source' },
    );
    expect(model.objects[id]).toMatchObject({
      x: 10,
      y: 20,
      width: 200,
      height: 140,
      cachedTitle: 'Source',
    });
    expect((model.objects[id]!.target as { address?: string }).address).toBe('h1');
  });

  it('rejects invalid targets and geometry without mutating the model', () => {
    const model = emptySurface(infiniteFrame());
    const before = JSON.stringify(model);
    expect(() =>
      insertWhiteboardEmbed(model, { documentId: '' } as never, { x: 0, y: 0 }),
    ).toThrow(TypeError);
    expect(() =>
      insertWhiteboardEmbed(model, target(), { x: Number.NaN, y: 0 }),
    ).toThrow(TypeError);
    expect(JSON.stringify(model)).toBe(before);
  });

  it('replaces the target while preserving the frame and clearing stale cache', () => {
    const model = emptySurface(infiniteFrame());
    const id = insertWhiteboardEmbed(model, target('resA'), {
      x: 5,
      y: 6,
      width: 100,
      height: 90,
      cachedTitle: 'Keep me',
    });
    expect(replaceWhiteboardEmbedTarget(model, id, target('resB'))).toBe(true);
    const record = model.objects[id]!;
    expect(record.target).toEqual(target('resB'));
    expect(record).toMatchObject({ x: 5, y: 6, width: 100, height: 90 });
    // Stale display never survives a replace without fresh values.
    expect('cachedTitle' in record).toBe(false);
    expect(replaceWhiteboardEmbedTarget(model, 'missing', target())).toBe(false);
  });

  it('replaces cached display only when fresh values are supplied', () => {
    const model = emptySurface(infiniteFrame());
    const id = insertWhiteboardEmbed(model, target('resA'), {
      x: 0,
      y: 0,
      cachedTitle: 'Stale',
      cachedKind: 'stale-kind',
    });
    expect(
      replaceWhiteboardEmbedTarget(model, id, target('resB'), {
        cachedTitle: 'Fresh',
        cachedKind: 'fresh-kind',
      }),
    ).toBe(true);
    expect(model.objects[id]).toMatchObject({
      cachedTitle: 'Fresh',
      cachedKind: 'fresh-kind',
    });
  });

  it('removes only the reference record and never cascades', () => {
    const model = emptySurface(infiniteFrame());
    const keep = insertWhiteboardEmbed(model, target('keep'), { x: 0, y: 0 });
    const drop = insertWhiteboardEmbed(model, target('drop'), { x: 50, y: 50 });
    expect(removeWhiteboardEmbed(model, drop)).toBe(true);
    expect(model.objects[drop]).toBeUndefined();
    expect(model.order).not.toContain(drop);
    expect(model.objects[keep]).toBeDefined();
    expect(model.order).toContain(keep);
    expect(removeWhiteboardEmbed(model, 'absent')).toBe(false);
  });

  it('refuses to remove wrong-type records', () => {
    const model = emptySurface(infiniteFrame());
    const shape = rectangleObject('rect-1', { x: 0, y: 0, width: 10, height: 10 });
    model.objects['rect-1'] = shape;
    model.order.push('rect-1');
    expect(removeWhiteboardEmbed(model, 'rect-1')).toBe(false);
    expect(model.objects['rect-1']).toBeDefined();
    expect(model.order).toContain('rect-1');
  });

  it('never auto-deletes dangling frames; the host decides replace/remove', () => {
    const model = emptySurface(infiniteFrame());
    const id = insertWhiteboardEmbed(model, target(), { x: 0, y: 0 });
    expect(isWhiteboardEmbedDangling(model, id, () => false)).toBe(true);
    expect(isWhiteboardEmbedDangling(model, id, () => true)).toBe(false);
    // The record survives the dangling check verbatim.
    expect(model.objects[id]).toBeDefined();
    expect(isWhiteboardEmbedDangling(model, 'absent', () => false)).toBe(false);
  });

  it('reads presentation tolerantly (absent → preview, unknown → preview + verbatim)', () => {
    const model = emptySurface(infiniteFrame());
    const id = insertWhiteboardEmbed(model, target(), { x: 0, y: 0 });
    expect(resolveWhiteboardEmbedPresentation(model.objects[id]!).mode).toBe(
      'preview',
    );
    const unknown = resolveWhiteboardEmbedPresentation({
      id,
      type: 'froglight.resource-embed',
      presentation: { mode: 'hologram' },
    } as never);
    expect(unknown.mode).toBe('preview');
    expect(unknown.unknown).toBe(true);
  });

  // parity matrix: keep identical across ui
  // `ResourceEmbedCard.spec.tsx`, whiteboard (here), and notebook
  // `resource-embed.spec.ts`. See ui `embed-presentation.ts` for why the
  // owner-local mirror exists instead of a shared foundation import.
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
      const resolved = resolveWhiteboardEmbedPresentation({
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
