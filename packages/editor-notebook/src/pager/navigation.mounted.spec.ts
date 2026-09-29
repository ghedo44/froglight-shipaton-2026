import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendPage,
  boundedFrame,
  emptyNotebook,
  emptySurface,
  notebookPage,
  inkStrokeObject,
  rectangleObject,
  textObject,
  type SurfaceModel,
} from '@froglight/foundation';
import { installCanvasStub } from '@froglight/foundation/testing';
import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import {
  mountNotebook,
  type NotebookPagerHandle,
  type NotebookPagerSkeleton,
} from '../pager.js';
import { NotebookChrome } from '../react/NotebookChrome.jsx';
import { installNotebookNavigationTiming } from './navigation.js';

const VIEWPORT = { left: 100, top: 50, width: 1_000, height: 800 };
const PADDING = { x: 50, y: 28 };
const PAGE_GAP = 28;
const PAGE_BORDER = 2;
const PAGE_POINT = { u: 0.72, v: 0.41 };

interface MountedPager {
  readonly pager: NotebookPagerHandle;
  readonly model: ReturnType<typeof emptyNotebook>;
  readonly reactRoot: Root;
  readonly parent: HTMLElement;
  readonly scroll: HTMLElement;
  readonly stack: HTMLElement;
  readonly shells: readonly HTMLElement[];
  destroy(): void;
}

class FrameDriver {
  nowMs = 0;
  #nextId = 1;
  readonly #callbacks = new Map<number, FrameRequestCallback>();

  readonly timing = {
    now: (): number => this.nowMs,
    requestFrame: (callback: FrameRequestCallback): number => {
      const id = this.#nextId++;
      this.#callbacks.set(id, callback);
      return id;
    },
    cancelFrame: (id: number): void => {
      this.#callbacks.delete(id);
    },
  };

  get pending(): number {
    return this.#callbacks.size;
  }

  advance(milliseconds = 16): void {
    this.nowMs += milliseconds;
    const callbacks = [...this.#callbacks.values()];
    this.#callbacks.clear();
    for (const callback of callbacks) callback(this.nowMs);
  }

  settle(maximumFrames = 240): void {
    for (let frame = 0; frame < maximumFrames && this.pending > 0; frame += 1)
      this.advance();
    expect(this.pending).toBe(0);
  }
}

class HiddenPageObserver implements IntersectionObserver {
  static latest: HiddenPageObserver | null = null;
  readonly root: Element | Document | null;
  readonly rootMargin: string;
  readonly scrollMargin = '';
  readonly thresholds = [0];
  readonly #callback: IntersectionObserverCallback;
  constructor(
    callback: IntersectionObserverCallback,
    options?: IntersectionObserverInit,
  ) {
    this.#callback = callback;
    this.root = options?.root ?? null;
    this.rootMargin = options?.rootMargin ?? '0px';
    HiddenPageObserver.latest = this;
  }
  emit(entries: readonly Partial<IntersectionObserverEntry>[]): void {
    this.#callback(entries as IntersectionObserverEntry[], this);
  }
  disconnect(): void {
    // Test observer intentionally never reports visibility.
  }
  observe(): void {
    // Test observer intentionally never reports visibility.
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  unobserve(): void {
    // Test observer intentionally never reports visibility.
  }
}

function rect(
  left: number,
  top: number,
  width: number,
  height: number,
): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    toJSON: () => ({}),
  } as DOMRect;
}

function pointerEvent(
  type: string,
  point: { readonly x: number; readonly y: number },
  pointerId: number,
  pointerType = 'touch',
): Event {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: point.x,
    clientY: point.y,
  });
  Object.defineProperty(event, 'pointerId', { value: pointerId });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  return event;
}

function pageOuterSize(shell: HTMLElement): { width: number; height: number } {
  const width = Number.parseFloat(shell.style.width) + PAGE_BORDER;
  const [ratioWidth = 1, ratioHeight = 1] = shell.style.aspectRatio
    .split('/')
    .map((part) => Number.parseFloat(part.trim()));
  return {
    width,
    height: (width - PAGE_BORDER) * (ratioHeight / ratioWidth) + PAGE_BORDER,
  };
}

function installGeometry(mounted: Omit<MountedPager, 'destroy'>): void {
  const { scroll, stack, shells } = mounted;
  let scrollLeft = 0;
  let scrollTop = 0;

  const stackWidth = (): number =>
    Math.max(
      VIEWPORT.width - PADDING.x * 2,
      ...shells.map((shell) => pageOuterSize(shell).width),
    );
  const stackHeight = (): number =>
    shells.reduce(
      (height, shell, index) =>
        height + pageOuterSize(shell).height + (index === 0 ? 0 : PAGE_GAP),
      0,
    );
  const maxScrollLeft = (): number =>
    Math.max(0, PADDING.x * 2 + stackWidth() - VIEWPORT.width);
  const maxScrollTop = (): number =>
    Math.max(0, PADDING.y * 2 + stackHeight() - VIEWPORT.height);

  Object.defineProperties(scroll, {
    clientWidth: { configurable: true, get: () => VIEWPORT.width },
    clientHeight: { configurable: true, get: () => VIEWPORT.height },
    scrollWidth: {
      configurable: true,
      get: () => PADDING.x * 2 + stackWidth(),
    },
    scrollHeight: {
      configurable: true,
      get: () => PADDING.y * 2 + stackHeight(),
    },
    scrollLeft: {
      configurable: true,
      get: () => scrollLeft,
      set: (value: number) => {
        scrollLeft = Math.min(Math.max(value, 0), maxScrollLeft());
      },
    },
    scrollTop: {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => {
        scrollTop = Math.min(Math.max(value, 0), maxScrollTop());
      },
    },
  });
  scroll.getBoundingClientRect = () =>
    rect(VIEWPORT.left, VIEWPORT.top, VIEWPORT.width, VIEWPORT.height);

  Object.defineProperties(stack, {
    offsetLeft: { configurable: true, get: () => PADDING.x },
    offsetTop: { configurable: true, get: () => PADDING.y },
  });
  stack.getBoundingClientRect = () =>
    rect(
      VIEWPORT.left + PADDING.x - scrollLeft,
      VIEWPORT.top + PADDING.y - scrollTop,
      stackWidth(),
      stackHeight(),
    );

  for (const [index, shell] of shells.entries()) {
    Object.defineProperty(shell, 'clientWidth', {
      configurable: true,
      get: () => pageOuterSize(shell).width - PAGE_BORDER,
    });
    shell.getBoundingClientRect = () => {
      const size = pageOuterSize(shell);
      let left =
        VIEWPORT.left +
        PADDING.x -
        scrollLeft +
        (stackWidth() - size.width) / 2;
      const precedingHeight = shells
        .slice(0, index)
        .reduce(
          (height, previous) => height + pageOuterSize(previous).height,
          0,
        );
      let top =
        VIEWPORT.top +
        PADDING.y -
        scrollTop +
        precedingHeight +
        index * PAGE_GAP;
      let width = size.width;
      let height = size.height;
      const transform = parsePreviewTransform(stack.style.transform);
      if (transform !== null) {
        const origin = stack.style.transformOrigin
          .split(' ')
          .map((value) => Number.parseFloat(value));
        const stackLeft = VIEWPORT.left + PADDING.x - scrollLeft;
        const stackTop = VIEWPORT.top + PADDING.y - scrollTop;
        const originX = stackLeft + (origin[0] ?? 0);
        const originY = stackTop + (origin[1] ?? 0);
        const { x: translateX, y: translateY, scale } = transform;
        left = originX + (left - originX) * scale + translateX;
        top = originY + (top - originY) * scale + translateY;
        width *= scale;
        height *= scale;
      }
      return rect(left, top, width, height);
    };
  }
}

function mountPager(
  options: {
    readonly frames?: FrameDriver;
    readonly reducedMotion?: boolean;
    readonly markDirty?: () => void;
    readonly seedSurface?: (surface: SurfaceModel) => void;
  } = {},
): MountedPager {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const chromeRef: { current: NotebookPagerSkeleton | null } = {
    current: null,
  };
  const reactRoot = createRoot(parent);
  flushSync(() => {
    reactRoot.render(createElement(NotebookChrome, { chromeRef }));
  });
  const host = chromeRef.current;
  if (host === null) throw new Error('Notebook chrome failed to mount');

  Object.defineProperties(host.scroll, {
    clientWidth: { configurable: true, get: () => VIEWPORT.width },
    clientHeight: { configurable: true, get: () => VIEWPORT.height },
  });
  host.scroll.getBoundingClientRect = () =>
    rect(VIEWPORT.left, VIEWPORT.top, VIEWPORT.width, VIEWPORT.height);

  const model = emptyNotebook('Navigation geometry');
  for (const id of ['page-1', 'page-2', 'page-3']) {
    appendPage(
      model,
      notebookPage(id, {
        surface: emptySurface(boundedFrame(800, 600)),
      }),
    );
  }
  const first = model.pages['page-1'];
  if (first?.kind === 'page') options.seedSurface?.(first.surface);
  const timingScope =
    options.frames === undefined
      ? null
      : installNotebookNavigationTiming(host.scroll, {
          ...options.frames.timing,
          reducedMotion: options.reducedMotion ?? false,
        });
  const pager = mountNotebook({
    model,
    markDirty: options.markDirty ?? (() => undefined),
    host,
  });
  const shells = [...host.stack.querySelectorAll<HTMLElement>('.fl-nb-shell')];
  const mounted = {
    pager,
    model,
    reactRoot,
    parent,
    scroll: host.scroll,
    stack: host.stack,
    shells,
  };
  installGeometry(mounted);
  return {
    ...mounted,
    destroy() {
      reactRoot.unmount();
      pager.destroy();
      timingScope?.dispose();
      parent.remove();
    },
  };
}

function pagePoint(shell: HTMLElement): { x: number; y: number } {
  const bounds = shell.getBoundingClientRect();
  return {
    x: bounds.left + bounds.width * PAGE_POINT.u,
    y: bounds.top + bounds.height * PAGE_POINT.v,
  };
}

function performPinch(
  scroll: HTMLElement,
  startCentroid: { readonly x: number; readonly y: number },
  factor: number,
  translation: { readonly x: number; readonly y: number },
): { x: number; y: number } {
  const startRadius = 100;
  const finalRadius = startRadius * factor;
  const finalCentroid = {
    x: startCentroid.x + translation.x,
    y: startCentroid.y + translation.y,
  };
  scroll.dispatchEvent(
    pointerEvent(
      'pointerdown',
      { x: startCentroid.x - startRadius, y: startCentroid.y },
      1,
    ),
  );
  scroll.dispatchEvent(
    pointerEvent(
      'pointerdown',
      { x: startCentroid.x + startRadius, y: startCentroid.y },
      2,
    ),
  );
  scroll.dispatchEvent(
    pointerEvent(
      'pointermove',
      { x: finalCentroid.x - finalRadius, y: finalCentroid.y },
      1,
    ),
  );
  scroll.dispatchEvent(
    pointerEvent(
      'pointermove',
      { x: finalCentroid.x + finalRadius, y: finalCentroid.y },
      2,
    ),
  );
  scroll.dispatchEvent(
    pointerEvent(
      'pointerup',
      { x: finalCentroid.x + finalRadius, y: finalCentroid.y },
      2,
    ),
  );
  scroll.dispatchEvent(
    pointerEvent(
      'pointerup',
      { x: finalCentroid.x - finalRadius, y: finalCentroid.y },
      1,
    ),
  );
  return finalCentroid;
}

function distance(
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function parsePreviewTransform(
  value: string,
): { x: number; y: number; scale: number } | null {
  const match = /translate\(([^,]+)px, ([^)]+)px\) scale\(([^)]+)\)/.exec(
    value,
  );
  if (match === null) return null;
  const parsed = {
    x: Number(match[1]),
    y: Number(match[2]),
    scale: Number(match[3]),
  };
  return Object.values(parsed).every(Number.isFinite) ? parsed : null;
}

function previewTransform(stack: HTMLElement): {
  x: number;
  y: number;
  scale: number;
} {
  const parsed = parsePreviewTransform(stack.style.transform);
  expect(
    parsed,
    `expected an observable live pinch transform, received "${stack.style.transform}"`,
  ).not.toBeNull();
  if (parsed === null)
    throw new Error('live pinch transform was not published');
  return parsed;
}

