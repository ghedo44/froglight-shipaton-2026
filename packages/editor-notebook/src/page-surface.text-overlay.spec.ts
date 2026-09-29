/**
 * Page-surface text-overlay seam (..).
 *
 * Colocated with `page-surface.ts`: the engine-owned dynamic page host
 * mirrors the React skeleton hooks (including the React-owned
 * `fl-ink-text-overlay-root` container), the Notebook text tool id still
 * translates to the Ink engine id, and a pending overlay commits (never
 * discards) on pager teardown.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendPage,
  emptyNotebook,
  emptySurface,
  boundedFrame,
  notebookPage,
  InMemoryStylusService,
  type NotebookModel,
} from '@froglight/foundation';
import {
  createPageInkHost,
  mountPageSurface,
  PAGE_TOOL_IDS,
} from './page-surface.js';
import { INK_TOOL_IDS } from '@froglight/editor-ink';

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
    closePath: noop,
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

function pointerEvent(type: string, x: number, y: number): Event {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
  });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  Object.defineProperty(event, 'pointerType', { value: 'mouse' });
  Object.defineProperty(event, 'pressure', { value: 0.5 });
  return event;
}

function fixture(): NotebookModel {
  const model = emptyNotebook('Page-surface overlay fixture');
  appendPage(
    model,
    notebookPage('p1', { surface: emptySurface(boundedFrame(800, 600)) }),
  );
  return model;
}

let restoreCanvas: (() => void) | null = null;

beforeEach(() => {
  restoreCanvas?.();
  restoreCanvas = installCanvasStub();
});

afterEach(() => {
  restoreCanvas?.();
  restoreCanvas = null;
  document.body.replaceChildren();
});

describe('page-surface text overlay seam', () => {
  it('engine-owned page hosts expose the React-parity overlay container', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const host = createPageInkHost(parent, false);
    expect(host.root.className).toBe('fl-ink-root');
    expect(host.page.querySelector('.fl-ink-canvas')).toBe(host.canvas);
    expect(host.page.querySelector('.fl-ink-badge')).toBe(host.badge);
    expect(host.page.querySelector('.fl-ink-pointer-indicator')).toBe(
      host.pointerIndicator,
    );
    // the overlay container mirrors InkSurfaceSkeleton.
    // `createPageInkHost` always commits it; the `| undefined` is only
    // the legacy-host tolerance on the shared `InkSkeleton` seam.
    const overlayRoot = host.overlayRoot;
    if (overlayRoot === undefined) throw new Error('expected overlayRoot');
    expect(overlayRoot.className).toBe('fl-ink-text-overlay-root');
    expect(host.page.contains(overlayRoot)).toBe(true);
    parent.remove();
  });

  it('keeps the Notebook text tool id translating to the Ink engine id', () => {
    expect(PAGE_TOOL_IDS.text).toBe('froglight.notebook.text');
    expect(INK_TOOL_IDS.text).not.toBe(PAGE_TOOL_IDS.text);
  });

  it('commits a pending overlay on destroy instead of discarding it', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const model = fixture();
    const page = model.pages.p1;
    if (page?.kind !== 'page') throw new Error('expected a navigable page');
    const host = createPageInkHost(parent, false);
    const stylusInput = new InMemoryStylusService();
    const surface = mountPageSurface({
      model: page.surface,
      markDirty: () => undefined,
      host,
      stylusInput,
    });
    expect(stylusInput.inputContext()).toBe('drawing');
    surface.setTool(PAGE_TOOL_IDS.text);
    expect(surface.activeToolId()).toBe(PAGE_TOOL_IDS.text);
    const canvas = parent.querySelector('.fl-ink-text-overlay-root')
      ? parent.querySelector('canvas')!
      : parent.querySelector('canvas')!;
    canvas.dispatchEvent(pointerEvent('pointerdown', 30, 40));
    const input = parent.querySelector<HTMLInputElement>('.fl-ink-text-input');
    expect(input).not.toBeNull();
    expect(stylusInput.inputContext()).toBe('text-entry');
    // The ephemeral editor mounts inside the overlay container.
    const overlayRoot = host.overlayRoot;
    if (overlayRoot === undefined) throw new Error('expected overlayRoot');
    expect(overlayRoot.contains(input)).toBe(true);
    input!.value = 'page text';
    surface.destroy();
    expect(stylusInput.inputContext()).toBe('default');

    const texts = Object.values(page.surface.objects).map(
      (object) => (object as unknown as Record<string, unknown>).text as string,
    );
    expect(texts).toContain('page text');
    parent.remove();
  });

  it('releases a remounted page independently and ignores read-only page previews', () => {
    const stylusInput = new InMemoryStylusService();
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const mount = (readOnly = false) => mountPageSurface({
      model: emptySurface(boundedFrame(800, 600)),
      markDirty: () => undefined,
      host: createPageInkHost(parent, false),
      stylusInput,
      readOnly,
    });
    const preview = mount(true);
    expect(stylusInput.inputContext()).toBe('default');
    const first = mount();
    const replacement = mount();
    first.destroy();
    expect(stylusInput.inputContext()).toBe('drawing');
    replacement.destroy();
    preview.destroy();
    expect(stylusInput.inputContext()).toBe('default');
    parent.remove();
  });
});
