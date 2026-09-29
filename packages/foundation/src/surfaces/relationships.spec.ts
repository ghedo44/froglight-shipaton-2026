/**
 * Shared surface embed extractor: paint order + orphans, invalid-target
 * skip, dangling preservation, presentation codec tolerance.
 */

import { describe, expect, it } from 'vitest';
import { utf8Encode } from '../encoding.js';
import { resourceId } from '../identity.js';
import {
  emptySurface,
  infiniteFrame,
  resourceEmbedObject,
  textObject,
} from './model.js';
import { decodeSurfacePayload, encodeSurfacePayload } from './codec.js';
import { INK_EMBED_EDGE_TYPE } from './kind.js';
import {
  extractSurfaceEmbedRelationships,
  resolveResourceEmbedPresentation,
} from './relationships.js';

function source() {
  return { resourceId: resourceId('res-src') } as never;
}

function embedTarget(overrides: Record<string, unknown> = {}) {
  return {
    documentId: 'doc1',
    kindId: 'froglight.markdown',
    resourceId: 'res1',
    ...overrides,
  };
}

describe('extractSurfaceEmbedRelationships', () => {
  it('emits paint-order edges with nested DocumentRef + objectId metadata', () => {
    const model = emptySurface(infiniteFrame());
    model.objects.e1 = resourceEmbedObject('e1', {
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      target: embedTarget(),
    });
    model.objects.e2 = resourceEmbedObject('e2', {
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      target: embedTarget({ documentId: 'doc2', address: 'page1' }),
    });
    model.objects.t1 = textObject('t1', { x: 0, y: 0, text: 'hi' });
    model.order.push('e2', 't1', 'e1');

    const edges = extractSurfaceEmbedRelationships({
      source: source(),
      model,
      edgeType: 'whiteboard.embed',
    });
    expect(edges.map((e) => e.source.address)).toEqual(['e2', 'e1']);
    expect(edges[0]!.type).toBe('whiteboard.embed');
    expect(edges[0]!.target.documentId).toBe('doc2');
    expect(edges[0]!.target.location.address).toBe('page1');
    expect(edges[0]!.metadata).toEqual({ objectId: 'e2' });
    expect(edges[1]!.target.documentId).toBe('doc1');
    expect(edges[1]!.target.location).toEqual({ resourceId: 'res1' });
  });

  it('honours the caller edgeType (ink/notebook) with identical mapping', () => {
    const model = emptySurface(infiniteFrame());
    model.objects.e1 = resourceEmbedObject('e1', {
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      target: embedTarget(),
    });
    model.order.push('e1');
    for (const edgeType of [INK_EMBED_EDGE_TYPE, 'notebook.embed'] as const) {
      const edges = extractSurfaceEmbedRelationships({
        source: source(),
        model,
        edgeType,
      });
      expect(edges).toHaveLength(1);
      expect(edges[0]!.type).toBe(edgeType);
      expect(edges[0]!.metadata).toEqual({ objectId: 'e1' });
    }
    expect(INK_EMBED_EDGE_TYPE).toBe('ink.embed');
  });

  it('appends out-of-order orphans after paint order', () => {
    const model = emptySurface(infiniteFrame());
    model.objects.e1 = resourceEmbedObject('e1', {
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      target: embedTarget(),
    });
    model.objects.orphan = resourceEmbedObject('orphan', {
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      target: embedTarget({ documentId: 'doc-orphan' }),
    });
    model.order.push('e1');
    const edges = extractSurfaceEmbedRelationships({
      source: source(),
      model,
      edgeType: 'whiteboard.embed',
    });
    expect(edges.map((e) => e.source.address)).toEqual(['e1', 'orphan']);
  });

  it('skips invalid targets and non-embed types, preserves dangling', () => {
    const model = emptySurface(infiniteFrame());
    model.objects.good = resourceEmbedObject('good', {
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      target: embedTarget({ documentId: 'ghost-doc', resourceId: 'ghost-res' }),
    });
    model.objects.bad = {
      id: 'bad',
      type: 'froglight.resource-embed',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      target: { documentId: '', kindId: '', resourceId: '' },
    };
    model.objects.t1 = textObject('t1', { x: 0, y: 0, text: 'x' });
    model.order.push('good', 'bad', 't1');
    const edges = extractSurfaceEmbedRelationships({
      source: source(),
      model,
      edgeType: 'whiteboard.embed',
    });
    // Dangling (nonexistent doc) still emits — no cascade. Invalid skipped.
    expect(edges.map((e) => e.source.address)).toEqual(['good']);
    expect(edges[0]!.target.documentId).toBe('ghost-doc');
  });

  it('treats edgeType as opaque: stamps any non-empty caller string verbatim', () => {
    const model = emptySurface(infiniteFrame());
    model.objects.e1 = resourceEmbedObject('e1', {
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      target: embedTarget(),
    });
    model.order.push('e1');
    // The helper owns ordering/filter/mapping only; the literal belongs to
    // the calling kind. No registry lookup happens here.
    const edges = extractSurfaceEmbedRelationships({
      source: source(),
      model,
      edgeType: 'custom.kind/embed',
    });
    expect(edges).toHaveLength(1);
    expect(edges[0]!.type).toBe('custom.kind/embed');
  });

  it('rejects an empty edgeType instead of emitting mistyped edges', () => {
    const model = emptySurface(infiniteFrame());
    model.objects.e1 = resourceEmbedObject('e1', {
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      target: embedTarget(),
    });
    model.order.push('e1');
    expect(() =>
      extractSurfaceEmbedRelationships({
        source: source(),
        model,
        edgeType: '',
      }),
    ).toThrow(TypeError);
  });

  it('tolerates presentation members: edges identical, codec byte-stable', () => {
    const model = emptySurface(infiniteFrame());
    model.objects.e1 = {
      ...resourceEmbedObject('e1', {
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        target: embedTarget(),
      }),
      presentation: 'link',
    };
    model.objects.e2 = {
      ...resourceEmbedObject('e2', {
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        target: embedTarget({ documentId: 'doc2' }),
      }),
      presentation: { mode: 'preview', future: [1] },
    };
    model.objects.e3 = {
      ...resourceEmbedObject('e3', {
        x: 0,
        y: 0,
        width: 10,
        height: 10,
        target: embedTarget({ documentId: 'doc3' }),
      }),
      presentation: 'future-spicy' as unknown as string,
    };
    model.order.push('e1', 'e2', 'e3');

    const edges = extractSurfaceEmbedRelationships({
      source: source(),
      model,
      edgeType: 'whiteboard.embed',
    });
    expect(edges).toHaveLength(3);

    const bytes = encodeSurfacePayload(model);
    const decoded = decodeSurfacePayload(bytes);
    // Presentation rides as verbatim unknown fields: no opaque degradation.
    expect(
      decoded.warnings.filter((w) => w.code === 'INVALID_CORE_OBJECT_OPAQUE'),
    ).toEqual([]);
    expect(decoded.model.objects.e1).toEqual(model.objects.e1);
    expect(decoded.model.objects.e2).toEqual(model.objects.e2);
    expect(decoded.model.objects.e3).toEqual(model.objects.e3);
  });
});

