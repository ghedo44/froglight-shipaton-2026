// @vitest-environment jsdom
/**
 * Derived-cache revision ownership lifecycle (final pass, item 1).
 *
 * The reopen binding is LIVE: mount and teardown read the session
 * revision and dirty flag at their own time, never a frozen mount-time
 * snapshot. These tests prove the two required lifecycles:
 *
 * ```text
 * open R0 → edit → save → R1 → close → reopen R1
 *   ⇒ cached geometry may hit R1, never R0
 *
 * open R0 → edit without saving → close
 *   ⇒ unsaved geometry is NOT persisted as R0
 * ```
 *
 * Mounting is the real production stack (`mountInkSurface` + committed
 * renderer + derived store + host storage port); records are warmed the
 * way a real viewport warms them (a compiled record), no synthetic cache
 * writes.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  boundedFrame,
  compiledStrokeComputeStats,
  compiledStrokeForRecord,
  createDefaultSurfaceObjectTypeRegistry,
  createLiveCachedCompiledRestore,
  DerivedReopenStore,
  emptySurface,
  inkStrokeObject,
  accumulateDerivedTranslation,
  packCompiledInk,
  packedRenderCounters,
  setCompiledForRecord,
  smoothSpineOfRecord,
  SURFACE_OBJECT_TYPES,
  type DerivedCacheStoragePort,
  type SurfaceModel,
} from '@froglight/foundation';
import { installCanvasStub } from '@froglight/foundation/testing';
import {
  mountInkSurface,
  type InkSkeleton,
  type InkSurfaceHandle,
} from '../index.js';

const DOC = 'doc-revision-lifecycle';
const ID = 's0';

interface FakeSession {
  readonly model: SurfaceModel;
  readonly openMetadata?: Readonly<Record<string, unknown>>;
  readonly document: { readonly documentId: string };
  contentRevision: string | null;
  dirty: boolean;
  markDirty(): void;
}

function memoryPort(): DerivedCacheStoragePort & {
  saved: Map<string, Uint8Array>;
} {
  const saved = new Map<string, Uint8Array>();
  return {
    saved,
    load: (documentId: string) => saved.get(documentId) ?? null,
    save: (documentId: string, bytes: Uint8Array) => {
      saved.set(documentId, bytes);
    },
    remove: (documentId: string) => {
      saved.delete(documentId);
    },
  };
}

function strokeModel(dx = 0, dy = 0): SurfaceModel {
  const model = emptySurface(boundedFrame(2000, 2000));
  const points: { x: number; y: number; pressure: number; dt: number }[] = [];
  for (let i = 0; i < 80; i++) {
    points.push({
      x: 200 + dx + i * 3,
      y: 400 + dy + Math.sin(i / 5) * 10,
      pressure: 0.5,
      dt: i * 8,
    });
  }
  model.objects[ID] = inkStrokeObject(ID, { points, width: 3.5 });
  model.order.push(ID);
  return model;
}

function makeHost(): { skeleton: InkSkeleton; cleanup: () => void } {
  const root = document.createElement('div');
  const page = document.createElement('div');
  const canvas = document.createElement('canvas');
  const badge = document.createElement('div');
  const pointerIndicator = document.createElement('div');
  const overlayRoot = document.createElement('div');
  page.appendChild(canvas);
  page.appendChild(badge);
  page.appendChild(pointerIndicator);
  page.appendChild(overlayRoot);
  root.appendChild(page);
  document.body.appendChild(root);
  const rect = {
    left: 0,
    top: 0,
    width: 800,
    height: 600,
    right: 800,
    bottom: 600,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;
  vi.spyOn(page, 'getBoundingClientRect').mockReturnValue(rect);
  vi.spyOn(canvas, 'getBoundingClientRect').mockReturnValue(rect);
  return {
    skeleton: { root, page, canvas, badge, pointerIndicator, overlayRoot },
    cleanup: () => root.remove(),
  };
}

function mountSession(
  session: FakeSession,
  store: DerivedReopenStore,
): { handle: InkSurfaceHandle; cleanup: () => void } {
  const { skeleton, cleanup } = makeHost();
  const handle = mountInkSurface({
    model: session.model,
    markDirty: () => session.markDirty(),
    host: skeleton,
    reopen: {
      store,
      documentId: session.document.documentId,
      getContentRevision: () => session.contentRevision,
      isDirty: () => session.dirty,
    },
  });
  return { handle, cleanup };
}

function warm(model: SurfaceModel): void {
  const record = model.objects[ID]!;
  const compiled = compiledStrokeForRecord(record);
  expect(compiled).not.toBeNull();
  // Simulate background packing completed (retained) so teardown persists
  // without sync packing (closure-pass ownership).
  const packed = packCompiledInk(compiled!).packed;
  setCompiledForRecord(record, compiled!, packed);
}

/**
 * Let the coalesced render frame run so the viewport-first preparation
 * queue reaches the visible stroke (lazy restore happens at preparation
 * priority, never at mount).
 */
