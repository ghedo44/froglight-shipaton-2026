// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  emptySurface,
  infiniteFrame,
  rectangleObject,
  viewToSurface,
} from '@froglight/foundation';
import { WhiteboardDocumentEditorProvider } from './editor.js';

type Transform = readonly [number, number, number, number, number, number];

function installMountedEnvironment(): {
  readonly transforms: Transform[];
  readonly pendingFrames: () => number;
  readonly flushFrame: (timeMs: number) => void;
  readonly restore: () => void;
} {
  const transforms: Transform[] = [];
  const noop = (): void => undefined;
  const context = {
    save: noop,
    restore: noop,
    beginPath: noop,
    closePath: noop,
    clip: noop,
    fill: noop,
    stroke: noop,
    rect: noop,
    fillRect: noop,
    strokeRect: noop,
    clearRect: noop,
    fillText: noop,
    drawImage: noop,
    moveTo: noop,
    lineTo: noop,
    arc: noop,
    ellipse: noop,
    translate: noop,
    rotate: noop,
    setLineDash: noop,
    setTransform: (...values: Transform) => void transforms.push(values),
    fillStyle: '',
    strokeStyle: '',
    font: '',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    globalAlpha: 1,
    textAlign: 'left',
    textBaseline: 'alphabetic',
  };
  const originalContext = HTMLCanvasElement.prototype.getContext;
  const originalBounds = HTMLElement.prototype.getBoundingClientRect;
  const widthDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'clientWidth',
  );
  const heightDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'clientHeight',
  );
  HTMLCanvasElement.prototype.getContext = function () {
    return context as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
  HTMLElement.prototype.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 800,
      bottom: 600,
      width: 800,
      height: 600,
      toJSON: () => ({}),
    }) as DOMRect;
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => 800,
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => 600,
  });

  const frames: FrameRequestCallback[] = [];
  const originalRequest = globalThis.requestAnimationFrame;
  const originalCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    frames.push(callback);
    return frames.length;
  }) as typeof requestAnimationFrame;
  globalThis.cancelAnimationFrame = (() => {
    frames.length = 0;
  }) as typeof cancelAnimationFrame;

  return {
    transforms,
    pendingFrames: () => frames.length,
    flushFrame: (timeMs) => {
      const callback = frames.shift();
      if (callback === undefined) throw new Error('expected a pending frame');
      callback(timeMs);
    },
    restore: () => {
      frames.length = 0;
      globalThis.requestAnimationFrame = originalRequest;
      globalThis.cancelAnimationFrame = originalCancel;
      HTMLCanvasElement.prototype.getContext = originalContext;
      HTMLElement.prototype.getBoundingClientRect = originalBounds;
      if (widthDescriptor === undefined)
        Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
      else
        Object.defineProperty(
          HTMLElement.prototype,
          'clientWidth',
          widthDescriptor,
        );
      if (heightDescriptor === undefined)
        Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
      else
        Object.defineProperty(
          HTMLElement.prototype,
          'clientHeight',
          heightDescriptor,
        );
    },
  };
}

function touch(
  canvas: HTMLCanvasElement,
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  id: number,
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
    pointerId: { value: id },
    pointerType: { value: 'touch' },
    timeStamp: { value: timeMs },
  });
  canvas.dispatchEvent(event);
}

function mouseDragEvent(
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
    buttons: type === 'pointerup' ? 0 : 1,
  });
  Object.defineProperties(event, {
    pointerId: { value: 1 },
    pointerType: { value: 'mouse' },
    timeStamp: { value: timeMs },
  });
  canvas.dispatchEvent(event);
}

const cleanup: Array<() => void> = [];

type BoardHandle = ReturnType<
  WhiteboardDocumentEditorProvider['createEditor']
>;

interface MountedBoard {
  readonly environment: ReturnType<typeof installMountedEnvironment>;
  readonly handle: BoardHandle;
  readonly canvas: HTMLCanvasElement;
  readonly model: ReturnType<typeof emptySurface>;
  readonly canonicalBefore: string;
  readonly dirtyCount: () => number;
}

/**
 * Mount a whiteboard over an infinite frame with a backdrop rect.
 *
 * The backdrop keeps the committed renderer emitting camera-carrying
 * grid/scene transforms, so tests can reconstruct the live camera from
 * `setTransform` records without any whiteboard-owned viewport code.
 * Camera mapping (dpr 1 under jsdom): zoom = a, x = -e/a, y = -f/d.
 */
