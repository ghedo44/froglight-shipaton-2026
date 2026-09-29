// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  appendPage,
  boundedFrame,
  createDefaultSurfaceObjectTypeRegistry,
  emptyNotebook,
  emptySurface,
  infiniteFrame,
  notebookPage,
  pdfNotebookPage,
  workspacePath,
  type NotebookPage,
  type PdfDocumentHandle,
} from '@froglight/foundation';
import {
  downloadCurrentNotebookPageAsPng,
  downloadNotebookPagesAsPng,
  renderNotebookPageImage,
  type NotebookExportEnvironment,
} from './export.js';

function installCanvasStubs(drawImage?: (source: unknown) => void): () => void {
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
    drawImage: (source: unknown) => drawImage?.(source),
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

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function installDownloadCounter(): {
  downloads: () => number;
  restore: () => void;
} {
  let created = 0;
  const countingCreate = URL.createObjectURL;
  URL.createObjectURL = () => {
    created += 1;
    return countingCreate(new Blob(['x']));
  };
  return {
    downloads: () => created,
    restore: () => {
      URL.createObjectURL = countingCreate;
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

function templateEntry(): NotebookPage {
  return notebookPage('p1', { surface: emptySurface(boundedFrame(800, 600)) });
}

function baseEnv(
  overrides: Partial<NotebookExportEnvironment> = {},
): NotebookExportEnvironment & { requested: number } {
  const env = {
    requested: 0,
    objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
    imageResolver: new Map(),
    backgroundFor: () => () => [],
    requestPageImages: async () => {
      env.requested += 1;
    },
    pdfDocumentFor: async (): Promise<PdfDocumentHandle> => {
      throw new Error('no pdf in this fixture');
    },
    isActive: () => true,
    ...overrides,
  };
  return env;
}

describe('renderNotebookPageImage', () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  it('rejects unknown pages', async () => {
    const model = emptyNotebook();
    await expect(
      renderNotebookPageImage(baseEnv(), model, 'missing', 72),
    ).rejects.toThrow('unavailable');
  });

  it('rejects cancelled signals before touching providers', async () => {
    restore = installCanvasStubs();
    const model = emptyNotebook();
    appendPage(model, templateEntry());
    const controller = new AbortController();
    controller.abort();
    const pdfDocumentFor = vi.fn();
    await expect(
      renderNotebookPageImage(
        baseEnv({ pdfDocumentFor }),
        model,
        'p1',
        72,
        controller.signal,
      ),
    ).rejects.toThrow('Export cancelled');
    expect(pdfDocumentFor).not.toHaveBeenCalled();
  });

  it('rejects unbounded frames', async () => {
    restore = installCanvasStubs();
    const model = emptyNotebook();
    const page = notebookPage('wide', {
      surface: emptySurface(infiniteFrame()),
    });
    appendPage(model, page);
    await expect(
      renderNotebookPageImage(baseEnv(), model, 'wide', 72),
    ).rejects.toThrow('not bounded');
  });

  it('renders template pages to bytes without mutating the model', async () => {
    restore = installCanvasStubs();
    const model = emptyNotebook();
    appendPage(model, templateEntry());
    const before = JSON.stringify(model);
    const bytes = await renderNotebookPageImage(baseEnv(), model, 'p1', 72);
    expect(bytes.length).toBeGreaterThan(0);
    expect(JSON.stringify(model)).toBe(before);
  });

  it('fails cleanly when the PDF provider cannot mount pages', async () => {
    restore = installCanvasStubs();
    const model = emptyNotebook();
    appendPage(
      model,
      pdfNotebookPage('pdf', {
        asset: { path: workspacePath('attachments/x'), sha256: 'x' },
        pageIndex: 0,
        pageBox: { widthPt: 300, heightPt: 200 },
      }),
    );
    const env = baseEnv({
      pdfDocumentFor: async () => ({
        pageCount: 1,
        getPageInfo: async () => {
          throw new Error('unreachable');
        },
        getPageText: async () => {
          throw new Error('unreachable');
        },
        getOutline: async () => [],
        getLinks: async () => [],
        close: async () => undefined,
      }),
    });
    await expect(
      renderNotebookPageImage(env, model, 'pdf', 72),
    ).rejects.toThrow('PDF page rendering is unavailable');
  });

  it('draws PDF bases beneath surface content', async () => {
    const drawn: unknown[] = [];
    restore = installCanvasStubs((source) => drawn.push(source));
    const model = emptyNotebook();
    appendPage(
      model,
      pdfNotebookPage('pdf', {
        asset: { path: workspacePath('attachments/x'), sha256: 'x' },
        pageIndex: 0,
        pageBox: { widthPt: 300, heightPt: 200 },
      }),
    );
    const destroyed: string[] = [];
    const env = baseEnv({
      pdfDocumentFor: async () => ({
        pageCount: 1,
        getPageInfo: async () => {
          throw new Error('unreachable');
        },
        getPageText: async () => {
          throw new Error('unreachable');
        },
        getOutline: async () => [],
        getLinks: async () => [],
        mountPage: async ({ parent }) => {
          const canvas = document.createElement('canvas');
          (parent as HTMLElement).appendChild(canvas);
          return {
            destroy: async () => {
              destroyed.push('base');
            },
          };
        },
        close: async () => undefined,
      }),
    });
    const bytes = await renderNotebookPageImage(env, model, 'pdf', 72);
    expect(bytes.length).toBeGreaterThan(0);
    expect(drawn.length).toBe(1);
    expect(destroyed).toEqual(['base']);
  });
});

describe('page PNG downloads', () => {
  let restore: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
  });

  it('current-page export contains Surface content via the canonical compositor', async () => {
    restore = installCanvasStubs();
    const model = emptyNotebook();
    appendPage(model, templateEntry());
    let created = 0;
    const countingCreate = URL.createObjectURL;
    URL.createObjectURL = () => {
      created += 1;
      return countingCreate(new Blob(['x']));
    };
    const env = baseEnv();
    await downloadCurrentNotebookPageAsPng(env, model, {
      pageId: 'p1',
      index: 0,
    });
    expect(created).toBe(1);
    expect(env.requested).toBe(1);
  });

  it('PDF-backed current-page export renders the PDF base beneath annotations', async () => {
    const drawn: unknown[] = [];
    restore = installCanvasStubs((source) => drawn.push(source));
    const model = emptyNotebook();
    appendPage(
      model,
      pdfNotebookPage('pdf', {
        asset: { path: workspacePath('attachments/x'), sha256: 'x' },
        pageIndex: 0,
        pageBox: { widthPt: 300, heightPt: 200 },
      }),
    );
    const destroyed: string[] = [];
    const env = baseEnv({
      pdfDocumentFor: async () => ({
        pageCount: 1,
        getPageInfo: async () => {
          throw new Error('unreachable');
        },
        getPageText: async () => {
          throw new Error('unreachable');
        },
        getOutline: async () => [],
        getLinks: async () => [],
        mountPage: async ({ parent }) => {
          const canvas = document.createElement('canvas');
          (parent as HTMLElement).appendChild(canvas);
          return {
            destroy: async () => {
              destroyed.push('base');
            },
          };
        },
        close: async () => undefined,
      }),
    });
    const before = JSON.stringify(model);
    await downloadCurrentNotebookPageAsPng(env, model, {
      pageId: 'pdf',
      index: 0,
    });
    expect(drawn.length).toBe(1);
    expect(destroyed).toEqual(['base']);
    expect(JSON.stringify(model)).toBe(before);
  });

  it('whole-notebook export handles mixed template/PDF pages without mutating', async () => {
    const drawn: unknown[] = [];
    restore = installCanvasStubs((source) => drawn.push(source));
    const model = emptyNotebook();
    appendPage(model, templateEntry());
    appendPage(
      model,
      pdfNotebookPage('pdf', {
        asset: { path: workspacePath('attachments/x'), sha256: 'x' },
        pageIndex: 1,
        pageBox: { widthPt: 300, heightPt: 200 },
      }),
    );
    let created = 0;
    const countingCreate = URL.createObjectURL;
    URL.createObjectURL = () => {
      created += 1;
      return countingCreate(new Blob(['x']));
    };
    const destroyed: string[] = [];
    const env = baseEnv({
      pdfDocumentFor: async () => ({
        pageCount: 2,
        getPageInfo: async () => {
          throw new Error('unreachable');
        },
        getPageText: async () => {
          throw new Error('unreachable');
        },
        getOutline: async () => [],
        getLinks: async () => [],
        mountPage: async ({ parent }) => {
          const canvas = document.createElement('canvas');
          (parent as HTMLElement).appendChild(canvas);
          return {
            destroy: async () => {
              destroyed.push('base');
            },
          };
        },
        close: async () => undefined,
      }),
    });
    const before = JSON.stringify(model);
    await downloadNotebookPagesAsPng(env, model, [
      { pageId: 'p1', index: 0 },
      { pageId: 'pdf', index: 1 },
    ]);
    expect(created).toBe(2);
    expect(drawn.length).toBe(1);
    expect(destroyed).toEqual(['base']);
    expect(JSON.stringify(model)).toBe(before);
  });

  it('downloads every page and stays silent when inactive', async () => {
    restore = installCanvasStubs();
    let created = 0;
    const countingCreate = URL.createObjectURL;
    URL.createObjectURL = () => {
      created += 1;
      return countingCreate(new Blob(['x']));
    };
    const model = emptyNotebook();
    appendPage(model, templateEntry());
    appendPage(
      model,
      notebookPage('p2', { surface: emptySurface(boundedFrame(400, 300)) }),
    );
    await downloadNotebookPagesAsPng(baseEnv(), model, [
      { pageId: 'p1', index: 0 },
      { pageId: 'p2', index: 1 },
    ]);
    expect(created).toBe(2);
    await downloadNotebookPagesAsPng(
      baseEnv({ isActive: () => false }),
      model,
      [{ pageId: 'p1', index: 0 }],
    );
    expect(created).toBe(2);
  });

  it('cancelled export does not leak mounted PDF handles', async () => {
    restore = installCanvasStubs();
    const model = emptyNotebook();
    appendPage(
      model,
      pdfNotebookPage('pdf', {
        asset: { path: workspacePath('attachments/x'), sha256: 'x' },
        pageIndex: 0,
        pageBox: { widthPt: 300, heightPt: 200 },
      }),
    );
    const destroyed: string[] = [];
    const env = baseEnv({
      isActive: () => false,
      pdfDocumentFor: async () => ({
        pageCount: 1,
        getPageInfo: async () => {
          throw new Error('unreachable');
        },
        getPageText: async () => {
          throw new Error('unreachable');
        },
        getOutline: async () => [],
        getLinks: async () => [],
        mountPage: async () => {
          throw new Error('should not mount when inactive');
        },
        close: async () => undefined,
      }),
    });
    void destroyed;
    let created = 0;
    const countingCreate = URL.createObjectURL;
    URL.createObjectURL = () => {
      created += 1;
      return countingCreate(new Blob(['x']));
    };
    // Inactive pager: no download, no mount, no leak.
    await downloadCurrentNotebookPageAsPng(env, model, {
      pageId: 'pdf',
      index: 0,
    });
    expect(created).toBe(0);
    // Aborted signal: render rejects, download stays silent, staging destroyed.
    const activeEnv = baseEnv({
      pdfDocumentFor: async () => ({
        pageCount: 1,
        getPageInfo: async () => {
          throw new Error('unreachable');
        },
        getPageText: async () => {
          throw new Error('unreachable');
        },
        getOutline: async () => [],
        getLinks: async () => [],
        mountPage: async ({ parent }) => {
          const canvas = document.createElement('canvas');
          (parent as HTMLElement).appendChild(canvas);
          return {
            destroy: async () => {
              destroyed.push('aborted-base');
            },
          };
        },
        close: async () => undefined,
      }),
    });
    const controller = new AbortController();
    controller.abort();
    await downloadCurrentNotebookPageAsPng(
      activeEnv,
      model,
      {
        pageId: 'pdf',
        index: 0,
      },
      72,
      controller.signal,
    );
    expect(created).toBe(0);
  });
});

describe('pager-cancelled PNG exports', () => {
  let restore: (() => void) | null = null;
  let restoreDownloads: (() => void) | null = null;
  afterEach(() => {
    restore?.();
    restore = null;
    restoreDownloads?.();
    restoreDownloads = null;
  });

  function pdfPageModel(): ReturnType<typeof emptyNotebook> {
    const model = emptyNotebook();
    appendPage(
      model,
      pdfNotebookPage('pdf', {
        asset: { path: workspacePath('attachments/x'), sha256: 'x' },
        pageIndex: 0,
        pageBox: { widthPt: 300, heightPt: 200 },
      }),
    );
    return model;
  }

  function pdfHandle(
    mountPage: NonNullable<PdfDocumentHandle['mountPage']>,
  ): PdfDocumentHandle {
    return {
      pageCount: 1,
      getPageInfo: async () => {
        throw new Error('unreachable');
      },
      getPageText: async () => {
        throw new Error('unreachable');
      },
      getOutline: async () => [],
      getLinks: async () => [],
      mountPage,
      close: async () => undefined,
    };
  }

  it('aborts before export starts without touching providers', async () => {
    restore = installCanvasStubs();
    const counter = installDownloadCounter();
    restoreDownloads = counter.restore;
    const model = emptyNotebook();
    appendPage(model, templateEntry());
    const requestPageImages = vi.fn(async () => undefined);
    const pdfDocumentFor = vi.fn();
    const controller = new AbortController();
    controller.abort();
    await downloadCurrentNotebookPageAsPng(
      baseEnv({ requestPageImages, pdfDocumentFor }),
      model,
      { pageId: 'p1', index: 0 },
      72,
      controller.signal,
    );
    expect(requestPageImages).not.toHaveBeenCalled();
    expect(pdfDocumentFor).not.toHaveBeenCalled();
    expect(counter.downloads()).toBe(0);
  });

  it('aborts while waiting for page images', async () => {
    restore = installCanvasStubs();
    const counter = installDownloadCounter();
    restoreDownloads = counter.restore;
    const model = emptyNotebook();
    appendPage(model, templateEntry());
    const before = JSON.stringify(model);
    const gate = deferred<void>();
    const env = baseEnv({
      requestPageImages: () => gate.promise,
    });
    let encodings = 0;
    const innerToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (
      this: HTMLCanvasElement,
      callback: BlobCallback,
    ): void {
      encodings += 1;
      return innerToBlob.call(this, callback);
    } as unknown as typeof HTMLCanvasElement.prototype.toBlob;
    const previousRestore = restore;
    restore = () => {
      HTMLCanvasElement.prototype.toBlob = innerToBlob;
      previousRestore?.();
    };
    const controller = new AbortController();
    const pending = downloadCurrentNotebookPageAsPng(
      env,
      model,
      { pageId: 'p1', index: 0 },
      72,
      controller.signal,
    );
    controller.abort();
    gate.resolve();
    await pending;
    // Cancellation is checked after the images resolve: no encoding starts
    // and no download occurs.
    expect(encodings).toBe(0);
    expect(counter.downloads()).toBe(0);
    expect(JSON.stringify(model)).toBe(before);
  });

  it('aborts while waiting for the PDF document', async () => {
    restore = installCanvasStubs();
    const counter = installDownloadCounter();
    restoreDownloads = counter.restore;
    const model = pdfPageModel();
    const before = JSON.stringify(model);
    const gate = deferred<PdfDocumentHandle>();
    const mountPage = vi.fn(async () => {
      throw new Error('must not mount after cancellation');
    });
    const env = baseEnv({
      pdfDocumentFor: () => gate.promise,
    });
    const controller = new AbortController();
    const pending = downloadCurrentNotebookPageAsPng(
      env,
      model,
      { pageId: 'pdf', index: 0 },
      72,
      controller.signal,
    );
    await flushMicrotasks();
    controller.abort();
    gate.resolve(pdfHandle(mountPage));
    await pending;
    // Cancellation is checked after the document resolves: the PDF page is
    // never mounted and no download occurs.
    expect(mountPage).not.toHaveBeenCalled();
    expect(counter.downloads()).toBe(0);
    expect(JSON.stringify(model)).toBe(before);
  });

  it('destroys the mounted PDF handle exactly once when abort lands mid-render', async () => {
    restore = installCanvasStubs();
    const counter = installDownloadCounter();
    restoreDownloads = counter.restore;
    const model = pdfPageModel();
    const before = JSON.stringify(model);
    const destroyed: string[] = [];
    const mountGate = deferred<void>();
    const env = baseEnv({
      pdfDocumentFor: async () =>
        pdfHandle(async ({ parent }) => {
          const canvas = document.createElement('canvas');
          (parent as HTMLElement).appendChild(canvas);
          await mountGate.promise;
          return {
            destroy: async () => {
              destroyed.push('base');
            },
          };
        }),
    });
    const controller = new AbortController();
    const pending = downloadCurrentNotebookPageAsPng(
      env,
      model,
      { pageId: 'pdf', index: 0 },
      72,
      controller.signal,
    );
    await flushMicrotasks();
    controller.abort();
    mountGate.resolve();
    await pending;
    // The staging mount still resolves after cancellation: its handle must
    // be destroyed exactly once via `finally`, with no download afterwards.
    expect(destroyed).toEqual(['base']);
    expect(counter.downloads()).toBe(0);
    expect(JSON.stringify(model)).toBe(before);
  });

  it('stops between pages of a whole-notebook export', async () => {
    restore = installCanvasStubs();
    const model = emptyNotebook();
    appendPage(model, templateEntry());
    appendPage(
      model,
      notebookPage('p2', { surface: emptySurface(boundedFrame(400, 300)) }),
    );
    const before = JSON.stringify(model);
    let rendered = 0;
    const innerEnv = baseEnv();
    const env = baseEnv({
      requestPageImages: async (surface) => {
        rendered += 1;
        return innerEnv.requestPageImages(surface);
      },
    });
    const controller = new AbortController();
    const countingCreate = URL.createObjectURL;
    URL.createObjectURL = () => {
      const url = countingCreate(new Blob(['x']));
      // Cancel right after the first page downloads: the loop must stop
      // before rendering the second page.
      controller.abort();
      return url;
    };
    restoreDownloads = () => {
      URL.createObjectURL = countingCreate;
    };
    await downloadNotebookPagesAsPng(
      env,
      model,
      [
        { pageId: 'p1', index: 0 },
        { pageId: 'p2', index: 1 },
      ],
      72,
      controller.signal,
    );
    expect(rendered).toBe(1);
    expect(JSON.stringify(model)).toBe(before);
  });

  it('aborts before PNG encoding completes', async () => {
    restore = installCanvasStubs();
    const counter = installDownloadCounter();
    restoreDownloads = counter.restore;
    const model = emptyNotebook();
    appendPage(model, templateEntry());
    const before = JSON.stringify(model);
    // Gate the canvas encoding step: hold the toBlob callback until abort.
    const encodeGate = deferred<Blob | null>();
    const originalToBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (
      callback: BlobCallback,
    ): void {
      void encodeGate.promise.then((value) => {
        if (value === null) callback(null);
        else callback(new Blob(['png-bytes']));
      });
    } as unknown as typeof HTMLCanvasElement.prototype.toBlob;
    const previousRestore = restore;
    restore = () => {
      HTMLCanvasElement.prototype.toBlob = originalToBlob;
      previousRestore?.();
    };
    const controller = new AbortController();
    const pending = downloadCurrentNotebookPageAsPng(
      baseEnv(),
      model,
      { pageId: 'p1', index: 0 },
      72,
      controller.signal,
    );
    await flushMicrotasks();
    controller.abort();
    encodeGate.resolve(new Blob(['png-bytes']));
    await pending;
    expect(counter.downloads()).toBe(0);
    expect(JSON.stringify(model)).toBe(before);
  });
});
