import { afterEach, describe, expect, it } from 'vitest';
import {
  boundedFrame,
  emptySurface,
  infiniteFrame,
  viewToSurface,
  type Point,
} from '@froglight/foundation';
import { mountInkSurface, type InkSkeleton } from '../index.js';
import { MAX_ZOOM, MIN_ZOOM } from './camera.js';

function installCanvasStub(): () => void {
  const noop = (): void => undefined;
  const context = {
    save: noop,
    restore: noop,
    beginPath: noop,
    clip: noop,
    fill: noop,
    stroke: noop,
    rect: noop,
    fillRect: noop,
    strokeRect: noop,
    fillText: noop,
    ellipse: noop,
    translate: noop,
    rotate: noop,
    setTransform: noop,
    setLineDash: noop,
    clearRect: noop,
    drawImage: noop,
    moveTo: noop,
    lineTo: noop,
    arc: noop,
    closePath: noop,
    fillStyle: '',
    strokeStyle: '',
    font: '',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    globalAlpha: 1,
    textAlign: 'left',
    textBaseline: 'alphabetic',
    canvas: null,
  };
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function () {
    return context as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
  return () => {
    HTMLCanvasElement.prototype.getContext = original;
  };
}

function installManualFrames(): {
  readonly pending: () => number;
  readonly flushOne: (timeMs: number) => void;
  readonly restore: () => void;
} {
  const queue: FrameRequestCallback[] = [];
  const originalRequest = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  let nextId = 1;
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    queue.push(callback);
    return nextId++;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {
    queue.length = 0;
  }) as typeof cancelAnimationFrame;
  return {
    pending: () => queue.length,
    flushOne: (timeMs) => {
      const callback = queue.shift();
      if (callback === undefined) throw new Error('expected a pending frame');
      callback(timeMs);
    },
    restore: () => {
      queue.length = 0;
      globalThis.requestAnimationFrame = originalRequest;
      globalThis.cancelAnimationFrame = originalCancel;
    },
  };
}

function makeHost(): InkSkeleton {
  const root = document.createElement('div');
  const page = document.createElement('div');
  const canvas = document.createElement('canvas');
  const badge = document.createElement('div');
  const pointerIndicator = document.createElement('div');
  const overlayRoot = document.createElement('div');
  page.append(canvas, badge, pointerIndicator, overlayRoot);
  root.append(page);
  document.body.append(root);
  const bounds = {
    left: 0,
    top: 0,
    right: 800,
    bottom: 600,
    width: 800,
    height: 600,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;
  page.getBoundingClientRect = () => bounds;
  canvas.getBoundingClientRect = () => bounds;
  Object.defineProperties(page, {
    clientWidth: { configurable: true, get: () => 800 },
    clientHeight: { configurable: true, get: () => 600 },
  });
  return { root, page, canvas, badge, pointerIndicator, overlayRoot };
}

function touch(
  canvas: HTMLCanvasElement,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  x: number,
  timeMs: number,
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: 100,
    button: 0,
  });
  Object.defineProperties(event, {
    pointerId: { value: 1 },
    pointerType: { value: 'touch' },
    timeStamp: { value: timeMs },
  });
  canvas.dispatchEvent(event);
}

function touchPointer(
  canvas: HTMLCanvasElement,
  type:
    | 'pointerdown'
    | 'pointermove'
    | 'pointerup'
    | 'pointercancel'
    | 'lostpointercapture',
  id: number,
  point: Point,
  timeMs: number,
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: point.x,
    clientY: point.y,
    button: 0,
  });
  Object.defineProperties(event, {
    pointerId: { value: id },
    pointerType: { value: 'touch' },
    timeStamp: { value: timeMs },
  });
  canvas.dispatchEvent(event);
}

function authorPointer(
  canvas: HTMLCanvasElement,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  pointerType: 'pen' | 'mouse',
  id: number,
  point: Point,
  timeMs: number,
): void {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: point.x,
    clientY: point.y,
    button: 0,
    buttons: type === 'pointerup' ? 0 : 1,
  });
  Object.defineProperties(event, {
    pointerId: { value: id },
    pointerType: { value: pointerType },
    pressure: { value: type === 'pointerup' ? 0 : 0.5 },
    timeStamp: { value: timeMs },
  });
  canvas.dispatchEvent(event);
}

function flushUntilSettled(
  frames: ReturnType<typeof installManualFrames>,
  startTimeMs: number,
): void {
  let timeMs = startTimeMs;
  for (let count = 0; count < 300 && frames.pending() > 0; count += 1) {
    timeMs += 1000 / 60;
    frames.flushOne(timeMs);
  }
  expect(frames.pending()).toBe(0);
}

const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
  document.body.replaceChildren();
});

