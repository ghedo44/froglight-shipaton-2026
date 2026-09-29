/**
 * Vault-backed DocumentAssetStore: binary assets referenced
 * by documents are stored once under a conventional attachments location,
 * deduplicated by SHA-256 content hash. Idempotent on identical bytes;
 * never touches canonical document resources.
 */

import {
  documentAssetStoreToken,
  ensureDirectory,
  joinPath,
  sha256Hex,
  vaultToken,
  workspacePath,
  type DocumentAssetStore,
  type StoredAsset,
  type VaultService,
} from '@froglight/foundation';
import { definePlugin, type PluginDefinition } from '@froglight/runtime';

export const ATTACHMENTS_DIR = 'attachments';

export function createVaultAssetStore(vault: VaultService): DocumentAssetStore {
  return {
    async put(data: Uint8Array, options?: { suggestedName?: string }): Promise<StoredAsset> {
      const hash = await sha256Hex(data);
      // The hash is the complete filename so identical bytes deduplicate even
      // when callers suggest different names or extensions.
      void options;
      const path = joinPath(workspacePath(ATTACHMENTS_DIR), hash);
      await ensureDirectory(vault, workspacePath(ATTACHMENTS_DIR));
      // Content-addressed writes are idempotent; recreate to heal deletions.
      await vault.write(path, data);
      return { path, sha256: hash };
    },
    async read(path) {
      return vault.read(path);
    },
  };
}

/**
 * Capability binding: provides `documentAssetStoreToken` while a vault is
 * active and withdraws it with the vault fiber (reconciliation-owned).
 */
export function workspaceAssetsPlugin(): PluginDefinition {
  return definePlugin({
    id: 'froglight.document-assets',
    requirements: { requires: [vaultToken] },
    activate: (ctx) => {
      const vault = ctx.require(vaultToken);
      ctx.provide(documentAssetStoreToken, createVaultAssetStore(vault));
    },
  });
}
