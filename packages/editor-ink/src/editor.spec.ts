/**
 * Ink page editor adapter conformance: the production
 * provider drives the host-free tool controller from real DOM pointer
 * events and renders through the shared compile/cull pipeline. The 2D
 * context is a recording stub, so the entire public surface — event
 * binding, gesture commit, session dirty marking, undo/redo, teardown —
 * runs under jsdom without a pixel ever being drawn.
 */

import { beforeEach, describe, expect, it } from 'vitest';

/** jsdom fires rAF on a timer; rendering is rAF-coalesced. */
async function frame(): Promise<void> {
  await new Promise((resolve) =>
    requestAnimationFrame(() => resolve(undefined)),
  );
}
import {
  boundedFrame,
  emptySurface,
  frameBounds,
  imageObject,
  rectangleObject,
  textObject,
  workspacePath,
  type DocumentAssetStore,
  type SurfaceModel,
} from '@froglight/foundation';
import {
  HeadlessInkEditorHandle,
  InkDocumentEditorProvider,
  mountInkSurface,
  INK_TOOL_IDS,
  renderInkPreviewImage,
  type DecodedImage,
  type InkSurfaceHandle,
  type InkSurfaceOptions,
} from './index.js';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import {
  InkSurfaceSkeleton,
  type InkSkeleton,
} from './react/InkSurfaceSkeleton.jsx';
import inkSkeletonCss from './react/InkSurfaceSkeleton.css?inline';

/**
 * Test-only React host for direct engine mounts:
 * production mounts go through InkDocumentEditorProvider; these
 * characterization tests commit the same React skeleton first and hand it
 * over via `host`, preserving the synchronous creation contract.
 */
function mountUiSurface(
  parent: HTMLElement,
  options: Omit<InkSurfaceOptions, 'host'>,
): InkSurfaceHandle {
  const presentation = options.presentation ?? 'paint-stage';
  const navigationMode =
    options.navigationMode ??
    (presentation === 'paint-stage' ? 'standalone' : 'embedded');
  const skeletonRef: { current: InkSkeleton | null } = { current: null };
  const root = createRoot(parent);
  flushSync(() => {
    root.render(
      createElement(InkSurfaceSkeleton, {
        presentation,
        navigationMode,
        skeletonRef,
      }),
    );
  });
  const skeleton = skeletonRef.current;
  if (skeleton === null) throw new Error('test skeleton failed to commit');
  const handle = mountInkSurface({ ...options, host: skeleton });
  let disposed = false;
  return {
    ...handle,
    destroy: () => {
      if (disposed) return;
      disposed = true;
      root.unmount();
      handle.destroy();
    },
  };
}

type CtxLog = Array<[string, ...unknown[]]>;

/** Recording Canvas2D stub covering every call the backend makes. */
function installCanvasStub(): { log: CtxLog; restore: () => void } {
  const log: CtxLog = [];
  const record =
    (name: string) =>
    (...args: unknown[]) =>
      void log.push([name, ...args]);
  const ctx = {
    save: record('save'),
    restore: record('restore'),
    beginPath: record('beginPath'),
    clip: record('clip'),
    fill: record('fill'),
    stroke: record('stroke'),
    rect: record('rect'),
    fillRect: record('fillRect'),
    strokeRect: record('strokeRect'),
    fillText: record('fillText'),
    ellipse: record('ellipse'),
    translate: record('translate'),
    rotate: record('rotate'),
    setTransform: record('setTransform'),
    setLineDash: record('setLineDash'),
    clearRect: record('clearRect'),
    drawImage: record('drawImage'),
    moveTo: record('moveTo'),
    lineTo: record('lineTo'),
    closePath: record('closePath'),
    arc: record('arc'),
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
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function () {
    return ctx as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
  return {
    log,
    restore: () => (HTMLCanvasElement.prototype.getContext = original),
  };
}

function pointerEvent(
  type: string,
  x: number,
  y: number,
  pressure?: number,
): MouseEvent & { pressure?: number } {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
  }) as MouseEvent & { pressure?: number };
  if (pressure !== undefined) {
    Object.defineProperty(event, 'pressure', { value: pressure });
  }
  return event;
}

interface Fixture {
  model: SurfaceModel;
  session: { model: SurfaceModel; markDirty(): void; dirtyCount: number };
}

function makeSession(): Fixture {
  const model = emptySurface(boundedFrame(800, 600));
  const session = {
    model,
    dirtyCount: 0,
    markDirty() {
      this.dirtyCount += 1;
    },
  };
  return { model, session };
}

let canvasStub: ReturnType<typeof installCanvasStub>;

