/**
 * Notebook provider conformance at the generic editor seam:
 * the Canvas adapter mounts the pager, commits a pen gesture into the
 * canonical page surface, and keeps undo/redo provider-local.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendPage,
  boundedFrame,
  emptyNotebook,
  emptySurface,
  imageObject,
  isNavigablePage,
  navigablePageIds,
  notebookPage,
  pdfNotebookPage,
  sha256Hex,
  workspacePath,
  type PdfProvider,
  type NotebookModel,
} from '@froglight/foundation';
import { type DecodedImage } from '@froglight/editor-ink';
import {
  mountNotebook,
  NotebookDocumentEditorProvider,
  PAGE_TOOL_IDS,
  exportSurfacePng,
  type NotebookPagerHandle,
  type NotebookPagerOptions,
} from './index.js';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import {
  NotebookChrome,
  type NotebookPagerSkeleton,
} from './react/NotebookChrome.jsx';
import notebookChromeCss from './react/NotebookChrome.css?inline';

/**
 * Test-only React chrome for direct pager mounts:
 * production mounts go through NotebookDocumentEditorProvider; these
 * characterization tests commit the same React chrome first and hand it
 * over via `host`, preserving the synchronous creation contract.
 */
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
  const model = emptyNotebook('Provider fixture');
  const page = notebookPage('p1', {
    surface: emptySurface(boundedFrame(800, 600)),
  });
  page.surface.objects.img = imageObject('img', {
    x: 100,
    y: 100,
    width: 80,
    height: 60,
    src: 'attachments/image',
    sha256: 'hash',
  });
  page.surface.order.push('img');
  appendPage(model, page);
  return model;
}

/**
 * Settle the animated zoom-spring with real rAF (async
 * contract): `setZoomFactor`/`zoom-slider` arm the single zoom-spring frame;
 * `zoomFactor()` (and the toolbar snapshot derived from it) stays stale at
 * the committed value until the spring commits. Pump real rAF + a macrotask
 * until the committed value reaches `expected` (no product rollback —
 * intentional async contract).
 */
async function settleRealZoomValue(
  read: () => number,
  expected: number,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Math.abs(read() - expected) > 0.005) {
    if (Date.now() > deadline) break;
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 16));
  }
}

