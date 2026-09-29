// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendPage,
  boundedFrame,
  emptyNotebook,
  emptySurface,
  notebookPage,
} from '@froglight/foundation';
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

/**
 * Notebook navigation integration cases.
 *
 * These fill gaps left by unit coverage and the mounted geometry specs:
 * anchor/relayout/narrow->wide/already-wide, gutter+embedded
 * inertia/overscroll/wheel parity, ctrl-wheel once, true-cancel discard,
 * 1->2->1/third-finger, reduced-motion full matrix, read-only flips
 * mid-flight, destroy mid-gesture, cancel-vs-end races, byte-compare
 * canonical after every run, perf counters (single motion frame, no
 * per-move layout, bounded geometry reads), at 60Hz and 120Hz.
 *
 * Every nav-only run asserts: canonical JSON byte-identical, dirty 0.
 * No production semantics are changed here.
 */

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
  scheduleCount = 0;

  readonly timing = {
    now: (): number => this.nowMs,
    requestFrame: (callback: FrameRequestCallback): number => {
      const id = this.#nextId++;
      this.#callbacks.set(id, callback);
      this.scheduleCount += 1;
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
    for (let frame = 0; frame < maximumFrames && this.pending > 0; frame += 1) {
      expect(this.pending).toBeLessThanOrEqual(1);
      this.advance();
    }
    expect(this.pending).toBe(0);
  }
}

class HiddenPageObserver implements IntersectionObserver {
  static latest: HiddenPageObserver | null = null;
  readonly root = null;
  readonly rootMargin = '';
  readonly scrollMargin = '';
  readonly thresholds = [0];
  readonly #callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.#callback = callback;
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
): Event {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: point.x,
    clientY: point.y,
  });
  Object.defineProperty(event, 'pointerId', { value: pointerId });
  Object.defineProperty(event, 'pointerType', { value: 'touch' });
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
  canvas.getBoundingClientRect = () =>
    rect(0, 0, VIEWPORT.width, VIEWPORT.height);
  return { ...mounted, canvas };
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

function expectCanonicalClean(
  mounted: MountedPager,
  canonicalBefore: string,
  dirtyCalls: number,
): void {
  expect(JSON.stringify(mounted.model)).toBe(canonicalBefore);
  expect(dirtyCalls).toBe(0);
  expect(mounted.stack.style.transform).toBe('');
  expect(mounted.pager.zoomFactor()).toBeGreaterThan(0);
}

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

