import type { DocumentPersistenceFactory } from '../surface-persistence.js';
/**
 * Workspace plugin: composes editor-neutral workspace capabilities over a Vault.
 * Search is optional but, when bound before workspace activation, is injected
 * into WorkspaceService so create/save/rebuild projections stay lifecycle-owned.
 */

import { definePlugin } from '@froglight/runtime';
import {
  commandsToken,
  documentRegistryToken,
  metadataToken,
  navigationToken,
  relationshipsToken,
  revisionsToken,
  searchToken,
  settingsToken,
  vaultToken,
  workspaceToken,
} from '../tokens.js';
import { InMemoryDocumentRegistry } from '../documents.js';
import { InMemoryMetadataService } from '../metadata.js';
import { InMemoryRelationshipService } from '../relationships.js';
import { InMemoryCommandService } from '../commands.js';
import { VaultSettingsService } from '../vault-settings.js';
import { InMemoryNavigationService } from '../navigation.js';
import { VaultRevisionService } from '../revisions.js';
import { WorkspaceServiceImpl } from '../workspace.js';
import type { WorkspaceService } from '../workspace.js';

export type WorkspacePluginConfig = {
  readonly persistenceFactory?: DocumentPersistenceFactory;
  readonly workspaceId?: string;
  /** Clock shared by the workspace record and revision timestamps. */
  readonly clock?: () => number;
};

export const workspacePlugin = definePlugin<WorkspacePluginConfig>({
  id: 'froglight.workspace',
  requirements: {
    requires: [vaultToken],
    optionallyRequires: [searchToken, settingsToken],
  },
  activate: async (ctx) => {
    const config = ctx.config;
    if (
      config.workspaceId !== undefined &&
      typeof config.workspaceId !== 'string'
    ) {
      throw new Error(`invalid workspaceId: ${String(config.workspaceId)}`);
    }
    if (config.clock !== undefined && typeof config.clock !== 'function') {
      throw new Error('invalid clock: expected a function');
    }
    const clock = config.clock ?? (() => Date.now());
    const vault = ctx.require(vaultToken);
    const search = ctx.try(searchToken) ?? null;

    const registry = new InMemoryDocumentRegistry();
    const metadata = new InMemoryMetadataService();
    const relationships = new InMemoryRelationshipService();
    const commands = new InMemoryCommandService();
    // Standalone workspace consumers retain vault-backed settings. The app
    // composition provides a host-lifetime service so preferences are shared
    // across vaults and available from the launcher.
    const vaultSettings =
      ctx.try(settingsToken) === undefined
        ? await VaultSettingsService.open(vault)
        : null;
    const navigation = new InMemoryNavigationService();

    let workspace: WorkspaceServiceImpl | null = null;
    const revisions = new VaultRevisionService({
      vault,
      resolveResource: (resourceId) => {
        if (workspace === null) return undefined;
        try {
          return workspace.resolveResourcePath(resourceId);
        } catch {
          return undefined;
        }
      },
      clock,
    });

    workspace = await WorkspaceServiceImpl.create({
      vault,
      registry,
      metadata,
      relationships,
      revisions,
      search,
      workspaceId: config.workspaceId,
      persistenceFactory: config.persistenceFactory,
      clock,
    });

    ctx.provide(documentRegistryToken, registry);
    ctx.provide(metadataToken, metadata);
    ctx.provide(relationshipsToken, relationships);
    ctx.provide(commandsToken, commands);
    if (vaultSettings !== null) ctx.provide(settingsToken, vaultSettings);
    ctx.provide(navigationToken, navigation);
    ctx.provide(revisionsToken, revisions);
    ctx.provide(workspaceToken, workspace);

    return async () => {
      try {
        await vaultSettings?.dispose();
      } finally {
        await workspace?.dispose();
      }
    };
  },
});

export type { WorkspaceService };
