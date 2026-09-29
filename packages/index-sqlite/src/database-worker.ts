/// <reference lib="webworker" />
import initSqlJs, { type Database } from 'sql.js';
import { SqliteDatabaseQueryProvider } from './sqlite-database-query.js';
import { wasmDriver } from './wasm-driver.js';
import type {
  DatabaseModel,
  DatabaseView,
  DatabaseRow,
  DatabaseRowInput,
  ResourcePropertyRowSource,
} from '@froglight/foundation';

export type DatabaseWorkerRequest =
  | { id: number; type: 'open'; wasmUrl: string; bytes?: Uint8Array }
  | {
      id: number;
      type: 'query';
      model: DatabaseModel;
      view: DatabaseView;
      rows: readonly DatabaseRow[];
    }
  | { id: number; type: 'close' };
export type DatabaseWorkerResponse = {
  id: number;
  ids?: string[];
  bytes?: Uint8Array;
  error?: string;
};
let database: Database | undefined;
let provider: SqliteDatabaseQueryProvider | undefined;
let fingerprint = '';
let tail: Promise<unknown> = Promise.resolve();

self.onmessage = (event: MessageEvent<DatabaseWorkerRequest>) => {
  const request = event.data;
  tail = tail
    .catch(() => undefined)
    .then(async () => {
      try {
        let response: DatabaseWorkerResponse = { id: request.id };
        if (request.type === 'open') {
          const SQL = await initSqlJs({ locateFile: () => request.wasmUrl });
          try {
            database = new SQL.Database(request.bytes);
            database.exec('PRAGMA quick_check');
            provider = createProvider(database);
          } catch {
            // A broken derived cache is disposable. No canonical bytes are touched.
            database?.close();
            database = new SQL.Database();
            provider = createProvider(database);
          }
        } else if (request.type === 'query') {
          if (!provider || !database)
            throw new Error('Database worker is not open');
          const rows = await provider.execute(
            request.model,
            request.view,
            request.rows,
          );
          const next = JSON.stringify(request.rows);
          response = {
            id: request.id,
            ids: rows.map((row) => row.resourceId),
            ...(next !== fingerprint ? { bytes: database.export() } : {}),
          };
          fingerprint = next;
        } else {
          await provider?.dispose();
          provider = undefined;
          database = undefined;
        }
        self.postMessage(response);
      } catch (error) {
        self.postMessage({
          id: request.id,
          error: error instanceof Error ? error.message : String(error),
        } satisfies DatabaseWorkerResponse);
      }
    });
};
function createProvider(database: Database) {
  return new SqliteDatabaseQueryProvider(wasmDriver(database), {
    execute(model, _view, rows: DatabaseRowInput) {
      if (model.membership.mode !== 'explicit')
        throw new Error('Expected indexed candidates');
      const members = new Set(model.membership.resourceIds);
      const source = Array.isArray(rows)
        ? rows
        : [...(rows as ResourcePropertyRowSource).scan()];
      return source
        .filter((row) => members.has(row.resourceId))
        .map((row) => ({ ...row, diagnostics: {} }));
    },
  });
}