describe('mounted Notebook touch navigation geometry', () => {
  let previousIntersectionObserver: typeof IntersectionObserver | undefined;

  beforeEach(() => {
    previousIntersectionObserver = globalThis.IntersectionObserver;
    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      value: HiddenPageObserver,
    });
  });

  afterEach(() => {
    if (previousIntersectionObserver === undefined) {
      delete (globalThis as { IntersectionObserver?: unknown })
        .IntersectionObserver;
    } else {
      Object.defineProperty(globalThis, 'IntersectionObserver', {
        configurable: true,
        value: previousIntersectionObserver,
      });
    }
    document.body.replaceChildren();
  });

  function mountTouchFixture() {
    const restoreCanvas = installCanvasStub();
    let dirty = 0;
    const mounted = mountPager({
      markDirty: () => {
        dirty += 1;
      },
      seedSurface: (surface) => {
        surface.objects.text = textObject('text', {
          x: 100,
          y: 100,
          text: 'Notebook text',
        });
        surface.objects.stroke = inkStrokeObject('stroke', {
          points: [
            { x: 100, y: 300 },
            { x: 200, y: 300 },
          ],
          width: 3,
        });
        surface.objects.rect = rectangleObject('rect', {
          x: 300,
          y: 300,
          width: 100,
          height: 80,
        });
        surface.order.push('text', 'stroke', 'rect');
      },
    });
    HiddenPageObserver.latest?.emit([
      { target: mounted.shells[0], isIntersecting: true },
    ]);
    const canvas =
      mounted.parent.querySelector<HTMLCanvasElement>('.fl-ps canvas');
    const page = mounted.parent.querySelector<HTMLElement>(
      '.fl-ps .fl-ink-page',
    );
    if (canvas === null || page === null)
      throw new Error('page surface did not mount');
    page.getBoundingClientRect = () => rect(0, 0, 800, 600);
    canvas.getBoundingClientRect = page.getBoundingClientRect;
    const pointFor = (id: string) => {
      mounted.pager.setSelection([id]);
      const bounds = mounted.pager.selectionViewportBounds();
      if (bounds === null) throw new Error('missing selection bounds');
      mounted.pager.setSelection([]);
      return {
        x: bounds.x + bounds.width / 2,
        y: bounds.y + bounds.height / 2,
      };
    };
    const text = pointFor('text');
    const stroke = pointFor('stroke');
    const shape = pointFor('rect');
    const send = (type: string, point: { x: number; y: number }, id = 1) =>
      canvas.dispatchEvent(pointerEvent(type, point, id));
    return {
      ...mounted,
      canvas,
      text,
      stroke,
      shape,
      send,
      dirty: () => dirty,
      destroy() {
        mounted.destroy();
        restoreCanvas();
      },
    };
  }

  it('delegates navigation until lift, then selects any tapped object', () => {
    const fixture = mountTouchFixture();
    try {
      const captures: number[] = [];
      fixture.scroll.setPointerCapture = (id) => captures.push(id);
      fixture.send('pointerdown', { x: 550, y: 450 });
      fixture.send('pointerup', { x: 550, y: 450 });
      expect(fixture.pager.selectionIds()).toEqual([]);
      for (const [id, point] of [
        ['stroke', fixture.stroke],
        ['rect', fixture.shape],
        ['text', fixture.text],
      ] as const) {
        fixture.pager.setSelection([]);
        fixture.send('pointerdown', point);
        expect(fixture.pager.selectionIds()).toEqual([]);
        fixture.send('pointerup', point);
        expect(fixture.pager.selectionIds()).toEqual([id]);
      }
      expect(captures).toEqual([1, 1, 1, 1]);
      expect(fixture.pager.activeToolId()).toBe('froglight.ink.pen');
      expect(fixture.pager.settledActiveToolId?.()).toBe('froglight.ink.pen');
      expect(fixture.dirty()).toBe(0);
      expect(fixture.pager.canUndo()).toBe(false);
    } finally {
      fixture.destroy();
    }
  });

  it('claims existing selection, cancels on second finger, and transfers both captures to pager pinch', () => {
    const fixture = mountTouchFixture();
    try {
      const captures: number[] = [];
      const releases: number[] = [];
      fixture.scroll.setPointerCapture = (id) => {
        captures.push(id);
      };
      fixture.canvas.releasePointerCapture = (id) => {
        releases.push(id);
      };
      fixture.pager.setSelection(['rect']);
      const before = JSON.stringify(fixture.model);
      fixture.send('pointerdown', fixture.shape);
      const end = { x: fixture.shape.x + 40, y: fixture.shape.y + 40 };
      fixture.send('pointermove', end);
      expect(captures).toEqual([]);
      expect(JSON.stringify(fixture.model)).toBe(before);
      fixture.send('pointerdown', { x: 550, y: 450 }, 2);
      expect(releases).toContain(1);
      expect(captures).toEqual([1, 2]);
      fixture.send('lostpointercapture', end);
      fixture.scroll.dispatchEvent(
        pointerEvent('pointermove', { x: 650, y: 500 }, 2),
      );
      expect(previewTransform(fixture.stack).scale).not.toBe(1);
      fixture.scroll.dispatchEvent(
        pointerEvent('pointerup', { x: 650, y: 500 }, 2),
      );
      fixture.scroll.dispatchEvent(pointerEvent('pointerup', end, 1));
      expect(JSON.stringify(fixture.model)).toBe(before);
      expect(fixture.dirty()).toBe(0);
      expect(fixture.pager.canUndo()).toBe(false);
      // A subsequent page gesture works: neither Surface nor pager is stuck.
      fixture.pager.setSelection(['rect']);
      fixture.send('pointerdown', fixture.shape, 3);
      fixture.send(
        'pointerup',
        { x: fixture.shape.x + 20, y: fixture.shape.y + 20 },
        3,
      );
      expect(fixture.pager.canUndo()).toBe(true);
    } finally {
      fixture.destroy();
    }
  });

  it('outside touch clears selection and the same pointer scrolls without history', () => {
    const fixture = mountTouchFixture();
    try {
      fixture.pager.setSelection(['text']);
      const before = JSON.stringify(fixture.model);
      fixture.send('pointerdown', { x: 550, y: 450 });
      expect(fixture.pager.selectionIds()).toEqual([]);
      expect(fixture.pager.selectionViewportBounds()).toBeNull();
      fixture.send('pointermove', { x: 550, y: 350 });
      expect(fixture.scroll.scrollTop).toBeGreaterThan(0);
      fixture.send('pointerup', { x: 550, y: 350 });
      expect(fixture.dirty()).toBe(0);
      expect(fixture.pager.canUndo()).toBe(false);
      expect(JSON.stringify(fixture.model)).toBe(before);
    } finally {
      fixture.destroy();
    }
  });

  it('a gap touch dismisses page selection while retaining pager navigation', () => {
    const fixture = mountTouchFixture();
    try {
      fixture.pager.setSelection(['text']);
      fixture.scroll.dispatchEvent(
        pointerEvent('pointerdown', { x: 600, y: 700 }, 1),
      );
      expect(fixture.pager.selectionIds()).toEqual([]);
      fixture.scroll.dispatchEvent(
        pointerEvent('pointermove', { x: 600, y: 600 }, 1),
      );
      expect(fixture.scroll.scrollTop).toBeGreaterThan(0);
      fixture.scroll.dispatchEvent(
        pointerEvent('pointerup', { x: 600, y: 600 }, 1),
      );
      expect(fixture.dirty()).toBe(0);
      expect(fixture.pager.canUndo()).toBe(false);
    } finally {
      fixture.destroy();
    }
  });

  it('leaves focused Surface text input under its existing input owner', () => {
    const fixture = mountTouchFixture();
    try {
      fixture.pager.setTool('froglight.notebook.text');
      fixture.canvas.dispatchEvent(
        new MouseEvent('dblclick', {
          bubbles: true,
          clientX: fixture.text.x,
          clientY: fixture.text.y,
        }),
      );
      const input =
        fixture.parent.querySelector<HTMLElement>('.fl-ink-text-input');
      expect(input).not.toBeNull();
      expect(fixture.pager.selectionIds()).toEqual(['text']);
      input!.dispatchEvent(pointerEvent('pointerdown', fixture.text, 1));
      expect(fixture.pager.selectionIds()).toEqual(['text']);
    } finally {
      fixture.destroy();
    }
  });

  it('prepares pages one viewport ahead and releases pages outside the buffer', () => {
    const mounted = mountPager();
    try {
      expect(HiddenPageObserver.latest?.root).toBe(mounted.scroll);
      expect(HiddenPageObserver.latest?.rootMargin).toBe('800px 0px');

      HiddenPageObserver.latest?.emit([
        { target: mounted.shells[1], isIntersecting: true },
      ]);
      expect(mounted.parent.querySelectorAll('.fl-ps canvas')).toHaveLength(1);

      HiddenPageObserver.latest?.emit([
        { target: mounted.shells[1], isIntersecting: false },
      ]);
      expect(mounted.parent.querySelectorAll('.fl-ps canvas')).toHaveLength(0);
    } finally {
      mounted.destroy();
    }
  });

  it('stops a smooth page jump before canvas input reaches every pointer owner', () => {
    const mounted = mountPager();
    try {
      const scrollCalls: ScrollToOptions[] = [];
      const navigationCalls: ScrollIntoViewOptions[] = [];
      mounted.scroll.scrollTo = (options?: ScrollToOptions | number): void => {
        if (typeof options === 'object') scrollCalls.push(options);
      };
      for (const shell of mounted.shells) {
        shell.scrollIntoView = (options?: ScrollIntoViewOptions): void => {
          if (options !== undefined) navigationCalls.push(options);
        };
      }
      const surface = document.createElement('div');
      surface.className = 'fl-ps';
      const canvas = document.createElement('canvas');
      canvas.className = 'fl-ink-canvas';
      surface.appendChild(canvas);
      mounted.shells[0]!.appendChild(surface);

      const delivered: string[] = [];
      canvas.addEventListener('pointerdown', (event) => {
        delivered.push((event as PointerEvent).pointerType);
        expect(event.defaultPrevented).toBe(false);
      });

      for (const [index, pointerType] of ['mouse', 'pen', 'touch'].entries()) {
        mounted.pager.jumpToPage(2);
        mounted.scroll.scrollLeft = 17 + index;
        mounted.scroll.scrollTop = 275 + index;
        const stoppedAt = {
          left: mounted.scroll.scrollLeft,
          top: mounted.scroll.scrollTop,
        };
        canvas.dispatchEvent(
          pointerEvent(
            'pointerdown',
            { x: VIEWPORT.left + 200, y: VIEWPORT.top + 200 },
            index + 1,
            pointerType,
          ),
        );
        expect(scrollCalls.at(-1)).toEqual({
          ...stoppedAt,
          behavior: 'auto',
        });
      }
      expect(delivered).toEqual(['mouse', 'pen', 'touch']);
      expect(scrollCalls).toHaveLength(3);

      // An older interrupted animation may report completion after a newer
      // jump starts. It must not disarm the newer canvas-input handoff.
      mounted.pager.jumpToPage(1);
      mounted.pager.jumpToPage(2);
      mounted.scroll.dispatchEvent(new Event('scrollend'));
      canvas.dispatchEvent(
        pointerEvent(
          'pointerdown',
          { x: VIEWPORT.left + 200, y: VIEWPORT.top + 200 },
          4,
          'pen',
        ),
      );
      expect(scrollCalls).toHaveLength(4);
      expect(navigationCalls).toHaveLength(5);
      expect(navigationCalls).toEqual(
        Array.from({ length: 5 }, () => ({
          behavior: 'smooth',
          block: 'start',
        })),
      );
    } finally {
      mounted.destroy();
    }
  });

  it.each([
    {
      name: 'when the centered page grows wider than the viewport',
      initialZoom: 1,
      initialScrollLeft: 0,
      initialScrollTop: 500,
      factor: 1.5,
      translation: { x: 30, y: -20 },
    },
    {
      name: 'when an already-wide page grows farther',
      initialZoom: 1.25,
      initialScrollLeft: 100,
      initialScrollTop: 650,
      factor: 1.25,
      translation: { x: 20, y: -15 },
    },
  ])(
    'keeps page 2 at u=.72, v=.41 under the final centroid $name',
    ({
      initialZoom,
      initialScrollLeft,
      initialScrollTop,
      factor,
      translation,
    }) => {
      const frames = new FrameDriver();
      const mounted = mountPager({ frames });
      try {
        mounted.pager.setZoomFactor(initialZoom);
        // settled toolbar zooms animate via zoom-spring (single
        // frame); settle setup so the pinch starts from the committed zoom.
        frames.settle();
        expect(mounted.pager.zoomFactor()).toBe(initialZoom);
        mounted.scroll.scrollLeft = initialScrollLeft;
        mounted.scroll.scrollTop = initialScrollTop;
        const shell = mounted.shells[1]!;
        const start = pagePoint(shell);

        const finalCentroid = performPinch(
          mounted.scroll,
          start,
          factor,
          translation,
        );

        expect(distance(pagePoint(shell), finalCentroid)).toBeLessThanOrEqual(
          1,
        );
      } finally {
        mounted.destroy();
      }
    },
  );

  it('commits two-finger translation even when the zoom factor is unchanged', () => {
    const mounted = mountPager();
    try {
      mounted.scroll.scrollTop = 500;
      const shell = mounted.shells[1]!;
      const start = pagePoint(shell);
      const finalCentroid = performPinch(mounted.scroll, start, 1, {
        x: 40,
        y: 25,
      });

      expect(distance(pagePoint(shell), finalCentroid)).toBeLessThanOrEqual(1);
    } finally {
      mounted.destroy();
    }
  });

  it('does not let a third touch change the transform owned by the primary pair', () => {
    const mounted = mountPager();
    try {
      mounted.scroll.scrollTop = 500;
      const center = pagePoint(mounted.shells[1]!);
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerdown', { x: center.x - 100, y: center.y }, 1),
      );
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerdown', { x: center.x + 100, y: center.y }, 2),
      );
      mounted.scroll.dispatchEvent(
        pointerEvent('pointermove', { x: center.x + 120, y: center.y }, 2),
      );
      const beforeThirdTouch = previewTransform(mounted.stack);
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerdown', { x: center.x + 600, y: center.y }, 3),
      );
      mounted.scroll.dispatchEvent(
        pointerEvent('pointermove', { x: center.x + 1_000, y: center.y }, 3),
      );
      const afterThirdTouch = previewTransform(mounted.stack);

      mounted.scroll.dispatchEvent(
        pointerEvent('pointerup', { x: center.x + 1_000, y: center.y }, 3),
      );
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerup', { x: center.x + 120, y: center.y }, 2),
      );
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerup', { x: center.x - 100, y: center.y }, 1),
      );

      expect(afterThirdTouch.x).toBeCloseTo(beforeThirdTouch.x, 6);
      expect(afterThirdTouch.y).toBeCloseTo(beforeThirdTouch.y, 6);
      expect(afterThirdTouch.scale).toBeCloseTo(beforeThirdTouch.scale, 6);
    } finally {
      mounted.destroy();
    }
  });

  it('rebases without a jump when a primary touch lifts while two touches remain', () => {
    const mounted = mountPager();
    try {
      mounted.scroll.scrollTop = 500;
      const shell = mounted.shells[1]!;
      const center = pagePoint(shell);
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerdown', { x: center.x - 100, y: center.y }, 1),
      );
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerdown', { x: center.x + 100, y: center.y }, 2),
      );
      mounted.scroll.dispatchEvent(
        pointerEvent('pointermove', { x: center.x + 140, y: center.y }, 2),
      );
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerdown', { x: center.x + 500, y: center.y }, 3),
      );
      const beforePrimaryLift = previewTransform(mounted.stack);

      mounted.scroll.dispatchEvent(
        pointerEvent('pointerup', { x: center.x - 100, y: center.y }, 1),
      );
      mounted.scroll.dispatchEvent(
        pointerEvent('pointermove', { x: center.x + 500, y: center.y }, 3),
      );
      const afterReplacementRebase = previewTransform(mounted.stack);

      mounted.scroll.dispatchEvent(
        pointerEvent('pointerup', { x: center.x + 500, y: center.y }, 3),
      );
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerup', { x: center.x + 140, y: center.y }, 2),
      );

      expect(afterReplacementRebase.x).toBeCloseTo(beforePrimaryLift.x, 6);
      expect(afterReplacementRebase.y).toBeCloseTo(beforePrimaryLift.y, 6);
      expect(afterReplacementRebase.scale).toBeCloseTo(
        beforePrimaryLift.scale,
        6,
      );
    } finally {
      mounted.destroy();
    }
  });

  it('folds edge translation into a new pinch baseline exactly once', () => {
    const mounted = mountPager();
    try {
      const shell = mounted.shells[0]!;
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerdown', { x: 500, y: 300 }, 1),
      );
      mounted.scroll.dispatchEvent(
        pointerEvent('pointermove', { x: 550, y: 300 }, 1),
      );
      const edge = previewTransform(mounted.stack);
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerdown', { x: 750, y: 300 }, 2),
      );
      const startCentroid = { x: 650, y: 300 };
      const startBounds = shell.getBoundingClientRect();
      const anchor = {
        u: (startCentroid.x - startBounds.left) / startBounds.width,
        v: (startCentroid.y - startBounds.top) / startBounds.height,
      };
      mounted.scroll.dispatchEvent(
        pointerEvent('pointermove', { x: 560, y: 300 }, 1),
      );
      mounted.scroll.dispatchEvent(
        pointerEvent('pointermove', { x: 760, y: 300 }, 2),
      );
      expect(previewTransform(mounted.stack).x).toBeCloseTo(edge.x + 10, 6);
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerup', { x: 760, y: 300 }, 2),
      );
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerup', { x: 560, y: 300 }, 1),
      );
      const committed = shell.getBoundingClientRect();
      expect(
        distance(
          {
            x: committed.left + committed.width * anchor.u,
            y: committed.top + committed.height * anchor.v,
          },
          { x: startCentroid.x + 10, y: startCentroid.y },
        ),
      ).toBeLessThanOrEqual(1);
    } finally {
      mounted.destroy();
    }
  });

  it('reconciles visibility entries suppressed during a pinch after commit', () => {
    const mounted = mountPager();
    try {
      expect(mounted.parent.querySelector('.fl-ps')).toBeNull();
      mounted.scroll.scrollTop = 500;
      const center = pagePoint(mounted.shells[1]!);
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerdown', { x: center.x - 80, y: center.y }, 1),
      );
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerdown', { x: center.x + 80, y: center.y }, 2),
      );
      HiddenPageObserver.latest?.emit([
        { target: mounted.shells[1], isIntersecting: true },
      ]);
      expect(mounted.parent.querySelector('.fl-ps')).toBeNull();
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerup', { x: center.x + 80, y: center.y }, 2),
      );
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerup', { x: center.x - 80, y: center.y }, 1),
      );

      expect(mounted.parent.querySelector('.fl-ps')).not.toBeNull();
    } finally {
      mounted.destroy();
    }
  });

  it.each([
    { startZoom: 7.9, zoom: 8, factor: 2 },
    { startZoom: 0.26, zoom: 0.25, factor: 0.5 },
  ])(
    'previews elastic zoom and settles exactly to $zoom',
    ({ startZoom, zoom, factor }) => {
      const frames = new FrameDriver();
      const mounted = mountPager({ frames });
      try {
        mounted.pager.setZoomFactor(startZoom);
        // toolbar setup animates; settle so the elastic pinch
        // starts from the committed bound.
        frames.settle();
        expect(mounted.pager.zoomFactor()).toBe(startZoom);
        mounted.scroll.scrollTop = 500;
        const center = pagePoint(mounted.shells[1]!);
        const radius = 80;
        mounted.scroll.dispatchEvent(
          pointerEvent('pointerdown', { x: center.x - radius, y: center.y }, 1),
        );
        mounted.scroll.dispatchEvent(
          pointerEvent('pointerdown', { x: center.x + radius, y: center.y }, 2),
        );
        mounted.scroll.dispatchEvent(
          pointerEvent(
            'pointermove',
            { x: center.x - radius * factor, y: center.y },
            1,
          ),
        );
        mounted.scroll.dispatchEvent(
          pointerEvent(
            'pointermove',
            { x: center.x + radius * factor, y: center.y },
            2,
          ),
        );
        const live = previewTransform(mounted.stack);
        expect(zoom === 8 ? live.scale > 1 : live.scale < 1).toBe(true);
        mounted.scroll.dispatchEvent(
          pointerEvent(
            'pointerup',
            { x: center.x + radius * factor, y: center.y },
            2,
          ),
        );
        mounted.scroll.dispatchEvent(
          pointerEvent(
            'pointerup',
            { x: center.x - radius * factor, y: center.y },
            1,
          ),
        );
        frames.settle();

        expect(mounted.pager.zoomFactor()).toBe(zoom);
        expect(mounted.stack.style.transform).toBe('');
      } finally {
        mounted.destroy();
      }
    },
  );

  it.each([0, 6])(
    'continues a fast gutter swipe with %ipx sideways drift',
    (drift) => {
      const frames = new FrameDriver();
      const mounted = mountPager({ frames });
      try {
        mounted.scroll.scrollTop = 500;
        mounted.scroll.dispatchEvent(
          pointerEvent('pointerdown', { x: 500, y: 400 }, 1),
        );
        frames.advance(16);
        mounted.scroll.dispatchEvent(
          pointerEvent('pointermove', { x: 500 + drift, y: 300 }, 1),
        );
        frames.advance(16);
        mounted.scroll.dispatchEvent(
          pointerEvent('pointerup', { x: 500 + drift, y: 300 }, 1),
        );
        const releasedAt = mounted.scroll.scrollTop;
        frames.advance(16);
        const firstStep = mounted.scroll.scrollTop - releasedAt;
        frames.advance(16);
        const secondStep = mounted.scroll.scrollTop - releasedAt - firstStep;

        expect(firstStep).toBeGreaterThan(0);
        expect(secondStep).toBeGreaterThan(0);
        expect(secondStep).toBeLessThan(firstStep);
        frames.settle();
      } finally {
        mounted.destroy();
      }
    },
  );

  it('rubber-bands horizontal edge excess and springs back without dirtying', () => {
    const frames = new FrameDriver();
    let dirtyCalls = 0;
    const mounted = mountPager({
      frames,
      markDirty: () => {
        dirtyCalls += 1;
      },
    });
    try {
      const canonicalBefore = JSON.stringify(mounted.model);
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerdown', { x: 300, y: 300 }, 1),
      );
      frames.advance(16);
      mounted.scroll.dispatchEvent(
        pointerEvent('pointermove', { x: 500, y: 300 }, 1),
      );
      expect(previewTransform(mounted.stack).x).toBeGreaterThan(0);
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerup', { x: 500, y: 300 }, 1),
      );
      const released = previewTransform(mounted.stack).x;
      frames.advance(16);
      expect(Math.abs(previewTransform(mounted.stack).x)).toBeLessThan(
        Math.abs(released),
      );
      frames.settle();

      expect(mounted.stack.style.transform).toBe('');
      expect(dirtyCalls).toBe(0);
      expect(JSON.stringify(mounted.model)).toBe(canonicalBefore);
    } finally {
      mounted.destroy();
    }
  });

  it('cancels pending navigation frames on destroy', () => {
    const frames = new FrameDriver();
    const mounted = mountPager({ frames });
    mounted.scroll.dispatchEvent(
      pointerEvent('pointerdown', { x: 300, y: 300 }, 1),
    );
    frames.advance(16);
    mounted.scroll.dispatchEvent(
      pointerEvent('pointermove', { x: 500, y: 300 }, 1),
    );
    mounted.scroll.dispatchEvent(
      pointerEvent('pointerup', { x: 500, y: 300 }, 1),
    );
    expect(frames.pending).toBe(1);

    mounted.destroy();
    expect(frames.pending).toBe(0);
  });

  it('interrupts a settle from its current visual position on new touch', () => {
    const frames = new FrameDriver();
    const mounted = mountPager({ frames });
    try {
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerdown', { x: 300, y: 300 }, 1),
      );
      frames.advance(16);
      mounted.scroll.dispatchEvent(
        pointerEvent('pointermove', { x: 500, y: 300 }, 1),
      );
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerup', { x: 500, y: 300 }, 1),
      );
      frames.advance(16);
      const settling = previewTransform(mounted.stack);

      mounted.scroll.dispatchEvent(
        pointerEvent('pointerdown', { x: 500, y: 300 }, 2),
      );

      expect(previewTransform(mounted.stack)).toEqual(settling);
      expect(frames.pending).toBe(0);
    } finally {
      mounted.destroy();
    }
  });

  it('clears transient navigation on pointercancel (true abort discards)', () => {
    const eventType = 'pointercancel' as const;
    const frames = new FrameDriver();
    const mounted = mountPager({ frames });
    try {
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerdown', { x: 300, y: 300 }, 1),
      );
      frames.advance(16);
      mounted.scroll.dispatchEvent(
        pointerEvent('pointermove', { x: 500, y: 300 }, 1),
      );
      expect(mounted.stack.style.transform).not.toBe('');

      mounted.scroll.dispatchEvent(
        pointerEvent(eventType, { x: 500, y: 300 }, 1),
      );

      expect(mounted.stack.style.transform).toBe('');
      expect(frames.pending).toBe(0);
    } finally {
      mounted.destroy();
    }
  });

  it('settles edge resistance immediately under reduced motion', () => {
    const frames = new FrameDriver();
    const mounted = mountPager({ frames, reducedMotion: true });
    try {
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerdown', { x: 300, y: 300 }, 1),
      );
      frames.advance(16);
      mounted.scroll.dispatchEvent(
        pointerEvent('pointermove', { x: 500, y: 300 }, 1),
      );
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerup', { x: 500, y: 300 }, 1),
      );

      expect(mounted.stack.style.transform).toBe('');
      expect(frames.pending).toBe(0);
    } finally {
      mounted.destroy();
    }
  });

  it('settles reduced-motion overzoom immediately at the legal maximum', () => {
    const frames = new FrameDriver();
    const mounted = mountPager({ frames, reducedMotion: true });
    try {
      mounted.pager.setZoomFactor(8);
      const center = pagePoint(mounted.shells[0]!);
      performPinch(mounted.scroll, center, 2, { x: 0, y: 0 });

      expect(mounted.pager.zoomFactor()).toBe(8);
      expect(frames.pending).toBe(0);
      expect(mounted.stack.style.transform).toBe('');
    } finally {
      mounted.destroy();
    }
  });

  it('cancels active decay before a settled toolbar zoom and preserves its center anchor', () => {
    const frames = new FrameDriver();
    const mounted = mountPager({ frames });
    try {
      mounted.scroll.scrollTop = 500;
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerdown', { x: 500, y: 400 }, 1),
      );
      frames.advance(16);
      mounted.scroll.dispatchEvent(
        pointerEvent('pointermove', { x: 500, y: 300 }, 1),
      );
      frames.advance(16);
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerup', { x: 500, y: 300 }, 1),
      );
      expect(frames.pending).toBe(1);
      const viewportCenter = { x: 600, y: 450 };
      const shell = mounted.shells[1]!;
      const before = shell.getBoundingClientRect();
      const anchor = {
        u: (viewportCenter.x - before.left) / before.width,
        v: (viewportCenter.y - before.top) / before.height,
      };

      mounted.pager.setZoomFactor(1.5);

      // toolbar zooms animate via the single zoom-spring (not
      // instant): one frame pending, preview transform published, then a
      // single settle commits with the viewport-center anchor preserved.
      expect(frames.pending).toBe(1);
      expect(mounted.stack.style.transform).toContain('scale(');
      frames.settle();

      const after = shell.getBoundingClientRect();
      expect(frames.pending).toBe(0);
      expect(
        distance(
          {
            x: after.left + after.width * anchor.u,
            y: after.top + after.height * anchor.v,
          },
          viewportCenter,
        ),
      ).toBeLessThanOrEqual(1);
    } finally {
      mounted.destroy();
    }
  });

  it('cancels active decay when embedded ctrl-wheel previews, committing on debounce idle', async () => {
    const frames = new FrameDriver();
    const mounted = mountPager({ frames });
    try {
      HiddenPageObserver.latest?.emit([
        { target: mounted.shells[1], isIntersecting: true },
      ]);
      mounted.scroll.scrollTop = 500;
      const pageCenter = pagePoint(mounted.shells[1]!);
      performPinch(mounted.scroll, pageCenter, 1, { x: 0, y: 0 });
      const canvas =
        mounted.parent.querySelector<HTMLCanvasElement>('.fl-ps canvas');
      expect(canvas).not.toBeNull();
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerdown', { x: 500, y: 400 }, 3),
      );
      frames.advance(16);
      mounted.scroll.dispatchEvent(
        pointerEvent('pointermove', { x: 500, y: 300 }, 3),
      );
      frames.advance(16);
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerup', { x: 500, y: 300 }, 3),
      );
      expect(frames.pending).toBe(1);

      canvas?.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          clientX: pageCenter.x,
          clientY: pageCenter.y,
          ctrlKey: true,
          deltaY: -100,
        }),
      );

      // ctrl-wheel cancels decay and previews (no per-tick commit).
      expect(frames.pending).toBe(0);
      expect(mounted.pager.zoomFactor()).toBe(1);
      expect(mounted.stack.style.transform).toContain('scale(');

      // Debounce idle commits once.
      await new Promise((resolve) => setTimeout(resolve, 200));
      frames.settle();
      expect(mounted.pager.zoomFactor()).toBeGreaterThan(1);
      expect(mounted.stack.style.transform).toBe('');
    } finally {
      mounted.destroy();
    }
  });

  it('retains active page calculation and focus through pinch commit', () => {
    const mounted = mountPager();
    try {
      mounted.scroll.scrollTop = 650;
      const root = mounted.parent.querySelector<HTMLElement>('.fl-nb');
      root?.focus();
      const center = pagePoint(mounted.shells[1]!);

      performPinch(mounted.scroll, center, 1.2, { x: 0, y: -10 });

      expect(mounted.pager.currentPageId()).toBe('page-2');
      expect(document.activeElement).toBe(root);
    } finally {
      mounted.destroy();
    }
  });

  it('cancels motion for source selection and safely releases captures on read-only', () => {
    const frames = new FrameDriver();
    const mounted = mountPager({ frames });
    const captured = new Set<number>();
    const released: number[] = [];
    mounted.scroll.setPointerCapture = (id) => captured.add(id);
    mounted.scroll.hasPointerCapture = (id) => captured.has(id);
    mounted.scroll.releasePointerCapture = (id) => {
      captured.delete(id);
      released.push(id);
    };
    try {
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerdown', { x: 500, y: 400 }, 1),
      );
      expect(captured.has(1)).toBe(true);
      mounted.pager.setReadOnly(true);
      expect(released).toEqual([1]);

      mounted.pager.setReadOnly(false);
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerdown', { x: 500, y: 400 }, 2),
      );
      frames.advance(16);
      mounted.scroll.dispatchEvent(
        pointerEvent('pointermove', { x: 500, y: 300 }, 2),
      );
      frames.advance(16);
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerup', { x: 500, y: 300 }, 2),
      );
      expect(frames.pending).toBe(1);
      mounted.pager.setSourceInteractionMode('source-select');
      expect(frames.pending).toBe(0);
      const textLayer = document.createElement('span');
      textLayer.className = 'fl-pdf-text-layer';
      mounted.scroll.appendChild(textLayer);
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerdown', { x: 500, y: 400 }, 4),
      );
      frames.advance(16);
      mounted.scroll.dispatchEvent(
        pointerEvent('pointermove', { x: 500, y: 300 }, 4),
      );
      frames.advance(16);
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerup', { x: 500, y: 300 }, 4),
      );
      expect(frames.pending).toBe(1);
      textLayer.dispatchEvent(
        pointerEvent('pointerdown', { x: 500, y: 300 }, 3),
      );

      expect(frames.pending).toBe(0);
      expect(captured.has(3)).toBe(false);
    } finally {
      mounted.destroy();
    }
  });

  it('settles a boundary-constrained anchor to legal scroll bounds', () => {
    const frames = new FrameDriver();
    const mounted = mountPager({ frames });
    try {
      const shell = mounted.shells[0]!;
      const start = pagePoint(shell);
      const desired = performPinch(mounted.scroll, start, 1, {
        x: 180,
        y: 0,
      });
      expect(distance(pagePoint(shell), desired)).toBeLessThanOrEqual(1);
      frames.settle();

      expect(mounted.scroll.scrollLeft).toBe(0);
      expect(mounted.stack.style.transform).toBe('');
      expect(distance(pagePoint(shell), desired)).toBeGreaterThan(1);
    } finally {
      mounted.destroy();
    }
  });

  it('keeps live pinch to transform writes with bounded geometry reads', () => {
    const mounted = mountPager();
    try {
      mounted.scroll.scrollTop = 500;
      const center = pagePoint(mounted.shells[1]!);
      let geometryReads = 0;
      for (const shell of mounted.shells) {
        const measure = shell.getBoundingClientRect.bind(shell);
        shell.getBoundingClientRect = () => {
          geometryReads += 1;
          return measure();
        };
      }
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerdown', { x: center.x - 80, y: center.y }, 1),
      );
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerdown', { x: center.x + 80, y: center.y }, 2),
      );
      const readsAtStart = geometryReads;
      const settledWidths = mounted.shells.map((shell) => shell.style.width);
      for (let step = 1; step <= 12; step += 1) {
        mounted.scroll.dispatchEvent(
          pointerEvent(
            'pointermove',
            { x: center.x + 80 + step * 4, y: center.y },
            2,
          ),
        );
      }

      expect(geometryReads).toBe(readsAtStart);
      expect(mounted.shells.map((shell) => shell.style.width)).toEqual(
        settledWidths,
      );
    } finally {
      mounted.destroy();
    }
  });

  it('hands pinch back to the remaining finger without stale pan movement', () => {
    const frames = new FrameDriver();
    const mounted = mountPager({ frames });
    try {
      mounted.scroll.scrollTop = 500;
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerdown', { x: 400, y: 400 }, 1),
      );
      frames.advance(16);
      mounted.scroll.dispatchEvent(
        pointerEvent('pointermove', { x: 400, y: 360 }, 1),
      );
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerdown', { x: 600, y: 360 }, 2),
      );
      mounted.scroll.dispatchEvent(
        pointerEvent('pointermove', { x: 620, y: 360 }, 2),
      );
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerup', { x: 620, y: 360 }, 2),
      );
      const handedOffAt = mounted.scroll.scrollTop;
      frames.advance(16);
      mounted.scroll.dispatchEvent(
        pointerEvent('pointermove', { x: 400, y: 330 }, 1),
      );

      expect(mounted.scroll.scrollTop).toBe(handedOffAt);
      expect(previewTransform(mounted.stack).y).toBeCloseTo(-30, 6);
      expect(frames.pending).toBe(0);
    } finally {
      mounted.destroy();
    }
  });

  it('splits background abort: pointercancel discards while lostpointercapture settles', () => {
    const cancelFrames = new FrameDriver();
    const cancelled = mountPager({ frames: cancelFrames });
    try {
      cancelled.scroll.dispatchEvent(
        pointerEvent('pointerdown', { x: 300, y: 300 }, 1),
      );
      cancelFrames.advance(16);
      cancelled.scroll.dispatchEvent(
        pointerEvent('pointermove', { x: 500, y: 300 }, 1),
      );
      expect(cancelled.stack.style.transform).not.toBe('');

      cancelled.scroll.dispatchEvent(
        pointerEvent('pointercancel', { x: 500, y: 300 }, 1),
      );

      // True abort discards: immediate clear, no fling, no commit.
      expect(cancelled.stack.style.transform).toBe('');
      expect(cancelFrames.pending).toBe(0);
    } finally {
      cancelled.destroy();
    }

    const lostFrames = new FrameDriver();
    const legalized = mountPager({ frames: lostFrames });
    try {
      legalized.scroll.dispatchEvent(
        pointerEvent('pointerdown', { x: 300, y: 300 }, 1),
      );
      lostFrames.advance(16);
      legalized.scroll.dispatchEvent(
        pointerEvent('pointermove', { x: 500, y: 300 }, 1),
      );
      expect(legalized.stack.style.transform).not.toBe('');

      legalized.scroll.dispatchEvent(
        pointerEvent('lostpointercapture', { x: 500, y: 300 }, 1),
      );

      // Legalize behaves like a release: the fast drag arms decay from the
      // current visual position instead of discarding it.
      expect(lostFrames.pending).toBe(1);
      lostFrames.settle();
      expect(legalized.stack.style.transform).toBe('');
      expect(lostFrames.pending).toBe(0);
    } finally {
      legalized.destroy();
    }
  });

  it('legalizes a background pinch on lostpointercapture (rebase then single commit) while pointercancel discards', () => {
    const cancelFrames = new FrameDriver();
    const cancelled = mountPager({ frames: cancelFrames });
    try {
      cancelled.scroll.scrollTop = 500;
      const shell = cancelled.shells[1]!;
      const center = pagePoint(shell);
      cancelled.scroll.dispatchEvent(
        pointerEvent('pointerdown', { x: center.x - 100, y: center.y }, 1),
      );
      cancelled.scroll.dispatchEvent(
        pointerEvent('pointerdown', { x: center.x + 100, y: center.y }, 2),
      );
      cancelled.scroll.dispatchEvent(
        pointerEvent('pointermove', { x: center.x + 140, y: center.y }, 2),
      );
      expect(cancelled.stack.style.transform).toContain('scale(');

      // Background pointercancel aborts the whole gesture, not one finger.
      cancelled.scroll.dispatchEvent(
        pointerEvent('pointercancel', { x: center.x + 140, y: center.y }, 2),
      );
      expect(cancelled.stack.style.transform).toBe('');
      expect(cancelled.pager.zoomFactor()).toBe(1);
      expect(cancelFrames.pending).toBe(0);
    } finally {
      cancelled.destroy();
    }

    const lostFrames = new FrameDriver();
    const legalized = mountPager({ frames: lostFrames });
    try {
      legalized.scroll.scrollTop = 500;
      const shell = legalized.shells[1]!;
      const center = pagePoint(shell);
      legalized.scroll.dispatchEvent(
        pointerEvent('pointerdown', { x: center.x - 100, y: center.y }, 1),
      );
      legalized.scroll.dispatchEvent(
        pointerEvent('pointerdown', { x: center.x + 100, y: center.y }, 2),
      );
      legalized.scroll.dispatchEvent(
        pointerEvent('pointermove', { x: center.x + 140, y: center.y }, 2),
      );
      legalized.scroll.dispatchEvent(
        pointerEvent('pointerdown', { x: center.x + 500, y: center.y }, 3),
      );
      const beforeLost = previewTransform(legalized.stack);

      // Losing one finger with two survivors rebases (like a lift), never
      // discards: the lowest-id survivor pair (2, 3) keeps the transform.
      legalized.scroll.dispatchEvent(
        pointerEvent(
          'lostpointercapture',
          { x: center.x - 100, y: center.y },
          1,
        ),
      );
      const afterRebase = previewTransform(legalized.stack);
      expect(afterRebase.x).toBeCloseTo(beforeLost.x, 6);
      expect(afterRebase.y).toBeCloseTo(beforeLost.y, 6);
      expect(afterRebase.scale).toBeCloseTo(beforeLost.scale, 6);

      // Capture loss retains the live preview until the last survivor lifts.
      legalized.scroll.dispatchEvent(
        pointerEvent(
          'lostpointercapture',
          { x: center.x + 140, y: center.y },
          2,
        ),
      );
      expect(legalized.pager.zoomFactor()).toBe(1);
      expect(previewTransform(legalized.stack).scale).toBeCloseTo(
        afterRebase.scale,
        6,
      );

      // The remaining finger settles like a release, then the stack is clean.
      legalized.scroll.dispatchEvent(
        pointerEvent(
          'lostpointercapture',
          { x: center.x + 500, y: center.y },
          3,
        ),
      );
      lostFrames.settle();
      expect(legalized.pager.zoomFactor()).toBeGreaterThan(1);
      expect(legalized.stack.style.transform).toBe('');
      expect(lostFrames.pending).toBe(0);
    } finally {
      legalized.destroy();
    }
  });

  it('replaces a lifted middle finger with the lowest-id survivor without a jump', () => {
    const frames = new FrameDriver();
    const mounted = mountPager({ frames });
    try {
      mounted.scroll.scrollTop = 500;
      const shell = mounted.shells[1]!;
      const center = pagePoint(shell);
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerdown', { x: center.x - 100, y: center.y }, 1),
      );
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerdown', { x: center.x + 100, y: center.y }, 2),
      );
      mounted.scroll.dispatchEvent(
        pointerEvent('pointermove', { x: center.x + 140, y: center.y }, 2),
      );
      // Third finger is ignored by the primary pair while both primaries live.
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerdown', { x: center.x + 500, y: center.y }, 3),
      );
      mounted.scroll.dispatchEvent(
        pointerEvent('pointermove', { x: center.x + 160, y: center.y }, 2),
      );
      const beforeLift = previewTransform(mounted.stack);

      // Lifting the middle id (2) deterministically promotes the lowest-id
      // survivor pair (1, 3): the published transform must not jump.
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerup', { x: center.x + 160, y: center.y }, 2),
      );
      const afterRebase = previewTransform(mounted.stack);
      expect(afterRebase.x).toBeCloseTo(beforeLift.x, 6);
      expect(afterRebase.y).toBeCloseTo(beforeLift.y, 6);
      expect(afterRebase.scale).toBeCloseTo(beforeLift.scale, 6);

      // The promoted pair keeps tracking: moving the replacement finger
      // widens the spread and grows the preview scale continuously.
      mounted.scroll.dispatchEvent(
        pointerEvent('pointermove', { x: center.x + 540, y: center.y }, 3),
      );
      const tracked = previewTransform(mounted.stack);
      expect(tracked.scale).toBeGreaterThan(afterRebase.scale);

      mounted.scroll.dispatchEvent(
        pointerEvent('pointerup', { x: center.x + 540, y: center.y }, 3),
      );
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerup', { x: center.x - 100, y: center.y }, 1),
      );
      frames.settle();
      expect(mounted.pager.zoomFactor()).toBeGreaterThan(1);
      expect(mounted.stack.style.transform).toBe('');
    } finally {
      mounted.destroy();
    }
  });

  it('holds the viewport-center anchor across a same-zoom relayout without drift', () => {
    const mounted = mountPager();
    try {
      mounted.scroll.scrollTop = 500;
      mounted.pager.setZoomFactor(1.5);
      const shell = mounted.shells[1]!;
      const scrollRect = mounted.scroll.getBoundingClientRect();
      const viewportCenter = {
        x: scrollRect.left + scrollRect.width / 2,
        y: scrollRect.top + scrollRect.height / 2,
      };
      const before = shell.getBoundingClientRect();
      const anchor = {
        u: (viewportCenter.x - before.left) / before.width,
        v: (viewportCenter.y - before.top) / before.height,
      };

      // Same-zoom commit re-runs capture/layout/resolve: the anchor content
      // point must stay under the viewport center within 1px (no drift).
      mounted.pager.setZoomFactor(1.5);

      const after = shell.getBoundingClientRect();
      expect(
        distance(
          {
            x: after.left + after.width * anchor.u,
            y: after.top + after.height * anchor.v,
          },
          viewportCenter,
        ),
      ).toBeLessThanOrEqual(1);
    } finally {
      mounted.destroy();
    }
  });

  it('holds the 1px anchor and decelerating decay at 120Hz timestamps', () => {
    const frames = new FrameDriver();
    const mounted = mountPager({ frames });
    try {
      mounted.pager.setZoomFactor(1);
      mounted.scroll.scrollTop = 500;
      const shell = mounted.shells[1]!;
      const start = pagePoint(shell);
      const finalCentroid = performPinch(mounted.scroll, start, 1.5, {
        x: 30,
        y: -20,
      });
      expect(distance(pagePoint(shell), finalCentroid)).toBeLessThanOrEqual(1);
      frames.settle();
      mounted.scroll.scrollTop = 500;

      mounted.scroll.dispatchEvent(
        pointerEvent('pointerdown', { x: 500, y: 400 }, 1),
      );
      frames.advance(8);
      mounted.scroll.dispatchEvent(
        pointerEvent('pointermove', { x: 500, y: 300 }, 1),
      );
      frames.advance(8);
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerup', { x: 500, y: 300 }, 1),
      );
      const releasedAt = mounted.scroll.scrollTop;
      frames.advance(8);
      const firstStep = mounted.scroll.scrollTop - releasedAt;
      frames.advance(8);
      const secondStep = mounted.scroll.scrollTop - releasedAt - firstStep;
      expect(firstStep).toBeGreaterThan(0);
      expect(secondStep).toBeGreaterThan(0);
      expect(secondStep).toBeLessThan(firstStep);
      frames.settle();
    } finally {
      mounted.destroy();
    }
  });

  it('hands a 1-2-1 sequence back to pan without a scroll jump', () => {
    const frames = new FrameDriver();
    const mounted = mountPager({ frames });
    try {
      mounted.scroll.scrollTop = 500;
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerdown', { x: 400, y: 400 }, 1),
      );
      frames.advance(16);
      mounted.scroll.dispatchEvent(
        pointerEvent('pointermove', { x: 400, y: 360 }, 1),
      );
      const panningAt = mounted.scroll.scrollTop;
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerdown', { x: 600, y: 360 }, 2),
      );
      mounted.scroll.dispatchEvent(
        pointerEvent('pointermove', { x: 620, y: 360 }, 2),
      );
      const pinching = previewTransform(mounted.stack);
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerup', { x: 620, y: 360 }, 2),
      );
      // The survivor moves the live preview; layout commits on final lift.
      const committedTop = mounted.scroll.scrollTop;
      frames.advance(16);
      mounted.scroll.dispatchEvent(
        pointerEvent('pointermove', { x: 400, y: 330 }, 1),
      );
      expect(mounted.scroll.scrollTop).toBeGreaterThanOrEqual(committedTop);
      expect(mounted.scroll.scrollTop).toBe(panningAt);
      expect(previewTransform(mounted.stack).y).toBeCloseTo(-30, 6);
      expect(Number.isFinite(pinching.scale)).toBe(true);
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerup', { x: 400, y: 330 }, 1),
      );
      frames.settle();
      expect(mounted.stack.style.transform).toBe('');
    } finally {
      mounted.destroy();
    }
  });

  it('ignores non-finite touch coordinates without poisoning scroll or transform', () => {
    const frames = new FrameDriver();
    const mounted = mountPager({ frames });
    try {
      mounted.scroll.scrollTop = 500;
      const beforeTop = mounted.scroll.scrollTop;

      const nanDown = pointerEvent('pointerdown', { x: 500, y: 400 }, 7);
      Object.defineProperty(nanDown, 'clientX', { value: Number.NaN });
      Object.defineProperty(nanDown, 'clientY', { value: Number.NaN });
      mounted.scroll.dispatchEvent(nanDown);
      expect(mounted.stack.style.transform).toBe('');
      expect(Number.isFinite(mounted.scroll.scrollTop)).toBe(true);
      expect(mounted.scroll.scrollTop).toBe(beforeTop);
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerup', { x: 500, y: 400 }, 7),
      );

      mounted.scroll.dispatchEvent(
        pointerEvent('pointerdown', { x: 500, y: 400 }, 8),
      );
      frames.advance(16);
      const nanMove = pointerEvent('pointermove', { x: 500, y: 300 }, 8);
      Object.defineProperty(nanMove, 'clientX', { value: Number.NaN });
      Object.defineProperty(nanMove, 'clientY', { value: Number.NaN });
      mounted.scroll.dispatchEvent(nanMove);
      expect(mounted.stack.style.transform).toBe('');
      expect(Number.isFinite(mounted.scroll.scrollTop)).toBe(true);
      expect(mounted.scroll.scrollTop).toBe(beforeTop);
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerup', { x: 500, y: 400 }, 8),
      );
      expect(Number.isFinite(mounted.scroll.scrollTop)).toBe(true);
      expect(frames.pending).toBe(0);
    } finally {
      mounted.destroy();
    }
  });
});

