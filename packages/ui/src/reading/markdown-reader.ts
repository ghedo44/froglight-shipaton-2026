/**
 * Markdown reading-view provider — shell-owned derived HTML preview.
 *
 * Mounted by the workbench in `reading` mode through the centralized
 * DocumentReaderRegistry, alongside editor-owned readers such as LaTeX.
 * Rendering is the declarative `MarkdownReaderView` React component over the
 * zero-dependency `renderMarkdown` projection; canonical storage stays raw
 * `.md`. This module owns one isolated React root inside the opaque parent
 *  and returns its disposer. The reader handle contract
 * (`update`/`revealAddress`/`destroy`) is unchanged. The single synchronous
 * root commit happens inside `mountIsolatedReactRoot` during creation;
 * `update` additionally flushes the view's state update synchronously per
 * the handle's long-standing contract.
 */

import { createElement } from 'react';
import { flushSync } from 'react-dom';
import {
  markdownKindId,
  type DocumentReaderHandle,
  type DocumentReaderProvider,
  type DocumentSession,
} from '@froglight/foundation';
import { mountIsolatedReactRoot } from '../react/index.js';
import {
  MarkdownReaderView,
  type MarkdownReaderViewHandle,
} from '../react/MarkdownReaderView.jsx';
import type { MarkdownEmbed } from './markdown-embeds.js';

export interface MarkdownReaderDeps {
  /** Debounce for re-renders after session changes. */
  readonly renderDebounceMillis?: number;
  /** Derived per-note scroll memory; absent means no persistence. */
  readonly loadScroll?: (documentId: string) => number;
  readonly saveScroll?: (documentId: string, top: number) => void;
  readonly resolveEmbed?: (session: DocumentSession, destination: string) => Promise<MarkdownEmbed>;
  readonly onEmbedChange?: (listener: () => void) => { dispose(): void };
}

export class MarkdownReaderProvider implements DocumentReaderProvider {
  readonly id = 'markdown-reader';
  readonly kindIds = [markdownKindId];
  readonly #deps: MarkdownReaderDeps;

  constructor(deps: MarkdownReaderDeps = {}) {
    this.#deps = deps;
  }

  createReader(input: {
    readonly session: DocumentSession;
    readonly parent: unknown;
  }): DocumentReaderHandle {
    const session = input.session;
    const parent = input.parent as HTMLElement;
    const handleRef: { current: MarkdownReaderViewHandle | null } = {
      current: null,
    };
    let destroyed = false;
    // One isolated root per reader host; the helper commits synchronously
    // and owns the single initial commit — no outer flushSync here.
    let bridge: { dispose(): void } | null = mountIsolatedReactRoot(
      parent,
      createElement(MarkdownReaderView, {
        session,
        renderDebounceMillis: this.#deps.renderDebounceMillis,
        loadScroll: this.#deps.loadScroll,
        saveScroll: this.#deps.saveScroll,
        resolveEmbed: this.#deps.resolveEmbed,
        onEmbedChange: this.#deps.onEmbedChange,
        handleRef,
      }),
    );
    return {
      update: (): void => {
        if (destroyed || handleRef.current === null) return;
        // Single synchronous flush of the view's state update — this is the
        // handle's long-standing synchronous `update` contract (pinned by
        // reading/markdown-reader.spec.ts), not a nested root commit: the
        // root helper owns the initial commit; this only flushes the view.
        const view = handleRef.current;
        flushSync(() => {
          view.update();
        });
      },
      revealAddress: (address: string): void => {
        if (destroyed) return;
        handleRef.current?.revealAddress(address);
      },
      destroy: (): void => {
        if (destroyed) return;
        destroyed = true;
        const current = bridge;
        bridge = null;
        // Unmount before anything else tears down: the root owns the DOM
        // the view reads (scroll host, handle ref).
        current?.dispose();
      },
    };
  }
}