describe('InkDocumentEditorProvider', () => {
  beforeEach(() => {
    canvasStub?.restore();
    canvasStub = installCanvasStub();
  });

  function mount(): {
    parent: HTMLElement;
    handle: ReturnType<InkDocumentEditorProvider['createEditor']>;
  } {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const { session } = makeSession();
    const provider = new InkDocumentEditorProvider();
    const handle = provider.createEditor({ session, parent });
    return { parent, handle };
  }

  it('binds a canvas to the parent and commits pen gestures into the session model', async () => {
    const { parent, handle } = mount();
    const canvas = parent.querySelector('canvas');
    expect(canvas).not.toBeNull();

    canvas!.dispatchEvent(pointerEvent('pointerdown', 10, 10, 0.5));
    canvas!.dispatchEvent(pointerEvent('pointermove', 40, 30, 0.25));
    canvas!.dispatchEvent(pointerEvent('pointerup', 60, 40, 0.5));
    await frame();

    // Read the committed stroke back through the rendered scene:
    // the recording context must have stroked segments in surface space.
    const moves = canvasStub.log.filter(([n]) => n === 'moveTo');
    expect(moves.length).toBeGreaterThanOrEqual(2);

    // Gesture-level undo removes the stroke; redo restores it.
    expect(handle.execCommand('undo')).toBe(true);
    expect(handle.execCommand('undo')).toBe(false);
    expect(handle.execCommand('redo')).toBe(true);
    handle.destroy();
  });

  it('marks the session dirty exactly once per committed gesture', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const { session } = makeSession();
    const provider = new InkDocumentEditorProvider();
    const handle = provider.createEditor({ session, parent });
    const canvas = parent.querySelector('canvas')!;

    canvas.dispatchEvent(pointerEvent('pointerdown', 100, 100));
    // Moves during capture must not flip the session dirty flag.
    canvas.dispatchEvent(pointerEvent('pointermove', 105, 105));
    expect(session.dirtyCount).toBe(0);
    canvas.dispatchEvent(pointerEvent('pointerup', 110, 110));
    expect(session.dirtyCount).toBe(1);
    handle.destroy();
  });

  it('publishes contextual anchors for touch selection and dismisses them before authoring', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const { session, model } = makeSession();
    model.objects.text = textObject('text', {
      x: 100,
      y: 100,
      text: 'Context menu',
    });
    model.order.push('text');
    const handle = new InkDocumentEditorProvider().createEditor({
      session,
      parent,
    });
    try {
      const canvas = parent.querySelector('canvas')!;
      const tools = handle.tools!;
      const touch = (type: string, x: number, y: number) => {
        const event = pointerEvent(type, x, y);
        Object.defineProperty(event, 'pointerType', { value: 'touch' });
        canvas.dispatchEvent(event);
      };
      touch('pointerdown', 140, 130);
      touch('pointerup', 140, 130);
      expect(tools.snapshot().contextualAnchor).toBeDefined();
      expect(
        tools
          .snapshot()
          .controls.find((c) => c.id === 'ink.tool.froglight.ink.pen'),
      ).toMatchObject({ active: true });
      touch('pointerdown', 500, 400);
      expect(tools.snapshot().contextualAnchor ?? null).toBeNull();
      touch('pointerup', 500, 400);
      touch('pointerdown', 140, 130);
      touch('pointerup', 140, 130);
      tools.execute('ink.tool.froglight.ink.pen');
      expect(tools.snapshot().contextualAnchor ?? null).toBeNull();
      touch('pointerdown', 140, 130);
      touch('pointerup', 140, 130);
      expect(tools.snapshot().contextualAnchor).toBeDefined();
      expect(session.dirtyCount).toBe(0);
      canvas.dispatchEvent(pointerEvent('pointerdown', 500, 350));
      expect(tools.snapshot().contextualAnchor ?? null).toBeNull();
      canvas.dispatchEvent(pointerEvent('pointerup', 540, 390));
      expect(model.order).toHaveLength(2);
    } finally {
      handle.destroy();
    }
  });

  it('routes second-tap settings actions into tool presets and recent colors', () => {
    const { handle } = mount();
    try {
      const tools = handle.tools!;
      expect(tools.execute('ink.tool.froglight.ink.pen')).toBe(true);
      expect(tools.execute('ink.settings.pen.size', '6')).toBe(true);
      expect(tools.execute('ink.settings.pen.color', '#c4554d')).toBe(true);
      expect(tools.execute('ink.settings.pen.pressure', '80')).toBe(true);
      // The snapshot style width follows the preset write.
      const width = tools
        .snapshot()
        .controls.find((control) => control.id === 'ink.width');
      expect(width).toMatchObject({ value: '6' });
      expect(tools.execute('ink.tool.froglight.ink.eraser.stroke')).toBe(true);
      // eraser mode is fixed per toolbar tool — the legacy
      // `ink.settings.eraser.mode` dropdown is gone (writes resolve false,
      // never a crash, never a silent write).
      expect(tools.execute('ink.settings.eraser.mode', 'unknown')).toBe(false);
      expect(tools.execute('ink.settings.eraser.mode', 'vaporize')).toBe(false);
      // Unknown settings ids resolve to false without mutating.
      expect(tools.execute('ink.settings.pen.nope', '6')).toBe(false);
    } finally {
      handle.destroy();
    }
  });

  it('destroys deterministically: listeners detach and further events do nothing', () => {
    const { parent, handle } = mount();
    handle.destroy();
    expect(parent.querySelector('canvas')).toBeNull();
    const canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
    canvas.dispatchEvent(pointerEvent('pointerdown', 1, 1));
    expect(() => handle.focus()).toThrowError();
    expect(handle.hasFocus()).toBe(false);
  });

  it('falls back to the headless handle when no usable 2D context exists', () => {
    canvasStub.restore();
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const { session } = makeSession();
    const handle = new InkDocumentEditorProvider().createEditor({
      session,
      parent,
    });
    expect(handle).toBeInstanceOf(HeadlessInkEditorHandle);
    expect(parent.querySelector('canvas')).toBeNull();
    expect(handle.execCommand('undo')).toBe(false);
    handle.destroy();
  });

  it('renders a bounded Ink model as a derived PNG composition image', async () => {
    const original = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = () =>
      'data:image/png;base64,cHJldmlldw==';
    try {
      const preview = await renderInkPreviewImage(
        emptySurface(boundedFrame(800, 600)),
      );
      expect(preview).toEqual({
        mimeType: 'image/png',
        dataUrl: 'data:image/png;base64,cHJldmlldw==',
        alt: 'Ink page preview',
        width: 1200,
        height: 900,
      });
      expect(canvasStub.log).toContainEqual([
        'setTransform',
        1.5,
        0,
        0,
        1.5,
        -0,
        -0,
      ]);
    } finally {
      HTMLCanvasElement.prototype.toDataURL = original;
    }
  });

  it('resolves image objects through the asset store in previews', async () => {
    const original = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = () =>
      'data:image/png;base64,cHJldmlldw==';
    try {
      const model = emptySurface(boundedFrame(800, 600));
      const object = imageObject('img-1', {
        x: 0,
        y: 0,
        width: 100,
        height: 50,
        src: 'attachments/abc',
        sha256: 'abc',
      });
      model.order.push(object.id);
      model.objects[object.id] = object;
      const bitmap = { tag: 'preview-bitmap' } as unknown as DecodedImage;
      const stored = new Map<string, Uint8Array>([
        ['attachments/abc', new Uint8Array([1])],
      ]);

      await renderInkPreviewImage(model, {
        assets: {
          async put() {
            throw new Error('unused');
          },
          async read(path) {
            const bytes = stored.get(path);
            if (bytes === undefined) throw new Error('missing asset');
            return bytes;
          },
        },
        decodeImage: async () => bitmap,
      });

      expect(
        canvasStub.log.some(
          ([name, source]) => name === 'drawImage' && source === bitmap,
        ),
      ).toBe(true);
    } finally {
      HTMLCanvasElement.prototype.toDataURL = original;
    }
  });
});