describe('embedded delegation parity (canvas-driven)', () => {
  let previousIntersectionObserver: typeof IntersectionObserver | undefined;

  beforeEach(() => {
    previousIntersectionObserver = globalThis.IntersectionObserver;
    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      value: HiddenPageObserver,
    });
  });

  afterEach(() => {
    if (previousIntersectionObserver === undefined) {
      delete (globalThis as { IntersectionObserver?: unknown })
        .IntersectionObserver;
    } else {
      Object.defineProperty(globalThis, 'IntersectionObserver', {
        configurable: true,
        value: previousIntersectionObserver,
      });
    }
    document.body.replaceChildren();
  });

  function mountEmbedded(
    options: {
      readonly frames?: FrameDriver;
      readonly reducedMotion?: boolean;
      readonly markDirty?: () => void;
    } = {},
  ): MountedPager & { canvas: HTMLCanvasElement } {
    const mounted = mountPager(options);
    HiddenPageObserver.latest?.emit(
      mounted.shells.map((shell) => ({
        target: shell,
        isIntersecting: true,
      })),
    );
    const canvas =
      mounted.parent.querySelector<HTMLCanvasElement>('.fl-ps canvas');
    if (canvas === null) {
      mounted.destroy();
      throw new Error('embedded page canvas failed to mount');
    }
    // Canvas-local view equals client in jsdom (zero rect): pin it so
    // controller view math stays deterministic.
    canvas.getBoundingClientRect = () =>
      rect(0, 0, VIEWPORT.width, VIEWPORT.height);
    return { ...mounted, canvas };
  }

  function penEvent(
    type: string,
    point: { readonly x: number; readonly y: number },
    pointerId: number,
  ): Event {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: point.x,
      clientY: point.y,
      button: 0,
      buttons: type === 'pointerup' ? 0 : 1,
    });
    Object.defineProperty(event, 'pointerId', { value: pointerId });
    Object.defineProperty(event, 'pointerType', { value: 'pen' });
    Object.defineProperty(event, 'pressure', { value: 0.5 });
    return event;
  }

  it('forwards pen drag panning from a view-mode page to the pager', () => {
    const frames = new FrameDriver();
    let dirtyCalls = 0;
    const mounted = mountEmbedded({
      frames,
      markDirty: () => {
        dirtyCalls += 1;
      },
    });
    try {
      mounted.scroll.scrollTop = 500;
      mounted.pager.setReadOnly(true);
      const canonicalBefore = JSON.stringify(mounted.model);
      mounted.canvas.dispatchEvent(
        penEvent('pointerdown', { x: 300, y: 300 }, 50),
      );
      mounted.canvas.dispatchEvent(
        penEvent('pointermove', { x: 500, y: 300 }, 50),
      );
      expect(previewTransform(mounted.stack).x).toBeGreaterThan(0);
      mounted.canvas.dispatchEvent(
        penEvent('pointerup', { x: 500, y: 300 }, 50),
      );
      frames.settle();
      expect(JSON.stringify(mounted.model)).toBe(canonicalBefore);
      expect(dirtyCalls).toBe(0);
    } finally {
      mounted.destroy();
    }
  });

  it('fails without the fix: embedded pan previews transform-only with zero layout per move and forwards both axes', () => {
    const frames = new FrameDriver();
    let dirtyCalls = 0;
    const mounted = mountEmbedded({
      frames,
      markDirty: () => {
        dirtyCalls += 1;
      },
    });
    try {
      mounted.scroll.scrollTop = 500;
      const widthsBefore = mounted.shells.map((shell) => shell.style.width);
      const zoomBefore = mounted.pager.zoomFactor();
      let geometryReads = 0;
      for (const shell of mounted.shells) {
        const measure = shell.getBoundingClientRect.bind(shell);
        shell.getBoundingClientRect = () => {
          geometryReads += 1;
          return measure();
        };
      }
      const readsAtStart = geometryReads;

      // Horizontal drag at the left edge: native scroll cannot consume X
      // (already at 0), so the shared rubber-band path must publish a
      // transform — proving the X-drop fix (old code used delta.y only).
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerdown', { x: 300, y: 300 }, 11),
      );
      frames.advance(16);
      mounted.canvas.dispatchEvent(
        pointerEvent('pointermove', { x: 500, y: 300 }, 11),
      );

      expect(previewTransform(mounted.stack).x).toBeGreaterThan(0);
      // Zero layout per move: widths, settled zoom, and dirty untouched.
      expect(mounted.shells.map((shell) => shell.style.width)).toEqual(
        widthsBefore,
      );
      expect(mounted.pager.zoomFactor()).toBe(zoomBefore);
      expect(dirtyCalls).toBe(0);
      expect(geometryReads).toBe(readsAtStart);

      mounted.canvas.dispatchEvent(
        pointerEvent('pointerup', { x: 500, y: 300 }, 11),
      );
      frames.settle();
      expect(mounted.stack.style.transform).toBe('');
      expect(dirtyCalls).toBe(0);
    } finally {
      mounted.destroy();
    }
  });

  it('tracks every finger move when the embedded canvas moves with the scroll', () => {
    const frames = new FrameDriver();
    const mounted = mountEmbedded({ frames });
    try {
      mounted.scroll.scrollTop = 500;
      // Unlike a fixed jsdom rect, the real canvas moves with its scroll owner.
      mounted.canvas.getBoundingClientRect = () =>
        rect(
          0,
          500 - mounted.scroll.scrollTop,
          VIEWPORT.width,
          VIEWPORT.height,
        );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerdown', { x: 500, y: 400 }, 12),
      );
      for (let step = 1; step <= 12; step += 1) {
        frames.advance(16);
        mounted.canvas.dispatchEvent(
          pointerEvent('pointermove', { x: 500, y: 400 - step * 20 }, 12),
        );
        expect(mounted.scroll.scrollTop).toBe(500 + step * 20);
      }
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerup', { x: 500, y: 160 }, 12),
      );
      expect(frames.pending).toBe(1);
      frames.settle();
    } finally {
      mounted.destroy();
    }
  });

  it('keeps pinch and its surviving finger in screen space while the page transforms', () => {
    const frames = new FrameDriver();
    const mounted = mountEmbedded({ frames });
    try {
      mounted.scroll.scrollTop = 500;
      mounted.canvas.getBoundingClientRect = () => {
        const preview = parsePreviewTransform(
          mounted.stack.style.transform,
        ) ?? { x: 0, y: 0 };
        return rect(preview.x, preview.y, VIEWPORT.width, VIEWPORT.height);
      };
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerdown', { x: 400, y: 400 }, 11),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerdown', { x: 600, y: 400 }, 12),
      );
      for (let step = 1; step <= 4; step += 1) {
        frames.advance(16);
        for (const [id, x] of [
          [11, 400],
          [12, 600],
        ] as const) {
          mounted.canvas.dispatchEvent(
            pointerEvent('pointermove', { x, y: 400 - step * 20 }, id),
          );
        }
        expect(previewTransform(mounted.stack).y).toBeCloseTo(-step * 20, 5);
        expect(previewTransform(mounted.stack).scale).toBeCloseTo(1, 5);
      }
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerup', { x: 600, y: 320 }, 12),
      );
      for (let step = 1; step <= 4; step += 1) {
        mounted.canvas.dispatchEvent(
          pointerEvent('pointermove', { x: 400, y: 320 - step * 20 }, 11),
        );
        expect(previewTransform(mounted.stack).y).toBeCloseTo(
          -80 - step * 20,
          5,
        );
      }
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerup', { x: 400, y: 240 }, 11),
      );
      frames.settle();
      expect(mounted.stack.style.transform).toBe('');
    } finally {
      mounted.destroy();
    }
  });

  it.each([0, 6])(
    'keeps vertical momentum after a fast swipe with %ipx sideways drift',
    (drift) => {
      const frames = new FrameDriver();
      const mounted = mountEmbedded({ frames });
      try {
        mounted.scroll.scrollTop = 500;
        mounted.canvas.dispatchEvent(
          pointerEvent('pointerdown', { x: 500, y: 400 }, 12),
        );
        frames.advance(16);
        mounted.canvas.dispatchEvent(
          pointerEvent('pointermove', { x: 500 + drift, y: 300 }, 12),
        );
        frames.advance(16);
        mounted.canvas.dispatchEvent(
          pointerEvent('pointerup', { x: 500 + drift, y: 300 }, 12),
        );
        expect(frames.pending).toBe(1);
        const releasedAt = mounted.scroll.scrollTop;
        frames.advance(16);
        const firstStep = mounted.scroll.scrollTop - releasedAt;
        frames.advance(16);
        const secondStep = mounted.scroll.scrollTop - releasedAt - firstStep;
        expect(firstStep).toBeGreaterThan(0);
        expect(secondStep).toBeGreaterThan(0);
        expect(secondStep).toBeLessThan(firstStep);
        frames.settle();
        expect(mounted.stack.style.transform).toBe('');
      } finally {
        mounted.destroy();
      }
    },
  );

  it('commits an embedded pinch once with a 1px anchor, suppressed IO, and zero dirty', () => {
    const frames = new FrameDriver();
    let dirtyCalls = 0;
    const mounted = mountEmbedded({
      frames,
      markDirty: () => {
        dirtyCalls += 1;
      },
    });
    try {
      mounted.scroll.scrollTop = 500;
      const shell = mounted.shells[1]!;
      const shellRect = shell.getBoundingClientRect();
      // Canvas-local centroid that maps onto the page anchor: the adapter
      // converts via host rect, so drive from client coords directly.
      const clientCenter = pagePoint(shell);
      const hostRect = shell.getBoundingClientRect();
      void hostRect;
      void shellRect;
      const canvasRect = mounted.canvas.getBoundingClientRect();
      const toCanvas = (client: { x: number; y: number }) => ({
        // Page shells and canvases share the jsdom zero-rect except the
        // mocked shells above; the controller subtracts the canvas rect.
        x: client.x - canvasRect.left,
        y: client.y - canvasRect.top,
      });
      const start = toCanvas(clientCenter);
      const radius = 80;
      const widthsBefore = mounted.shells.map((shell) => shell.style.width);
      const mountedBefore = mounted.parent.querySelectorAll('.fl-ps').length;
      expect(mountedBefore).toBeGreaterThan(0);

      mounted.canvas.dispatchEvent(
        pointerEvent('pointerdown', { x: start.x - radius, y: start.y }, 21),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerdown', { x: start.x + radius, y: start.y }, 22),
      );
      // Suppress a visibility entry mid-preview: IO must not remount.
      HiddenPageObserver.latest?.emit([
        { target: mounted.shells[2], isIntersecting: true },
      ]);
      const mountedDuringPreview =
        mounted.parent.querySelectorAll('.fl-ps').length;
      mounted.canvas.dispatchEvent(
        pointerEvent(
          'pointermove',
          { x: start.x - radius * 1.5, y: start.y },
          21,
        ),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent(
          'pointermove',
          { x: start.x + radius * 1.5, y: start.y },
          22,
        ),
      );

      const live = previewTransform(mounted.stack);
      expect(live.scale).toBeGreaterThan(1);
      // Single-commit: no layout until release.
      expect(mounted.shells.map((s) => s.style.width)).toEqual(widthsBefore);
      expect(mounted.pager.zoomFactor()).toBe(1);
      expect(mounted.parent.querySelectorAll('.fl-ps').length).toBe(
        mountedDuringPreview,
      );

      mounted.canvas.dispatchEvent(
        pointerEvent(
          'pointerup',
          { x: start.x + radius * 1.5, y: start.y },
          22,
        ),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent(
          'pointerup',
          { x: start.x - radius * 1.5, y: start.y },
          21,
        ),
      );
      frames.settle();

      expect(mounted.pager.zoomFactor()).toBeGreaterThan(1);
      expect(mounted.stack.style.transform).toBe('');
      expect(dirtyCalls).toBe(0);
      // Anchor under the fingers within 1px after the single commit.
      const finalCentroid = {
        x: clientCenter.x,
        y: clientCenter.y,
      };
      expect(distance(pagePoint(shell), finalCentroid)).toBeLessThanOrEqual(
        1.6,
      );
    } finally {
      mounted.destroy();
    }
  });

  it('leaves plain wheel native while cancelling synthetic motion (no double-scroll)', () => {
    const frames = new FrameDriver();
    const mounted = mountEmbedded({ frames });
    try {
      HiddenPageObserver.latest?.emit([
        { target: mounted.shells[1], isIntersecting: true },
      ]);
      mounted.scroll.scrollTop = 500;
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerdown', { x: 500, y: 400 }, 31),
      );
      frames.advance(16);
      mounted.canvas.dispatchEvent(
        pointerEvent('pointermove', { x: 500, y: 300 }, 31),
      );
      frames.advance(16);
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerup', { x: 500, y: 300 }, 31),
      );
      expect(frames.pending).toBe(1);

      const plain = new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaY: 80,
      });
      const topBefore = mounted.scroll.scrollTop;
      mounted.canvas.dispatchEvent(plain);

      expect(plain.defaultPrevented).toBe(false);
      expect(frames.pending).toBe(0);
      expect(mounted.pager.zoomFactor()).toBe(1);
      expect(mounted.stack.style.transform).toBe('');
      expect(mounted.scroll.scrollTop).toBe(topBefore);
    } finally {
      mounted.destroy();
    }
  });

  it('preserves focus through embedded pinch and respects readonly/select', () => {
    const frames = new FrameDriver();
    const mounted = mountEmbedded({ frames });
    try {
      mounted.scroll.scrollTop = 500;
      const root = mounted.parent.querySelector<HTMLElement>('.fl-nb');
      root?.focus();
      const canvasRect = mounted.canvas.getBoundingClientRect();
      const clientCenter = pagePoint(mounted.shells[1]!);
      const toCanvas = (client: { x: number; y: number }) => ({
        x: client.x - canvasRect.left,
        y: client.y - canvasRect.top,
      });
      const start = toCanvas(clientCenter);
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerdown', { x: start.x - 80, y: start.y }, 41),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerdown', { x: start.x + 80, y: start.y }, 42),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointermove', { x: start.x - 96, y: start.y }, 41),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointermove', { x: start.x + 96, y: start.y }, 42),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerup', { x: start.x + 96, y: start.y }, 42),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerup', { x: start.x - 96, y: start.y }, 41),
      );
      frames.settle();
      expect(mounted.pager.currentPageId()).toBe('page-2');
      expect(document.activeElement).toBe(root);

      // Readonly cancels transient navigation and never commits.
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerdown', { x: 300, y: 300 }, 43),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointermove', { x: 500, y: 300 }, 43),
      );
      mounted.pager.setReadOnly(true);
      expect(mounted.stack.style.transform).toBe('');
      expect(frames.pending).toBe(0);
      mounted.pager.setReadOnly(false);

      // Source-select ignores embedded navigation.
      mounted.pager.setSourceInteractionMode('source-select');
      const topBefore = mounted.scroll.scrollTop;
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerdown', { x: 300, y: 300 }, 44),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointermove', { x: 300, y: 200 }, 44),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerup', { x: 300, y: 200 }, 44),
      );
      frames.settle();
      expect(mounted.stack.style.transform).toBe('');
      expect(mounted.scroll.scrollTop).toBe(topBefore);
      expect(frames.pending).toBe(0);
    } finally {
      mounted.destroy();
    }
  });

  it('settles embedded gestures immediately under reduced motion', () => {
    const frames = new FrameDriver();
    const mounted = mountEmbedded({ frames, reducedMotion: true });
    try {
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerdown', { x: 300, y: 300 }, 51),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointermove', { x: 500, y: 300 }, 51),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerup', { x: 500, y: 300 }, 51),
      );
      expect(mounted.stack.style.transform).toBe('');
      expect(frames.pending).toBe(0);

      mounted.pager.setZoomFactor(7.9);
      const canvasRect = mounted.canvas.getBoundingClientRect();
      const clientCenter = pagePoint(mounted.shells[0]!);
      const start = {
        x: clientCenter.x - canvasRect.left,
        y: clientCenter.y - canvasRect.top,
      };
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerdown', { x: start.x - 80, y: start.y }, 52),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerdown', { x: start.x + 80, y: start.y }, 53),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointermove', { x: start.x - 160, y: start.y }, 52),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointermove', { x: start.x + 160, y: start.y }, 53),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerup', { x: start.x + 160, y: start.y }, 53),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerup', { x: start.x - 160, y: start.y }, 52),
      );
      expect(mounted.pager.zoomFactor()).toBe(8);
      expect(frames.pending).toBe(0);
      expect(mounted.stack.style.transform).toBe('');
    } finally {
      mounted.destroy();
    }
  });

  it('tracks an embedded pinch 2->1 survivor drag and commits its anchor within 1px', () => {
    const frames = new FrameDriver();
    const mounted = mountEmbedded({ frames });
    try {
      mounted.scroll.scrollTop = 500;
      const shell = mounted.shells[1]!;
      const clientCenter = pagePoint(shell);
      const canvasRect = mounted.canvas.getBoundingClientRect();
      const start = {
        x: clientCenter.x - canvasRect.left,
        y: clientCenter.y - canvasRect.top,
      };
      const radius = 80;
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerdown', { x: start.x - radius, y: start.y }, 61),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerdown', { x: start.x + radius, y: start.y }, 62),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent(
          'pointermove',
          { x: start.x - radius * 1.5, y: start.y },
          61,
        ),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent(
          'pointermove',
          { x: start.x + radius * 1.5, y: start.y },
          62,
        ),
      );
      const live = previewTransform(mounted.stack);
      expect(live.scale).toBeGreaterThan(1);
      // Lift one finger; survivor remains — no commit yet, preview stays open.
      mounted.canvas.dispatchEvent(
        pointerEvent(
          'pointerup',
          { x: start.x + radius * 1.5, y: start.y },
          62,
        ),
      );
      expect(mounted.pager.zoomFactor()).toBe(1);
      expect(mounted.stack.style.transform).toContain('scale(');
      // Drag survivor 50px: preview.translation must track (never frozen).
      mounted.canvas.dispatchEvent(
        pointerEvent(
          'pointermove',
          { x: start.x - radius * 1.5 + 50, y: start.y },
          61,
        ),
      );
      const tracked = previewTransform(mounted.stack);
      expect(tracked.x).toBeCloseTo(live.x + 50, 6);
      expect(tracked.scale).toBeCloseTo(live.scale, 6);
      // Last lift commits once; anchor under the shifted centroid within 1px.
      mounted.canvas.dispatchEvent(
        pointerEvent(
          'pointerup',
          { x: start.x - radius * 1.5 + 50, y: start.y },
          61,
        ),
      );
      frames.settle();
      expect(mounted.pager.zoomFactor()).toBeGreaterThan(1);
      expect(mounted.stack.style.transform).toBe('');
      const finalCentroid = {
        x: clientCenter.x + 50,
        y: clientCenter.y,
      };
      expect(distance(pagePoint(shell), finalCentroid)).toBeLessThanOrEqual(1);
    } finally {
      mounted.destroy();
    }
  });

  it('discards IO suppressed during a preview on cancel and keeps the next pinch clean', () => {
    const frames = new FrameDriver();
    const mounted = mountEmbedded({ frames });
    try {
      mounted.scroll.scrollTop = 500;
      const before = mounted.parent.querySelectorAll('.fl-ps').length;
      expect(before).toBeGreaterThan(0);
      const clientCenter = pagePoint(mounted.shells[1]!);
      const canvasRect = mounted.canvas.getBoundingClientRect();
      const start = {
        x: clientCenter.x - canvasRect.left,
        y: clientCenter.y - canvasRect.top,
      };
      // First preview: open, suppress an entry, then cancel both fingers.
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerdown', { x: start.x - 80, y: start.y }, 71),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerdown', { x: start.x + 80, y: start.y }, 72),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointermove', { x: start.x - 96, y: start.y }, 71),
      );
      expect(mounted.stack.style.transform).toContain('scale(');
      HiddenPageObserver.latest?.emit([
        { target: mounted.shells[2], isIntersecting: false },
      ]);
      expect(mounted.parent.querySelectorAll('.fl-ps').length).toBe(before);
      // A true cancel aborts the notebook gesture, including the survivor.
      mounted.canvas.dispatchEvent(
        pointerEvent('pointercancel', { x: start.x - 96, y: start.y }, 71),
      );
      expect(mounted.stack.style.transform).toBe('');
      mounted.canvas.dispatchEvent(
        pointerEvent('pointercancel', { x: start.x + 80, y: start.y }, 72),
      );
      expect(mounted.stack.style.transform).toBe('');
      expect(mounted.pager.zoomFactor()).toBe(1);
      expect(mounted.parent.querySelectorAll('.fl-ps').length).toBe(before);
      // Next pinch must be clean: fresh preview, suppressed entries from the
      // cancelled pinch never apply, single commit reconciles only fresh IO.
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerdown', { x: start.x - 80, y: start.y }, 73),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerdown', { x: start.x + 80, y: start.y }, 74),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointermove', { x: start.x - 96, y: start.y }, 73),
      );
      expect(mounted.stack.style.transform).toContain('scale(');
      HiddenPageObserver.latest?.emit([
        { target: mounted.shells[1], isIntersecting: true },
      ]);
      expect(mounted.parent.querySelectorAll('.fl-ps').length).toBe(before);
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerup', { x: start.x + 80, y: start.y }, 74),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointermove', { x: start.x - 96, y: start.y }, 73),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerup', { x: start.x - 96, y: start.y }, 73),
      );
      frames.settle();
      expect(mounted.stack.style.transform).toBe('');
      expect(mounted.parent.querySelectorAll('.fl-ps').length).toBe(before);
    } finally {
      mounted.destroy();
    }
  });

  it('clears suppressed IO on destroy without retaining detached shells', () => {
    const frames = new FrameDriver();
    const mounted = mountEmbedded({ frames });
    try {
      const clientCenter = pagePoint(mounted.shells[1]!);
      const canvasRect = mounted.canvas.getBoundingClientRect();
      const start = {
        x: clientCenter.x - canvasRect.left,
        y: clientCenter.y - canvasRect.top,
      };
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerdown', { x: start.x - 80, y: start.y }, 81),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerdown', { x: start.x + 80, y: start.y }, 82),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointermove', { x: start.x - 96, y: start.y }, 81),
      );
      expect(mounted.stack.style.transform).toContain('scale(');
      HiddenPageObserver.latest?.emit([
        { target: mounted.shells[0], isIntersecting: false },
      ]);
      expect(() => mounted.destroy()).not.toThrow();
      expect(mounted.parent.isConnected).toBe(false);
    } finally {
      document.body.replaceChildren();
    }
  });

  it('keeps a single motion frame when wheel interrupts a zoom-spring', async () => {
    const frames = new FrameDriver();
    const mounted = mountEmbedded({ frames });
    try {
      mounted.pager.setZoomFactor(7.9);
      // toolbar setup animates; settle so the wheel overzoom
      // starts just inside the max so the first crossing stays elastic.
      frames.settle();
      expect(mounted.pager.zoomFactor()).toBe(7.9);
      const clientCenter = pagePoint(mounted.shells[0]!);
      const wheel = (deltaY: number): void => {
        mounted.canvas.dispatchEvent(
          new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            clientX: clientCenter.x,
            clientY: clientCenter.y,
            ctrlKey: true,
            deltaY,
          }),
        );
      };
      // The first crossing is elastic; a settled saturated input is a no-op.
      wheel(-100);
      expect(mounted.stack.style.transform).toContain('scale(');
      expect(frames.pending).toBe(0);
      await new Promise((resolve) => setTimeout(resolve, 200));
      // Spring armed (single frame) for the elastic settle back to 8.
      expect(frames.pending).toBe(1);
      // Interrupting wheel during the spring must not fork a second frame:
      // the owned step cancels the spring first, then writes the preview.
      wheel(-40);
      expect(frames.pending).toBeLessThanOrEqual(1);
      expect(mounted.stack.style.transform).toContain('scale(');
      await new Promise((resolve) => setTimeout(resolve, 200));
      frames.settle();
      expect(mounted.pager.zoomFactor()).toBe(8);
      expect(mounted.stack.style.transform).toBe('');
      expect(frames.pending).toBe(0);
    } finally {
      mounted.destroy();
    }
  });

  it('cancels gutter decay on plain wheel without double-scroll', () => {
    const frames = new FrameDriver();
    const mounted = mountPager({ frames });
    try {
      mounted.scroll.scrollTop = 500;
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerdown', { x: 500, y: 400 }, 91),
      );
      frames.advance(16);
      mounted.scroll.dispatchEvent(
        pointerEvent('pointermove', { x: 500, y: 300 }, 91),
      );
      frames.advance(16);
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerup', { x: 500, y: 300 }, 91),
      );
      expect(frames.pending).toBe(1);
      const topBefore = mounted.scroll.scrollTop;
      const plain = new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaY: 80,
      });
      mounted.scroll.dispatchEvent(plain);
      // Passive gutter listener: never prevents native scroll, cancels decay.
      expect(plain.defaultPrevented).toBe(false);
      expect(frames.pending).toBe(0);
      expect(mounted.scroll.scrollTop).toBe(topBefore);
      expect(mounted.stack.style.transform).toBe('');
    } finally {
      mounted.destroy();
    }
  });

  it('releases embedded pinch ownership on wheel commit so a later background pinch is not stolen', async () => {
    const frames = new FrameDriver();
    const mounted = mountEmbedded({ frames });
    try {
      mounted.scroll.scrollTop = 500;
      const wheelCenter = pagePoint(mounted.shells[1]!);
      // Wheel-originated embedded preview, committed via debounce idle.
      mounted.canvas.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          clientX: wheelCenter.x,
          clientY: wheelCenter.y,
          ctrlKey: true,
          deltaY: -100,
        }),
      );
      expect(mounted.stack.style.transform).toContain('scale(');
      await new Promise((resolve) => setTimeout(resolve, 200));
      frames.settle();
      const committedZoom = mounted.pager.zoomFactor();
      expect(committedZoom).toBeGreaterThan(1);
      expect(mounted.stack.style.transform).toBe('');

      // Background pinch opens the single preview slot (embedded owns nothing).
      const clientCenter = pagePoint(mounted.shells[1]!);
      mounted.scroll.dispatchEvent(
        pointerEvent(
          'pointerdown',
          { x: clientCenter.x - 80, y: clientCenter.y },
          71,
        ),
      );
      mounted.scroll.dispatchEvent(
        pointerEvent(
          'pointerdown',
          { x: clientCenter.x + 80, y: clientCenter.y },
          72,
        ),
      );
      mounted.scroll.dispatchEvent(
        pointerEvent(
          'pointermove',
          { x: clientCenter.x - 96, y: clientCenter.y },
          71,
        ),
      );
      const live = previewTransform(mounted.stack);

      // Embedded single-finger pan while the background preview is open must
      // be ignored — stale ownership would steal the preview and shift it.
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerdown', { x: 300, y: 300 }, 73),
      );
      frames.advance(16);
      mounted.canvas.dispatchEvent(
        pointerEvent('pointermove', { x: 350, y: 300 }, 73),
      );
      const afterPan = previewTransform(mounted.stack);
      expect(afterPan.x).toBeCloseTo(live.x, 6);
      expect(afterPan.y).toBeCloseTo(live.y, 6);
      expect(afterPan.scale).toBeCloseTo(live.scale, 6);
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerup', { x: 350, y: 300 }, 73),
      );

      // Background pinch still commits once through the shared path.
      mounted.scroll.dispatchEvent(
        pointerEvent(
          'pointerup',
          { x: clientCenter.x + 80, y: clientCenter.y },
          72,
        ),
      );
      mounted.scroll.dispatchEvent(
        pointerEvent(
          'pointerup',
          { x: clientCenter.x - 96, y: clientCenter.y },
          71,
        ),
      );
      frames.settle();
      expect(mounted.pager.zoomFactor()).toBeGreaterThan(committedZoom);
      expect(mounted.stack.style.transform).toBe('');
    } finally {
      mounted.destroy();
    }
  });

  it('preserves an embedded touch pinch across a plain-wheel tick and commits once', () => {
    const frames = new FrameDriver();
    const mounted = mountEmbedded({ frames });
    try {
      mounted.scroll.scrollTop = 500;
      const clientCenter = pagePoint(mounted.shells[1]!);
      const canvasRect = mounted.canvas.getBoundingClientRect();
      const start = {
        x: clientCenter.x - canvasRect.left,
        y: clientCenter.y - canvasRect.top,
      };
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerdown', { x: start.x - 80, y: start.y }, 81),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerdown', { x: start.x + 80, y: start.y }, 82),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointermove', { x: start.x - 96, y: start.y }, 81),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointermove', { x: start.x + 96, y: start.y }, 82),
      );
      expect(mounted.stack.style.transform).toContain('scale(');

      // Plain-wheel tick mid-pinch: stays native and must never discard the
      // active preview (gutter parity) — and commits nothing yet either.
      const plain = new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaY: 80,
      });
      mounted.canvas.dispatchEvent(plain);
      expect(plain.defaultPrevented).toBe(false);
      expect(mounted.stack.style.transform).toContain('scale(');
      expect(mounted.pager.zoomFactor()).toBe(1);

      // Release commits exactly once through the shared path.
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerup', { x: start.x + 96, y: start.y }, 82),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerup', { x: start.x - 96, y: start.y }, 81),
      );
      frames.settle();
      expect(mounted.pager.zoomFactor()).toBeGreaterThan(1);
      expect(mounted.stack.style.transform).toBe('');
    } finally {
      mounted.destroy();
    }
  });

  it('preserves a wheel preview across a plain-wheel tick and commits on debounce idle', async () => {
    const frames = new FrameDriver();
    const mounted = mountEmbedded({ frames });
    try {
      mounted.scroll.scrollTop = 500;
      const clientCenter = pagePoint(mounted.shells[1]!);
      mounted.canvas.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          clientX: clientCenter.x,
          clientY: clientCenter.y,
          ctrlKey: true,
          deltaY: -100,
        }),
      );
      expect(mounted.stack.style.transform).toContain('scale(');

      // Plain-wheel tick before the debounce fires: must neither clear the
      // pending commit nor discard the preview.
      mounted.canvas.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          deltaY: 80,
        }),
      );
      expect(mounted.stack.style.transform).toContain('scale(');
      expect(mounted.pager.zoomFactor()).toBe(1);

      await new Promise((resolve) => setTimeout(resolve, 200));
      frames.settle();
      expect(mounted.pager.zoomFactor()).toBeGreaterThan(1);
      expect(mounted.stack.style.transform).toBe('');
    } finally {
      mounted.destroy();
    }
  });

  it('discards an embedded touch pinch on true pointercancel (no commit, no dirty, IO rearmed)', async () => {
    const frames = new FrameDriver();
    let dirtyCalls = 0;
    const mounted = mountEmbedded({
      frames,
      markDirty: () => {
        dirtyCalls += 1;
      },
    });
    try {
      const canonicalBefore = JSON.stringify(mounted.model);
      const zoomBefore = mounted.pager.zoomFactor();
      const mountedBefore = mounted.parent.querySelectorAll('.fl-ps').length;
      expect(mountedBefore).toBeGreaterThan(0);
      mounted.scroll.scrollTop = 500;
      const clientCenter = pagePoint(mounted.shells[1]!);
      const canvasRect = mounted.canvas.getBoundingClientRect();
      const start = {
        x: clientCenter.x - canvasRect.left,
        y: clientCenter.y - canvasRect.top,
      };
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerdown', { x: start.x - 80, y: start.y }, 91),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerdown', { x: start.x + 80, y: start.y }, 92),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointermove', { x: start.x - 96, y: start.y }, 91),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointermove', { x: start.x + 96, y: start.y }, 92),
      );
      expect(mounted.stack.style.transform).toContain('scale(');
      expect(mounted.pager.zoomFactor()).toBe(zoomBefore);
      // Suppress one entry mid-preview: cancel must discard it, never apply.
      HiddenPageObserver.latest?.emit([
        { target: mounted.shells[2], isIntersecting: false },
      ]);
      expect(mounted.parent.querySelectorAll('.fl-ps').length).toBe(
        mountedBefore,
      );

      // First cancel leaves the survivor open (no discard yet): ZoomEnd 0.
      mounted.canvas.dispatchEvent(
        pointerEvent('pointercancel', { x: start.x - 96, y: start.y }, 91),
      );
      expect(mounted.stack.style.transform).toBe('');
      expect(mounted.pager.zoomFactor()).toBe(zoomBefore);
      // True abort with no survivors discards: Cancel 1, never a commit.
      mounted.canvas.dispatchEvent(
        pointerEvent('pointercancel', { x: start.x + 96, y: start.y }, 92),
      );
      expect(mounted.stack.style.transform).toBe('');
      expect(mounted.pager.zoomFactor()).toBe(zoomBefore);
      expect(dirtyCalls).toBe(0);
      expect(JSON.stringify(mounted.model)).toBe(canonicalBefore);
      expect(mounted.parent.querySelectorAll('.fl-ps').length).toBe(
        mountedBefore,
      );

      // The wheel debounce is cleared: no delayed commit arrives after idle.
      await new Promise((resolve) => setTimeout(resolve, 200));
      frames.settle();
      expect(mounted.pager.zoomFactor()).toBe(zoomBefore);
      expect(mounted.stack.style.transform).toBe('');
      expect(frames.pending).toBe(0);

      // IO is rearmed: the next pinch reconciles only fresh entries and
      // commits once through the shared path.
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerdown', { x: start.x - 80, y: start.y }, 93),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerdown', { x: start.x + 80, y: start.y }, 94),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointermove', { x: start.x - 96, y: start.y }, 93),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointermove', { x: start.x + 96, y: start.y }, 94),
      );
      expect(mounted.stack.style.transform).toContain('scale(');
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerup', { x: start.x + 96, y: start.y }, 94),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerup', { x: start.x - 96, y: start.y }, 93),
      );
      frames.settle();
      expect(mounted.pager.zoomFactor()).toBeGreaterThan(zoomBefore);
      expect(mounted.stack.style.transform).toBe('');
      expect(dirtyCalls).toBe(0);
    } finally {
      mounted.destroy();
    }
  });

  it('discards elastic overzoom on cancel (never settles to the limit)', () => {
    const frames = new FrameDriver();
    const mounted = mountEmbedded({ frames });
    try {
      mounted.pager.setZoomFactor(7.9);
      frames.settle();
      expect(mounted.pager.zoomFactor()).toBe(7.9);
      mounted.scroll.scrollTop = 500;
      const clientCenter = pagePoint(mounted.shells[0]!);
      const canvasRect = mounted.canvas.getBoundingClientRect();
      const start = {
        x: clientCenter.x - canvasRect.left,
        y: clientCenter.y - canvasRect.top,
      };
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerdown', { x: start.x - 80, y: start.y }, 95),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerdown', { x: start.x + 80, y: start.y }, 96),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointermove', { x: start.x - 160, y: start.y }, 95),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointermove', { x: start.x + 160, y: start.y }, 96),
      );
      // Elastic preview resists past the max while the settle target stays 8.
      expect(mounted.stack.style.transform).toContain('scale(');
      mounted.canvas.dispatchEvent(
        pointerEvent('pointercancel', { x: start.x - 160, y: start.y }, 95),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointercancel', { x: start.x + 160, y: start.y }, 96),
      );
      expect(mounted.stack.style.transform).toBe('');
      expect(mounted.pager.zoomFactor()).toBe(7.9);
      expect(frames.pending).toBe(0);
      frames.settle();
      expect(mounted.pager.zoomFactor()).toBe(7.9);
      expect(mounted.stack.style.transform).toBe('');
    } finally {
      mounted.destroy();
    }
  });

  it('commits rapid ctrl-wheel ticks once on debounce idle (no per-tick commit)', async () => {
    const frames = new FrameDriver();
    const mounted = mountEmbedded({ frames });
    try {
      mounted.scroll.scrollTop = 500;
      const clientCenter = pagePoint(mounted.shells[1]!);
      const wheel = (): void => {
        mounted.canvas.dispatchEvent(
          new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            clientX: clientCenter.x,
            clientY: clientCenter.y,
            ctrlKey: true,
            deltaY: -100,
          }),
        );
      };
      wheel();
      expect(mounted.stack.style.transform).toContain('scale(');
      expect(mounted.pager.zoomFactor()).toBe(1);
      // Second tick before idle extends the same preview: still no commit.
      wheel();
      expect(mounted.stack.style.transform).toContain('scale(');
      expect(mounted.pager.zoomFactor()).toBe(1);

      await new Promise((resolve) => setTimeout(resolve, 200));
      frames.settle();
      // Single accumulated commit: exp(0.2 + 0.2) from the two ticks.
      expect(mounted.pager.zoomFactor()).toBeCloseTo(Math.exp(0.4), 1);
      expect(mounted.stack.style.transform).toBe('');
      expect(frames.pending).toBe(0);
    } finally {
      mounted.destroy();
    }
  });

  it('preserves a wheel zoom-spring across a plain-wheel tick (no early finalize, single settle)', async () => {
    const frames = new FrameDriver();
    const mounted = mountEmbedded({ frames });
    try {
      mounted.pager.setZoomFactor(7.9);
      frames.settle();
      expect(mounted.pager.zoomFactor()).toBe(7.9);
      const clientCenter = pagePoint(mounted.shells[0]!);
      mounted.canvas.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          clientX: clientCenter.x,
          clientY: clientCenter.y,
          ctrlKey: true,
          deltaY: -100,
        }),
      );
      expect(mounted.stack.style.transform).toContain('scale(');
      await new Promise((resolve) => setTimeout(resolve, 200));
      // Debounce idle armed the single zoom-spring frame for the elastic
      // settle back to the max.
      expect(frames.pending).toBe(1);

      // Plain-wheel tick mid-spring stays native and preserves the open
      // preview: no early finalize, no second frame, no commit yet.
      const plain = new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaY: 80,
      });
      mounted.canvas.dispatchEvent(plain);
      expect(plain.defaultPrevented).toBe(false);
      expect(mounted.pager.zoomFactor()).toBe(7.9);
      expect(mounted.stack.style.transform).toContain('scale(');
      expect(frames.pending).toBeLessThanOrEqual(1);

      frames.settle();
      expect(mounted.pager.zoomFactor()).toBe(8);
      expect(mounted.stack.style.transform).toBe('');
      expect(frames.pending).toBe(0);
    } finally {
      mounted.destroy();
    }
  });

  it('ignores palm touches until the pen finishes, then accepts a fresh pinch', () => {
    const frames = new FrameDriver();
    const mounted = mountEmbedded({ frames });
    try {
      mounted.canvas.dispatchEvent(
        penEvent('pointerdown', { x: 300, y: 300 }, 91),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerdown', { x: 350, y: 300 }, 92),
      );
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerdown', { x: 550, y: 300 }, 93),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointermove', { x: 250, y: 300 }, 92),
      );
      expect(mounted.stack.style.transform).toBe('');
      mounted.canvas.dispatchEvent(
        penEvent('pointerup', { x: 300, y: 300 }, 91),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerup', { x: 250, y: 300 }, 92),
      );
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerup', { x: 550, y: 300 }, 93),
      );
      performPinch(mounted.scroll, { x: 450, y: 300 }, 1.5, { x: 0, y: 0 });
      frames.settle();
      expect(mounted.pager.zoomFactor()).toBeCloseTo(1.5, 6);
    } finally {
      mounted.destroy();
    }
  });

  it('unmounting a page releases its pen contact so navigation can resume', () => {
    const frames = new FrameDriver();
    const mounted = mountEmbedded({ frames });
    try {
      mounted.canvas.dispatchEvent(
        penEvent('pointerdown', { x: 300, y: 300 }, 91),
      );
      HiddenPageObserver.latest?.emit([
        { target: mounted.shells[0], isIntersecting: false },
      ]);
      performPinch(mounted.scroll, { x: 450, y: 300 }, 1.5, { x: 0, y: 0 });
      frames.settle();
      expect(mounted.pager.zoomFactor()).toBeCloseTo(1.5, 6);
    } finally {
      mounted.destroy();
    }
  });

  it('pen preempting an embedded 1-finger pan discards pager state with no fling', () => {
    const frames = new FrameDriver();
    const mounted = mountEmbedded({ frames });
    try {
      mounted.scroll.scrollTop = 500;
      const topAtStart = mounted.scroll.scrollTop;
      // Horizontal drag at the left edge: native scroll cannot consume X, so
      // the shared rubber-band path publishes a transform preview.
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerdown', { x: 300, y: 300 }, 11),
      );
      frames.advance(16);
      mounted.canvas.dispatchEvent(
        pointerEvent('pointermove', { x: 500, y: 300 }, 11),
      );
      expect(previewTransform(mounted.stack).x).toBeGreaterThan(0);

      // Pen preempts: the controller must forward a true-abort cancel so the
      // pager discards (no PanEnd fling, no stranded transform/owner).
      mounted.canvas.dispatchEvent(
        penEvent('pointerdown', { x: 400, y: 300 }, 90),
      );
      expect(mounted.stack.style.transform).toBe('');
      expect(mounted.pager.zoomFactor()).toBe(1);
      expect(frames.pending).toBe(0);

      // Late touch lift and pen lift settle with no fling and no commit.
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerup', { x: 500, y: 300 }, 11),
      );
      mounted.canvas.dispatchEvent(
        penEvent('pointerup', { x: 400, y: 300 }, 90),
      );
      frames.settle();
      expect(mounted.stack.style.transform).toBe('');
      expect(mounted.pager.zoomFactor()).toBe(1);
      expect(mounted.scroll.scrollTop).toBe(topAtStart);
      expect(frames.pending).toBe(0);

      // Gutter navigation is unblocked: a fresh background pan settles clean.
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerdown', { x: 500, y: 400 }, 12),
      );
      frames.advance(16);
      mounted.scroll.dispatchEvent(
        pointerEvent('pointermove', { x: 500, y: 300 }, 12),
      );
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerup', { x: 500, y: 300 }, 12),
      );
      frames.settle();
      expect(mounted.stack.style.transform).toBe('');
      expect(frames.pending).toBe(0);
    } finally {
      mounted.destroy();
    }
  });

  it('pen preempting an embedded pinch discards the preview and unblocks the gutter', () => {
    const frames = new FrameDriver();
    const mounted = mountEmbedded({ frames });
    try {
      mounted.scroll.scrollTop = 500;
      const clientCenter = pagePoint(mounted.shells[1]!);
      const canvasRect = mounted.canvas.getBoundingClientRect();
      const start = {
        x: clientCenter.x - canvasRect.left,
        y: clientCenter.y - canvasRect.top,
      };
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerdown', { x: start.x - 80, y: start.y }, 21),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerdown', { x: start.x + 80, y: start.y }, 22),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointermove', { x: start.x - 96, y: start.y }, 21),
      );
      expect(mounted.stack.style.transform).toContain('scale(');

      // Pen preempts: the pager preview must be discarded (never committed),
      // releasing the single preview slot and ownership.
      mounted.canvas.dispatchEvent(
        penEvent('pointerdown', { x: 400, y: 300 }, 90),
      );
      expect(mounted.stack.style.transform).toBe('');
      expect(mounted.pager.zoomFactor()).toBe(1);
      expect(frames.pending).toBe(0);

      // Late touch lifts cannot commit the discarded preview.
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerup', { x: start.x + 80, y: start.y }, 22),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerup', { x: start.x - 96, y: start.y }, 21),
      );
      mounted.canvas.dispatchEvent(
        penEvent('pointerup', { x: 400, y: 300 }, 90),
      );
      frames.settle();
      expect(mounted.stack.style.transform).toBe('');
      expect(mounted.pager.zoomFactor()).toBe(1);
      expect(frames.pending).toBe(0);

      // Gutter pinch is unblocked: a fresh background pinch previews and
      // commits exactly once through the shared path.
      const gutterCenter = pagePoint(mounted.shells[1]!);
      mounted.scroll.dispatchEvent(
        pointerEvent(
          'pointerdown',
          { x: gutterCenter.x - 80, y: gutterCenter.y },
          31,
        ),
      );
      mounted.scroll.dispatchEvent(
        pointerEvent(
          'pointerdown',
          { x: gutterCenter.x + 80, y: gutterCenter.y },
          32,
        ),
      );
      mounted.scroll.dispatchEvent(
        pointerEvent(
          'pointermove',
          { x: gutterCenter.x - 96, y: gutterCenter.y },
          31,
        ),
      );
      expect(mounted.stack.style.transform).toContain('scale(');
      mounted.scroll.dispatchEvent(
        pointerEvent(
          'pointerup',
          { x: gutterCenter.x + 80, y: gutterCenter.y },
          32,
        ),
      );
      mounted.scroll.dispatchEvent(
        pointerEvent(
          'pointerup',
          { x: gutterCenter.x - 96, y: gutterCenter.y },
          31,
        ),
      );
      frames.settle();
      expect(mounted.pager.zoomFactor()).toBeGreaterThan(1);
      expect(mounted.stack.style.transform).toBe('');
    } finally {
      mounted.destroy();
    }
  });
});