function mountBoard(): MountedBoard {
  const environment = installMountedEnvironment();
  cleanup.push(environment.restore);
  const model = emptySurface(infiniteFrame());
  model.objects['backdrop'] = rectangleObject('backdrop', {
    x: -10_000,
    y: -10_000,
    width: 20_000,
    height: 20_000,
  });
  model.order.push('backdrop');
  const canonicalBefore = JSON.stringify(model);
  let dirty = 0;
  const parent = document.createElement('div');
  document.body.append(parent);
  const handle = new WhiteboardDocumentEditorProvider().createEditor({
    session: {
      model,
      markDirty: () => {
        dirty += 1;
      },
    } as never,
    parent,
  });
  cleanup.push(() => handle.destroy());
  environment.flushFrame(0);
  const canvas = parent.querySelector('canvas');
  if (canvas === null) throw new Error('expected mounted whiteboard canvas');
  return {
    environment,
    handle,
    canvas,
    model,
    canonicalBefore,
    dirtyCount: () => dirty,
  };
}

function zoomPercent(handle: BoardHandle): number {
  const tools = handle.tools;
  if (tools === undefined) throw new Error('expected whiteboard tools');
  const zoom = tools
    .snapshot()
    .controls.find((control) => (control as { id: string }).id === 'whiteboard.zoom');
  return (zoom as { value: number }).value;
}

interface CameraSnapshot {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

/** Reconstruct the live camera from rendered scene transforms. */
function cameraFromTransforms(
  transforms: Transform[],
  fromIndex: number,
): CameraSnapshot {
  for (let index = transforms.length - 1; index >= fromIndex; index -= 1) {
    const transform = transforms[index];
    if (transform === undefined) continue;
    if (transform[0] !== 1 || transform[4] !== 0 || transform[5] !== 0) {
      return {
        x: -transform[4] / transform[0],
        y: -transform[5] / transform[3],
        zoom: transform[0],
      };
    }
  }
  return { x: 0, y: 0, zoom: 1 };
}

function dispatchWheel(
  canvas: HTMLCanvasElement,
  init: WheelEventInit & { clientX?: number; clientY?: number },
  timeMs?: number,
): WheelEvent {
  const event = new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    deltaX: 0,
    deltaY: 0,
    clientX: 0,
    clientY: 0,
    ...init,
  });
  // harness time base: jsdom stamps WheelEvents with Date.now()
  // (~1.7e12) while the manual frame queue runs on synthetic 0/16/32ms
  // time. The shared spring stepper clamps to max(frameTime, lastTimeMs),
  // so a wall-clock stamp stalls deltaTimeMs at 0 forever (pending 1,
  // never settling, no budget extension can drain it). Pin to the harness
  // clock like touch() already does and like the Ink harness does.
  if (timeMs !== undefined) {
    Object.defineProperty(event, 'timeStamp', { value: timeMs });
  }
  canvas.dispatchEvent(event);
  return event;
}

/** Drain the shared render frame until no spring/decay animation remains.
 *
 *  the elastic settle spring is a
 * critically-damped spring (omega=18, epsilon=0.001) whose tail grows with
 * the accumulated wheel burst, and wheel timestamps must share the harness
 * clock (see dispatchWheel) or deltaTimeMs stalls at 0 and no budget can
 * drain. The 800-frame budget (~13s simulated) covers the 20x burst tail
 * without retuning frozen production physics; peak + settled-value
 * assertions below stay strict.
 */
function drainFrames(
  environment: ReturnType<typeof installMountedEnvironment>,
  startTimeMs: number,
): number {
  let timeMs = startTimeMs;
  let count = 0;
  while (environment.pendingFrames() > 0 && count < 800) {
    timeMs += 1000 / 60;
    environment.flushFrame(timeMs);
    count += 1;
  }
  return count;
}

/**
 * Navigation is an ephemeral preview: it must never dirty canonical
 * content, record history, or mutate the model.
 */
function expectEphemeral(board: MountedBoard): void {
  expect(JSON.stringify(board.model)).toBe(board.canonicalBefore);
  expect(board.dirtyCount()).toBe(0);
  expect(board.handle.canExecCommand?.('undo')).toBe(false);
  expect(board.handle.canExecCommand?.('redo')).toBe(false);
}

afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
  document.body.replaceChildren();
});

