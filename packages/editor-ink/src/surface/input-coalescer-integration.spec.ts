/**
 * Single-shared-frame draw input (live-writing repair).
 *
 * Proves the production path: many `pointermove`/`pointerrawupdate` events
 * per visible frame buffer cheaply and publish once per SHARED render
 * frame — at most one expensive live geometry publication per frame, at
 * most one paint, confirmed never dropped, predictions latest-only,
 * pointerup flushes synchronously with no extra frame scheduled.
 *
 * Frame model: pointer events → pending buffer + `scheduleRender` request
 * → shared frame runs `flushPendingInputWithoutSchedulingRender()` (drain
 * + dispatch, never schedules) then paints. Tests drive the shared frame
 * explicitly through the flush; `scheduleRender` is only a request counter.
 */

import { describe, expect, it } from 'vitest';
import {
  createPointerController,
  type PointerControllerDeps,
} from './pointer-controller.js';
import { emptySurface, boundedFrame, InkToolController, createDefaultSurfaceObjectTypeRegistry, createDefaultSurfaceToolRegistry, SURFACE_TOOL_IDS } from '@froglight/foundation';

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

function pointerDown(
  canvas: HTMLCanvasElement,
  id: number,
  x: number,
  y: number,
): void {
  const event = new MouseEvent('pointerdown', {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
  }) as unknown as PointerEvent;
  Object.defineProperty(event, 'pointerId', { value: id });
  Object.defineProperty(event, 'pointerType', { value: 'pen' });
  Object.defineProperty(event, 'pressure', { value: 0.5 });
  canvas.dispatchEvent(event);
}

function pointerMoveBatch(
  canvas: HTMLCanvasElement,
  id: number,
  current: { x: number; y: number },
  coalesced: Array<{ x: number; y: number }>,
  predicted: Array<{ x: number; y: number }> = [],
  time = 2000,
): void {
  const event = new MouseEvent('pointermove', {
    bubbles: true,
    cancelable: true,
    clientX: current.x,
    clientY: current.y,
  }) as unknown as PointerEvent;
  const sample = (p: { x: number; y: number }) => ({
    clientX: p.x,
    clientY: p.y,
    pressure: 0.5,
    timeStamp: time,
  });
  Object.defineProperty(event, 'pointerId', { value: id });
  Object.defineProperty(event, 'pointerType', { value: 'pen' });
  Object.defineProperty(event, 'pressure', { value: 0.5 });
  Object.defineProperty(event, 'getCoalescedEvents', {
    value: () => coalesced.map(sample),
  });
  Object.defineProperty(event, 'getPredictedEvents', {
    value: () => predicted.map(sample),
  });
  canvas.dispatchEvent(event);
}

function pointerUp(
  canvas: HTMLCanvasElement,
  id: number,
  x: number,
  y: number,
): void {
  const event = new Event('pointerup', {
    bubbles: true,
    cancelable: true,
  }) as unknown as PointerEvent;
  Object.defineProperty(event, 'pointerId', { value: id });
  Object.defineProperty(event, 'pointerType', { value: 'pen' });
  Object.defineProperty(event, 'pressure', { value: 0.5 });
  Object.defineProperty(event, 'clientX', { value: x });
  Object.defineProperty(event, 'clientY', { value: y });
  Object.defineProperty(event, 'getCoalescedEvents', { value: () => [] });
  canvas.dispatchEvent(event);
}