describe('mounted Surface navigation frame ownership', () => {
  it('coalesces move bursts and advances inertia through the existing render frame', () => {
    const restoreCanvas = installCanvasStub();
    const frames = installManualFrames();
    cleanup.push(restoreCanvas, frames.restore);
    const host = makeHost();
    const model = emptySurface(boundedFrame(800, 600));
    const canonicalBefore = JSON.stringify(model);
    let dirty = 0;
    const handle = mountInkSurface({
      model,
      host,
      initialCamera: { x: 0, y: 0, zoom: 1 },
      markDirty: () => {
        dirty += 1;
      },
    });
    cleanup.push(() => handle.destroy());
    frames.flushOne(0);
    const framesBefore = handle.diagnostics().renderFrames;

    touch(host.canvas, 'pointerdown', 300, 0);
    touch(host.canvas, 'pointermove', 260, 8);
    touch(host.canvas, 'pointermove', 220, 16);
    touch(host.canvas, 'pointermove', 180, 24);
    touch(host.canvas, 'pointerup', 180, 24);

    expect(frames.pending()).toBe(1);
    const releaseX = handle.camera().x;
    frames.flushOne(40);
    expect(handle.camera().x).toBeGreaterThan(releaseX);
    expect(handle.diagnostics().renderFrames).toBe(framesBefore + 1);
    expect(frames.pending()).toBe(1);
    expect(JSON.stringify(model)).toBe(canonicalBefore);
    expect(dirty).toBe(0);
    expect(handle.canUndo()).toBe(false);
  });

  it('keeps a simultaneous translated pinch anchored and rebases extra contacts without canonical history', () => {
    const restoreCanvas = installCanvasStub();
    const frames = installManualFrames();
    cleanup.push(restoreCanvas, frames.restore);
    const host = makeHost();
    const model = emptySurface(boundedFrame(2_000, 2_000));
    const canonicalBefore = JSON.stringify(model);
    let dirty = 0;
    const handle = mountInkSurface({
      model,
      host,
      initialCamera: { x: 200, y: 100, zoom: 1 },
      markDirty: () => {
        dirty += 1;
      },
    });
    cleanup.push(() => handle.destroy());
    frames.flushOne(0);

    const startCentroid = { x: 300, y: 200 };
    const anchor = viewToSurface(handle.camera(), startCentroid);
    touchPointer(host.canvas, 'pointerdown', 1, { x: 200, y: 200 }, 0);
    touchPointer(host.canvas, 'pointerdown', 2, { x: 400, y: 200 }, 0);
    touchPointer(host.canvas, 'pointerdown', 3, { x: 700, y: 500 }, 0);
    const beforeThird = handle.camera();
    touchPointer(host.canvas, 'pointermove', 3, { x: 760, y: 540 }, 8);
    expect(handle.camera()).toEqual(beforeThird);

    touchPointer(host.canvas, 'pointermove', 1, { x: 160, y: 180 }, 16);
    touchPointer(host.canvas, 'pointermove', 2, { x: 460, y: 220 }, 24);
    const nextCentroid = { x: 310, y: 200 };
    const anchored = viewToSurface(handle.camera(), nextCentroid);
    expect(anchored.x).toBeCloseTo(anchor.x, 9);
    expect(anchored.y).toBeCloseTo(anchor.y, 9);

    touchPointer(host.canvas, 'pointerup', 1, { x: 160, y: 180 }, 28);
    const replacementCentroid = { x: 610, y: 380 };
    const replacementAnchor = viewToSurface(
      handle.camera(),
      replacementCentroid,
    );
    touchPointer(host.canvas, 'pointermove', 2, { x: 462, y: 220 }, 32);
    const movedReplacementCentroid = { x: 611, y: 380 };
    expect(
      viewToSurface(handle.camera(), movedReplacementCentroid).x,
    ).toBeCloseTo(replacementAnchor.x, 9);

    touchPointer(host.canvas, 'pointerup', 3, { x: 760, y: 540 }, 36);
    const oneFingerCamera = handle.camera();
    touchPointer(host.canvas, 'pointermove', 2, { x: 450, y: 220 }, 44);
    expect(handle.camera()).not.toEqual(oneFingerCamera);
    expect(JSON.stringify(model)).toBe(canonicalBefore);
    expect(dirty).toBe(0);
    expect(handle.canUndo()).toBe(false);
  });

  it.each([MIN_ZOOM, MAX_ZOOM])(
    'settles mounted elastic zoom at %s to the exact limit',
    (limit) => {
      const restoreCanvas = installCanvasStub();
      const frames = installManualFrames();
      cleanup.push(restoreCanvas, frames.restore);
      const host = makeHost();
      const startZoom = limit === MAX_ZOOM ? MAX_ZOOM - 0.1 : MIN_ZOOM + 0.01;
      const handle = mountInkSurface({
        model: emptySurface(boundedFrame(2_000, 2_000)),
        host,
        initialCamera: { x: 200, y: 100, zoom: startZoom },
        markDirty: () => undefined,
      });
      cleanup.push(() => handle.destroy());
      frames.flushOne(0);

      touchPointer(host.canvas, 'pointerdown', 1, { x: 200, y: 200 }, 0);
      touchPointer(host.canvas, 'pointerdown', 2, { x: 400, y: 200 }, 0);
      touchPointer(
        host.canvas,
        'pointermove',
        2,
        { x: limit === MAX_ZOOM ? 700 : 300, y: 200 },
        20,
      );
      if (limit === MAX_ZOOM)
        expect(handle.camera().zoom).toBeGreaterThan(MAX_ZOOM);
      else expect(handle.camera().zoom).toBeLessThan(MIN_ZOOM);
      touchPointer(host.canvas, 'pointerup', 2, { x: 400, y: 200 }, 24);
      touchPointer(host.canvas, 'pointerup', 1, { x: 200, y: 200 }, 28);
      flushUntilSettled(frames, 28);

      expect(handle.camera().zoom).toBe(limit);
    },
  );

  it('hands bounded release inertia to edge settling and lands on the exact camera bound', () => {
    const restoreCanvas = installCanvasStub();
    const frames = installManualFrames();
    cleanup.push(restoreCanvas, frames.restore);
    const host = makeHost();
    const handle = mountInkSurface({
      model: emptySurface(boundedFrame(800, 600)),
      host,
      initialCamera: { x: 600, y: 0, zoom: 1 },
      markDirty: () => undefined,
    });
    cleanup.push(() => handle.destroy());
    frames.flushOne(0);

    touchPointer(host.canvas, 'pointerdown', 1, { x: 300, y: 100 }, 0);
    touchPointer(host.canvas, 'pointermove', 1, { x: 200, y: 100 }, 20);
    touchPointer(host.canvas, 'pointerup', 1, { x: 200, y: 100 }, 20);
    expect(handle.camera().x).toBe(700);
    frames.flushOne(36);
    expect(handle.camera().x).toBeGreaterThan(700);
    flushUntilSettled(frames, 36);

    expect(handle.camera().x).toBe(744);
  });

  it('rebases moved pan-to-pinch-to-pan, cancels inertia on new touch, and cleans lost capture', () => {
    const restoreCanvas = installCanvasStub();
    const frames = installManualFrames();
    cleanup.push(restoreCanvas, frames.restore);
    const host = makeHost();
    const handle = mountInkSurface({
      model: emptySurface(boundedFrame(2_000, 2_000)),
      host,
      initialCamera: { x: 200, y: 100, zoom: 1 },
      markDirty: () => undefined,
    });
    cleanup.push(() => handle.destroy());
    frames.flushOne(0);

    touchPointer(host.canvas, 'pointerdown', 1, { x: 300, y: 200 }, 0);
    touchPointer(host.canvas, 'pointermove', 1, { x: 250, y: 200 }, 12);
    const movedPan = handle.camera();
    touchPointer(host.canvas, 'pointerdown', 2, { x: 450, y: 200 }, 16);
    expect(handle.camera()).toEqual(movedPan);
    touchPointer(host.canvas, 'pointermove', 2, { x: 550, y: 200 }, 28);
    touchPointer(host.canvas, 'pointerup', 2, { x: 550, y: 200 }, 32);
    const handedOff = handle.camera();
    touchPointer(host.canvas, 'pointermove', 1, { x: 240, y: 200 }, 40);
    expect(handle.camera()).not.toEqual(handedOff);
    touchPointer(host.canvas, 'pointerup', 1, { x: 240, y: 200 }, 44);

    const released = handle.camera();
    touchPointer(host.canvas, 'pointerdown', 3, { x: 400, y: 200 }, 48);
    frames.flushOne(64);
    expect(handle.camera()).toEqual(released);
    touchPointer(host.canvas, 'lostpointercapture', 3, { x: 400, y: 200 }, 68);
    expect(handle.camera().zoom).toBeGreaterThanOrEqual(MIN_ZOOM);
    expect(handle.camera().zoom).toBeLessThanOrEqual(MAX_ZOOM);
  });

  it('rubber-bands direct touch overscroll and legalizes it on lost capture', () => {
    const restoreCanvas = installCanvasStub();
    const frames = installManualFrames();
    cleanup.push(restoreCanvas, frames.restore);
    const host = makeHost();
    const handle = mountInkSurface({
      model: emptySurface(boundedFrame(800, 600)),
      host,
      initialCamera: { x: -744, y: 0, zoom: 1 },
      markDirty: () => undefined,
    });
    cleanup.push(() => handle.destroy());
    frames.flushOne(0);

    touchPointer(host.canvas, 'pointerdown', 1, { x: 100, y: 100 }, 0);
    touchPointer(host.canvas, 'pointermove', 1, { x: 180, y: 100 }, 20);
    expect(handle.camera().x).toBeLessThan(-744);
    // A lost capture settles like a release via beginPanRelease
    // (decay/spring arms), not a snap-discard like cancel.
    touchPointer(host.canvas, 'lostpointercapture', 1, { x: 180, y: 100 }, 24);
    expect(frames.pending()).toBe(1);
    expect(handle.camera().x).toBeLessThan(-744);
    flushUntilSettled(frames, 24);
    expect(handle.camera().x).toBe(-744);
  });

  it.each(['pen', 'mouse'] as const)(
    'settles released overscroll before mounted %s authoring',
    (pointerType) => {
      const restoreCanvas = installCanvasStub();
      const frames = installManualFrames();
      cleanup.push(restoreCanvas, frames.restore);
      const host = makeHost();
      const model = emptySurface(boundedFrame(800, 600));
      let dirty = 0;
      const handle = mountInkSurface({
        model,
        host,
        initialCamera: { x: -744, y: 0, zoom: 1 },
        markDirty: () => {
          dirty += 1;
        },
      });
      cleanup.push(() => handle.destroy());
      frames.flushOne(0);
      touchPointer(host.canvas, 'pointerdown', 1, { x: 100, y: 100 }, 0);
      touchPointer(host.canvas, 'pointermove', 1, { x: 180, y: 100 }, 20);
      touchPointer(host.canvas, 'pointerup', 1, { x: 180, y: 100 }, 20);
      expect(handle.camera().x).toBeLessThan(-744);

      authorPointer(
        host.canvas,
        'pointerdown',
        pointerType,
        20,
        { x: 780, y: 200 },
        24,
      );
      expect(handle.camera().x).toBe(-744);
      authorPointer(
        host.canvas,
        'pointermove',
        pointerType,
        20,
        { x: 785, y: 205 },
        32,
      );
      authorPointer(
        host.canvas,
        'pointerup',
        pointerType,
        20,
        { x: 790, y: 210 },
        40,
      );
      expect(model.order.length).toBe(1);
      expect(dirty).toBe(1);
    },
  );

  it.each([
    { gesture: 'overscroll', pointerType: 'pen' },
    { gesture: 'overscroll', pointerType: 'mouse' },
    { gesture: 'overzoom', pointerType: 'pen' },
    { gesture: 'overzoom', pointerType: 'mouse' },
  ] as const)(
    'ends active mounted touch $gesture before $pointerType authoring',
    ({ gesture, pointerType }) => {
      const restoreCanvas = installCanvasStub();
      const frames = installManualFrames();
      cleanup.push(restoreCanvas, frames.restore);
      const host = makeHost();
      const model = emptySurface(boundedFrame(800, 600));
      let dirty = 0;
      const handle = mountInkSurface({
        model,
        host,
        initialCamera:
          gesture === 'overscroll'
            ? { x: -744, y: 0, zoom: 1 }
            : { x: 0, y: 0, zoom: MAX_ZOOM - 0.1 },
        markDirty: () => {
          dirty += 1;
        },
      });
      cleanup.push(() => handle.destroy());
      frames.flushOne(0);

      touchPointer(host.canvas, 'pointerdown', 1, { x: 100, y: 100 }, 0);
      if (gesture === 'overscroll') {
        touchPointer(host.canvas, 'pointermove', 1, { x: 180, y: 100 }, 20);
        expect(handle.camera().x).toBeLessThan(-744);
      } else {
        touchPointer(host.canvas, 'pointerdown', 2, { x: 200, y: 100 }, 0);
        touchPointer(host.canvas, 'pointermove', 2, { x: 320, y: 100 }, 20);
        expect(handle.camera().zoom).toBeGreaterThan(MAX_ZOOM);
      }

      authorPointer(
        host.canvas,
        'pointerdown',
        pointerType,
        20,
        gesture === 'overscroll' ? { x: 780, y: 200 } : { x: 300, y: 200 },
        24,
      );
      expect(handle.camera().x).toBeGreaterThanOrEqual(-744);
      expect(handle.camera().zoom).toBeLessThanOrEqual(MAX_ZOOM);

      // Late events from the terminated touch gesture cannot steal or end
      // the newly active authoring pointer.
      touchPointer(host.canvas, 'pointerup', 1, { x: 180, y: 100 }, 28);
      if (gesture === 'overzoom')
        touchPointer(host.canvas, 'pointerup', 2, { x: 320, y: 100 }, 28);
      authorPointer(
        host.canvas,
        'pointermove',
        pointerType,
        20,
        gesture === 'overscroll' ? { x: 785, y: 205 } : { x: 340, y: 220 },
        32,
      );
      authorPointer(
        host.canvas,
        'pointerup',
        pointerType,
        20,
        gesture === 'overscroll' ? { x: 790, y: 210 } : { x: 360, y: 230 },
        40,
      );

      expect(model.order.length).toBe(1);
      expect(dirty).toBe(1);
      expect(handle.canUndo()).toBe(true);
    },
  );

  it('keeps infinite-frame inertia unresisted and cancels transient state on read-only and destroy', () => {
    const restoreCanvas = installCanvasStub();
    const frames = installManualFrames();
    cleanup.push(restoreCanvas, frames.restore);
    const host = makeHost();
    const model = emptySurface(infiniteFrame());
    const handle = mountInkSurface({
      model,
      host,
      initialCamera: { x: 10_000, y: -10_000, zoom: 1 },
      markDirty: () => undefined,
    });
    cleanup.push(() => handle.destroy());
    frames.flushOne(0);

    touchPointer(host.canvas, 'pointerdown', 1, { x: 300, y: 100 }, 0);
    touchPointer(host.canvas, 'pointermove', 1, { x: 100, y: 100 }, 20);
    touchPointer(host.canvas, 'pointerup', 1, { x: 100, y: 100 }, 20);
    const releasedX = handle.camera().x;
    frames.flushOne(36);
    expect(handle.camera().x).toBeGreaterThan(releasedX);
    expect(handle.camera().x).toBeGreaterThan(10_000);

    touchPointer(host.canvas, 'pointerdown', 2, { x: 200, y: 100 }, 40);
    touchPointer(host.canvas, 'pointerdown', 3, { x: 300, y: 100 }, 40);
    touchPointer(host.canvas, 'pointermove', 3, { x: 700, y: 100 }, 56);
    expect(handle.camera().zoom).toBeGreaterThan(1);
    touchPointer(host.canvas, 'pointercancel', 3, { x: 700, y: 100 }, 60);
    handle.setReadOnly(true);
    expect(handle.camera().zoom).toBeLessThanOrEqual(MAX_ZOOM);
    handle.destroy();
    expect(frames.pending()).toBe(0);
  });
});

