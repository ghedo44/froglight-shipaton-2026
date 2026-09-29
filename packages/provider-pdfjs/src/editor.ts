/**
 * PDF document editor provider — standalone PDF reading surface.
 *
 * Each document kind keeps its own `<Kind>DocumentEditorProvider` behind
 * the package barrel. The render capability itself lives in
 * `pdf-provider.ts`; this module owns only the workbench editing surface
 * (page navigation, source-text selection, outline/links, notebook import).
 */
import {
  type PdfDocumentHandle,
  type PdfLink,
  type PdfMountedPageHandle,
  type PdfOutlineEntry,
  type PdfProvider,
  pdfKindId,
  type DocumentEditorHandle,
  type DocumentEditorProvider,
  type DocumentEditorTools,
  type DocumentSession,
  type PdfSourceModel,
} from '@froglight/foundation';
import { assertSignal } from './pdf-provider.js';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import {
  PdfReaderSkeleton,
  type PdfSkeleton,
} from './react/PdfReaderSkeleton.jsx';
export interface PdfReaderSearchHit {
  readonly pageIndex: number;
  readonly address: string;
  readonly text: string;
}

export interface PdfReaderHandle extends DocumentEditorHandle {
  searchSource(
    query: string,
    signal?: AbortSignal,
  ): Promise<readonly PdfReaderSearchHit[]>;
  getOutline(signal?: AbortSignal): Promise<readonly PdfOutlineEntry[]>;
  getLinks(
    pageIndex: number,
    signal?: AbortSignal,
  ): Promise<readonly PdfLink[]>;
}

export interface PdfDocumentEditorDeps {
  readonly pdfProvider: PdfProvider | (() => PdfProvider | null);
  readonly promptForPassword?: (
    reason: 'required' | 'incorrect',
  ) => Promise<string | null>;
  readonly importAsNotebook?: (bytes: Uint8Array) => void | Promise<void>;
  readonly openExternalLink?: (url: string) => void | Promise<void>;
}

type PdfReaderState = 'idle' | 'opening' | 'ready' | 'locked' | 'error';
type PdfOutlineState = 'loading' | 'ready' | 'empty' | 'unavailable';

interface PdfReaderViewState {
  pageIndex: number;
  password?: string;
}

interface PdfOutlineDestination {
  readonly value: string;
  readonly pageIndex: number;
  readonly label: string;
}

function outlineDestinations(
  entries: readonly PdfOutlineEntry[],
  pageCount: number,
  depth = 0,
  result: PdfOutlineDestination[] = [],
): PdfOutlineDestination[] {
  for (const entry of entries) {
    if (
      entry.pageIndex !== undefined &&
      entry.pageIndex >= 0 &&
      entry.pageIndex < pageCount
    ) {
      result.push({
        value: `${result.length}:${entry.pageIndex}`,
        pageIndex: entry.pageIndex,
        label: `${'  '.repeat(depth)}${entry.title}`,
      });
    }
    outlineDestinations(entry.children, pageCount, depth + 1, result);
  }
  return result;
}

class PdfReaderHandleImpl implements PdfReaderHandle {
  readonly tools: DocumentEditorTools;
  readonly #options: PdfDocumentEditorDeps;
  readonly #bytes: Uint8Array;
  readonly #abort = new AbortController();
  readonly #root: HTMLDivElement | null;
  readonly #reactRoot: Root | null;
  readonly #resizeObserver: ResizeObserver | null;
  readonly #viewState: PdfReaderViewState;
  #attempt: Promise<PdfDocumentHandle> | null = null;
  #document: PdfDocumentHandle | null = null;
  #failure: unknown = null;
  #state: PdfReaderState = 'idle';
  #openGeneration = 0;
  #renderGeneration = 0;
  #mounted: PdfMountedPageHandle | null = null;
  #pageIndex = 0;
  #pageCount = 0;
  #outline: readonly PdfOutlineEntry[] = [];
  #outlineDestinations: readonly PdfOutlineDestination[] = [];
  #outlineState: PdfOutlineState = 'loading';
  #renderedWidth = 0;
  #destroyed = false;
  #sourceInteraction = true;
  readonly #listeners = new Set<() => void>();

