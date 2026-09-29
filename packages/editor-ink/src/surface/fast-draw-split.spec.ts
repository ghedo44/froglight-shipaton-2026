/**
 * Fast-drawing split artifact regression (live-writing repair §4).
 *
 * End-to-end input fixture — not an isolated compiler test. Runs the full
 * path per frame:
 *
 * ```text
 * pointerrawupdate + pointermove (+ coalesced + predicted)
 * → pending buffer + shared-frame flush (rAF buffering)
 * → camera transform (0.25×/0.5×/1×/4×/8×, incl. 0.5× where users reproduce it)
 * → InkToolController → LiveInkStrokeCompiler → committed stroke
 * ```
 *
 * Fast arcs with transport overlap/reordering injection must commit
 * identically to a clean chronological feed: confirmed surface trajectory
 * stays ordered, no artificial long backward/forward segment appears, and
 * predictions never leak into canonical data.
 */

import { describe, expect, it } from 'vitest';
import { createPointerController } from './pointer-controller.js';
import {
  createDefaultSurfaceObjectTypeRegistry,
  createDefaultSurfaceToolRegistry,
  emptySurface,
  infiniteFrame,
  InkToolController,
  SURFACE_TOOL_IDS,
  viewToSurface,
  type Camera,
  type SurfaceModel,
} from '@froglight/foundation';

const ZOOMS = [0.25, 0.5, 1, 4, 8] as const;

/** Fast arc in view space (CSS px): quarter circle, 10 samples. */
function arcViews(): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  const cx = 400;
  const cy = 300;
  const r = 150;
  const n = 10;
  for (let i = 0; i < n; i++) {
    const a = Math.PI + (i / (n - 1)) * (Math.PI / 2);
    out.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  return out;
}

function makeDom() {
  const page = document.createElement('div');
  const canvas = document.createElement('canvas');
  const badge = document.createElement('div');
  page.appendChild(canvas);
  document.body.appendChild(page);
  canvas.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 800, height: 600 }) as DOMRect;
  return { page, canvas, badge };
}

function penControllerFor(
  model: SurfaceModel,
  camera: Camera,
): InkToolController {
  const c = new InkToolController({
    model,
    objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
    toolRegistry: createDefaultSurfaceToolRegistry(),
    camera,
  });
  c.setTool(SURFACE_TOOL_IDS.pen);
  return c;
}

function committedXY(model: SurfaceModel): { x: number; y: number }[] {
  const id = model.order[0];
  const record = id === undefined ? undefined : model.objects[id];
  const points =
    (record?.points as readonly { x: number; y: number }[] | undefined) ?? [];
  return points.map((p) => ({ x: p.x, y: p.y }));
}

function maxSegment(points: readonly { x: number; y: number }[]): number {
  let longest = 0;
  for (let i = 1; i < points.length; i++) {
    longest = Math.max(
      longest,
      Math.hypot(
        points[i]!.x - points[i - 1]!.x,
        points[i]!.y - points[i - 1]!.y,
      ),
    );
  }
  return longest;
}

function downAt(
  canvas: HTMLCanvasElement,
  p: { x: number; y: number },
  ts: number,
): void {
  const event = new MouseEvent('pointerdown', {
    bubbles: true,
    cancelable: true,
    clientX: p.x,
    clientY: p.y,
    button: 0,
  }) as unknown as PointerEvent;
  Object.defineProperty(event, 'pointerId', { value: 1 });
  Object.defineProperty(event, 'pointerType', { value: 'pen' });
  Object.defineProperty(event, 'pressure', { value: 0.5 });
  Object.defineProperty(event, 'timeStamp', { value: ts });
  canvas.dispatchEvent(event);
}