describe('mounted read-only Surface navigation settle', () => {
  it.each(['mouse', 'pen'] as const)(
    'pans with a %s drag in view mode without editing',
    (pointerType) => {
      const restoreCanvas = installCanvasStub();
      const frames = installManualFrames();
      cleanup.push(restoreCanvas, frames.restore);
      const host = makeHost();
      const model = emptySurface(infiniteFrame());
      let dirty = 0;
      const handle = mountInkSurface({
        model,
        host,
        initialCamera: { x: 0, y: 0, zoom: 1 },
        markDirty: () => {
          dirty += 1;
        },
      });
      cleanup.push(() => handle.destroy());
      frames.flushOne(0);
      handle.setReadOnly(true);
      const before = JSON.stringify(model);

      authorPointer(
        host.canvas,
        'pointerdown',
        pointerType,
        1,
        { x: 300, y: 100 },
        0,
      );
      authorPointer(
        host.canvas,
        'pointermove',
        pointerType,
        1,
        { x: 100, y: 100 },
        20,
      );
      expect(handle.camera().x).toBe(200);
      authorPointer(
        host.canvas,
        'pointerup',
        pointerType,
        1,
        { x: 100, y: 100 },
        20,
      );
      expect(JSON.stringify(model)).toBe(before);
      expect(dirty).toBe(0);
      expect(handle.canUndo()).toBe(false);
    },
  );

  it('settles already-read-only overzoom to MAX_ZOOM exactly without canonical mutation', () => {
    const restoreCanvas = installCanvasStub();
    const frames = installManualFrames();
    cleanup.push(restoreCanvas, frames.restore);
    const host = makeHost();
    const model = emptySurface(boundedFrame(2_000, 2_000));
    const canonicalBefore = JSON.stringify(model);
    let dirty = 0;
    const handle = mountInkSurface({
      model,
      host,
      initialCamera: { x: 200, y: 100, zoom: MAX_ZOOM - 0.1 },
      markDirty: () => {
        dirty += 1;
      },
    });
    cleanup.push(() => handle.destroy());
    frames.flushOne(0);
    handle.setReadOnly(true);

    touchPointer(host.canvas, 'pointerdown', 1, { x: 200, y: 200 }, 0);
    touchPointer(host.canvas, 'pointerdown', 2, { x: 400, y: 200 }, 0);
    touchPointer(host.canvas, 'pointermove', 2, { x: 700, y: 200 }, 20);
    expect(handle.camera().zoom).toBeGreaterThan(MAX_ZOOM);
    touchPointer(host.canvas, 'pointerup', 2, { x: 700, y: 200 }, 24);
    touchPointer(host.canvas, 'pointerup', 1, { x: 200, y: 200 }, 28);
    flushUntilSettled(frames, 28);

    expect(handle.camera().zoom).toBe(MAX_ZOOM);
    expect(JSON.stringify(model)).toBe(canonicalBefore);
    expect(dirty).toBe(0);
    expect(handle.canUndo()).toBe(false);
  });

  it('settles already-read-only underzoom to MIN_ZOOM exactly without canonical mutation', () => {
    const restoreCanvas = installCanvasStub();
    const frames = installManualFrames();
    cleanup.push(restoreCanvas, frames.restore);
    const host = makeHost();
    const model = emptySurface(boundedFrame(2_000, 2_000));
    const canonicalBefore = JSON.stringify(model);
    let dirty = 0;
    const handle = mountInkSurface({
      model,
      host,
      initialCamera: { x: 200, y: 100, zoom: MIN_ZOOM + 0.01 },
      markDirty: () => {
        dirty += 1;
      },
    });
    cleanup.push(() => handle.destroy());
    frames.flushOne(0);
    handle.setReadOnly(true);

    touchPointer(host.canvas, 'pointerdown', 1, { x: 200, y: 200 }, 0);
    touchPointer(host.canvas, 'pointerdown', 2, { x: 400, y: 200 }, 0);
    touchPointer(host.canvas, 'pointermove', 2, { x: 300, y: 200 }, 20);
    expect(handle.camera().zoom).toBeLessThan(MIN_ZOOM);
    touchPointer(host.canvas, 'pointerup', 2, { x: 300, y: 200 }, 24);
    touchPointer(host.canvas, 'pointerup', 1, { x: 200, y: 200 }, 28);
    flushUntilSettled(frames, 28);

    expect(handle.camera().zoom).toBe(MIN_ZOOM);
    expect(JSON.stringify(model)).toBe(canonicalBefore);
    expect(dirty).toBe(0);
    expect(handle.canUndo()).toBe(false);
  });

  it('settles already-read-only bounded overscroll to the exact legal bound', () => {
    const restoreCanvas = installCanvasStub();
    const frames = installManualFrames();
    cleanup.push(restoreCanvas, frames.restore);
    const host = makeHost();
    const model = emptySurface(boundedFrame(800, 600));
    const canonicalBefore = JSON.stringify(model);
    let dirty = 0;
    const handle = mountInkSurface({
      model,
      host,
      initialCamera: { x: -744, y: 0, zoom: 1 },
      markDirty: () => {
        dirty += 1;
      },
    });
    cleanup.push(() => handle.destroy());
    frames.flushOne(0);
    handle.setReadOnly(true);

    touchPointer(host.canvas, 'pointerdown', 1, { x: 100, y: 100 }, 0);
    touchPointer(host.canvas, 'pointermove', 1, { x: 180, y: 100 }, 20);
    expect(handle.camera().x).toBeLessThan(-744);
    touchPointer(host.canvas, 'pointerup', 1, { x: 180, y: 100 }, 20);
    flushUntilSettled(frames, 20);

    expect(handle.camera().x).toBe(-744);
    expect(JSON.stringify(model)).toBe(canonicalBefore);
    expect(dirty).toBe(0);
    expect(handle.canUndo()).toBe(false);
  });

  it('settles transient navigation when read-only is set mid-gesture and leaves no frame on destroy', () => {
    const restoreCanvas = installCanvasStub();
    const frames = installManualFrames();
    cleanup.push(restoreCanvas, frames.restore);
    const host = makeHost();
    const model = emptySurface(boundedFrame(800, 600));
    const canonicalBefore = JSON.stringify(model);
    let dirty = 0;
    const handle = mountInkSurface({
      model,
      host,
      initialCamera: { x: -744, y: 0, zoom: 1 },
      markDirty: () => {
        dirty += 1;
      },
    });
    cleanup.push(() => handle.destroy());
    frames.flushOne(0);

    touchPointer(host.canvas, 'pointerdown', 1, { x: 100, y: 100 }, 0);
    touchPointer(host.canvas, 'pointermove', 1, { x: 180, y: 100 }, 20);
    expect(handle.camera().x).toBeLessThan(-744);
    handle.setReadOnly(true);
    expect(handle.camera().x).toBe(-744);

    handle.destroy();
    expect(frames.pending()).toBe(0);
    expect(JSON.stringify(model)).toBe(canonicalBefore);
    expect(dirty).toBe(0);
    expect(handle.canUndo()).toBe(false);
  });

  it('clears panning chrome and settles already-read-only overscroll with no pending frame', () => {
    const restoreCanvas = installCanvasStub();
    const frames = installManualFrames();
    cleanup.push(restoreCanvas, frames.restore);
    const host = makeHost();
    const model = emptySurface(boundedFrame(800, 600));
    const canonicalBefore = JSON.stringify(model);
    let dirty = 0;
    const handle = mountInkSurface({
      model,
      host,
      initialCamera: { x: -744, y: 0, zoom: 1 },
      markDirty: () => {
        dirty += 1;
      },
    });
    cleanup.push(() => handle.destroy());
    frames.flushOne(0);
    handle.setReadOnly(true);

    touchPointer(host.canvas, 'pointerdown', 1, { x: 100, y: 100 }, 0);
    touchPointer(host.canvas, 'pointermove', 1, { x: 180, y: 100 }, 20);
    expect(handle.camera().x).toBeLessThan(-744);
    touchPointer(host.canvas, 'pointerup', 1, { x: 180, y: 100 }, 20);
    flushUntilSettled(frames, 20);

    expect(handle.camera().x).toBe(-744);
    expect(host.page.classList.contains('panning')).toBe(false);
    expect(frames.pending()).toBe(0);
    expect(JSON.stringify(model)).toBe(canonicalBefore);
    expect(dirty).toBe(0);
    expect(handle.canUndo()).toBe(false);
  });

  it('tolerates cancel and lost-capture while read-only without throwing and leaves no frame', () => {
    const restoreCanvas = installCanvasStub();
    const frames = installManualFrames();
    cleanup.push(restoreCanvas, frames.restore);
    const host = makeHost();
    const model = emptySurface(boundedFrame(800, 600));
    const canonicalBefore = JSON.stringify(model);
    let dirty = 0;
    const handle = mountInkSurface({
      model,
      host,
      initialCamera: { x: -744, y: 0, zoom: 1 },
      markDirty: () => {
        dirty += 1;
      },
    });
    cleanup.push(() => handle.destroy());
    frames.flushOne(0);
    handle.setReadOnly(true);

    touchPointer(host.canvas, 'pointerdown', 1, { x: 100, y: 100 }, 0);
    touchPointer(host.canvas, 'pointermove', 1, { x: 180, y: 100 }, 20);
    expect(handle.camera().x).toBeLessThan(-744);
    expect(() =>
      touchPointer(host.canvas, 'pointercancel', 1, { x: 180, y: 100 }, 24),
    ).not.toThrow();
    expect(() =>
      touchPointer(
        host.canvas,
        'lostpointercapture',
        1,
        { x: 180, y: 100 },
        28,
      ),
    ).not.toThrow();
    flushUntilSettled(frames, 28);

    expect(handle.camera().x).toBe(-744);
    expect(host.page.classList.contains('panning')).toBe(false);
    expect(frames.pending()).toBe(0);
    expect(JSON.stringify(model)).toBe(canonicalBefore);
    expect(dirty).toBe(0);
    expect(handle.canUndo()).toBe(false);
  });
});

