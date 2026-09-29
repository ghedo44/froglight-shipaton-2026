/**
 * LaTeX reading-view provider — sandboxed preview only.
 *
 * Mounted by the workbench in `reading` mode through the centralized
 * DocumentReaderRegistry. The provider owns the only rendered-HTML surface
 * in the product: an iframe sandboxed with `allow-same-origin` and
 * deliberately without `allow-scripts`, so provider output cannot execute
 * code even though the host can scroll it for outline-matched navigation.
 * Canonical bytes flow through the shared session;
 * preview state is always derived and never persisted.
 *
 * Diagnostics live with the source editor in edit mode; this reader shows
 * a clean preview plus recoverable placeholders when the provider is
 * missing or rendering fails.
 */

import type {
  DocumentReaderHandle,
  DocumentReaderProvider,
  DocumentSession,
  LaTeXDocumentHandle,
} from '@froglight/foundation';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { latexKindId } from '@froglight/foundation';
import {
  PREVIEW_SANDBOX,
  latexPlaceholderDocument,
  resolveLatexAddress,
  type LatexRenderDeps,
} from './latex-shared.js';
import { LatexReaderSkeleton } from './react/LatexReaderSkeleton.jsx';

/** Render-capability dependencies for the reading-mode preview. */
export type LatexDocumentReaderDeps = LatexRenderDeps;

/** Visible skeleton elements: owned by React, consumed by the engine. */
export interface LatexReaderSkeleton {
  readonly root: HTMLDivElement;
  readonly frame: HTMLIFrameElement;
}

/**
 * Global theme tokens mirrored from the shell into the isolated preview
 * document (which cannot inherit them). Inline values win; the preview CSS
 * falls back to light literals plus system/explicit dark defaults.
 */
const PREVIEW_THEME_TOKENS: readonly string[] = [
  '--fl-surface-editor',
  '--fl-text-primary',
  '--fl-border-default',
  '--fl-accent-soft',
  '--fl-accent-strong',
  '--_fl-editor-floating-top',
];

class LatexDocumentReaderHandle implements DocumentReaderHandle {
  readonly #deps: LatexDocumentReaderDeps;
  readonly #session: DocumentSession;
  readonly #wrapper: HTMLElement;
  readonly #iframe: HTMLIFrameElement;
  readonly #root: Root;
  #handle: LaTeXDocumentHandle | null = null;
  readonly #closing = new WeakMap<LaTeXDocumentHandle, Promise<void>>();
  #previewDocument: Document | null = null;
  #renderTimer: ReturnType<typeof setTimeout> | null = null;
  #renderGeneration = 0;
  #destroyed = false;
  #themeObserver: MutationObserver | null = null;
  #schemeMedia: MediaQueryList | null = null;

