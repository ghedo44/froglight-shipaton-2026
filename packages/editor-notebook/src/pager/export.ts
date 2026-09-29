/**
 * Notebook render/export helpers.
 *
 * Single-page derived image rendering and whole-notebook PNG export using
 * the same Surface object registry, background compilation, PDF base, and
 * image resolver as on-screen rendering. Export never mutates canonical
 * state. Moved out of `page-surface.ts` (and `pager.ts`) so the
 * page-surface adapter remains interaction policy; the generic
 * `exportSurfacePng` download helper lives here too.
 */

import {
  baseOf,
  createDefaultSurfaceObjectTypeRegistry,
  frameBounds,
  isWorkspacePath,
  isNavigablePage,
  navigablePageIds,
  paperOptionsOf,
  sha256Hex,
  renderSurfaceScene,
  templateBackgroundDrawItems,
  templateOf,
  PDF_LIMITS,
  type DrawItem,
  type DocumentAssetStore,
  type CompositionImage,
  type NotebookModel,
  type PdfDocumentHandle,
  type PdfProvider,
  type StoredAsset,
  type SurfaceModel,
  type SurfaceObjectTypeRegistry,
} from '@froglight/foundation';
import {
  CanvasSurfaceRendererBackend,
  type SurfaceImageResolver,
} from '@froglight/surface-default';
import {
  createSurfaceImageCache,
  decodeImageBytes,
} from '@froglight/editor-ink';

/** Render one bounded surface to a derived PNG download without mutating it. */
export function exportSurfacePng(options: {
  readonly model: SurfaceModel;
  readonly backgroundItems?: readonly DrawItem[];
  readonly imageResolver?: SurfaceImageResolver;
  readonly filename?: string;
  readonly isActive?: () => boolean;
}): void {
  if (typeof document === 'undefined') return;
  const size = frameBounds(options.model.frame) ?? { width: 800, height: 600 };
  const scale = 2;
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(size.width * scale));
  out.height = Math.max(1, Math.round(size.height * scale));
  const outCtx = out.getContext('2d');
  if (outCtx === null) return;
  outCtx.fillStyle = '#ffffff';
  outCtx.fillRect(0, 0, out.width, out.height);
  renderSurfaceScene(
    new CanvasSurfaceRendererBackend(outCtx, { images: options.imageResolver }),
    options.model,
    createDefaultSurfaceObjectTypeRegistry(),
    { x: 0, y: 0, zoom: scale },
    { width: out.width, height: out.height, dpr: 1 },
    { backgroundItems: options.backgroundItems },
  );
  if (typeof out.toBlob !== 'function') return;
  out.toBlob((blob) => {
    if (blob === null || options.isActive?.() === false) return;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = options.filename ?? 'page.png';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, 'image/png');
}

/** Collaborator seams the export flows need from the pager. */
export interface NotebookExportEnvironment {
  readonly objectRegistry: SurfaceObjectTypeRegistry;
  readonly imageResolver: SurfaceImageResolver;
  readonly backgroundFor: (pageId: string) => () => readonly DrawItem[];
  readonly requestPageImages: (surface: SurfaceModel) => Promise<void>;
  readonly pdfDocumentFor: (asset: StoredAsset) => Promise<PdfDocumentHandle>;
  readonly isActive: () => boolean;
}

/** Default export resolution: 144dpi (scale 2 @ 72pt), matching prior downloads. */
export const NOTEBOOK_PNG_EXPORT_DPI = 144;

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw cancelledExportError();
}

/** Shared cancellation error for pager-owned export scopes. */
export function cancelledExportError(): DOMException {
  return new DOMException('Export cancelled', 'AbortError');
}

/**
 * Render one notebook page to PNG bytes (editor-contract export path).
 * Operates through renderer/provider seams; throws for unknown pages,
 * unbounded frames, unavailable canvas, and cancelled signals.
 */