function rawFrame(
  canvas: HTMLCanvasElement,
  samples: Array<{ x: number; y: number; ts: number }>,
  predicted: Array<{ x: number; y: number; ts: number }>,
): void {
  const last = samples[samples.length - 1]!;
  const event = new MouseEvent('pointerrawupdate', {
    bubbles: true,
    cancelable: true,
    clientX: last.x,
    clientY: last.y,
  }) as unknown as PointerEvent;
  Object.defineProperty(event, 'pointerId', { value: 1 });
  Object.defineProperty(event, 'pointerType', { value: 'pen' });
  Object.defineProperty(event, 'pressure', { value: 0.5 });
  Object.defineProperty(event, 'timeStamp', { value: last.ts });
  Object.defineProperty(event, 'getCoalescedEvents', {
    value: () =>
      samples.map((p) => ({
        clientX: p.x,
        clientY: p.y,
        pressure: 0.5,
        timeStamp: p.ts,
      })),
  });
  Object.defineProperty(event, 'getPredictedEvents', {
    value: () =>
      predicted.map((p) => ({
        clientX: p.x,
        clientY: p.y,
        pressure: 0.5,
        timeStamp: p.ts,
      })),
  });
  canvas.dispatchEvent(event);
}

function moveEcho(
  canvas: HTMLCanvasElement,
  samples: Array<{ x: number; y: number; ts: number }>,
  predicted: Array<{ x: number; y: number; ts: number }>,
): void {
  const last = samples[samples.length - 1]!;
  const event = new MouseEvent('pointermove', {
    bubbles: true,
    cancelable: true,
    clientX: last.x,
    clientY: last.y,
  }) as unknown as PointerEvent;
  Object.defineProperty(event, 'pointerId', { value: 1 });
  Object.defineProperty(event, 'pointerType', { value: 'pen' });
  Object.defineProperty(event, 'pressure', { value: 0.5 });
  Object.defineProperty(event, 'timeStamp', { value: last.ts });
  Object.defineProperty(event, 'getCoalescedEvents', {
    value: () =>
      samples.map((p) => ({
        clientX: p.x,
        clientY: p.y,
        pressure: 0.5,
        timeStamp: p.ts,
      })),
  });
  Object.defineProperty(event, 'getPredictedEvents', {
    value: () =>
      predicted.map((p) => ({
        clientX: p.x,
        clientY: p.y,
        pressure: 0.5,
        timeStamp: p.ts,
      })),
  });
  canvas.dispatchEvent(event);
}

function upAt(canvas: HTMLCanvasElement, p: { x: number; y: number }): void {
  const event = new MouseEvent('pointerup', {
    bubbles: true,
    cancelable: true,
    clientX: p.x,
    clientY: p.y,
    button: 0,
  }) as unknown as PointerEvent;
  Object.defineProperty(event, 'pointerId', { value: 1 });
  Object.defineProperty(event, 'pointerType', { value: 'pen' });
  Object.defineProperty(event, 'pressure', { value: 0.5 });
  Object.defineProperty(event, 'getCoalescedEvents', { value: () => [] });
  Object.defineProperty(event, 'getPredictedEvents', { value: () => [] });
  canvas.dispatchEvent(event);
}

