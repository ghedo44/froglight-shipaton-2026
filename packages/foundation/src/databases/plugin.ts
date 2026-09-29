import { createServiceToken, definePlugin } from '@froglight/runtime';
import { propertyCatalogToken } from '../resource-properties/plugin.js';
import { FormulaFunctions } from './formula.js';
import {
  InMemoryDatabaseQueryProvider,
  type DatabaseQueryProvider,
} from './query.js';
import { databaseDefinitionsToken } from './definitions.js';
import { relationshipsToken } from '../tokens.js';

export const formulaFunctionsToken = createServiceToken<FormulaFunctions>(
  'froglight.formula-functions',
);
export const databaseQueryToken = createServiceToken<DatabaseQueryProvider>(
  'froglight.database-query',
);
export const formulaFunctionsPlugin = definePlugin({
  id: 'froglight.formula-functions.default',
  activate(ctx) {
    ctx.provide(formulaFunctionsToken, new FormulaFunctions());
  },
});
export const databaseQueryPlugin = definePlugin({
  id: 'froglight.database-query.reference',
  requirements: {
    requires: [
      propertyCatalogToken,
      formulaFunctionsToken,
      databaseDefinitionsToken,
      relationshipsToken,
    ],
  },
  activate(ctx) {
    ctx.provide(
      databaseQueryToken,
      new InMemoryDatabaseQueryProvider(
        ctx.require(formulaFunctionsToken),
        ctx.require(propertyCatalogToken),
        ctx.require(databaseDefinitionsToken),
        ctx.require(relationshipsToken),
      ),
    );
  },
});
