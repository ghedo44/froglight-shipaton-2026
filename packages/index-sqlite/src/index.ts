/**
 * @froglight/index-sqlite — SQLite-derived index for Froglight search.
 *
 * Node: file-backed FTS5 via `node:sqlite` (`SqliteSearchService`) with
 * persistence across reopen and `clear()` + rebuild equivalence. Falls back
 * to `InMemorySearchService` when `node:sqlite` is unavailable (browser
 * bundles must not import `node:sqlite` — use the async factory, which probes
 * lazily).
 *
 * Web: `sqlite-wasm` `opfs-sahpool` in a dedicated Worker
 * (`directory:'/froglight/index'`) remains a future provider swap behind
 * `searchToken`. Tauri shipped native uses Rust `rusqlite` via the native
 * host. Both satisfy the same `SearchService` contract proven here.
 */

import {
  InMemorySearchService,
  type SearchService,
} from '@froglight/foundation';

export type {
  SearchService,
  SearchQuery,
  SearchResult,
} from '@froglight/foundation';
export {
  SqliteSearchService,
  createSqliteSearchService,
} from './sqlite-search.js';
export type { SqliteSearchOptions } from './sqlite-search.js';

/**
 * Create the SQLite-derived index (sync call shape for consumers).
 *
 * Always returns the in-memory derived projection. For an explicitly
 * file-backed FTS5 index with persistence across reopen, use the async
 * `createSqliteSearchService()` factory (requires `node:sqlite`).
 */
export function createSqliteIndex(): SearchService {
  // Sync call shape preserved for consumers: always a usable index.
  // The probe moved to the async `createSqliteSearchService()` factory, which
  // lazily imports `node:sqlite` (browsers must never statically import it).
  return new InMemorySearchService();
}

/** Re-export the in-memory service for tests that assert rebuild equivalence. */
export { InMemorySearchService } from '@froglight/foundation';
export { SqliteDatabaseQueryProvider } from './sqlite-database-query.js';
export { createSqliteDatabaseQueryProvider } from './node-database-query.js';
