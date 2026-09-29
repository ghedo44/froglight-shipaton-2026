import type { Database, BindParams } from 'sql.js';
import type { SqliteDatabase } from './sqlite-search.js';

/** Provider-local adapter; statements never escape their operation's lifetime. */
export function wasmDriver(database: Database): SqliteDatabase {
  const all = (sql: string, values: unknown[]) => {
    const statement = database.prepare(sql);
    try {
      statement.bind(values as BindParams);
      const rows = [];
      while (statement.step()) rows.push(statement.getAsObject());
      return rows;
    } finally {
      statement.free();
    }
  };
  return {
    exec(sql) {
      database.run(sql);
    },
    prepare(sql) {
      return {
        all: (...values) => all(sql, values),
        get: (...values) => all(sql, values)[0],
        run: (...values) => {
          database.run(sql, values as BindParams);
        },
      };
    },
    close() {
      database.close();
    },
  };
}
