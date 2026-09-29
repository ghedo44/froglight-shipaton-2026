// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendPage,
  boundedFrame,
  decodeNotebook,
  emptyNotebook,
  emptySurface,
  encodeNotebook,
  isNavigablePage,
  notebookPage,
  type NotebookModel,
} from '@froglight/foundation';
import {
  HeadlessNotebookEditorHandle,
  mountNotebook,
  NotebookDocumentEditorProvider,
} from '../index.js';
import {
  NotebookChrome,
  type NotebookPagerSkeleton,
} from './NotebookChrome.jsx';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

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
  const model = emptyNotebook('Chrome fixture');
  appendPage(
    model,
    notebookPage('p1', { surface: emptySurface(boundedFrame(800, 600)) }),
  );
  return model;
}

let restoreCanvas: (() => void) | null = null;
let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  restoreCanvas?.();
  restoreCanvas = installCanvasStub();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  restoreCanvas?.();
  restoreCanvas = null;
  document.body.replaceChildren();
});

describe('notebook chrome (React pager)', () => {
  it('commits the identical pager skeleton structure with refs populated', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const chromeRef: { current: NotebookPagerSkeleton | null } = {
      current: null,
    };
    await act(async () => {
      root!.render(createElement(NotebookChrome, { chromeRef }));
    });
    const skeleton = chromeRef.current;
    expect(skeleton).not.toBeNull();
    expect(skeleton!.root.className).toBe('fl-nb');
    expect(skeleton!.root.tabIndex).toBe(0);
    expect(skeleton!.imgInput.type).toBe('file');
    expect(skeleton!.imgInput.accept).toBe('image/*');
    expect(skeleton!.imgInput.hidden).toBe(true);
    expect(skeleton!.pdfInput.type).toBe('file');
    expect(skeleton!.pdfInput.accept).toBe('application/pdf,.pdf');
    expect(skeleton!.pdfInput.hidden).toBe(true);
    expect(skeleton!.pdfImportStatus.className).toBe('fl-nb-pdf-import-error');
    expect(skeleton!.pdfImportStatus.getAttribute('role')).toBe('alert');
    expect(skeleton!.pdfImportStatus.hidden).toBe(true);
    expect(skeleton!.main.className).toBe('fl-nb-main');
    expect(skeleton!.scroll.className).toBe('fl-nb-scroll');
    expect(skeleton!.stack.className).toBe('fl-nb-stack');
    expect(skeleton!.scroll.contains(skeleton!.stack)).toBe(true);
    expect(skeleton!.main.contains(skeleton!.scroll)).toBe(true);
    expect(skeleton!.main.querySelector('.fl-nb-thumbs')).toBeNull();
    expect(skeleton!.root.contains(skeleton!.main)).toBe(true);
    expect([...skeleton!.root.children]).toEqual([
      skeleton!.imgInput,
      skeleton!.pdfInput,
      skeleton!.pdfImportStatus,
      skeleton!.main,
    ]);
  });

  it('provider creation synchronously commits chrome the engine consumes', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const model = fixture();
    let dirty = 0;
    const provider = new NotebookDocumentEditorProvider();
    let handle: ReturnType<NotebookDocumentEditorProvider['createEditor']>;
    await act(async () => {
      handle = provider.createEditor({
        session: {
          model,
          markDirty: () => {
            dirty += 1;
          },
        } as never,
        parent,
      });
    });
    // No extra flush: the pager chrome and the embedded page surface the
    // engine draws into exist immediately, preserving the synchronous
    // createEditor contract.
    expect(parent.querySelector('.fl-nb')).not.toBeNull();
    expect(parent.querySelector('.fl-nb-scroll')).not.toBeNull();
    expect(parent.querySelector('.fl-nb-stack')).not.toBeNull();
    expect(parent.querySelector('.fl-ps canvas')).not.toBeNull();
    expect(handle!.tools).toBeDefined();
    expect(handle!.execCommand('undo')).toBe(false);
    expect(dirty).toBe(0);
    handle!.destroy();
    expect(parent.querySelector('.fl-nb')).toBeNull();
    expect(parent.querySelector('canvas')).toBeNull();
    parent.remove();
  });

  it('engine attaches to React-committed refs with identical semantics', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const chromeRef: { current: NotebookPagerSkeleton | null } = {
      current: null,
    };
    await act(async () => {
      root!.render(createElement(NotebookChrome, { chromeRef }));
    });
    const model = fixture();
    let dirty = 0;
    const pager = mountNotebook({
      model,
      markDirty: () => {
        dirty += 1;
      },
      host: chromeRef.current!,
    });
    expect(pager.root).toBe(chromeRef.current!.root);
    expect(pager.pageCount()).toBe(1);
    expect(pager.canUndo()).toBe(false);
    pager.flush();
    pager.jumpToAddress('p1');
    expect(pager.currentPageId()).toBe('p1');
    expect(host.querySelector('.fl-ps')).not.toBeNull();
    expect(dirty).toBe(0);
    // Unmount the React owner before engine teardown: same order the
    // provider uses, so no React-managed node is yanked mid-teardown.
    act(() => root?.unmount());
    root = null;
    pager.destroy();
    expect(host.querySelector('.fl-nb')).toBeNull();
    expect(host.querySelector('canvas')).toBeNull();
  });

  it('falls back to the headless handle without a 2D context', () => {
    restoreCanvas?.();
    restoreCanvas = null;
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const model = fixture();
    const handle = new NotebookDocumentEditorProvider().createEditor({
      session: { model, markDirty: () => undefined } as never,
      parent,
    });
    expect(handle).toBeInstanceOf(HeadlessNotebookEditorHandle);
    expect(parent.querySelector('.fl-nb')).toBeNull();
    expect(parent.querySelector('canvas')).toBeNull();
    expect(handle.execCommand('undo')).toBe(false);
    handle.destroy();
    parent.remove();
  });

  it('keeps save/reopen byte identity through the session path', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const model = fixture();
    let dirty = 0;
    const provider = new NotebookDocumentEditorProvider();
    let handle: ReturnType<NotebookDocumentEditorProvider['createEditor']>;
    await act(async () => {
      handle = provider.createEditor({
        session: {
          model,
          markDirty: () => {
            dirty += 1;
          },
        } as never,
        parent,
      });
    });
    const canvas = parent.querySelector('.fl-ps canvas');
    expect(canvas).not.toBeNull();
    canvas!.dispatchEvent(pointerEvent('pointerdown', 10, 10));
    canvas!.dispatchEvent(pointerEvent('pointermove', 40, 30));
    canvas!.dispatchEvent(pointerEvent('pointerup', 60, 40));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(dirty).toBe(1);
    handle!.flush?.();
    handle!.revealAddress?.('p1');
    const page = model.pages.p1;
    if (page?.kind !== 'page') throw new Error('expected a navigable page');
    expect(page.surface.order).toHaveLength(1);

    const once = encodeNotebook(model);
    const reopened = decodeNotebook(once.slice()).model;
    const twice = encodeNotebook(reopened);
    expect([...twice]).toEqual([...once]);
    const reopenedPage = reopened.pages.p1;
    if (!isNavigablePage(reopenedPage))
      throw new Error('expected a navigable reopened page');
    expect(reopenedPage.surface.order).toHaveLength(1);

    handle!.destroy();
    parent.remove();
  });
});
