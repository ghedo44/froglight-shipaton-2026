/**
 * Pager-owned cancellation for Notebook PNG exports: destroying the pager
 * aborts in-flight derived export work
 * via a pager-owned `AbortController`. No download occurs after
 * destruction, staging PDF handles are still destroyed, and task
 * settlement never surfaces unhandled rejections.
 */

// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendPage,
  boundedFrame,
  emptyNotebook,
  emptySurface,
  notebookPage,
  type NotebookModel,
} from '@froglight/foundation';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import {
  mountNotebook,
  type NotebookPagerHandle,
  type NotebookPagerOptions,
} from '../index.js';
import {
  NotebookChrome,
  type NotebookPagerSkeleton,
} from '../react/NotebookChrome.jsx';

/**
 * Test-only React chrome for direct pager mounts:
 * mirrors `editor.spec.ts` — production mounts go through
 * `NotebookDocumentEditorProvider`; these tests commit the same React
 * chrome first and hand it over via `host`.
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

function installCanvasStubs(): () => void {
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
  const originalGetContext = HTMLCanvasElement.prototype.getContext;
  const originalToBlob = HTMLCanvasElement.prototype.toBlob;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const originalClick = HTMLAnchorElement.prototype.click;
  HTMLCanvasElement.prototype.getContext = function () {
    return context as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.toBlob = function (callback: BlobCallback): void {
    callback(new Blob(['png-bytes']));
  } as unknown as typeof HTMLCanvasElement.prototype.toBlob;
  URL.createObjectURL = () => 'blob:export-stub';
  URL.revokeObjectURL = () => {
    /* stub: nothing to revoke */
  };
  HTMLAnchorElement.prototype.click = function () {
    /* stub: no navigation in tests */
  };
  return () => {
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    HTMLCanvasElement.prototype.toBlob = originalToBlob;
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    HTMLAnchorElement.prototype.click = originalClick;
  };
}

function templateModel(pages = 1): NotebookModel {
  const model = emptyNotebook();
  for (let i = 0; i < pages; i += 1) {
    appendPage(
      model,
      notebookPage(`p${i + 1}`, {
        surface: emptySurface(boundedFrame(800, 600)),
      }),
    );
  }
  return model;
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

async function flushMacrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('pager-owned export cancellation', () => {
  let restoreCanvas: (() => void) | null = null;

  afterEach(() => {
    restoreCanvas?.();
    restoreCanvas = null;
    document.body.replaceChildren();
  });

  function mount(
    model: NotebookModel,
  ): NotebookPagerHandle & { downloads: () => number } {
    restoreCanvas = installCanvasStubs();
    let created = 0;
    const countingCreate = URL.createObjectURL;
    URL.createObjectURL = () => {
      created += 1;
      return countingCreate(new Blob(['x']));
    };
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const pager = mountUiPager(parent, {
      model,
      markDirty: () => undefined,
    });
    return Object.assign(pager, { downloads: () => created });
  }

  // NOTE: task settlement without unhandled rejections is asserted
  // implicitly — Vitest fails the run on any unhandled rejection, so a
  // rejecting tracked export after destruction would fail these tests.

  it('renderPageImage rejects after pager destruction', async () => {
    const pager = mount(templateModel());
    pager.destroy();
    await expect(pager.renderPageImage('p1', 144)).rejects.toThrow(
      'Export cancelled',
    );
    await flushMacrotasks();
    expect(pager.downloads()).toBe(0);
  });

  it('destroying mid-export downloads nothing and settles cleanly', async () => {
    const model = templateModel();
    const before = JSON.stringify(model);
    const pager = mount(model);
    // Gate the canvas encoding step so destruction lands mid-export. Boxed
    // in an object: property narrowing (unlike local narrowing) is reset
    // by intervening awaits, so the callback assignment below stays visible.
    const gate: { release: ((blob: Blob | null) => void) | null } = {
      release: null,
    };
    const innerToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (
      callback: BlobCallback,
    ): void {
      gate.release = (blob) => callback(blob);
    } as unknown as typeof HTMLCanvasElement.prototype.toBlob;
    try {
      pager.exportCurrentPagePng();
      await flushMicrotasks();
      const release = gate.release;
      if (release === null)
        throw new Error('encoding gate was never reached');
      pager.destroy();
      release(new Blob(['png-bytes']));
      await flushMacrotasks();
      expect(pager.downloads()).toBe(0);
      expect(JSON.stringify(model)).toBe(before);
    } finally {
      HTMLCanvasElement.prototype.toBlob = innerToBlob;
    }
  });

  it('destroying between pages stops a whole-notebook export', async () => {
    const model = templateModel(2);
    const before = JSON.stringify(model);
    const pager = mount(model);
    try {
      const countingCreate = URL.createObjectURL;
      let calls = 0;
      URL.createObjectURL = () => {
        calls += 1;
        const url = countingCreate(new Blob(['x']));
        // Destroy right after the first page downloads: the page loop must
        // stop before rendering the second page.
        pager.destroy();
        return url;
      };
      pager.exportNotebookPng();
      await flushMacrotasks();
      // Exactly one page downloaded: destruction right after the first page
      // stops the page loop before the second page renders.
      expect(calls).toBe(1);
      expect(JSON.stringify(model)).toBe(before);
      URL.createObjectURL = countingCreate;
    } finally {
      await flushMacrotasks();
    }
  });
});