describe('whiteboard shared Surface navigation', () => {
  it('pans by mouse in view mode without moving objects or recording history', () => {
    const board = mountBoard();
    if (!board.handle.setReadOnly)
      throw new Error('expected read-only support');
    board.handle.setReadOnly(true);
    const before = cameraFromTransforms(board.environment.transforms, 0);
    mouseDragEvent(board.canvas, 'pointerdown', 300, 0);
    mouseDragEvent(board.canvas, 'pointermove', 100, 20);
    board.environment.flushFrame(20);
    const after = cameraFromTransforms(board.environment.transforms, 0);
    expect(after.x).toBeGreaterThan(before.x);
    mouseDragEvent(board.canvas, 'pointerup', 100, 20);
    expectEphemeral(board);
  });

  it('pinches through the mounted provider without mutating canonical state', () => {
    const environment = installMountedEnvironment();
    cleanup.push(environment.restore);
    const model = emptySurface(infiniteFrame());
    const canonicalBefore = JSON.stringify(model);
    let dirty = 0;
    const parent = document.createElement('div');
    document.body.append(parent);
    const handle = new WhiteboardDocumentEditorProvider().createEditor({
      session: {
        model,
        markDirty: () => {
          dirty += 1;
        },
      } as never,
      parent,
    });
    cleanup.push(() => handle.destroy());
    environment.flushFrame(0);
    const canvas = parent.querySelector('canvas');
    if (canvas === null) throw new Error('expected mounted whiteboard canvas');

    touch(canvas, 'pointerdown', 1, 200, 0);
    touch(canvas, 'pointerdown', 2, 400, 0);
    touch(canvas, 'pointermove', 2, 600, 16);

    const tools = handle.tools;
    if (tools === undefined) throw new Error('expected whiteboard tools');
    const zoom = tools
      .snapshot()
      .controls.find(
        (control) => (control as { id: string }).id === 'whiteboard.zoom',
      );
    expect((zoom as { value: number }).value).toBe(200);
    expect(JSON.stringify(model)).toBe(canonicalBefore);
    expect(dirty).toBe(0);
    expect(handle.canExecCommand?.('undo')).toBe(false);
  });

  it('keeps touch-pan inertia unbounded without object movement or history', () => {
    const environment = installMountedEnvironment();
    cleanup.push(environment.restore);
    const model = emptySurface(infiniteFrame());
    model.objects['fixed'] = rectangleObject('fixed', {
      x: -10_000,
      y: -10_000,
      width: 20_000,
      height: 20_000,
    });
    model.order.push('fixed');
    const canonicalBefore = JSON.stringify(model);
    let dirty = 0;
    const parent = document.createElement('div');
    document.body.append(parent);
    const handle = new WhiteboardDocumentEditorProvider().createEditor({
      session: {
        model,
        markDirty: () => {
          dirty += 1;
        },
      } as never,
      parent,
    });
    cleanup.push(() => handle.destroy());
    environment.flushFrame(0);
    const canvas = parent.querySelector('canvas');
    if (canvas === null) throw new Error('expected mounted whiteboard canvas');

    touch(canvas, 'pointerdown', 1, 300, 0);
    touch(canvas, 'pointermove', 1, 100, 20);
    touch(canvas, 'pointerup', 1, 100, 20);
    const transformsBeforeReleaseFrame = environment.transforms.length;
    environment.flushFrame(36);
    const releasedTranslation = Math.min(
      ...environment.transforms
        .slice(transformsBeforeReleaseFrame)
        .map((transform) => transform[4]),
    );
    expect(releasedTranslation).toBeLessThan(-200);
    expect(environment.pendingFrames()).toBe(1);
    const transformsBeforeNextFrame = environment.transforms.length;
    environment.flushFrame(52);
    expect(
      Math.min(
        ...environment.transforms
          .slice(transformsBeforeNextFrame)
          .map((transform) => transform[4]),
      ),
    ).toBeLessThan(releasedTranslation);
    expect(JSON.stringify(model)).toBe(canonicalBefore);
    expect(dirty).toBe(0);
    expect(handle.canExecCommand?.('undo')).toBe(false);
  });
});

