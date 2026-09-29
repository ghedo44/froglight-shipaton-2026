/**
 * PDF.js render provider — replaceable PDF rendering capability.
 *
 * Turns canonical `.pdf` source bytes into page rendering, text layers,
 * outlines, and links behind the Froglight-owned `PdfProvider` contract.
 * The workbench editing surface lives in `editor.ts`; provider-library
 * types never cross the document seams.
 */
import {
  FroglightError,
  PDF_LIMITS,
  normalizePdfPageGeometry,
  type PdfDocumentHandle,
  type PdfLink,
  type PdfMountedPageHandle,
  type PdfOutlineEntry,
  type PdfPageInfo,
  type PdfPageMountRequest,
  type PdfPageText,
  type PdfProvider,
  type CompositionImage,
} from '@froglight/foundation';
import {
  getDocument,
  GlobalWorkerOptions,
  PasswordResponses,
  Util,
  type PDFDocumentProxy,
  type PDFPageProxy,
} from 'pdfjs-dist/legacy/build/pdf.mjs';
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';

// The PDF.js default is a document-relative `./pdf.worker.mjs`, which does
// not exist in Froglight's web/native bundles. Let the host bundler emit and
// fingerprint the worker so real browser imports do not fail after picking a
// file. Parsing remains off the main thread where Worker is available.
export const pdfJsWorkerUrl = pdfWorkerUrl;

// Notebook scrolling can visit thousands of PDF-backed pages. Keep recent
// annotations for remounts without retaining links for every page forever.
const PDF_LINK_CACHE_PAGES = 16;

export function createPdfPageLinkCache(
  load: (pageIndex: number) => Promise<readonly PdfLink[]>,
): {
  get(pageIndex: number): Promise<readonly PdfLink[]>;
  clear(): void;
} {
  const entries = new Map<number, Promise<readonly PdfLink[]>>();
  return {
    get(pageIndex) {
      const cached = entries.get(pageIndex);
      if (cached !== undefined) {
        entries.delete(pageIndex);
        entries.set(pageIndex, cached);
        return cached;
      }
      const result = load(pageIndex);
      entries.set(pageIndex, result);
      if (entries.size > PDF_LINK_CACHE_PAGES) {
        const oldest = entries.keys().next().value;
        if (oldest !== undefined) entries.delete(oldest);
      }
      void result.catch(() => {
        if (entries.get(pageIndex) === result) entries.delete(pageIndex);
      });
      return result;
    },
    clear: () => entries.clear(),
  };
}

/** Render one disposable page preview for composition surfaces. */
export async function renderPdfPreviewImage(
  provider: PdfProvider,
  bytes: Uint8Array,
  pageIndex = 0,
): Promise<CompositionImage | undefined> {
  if (typeof document === 'undefined') return undefined;
  const handle = await provider.open({ bytes: bytes.slice() });
  let mounted: PdfMountedPageHandle | null = null;
  try {
    if (
      handle.mountPage === undefined ||
      pageIndex < 0 ||
      pageIndex >= handle.pageCount
    ) {
      return undefined;
    }
    const info = await handle.getPageInfo(pageIndex);
    const scale = Math.max(
      0.05,
      Math.min(1.5, 900 / info.geometry.pageBox.widthPt),
    );
    const staging = document.createElement('div');
    mounted = await handle.mountPage({
      pageIndex,
      parent: staging,
      scale,
      sourceInteraction: false,
    });
    const canvas = staging.querySelector<HTMLCanvasElement>('canvas');
    if (canvas === null) return undefined;
    return {
      mimeType: 'image/png',
      dataUrl: canvas.toDataURL('image/png'),
      alt: `PDF page ${pageIndex + 1} preview`,
      width: canvas.width,
      height: canvas.height,
    };
  } catch {
    return undefined;
  } finally {
    await mounted?.destroy();
    await handle.close();
  }
}
if (typeof Worker !== 'undefined')
  GlobalWorkerOptions.workerSrc = pdfJsWorkerUrl;

interface PdfJsTextItem {
  readonly str: string;
  readonly transform: number[];
}