  constructor(
    deps: LatexDocumentReaderDeps,
    session: DocumentSession,
    parent: HTMLElement,
  ) {
    this.#deps = deps;
    this.#session = session;

    // One narrowly contained synchronous commit: the engine
    // needs the actual iframe host immediately, and createReader is
    // synchronous. Never during normal rendering or engine updates.
    const skeletonRef: { current: LatexReaderSkeleton | null } = {
      current: null,
    };
    const root = createRoot(parent);
    flushSync(() => {
      root.render(createElement(LatexReaderSkeleton, { skeletonRef }));
    });
    const skeleton = skeletonRef.current;
    if (skeleton === null)
      throw new Error('latex reader skeleton failed to commit');
    this.#root = root;
    this.#wrapper = skeleton.root;
    this.#iframe = skeleton.frame;
    // Clicks inside the iframe never bubble to the parent document; attach to
    // each loaded contentDocument (srcdoc swaps the document per render).
    this.#iframe.addEventListener('load', this.#onPreviewLoad);
    // The preview document is isolated (no scripts inside): mirror the
    // shell world (explicit `data-theme` plus live token values) on every
    // load and on every shell theme change.
    const outerRoot = this.#iframe.ownerDocument.documentElement;
    this.#themeObserver = new MutationObserver(() => {
      this.#syncPreviewTheme();
    });
    this.#themeObserver.observe(outerRoot, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    const schemeMedia =
      this.#iframe.ownerDocument.defaultView?.matchMedia?.(
        '(prefers-color-scheme: dark)',
      ) ?? null;
    this.#schemeMedia = schemeMedia;
    schemeMedia?.addEventListener?.('change', this.#onSchemeChange);

    this.#scheduleRender();
  }

  update(): void {
    this.#scheduleRender();
  }

  #scheduleRender(): void {
    if (this.#destroyed) return;
    // Invalidate now, not when the debounce expires: pending work already
    // represents older source, including when the session is already dirty.
    const generation = ++this.#renderGeneration;
    if (this.#renderTimer !== null) clearTimeout(this.#renderTimer);
    this.#renderTimer = setTimeout(() => {
      this.#renderTimer = null;
      void this.#render(generation);
    }, this.#deps.renderDebounceMillis ?? 500);
  }

  #isCurrent(generation: number): boolean {
    return !this.#destroyed && generation === this.#renderGeneration;
  }

  #close(handle: LaTeXDocumentHandle): Promise<void> {
    let closing = this.#closing.get(handle);
    if (closing === undefined) {
      // Cleanup failure must not strand a newer projection or cause an
      // unhandled rejection during synchronous destroy. Never retry a close.
      try {
        closing = handle.close().catch(() => undefined);
      } catch {
        closing = Promise.resolve();
      }
      this.#closing.set(handle, closing);
    }
    return closing;
  }

  async #render(generation: number): Promise<void> {
    if (!this.#isCurrent(generation)) return;
    let handle: LaTeXDocumentHandle | null = null;
    try {
      const provider = this.#deps.latexProvider();
      const documentPath = this.#deps.resolveDocumentPath(this.#session);
      const resolver = documentPath !== null ? this.#deps.createResolver(documentPath) : null;
      if (provider === null || resolver === null) {
        const previous = this.#handle;
        this.#handle = null;
        this.#iframe.srcdoc = latexPlaceholderDocument(
          'LaTeX preview unavailable',
          'No LaTeX preview provider is bound. The source document is unchanged.',
        );
        if (previous !== null) await this.#close(previous);
        return;
      }
      const entry = (this.#session.model as unknown as { raw: string }).raw;
      handle = await provider.open({ entry, resolve: resolver });
      if (!this.#isCurrent(generation)) {
        await this.#close(handle);
        return;
      }
      const previous = this.#handle;
      this.#handle = handle;
      if (previous !== null) await this.#close(previous);
      if (!this.#isCurrent(generation)) {
        if (this.#handle === handle) this.#handle = null;
        await this.#close(handle);
        return;
      }
      const result = await handle.render();
      if (!this.#isCurrent(generation)) {
        if (this.#handle === handle) this.#handle = null;
        await this.#close(handle);
        return;
      }
      // Current failure cannot masquerade as a successful older preview.
      this.#iframe.srcdoc = result.html !== '' ? result.html : latexPlaceholderDocument(
        'LaTeX preview unavailable',
        result.diagnostics[0]?.message ?? 'The preview provider could not render this document.',
      );
    } catch (error) {
      if (this.#isCurrent(generation)) {
        const message = error instanceof Error ? error.message : String(error);
        this.#iframe.srcdoc = latexPlaceholderDocument('LaTeX preview failed', message);
      }
      if (handle !== null) {
        if (this.#handle === handle) this.#handle = null;
        await this.#close(handle);
      }
    }
  }

  readonly #onPreviewLoad = (): void => {
    this.#previewDocument?.removeEventListener('click', this.#onPreviewClick);
    this.#previewDocument?.removeEventListener('contextmenu', this.#onPreviewContextMenu);
    this.#previewDocument = this.#destroyed ? null : this.#iframe.contentDocument;
    this.#previewDocument?.addEventListener('click', this.#onPreviewClick);
    this.#previewDocument?.addEventListener('contextmenu', this.#onPreviewContextMenu);
    this.#syncPreviewTheme();
  };

  readonly #onPreviewContextMenu = (event: Event): void => {
    event.preventDefault();
  };

  readonly #onSchemeChange = (): void => {
    this.#syncPreviewTheme();
  };

  #syncPreviewTheme(): void {
    if (this.#destroyed) return;
    const owner = this.#iframe.ownerDocument;
    const outer = owner?.documentElement ?? null;
    const inner = this.#iframe.contentDocument?.documentElement ?? null;
    if (outer === null || inner === null) return;
    const theme = outer.getAttribute('data-theme');
    if (theme === null) inner.removeAttribute('data-theme');
    else inner.setAttribute('data-theme', theme);
    try {
      // Read from the preview wrapper, not the document root: theme tokens
      // inherit to both, while split/edit toolbar clearance is pane-local.
      const computed =
        owner.defaultView?.getComputedStyle(this.#wrapper) ?? null;
      if (computed === null) return;
      for (const token of PREVIEW_THEME_TOKENS) {
        const value = computed.getPropertyValue(token).trim();
        if (value !== '') inner.style.setProperty(token, value);
        else inner.style.removeProperty(token);
      }
    } catch {
      // Theme sync is best-effort derived state; a failed read must never
      // break preview clicks, scrolling, or rendering.
    }
  }

  #scrollPreviewToSection(title: string, occurrence: number): boolean {
    const doc = this.#iframe.contentDocument;
    if (doc === null) return false;
    const headings = Array.from(doc.querySelectorAll('h1, h2, h3, h4, h5, h6'));
    const normalized = title.replace(/\s+/g, ' ').trim();
    if (normalized === '') return false;
    const matches = headings.filter((heading) =>
      (heading.textContent ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .endsWith(normalized),
    );
    const match = matches[occurrence];
    if (match === undefined) return false;
    match.scrollIntoView({ block: 'start' });
    return true;
  }

  /** Outline/heading navigation: scroll the preview to the section. */
  revealAddress(address: string): void {
    if (this.#destroyed) return;
    const hit = resolveLatexAddress(
      (this.#session.model as unknown as { raw: string }).raw,
      address,
    );
    if (hit !== null) this.#scrollPreviewToSection(hit.title, hit.occurrence);
  }

  /**
   * Preview click stays in the preview: scroll to the nearest preceding
   * section heading so long sections remain navigable without a source.
   */
  readonly #onPreviewClick = (event: Event): void => {
    const doc = this.#iframe.contentDocument;
    if (doc === null || this.#destroyed) return;
    const target = event.target;
    if (
      target === null ||
      typeof target !== 'object' ||
      !('contains' in target)
    )
      return;
    const targetNode = target as Node;
    const headings = Array.from(doc.querySelectorAll('h1, h2, h3, h4, h5, h6'));
    for (const heading of headings) {
      if (heading === targetNode || heading.contains(targetNode)) {
        heading.scrollIntoView({ block: 'start' });
        return;
      }
    }
    let best: Element | null = null;
    for (const heading of headings) {
      if (
        typeof targetNode.compareDocumentPosition === 'function' &&
        (targetNode.compareDocumentPosition(heading) &
          Node.DOCUMENT_POSITION_PRECEDING) !==
          0
      ) {
        best = heading;
      }
    }
    best?.scrollIntoView({ block: 'start' });
  };

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    if (this.#renderTimer !== null) clearTimeout(this.#renderTimer);
    this.#renderGeneration += 1;
    const handle = this.#handle;
    this.#handle = null;
    if (handle !== null) void this.#close(handle);
    this.#iframe.removeEventListener('load', this.#onPreviewLoad);
    this.#schemeMedia?.removeEventListener?.('change', this.#onSchemeChange);
    this.#schemeMedia = null;
    this.#themeObserver?.disconnect();
    this.#themeObserver = null;
    this.#previewDocument?.removeEventListener('click', this.#onPreviewClick);
    this.#previewDocument?.removeEventListener('contextmenu', this.#onPreviewContextMenu);
    this.#previewDocument = null;
    // Unmount first so React cleanly removes the skeleton it owns; the
    // engine teardown below then runs against detached nodes (its own
    // wrapper.remove() becomes a harmless no-op). Reversing the order yanks
    // React-managed DOM out from under the root and corrupts teardown.
    this.#root.unmount();
    this.#wrapper.remove();
  }
}

export class LatexDocumentReaderProvider implements DocumentReaderProvider {
  readonly id = 'latex-reader';
  readonly kindIds = [latexKindId];
  readonly #deps: LatexDocumentReaderDeps;

  constructor(deps: LatexDocumentReaderDeps) {
    this.#deps = deps;
  }

  createReader(input: {
    readonly session: DocumentSession;
    readonly parent: unknown;
  }): DocumentReaderHandle {
    return new LatexDocumentReaderHandle(
      this.#deps,
      input.session,
      input.parent as HTMLElement,
    );
  }
}

export { PREVIEW_SANDBOX };
