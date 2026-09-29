/**
 * Native-filesystem vault provider plugin.
 *
 * Registers the native vault as a runtime provider of `vaultToken`
 * (replacing the in-memory reference provider without touching any
 * consumer code — the provider replacement proof over real
 * storage).
 */

import { definePlugin } from '@froglight/runtime';
import type { PluginConfig } from '@froglight/runtime';
import {
  localVaultIdentity,
  localVaultIdentityToken,
  vaultToken,
} from '@froglight/foundation';
import { NativeFsVault, type NativeFsFailureInjector } from './native-fs-vault.js';

export interface NativeFsVaultPluginConfig extends PluginConfig {
  /** Absolute host path of the workspace root directory. */
  readonly root: string;
  /** Declared case semantics; probed at create time when omitted. */
  readonly caseSensitivity?: 'sensitive' | 'insensitive';
  /** Test-only failure injection. */
  readonly fail?: NativeFsFailureInjector;
  /**
   * Host vault identity for sync attachment.
   * Omit for transient providers to bind the reserved ephemeral identity.
   */
  readonly localVaultId?: string;
}

export const nativeFsVaultPlugin = definePlugin<NativeFsVaultPluginConfig>({
  id: 'froglight.native-fs-vault',
  requirements: { requires: [] },
  activate: async (ctx) => {
    const config = ctx.config;
    if (typeof config.root !== 'string' || config.root.length === 0) {
      throw new Error('invalid root: expected a non-empty absolute path');
    }
    const vault = await NativeFsVault.create(config);
    ctx.provide(vaultToken, vault);
    ctx.provide(
      localVaultIdentityToken,
      localVaultIdentity(config.localVaultId),
    );
  },
});
