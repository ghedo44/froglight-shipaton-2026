/**
 * Minimal host-agnostic search UI helper.
 *
 * No framework, no CodeMirror, no host branch. The caller supplies a
 * `SearchService` (derived, rebuildable) and a render target. It keeps the
 * search control independent of any editor or host.
 */

import type { SearchService, SearchQuery, SearchResult } from '@froglight/foundation';

export interface SearchUiOptions {
  /** Placeholder to keep the helper host-agnostic (e.g. `HTMLElement` or test stub). */
  readonly container: unknown;
  readonly searchService: SearchService;
  /** Called when the user selects a result; navigates via portable `DocumentLocation`. */
  readonly onSelect?: (result: SearchResult) => void;
}

export interface SearchUiHandle {
  /** Run a query and return ranked results (also renders if container is an element). */
  query(q: SearchQuery): readonly SearchResult[];
  destroy(): void;
}

/**
 * Create a minimal search UI handle. In a real app this would mount a
 * React component via `createRoot(container)`; here it is a plain function
 * that provides search without framework lock-in.
 */
export function createSearchUi(options: SearchUiOptions): SearchUiHandle {
  const { searchService } = options;
  let destroyed = false;

  return {
    query(q: SearchQuery): readonly SearchResult[] {
      if (destroyed) throw new Error('SearchUiHandle destroyed');
      const results = searchService.search(q);
      // Host-agnostic render: if container looks like an element with innerHTML, populate it.
      const maybeEl = options.container as { innerHTML?: string } | null;
      if (maybeEl !== null && typeof maybeEl === 'object' && 'innerHTML' in maybeEl) {
        try {
          (maybeEl as { innerHTML: string }).innerHTML = results
            .map((r) => `<div data-doc="${r.documentId}">${r.title ?? r.documentId}: ${r.excerpt}</div>`)
            .join('');
        } catch {
          // Render failure is non-fatal for headless tests.
        }
      }
      if (options.onSelect) {
        // Do not auto-select; caller wires `onSelect` to `NavigationService.push(result.location)`.
      }
      return results;
    },
    destroy(): void {
      destroyed = true;
    },
  };
}
