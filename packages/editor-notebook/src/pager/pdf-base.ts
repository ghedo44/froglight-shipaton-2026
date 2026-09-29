/**
 * Notebook PDF base manager.
 *
 * Owns pager-internal PDF concerns: asset-byte loading with integrity
 * validation, the document pool keyed by content hash, password retry for
 * mounted notebook bases, page info/geometry, mount/unmount into shell
 * hosts, source-interaction mode propagation on the base side, link
 * activation, and outline projection. Pager orchestration asks this
 * collaborator to mount/update/destroy a base instead of manipulating
 * provider handles directly.
 *
 * Password handling stays provider-neutral: opens retry through the
 * Notebook-local prompt callback over the foundation `PdfProvider`
 * contract. `provider-pdfjs` internals are never imported.
 */

import {
  sha256Hex,
  isWorkspacePath,
  PDF_LIMITS,
  type DocumentAssetStore,
  type PdfDocumentHandle,
  type PdfMountedPageHandle,
  type PdfProvider,
  type StoredAsset,
} from '@froglight/foundation';

export interface PdfBaseGeometry {
  readonly pageIndex: number;
  readonly pageBox: { readonly widthPt: number; readonly heightPt: number };
}

export interface PdfBaseEnvironment {
  readonly assets?: DocumentAssetStore | null;
  readonly pdfProvider?: PdfProvider | null;
  readonly promptForPassword?: (
    reason: 'required' | 'incorrect',
  ) => Promise<string | null>;
  readonly openExternalLink?: (url: string) => void | Promise<void>;
  /**
   * Resolve an internal link to a notebook page index (`-1` when the
   * target is not a notebook page). The manager navigates through this
   * callback so it never reads the canonical model itself.
   */
  readonly resolveInternalLink?: (
    assetSha256: string,
    pageIndex: number,
  ) => number;
  readonly navigateToPageIndex?: (index: number) => void;
  /** Current source-interaction mode, re-read at mount/completion time. */
  readonly sourceInteraction: () => boolean;
  readonly isActive: () => boolean;
  readonly trackTask?: <T>(task: Promise<T>) => Promise<T>;
}

export interface PdfBaseOutlineEntry {
  readonly pageId: string;
  readonly label: string;
}

interface MountedBase {
  readonly abort: AbortController;
  readonly host: HTMLElement;
  readonly asset: StoredAsset;
  readonly geometry: PdfBaseGeometry;
  readonly renderScale: number;
  handle?: PdfMountedPageHandle;
}

function track(env: PdfBaseEnvironment, task: Promise<unknown>): void {
  if (env.trackTask !== undefined) void env.trackTask(task);
}

function isPasswordError(error: unknown): 'required' | 'incorrect' | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { code?: unknown }).code;
  if (code === 'PDF_PASSWORD_REQUIRED') return 'required';
  if (code === 'PDF_PASSWORD_INCORRECT') return 'incorrect';
  return null;
}

export interface PdfBaseManager {
  /** Pooled document open with integrity check and password retry. */
  openDocument(asset: StoredAsset): Promise<PdfDocumentHandle>;
  /**
   * Mount a PDF page base into `host` (prepends an engine-owned layer).
   * Async work is abort-safe: teardown before completion destroys the
   * handle and leaves no layer behind.
   */
  mountBase(
    pageId: string,
    host: HTMLElement,
    base: PdfBaseGeometry & { readonly asset: StoredAsset },
  ): void;
  unmountBase(pageId: string): void;
  /** Propagate the current source-interaction mode to base layers/handles. */
  setBaseInteraction(): void;
  /** Drop a pending layout-triggered rerender without remounting. */
  cancelScheduledRerender(): void;
  /** Recompute render scales after layout changes; remounts stale bases. */
  noteLayoutChanged(shellOf: (pageId: string) => HTMLElement | undefined): void;
  /** Project the source outline for the given pages. */
  loadOutline(
    pages: readonly {
      readonly pageId: string;
      readonly asset: StoredAsset;
      readonly pageIndex: number;
    }[],
  ): Promise<PdfBaseOutlineEntry[]>;
  destroy(): void;
}

