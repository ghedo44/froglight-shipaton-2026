/**
 * Authoritative raw confirmed transport (live-writing repair §1).
 *
 * Reproduces the exact failure: confirmed samples consumed from BOTH
 * `pointerrawupdate` and `pointermove` with exact-identity dedup still
 * reorders when an older coalesced move arrives after a newer raw sample:
 *
 * ```text
 * raw:                  P4
 * pointermove coalesced: P2, P3, P4   (P4 echoes, P2/P3 look "fresh")
 * old canonical:        P1 → P4 → P2 → P3   (backtrack + long chords)
 * new canonical:        P1 → P4             (moves suppressed, never merged)
 * ```
 *
 * Runs at camera zoom 0.25×/0.5×/1×/4×/8× because the reorder's surface
 * distance (view distance / zoom) is visually amplified below 1×: the same
 * 20px view backtrack is 80 surface units at 0.25× vs 2.5 at 8×.
 */

import { describe, expect, it } from 'vitest';
import { createPointerController } from './pointer-controller.js';
import {
  emptySurface,
  boundedFrame,
  viewToSurface,
} from '@froglight/foundation';

const ZOOMS = [0.25, 0.5, 1, 4, 8] as const;

// View-space fixture (CSS px, canvas rect at origin so client == view).
const P1 = { x: 50, y: 50 };
const P2 = { x: 60, y: 50 };
const P3 = { x: 70, y: 50 };
const P4 = { x: 80, y: 50 };
const T1 = 1000;
const T2 = 1001;
const T3 = 1002;
const T4 = 1003;

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

function rawWith(
  canvas: HTMLCanvasElement,
  current: { x: number; y: number },
  coalesced: Array<{ x: number; y: number; ts: number }>,
  currentTs: number,
): void {
  const event = new MouseEvent('pointerrawupdate', {
    bubbles: true,
    cancelable: true,
    clientX: current.x,
    clientY: current.y,
  }) as unknown as PointerEvent;
  Object.defineProperty(event, 'pointerId', { value: 1 });
  Object.defineProperty(event, 'pointerType', { value: 'pen' });
  Object.defineProperty(event, 'pressure', { value: 0.5 });
  Object.defineProperty(event, 'timeStamp', { value: currentTs });
  Object.defineProperty(event, 'getCoalescedEvents', {
    value: () =>
      coalesced.map((p) => ({
        clientX: p.x,
        clientY: p.y,
        pressure: 0.5,
        timeStamp: p.ts,
      })),
  });
  Object.defineProperty(event, 'getPredictedEvents', { value: () => [] });
  canvas.dispatchEvent(event);
}

function moveWith(
  canvas: HTMLCanvasElement,
  current: { x: number; y: number },
  coalesced: Array<{ x: number; y: number; ts: number }>,
  currentTs: number,
): void {
  const event = new MouseEvent('pointermove', {
    bubbles: true,
    cancelable: true,
    clientX: current.x,
    clientY: current.y,
  }) as unknown as PointerEvent;
  Object.defineProperty(event, 'pointerId', { value: 1 });
  Object.defineProperty(event, 'pointerType', { value: 'pen' });
  Object.defineProperty(event, 'pressure', { value: 0.5 });
  Object.defineProperty(event, 'timeStamp', { value: currentTs });
  Object.defineProperty(event, 'getCoalescedEvents', {
    value: () =>
      coalesced.map((p) => ({
        clientX: p.x,
        clientY: p.y,
        pressure: 0.5,
        timeStamp: p.ts,
      })),
  });
  Object.defineProperty(event, 'getPredictedEvents', { value: () => [] });
  canvas.dispatchEvent(event);
}

describe.each(ZOOMS)('authoritative raw transport at %sx zoom', (zoom) => {
  it('never reorders overlapping raw + coalesced move input', () => {
    const { page, canvas, badge } = makeDom();
    const confirmed: { x: number; y: number }[] = [];
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
          for (const e of events) confirmed.push({ ...e.point });
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
      pointerRawUpdate: 'always',
      predictionPolicy: { maxScreenPx: 100000, maxLookaheadMs: 1000000 },
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    handler.attach(root);

    downAt(canvas, P1, T1);
    // Newer raw sample arrives first…
    rawWith(canvas, P4, [{ ...P4, ts: T4 }], T4);
    // …then the older coalesced move (P2/P3 look "fresh" by identity —
    // only P4 is an exact echo). Merging would append P2→P3 after P4.
    moveWith(
      canvas,
      P4,
      [
        { ...P2, ts: T2 },
        { ...P3, ts: T3 },
        { ...P4, ts: T4 },
      ],
      T4,
    );

    // Canonical view order never backtracks: P2/P3 are suppressed, never
    // appended after P4. (Synchronous dispatch: no rAF flush needed.)
    expect(confirmed).toEqual([P4]);

    // Surface trajectory stays temporally/spatially ordered at this zoom:
    // monotonic x (no P4→P2 backtrack), and zero backward distance. The
    // P1→P4 forward gap reflects the fixture's raw batching (raw delivered
    // only P4); the artifact under test is the backward reorder, which must
    // be absent. Absolute length gates belong to the realistic e2e fixture
    // (raw delivers every sample); here direction is the signal.
    const camera = { x: 0, y: 0, zoom };
    const surface = [P1, ...confirmed].map((p) => viewToSurface(camera, p));
    for (let i = 1; i < surface.length; i++) {
      expect(surface[i]!.x).toBeGreaterThanOrEqual(surface[i - 1]!.x);
    }
    let backward = 0;
    for (let i = 1; i < surface.length; i++) {
      backward += Math.max(0, surface[i - 1]!.x - surface[i]!.x);
    }
    expect(backward).toBe(0);

    const stats = handler.transportStats();
    expect(stats.rawConfirmed).toBe(1);
    expect(stats.moveSuppressedRawOwned).toBe(2);
    expect(stats.moveConfirmed).toBe(0);

    handler.detach();
    page.remove();
    root.remove();
  });

  it('falls back to move confirmed input when raw never arrives', () => {
    const { page, canvas, badge } = makeDom();
    const confirmed: { x: number; y: number }[] = [];
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
          for (const e of events) confirmed.push({ ...e.point });
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
      pointerRawUpdate: 'always',
      predictionPolicy: { maxScreenPx: 100000, maxLookaheadMs: 1000000 },
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    handler.attach(root);

    downAt(canvas, P1, T1);
    // No rawupdate fires at all (genuinely unavailable): moves own input.
    moveWith(canvas, P2, [{ ...P2, ts: T2 }], T2);
    moveWith(canvas, P3, [{ ...P3, ts: T3 }], T3);
    expect(confirmed).toEqual([P2, P3]);
    expect(handler.transportStats().rawFallbackActivations).toBe(1);
    expect(handler.transportStats().moveConfirmed).toBe(2);

    handler.detach();
    page.remove();
    root.remove();
  });
});
