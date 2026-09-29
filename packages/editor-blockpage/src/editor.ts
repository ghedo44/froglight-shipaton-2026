/**
 * Block Page document editor provider — replaceable Tiptap/ProseMirror
 * adapter seam.
 *
 * Browser hosts get the Tiptap/ProseMirror adapter carrying the
 * Notion-style interaction checklist; headless tests keep the
 * deterministic in-memory twin. Canonical plain-data models cross the
 * boundary; no editor types ever do. Swapping providers never touches
 * canonical formats, sessions, storage, search, navigation, or hosts.
 */

import {
  type BlockPageEditorHandle,
  type BlockPageEditorProvider,
  type DocumentAssetStore,
} from '@froglight/foundation';
import { TiptapBlockpageEditorHandle } from './tiptap-handle.js';
import { HeadlessBlockpageEditorHandle } from './headless-handle.js';
import type { FetchFn } from './media-security.js';
import type { BlockPageMediaEditorInput } from './media-view.js';

/**
 * Provider-local dependencies use lazy asset-store resolution because
 * vaults activate after providers, plus an injectable remote fetch for media
 * (specs inject a mock — never real network in tests).
 */
export interface BlockPageDocumentEditorDeps {
  /** Lazy asset-store resolution; vaults bind after provider construction. */
  readonly assets?: () => DocumentAssetStore | null;
  /** Remote media fetch; defaults to the host `fetch` when absent. */
  readonly fetchFn?: () => FetchFn | null;
}

export class BlockPageDocumentEditorProvider
  implements BlockPageEditorProvider
{
  readonly id = 'blockpage';
  readonly #deps: BlockPageDocumentEditorDeps;

  constructor(deps: BlockPageDocumentEditorDeps = {}) {
    this.#deps = deps;
  }

  createEditor(input: BlockPageMediaEditorInput): BlockPageEditorHandle {
    void input.session;
    const liveDom =
      typeof document !== 'undefined' && typeof HTMLElement !== 'undefined';
    if (!liveDom) {
      // Typed asset seam: the extended provider input carries
      // the optional vault binding (no cast — the foundation seam stays
      // unchanged); absent bindings fail safe to offline placeholders.
      const assets = input.assets ?? resolveDepsAssets(this.#deps);
      return new HeadlessBlockpageEditorHandle({ ...input, ...(assets !== null ? { assets } : {}) });
    }

    // A live DOM must never degrade into the invisible headless handle:
    // a missing or detached pane host gets a visible fallback so the
    // document is always editable, and the wiring fault is announced.
    // Recovery positioning lives in the colocated provider stylesheet
    // (styles/prose-mirror.css `.flbp-fallback-host`); the React skeleton
    // still owns the chrome committed inside the fallback.
    const paneHost = input.parent instanceof HTMLElement ? input.parent : null;
    // Extended input: callers bind a `DocumentAssetStore`
    // and/or remote `fetchFn` directly on the typed input object or through
    // provider deps (notebook lazy pattern). The foundation seam stays
    // unchanged; absent bindings fail safe to placeholders downstream.
    const directAssets = input.assets ?? null;
    const directFetch = input.fetchFn ?? null;
    let depAssets: DocumentAssetStore | null = null;
    try {
      depAssets = this.#deps.assets?.() ?? null;
    } catch {
      depAssets = null;
    }
    let depFetch: FetchFn | null = null;
    try {
      depFetch = this.#deps.fetchFn?.() ?? null;
    } catch {
      depFetch = null;
    }
    const assets = directAssets ?? depAssets;
    const fetchFn =
      directFetch ??
      depFetch ??
      (typeof fetch === 'function' ? (fetch as unknown as FetchFn) : null);
    if (paneHost === null || !paneHost.isConnected) {
      console.warn(
        '[froglight/blockpage] editor parent is missing or detached from the document; ' +
          'mounted a visible fallback host — the workbench pane wiring should be fixed',
      );
      const fallback = document.createElement('div');
      fallback.className = 'flbp-fallback-host';
      document.body.appendChild(fallback);
      return new TiptapBlockpageEditorHandle(input, fallback, {
        ...(assets !== null ? { assets } : {}),
        ...(fetchFn !== null ? { fetchFn } : {}),
      });
    }
    // The pane host is shared across document providers. The React root
    // owns the single provider child inside it, so switching away cannot
    // contaminate the next editor's flex sizing. The committed skeleton
    // carries the colocated host module class + `flbp-host` itself.
    paneHost.replaceChildren();
    return new TiptapBlockpageEditorHandle(input, paneHost, {
      ...(assets !== null ? { assets } : {}),
      ...(fetchFn !== null ? { fetchFn } : {}),
    });
  }
}

function resolveDepsAssets(
  deps: BlockPageDocumentEditorDeps,
): DocumentAssetStore | null {
  try {
    return deps.assets?.() ?? null;
  } catch {
    return null;
  }
}
