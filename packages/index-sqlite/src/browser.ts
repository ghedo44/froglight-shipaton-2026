import { definePlugin } from '@froglight/runtime';
import {
  databaseQueryToken,
  formulaFunctionsToken,
  propertyCatalogToken,
  databaseDefinitionsToken,
  relationshipsToken,
  vaultToken,
  InMemoryDatabaseQueryProvider,
} from '@froglight/foundation';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { WorkerDatabaseQueryProvider } from './worker-query.js';

/** Web and native WebViews use the same owned worker and replaceable vault store. */
export const workerDatabaseQueryPlugin = definePlugin({
  id: 'froglight.database-query.sqlite-worker',
  requirements: {
    requires: [
      vaultToken,
      formulaFunctionsToken,
      propertyCatalogToken,
      databaseDefinitionsToken,
      relationshipsToken,
    ],
  },
  async activate(ctx) {
    const evaluator = new InMemoryDatabaseQueryProvider(
      ctx.require(formulaFunctionsToken),
      ctx.require(propertyCatalogToken),
      ctx.require(databaseDefinitionsToken),
      ctx.require(relationshipsToken),
    );
    const provider = new WorkerDatabaseQueryProvider(
      new Worker(new URL('./database-worker.ts', import.meta.url), {
        type: 'module',
      }),
      ctx.require(vaultToken),
      evaluator,
    );
    try {
      await provider.open(wasmUrl);
    } catch (error) {
      await provider.dispose();
      throw error;
    }
    ctx.provide(databaseQueryToken, provider);
    return () => provider.dispose();
  },
});
export {
  WorkerDatabaseQueryProvider,
  DATABASE_INDEX_PATH,
} from './worker-query.js';
