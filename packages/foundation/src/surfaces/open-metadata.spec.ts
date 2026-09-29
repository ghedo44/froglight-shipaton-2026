/**
 * Decode-time bounds plumbing (cold-open repair).
 *
 * The codec already derives Ink envelopes while parsing. This suite proves
 * those seeds survive the NORMAL production opening path — kind decode →
 * session openMetadata → spatial-index seed — instead of being discarded
 * and rescanned:
 *
 * ```text
 * decodeSurfacePayload() → model + seedBounds
 *   → kind.decode() → openMetadata (never canonical metadata)
 *   → session.open()/reload() → session.openMetadata
 *   → provider mount → seedIndexesFromDecode()
 * ```
 *
 * Seeds are disposable: absent/invalid entries fall back to normal
 * derivation without poisoning indexes.
 */

import { describe, expect, it } from 'vitest';
import { InMemoryDocumentRegistry } from '../documents.js';
import { DOCUMENT_CONTENT_REVISION_KEY } from '../documents.js';
import type { DocumentRef } from '../documents.js';
import { DocumentSessionImpl } from '../session.js';
import { checksumOf } from '../revisions.js';
import { createMemoryVault } from '../vault/memory.js';
import { workspacePath } from '../paths.js';
import { generateDocumentId, generateResourceId } from '../identity.js';
import {
  SURFACE_CANONICAL_CHECKSUM_KEY,
  SURFACE_SEED_BOUNDS_KEY,
  SURFACE_SEED_BOUNDS_BY_PAGE_KEY,
  contentRevisionFromOpenMetadata,
  isValidSeedBounds,
  seedBoundsFromOpenMetadata,
  pageSeedBoundsFromOpenMetadata,
} from './open-metadata.js';
import { decodeSurfacePayload, encodeSurfacePayload } from './codec.js';
import { inkPageKind, inkPageKindId } from './kind.js';
import { whiteboardKind, whiteboardKindId } from '../whiteboard/kind.js';
import { notebookKind, notebookKindId } from '../notebooks/kind.js';
import { encodeNotebook } from '../notebooks/codec.js';
import { emptyNotebook, notebookPage } from '../notebooks/model.js';
import type { NotebookModel } from '../notebooks/model.js';
import {
  boundedFrame,
  emptySurface,
  infiniteFrame,
  inkStrokeObject,
  type SurfaceModel,
} from './model.js';
import { createDefaultSurfaceObjectTypeRegistry } from './objects.js';
import { SurfaceInteractionController } from './controller.js';
import type { Bounds } from './geometry.js';

function strokePoints(baseX: number, baseY: number, count: number) {
  const out: { x: number; y: number; pressure: number; dt: number }[] = [];
  for (let i = 0; i < count; i++) {
    out.push({
      x: baseX + i * 2,
      y: baseY + Math.sin(i / 4) * 6,
      pressure: 0.5,
      dt: i * 8,
    });
  }
  return out;
}

function denseModel(strokes = 20, samples = 50): SurfaceModel {
  const model = emptySurface(boundedFrame(8000, 6000));
  for (let i = 0; i < strokes; i++) {
    const id = `s${i}`;
    model.objects[id] = inkStrokeObject(id, {
      points: strokePoints((i % 10) * 120, Math.floor(i / 10) * 120, samples),
      width: 3,
    });
    model.order.push(id);
  }
  return model;
}

function docRef(kindId: never): DocumentRef {
  return {
    documentId: generateDocumentId(),
    kindId,
    location: { resourceId: generateResourceId() },
  };
}

