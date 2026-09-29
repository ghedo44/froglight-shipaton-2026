/**
 * Runtime binding for the vault sync capability.
 *
 * Two lifetimes, two plugins:
 *
 * ```text
 * Host lifetime
 * ├── AccountService
 * ├── VaultSyncStore
 * └── VaultSyncService provider (`froglight.vault-sync`)
 *     └── provides vaultSyncToken
 *         └── survives launcher/workspace transitions
 *
 * Workspace lifetime
 * └── VaultSyncAttachment (`froglight.vault-sync-attachment`)
 *     ├── requires vaultToken
 *     ├── requires localVaultIdentityToken
 *     ├── requires vaultSyncToken
 *     ├── verifies shared observable vault
 *     ├── service.attach({ localVaultId, vault: observableVault })
 *     └── service.detach() on disposal
 * ```
 *
 * Hosts create one host object per bootstrap with `createVaultSyncHost`
 * (injecting their service, already constructed over the remote, account,
 * storage, and tracker) and register BOTH `definition` (host lifetime)
 * and `attachment` (workspace lifetime) as slots. The service instance is
 * host bootstrap state so it outlives individual fibers: the host fiber
 * provides the token binding (withdrawn on dispose, satisfying the
 * lifecycle invariant) while the attachment fiber owns the
 * attach/detach wiring to the current observable vault.
 *
 * The previous single-plugin shape coupled the two lifetimes: closing the
 * bootstrap vault (launcher) withdrew `vaultToken`, which deactivated the
 * sync provider and removed `vaultSyncToken` — so the launcher could not
 * resolve the sync service needed to list and download cloud vaults.
 * The split fixes that structurally: `vaultSyncToken` depends on the
 * account capability only and remains available with no workspace open.
 * Automatic reconcile stays parked while no local vault is attached
 * (the service no-ops without an attached vault).
 *
 * The vault MUST be the shared observable facade: every host wraps its
 * vault provider with `withObservableVault()` at the composition
 * boundary, so workspace sessions, asset ingestion, and the sync
 * scheduler all observe the same `vaultToken`. A disconnected wrapper
 * created inside this consumer would only see its own calls while the
 * rest of the application writes through the original handle — so a
 * non-observable vault is a host composition error that fails loudly
 * in the attachment fiber instead of silently dropping auto-sync.
 *
 * Vault replacement flows through the attachment untouched: a new
 * `vaultToken` binding disposes the attachment fiber and reactivates it,
 * and activation re-attaches the service to the fresh (observable) vault.
 * The host fiber (and the service instance) survive the transition.
 *
 * UI must not own this lifecycle: hosts compose the pieces; shell probes
 * resolve `vaultSyncToken` through the host-lifetime provider.
 */

import { definePlugin, type PluginDefinition } from '@froglight/runtime';
import {
  accountToken,
  localVaultIdentityToken,
  vaultSyncToken,
  vaultToken,
} from '../tokens.js';
import { asObservableVault } from './mutations.js';
import type { VaultSyncStore } from './service.js';

export interface VaultSyncHostOptions {
  readonly service: VaultSyncStore;
}

export interface VaultSyncHost {
  readonly definition: PluginDefinition;
  /** Workspace-lifetime attachment: requires vault + sync service. */
  readonly attachment: PluginDefinition;
  readonly service: VaultSyncStore;
}

export function createVaultSyncHost(
  options: VaultSyncHostOptions,
): VaultSyncHost {
  const { service } = options;
  // Host lifetime: account capability only. Survives launcher/workspace
  // transitions so Download & Open discovery works with no vault open.
  const definition = definePlugin({
    id: 'froglight.vault-sync',
    requirements: { requires: [accountToken] },
    activate: (ctx) => {
      // Composition invariant: the runtime account capability must be the
      // exact service the sync store was constructed over. A mismatched
      // account instance (two AccountStores over one transport) would
      // authenticate sync against a different session than the app; fail
      // loudly here instead of syncing under a phantom identity.
      const account = ctx.require(accountToken);
      if ((account as unknown) !== (service.accountService as unknown)) {
        throw new Error(
          'froglight.vault-sync was composed with a different AccountService ' +
            'instance than the account host provides',
        );
      }
      ctx.provide(vaultSyncToken, service);
    },
  });
  // Workspace lifetime: attaches the currently mounted observable vault
  // AND its host local-vault identity atomically. Disposal detaches; the
  // service (and its token) survive. The identity comes from the runtime
  // provider that owns the vault — never from React, UI selection, or a
  // post-activation callback.
  const attachment = definePlugin({
    id: 'froglight.vault-sync-attachment',
    requirements: {
      requires: [vaultToken, localVaultIdentityToken, vaultSyncToken],
    },
    activate: (ctx) => {
      const vault = ctx.require(vaultToken);
      const identity = ctx.require(localVaultIdentityToken);
      const sync = ctx.require(vaultSyncToken);
      if (typeof identity.id !== 'string' || identity.id.length === 0) {
        throw new Error(
          'froglight.vault-sync-attachment requires a non-empty local vault identity',
        );
      }
      const observable = asObservableVault(vault);
      if (observable === null) {
        throw new Error(
          'froglight.vault-sync-attachment requires an observable vault: wrap the vault ' +
            'provider with withObservableVault() at the host composition boundary',
        );
      }
      // The attachment fiber must observe the same service instance the
      // host fiber provides; a mismatched instance is a composition error.
      if (sync !== (service as unknown)) {
        throw new Error(
          'froglight.vault-sync-attachment resolved a different VaultSyncService ' +
            'instance than the host composition provides',
        );
      }
      ctx.effect(() => {
        service.attach({ localVaultId: identity.id, vault: observable });
        return () => {
          service.detach();
        };
      });
    },
  });
  return { definition, attachment, service };
}

/**
 * Workspace-lifetime attachment plugin for hosts that compose the sync
 * service manually. Prefer `createVaultSyncHost(...).attachment` when the
 * host already owns the service; this helper covers the same contract for
 * test compositions that hold the service separately.
 */
export function createVaultSyncAttachment(
  options: VaultSyncHostOptions,
): PluginDefinition {
  return createVaultSyncHost(options).attachment;
}