export async function renderNotebookPageImage(
  env: NotebookExportEnvironment,
  model: NotebookModel,
  pageId: string,
  dpi: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const entry = model.pages[pageId];
  if (!isNavigablePage(entry))
    throw new Error(`Notebook page ${pageId} is unavailable`);
  throwIfAborted(signal);
  await env.requestPageImages(entry.surface);
  // Cancellation is checked after every async boundary, not only before
  // work begins: a pager-owned abort (editor destruction) must stop the
  // export promptly instead of pointlessly rendering a doomed page.
  throwIfAborted(signal);
  const size = frameBounds(entry.surface.frame);
  if (size === null) throw new Error(`Notebook page ${pageId} is not bounded`);
  const scale = dpi / 72;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(size.width * scale));
  canvas.height = Math.max(1, Math.ceil(size.height * scale));
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('Canvas export is unavailable');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  const base = baseOf(entry);
  if (base.kind === 'pdf-page') {
    const pdf = await env.pdfDocumentFor(base.asset);
    throwIfAborted(signal);
    if (pdf.mountPage === undefined)
      throw new Error('PDF page rendering is unavailable');
    const staging = document.createElement('div');
    const mountedPage = await pdf.mountPage({
      pageIndex: base.pageIndex,
      parent: staging,
      scale,
      ...(signal !== undefined ? { signal } : {}),
      sourceInteraction: false,
    });
    try {
      // The mount may still resolve after cancellation (a provider that
      // ignores the signal): abort before compositing. The handle is always
      // destroyed via `finally` below.
      throwIfAborted(signal);
      const source = staging.querySelector<HTMLCanvasElement>('canvas');
      if (source === null)
        throw new Error('PDF page renderer produced no canvas');
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
    } finally {
      await mountedPage.destroy();
    }
  }
  renderSurfaceScene(
    new CanvasSurfaceRendererBackend(context, { images: env.imageResolver }),
    entry.surface,
    env.objectRegistry,
    { x: 0, y: 0, zoom: scale },
    { width: canvas.width, height: canvas.height, dpr: 1 },
    { backgroundItems: env.backgroundFor(pageId)() },
  );
  throwIfAborted(signal);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => {
      if (value === null)
        reject(new Error('Notebook page PNG encoding failed'));
      else resolve(value);
    }, 'image/png');
  });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  throwIfAborted(signal);
  return bytes;
}

/**
 * Render the first few Notebook pages as small derived images for resource
 * embeds. The previews use the same page compositor as the Pages sidebar and
 * never expose Notebook's extracted text as the embedded content.
 */
export async function renderNotebookPreviewImages(
  model: NotebookModel,
  options: {
    readonly assets?: DocumentAssetStore | null;
    readonly pdfProvider?: PdfProvider | null;
  } = {},
): Promise<readonly CompositionImage[]> {
  if (typeof document === 'undefined') return [];

  const imageCache =
    options.assets == null
      ? undefined
      : createSurfaceImageCache({
          assets: options.assets,
          decode: decodeImageBytes,
        });
  const pdfDocuments = new Map<string, Promise<PdfDocumentHandle>>();
  const pageIds = navigablePageIds(model).slice(0, 4);
  const exportEnv: NotebookExportEnvironment = {
    objectRegistry: createDefaultSurfaceObjectTypeRegistry(),
    imageResolver: imageCache?.resolver ?? new Map(),
    backgroundFor: (pageId) => () => {
      const page = model.pages[pageId];
      if (!isNavigablePage(page)) return [];
      const size = frameBounds(page.surface.frame);
      if (size === null) return [];
      return templateBackgroundDrawItems(
        templateOf(page),
        size.width,
        size.height,
        paperOptionsOf(page),
      );
    },
    requestPageImages: (surface) =>
      imageCache?.requestSurface(surface) ?? Promise.resolve(),
    pdfDocumentFor: (asset) => {
      if (
        options.assets == null ||
        options.pdfProvider == null ||
        !isWorkspacePath(asset.path)
      )
        return Promise.reject(new Error('PDF preview is unavailable'));
      const existing = pdfDocuments.get(asset.sha256);
      if (existing !== undefined) return existing;
      const open = options.assets
        .read(asset.path)
        .then(async (bytes) => {
          if (
            bytes.byteLength > PDF_LIMITS.maxSourceBytes ||
            (await sha256Hex(bytes)) !== asset.sha256
          )
            throw new Error('PDF asset is unavailable');
          return options.pdfProvider!.open({ bytes });
        })
        .catch((error: unknown) => {
          pdfDocuments.delete(asset.sha256);
          throw error;
        });
      pdfDocuments.set(asset.sha256, open);
      return open;
    },
    isActive: () => true,
  };

  try {
    const rendered = await Promise.all(
      pageIds.map(async (pageId, index) => {
        const page = model.pages[pageId];
        if (!isNavigablePage(page)) return undefined;
        try {
          const bytes = await renderNotebookPageImage(
            exportEnv,
            model,
            pageId,
            48,
          );
          const dataUrl = await pngDataUrl(bytes);
          const size = frameBounds(page.surface.frame);
          const scale = 48 / 72;
          return {
            mimeType: 'image/png' as const,
            dataUrl,
            alt: `Notebook page ${index + 1} preview`,
            width: Math.max(1, Math.ceil((size?.width ?? 800) * scale)),
            height: Math.max(1, Math.ceil((size?.height ?? 600) * scale)),
          };
        } catch {
          return undefined;
        }
      }),
    );
    return rendered.filter(
      (image): image is CompositionImage => image !== undefined,
    );
  } finally {
    imageCache?.dispose();
    const opened = await Promise.allSettled(pdfDocuments.values());
    await Promise.allSettled(
      opened.flatMap((result) =>
        result.status === 'fulfilled' ? [result.value.close()] : [],
      ),
    );
  }
}