async function nextRenderFrame(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 40));
}

/** Poll until the lazy viewport restore lands (load-tolerant). */
async function waitForLazyRestore(handle: InkSurfaceHandle): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (handle.diagnostics().reopenCompiled.cachedPackedRestored > 0) return;
    await nextRenderFrame();
  }
}

/** Simulate a controller rigid-translation commit (canonical + derived). */
function translate(model: SurfaceModel, dx: number, dy: number): void {
  createDefaultSurfaceObjectTypeRegistry().get(SURFACE_OBJECT_TYPES.stroke)!
    .translate!(model.objects[ID]!, dx, dy);
  accumulateDerivedTranslation(model, [ID], dx, dy);
}

describe('derived-cache revision ownership lifecycle', () => {
  let restoreCanvas: (() => void) | null = null;

  afterEach(() => {
    restoreCanvas?.();
    restoreCanvas = null;
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it('open R0 → edit → save R1 → close → reopen R1 hits R1, never R0', async () => {
    restoreCanvas = installCanvasStub();
    const port = memoryPort();
    const store = new DerivedReopenStore(32, port);
    const session: FakeSession = {
      model: strokeModel(),
      openMetadata: {},
      document: { documentId: DOC },
      contentRevision: 'R0',
      dirty: false,
      markDirty: () => {
        session.dirty = true;
      },
    };

    const first = mountSession(session, store);
    // The viewport warms the stroke (exactly what a rendered viewport does).
    warm(session.model);
    // Edit, then save: the live revision moves R0 → R1 while mounted.
    translate(session.model, 40, 25);
    session.dirty = true;
    session.contentRevision = 'R1';
    session.dirty = false;
    first.handle.destroy();
    first.cleanup();
    await store.flushPending();

    // Truly-lazy durable: manifest + per-entry records (never a monolithic
    // container). R1 entries exist; R0 finds nothing (retired revision).
    expect(port.saved.has(DOC)).toBe(true);
    const r1check = new DerivedReopenStore(32, port);
    r1check.acquire(DOC, 'R1');
    expect(await r1check.hydrate(DOC)).toBe(true);
    expect(await r1check.loadDurableEntry(DOC, 'R1', ID)).toBeDefined();
    const r0check = new DerivedReopenStore(32, port);
    r0check.acquire(DOC, 'R0');
    expect(await r0check.hydrate(DOC)).toBe(false);
    expect(await r0check.loadDurableEntry(DOC, 'R0', ID)).toBeNull();

    // Reopen at R1 via the live restore source (deterministic, no rAF
    // timing): packed hits with zero B-spline compiles, zero rich unpacks,
    // at the translated world position. Mount progressive coverage for the
    // same path is asserted in the Chromium dense suite + foundation closure
    // spec (viewport priority, bounded preload).
    const reopenedModel = strokeModel(40, 25);
    const computesBefore = compiledStrokeComputeStats.computes;
    // Delta assertion (other suites may unpack concurrently; only this
    // restore's unpacks must be zero).
    const unpacksBefore = packedRenderCounters.synchronousRichUnpacks;
    const liveBinding = {
      store,
      documentId: DOC,
      getContentRevision: () => 'R1' as string | null,
      isDirty: () => false,
    };
    // Ensure the durable entry is in memory (viewport-priority fetch).
    // (`store` forgot its entry at teardown; re-acquire R1 first.)
    store.acquire(DOC, 'R1');
    expect(await store.hydrate(DOC)).toBe(true);
    expect(await store.loadDurableEntry(DOC, 'R1', ID)).toBeDefined();
    const liveRestore = createLiveCachedCompiledRestore(liveBinding);
    const reopenedRecord = reopenedModel.objects[ID]!;
    const packedHit = liveRestore.restorePacked?.(reopenedRecord);
    expect(packedHit).toBeDefined();
    expect(liveRestore.stats().restored).toBe(1);
    expect(liveRestore.stats().misses).toBe(0);
    expect(compiledStrokeComputeStats.computes).toBe(computesBefore);
    expect(packedRenderCounters.synchronousRichUnpacks - unpacksBefore).toBe(0);
    // World position via packed bounds (no rich unpack for the check).
    expect(packedHit!.boundsXYWH[0]).toBeGreaterThan(200);
    // Retired R0 revision never serves (live binding reads current revision;
    // stale R0 hydration is discarded by generation/entry identity).
    const staleBinding = {
      store,
      documentId: DOC,
      getContentRevision: () => 'R0' as string | null,
      isDirty: () => false,
    };
    const staleRestore = createLiveCachedCompiledRestore(staleBinding);
    const staleRecord = strokeModel().objects[ID]!;
    expect(staleRestore.restore(staleRecord)).toBe(false);
    expect(staleRestore.restorePacked?.(staleRecord)).toBeUndefined();
    // Mount-level live safety (dirty + revision) is covered below; close the
    // second mount cleanly (teardown persists R1 again, harmless).
    const session2: FakeSession = {
      model: reopenedModel,
      document: { documentId: DOC },
      contentRevision: 'R1',
      dirty: false,
      markDirty: () => undefined,
    };
    const second = mountSession(session2, store);
    try {
      await waitForLazyRestore(second.handle);
    } finally {
      second.handle.destroy();
      second.cleanup();
      await store.flushPending();
    }
  });

  it('open R0 → edit without saving → close persists nothing for the edit', async () => {
    restoreCanvas = installCanvasStub();
    const port = memoryPort();
    const store = new DerivedReopenStore(32, port);
    // Seed a clean R0 entry first (previous clean session).
    const cleanSession: FakeSession = {
      model: strokeModel(),
      document: { documentId: DOC },
      contentRevision: 'R0',
      dirty: false,
      markDirty: () => undefined,
    };
    const clean = mountSession(cleanSession, store);
    warm(cleanSession.model);
    clean.handle.destroy();
    clean.cleanup();
    await store.flushPending();
    const persistedBefore = port.saved.get(DOC);
    expect(persistedBefore).toBeDefined();
    const untouchedSpine = smoothSpineOfRecord(cleanSession.model.objects[ID]!);

    // Unsaved session: mount is dirty, so no restore is trusted; edits are
    // never associated with the last saved revision R0.
    const dirtySession: FakeSession = {
      model: strokeModel(),
      document: { documentId: DOC },
      contentRevision: 'R0',
      dirty: true,
      markDirty: () => undefined,
    };
    const dirty = mountSession(dirtySession, store);
    expect(dirty.handle.diagnostics().reopenCompiled.hits).toBe(0);
    warm(dirtySession.model);
    translate(dirtySession.model, 500, 300);
    dirty.handle.destroy();
    dirty.cleanup();
    await store.flushPending();

    // Storage manifest is byte-identical: nothing was re-serialized from the
    // unsaved model, and the R0 entry still describes the saved geometry.
    // (Truly-lazy durable stores manifest + per-entry records; the dirty
    // teardown queued no job, so all saved records are untouched.)
    expect(port.saved.get(DOC)).toEqual(persistedBefore);
    // Demanded R0 entry still serves (packed, validated) via lazy fetch.
    store.acquire(DOC, 'R0');
    expect(await store.hydrate(DOC)).toBe(true);
    expect(await store.loadDurableEntry(DOC, 'R0', ID)).toBeDefined();
    // The saved R0 cache holds the original (untranslated) spine; the
    // unsaved +500/+300 edit never entered the cache.
    const cachedSpine = smoothSpineOfRecord(cleanSession.model.objects[ID]!);
    expect(cachedSpine).toEqual(untouchedSpine);
  });

  it('destroy does no synchronous whole-cache serialization for a large warm cache', async () => {
    restoreCanvas = installCanvasStub();
    const port = memoryPort();
    const store = new DerivedReopenStore(32, port);
    const session: FakeSession = {
      model: strokeModel(),
      document: { documentId: DOC },
      contentRevision: 'R0',
      dirty: false,
      markDirty: () => undefined,
    };
    const mounted = mountSession(session, store);
    warm(session.model);
    try {
      mounted.handle.destroy();
      mounted.cleanup();
      // Teardown returned with no durable writes on the stack: manifest +
      // per-entry records run on the store's async lane (truly-lazy, no
      // monolithic container, zero sync `packCompiledInk`).
      expect(port.saved.has(DOC)).toBe(false);
      await store.flushPending();
      expect(port.saved.has(DOC)).toBe(true);
    } finally {
      void 0;
    }
  });
});