describe.each(ZOOMS)('fast-draw split artifact at %sx zoom', (zoom) => {
  it('overlapping transports + predictions commit like the clean chronological feed', () => {
    const views = arcViews();
    const camera: Camera = { x: 0, y: 0, zoom };
    const T0 = 5000;
    const stamps = views.map((_, i) => T0 + i * 4);

    // Clean chronological feed straight into the tool (reference truth).
    // Infinite frame: border-resize hit-testing is irrelevant to the split
    // artifact (and an identity camera would park arc points on the
    // bounded border at some zooms); the camera transform under test stays.
    const cleanModel = emptySurface(infiniteFrame());
    const clean = penControllerFor(cleanModel, { ...camera });
    clean.pointerDown({ point: views[0]! });
    clean.pointerBatch(views.slice(1, -1).map((p) => ({ point: { ...p } })));
    clean.pointerUp({ point: views[views.length - 1]! });
    const cleanCommitted = committedXY(cleanModel);
    expect(cleanCommitted.length).toBeGreaterThan(5);
    const cleanMax = maxSegment(cleanCommitted);

    // Overlap run through the real transport + buffering + camera + tool.
    const model = emptySurface(infiniteFrame());
    const ink = penControllerFor(model, { ...camera });
    const { page, canvas, badge } = makeDom();
    const handler = createPointerController({
      model,
      controller: {
        camera: () => ({ ...camera }),
        setCamera: (c) => ink.setCamera(c),
        pointerDown: (e) => ink.pointerDown(e),
        pointerMove: (e) => ink.pointerMove(e),
        pointerUp: (e) => ink.pointerUp(e),
        pointerCancel: () => ink.pointerCancel(),
        pointerBatch: (events) => ink.pointerBatch(events),
        pointerPredicted: (events) => ink.pointerPredicted(events),
        panBy: () => undefined,
        selection: () => [],
        setSelection: () => undefined,
        resizeObject: () => undefined,
      },
      canvas,
      page,
      badge,
      navigationMode: 'standalone',
      cameraInteractive: true,
      frameResizable: true,
      isReadOnly: () => false,
      isDestroyed: () => false,
      isUserNavigated: () => false,
      setUserNavigated: () => undefined,
      getActiveToolId: () => 'froglight.ink.pen',
      beginHistoryGesture: () => undefined,
      commitHistoryGesture: () => undefined,
      cancelHistoryGesture: () => undefined,
      clampToSheet: (c) => c,
      setZoomFactor: () => undefined,
      syncZoomState: () => undefined,
      scheduleRender: () => undefined,
      invalidateScene: () => undefined,
      fitToView: () => undefined,
      notifyTools: () => undefined,
      markDirty: () => undefined,
      openTextOverlay: () => undefined,
      openTextOverlayAtSelection: () => false,
      isTextOverlayOpen: () => false,
      requestUndo: () => false,
      requestRedo: () => false,
      requestSetTool: () => undefined,
      pointerRawUpdate: 'always',
      coalesceDrawInput: true,
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    handler.attach(root);

    downAt(canvas, views[0]!, stamps[0]!);
    // 3 samples per shared frame: raw delivers the frame, the echoing move
    // carries the same coalesced samples (exact echoes → suppressed), plus
    // one near prediction (ephemeral) and one far prediction (clipped).
    for (let base = 1; base < views.length; base += 3) {
      const chunk = views.slice(base, base + 3).map((p, k) => ({
        ...p,
        ts: stamps[base + k]!,
      }));
      const tip = chunk[chunk.length - 1]!;
      const near = { x: tip.x + 8, y: tip.y + 2, ts: tip.ts + 4 };
      const far = { x: tip.x + 250, y: tip.y, ts: tip.ts + 6 };
      rawFrame(canvas, chunk, [near, far]);
      moveEcho(canvas, chunk, [near, far]);
      // Mid-gesture stale-overlap injection (frame 2): an older position
      // with a fresh timestamp arrives after newer raw input. The old
      // dual-transport merge would append it after the frontier (backtrack
      // chord); authoritative raw suppresses it.
      if (base === 4) {
        moveEcho(canvas, [{ ...views[1]!, ts: tip.ts + 1 }], []);
      }
      // One shared frame: drain confirmed + latest prediction, no new frame.
      handler.flushPendingInputWithoutSchedulingRender();
    }
    upAt(canvas, views[views.length - 1]!);

    const committed = committedXY(model);
    // Same confirmed trajectory → same canonical commit as the clean feed.
    expect(committed.length).toBe(cleanCommitted.length);
    for (let i = 0; i < committed.length; i++) {
      expect(committed[i]!.x).toBeCloseTo(cleanCommitted[i]!.x, 9);
      expect(committed[i]!.y).toBeCloseTo(cleanCommitted[i]!.y, 9);
    }
    // No artificial long segment: the overlap never stretched the stroke.
    expect(maxSegment(committed)).toBeLessThanOrEqual(cleanMax * 1.5 + 1e-6);
    // Predictions never leaked into canonical data (far tip 250px ahead).
    const farSurface = viewToSurface(camera, {
      x: views[views.length - 1]!.x + 250,
      y: views[views.length - 1]!.y,
    });
    for (const p of committed) {
      expect(
        Math.hypot(p.x - farSurface.x, p.y - farSurface.y),
      ).toBeGreaterThan(1);
    }
    // Transport diagnostics prove the overlap was exercised, not skipped.
    const stats = handler.transportStats();
    expect(stats.rawConfirmed).toBeGreaterThan(0);
    expect(stats.moveSuppressedRawOwned).toBeGreaterThanOrEqual(1);
    expect(stats.predictedReceived).toBeGreaterThan(0);

    handler.detach();
    page.remove();
    root.remove();
  });
});
