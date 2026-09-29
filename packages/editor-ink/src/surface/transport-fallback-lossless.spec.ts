/**
 * Lossless raw→move fallback (live-writing repair §1–§2).
 *
 * While raw owns confirmed input, fresh moves buffer as fallback
 * candidates instead of being dropped. Raw resuming discards them;
 * raw remaining absent past the elapsed-time stall threshold latches
 * move ownership and releases them in safe order (never behind the raw
 * frontier). Pointerup resolves any buffered candidates plus genuinely
 * new up samples so no movement disappears at lift.
 *
 * Parameterized at 0.25×/0.5× (where users reproduce the split/chord)
 * plus 1×/4×/8× for horizon parity. View-space fixture (CSS px, canvas
 * rect at origin so client == view).
 */

import { describe, expect, it } from 'vitest';
import { createPointerController } from './pointer-controller.js';
import {
  emptySurface,
  boundedFrame,
  viewToSurface,
} from '@froglight/foundation';

const ZOOMS = [0.25, 0.5, 1, 4, 8] as const;

const P1 = { x: 50, y: 50 };
const P2 = { x: 60, y: 50 };
const P3 = { x: 70, y: 50 };
const P4 = { x: 80, y: 50 };
const P5 = { x: 90, y: 50 };
const P6 = { x: 100, y: 50 };
const T1 = 1000;
const T2 = 1001;
const T3 = 1002;
const T4 = 1003;
const T5 = 1020;
const T6 = 1045;

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

