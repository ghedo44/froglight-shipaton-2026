import {
  conjoinDatabaseFilterExpressions,
  throwIfDatabaseQueryAborted,
  type DatabaseModel,
  type DatabaseView,
  type DatabaseRow,
  type DatabaseRowInput,
  type DatabaseQueryOptions,
  type ResourcePropertyRowSource,
  type DatabaseQueryProvider,
  type EvaluatedDatabaseRow,
} from '@froglight/foundation';
import type { SqliteDatabase } from './sqlite-search.js';

/** Indexed candidate selection; canonical typing/formulas stay in the evaluator. */
export class SqliteDatabaseQueryProvider implements DatabaseQueryProvider {
  readonly #snapshots = new Map<string, string>();
  #tail: Promise<unknown> = Promise.resolve();
  #closed = false;
  constructor(
    readonly database: SqliteDatabase,
    readonly evaluator: DatabaseQueryProvider,
  ) {
    database.exec(`
      CREATE TABLE IF NOT EXISTS database_rows (id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS database_values (resource_id TEXT NOT NULL, property_id TEXT NOT NULL, value_json TEXT NOT NULL, PRIMARY KEY(resource_id, property_id));
      CREATE INDEX IF NOT EXISTS database_values_lookup ON database_values(property_id, value_json, resource_id);
    `);
    for (const row of database
      .prepare('SELECT id, payload FROM database_rows')
      .all() as { id: string; payload: string }[])
      this.#snapshots.set(row.id, row.payload);
  }
  execute(
    model: DatabaseModel,
    view: DatabaseView,
    rows: DatabaseRowInput,
    search = '',
    options: DatabaseQueryOptions = {},
  ): Promise<readonly EvaluatedDatabaseRow[]> {
    if (this.#closed)
      return Promise.reject(new Error('Database query provider closed'));
    const operation = this.#tail
      .catch(() => undefined)
      .then(async () => {
        throwIfDatabaseQueryAborted(options.signal);
        // Indexed predicates can over-select when formulas, nested filters, or
        // free-text search need the semantic evaluator. A bounded lazy scan is
        // both safer and cheaper than materializing every candidate ID first.
        if (options.limit !== undefined)
          return this.evaluator.execute(model, view, rows, search, options);
        this.#project(rows);
        const filters = [
          ...(model.membership.mode === 'query'
            ? model.membership.filters
            : []),
          ...(view.filters ?? []),
        ];
        const eligible = filters.filter((filter) => {
          if (
            filter.operator !== 'eq' ||
            filter.value === null ||
            filter.value === undefined ||
            typeof filter.value === 'object'
          )
            return false;
          if (['$title', '$path', '$kind'].includes(filter.property))
            return typeof filter.value === 'string';
          const property = model.properties.find(
            (property) => property.id === filter.property,
          );
          return (
            property &&
            [
              'text',
              'number',
              'boolean',
              'select',
              'url',
              'email',
              'phone',
            ].includes(property.type)
          );
        });
        const predicates = eligible.map(
          () =>
            'EXISTS (SELECT 1 FROM database_values v WHERE v.resource_id = r.id AND v.property_id = ? AND v.value_json = ?)',
        );
        const candidates = this.database
          .prepare(
            `SELECT r.id FROM database_rows r ${predicates.length ? `WHERE ${predicates.join(' AND ')}` : ''} ORDER BY r.ordinal`,
          )
          .all(
            ...eligible.flatMap((filter) => [
              filter.property,
              JSON.stringify(filter.value),
            ]),
          ) as { id: string }[];
        const allowed = new Set(candidates.map((row) => row.id));
        const ids =
          model.membership.mode === 'explicit'
            ? model.membership.resourceIds.filter((id) => allowed.has(id))
            : [...this.#scan(rows)]
                .filter((row) => allowed.has(row.resourceId))
                .map((row) => row.resourceId);
        return this.evaluator.execute(
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
          rows,
          search,
          options,
        );
      });
    this.#tail = operation;
    return operation;
  }
  #scan(rows: DatabaseRowInput): Iterable<DatabaseRow> {
    return Array.isArray(rows)
      ? rows
      : (rows as ResourcePropertyRowSource).scan();
  }
  #project(rows: DatabaseRowInput): void {
    const next = new Map<string, string>();
    this.database.exec('BEGIN');
    try {
      let ordinal = 0;
      for (const row of this.#scan(rows)) {
        const payload = JSON.stringify(row);
        next.set(row.resourceId, payload);
        if (this.#snapshots.get(row.resourceId) === payload) {
          this.database
            .prepare('UPDATE database_rows SET ordinal = ? WHERE id = ?')
            .run(ordinal, row.resourceId);
          ordinal += 1;
          continue;
        }
        this.database
          .prepare(
            'INSERT INTO database_rows(id, ordinal, payload) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET ordinal=excluded.ordinal, payload=excluded.payload',
          )
          .run(row.resourceId, ordinal, payload);
        this.database
          .prepare('DELETE FROM database_values WHERE resource_id = ?')
          .run(row.resourceId);
        const values = {
          ...row.values,
          $title: row.title,
          $kind: row.kindId,
          $path: row.path,
        };
        for (const [id, value] of Object.entries(values))
          this.database
            .prepare(
              'INSERT INTO database_values(resource_id, property_id, value_json) VALUES (?, ?, ?)',
            )
            .run(row.resourceId, id, JSON.stringify(value));
        ordinal += 1;
      }
      for (const id of this.#snapshots.keys()) {
        if (next.has(id)) continue;
        this.database.prepare('DELETE FROM database_rows WHERE id = ?').run(id);
        this.database
          .prepare('DELETE FROM database_values WHERE resource_id = ?')
          .run(id);
      }
      this.database.exec('COMMIT');
      this.#snapshots.clear();
      for (const [id, payload] of next) this.#snapshots.set(id, payload);
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }
  /** Rebuild only derived tables; the next query repopulates them from projections. */
  async clear(): Promise<void> {
    if (this.#closed) throw new Error('Database query provider closed');
    const operation = this.#tail
      .catch(() => undefined)
      .then(() => {
        this.database.exec(
          'BEGIN; DELETE FROM database_values; DELETE FROM database_rows; COMMIT;',
        );
        this.#snapshots.clear();
      });
    this.#tail = operation;
    return operation;
  }
  async dispose(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#tail.catch(() => undefined);
    this.database.close();
    this.#snapshots.clear();
  }
}