function coalescedDeps(overrides: Partial<PointerControllerDeps> = {}): {
  deps: PointerControllerDeps;
  batches: { x: number; y: number }[][];
  predicted: { x: number; y: number }[][];
  scheduleRequests: { count: number };
} {
  const { page, canvas, badge } = makeDom();
  const batches: { x: number; y: number }[][] = [];
  const predicted: { x: number; y: number }[][] = [];
  const scheduleRequests = { count: 0 };
  const deps: PointerControllerDeps = {
    model: emptySurface(boundedFrame(800, 600)),
    controller: {
      camera: () => ({ x: 0, y: 0, zoom: 1 }),
      setCamera: () => undefined,
      pointerDown: () => undefined,
      pointerMove: () => undefined,
      pointerUp: () => undefined,
      pointerCancel: () => undefined,
      pointerBatch: (
        events: readonly { point: { x: number; y: number } }[],
      ) => {
        batches.push(events.map((e) => ({ ...e.point })));
      },
      pointerPredicted: (
        events: readonly { point: { x: number; y: number } }[],
      ) => {
        predicted.push(events.map((e) => ({ ...e.point })));
      },
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
    // Shared-frame request counter (production coalesces these into one
    // frame; the test drives the frame explicitly via the flush below).
    scheduleRender: () => {
      scheduleRequests.count += 1;
    },
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
    coalesceDrawInput: true,
    // Generous horizon isolates scheduling assertions from the
    // prediction-horizon policy (dedicated horizon specs use defaults).
    predictionPolicy: { maxScreenPx: 100000, maxLookaheadMs: 1000000 },
    ...overrides,
  };
  return { deps, batches, predicted, scheduleRequests };
}

describe('coalesced draw input (one flush + one paint per shared frame)', () => {
  it('buffers many pointermoves into one batch per shared frame', () => {
    const { deps, batches, scheduleRequests } = coalescedDeps();
    const root = document.createElement('div');
    document.body.appendChild(root);
    const handler = createPointerController(deps);
    handler.attach(root);
    pointerDown(deps.canvas, 1, 50, 50);
    scheduleRequests.count = 0;
    // 4 DOM events in one frame (240Hz events vs 60fps frames).
    pointerMoveBatch(
      deps.canvas,
      1,
      { x: 52, y: 50 },
      [{ x: 52, y: 50 }],
      [],
      1001,
    );
    pointerMoveBatch(
      deps.canvas,
      1,
      { x: 54, y: 50 },
      [{ x: 54, y: 50 }],
      [],
      1002,
    );
    pointerMoveBatch(
      deps.canvas,
      1,
      { x: 56, y: 50 },
      [{ x: 56, y: 50 }],
      [],
      1003,
    );
    pointerMoveBatch(
      deps.canvas,
      1,
      { x: 58, y: 50 },
      [{ x: 58, y: 50 }],
      [],
      1004,
    );
    // Nothing published yet — buffered cheaply, no expensive work.
    expect(batches).toHaveLength(0);
    expect(handler.hasPendingInput()).toBe(true);
    // Each event requests the shared frame (production coalesces them).
    expect(scheduleRequests.count).toBe(4);
    const requestsBeforeFlush = scheduleRequests.count;
    // One shared frame → drain (no new frame scheduled) → one batch.
    handler.flushPendingInputWithoutSchedulingRender();
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual([
      { x: 52, y: 50 },
      { x: 54, y: 50 },
      { x: 56, y: 50 },
      { x: 58, y: 50 },
    ]);
    // The flush never schedules another frame (single-rAF invariant).
    expect(scheduleRequests.count).toBe(requestsBeforeFlush);
    expect(handler.hasPendingInput()).toBe(false);
    expect(handler.transportStats().inputFlushes).toBe(1);
    handler.detach();
    deps.page.remove();
    root.remove();
  });

  it('keeps only the latest predictions between frames', () => {
    const { deps, batches, predicted } = coalescedDeps();
    const root = document.createElement('div');
    document.body.appendChild(root);
    const handler = createPointerController(deps);
    handler.attach(root);
    pointerDown(deps.canvas, 1, 50, 50);
    pointerMoveBatch(
      deps.canvas,
      1,
      { x: 52, y: 50 },
      [{ x: 52, y: 50 }],
      [{ x: 100, y: 100 }],
      1001,
    );
    pointerMoveBatch(
      deps.canvas,
      1,
      { x: 54, y: 50 },
      [{ x: 54, y: 50 }],
      [{ x: 110, y: 100 }],
      1002,
    );
    handler.flushPendingInputWithoutSchedulingRender();
    expect(batches).toHaveLength(1);
    expect(batches[0]).toHaveLength(2);
    // Intermediate prediction replaced (ephemeral, never canonical).
    expect(predicted).toHaveLength(1);
    expect(predicted[0]).toEqual([{ x: 110, y: 100 }]);
    handler.detach();
    deps.page.remove();
    root.remove();
  });

  it('pointerup synchronously flushes pending input before commit (no extra frame)', () => {
    const { deps, batches, scheduleRequests } = coalescedDeps();
    const ups: { x: number; y: number }[] = [];
    (
      deps.controller as {
        pointerUp: (e: { point: { x: number; y: number } }) => void;
      }
    ).pointerUp = (e) => void ups.push({ ...e.point });
    const root = document.createElement('div');
    document.body.appendChild(root);
    const handler = createPointerController(deps);
    handler.attach(root);
    pointerDown(deps.canvas, 1, 50, 50);
    pointerMoveBatch(
      deps.canvas,
      1,
      { x: 52, y: 50 },
      [{ x: 52, y: 50 }],
      [],
      1001,
    );
    pointerMoveBatch(
      deps.canvas,
      1,
      { x: 54, y: 50 },
      [{ x: 54, y: 50 }],
      [],
      1002,
    );
    expect(batches).toHaveLength(0);
    const requestsBeforeUp = scheduleRequests.count;
    // Lift without running the frame: pending must still commit (never dropped).
    pointerUp(deps.canvas, 1, 60, 50);
    expect(handler.hasPendingInput()).toBe(false);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual([
      { x: 52, y: 50 },
      { x: 54, y: 50 },
    ]);
    expect(ups.length).toBeGreaterThan(0);
    // pointerup's synchronous flush schedules no extra frame beyond the
    // final commit render.
    expect(scheduleRequests.count).toBeLessThanOrEqual(requestsBeforeUp + 1);
    handler.detach();
    deps.page.remove();
    root.remove();
  });

  it('continuous circles publish every frame with no gaps (no pause/catch-up)', () => {
    const { deps, batches } = coalescedDeps();
    const root = document.createElement('div');
    document.body.appendChild(root);
    const handler = createPointerController(deps);
    handler.attach(root);
    pointerDown(deps.canvas, 1, 100, 100);
    // Two shared frames of small repetitive circles (high curvature, 240Hz-like).
    let t = 3000;
    for (let frame = 0; frame < 2; frame++) {
      for (let e = 0; e < 4; e++) {
        const a = ((frame * 4 + e) / 16) * Math.PI * 2;
        const x = Math.round(100 + Math.cos(a) * 12);
        const y = Math.round(100 + Math.sin(a) * 12);
        t += 1;
        pointerMoveBatch(deps.canvas, 1, { x, y }, [{ x, y }], [], t);
      }
      handler.flushPendingInputWithoutSchedulingRender();
    }
    // Every frame published progress (visually continuous — no empty frame
    // during active drawing, no single catch-up block at the end).
    expect(batches).toHaveLength(2);
    expect(batches[0]!.length).toBe(4);
    expect(batches[1]!.length).toBe(4);
    // All 8 confirmed samples arrived in order (none dropped).
    const all = batches.flat();
    expect(all).toHaveLength(8);
    expect(handler.transportStats().inputFlushes).toBe(2);
    handler.detach();
    deps.page.remove();
    root.remove();
  });

  it('flushPendingInput never schedules another frame', () => {
    const { deps, scheduleRequests } = coalescedDeps();
    const root = document.createElement('div');
    document.body.appendChild(root);
    const handler = createPointerController(deps);
    handler.attach(root);
    pointerDown(deps.canvas, 1, 50, 50);
    pointerMoveBatch(
      deps.canvas,
      1,
      { x: 52, y: 50 },
      [{ x: 52, y: 50 }],
      [],
      1001,
    );
    const before = scheduleRequests.count;
    handler.flushPendingInput();
    handler.flushPendingInput();
    expect(scheduleRequests.count).toBe(before);
    handler.detach();
    deps.page.remove();
    root.remove();
  });
});

describe('prediction snapshot withdrawal', () => {
  it.each([false, true])(
    'clears a displayed tail without new confirmed input (coalesced=%s)',
    (coalesceDrawInput) => {
      const { deps, predicted, scheduleRequests } = coalescedDeps({
        coalesceDrawInput,
        pointerRawUpdate: 'always',
      });
      const handler = createPointerController(deps);
      const root = document.createElement('div');
      handler.attach(root);
      pointerDown(deps.canvas, 1, 50, 50);
      pointerMoveBatch(
        deps.canvas,
        1,
        { x: 60, y: 50 },
        [{ x: 60, y: 50 }],
        [{ x: 65, y: 50 }],
      );
      handler.flushPendingInputWithoutSchedulingRender();
      expect(predicted.at(-1)).toEqual([{ x: 65, y: 50 }]);
      const before = scheduleRequests.count;
      // Identical confirmed point: only the prediction snapshot changes.
      pointerMoveBatch(
        deps.canvas,
        1,
        { x: 60, y: 50 },
        [{ x: 60, y: 50 }],
        [],
      );
      handler.flushPendingInputWithoutSchedulingRender();
      expect(predicted.at(-1)).toEqual([]);
      expect(scheduleRequests.count).toBeGreaterThan(before);
      handler.detach();
      deps.page.remove();
      root.remove();
    },
  );
});

describe('complete prediction replacement snapshots', () => {
  it.each([false, true])(
    'keeps repeated lookahead after confirmed geometry advances (coalesced=%s)',
    (coalesceDrawInput) => {
      const { deps, predicted } = coalescedDeps({
        coalesceDrawInput,
        pointerRawUpdate: 'never',
      });
      const handler = createPointerController(deps);
      const root = document.createElement('div');
      handler.attach(root);
      pointerDown(deps.canvas, 1, 50, 50);
      pointerMoveBatch(
        deps.canvas,
        1,
        { x: 60, y: 50 },
        [{ x: 60, y: 50 }],
        [{ x: 75, y: 50 }],
      );
      handler.flushPendingInputWithoutSchedulingRender();
      pointerMoveBatch(
        deps.canvas,
        1,
        { x: 65, y: 50 },
        [{ x: 65, y: 50 }],
        [{ x: 75, y: 50 }],
      );
      handler.flushPendingInputWithoutSchedulingRender();
      // Appending confirmed samples replaces the tool preview. The same valid
      // lookahead must be applied again to that new geometry, not echo-dropped.
      expect(predicted).toEqual([[{ x: 75, y: 50 }], [{ x: 75, y: 50 }]]);
      handler.detach();
      deps.page.remove();
      root.remove();
    },
  );
});


describe('rapid handwriting through the real ink engine', () => {
  it('keeps a short lead-in and the following C separate before any render frame', () => {
    const { deps } = coalescedDeps({ pointerRawUpdate: 'never' });
    const controller = new InkToolController({
      model: deps.model,
      objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
      toolRegistry: createDefaultSurfaceToolRegistry(),
      camera: { x: 0, y: 0, zoom: 1 },
    });
    controller.setTool(SURFACE_TOOL_IDS.pen);
    const handler = createPointerController({ ...deps, controller });
    const root = document.createElement('div');
    handler.attach(root);
    const curve = [
      { x: 140, y: 90 }, { x: 125, y: 80 }, { x: 105, y: 90 },
      { x: 95, y: 110 }, { x: 100, y: 135 }, { x: 120, y: 145 }, { x: 145, y: 135 },
    ];
    try {
      pointerDown(deps.canvas, 1, 60, 100);
      pointerMoveBatch(deps.canvas, 1, { x: 80, y: 90 }, [{ x: 80, y: 90 }]);
      pointerUp(deps.canvas, 1, 80, 90);
      // Same pointer identity, immediate next contact, no rAF between strokes.
      pointerDown(deps.canvas, 1, 140, 90);
      pointerMoveBatch(deps.canvas, 1, curve[0]!, curve.slice(1));
      pointerUp(deps.canvas, 1, 145, 135);
      handler.flushPendingInputWithoutSchedulingRender();
      expect(deps.model.order).toHaveLength(2);
      const first = deps.model.objects[deps.model.order[0]!];
      const second = deps.model.objects[deps.model.order[1]!];
      expect(first?.points).toEqual([
        expect.objectContaining({ x: 60, y: 100 }), expect.objectContaining({ x: 80, y: 90 }),
      ]);
      expect(second?.points).toEqual(curve.map(point => expect.objectContaining(point)));
    } finally {
      handler.detach();
      deps.page.remove();
      root.remove();
    }
  });
});