describe('InkDocumentEditorProvider review regressions', () => {
  beforeEach(() => {
    canvasStub?.restore();
    canvasStub = installCanvasStub();
  });

  it('keeps the opposite edges anchored across repeated north-west frame resize moves', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const { model, session } = makeSession();
    const mark = rectangleObject('mark', {
      x: 200,
      y: 150,
      width: 20,
      height: 20,
    });
    model.objects[mark.id] = mark;
    model.order.push(mark.id);
    const handle = mountUiSurface(parent, {
      model,
      initialCamera: { x: 0, y: 0, zoom: 1 },
      markDirty: () => session.markDirty(),
    });
    const canvas = parent.querySelector('canvas')!;
    const start = handle.camera();
    const zoom = start.zoom;
    const markView = {
      x: (200 - start.x) * zoom,
      y: (150 - start.y) * zoom,
    };
    const left = -start.x * zoom;
    const top = -start.y * zoom;

    canvas.dispatchEvent(pointerEvent('pointerdown', left, top));
    canvas.dispatchEvent(pointerEvent('pointermove', left - 10, top - 10));
    canvas.dispatchEvent(pointerEvent('pointermove', left - 20, top - 20));
    canvas.dispatchEvent(pointerEvent('pointerup', left - 20, top - 20));

    const frame = frameBounds(model.frame);
    if (frame === null) throw new Error('expected a bounded frame');
    expect(frame).toEqual({ width: 820, height: 620 });
    const camera = handle.camera();
    expect(camera.x).toBeCloseTo(start.x + frame.width - 800, 5);
    expect(camera.y).toBeCloseTo(start.y + frame.height - 600, 5);
    expect((frame.width - camera.x) * zoom).toBeCloseTo(
      (800 - start.x) * zoom,
      5,
    );
    expect((frame.height - camera.y) * zoom).toBeCloseTo(
      (600 - start.y) * zoom,
      5,
    );
    const moved = model.objects[mark.id]!;
    expect(((moved.x as number) - camera.x) * zoom).toBeCloseTo(markView.x, 5);
    expect(((moved.y as number) - camera.y) * zoom).toBeCloseTo(markView.y, 5);
    const movedPosition = { x: moved.x, y: moved.y };
    expect(handle.undo()).toBe(true);
    expect(model.frame).toEqual(boundedFrame(800, 600));
    expect(model.objects[mark.id]).toMatchObject({ x: 200, y: 150 });
    expect(handle.redo()).toBe(true);
    expect(model.objects[mark.id]).toMatchObject(movedPosition);
    handle.destroy();
  });

  it('captures tilt/twist from PointerEvent axes into committed samples', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const { model, session } = makeSession();
    const handle = new InkDocumentEditorProvider().createEditor({
      session,
      parent,
    });
    const canvas = parent.querySelector('canvas')!;
    canvas.dispatchEvent(pointerEvent('pointerdown', 100, 100, 0.5));
    const move = pointerEvent('pointermove', 120, 100, 0.5) as MouseEvent & {
      tiltX?: number;
      tiltY?: number;
      twistAngle?: number;
    };
    move.tiltX = 30;
    move.tiltY = 40;
    move.twistAngle = 90;
    Object.defineProperty(move, 'tiltX', { value: 30 });
    Object.defineProperty(move, 'tiltY', { value: 40 });
    Object.defineProperty(move, 'twistAngle', { value: 90 });
    canvas.dispatchEvent(move);
    canvas.dispatchEvent(pointerEvent('pointerup', 140, 100, 0.5));
    handle.destroy();

    const stroke = model.objects[model.order[0]!] as {
      points?: Array<Record<string, unknown>>;
    };
    const points = stroke.points!;
    // tiltX=30°/tiltY=40° preserved per axis (still v1);
    // twist 90° → π/2.
    const tilt = points[1]!.tilt as { x: number; y: number };
    expect(tilt.x).toBeCloseTo(30 * (Math.PI / 180), 6);
    expect(tilt.y).toBeCloseTo(40 * (Math.PI / 180), 6);
    expect(points[1]!.twist as number).toBeCloseTo(Math.PI / 2, 6);
  });

  it('commits re-entered bounded-paper ink as separate runs in one undo gesture', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const { model, session } = makeSession();
    const handle = mountUiSurface(parent, {
      model,
      initialCamera: { x: 0, y: 0, zoom: 1 },
      markDirty: () => session.markDirty(),
    });
    handle.setTool('froglight.ink.pen');
    const canvas = parent.querySelector('canvas')!;

    canvas.dispatchEvent(pointerEvent('pointerdown', 100, 100, 0.5));
    canvas.dispatchEvent(pointerEvent('pointermove', -100, 100, 0.5));
    canvas.dispatchEvent(pointerEvent('pointermove', 300, 100, 0.5));
    canvas.dispatchEvent(pointerEvent('pointerup', 350, 100, 0));

    const strokes = model.order
      .map((id) => model.objects[id])
      .filter((record) => record?.type === 'froglight.ink.stroke');
    expect(strokes).toHaveLength(2);
    expect(strokes[0]?.logicalId).toBeUndefined();
    expect(strokes[1]?.logicalId).toBeUndefined();
    for (const stroke of strokes) {
      const points = stroke?.points as Array<{ x: number; y: number }>;
      expect(points.every((point) => point.x >= 0)).toBe(true);
    }
    expect((strokes[0]?.points as Array<{ x: number }>).at(-1)?.x).toBeCloseTo(
      0,
      6,
    );
    expect((strokes[1]?.points as Array<{ x: number }>)[0]?.x).toBeCloseTo(
      0,
      6,
    );
    expect(handle.undo()).toBe(true);
    expect(model.order).toEqual([]);
    expect(handle.redo()).toBe(true);
    expect(model.order).toHaveLength(2);
    handle.destroy();
  });

  it('undo removes strokes added after the snapshot instead of leaving ghosts', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const { model, session } = makeSession();
    const provider = new InkDocumentEditorProvider();
    const handle = provider.createEditor({ session, parent });
    const canvas = parent.querySelector('canvas')!;
    for (const [type, x] of [
      ['pointerdown', 100],
      ['pointerup', 110],
      ['pointerdown', 100],
      ['pointerup', 110],
    ] as const) {
      canvas.dispatchEvent(pointerEvent(type, x, 100));
    }
    expect(Object.keys(model.objects)).toHaveLength(2);
    expect(handle.execCommand('undo')).toBe(true);
    expect(Object.keys(model.objects)).toHaveLength(1);
    expect(model.order).toHaveLength(1);
    handle.destroy();
  });

  it('wheel zoom never enters the undo history', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const { session } = makeSession();
    const provider = new InkDocumentEditorProvider();
    const handle = provider.createEditor({ session, parent });
    const canvas = parent.querySelector('canvas')!;
    canvas.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaY: -120,
      }),
    );
    expect(handle.canExecCommand!('undo')).toBe(false);
    handle.destroy();
  });
});

