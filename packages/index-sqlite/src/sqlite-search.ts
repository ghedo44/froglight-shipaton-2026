/**
 * File-backed SQLite FTS5 search index (Node `node:sqlite`).
 *
 * Real SQLite now (not facade-only): docs persist in a SQLite file with an
 * FTS5 index, so the derived search state survives restarts and rebuilds
 * from canonical workspace resources converge with incremental indexing.
 *
 * Contract: identical `SearchService` interface as `InMemorySearchService`.
 * Ranking reuses the same tokenization/prefix semantics; persistence is the
 * new guarantee (file-backed, `clear()` + rebuild equivalence).
 *
 * Web (`sqlite-wasm opfs-sahpool` Worker) and native (`rusqlite`) bindings
 * remain future provider swaps behind `searchToken` — this module proves the
 * file-backed contract on Node without changing Markdown/workspace consumers.
 */

import type { DocumentId } from '@froglight/foundation';
import type {
  DocumentLocation,
  DocumentSearchAnchor,
} from '@froglight/foundation';
import type {
  SearchQuery,
  SearchResult,
  SearchService,
} from '@froglight/foundation';
import { projectMarkdownForSearch, tokenize } from '@froglight/foundation';

interface SqliteRow {
  readonly id: string;
  readonly location: string;
  readonly indexText: string;
  readonly title: string;
  readonly body: string;
  readonly tags: string;
  readonly anchors: string | null;
}

// `node:sqlite` is Node ≥22.5 only. Import lazily so browsers/bundlers never
// pull it in; the factory falls back to in-memory when unavailable.
/** Minimal structural surface of `node:sqlite` used by this provider. */
export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
  };
  close(): void;
}

type DatabaseSyncCtor = new (path: string) => SqliteDatabase;

async function loadDatabaseSync(): Promise<DatabaseSyncCtor | null> {
  try {
    const mod = (await import('node:sqlite')) as unknown as {
      DatabaseSync?: DatabaseSyncCtor;
    };
    return mod.DatabaseSync ?? null;
  } catch {
    return null;
  }
}

export interface SqliteSearchOptions {
  /** File path, or `:memory:` for ephemeral indexes. */
  readonly path?: string;
}

export class SqliteSearchService implements SearchService {
  readonly #db: SqliteDatabase;
  readonly #path: string;
  #closed = false;

  constructor(db: SqliteDatabase, path: string) {
    this.#db = db;
    this.#path = path;
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS docs (
        id TEXT PRIMARY KEY,
        location TEXT NOT NULL,
        indexText TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        tags TEXT NOT NULL,
        anchors TEXT
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
        id UNINDEXED, title, body, indexText, tags
      );
    `);
  }

  get path(): string {
    return this.#path;
  }

  indexDocument(
    documentId: DocumentId,
    location: DocumentLocation,
    raw: string,
    anchors?: readonly DocumentSearchAnchor[],
  ): void {
    this.#assertOpen();
    const projection = projectMarkdownForSearch(raw, documentId);
    const row = {
      id: documentId,
      location: JSON.stringify(location),
      indexText: projection.indexText,
      title: projection.title,
      body: projection.body,
      tags: JSON.stringify(projection.tags),
      anchors: anchors && anchors.length > 0 ? JSON.stringify(anchors) : null,
    };
    this.#db
      .prepare(
        `INSERT INTO docs (id, location, indexText, title, body, tags, anchors)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         location=excluded.location, indexText=excluded.indexText,
         title=excluded.title, body=excluded.body,
         tags=excluded.tags, anchors=excluded.anchors`,
      )
      .run(
        row.id,
        row.location,
        row.indexText,
        row.title,
        row.body,
        row.tags,
        row.anchors,
      );
    this.#db.prepare(`DELETE FROM docs_fts WHERE id = ?`).run(documentId);
    this.#db
      .prepare(
        `INSERT INTO docs_fts (id, title, body, indexText, tags) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(
        documentId,
        projection.title,
        projection.body,
        projection.indexText,
        projection.tags.join(' '),
      );
  }

  remove(documentId: DocumentId): void {
    this.#assertOpen();
    this.#db.prepare(`DELETE FROM docs WHERE id = ?`).run(documentId);
    this.#db.prepare(`DELETE FROM docs_fts WHERE id = ?`).run(documentId);
  }