describe('Notebook navigation integration matrix', () => {
  it.each(['different pages', 'page and gutter', 'gutter and page'])(
    'pinches across %s with one shared gesture',
    (origin) => {
      const frames = new FrameDriver();
      const mounted = mountEmbedded({ frames });
      try {
        const canvases = mounted.parent.querySelectorAll('.fl-ps canvas');
        const first =
          origin === 'gutter and page' ? mounted.scroll : canvases[0]!;
        const second =
          origin === 'different pages'
            ? canvases[1]!
            : origin === 'page and gutter'
              ? mounted.scroll
              : canvases[0]!;
        const before = JSON.stringify(mounted.model);
        const zoom = mounted.pager.zoomFactor();
        first.dispatchEvent(pointerEvent('pointerdown', { x: 350, y: 300 }, 1));
        second.dispatchEvent(
          pointerEvent('pointerdown', { x: 550, y: 300 }, 2),
        );
        first.dispatchEvent(pointerEvent('pointermove', { x: 300, y: 300 }, 1));
        second.dispatchEvent(
          pointerEvent('pointermove', { x: 600, y: 300 }, 2),
        );
        expect(previewTransform(mounted.stack).scale).toBeCloseTo(1.5, 2);
        second.dispatchEvent(pointerEvent('pointerup', { x: 600, y: 300 }, 2));
        first.dispatchEvent(pointerEvent('pointerup', { x: 300, y: 300 }, 1));
        frames.settle();
        expect(mounted.pager.zoomFactor()).toBeCloseTo(zoom * 1.5, 2);
        expect(JSON.stringify(mounted.model)).toBe(before);
      } finally {
        mounted.destroy();
      }
    },
  );

  it('pulling beyond the first page inserts one blank page on release', () => {
    const mounted = mountPager();
    try {
      const before = mounted.pager.pageCount();
      mounted.scroll.scrollTop = 0;
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerdown', { x: 300, y: 300 }, 41),
      );
      mounted.scroll.dispatchEvent(
        pointerEvent('pointermove', { x: 300, y: 520 }, 41),
      );
      expect(mounted.pager.pageCount()).toBe(before);
      expect(
        mounted.parent.querySelector('.fl-nb-pull-add-label')?.textContent,
      ).toBe('Release to add page');
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerup', { x: 300, y: 520 }, 41),
      );
      expect(mounted.pager.pageCount()).toBe(before + 1);
      expect(mounted.pager.currentPageIndex()).toBe(0);
      const first = mounted.model.pages[mounted.model.pageOrder[0]!];
      expect(first?.kind).toBe('page');
      if (first?.kind !== 'page') throw new Error('Expected a notebook page');
      expect(first.surface.order).toEqual([]);
      expect(first.surface.frame).toEqual(boundedFrame(800, 600));
      expect(
        mounted.parent.querySelector('.fl-nb-pull-add')?.hasAttribute('hidden'),
      ).toBe(true);
    } finally {
      mounted.destroy();
    }
  });

  it('bottom pull appends one page; a short pull or cancel leaves pages untouched', () => {
    const mounted = mountPager();
    try {
      const before = mounted.pager.pageCount();
      mounted.pager.jumpToPage(before - 1);
      mounted.scroll.scrollTop = 1_000_000;
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerdown', { x: 300, y: 430 }, 42),
      );
      mounted.scroll.dispatchEvent(
        pointerEvent('pointermove', { x: 300, y: 290 }, 42),
      );
      expect(
        mounted.parent.querySelector('.fl-nb-pull-add-label')?.textContent,
      ).toBe('+ Add page');
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerup', { x: 300, y: 290 }, 42),
      );
      expect(mounted.pager.pageCount()).toBe(before);
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerdown', { x: 300, y: 430 }, 43),
      );
      mounted.scroll.dispatchEvent(
        pointerEvent('pointermove', { x: 300, y: 210 }, 43),
      );
      expect(mounted.pager.pageCount()).toBe(before);
      mounted.scroll.dispatchEvent(
        pointerEvent('pointercancel', { x: 300, y: 210 }, 43),
      );
      expect(mounted.pager.pageCount()).toBe(before);
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerdown', { x: 300, y: 430 }, 44),
      );
      mounted.scroll.dispatchEvent(
        pointerEvent('pointermove', { x: 300, y: 210 }, 44),
      );
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerup', { x: 300, y: 210 }, 44),
      );
      expect(mounted.pager.pageCount()).toBe(before + 1);
      expect(mounted.model.pageOrder).toHaveLength(before + 1);
    } finally {
      mounted.destroy();
    }
  });

  it('narrow page growing wider keeps the anchor within 1px', () => {
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
      mounted.pager.setZoomFactor(1);
      mounted.scroll.scrollLeft = 0;
      mounted.scroll.scrollTop = 500;
      const shell = mounted.shells[1]!;
      const start = pagePoint(shell);
      const finalCentroid = performPinch(mounted.scroll, start, 1.5, {
        x: 30,
        y: -20,
      });
      expect(distance(pagePoint(shell), finalCentroid)).toBeLessThanOrEqual(1);
      frames.settle();
      expectCanonicalClean(mounted, canonicalBefore, dirtyCalls);
    } finally {
      mounted.destroy();
    }
  });

  it('already-wide page growing farther keeps the anchor within 1px', () => {
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
      mounted.pager.setZoomFactor(1.25);
      mounted.scroll.scrollLeft = 100;
      mounted.scroll.scrollTop = 650;
      const shell = mounted.shells[1]!;
      const start = pagePoint(shell);
      const finalCentroid = performPinch(mounted.scroll, start, 1.25, {
        x: 20,
        y: -15,
      });
      expect(distance(pagePoint(shell), finalCentroid)).toBeLessThanOrEqual(1);
      frames.settle();
      expectCanonicalClean(mounted, canonicalBefore, dirtyCalls);
    } finally {
      mounted.destroy();
    }
  });

  it('same-zoom relayout holds the viewport-center anchor without drift', () => {
    const mounted = mountPager();
    try {
      const canonicalBefore = JSON.stringify(mounted.model);
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
      expect(JSON.stringify(mounted.model)).toBe(canonicalBefore);
    } finally {
      mounted.destroy();
    }
  });

  it('gutter fling decays with deceleration at 60Hz and settles clean', () => {
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
      const releasedAt = mounted.scroll.scrollTop;
      frames.advance(16);
      const firstStep = mounted.scroll.scrollTop - releasedAt;
      frames.advance(16);
      const secondStep = mounted.scroll.scrollTop - releasedAt - firstStep;
      expect(firstStep).toBeGreaterThan(0);
      expect(secondStep).toBeGreaterThan(0);
      expect(secondStep).toBeLessThan(firstStep);
      frames.settle();
      expectCanonicalClean(mounted, canonicalBefore, dirtyCalls);
      expect(frames.pending).toBe(0);
    } finally {
      mounted.destroy();
    }
  });

  it('gutter fling decays with deceleration at 120Hz and settles clean', () => {
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
      expect(frames.pending).toBe(1);
      const releasedAt = mounted.scroll.scrollTop;
      frames.advance(8);
      const firstStep = mounted.scroll.scrollTop - releasedAt;
      frames.advance(8);
      const secondStep = mounted.scroll.scrollTop - releasedAt - firstStep;
      expect(firstStep).toBeGreaterThan(0);
      expect(secondStep).toBeGreaterThan(0);
      expect(secondStep).toBeLessThan(firstStep);
      frames.settle();
      expectCanonicalClean(mounted, canonicalBefore, dirtyCalls);
    } finally {
      mounted.destroy();
    }
  });

  it('embedded fast swipe flings through the shared decay branch with zero dirty', () => {
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
      mounted.scroll.scrollTop = 500;
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerdown', { x: 500, y: 400 }, 12),
      );
      frames.advance(16);
      mounted.canvas.dispatchEvent(
        pointerEvent('pointermove', { x: 500, y: 300 }, 12),
      );
      frames.advance(16);
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerup', { x: 500, y: 300 }, 12),
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
      expectCanonicalClean(mounted, canonicalBefore, dirtyCalls);
    } finally {
      mounted.destroy();
    }
  });

  it('gutter overscroll rubber-bands and springs back with zero dirty', () => {
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
      frames.settle();
      expect(mounted.stack.style.transform).toBe('');
      expectCanonicalClean(mounted, canonicalBefore, dirtyCalls);
    } finally {
      mounted.destroy();
    }
  });

  it('embedded overscroll previews transform-only with zero layout per move', () => {
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
      mounted.scroll.scrollTop = 500;
      const widthsBefore = mounted.shells.map((shell) => shell.style.width);
      const zoomBefore = mounted.pager.zoomFactor();
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerdown', { x: 300, y: 300 }, 11),
      );
      frames.advance(16);
      mounted.canvas.dispatchEvent(
        pointerEvent('pointermove', { x: 500, y: 300 }, 11),
      );
      expect(previewTransform(mounted.stack).x).toBeGreaterThan(0);
      expect(mounted.shells.map((shell) => shell.style.width)).toEqual(
        widthsBefore,
      );
      expect(mounted.pager.zoomFactor()).toBe(zoomBefore);
      expect(dirtyCalls).toBe(0);
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerup', { x: 500, y: 300 }, 11),
      );
      frames.settle();
      expect(mounted.stack.style.transform).toBe('');
      expectCanonicalClean(mounted, canonicalBefore, dirtyCalls);
    } finally {
      mounted.destroy();
    }
  });

  it('gutter plain wheel cancels decay without double-scroll', () => {
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
      expect(plain.defaultPrevented).toBe(false);
      expect(frames.pending).toBe(0);
      expect(mounted.scroll.scrollTop).toBe(topBefore);
      expect(mounted.stack.style.transform).toBe('');
      expectCanonicalClean(mounted, canonicalBefore, dirtyCalls);
    } finally {
      mounted.destroy();
    }
  });

  it('embedded plain wheel preserves an open pinch preview and plain gutter wheel stays native', () => {
    const frames = new FrameDriver();
    const mounted = mountEmbedded({ frames });
    try {
      const canonicalBefore = JSON.stringify(mounted.model);
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
      const plain = new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        deltaY: 80,
      });
      mounted.canvas.dispatchEvent(plain);
      expect(plain.defaultPrevented).toBe(false);
      expect(mounted.stack.style.transform).toContain('scale(');
      expect(mounted.pager.zoomFactor()).toBe(1);
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerup', { x: start.x + 96, y: start.y }, 82),
      );
      mounted.canvas.dispatchEvent(
        pointerEvent('pointerup', { x: start.x - 96, y: start.y }, 81),
      );
      frames.settle();
      expect(mounted.pager.zoomFactor()).toBeGreaterThan(1);
      expect(mounted.stack.style.transform).toBe('');
      expect(JSON.stringify(mounted.model)).toBe(canonicalBefore);
    } finally {
      mounted.destroy();
    }
  });

  it('rapid ctrl-wheel ticks commit exactly once on debounce idle', async () => {
    const frames = new FrameDriver();
    const mounted = mountEmbedded({ frames });
    try {
      const canonicalBefore = JSON.stringify(mounted.model);
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
      wheel();
      expect(mounted.stack.style.transform).toContain('scale(');
      expect(mounted.pager.zoomFactor()).toBe(1);

      await new Promise((resolve) => setTimeout(resolve, 200));
      frames.settle();
      expect(mounted.pager.zoomFactor()).toBeCloseTo(Math.exp(0.4), 1);
      expect(mounted.stack.style.transform).toBe('');
      expect(frames.pending).toBe(0);
      expect(JSON.stringify(mounted.model)).toBe(canonicalBefore);
    } finally {
      mounted.destroy();
    }
  });

  it('background cancel discards while lost capture legalizes (cancel-vs-end race)', () => {
    const cancelFrames = new FrameDriver();
    let cancelDirty = 0;
    const cancelled = mountPager({
      frames: cancelFrames,
      markDirty: () => {
        cancelDirty += 1;
      },
    });
    try {
      const canonicalBefore = JSON.stringify(cancelled.model);
      cancelled.scroll.dispatchEvent(
        pointerEvent('pointerdown', { x: 300, y: 300 }, 1),
      );
      cancelFrames.advance(16);
      cancelled.scroll.dispatchEvent(
        pointerEvent('pointermove', { x: 500, y: 300 }, 1),
      );
      expect(cancelled.stack.style.transform).not.toBe('');
      // Stale end after the abort must be safe: no commit, no fling.
      cancelled.scroll.dispatchEvent(
        pointerEvent('pointercancel', { x: 500, y: 300 }, 1),
      );
      expect(cancelled.stack.style.transform).toBe('');
      expect(cancelFrames.pending).toBe(0);
      cancelled.scroll.dispatchEvent(
        pointerEvent('pointerup', { x: 500, y: 300 }, 1),
      );
      expect(cancelFrames.pending).toBe(0);
      expect(cancelled.stack.style.transform).toBe('');
      expectCanonicalClean(cancelled, canonicalBefore, cancelDirty);
    } finally {
      cancelled.destroy();
    }

    const lostFrames = new FrameDriver();
    let lostDirty = 0;
    const legalized = mountPager({
      frames: lostFrames,
      markDirty: () => {
        lostDirty += 1;
      },
    });
    try {
      const canonicalBefore = JSON.stringify(legalized.model);
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
      expect(lostFrames.pending).toBe(1);
      lostFrames.settle();
      expect(legalized.stack.style.transform).toBe('');
      expectCanonicalClean(legalized, canonicalBefore, lostDirty);
    } finally {
      legalized.destroy();
    }
  });

  it('embedded true cancel discards the pinch with no commit and rearms IO', async () => {
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
      mounted.canvas.dispatchEvent(
        pointerEvent('pointercancel', { x: start.x - 96, y: start.y }, 91),
      );
      expect(mounted.stack.style.transform).toBe('');
      mounted.canvas.dispatchEvent(
        pointerEvent('pointercancel', { x: start.x + 96, y: start.y }, 92),
      );
      expect(mounted.stack.style.transform).toBe('');
      expect(mounted.pager.zoomFactor()).toBe(zoomBefore);
      expect(dirtyCalls).toBe(0);
      expect(JSON.stringify(mounted.model)).toBe(canonicalBefore);
      await new Promise((resolve) => setTimeout(resolve, 200));
      frames.settle();
      expect(mounted.pager.zoomFactor()).toBe(zoomBefore);
      expect(frames.pending).toBe(0);
    } finally {
      mounted.destroy();
    }
  });

  it('1-2-1 handoff returns to pan without a scroll jump', () => {
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
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerup', { x: 620, y: 360 }, 2),
      );
      const committedTop = mounted.scroll.scrollTop;
      frames.advance(16);
      mounted.scroll.dispatchEvent(
        pointerEvent('pointermove', { x: 400, y: 330 }, 1),
      );
      expect(mounted.scroll.scrollTop).toBeGreaterThanOrEqual(committedTop);
      expect(mounted.scroll.scrollTop).toBe(panningAt);
      expect(previewTransform(mounted.stack).y).toBeCloseTo(-30, 6);
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerup', { x: 400, y: 330 }, 1),
      );
      frames.settle();
      expect(mounted.stack.style.transform).toBe('');
      expectCanonicalClean(mounted, canonicalBefore, dirtyCalls);
    } finally {
      mounted.destroy();
    }
  });

  it('third finger never moves the primary pair and middle-lift rebases without a jump', () => {
    const frames = new FrameDriver();
    const mounted = mountPager({ frames });
    try {
      const canonicalBefore = JSON.stringify(mounted.model);
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
      expect(afterThirdTouch.x).toBeCloseTo(beforeThirdTouch.x, 6);
      expect(afterThirdTouch.y).toBeCloseTo(beforeThirdTouch.y, 6);
      expect(afterThirdTouch.scale).toBeCloseTo(beforeThirdTouch.scale, 6);
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerup', { x: center.x + 1_000, y: center.y }, 3),
      );
      mounted.scroll.dispatchEvent(
        pointerEvent('pointermove', { x: center.x + 140, y: center.y }, 2),
      );
      const beforeLift = previewTransform(mounted.stack);
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerup', { x: center.x + 140, y: center.y }, 2),
      );
      // Survivor (1) keeps the preview open; release the last finger.
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerup', { x: center.x - 100, y: center.y }, 1),
      );
      frames.settle();
      expect(mounted.stack.style.transform).toBe('');
      expect(beforeLift.scale).toBeGreaterThan(0);
      expect(JSON.stringify(mounted.model)).toBe(canonicalBefore);
    } finally {
      mounted.destroy();
    }
  });

  it('reduced-motion full matrix snaps immediately with zero residue', () => {
    // Pan overscroll.
    {
      const frames = new FrameDriver();
      let dirtyCalls = 0;
      const mounted = mountPager({
        frames,
        reducedMotion: true,
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
        mounted.scroll.dispatchEvent(
          pointerEvent('pointerup', { x: 500, y: 300 }, 1),
        );
        expect(mounted.stack.style.transform).toBe('');
        expect(frames.pending).toBe(0);
        expectCanonicalClean(mounted, canonicalBefore, dirtyCalls);
      } finally {
        mounted.destroy();
      }
    }
    // Overzoom and underzoom clamp synchronously.
    for (const zoom of [8, 0.25]) {
      const frames = new FrameDriver();
      let dirtyCalls = 0;
      const mounted = mountPager({
        frames,
        reducedMotion: true,
        markDirty: () => {
          dirtyCalls += 1;
        },
      });
      try {
        const canonicalBefore = JSON.stringify(mounted.model);
        mounted.pager.setZoomFactor(zoom);
        const center = pagePoint(mounted.shells[0]!);
        performPinch(mounted.scroll, center, zoom === 8 ? 2 : 0.5, {
          x: 0,
          y: 0,
        });
        expect(mounted.pager.zoomFactor()).toBe(zoom);
        expect(frames.pending).toBe(0);
        expect(mounted.stack.style.transform).toBe('');
        expectCanonicalClean(mounted, canonicalBefore, dirtyCalls);
      } finally {
        mounted.destroy();
      }
    }
    // Embedded reduced-motion pan.
    {
      const frames = new FrameDriver();
      let dirtyCalls = 0;
      const mounted = mountEmbedded({
        frames,
        reducedMotion: true,
        markDirty: () => {
          dirtyCalls += 1;
        },
      });
      try {
        const canonicalBefore = JSON.stringify(mounted.model);
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
        expectCanonicalClean(mounted, canonicalBefore, dirtyCalls);
      } finally {
        mounted.destroy();
      }
    }
  });

  it('read-only flip mid-flight cancels motion with zero commit', () => {
    // Flip during gutter decay.
    {
      const frames = new FrameDriver();
      let dirtyCalls = 0;
      const mounted = mountPager({
        frames,
        markDirty: () => {
          dirtyCalls += 1;
        },
      });
      const canonicalBefore = JSON.stringify(mounted.model);
      try {
        mounted.scroll.scrollTop = 500;
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
        mounted.pager.setReadOnly(true);
        expect(frames.pending).toBe(0);
        expect(mounted.stack.style.transform).toBe('');
        expectCanonicalClean(mounted, canonicalBefore, dirtyCalls);
        mounted.pager.setReadOnly(false);
      } finally {
        mounted.destroy();
      }
    }
    // Flip during an open pinch preview.
    {
      const frames = new FrameDriver();
      let dirtyCalls = 0;
      const mounted = mountEmbedded({
        frames,
        markDirty: () => {
          dirtyCalls += 1;
        },
      });
      const canonicalBefore = JSON.stringify(mounted.model);
      const zoomBefore = mounted.pager.zoomFactor();
      try {
        mounted.canvas.dispatchEvent(
          pointerEvent('pointerdown', { x: 300, y: 300 }, 43),
        );
        mounted.canvas.dispatchEvent(
          pointerEvent('pointermove', { x: 500, y: 300 }, 43),
        );
        mounted.pager.setReadOnly(true);
        expect(mounted.stack.style.transform).toBe('');
        expect(frames.pending).toBe(0);
        expect(mounted.pager.zoomFactor()).toBe(zoomBefore);
        expectCanonicalClean(mounted, canonicalBefore, dirtyCalls);
      } finally {
        mounted.destroy();
      }
    }
  });

  it('destroy mid-gesture leaves zero frames, clean transform, no commit', () => {
    // Destroy during an active pan.
    {
      const frames = new FrameDriver();
      const mounted = mountPager({ frames });
      const canonicalBefore = JSON.stringify(mounted.model);
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerdown', { x: 300, y: 300 }, 1),
      );
      frames.advance(16);
      mounted.scroll.dispatchEvent(
        pointerEvent('pointermove', { x: 500, y: 300 }, 1),
      );
      expect(() => mounted.destroy()).not.toThrow();
      expect(frames.pending).toBe(0);
      expect(JSON.stringify(mounted.model)).toBe(canonicalBefore);
      document.body.replaceChildren();
    }
    // Destroy during an open pinch preview.
    {
      const frames = new FrameDriver();
      const mounted = mountPager({ frames });
      const canonicalBefore = JSON.stringify(mounted.model);
      const center = pagePoint(mounted.shells[1]!);
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerdown', { x: center.x - 80, y: center.y }, 1),
      );
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerdown', { x: center.x + 80, y: center.y }, 2),
      );
      mounted.scroll.dispatchEvent(
        pointerEvent('pointermove', { x: center.x + 120, y: center.y }, 2),
      );
      expect(mounted.stack.style.transform).toContain('scale(');
      expect(() => mounted.destroy()).not.toThrow();
      expect(frames.pending).toBe(0);
      expect(JSON.stringify(mounted.model)).toBe(canonicalBefore);
      document.body.replaceChildren();
    }
    // Destroy during decay.
    {
      const frames = new FrameDriver();
      const mounted = mountPager({ frames });
      const canonicalBefore = JSON.stringify(mounted.model);
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
      expect(() => mounted.destroy()).not.toThrow();
      expect(frames.pending).toBe(0);
      expect(JSON.stringify(mounted.model)).toBe(canonicalBefore);
      document.body.replaceChildren();
    }
  });

  it('live preview writes transform-only with bounded geometry reads and a single motion frame', () => {
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
      const center = pagePoint(mounted.shells[1]!);
      let geometryReads = 0;
      for (const shell of mounted.shells) {
        const measure = shell.getBoundingClientRect.bind(shell);
        shell.getBoundingClientRect = () => {
          geometryReads += 1;
          return measure();
        };
      }
      const schedulesBefore = frames.scheduleCount;
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
      // No per-move layout: shell widths untouched, no shell geometry reads.
      expect(geometryReads).toBe(readsAtStart);
      expect(mounted.shells.map((shell) => shell.style.width)).toEqual(
        settledWidths,
      );
      // Single motion-frame ownership: at most one pending frame, and the
      // schedule count never exceeds moves+release (no second rAF forked).
      expect(frames.pending).toBeLessThanOrEqual(1);
      expect(frames.scheduleCount - schedulesBefore).toBeLessThanOrEqual(2);
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerup', { x: center.x + 128, y: center.y }, 2),
      );
      mounted.scroll.dispatchEvent(
        pointerEvent('pointerup', { x: center.x - 80, y: center.y }, 1),
      );
      frames.settle();
      expect(mounted.stack.style.transform).toBe('');
      expect(frames.pending).toBe(0);
      expectCanonicalClean(mounted, canonicalBefore, dirtyCalls);
    } finally {
      mounted.destroy();
    }
  });
});
