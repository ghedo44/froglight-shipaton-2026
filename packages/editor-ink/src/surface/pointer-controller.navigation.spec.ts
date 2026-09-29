/**
 * Touch-navigation characterization for the standalone Surface adapter.
 *
 * These tests pin direct-manipulation behavior at the public pointer-controller
 * seam. They intentionally describe the elastic/stable behavior that replaces
 * the current hard-clamped and all-touch centroid implementation.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  boundedFrame,
  emptySurface,
  viewToSurface,
  type Camera,
  type Point,
} from '@froglight/foundation';
import { boundedCamera, MAX_ZOOM, MIN_ZOOM } from './camera.js';
import {
  createPointerController,
  type PointerControllerDeps,
} from './pointer-controller.js';

const FRAME = { width: 800, height: 600 } as const;
const VIEWPORT = { width: 800, height: 600 } as const;

interface NavigationHarness {
  readonly canvas: HTMLCanvasElement;
  readonly page: HTMLElement;
  readonly root: HTMLElement;
  readonly handler: ReturnType<typeof createPointerController>;
  readonly model: ReturnType<typeof emptySurface>;
  readonly effects: { dirty: number; history: number };
  camera(): Camera;
}

function createNavigationHarness(
  initialCamera: Camera,
  clampToSheet: PointerControllerDeps['clampToSheet'] = (camera) => camera,
  overrides: Partial<PointerControllerDeps> = {},
): NavigationHarness {
  const page = document.createElement('div');
  const canvas = document.createElement('canvas');
  const badge = document.createElement('div');
  const root = document.createElement('div');
  page.append(canvas);
  root.append(page);
  document.body.append(root);
  canvas.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 800, height: 600 }) as DOMRect;

  let camera = { ...initialCamera };
  const model = emptySurface(boundedFrame(FRAME.width, FRAME.height));
  const effects = { dirty: 0, history: 0 };
  const controller = {
    camera: () => ({ ...camera }),
    setCamera: (next: Camera) => {
      camera = { ...next };
    },
    pointerDown: () => undefined,
    pointerMove: () => undefined,
    pointerUp: () => undefined,
    pointerCancel: () => undefined,
    panBy: (deltaView: Point) => {
      camera = {
        ...camera,
        x: camera.x + deltaView.x / camera.zoom,
        y: camera.y + deltaView.y / camera.zoom,
      };
    },
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
    frameResizable: false,
    isReadOnly: () => false,
    isDestroyed: () => false,
    isUserNavigated: () => false,
    setUserNavigated: () => undefined,
    getActiveToolId: () => 'froglight.ink.pen',
    beginHistoryGesture: () => {
      effects.history += 1;
    },
    commitHistoryGesture: () => {
      effects.history += 1;
    },
    cancelHistoryGesture: () => undefined,
    clampToSheet,
    setZoomFactor: () => undefined,
    syncZoomState: () => undefined,
    scheduleRender: () => undefined,
    invalidateScene: () => undefined,
    fitToView: () => undefined,
    notifyTools: () => undefined,
    markDirty: () => {
      effects.dirty += 1;
    },
    openTextOverlay: () => undefined,
    openTextOverlayAtSelection: () => false,
    isTextOverlayOpen: () => false,
    requestUndo: () => false,
    requestRedo: () => false,
    requestSetTool: () => undefined,
    ...overrides,
  };
  const handler = createPointerController(deps);
  handler.attach(root);
  return {
    canvas,
    page,
    root,
    handler,
    model,
    effects,
    camera: () => ({ ...camera }),
  };
}

function dispatchPointer(
  canvas: HTMLCanvasElement,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  id: number,
  point: Point,
  timeMs?: number,
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: point.x,
    clientY: point.y,
    button: 0,
  }) as unknown as PointerEvent;
  Object.defineProperty(event, 'pointerId', { value: id });
  Object.defineProperty(event, 'pointerType', { value: 'touch' });
  if (timeMs !== undefined)
    Object.defineProperty(event, 'timeStamp', { value: timeMs });
  canvas.dispatchEvent(event);
}

function dispatchCancel(canvas: HTMLCanvasElement, id: number): void {
  const event = new Event('pointercancel', {
    bubbles: true,
    cancelable: true,
  }) as PointerEvent;
  Object.defineProperty(event, 'pointerId', { value: id });
  canvas.dispatchEvent(event);
}

function dispatchMousePan(
  canvas: HTMLCanvasElement,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  point: Point,
  timeMs?: number,
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: point.x,
    clientY: point.y,
    button: type === 'pointerdown' ? 1 : 0,
  }) as unknown as PointerEvent;
  Object.defineProperties(event, {
    pointerId: { value: 90 },
    pointerType: { value: 'mouse' },
  });
  if (timeMs !== undefined)
    Object.defineProperty(event, 'timeStamp', { value: timeMs });
  canvas.dispatchEvent(event);
}

function dispatchAuthoringDown(
  canvas: HTMLCanvasElement,
  pointerType: 'pen' | 'mouse',
  id: number,
): void {
  const event = new MouseEvent('pointerdown', {
    bubbles: true,
    cancelable: true,
    clientX: 300,
    clientY: 200,
    button: 0,
  }) as unknown as PointerEvent;
  Object.defineProperties(event, {
    pointerId: { value: id },
    pointerType: { value: pointerType },
  });
  canvas.dispatchEvent(event);
}

const mounted: NavigationHarness[] = [];

function mount(
  initialCamera: Camera,
  clampToSheet?: PointerControllerDeps['clampToSheet'],
  overrides?: Partial<PointerControllerDeps>,
): NavigationHarness {
  const harness = createNavigationHarness(
    initialCamera,
    clampToSheet,
    overrides,
  );
  mounted.push(harness);
  return harness;
}

afterEach(() => {
  for (const harness of mounted.splice(0)) {
    harness.handler.detach();
    harness.root.remove();
  }
});

function advanceUntilIdle(
  harness: NavigationHarness,
  startTimeMs: number,
): void {
  let timeMs = startTimeMs;
  for (let frame = 0; frame < 240; frame += 1) {
    timeMs += 1000 / 60;
    if (!harness.handler.advanceNavigation(timeMs)) return;
  }
  throw new Error('navigation animation did not settle');
}

describe('standalone Surface active boundary behavior', () => {
  it('derives touch resistance from total displacement, independent of move batching', () => {
    const clamp = (camera: Camera) => boundedCamera(camera, FRAME, VIEWPORT);
    const oneMove = mount({ x: -744, y: 0, zoom: 1 }, clamp);
    const manyMoves = mount({ x: -744, y: 0, zoom: 1 }, clamp);

    dispatchPointer(oneMove.canvas, 'pointerdown', 1, { x: 100, y: 100 });
    dispatchPointer(oneMove.canvas, 'pointermove', 1, { x: 300, y: 100 });

    dispatchPointer(manyMoves.canvas, 'pointerdown', 1, { x: 100, y: 100 });
    for (const x of [140, 180, 220, 260, 300])
      dispatchPointer(manyMoves.canvas, 'pointermove', 1, { x, y: 100 });

    expect(manyMoves.camera()).toEqual(oneMove.camera());
  });

  it('rubber-bands middle-button desktop pan and springs back on release', () => {
    const clamp = (camera: Camera) => boundedCamera(camera, FRAME, VIEWPORT);
    const harness = mount({ x: -744, y: 0, zoom: 1 }, clamp);

    dispatchMousePan(harness.canvas, 'pointerdown', { x: 100, y: 100 }, 0);
    dispatchMousePan(harness.canvas, 'pointermove', { x: 300, y: 100 }, 20);
    expect(harness.camera().x).toBeLessThan(-744);
    dispatchMousePan(harness.canvas, 'pointerup', { x: 300, y: 100 }, 20);
    advanceUntilIdle(harness, 20);
    expect(harness.camera()).toEqual(clamp(harness.camera()));
    expect(harness.camera().x).toBe(-744);
  });

  it.each([
    { name: 'maximum', zoom: MAX_ZOOM - 0.1, movingX: 300, compare: 'above' },
    { name: 'minimum', zoom: MIN_ZOOM + 0.01, movingX: 150, compare: 'below' },
  ] as const)(
    'keeps following a pinch elastically beyond the $name settled zoom',
    ({ zoom, movingX, compare }) => {
      const harness = mount({ x: 0, y: 0, zoom });
      dispatchPointer(harness.canvas, 'pointerdown', 1, { x: 100, y: 100 });
      dispatchPointer(harness.canvas, 'pointerdown', 2, { x: 200, y: 100 });
      dispatchPointer(harness.canvas, 'pointermove', 2, {
        x: movingX,
        y: 100,
      });

      if (compare === 'above')
        expect(harness.camera().zoom).toBeGreaterThan(MAX_ZOOM);
      else expect(harness.camera().zoom).toBeLessThan(MIN_ZOOM);
    },
  );

  it.each([
    {
      name: 'left',
      camera: { x: -744, y: 0, zoom: 1 },
      move: { x: 160, y: 100 },
      axis: 'x',
      compare: 'below',
      limit: -744,
    },
    {
      name: 'right',
      camera: { x: 744, y: 0, zoom: 1 },
      move: { x: 40, y: 100 },
      axis: 'x',
      compare: 'above',
      limit: 744,
    },
    {
      name: 'top',
      camera: { x: 0, y: -544, zoom: 1 },
      move: { x: 100, y: 160 },
      axis: 'y',
      compare: 'below',
      limit: -544,
    },
    {
      name: 'bottom',
      camera: { x: 0, y: 544, zoom: 1 },
      move: { x: 100, y: 40 },
      axis: 'y',
      compare: 'above',
      limit: 544,
    },
  ] as const)(
    'retains bounded elastic movement after reaching the $name sheet edge',
    ({ camera, move, axis, compare, limit }) => {
      const harness = mount(camera, (next) =>
        boundedCamera(next, FRAME, VIEWPORT),
      );
      dispatchPointer(harness.canvas, 'pointerdown', 1, { x: 100, y: 100 });
      dispatchPointer(harness.canvas, 'pointermove', 1, move);

      const value = harness.camera()[axis];
      if (compare === 'above') expect(value).toBeGreaterThan(limit);
      else expect(value).toBeLessThan(limit);
    },
  );
});

describe('standalone Surface gesture handoff', () => {
  it.each([
    { gesture: 'overscroll', pointerType: 'pen' },
    { gesture: 'overscroll', pointerType: 'mouse' },
    { gesture: 'overzoom', pointerType: 'pen' },
    { gesture: 'overzoom', pointerType: 'mouse' },
  ] as const)(
    'ends active touch $gesture before $pointerType authoring starts',
    ({ gesture, pointerType }) => {
      const clamp = (camera: Camera) => boundedCamera(camera, FRAME, VIEWPORT);
      const harness = mount(
        gesture === 'overscroll'
          ? { x: -744, y: 0, zoom: 1 }
          : { x: 0, y: 0, zoom: MAX_ZOOM - 0.1 },
        clamp,
      );
      const releasedCaptures: number[] = [];
      harness.canvas.releasePointerCapture = (id) => {
        releasedCaptures.push(id);
      };
      dispatchPointer(harness.canvas, 'pointerdown', 1, { x: 100, y: 100 }, 0);
      if (gesture === 'overscroll') {
        dispatchPointer(
          harness.canvas,
          'pointermove',
          1,
          { x: 180, y: 100 },
          20,
        );
        expect(harness.camera().x).toBeLessThan(-744);
      } else {
        dispatchPointer(
          harness.canvas,
          'pointerdown',
          2,
          { x: 200, y: 100 },
          0,
        );
        dispatchPointer(
          harness.canvas,
          'pointermove',
          2,
          { x: 320, y: 100 },
          20,
        );
        expect(harness.camera().zoom).toBeGreaterThan(MAX_ZOOM);
      }

      dispatchAuthoringDown(harness.canvas, pointerType, 20);

      expect(harness.camera()).toEqual(clamp(harness.camera()));
      expect(harness.handler.debugState()).toMatchObject({
        mode: 'draw',
        pointers: [{ id: 20, x: 300, y: 200 }],
      });
      expect(releasedCaptures).toEqual(gesture === 'overscroll' ? [1] : [1, 2]);
      expect(harness.page.classList.contains('panning')).toBe(false);
      expect(harness.handler.advanceNavigation(40)).toBe(false);
    },
  );

  it('preserves the visible camera at pan-to-pinch and the remaining finger anchor at pinch-to-pan', () => {
    const harness = mount({ x: 0, y: 0, zoom: 1 });
    dispatchPointer(harness.canvas, 'pointerdown', 1, { x: 100, y: 100 });
    dispatchPointer(harness.canvas, 'pointermove', 1, { x: 80, y: 100 });
    const beforePinch = harness.camera();

    dispatchPointer(harness.canvas, 'pointerdown', 2, { x: 180, y: 100 });
    expect(harness.camera()).toEqual(beforePinch);
    dispatchPointer(harness.canvas, 'pointermove', 2, { x: 220, y: 100 });

    const remainingPoint = { x: 80, y: 100 };
    const anchoredSurfacePoint = viewToSurface(
      harness.camera(),
      remainingPoint,
    );
    dispatchPointer(harness.canvas, 'pointerup', 2, { x: 220, y: 100 });
    expect(viewToSurface(harness.camera(), remainingPoint)).toEqual(
      anchoredSurfacePoint,
    );

    const continuedPoint = { x: 70, y: 100 };
    dispatchPointer(harness.canvas, 'pointermove', 1, continuedPoint);
    const afterHandoff = viewToSurface(harness.camera(), continuedPoint);
    expect(afterHandoff.x).toBeCloseTo(anchoredSurfacePoint.x, 9);
    expect(afterHandoff.y).toBeCloseTo(anchoredSurfacePoint.y, 9);
  });

  it('hands an overbound pinch directly to the surviving finger without a competing spring', () => {
    const clamp = (camera: Camera) => boundedCamera(camera, FRAME, VIEWPORT);
    const harness = mount({ x: 0, y: 0, zoom: MAX_ZOOM - 0.1 }, clamp);
    dispatchPointer(harness.canvas, 'pointerdown', 1, { x: 100, y: 100 }, 0);
    dispatchPointer(harness.canvas, 'pointerdown', 2, { x: 200, y: 100 }, 0);
    dispatchPointer(harness.canvas, 'pointermove', 2, { x: 320, y: 100 }, 20);
    expect(harness.camera().zoom).toBeGreaterThan(MAX_ZOOM);

    dispatchPointer(harness.canvas, 'pointerup', 2, { x: 320, y: 100 }, 24);
    const handoff = harness.camera();
    expect(harness.handler.advanceNavigation(40)).toBe(false);
    expect(harness.camera()).toEqual(handoff);

    dispatchPointer(harness.canvas, 'pointermove', 1, { x: 80, y: 100 }, 44);
    expect(harness.camera().x).not.toBe(handoff.x);
    dispatchPointer(harness.canvas, 'pointerup', 1, { x: 80, y: 100 }, 60);
    advanceUntilIdle(harness, 60);
    expect(harness.camera()).toEqual(clamp(harness.camera()));
  });

  it('rebases a cancelled pinch onto its surviving finger without a hard snap', () => {
    const clamp = (camera: Camera) => boundedCamera(camera, FRAME, VIEWPORT);
    const harness = mount({ x: 0, y: 0, zoom: MAX_ZOOM }, clamp);
    dispatchPointer(harness.canvas, 'pointerdown', 1, { x: 100, y: 100 }, 0);
    dispatchPointer(harness.canvas, 'pointerdown', 2, { x: 200, y: 100 }, 0);
    dispatchPointer(harness.canvas, 'pointermove', 2, { x: 320, y: 100 }, 20);
    const transient = harness.camera();

    dispatchCancel(harness.canvas, 2);
    expect(harness.camera()).toEqual(transient);
    expect(harness.handler.advanceNavigation(36)).toBe(false);
    dispatchPointer(harness.canvas, 'pointermove', 1, { x: 80, y: 100 }, 40);
    expect(harness.camera().x).not.toBe(transient.x);
  });
});

describe('standalone Surface release physics', () => {
  it.each(['pen', 'mouse'] as const)(
    'settles an overbound release before %s authoring starts',
    (pointerType) => {
      const clamp = (camera: Camera) => boundedCamera(camera, FRAME, VIEWPORT);
      const harness = mount({ x: -744, y: 0, zoom: 1 }, clamp);
      dispatchPointer(harness.canvas, 'pointerdown', 1, { x: 100, y: 100 }, 0);
      dispatchPointer(harness.canvas, 'pointermove', 1, { x: 180, y: 100 }, 20);
      dispatchPointer(harness.canvas, 'pointerup', 1, { x: 180, y: 100 }, 20);
      expect(harness.camera().x).toBeLessThan(-744);

      dispatchAuthoringDown(harness.canvas, pointerType, 20);

      expect(harness.camera()).toEqual(clamp(harness.camera()));
      expect(harness.handler.debugState().mode).toBe('draw');
      expect(harness.handler.advanceNavigation(40)).toBe(false);
    },
  );

  it.each([
    { name: 'bounded sheet', frame: FRAME },
    { name: 'infinite whiteboard', frame: null },
  ] as const)(
    'settles $name elastic overzoom to the exact legal zoom',
    ({ frame }) => {
      const harness = mount({ x: 0, y: 0, zoom: MAX_ZOOM - 0.1 }, (camera) =>
        boundedCamera(camera, frame, VIEWPORT),
      );
      dispatchPointer(harness.canvas, 'pointerdown', 1, { x: 100, y: 100 }, 0);
      dispatchPointer(harness.canvas, 'pointerdown', 2, { x: 200, y: 100 }, 0);
      dispatchPointer(harness.canvas, 'pointermove', 2, { x: 300, y: 100 }, 20);
      expect(harness.camera().zoom).toBeGreaterThan(MAX_ZOOM);
      dispatchPointer(harness.canvas, 'pointerup', 2, { x: 300, y: 100 }, 20);
      dispatchPointer(harness.canvas, 'pointerup', 1, { x: 100, y: 100 }, 20);

      advanceUntilIdle(harness, 20);
      expect(harness.camera().zoom).toBe(MAX_ZOOM);
    },
  );

  it('settles an elastically pulled bounded edge to its exact legal camera', () => {
    const clamp = (camera: Camera) => boundedCamera(camera, FRAME, VIEWPORT);
    const harness = mount({ x: -744, y: 0, zoom: 1 }, clamp);
    dispatchPointer(harness.canvas, 'pointerdown', 1, { x: 100, y: 100 }, 0);
    dispatchPointer(harness.canvas, 'pointermove', 1, { x: 180, y: 100 }, 20);
    expect(harness.camera().x).toBeLessThan(-744);
    // Reverse slightly while still outside. Release must begin correcting on
    // the first frame instead of coasting through a decay interval.
    dispatchPointer(harness.canvas, 'pointermove', 1, { x: 170, y: 100 }, 40);
    const releasedX = harness.camera().x;
    dispatchPointer(harness.canvas, 'pointerup', 1, { x: 170, y: 100 }, 40);
    expect(harness.handler.advanceNavigation(56)).toBe(true);
    expect(Math.abs(harness.camera().x + 744)).toBeLessThan(
      Math.abs(releasedX + 744),
    );

    advanceUntilIdle(harness, 56);
    expect(harness.camera()).toEqual(clamp(harness.camera()));
    expect(harness.camera().x).toBe(-744);
  });

  it('continues unbounded touch momentum without dirty or history effects and interrupts on touch', () => {
    const harness = mount({ x: 0, y: 0, zoom: 1 }, (camera) =>
      boundedCamera(camera, null, VIEWPORT),
    );
    const canonicalBefore = JSON.stringify(harness.model);
    dispatchPointer(harness.canvas, 'pointerdown', 1, { x: 200, y: 100 }, 0);
    dispatchPointer(harness.canvas, 'pointermove', 1, { x: 100, y: 100 }, 20);
    dispatchPointer(harness.canvas, 'pointerup', 1, { x: 100, y: 100 }, 20);
    const releaseX = harness.camera().x;

    expect(harness.handler.advanceNavigation(36)).toBe(true);
    expect(harness.camera().x).toBeGreaterThan(releaseX);
    dispatchPointer(harness.canvas, 'pointerdown', 2, { x: 300, y: 100 }, 40);
    const interruptedX = harness.camera().x;
    expect(harness.handler.advanceNavigation(56)).toBe(false);
    expect(harness.camera().x).toBe(interruptedX);
    dispatchCancel(harness.canvas, 2);

    expect(JSON.stringify(harness.model)).toBe(canonicalBefore);
    expect(harness.effects).toEqual({ dirty: 0, history: 0 });
  });

  it('does not fling after the finger pauses longer than the velocity window', () => {
    const harness = mount({ x: 0, y: 0, zoom: 1 }, (camera) =>
      boundedCamera(camera, null, VIEWPORT),
    );
    dispatchPointer(harness.canvas, 'pointerdown', 1, { x: 200, y: 100 }, 0);
    dispatchPointer(harness.canvas, 'pointermove', 1, { x: 100, y: 100 }, 20);
    dispatchPointer(harness.canvas, 'pointerup', 1, { x: 100, y: 100 }, 140);
    const released = harness.camera();

    expect(harness.handler.advanceNavigation(156)).toBe(false);
    expect(harness.camera()).toEqual(released);
  });

  it('cancels transient navigation on pointercancel and detach', () => {
    const clamp = (camera: Camera) => boundedCamera(camera, FRAME, VIEWPORT);
    const cancelled = mount({ x: -744, y: 0, zoom: 1 }, clamp);
    dispatchPointer(cancelled.canvas, 'pointerdown', 1, { x: 100, y: 100 }, 0);
    dispatchPointer(cancelled.canvas, 'pointermove', 1, { x: 180, y: 100 }, 20);
    dispatchCancel(cancelled.canvas, 1);
    expect(cancelled.camera()).toEqual(clamp(cancelled.camera()));
    expect(cancelled.handler.advanceNavigation(40)).toBe(false);

    const detached = mount({ x: 0, y: 0, zoom: 1 });
    dispatchPointer(detached.canvas, 'pointerdown', 2, { x: 200, y: 100 }, 0);
    dispatchPointer(detached.canvas, 'pointermove', 2, { x: 100, y: 100 }, 20);
    dispatchPointer(detached.canvas, 'pointerup', 2, { x: 100, y: 100 }, 20);
    detached.handler.detach();
    expect(detached.handler.advanceNavigation(40)).toBe(false);

    const readOnly = mount({ x: 0, y: 0, zoom: 1 });
    dispatchPointer(readOnly.canvas, 'pointerdown', 3, { x: 200, y: 100 }, 0);
    dispatchPointer(readOnly.canvas, 'pointermove', 3, { x: 100, y: 100 }, 20);
    dispatchPointer(readOnly.canvas, 'pointerup', 3, { x: 100, y: 100 }, 20);
    readOnly.handler.resetForReadOnly();
    expect(readOnly.handler.advanceNavigation(40)).toBe(false);
  });

  it('settles immediately when reduced motion is requested', () => {
    const clamp = (camera: Camera) => boundedCamera(camera, FRAME, VIEWPORT);
    const harness = mount({ x: -744, y: 0, zoom: 1 }, clamp, {
      reducedMotion: () => true,
    });
    dispatchPointer(harness.canvas, 'pointerdown', 1, { x: 100, y: 100 }, 0);
    dispatchPointer(harness.canvas, 'pointermove', 1, { x: 180, y: 100 }, 20);
    dispatchPointer(harness.canvas, 'pointerup', 1, { x: 180, y: 100 }, 20);

    expect(harness.camera()).toEqual(clamp(harness.camera()));
    expect(harness.handler.advanceNavigation(40)).toBe(false);
  });
});

describe('standalone Surface primary touch pair', () => {
  it('does not let a third contact alter the active pair centroid or distance', () => {
    const harness = mount({ x: 0, y: 0, zoom: 1 });
    dispatchPointer(harness.canvas, 'pointerdown', 1, { x: 100, y: 100 });
    dispatchPointer(harness.canvas, 'pointerdown', 2, { x: 200, y: 100 });
    dispatchPointer(harness.canvas, 'pointerdown', 3, { x: 700, y: 500 });
    const beforePalmMove = harness.camera();

    dispatchPointer(harness.canvas, 'pointermove', 3, { x: 760, y: 540 });

    expect(harness.camera()).toEqual(beforePalmMove);
  });

  it('rebases a deterministic replacement pair without a coordinate jump', () => {
    const harness = mount({ x: 0, y: 0, zoom: 1 });
    dispatchPointer(harness.canvas, 'pointerdown', 1, { x: 100, y: 100 });
    dispatchPointer(harness.canvas, 'pointerdown', 2, { x: 200, y: 100 });
    dispatchPointer(harness.canvas, 'pointerdown', 3, { x: 300, y: 100 });
    dispatchPointer(harness.canvas, 'pointerdown', 4, { x: 400, y: 100 });

    dispatchPointer(harness.canvas, 'pointerup', 1, { x: 100, y: 100 });
    const replacementCentroid = { x: 250, y: 100 };
    const anchoredSurfacePoint = viewToSurface(
      harness.camera(),
      replacementCentroid,
    );
    dispatchPointer(harness.canvas, 'pointermove', 2, { x: 201, y: 100 });

    const movedCentroid = { x: 250.5, y: 100 };
    const afterReplacementMove = viewToSurface(harness.camera(), movedCentroid);
    expect(afterReplacementMove.x).toBeCloseTo(anchoredSurfacePoint.x, 9);
    expect(afterReplacementMove.y).toBeCloseTo(anchoredSurfacePoint.y, 9);
  });
});

describe('standalone Surface transient navigation signal', () => {
  it('reports live touch pan, pinch, and release physics as transient', () => {
    const harness = mount({ x: 0, y: 0, zoom: 1 }, (camera) =>
      boundedCamera(camera, null, VIEWPORT),
    );
    expect(harness.handler.hasTransientNavigation()).toBe(false);

    dispatchPointer(harness.canvas, 'pointerdown', 1, { x: 200, y: 100 }, 0);
    dispatchPointer(harness.canvas, 'pointermove', 1, { x: 100, y: 100 }, 20);
    expect(harness.handler.hasTransientNavigation()).toBe(true);

    dispatchPointer(harness.canvas, 'pointerdown', 2, { x: 300, y: 100 }, 20);
    expect(harness.handler.hasTransientNavigation()).toBe(true);

    dispatchPointer(harness.canvas, 'pointerup', 2, { x: 300, y: 100 }, 24);
    dispatchPointer(harness.canvas, 'pointerup', 1, { x: 100, y: 100 }, 24);
    dispatchCancel(harness.canvas, 1);
    expect(harness.handler.hasTransientNavigation()).toBe(false);

    dispatchPointer(harness.canvas, 'pointerdown', 3, { x: 200, y: 100 }, 100);
    dispatchPointer(harness.canvas, 'pointermove', 3, { x: 100, y: 100 }, 120);
    dispatchPointer(harness.canvas, 'pointerup', 3, { x: 100, y: 100 }, 120);
    expect(harness.handler.hasTransientNavigation()).toBe(true);

    advanceUntilIdle(harness, 120);
    expect(harness.handler.hasTransientNavigation()).toBe(false);
  });
});

describe('embedded Surface delegation parity', () => {
  interface EmbeddedSpies {
    readonly pans: Point[];
    readonly zooms: {
      readonly factor: number;
      readonly point: Point;
      readonly translation: Point;
    }[];
    readonly panEnds: Point[];
    letZoomEnds: number;
    letCancels: number;
    letWheels: number;
    letRenders: number;
  }

  function mountEmbedded(initialCamera: Camera): {
    harness: NavigationHarness;
    spies: EmbeddedSpies;
  } {
    const spies: EmbeddedSpies = {
      pans: [],
      zooms: [],
      panEnds: [],
      letZoomEnds: 0,
      letCancels: 0,
      letWheels: 0,
      letRenders: 0,
    };
    const harness = mount({ ...initialCamera }, (camera) => camera, {
      navigationMode: 'embedded',
      scheduleRender: () => {
        spies.letRenders += 1;
      },
      onEmbeddedPan: (delta) => {
        spies.pans.push({ ...delta });
      },
      onEmbeddedZoom: (gesture) => {
        spies.zooms.push({
          factor: gesture.factor,
          point: { ...gesture.point },
          translation: { ...gesture.translation },
        });
      },
      onEmbeddedPanEnd: (velocity) => {
        spies.panEnds.push({ ...velocity });
      },
      onEmbeddedZoomEnd: () => {
        spies.letZoomEnds += 1;
      },
      onEmbeddedCancel: () => {
        spies.letCancels += 1;
      },
      onEmbeddedWheel: () => {
        spies.letWheels += 1;
      },
    });
    return { harness, spies };
  }

  function dispatchWheel(
    canvas: HTMLCanvasElement,
    init: WheelEventInit & { clientX?: number; clientY?: number },
  ): WheelEvent {
    const event = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      ...init,
    });
    canvas.dispatchEvent(event);
    return event;
  }

  it('fails without the fix: forwards pan deltas on both axes without touching local camera, animation, or render', () => {
    const { harness, spies } = mountEmbedded({ x: 5, y: 7, zoom: 2 });
    const before = harness.camera();
    dispatchPointer(harness.canvas, 'pointerdown', 1, { x: 300, y: 300 }, 0);
    dispatchPointer(harness.canvas, 'pointermove', 1, { x: 200, y: 250 }, 20);

    // Both axes forwarded (the X-drop fix); local camera untouched.
    expect(spies.pans).toEqual([{ x: 100, y: 50 }]);
    expect(harness.camera()).toEqual(before);
    // No local release animation is ever populated for embedded input.
    expect(harness.handler.advanceNavigation(40)).toBe(false);
    expect(spies.letRenders).toBe(0);

    dispatchPointer(harness.canvas, 'pointerup', 1, { x: 200, y: 250 }, 20);
    // Release forwards velocity (pager absorbs the fling) with no local
    // decay/spring and no render.
    expect(spies.panEnds).toHaveLength(1);
    expect(
      Math.hypot(spies.panEnds[0]!.x, spies.panEnds[0]!.y),
    ).toBeGreaterThan(0);
    expect(harness.handler.advanceNavigation(40)).toBe(false);
    expect(harness.camera()).toEqual(before);
    expect(spies.letRenders).toBe(0);
  });

  it('forwards pinch as incremental factors with rebase and never publishes locally', () => {
    const { harness, spies } = mountEmbedded({ x: 0, y: 0, zoom: 1 });
    const before = harness.camera();
    dispatchPointer(harness.canvas, 'pointerdown', 1, { x: 100, y: 100 }, 0);
    dispatchPointer(harness.canvas, 'pointerdown', 2, { x: 200, y: 100 }, 0);
    dispatchPointer(harness.canvas, 'pointermove', 2, { x: 220, y: 100 }, 20);
    expect(spies.zooms).toHaveLength(1);
    const firstFactor = spies.zooms[0]!.factor;
    expect(firstFactor).toBeCloseTo(1.2, 9);

    // Second move rebases: factor is incremental from the rebased pair.
    dispatchPointer(harness.canvas, 'pointermove', 2, { x: 242, y: 100 }, 40);
    expect(spies.zooms).toHaveLength(2);
    expect(spies.zooms[1]!.factor).toBeCloseTo(142 / 120, 9);
    expect(harness.camera()).toEqual(before);
    expect(harness.handler.advanceNavigation(60)).toBe(false);
    expect(spies.letRenders).toBe(0);

    // Lifting the last finger forwards ZoomEnd exactly once.
    dispatchPointer(harness.canvas, 'pointerup', 1, { x: 100, y: 100 }, 44);
    expect(spies.letZoomEnds).toBe(0);
    dispatchPointer(harness.canvas, 'pointerup', 2, { x: 242, y: 100 }, 48);
    expect(spies.letZoomEnds).toBe(1);
    expect(harness.handler.advanceNavigation(64)).toBe(false);
    expect(harness.camera()).toEqual(before);
    expect(spies.letRenders).toBe(0);
  });

  it('keeps wheel preventDefault only for ctrl/meta and routes plain wheel to onEmbeddedWheel (never cancel)', () => {
    const { harness, spies } = mountEmbedded({ x: 0, y: 0, zoom: 1 });
    const before = harness.camera();
    const zoomed = dispatchWheel(harness.canvas, {
      clientX: 100,
      clientY: 100,
      ctrlKey: true,
      deltaY: -100,
    });
    expect(zoomed.defaultPrevented).toBe(true);
    expect(spies.zooms).toHaveLength(1);
    expect(spies.zooms[0]!.factor).toBeCloseTo(Math.exp(0.2), 9);
    expect(harness.camera()).toEqual(before);

    const plain = dispatchWheel(harness.canvas, { deltaY: 80 });
    // Plain wheel stays native (no preventDefault) and routes to the
    // gutter-parity wheel path — never the true-abort cancel path, so the
    // pager can preserve an open preview instead of discarding it.
    expect(plain.defaultPrevented).toBe(false);
    expect(spies.letWheels).toBe(1);
    expect(spies.letCancels).toBe(0);
    expect(spies.zooms).toHaveLength(1);
    expect(harness.camera()).toEqual(before);
    expect(harness.handler.advanceNavigation(40)).toBe(false);
  });

  it('forwards zero velocity after a pause and stays safe on cancel/detach', () => {
    const { harness, spies } = mountEmbedded({ x: 0, y: 0, zoom: 1 });
    dispatchPointer(harness.canvas, 'pointerdown', 5, { x: 200, y: 100 }, 0);
    dispatchPointer(harness.canvas, 'pointermove', 5, { x: 100, y: 100 }, 20);
    // Pause longer than the velocity window, then lift without moving.
    dispatchPointer(harness.canvas, 'pointerup', 5, { x: 100, y: 100 }, 500);
    expect(spies.panEnds).toHaveLength(1);
    expect(spies.panEnds[0]).toEqual({ x: 0, y: 0 });
    expect(harness.handler.advanceNavigation(520)).toBe(false);

    const { harness: cancelled, spies: cancelledSpies } = mountEmbedded({
      x: 0,
      y: 0,
      zoom: 1,
    });
    const cameraBefore = cancelled.camera();
    dispatchPointer(cancelled.canvas, 'pointerdown', 6, { x: 200, y: 100 }, 0);
    dispatchPointer(cancelled.canvas, 'pointermove', 6, { x: 100, y: 100 }, 20);
    dispatchCancel(cancelled.canvas, 6);
    expect(cancelledSpies.letCancels).toBe(1);
    expect(cancelledSpies.panEnds).toHaveLength(0);
    expect(cancelled.camera()).toEqual(cameraBefore);
    expect(cancelled.handler.advanceNavigation(40)).toBe(false);

    // Detach mid-gesture never throws, clears, and forwards cancel.
    const { harness: detached, spies: detachedSpies } = mountEmbedded({
      x: 0,
      y: 0,
      zoom: 1,
    });
    dispatchPointer(detached.canvas, 'pointerdown', 7, { x: 200, y: 100 }, 0);
    dispatchPointer(detached.canvas, 'pointermove', 7, { x: 100, y: 100 }, 20);
    expect(() => detached.handler.detach()).not.toThrow();
    expect(detachedSpies.letCancels).toBe(1);
    expect(detached.handler.advanceNavigation(40)).toBe(false);
  });

  it('forwards a pinch 2->1 survivor drag as pan deltas with a single ZoomEnd commit', () => {
    const { harness, spies } = mountEmbedded({ x: 0, y: 0, zoom: 1 });
    dispatchPointer(harness.canvas, 'pointerdown', 1, { x: 100, y: 100 }, 0);
    dispatchPointer(harness.canvas, 'pointerdown', 2, { x: 200, y: 100 }, 0);
    dispatchPointer(harness.canvas, 'pointermove', 2, { x: 220, y: 100 }, 20);
    expect(spies.zooms).toHaveLength(1);
    // Lift one finger; survivor remains — no commit yet.
    dispatchPointer(harness.canvas, 'pointerup', 1, { x: 100, y: 100 }, 24);
    expect(spies.letZoomEnds).toBe(0);
    expect(spies.panEnds).toHaveLength(0);
    // Drag survivor 50px: must forward as pan (never frozen).
    dispatchPointer(harness.canvas, 'pointermove', 2, { x: 270, y: 100 }, 40);
    expect(spies.pans).toHaveLength(1);
    expect(spies.pans[0]).toEqual({ x: -50, y: 0 });
    // Last lift commits once via ZoomEnd (pinch stayed open for embedded).
    dispatchPointer(harness.canvas, 'pointerup', 2, { x: 270, y: 100 }, 48);
    expect(spies.letZoomEnds).toBe(1);
    expect(spies.panEnds).toHaveLength(0);
    expect(spies.letRenders).toBe(0);
    expect(harness.handler.advanceNavigation(64)).toBe(false);
  });

  it('unifies cancel survivor with up survivor (both forward as pan, never freeze)', () => {
    const { harness, spies } = mountEmbedded({ x: 0, y: 0, zoom: 1 });
    dispatchPointer(harness.canvas, 'pointerdown', 1, { x: 100, y: 100 }, 0);
    dispatchPointer(harness.canvas, 'pointerdown', 2, { x: 200, y: 100 }, 0);
    dispatchPointer(harness.canvas, 'pointermove', 2, { x: 220, y: 100 }, 20);
    expect(spies.zooms).toHaveLength(1);
    // Cancel one finger with a survivor remaining: must NOT forward Cancel
    // (gesture continues, parity with the up path).
    dispatchCancel(harness.canvas, 1);
    expect(spies.letCancels).toBe(0);
    dispatchPointer(harness.canvas, 'pointermove', 2, { x: 270, y: 100 }, 40);
    expect(spies.pans).toHaveLength(1);
    expect(spies.pans[0]).toEqual({ x: -50, y: 0 });
    // Full cancel of the last finger forwards Cancel once (never commits).
    dispatchCancel(harness.canvas, 2);
    expect(spies.letCancels).toBe(1);
    expect(spies.letZoomEnds).toBe(0);
    expect(spies.panEnds).toHaveLength(0);
  });
});

describe('read-only Surface navigation closure', () => {
  function mountReadOnly(
    initialCamera: Camera,
    clamp: PointerControllerDeps['clampToSheet'],
  ): NavigationHarness {
    const canonical = JSON.stringify(emptySurface(boundedFrame(800, 600)));
    void canonical;
    return mount(initialCamera, clamp, { isReadOnly: () => true });
  }

  it('settles already-read-only overzoom to MAX_ZOOM exactly without canonical mutation', () => {
    const clamp = (camera: Camera) => boundedCamera(camera, FRAME, VIEWPORT);
    const harness = mountReadOnly({ x: 0, y: 0, zoom: MAX_ZOOM - 0.1 }, clamp);
    const canonicalBefore = JSON.stringify(harness.model);
    dispatchPointer(harness.canvas, 'pointerdown', 1, { x: 100, y: 100 }, 0);
    dispatchPointer(harness.canvas, 'pointerdown', 2, { x: 200, y: 100 }, 0);
    dispatchPointer(harness.canvas, 'pointermove', 2, { x: 300, y: 100 }, 20);
    expect(harness.camera().zoom).toBeGreaterThan(MAX_ZOOM);
    dispatchPointer(harness.canvas, 'pointerup', 2, { x: 300, y: 100 }, 20);
    dispatchPointer(harness.canvas, 'pointerup', 1, { x: 100, y: 100 }, 20);

    advanceUntilIdle(harness, 20);
    expect(harness.camera().zoom).toBe(MAX_ZOOM);
    expect(harness.camera()).toEqual(clamp(harness.camera()));
    expect(harness.handler.hasTransientNavigation()).toBe(false);
    expect(JSON.stringify(harness.model)).toBe(canonicalBefore);
    expect(harness.effects).toEqual({ dirty: 0, history: 0 });
  });

  it('settles already-read-only underzoom to MIN_ZOOM exactly without canonical mutation', () => {
    const clamp = (camera: Camera) => boundedCamera(camera, FRAME, VIEWPORT);
    const harness = mountReadOnly({ x: 0, y: 0, zoom: MIN_ZOOM + 0.01 }, clamp);
    const canonicalBefore = JSON.stringify(harness.model);
    dispatchPointer(harness.canvas, 'pointerdown', 1, { x: 100, y: 100 }, 0);
    dispatchPointer(harness.canvas, 'pointerdown', 2, { x: 200, y: 100 }, 0);
    dispatchPointer(harness.canvas, 'pointermove', 2, { x: 150, y: 100 }, 20);
    expect(harness.camera().zoom).toBeLessThan(MIN_ZOOM);
    dispatchPointer(harness.canvas, 'pointerup', 2, { x: 150, y: 100 }, 20);
    dispatchPointer(harness.canvas, 'pointerup', 1, { x: 100, y: 100 }, 20);

    advanceUntilIdle(harness, 20);
    expect(harness.camera().zoom).toBe(MIN_ZOOM);
    expect(harness.camera()).toEqual(clamp(harness.camera()));
    expect(harness.handler.hasTransientNavigation()).toBe(false);
    expect(harness.page.classList.contains('panning')).toBe(false);
    expect(JSON.stringify(harness.model)).toBe(canonicalBefore);
    expect(harness.effects).toEqual({ dirty: 0, history: 0 });
  });

  it('settles already-read-only bounded overscroll to the exact legal bound', () => {
    const clamp = (camera: Camera) => boundedCamera(camera, FRAME, VIEWPORT);
    const harness = mountReadOnly({ x: -744, y: 0, zoom: 1 }, clamp);
    const canonicalBefore = JSON.stringify(harness.model);
    dispatchPointer(harness.canvas, 'pointerdown', 1, { x: 100, y: 100 }, 0);
    dispatchPointer(harness.canvas, 'pointermove', 1, { x: 180, y: 100 }, 20);
    expect(harness.camera().x).toBeLessThan(-744);
    dispatchPointer(harness.canvas, 'pointerup', 1, { x: 180, y: 100 }, 20);

    advanceUntilIdle(harness, 20);
    expect(harness.camera().x).toBe(-744);
    expect(harness.camera()).toEqual(clamp(harness.camera()));
    expect(harness.handler.hasTransientNavigation()).toBe(false);
    expect(harness.page.classList.contains('panning')).toBe(false);
    expect(JSON.stringify(harness.model)).toBe(canonicalBefore);
    expect(harness.effects).toEqual({ dirty: 0, history: 0 });
  });

  it('advances read-only release inertia without dirty or history effects', () => {
    const harness = mount(
      { x: 0, y: 0, zoom: 1 },
      (camera) => boundedCamera(camera, null, VIEWPORT),
      { isReadOnly: () => true },
    );
    const canonicalBefore = JSON.stringify(harness.model);
    dispatchPointer(harness.canvas, 'pointerdown', 1, { x: 200, y: 100 }, 0);
    dispatchPointer(harness.canvas, 'pointermove', 1, { x: 100, y: 100 }, 20);
    dispatchPointer(harness.canvas, 'pointerup', 1, { x: 100, y: 100 }, 20);
    const releaseX = harness.camera().x;

    expect(harness.handler.advanceNavigation(36)).toBe(true);
    expect(harness.camera().x).toBeGreaterThan(releaseX);
    advanceUntilIdle(harness, 36);
    expect(harness.handler.hasTransientNavigation()).toBe(false);
    expect(harness.page.classList.contains('panning')).toBe(false);
    expect(JSON.stringify(harness.model)).toBe(canonicalBefore);
    expect(harness.effects).toEqual({ dirty: 0, history: 0 });
  });

  it('settles pending animation when read-only flips mid-flight instead of stranding transient', () => {
    const clamp = (camera: Camera) => boundedCamera(camera, FRAME, VIEWPORT);
    let readOnly = false;
    const harness = mount({ x: -744, y: 0, zoom: 1 }, clamp, {
      isReadOnly: () => readOnly,
    });
    const canonicalBefore = JSON.stringify(harness.model);
    dispatchPointer(harness.canvas, 'pointerdown', 1, { x: 100, y: 100 }, 0);
    dispatchPointer(harness.canvas, 'pointermove', 1, { x: 180, y: 100 }, 20);
    dispatchPointer(harness.canvas, 'pointerup', 1, { x: 180, y: 100 }, 20);
    expect(harness.camera().x).toBeLessThan(-744);

    readOnly = true;
    advanceUntilIdle(harness, 20);
    expect(harness.camera().x).toBe(-744);
    expect(harness.camera()).toEqual(clamp(harness.camera()));
    expect(harness.handler.hasTransientNavigation()).toBe(false);
    expect(harness.page.classList.contains('panning')).toBe(false);
    expect(JSON.stringify(harness.model)).toBe(canonicalBefore);
    expect(harness.effects).toEqual({ dirty: 0, history: 0 });
  });

  it('legalizes transient navigation on resetForReadOnly and terminates on detach', () => {
    const clamp = (camera: Camera) => boundedCamera(camera, FRAME, VIEWPORT);
    const transitioning = mount({ x: -744, y: 0, zoom: 1 }, clamp);
    dispatchPointer(
      transitioning.canvas,
      'pointerdown',
      1,
      { x: 100, y: 100 },
      0,
    );
    dispatchPointer(
      transitioning.canvas,
      'pointermove',
      1,
      { x: 180, y: 100 },
      20,
    );
    expect(transitioning.camera().x).toBeLessThan(-744);
    transitioning.handler.resetForReadOnly();
    expect(transitioning.camera().x).toBe(-744);
    expect(transitioning.handler.advanceNavigation(40)).toBe(false);
    expect(transitioning.handler.hasTransientNavigation()).toBe(false);

    const detached = mount({ x: 0, y: 0, zoom: 1 }, (camera) =>
      boundedCamera(camera, null, VIEWPORT),
    );
    dispatchPointer(detached.canvas, 'pointerdown', 2, { x: 200, y: 100 }, 0);
    dispatchPointer(detached.canvas, 'pointermove', 2, { x: 100, y: 100 }, 20);
    dispatchPointer(detached.canvas, 'pointerup', 2, { x: 100, y: 100 }, 20);
    expect(detached.handler.hasTransientNavigation()).toBe(true);
    detached.handler.detach();
    expect(detached.handler.hasTransientNavigation()).toBe(false);
    expect(detached.handler.advanceNavigation(40)).toBe(false);
  });

  it('clears panning chrome when already-read-only overscroll settles to the exact bound', () => {
    const clamp = (camera: Camera) => boundedCamera(camera, FRAME, VIEWPORT);
    const harness = mountReadOnly({ x: -744, y: 0, zoom: 1 }, clamp);
    const canonicalBefore = JSON.stringify(harness.model);
    dispatchPointer(harness.canvas, 'pointerdown', 1, { x: 100, y: 100 }, 0);
    dispatchPointer(harness.canvas, 'pointermove', 1, { x: 180, y: 100 }, 20);
    expect(harness.camera().x).toBeLessThan(-744);
    expect(harness.page.classList.contains('panning')).toBe(true);
    dispatchPointer(harness.canvas, 'pointerup', 1, { x: 180, y: 100 }, 20);

    advanceUntilIdle(harness, 20);
    expect(harness.camera().x).toBe(-744);
    expect(harness.camera()).toEqual(clamp(harness.camera()));
    expect(harness.handler.hasTransientNavigation()).toBe(false);
    expect(harness.page.classList.contains('panning')).toBe(false);
    expect(harness.handler.advanceNavigation(40)).toBe(false);
    expect(JSON.stringify(harness.model)).toBe(canonicalBefore);
    expect(harness.effects).toEqual({ dirty: 0, history: 0 });
  });

  it('tolerates cancel and lost-capture while read-only without throwing and settles exact', () => {
    const clamp = (camera: Camera) => boundedCamera(camera, FRAME, VIEWPORT);
    const harness = mountReadOnly({ x: 0, y: 0, zoom: MAX_ZOOM - 0.1 }, clamp);
    const canonicalBefore = JSON.stringify(harness.model);
    dispatchPointer(harness.canvas, 'pointerdown', 1, { x: 100, y: 100 }, 0);
    dispatchPointer(harness.canvas, 'pointerdown', 2, { x: 200, y: 100 }, 0);
    dispatchPointer(harness.canvas, 'pointermove', 2, { x: 300, y: 100 }, 20);
    expect(harness.camera().zoom).toBeGreaterThan(MAX_ZOOM);

    expect(() => dispatchCancel(harness.canvas, 2)).not.toThrow();
    expect(() => {
      harness.canvas.dispatchEvent(
        new Event('lostpointercapture', { bubbles: true, cancelable: true }),
      );
    }).not.toThrow();
    dispatchPointer(harness.canvas, 'pointerup', 1, { x: 100, y: 100 }, 24);

    advanceUntilIdle(harness, 24);
    expect(harness.camera().zoom).toBe(MAX_ZOOM);
    expect(harness.camera()).toEqual(clamp(harness.camera()));
    expect(harness.handler.hasTransientNavigation()).toBe(false);
    expect(harness.page.classList.contains('panning')).toBe(false);
    expect(JSON.stringify(harness.model)).toBe(canonicalBefore);
    expect(harness.effects).toEqual({ dirty: 0, history: 0 });
  });
});

describe('Surface navigation repair cases', () => {
  function dispatchLost(
    canvas: HTMLCanvasElement,
    id: number,
    point: Point,
    timeMs?: number,
  ): void {
    const event = new MouseEvent('lostpointercapture', {
      bubbles: true,
      cancelable: true,
      clientX: point.x,
      clientY: point.y,
      button: 0,
    }) as unknown as PointerEvent;
    Object.defineProperty(event, 'pointerId', { value: id });
    Object.defineProperty(event, 'pointerType', { value: 'touch' });
    if (timeMs !== undefined)
      Object.defineProperty(event, 'timeStamp', { value: timeMs });
    canvas.dispatchEvent(event);
  }

  function dispatchWheelRaw(
    canvas: HTMLCanvasElement,
    init: WheelEventInit & { clientX?: number; clientY?: number },
  ): WheelEvent {
    const event = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      ...init,
    });
    canvas.dispatchEvent(event);
    return event;
  }

  it('infinite-fling lost arms decay (not snap-discard)', () => {
    // Whiteboard infinite frame: clamp is identity via null frame, so any
    // snap would freeze while decay must keep moving.
    const harness = mount({ x: 10_000, y: -10_000, zoom: 1 }, (camera) =>
      boundedCamera(camera, null, VIEWPORT),
    );
    const canonicalBefore = JSON.stringify(harness.model);
    dispatchPointer(harness.canvas, 'pointerdown', 1, { x: 300, y: 100 }, 0);
    dispatchPointer(harness.canvas, 'pointermove', 1, { x: 100, y: 100 }, 20);
    const atRelease = harness.camera().x;
    // Lost with no survivors must legalize like a release: decay arms
    // (advance returns true, camera keeps gliding), never a snap-discard
    // (which would return false and freeze at the release camera).
    dispatchLost(harness.canvas, 1, { x: 100, y: 100 }, 24);
    expect(harness.handler.hasTransientNavigation()).toBe(true);
    expect(harness.handler.advanceNavigation(40)).toBe(true);
    expect(harness.camera().x).toBeGreaterThan(atRelease);
    advanceUntilIdle(harness, 40);
    expect(harness.handler.hasTransientNavigation()).toBe(false);
    expect(JSON.stringify(harness.model)).toBe(canonicalBefore);
    expect(harness.effects).toEqual({ dirty: 0, history: 0 });
  });

  it('true pointercancel still discards (no decay)', () => {
    const harness = mount({ x: 10_000, y: -10_000, zoom: 1 }, (camera) =>
      boundedCamera(camera, null, VIEWPORT),
    );
    dispatchPointer(harness.canvas, 'pointerdown', 1, { x: 300, y: 100 }, 0);
    dispatchPointer(harness.canvas, 'pointermove', 1, { x: 100, y: 100 }, 20);
    const transient = harness.camera().x;
    dispatchCancel(harness.canvas, 1);
    // Discard keeps the transient camera but arms nothing.
    expect(harness.camera().x).toBe(transient);
    expect(harness.handler.advanceNavigation(40)).toBe(false);
    expect(harness.handler.hasTransientNavigation()).toBe(false);
  });

  it('NaN plain-wheel deltas never poison the infinite camera', () => {
    const harness = mount({ x: 1_000, y: 2_000, zoom: 1 }, (camera) =>
      boundedCamera(camera, null, VIEWPORT),
    );
    const canonicalBefore = JSON.stringify(harness.model);
    const before = harness.camera();
    // jsdom rejects non-finite WheelEventInit, so craft a finite event then
    // poison the deltas like a pathological browser would.
    const event = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaX: 0,
      deltaY: 0,
    });
    Object.defineProperties(event, {
      deltaX: { value: Number.NaN },
      deltaY: { value: Number.NaN },
    });
    harness.canvas.dispatchEvent(event);
    const after = harness.camera();
    expect(Number.isFinite(after.x)).toBe(true);
    expect(Number.isFinite(after.y)).toBe(true);
    expect(after).toEqual(before);
    // Recovers: a finite wheel pans exactly once afterwards.
    dispatchWheelRaw(harness.canvas, { deltaX: 40, deltaY: 20 });
    expect(harness.camera().x).toBeCloseTo(before.x + 40, 9);
    expect(harness.camera().y).toBeCloseTo(before.y + 20, 9);
    expect(JSON.stringify(harness.model)).toBe(canonicalBefore);
    expect(harness.effects).toEqual({ dirty: 0, history: 0 });
  });

  it('infinite null-frame clamp stays finite on NaN input', () => {
    const next = boundedCamera(
      { x: Number.NaN, y: Number.NaN, zoom: 1 },
      null,
      VIEWPORT,
    );
    expect(Number.isFinite(next.x)).toBe(true);
    expect(Number.isFinite(next.y)).toBe(true);
  });

  it('attach→detach→attach drives a new gesture with a single registration', () => {
    const harness = mount({ x: 0, y: 0, zoom: 1 }, (camera) =>
      boundedCamera(camera, null, VIEWPORT),
    );
    // First gesture works.
    dispatchPointer(harness.canvas, 'pointerdown', 1, { x: 200, y: 100 }, 0);
    dispatchPointer(harness.canvas, 'pointermove', 1, { x: 100, y: 100 }, 20);
    const first = harness.camera().x;
    expect(first).toBeGreaterThan(0);
    dispatchPointer(harness.canvas, 'pointerup', 1, { x: 100, y: 100 }, 20);
    // Detach clears transient; double-detach is safe.
    harness.handler.detach();
    expect(harness.handler.hasTransientNavigation()).toBe(false);
    expect(harness.handler.advanceNavigation(40)).toBe(false);
    harness.handler.detach();
    // Reattach drives a fresh gesture (no stuck mode, no double listener).
    harness.handler.attach(harness.root);
    // Double-attach is a single registration (guarded).
    harness.handler.attach(harness.root);
    dispatchPointer(harness.canvas, 'pointerdown', 2, { x: 200, y: 100 }, 100);
    dispatchPointer(harness.canvas, 'pointermove', 2, { x: 100, y: 100 }, 120);
    const second = harness.camera().x;
    // Exactly one pan step from the fresh gesture (100px / zoom 1).
    expect(second - first).toBeCloseTo(100, 6);
    dispatchPointer(harness.canvas, 'pointerup', 2, { x: 100, y: 100 }, 120);
    expect(harness.handler.hasTransientNavigation()).toBe(true);
    advanceUntilIdle(harness, 120);
    expect(harness.handler.hasTransientNavigation()).toBe(false);
  });
});
describe('standalone Surface elastic wheel-zoom parity with pinch', () => {
  function dispatchWheel(
    canvas: HTMLCanvasElement,
    init: WheelEventInit & { clientX?: number; clientY?: number },
    timeMs?: number,
  ): WheelEvent {
    // Construct with finite values (jsdom validates), then override to the
    // exact requested deltas (including NaN) so finite-guards are exercised.
    const finiteDeltaX =
      typeof init.deltaX === 'number' && Number.isFinite(init.deltaX)
        ? init.deltaX
        : 0;
    const finiteDeltaY =
      typeof init.deltaY === 'number' && Number.isFinite(init.deltaY)
        ? init.deltaY
        : 0;
    const event = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      ctrlKey: init.ctrlKey,
      metaKey: init.metaKey,
      deltaX: finiteDeltaX,
      deltaY: finiteDeltaY,
      ...(typeof init.clientX === 'number' ? { clientX: init.clientX } : {}),
      ...(typeof init.clientY === 'number' ? { clientY: init.clientY } : {}),
    });
    if (init.deltaX !== undefined && init.deltaX !== finiteDeltaX) {
      Object.defineProperty(event, 'deltaX', { value: init.deltaX });
    }
    if (init.deltaY !== undefined && init.deltaY !== finiteDeltaY) {
      Object.defineProperty(event, 'deltaY', { value: init.deltaY });
    }
    if (timeMs !== undefined) {
      Object.defineProperty(event, 'timeStamp', { value: timeMs });
    }
    canvas.dispatchEvent(event);
    return event;
  }

  function wheelZoomFactor(deltaY: number): number {
    return Math.exp(-deltaY * 0.002);
  }

  function mountEmbeddedForWheel(initialCamera: Camera): {
    harness: NavigationHarness;
    spies: {
      readonly pans: Point[];
      readonly zooms: {
        readonly factor: number;
        readonly point: Point;
        readonly translation: Point;
      }[];
      readonly panEnds: Point[];
      readonly userNavigated: boolean[];
      letRenders: number;
    };
  } {
    const spies: {
      pans: Point[];
      zooms: {
        factor: number;
        point: Point;
        translation: Point;
      }[];
      panEnds: Point[];
      userNavigated: boolean[];
      letRenders: number;
    } = {
      pans: [],
      zooms: [],
      panEnds: [],
      userNavigated: [],
      letRenders: 0,
    };
    const harness = mount({ ...initialCamera }, (camera) => camera, {
      navigationMode: 'embedded',
      scheduleRender: () => {
        spies.letRenders += 1;
      },
      onEmbeddedPan: (delta) => {
        spies.pans.push({ ...delta });
      },
      onEmbeddedZoom: (gesture) => {
        spies.zooms.push({
          factor: gesture.factor,
          point: { ...gesture.point },
          translation: { ...gesture.translation },
        });
      },
      onEmbeddedPanEnd: (velocity) => {
        spies.panEnds.push({ ...velocity });
      },
      setUserNavigated: (value) => {
        spies.userNavigated.push(value);
      },
      onEmbeddedZoomEnd: () => undefined,
      onEmbeddedCancel: () => undefined,
      onEmbeddedWheel: () => undefined,
    });
    return { harness, spies };
  }

  it('forwards middle-button desktop pan to the pager without moving the page camera', () => {
    const { harness, spies } = mountEmbeddedForWheel({ x: 5, y: 7, zoom: 2 });
    const before = harness.camera();
    dispatchMousePan(harness.canvas, 'pointerdown', { x: 300, y: 200 });
    dispatchMousePan(harness.canvas, 'pointermove', { x: 260, y: 170 });
    dispatchMousePan(harness.canvas, 'pointerup', { x: 260, y: 170 });

    expect(spies.pans).toEqual([{ x: 40, y: 30 }]);
    expect(spies.panEnds).toHaveLength(1);
    expect(harness.camera()).toEqual(before);
    expect(spies.userNavigated).toEqual([]);
    expect(spies.letRenders).toBe(0);
  });

  it('keeps an inside-bounds wheel zoom cursor-anchored within 2px with no spring', () => {
    const harness = mount({ x: 0, y: 0, zoom: 1 }, (camera) =>
      boundedCamera(camera, FRAME, VIEWPORT),
    );
    const anchor = { x: 400, y: 300 };
    const beforeSurface = viewToSurface(harness.camera(), anchor);
    dispatchWheel(
      harness.canvas,
      {
        clientX: anchor.x,
        clientY: anchor.y,
        ctrlKey: true,
        deltaY: -100,
      },
      20,
    );
    const after = harness.camera();
    const expectedZoom = 1 * wheelZoomFactor(-100);
    expect(after.zoom).toBeCloseTo(expectedZoom, 9);
    // Cursor-anchored: the surface point under the cursor is preserved.
    const afterSurface = viewToSurface(after, anchor);
    expect(afterSurface.x).toBeCloseTo(beforeSurface.x, 9);
    expect(afterSurface.y).toBeCloseTo(beforeSurface.y, 9);
    // View-space error ≤2px (exact here since inside bounds, no resistance).
    const viewX = (beforeSurface.x - after.x) * after.zoom;
    const viewY = (beforeSurface.y - after.y) * after.zoom;
    expect(Math.abs(viewX - anchor.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(viewY - anchor.y)).toBeLessThanOrEqual(2);
    // Inside bounds: no spring armed, single shared frame only.
    expect(harness.handler.hasTransientNavigation()).toBe(false);
    expect(harness.handler.advanceNavigation(36)).toBe(false);
    expect(harness.camera()).toEqual(after);
  });

  it.each([
    {
      name: 'maximum',
      startZoom: MAX_ZOOM - 0.1,
      deltaY: -100,
      limit: MAX_ZOOM,
    },
    {
      name: 'minimum',
      startZoom: MIN_ZOOM + 0.01,
      deltaY: 100,
      limit: MIN_ZOOM,
    },
  ] as const)(
    'shows elastic overzoom beyond the $name with diminishing gain then settles exactly',
    ({ startZoom, deltaY, limit }) => {
      const clamp = (camera: Camera) => boundedCamera(camera, FRAME, VIEWPORT);
      const harness = mount({ x: 0, y: 0, zoom: startZoom }, clamp);
      const anchor = { x: 400, y: 300 };
      const factor = wheelZoomFactor(deltaY);
      const requested = startZoom * factor;
      const firstEvent = dispatchWheel(
        harness.canvas,
        {
          clientX: anchor.x,
          clientY: anchor.y,
          ctrlKey: true,
          deltaY,
        },
        20,
      );
      const first = harness.camera();
      // Elastic visual: beyond the limit but short of the hard request.
      if (limit === MAX_ZOOM) {
        expect(first.zoom).toBeGreaterThan(MAX_ZOOM);
        expect(first.zoom).toBeLessThan(requested);
      } else {
        expect(first.zoom).toBeLessThan(MIN_ZOOM);
        expect(first.zoom).toBeGreaterThan(requested);
      }
      // The first tick may overshoot stylishly, but its legal target is now
      // saturated: repeated outward input must not add zoom debt or drift.
      dispatchWheel(
        harness.canvas,
        {
          clientX: anchor.x,
          clientY: anchor.y,
          ctrlKey: true,
          deltaY,
        },
        24,
      );
      const second = harness.camera();
      expect(second).toEqual(first);
      // Spring-back: no hard jump (first step stays over the limit), then
      // settles exactly to the legal zoom within the shared animation.
      expect(harness.handler.hasTransientNavigation()).toBe(true);
      const stepTime = Number(firstEvent.timeStamp) + 16;
      expect(harness.handler.advanceNavigation(stepTime)).toBe(true);
      expect(harness.camera().zoom).not.toBe(limit);
      advanceUntilIdle(harness, stepTime);
      expect(Math.abs(harness.camera().zoom - limit)).toBeLessThanOrEqual(
        0.001,
      );
      expect(harness.camera().zoom).toBe(limit);
      expect(harness.camera()).toEqual(clamp(harness.camera()));
      expect(harness.handler.hasTransientNavigation()).toBe(false);
    },
  );

  it('never zooms on plain-wheel pan and ignores non-finite deltas', () => {
    const clamp = (camera: Camera) => boundedCamera(camera, FRAME, VIEWPORT);
    const harness = mount({ x: 0, y: 0, zoom: 1 }, clamp);
    const before = harness.camera();
    dispatchWheel(harness.canvas, { deltaX: 10, deltaY: 20 }, 20);
    const panned = harness.camera();
    expect(panned.zoom).toBe(before.zoom);
    expect(panned.x).not.toBe(before.x);
    expect(panned.y).not.toBe(before.y);
    expect(panned).toEqual(clamp(panned));
    expect(harness.handler.advanceNavigation(36)).toBe(false);

    // Non-finite plain deltas are ignored (no poison, no frame side-effect).
    const pannedBefore = harness.camera();
    dispatchWheel(
      harness.canvas,
      {
        deltaX: Number.NaN,
        deltaY: Number.NaN,
      },
      40,
    );
    expect(harness.camera()).toEqual(pannedBefore);

    // Non-finite ctrl-wheel deltas are ignored (camera untouched).
    const zoomBefore = harness.camera();
    dispatchWheel(
      harness.canvas,
      {
        clientX: 400,
        clientY: 300,
        ctrlKey: true,
        deltaY: Number.NaN,
      },
      44,
    );
    expect(harness.camera()).toEqual(zoomBefore);
    expect(harness.handler.advanceNavigation(60)).toBe(false);
  });

  it('discards the armed wheel-spring on a mid-spring plain-wheel pan', () => {
    const clamp = (camera: Camera) => boundedCamera(camera, FRAME, VIEWPORT);
    const harness = mount({ x: 0, y: 0, zoom: MAX_ZOOM - 0.1 }, clamp);
    const anchor = { x: 400, y: 300 };
    // Overzoom arms the shared settle spring (elastic visual beyond MAX).
    dispatchWheel(
      harness.canvas,
      {
        clientX: anchor.x,
        clientY: anchor.y,
        ctrlKey: true,
        deltaY: -100,
      },
      20,
    );
    const over = harness.camera();
    expect(over.zoom).toBeGreaterThan(MAX_ZOOM);
    expect(harness.handler.hasTransientNavigation()).toBe(true);
    // Plain-wheel pan mid-spring: the stale spring target (snapshotted
    // pre-pan by `beginSpring`) is discarded — the pan applies to the kept
    // camera and the pan path's clamp legalizes the zoom.
    dispatchWheel(harness.canvas, { deltaX: 10, deltaY: 20 }, 24);
    const panned = harness.camera();
    expect(harness.handler.hasTransientNavigation()).toBe(false);
    expect(panned.zoom).toBe(MAX_ZOOM);
    expect(panned).toEqual(clamp(panned));
    // Pan preserved from the kept camera (positive deltas move +x/+y).
    expect(panned.x).toBeGreaterThan(over.x);
    expect(panned.y).toBeGreaterThan(over.y);
    // No jump-back: no animation remains, so stepping is a no-op and the
    // camera stays exactly where the pan left it.
    expect(harness.handler.advanceNavigation(40)).toBe(false);
    expect(harness.camera()).toEqual(panned);
  });

  it('snaps to legal on reduced-motion with no elastic visual and no animation', () => {
    const clamp = (camera: Camera) => boundedCamera(camera, FRAME, VIEWPORT);
    const harness = mount({ x: 0, y: 0, zoom: MAX_ZOOM }, clamp, {
      reducedMotion: () => true,
    });
    dispatchWheel(
      harness.canvas,
      {
        clientX: 400,
        clientY: 300,
        ctrlKey: true,
        deltaY: -100,
      },
      20,
    );
    // Reduced-motion: identical to the settled target, never elastic.
    expect(harness.camera().zoom).toBe(MAX_ZOOM);
    expect(harness.camera()).toEqual(clamp(harness.camera()));
    expect(harness.handler.hasTransientNavigation()).toBe(false);
    expect(harness.handler.advanceNavigation(36)).toBe(false);
  });

  it('preserves infinite position-unclamped but zoom-clamped semantics', () => {
    const infiniteClamp = (camera: Camera) =>
      boundedCamera(camera, null, VIEWPORT);
    const harness = mount({ x: 10_000, y: -10_000, zoom: 1 }, infiniteClamp);
    const anchor = { x: 400, y: 300 };
    dispatchWheel(
      harness.canvas,
      {
        clientX: anchor.x,
        clientY: anchor.y,
        ctrlKey: true,
        deltaY: -100,
      },
      20,
    );
    const after = harness.camera();
    // Zoom follows the elastic factor; far-field position stays unclamped.
    expect(after.zoom).toBeCloseTo(wheelZoomFactor(-100), 9);
    expect(Math.abs(after.x)).toBeGreaterThan(9_000);
    expect(Math.abs(after.y)).toBeGreaterThan(9_000);
    expect(harness.handler.advanceNavigation(36)).toBe(false);

    // Overzoom on infinite still elastics zoom and settles zoom exactly
    // while leaving the far-field position alone.
    const over = mount(
      { x: 10_000, y: 0, zoom: MAX_ZOOM - 0.1 },
      infiniteClamp,
    );
    const overEvent = dispatchWheel(
      over.canvas,
      {
        clientX: anchor.x,
        clientY: anchor.y,
        ctrlKey: true,
        deltaY: -200,
      },
      20,
    );
    expect(over.camera().zoom).toBeGreaterThan(MAX_ZOOM);
    const overX = over.camera().x;
    advanceUntilIdle(over, Number(overEvent.timeStamp));
    expect(over.camera().zoom).toBe(MAX_ZOOM);
    // Position was never clamped away: still far-field, only anchor-shifted.
    expect(Math.abs(over.camera().x - overX)).toBeLessThan(500);
    expect(over.camera().x).toBeGreaterThan(9_000);
  });

  it('keeps wheel-zoom ephemeral with a single shared frame and settles on detach', () => {
    const clamp = (camera: Camera) => boundedCamera(camera, FRAME, VIEWPORT);
    let renders = 0;
    const canonicalHarness = mount(
      { x: 0, y: 0, zoom: MAX_ZOOM - 0.1 },
      clamp,
      {
        scheduleRender: () => {
          renders += 1;
        },
      },
    );
    const canonicalBefore = JSON.stringify(canonicalHarness.model);
    const wheelEvent = dispatchWheel(
      canonicalHarness.canvas,
      {
        clientX: 400,
        clientY: 300,
        ctrlKey: true,
        deltaY: -100,
      },
      20,
    );
    expect(renders).toBe(1);
    expect(canonicalHarness.handler.hasTransientNavigation()).toBe(true);
    advanceUntilIdle(canonicalHarness, Number(wheelEvent.timeStamp));
    expect(JSON.stringify(canonicalHarness.model)).toBe(canonicalBefore);
    expect(canonicalHarness.effects).toEqual({ dirty: 0, history: 0 });

    // Detach mid-spring legalizes (no stranded transient, no second rAF).
    const detached = mount({ x: 0, y: 0, zoom: MAX_ZOOM - 0.1 }, clamp);
    dispatchWheel(
      detached.canvas,
      {
        clientX: 400,
        clientY: 300,
        ctrlKey: true,
        deltaY: -100,
      },
      20,
    );
    expect(detached.camera().zoom).toBeGreaterThan(MAX_ZOOM);
    detached.handler.detach();
    expect(detached.camera().zoom).toBe(MAX_ZOOM);
    expect(detached.camera()).toEqual(clamp(detached.camera()));
    expect(detached.handler.hasTransientNavigation()).toBe(false);
    expect(detached.handler.advanceNavigation(64)).toBe(false);
  });

  it('runs wheel-zoom identically in read-only without dirty or history', () => {
    const clamp = (camera: Camera) => boundedCamera(camera, FRAME, VIEWPORT);
    const harness = mount({ x: 0, y: 0, zoom: MAX_ZOOM - 0.1 }, clamp, {
      isReadOnly: () => true,
    });
    const canonicalBefore = JSON.stringify(harness.model);
    const wheelEvent = dispatchWheel(
      harness.canvas,
      {
        clientX: 400,
        clientY: 300,
        ctrlKey: true,
        deltaY: -100,
      },
      20,
    );
    expect(harness.camera().zoom).toBeGreaterThan(MAX_ZOOM);
    expect(harness.handler.hasTransientNavigation()).toBe(true);
    advanceUntilIdle(harness, Number(wheelEvent.timeStamp));
    expect(harness.camera().zoom).toBe(MAX_ZOOM);
    expect(JSON.stringify(harness.model)).toBe(canonicalBefore);
    expect(harness.effects).toEqual({ dirty: 0, history: 0 });
  });

  it('never animates locally in embedded mode (pager preview owns the gesture)', () => {
    const { harness, spies } = mountEmbeddedForWheel({ x: 5, y: 7, zoom: 2 });
    const before = harness.camera();
    const zoomed = dispatchWheel(
      harness.canvas,
      {
        clientX: 100,
        clientY: 100,
        ctrlKey: true,
        deltaY: -100,
      },
      20,
    );
    expect(zoomed.defaultPrevented).toBe(true);
    expect(spies.zooms).toHaveLength(1);
    expect(harness.camera()).toEqual(before);
    expect(harness.handler.hasTransientNavigation()).toBe(false);
    expect(harness.handler.advanceNavigation(40)).toBe(false);
    expect(spies.letRenders).toBe(0);
  });
});
