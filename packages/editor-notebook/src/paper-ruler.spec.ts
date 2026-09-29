/**
 * Notebook slice 10 pager ergonomics: per-page paper options, standard
 * sizes/orientation, and the ephemeral straightedge ruler.
 *
 * Uses the same test-only React chrome pattern as editor.spec.ts: production
 * mounts go through the provider; these tests
 * commit the same chrome first and hand it over via `host`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import {
  appendPage,
  boundedFrame,
  emptyNotebook,
  emptySurface,
  notebookPage,
  paperOptionsOf,
  type NotebookModel,
} from '@froglight/foundation';
import {
  mountNotebook,
  type NotebookPagerHandle,
  type NotebookPagerOptions,
} from './pager.js';
import {
  NotebookChrome,
  type NotebookPagerSkeleton,
} from './react/NotebookChrome.jsx';

function mountUiPager(
  parent: HTMLElement,
  options: Omit<NotebookPagerOptions, 'host'>,
): NotebookPagerHandle {
  const chromeRef: { current: NotebookPagerSkeleton | null } = {
    current: null,
  };
  const root = createRoot(parent);
  flushSync(() => {
    root.render(createElement(NotebookChrome, { chromeRef }));
  });
  const skeleton = chromeRef.current;
  if (skeleton === null) throw new Error('test chrome failed to commit');
  const pager = mountNotebook({ ...options, host: skeleton });
  let disposed = false;
  return {
    ...pager,
    destroy: () => {
      if (disposed) return;
      disposed = true;
      root.unmount();
      pager.destroy();
    },
  };
}

function installCanvasStub(): () => void {
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
    return context as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
  return () => {
    HTMLCanvasElement.prototype.getContext = original;
  };
}

function pointerEvent(
  type: string,
  x: number,
  y: number,
  pointerId = 1,
  pointerType = 'mouse',
): Event {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
  });
  Object.defineProperty(event, 'pointerId', { value: pointerId });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  Object.defineProperty(event, 'pressure', { value: 0.5 });
  return event;
}

function fixture(): NotebookModel {
  const model = emptyNotebook('Paper fixture');
  appendPage(
    model,
    notebookPage('p1', {
      template: 'froglight.lined',
      surface: emptySurface(boundedFrame(800, 600)),
    }),
  );
  return model;
}

function strokeYs(model: NotebookModel, pageId: string): number[] {
  const page = model.pages[pageId];
  if (page?.kind !== 'page') throw new Error('expected a navigable page');
  const id = page.surface.order.at(-1);
  const record = page.surface.objects[id!] as
    | { points?: { y: number }[] }
    | undefined;
  return (record?.points ?? []).map((p) => p.y);
}

describe('notebook paper options', () => {
  let restoreCanvas: (() => void) | null = null;

  beforeEach(() => {
    restoreCanvas = installCanvasStub();
  });

  afterEach(() => {
    restoreCanvas?.();
    restoreCanvas = null;
    document.body.replaceChildren();
  });

  it('reads absent paper as template defaults', () => {
    const parent = document.createElement('div');
    const pager = mountUiPager(parent, {
      model: fixture(),
      markDirty: () => undefined,
    });
    expect(pager.paperOptions()).toBeUndefined();
    pager.destroy();
  });

  it('stores paper options canonically and marks the session dirty', () => {
    const parent = document.createElement('div');
    const model = fixture();
    let dirty = 0;
    const pager = mountUiPager(parent, {
      model,
      markDirty: () => (dirty += 1),
    });
    pager.setPaperOptions({ spacing: 56, paperColor: '#faf7ef' });
    expect(dirty).toBe(1);
    expect(paperOptionsOf(model.pages.p1 as never)).toEqual({
      spacing: 56,
      paperColor: '#faf7ef',
    });
    // The page stays mounted and drawable after the paper remount.
    expect(parent.querySelectorAll('.fl-ps')).toHaveLength(1);
    pager.setPaperOptions(undefined);
    expect(dirty).toBe(2);
    expect(paperOptionsOf(model.pages.p1 as never)).toBeUndefined();
    pager.destroy();
  });

  it('ignores invalid paper without touching canonical state', () => {
    const parent = document.createElement('div');
    const model = fixture();
    let dirty = 0;
    const pager = mountUiPager(parent, {
      model,
      markDirty: () => (dirty += 1),
    });
    pager.setPaperOptions({ spacing: -5 });
    expect(dirty).toBe(0);
    expect(paperOptionsOf(model.pages.p1 as never)).toBeUndefined();
    pager.destroy();
  });

  it('inherits the current paper when adding pages', () => {
    const parent = document.createElement('div');
    const model = fixture();
    const pager = mountUiPager(parent, {
      model,
      markDirty: () => undefined,
    });
    pager.setPaperOptions({ spacing: 64 });
    const added = pager.addPage('froglight.lined');
    expect(paperOptionsOf(model.pages[added] as never)).toEqual({
      spacing: 64,
    });
    pager.destroy();
  });
});

describe('notebook page sizes and orientation', () => {
  let restoreCanvas: (() => void) | null = null;

  beforeEach(() => {
    restoreCanvas = installCanvasStub();
  });

  afterEach(() => {
    restoreCanvas?.();
    restoreCanvas = null;
    document.body.replaceChildren();
  });

  it('applies a standard size preset to the current page', () => {
    const parent = document.createElement('div');
    const model = fixture();
    let dirty = 0;
    const pager = mountUiPager(parent, {
      model,
      markDirty: () => (dirty += 1),
    });
    expect(pager.applyPageSize('froglight.square')).toBe(true);
    expect(pager.currentPageSize()).toEqual({ width: 1240, height: 1240 });
    expect(dirty).toBe(1);
    expect(pager.applyPageSize('nope.size')).toBe(false);
    pager.destroy();
  });

  it('portraits and landscapes the current page by swapping sides', () => {
    const parent = document.createElement('div');
    const model = fixture();
    const pager = mountUiPager(parent, {
      model,
      markDirty: () => undefined,
    });
    // Fixture is 800x600 landscape: portrait swaps, landscape is a no-op.
    expect(pager.setPageOrientation('portrait')).toBe(true);
    expect(pager.currentPageSize()).toEqual({ width: 600, height: 800 });
    expect(pager.setPageOrientation('landscape')).toBe(true);
    expect(pager.currentPageSize()).toEqual({ width: 800, height: 600 });
    pager.destroy();
  });
});

describe('notebook ruler', () => {
  let restoreCanvas: (() => void) | null = null;

  beforeEach(() => {
    restoreCanvas = installCanvasStub();
  });

  afterEach(() => {
    restoreCanvas?.();
    restoreCanvas = null;
    document.body.replaceChildren();
  });

  it('starts hidden and never enters canonical data', () => {
    const parent = document.createElement('div');
    const model = fixture();
    let dirty = 0;
    const pager = mountUiPager(parent, {
      model,
      markDirty: () => (dirty += 1),
    });
    expect(pager.rulerState()).toBeNull();
    pager.setRuler({ visible: true, x: 400, y: 300, angle: 0, length: 400 });
    expect(dirty).toBe(0);
    expect(pager.rulerState()).toMatchObject({ visible: true, y: 300 });
    expect(JSON.stringify(model)).not.toContain('ruler');
    pager.setRuler(null);
    expect(pager.rulerState()).toBeNull();
    expect(dirty).toBe(0);
    pager.destroy();
  });

  it('snaps pen strokes started near the edge into straight ink', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const model = fixture();
    let dirty = 0;
    const pager = mountUiPager(parent, {
      model,
      markDirty: () => (dirty += 1),
    });
    pager.centerRuler();
    expect(pager.rulerState()).toMatchObject({ visible: true });
    const canvas = parent.querySelector('.fl-ps canvas');
    expect(canvas).not.toBeNull();
    // Near the centered horizontal edge (segment x∈[200,600] at y=300):
    // the committed stroke is straight. The down point starts inside the
    // finite segment — beyond-endpoint starts must not latch.
    canvas!.dispatchEvent(pointerEvent('pointerdown', 250, 305));
    canvas!.dispatchEvent(pointerEvent('pointermove', 400, 296));
    canvas!.dispatchEvent(pointerEvent('pointerup', 550, 304));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const ys = strokeYs(model, 'p1');
    expect(ys.length).toBeGreaterThan(1);
    for (const y of ys) expect(y).toBeCloseTo(300, 0);
    expect(dirty).toBe(1);
    pager.destroy();
  });

  it('centers a horizontal ruler on the current page', () => {
    const parent = document.createElement('div');
    const pager = mountUiPager(parent, {
      model: fixture(),
      markDirty: () => undefined,
    });
    pager.centerRuler();
    // Fixture page is 800x600: center (400, 300), horizontal edge.
    expect(pager.rulerState()).toMatchObject({
      visible: true,
      x: 400,
      y: 300,
      angle: 0,
    });
    pager.destroy();
  });
});
