import { createServiceToken, definePlugin } from '@froglight/runtime';
import {
  workspaceToken,
  vaultToken,
  metadataToken,
  relationshipsToken,
  revisionsToken,
  documentRegistryToken,
} from '../tokens.js';
import { PropertyCatalog } from './catalog.js';
import type { ResourcePropertyService } from './contract.js';
import {
  WorkspaceResourceProperties,
  propertyResourceId,
  resourcePropertyPath,
} from './provider.js';

export const propertyCatalogToken = createServiceToken<PropertyCatalog>(
  'froglight.property-catalog',
);
export const resourcePropertiesToken =
  createServiceToken<ResourcePropertyService>('froglight.resource-properties');
export const propertyCatalogPlugin = definePlugin({
  id: 'froglight.property-catalog.default',
  activate(ctx) {
    ctx.provide(propertyCatalogToken, new PropertyCatalog());
  },
});
export const resourcePropertiesPlugin = definePlugin({
  id: 'froglight.resource-properties.vault',
  requirements: {
    requires: [
      workspaceToken,
      vaultToken,
      metadataToken,
      relationshipsToken,
      revisionsToken,
      documentRegistryToken,
      propertyCatalogToken,
    ],
  },
  async activate(ctx) {
    const workspace = ctx.require(workspaceToken);
    const properties = new WorkspaceResourceProperties({
      workspace,
      vault: ctx.require(vaultToken),
      metadata: ctx.require(metadataToken),
      relationships: ctx.require(relationshipsToken),
      revisions: ctx.require(revisionsToken),
      catalog: ctx.require(propertyCatalogToken),
      registry: ctx.require(documentRegistryToken),
    });
    const projection = workspace.registerProjection({
      project: (ref) => properties.project(ref),
      remove: (ref) => properties.remove(ref.location.resourceId),
      resolveResource: (id) => {
        const ref = workspace
          .listDocuments()
          .find((ref) => propertyResourceId(ref.location.resourceId) === id);
        return ref ? resourcePropertyPath(ref.location.resourceId) : undefined;
      },
    });
    try {
      await properties.rebuild();
    } catch (error) {
      await properties.dispose();
      projection.dispose();
      throw error;
    }
    ctx.provide(resourcePropertiesToken, properties);
    return async () => {
      await properties.dispose();
      projection.dispose();
    };
  },
});