describe('decode-time seeds survive kind decode', () => {
  it('inkPageKind.decode preserves seedBounds in openMetadata, never in canonical metadata', () => {
    const model = denseModel();
    const bytes = encodeSurfacePayload(model);
    const decoded = inkPageKind.decode(bytes, docRef(inkPageKindId as never));
    const seeds = seedBoundsFromOpenMetadata(decoded.openMetadata);
    expect(seeds).not.toBeNull();
    expect(seeds!.size).toBe(20);
    expect(isValidSeedBounds(seeds)).toBe(true);
    // Canonical metadata stays seed-free (never projected, never saved).
    expect(decoded.metadata).toEqual({});
    expect(JSON.stringify(decoded.metadata)).not.toContain('seedBounds');
    // Seeds never persist: re-encoding the model is byte-stable.
    expect(encodeSurfacePayload(decoded.model as SurfaceModel)).toEqual(bytes);
  });

  it('whiteboardKind.decode preserves seedBounds in openMetadata', () => {
    const model = emptySurface(infiniteFrame());
    for (let i = 0; i < 5; i++) {
      const id = `w${i}`;
      model.objects[id] = inkStrokeObject(id, {
        points: strokePoints(i * 100, 50, 30),
        width: 4,
      });
      model.order.push(id);
    }
    const decoded = whiteboardKind.decode(
      encodeSurfacePayload(model),
      docRef(whiteboardKindId as never),
    );
    const seeds = seedBoundsFromOpenMetadata(decoded.openMetadata);
    expect(seeds).not.toBeNull();
    expect(seeds!.size).toBe(5);
  });

  it('notebookKind.decode preserves per-page seeds; opaque pages have no entry', () => {
    const pageSurface = (baseX: number): SurfaceModel => {
      const surface = emptySurface(boundedFrame(800, 600));
      surface.objects.p1 = inkStrokeObject('p1', {
        points: strokePoints(baseX, 100, 25),
        width: 3,
      });
      surface.order.push('p1');
      return surface;
    };
    const notebook: NotebookModel = emptyNotebook('seeds');
    notebook.pageOrder.push('page-1', 'page-2', 'page-3');
    notebook.pages['page-1'] = notebookPage('page-1', {
      surface: pageSurface(10),
    });
    notebook.pages['page-2'] = notebookPage('page-2', {
      surface: pageSurface(300),
    });
    // Opaque pages preserve verbatim and seed nothing.
    notebook.pages['page-3'] = {
      kind: 'opaque',
      id: 'page-3',
      raw: { id: 'page-3' },
    };
    const decoded = notebookKind.decode(
      encodeNotebook(notebook),
      docRef(notebookKindId as never),
    );
    const open = decoded.openMetadata ?? {};
    expect(open[SURFACE_SEED_BOUNDS_BY_PAGE_KEY] instanceof Map).toBe(true);
    const page1 = pageSeedBoundsFromOpenMetadata(open, 'page-1');
    const page2 = pageSeedBoundsFromOpenMetadata(open, 'page-2');
    const page3 = pageSeedBoundsFromOpenMetadata(open, 'page-3');
    expect(page1).not.toBeNull();
    expect(page1!.size).toBe(1);
    expect(page2).not.toBeNull();
    expect(page2!.size).toBe(1);
    expect(page3).toBeNull();
    // Whole-document seeds are meaningless for notebooks (per-page only).
    expect(seedBoundsFromOpenMetadata(open)).toBeNull();
  });
});