describe('Pager navigation repair cases', () => {
  let previousIntersectionObserver: typeof IntersectionObserver | undefined;

  beforeEach(() => {
    previousIntersectionObserver = globalThis.IntersectionObserver;
    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      value: HiddenPageObserver,
    });
  });

  afterEach(() => {
    if (previousIntersectionObserver === undefined) {
      delete (globalThis as { IntersectionObserver?: unknown })
        .IntersectionObserver;
    } else {
      Object.defineProperty(globalThis, 'IntersectionObserver', {
        configurable: true,
        value: previousIntersectionObserver,
      });
    }
    document.body.replaceChildren();
  });

  function mountEmbeddedT11(
    options: {
      readonly frames?: FrameDriver;
      readonly reducedMotion?: boolean;
      readonly markDirty?: () => void;
    } = {},
  ): MountedPager & { canvas: HTMLCanvasElement } {
    const mounted = mountPager(options);
    HiddenPageObserver.latest?.emit(
      mounted.shells.map((shell) => ({
        target: shell,
        isIntersecting: true,
      })),
    );
    const canvas =
      mounted.parent.querySelector<HTMLCanvasElement>('.fl-ps canvas');
    if (canvas === null) {
      mounted.destroy();
      throw new Error('embedded page canvas failed to mount');
    }
    canvas.getBoundingClientRect = () =>
      rect(0, 0, VIEWPORT.width, VIEWPORT.height);
    return { ...mounted, canvas };
  }

  it('pan→pinch→lift→tap has no stale fling (velocity clean, cursor reset)', () => {
    const frames = new FrameDriver();
    const mounted = mountEmbeddedT11({ frames });
    // Impossible-state assert (both flags co-owned) must never fire: the
    // Pinch start clears any prior pan.
    const asserts: string[] = [];
    const originalAssert = console.assert;
    console.assert = (condition?: boolean, ...data: unknown[]): void => {
      if (condition === false) asserts.push(data.map(String).join(' '));
      return originalAssert(condition, ...data);
    };
    try {
      mounted.scroll.scrollTop = 500;
      // Fast embedded pan (high velocity) that will be interrupted by a pinch.
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerdown', { x: 500, y: 400 }, 11),
      );
      frames.advance(16);
      mounted.canvas.dispatchEvent(
        pointerEvent('pointermove', { x: 500, y: 300 }, 11),
      );
      // Second finger opens an embedded pinch — the pager must clear the
      // stranded pan cursor/velocity when the pinch starts (or on ZoomEnd).
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerdown', { x: 600, y: 400 }, 12),
      );
      frames.advance(16);
      mounted.canvas.dispatchEvent(
        pointerEvent('pointermove', { x: 500, y: 390 }, 11),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointermove', { x: 600, y: 410 }, 12),
      );
      expect(mounted.stack.style.transform).toContain('scale(');
      expect(asserts.filter((message) => message.includes('co-owned'))).toEqual(
        [],
      );
      // Both lift: ZoomEnd commits once (spring settles the anchor residual).
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerup', { x: 600, y: 410 }, 12),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerup', { x: 500, y: 390 }, 11),
      );
      frames.settle();
      expect(mounted.stack.style.transform).toBe('');
      expect(frames.pending).toBe(0);
      expect(asserts.filter((message) => message.includes('co-owned'))).toEqual(
        [],
      );

      // Immediate tap (down/up, no moves) must not reuse stranded velocity.
      // Fresh state never arms decay for a tap; stranded state would fling.
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerdown', { x: 500, y: 400 }, 13),
      );
      frames.advance(16);
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerup', { x: 500, y: 400 }, 13),
      );
      expect(frames.pending).toBe(0);
      expect(mounted.stack.style.transform).toBe('');
    } finally {
      console.assert = originalAssert;
      mounted.destroy();
    }
  });

  it('gutter pinch cannot steal an open embedded wheel preview (single commit)', async () => {
    const frames = new FrameDriver();
    const mounted = mountEmbeddedT11({ frames });
    try {
      mounted.scroll.scrollTop = 500;
      const wheelCenter = pagePoint(mounted.shells[1]!);
      mounted.canvas.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          clientX: wheelCenter.x,
          clientY: wheelCenter.y,
          ctrlKey: true,
          deltaY: -100,
        }),
      );
      expect(mounted.stack.style.transform).toContain('scale(');
      const live = previewTransform(mounted.stack);

      // Concurrent gutter two-finger gesture while the embedded preview owns
      // the single slot: background Down/Move must bail, never rebase.
      const gutterCenter = pagePoint(mounted.shells[1]!);
      mounted.scroll.dispatchEvent(
        pointerEvent(
          'pointerdown',
          { x: gutterCenter.x - 80, y: gutterCenter.y },
          71,
        ),
      );
      mounted.scroll.dispatchEvent(
        pointerEvent(
          'pointerdown',
          { x: gutterCenter.x + 80, y: gutterCenter.y },
          72,
        ),
      );
      mounted.scroll.dispatchEvent(
        pointerEvent(
          'pointermove',
          { x: gutterCenter.x - 120, y: gutterCenter.y },
          71,
        ),
      );
      mounted.scroll.dispatchEvent(
        pointerEvent(
          'pointermove',
          { x: gutterCenter.x + 120, y: gutterCenter.y },
          72,
        ),
      );
      const afterGutter = previewTransform(mounted.stack);
      expect(afterGutter.x).toBeCloseTo(live.x, 6);
      expect(afterGutter.y).toBeCloseTo(live.y, 6);
      expect(afterGutter.scale).toBeCloseTo(live.scale, 6);
      expect(mounted.pager.zoomFactor()).toBe(1);
      // Stale gutter ends must not commit or arm motion.
      mounted.scroll.dispatchEvent(
        pointerEvent(
          'pointerup',
          { x: gutterCenter.x + 120, y: gutterCenter.y },
          72,
        ),
      );
      mounted.scroll.dispatchEvent(
        pointerEvent(
          'pointerup',
          { x: gutterCenter.x - 120, y: gutterCenter.y },
          71,
        ),
      );
      expect(mounted.pager.zoomFactor()).toBe(1);

      // Wheel debounce idle commits exactly once.
      await new Promise((resolve) => setTimeout(resolve, 200));
      frames.settle();
      expect(mounted.pager.zoomFactor()).toBeCloseTo(Math.exp(0.2), 1);
      expect(mounted.stack.style.transform).toBe('');
      expect(frames.pending).toBe(0);
    } finally {
      mounted.destroy();
    }
  });

  it('wheel waits for the shared touch gesture to finish, then zooms once', async () => {
    const frames = new FrameDriver();
    const mounted = mountEmbeddedT11({ frames });
    try {
      mounted.scroll.scrollTop = 500;
      const point = pagePoint(mounted.shells[1]!);
      const wheel = () =>
        mounted.canvas.dispatchEvent(
          new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            ctrlKey: true,
            deltaY: -100,
            clientX: point.x,
            clientY: point.y,
          }),
        );
      mounted.scroll.dispatchEvent(pointerEvent('pointerdown', point, 71));
      wheel();
      expect(mounted.stack.style.transform).toBe('');
      mounted.scroll.dispatchEvent(pointerEvent('pointerup', point, 71));
      wheel();
      expect(mounted.stack.style.transform).toContain('scale(');
      await new Promise((resolve) => setTimeout(resolve, 200));
      frames.settle();
      expect(mounted.pager.zoomFactor()).toBeCloseTo(Math.exp(0.2), 6);
      expect(mounted.stack.style.transform).toBe('');
    } finally {
      mounted.destroy();
    }
  });

  it('a gutter cancel aborts a cross-page gesture and trailing lifts do nothing', () => {
    const frames = new FrameDriver();
    const mounted = mountEmbeddedT11({ frames });
    try {
      const before = JSON.stringify(mounted.model);
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerdown', { x: 300, y: 300 }, 71),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerdown', { x: 500, y: 300 }, 72),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointermove', { x: 600, y: 300 }, 72),
      );
      expect(previewTransform(mounted.stack).scale).toBeCloseTo(1.5, 6);
      mounted.scroll.dispatchEvent(
        pointerEvent('pointercancel', { x: 300, y: 300 }, 71),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerup', { x: 600, y: 300 }, 72),
      );
      frames.settle();
      expect(mounted.pager.zoomFactor()).toBe(1);
      expect(mounted.stack.style.transform).toBe('');
      expect(JSON.stringify(mounted.model)).toBe(before);
    } finally {
      mounted.destroy();
    }
  });

  it('non-finite rAF timestamp never poisons motion (no stuck loop)', () => {
    const frames = new FrameDriver();
    const mounted = mountPager({ frames });
    try {
      mounted.scroll.scrollTop = 500;
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerdown', { x: 500, y: 400 }, 1),
      );
      frames.advance(16);
      mounted.scroll.dispatchEvent(
        pointerEvent('pointermove', { x: 500, y: 300 }, 1),
      );
      frames.advance(16);
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerup', { x: 500, y: 300 }, 1),
      );
      expect(frames.pending).toBe(1);
      // Inject a non-finite rAF timestamp: the stepper must reuse motionTime
      // and reschedule without poisoning (still exactly one frame pending).
      frames.nowMs = Number.NaN;
      frames.advance(0);
      expect(frames.pending).toBe(1);
      // Recover with finite timestamps: motion must still progress and
      // settle to a clean transform (no stuck loop, no second rAF).
      frames.nowMs = 1_000;
      frames.advance(16);
      expect(frames.pending).toBeLessThanOrEqual(1);
      frames.settle();
      expect(mounted.stack.style.transform).toBe('');
      expect(frames.pending).toBe(0);
    } finally {
      mounted.destroy();
    }
  });

  it('remount after destroy drives a fresh gesture cleanly', () => {
    const frames = new FrameDriver();
    const first = mountPager({ frames });
    try {
      first.scroll.scrollTop = 500;
      first.scroll.dispatchEvent(
        pointerEvent('pointerdown', { x: 500, y: 400 }, 1),
      );
      frames.advance(16);
      first.scroll.dispatchEvent(
        pointerEvent('pointermove', { x: 500, y: 300 }, 1),
      );
      first.scroll.dispatchEvent(
        pointerEvent('pointerup', { x: 500, y: 300 }, 1),
      );
      expect(frames.pending).toBe(1);
    } finally {
      first.destroy();
    }
    expect(frames.pending).toBe(0);
    const second = mountPager({ frames });
    try {
      second.scroll.scrollTop = 500;
      const zoomBefore = second.pager.zoomFactor();
      expect(zoomBefore).toBe(1);
      second.scroll.dispatchEvent(
        pointerEvent('pointerdown', { x: 500, y: 400 }, 2),
      );
      frames.advance(16);
      second.scroll.dispatchEvent(
        pointerEvent('pointermove', { x: 500, y: 300 }, 2),
      );
      second.scroll.dispatchEvent(
        pointerEvent('pointerup', { x: 500, y: 300 }, 2),
      );
      // Fresh mount drives exactly one motion frame (single registration,
      // no leaked frame from the destroyed pager).
      expect(frames.pending).toBe(1);
      frames.settle();
      expect(second.stack.style.transform).toBe('');
      expect(frames.pending).toBe(0);
    } finally {
      second.destroy();
    }
  });
});

