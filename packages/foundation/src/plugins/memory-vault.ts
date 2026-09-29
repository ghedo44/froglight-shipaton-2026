/**
 * Plugin wrapper for the deterministic in-memory vault provider.
 *
 * Test/reference provider: binds `vaultToken` to a `MemoryVault`. The
 * backing state can be shared across activations (reopen semantics) and
 * failure injection is configurable, which makes this the workhorse for
 * lifecycle and adversarial tests.
 */

import { definePlugin } from '@froglight/runtime';
import { localVaultIdentity, localVaultIdentityToken, vaultToken } from '../tokens.js';
import {
  createMemoryVaultState,
  MemoryVault,
  type MemoryVaultState,
  type VaultFailureInjector,
} from '../vault/memory.js';

export type MemoryVaultPluginConfig = {
  /** Shared backing state; a fresh one is created when omitted. */
  readonly state?: MemoryVaultState;
  readonly caseSensitivity?: 'sensitive' | 'insensitive';
  /** Test-only failure injection. */
  readonly fail?: VaultFailureInjector;
  /** Clock for `modifiedMillis`; defaults to `Date.now`. */
  readonly now?: () => number;
  /**
   * Host vault identity for sync attachment. Omit
   * for transient/bootstrap providers: the plugin binds the reserved
   * ephemeral identity instead, which has no cloud binding.
   */
  readonly localVaultId?: string;
};

export const memoryVaultPlugin = definePlugin<MemoryVaultPluginConfig>({
  id: 'froglight.memory-vault',
  activate: (ctx) => {
    const config = ctx.config;
    if (config.caseSensitivity !== undefined && config.caseSensitivity !== 'sensitive' && config.caseSensitivity !== 'insensitive') {
      throw new Error(`invalid caseSensitivity: ${String(config.caseSensitivity)}`);
    }
    const state = config.state ?? createMemoryVaultState();
    const vault = new MemoryVault(state, {
      caseSensitivity: config.caseSensitivity,
      fail: config.fail,
      now: config.now,
    });
    ctx.provide(vaultToken, vault);
    // Identity is provided with the vault, atomically: consumers never
    // infer which local vault this provider represents.
    ctx.provide(localVaultIdentityToken, localVaultIdentity(config.localVaultId));
    // The state is external; nothing to dispose.
  },
});