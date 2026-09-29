/**
 * Pointer-controller decision tests.
 *
 * Deterministic routing: palm rejection, embedded delegation, and hover
 * cursors are covered without mounting the full surface engine.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import {
  createPointerController,
  type PointerControllerDeps,
} from './pointer-controller.js';
import { SurfaceGestureHistory } from './history.js';
import {
  emptySurface,
  boundedFrame,
  GESTURE_THRESHOLDS,
} from '@froglight/foundation';

function makeDom() {
  const page = document.createElement('div');
  const canvas = document.createElement('canvas');
  const badge = document.createElement('div');
  page.appendChild(canvas);
  document.body.appendChild(page);
  // jsdom rects are zero; give the canvas a stable box for view math.
  canvas.getBoundingClientRect = () =>
    ({ left: 10, top: 20, width: 800, height: 600 }) as DOMRect;
  return { page, canvas, badge };
}

function makeDeps(overrides: Partial<PointerControllerDeps> = {}) {
  const { page, canvas, badge } = makeDom();
  const model = emptySurface(boundedFrame(800, 600));
  const cameras: Array<{ x: number; y: number; zoom: number }> = [];
  const controller = {
    camera: () => ({ x: 0, y: 0, zoom: 1 }),
    setCamera: (c: { x: number; y: number; zoom: number }) => {
      cameras.push(c);
    },
    pointerDown: () => undefined,
    pointerMove: () => undefined,
    pointerUp: () => undefined,
    pointerCancel: () => undefined,
    panBy: () => undefined,
    selection: () => [] as readonly string[],
    setSelection: () => undefined,
    resizeObject: () => undefined,
  };
  const deps: PointerControllerDeps = {
    model,
    controller,
    canvas,
    page,
    badge,
    navigationMode: 'standalone',
    cameraInteractive: true,
    frameResizable: true,
    delegateTouchNavigation: undefined,
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
    ...overrides,
  };
  return { deps, page, canvas, badge, model, controller, cameras };
}

function pointerDown(
  canvas: HTMLCanvasElement,
  id: number,
  x: number,
  y: number,
  pointerType = 'mouse',
  pressure = 0.5,
): void {
  const event = new MouseEvent('pointerdown', {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
  }) as unknown as PointerEvent;
  Object.defineProperty(event, 'pointerId', { value: id });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  Object.defineProperty(event, 'pressure', { value: pressure });
  canvas.dispatchEvent(event);
}

function pointerCancel(canvas: HTMLCanvasElement, id: number): void {
  const event = new Event('pointercancel', {
    bubbles: true,
    cancelable: true,
  }) as unknown as PointerEvent;
  Object.defineProperty(event, 'pointerId', { value: id });
  canvas.dispatchEvent(event);
}

function pointerUp(
  canvas: HTMLCanvasElement,
  id: number,
  x = 60,
  y = 60,
  pressure = 0,
): void {
  // Real pointerup events always carry client coords; include them so the
  // final sample closes the gesture (coord-less synthetic events are
  // dropped as malformed input, never committed).
  const event = new MouseEvent('pointerup', {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
  }) as unknown as PointerEvent;
  Object.defineProperty(event, 'pointerId', { value: id });
  Object.defineProperty(event, 'pressure', { value: pressure });
  canvas.dispatchEvent(event);
}

function pointerMove(
  canvas: HTMLCanvasElement,
  id: number,
  x: number,
  y: number,
): void {
  const event = new MouseEvent('pointermove', {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
  }) as unknown as PointerEvent;
  Object.defineProperty(event, 'pointerId', { value: id });
  canvas.dispatchEvent(event);
}

function pointerMoveBatch(
  canvas: HTMLCanvasElement,
  id: number,
  current: { x: number; y: number },
  coalesced: Array<{ x: number; y: number }>,
  predicted: Array<{ x: number; y: number }> = [],
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
    timeStamp: 2000,
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

function pointerUpBatch(
  canvas: HTMLCanvasElement,
  id: number,
  current: { x: number; y: number },
  coalesced: Array<{ x: number; y: number }>,
): void {
  const event = new Event('pointerup', {
    bubbles: true,
    cancelable: true,
  }) as unknown as PointerEvent;
  const sample = (p: { x: number; y: number }) => ({
    clientX: p.x,
    clientY: p.y,
    pressure: 0.5,
    timeStamp: 2000,
  });
  Object.defineProperty(event, 'pointerId', { value: id });
  Object.defineProperty(event, 'pointerType', { value: 'pen' });
  Object.defineProperty(event, 'pressure', { value: 0.5 });
  Object.defineProperty(event, 'clientX', { value: current.x });
  Object.defineProperty(event, 'clientY', { value: current.y });
  Object.defineProperty(event, 'getCoalescedEvents', {
    value: () => coalesced.map(sample),
  });
  canvas.dispatchEvent(event);
}

describe('pointer controller routing', () => {
  it('delegates touch to the parent when delegateTouchNavigation is set', () => {
    const { deps, canvas, page } = makeDeps({ delegateTouchNavigation: true });
    const root = document.createElement('div');
    document.body.appendChild(root);
    const handler = createPointerController(deps);
    handler.attach(root);
    pointerDown(canvas, 1, 100, 100, 'touch');
    expect(handler.debugState().pointers).toHaveLength(0);
    expect(page.classList.contains('panning')).toBe(false);
    handler.detach();
    page.remove();
    root.remove();
  });

  it('rejects a touch that arrives mid-draw without disturbing the stroke', () => {
    const { deps, canvas, page } = makeDeps();
    const root = document.createElement('div');
    document.body.appendChild(root);
    const handler = createPointerController(deps);
    handler.attach(root);
    pointerDown(canvas, 1, 50, 50, 'pen');
    expect(handler.debugState().mode).toBe('draw');
    pointerDown(canvas, 2, 400, 400, 'touch');
    expect(handler.debugState().pointers).toHaveLength(1);
    handler.detach();
    page.remove();
    root.remove();
  });

  it('shows resize cursors on hover without capturing', () => {
    const { deps, canvas, page } = makeDeps();
    const root = document.createElement('div');
    document.body.appendChild(root);
    const handler = createPointerController(deps);
    handler.attach(root);
    const move = new MouseEvent('pointermove', {
      bubbles: true,
      cancelable: true,
      clientX: 10,
      clientY: 20,
    }) as unknown as PointerEvent;
    Object.defineProperty(move, 'pointerId', { value: 99 });
    canvas.dispatchEvent(move);
    // East border of the 800-wide sheet at zoom 1 sits at view x=800;
    // clientX = 10 (rect left) + 800 = 810.
    const east = new MouseEvent('pointermove', {
      bubbles: true,
      cancelable: true,
      clientX: 810,
      clientY: 320,
    }) as unknown as PointerEvent;
    Object.defineProperty(east, 'pointerId', { value: 99 });
    canvas.dispatchEvent(east);
    expect(page.style.cursor).toBe('ew-resize');
    handler.detach();
    page.remove();
    root.remove();
  });

  it('pointercancel aborts mouse authoring and leaves the next gesture functional', () => {
    let ups = 0;
    let cancels = 0;
    const { deps, canvas, page } = makeDeps({
      controller: undefined as never,
    });
    const tracking = {
      camera: () => ({ x: 0, y: 0, zoom: 1 }),
      setCamera: () => undefined,
      pointerDown: () => undefined,
      pointerMove: () => undefined,
      pointerUp: () => {
        ups += 1;
      },
      pointerCancel: () => {
        cancels += 1;
      },
      panBy: () => undefined,
      selection: () => [] as readonly string[],
      setSelection: () => undefined,
      resizeObject: () => undefined,
    };
    const withTracking = { ...deps, controller: tracking };
    const root = document.createElement('div');
    document.body.appendChild(root);
    const handler = createPointerController(withTracking);
    handler.attach(root);
    pointerDown(canvas, 1, 50, 50, 'mouse');
    expect(handler.debugState().mode).toBe('draw');
    pointerCancel(canvas, 1);
    expect(cancels).toBe(1);
    expect(ups).toBe(0);
    expect(handler.debugState().mode).toBe('idle');
    expect(handler.debugState().pointers).toHaveLength(0);
    expect(page.classList.contains('panning')).toBe(false);
    // Next gesture works normally.
    pointerDown(canvas, 2, 60, 60, 'pen');
    expect(handler.debugState().mode).toBe('draw');
    pointerUp(canvas, 2);
    expect(ups).toBe(1);
    handler.detach();
    page.remove();
    root.remove();
  });

  it('cancel of a frame resize rolls back frame, camera, and history', () => {
    let begins = 0;
    let commits = 0;
    let cancels = 0;
    const { deps, canvas, page } = makeDeps();
    const history = new SurfaceGestureHistory(deps.model);
    const wired = {
      ...deps,
      beginHistoryGesture: () => {
        begins += 1;
        history.beginGesture();
      },
      commitHistoryGesture: () => {
        commits += 1;
        history.commitGesture();
      },
      cancelHistoryGesture: () => {
        cancels += 1;
        history.cancelGesture();
      },
    };
    const root = document.createElement('div');
    document.body.appendChild(root);
    const handler = createPointerController(wired);
    handler.attach(root);
    const beforeFrame = JSON.stringify(wired.model.frame);
    const beforeCamera = deps.controller.camera();
    // East border down starts a frame resize.
    pointerDown(canvas, 1, 810, 320, 'mouse');
    expect(handler.debugState().mode).toBe('resize');
    expect(begins).toBe(1);
    pointerMove(canvas, 1, 860, 320);
    expect(JSON.stringify(wired.model.frame)).not.toBe(beforeFrame);
    pointerCancel(canvas, 1);
    expect(cancels).toBe(1);
    expect(commits).toBe(0);
    expect(JSON.stringify(wired.model.frame)).toBe(beforeFrame);
    expect(wired.controller.camera()).toEqual(beforeCamera);
    expect(handler.debugState().mode).toBe('idle');
    handler.detach();
    page.remove();
    root.remove();
  });

  it('captures the first pointer that presses a frame resize corner', () => {
    const { deps, canvas, page } = makeDeps();
    const capture = vi.fn();
    canvas.setPointerCapture = capture;
    const root = document.createElement('div');
    document.body.appendChild(root);
    const handler = createPointerController(deps);
    handler.attach(root);

    // The south-east handle is centered on the canvas boundary. Capture on
    // the initial press so an outward first move remains part of this drag.
    pointerDown(canvas, 1, 810, 620, 'mouse');

    expect(handler.debugState().mode).toBe('resize');
    expect(capture).toHaveBeenCalledExactlyOnceWith(1);
    handler.detach();
    page.remove();
    root.remove();
  });

  it.each([
    ['edge', 810, 320],
    ['corner', 810, 620],
  ])('resizes the frame with a finger from the %s', (_name, x, y) => {
    const { deps, canvas, page } = makeDeps();
    const root = document.createElement('div');
    document.body.appendChild(root);
    const handler = createPointerController(deps);
    handler.attach(root);

    pointerDown(canvas, 1, x, y, 'touch');
    expect(handler.debugState().mode).toBe('resize');
    pointerMove(canvas, 1, x + 40, y + 40);
    pointerUp(canvas, 1, x + 40, y + 40);
    expect(deps.model.frame?.width).toBeGreaterThan(800);
    expect(handler.debugState().mode).toBe('idle');

    handler.detach();
    page.remove();
    root.remove();
  });

  it('routes document-level Space pan before text and frame authoring on the first drag', () => {
    let textOpens = 0;
    let userNavigated = false;
    const { deps, canvas, page, cameras } = makeDeps({
      getActiveToolId: () => 'froglight.ink.text',
      openTextOverlay: () => {
        textOpens += 1;
      },
      setUserNavigated: (value) => {
        userNavigated = value;
      },
    });
    const root = document.createElement('div');
    const toolbarButton = document.createElement('button');
    document.body.append(root, toolbarButton);
    const handler = createPointerController(deps);
    handler.attach(root);

    // Real focus remains on toolbar chrome. Hover establishes which mounted
    // surface owns the temporary Space gesture without hijacking the button.
    toolbarButton.focus();
    pointerMove(canvas, 99, 810, 320);
    document.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: ' ',
        bubbles: true,
        cancelable: true,
      }),
    );
    pointerDown(canvas, 1, 810, 320, 'mouse');
    pointerMove(canvas, 1, 760, 320);

    expect(handler.debugState().mode).toBe('pan');
    expect(textOpens).toBe(0);
    expect(cameras.some((camera) => camera.x !== 0)).toBe(true);
    expect(userNavigated).toBe(true);
    expect(deps.model.frame).toEqual(boundedFrame(800, 600));

    pointerUp(canvas, 1, 760, 320);
    document.dispatchEvent(
      new KeyboardEvent('keyup', { key: ' ', bubbles: true }),
    );
    handler.detach();
    page.remove();
    root.remove();
    toolbarButton.remove();
  });

  describe('input batching', () => {
    function batchWired() {
      const batches: Array<{ x: number; y: number }[]> = [];
      const predicted: Array<{ x: number; y: number }[]> = [];
      const moves: Array<{ x: number; y: number }> = [];
      const ups: Array<{ x: number; y: number }> = [];
      const { deps, canvas, page } = makeDeps();
      const controller = {
        ...deps.controller,
        pointerMove: (event: { point: { x: number; y: number } }) => {
          moves.push({ ...event.point });
        },
        pointerUp: (event: { point: { x: number; y: number } }) => {
          ups.push({ ...event.point });
        },
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
      };
      return {
        // Generous horizon isolates batching/transport assertions from the
        // prediction-horizon policy (covered by dedicated horizon specs).
        wired: {
          ...deps,
          controller,
          predictionPolicy: {
            maxScreenPx: 100000,
            maxLookaheadMs: 1000000,
          },
        },
        canvas,
        page,
        batches,
        predicted,
        moves,
        ups,
      };
    }

    it('reads canvas geometry once per pointermove and dispatches one batch', () => {
      const { wired, canvas, page, batches } = batchWired();
      let rectReads = 0;
      canvas.getBoundingClientRect = () => {
        rectReads += 1;
        return { left: 10, top: 20, width: 800, height: 600 } as DOMRect;
      };
      const root = document.createElement('div');
      document.body.appendChild(root);
      const handler = createPointerController(wired);
      handler.attach(root);
      pointerDown(canvas, 1, 50, 50, 'pen');
      rectReads = 0;
      // Canvas rect is (10,20): client (60,70) is view (50,50).
      pointerMoveBatch(canvas, 1, { x: 70, y: 80 }, [
        { x: 60, y: 70 },
        { x: 65, y: 75 },
        { x: 70, y: 80 },
      ]);
      expect(rectReads).toBe(1);
      expect(batches).toHaveLength(1);
      expect(batches[0]).toEqual([
        { x: 50, y: 50 },
        { x: 55, y: 55 },
        { x: 60, y: 60 },
      ]);
      handler.detach();
      page.remove();
      root.remove();
    });

    it('forwards predicted samples separately from the confirmed batch', () => {
      const { wired, canvas, page, batches, predicted } = batchWired();
      const root = document.createElement('div');
      document.body.appendChild(root);
      const handler = createPointerController(wired);
      handler.attach(root);
      pointerDown(canvas, 1, 50, 50, 'pen');
      pointerMoveBatch(
        canvas,
        1,
        { x: 70, y: 80 },
        [
          { x: 60, y: 70 },
          { x: 70, y: 80 },
        ],
        [
          { x: 80, y: 90 },
          { x: 90, y: 100 },
        ],
      );
      expect(batches).toHaveLength(1);
      expect(batches[0]).toEqual([
        { x: 50, y: 50 },
        { x: 60, y: 60 },
      ]);
      expect(predicted).toHaveLength(1);
      expect(predicted[0]).toEqual([
        { x: 70, y: 70 },
        { x: 80, y: 80 },
      ]);
      handler.detach();
      page.remove();
      root.remove();
    });

    it('falls back to per-sample pointerMove without batch support', () => {
      const { deps, canvas, page } = makeDeps();
      const moves: Array<{ x: number; y: number }> = [];
      const legacy = {
        ...deps.controller,
        pointerMove: (event: { point: { x: number; y: number } }) => {
          moves.push({ ...event.point });
        },
      };
      // No pointerBatch on the port: every coalesced sample routes singly.
      expect('pointerBatch' in legacy).toBe(false);
      const root = document.createElement('div');
      document.body.appendChild(root);
      const handler = createPointerController({ ...deps, controller: legacy });
      handler.attach(root);
      pointerDown(canvas, 1, 50, 50, 'pen');
      pointerMoveBatch(canvas, 1, { x: 70, y: 80 }, [
        { x: 60, y: 70 },
        { x: 65, y: 75 },
        { x: 70, y: 80 },
      ]);
      expect(moves).toEqual([
        { x: 50, y: 50 },
        { x: 55, y: 55 },
        { x: 60, y: 60 },
      ]);
      handler.detach();
      page.remove();
      root.remove();
    });

    it('schedules exactly one render per pointermove batch', () => {
      let renders = 0;
      const { deps, canvas, page } = makeDeps({
        scheduleRender: () => {
          renders += 1;
        },
      });
      const controller = {
        ...deps.controller,
        pointerBatch: () => undefined,
        pointerPredicted: () => undefined,
      };
      const root = document.createElement('div');
      document.body.appendChild(root);
      const handler = createPointerController({ ...deps, controller });
      handler.attach(root);
      pointerDown(canvas, 1, 50, 50, 'pen');
      renders = 0;
      pointerMoveBatch(
        canvas,
        1,
        { x: 70, y: 80 },
        [
          { x: 60, y: 70 },
          { x: 65, y: 75 },
          { x: 70, y: 80 },
        ],
        [{ x: 80, y: 90 }],
      );
      // One DOM event → one batch → one frame, even with predicted samples.
      expect(renders).toBe(1);
      handler.detach();
      page.remove();
      root.remove();
    });

    it('flushes coalesced samples on pointerup before the final up', () => {
      const { wired, canvas, page, batches, ups } = batchWired();
      const root = document.createElement('div');
      document.body.appendChild(root);
      const handler = createPointerController(wired);
      handler.attach(root);
      pointerDown(canvas, 1, 50, 50, 'pen');
      pointerUpBatch(canvas, 1, { x: 70, y: 80 }, [
        { x: 60, y: 70 },
        { x: 70, y: 80 },
      ]);
      expect(batches).toHaveLength(1);
      expect(batches[0]).toEqual([{ x: 50, y: 50 }]);
      expect(ups).toEqual([{ x: 60, y: 60 }]);
      handler.detach();
      page.remove();
      root.remove();
    });

    it('does not commit the terminal pointerup pressure reset', () => {
      const upEvents: Array<{
        point: { x: number; y: number };
        pressure?: number;
      }> = [];
      const { deps, canvas, page } = makeDeps();
      const controller = {
        ...deps.controller,
        pointerUp: (event: {
          point: { x: number; y: number };
          pressure?: number;
        }) => {
          upEvents.push(event);
        },
      };
      const root = document.createElement('div');
      document.body.appendChild(root);
      const handler = createPointerController({ ...deps, controller });
      handler.attach(root);
      pointerDown(canvas, 1, 50, 50, 'pen', 0.9);
      pointerUp(canvas, 1, 50, 50, 0);
      expect(upEvents).toHaveLength(1);
      expect(upEvents[0]).toMatchObject({
        point: { x: 40, y: 30 },
        pressure: 0.9,
      });
      handler.detach();
      page.remove();
      root.remove();
    });
  });

  it.each(['pointercancel', 'lostpointercapture'])(
    '%s retains confirmed pen input and accepts the next stroke',
    (type) => {
      const { deps, canvas, page } = makeDeps({ coalesceDrawInput: true });
      const up = vi.fn();
      const cancel = vi.fn();
      const move = vi.fn();
      const handler = createPointerController({
        ...deps,
        controller: {
          ...deps.controller,
          pointerUp: up,
          pointerCancel: cancel,
          pointerMove: move,
        },
      });
      handler.attach(page);
      pointerDown(canvas, 1, 60, 60, 'pen');
      pointerMove(canvas, 1, 90, 80);
      const interruption = new Event(type, { bubbles: true });
      Object.defineProperty(interruption, 'pointerId', { value: 1 });
      canvas.dispatchEvent(interruption);
      expect(move).toHaveBeenCalled();
      expect(up).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ point: { x: 80, y: 60 } }),
      );
      expect(cancel).not.toHaveBeenCalled();
      expect(handler.debugState().mode).toBe('idle');
      pointerDown(canvas, 2, 60, 60, 'pen');
      pointerUp(canvas, 2, 90, 80);
      expect(up).toHaveBeenCalledTimes(2);
      handler.detach();
      page.remove();
    },
  );

  it('lostpointercapture rolls back mouse authoring', () => {
    let cancels = 0;
    let ups = 0;
    const { deps, canvas, page } = makeDeps({
      cancelHistoryGesture: () => (cancels += 1),
      commitHistoryGesture: () => undefined,
    });
    const tracking = {
      camera: () => ({ x: 0, y: 0, zoom: 1 }),
      setCamera: () => undefined,
      pointerDown: () => undefined,
      pointerMove: () => undefined,
      pointerUp: () => {
        ups += 1;
      },
      pointerCancel: () => {
        cancels += 1;
      },
      panBy: () => undefined,
      selection: () => [] as readonly string[],
      setSelection: () => undefined,
      resizeObject: () => undefined,
    };
    const withTracking = { ...deps, controller: tracking };
    const root = document.createElement('div');
    document.body.appendChild(root);
    const handler = createPointerController(withTracking);
    handler.attach(root);
    pointerDown(canvas, 1, 50, 50, 'mouse');
    const lost = new Event('lostpointercapture', {
      bubbles: true,
      cancelable: true,
    }) as unknown as PointerEvent;
    Object.defineProperty(lost, 'pointerId', { value: 1 });
    canvas.dispatchEvent(lost);
    expect(ups).toBe(0);
    expect(cancels).toBeGreaterThan(0);
    expect(handler.debugState().mode).toBe('idle');
    handler.detach();
    page.remove();
    root.remove();
  });

  it('keeps restored hover after normal pointerup releases capture', () => {
    const updates: boolean[] = [];
    let resets = 0;
    const { deps, canvas, page } = makeDeps({
      cursorPresenter: {
        update: (sample) => updates.push(sample.contact),
        refresh: () => undefined,
        leave: () => undefined,
        reset: () => (resets += 1),
        destroy: () => undefined,
      },
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    const handler = createPointerController(deps);
    handler.attach(root);

    pointerDown(canvas, 1, 50, 50, 'mouse');
    pointerUp(canvas, 1, 60, 60);
    const lost = new Event('lostpointercapture', {
      bubbles: true,
      cancelable: true,
    }) as unknown as PointerEvent;
    Object.defineProperty(lost, 'pointerId', { value: 1 });
    canvas.dispatchEvent(lost);

    expect(updates.at(-1)).toBe(false);
    expect(resets).toBe(0);
    handler.detach();
    page.remove();
    root.remove();
  });
});

describe('tool keymap', () => {
  it('handles undo/redo exactly once when nested in a pager root', () => {
    // Notebook regression (PWA offline suite): the pager root above the
    // surface also handles meta+z by delegating to the same page history.
    // One keypress must pop exactly one entry — never a drag revert plus
    // the previous stroke creation.
    let undos = 0;
    let redos = 0;
    const { deps, page } = makeDeps({
      requestUndo: () => {
        undos += 1;
        return true;
      },
      requestRedo: () => {
        redos += 1;
        return true;
      },
    });
    const pagerRoot = document.createElement('div');
    const surfaceRoot = document.createElement('div');
    pagerRoot.appendChild(surfaceRoot);
    document.body.appendChild(pagerRoot);
    let pagerUndos = 0;
    let pagerRedos = 0;
    pagerRoot.addEventListener('keydown', (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        if (event.shiftKey) pagerRedos += 1;
        else pagerUndos += 1;
      }
    });
    const handler = createPointerController(deps);
    handler.attach(surfaceRoot);
    surfaceRoot.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'z',
        ctrlKey: true,
        bubbles: true,
      }),
    );
    surfaceRoot.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Z',
        ctrlKey: true,
        shiftKey: true,
        bubbles: true,
      }),
    );
    expect(undos).toBe(1);
    expect(redos).toBe(1);
    expect(pagerUndos).toBe(0);
    expect(pagerRedos).toBe(0);
    handler.detach();
    page.remove();
    pagerRoot.remove();
  });
  it('routes writing-tool keys to the surface tool registry', () => {
    const requested: string[] = [];
    const { deps, page } = makeDeps({
      requestSetTool: (toolId: string) => {
        requested.push(toolId);
      },
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    const handler = createPointerController(deps);
    handler.attach(root);
    for (const key of ['f', 'b', 'n', 'p', 'h']) {
      root.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    }
    expect(requested).toEqual([
      'froglight.ink.fountain',
      'froglight.ink.brush',
      'froglight.ink.pencil',
      'froglight.ink.pen',
      'froglight.ink.highlighter',
    ]);
    handler.detach();
    page.remove();
    root.remove();
  });
});

describe('pointerrawupdate transport', () => {
  function rawWired(
    mode: 'always' | 'never' | undefined,
    canvasPatch?: (canvas: HTMLCanvasElement) => void,
  ) {
    const batches: Array<{ x: number; y: number }[]> = [];
    const moves: Array<{ x: number; y: number }> = [];
    const ups: Array<{ x: number; y: number }> = [];
    const predicted: Array<{ x: number; y: number }[]> = [];
    let renders = 0;
    const { deps, canvas, page } = makeDeps({
      scheduleRender: () => {
        renders += 1;
      },
      ...(mode !== undefined ? { pointerRawUpdate: mode } : {}),
    });
    canvasPatch?.(canvas);
    const controller = {
      ...deps.controller,
      pointerMove: (event: { point: { x: number; y: number } }) => {
        moves.push({ ...event.point });
      },
      pointerUp: (event: { point: { x: number; y: number } }) => {
        ups.push({ ...event.point });
      },
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
    };
    return {
      // Generous horizon isolates transport-ownership assertions from the
      // prediction-horizon policy (dedicated horizon specs use defaults).
      wired: {
        ...deps,
        controller,
        predictionPolicy: { maxScreenPx: 100000, maxLookaheadMs: 1000000 },
      },
      canvas,
      page,
      batches,
      moves,
      ups,
      predicted,
      renders: () => renders,
    };
  }

  function dispatchRaw(
    canvas: HTMLCanvasElement,
    id: number,
    current: { x: number; y: number },
    coalesced: Array<{ x: number; y: number; ts: number }>,
    currentTs?: number,
    predicted: Array<{ x: number; y: number; ts: number }> = [],
  ): void {
    const event = new MouseEvent('pointerrawupdate', {
      bubbles: true,
      cancelable: true,
      clientX: current.x,
      clientY: current.y,
    }) as unknown as PointerEvent;
    Object.defineProperty(event, 'pointerId', { value: id });
    Object.defineProperty(event, 'pointerType', { value: 'pen' });
    Object.defineProperty(event, 'pressure', { value: 0.5 });
    if (currentTs !== undefined) {
      Object.defineProperty(event, 'timeStamp', { value: currentTs });
    }
    Object.defineProperty(event, 'getCoalescedEvents', {
      value: () =>
        coalesced.map((p) => ({
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

  function moveWithTs(
    canvas: HTMLCanvasElement,
    id: number,
    current: { x: number; y: number },
    coalesced: Array<{ x: number; y: number; ts: number }>,
    currentTs?: number,
    predicted: Array<{ x: number; y: number; ts: number }> = [],
  ): void {
    const event = new MouseEvent('pointermove', {
      bubbles: true,
      cancelable: true,
      clientX: current.x,
      clientY: current.y,
    }) as unknown as PointerEvent;
    Object.defineProperty(event, 'pointerId', { value: id });
    Object.defineProperty(event, 'pointerType', { value: 'pen' });
    Object.defineProperty(event, 'pressure', { value: 0.5 });
    if (currentTs !== undefined) {
      Object.defineProperty(event, 'timeStamp', { value: currentTs });
    }
    Object.defineProperty(event, 'getCoalescedEvents', {
      value: () =>
        coalesced.map((p) => ({
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

  it('prefers raw events and drops the duplicate pointermove echo', () => {
    const { wired, canvas, page, batches, renders } = rawWired('always');
    const root = document.createElement('div');
    document.body.appendChild(root);
    const handler = createPointerController(wired);
    handler.attach(root);
    pointerDown(canvas, 1, 50, 50, 'pen');
    const afterDown = renders();
    // Canvas rect is (10,20): client (60,70) is view (50,50).
    dispatchRaw(
      canvas,
      1,
      { x: 70, y: 80 },
      [
        { x: 60, y: 70, ts: 3000 },
        { x: 70, y: 80, ts: 3008 },
      ],
      3008,
    );
    expect(batches).toEqual([
      [
        { x: 50, y: 50 },
        { x: 60, y: 60 },
      ],
    ]);
    expect(renders()).toBe(afterDown + 1);
    // The echoing pointermove carries nothing new: no batch, no frame.
    moveWithTs(
      canvas,
      1,
      { x: 70, y: 80 },
      [
        { x: 60, y: 70, ts: 3000 },
        { x: 70, y: 80, ts: 3008 },
      ],
      3008,
    );
    expect(batches).toHaveLength(1);
    expect(renders()).toBe(afterDown + 1);
    handler.detach();
    page.remove();
    root.remove();
  });

  it('suppresses move confirmed samples while raw owns the gesture (authoritative raw)', () => {
    const { wired, canvas, page, batches, ups } = rawWired('always');
    const root = document.createElement('div');
    document.body.appendChild(root);
    const handler = createPointerController(wired);
    handler.attach(root);
    pointerDown(canvas, 1, 50, 50, 'pen');
    dispatchRaw(
      canvas,
      1,
      { x: 65, y: 75 },
      [
        { x: 60, y: 70, ts: 3000 },
        { x: 65, y: 75, ts: 3004 },
      ],
      3004,
    );
    // Raw owns confirmed input from here: the overlapping move carries
    // one echo (55,55 @3004, already consumed) plus genuinely new content
    // (65,65 @3012) — the new sample buffers as a fallback candidate
    // (lossless, not committed yet) instead of being merged behind the
    // raw frontier. Stale history would be suppressed, never reordered.
    moveWithTs(
      canvas,
      1,
      { x: 75, y: 85 },
      [
        { x: 65, y: 75, ts: 3004 },
        { x: 75, y: 85, ts: 3012 },
      ],
      3012,
    );
    expect(batches).toEqual([
      [
        { x: 50, y: 50 },
        { x: 55, y: 55 },
      ],
    ]);
    // Buffered, not yet suppressed: raw is still alive (only 8ms elapsed,
    // well under the stall timeout), so nothing is counted as dropped and
    // the fallback has not latched.
    expect(handler.transportStats().moveSuppressedRawOwned).toBe(0);
    expect(handler.transportStats().rawFallbackActivations).toBe(0);
    // Raw stays absent past the elapsed-time stall threshold (36ms since
    // the last raw): the fallback latches and releases BOTH buffered
    // candidates in safe order — move #1 is preserved, not lost.
    moveWithTs(canvas, 1, { x: 85, y: 95 }, [{ x: 85, y: 95, ts: 3040 }], 3040);
    expect(handler.transportStats().rawFallbackActivations).toBe(1);
    expect(batches).toHaveLength(2);
    expect(batches[1]).toEqual([
      { x: 65, y: 65 },
      { x: 75, y: 75 },
    ]);
    // The up flush skips raw-consumed samples before the final up.
    pointerUpBatch(canvas, 1, { x: 85, y: 95 }, [{ x: 85, y: 95 }]);
    expect(ups).toEqual([{ x: 75, y: 75 }]);
    handler.detach();
    page.remove();
    root.remove();
  });

  it('does not release stale move overlap with timestamps rounded to the raw frontier', () => {
    const { wired, canvas, page, batches } = rawWired('always');
    const downs: Array<{ x: number; y: number }> = [];
    const controller = {
      ...wired.controller,
      pointerDown: (event: { point: { x: number; y: number } }) => {
        downs.push({ ...event.point });
      },
    };
    const root = document.createElement('div');
    document.body.appendChild(root);
    const handler = createPointerController({ ...wired, controller });
    handler.attach(root);
    pointerDown(canvas, 1, 50, 50, 'pen');
    // Raw advances to P4. Some event transports can give multiple samples
    // the same timestamp; a later move then repeats older coalesced history
    // at that exact frontier. Those samples must not be appended after P4.
    dispatchRaw(
      canvas,
      1,
      { x: 70, y: 80 },
      [{ x: 70, y: 80, ts: 3004 }],
      3004,
    );
    for (let i = 0; i < 5; i += 1) {
      moveWithTs(
        canvas,
        1,
        { x: 75, y: 85 },
        [
          { x: 60, y: 70, ts: 3004 },
          { x: 65, y: 75, ts: 3004 },
          { x: 70, y: 80, ts: 3004 },
          { x: 75, y: 85, ts: 3004 },
        ],
        3004,
      );
    }

    // P2/P3 are before the raw anchor and must not backtrack the stroke;
    // P5 is a distinct same-time sample after that anchor and must survive.
    expect([...downs, ...batches.flat()]).toEqual([
      { x: 40, y: 30 }, // P1
      { x: 60, y: 60 }, // P4, raw authoritative frontier
      { x: 65, y: 65 }, // P5, same-time sample after the overlap anchor
    ]);
    handler.detach();
    page.remove();
    root.remove();
  });

  it('drops an equal-time fallback buffered before raw advances to a later sample', () => {
    const { wired, canvas, page, batches } = rawWired('always');
    const root = document.createElement('div');
    document.body.appendChild(root);
    const handler = createPointerController(wired);
    handler.attach(root);
    pointerDown(canvas, 1, 50, 50, 'pen');
    dispatchRaw(
      canvas,
      1,
      { x: 70, y: 80 },
      [{ x: 70, y: 80, ts: 3004 }],
      3004,
    );

    // P5 is buffered as a move fallback after P4. Raw then confirms P6 at
    // the same rounded timestamp; that raw arrival clears the old buffer.
    moveWithTs(
      canvas,
      1,
      { x: 75, y: 85 },
      [
        { x: 70, y: 80, ts: 3004 },
        { x: 75, y: 85, ts: 3004 },
      ],
      3004,
    );
    dispatchRaw(
      canvas,
      1,
      { x: 80, y: 90 },
      [{ x: 80, y: 90, ts: 3004 }],
      3004,
    );

    // Subsequent move batches echo P6 while replaying the old P5 prefix.
    // The coalesced overlap anchor proves P5 precedes the raw frontier.
    for (let i = 0; i < 5; i += 1) {
      moveWithTs(
        canvas,
        1,
        { x: 80, y: 90 },
        [
          { x: 75, y: 85, ts: 3004 },
          { x: 80, y: 90, ts: 3004 },
        ],
        3004,
      );
    }

    expect(batches).toEqual([
      [{ x: 60, y: 60 }], // P4
      [{ x: 70, y: 70 }], // P6; buffered P5 never follows it
    ]);
    handler.detach();
    page.remove();
    root.remove();
  });

  it('ignores raw events when the transport is disabled', () => {
    const { wired, canvas, page, batches, moves } = rawWired('never');
    const root = document.createElement('div');
    document.body.appendChild(root);
    const handler = createPointerController(wired);
    handler.attach(root);
    pointerDown(canvas, 1, 50, 50, 'pen');
    dispatchRaw(canvas, 1, { x: 70, y: 80 }, [{ x: 60, y: 70, ts: 3000 }]);
    expect(batches).toEqual([]);
    expect(moves).toEqual([]);
    moveWithTs(canvas, 1, { x: 70, y: 80 }, [{ x: 70, y: 80, ts: 3000 }]);
    expect(batches).toEqual([[{ x: 60, y: 60 }]]);
    handler.detach();
    page.remove();
    root.remove();
  });

  it('auto-detects raw support from the canvas', () => {
    const { wired, canvas, page, batches } = rawWired(undefined, (c) => {
      Object.defineProperty(c, 'onpointerrawupdate', { value: null });
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    const handler = createPointerController(wired);
    handler.attach(root);
    pointerDown(canvas, 1, 50, 50, 'pen');
    dispatchRaw(canvas, 1, { x: 70, y: 80 }, [{ x: 70, y: 80, ts: 3000 }]);
    // A present (even null) handler property means raw transport.
    expect(batches).toEqual([[{ x: 60, y: 60 }]]);
    handler.detach();
    page.remove();
    root.remove();
  });

  it('drops echoed predicted tails without swallowing fresh ones', () => {
    const { wired, canvas, page, predicted } = rawWired('always');
    const root = document.createElement('div');
    document.body.appendChild(root);
    const handler = createPointerController(wired);
    handler.attach(root);
    pointerDown(canvas, 1, 50, 50, 'pen');
    // Raw is confirmed-only (never a prediction source): its predicted
    // payload is ignored, so no tail renders from raw alone.
    dispatchRaw(
      canvas,
      1,
      { x: 70, y: 80 },
      [{ x: 70, y: 80, ts: 3000 }],
      3008,
      [{ x: 80, y: 90, ts: 3020 }],
    );
    expect(predicted).toEqual([]);
    // The echoing move supplies the same tail through the prediction
    // transport: it renders once (move-owned predictions).
    moveWithTs(
      canvas,
      1,
      { x: 70, y: 80 },
      [{ x: 70, y: 80, ts: 3008 }],
      3008,
      [{ x: 80, y: 90, ts: 3020 }],
    );
    expect(predicted).toEqual([[{ x: 70, y: 70 }]]);
    // Echo carries the same predicted tail: dropped, not re-rendered.
    moveWithTs(
      canvas,
      1,
      { x: 70, y: 80 },
      [{ x: 70, y: 80, ts: 3008 }],
      3008,
      [{ x: 80, y: 90, ts: 3020 }],
    );
    expect(predicted).toHaveLength(1);
    // A genuinely new tail still forwards.
    moveWithTs(
      canvas,
      1,
      { x: 70, y: 80 },
      [{ x: 70, y: 80, ts: 3008 }],
      3008,
      [{ x: 90, y: 100, ts: 3030 }],
    );
    expect(predicted).toEqual([[{ x: 70, y: 70 }], [{ x: 80, y: 80 }]]);
    handler.detach();
    page.remove();
    root.remove();
  });

  it('keeps distinct samples sharing identical timestamps', () => {
    const { wired, canvas, page, batches } = rawWired('always');
    const root = document.createElement('div');
    document.body.appendChild(root);
    const handler = createPointerController(wired);
    handler.attach(root);
    pointerDown(canvas, 1, 50, 50, 'pen');
    // Same timestamp, three distinct positions: no sample is an echo of
    // another, so all three forward.
    moveWithTs(
      canvas,
      1,
      { x: 80, y: 80 },
      [
        { x: 60, y: 70, ts: 3000 },
        { x: 70, y: 75, ts: 3000 },
        { x: 80, y: 80, ts: 3000 },
      ],
      3000,
    );
    expect(batches).toEqual([
      [
        { x: 50, y: 50 },
        { x: 60, y: 55 },
        { x: 70, y: 60 },
      ],
    ]);
    handler.detach();
    page.remove();
    root.remove();
  });

  it('never drops confirmed input when timestamps move backwards', () => {
    const { wired, canvas, page, batches } = rawWired('always');
    const root = document.createElement('div');
    document.body.appendChild(root);
    const handler = createPointerController(wired);
    handler.attach(root);
    pointerDown(canvas, 1, 50, 50, 'pen');
    moveWithTs(canvas, 1, { x: 70, y: 80 }, [{ x: 70, y: 80, ts: 5000 }], 5000);
    // Clock jumps backwards: the distinct sample still forwards.
    moveWithTs(canvas, 1, { x: 90, y: 90 }, [{ x: 90, y: 90, ts: 1000 }], 1000);
    expect(batches).toEqual([[{ x: 60, y: 60 }], [{ x: 80, y: 70 }]]);
    handler.detach();
    page.remove();
    root.remove();
  });

  it('forwards confirmed samples overlapping earlier predicted timestamps', () => {
    const { wired, canvas, page, batches, predicted } = rawWired('always');
    const root = document.createElement('div');
    document.body.appendChild(root);
    const handler = createPointerController(wired);
    handler.attach(root);
    pointerDown(canvas, 1, 50, 50, 'pen');
    // Future-dated lookahead first…
    moveWithTs(
      canvas,
      1,
      { x: 70, y: 80 },
      [{ x: 70, y: 80, ts: 3000 }],
      3000,
      [{ x: 100, y: 100, ts: 4000 }],
    );
    expect(predicted).toHaveLength(1);
    // …then the real samples arrive at the predicted ground: none are
    // suppressed as duplicates of the lookahead.
    moveWithTs(
      canvas,
      1,
      { x: 100, y: 100 },
      [
        { x: 80, y: 90, ts: 3500 },
        { x: 100, y: 100, ts: 4000 },
      ],
      4000,
    );
    const flat = batches.flat();
    expect(flat).toContainEqual({ x: 70, y: 70 });
    expect(flat).toContainEqual({ x: 90, y: 80 });
    handler.detach();
    page.remove();
    root.remove();
  });

  it('cleans predicted state deterministically on pointercancel', () => {
    const { wired, canvas, page, batches, predicted } = rawWired('always');
    const root = document.createElement('div');
    document.body.appendChild(root);
    const handler = createPointerController(wired);
    handler.attach(root);
    pointerDown(canvas, 1, 50, 50, 'pen');
    moveWithTs(
      canvas,
      1,
      { x: 70, y: 80 },
      [{ x: 70, y: 80, ts: 3000 }],
      3000,
      [{ x: 100, y: 100, ts: 4000 }],
    );
    expect(predicted).toHaveLength(1);
    pointerCancel(canvas, 1);
    expect(handler.debugState().mode).toBe('idle');
    // The next gesture starts from clean dedup state: identical
    // timestamps forward again instead of echo-dropping.
    pointerDown(canvas, 1, 60, 60, 'pen');
    moveWithTs(canvas, 1, { x: 70, y: 80 }, [{ x: 70, y: 80, ts: 3000 }], 3000);
    expect(batches.flat()).toContainEqual({ x: 60, y: 60 });
    handler.detach();
    page.remove();
    root.remove();
  });

  it('survives throwing coalesced/predicted getters without losing the gesture', () => {
    const inner = makeDeps();
    const seen: Array<{ x: number; y: number }> = [];
    const wired = {
      ...inner.deps,
      controller: {
        ...inner.deps.controller,
        pointerBatch: (
          events: readonly { point: { x: number; y: number } }[],
        ) => {
          for (const e of events) seen.push({ ...e.point });
        },
      },
    };
    const root = document.createElement('div');
    document.body.appendChild(root);
    const handler = createPointerController(wired);
    handler.attach(root);
    pointerDown(inner.canvas, 1, 50, 50, 'pen');
    const event = new MouseEvent('pointermove', {
      bubbles: true,
      cancelable: true,
      clientX: 70,
      clientY: 80,
    }) as unknown as PointerEvent;
    Object.defineProperty(event, 'pointerId', { value: 1 });
    Object.defineProperty(event, 'pointerType', { value: 'pen' });
    Object.defineProperty(event, 'pressure', { value: 0.5 });
    Object.defineProperty(event, 'getCoalescedEvents', {
      value: () => {
        throw new Error('coalesced unavailable');
      },
    });
    Object.defineProperty(event, 'getPredictedEvents', {
      value: () => {
        throw new Error('predicted unavailable');
      },
    });
    inner.canvas.dispatchEvent(event);
    // The event's own coords still dispatch as one confirmed sample.
    expect(seen).toEqual([{ x: 60, y: 60 }]);
    expect(handler.debugState().mode).toBe('draw');
    handler.detach();
    inner.page.remove();
    root.remove();
  });

  it('lets a pen preempt an accidental single-touch pan', () => {
    const downs: number[] = [];
    const { deps, canvas, page } = makeDeps();
    const wired = {
      ...deps,
      controller: {
        ...deps.controller,
        pointerDown: () => {
          downs.push(1);
        },
      },
    };
    const root = document.createElement('div');
    document.body.appendChild(root);
    const handler = createPointerController(wired);
    handler.attach(root);
    // Palm lands first: single-touch pan.
    pointerDown(canvas, 1, 400, 400, 'touch');
    expect(handler.debugState().mode).toBe('pan');
    // Pen lands: preempts the pan and starts drawing.
    pointerDown(canvas, 2, 50, 50, 'pen');
    expect(handler.debugState().mode).toBe('draw');
    expect(downs).toHaveLength(1);
    expect(page.classList.contains('panning')).toBe(false);
    // Pen lifts with nothing tracked: clean idle, next touch pans again.
    pointerUp(canvas, 2, 50, 50);
    expect(handler.debugState().mode).toBe('idle');
    pointerDown(canvas, 3, 400, 400, 'touch');
    expect(handler.debugState().mode).toBe('pan');
    handler.detach();
    page.remove();
    root.remove();
  });

  it('never sticks in draw when the pen lifts with a touch tracked', () => {
    const { deps, canvas, page } = makeDeps();
    const root = document.createElement('div');
    document.body.appendChild(root);
    const handler = createPointerController(deps);
    handler.attach(root);
    pointerDown(canvas, 1, 50, 50, 'pen');
    expect(handler.debugState().mode).toBe('draw');
    // Incidental touch is rejected and untracked…
    pointerDown(canvas, 2, 400, 400, 'touch');
    expect(handler.debugState().pointers).toHaveLength(1);
    // …so the pen lift settles cleanly to idle (no stuck draw mode).
    pointerUp(canvas, 1, 50, 50);
    expect(handler.debugState().mode).toBe('idle');
    expect(handler.debugState().pointers).toHaveLength(0);
    handler.detach();
    page.remove();
    root.remove();
  });
});

describe('hold-to-gesture timer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function holdWired() {
    let holds = 0;
    const { deps, canvas, page } = makeDeps();
    const controller = {
      ...deps.controller,
      gestureHold: () => {
        holds += 1;
      },
    };
    return {
      wired: { ...deps, controller },
      canvas,
      page,
      holds: () => holds,
    };
  }

  function attachHold() {
    const ctx = holdWired();
    const root = document.createElement('div');
    document.body.appendChild(root);
    vi.useFakeTimers();
    const handler = createPointerController(ctx.wired);
    handler.attach(root);
    return { ...ctx, root, handler };
  }

  it('fires gestureHold after stillness, not before', () => {
    const { canvas, page, holds, root, handler } = attachHold();
    pointerDown(canvas, 1, 50, 50, 'pen');
    vi.advanceTimersByTime(GESTURE_THRESHOLDS.holdMs - 1);
    expect(holds()).toBe(0);
    vi.advanceTimersByTime(1);
    expect(holds()).toBe(1);
    handler.detach();
    page.remove();
    root.remove();
  });

  it('reschedules on movement and clears on pointerup', () => {
    const { canvas, page, holds, root, handler } = attachHold();
    pointerDown(canvas, 1, 50, 50, 'pen');
    vi.advanceTimersByTime(GESTURE_THRESHOLDS.holdMs - 100);
    pointerMove(canvas, 1, 60, 60);
    vi.advanceTimersByTime(GESTURE_THRESHOLDS.holdMs - 100);
    expect(holds()).toBe(0);
    vi.advanceTimersByTime(100);
    expect(holds()).toBe(1);
    // A fresh gesture arms a fresh timer; lifting clears it.
    pointerUp(canvas, 1, 50, 50);
    pointerDown(canvas, 2, 50, 50, 'pen');
    pointerUp(canvas, 2, 50, 50);
    vi.advanceTimersByTime(GESTURE_THRESHOLDS.holdMs * 2);
    expect(holds()).toBe(1);
    handler.detach();
    page.remove();
    root.remove();
  });

  it('never fires outside a draw gesture', () => {
    const { canvas, page, holds, root, handler } = attachHold();
    // Touch navigates (pan mode): no hold even after stillness.
    pointerDown(canvas, 1, 50, 50, 'touch');
    vi.advanceTimersByTime(GESTURE_THRESHOLDS.holdMs * 2);
    expect(holds()).toBe(0);
    handler.detach();
    page.remove();
    root.remove();
  });
});

describe('pen buttons, hover, and mid-gesture robustness', () => {
  function penDown(
    canvas: HTMLCanvasElement,
    id: number,
    x: number,
    y: number,
    button: number,
  ): void {
    const event = new MouseEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button,
    }) as unknown as PointerEvent;
    Object.defineProperty(event, 'pointerId', { value: id });
    Object.defineProperty(event, 'pointerType', { value: 'pen' });
    Object.defineProperty(event, 'pressure', { value: 0.5 });
    canvas.dispatchEvent(event);
  }

  function hoverMove(canvas: HTMLCanvasElement, x: number, y: number): void {
    const event = new MouseEvent('pointermove', {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      buttons: 0,
    }) as unknown as PointerEvent;
    Object.defineProperty(event, 'pointerId', { value: 7 });
    Object.defineProperty(event, 'pointerType', { value: 'pen' });
    canvas.dispatchEvent(event);
  }

  function drawWired() {
    const downs: number[] = [];
    const ups: number[] = [];
    const { deps, canvas, page } = makeDeps();
    const wired = {
      ...deps,
      controller: {
        ...deps.controller,
        pointerDown: () => {
          downs.push(1);
        },
        pointerUp: () => {
          ups.push(1);
        },
      },
    };
    return { wired, canvas, page, downs, ups };
  }

  function attach(wired: PointerControllerDeps) {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const handler = createPointerController(wired);
    handler.attach(root);
    return { root, handler };
  }

  it('draws normally with the barrel button held (no tool hijack)', () => {
    const { wired, canvas, page, downs, ups } = drawWired();
    const { root, handler } = attach(wired);
    // Barrel button (W3C code 2) is classified for diagnostics, never
    // bound: the stroke proceeds as ordinary ink.
    penDown(canvas, 1, 50, 50, 2);
    expect(handler.debugState().mode).toBe('draw');
    pointerMove(canvas, 1, 60, 60);
    pointerUp(canvas, 1, 60, 60);
    expect(downs).toHaveLength(1);
    expect(ups).toHaveLength(1);
    expect(handler.debugState().mode).toBe('idle');
    handler.detach();
    page.remove();
    root.remove();
  });

  it('draws as ink with the eraser end (unbound until the device matrix)', () => {
    const { wired, canvas, page, downs, ups } = drawWired();
    const { root, handler } = attach(wired);
    // Eraser end (W3C code 5): intentionally not bound to tools here.
    penDown(canvas, 1, 50, 50, 5);
    expect(handler.debugState().mode).toBe('draw');
    pointerMove(canvas, 1, 60, 60);
    pointerUp(canvas, 1, 60, 60);
    expect(downs).toHaveLength(1);
    expect(ups).toHaveLength(1);
    handler.detach();
    page.remove();
    root.remove();
  });

  it('starts no gesture on pen hover without buttons', () => {
    const { wired, canvas, page, downs } = drawWired();
    const { root, handler } = attach(wired);
    hoverMove(canvas, 100, 100);
    hoverMove(canvas, 120, 110);
    expect(handler.debugState().mode).toBe('idle');
    expect(downs).toHaveLength(0);
    handler.detach();
    page.remove();
    root.remove();
  });

  it('rejects two touches during a pen stroke without disturbing it', () => {
    const { wired, canvas, page, downs, ups } = drawWired();
    const { root, handler } = attach(wired);
    penDown(canvas, 1, 50, 50, 0);
    expect(handler.debugState().mode).toBe('draw');
    pointerMove(canvas, 1, 60, 60);
    // Palm + second finger land mid-stroke: both rejected, no pan/pinch,
    // the pen stroke continues underneath.
    pointerDown(canvas, 2, 400, 400, 'touch');
    pointerDown(canvas, 3, 450, 450, 'touch');
    expect(handler.debugState().mode).toBe('draw');
    expect(page.classList.contains('panning')).toBe(false);
    pointerMove(canvas, 1, 70, 70);
    pointerUp(canvas, 1, 70, 70);
    expect(downs).toHaveLength(1);
    expect(ups).toHaveLength(1);
    expect(handler.debugState().mode).toBe('idle');
    handler.detach();
    page.remove();
    root.remove();
  });

  it('restarts cleanly when detach interrupts a draw gesture', () => {
    const { wired, canvas, page, downs, ups } = drawWired();
    const root = document.createElement('div');
    document.body.appendChild(root);
    const handler = createPointerController(wired);
    handler.attach(root);
    penDown(canvas, 1, 50, 50, 0);
    pointerMove(canvas, 1, 60, 60);
    // Surface unmounts mid-gesture (page transition): detach must not
    // wedge the next gesture on re-attach.
    handler.detach();
    const root2 = document.createElement('div');
    document.body.appendChild(root2);
    handler.attach(root2);
    penDown(canvas, 9, 50, 50, 0);
    expect(handler.debugState().mode).toBe('draw');
    pointerMove(canvas, 9, 60, 60);
    pointerUp(canvas, 9, 60, 60);
    expect(downs).toHaveLength(2);
    expect(ups).toHaveLength(1);
    expect(handler.debugState().mode).toBe('idle');
    handler.detach();
    page.remove();
    root.remove();
    root2.remove();
  });
});

describe('drawing keyboard focus', () => {
  it('returns focus from the toolbar to the surface so undo reaches its handler', () => {
    const undo = vi.fn(() => true);
    const { deps } = makeDeps({ requestUndo: undo });
    const root = document.createElement('div');
    root.tabIndex = 0;
    root.appendChild(deps.page);
    const toolbarButton = document.createElement('button');
    document.body.append(root, toolbarButton);
    toolbarButton.focus();
    const handler = createPointerController(deps);
    handler.attach(root);
    pointerDown(deps.canvas, 1, 100, 100, 'pen');
    expect(document.activeElement).toBe(root);
    document.activeElement!.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }),
    );
    expect(undo).toHaveBeenCalledOnce();
    handler.detach();
    root.remove();
    toolbarButton.remove();
  });
});

it('publishes selection-only gesture state without marking content dirty', () => {
  const notifyTools = vi.fn();
  const markDirty = vi.fn();
  const { deps } = makeDeps({
    getActiveToolId: () => 'froglight.ink.select',
    notifyTools,
    markDirty,
  });
  const handler = createPointerController(deps);
  handler.attach(deps.page);
  pointerDown(deps.canvas, 1, 100, 100);
  pointerUp(deps.canvas, 1, 100, 100);
  expect(notifyTools).toHaveBeenCalledOnce();
  expect(markDirty).not.toHaveBeenCalled();
  handler.detach();
});