function pngDataUrl(bytes: Uint8Array): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(
      new Blob([bytes.slice().buffer as ArrayBuffer], { type: 'image/png' }),
    );
  });
}

/**
 * Download one page's PNG bytes without mutating canonical state. No-op when
 * the pager is inactive/destroyed. The mounted-handle fast path is
 * intentionally not used: it renders only the annotation/template surface
 * and can omit the PDF base. All user-facing PNG exports go through the
 * canonical `renderNotebookPageImage` compositor.
 */
export async function downloadCurrentNotebookPageAsPng(
  env: NotebookExportEnvironment,
  model: NotebookModel,
  page: { readonly pageId: string; readonly index: number },
  dpi: number = NOTEBOOK_PNG_EXPORT_DPI,
  signal?: AbortSignal,
): Promise<void> {
  const bytes = await renderNotebookPageImage(
    env,
    model,
    page.pageId,
    dpi,
    signal,
  ).catch((error) => {
    // Cancelled/destroyed exports stay silent; real failures propagate.
    if (
      (error instanceof DOMException && error.name === 'AbortError') ||
      signal?.aborted ||
      !env.isActive()
    ) {
      return null;
    }
    throw error;
  });
  if (bytes === null || !env.isActive() || signal?.aborted) return;
  downloadPngBytes(bytes, `notebook-page-${page.index + 1}.png`);
}

/**
 * Download every page as PNG through the canonical compositor, correctly
 * handling mixed template/PDF pages. Never mutates canonical state. Stops
 * early when inactive/cancelled; already-rendered pages still download, but
 * no stale PDF handles leak (each `renderNotebookPageImage` destroys its
 * staging mount in `finally`).
 */
export async function downloadNotebookPagesAsPng(
  env: NotebookExportEnvironment,
  model: NotebookModel,
  pages: readonly {
    readonly pageId: string;
    readonly index: number;
  }[],
  dpi: number = NOTEBOOK_PNG_EXPORT_DPI,
  signal?: AbortSignal,
): Promise<void> {
  for (const { pageId, index } of pages) {
    if (!env.isActive() || signal?.aborted) return;
    const bytes = await renderNotebookPageImage(
      env,
      model,
      pageId,
      dpi,
      signal,
    ).catch((error) => {
      if (
        (error instanceof DOMException && error.name === 'AbortError') ||
        signal?.aborted ||
        !env.isActive()
      ) {
        return null;
      }
      throw error;
    });
    if (bytes === null || !env.isActive() || signal?.aborted) return;
    downloadPngBytes(bytes, `notebook-page-${index + 1}.png`);
  }
}

function downloadPngBytes(bytes: Uint8Array, filename: string): void {
  if (
    typeof document === 'undefined' ||
    typeof URL?.createObjectURL !== 'function'
  ) {
    return;
  }
  // Copy to detach from any pooled buffer; Blob takes ownership of a fresh copy.
  const copy = new Uint8Array(bytes);
  // `BlobPart` typing needs a plain ArrayBuffer view; the copy above is safe.
  const blob = new Blob([copy as BlobPart], { type: 'image/png' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