type PdfErrorCode =
  | 'PDF_PASSWORD_REQUIRED'
  | 'PDF_PASSWORD_INCORRECT'
  | 'PDF_ENCRYPTION_UNSUPPORTED'
  | 'PDF_CORRUPT'
  | 'PDF_RESOURCE_LIMIT'
  | 'PDF_PAGE_OUT_OF_RANGE'
  | 'PDF_RENDER_CANCELLED';

function failure(
  code: PdfErrorCode,
  message: string,
  cause?: unknown,
): FroglightError {
  return new FroglightError(
    code,
    message,
    cause === undefined ? undefined : { cause },
  );
}

function normalizeError(error: unknown): FroglightError {
  if (error instanceof FroglightError) return error;
  const candidate = error as {
    readonly name?: unknown;
    readonly code?: unknown;
    readonly message?: unknown;
  };
  if (candidate.name === 'PasswordException') {
    return candidate.code === PasswordResponses.INCORRECT_PASSWORD
      ? failure('PDF_PASSWORD_INCORRECT', 'PDF password is incorrect')
      : failure('PDF_PASSWORD_REQUIRED', 'PDF requires a password');
  }
  if (
    candidate.name === 'RenderingCancelledException' ||
    candidate.name === 'AbortException'
  ) {
    return failure('PDF_RENDER_CANCELLED', 'PDF work was cancelled', error);
  }
  if (
    candidate.name === 'InvalidPDFException' ||
    candidate.name === 'FormatError'
  ) {
    return failure('PDF_CORRUPT', 'PDF is corrupt or unsupported', error);
  }
  return failure(
    'PDF_CORRUPT',
    typeof candidate.message === 'string'
      ? candidate.message
      : 'PDF provider failed',
    error,
  );
}

/** Abort guard shared by the render provider and the editing surface. */
export function assertSignal(signal?: AbortSignal): void {
  if (signal?.aborted === true)
    throw failure('PDF_RENDER_CANCELLED', 'PDF work was cancelled');
}

function isTextItem(item: unknown): item is PdfJsTextItem {
  return (
    typeof item === 'object' &&
    item !== null &&
    typeof (item as { str?: unknown }).str === 'string' &&
    Array.isArray((item as { transform?: unknown }).transform)
  );
}