describe('resolveResourceEmbedPresentation', () => {
  it('defaults absent to preview', () => {
    const record = resourceEmbedObject('e', {
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      target: embedTarget(),
    });
    expect(resolveResourceEmbedPresentation(record)).toEqual({
      mode: 'preview',
      raw: undefined,
      unknown: false,
    });
  });

  it('resolves known link/preview in string and {mode} shapes', () => {
    const base = {
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      target: embedTarget(),
    } as const;
    expect(
      resolveResourceEmbedPresentation({
        ...resourceEmbedObject('a', base),
        presentation: 'link',
      } as never).mode,
    ).toBe('link');
    expect(
      resolveResourceEmbedPresentation({
        ...resourceEmbedObject('b', base),
        presentation: 'preview',
      } as never).mode,
    ).toBe('preview');
    expect(
      resolveResourceEmbedPresentation({
        ...resourceEmbedObject('c', base),
        presentation: { mode: 'link' },
      } as never),
    ).toEqual({ mode: 'link', raw: { mode: 'link' }, unknown: false });
    expect(
      resolveResourceEmbedPresentation({
        ...resourceEmbedObject('d', base),
        presentation: { mode: 'preview' },
      } as never).mode,
    ).toBe('preview');
  });

  it('degrades unknown to preview + verbatim raw', () => {
    const base = {
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      target: embedTarget(),
    } as const;
    const weird = { mode: 'hologram', opacity: 0.5 };
    const resolved = resolveResourceEmbedPresentation({
      ...resourceEmbedObject('u', base),
      presentation: weird,
    } as never);
    expect(resolved.mode).toBe('preview');
    expect(resolved.unknown).toBe(true);
    expect(resolved.raw).toEqual(weird);
  });

  it('round-trips unknown presentation bytes through the surface codec', () => {
    const raw = {
      formatVersion: 1,
      frame: { kind: 'infinite' },
      order: ['e1'],
      objects: {
        e1: {
          id: 'e1',
          type: 'froglight.resource-embed',
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          target: embedTarget(),
          presentation: { mode: 'hologram', future: true },
        },
      },
    };
    const decoded = decodeSurfacePayload(utf8Encode(JSON.stringify(raw)));
    expect(decoded.model.objects.e1).toEqual(raw.objects.e1);
    expect(resolveResourceEmbedPresentation(decoded.model.objects.e1!).unknown).toBe(
      true,
    );
  });
});