describe('NotebookDocumentEditorProvider', () => {
  let restoreCanvas: (() => void) | null = null;

  beforeEach(() => {
    restoreCanvas = installCanvasStub();
  });

  afterEach(() => {
    restoreCanvas?.();
    restoreCanvas = null;
    document.body.replaceChildren();
  });

  it('mounts the pager and commits a pen gesture through the provider seam', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const model = fixture();
    let dirty = 0;
    const handle = new NotebookDocumentEditorProvider().createEditor({
      session: {
        model,
        markDirty: () => {
          dirty += 1;
        },
      } as never,
      parent,
    });
    const canvas = parent.querySelector('.fl-ps canvas');

    expect(canvas).not.toBeNull();
    canvas!.dispatchEvent(pointerEvent('pointerdown', 10, 10));
    canvas!.dispatchEvent(pointerEvent('pointermove', 40, 30));
    canvas!.dispatchEvent(pointerEvent('pointerup', 60, 40));
    await new Promise((resolve) => requestAnimationFrame(resolve));

    const page = model.pages.p1;
    if (page?.kind !== 'page') throw new Error('expected a navigable page');
    expect(page.surface.order).toHaveLength(2);
    expect(dirty).toBe(1);
    expect(handle.execCommand('undo')).toBe(true);
    expect(page.surface.order).toHaveLength(1);
    expect(handle.execCommand('redo')).toBe(true);
    expect(page.surface.order).toHaveLength(2);

    handle.destroy();
    expect(parent.querySelector('.fl-nb')).toBeNull();
  });

  it('keeps pager page operations on the canonical model', () => {
    const parent = document.createElement('div');
    const model = fixture();
    const pager = mountUiPager(parent, { model, markDirty: () => undefined });

    expect(pager.pageCount()).toBe(1);
    // No runtime style injection: the pager rules ship with the colocated
    // React chrome stylesheet under the components layer (jsdom drops
    // `@layer` blocks, so layer precedence itself is pinned by the
    // production Chromium suite, not by computed styles here).
    expect(notebookChromeCss).toContain('.fl-nb');
    expect(notebookChromeCss).toContain('width: 100%');
    expect(notebookChromeCss).toContain('height: 100%');
    expect(notebookChromeCss).toContain('@layer components');
    expect(document.querySelector('#fl-notebook-styles')).toBeNull();
    expect(parent.querySelectorAll('.fl-ps')).toHaveLength(1);
    expect(
      parent.querySelector<HTMLElement>('.fl-ps')?.dataset.presentation,
    ).toBe('embedded-paper');
    expect(pager.root.querySelector('.fl-nb-bar')).toBeNull();
    pager.jumpToPage(0);
    pager.setTool(PAGE_TOOL_IDS.eraser);
    model.pages.opaque = {
      kind: 'opaque',
      id: 'opaque',
      raw: { id: 'opaque', future: true },
    };
    model.pageOrder.unshift('opaque');
    const added = pager.addPage('froglight.lined');
    expect(model.pageOrder).toEqual(['opaque', 'p1', added]);
    expect(parent.querySelectorAll('.fl-nb-shell')).toHaveLength(2);
    expect(parent.querySelectorAll('.fl-ps')).toHaveLength(1);
    expect(pager.activeToolId()).toBe(PAGE_TOOL_IDS.eraser);
    expect(pager.duplicatePage(0)).not.toBeNull();
    expect(pager.pageCount()).toBe(3);
    expect(pager.deletePage(1)).toBe(true);
    expect(pager.pageCount()).toBe(2);

    pager.destroy();
  });

  it('exposes a compact notebook zoom-reset showing the stack zoom', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const model = fixture();
    const handle = new NotebookDocumentEditorProvider().createEditor({
      session: { model, markDirty: () => undefined } as never,
      parent,
    });
    const tools = handle.tools!;
    const zoomValue = (): number => {
      const control = tools
        .snapshot()
        .controls.find((c) => c.id === 'notebook.zoom') as unknown as {
        value?: unknown;
      };
      return typeof control?.value === 'number' ? control.value : Number.NaN;
    };
    expect(tools.execute('notebook.zoom-slider', '150')).toBe(true);
    // (async contract): the slider arms the zoom-spring;
    // the snapshot stays stale at 100% until the spring settles.
    await settleRealZoomValue(zoomValue, 150);
    const reset = tools
      .snapshot()
      .controls.find((control) => control.id === 'notebook.zoom-reset');
    expect(reset).toMatchObject({ kind: 'button' });
    expect((reset as { label: string }).label).toContain('150%');
    expect(tools.execute('notebook.zoom-reset')).toBe(true);
    await settleRealZoomValue(zoomValue, 100);
    expect(
      tools.snapshot().controls.find((c) => c.id === 'notebook.zoom'),
    ).toMatchObject({ kind: 'number', value: 100 });
    handle.destroy();
  });

  it.each([
    ['before', 'notebook.insert-pdf-before', 0],
    ['after', 'notebook.insert-pdf-after', 1],
  ] as const)(
    'inserts a selected PDF %s the current page through the document tools',
    async (_position, commandId, expectedBoundary) => {
      const parent = document.createElement('div');
      document.body.appendChild(parent);
      const model = fixture();
      const boundaries: number[] = [];
      const handle = new NotebookDocumentEditorProvider().createEditor({
        session: { model, markDirty: () => undefined } as never,
        parent,
        importPdf: async (notebook, _bytes, at) => {
          boundaries.push(at);
          const imported = notebookPage(`pdf-${at}`);
          notebook.pages[imported.id] = imported;
          notebook.pageOrder.splice(at, 0, imported.id);
        },
      });
      expect(handle.tools?.execute(commandId)).toBe(true);
      const input = parent.querySelector<HTMLInputElement>(
        'input[type="file"][accept*="pdf"]',
      );
      expect(input).not.toBeNull();
      const file = new File([new Uint8Array([37, 80, 68, 70])], 'fixture.pdf', {
        type: 'application/pdf',
      });
      Object.defineProperty(file, 'arrayBuffer', {
        value: async () => new Uint8Array([37, 80, 68, 70]).buffer,
      });
      Object.defineProperty(input!, 'files', {
        configurable: true,
        value: [file],
      });
      input!.dispatchEvent(new Event('change'));
      for (
        let attempt = 0;
        attempt < 20 && boundaries.length === 0;
        attempt += 1
      ) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      expect(boundaries).toEqual([expectedBoundary]);
      expect(model.pageOrder[expectedBoundary]).toBe(`pdf-${expectedBoundary}`);
      handle.destroy();
    },
  );

  it('surfaces a failed PDF insertion instead of making the command appear inert', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const handle = new NotebookDocumentEditorProvider().createEditor({
      session: { model: fixture(), markDirty: () => undefined } as never,
      parent,
      importPdf: async () => {
        throw new Error('fixture import failed');
      },
    });
    expect(handle.tools?.execute('notebook.insert-pdf-after')).toBe(true);
    const input = parent.querySelector<HTMLInputElement>(
      'input[type="file"][accept*="pdf"]',
    )!;
    const file = new File([new Uint8Array([37, 80, 68, 70])], 'fixture.pdf');
    Object.defineProperty(file, 'arrayBuffer', {
      value: async () => new Uint8Array([37, 80, 68, 70]).buffer,
    });
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [file],
    });
    input.dispatchEvent(new Event('change'));
    for (
      let attempt = 0;
      attempt < 20 &&
      !parent
        .querySelector('[role="alert"]')
        ?.textContent?.includes('fixture import failed');
      attempt += 1
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    expect(parent.querySelector('[role="alert"]')?.textContent).toContain(
      'fixture import failed',
    );
    handle.destroy();
  });

  it('layers a lazy PDF base beneath Surface content and isolates Source Select gestures', async () => {
    const parent = document.createElement('div');
    const bytes = new Uint8Array([37, 80, 68, 70]);
    const hash = await sha256Hex(bytes);
    const asset = { path: workspacePath(`attachments/${hash}`), sha256: hash };
    const model = emptyNotebook();
    appendPage(
      model,
      pdfNotebookPage('pdf', {
        asset,
        pageIndex: 0,
        pageBox: { widthPt: 300, heightPt: 200 },
      }),
    );
    let closed = 0;
    const renderScales: number[] = [];
    const pdfProvider: PdfProvider = {
      async open() {
        return {
          pageCount: 1,
          getPageInfo: async () => ({
            pageIndex: 0,
            geometry: {
              effectiveBox: { minX: 0, minY: 0, maxX: 300, maxY: 200 },
              userUnit: 1,
              rotate: 0,
              pageBox: { widthPt: 300, heightPt: 200 },
            },
            hasSourceText: true,
          }),
          getPageText: async () => ({
            kind: 'source',
            items: [{ text: 'source' }],
          }),
          getOutline: async () => [
            { id: 'chapter', title: 'Chapter one', pageIndex: 0, children: [] },
          ],
          getLinks: async () => [],
          mountPage: async ({ parent: mountParent, onLinkActivate, scale }) => {
            renderScales.push(scale);
            const pageRoot = document.createElement('div');
            pageRoot.className = 'fl-pdf-page';
            const layer = document.createElement('span');
            layer.className = 'test-pdf-source';
            const external = document.createElement('button');
            external.className = 'test-external-link';
            external.addEventListener('click', () =>
              onLinkActivate?.({
                kind: 'external',
                url: 'https://example.test',
              }),
            );
            pageRoot.append(layer, external);
            (mountParent as HTMLElement).appendChild(pageRoot);
            return {
              setSourceInteractionEnabled(enabled) {
                layer.dataset.sourceEnabled = String(enabled);
              },
              destroy() {
                pageRoot.remove();
              },
            };
          },
          close: async () => {
            closed += 1;
          },
        };
      },
    };
    const externalLinks: string[] = [];
    const pager = mountUiPager(parent, {
      model,
      markDirty: () => undefined,
      pdfProvider,
      assets: {
        put: async () => {
          throw new Error(
            'page operations must not duplicate the source asset',
          );
        },
        read: async () => bytes.slice(),
      },
      openExternalLink: (url) => void externalLinks.push(url),
    });
    for (
      let attempt = 0;
      attempt < 20 &&
      (parent.querySelector('.test-pdf-source') === null ||
        pager.sourceOutline().length === 0);
      attempt += 1
    ) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    expect(parent.querySelector('.fl-nb-pdf-base')).not.toBeNull();
    expect(renderScales[0]).toBeGreaterThan(1);
    expect(parent.querySelector('.test-pdf-source')).not.toBeNull();
    const surface = parent.querySelector<HTMLElement>('.fl-ps')!;
    const baseLayer = parent.querySelector<HTMLElement>('.fl-nb-pdf-base')!;
    const pdfPage = parent.querySelector<HTMLElement>('.fl-pdf-page')!;
    expect(surface.style.zIndex).toBe('1');
    expect(surface.dataset.presentation).toBe('embedded-overlay');
    expect(baseLayer.style.pointerEvents).toBe('none');
    expect(pdfPage.style.transform).toBe('scale(1)');
    expect(pager.sourceOutline()).toEqual([
      { pageId: 'pdf', label: 'Chapter one' },
    ]);
    parent.querySelector<HTMLButtonElement>('.test-external-link')?.click();
    expect(externalLinks).toEqual(['https://example.test']);

    pager.setSourceInteractionMode('source-select');
    expect(surface.style.pointerEvents).toBe('none');
    expect(baseLayer.style.pointerEvents).toBe('auto');
    expect(
      parent.querySelector<HTMLElement>('.test-pdf-source')?.dataset
        .sourceEnabled,
    ).toBe('true');

    pager.setTool(PAGE_TOOL_IDS.pen);
    expect(surface.style.pointerEvents).toBe('auto');
    expect(baseLayer.style.pointerEvents).toBe('none');

    pager.setZoomFactor(1.5);
    // (async contract): the programmatic zoom animates via
    // the zoom-spring — `syncBaseScale` (pdfPage transform) only runs at the
    // settled commit, so settle real-rAF before asserting the 1.5x base.
    await settleRealZoomValue(() => pager.zoomFactor(), 1.5);
    expect(Number.parseFloat(pdfPage.style.transform.slice(6))).toBeCloseTo(
      1.5,
    );
    // The heavier PDF remount debounces 100ms past the layout commit, then
    // recomputes renderScale (≈4.2) and resets the CSS transform to 1.
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    expect(renderScales.at(-1)).toBeCloseTo(4.2);
    expect(
      parent.querySelector<HTMLElement>('.fl-pdf-page')?.style.transform,
    ).toBe('scale(1)');

    const copyId = pager.duplicatePage(0)!;
    expect(model.pages[copyId]).toMatchObject({
      kind: 'page',
      record: { base: { kind: 'pdf-page', asset, pageIndex: 0 } },
    });
    expect(pager.deletePage(1)).toBe(true);
    pager.destroy();
    await Promise.resolve();
    expect(closed).toBe(1);
  });

  it('uses the normal Select tool for selectable PDF source text', () => {
    const parent = document.createElement('div');
    const model = emptyNotebook();
    appendPage(
      model,
      pdfNotebookPage('pdf', {
        asset: {
          path: workspacePath('attachments/source.pdf'),
          sha256: 'source-hash',
        },
        pageIndex: 0,
        pageBox: { widthPt: 300, heightPt: 200 },
      }),
    );
    const handle = new NotebookDocumentEditorProvider().createEditor({
      session: { model, markDirty: () => undefined } as never,
      parent,
    });
    const surface = parent.querySelector<HTMLElement>('.fl-ps');
    expect(surface?.style.pointerEvents).toBe('auto');
    expect(handle.tools?.execute(`notebook.tool.${PAGE_TOOL_IDS.select}`)).toBe(
      true,
    );
    expect(surface?.style.pointerEvents).toBe('none');
    handle.destroy();
  });

  it('mounts page editors only when their shell intersects the notebook viewport', async () => {
    const previous = Object.getOwnPropertyDescriptor(
      globalThis,
      'IntersectionObserver',
    );
    let notify: IntersectionObserverCallback = () => undefined;
    let observedOptions: IntersectionObserverInit | undefined;
    class VisiblePageObserver {
      readonly root = null;
      readonly rootMargin = '';
      readonly thresholds = [0];
      constructor(
        callback: IntersectionObserverCallback,
        options?: IntersectionObserverInit,
      ) {
        notify = callback;
        observedOptions = options;
      }
      observe(): undefined {
        return undefined;
      }
      unobserve(): undefined {
        return undefined;
      }
      disconnect(): undefined {
        return undefined;
      }
      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }
    }
    Object.defineProperty(globalThis, 'IntersectionObserver', {
      configurable: true,
      value: VisiblePageObserver,
    });
    try {
      const parent = document.createElement('div');
      const model = emptyNotebook();
      appendPage(model, notebookPage('one'));
      appendPage(model, notebookPage('two'));
      appendPage(model, notebookPage('three'));
      const pager = mountUiPager(parent, {
        model,
        markDirty: () => undefined,
      });
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve()),
      );
      expect(parent.querySelectorAll('.fl-ps')).toHaveLength(0);
      expect(observedOptions?.rootMargin).toBe('0px');

      const shells = parent.querySelectorAll<HTMLElement>('.fl-nb-shell');
      notify(
        [
          {
            target: shells[0],
            isIntersecting: true,
          } as unknown as IntersectionObserverEntry,
        ],
        {} as IntersectionObserver,
      );
      expect(parent.querySelectorAll('.fl-ps')).toHaveLength(1);
      notify(
        [
          {
            target: shells[0],
            isIntersecting: false,
          } as unknown as IntersectionObserverEntry,
          {
            target: shells[1],
            isIntersecting: true,
          } as unknown as IntersectionObserverEntry,
        ],
        {} as IntersectionObserver,
      );
      expect(parent.querySelectorAll('.fl-ps')).toHaveLength(1);
      expect(shells[0]?.childElementCount).toBe(1);
      expect(shells[1]?.querySelector('.fl-ps')).not.toBeNull();
      pager.destroy();
    } finally {
      if (previous === undefined)
        delete (globalThis as { IntersectionObserver?: unknown })
          .IntersectionObserver;
      else Object.defineProperty(globalThis, 'IntersectionObserver', previous);
    }
  });

  it('leaves wheel scrolling to the notebook stack instead of moving page content', () => {
    const parent = document.createElement('div');
    const model = fixture();
    const pager = mountUiPager(parent, { model, markDirty: () => undefined });
    const canvas = parent.querySelector<HTMLCanvasElement>('.fl-ps canvas')!;
    const wheel = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: 80,
    });

    canvas.dispatchEvent(wheel);

    expect(wheel.defaultPrevented).toBe(false);
    pager.destroy();
  });

  it('zooms the entire continuous paper stack instead of one page camera', async () => {
    const parent = document.createElement('div');
    const model = fixture();
    appendPage(
      model,
      notebookPage('p2', {
        surface: emptySurface(boundedFrame(800, 600)),
      }),
    );
    const pager = mountUiPager(parent, { model, markDirty: () => undefined });

    pager.setZoomFactor(1.5);
    // (async contract): the programmatic zoom settles via the
    // zoom-spring — shell widths/layout only commit at settle, so pump
    // real-rAF before asserting the committed 1.5x stack.
    await settleRealZoomValue(() => pager.zoomFactor(), 1.5);

    const shells = [...parent.querySelectorAll<HTMLElement>('.fl-nb-shell')];
    expect(pager.zoomFactor()).toBe(1.5);
    expect(shells).toHaveLength(2);
    expect(shells.map((shell) => shell.style.width)).toEqual([
      '1260px',
      '1260px',
    ]);
    pager.destroy();
  });

  it('pinch-zooms the whole stack while ordinary wheel remains pager-owned', () => {
    const parent = document.createElement('div');
    const model = fixture();
    appendPage(
      model,
      notebookPage('p2', {
        surface: emptySurface(boundedFrame(800, 600)),
      }),
    );
    const pager = mountUiPager(parent, { model, markDirty: () => undefined });
    const canvas = parent.querySelector<HTMLCanvasElement>('.fl-ps canvas')!;
    const initialZoom = pager.zoomFactor();
    canvas.dispatchEvent(pointerEvent('pointerdown', 300, 300, 1, 'touch'));
    canvas.dispatchEvent(pointerEvent('pointerdown', 500, 300, 2, 'touch'));
    canvas.dispatchEvent(pointerEvent('pointermove', 700, 300, 2, 'touch'));
    expect(
      [...parent.querySelectorAll<HTMLElement>('.fl-nb-shell')].map(
        (shell) => shell.style.width,
      ),
    ).toEqual(['840px', '840px']);
    expect(
      parent.querySelector<HTMLElement>('.fl-nb-stack')?.style.transform,
    ).toContain('scale(');
    canvas.dispatchEvent(pointerEvent('pointerup', 700, 300, 2, 'touch'));
    canvas.dispatchEvent(pointerEvent('pointerup', 300, 300, 1, 'touch'));
    expect(pager.zoomFactor()).toBeGreaterThan(initialZoom);
    expect(
      [...parent.querySelectorAll<HTMLElement>('.fl-nb-shell')].map(
        (shell) => shell.style.width,
      ),
    ).toEqual(['1680px', '1680px']);
    const page = model.pages.p1;
    expect(isNavigablePage(page) ? page.surface.order : []).toEqual(['img']);
    pager.destroy();
  });

  it('routes trackpad pinch wheel input into the shared notebook zoom', async () => {
    const parent = document.createElement('div');
    const model = fixture();
    appendPage(
      model,
      notebookPage('p2', {
        surface: emptySurface(boundedFrame(800, 600)),
      }),
    );
    const pager = mountUiPager(parent, { model, markDirty: () => undefined });
    const canvas = parent.querySelector<HTMLCanvasElement>('.fl-ps canvas')!;
    const wheel = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      deltaY: -100,
    });
    canvas.dispatchEvent(wheel);
    expect(wheel.defaultPrevented).toBe(true);
    // ctrl-wheel previews (transform-only) and commits on
    // debounce idle — never a per-tick layout commit.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(pager.zoomFactor()).toBeGreaterThan(1);
    const widths = [
      ...parent.querySelectorAll<HTMLElement>('.fl-nb-shell'),
    ].map((shell) => Number.parseFloat(shell.style.width));
    expect(widths[0]).toBeGreaterThan(840);
    expect(widths[1]).toBe(widths[0]);
    pager.destroy();
  });

  it('routes one-finger vertical movement to the continuous page stack', () => {
    const parent = document.createElement('div');
    const pager = mountUiPager(parent, {
      model: fixture(),
      markDirty: () => undefined,
    });
    const scroll = parent.querySelector<HTMLElement>('.fl-nb-scroll')!;
    const canvas = parent.querySelector<HTMLCanvasElement>('.fl-ps canvas')!;
    canvas.dispatchEvent(pointerEvent('pointerdown', 300, 300, 1, 'touch'));
    canvas.dispatchEvent(pointerEvent('pointermove', 300, 200, 1, 'touch'));
    canvas.dispatchEvent(pointerEvent('pointerup', 300, 200, 1, 'touch'));
    expect(scroll.scrollTop).toBe(100);
    pager.destroy();
  });

  it('routes one-finger horizontal movement over both the canvas and page gutter', () => {
    const parent = document.createElement('div');
    const pager = mountUiPager(parent, {
      model: fixture(),
      markDirty: () => undefined,
    });
    const scroll = parent.querySelector<HTMLElement>('.fl-nb-scroll')!;
    const canvas = parent.querySelector<HTMLCanvasElement>('.fl-ps canvas')!;
    canvas.dispatchEvent(pointerEvent('pointerdown', 300, 300, 1, 'touch'));
    canvas.dispatchEvent(pointerEvent('pointermove', 200, 300, 1, 'touch'));
    canvas.dispatchEvent(pointerEvent('pointerup', 200, 300, 1, 'touch'));
    expect(scroll.scrollLeft).toBe(100);

    scroll.dispatchEvent(pointerEvent('pointerdown', 300, 100, 2, 'touch'));
    scroll.dispatchEvent(pointerEvent('pointermove', 220, 100, 2, 'touch'));
    scroll.dispatchEvent(pointerEvent('pointerup', 220, 100, 2, 'touch'));
    expect(scroll.scrollLeft).toBe(180);
    pager.destroy();
  });

  it('uses fingers to navigate while Apple Pencil input writes on the page', () => {
    const parent = document.createElement('div');
    const model = fixture();
    const first = model.pages['p1'];
    if (first?.kind !== 'page') throw new Error('expected p1');
    const before = first.surface.order.length;
    const pager = mountUiPager(parent, { model, markDirty: () => undefined });
    const scroll = parent.querySelector<HTMLElement>('.fl-nb-scroll')!;
    const canvas = parent.querySelector<HTMLCanvasElement>('.fl-ps canvas')!;

    canvas.dispatchEvent(pointerEvent('pointerdown', 300, 300, 1, 'touch'));
    canvas.dispatchEvent(pointerEvent('pointermove', 300, 220, 1, 'touch'));
    canvas.dispatchEvent(pointerEvent('pointerup', 300, 220, 1, 'touch'));
    expect(scroll.scrollTop).toBe(80);

    canvas.dispatchEvent(pointerEvent('pointerdown', 120, 120, 7, 'pen'));
    canvas.dispatchEvent(pointerEvent('pointermove', 180, 180, 7, 'pen'));
    canvas.dispatchEvent(pointerEvent('pointerup', 180, 180, 7, 'pen'));
    expect(first.surface.order).toHaveLength(before + 1);
    pager.destroy();
  });

  it('applies exact dimensions only to the current canonical page', () => {
    const parent = document.createElement('div');
    const model = fixture();
    let dirtyCount = 0;
    const pager = mountUiPager(parent, {
      model,
      markDirty: () => {
        dirtyCount += 1;
      },
    });
    expect(pager.resizeCurrentPage(1024, 768)).toBe(true);
    const page = model.pages.p1;
    expect(isNavigablePage(page) ? page.surface.frame : null).toEqual({
      kind: 'bounded',
      width: 1024,
      height: 768,
    });
    expect(
      parent.querySelector<HTMLElement>('.fl-nb-shell')?.style.aspectRatio,
    ).toBe('1024 / 768');
    expect(dirtyCount).toBe(1);
    pager.destroy();
  });

  it('moves and resizes a selected image without rasterizing canonical data', () => {
    const parent = document.createElement('div');
    const model = fixture();
    const pager = mountUiPager(parent, { model, markDirty: () => undefined });
    const canvas = parent.querySelector('.fl-ps canvas');
    expect(canvas).not.toBeNull();
    pager.setTool(PAGE_TOOL_IDS.select);

    // Embedded notebook paper is full-bleed at 1:1 in this 800x600 test
    // viewport; exercise move and resize through view-space coordinates.
    canvas!.dispatchEvent(pointerEvent('pointerdown', 130, 130));
    canvas!.dispatchEvent(pointerEvent('pointermove', 150, 140));
    canvas!.dispatchEvent(pointerEvent('pointerup', 150, 140));
    canvas!.dispatchEvent(pointerEvent('pointerdown', 200, 170));
    canvas!.dispatchEvent(pointerEvent('pointermove', 250, 210));
    canvas!.dispatchEvent(pointerEvent('pointerup', 250, 210));

    const page = model.pages.p1;
    if (page?.kind !== 'page') throw new Error('expected a navigable page');
    expect(page.surface.objects.img?.x).toBeCloseTo(120, 5);
    expect(page.surface.objects.img?.y).toBeCloseTo(110, 5);
    expect(page.surface.objects.img?.width).toBeCloseTo(130, 5);
    expect(page.surface.objects.img?.height).toBeCloseTo(100, 5);
    pager.destroy();
  });

  it('keeps PNG export side-effect-free', () => {
    const model = fixture();
    const before = JSON.stringify(model);
    const page = model.pages.p1;
    if (page?.kind !== 'page') throw new Error('expected a navigable page');
    exportSurfacePng({ model: page.surface, filename: 'test.png' });
    expect(JSON.stringify(model)).toBe(before);
  });

  it('commits an active text overlay before the provider is destroyed', () => {
    const parent = document.createElement('div');
    const model = fixture();
    const pager = mountUiPager(parent, { model, markDirty: () => undefined });
    pager.setTool(PAGE_TOOL_IDS.text);
    const canvas = parent.querySelector('.fl-ps canvas');
    expect(canvas).not.toBeNull();
    canvas!.dispatchEvent(pointerEvent('pointerdown', 30, 40));
    const input = parent.querySelector<HTMLInputElement>('.fl-ink-text-input');
    expect(input).not.toBeNull();
    input!.value = 'saved text';
    pager.destroy();

    const page = model.pages.p1;
    if (page?.kind !== 'page') throw new Error('expected navigable page');
    const text = Object.values(page.surface.objects).find(
      (object) => object.type === 'froglight.text',
    );
    expect(text?.text).toBe('saved text');
  });
});

