/**
 * OPFS vault provider plugin.
 *
 * Registers the OPFS vault as a runtime provider of `vaultToken`
 * (replacing the in-memory reference provider without touching any
 * consumer code — the provider replacement proof over real
 * browser storage).
 */

import { definePlugin } from '@froglight/runtime';
import type { PluginConfig } from '@froglight/runtime';
import {
  localVaultIdentity,
  localVaultIdentityToken,
  vaultToken,
} from '@froglight/foundation';
import { OpfsVault, type OpfsFailureInjector } from './opfs-vault.js';

export interface OpfsVaultPluginConfig extends PluginConfig {
  /** Root directory handle (from `navigator.storage.getDirectory()`). */
  readonly root: FileSystemDirectoryHandle;
  /** Declared case semantics; defaults to `sensitive`. */
  readonly caseSensitivity?: 'sensitive' | 'insensitive';
  /** Declared normalization; defaults to `nfc`. */
  readonly nameNormalization?: 'none' | 'nfc';
  /** Test-only failure injection. */
  readonly fail?: OpfsFailureInjector;
  /**
   * Host vault identity for sync attachment.
   * Omit for transient providers to bind the reserved ephemeral identity.
   */
  readonly localVaultId?: string;
}

export const opfsVaultPlugin = definePlugin<OpfsVaultPluginConfig>({
  id: 'froglight.opfs-vault',
  requirements: { requires: [] },
  activate: async (ctx) => {
    const config = ctx.config;
    if (
      !config.root ||
      typeof (config.root as FileSystemDirectoryHandle).getDirectoryHandle !== 'function'
    ) {
      throw new Error('invalid root: expected a FileSystemDirectoryHandle');
    }
    const vault = await OpfsVault.create(config as OpfsVaultPluginConfig);
    ctx.provide(vaultToken, vault);
    ctx.provide(
      localVaultIdentityToken,
      localVaultIdentity(config.localVaultId),
    );
  },
});