function pointer(
  type: string,
  id: number,
  x: number,
  y: number,
  pointerType = 'mouse',
): PointerEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
  }) as unknown as PointerEvent;
  Object.defineProperty(event, 'pointerId', { value: id });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  Object.defineProperty(event, 'pressure', { value: 0.5 });
  return event;
}

async function drawTap(canvas: Element, x: number, y: number): Promise<void> {
  canvas.dispatchEvent(pointer('pointerdown', 7, x, y));
  canvas.dispatchEvent(pointer('pointerup', 7, x + 4, y));
  await frame();
}

describe('InkDocumentEditorProvider editing surface (semantic tools, gestures, frames)', () => {
  beforeEach(() => {
    canvasStub?.restore();
    canvasStub = installCanvasStub();
  });

  function mounted(): {
    parent: HTMLElement;
    canvas: HTMLCanvasElement;
    model: SurfaceModel;
    handle: ReturnType<InkDocumentEditorProvider['createEditor']>;
  } {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const { model, session } = makeSession();
    const handle = new InkDocumentEditorProvider().createEditor({
      session,
      parent,
    });
    return {
      parent,
      canvas: parent.querySelector('.fl-ink-canvas')!,
      model,
      handle,
    };
  }

  it('renders every frame from a cleared device canvas', async () => {
    const { canvas, handle } = mounted();
    await frame();
    const clearsAfterFirstFrame = canvasStub.log.filter(
      ([n]) => n === 'clearRect',
    ).length;
    expect(clearsAfterFirstFrame).toBeGreaterThanOrEqual(1);
    // Camera change → new frame → another full clear (the ghosting fix).
    canvas.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaY: -120,
        ctrlKey: true,
      }),
    );
    await frame();
    const clearsAfterZoom = canvasStub.log.filter(
      ([n]) => n === 'clearRect',
    ).length;
    expect(clearsAfterZoom).toBeGreaterThan(clearsAfterFirstFrame);
    handle.destroy();
  });

  it('plain wheel pans and ctrl+wheel zooms through the camera', async () => {
    const surface = mounted();
    await frame();
    const cacheTransforms = (): Array<number[]> =>
      canvasStub.log
        .filter(([n, ...rest]) => n === 'setTransform' && rest.length === 6)
        .map(([, ...args]) => args as unknown as number[]);
    const baseCount = cacheTransforms().length;

    surface.canvas.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaY: -120,
        ctrlKey: true,
      }),
    );
    await frame();
    // Cache rebuilt with a scaled surface transform (dpr*zoom > 1 at dpr 1... zoom >1).
    const afterZoom = cacheTransforms();
    expect(afterZoom.length).toBeGreaterThan(baseCount);
    expect(Math.max(...afterZoom.map((t) => t[0]))).toBeGreaterThan(1);

    // Plain wheel pans: some rebuild translate offsets become non-zero.
    surface.canvas.dispatchEvent(
      new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 60 }),
    );
    await frame();
    const panned = cacheTransforms().some(
      (t) => Math.abs(t[4]) > 0 || Math.abs(t[5]) > 0,
    );
    expect(panned).toBe(true);
    surface.handle.destroy();
  });

  it('bounds repeated wheel navigation to the finite canvas', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const { model } = makeSession();
    const handle = mountUiSurface(parent, {
      model,
      markDirty: () => undefined,
    });
    const canvas = parent.querySelector<HTMLCanvasElement>('canvas')!;
    handle.setZoomFactor(2);
    for (let index = 0; index < 100; index += 1) {
      canvas.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          deltaX: -1_000,
          deltaY: -1_000,
        }),
      );
    }
    const camera = handle.camera();
    expect(camera.x).toBeLessThanOrEqual(800 - 56 / camera.zoom);
    expect(camera.y).toBeLessThanOrEqual(600 - 56 / camera.zoom);
    expect(Number.isFinite(camera.x)).toBe(true);
    expect(Number.isFinite(camera.y)).toBe(true);
    handle.destroy();
  });

  it('uses fingers for bounded pan and pinch zoom without drawing', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const { model } = makeSession();
    const handle = mountUiSurface(parent, {
      model,
      markDirty: () => undefined,
    });
    const canvas = parent.querySelector<HTMLCanvasElement>('canvas')!;
    const initialZoom = handle.zoomFactor();
    canvas.dispatchEvent(pointer('pointerdown', 1, 300, 300, 'touch'));
    canvas.dispatchEvent(pointer('pointerdown', 2, 500, 300, 'touch'));
    canvas.dispatchEvent(pointer('pointermove', 2, 700, 300, 'touch'));
    canvas.dispatchEvent(pointer('pointerup', 2, 700, 300, 'touch'));
    canvas.dispatchEvent(pointer('pointerup', 1, 300, 300, 'touch'));
    expect(handle.zoomFactor()).toBeGreaterThan(initialZoom);
    expect(model.order).toEqual([]);
    handle.destroy();
  });

  it('continues embedded navigation with the surviving finger after a pinch', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const { model } = makeSession();
    const pans: Array<{ x: number; y: number }> = [];
    const handle = mountUiSurface(parent, {
      model,
      markDirty: () => undefined,
      navigationMode: 'embedded',
      onEmbeddedPan: (delta) => pans.push(delta),
      onEmbeddedZoom: () => undefined,
    });
    const canvas = parent.querySelector<HTMLCanvasElement>('canvas')!;
    canvas.dispatchEvent(pointer('pointerdown', 1, 100, 100, 'touch'));
    canvas.dispatchEvent(pointer('pointerdown', 2, 200, 100, 'touch'));
    canvas.dispatchEvent(pointer('pointermove', 2, 240, 100, 'touch'));
    canvas.dispatchEvent(pointer('pointerup', 2, 240, 100, 'touch'));
    canvas.dispatchEvent(pointer('pointermove', 1, 100, 140, 'touch'));
    expect(pans).toEqual([{ x: 0, y: -40 }]);
    canvas.dispatchEvent(pointer('pointerup', 1, 100, 140, 'touch'));
    expect(parent.querySelector('.fl-ink-page')?.classList).not.toContain(
      'panning',
    );
    expect(model.order).toEqual([]);
    handle.destroy();
  });

  it('sets exact pixel dimensions and typed zoom through semantic tools', async () => {
    const { model, handle } = mounted();
    const tools = handle.tools!;
    expect(await tools.execute('ink.frame-width', '1234')).toBe(true);
    expect(await tools.execute('ink.frame-height', '777')).toBe(true);
    expect(frameBounds(model.frame)).toEqual({ width: 1234, height: 777 });
    expect(await tools.execute('ink.zoom', '175')).toBe(true);
    expect(
      tools.snapshot().controls.find((control) => control.id === 'ink.zoom'),
    ).toMatchObject({ kind: 'number', value: 175 });
    expect(
      tools
        .snapshot()
        .controls.find((control) => control.id === 'ink.zoom-slider'),
    ).toMatchObject({ kind: 'range', value: 175 });
    handle.destroy();
  });

  it('keeps Ink bounded while resizing its canvas', async () => {
    const { model, handle } = mounted();
    model.frame.vendorNote = 'keep';
    const tools = handle.tools!;
    expect(await tools.execute('ink.frame-width', '1234')).toBe(true);
    expect(
      tools
        .snapshot()
        .controls.some((control) => control.id === 'ink.canvas-mode'),
    ).toBe(false);
    expect(await tools.execute('ink.canvas-mode', 'infinite')).toBe(false);
    expect(frameBounds(model.frame)).toEqual({ width: 1234, height: 600 });
    expect(model.frame.vendorNote).toBe('keep');
    handle.destroy();
  });

  it('exposes a compact zoom-reset showing the current zoom', async () => {
    const { handle } = mounted();
    const tools = handle.tools!;
    expect(await tools.execute('ink.zoom', '175')).toBe(true);
    const reset = tools
      .snapshot()
      .controls.find((control) => control.id === 'ink.zoom-reset');
    expect(reset).toMatchObject({ kind: 'button' });
    expect((reset as { label: string }).label).toContain('175%');
    expect((reset as { label: string }).label).toContain('100%');
    expect(await tools.execute('ink.zoom-reset')).toBe(true);
    expect(
      tools.snapshot().controls.find((control) => control.id === 'ink.zoom'),
    ).toMatchObject({ kind: 'number', value: 100 });
    handle.destroy();
  });

  it('keeps toolbar zoom chrome derived without marking canonical dirty', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const { session } = makeSession();
    const provider = new InkDocumentEditorProvider();
    const handle = provider.createEditor({ session, parent });
    const tools = handle.tools!;
    expect(session.dirtyCount).toBe(0);
    expect(tools.execute('ink.zoom-in')).toBe(true);
    expect(tools.execute('ink.zoom-reset')).toBe(true);
    expect(tools.execute('ink.fit')).toBe(true);
    expect(session.dirtyCount).toBe(0);
    handle.destroy();
  });

  it('switches semantic tools and erases through the canvas path', async () => {
    const { canvas, model, handle } = mounted();
    // Seed one stroke.
    canvas.dispatchEvent(pointer('pointerdown', 1, 10, 10));
    canvas.dispatchEvent(pointer('pointerup', 1, 40, 10));
    await frame();

    const tools = handle.tools!;
    // Stroke eraser over the single engine.
    expect(await tools.execute('ink.tool.froglight.ink.eraser.stroke')).toBe(
      true,
    );
    expect(
      tools
        .snapshot()
        .controls.some(
          (control) =>
            control.id === 'ink.tool.froglight.ink.eraser.stroke' &&
            control.kind === 'button' &&
            control.active,
        ),
    ).toBe(true);
    canvas.dispatchEvent(pointer('pointerdown', 2, 25, 10));
    canvas.dispatchEvent(pointer('pointerup', 2, 25, 10));
    await frame();
    expect(model.order).toEqual([]);

    await tools.execute('ink.tool.froglight.ink.pen');
    await drawTap(canvas, 100, 100);
    expect(model.order).toHaveLength(1);
    handle.destroy();
  });

  it('applies the selected swatch color to committed strokes', async () => {
    const { canvas, model, handle } = mounted();
    expect(await handle.tools!.execute('ink.color', '#7c6cf0')).toBe(true);
    await drawTap(canvas, 100, 100);
    const stroke = model.objects[model.order[0]!]!;
    expect(stroke.color).toBe('#7c6cf0');
    handle.destroy();
  });

  it('paints highlighter strokes in the chosen color with its preset width', async () => {
    const { canvas, model, handle } = mounted();
    expect(await handle.tools!.execute('ink.color', '#7c6cf0')).toBe(true);
    expect(
      await handle.tools!.execute('ink.tool.froglight.ink.highlighter'),
    ).toBe(true);
    await drawTap(canvas, 100, 100);
    const stroke = model.objects[model.order[0]!]!;
    // Slice 3: highlighter keeps its own preset color (pen independence);
    // the swatch above targeted the pen tool only.
    expect(stroke.color).toBe('#ffd54f');
    expect(stroke.width).toBe(14);
    expect(stroke.opacity).toBeCloseTo(0.35, 5);
    handle.destroy();
  });

  it('selects strokes by lasso and duplicates them in one undo step', async () => {
    // Engine-seam coverage (InkSurfaceHandle verbs): Notebook and
    // Whiteboard consume this handle directly, so transforms prove out
    // here rather than through the provider wrapper.
    const { model } = makeSession();
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const surface = mountUiSurface(parent, {
      model,
      markDirty: () => undefined,
    });
    const canvas = parent.querySelector('.fl-ink-canvas')!;
    try {
      surface.setTool('froglight.ink.pen');
      canvas.dispatchEvent(pointer('pointerdown', 7, 100, 100));
      canvas.dispatchEvent(pointer('pointerup', 7, 104, 100));
      canvas.dispatchEvent(pointer('pointerdown', 8, 200, 120));
      canvas.dispatchEvent(pointer('pointerup', 8, 204, 120));
      await frame();
      expect(model.order).toHaveLength(2);
      surface.setTool('froglight.ink.lasso');
      canvas.dispatchEvent(pointer('pointerdown', 3, 80, 80));
      canvas.dispatchEvent(pointer('pointermove', 3, 250, 80));
      canvas.dispatchEvent(pointer('pointermove', 3, 250, 160));
      canvas.dispatchEvent(pointer('pointerup', 3, 80, 160));
      await frame();
      const context = surface.selectionContext();
      expect(context?.ids).toHaveLength(2);
      expect(context?.kinds).toEqual(['ink']);
      const copies = surface.duplicateSelection();
      expect(copies).toHaveLength(2);
      expect(model.order).toHaveLength(4);
      expect(surface.undo()).toBe(true);
      expect(model.order).toHaveLength(2);
    } finally {
      surface.destroy();
      parent.remove();
    }
  });

  it('ignores extra pointers while a stroke is being captured (palm guard)', async () => {
    const { canvas, model, handle } = mounted();
    canvas.dispatchEvent(pointer('pointerdown', 1, 100, 100));
    canvas.dispatchEvent(pointer('pointermove', 1, 130, 100));
    // A second contact arrives mid-stroke.
    canvas.dispatchEvent(pointer('pointerdown', 2, 200, 200));
    canvas.dispatchEvent(pointer('pointermove', 2, 260, 260));
    canvas.dispatchEvent(pointer('pointerup', 2, 270, 270));
    canvas.dispatchEvent(pointer('pointerup', 1, 160, 100));
    await frame();
    expect(model.order).toHaveLength(1);
    const points = model.objects[model.order[0]!]!.points as Array<{
      x: number;
    }>;
    // The palm never contributed samples.
    expect(points.every((p) => p.x < 200)).toBe(true);
    handle.destroy();
  });
});

