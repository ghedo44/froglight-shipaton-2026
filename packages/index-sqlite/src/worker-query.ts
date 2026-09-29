import {
  conjoinDatabaseFilterExpressions,
  throwIfDatabaseQueryAborted,
  ensureDirectory,
  workspacePath,
  isVaultErrorCode,
  type VaultService,
  type DatabaseQueryProvider,
  type DatabaseModel,
  type DatabaseView,
  type DatabaseRowInput,
  type DatabaseQueryOptions,
  type ResourcePropertyRowSource,
  type EvaluatedDatabaseRow,
} from '@froglight/foundation';
import type {
  DatabaseWorkerRequest,
  DatabaseWorkerResponse,
} from './database-worker.js';

export const DATABASE_INDEX_PATH = workspacePath(
  '.froglight/indexes/database.sqlite',
);
/** Trusted worker ownership and cache persistence; shared evaluator owns semantics. */
export class WorkerDatabaseQueryProvider implements DatabaseQueryProvider {
  readonly #pending = new Map<
    number,
    { resolve(value: DatabaseWorkerResponse): void; reject(error: Error): void }
  >();
  #sequence = 0;
  #tail: Promise<unknown> = Promise.resolve();
  #disposed = false;
  #cacheError: string | undefined;
  #failure: Error | undefined;
  #unsaved: Uint8Array | undefined;
  constructor(
    readonly worker: Worker,
    readonly vault: VaultService,
    readonly evaluator: DatabaseQueryProvider,
  ) {
    worker.onmessage = (event: MessageEvent<DatabaseWorkerResponse>) => {
      const request = this.#pending.get(event.data.id);
      this.#pending.delete(event.data.id);
      if (event.data.error) request?.reject(new Error(event.data.error));
      else request?.resolve(event.data);
    };
    worker.onerror = (event) => {
      this.#failure = new Error(event.message || 'Database worker failed');
      for (const request of this.#pending.values())
        request.reject(this.#failure);
      this.#pending.clear();
    };
  }
  #request(
    request:
      | Omit<Extract<DatabaseWorkerRequest, { type: 'open' }>, 'id'>
      | Omit<Extract<DatabaseWorkerRequest, { type: 'query' }>, 'id'>
      | { type: 'close' },
  ): Promise<DatabaseWorkerResponse> {
    if (this.#failure) return Promise.reject(this.#failure);
    const id = ++this.#sequence;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      try {
        this.worker.postMessage({ ...request, id });
      } catch (error) {
        this.#pending.delete(id);
        reject(error);
      }
    });
  }
  async open(wasmUrl: string): Promise<void> {
    let bytes: Uint8Array | undefined;
    try {
      bytes = await this.vault.read(DATABASE_INDEX_PATH);
    } catch (error) {
      if (!isVaultErrorCode(error, 'NOT_FOUND'))
        this.#cacheError = String(error);
    }
    await this.#request({ type: 'open', wasmUrl, ...(bytes ? { bytes } : {}) });
  }
  execute(
    model: DatabaseModel,
    view: DatabaseView,
    rows: DatabaseRowInput,
    search = '',
    options: DatabaseQueryOptions = {},
  ): Promise<readonly EvaluatedDatabaseRow[]> {
    if (this.#disposed)
      return Promise.reject(new Error('Database query provider disposed'));
    const operation = this.#tail
      .catch(() => undefined)
      .then(async () => {
        throwIfDatabaseQueryAborted(options.signal);
        // Worker candidate selection cannot safely apply a result limit before
        // formulas and non-indexed filters. Keep bounded lookups lazy in the
        // shared semantic evaluator and avoid cloning the complete row source.
        if (options.limit !== undefined)
          return this.evaluator.execute(model, view, rows, search, options);
        const materializedRows = Array.isArray(rows)
          ? rows
          : [...(rows as ResourcePropertyRowSource).scan()];
        const result = await this.#request({
          type: 'query',
          model,
          view,
          rows: materializedRows,
        });
        if (result.bytes) this.#unsaved = result.bytes;
        if (this.#unsaved) {
          try {
            await ensureDirectory(
              this.vault,
              workspacePath('.froglight/indexes'),
            );
            await this.vault.write(DATABASE_INDEX_PATH, this.#unsaved);
            this.#unsaved = undefined;
            this.#cacheError = undefined;
          } catch (error) {
            this.#cacheError = String(error);
          }
        }
        const candidates = new Set(result.ids);
        const ids =
          model.membership.mode === 'explicit'
            ? model.membership.resourceIds.filter((id) => candidates.has(id))
            : materializedRows
                .filter((row) => candidates.has(row.resourceId))
                .map((row) => row.resourceId);
        const filters = [
          ...(model.membership.mode === 'query'
            ? model.membership.filters
            : []),
          ...(view.filters ?? []),
        ];
        const evaluated = await this.evaluator.execute(
          { ...model, membership: { mode: 'explicit', resourceIds: ids } },
          {
            ...view,
            filters,
            where: conjoinDatabaseFilterExpressions(
              model.membership.mode === 'query'
                ? model.membership.where
                : undefined,
              view.where,
            ),
          },
          materializedRows,
          search,
          options,
        );
        return this.#cacheError
          ? evaluated.map((row) => ({
              ...row,
              diagnostics: {
                ...row.diagnostics,
                $index: `Index cache could not be saved: ${this.#cacheError}`,
              },
            }))
          : evaluated;
      });
    this.#tail = operation;
    return operation;
  }
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await this.#tail.catch(() => undefined);
    // Termination also releases WASM memory; no database state exists only here.
    this.worker.terminate();
    for (const request of this.#pending.values())
      request.reject(new Error('Database query provider disposed'));
    this.#pending.clear();
    this.#unsaved = undefined;
  }
}
