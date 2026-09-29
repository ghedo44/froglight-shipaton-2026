// @vitest-environment jsdom
/**
 * Decode-seed consumption at the mount layer (cold-open repair).
 *
 * Proves `mountInkSurface({ seedBounds })` — the last hop after kind
 * decode → session openMetadata — seeds the spatial/derived indexes
 * without rescanning Ink samples, and that absent/invalid seeds keep the
 * lazy derivation path intact.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  boundedFrame,
  checksumFromOpenMetadata,
  contentRevisionFromOpenMetadata,
  checksumOf,
  DerivedReopenStore,
  DOCUMENT_CONTENT_REVISION_KEY,
  emptySurface,
  encodeSurfacePayload,
  inkStrokeObject,
  seedBoundsFromOpenMetadata,
  inkPageKind,
  type Bounds,
  type SurfaceModel,
} from '@froglight/foundation';
import { installCanvasStub } from '@froglight/foundation/testing';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import {
  InkSurfaceSkeleton,
  type InkSkeleton,
} from '../react/InkSurfaceSkeleton.jsx';
import {
  InkDocumentEditorProvider,
  mountInkSurface,
  seedBoundsFromSession,
  type InkSurfaceHandle,
} from '../index.js';

function strokeModel(count: number): SurfaceModel {
  const model = emptySurface(boundedFrame(2000, 2000));
  for (let i = 0; i < count; i++) {
    const id = `s${i}`;
    const points: { x: number; y: number; pressure: number }[] = [];
    for (let k = 0; k < 20; k++) {
      points.push({
        x: (i % 8) * 120 + k * 2,
        y: Math.floor(i / 8) * 120,
        pressure: 0.5,
      });
    }
    model.objects[id] = inkStrokeObject(id, { points, width: 3 });
    model.order.push(id);
  }
  return model;
}

/** Seeds through the real production path: bytes → kind.decode → metadata. */
function productionSeeds(model: SurfaceModel) {
  const bytes = encodeSurfacePayload(model);
  const decoded = inkPageKind.decode(bytes, {
    documentId: 'doc-seed' as never,
    kindId: 'froglight.ink' as never,
    location: { resourceId: 'res-seed' as never },
  });
  return {
    model: decoded.model as SurfaceModel,
    seeds: seedBoundsFromOpenMetadata(decoded.openMetadata),
  };
}

function mountSurface(
  model: SurfaceModel,
  seedBounds?: ReadonlyMap<string, Bounds | null>,
): {
  parent: HTMLElement;
  handle: InkSurfaceHandle;
  root: ReturnType<typeof createRoot>;
} {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const skeletonRef: { current: InkSkeleton | null } = { current: null };
  const root = createRoot(parent);
  flushSync(() => {
    root.render(
      createElement(InkSurfaceSkeleton, {
        presentation: 'paint-stage',
        navigationMode: 'standalone',
        skeletonRef,
      }),
    );
  });
  const skeleton = skeletonRef.current;
  if (skeleton === null) throw new Error('test skeleton failed to commit');
  const handle = mountInkSurface({
    model,
    markDirty: () => undefined,
    host: skeleton,
    ...(seedBounds !== undefined ? { seedBounds } : {}),
  });
  return { parent, handle, root };
}