  constructor(
    bytes: Uint8Array,
    parent: unknown,
    options: PdfDocumentEditorDeps,
    viewState: PdfReaderViewState,
  ) {
    this.#bytes = bytes.slice();
    this.#options = options;
    this.#viewState = viewState;
    this.#pageIndex = viewState.pageIndex;
    const domParent = parent as {
      appendChild?: unknown;
      ownerDocument?: Document;
    };
    if (typeof domParent.appendChild === 'function') {
      // One narrowly contained synchronous commit: the provider
      // needs the actual reader element immediately, and createEditor is
      // synchronous. Never during normal rendering or engine updates.
      const skeletonRef: { current: PdfSkeleton | null } = { current: null };
      const reactRoot = createRoot(domParent as unknown as HTMLElement);
      flushSync(() => {
        reactRoot.render(createElement(PdfReaderSkeleton, { skeletonRef }));
      });
      const skeleton = skeletonRef.current;
      if (skeleton === null) {
        reactRoot.unmount();
        throw new Error('pdf reader skeleton failed to commit');
      }
      this.#reactRoot = reactRoot;
      this.#root = skeleton.root;
    } else {
      this.#reactRoot = null;
      this.#root = null;
    }
    if (this.#root !== null && typeof ResizeObserver === 'function') {
      this.#resizeObserver = new ResizeObserver(() => {
        if (this.#destroyed || this.#state !== 'ready' || this.#root === null)
          return;
        const width = this.#root.clientWidth;
        if (width <= 0 || Math.abs(width - this.#renderedWidth) < 1) return;
        void this.#renderCurrent();
      });
      this.#resizeObserver.observe(this.#root);
    } else {
      this.#resizeObserver = null;
    }
    this.tools = {
      snapshot: () => ({
        context: 'PDF source',
        controls: [
          {
            kind: 'button',
            id: 'pdf.previous',
            semanticRole: 'pdf.page.previous',
            group: 'pages',
            label: 'Previous PDF page',
            shortLabel: 'Previous',
            icon: 'arrow-back',
            disabled: this.#state !== 'ready' || this.#pageIndex <= 0,
          },
          {
            kind: 'status',
            id: 'pdf.page',
            group: 'pages',
            label:
              this.#state === 'locked'
                ? 'PDF locked'
                : this.#state === 'error'
                  ? 'PDF unavailable'
                  : this.#state !== 'ready'
                    ? 'Opening PDF'
                    : `${this.#pageIndex + 1} / ${this.#pageCount}`,
          },
          ...(this.#state === 'locked' || this.#state === 'error'
            ? ([
                {
                  kind: 'button',
                  id: 'pdf.retry',
                  semanticRole: 'pdf.retry',
                  group: 'pages',
                  label:
                    this.#state === 'locked' ? 'Unlock PDF' : 'Retry PDF',
                  shortLabel: this.#state === 'locked' ? 'Unlock' : 'Retry',
                  icon: this.#state === 'locked' ? 'unlock' : 'refresh',
                  disabled: false,
                },
              ] as const)
            : []),
          {
            kind: 'button',
            id: 'pdf.next',
            semanticRole: 'pdf.page.next',
            group: 'pages',
            label: 'Next PDF page',
            shortLabel: 'Next',
            icon: 'arrow-forward',
            disabled:
              this.#state !== 'ready' ||
              this.#pageIndex >= this.#pageCount - 1,
          },
          ...(this.#state === 'ready' && this.#outlineDestinations.length > 0
            ? ([
                {
                  kind: 'choice',
                  id: 'pdf.outline',
                  group: 'pages',
                  label: 'PDF outline',
                  value: '',
                  options: [
                    { value: '', label: 'PDF outline…' },
                    ...this.#outlineDestinations.map(({ value, label }) => ({
                      value,
                      label,
                    })),
                  ],
                },
              ] as const)
            : []),
          ...(this.#state === 'ready' && this.#outlineState === 'unavailable'
            ? ([
                {
                  kind: 'status',
                  id: 'pdf.outline',
                  group: 'pages',
                  label: 'PDF outline unavailable',
                },
              ] as const)
            : []),
          {
            kind: 'button',
            id: 'pdf.source-select',
            semanticRole: 'pdf.select.source',
            group: 'interaction',
            label: 'Select and copy source text',
            shortLabel: 'Source Select',
            icon: 'cursor',
            active: this.#sourceInteraction,
            disabled: this.#state !== 'ready',
            // Interaction-mode toggle, never an exclusive editing tool.
            activationRole: 'toggle',
          },
          {
            kind: 'button',
            id: 'pdf.import-notebook',
            semanticRole: 'pdf.annotate.notebook',
            group: 'document',
            label: 'Annotate / Import as Notebook',
            shortLabel: 'Annotate',
            icon: 'notebook',
            disabled:
              this.#state !== 'ready' ||
              this.#options.importAsNotebook === undefined,
          },
        ],
      }),
      execute: (id, value) => {
        if (id === 'pdf.previous') {
          if (this.#state !== 'ready') return false;
          void this.#goTo(this.#pageIndex - 1);
          return true;
        }
        if (id === 'pdf.next') {
          if (this.#state !== 'ready') return false;
          void this.#goTo(this.#pageIndex + 1);
          return true;
        }
        if (id === 'pdf.outline' && value !== undefined && value !== '') {
          if (this.#state !== 'ready') return false;
          const destination = this.#outlineDestinations.find(
            (candidate) => candidate.value === value,
          );
          if (destination === undefined) return false;
          void this.#goTo(destination.pageIndex);
          return true;
        }
        if (id === 'pdf.source-select') {
          if (this.#state !== 'ready') return false;
          this.#sourceInteraction = !this.#sourceInteraction;
          this.#mounted?.setSourceInteractionEnabled?.(this.#sourceInteraction);
          this.#notify();
          return true;
        }
        if (
          id === 'pdf.import-notebook' &&
          this.#state === 'ready' &&
          this.#options.importAsNotebook !== undefined
        ) {
          void this.#options.importAsNotebook(this.#bytes.slice());
          return true;
        }
        if (id === 'pdf.retry') return this.#startOpen();
        return false;
      },
      onDidChange: (listener) => {
        this.#listeners.add(listener);
        return { dispose: () => this.#listeners.delete(listener) };
      },
    };
    this.#startOpen();
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }

  #startOpen(): boolean {
    if (
      this.#destroyed ||
      this.#state === 'opening' ||
      this.#state === 'ready'
    ) {
      return false;
    }
    const generation = ++this.#openGeneration;
    this.#renderGeneration += 1;
    this.#state = 'opening';
    this.#failure = null;
    this.#document = null;
    this.#pageCount = 0;
    this.#outline = [];
    this.#outlineDestinations = [];
    this.#outlineState = 'loading';
    this.#showPlaceholder('Opening PDF…');
    this.#notify();
    const attempt = this.#open();
    this.#attempt = attempt;
    void attempt.then(
      (handle) => this.#acceptOpen(generation, handle),
      (error: unknown) => this.#failOpen(generation, error),
    );
    return true;
  }

  async #acceptOpen(
    generation: number,
    handle: PdfDocumentHandle,
  ): Promise<void> {
    if (this.#destroyed) return;
    if (generation !== this.#openGeneration) {
      await handle.close();
      return;
    }
    this.#document = handle;
    this.#pageCount = handle.pageCount;
    this.#pageIndex = Math.min(
      Math.max(0, this.#pageIndex),
      Math.max(0, this.#pageCount - 1),
    );
    this.#viewState.pageIndex = this.#pageIndex;
    try {
      await this.#renderCurrent();
    } catch (error) {
      if (this.#destroyed || generation !== this.#openGeneration) return;
      this.#document = null;
      await handle.close();
      this.#failOpen(generation, error);
      return;
    }
    if (this.#destroyed || generation !== this.#openGeneration) return;
    this.#state = 'ready';
    this.#notify();
    try {
      const outline = await handle.getOutline(this.#abort.signal);
      if (this.#destroyed || generation !== this.#openGeneration) return;
      this.#outline = outline;
      this.#outlineDestinations = outlineDestinations(
        outline,
        this.#pageCount,
      );
      this.#outlineState =
        this.#outlineDestinations.length > 0 ? 'ready' : 'empty';
    } catch {
      if (this.#destroyed || generation !== this.#openGeneration) return;
      this.#outline = [];
      this.#outlineDestinations = [];
      this.#outlineState = 'unavailable';
    }
    this.#notify();
  }

  #failOpen(generation: number, error: unknown): void {
    if (this.#destroyed || generation !== this.#openGeneration) return;
    this.#attempt = null;
    this.#document = null;
    this.#failure = error;
    const code =
      typeof error === 'object' && error !== null
        ? (error as { code?: unknown }).code
        : undefined;
    this.#state =
      code === 'PDF_PASSWORD_REQUIRED' || code === 'PDF_PASSWORD_INCORRECT'
        ? 'locked'
        : 'error';
    this.#showPlaceholder(
      this.#state === 'locked' ? 'PDF is locked.' : 'PDF is unavailable.',
      this.#state === 'locked' ? 'Unlock PDF' : 'Retry PDF',
    );
    this.#notify();
  }

  #showPlaceholder(message: string, actionLabel?: string): void {
    if (this.#root === null || this.#destroyed) return;
    const placeholder = this.#root.ownerDocument.createElement('div');
    placeholder.className = 'fl-pdf-reader-placeholder';
    const description = this.#root.ownerDocument.createElement('p');
    description.textContent = message;
    placeholder.append(description);
    if (actionLabel !== undefined) {
      const retry = this.#root.ownerDocument.createElement('button');
      retry.type = 'button';
      retry.className = 'fl-pdf-reader-retry';
      retry.textContent = actionLabel;
      retry.addEventListener('click', () => this.#startOpen());
      placeholder.append(retry);
    }
    this.#root.replaceChildren(placeholder);
  }

  async #open(): Promise<PdfDocumentHandle> {
    let password = this.#viewState.password;
    let reason: 'required' | 'incorrect' = 'required';
    while (true) {
      if (this.#destroyed) throw new Error('PDF reader was destroyed');
      try {
        const provider =
          typeof this.#options.pdfProvider === 'function'
            ? this.#options.pdfProvider()
            : this.#options.pdfProvider;
        if (provider === null) throw new Error('PDF provider is unavailable');
        const handle = await provider.open({
          bytes: this.#bytes.slice(),
          ...(password !== undefined ? { password } : {}),
          signal: this.#abort.signal,
        });
        this.#viewState.password = password;
        return handle;
      } catch (error) {
        if (this.#destroyed) throw error;
        const code =
          typeof error === 'object' && error !== null
            ? (error as { code?: unknown }).code
            : undefined;
        if (
          (code !== 'PDF_PASSWORD_REQUIRED' &&
            code !== 'PDF_PASSWORD_INCORRECT') ||
          this.#options.promptForPassword === undefined
        ) {
          throw error;
        }
        this.#viewState.password = undefined;
        reason = code === 'PDF_PASSWORD_INCORRECT' ? 'incorrect' : reason;
        const entered = await this.#options.promptForPassword(reason);
        if (this.#destroyed) throw error;
        if (entered === null) throw error;
        password = entered;
      }
    }
  }

  async #goTo(pageIndex: number): Promise<void> {
    if (
      this.#destroyed ||
      this.#state !== 'ready' ||
      pageIndex < 0 ||
      pageIndex >= this.#pageCount
    )
      return;
    this.#pageIndex = pageIndex;
    this.#viewState.pageIndex = pageIndex;
    await this.#renderCurrent();
    this.#notify();
  }

  async #renderCurrent(): Promise<void> {
    if (this.#root === null || this.#destroyed || this.#document === null)
      return;
    const generation = ++this.#renderGeneration;
    const previous = this.#mounted;
    this.#mounted = null;
    await previous?.destroy();
    if (this.#destroyed || generation !== this.#renderGeneration) return;
    this.#root.replaceChildren();
    const handle = this.#document;
    if (handle.mountPage === undefined) return;
    const info = await handle.getPageInfo(this.#pageIndex, this.#abort.signal);
    if (this.#destroyed || generation !== this.#renderGeneration) return;
    const availableWidth =
      this.#root.clientWidth || info.geometry.pageBox.widthPt;
    this.#renderedWidth = availableWidth;
    const scale = Math.min(
      4,
      Math.max(0.1, availableWidth / info.geometry.pageBox.widthPt),
    );
    const mounted = await handle.mountPage({
      pageIndex: this.#pageIndex,
      parent: this.#root,
      scale,
      signal: this.#abort.signal,
      sourceInteraction: this.#sourceInteraction,
      onLinkActivate: (link) => {
        if (link.kind === 'page') void this.#goTo(link.pageIndex);
        else void this.#options.openExternalLink?.(link.url);
      },
    });
    if (this.#destroyed || generation !== this.#renderGeneration) {
      await mounted.destroy();
      return;
    }
    this.#mounted = mounted;
  }

  async #currentDocument(): Promise<PdfDocumentHandle> {
    if (this.#document !== null) return this.#document;
    if (this.#attempt !== null) return this.#attempt;
    throw this.#failure ?? new Error('PDF is unavailable');
  }

  async searchSource(
    query: string,
    signal?: AbortSignal,
  ): Promise<readonly PdfReaderSearchHit[]> {
    const needle = query.trim().toLocaleLowerCase();
    if (needle === '') return [];
    const handle = await this.#currentDocument();
    const hits: PdfReaderSearchHit[] = [];
    for (let pageIndex = 0; pageIndex < handle.pageCount; pageIndex += 1) {
      assertSignal(signal);
      const page = await handle.getPageText(pageIndex, signal);
      const text = page.items.map((item) => item.text).join('');
      if (text.toLocaleLowerCase().includes(needle)) {
        hits.push({ pageIndex, address: String(pageIndex), text });
      }
    }
    return hits;
  }

  async getOutline(signal?: AbortSignal): Promise<readonly PdfOutlineEntry[]> {
    if (this.#outlineState === 'ready' || this.#outlineState === 'empty')
      return this.#outline;
    return (await this.#currentDocument()).getOutline(signal);
  }

  async getLinks(
    pageIndex: number,
    signal?: AbortSignal,
  ): Promise<readonly PdfLink[]> {
    return (await this.#currentDocument()).getLinks(pageIndex, signal);
  }

  focus(): void {
    this.#root?.focus();
  }

  hasFocus(): boolean {
    return this.#root?.ownerDocument.activeElement === this.#root;
  }

  setReadOnly(_readOnly: boolean): void {
    // Standalone PDF source bytes are always immutable.
  }

  canExecCommand(_id: 'undo' | 'redo'): boolean {
    return false;
  }

  execCommand(_id: 'undo' | 'redo'): boolean {
    return false;
  }

  revealAddress(address: string): void {
    const pageIndex = Number(address);
    if (Number.isInteger(pageIndex)) void this.#goTo(pageIndex);
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#openGeneration += 1;
    this.#renderGeneration += 1;
    this.#resizeObserver?.disconnect();
    // Unmount first so React cleanly removes the skeleton it owns; the
    // engine teardown below then runs against detached nodes (its own
    // root.remove() becomes a harmless no-op). Reversing the order yanks
    // React-managed DOM out from under the root and corrupts teardown.
    this.#reactRoot?.unmount();
    this.#abort.abort();
    void this.#mounted?.destroy();
    this.#mounted = null;
    this.#root?.remove();
    this.#listeners.clear();
    void this.#attempt?.then(
      (handle) => handle.close(),
      () => undefined,
    );
  }
}

export class PdfDocumentEditorProvider implements DocumentEditorProvider {
  readonly id = 'pdf';
  readonly kindIds = [pdfKindId] as const;
  readonly #options: PdfDocumentEditorDeps;
  // Reading position and an unlocked password live only as long as the live
  // workbench session. Responsive host replacement must not reset either.
  readonly #viewStates = new WeakMap<DocumentSession, PdfReaderViewState>();

  constructor(options: PdfDocumentEditorDeps) {
    this.#options = options;
  }

  createEditor(input: {
    readonly session: DocumentSession;
    readonly parent: unknown;
  }): PdfReaderHandle {
    const session = input.session as DocumentSession<PdfSourceModel>;
    let viewState = this.#viewStates.get(session);
    if (viewState === undefined) {
      viewState = { pageIndex: 0 };
      this.#viewStates.set(session, viewState);
    }
    return new PdfReaderHandleImpl(
      session.model.bytes,
      input.parent,
      this.#options,
      viewState,
    );
  }
}
