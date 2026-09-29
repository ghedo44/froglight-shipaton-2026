/**
 * Standalone wheel/pinch parity integration.
 *
 * Pins that ctrl/meta-wheel and two-finger pinch share one elastic visual
 * (`elasticZoom` + `zoomCameraAroundPointUnclamped` + `transientCamera`) and
 * one shared spring settle to the same clamped target. Uses the public
 * pointer-controller seam with the production `boundedCamera` clamp so the
 * composition — not just the units — is covered.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  boundedFrame,
  emptySurface,
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

interface Harness {
  readonly canvas: HTMLCanvasElement;
  readonly page: HTMLElement;
  readonly root: HTMLElement;
  readonly handler: ReturnType<typeof createPointerController>;
  readonly effects: { dirty: number; history: number };
  readonly model: ReturnType<typeof emptySurface>;
  camera(): Camera;
}

function createHarness(
  initialCamera: Camera,
  clamp: PointerControllerDeps['clampToSheet'] = (camera) => camera,
  overrides: Partial<PointerControllerDeps> = {},
): Harness {
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
    clampToSheet: clamp,
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
    effects,
    model,
    camera: () => ({ ...camera }),
  };
}

const mounted: Harness[] = [];

function mount(
  initialCamera: Camera,
  clamp?: PointerControllerDeps['clampToSheet'],
  overrides?: Partial<PointerControllerDeps>,
): Harness {
  const harness = createHarness(initialCamera, clamp, overrides);
  mounted.push(harness);
  return harness;
}

afterEach(() => {
  for (const harness of mounted.splice(0)) {
    harness.handler.detach();
    harness.root.remove();
  }
});

function dispatchTouch(
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

function dispatchWheel(
  canvas: HTMLCanvasElement,
  init: WheelEventInit & { clientX?: number; clientY?: number },
  timeMs?: number,
): WheelEvent {
  const finiteDeltaY =
    typeof init.deltaY === 'number' && Number.isFinite(init.deltaY)
      ? init.deltaY
      : 0;
  const event = new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    ctrlKey: init.ctrlKey,
    deltaY: finiteDeltaY,
    ...(typeof init.clientX === 'number' ? { clientX: init.clientX } : {}),
    ...(typeof init.clientY === 'number' ? { clientY: init.clientY } : {}),
  });
  if (init.deltaY !== undefined && init.deltaY !== finiteDeltaY) {
    Object.defineProperty(event, 'deltaY', { value: init.deltaY });
  }
  if (timeMs !== undefined) {
    Object.defineProperty(event, 'timeStamp', { value: timeMs });
  }
  canvas.dispatchEvent(event);
  return event;
}

function advanceUntilIdle(harness: Harness, startTimeMs: number): void {
  let timeMs = startTimeMs;
  for (let frame = 0; frame < 240; frame += 1) {
    timeMs += 1000 / 60;
    if (!harness.handler.advanceNavigation(timeMs)) return;
  }
  throw new Error('navigation animation did not settle');
}

describe('wheel/pinch elastic parity integration', () => {
  it.each([
    { name: 'maximum', startZoom: MAX_ZOOM - 0.1, deltaY: -100 },
    { name: 'minimum', startZoom: MIN_ZOOM + 0.01, deltaY: 100 },
  ] as const)(
    'produces the same elastic visual for wheel and pinch at the $name',
    ({ startZoom, deltaY }) => {
      const clamp = (camera: Camera) => boundedCamera(camera, FRAME, VIEWPORT);
      const startCamera = clamp({ x: 0, y: 0, zoom: startZoom });
      const wheel = mount(startCamera, clamp);
      const pinch = mount(startCamera, clamp);
      // Wheel factor for this delta.
      const factor = Math.exp(-deltaY * 0.002);
      dispatchWheel(
        wheel.canvas,
        { clientX: 400, clientY: 300, ctrlKey: true, deltaY },
        20,
      );
      // Pinch factor matched to the same requested zoom: start distance 100,
      // end distance 100 * factor.
      const startDistance = 100;
      const endDistance = startDistance * factor;
      const centerX = 150;
      dispatchTouch(
        pinch.canvas,
        'pointerdown',
        1,
        { x: centerX - startDistance / 2, y: 100 },
        0,
      );
      dispatchTouch(
        pinch.canvas,
        'pointerdown',
        2,
        { x: centerX + startDistance / 2, y: 100 },
        0,
      );
      dispatchTouch(
        pinch.canvas,
        'pointermove',
        2,
        { x: centerX + endDistance - startDistance / 2, y: 100 },
        20,
      );
      // Same elastic visual (within float tolerance; both use elasticZoom +
      // unclamped anchor + resisted position).
      expect(wheel.camera().zoom).toBeCloseTo(pinch.camera().zoom, 6);
      // Same settle target via the shared spring.
      const wheelEventTime = 20;
      const pinchReleaseTime = 20;
      dispatchTouch(
        pinch.canvas,
        'pointerup',
        2,
        { x: centerX + endDistance - startDistance / 2, y: 100 },
        pinchReleaseTime,
      );
      dispatchTouch(
        pinch.canvas,
        'pointerup',
        1,
        { x: centerX - startDistance / 2, y: 100 },
        pinchReleaseTime,
      );
      advanceUntilIdle(wheel, wheelEventTime);
      advanceUntilIdle(pinch, pinchReleaseTime);
      expect(wheel.camera().zoom).toBe(pinch.camera().zoom);
      expect(wheel.camera()).toEqual(clamp(wheel.camera()));
      expect(pinch.camera()).toEqual(clamp(pinch.camera()));
    },
  );

  it('settles wheel and pinch to the same legal camera without canonical effects', () => {
    const clamp = (camera: Camera) => boundedCamera(camera, FRAME, VIEWPORT);
    const wheel = mount({ x: 0, y: 0, zoom: MAX_ZOOM }, clamp);
    const pinch = mount({ x: 0, y: 0, zoom: MAX_ZOOM }, clamp);
    const wheelCameraBefore = wheel.camera();
    const pinchCameraBefore = pinch.camera();
    const wheelBefore = JSON.stringify(wheel.model);
    const pinchBefore = JSON.stringify(pinch.model);
    dispatchWheel(
      wheel.canvas,
      { clientX: 400, clientY: 300, ctrlKey: true, deltaY: -100 },
      20,
    );
    dispatchTouch(pinch.canvas, 'pointerdown', 1, { x: 100, y: 100 }, 0);
    dispatchTouch(pinch.canvas, 'pointerdown', 2, { x: 200, y: 100 }, 0);
    dispatchTouch(pinch.canvas, 'pointermove', 1, { x: 40, y: 100 }, 20);
    dispatchTouch(pinch.canvas, 'pointermove', 2, { x: 260, y: 100 }, 20);
    dispatchTouch(pinch.canvas, 'pointerup', 2, { x: 260, y: 100 }, 20);
    dispatchTouch(pinch.canvas, 'pointerup', 1, { x: 40, y: 100 }, 20);
    advanceUntilIdle(wheel, 20);
    advanceUntilIdle(pinch, 20);
    expect(wheel.camera().zoom).toBe(MAX_ZOOM);
    expect(pinch.camera().zoom).toBe(MAX_ZOOM);
    expect(wheel.camera()).toEqual(wheelCameraBefore);
    expect(pinch.camera()).toEqual(pinchCameraBefore);
    expect(JSON.stringify(wheel.model)).toBe(wheelBefore);
    expect(JSON.stringify(pinch.model)).toBe(pinchBefore);
    expect(wheel.effects).toEqual({ dirty: 0, history: 0 });
    expect(pinch.effects).toEqual({ dirty: 0, history: 0 });
  });

  it('keeps plain-wheel pan zoom-free while ctrl-wheel zooms (mode matrix)', () => {
    const clamp = (camera: Camera) => boundedCamera(camera, FRAME, VIEWPORT);
    const harness = mount({ x: 0, y: 0, zoom: 1 }, clamp);
    dispatchWheel(harness.canvas, { deltaX: 8, deltaY: 12 }, 20);
    const panned = harness.camera();
    expect(panned.zoom).toBe(1);
    dispatchWheel(
      harness.canvas,
      { clientX: 400, clientY: 300, ctrlKey: true, deltaY: -100 },
      24,
    );
    expect(harness.camera().zoom).toBeGreaterThan(panned.zoom);
  });

  it('forwards embedded wheel without local animation while standalone animates', () => {
    const standalone = mount({ x: 5, y: 7, zoom: 2 }, (camera) => camera);
    const embeddedSpies: { zooms: number; renders: number } = {
      zooms: 0,
      renders: 0,
    };
    const embedded = mount({ x: 5, y: 7, zoom: 2 }, (camera) => camera, {
      navigationMode: 'embedded',
      scheduleRender: () => {
        embeddedSpies.renders += 1;
      },
      onEmbeddedZoom: () => {
        embeddedSpies.zooms += 1;
      },
    });
    const standaloneBefore = standalone.camera();
    const embeddedBefore = embedded.camera();
    dispatchWheel(
      standalone.canvas,
      { clientX: 100, clientY: 100, ctrlKey: true, deltaY: -100 },
      20,
    );
    dispatchWheel(
      embedded.canvas,
      { clientX: 100, clientY: 100, ctrlKey: true, deltaY: -100 },
      20,
    );
    // Standalone publishes locally; embedded never touches local camera.
    expect(standalone.camera()).not.toEqual(standaloneBefore);
    expect(embedded.camera()).toEqual(embeddedBefore);
    expect(embeddedSpies.zooms).toBe(1);
    expect(embeddedSpies.renders).toBe(0);
    expect(embedded.handler.advanceNavigation(40)).toBe(false);
  });
});
