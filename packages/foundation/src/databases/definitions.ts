import { createServiceToken, definePlugin } from '@froglight/runtime';
import type { ResourceId } from '../identity.js';
import { workspaceToken } from '../tokens.js';
import { databaseKindId, validateDatabase } from './kind.js';
import type { DatabaseModel } from './model.js';

/** Rebuildable definitions; queries never read canonical files themselves. */
export interface DatabaseDefinitions {
  get(id: ResourceId): DatabaseModel | undefined;
}
export const databaseDefinitionsToken = createServiceToken<DatabaseDefinitions>(
  'froglight.database-definitions',
);
export const databaseDefinitionsPlugin = definePlugin({
  id: 'froglight.database-definitions.vault',
  requirements: { requires: [workspaceToken] },
  async activate(ctx) {
    const workspace = ctx.require(workspaceToken);
    const definitions = new Map<ResourceId, DatabaseModel>();
    const generations = new Map<ResourceId, number>();
    let disposed = false;
    const project = async (
      ref: ReturnType<typeof workspace.listDocuments>[number],
    ) => {
      if (ref.kindId !== databaseKindId) return;
      const id = ref.location.resourceId;
      const generation = (generations.get(id) ?? 0) + 1;
      generations.set(id, generation);
      try {
        const { model } = await workspace.readDocument(ref.documentId);
        validateDatabase(model);
        if (!disposed && generations.get(id) === generation)
          definitions.set(id, model);
      } catch (error) {
        if (generations.get(id) === generation) definitions.delete(id);
        throw error;
      }
    };
    const projection = workspace.registerProjection({
      project,
      remove: (ref) => {
        const id = ref.location.resourceId;
        generations.set(id, (generations.get(id) ?? 0) + 1);
        definitions.delete(id);
      },
    });
    const dispose = () => {
      disposed = true;
      projection.dispose();
      definitions.clear();
      generations.clear();
    };
    try {
      for (const ref of workspace.listDocuments()) {
        try {
          await project(ref);
        } catch {
          /* One unavailable definition must not disable other databases. */
        }
      }
      ctx.provide(databaseDefinitionsToken, {
        get: (id) => definitions.get(id),
      });
    } catch (error) {
      dispose();
      throw error;
    }
    return dispose;
  },
});