describe('whiteboard inherited elastic wheel navigation', () => {
  it('keeps ctrl-wheel zoom anchored to the cursor within 2px', () => {
    const board = mountBoard();
    const { environment, canvas } = board;
    const before = cameraFromTransforms(environment.transforms, 0);
    const cursor = { x: 400, y: 300 };
    const anchor = viewToSurface(before, cursor);
    const mark = environment.transforms.length;

    dispatchWheel(
      canvas,
      {
        deltaY: -120,
        ctrlKey: true,
        clientX: cursor.x,
        clientY: cursor.y,
      },
      0,
    );
    environment.flushFrame(16);

    const after = cameraFromTransforms(environment.transforms, mark);
    expect(after.zoom).toBeGreaterThan(before.zoom);
    const reprojected = {
      x: (anchor.x - after.x) * after.zoom,
      y: (anchor.y - after.y) * after.zoom,
    };
    expect(Math.abs(reprojected.x - cursor.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(reprojected.y - cursor.y)).toBeLessThanOrEqual(2);
    expectEphemeral(board);
  });

  it('treats meta-wheel identically to ctrl-wheel', () => {
    const board = mountBoard();
    const { environment, canvas } = board;
    const before = cameraFromTransforms(environment.transforms, 0);
    const cursor = { x: 200, y: 150 };
    const anchor = viewToSurface(before, cursor);
    const mark = environment.transforms.length;

    const event = dispatchWheel(
      canvas,
      {
        deltaY: -120,
        metaKey: true,
        clientX: cursor.x,
        clientY: cursor.y,
      },
      0,
    );
    expect(event.defaultPrevented).toBe(true);
    environment.flushFrame(16);

    const after = cameraFromTransforms(environment.transforms, mark);
    expect(after.zoom).toBeGreaterThan(before.zoom);
    const reprojected = {
      x: (anchor.x - after.x) * after.zoom,
      y: (anchor.y - after.y) * after.zoom,
    };
    expect(Math.abs(reprojected.x - cursor.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(reprojected.y - cursor.y)).toBeLessThanOrEqual(2);
    expectEphemeral(board);
  });

  it('overshoots beyond MAX transiently then settles ctrl-wheel zoom to exactly 8', () => {
    const board = mountBoard();
    const { environment, handle, canvas } = board;
    const mark = environment.transforms.length;
    for (let index = 0; index < 20; index += 1) {
      dispatchWheel(
        canvas,
        {
          deltaY: -500,
          ctrlKey: true,
          clientX: 400,
          clientY: 300,
        },
        0,
      );
    }
    environment.flushFrame(16);
    const peak = Math.max(
      ...environment.transforms.slice(mark).map((transform) => transform[0]),
    );
    // elastic parity: the live visual resists past the bound.
    expect(peak).toBeGreaterThan(8);

    drainFrames(environment, 16);
    expect(environment.pendingFrames()).toBe(0);
    expect(zoomPercent(handle)).toBe(800);
    const settled = cameraFromTransforms(environment.transforms, mark);
    expect(Math.abs(settled.zoom - 8)).toBeLessThanOrEqual(0.001);
    expectEphemeral(board);
  });

  it('undershoots below MIN transiently then settles ctrl-wheel zoom to exactly 0.25', () => {
    const board = mountBoard();
    const { environment, handle, canvas } = board;
    const mark = environment.transforms.length;
    for (let index = 0; index < 20; index += 1) {
      dispatchWheel(
        canvas,
        {
          deltaY: 500,
          ctrlKey: true,
          clientX: 400,
          clientY: 300,
        },
        0,
      );
    }
    environment.flushFrame(16);
    const floor = Math.min(
      ...environment.transforms.slice(mark).map((transform) => transform[0]),
    );
    // elastic parity: the live visual resists past the bound.
    expect(floor).toBeLessThan(0.25);

    drainFrames(environment, 16);
    expect(environment.pendingFrames()).toBe(0);
    expect(zoomPercent(handle)).toBe(25);
    const settled = cameraFromTransforms(environment.transforms, mark);
    expect(Math.abs(settled.zoom - 0.25)).toBeLessThanOrEqual(0.001);
    expectEphemeral(board);
  });

  it('snaps wheel overzoom to the legal limit with no pending settle under reduced motion', () => {
    const board = mountBoard();
    const { environment, handle, canvas } = board;
    const holder = window as unknown as Record<string, unknown>;
    const previousMatchMedia = holder.matchMedia;
    holder.matchMedia = () => ({
      matches: true,
      media: '(prefers-reduced-motion: reduce)',
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    });
    cleanup.push(() => {
      holder.matchMedia = previousMatchMedia;
    });

    for (let index = 0; index < 20; index += 1) {
      dispatchWheel(
        canvas,
        {
          deltaY: -500,
          ctrlKey: true,
          clientX: 400,
          clientY: 300,
        },
        0,
      );
    }
    drainFrames(environment, 16);
    expect(environment.pendingFrames()).toBe(0);
    expect(zoomPercent(handle)).toBe(800);
    expectEphemeral(board);
  });

  it('ignores non-finite wheel deltas without poisoning the infinite camera', () => {
    const board = mountBoard();
    const { environment, handle, canvas } = board;
    const mark = environment.transforms.length;

    // jsdom validates WheelEventInit deltas as finite, so install the
    // non-finite payload the way hostile browsers deliver it: an own
    // property shadowing the prototype getter after construction.
    const poisonedZoom = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: 0,
      ctrlKey: true,
      clientX: 400,
      clientY: 300,
    });
    Object.defineProperty(poisonedZoom, 'deltaY', { value: Number.NaN });
    canvas.dispatchEvent(poisonedZoom);
    const poisonedPan = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaX: 0,
      deltaY: 0,
    });
    Object.defineProperty(poisonedPan, 'deltaX', { value: Number.NaN });
    Object.defineProperty(poisonedPan, 'deltaY', { value: Number.NaN });
    canvas.dispatchEvent(poisonedPan);
    expect(environment.pendingFrames()).toBe(0);
    expect(zoomPercent(handle)).toBe(100);
    expect(cameraFromTransforms(environment.transforms, mark)).toEqual({
      x: 0,
      y: 0,
      zoom: 1,
    });
    expectEphemeral(board);
  });

  it('pans unbounded across the infinite board while zoom stays bounded', () => {
    const board = mountBoard();
    const { environment, handle, canvas } = board;
    const mark = environment.transforms.length;
    for (let index = 0; index < 10; index += 1) {
      dispatchWheel(canvas, { deltaX: 5000, deltaY: 3000 }, 0);
    }
    drainFrames(environment, 16);

    const camera = cameraFromTransforms(environment.transforms, mark);
    expect(Math.abs(camera.x)).toBeGreaterThan(2000);
    expect(Math.abs(camera.y)).toBeGreaterThan(2000);
    expect(Number.isFinite(camera.x)).toBe(true);
    expect(Number.isFinite(camera.y)).toBe(true);
    expect(camera.zoom).toBe(1);
    expect(zoomPercent(handle)).toBe(100);
    expectEphemeral(board);
  });

  it('routes fit through the inherited bounded-frame fit and leaves the infinite board untouched', () => {
    const board = mountBoard();
    const { environment, handle } = board;
    const tools = handle.tools;
    if (tools === undefined) throw new Error('expected whiteboard tools');
    expect(tools.execute('whiteboard.zoom-slider', '150')).toBe(true);
    drainFrames(environment, 16);
    const zoomBefore = zoomPercent(handle);
    expect(zoomBefore).toBe(150);
    const mark = environment.transforms.length;

    // Infinite frames have no bounds to fit: the inherited fit is a
    // bounded-frame-only no-op, so it schedules no frame and repaints
    // nothing rather than inventing whiteboard-specific viewport math.
    expect(tools.execute('whiteboard.fit')).toBe(true);
    expect(environment.pendingFrames()).toBe(0);
    expect(environment.transforms.length).toBe(mark);
    expect(zoomPercent(handle)).toBe(zoomBefore);
    expectEphemeral(board);
  });

  it('settles pinch overzoom to MAX exactly through the inherited spring', () => {
    const board = mountBoard();
    const { environment, handle, canvas } = board;
    const mark = environment.transforms.length;

    touch(canvas, 'pointerdown', 1, 200, 0);
    touch(canvas, 'pointerdown', 2, 400, 0);
    touch(canvas, 'pointermove', 2, 2000, 20);
    environment.flushFrame(36);
    const peak = Math.max(
      ...environment.transforms.slice(mark).map((transform) => transform[0]),
    );
    expect(peak).toBeGreaterThan(8);

    touch(canvas, 'pointerup', 2, 2000, 40);
    touch(canvas, 'pointerup', 1, 200, 44);
    drainFrames(environment, 44);
    expect(environment.pendingFrames()).toBe(0);
    expect(zoomPercent(handle)).toBe(800);
    const settled = cameraFromTransforms(environment.transforms, mark);
    expect(Math.abs(settled.zoom - 8)).toBeLessThanOrEqual(0.001);
    expectEphemeral(board);
  });
});