  clear(): number {
    this.#assertOpen();
    const row = this.#db.prepare(`SELECT COUNT(*) AS n FROM docs`).get() as {
      n: number;
    };
    const count = row.n;
    this.#db.exec(`DELETE FROM docs; DELETE FROM docs_fts;`);
    return count;
  }

  indexedIds(): readonly DocumentId[] {
    this.#assertOpen();
    const rows = this.#db.prepare(`SELECT id FROM docs ORDER BY id`).all() as {
      id: string;
    }[];
    return rows.map((r) => r.id as DocumentId);
  }

  search(query: SearchQuery): readonly SearchResult[] {
    this.#assertOpen();
    const tokens = tokenize(query.text);
    if (tokens.length === 0) return [];
    // FTS5 prefix query: each token as `token*`, ANDed. Escape double quotes.
    const match = tokens
      .map((t) => `"${t.replace(/"/g, '""')}"*`)
      .join(' AND ');
    let rows: SqliteRow[];
    try {
      rows = this.#db
        .prepare(
          `SELECT d.id, d.location, d.indexText, d.title, d.body, d.tags, d.anchors
         FROM docs_fts f JOIN docs d ON d.id = f.id WHERE docs_fts MATCH ? LIMIT ?`,
        )
        .all(match, query.limit ?? 20) as SqliteRow[];
    } catch {
      // Defensive: a malformed MATCH expression (never generated from our own
      // quoted-token query) yields no hits rather than breaking the caller.
      // A corrupt database file surfaces earlier, at open/index time.
      return [];
    }
    const results: SearchResult[] = [];
    for (const row of rows) {
      const location = JSON.parse(row.location) as DocumentLocation;
      const anchors = row.anchors
        ? (JSON.parse(row.anchors) as readonly DocumentSearchAnchor[])
        : undefined;
      const excerpt = buildExcerpt(row.body, tokens);
      const address = anchors ? anchorFor(anchors, excerpt.start) : undefined;
      results.push({
        documentId: row.id as DocumentId,
        location: address !== undefined ? { ...location, address } : location,
        // Ranking differs from InMemorySearchService by design: FTS5 ranks
        // internally and this provider surfaces stable id order. The shared
        // contract guarantee is hit-set equivalence, not identical scores.
        score: 1,
        excerpt: excerpt.excerpt,
        title: row.title || undefined,
      });
    }
    results.sort((a, b) =>
      a.documentId < b.documentId ? -1 : a.documentId > b.documentId ? 1 : 0,
    );
    return results.slice(0, query.limit ?? 20);
  }

  close(): void {
    if (!this.#closed) {
      this.#closed = true;
      this.#db.close();
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('sqlite search index is closed');
  }
}

export async function createSqliteSearchService(
  options: SqliteSearchOptions = {},
): Promise<SqliteSearchService | null> {
  const Ctor = await loadDatabaseSync();
  if (!Ctor) return null;
  const target = options.path ?? ':memory:';
  const db = new Ctor(target);
  return new SqliteSearchService(db, target);
}

function buildExcerpt(
  body: string,
  queryTokens: readonly string[],
): { excerpt: string; start: number } {
  const lower = body.toLowerCase();
  let index = -1;
  let token = '';
  for (const queryToken of queryTokens) {
    const position = lower.indexOf(queryToken);
    if (position !== -1 && (index === -1 || position < index)) {
      index = position;
      token = queryToken;
    }
  }
  if (index === -1) return { excerpt: body.slice(0, 120), start: 0 };
  const start = Math.max(0, index - 40);
  const end = Math.min(body.length, index + token.length + 80);
  return {
    excerpt: `${start > 0 ? '…' : ''}${body.slice(start, end).replace(/\n/g, ' ')}${end < body.length ? '…' : ''}`,
    start: index,
  };
}

function anchorFor(
  anchors: readonly DocumentSearchAnchor[],
  offset: number,
): string | undefined {
  let best: DocumentSearchAnchor | undefined;
  for (const anchor of anchors) {
    if (anchor.start <= offset && offset < anchor.end) return anchor.address;
    if (
      anchor.start <= offset &&
      (best === undefined || anchor.start > best.start)
    )
      best = anchor;
  }
  return best?.address;
}