describe('mountInkSurface — creation tools & page frame', () => {
  beforeEach(() => {
    canvasStub?.restore();
    canvasStub = installCanvasStub();
  });

  function mounted() {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const { model, session } = makeSession();
    const handle = mountUiSurface(parent, {
      model,
      markDirty: () => session.markDirty(),
    });
    const canvas = parent.querySelector<HTMLCanvasElement>('.fl-ink-canvas')!;
    return { parent, canvas, model, session, handle };
  }

  it('keeps an embedded overlay transparent for host-rendered page bases', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const { model, session } = makeSession();
    const handle = mountUiSurface(parent, {
      model,
      markDirty: () => session.markDirty(),
      presentation: 'embedded-overlay',
    });

    await frame();

    expect(canvasStub.log.some(([name]) => name === 'fillRect')).toBe(false);
    expect(
      parent.querySelector<HTMLElement>('.fl-ink-root')?.dataset.presentation,
    ).toBe('embedded-overlay');
    // No runtime style injection: the overlay rule ships with the colocated
    // React skeleton stylesheet under the components layer.
    expect(inkSkeletonCss).toContain(
      ".fl-ink-root[data-presentation='embedded-overlay']",
    );
    expect(inkSkeletonCss).toContain('background: transparent');
    expect(inkSkeletonCss).toContain('@layer components');
    expect(document.querySelector('#fl-ink-editor-styles')).toBeNull();
    handle.destroy();
  });

  it('rectangle tool commits a core rectangle from a drag; tap makes a default shape', async () => {
    const { canvas, model, handle } = mounted();
    handle.setTool(INK_TOOL_IDS.rect);
    expect(handle.activeToolId()).toBe(INK_TOOL_IDS.rect);

    const surf = (vx: number, vy: number) => {
      const c = handle.camera();
      return { x: vx / c.zoom + c.x, y: vy / c.zoom + c.y };
    };
    canvas.dispatchEvent(pointer('pointerdown', 1, 10, 10));
    canvas.dispatchEvent(pointer('pointermove', 1, 60, 40));
    await frame();
    // Live preview renders as a rect draw op before commit.
    expect(
      canvasStub.log.filter(([n]) => n === 'fillRect').length,
    ).toBeGreaterThan(0);
    canvas.dispatchEvent(pointer('pointerup', 1, 60, 40));
    await frame();

    expect(model.order).toHaveLength(1);
    const rect = model.objects[model.order[0]!]!;
    const a = surf(10, 10);
    const b = surf(60, 40);
    expect(rect.type).toBe('froglight.rectangle');
    expect(rect.x).toBeCloseTo(Math.min(a.x, b.x), 6);
    expect(rect.width).toBeCloseTo(Math.abs(b.x - a.x), 6);
    expect(rect.height).toBeCloseTo(Math.abs(b.y - a.y), 6);

    await drawTap(canvas, 100, 100);
    expect(model.order).toHaveLength(2);
    handle.destroy();
  });

  it('line tool commits an arrowed froglight.line connector', async () => {
    const { canvas, model, handle } = mounted();
    handle.setTool(INK_TOOL_IDS.line);
    canvas.dispatchEvent(pointer('pointerdown', 1, 0, 0));
    canvas.dispatchEvent(pointer('pointerup', 1, 80, 40));
    await frame();
    const line = model.objects[model.order[0]!]!;
    const c = handle.camera();
    expect(line.type).toBe('froglight.line');
    expect(line.arrows).toBe('end');
    expect(line.x2).toBeCloseTo(80 / c.zoom + c.x, 6);
    expect(line.y2).toBeCloseTo(40 / c.zoom + c.y, 6);
    handle.destroy();
  });

  it('text tool opens an inline editor and commits on Enter', async () => {
    const { parent, canvas, model, handle } = mounted();
    handle.setTool(INK_TOOL_IDS.text);
    canvas.dispatchEvent(pointer('pointerdown', 1, 20, 20));
    const input = parent.querySelector<HTMLInputElement>('.fl-ink-text-input')!;
    input.value = 'Glycolysis';
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    await frame();
    expect(model.order).toHaveLength(1);
    const text = model.objects[model.order[0]!]!;
    expect(text.type).toBe('froglight.text');
    expect(text.text).toBe('Glycolysis');
    handle.destroy();
  });

  it('the page border resizes directly, Paint-style, on the default tool', async () => {
    const { canvas, model, handle } = mounted();
    // Default pen tool — the border must still grab. After fit-to-view
    // (zoom 0.92 at the 800×600 fallback pane), the east border sits at
    // view x = 768; dragging +92px grows the page by exactly 100 units.
    const c = handle.camera();
    const eastX = (800 - c.x) * c.zoom;
    const midY = (300 - c.y) * c.zoom;
    canvas.dispatchEvent(pointer('pointerdown', 3, eastX, midY));
    canvas.dispatchEvent(pointer('pointermove', 3, eastX + 92, midY));
    canvas.dispatchEvent(pointer('pointerup', 3, eastX + 92, midY));
    await frame();
    expect(model.frame).toEqual({ kind: 'bounded', width: 900, height: 600 });
    handle.destroy();
  });

  it('hides frame resize handles in read-only mode', async () => {
    const { handle } = mounted();
    await frame();

    handle.setReadOnly(true);
    await frame();

    const lastClear = canvasStub.log
      .map(([name]) => name)
      .lastIndexOf('clearRect');
    const visibleHandles = canvasStub.log
      .slice(lastClear + 1)
      .filter(
        ([name, , , width, height]) =>
          name === 'rect' && width === 10 && height === 10,
      );
    expect(visibleHandles).toHaveLength(0);
    handle.destroy();
  });

  it('freehand strokes near a page corner are never hijacked into resizes', async () => {
    const { canvas, model, handle } = mounted();
    const camera = handle.camera();
    const left = -camera.x * camera.zoom;
    const top = -camera.y * camera.zoom;
    await drawTap(canvas, left + 13, top + 13); // inside paper, just beyond resize chrome
    await frame();
    expect(model.order).toHaveLength(1);
    expect(model.frame).toEqual({ kind: 'bounded', width: 800, height: 600 });
    handle.destroy();
  });
});