describe('sessions expose disposable open metadata', () => {
  function sessionFixture() {
    const { vault } = createMemoryVault();
    const registry = new InMemoryDocumentRegistry();
    registry.register(inkPageKind);
    return { vault, registry };
  }

  it('open surfaces decode seeds; reload refreshes them', async () => {
    const { vault, registry } = sessionFixture();
    const path = workspacePath('seeded.ink');
    await vault.write(path, encodeSurfacePayload(denseModel(4, 20)));
    const ref = docRef(inkPageKindId as never);
    const resolveResourcePath = () => path;
    const kind = registry.get(inkPageKindId);
    const session = new DocumentSessionImpl({
      ref,
      kind,
      vault,
      revisions: null,
      resolveResourcePath,
    });
    await session.open();
    const seeds = seedBoundsFromOpenMetadata(session.openMetadata);
    expect(seeds).not.toBeNull();
    expect(seeds!.size).toBe(4);

    // Reload after an external rewrite refreshes (never accumulates).
    await vault.write(path, encodeSurfacePayload(denseModel(7, 10)));
    await session.reload();
    expect(seedBoundsFromOpenMetadata(session.openMetadata)!.size).toBe(7);
    await session.close();
  });

  it('kinds without seeds expose an empty map-shaped default', async () => {
    const { vault, registry } = sessionFixture();
    registry.register({
      id: 'test.plain' as never,
      decode: (data: Uint8Array) => ({
        model: new TextDecoder().decode(data),
        metadata: {},
        relationships: [],
      }),
      encode: (model: unknown) => new TextEncoder().encode(String(model)),
    });
    const path = workspacePath('plain.txt');
    await vault.write(path, new TextEncoder().encode('hello'));
    const session = new DocumentSessionImpl({
      ref: docRef('test.plain' as never),
      kind: registry.get('test.plain' as never),
      vault,
      revisions: null,
      resolveResourcePath: () => path,
    });
    await session.open();
    // The session owns the canonical content revision (derived session
    // identity) even for kinds without seeds — computed once from the
    // opened bytes, never by the kind.
    expect(session.openMetadata).toEqual({
      [DOCUMENT_CONTENT_REVISION_KEY]: checksumOf(
        new TextEncoder().encode('hello'),
      ),
    });
    expect(session.contentRevision).toBe(
      checksumOf(new TextEncoder().encode('hello')),
    );
    expect(seedBoundsFromOpenMetadata(session.openMetadata)).toBeNull();
    await session.close();
  });

  describe('content revision ownership (session layer)', () => {
    it('open/reload refresh the session-owned revision; decoders write none', async () => {
      const { vault, registry } = sessionFixture();
      const path = workspacePath('rev.ink');
      const first = encodeSurfacePayload(denseModel(2, 10));
      await vault.write(path, first);
      const ref = docRef(inkPageKindId as never);
      const kind = registry.get(inkPageKindId);
      const session = new DocumentSessionImpl({
        ref,
        kind,
        vault,
        revisions: null,
        resolveResourcePath: () => path,
      });
      // Decoders perform no whole-file checksum pass of their own.
      const decoded = kind.decode(first, ref);
      expect(
        decoded.openMetadata?.[DOCUMENT_CONTENT_REVISION_KEY],
      ).toBeUndefined();
      // The session computes the revision once from the opened bytes.
      await session.open();
      expect(session.contentRevision).toBe(checksumOf(first));
      expect(session.openMetadata[DOCUMENT_CONTENT_REVISION_KEY]).toBe(
        checksumOf(first),
      );
      expect(contentRevisionFromOpenMetadata(session.openMetadata)).toBe(
        checksumOf(first),
      );
      // Reload after an external rewrite refreshes the token.
      const second = encodeSurfacePayload(denseModel(3, 10));
      await vault.write(path, second);
      await session.reload();
      expect(session.contentRevision).toBe(checksumOf(second));
      expect(session.contentRevision).not.toBe(checksumOf(first));
      await session.close();
    });

    it('prefers the session token and falls back to the legacy kind checksum', () => {
      const revision = 'session-rev';
      expect(
        contentRevisionFromOpenMetadata({
          [DOCUMENT_CONTENT_REVISION_KEY]: revision,
          [SURFACE_CANONICAL_CHECKSUM_KEY]: 'legacy-rev',
        }),
      ).toBe(revision);
      expect(
        contentRevisionFromOpenMetadata({
          [SURFACE_CANONICAL_CHECKSUM_KEY]: 'legacy-rev',
        }),
      ).toBe('legacy-rev');
      expect(contentRevisionFromOpenMetadata({})).toBeNull();
      expect(contentRevisionFromOpenMetadata(null)).toBeNull();
    });
  });
});

