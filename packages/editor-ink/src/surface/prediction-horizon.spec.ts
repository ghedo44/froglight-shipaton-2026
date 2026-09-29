/**
 * Bounded prediction (live-writing repair §2).
 *
 * The flashing forward line is browser `getPredictedEvents()` rendered too
 * far ahead. Predictions are horizon-clipped in SCREEN space (CSS px, never
 * surface units) plus a ≈one-frame lookahead, per-pointer-type gated
 * (pen-only by default), and kill-switchable without touching confirmed
 * drawing.
 */

import { describe, expect, it } from 'vitest';
import { createPointerController } from './pointer-controller.js';
import {
  clipPredictedToHorizon,
  PREDICTION_MAX_SCREEN_PX,
  shouldPredictForPointerType,
} from './prediction-policy.js';
import { emptySurface, boundedFrame } from '@froglight/foundation';

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

function penDown(
  canvas: HTMLCanvasElement,
  x: number,
  y: number,
  type = 'pen',
): void {
  const event = new MouseEvent('pointerdown', {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
  }) as unknown as PointerEvent;
  Object.defineProperty(event, 'pointerId', { value: 1 });
  Object.defineProperty(event, 'pointerType', { value: type });
  Object.defineProperty(event, 'pressure', { value: 0.5 });
  canvas.dispatchEvent(event);
}