describe('mountInkSurface — rendering regressions (user-visible bugs)', () => {
  beforeEach(() => {
    canvasStub?.restore();
    canvasStub = installCanvasStub();
  });

  it.each([960, 640])(
    'paints the first settled notebook frame at width %i with its new page fit',
    async (settledWidth) => {
      const parent = document.createElement('div');
      document.body.appendChild(parent);
      const model = emptySurface(boundedFrame(800, 600));
      model.objects.r1 = rectangleObject('r1', {
        x: 200,
        y: 200,
        width: 80,
        height: 60,
      });
      model.order.push('r1');
      const canonical = JSON.stringify(model);
      let dirty = 0;
      const handle = mountUiSurface(parent, {
        model,
        markDirty: () => {
          dirty += 1;
        },
        presentation: 'embedded-paper',
        renderViewport: parent,
      });
      const page = parent.querySelector<HTMLElement>('.fl-ink-page')!;
      let width = 800;
      Object.defineProperty(page, 'clientWidth', { get: () => width });
      page.getBoundingClientRect = () => new DOMRect(0, 0, width, width * 0.75);
      handle.refreshViewport();
      await frame();
      const initialZoom = handle.camera().zoom;
      // The pager replaces its CSS transform with real layout before the
      // surface's rAF; ResizeObserver delivers only after that frame.
      width = settledWidth;
      handle.refreshViewport();
      await frame();
      try {
        expect(handle.camera().zoom).toBeCloseTo(
          (initialZoom * settledWidth) / 800,
        );
        expect(JSON.stringify(model)).toBe(canonical);
        expect(dirty).toBe(0);
      } finally {
        handle.destroy();
        parent.remove();
      }
    },
  );

  it('committed strokes stay composited while a new stroke is captured', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const { model } = makeSession();
    model.objects.s0 = {
      id: 's0',
      type: 'froglight.rectangle',
      x: 100,
      y: 100,
      width: 50,
      height: 40,
    };
    model.order.push('s0');
    const handle = mountUiSurface(parent, {
      model,
      markDirty: () => undefined,
    });
    await frame();

    // Capture a new stroke WITHOUT releasing: the rectangle must still be
    // drawn on every frame (drawImage after the last clearRect).
    const canvas = parent.querySelector<HTMLCanvasElement>('.fl-ink-canvas')!;
    canvas.dispatchEvent(pointer('pointerdown', 9, 5, 5));
    canvas.dispatchEvent(pointer('pointermove', 9, 30, 30));
    await frame();

    const names = canvasStub.log.map(([n]) => n);
    const lastClear = names.lastIndexOf('clearRect');
    const blitAfterClear = names.indexOf('drawImage', lastClear);
    expect(blitAfterClear).toBeGreaterThan(lastClear);
    // And no second clear wiped it before the scene was painted.
    expect(
      names.slice(lastClear + 1, blitAfterClear).includes('clearRect'),
    ).toBe(false);
    // The committed rectangle is part of the cached layer (fillRect op).
    expect(names.slice(0, lastClear).includes('fillRect')).toBe(true);
    handle.destroy();
  });

  it('selection renders dashed chrome so shapes show as selected', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const { model } = makeSession();
    model.objects.r1 = {
      id: 'r1',
      type: 'froglight.rectangle',
      x: 10,
      y: 10,
      width: 60,
      height: 30,
    };
    model.order.push('r1');
    const handle = mountUiSurface(parent, {
      model,
      markDirty: () => undefined,
    });
    handle.setSelection?.(['r1']);
    await frame();
    expect(canvasStub.log.some(([n]) => n === 'setLineDash')).toBe(true);
    handle.destroy();
  });
});