describe('seed validation', () => {
  const good: Bounds = { x: 1, y: 2, width: 3, height: 4 };

  it('accepts well-formed maps including null (boundless) entries', () => {
    expect(
      isValidSeedBounds(
        new Map<string, Bounds | null>([
          ['a', good],
          ['b', null],
        ]),
      ),
    ).toBe(true);
    expect(isValidSeedBounds(new Map())).toBe(true);
  });

  it('rejects non-maps, bad keys, and malformed bounds', () => {
    expect(isValidSeedBounds(undefined)).toBe(false);
    expect(isValidSeedBounds(null)).toBe(false);
    expect(isValidSeedBounds({})).toBe(false);
    expect(isValidSeedBounds(new Map([['', good]] as never))).toBe(false);
    expect(
      isValidSeedBounds(new Map([['a', { x: 1 }] as never])) as boolean,
    ).toBe(false);
    expect(
      isValidSeedBounds(
        new Map([['a', { ...good, width: Number.NaN }]]) as never,
      ) as boolean,
    ).toBe(false);
    expect(
      isValidSeedBounds(
        new Map([['a', { ...good, height: -2 }]]) as never,
      ) as boolean,
    ).toBe(false);
    expect(seedBoundsFromOpenMetadata(undefined)).toBeNull();
    expect(seedBoundsFromOpenMetadata({})).toBeNull();
    expect(
      seedBoundsFromOpenMetadata({ [SURFACE_SEED_BOUNDS_KEY]: {} }),
    ).toBeNull();
    expect(pageSeedBoundsFromOpenMetadata({}, 'page-1')).toBeNull();
    expect(
      pageSeedBoundsFromOpenMetadata(
        { [SURFACE_SEED_BOUNDS_BY_PAGE_KEY]: new Map() },
        'missing',
      ),
    ).toBeNull();
  });
});

describe('seeded production open performs no second sample scan', () => {
  it('session model + kind seeds open with zero bounds computations', () => {
    const model = denseModel(30, 60);
    const bytes = encodeSurfacePayload(model);
    // The normal opening path: codec seeds flow through kind.decode.
    const kindDecoded = inkPageKind.decode(
      bytes,
      docRef(inkPageKindId as never),
    );
    expect(seedBoundsFromOpenMetadata(kindDecoded.openMetadata)).not.toBeNull();

    // Mount-equivalent consumption: seed the controller from kind seeds.
    const registry = createDefaultSurfaceObjectTypeRegistry();
    const controller = new SurfaceInteractionController({
      model: kindDecoded.model as SurfaceModel,
      registry,
    });
    controller.seedIndexesFromDecode(
      seedBoundsFromOpenMetadata(kindDecoded.openMetadata)!,
    );
    const stats = controller.controllerStats();
    expect(stats.seedBoundsSeeded).toBe(30);
    expect(stats.boundsComputations).toBe(0);
    // Queries hit seeded entries (no scans, no NaN).
    const found = controller.queryRegion({
      x: 0,
      y: 0,
      width: 500,
      height: 500,
    });
    expect(found.length).toBeGreaterThan(0);
    for (const id of found) {
      const bounds = controller.cachedBoundsFor(id);
      expect(bounds).not.toBeNull();
      expect(Number.isFinite(bounds!.x + bounds!.width)).toBe(true);
    }
    controller.destroy();
  });

  it('malformed seed entries fall back per id without poisoning the index', () => {
    const model = denseModel(4, 20);
    const registry = createDefaultSurfaceObjectTypeRegistry();
    const controller = new SurfaceInteractionController({ model, registry });
    const good = new Map<string, Bounds | null>();
    const decoded = decodeSurfacePayload(encodeSurfacePayload(model));
    for (const [id, bounds] of decoded.seedBounds) good.set(id, bounds);
    // Corrupt two entries: one non-finite, one negative size.
    good.set('s0', { x: NaN, y: 0, width: 10, height: 10 });
    good.set('s1', { x: 0, y: 0, width: -5, height: 10 });
    controller.seedIndexesFromDecode(good);
    const stats = controller.controllerStats();
    // Two fallbacks recomputed; two valid seeds consumed.
    expect(stats.seedBoundsSeeded).toBe(2);
    expect(stats.boundsComputations).toBe(2);
    // Every id still resolves to finite bounds (no NaN in the index).
    for (const id of model.order) {
      const bounds = controller.cachedBoundsFor(id);
      expect(bounds).not.toBeNull();
      expect(
        [bounds!.x, bounds!.y, bounds!.width, bounds!.height].every(
          Number.isFinite,
        ),
      ).toBe(true);
      expect(bounds!.width).toBeGreaterThanOrEqual(0);
      expect(bounds!.height).toBeGreaterThanOrEqual(0);
    }
    // Region queries still find all four strokes (a query box larger
    // than the overflow threshold only sees overflow entries by design,
    // so keep the box tight: 6 cells, precise per-entry filtering).
    expect(
      controller.queryRegion({ x: -100, y: -100, width: 1200, height: 500 })
        .length,
    ).toBe(4);
    controller.destroy();
  });
});