describe('mounted embedded authoring preemption', () => {
  function mountEmbeddedSurface(): {
    readonly host: ReturnType<typeof makeHost>;
    readonly handle: ReturnType<typeof mountInkSurface>;
    readonly model: ReturnType<typeof emptySurface>;
    readonly cancels: { count: number };
    readonly panEnds: Point[];
    readonly zoomEnds: { count: number };
    readonly dirty: { count: number };
  } {
    const host = makeHost();
    const model = emptySurface(boundedFrame(800, 600));
    const cancels = { count: 0 };
    const panEnds: Point[] = [];
    const zoomEnds = { count: 0 };
    const dirty = { count: 0 };
    const handle = mountInkSurface({
      model,
      host,
      initialCamera: { x: 0, y: 0, zoom: 1 },
      markDirty: () => {
        dirty.count += 1;
      },
      navigationMode: 'embedded',
      onEmbeddedPan: () => undefined,
      onEmbeddedZoom: () => undefined,
      onEmbeddedPanEnd: (velocity: Point) => {
        panEnds.push({ ...velocity });
      },
      onEmbeddedZoomEnd: () => {
        zoomEnds.count += 1;
      },
      onEmbeddedCancel: () => {
        cancels.count += 1;
      },
    });
    return { host, handle, model, cancels, panEnds, zoomEnds, dirty };
  }

  it.each(['pen', 'mouse'] as const)(
    'forwards embedded cancel once when %s preempts an embedded 1-finger pan (no fling, no dirty)',
    (pointerType) => {
      const restoreCanvas = installCanvasStub();
      const frames = installManualFrames();
      cleanup.push(restoreCanvas, frames.restore);
      const { host, handle, model, cancels, panEnds, dirty } =
        mountEmbeddedSurface();
      cleanup.push(() => handle.destroy());
      frames.flushOne(0);
      const cameraBefore = handle.camera();

      touchPointer(host.canvas, 'pointerdown', 1, { x: 300, y: 200 }, 0);
      touchPointer(host.canvas, 'pointermove', 1, { x: 250, y: 200 }, 12);
      // Authoring preempts the active embedded pan: the pager must be told
      // to discard (single cancel, never a fling-producing PanEnd) and the
      // touch-only gesture must never dirty canonical content.
      authorPointer(
        host.canvas,
        'pointerdown',
        pointerType,
        20,
        { x: 300, y: 200 },
        24,
      );
      expect(cancels.count).toBe(1);
      expect(panEnds).toHaveLength(0);
      expect(dirty.count).toBe(0);
      // Local camera untouched by the embedded gesture or its termination.
      expect(handle.camera()).toEqual(cameraBefore);

      // Late touch release cannot revive navigation or end the authoring
      // pointer.
      touchPointer(host.canvas, 'pointerup', 1, { x: 250, y: 200 }, 28);
      expect(cancels.count).toBe(1);
      expect(panEnds).toHaveLength(0);
      authorPointer(
        host.canvas,
        'pointermove',
        pointerType,
        20,
        { x: 340, y: 220 },
        32,
      );
      authorPointer(
        host.canvas,
        'pointerup',
        pointerType,
        20,
        { x: 360, y: 230 },
        40,
      );
      expect(model.order.length).toBe(1);
      expect(dirty.count).toBe(1);
      expect(handle.canUndo()).toBe(true);
    },
  );

  it.each(['pen', 'mouse'] as const)(
    'forwards embedded cancel once when %s preempts an embedded pinch (no commit, no dirty)',
    (pointerType) => {
      const restoreCanvas = installCanvasStub();
      const frames = installManualFrames();
      cleanup.push(restoreCanvas, frames.restore);
      const { host, handle, model, cancels, panEnds, zoomEnds, dirty } =
        mountEmbeddedSurface();
      cleanup.push(() => handle.destroy());
      frames.flushOne(0);
      const cameraBefore = handle.camera();

      touchPointer(host.canvas, 'pointerdown', 1, { x: 100, y: 100 }, 0);
      touchPointer(host.canvas, 'pointerdown', 2, { x: 200, y: 100 }, 0);
      touchPointer(host.canvas, 'pointermove', 2, { x: 220, y: 100 }, 20);
      // Authoring preempts the active embedded pinch: the pager must discard
      // its preview (single cancel, never a ZoomEnd commit, never a PanEnd
      // fling, never canonical dirt).
      authorPointer(
        host.canvas,
        'pointerdown',
        pointerType,
        20,
        { x: 300, y: 200 },
        24,
      );
      expect(cancels.count).toBe(1);
      expect(zoomEnds.count).toBe(0);
      expect(panEnds).toHaveLength(0);
      expect(dirty.count).toBe(0);
      expect(handle.camera()).toEqual(cameraBefore);

      // Late touch releases cannot commit or revive navigation.
      touchPointer(host.canvas, 'pointerup', 1, { x: 100, y: 100 }, 28);
      touchPointer(host.canvas, 'pointerup', 2, { x: 220, y: 100 }, 28);
      expect(cancels.count).toBe(1);
      expect(zoomEnds.count).toBe(0);
      expect(panEnds).toHaveLength(0);
      authorPointer(
        host.canvas,
        'pointermove',
        pointerType,
        20,
        { x: 340, y: 220 },
        32,
      );
      authorPointer(
        host.canvas,
        'pointerup',
        pointerType,
        20,
        { x: 360, y: 230 },
        40,
      );
      expect(model.order.length).toBe(1);
      expect(dirty.count).toBe(1);
      expect(handle.canUndo()).toBe(true);
    },
  );
});

