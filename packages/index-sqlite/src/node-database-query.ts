import type { DatabaseQueryProvider } from '@froglight/foundation';
import { SqliteDatabaseQueryProvider } from './sqlite-database-query.js';

/** Headless Node driver. Web/native hosts must supply their own SQLite driver. */
export async function createSqliteDatabaseQueryProvider(
  path: string,
  evaluator: DatabaseQueryProvider,
): Promise<SqliteDatabaseQueryProvider> {
  const { DatabaseSync } = await import('node:sqlite');
  return new SqliteDatabaseQueryProvider(new DatabaseSync(path), evaluator);
}