describe('notebook image insertion', () => {
  let restoreCanvas: (() => void) | null = null;

  beforeEach(() => {
    restoreCanvas = installCanvasStub();
  });

  afterEach(() => {
    restoreCanvas?.();
    restoreCanvas = null;
    document.body.replaceChildren();
  });

  it('inserts images at natural aspect, centered on the current page', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const model = fixture();
    let dirty = 0;
    const puts: string[] = [];
    const stored = new Map<string, Uint8Array>();
    const bitmap = {
      width: 800,
      height: 300,
    } as unknown as DecodedImage;
    const pager = mountUiPager(parent, {
      model,
      markDirty: () => (dirty += 1),
      assets: {
        put: async (bytes, options) => {
          puts.push(options?.suggestedName ?? '');
          const path = workspacePath(`attachments/hash-${puts.length}`);
          stored.set(path, bytes);
          return { path, sha256: `sha-${puts.length}` };
        },
        read: async (path) => {
          const bytes = stored.get(path);
          if (bytes === undefined) throw new Error('missing asset');
          return bytes;
        },
      },
      decodeImage: async () => bitmap,
    });

    await pager.insertImageFile(
      new File([new Uint8Array([137, 80, 78, 71])], 'pic.png', {
        type: 'image/png',
      }),
    );

    const pageId = navigablePageIds(model)[0]!;
    const entry = model.pages[pageId]!;
    if (!isNavigablePage(entry)) throw new Error('expected navigable page');
    const inserted = Object.values(entry.surface.objects).find(
      (object) => object.type === 'froglight.image' && object.id !== 'img',
    );
    expect(inserted).toBeDefined();
    const record = inserted as unknown as {
      width: number;
      height: number;
      x: number;
      y: number;
    };
    // Natural 800×300 (wide panorama) downscales to the 50%-width box
    // preserving aspect — the legacy fixed 3:4 box would squash it.
    expect(record.width).toBe(400);
    expect(record.height).toBe(150);
    expect(record.x).toBe(200);
    expect(record.y).toBe(225);
    expect(puts).toEqual(['pic.png']);
    expect(dirty).toBe(1);
    pager.destroy();
  });
});