describe('mounted standalone elastic wheel-zoom parity with pinch', () => {
  function dispatchWheel(
    canvas: HTMLCanvasElement,
    init: WheelEventInit & { clientX?: number; clientY?: number },
    timeMs?: number,
  ): WheelEvent {
    const finiteDeltaY =
      typeof init.deltaY === 'number' && Number.isFinite(init.deltaY)
        ? init.deltaY
        : 0;
    const finiteDeltaX =
      typeof init.deltaX === 'number' && Number.isFinite(init.deltaX)
        ? init.deltaX
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

  it('keeps an inside-bounds wheel zoom cursor-anchored with a single shared frame', () => {
    const restoreCanvas = installCanvasStub();
    const frames = installManualFrames();
    cleanup.push(restoreCanvas, frames.restore);
    const host = makeHost();
    const model = emptySurface(boundedFrame(800, 600));
    const canonicalBefore = JSON.stringify(model);
    let dirty = 0;
    const handle = mountInkSurface({
      model,
      host,
      initialCamera: { x: 0, y: 0, zoom: 1 },
      markDirty: () => {
        dirty += 1;
      },
    });
    cleanup.push(() => handle.destroy());
    frames.flushOne(0);
    const anchor = { x: 400, y: 300 };
    const beforeSurface = viewToSurface(handle.camera(), anchor);
    const beforeFrames = handle.diagnostics().renderFrames;
    dispatchWheel(
      host.canvas,
      { clientX: anchor.x, clientY: anchor.y, ctrlKey: true, deltaY: -100 },
      20,
    );
    expect(frames.pending()).toBe(1);
    frames.flushOne(36);
    const after = handle.camera();
    expect(after.zoom).toBeCloseTo(Math.exp(0.2), 9);
    const afterSurface = viewToSurface(after, anchor);
    expect(afterSurface.x).toBeCloseTo(beforeSurface.x, 9);
    expect(afterSurface.y).toBeCloseTo(beforeSurface.y, 9);
    const viewX = (beforeSurface.x - after.x) * after.zoom;
    expect(Math.abs(viewX - anchor.x)).toBeLessThanOrEqual(2);
    expect(handle.diagnostics().renderFrames).toBe(beforeFrames + 1);
    expect(frames.pending()).toBe(0);
    expect(JSON.stringify(model)).toBe(canonicalBefore);
    expect(dirty).toBe(0);
    expect(handle.canUndo()).toBe(false);
  });

  it.each([
    { limit: MAX_ZOOM, startZoom: MAX_ZOOM, deltaY: -120 },
    { limit: MIN_ZOOM, startZoom: MIN_ZOOM, deltaY: 120 },
  ])(
    'keeps a saturated wheel zoom camera fixed with no deferred drift at $limit',
    ({ limit, startZoom, deltaY }) => {
      const restoreCanvas = installCanvasStub();
      const frames = installManualFrames();
      cleanup.push(restoreCanvas, frames.restore);
      const host = makeHost();
      const model = emptySurface(boundedFrame(2_000, 2_000));
      const canonicalBefore = JSON.stringify(model);
      let dirty = 0;
      const handle = mountInkSurface({
        model,
        host,
        initialCamera: { x: 200, y: 100, zoom: startZoom },
        markDirty: () => {
          dirty += 1;
        },
      });
      cleanup.push(() => handle.destroy());
      frames.flushOne(0);
      const before = handle.camera();
      const wheelEvent = dispatchWheel(
        host.canvas,
        { clientX: 400, clientY: 300, ctrlKey: true, deltaY },
        20,
      );
      void wheelEvent;
      expect(handle.camera()).toEqual(before);
      while (frames.pending() > 0) frames.flushOne(36);
      expect(handle.camera()).toEqual(before);
      expect(frames.pending()).toBe(0);
      expect(JSON.stringify(model)).toBe(canonicalBefore);
      expect(dirty).toBe(0);
      expect(handle.canUndo()).toBe(false);
    },
  );

  it('never zooms on plain-wheel pan and ignores non-finite wheel deltas', () => {
    const restoreCanvas = installCanvasStub();
    const frames = installManualFrames();
    cleanup.push(restoreCanvas, frames.restore);
    const host = makeHost();
    const model = emptySurface(boundedFrame(800, 600));
    const handle = mountInkSurface({
      model,
      host,
      initialCamera: { x: 0, y: 0, zoom: 1 },
      markDirty: () => undefined,
    });
    cleanup.push(() => handle.destroy());
    frames.flushOne(0);
    const before = handle.camera();
    dispatchWheel(host.canvas, { deltaX: 12, deltaY: 24 }, 20);
    expect(frames.pending()).toBe(1);
    frames.flushOne(36);
    const panned = handle.camera();
    expect(panned.zoom).toBe(before.zoom);
    expect(panned.x).not.toBe(before.x);
    expect(panned.y).not.toBe(before.y);

    const settled = handle.camera();
    dispatchWheel(
      host.canvas,
      { clientX: 400, clientY: 300, ctrlKey: true, deltaY: Number.NaN },
      40,
    );
    // Non-finite ctrl-wheel schedules no new frame and leaves the camera.
    expect(handle.camera()).toEqual(settled);
    // Drain any pending frame from the earlier pan (already flushed) — no
    // new frame was added by the NaN tick.
    while (frames.pending() > 0) frames.flushOne(56);
    expect(handle.camera()).toEqual(settled);
  });

  it('snaps overzoom to legal under reduced-motion with no elastic visual', () => {
    const restoreCanvas = installCanvasStub();
    const frames = installManualFrames();
    cleanup.push(restoreCanvas, frames.restore);
    const originalMatchMedia = (
      globalThis as unknown as Record<string, unknown>
    ).matchMedia;
    (globalThis as unknown as Record<string, unknown>).matchMedia = () =>
      ({ matches: true }) as MediaQueryList;
    try {
      const host = makeHost();
      const handle = mountInkSurface({
        model: emptySurface(boundedFrame(2_000, 2_000)),
        host,
        initialCamera: { x: 200, y: 100, zoom: MAX_ZOOM },
        markDirty: () => undefined,
      });
      cleanup.push(() => handle.destroy());
      frames.flushOne(0);
      dispatchWheel(
        host.canvas,
        { clientX: 400, clientY: 300, ctrlKey: true, deltaY: -120 },
        20,
      );
      expect(handle.camera().zoom).toBe(MAX_ZOOM);
      expect(frames.pending()).toBe(0);
    } finally {
      if (originalMatchMedia === undefined) {
        delete (globalThis as unknown as Record<string, unknown>).matchMedia;
      } else {
        (globalThis as unknown as Record<string, unknown>).matchMedia =
          originalMatchMedia;
      }
    }
  });

  it('runs wheel-zoom identically in read-only and settles destroy with no frame', () => {
    const restoreCanvas = installCanvasStub();
    const frames = installManualFrames();
    cleanup.push(restoreCanvas, frames.restore);
    const host = makeHost();
    const model = emptySurface(boundedFrame(2_000, 2_000));
    const canonicalBefore = JSON.stringify(model);
    let dirty = 0;
    const handle = mountInkSurface({
      model,
      host,
      initialCamera: { x: 200, y: 100, zoom: MAX_ZOOM - 0.1 },
      markDirty: () => {
        dirty += 1;
      },
    });
    cleanup.push(() => handle.destroy());
    frames.flushOne(0);
    handle.setReadOnly(true);
    dispatchWheel(
      host.canvas,
      { clientX: 400, clientY: 300, ctrlKey: true, deltaY: -120 },
      20,
    );
    expect(handle.camera().zoom).toBeGreaterThan(MAX_ZOOM);
    flushUntilSettled(frames, 20);
    expect(handle.camera().zoom).toBe(MAX_ZOOM);
    expect(JSON.stringify(model)).toBe(canonicalBefore);
    expect(dirty).toBe(0);
    handle.destroy();
    expect(frames.pending()).toBe(0);
  });
});
