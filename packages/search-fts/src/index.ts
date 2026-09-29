/**
 * @froglight/search-fts — FTS search service and basic search UI helpers.
 *
 * Re-exports the `SearchService` contract and provides a minimal
 * framework-agnostic search UI helper. The UI is deliberately thin:
 * it renders ranked `SearchResult`s from `InMemorySearchService`
 * (backed by SQLite-derived index via `searchToken`) as portable
 * `DocumentLocation`s, never as editor offsets.
 *
 * Provider implementations (e.g. `@froglight/index-sqlite`) bind
 * `searchToken` in hosts; this capability package never depends on them.
 *
 * A future React/Vue adapter will bind this helper to the app shell;
 * for the helper is sufficient for `command-palette` style
 * search and for headless/Playwright verification.
 */

export { InMemorySearchService, type SearchService, type SearchQuery, type SearchResult } from '@froglight/foundation';
export * from './ui.js';