describe('notebook shared image cache', () => {
  let restoreCanvas: (() => void) | null = null;

  beforeEach(() => {
    restoreCanvas = installCanvasStub();
  });

  afterEach(() => {
    restoreCanvas?.();
    restoreCanvas = null;
    document.body.replaceChildren();
  });

  function sharedImageModel(): NotebookModel {
    const model = emptyNotebook();
    for (const id of ['p1', 'p2']) {
      const page = notebookPage(id, {
        surface: emptySurface(boundedFrame(800, 600)),
      });
      page.surface.objects.img = imageObject('img', {
        x: 100,
        y: 100,
        width: 80,
        height: 60,
        src: 'attachments/shared',
        sha256: 'hash',
      });
      page.surface.order.push('img');
      appendPage(model, page);
    }
    return model;
  }

  it('loads a shared image path once across pages and thumbnails', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const model = sharedImageModel();
    const reads: string[] = [];
    const bitmap = { width: 800, height: 300 } as unknown as DecodedImage;
    const pager = mountUiPager(parent, {
      model,
      markDirty: () => undefined,
      assets: {
        put: async () => {
          throw new Error('no puts in this fixture');
        },
        read: async (path) => {
          reads.push(path);
          return new Uint8Array([137, 80, 78, 71]);
        },
      },
      decodeImage: async () => bitmap,
    });

    for (let attempt = 0; attempt < 20 && reads.length === 0; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    // Mounted page surfaces share one cache: a single load serves every
    // reference to the path.
    expect(reads).toEqual(['attachments/shared']);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    expect(reads).toEqual(['attachments/shared']);
    pager.destroy();
  });

  it('seeds inserted images instead of reloading them', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const model = fixture();
    const reads: string[] = [];
    const stored = new Map<string, Uint8Array>();
    const bitmap = { width: 800, height: 300 } as unknown as DecodedImage;
    const pager = mountUiPager(parent, {
      model,
      markDirty: () => undefined,
      assets: {
        put: async (bytes, options) => {
          const path = workspacePath(
            `attachments/${options?.suggestedName ?? 'file'}`,
          );
          stored.set(path, bytes);
          return { path, sha256: 'sha-1' };
        },
        read: async (path) => {
          reads.push(path);
          const bytes = stored.get(path);
          if (bytes === undefined) throw new Error('missing asset');
          return bytes;
        },
      },
      decodeImage: async () => bitmap,
    });

    await pager.insertImageFile(
      new File([new Uint8Array([137, 80, 78, 71])], 'pic.png', {
        type: 'image/png',
      }),
    );
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    // The inserted path was seeded at insert time, so rendering it never
    // triggers a load. The pre-existing fixture image loads exactly once.
    expect(reads).toEqual(['attachments/image']);
    pager.destroy();
  });

  it('settles image work silently after destroy', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const model = fixture();
    let puts = 0;
    const pager = mountUiPager(parent, {
      model,
      markDirty: () => undefined,
      assets: {
        put: async () => {
          puts += 1;
          throw new Error('no puts after destroy');
        },
        read: async () => new Uint8Array([137, 80, 78, 71]),
      },
      decodeImage: async () => null,
    });
    pager.destroy();
    await pager.insertImageFile(
      new File([new Uint8Array([137, 80, 78, 71])], 'pic.png', {
        type: 'image/png',
      }),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    expect(puts).toBe(0);
  });
});