export function createPdfBaseManager(env: PdfBaseEnvironment): PdfBaseManager {
  const documents = new Map<string, Promise<PdfDocumentHandle>>();
  const mounted = new Map<string, MountedBase>();
  let rerenderTimer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;

  async function openWithPasswordRetry(
    asset: StoredAsset,
  ): Promise<PdfDocumentHandle> {
    if (env.assets == null || env.pdfProvider == null) {
      throw new Error('PDF asset or provider is unavailable');
    }
    const { assets, pdfProvider } = env;
    const bytes = await assets.read(asset.path);
    if ((await sha256Hex(bytes)) !== asset.sha256) {
      throw new Error('PDF_ASSET_INTEGRITY');
    }
    let password: string | undefined;
    for (;;) {
      try {
        return await pdfProvider.open({
          bytes,
          ...(password !== undefined ? { password } : {}),
        });
      } catch (error) {
        const reason = isPasswordError(error);
        if (reason === null || env.promptForPassword === undefined) {
          throw error;
        }
        // A destroy or deactivation while the prompt is pending must not
        // leak a successfully opened handle with nobody left to close it.
        if (destroyed || !env.isActive()) throw error;
        const entered = await env.promptForPassword(reason);
        if (entered === null || destroyed || !env.isActive()) throw error;
        password = entered;
      }
    }
  }

  function openDocument(asset: StoredAsset): Promise<PdfDocumentHandle> {
    const existing = documents.get(asset.sha256);
    if (existing !== undefined) return existing;
    if (
      env.assets == null ||
      env.pdfProvider == null ||
      !isWorkspacePath(asset.path)
    ) {
      return Promise.reject(new Error('PDF asset or provider is unavailable'));
    }
    const task = openWithPasswordRetry(asset).catch((error: unknown) => {
      if (documents.get(asset.sha256) === task) documents.delete(asset.sha256);
      throw error;
    });
    documents.set(asset.sha256, task);
    return task;
  }

  function unmountBase(pageId: string): void {
    const record = mounted.get(pageId);
    if (record === undefined) return;
    record.abort.abort();
    void record.handle?.destroy();
    mounted.delete(pageId);
    record.host.querySelector(':scope > .fl-nb-pdf-base')?.remove();
  }

  function syncBaseScale(record: MountedBase): void {
    const rendered = record.host.querySelector<HTMLElement>(
      ':scope > .fl-nb-pdf-base > .fl-pdf-page',
    );
    if (rendered === null) return;
    const shellWidth =
      record.host.clientWidth || Number.parseFloat(record.host.style.width);
    if (!Number.isFinite(shellWidth) || shellWidth <= 0) return;
    const scale =
      shellWidth / record.geometry.pageBox.widthPt / record.renderScale;
    rendered.style.transformOrigin = '0 0';
    rendered.style.transform = `scale(${scale})`;
  }

  function showPlaceholder(
    record: MountedBase,
    layer: HTMLElement,
    message: string,
  ): void {
    if (
      destroyed ||
      record.abort.signal.aborted ||
      !record.host.contains(layer)
    ) {
      return;
    }
    const placeholder = document.createElement('div');
    placeholder.className = 'fl-nb-pdf-placeholder';
    placeholder.dataset.pdfPlaceholder = 'true';
    placeholder.textContent = message;
    layer.replaceChildren(placeholder);
  }

  function renderScaleFor(host: HTMLElement, base: PdfBaseGeometry): number {
    const shellWidth =
      host.clientWidth || Number.parseFloat(host.style.width) || 0;
    return clampRenderScale(base.pageBox, shellWidth / base.pageBox.widthPt);
  }

  /**
   * Render scale for a base at the given display scale (shell width per
   * PDF point), clamped by pixel ratio and provider resource limits.
   */
  function clampRenderScale(
    pageBox: { readonly widthPt: number; readonly heightPt: number },
    displayScale: number,
  ): number {
    if (!Number.isFinite(displayScale) || displayScale <= 0) return 1;
    const pixelRatio = Math.max(window.devicePixelRatio || 1, 1);
    const dimensionScale = Math.min(
      PDF_LIMITS.maxRenderDimension / pageBox.widthPt,
      PDF_LIMITS.maxRenderDimension / pageBox.heightPt,
    );
    const areaScale = Math.sqrt(
      PDF_LIMITS.maxRenderArea / (pageBox.widthPt * pageBox.heightPt),
    );
    return Math.max(
      0.01,
      Math.min(displayScale * pixelRatio, dimensionScale, areaScale),
    );
  }

  function mountBase(
    pageId: string,
    host: HTMLElement,
    base: PdfBaseGeometry & { readonly asset: StoredAsset },
  ): void {
    if (destroyed) return;
    // Engine-owned PDF render target: the immutable
    // page base is rendered by the PDF provider into this layer, with a
    // recoverable placeholder when the source is locked or unavailable.
    // Pointer-events flip with the source-interaction mode at runtime.
    const layer = document.createElement('div');
    layer.className = 'fl-nb-pdf-base';
    layer.style.pointerEvents = env.sourceInteraction() ? 'auto' : 'none';
    host.prepend(layer);
    const abort = new AbortController();
    const record: MountedBase = {
      abort,
      host,
      asset: base.asset,
      geometry: { pageIndex: base.pageIndex, pageBox: base.pageBox },
      renderScale: renderScaleFor(host, base),
    };
    mounted.set(pageId, record);
    track(
      env,
      openDocument(base.asset)
        .then(async (pdf) => {
          if (abort.signal.aborted) return;
          const info = await pdf.getPageInfo(base.pageIndex, abort.signal);
          if (
            Math.abs(info.geometry.pageBox.widthPt - base.pageBox.widthPt) >
              1e-6 ||
            Math.abs(info.geometry.pageBox.heightPt - base.pageBox.heightPt) >
              1e-6
          ) {
            throw new Error(
              'PDF page geometry does not match the Notebook base',
            );
          }
          if (pdf.mountPage === undefined) {
            showPlaceholder(
              record,
              layer,
              'PDF preview is unavailable. Annotations remain editable.',
            );
            return;
          }
          const handle = await pdf.mountPage({
            pageIndex: base.pageIndex,
            parent: layer,
            scale: record.renderScale,
            signal: abort.signal,
            sourceInteraction: env.sourceInteraction(),
            onLinkActivate: (link) => {
              if (link.kind === 'external') {
                void env.openExternalLink?.(link.url);
                return;
              }
              const targetIndex =
                env.resolveInternalLink?.(base.asset.sha256, link.pageIndex) ??
                -1;
              if (targetIndex !== -1) env.navigateToPageIndex?.(targetIndex);
            },
          });
          if (abort.signal.aborted) {
            await handle.destroy();
            return;
          }
          record.handle = handle;
          syncBaseScale(record);
          setBaseInteraction();
        })
        .catch((error: unknown) => {
          showPlaceholder(
            record,
            layer,
            isPasswordError(error) !== null
              ? 'PDF is locked. Unlock the source to restore its page base; annotations are preserved.'
              : 'PDF page base is unavailable or failed integrity validation; annotations are preserved.',
          );
          if (
            isPasswordError(error) !== null &&
            env.promptForPassword !== undefined &&
            !destroyed &&
            !abort.signal.aborted &&
            host.contains(layer)
          ) {
            layer.dataset.recovery = 'true';
            const retry = document.createElement('button');
            retry.type = 'button';
            retry.textContent = 'Unlock PDF';
            retry.className = 'fl-nb-pdf-unlock';
            retry.addEventListener('pointerdown', (event) =>
              event.stopPropagation(),
            );
            retry.addEventListener('click', () => {
              // All visible pages share one pooled open/password prompt.
              for (const [id, current] of [...mounted]) {
                if (current.asset.sha256 !== base.asset.sha256) continue;
                unmountBase(id);
                mountBase(id, current.host, {
                  asset: current.asset,
                  ...current.geometry,
                });
              }
            });
            layer.querySelector('[data-pdf-placeholder]')?.append(retry);
          }
        }),
    );
  }

  function setBaseInteraction(): void {
    const selecting = env.sourceInteraction();
    for (const record of mounted.values()) {
      const layer = record.host.querySelector<HTMLElement>(
        ':scope > .fl-nb-pdf-base',
      );
      if (layer !== null) {
        layer.style.pointerEvents = selecting ? 'auto' : 'none';
      }
      record.handle?.setSourceInteractionEnabled?.(selecting);
    }
  }

  function noteLayoutChanged(
    shellOf: (pageId: string) => HTMLElement | undefined,
  ): void {
    if (destroyed) return;
    // Exact transform sync is synchronous on every layout (cheap); heavier
    // remounts debounce below and apply only past the drift threshold.
    for (const record of mounted.values()) syncBaseScale(record);
    if (mounted.size === 0) return;
    if (rerenderTimer !== null) clearTimeout(rerenderTimer);
    rerenderTimer = setTimeout(() => {
      rerenderTimer = null;
      if (destroyed) return;
      for (const [pageId, record] of [...mounted]) {
        const host = shellOf(pageId);
        if (host === undefined) continue;
        const shellWidth =
          host.clientWidth || Number.parseFloat(host.style.width) || 0;
        if (shellWidth <= 0) continue;
        const nextScale = clampRenderScale(
          record.geometry.pageBox,
          shellWidth / record.geometry.pageBox.widthPt,
        );
        if (Math.abs(nextScale / record.renderScale - 1) < 0.05) continue;
        unmountBase(pageId);
        // Remount through the stored base description; the scale recomputes
        // from live layout inside the fresh mount.
        mountBase(pageId, host, {
          asset: record.asset,
          pageIndex: record.geometry.pageIndex,
          pageBox: record.geometry.pageBox,
        });
      }
    }, 100);
  }

  async function loadOutline(
    pages: readonly {
      readonly pageId: string;
      readonly asset: StoredAsset;
      readonly pageIndex: number;
    }[],
  ): Promise<PdfBaseOutlineEntry[]> {
    const groups = new Map<
      string,
      { asset: StoredAsset; pageIds: Map<number, string> }
    >();
    for (const page of pages) {
      const group = groups.get(page.asset.sha256) ?? {
        asset: page.asset,
        pageIds: new Map<number, string>(),
      };
      group.pageIds.set(page.pageIndex, page.pageId);
      groups.set(page.asset.sha256, group);
    }
    const projected: PdfBaseOutlineEntry[] = [];
    const appendEntries = (
      entries: Awaited<ReturnType<PdfDocumentHandle['getOutline']>>,
      pageIds: ReadonlyMap<number, string>,
      depth = 0,
    ): void => {
      for (const entry of entries) {
        const pageId =
          entry.pageIndex === undefined
            ? undefined
            : pageIds.get(entry.pageIndex);
        if (pageId !== undefined) {
          projected.push({
            pageId,
            label: `${'  '.repeat(depth)}${entry.title}`,
          });
        }
        appendEntries(entry.children, pageIds, depth + 1);
      }
    };
    for (const group of groups.values()) {
      const pdf = await openDocument(group.asset);
      appendEntries(await pdf.getOutline(), group.pageIds);
    }
    return projected;
  }

  function cancelScheduledRerender(): void {
    if (rerenderTimer !== null) {
      clearTimeout(rerenderTimer);
      rerenderTimer = null;
    }
  }

  function destroy(): void {
    if (destroyed) return;
    destroyed = true;
    cancelScheduledRerender();
    for (const pageId of [...mounted.keys()]) unmountBase(pageId);
    for (const task of documents.values()) {
      void task.then(
        (document) => document.close(),
        () => undefined,
      );
    }
    documents.clear();
  }

  return {
    openDocument,
    mountBase,
    unmountBase,
    setBaseInteraction,
    cancelScheduledRerender,
    noteLayoutChanged,
    loadOutline,
    destroy,
  };
}