function makeHandler(
  zoom: number,
  confirmed: { x: number; y: number }[],
  ups: { x: number; y: number }[],
  batches: { x: number; y: number }[][],
) {
  const { page, canvas, badge } = makeDom();
  const handler = createPointerController({
    model: emptySurface(boundedFrame(800, 600)),
    controller: {
      camera: () => ({ x: 0, y: 0, zoom }),
      setCamera: () => undefined,
      pointerDown: () => undefined,
      pointerMove: () => undefined,
      pointerUp: (e) => void ups.push({ ...e.point }),
      pointerCancel: () => undefined,
      pointerBatch: (events) => {
        const batch = events.map((e) => ({ ...e.point }));
        batches.push(batch);
        for (const p of batch) confirmed.push({ ...p });
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
  return { handler, page, canvas, root };
}

describe.each(ZOOMS)('lossless raw→move fallback at %sx zoom', (zoom) => {
  it('buffers stalled moves and releases them in order (zero loss)', () => {
    const confirmed: { x: number; y: number }[] = [];
    const ups: { x: number; y: number }[] = [];
    const batches: { x: number; y: number }[][] = [];
    const { handler, page, canvas, root } = makeHandler(
      zoom,
      confirmed,
      ups,
      batches,
    );

    downAt(canvas, P1, T1);
    rawWith(canvas, P4, [{ ...P4, ts: T4 }], T4);
    // Raw stalls: two fresh moves arrive with no interleaving raw. The
    // first buffers (17ms elapsed, under the 32ms timeout); the second
    // arrives 42ms after the last raw and latches, releasing BOTH.
    moveWith(canvas, P5, [{ ...P5, ts: T5 }], T5);
    expect(confirmed).toEqual([P4]);
    expect(handler.transportStats().rawFallbackActivations).toBe(0);
    moveWith(canvas, P6, [{ ...P6, ts: T6 }], T6);
    expect(handler.transportStats().rawFallbackActivations).toBe(1);
    // Zero loss: P5 (move #1) plus P6 (triggering move) both committed.
    expect(confirmed).toEqual([P4, P5, P6]);

    // Surface trajectory stays ordered at this zoom (no backtrack).
    const camera = { x: 0, y: 0, zoom };
    const surface = [P1, ...confirmed].map((p) => viewToSurface(camera, p));
    for (let i = 1; i < surface.length; i++) {
      expect(surface[i]!.x).toBeGreaterThanOrEqual(surface[i - 1]!.x);
    }

    handler.detach();
    page.remove();
    root.remove();
    void ups;
    void batches;
  });

  it('releases a large fallback batch without truncating tiny movement', () => {
    const confirmed: { x: number; y: number }[] = [];
    const { handler, page, canvas, root } = makeHandler(
      zoom,
      confirmed,
      [],
      [],
    );
    downAt(canvas, P1, T1);
    rawWith(canvas, P4, [{ ...P4, ts: T4 }], T4);
    const samples = Array.from({ length: 100 }, (_, i) => ({
      x: P4.x + (i + 1) * 0.01,
      y: P4.y + Math.sin(i / 10),
      ts: T4 + i + 1,
    }));
    moveWith(canvas, samples[99]!, samples, samples[99]!.ts);
    expect(confirmed).toEqual([P4, ...samples.map(({ x, y }) => ({ x, y }))]);
    handler.detach();
    page.remove();
    root.remove();
  });

  it('deduplicates overlapping buffered batches before release', () => {
    const confirmed: { x: number; y: number }[] = [];
    const { handler, page, canvas, root } = makeHandler(
      zoom,
      confirmed,
      [],
      [],
    );
    downAt(canvas, P1, T1);
    rawWith(canvas, P4, [{ ...P4, ts: T4 }], T4);
    moveWith(canvas, P5, [{ ...P5, ts: T5 }], T5);
    moveWith(
      canvas,
      P6,
      [
        { ...P5, ts: T5 },
        { ...P6, ts: T6 },
      ],
      T6,
    );
    expect(confirmed).toEqual([P4, P5, P6]);
    handler.detach();
    page.remove();
    root.remove();
  });

  it('never appends stale samples behind the raw frontier', () => {
    const confirmed: { x: number; y: number }[] = [];
    const ups: { x: number; y: number }[] = [];
    const batches: { x: number; y: number }[][] = [];
    const { handler, page, canvas, root } = makeHandler(
      zoom,
      confirmed,
      ups,
      batches,
    );

    downAt(canvas, P1, T1);
    rawWith(canvas, P4, [{ ...P4, ts: T4 }], T4);
    // Stale coalesced history behind the frontier: dropped, never
    // buffered, never committed after P4.
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
    expect(confirmed).toEqual([P4]);
    // Genuine stall after the stale echo still releases losslessly.
    moveWith(canvas, P5, [{ ...P5, ts: T5 }], T5);
    moveWith(canvas, P6, [{ ...P6, ts: T6 }], T6);
    expect(confirmed).toEqual([P4, P5, P6]);
    // No P4 → older P2/P3 reorder anywhere in the committed sequence.
    const xs = [P1, ...confirmed].map((p) => p.x);
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i]).toBeGreaterThanOrEqual(xs[i - 1]);
    }

    handler.detach();
    page.remove();
    root.remove();
    void ups;
    void batches;
  });

  it('preserves samples when raw stops immediately before pointerup', () => {
    const confirmed: { x: number; y: number }[] = [];
    const ups: { x: number; y: number }[] = [];
    const batches: { x: number; y: number }[][] = [];
    const { handler, page, canvas, root } = makeHandler(
      zoom,
      confirmed,
      ups,
      batches,
    );

    downAt(canvas, P1, T1);
    rawWith(canvas, P4, [{ ...P4, ts: T4 }], T4);
    // Raw stops; the lift carries the only record of P5→P6.
    const upEvent = new MouseEvent('pointerup', {
      bubbles: true,
      cancelable: true,
      clientX: P6.x,
      clientY: P6.y,
      button: 0,
    }) as unknown as PointerEvent;
    Object.defineProperty(upEvent, 'pointerId', { value: 1 });
    Object.defineProperty(upEvent, 'pointerType', { value: 'pen' });
    Object.defineProperty(upEvent, 'pressure', { value: 0.5 });
    Object.defineProperty(upEvent, 'timeStamp', { value: T6 });
    Object.defineProperty(upEvent, 'getCoalescedEvents', {
      value: () => [
        { clientX: P5.x, clientY: P5.y, pressure: 0.5, timeStamp: T5 },
        { clientX: P6.x, clientY: P6.y, pressure: 0.5, timeStamp: T6 },
      ],
    });
    Object.defineProperty(upEvent, 'getPredictedEvents', { value: () => [] });
    canvas.dispatchEvent(upEvent);

    // P4 → P5 → P6 preserved: P5 flows through the batch head, P6 closes.
    // Without the fix this collapsed to P4 → P6 (P5 lost).
    expect(confirmed).toEqual([P4, P5]);
    expect(ups).toEqual([P6]);

    handler.detach();
    page.remove();
    root.remove();
    void batches;
  });
});