describe('gutter elastic zoom + animated buttons', () => {
  let previousIntersectionObserver: typeof IntersectionObserver | undefined;

  beforeEach(() => {
    previousIntersectionObserver = globalThis.IntersectionObserver;
    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      value: HiddenPageObserver,
    });
  });

  afterEach(() => {
    if (previousIntersectionObserver === undefined) {
      delete (globalThis as { IntersectionObserver?: unknown })
        .IntersectionObserver;
    } else {
      Object.defineProperty(globalThis, 'IntersectionObserver', {
        configurable: true,
        value: previousIntersectionObserver,
      });
    }
    document.body.replaceChildren();
  });

  function mountEmbeddedGutter(
    options: {
      readonly frames?: FrameDriver;
      readonly reducedMotion?: boolean;
      readonly markDirty?: () => void;
    } = {},
  ): MountedPager & { canvas: HTMLCanvasElement } {
    const mounted = mountPager(options);
    HiddenPageObserver.latest?.emit(
      mounted.shells.map((shell) => ({
        target: shell,
        isIntersecting: true,
      })),
    );
    const canvas =
      mounted.parent.querySelector<HTMLCanvasElement>('.fl-ps canvas');
    if (canvas === null) {
      mounted.destroy();
      throw new Error('embedded page canvas failed to mount');
    }
    canvas.getBoundingClientRect = () =>
      rect(0, 0, VIEWPORT.width, VIEWPORT.height);
    return { ...mounted, canvas };
  }

  function gutterWheel(
    scroll: HTMLElement,
    point: { readonly x: number; readonly y: number },
    deltaY: number,
  ): WheelEvent {
    const event = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX: point.x,
      clientY: point.y,
      ctrlKey: true,
      deltaY,
    });
    scroll.dispatchEvent(event);
    return event;
  }

  it('gutter ctrl-wheel previews elastic at the cursor and commits once with a <=2px anchor (ephemeral)', async () => {
    const frames = new FrameDriver();
    let dirtyCalls = 0;
    const mounted = mountPager({
      frames,
      markDirty: () => {
        dirtyCalls += 1;
      },
    });
    try {
      const canonicalBefore = JSON.stringify(mounted.model);
      mounted.scroll.scrollTop = 500;
      const cursor = pagePoint(mounted.shells[1]!);

      const first = gutterWheel(mounted.scroll, cursor, -100);
      // Non-passive gutter listener (fix): ctrl-wheel blocks the
      // browser pinch-zoom while plain-wheel below stays native.
      expect(first.defaultPrevented).toBe(true);
      expect(mounted.stack.style.transform).toContain('scale(');
      expect(mounted.stack.style.transformOrigin).not.toBe('');
      expect(mounted.pager.zoomFactor()).toBe(1);
      expect(frames.pending).toBe(0);

      // Rapid second tick coalesces: same preview extended, still no commit.
      gutterWheel(mounted.scroll, cursor, -100);
      expect(mounted.stack.style.transform).toContain('scale(');
      expect(mounted.pager.zoomFactor()).toBe(1);
      expect(frames.pending).toBe(0);

      await new Promise((resolve) => setTimeout(resolve, 200));
      frames.settle();

      expect(mounted.pager.zoomFactor()).toBeCloseTo(Math.exp(0.4), 1);
      expect(mounted.pager.zoomFactor()).toBeGreaterThanOrEqual(0.25);
      expect(mounted.pager.zoomFactor()).toBeLessThanOrEqual(8);
      expect(mounted.stack.style.transform).toBe('');
      expect(frames.pending).toBe(0);
      expect(dirtyCalls).toBe(0);
      expect(JSON.stringify(mounted.model)).toBe(canonicalBefore);
      // Preview/commit agree: the page content under the cursor stays
      // within 2px (transformOrigin aligned with commit anchor math).
      expect(
        distance(pagePoint(mounted.shells[1]!), cursor),
      ).toBeLessThanOrEqual(2);
    } finally {
      mounted.destroy();
    }
  });

  it('gutter overzoom resists past the bounds and never settles outside 0.25-8', async () => {
    const frames = new FrameDriver();
    const mounted = mountPager({ frames });
    try {
      mounted.pager.setZoomFactor(7.9);
      frames.settle();
      expect(mounted.pager.zoomFactor()).toBe(7.9);
      mounted.scroll.scrollTop = 500;
      const topCursor = pagePoint(mounted.shells[0]!);
      gutterWheel(mounted.scroll, topCursor, -100);
      const live = previewTransform(mounted.stack);
      // Elastic preview resists past the max (visual scale grows).
      expect(live.scale).toBeGreaterThan(1);
      await new Promise((resolve) => setTimeout(resolve, 200));
      // Elastic settle arms the single zoom-spring back to the bound.
      expect(frames.pending).toBe(1);
      frames.settle();
      expect(mounted.pager.zoomFactor()).toBe(8);
      expect(mounted.stack.style.transform).toBe('');
      expect(frames.pending).toBe(0);

      // Once the canonical zoom is saturated, repeated outward wheel input
      // is a complete no-op: no CSS scaling of paper lines and no delayed
      // settle frame. Reversing direction responds on the first tick.
      gutterWheel(mounted.scroll, topCursor, -100);
      expect(mounted.stack.style.transform).toBe('');
      expect(frames.pending).toBe(0);

      mounted.pager.setZoomFactor(0.26);
      frames.settle();
      expect(mounted.pager.zoomFactor()).toBe(0.26);
      const bottomCursor = pagePoint(mounted.shells[1]!);
      gutterWheel(mounted.scroll, bottomCursor, 100);
      const shrunk = previewTransform(mounted.stack);
      expect(shrunk.scale).toBeLessThan(1);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(frames.pending).toBe(1);
      frames.settle();
      expect(mounted.pager.zoomFactor()).toBe(0.25);
      expect(mounted.stack.style.transform).toBe('');
      expect(frames.pending).toBe(0);

      gutterWheel(mounted.scroll, bottomCursor, 100);
      expect(mounted.stack.style.transform).toBe('');
      expect(frames.pending).toBe(0);
      gutterWheel(mounted.scroll, bottomCursor, -100);
      expect(previewTransform(mounted.stack).scale).toBeGreaterThan(1);
    } finally {
      mounted.destroy();
    }
  });

  it('gutter plain-wheel stays native and preserves an open wheel preview (single commit)', async () => {
    const frames = new FrameDriver();
    const mounted = mountPager({ frames });
    try {
      mounted.scroll.scrollTop = 500;
      const cursor = pagePoint(mounted.shells[1]!);
      gutterWheel(mounted.scroll, cursor, -100);
      expect(mounted.stack.style.transform).toContain('scale(');

      const plain = new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaY: 80,
      });
      const topBefore = mounted.scroll.scrollTop;
      mounted.scroll.dispatchEvent(plain);
      expect(plain.defaultPrevented).toBe(false);
      expect(mounted.stack.style.transform).toContain('scale(');
      expect(mounted.pager.zoomFactor()).toBe(1);
      expect(mounted.scroll.scrollTop).toBe(topBefore);

      await new Promise((resolve) => setTimeout(resolve, 200));
      frames.settle();
      expect(mounted.pager.zoomFactor()).toBeCloseTo(Math.exp(0.2), 1);
      expect(mounted.stack.style.transform).toBe('');
      expect(frames.pending).toBe(0);
    } finally {
      mounted.destroy();
    }
  });

  it('toolbar zoom animates over frames with a viewport-center anchor (ephemeral, single frame)', () => {
    const frames = new FrameDriver();
    let dirtyCalls = 0;
    const mounted = mountPager({
      frames,
      markDirty: () => {
        dirtyCalls += 1;
      },
    });
    try {
      const canonicalBefore = JSON.stringify(mounted.model);
      mounted.scroll.scrollTop = 500;
      const viewportCenter = { x: 600, y: 450 };
      const shell = mounted.shells[1]!;
      const before = shell.getBoundingClientRect();
      const anchor = {
        u: (viewportCenter.x - before.left) / before.width,
        v: (viewportCenter.y - before.top) / before.height,
      };

      mounted.pager.setZoomFactor(1.5);

      // Animated (not instant): one motion frame, live preview, no commit yet.
      expect(frames.pending).toBe(1);
      expect(mounted.stack.style.transform).toContain('scale(');
      expect(mounted.stack.style.transformOrigin).not.toBe('');
      expect(mounted.pager.zoomFactor()).toBe(1);
      // >0 frames: one step still animates (not yet settled).
      frames.advance(16);
      expect(frames.pending).toBeLessThanOrEqual(1);
      frames.settle();

      expect(mounted.pager.zoomFactor()).toBeCloseTo(1.5, 3);
      expect(mounted.stack.style.transform).toBe('');
      expect(frames.pending).toBe(0);
      expect(dirtyCalls).toBe(0);
      expect(JSON.stringify(mounted.model)).toBe(canonicalBefore);
      const after = shell.getBoundingClientRect();
      expect(
        distance(
          {
            x: after.left + after.width * anchor.u,
            y: after.top + after.height * anchor.v,
          },
          viewportCenter,
        ),
      ).toBeLessThanOrEqual(1);
    } finally {
      mounted.destroy();
    }
  });

  it('toolbar zoom is instant under reduced motion with an identical result', () => {
    const frames = new FrameDriver();
    const mounted = mountPager({ frames, reducedMotion: true });
    try {
      mounted.scroll.scrollTop = 500;
      mounted.pager.setZoomFactor(1.5);
      expect(frames.pending).toBe(0);
      expect(mounted.stack.style.transform).toBe('');
      expect(mounted.pager.zoomFactor()).toBe(1.5);
    } finally {
      mounted.destroy();
    }
  });

  it('gutter wheel at an outside-page stack anchor commits once with a smooth recenter', async () => {
    const frames = new FrameDriver();
    let dirtyCalls = 0;
    const mounted = mountPager({
      frames,
      markDirty: () => {
        dirtyCalls += 1;
      },
    });
    try {
      mounted.scroll.scrollTop = 500;
      // A horizontal gutter point is page-relative even though its U lies
      // outside [0, 1]. Commit cannot preserve that anchor after scroll
      // clamping, so the residual bridges into the smooth recenter spring.
      const outside = { x: VIEWPORT.left + PADDING.x - 10, y: 450 };
      const anchoredPage = mounted.shells.find((shell) => {
        const bounds = shell.getBoundingClientRect();
        return outside.y >= bounds.top && outside.y <= bounds.bottom;
      });
      expect(anchoredPage).toBeDefined();
      const pageBefore = anchoredPage!.getBoundingClientRect();
      const centerBefore = pageBefore.left + pageBefore.width / 2;
      gutterWheel(mounted.scroll, outside, -100);
      expect(mounted.stack.style.transform).toContain('scale(');
      expect(mounted.stack.style.transformOrigin).not.toBe('');

      await new Promise((resolve) => setTimeout(resolve, 200));
      // Outside-page anchors commit through the same finalize path;
      // a scroll-clamp residual arms one pan-spring recenter (no hard cut).
      // Residual spring progression: at most one frame, live transform still
      // published mid-spring, clean after settle.
      expect(frames.pending).toBeLessThanOrEqual(1);
      expect(mounted.stack.style.transform).not.toBe('');
      frames.advance(16);
      expect(frames.pending).toBeLessThanOrEqual(1);
      frames.settle();

      expect(mounted.pager.zoomFactor()).toBeCloseTo(Math.exp(0.2), 1);
      expect(mounted.stack.style.transform).toBe('');
      expect(frames.pending).toBe(0);
      expect(dirtyCalls).toBe(0);
      expect(Number.isFinite(mounted.scroll.scrollTop)).toBe(true);
      // The gutter-origin preview hands off continuously to a centered page;
      // unlike an on-paper anchor, the outside cursor is not retained.
      const pageAfter = anchoredPage!.getBoundingClientRect();
      expect(pageAfter.left + pageAfter.width / 2).toBeCloseTo(centerBefore, 0);
    } finally {
      mounted.destroy();
    }
  });

  it('gutter wheel owns the preview: embedded steps never steal it (single commit)', async () => {
    const frames = new FrameDriver();
    const mounted = mountEmbeddedGutter({ frames });
    try {
      mounted.scroll.scrollTop = 500;
      const gutterCursor = pagePoint(mounted.shells[1]!);
      gutterWheel(mounted.scroll, gutterCursor, -100);
      expect(mounted.stack.style.transform).toContain('scale(');
      const live = previewTransform(mounted.stack);

      // Embedded pinch attempt while the gutter owns must be ignored.
      const canvasRect = mounted.canvas.getBoundingClientRect();
      const clientCenter = pagePoint(mounted.shells[1]!);
      const start = {
        x: clientCenter.x - canvasRect.left,
        y: clientCenter.y - canvasRect.top,
      };
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerdown', { x: start.x - 80, y: start.y }, 71),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerdown', { x: start.x + 80, y: start.y }, 72),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointermove', { x: start.x - 96, y: start.y }, 71),
      );
      const afterEmbedded = previewTransform(mounted.stack);
      expect(afterEmbedded.x).toBeCloseTo(live.x, 6);
      expect(afterEmbedded.y).toBeCloseTo(live.y, 6);
      expect(afterEmbedded.scale).toBeCloseTo(live.scale, 6);
      expect(mounted.pager.zoomFactor()).toBe(1);
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerup', { x: start.x + 80, y: start.y }, 72),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerup', { x: start.x - 96, y: start.y }, 71),
      );

      await new Promise((resolve) => setTimeout(resolve, 200));
      frames.settle();
      expect(mounted.pager.zoomFactor()).toBeCloseTo(Math.exp(0.2), 1);
      expect(mounted.stack.style.transform).toBe('');
      expect(frames.pending).toBe(0);
    } finally {
      mounted.destroy();
    }
  });

  it('a second toolbar zoom overrides an in-flight animation (single frame, single commit)', () => {
    const frames = new FrameDriver();
    const mounted = mountPager({ frames });
    try {
      mounted.scroll.scrollTop = 500;
      mounted.pager.setZoomFactor(2);
      expect(frames.pending).toBe(1);
      // Interrupt before settle: the first preview is discarded via the
      // shared cancel path, the second arms the single frame (never two).
      mounted.pager.setZoomFactor(1.5);
      expect(frames.pending).toBe(1);
      frames.settle();
      expect(mounted.pager.zoomFactor()).toBeCloseTo(1.5, 3);
      expect(mounted.stack.style.transform).toBe('');
      expect(frames.pending).toBe(0);
    } finally {
      mounted.destroy();
    }
  });

  it('slider scrub coalesces rapid programmatic zooms to the last target (single frame, no loss)', () => {
    // regression: buttons/slider drive absolute `setZoomFactor`
    // values that animate (async contract). Rapid scrubs must coalesce
    // to the last target with one frame/one commit — the stale
    // `zoomFactor()` reads mid-animation must never cause a lost last write.
    const frames = new FrameDriver();
    let dirtyCalls = 0;
    const mounted = mountPager({
      frames,
      markDirty: () => {
        dirtyCalls += 1;
      },
    });
    try {
      const canonicalBefore = JSON.stringify(mounted.model);
      mounted.scroll.scrollTop = 500;
      mounted.pager.setZoomFactor(1.2);
      expect(frames.pending).toBe(1);
      // Stale during animation (documented on `setZoomFactor`): the committed
      // value is still 1 until the spring settles.
      expect(mounted.pager.zoomFactor()).toBe(1);
      mounted.pager.setZoomFactor(1.4);
      expect(frames.pending).toBe(1);
      expect(mounted.pager.zoomFactor()).toBe(1);
      mounted.pager.setZoomFactor(1.6);
      expect(frames.pending).toBe(1);
      expect(mounted.stack.style.transform).toContain('scale(');
      expect(mounted.pager.zoomFactor()).toBe(1);
      frames.settle();
      // Last write wins with a single commit — no stacking, no loss.
      expect(mounted.pager.zoomFactor()).toBeCloseTo(1.6, 3);
      expect(mounted.stack.style.transform).toBe('');
      expect(frames.pending).toBe(0);
      expect(dirtyCalls).toBe(0);
      expect(JSON.stringify(mounted.model)).toBe(canonicalBefore);
    } finally {
      mounted.destroy();
    }
  });

  it('destroy during a gutter preview clears the debounce with no late commit', async () => {
    const frames = new FrameDriver();
    const mounted = mountPager({ frames });
    mounted.scroll.scrollTop = 500;
    const cursor = pagePoint(mounted.shells[1]!);
    gutterWheel(mounted.scroll, cursor, -100);
    expect(mounted.stack.style.transform).toContain('scale(');
    mounted.destroy();
    expect(frames.pending).toBe(0);
    document.body.replaceChildren();
    await new Promise((resolve) => setTimeout(resolve, 200));
    frames.settle();
    expect(frames.pending).toBe(0);
    // the single non-passive gutter wheel listener is removed on
    // destroy — post-destroy wheel (both ctrl and plain paths) is a safe
    // no-op with no late preview, no frame, and no throw.
    const scrollAfterDestroy = mounted.scroll;
    expect(() => {
      gutterWheel(scrollAfterDestroy, cursor, -100);
      scrollAfterDestroy.dispatchEvent(
        new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          deltaY: 80,
        }),
      );
    }).not.toThrow();
    expect(frames.pending).toBe(0);
  });
});