describe('mountInkSurface seedBounds', () => {
  let restoreCanvas: (() => void) | null = null;

  beforeEach(() => {
    restoreCanvas = installCanvasStub();
  });

  afterEach(() => {
    restoreCanvas?.();
    restoreCanvas = null;
    document.body.replaceChildren();
  });

  it('seeds spatial/derived indexes from production decode seeds', () => {
    const { model, seeds } = productionSeeds(strokeModel(12));
    expect(seeds).not.toBeNull();
    const { handle, root } = mountSurface(model, seeds!);
    try {
      const diagnostics = handle.diagnostics();
      expect(diagnostics.controller.seedBoundsSeeded).toBe(12);
      expect(diagnostics.controller.boundsComputations).toBe(0);
      expect(diagnostics.spatial.entries).toBe(12);
    } finally {
      root.unmount();
      handle.destroy();
    }
  });

  it('mounts lazily without seeds (no eager full-document scan)', () => {
    const { model } = productionSeeds(strokeModel(12));
    const { handle, root } = mountSurface(model);
    try {
      const diagnostics = handle.diagnostics();
      expect(diagnostics.controller.seedBoundsSeeded).toBe(0);
      // Lazy: nothing indexed until the first query/drag/hit-test.
      expect(diagnostics.spatial.entries).toBe(0);
    } finally {
      root.unmount();
      handle.destroy();
    }
  });

  it('ignores structurally invalid seeds and mounts normally', () => {
    const { model } = productionSeeds(strokeModel(4));
    const { handle, root } = mountSurface(model, {
      not: 'a map',
    } as unknown as ReadonlyMap<string, Bounds | null>);
    try {
      const diagnostics = handle.diagnostics();
      expect(diagnostics.controller.seedBoundsSeeded).toBe(0);
      expect(diagnostics.spatial.entries).toBe(0);
    } finally {
      root.unmount();
      handle.destroy();
    }
  });

  it('seedBoundsFromSession resolves the exact mount glue providers use', () => {
    const { seeds } = productionSeeds(strokeModel(3));
    expect(seeds).not.toBeNull();
    // Session carrying production openMetadata resolves to the seed map.
    expect(
      seedBoundsFromSession({ openMetadata: { 'surface.seedBounds': seeds! } }),
    ).toBe(seeds);
    // Absent or malformed metadata resolves to null (lazy mount path).
    expect(seedBoundsFromSession({})).toBeNull();
    expect(seedBoundsFromSession({ openMetadata: {} })).toBeNull();
    expect(
      seedBoundsFromSession({ openMetadata: { 'surface.seedBounds': {} } }),
    ).toBeNull();
  });

  it('provider consults the derived reopen cache on mount', () => {
    const acquire = vi.spyOn(DerivedReopenStore.prototype, 'acquire');
    try {
      const { model } = productionSeeds(strokeModel(4));
      const bytes = encodeSurfacePayload(model);
      const decoded = inkPageKind.decode(bytes, {
        documentId: 'doc-cache' as never,
        kindId: 'froglight.ink' as never,
        location: { resourceId: 'res-cache' as never },
      });
      const openMetadata = decoded.openMetadata ?? {};
      // Decoders contribute seeds only — no revision token of their own
      // (the session layer owns the canonical bytes and the revision).
      expect(seedBoundsFromOpenMetadata(openMetadata)).not.toBeNull();
      expect(checksumFromOpenMetadata(openMetadata)).toBeNull();
      expect(contentRevisionFromOpenMetadata(openMetadata)).toBeNull();
      // Without a session revision the provider mounts seeds-only: the
      // cache is unusable, so it is never consulted.
      const parent = document.createElement('div');
      document.body.appendChild(parent);
      const seedOnly = new InkDocumentEditorProvider().createEditor({
        session: {
          model: decoded.model as SurfaceModel,
          openMetadata,
          document: { documentId: 'doc-cache' },
          markDirty: () => undefined,
        } as never,
        parent,
      });
      try {
        expect(parent.querySelector('canvas')).not.toBeNull();
        expect(acquire).not.toHaveBeenCalled();
      } finally {
        seedOnly.destroy();
        parent.remove();
      }
      // With the session-owned revision (normal session open), the real
      // reopen path reaches the cache exactly once, scoped to this
      // document + content revision (misses fall back to seeds, and
      // packed vectors restore with zero compiles on hits).
      const revision = checksumOf(bytes);
      const sessionMetadata = {
        ...openMetadata,
        [DOCUMENT_CONTENT_REVISION_KEY]: revision,
      };
      const parent2 = document.createElement('div');
      document.body.appendChild(parent2);
      const handle = new InkDocumentEditorProvider().createEditor({
        session: {
          model: decoded.model as SurfaceModel,
          openMetadata: sessionMetadata,
          document: { documentId: 'doc-cache' },
          markDirty: () => undefined,
        } as never,
        parent: parent2,
      });
      try {
        expect(parent2.querySelector('canvas')).not.toBeNull();
        expect(acquire).toHaveBeenCalledTimes(1);
        expect(acquire).toHaveBeenCalledWith('doc-cache', revision);
      } finally {
        handle.destroy();
        parent2.remove();
      }
    } finally {
      acquire.mockRestore();
    }
  });

  it('provider mounts a seeded session normally', () => {
    const { model, seeds } = productionSeeds(strokeModel(6));
    expect(seeds).not.toBeNull();
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const session = {
      model,
      openMetadata: {
        'surface.seedBounds': seeds!,
      },
      markDirty: () => undefined,
    };
    const handle = new InkDocumentEditorProvider().createEditor({
      session: session as never,
      parent,
    });
    try {
      // The seeded session mounts through the production provider path:
      // canvas bound, toolbar snapshot serving, model intact.
      expect(parent.querySelector('canvas')).not.toBeNull();
      expect(handle.tools?.snapshot().context).toBe('Ink canvas');
      expect(model.order).toHaveLength(6);
    } finally {
      handle.destroy();
    }
  });
});