function moveWithPrediction(
  canvas: HTMLCanvasElement,
  current: { x: number; y: number },
  confirmedTs: number,
  predicted: Array<{ x: number; y: number; ts: number }>,
  type = 'pen',
): void {
  const event = new MouseEvent('pointermove', {
    bubbles: true,
    cancelable: true,
    clientX: current.x,
    clientY: current.y,
  }) as unknown as PointerEvent;
  Object.defineProperty(event, 'pointerId', { value: 1 });
  Object.defineProperty(event, 'pointerType', { value: type });
  Object.defineProperty(event, 'pressure', { value: 0.5 });
  Object.defineProperty(event, 'getCoalescedEvents', {
    value: () => [
      {
        clientX: current.x,
        clientY: current.y,
        pressure: 0.5,
        timeStamp: confirmedTs,
      },
    ],
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

function predictedHarness(
  pointerType = 'pen',
  policy: Record<string, unknown> = {},
  depsOverride: Record<string, unknown> = {},
  zoom = 1,
) {
  const { page, canvas, badge } = makeDom();
  const batches: { x: number; y: number }[][] = [];
  const predicted: { x: number; y: number }[][] = [];
  const handler = createPointerController({
    model: emptySurface(boundedFrame(800, 600)),
    controller: {
      camera: () => ({ x: 0, y: 0, zoom }),
      setCamera: () => undefined,
      pointerDown: () => undefined,
      pointerMove: () => undefined,
      pointerUp: () => undefined,
      pointerCancel: () => undefined,
      pointerBatch: (events) => {
        batches.push(events.map((e) => ({ ...e.point })));
      },
      pointerPredicted: (events) => {
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
    predictionPolicy: { ...policy },
    ...(depsOverride as object),
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  handler.attach(root);
  penDown(canvas, 50, 50, pointerType);
  return { handler, canvas, page, root, batches, predicted };
}

describe('prediction policy', () => {
  it('enables pen, disables mouse/touch/unknown by default', () => {
    expect(shouldPredictForPointerType('pen')).toBe(true);
    expect(shouldPredictForPointerType('mouse')).toBe(false);
    expect(shouldPredictForPointerType('touch')).toBe(false);
    expect(shouldPredictForPointerType('weird-pen')).toBe(false);
    expect(shouldPredictForPointerType('mouse', { allowMouse: true })).toBe(
      true,
    );
    expect(shouldPredictForPointerType('touch', { allowTouch: true })).toBe(
      true,
    );
    expect(shouldPredictForPointerType('pen', { enabled: false })).toBe(false);
  });

  it('kill-switch drops all predictions, confirmed drawing unchanged', () => {
    const on = predictedHarness('pen', {});
    moveWithPrediction(on.canvas, { x: 60, y: 50 }, 1001, [
      { x: 65, y: 50, ts: 1005 },
    ]);
    expect(on.predicted).toHaveLength(1);
    const confirmedOn = JSON.stringify(on.batches);
    on.handler.detach();
    on.page.remove();
    on.root.remove();

    const off = predictedHarness('pen', { enabled: false });
    moveWithPrediction(off.canvas, { x: 60, y: 50 }, 1001, [
      { x: 65, y: 50, ts: 1005 },
    ]);
    expect(off.predicted).toHaveLength(0);
    expect(JSON.stringify(off.batches)).toBe(confirmedOn);
    expect(off.handler.transportStats().predictedReceived).toBe(1);
    expect(off.handler.transportStats().predictedRetained).toBe(0);
    off.handler.detach();
    off.page.remove();
    off.root.remove();
  });

  it('mouse predictions stay disabled, touch needs explicit opt-in', () => {
    const mouse = predictedHarness('mouse', {});
    moveWithPrediction(
      mouse.canvas,
      { x: 60, y: 50 },
      1001,
      [{ x: 65, y: 50, ts: 1005 }],
      'mouse',
    );
    expect(mouse.predicted).toHaveLength(0);
    mouse.handler.detach();
    mouse.page.remove();
    mouse.root.remove();

    const touch = predictedHarness('touch', {});
    moveWithPrediction(
      touch.canvas,
      { x: 60, y: 50 },
      1001,
      [{ x: 65, y: 50, ts: 1005 }],
      'touch',
    );
    expect(touch.predicted).toHaveLength(0);
    touch.handler.detach();
    touch.page.remove();
    touch.root.remove();

    // Touch draws only when the surface doesn't reserve it for navigation;
    // the opt-in then bounds it like pen input.
    const touchAllowed = predictedHarness(
      'touch',
      { allowTouch: true },
      { cameraInteractive: false },
    );
    moveWithPrediction(
      touchAllowed.canvas,
      { x: 60, y: 50 },
      1001,
      [{ x: 65, y: 50, ts: 1005 }],
      'touch',
    );
    expect(touchAllowed.predicted).toHaveLength(1);
    touchAllowed.handler.detach();
    touchAllowed.page.remove();
    touchAllowed.root.remove();
  });
});

describe('prediction horizon', () => {
  it('clips extreme far-ahead browser predictions to nothing visible', () => {
    const h = predictedHarness('pen', {});
    // Confirmed at (60,50); browser predicts 450px ahead (several cm).
    moveWithPrediction(h.canvas, { x: 60, y: 50 }, 1001, [
      { x: 500, y: 50, ts: 1005 },
    ]);
    expect(h.predicted).toHaveLength(0);
    const stats = h.handler.transportStats();
    expect(stats.predictedReceived).toBe(1);
    expect(stats.predictedRetained).toBe(0);
    expect(stats.predictedScreenLengthPx).toBe(0);
    // Confirmed flowed normally (horizon never touches canonical input).
    expect(h.batches).toHaveLength(1);
    h.handler.detach();
    h.page.remove();
    h.root.remove();
  });

  it('trims curved predictions cumulatively to the screen-space horizon', () => {
    const h = predictedHarness('pen', {});
    // Confirmed frontier (60,50); five 10px steps curving away (50px total).
    moveWithPrediction(h.canvas, { x: 60, y: 50 }, 1001, [
      { x: 70, y: 50, ts: 1002 },
      { x: 80, y: 52, ts: 1003 },
      { x: 90, y: 56, ts: 1004 },
      { x: 100, y: 62, ts: 1005 },
      { x: 110, y: 70, ts: 1006 },
    ]);
    expect(h.predicted).toHaveLength(1);
    // 10 + ~10.2 = ~20.2 > 20: only the first step survives the 20px horizon.
    expect(h.predicted[0]).toHaveLength(1);
    expect(h.predicted[0]![0]).toEqual({ x: 70, y: 50 });
    expect(
      h.handler.transportStats().predictedScreenLengthPx,
    ).toBeLessThanOrEqual(PREDICTION_MAX_SCREEN_PX + 1e-9);
    h.handler.detach();
    h.page.remove();
    h.root.remove();
  });

  it.each([0.25, 0.5, 1, 4, 8])(
    'holds the same screen-space horizon at %sx zoom',
    (zoom) => {
      // Horizon is view/CSS-px, never surface units: identical view inputs
      // retain identical predictions at any camera zoom (else 0.25× would
      // flash 4× farther on screen than 8×). The harness constructs the
      // camera at the looped zoom so the horizon is exercised for real.
      const a = predictedHarness('pen', {}, {}, zoom);
      moveWithPrediction(a.canvas, { x: 60, y: 50 }, 1001, [
        { x: 70, y: 50, ts: 1002 },
        { x: 90, y: 50, ts: 1003 },
        { x: 200, y: 50, ts: 1004 },
      ]);
      const retained = a.predicted[0]?.length ?? 0;
      // 10px retained, +20px would exceed 20px → trimmed to the first step.
      expect(retained).toBe(1);
      a.handler.detach();
      a.page.remove();
      a.root.remove();
    },
  );

  it('drops far-future lookahead beyond one frame', () => {
    const h = predictedHarness('pen', {});
    // 5px away (inside the distance horizon) but 500ms in the future.
    moveWithPrediction(h.canvas, { x: 60, y: 50 }, 1000, [
      { x: 65, y: 50, ts: 1500 },
    ]);
    expect(h.predicted).toHaveLength(0);
    h.handler.detach();
    h.page.remove();
    h.root.remove();
  });

  it('never exceeds the configured CSS-pixel horizon', () => {
    const h = predictedHarness('pen', { maxScreenPx: 16 });
    moveWithPrediction(h.canvas, { x: 60, y: 50 }, 1001, [
      { x: 70, y: 50, ts: 1002 },
      { x: 76, y: 50, ts: 1003 },
      { x: 80, y: 50, ts: 1004 },
    ]);
    // 10 + 6 = 16 retained; the next 4px step would exceed → trimmed.
    expect(h.predicted[0]).toEqual([
      { x: 70, y: 50 },
      { x: 76, y: 50 },
    ]);
    expect(
      h.handler.transportStats().predictedScreenLengthPx,
    ).toBeLessThanOrEqual(16 + 1e-9);
    h.handler.detach();
    h.page.remove();
    h.root.remove();
  });
});

describe('prediction replacement', () => {
  it('replaces the tail frame-to-frame, latest clipped set only', () => {
    const { page, canvas, badge } = makeDom();
    const batches: { x: number; y: number }[][] = [];
    const predicted: { x: number; y: number }[][] = [];
    const handler = createPointerController({
      model: emptySurface(boundedFrame(800, 600)),
      controller: {
        camera: () => ({ x: 0, y: 0, zoom: 1 }),
        setCamera: () => undefined,
        pointerDown: () => undefined,
        pointerMove: () => undefined,
        pointerUp: () => undefined,
        pointerCancel: () => undefined,
        pointerBatch: (events) => {
          batches.push(events.map((e) => ({ ...e.point })));
        },
        pointerPredicted: (events) => {
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
      coalesceDrawInput: true,
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    handler.attach(root);
    penDown(canvas, 50, 50);
    // Two frames with different tails; the coalescer keeps the latest only,
    // and the horizon clips each to the screen budget.
    const fire = (cx: number, px: number, ts: number): void => {
      const event = new MouseEvent('pointermove', {
        bubbles: true,
        cancelable: true,
        clientX: cx,
        clientY: 50,
      }) as unknown as PointerEvent;
      Object.defineProperty(event, 'pointerId', { value: 1 });
      Object.defineProperty(event, 'pointerType', { value: 'pen' });
      Object.defineProperty(event, 'pressure', { value: 0.5 });
      Object.defineProperty(event, 'getCoalescedEvents', {
        value: () => [
          { clientX: cx, clientY: 50, pressure: 0.5, timeStamp: ts },
        ],
      });
      Object.defineProperty(event, 'getPredictedEvents', {
        value: () => [
          { clientX: px, clientY: 50, pressure: 0.5, timeStamp: ts + 4 },
        ],
      });
      canvas.dispatchEvent(event);
    };
    fire(60, 68, 1001);
    fire(62, 70, 1002);
    handler.flushPendingInputWithoutSchedulingRender();
    expect(batches).toHaveLength(1);
    // Only the latest tail renders (replacement, never appended).
    expect(predicted).toHaveLength(1);
    expect(predicted[0]).toEqual([{ x: 70, y: 50 }]);
    // Latest tail (62→70 = 8px) fits the horizon.
    expect(
      handler.transportStats().predictedScreenLengthPx,
    ).toBeLessThanOrEqual(PREDICTION_MAX_SCREEN_PX + 1e-9);
    handler.detach();
    page.remove();
    root.remove();
  });
});

describe('clipPredictedToHorizon (pure)', () => {
  it('returns empty without a frontier and skips non-finite points', () => {
    expect(
      clipPredictedToHorizon([{ point: { x: 1, y: 1 } } as never], null, 0)
        .retained,
    ).toEqual([]);
    const clipped = clipPredictedToHorizon(
      [{ point: { x: Number.NaN, y: 0 } }, { point: { x: 5, y: 0 } }] as never,
      { x: 0, y: 0 },
      0,
      { maxScreenPx: 20 },
    );
    expect(clipped.retained.map((s) => s.point)).toEqual([{ x: 5, y: 0 }]);
    expect(clipped.screenLengthPx).toBeCloseTo(5, 9);
  });
});
