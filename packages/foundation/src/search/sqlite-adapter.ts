/**
 * SQLite adapter facade for derived indexes.
 *
 * Per `research/sqlite-wasm-threading` (89427b0):
 * - Native (Tauri shipped): Rust `rusqlite` (`bundled`) — Tauri WebView has no Node.
 * - Headless/CLI/tests: `node:sqlite` (`DatabaseSync`) behind `createNativeDb()` facade, fallback `better-sqlite3`.
 * - Web (PWA): `sqlite-wasm` `opfs-sahpool` in dedicated Worker, `directory:'/froglight/index'`.
 *
 * The application package provides the derived-index contract
 * (`SearchService` token, `InMemorySearchService` projection, and rebuild
 * equivalence). SQLite is a provider-binding change. The real driver lives in
 * `providers/native` (Rust) and `providers/web` (Worker) and never leaks
 * into Markdown core.
 *
 * This file is the insertion point. Callers depend on `searchToken`; the
 * provider binds either this in-memory service (tests/headless) or the
 * SQLite-backed service (native/web).
 */

import { InMemorySearchService, type SearchService } from './service.js';

/** Factory — returns the in-memory derived index; native/web providers override.*/
export function createSearchService(): SearchService {
  return new InMemorySearchService();
}

/** Re-export the token-safe type for providers. */
export type { SearchService };