function createTaskGate(
  limit: number,
): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= limit)
      await new Promise<void>((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

async function resolveDestinationPage(
  document: PDFDocumentProxy,
  destination: unknown,
): Promise<number | undefined> {
  let explicit = destination;
  if (typeof explicit === 'string')
    explicit = await document.getDestination(explicit);
  if (!Array.isArray(explicit) || explicit.length === 0) return undefined;
  const target = explicit[0];
  if (typeof target === 'number') return target;
  if (typeof target === 'object' && target !== null) {
    try {
      return await document.getPageIndex(target as never);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

async function projectOutline(
  document: PDFDocumentProxy,
  values: readonly unknown[],
  count: { value: number },
): Promise<PdfOutlineEntry[]> {
  const result: PdfOutlineEntry[] = [];
  for (const value of values) {
    count.value += 1;
    if (count.value > PDF_LIMITS.maxOutlineNodes) {
      throw failure('PDF_RESOURCE_LIMIT', 'PDF outline exceeds the node limit');
    }
    const item = value as {
      readonly title?: unknown;
      readonly dest?: unknown;
      readonly items?: unknown;
      readonly url?: unknown;
    };
    const pageIndex =
      item.dest === undefined
        ? undefined
        : await resolveDestinationPage(document, item.dest);
    const children = Array.isArray(item.items)
      ? await projectOutline(document, item.items, count)
      : [];
    result.push({
      id: `pdf-outline-${count.value}`,
      title: typeof item.title === 'string' ? item.title : '',
      ...(pageIndex !== undefined ? { pageIndex } : {}),
      children,
    });
  }
  return result;
}

async function pageLinks(
  document: PDFDocumentProxy,
  page: PDFPageProxy,
): Promise<PdfLink[]> {
  const annotations = await page.getAnnotations({ intent: 'display' });
  if (annotations.length > PDF_LIMITS.maxLinksPerPage) {
    throw failure(
      'PDF_RESOURCE_LIMIT',
      'PDF page annotations exceed the link limit',
    );
  }
  const links: PdfLink[] = [];
  for (const annotation of annotations) {
    const item = annotation as {
      readonly subtype?: unknown;
      readonly url?: unknown;
      readonly dest?: unknown;
      readonly rect?: unknown;
    };
    if (item.subtype !== 'Link') continue;
    const bounds =
      Array.isArray(item.rect) &&
      item.rect.every((value) => typeof value === 'number')
        ? (item.rect as number[])
        : undefined;
    const url = typeof item.url === 'string' ? item.url : undefined;
    const scheme =
      url === undefined
        ? ''
        : (/^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase() ?? '');
    if (
      url !== undefined &&
      (scheme === 'http' || scheme === 'https' || scheme === 'mailto')
    ) {
      links.push({
        kind: 'external',
        url,
        ...(bounds !== undefined ? { bounds } : {}),
      });
      continue;
    }
    const pageIndex = await resolveDestinationPage(document, item.dest);
    if (pageIndex !== undefined) {
      links.push({
        kind: 'page',
        pageIndex,
        ...(bounds !== undefined ? { bounds } : {}),
      });
    }
    // JavaScript, Launch, GoToR, file, and other active actions are
    // intentionally absent from the Froglight projection.
  }
  return links;
}

/**
 * Third-party engine DOM: the PDF.js page mount —
 * render canvas, transparent text layer with per-glyph geometry spans, and
 * link-hit buttons — is owned by the render provider, not by React.
 * Positions come from PDF transforms at render time, so they stay inline
 * styles; only the stable reader wrapper is React-owned
 * (react/PdfReaderSkeleton.tsx).
 */
function mountDomPage(
  page: PDFPageProxy,
  request: PdfPageMountRequest,
  links: readonly PdfLink[],
  onDestroy: () => void,
): Promise<PdfMountedPageHandle> {
  const parent = request.parent as {
    appendChild?: unknown;
    ownerDocument?: Document;
  };
  if (typeof parent.appendChild !== 'function') {
    throw failure(
      'PDF_CORRUPT',
      'PDF page mount parent is not a DOM container',
    );
  }
  const ownerDocument = parent.ownerDocument ?? document;
  const viewport = page.getViewport({ scale: request.scale });
  if (
    viewport.width > PDF_LIMITS.maxRenderDimension ||
    viewport.height > PDF_LIMITS.maxRenderDimension ||
    viewport.width * viewport.height > PDF_LIMITS.maxRenderArea
  ) {
    throw failure(
      'PDF_RESOURCE_LIMIT',
      'PDF display render exceeds configured limits',
    );
  }
  const root = ownerDocument.createElement('div');
  root.className = 'fl-pdf-page';
  root.style.position = 'relative';
  root.style.width = `${viewport.width}px`;
  root.style.height = `${viewport.height}px`;
  const canvas = ownerDocument.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(viewport.width));
  canvas.height = Math.max(1, Math.ceil(viewport.height));
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  root.appendChild(canvas);
  const textLayer = ownerDocument.createElement('div');
  textLayer.className = 'fl-pdf-text-layer';
  Object.assign(textLayer.style, {
    position: 'absolute',
    inset: '0',
    overflow: 'hidden',
    color: 'transparent',
    lineHeight: '1',
  });
  root.appendChild(textLayer);
  parent.appendChild(root);
  const context = canvas.getContext('2d');
  if (context === null)
    throw failure('PDF_CORRUPT', 'Canvas 2D is unavailable');
  const renderTask = page.render({ canvas, canvasContext: context, viewport });
  let destroyed = false;
  const abort = (): void => renderTask.cancel();
  request.signal?.addEventListener('abort', abort, { once: true });

  return Promise.all([renderTask.promise, page.getTextContent()])
    .then(([, content]) => {
      for (const item of content.items) {
        if (!isTextItem(item) || item.str === '') continue;
        const transform = Util.transform(viewport.transform, item.transform);
        const span = ownerDocument.createElement('span');
        span.textContent = item.str;
        Object.assign(span.style, {
          position: 'absolute',
          whiteSpace: 'pre',
          left: `${transform[4]}px`,
          top: `${transform[5] - Math.hypot(transform[2], transform[3])}px`,
          fontSize: `${Math.hypot(transform[2], transform[3])}px`,
          transformOrigin: '0 0',
        });
        textLayer.appendChild(span);
      }
      for (const link of links) {
        if (link.bounds === undefined || link.bounds.length < 4) continue;
        const [x1, y1] = viewport.convertToViewportPoint(
          link.bounds[0]!,
          link.bounds[1]!,
        );
        const [x2, y2] = viewport.convertToViewportPoint(
          link.bounds[2]!,
          link.bounds[3]!,
        );
        const button = ownerDocument.createElement('button');
        button.type = 'button';
        button.className = 'fl-pdf-source-link';
        button.setAttribute(
          'aria-label',
          link.kind === 'external'
            ? 'Open external PDF link'
            : `Go to PDF page ${link.pageIndex + 1}`,
        );
        Object.assign(button.style, {
          position: 'absolute',
          left: `${Math.min(x1, x2)}px`,
          top: `${Math.min(y1, y2)}px`,
          width: `${Math.abs(x2 - x1)}px`,
          height: `${Math.abs(y2 - y1)}px`,
          border: '0',
          padding: '0',
          background: 'transparent',
        });
        button.addEventListener('click', () => request.onLinkActivate?.(link));
        textLayer.appendChild(button);
      }
      const setEnabled = (enabled: boolean): void => {
        textLayer.style.pointerEvents = enabled ? 'auto' : 'none';
        textLayer.style.userSelect = enabled ? 'text' : 'none';
        textLayer.style.webkitUserSelect = enabled ? 'text' : 'none';
        textLayer.style.setProperty(
          '-webkit-touch-callout',
          enabled ? 'default' : 'none',
        );
        textLayer.style.cursor = enabled ? 'text' : 'default';
      };
      setEnabled(request.sourceInteraction);
      return {
        setSourceInteractionEnabled: setEnabled,
        destroy: () => {
          if (destroyed) return;
          destroyed = true;
          request.signal?.removeEventListener('abort', abort);
          renderTask.cancel();
          root.remove();
          onDestroy();
        },
      };
    })
    .catch((error) => {
      root.remove();
      onDestroy();
      throw normalizeError(error);
    });
}

export class PdfJsProvider implements PdfProvider {
  async open(input: {
    readonly bytes: Uint8Array;
    readonly password?: string;
    readonly signal?: AbortSignal;
  }): Promise<PdfDocumentHandle> {
    if (input.bytes.byteLength > PDF_LIMITS.maxSourceBytes) {
      throw failure('PDF_RESOURCE_LIMIT', 'PDF source exceeds the byte limit');
    }
    assertSignal(input.signal);
    const bytes = input.bytes.slice();
    const loading = getDocument({
      data: bytes,
      ...(input.password !== undefined ? { password: input.password } : {}),
      enableXfa: false,
      disableAutoFetch: true,
      disableStream: true,
      stopAtErrors: true,
    });
    let passwordFailure: FroglightError | null = null;
    loading.onPassword = (
      _updatePassword: (password: string) => void,
      reason: number,
    ) => {
      passwordFailure =
        reason === PasswordResponses.INCORRECT_PASSWORD
          ? failure('PDF_PASSWORD_INCORRECT', 'PDF password is incorrect')
          : failure('PDF_PASSWORD_REQUIRED', 'PDF requires a password');
      void loading.destroy();
    };
    const abortOpen = (): void => {
      void loading.destroy();
    };
    input.signal?.addEventListener('abort', abortOpen, { once: true });
    let documentProxy: PDFDocumentProxy;
    try {
      documentProxy = await loading.promise;
    } catch (error) {
      if (passwordFailure !== null) throw passwordFailure;
      throw normalizeError(error);
    } finally {
      input.signal?.removeEventListener('abort', abortOpen);
    }
    if (documentProxy.numPages > PDF_LIMITS.maxPages) {
      await loading.destroy();
      throw failure('PDF_RESOURCE_LIMIT', 'PDF exceeds the page-count limit');
    }

    let closed = false;
    const mounted = new Set<PdfMountedPageHandle>();
    const textCache = new Map<number, PdfPageText>();
    const gate = createTaskGate(PDF_LIMITS.maxConcurrentPageTasks);
    const assertPage = (pageIndex: number): void => {
      if (
        !Number.isInteger(pageIndex) ||
        pageIndex < 0 ||
        pageIndex >= documentProxy.numPages
      ) {
        throw failure(
          'PDF_PAGE_OUT_OF_RANGE',
          `PDF page ${pageIndex} is out of range`,
        );
      }
    };
    const operation = async <T>(
      signal: AbortSignal | undefined,
      task: () => Promise<T>,
    ): Promise<T> => {
      if (closed) throw failure('PDF_RENDER_CANCELLED', 'PDF handle is closed');
      assertSignal(signal);
      try {
        return await gate(async () => {
          if (closed)
            throw failure('PDF_RENDER_CANCELLED', 'PDF handle is closed');
          const value = await task();
          assertSignal(signal);
          if (closed)
            throw failure('PDF_RENDER_CANCELLED', 'PDF handle is closed');
          return value;
        });
      } catch (error) {
        throw normalizeError(error);
      }
    };
    const getText = async (
      pageIndex: number,
      signal?: AbortSignal,
    ): Promise<PdfPageText> => {
      assertPage(pageIndex);
      const cached = textCache.get(pageIndex);
      if (cached !== undefined) return cached;
      return operation(signal, async () => {
        const page = await documentProxy.getPage(pageIndex + 1);
        const content = await page.getTextContent({
          disableNormalization: false,
        });
        const items: Array<{ text: string }> = [];
        for (const item of content.items) {
          if (isTextItem(item)) items.push({ text: item.str });
        }
        const characters = items.reduce(
          (total, item) => total + item.text.length,
          0,
        );
        if (
          items.length > PDF_LIMITS.maxTextItemsPerPage ||
          characters > PDF_LIMITS.maxTextCharactersPerPage
        ) {
          throw failure(
            'PDF_RESOURCE_LIMIT',
            'PDF page text exceeds configured limits',
          );
        }
        const result: PdfPageText = { kind: 'source', items };
        textCache.set(pageIndex, result);
        return result;
      });
    };
    const pageLinkCache = createPdfPageLinkCache((pageIndex) => {
      assertPage(pageIndex);
      return (async () =>
        pageLinks(documentProxy, await documentProxy.getPage(pageIndex + 1))
      )();
    });
    const getLinks = (pageIndex: number, signal?: AbortSignal) =>
      operation(signal, () => pageLinkCache.get(pageIndex));
    const handle: PdfDocumentHandle = {
      pageCount: documentProxy.numPages,
      getPageInfo: async (pageIndex, signal) => {
        assertPage(pageIndex);
        const page = await operation(signal, () =>
          documentProxy.getPage(pageIndex + 1),
        );
        return {
          pageIndex,
          geometry: normalizePdfPageGeometry({
            mediaBox: page.view as [number, number, number, number],
            userUnit: page.userUnit,
            rotate: page.rotate,
          }),
        } satisfies PdfPageInfo;
      },
      getPageText: getText,
      getOutline: (signal) =>
        operation(signal, async () => {
          const outline = await documentProxy.getOutline();
          return outline === null
            ? []
            : projectOutline(documentProxy, outline, { value: 0 });
        }),
      getLinks,
      mountPage: async (request) => {
        assertPage(request.pageIndex);
        return operation(request.signal, async () => {
          const page = await documentProxy.getPage(request.pageIndex + 1);
          const links = await pageLinkCache.get(request.pageIndex);
          const mountedHandleRef: { value?: PdfMountedPageHandle } = {};
          const mountedHandle = await mountDomPage(page, request, links, () => {
            if (mountedHandleRef.value !== undefined)
              mounted.delete(mountedHandleRef.value);
          });
          mountedHandleRef.value = mountedHandle;
          mounted.add(mountedHandle);
          return mountedHandle;
        });
      },
      close: async () => {
        if (closed) return;
        closed = true;
        for (const page of [...mounted]) await page.destroy();
        mounted.clear();
        textCache.clear();
        pageLinkCache.clear();
        await loading.destroy();
      },
    };
    return handle;
  }
}