describe('surface image support', () => {
  beforeEach(() => {
    canvasStub?.restore();
    canvasStub = installCanvasStub();
  });

  interface ImageFixture {
    parent: HTMLElement;
    model: SurfaceModel;
    surface: InkSurfaceHandle;
    puts: Array<{ name: string; bytes: Uint8Array }>;
    bitmap: CanvasImageSource;
    dirty(): number;
  }

  function mountWithAssets(): ImageFixture {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const { model } = makeSession();
    let dirtyCount = 0;
    const puts: Array<{ name: string; bytes: Uint8Array }> = [];
    const stored = new Map<string, Uint8Array>();
    const assets: DocumentAssetStore = {
      async put(bytes, options) {
        puts.push({ name: options?.suggestedName ?? '', bytes });
        const path = workspacePath(`attachments/hash-${puts.length}`);
        stored.set(path, bytes);
        return { path, sha256: `sha-${puts.length}` };
      },
      async read(path) {
        const bytes = stored.get(path);
        if (bytes === undefined) throw new Error('missing asset');
        return bytes;
      },
    };
    const bitmap = {
      tag: 'bitmap',
      width: 400,
      height: 200,
    } as unknown as DecodedImage;
    const surface = mountUiSurface(parent, {
      model,
      markDirty: () => (dirtyCount += 1),
      assets,
      decodeImage: async () => bitmap,
    });
    return { parent, model, surface, puts, bitmap, dirty: () => dirtyCount };
  }

  function pngFile(): File {
    return new File([new Uint8Array([137, 80, 78, 71])], 'photo.png', {
      type: 'image/png',
    });
  }

  it('insertImage commits an aspect-correct centered image object', async () => {
    const { model, surface, puts, dirty } = mountWithAssets();
    expect(surface.canInsertImage()).toBe(true);

    const id = await surface.insertImage(pngFile());

    expect(id).not.toBeNull();
    expect(puts).toHaveLength(1);
    expect(puts[0]!.name).toBe('photo.png');
    const record = model.objects[id!]!;
    expect(record.type).toBe('froglight.image');
    // Natural 400×200 fits the 50%-width box untouched, centered on the page.
    expect(record.width).toBe(400);
    expect(record.height).toBe(200);
    expect(record.x).toBe(200);
    expect(record.y).toBe(200);
    expect(dirty()).toBe(1);
    surface.destroy();
  });

  it('publishes the inserted bitmap to the renderer', async () => {
    const { surface, bitmap } = mountWithAssets();

    await surface.insertImage(pngFile());
    await frame();
    await frame();

    expect(
      canvasStub.log.some(
        ([name, source]) => name === 'drawImage' && source === bitmap,
      ),
    ).toBe(true);
    surface.destroy();
  });

  it('inserted images undo as one gesture', async () => {
    const { model, surface } = mountWithAssets();

    const id = await surface.insertImage(pngFile());
    expect(model.order).toContain(id);

    expect(surface.undo()).toBe(true);
    expect(model.objects[id!]).toBeUndefined();
    expect(model.order).not.toContain(id!);
    expect(surface.undo()).toBe(false);
    surface.destroy();
  });

  it('images stay unavailable without an asset store or when read-only', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const { model } = makeSession();
    const bare = mountUiSurface(parent, {
      model,
      markDirty: () => undefined,
    });

    expect(bare.canInsertImage()).toBe(false);
    await expect(bare.insertImage(pngFile())).resolves.toBeNull();
    expect(model.order).toHaveLength(0);

    bare.setReadOnly(true);
    expect(bare.canInsertImage()).toBe(false);
    bare.destroy();
  });

  it('honors an explicit resolver over the internal cache (notebook path)', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const { model } = makeSession();
    const bitmap = { tag: 'external' } as unknown as CanvasImageSource;
    const object = imageObject('img-x', {
      x: 0,
      y: 0,
      width: 100,
      height: 50,
      src: 'attachments/abc',
      sha256: 'abc',
    });
    model.order.push(object.id);
    model.objects[object.id] = object;

    const handle = mountUiSurface(parent, {
      model,
      markDirty: () => undefined,
      imageResolver: new Map([['attachments/abc', bitmap]]),
    });
    await frame();

    expect(
      canvasStub.log.some(
        ([name, source]) => name === 'drawImage' && source === bitmap,
      ),
    ).toBe(true);
    handle.destroy();
  });

  it('the provider wires assets through and offers the image control', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const { session } = makeSession();
    const assets: DocumentAssetStore = {
      async put(bytes) {
        void bytes;
        return { path: workspacePath('attachments/x'), sha256: 'x' };
      },
      async read() {
        return new Uint8Array();
      },
    };
    const handle = new InkDocumentEditorProvider().createEditor({
      session,
      parent,
      assets,
    });
    const control = handle
      .tools!.snapshot()
      .controls.find((entry) => 'id' in entry && entry.id === 'ink.image');
    expect(control).toBeDefined();
    expect((control as { disabled?: boolean }).disabled).toBe(false);
    expect(handle.tools!.execute('ink.image')).toBe(true);
    handle.destroy();

    // Without an asset store the control stays visible but disabled.
    const bareParent = document.createElement('div');
    document.body.appendChild(bareParent);
    const bare = new InkDocumentEditorProvider().createEditor({
      session: makeSession().session,
      parent: bareParent,
    });
    const bareControl = bare
      .tools!.snapshot()
      .controls.find((entry) => 'id' in entry && entry.id === 'ink.image');
    expect(bareControl).toBeDefined();
    expect((bareControl as { disabled?: boolean }).disabled).toBe(true);
    bare.destroy();
  });
});
