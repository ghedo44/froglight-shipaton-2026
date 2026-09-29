/**
 * Cloud vault discovery for the launcher.
 *
 * Signed-in view over `VaultSyncService.listRemoteVaults()`: cloud vaults
 * appear with their revision timestamp and a Download & Open action that
 * materializes the remote as a normal local vault (created through the
 * host adapter, activated through the controller, then bound with
 * `attachRemoteVault` — editors never touch Storage objects directly).
 * Vaults already bound locally show that instead of a duplicate download.
 *
 * Renders nothing while signed out, unconfigured, or while the vault list
 * cannot load without an error to report — local vaults are always the
 * primary surface.
 */

import { useEffect, useState } from 'react';
import type { AccountService } from '@froglight/foundation/account';
import type { RemoteVaultInfo, VaultSyncService } from '@froglight/foundation';
import type { VaultChoice, VaultHostAdapter } from '../launcher.js';
import { VaultIcon } from './VaultIcon.jsx';
import { Button } from './Button.jsx';
import { useAccountSnapshot } from './useAccount.jsx';
import { useVaultSyncSnapshot } from './useVaultSync.jsx';
import styles from './LauncherView.module.css';

function downloadErrorCopy(error: unknown): string {
  const code =
    typeof error === 'object' && error !== null
      ? (error as Record<string, unknown>).code
      : null;
  switch (code) {
    case 'NOT_AUTHENTICATED':
      return 'Sign in to download cloud vaults.';
    case 'REMOTE_NOT_FOUND':
      return 'That cloud vault no longer exists.';
    case 'ACCOUNT_CHANGED':
      return 'Account changed during download. Try again.';
    case 'NETWORK':
      return 'Couldn’t reach the cloud. Check your connection and try again.';
    case 'NOT_CONFIGURED':
      return 'Sync isn’t set up in this build yet.';
    case 'PERMISSION_DENIED':
    case 'PRO_REQUIRED':
    case 'ENTITLEMENT_PENDING':
      return 'Cloud vaults need Froglight Pro on this account.';
    default:
      return 'Could not download that vault.';
  }
}

function listErrorCopy(error: unknown): string {
  const code =
    typeof error === 'object' && error !== null
      ? (error as Record<string, unknown>).code
      : null;
  switch (code) {
    case 'NOT_AUTHENTICATED':
      return 'Sign in to see cloud vaults.';
    case 'NETWORK':
      return 'Couldn’t reach the cloud. Check your connection and try again.';
    case 'NOT_CONFIGURED':
      return 'Sync isn’t set up in this build yet.';
    case 'PERMISSION_DENIED':
    case 'PRO_REQUIRED':
    case 'ENTITLEMENT_PENDING':
      return 'Cloud vaults need Froglight Pro on this account.';
    default:
      return 'Could not load cloud vaults.';
  }
}

export interface CloudVaultsViewProps {
  readonly vaults: VaultHostAdapter;
  readonly excludeCloudIds?: readonly string[];
  readonly onOpen: (choice: VaultChoice) => void;
  readonly resolveAccount: () => AccountService | null;
  readonly resolveSync: () => VaultSyncService | null;
}

type LoadState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly vaults: readonly RemoteVaultInfo[] }
  | { readonly kind: 'error'; readonly message: string };

export function CloudVaultsView(
  props: CloudVaultsViewProps,
): React.ReactElement | null {
  const { vaults, onOpen, resolveAccount, resolveSync } = props;
  const account = resolveAccount();
  const sync = resolveSync();
  const { snapshot: accountSnapshot } = useAccountSnapshot(account);
  const { snapshot: syncSnapshot } = useVaultSyncSnapshot(sync);
  const [load, setLoad] = useState<LoadState>({ kind: 'idle' });
  const [reload, setReload] = useState(0);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const signedIn = accountSnapshot.user !== null;
  // Already-materialized vaults (every remembered binding under this
  // account, not just the active one) show bound instead of offering a
  // duplicate download. A binding whose persisted sync base is corrupt is
  // excluded: re-materializing through Download & Open replaces it with a
  // fresh verified replica (Strategy A recovery).
  const snapshotBindings = [
    ...(syncSnapshot.bindings ?? []),
    ...(syncSnapshot.binding === null ? [] : [syncSnapshot.binding]),
  ];
  const corruptCloudIds = new Set<string>(
    snapshotBindings
      .filter((binding) => binding.baseCorrupt === true)
      .map((binding) => binding.cloudVaultId),
  );
  const boundCloudIds = new Set<string>(
    snapshotBindings
      .filter((binding) => binding.baseCorrupt !== true)
      .map((binding) => binding.cloudVaultId),
  );

  useEffect(() => {
    if (!signedIn || sync === null) {
      setLoad({ kind: 'idle' });
      return;
    }
    let cancelled = false;
    setLoad({ kind: 'loading' });
    setNotice(null);
    void sync
      .listRemoteVaults()
      .then((listed) => {
        if (cancelled) return;
        setLoad({ kind: 'ready', vaults: listed });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoad({
          kind: 'error',
          message: listErrorCopy(error),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [signedIn, accountSnapshot.user?.id, sync, reload]);

  if (!signedIn || sync === null) return null;

  const listedVaults =
    load.kind === 'ready'
      ? load.vaults.filter(
          (remote) => !props.excludeCloudIds?.includes(remote.cloudVaultId),
        )
      : [];

  return (
    <section
      className={styles['recent-vaults']}
      data-fl-component="cloud-vaults"
    >
      <div
        className={styles['recent-vaults-heading']}
        data-testid="cloud-vaults-heading"
      >
        {props.excludeCloudIds ? 'Available to download' : 'Cloud vaults'}
      </div>
      {load.kind === 'loading' || load.kind === 'idle' ? (
        <p data-testid="cloud-vaults-loading">Loading cloud vaults…</p>
      ) : null}
      {load.kind === 'error' ? (
        <div data-testid="cloud-vaults-error">
          <p>{load.message}</p>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setReload((value) => value + 1);
            }}
          >
            Retry
          </Button>
        </div>
      ) : null}
      {load.kind === 'ready' && listedVaults.length === 0 ? (
        <div data-testid="cloud-vaults-empty-state">
          {props.excludeCloudIds?.length
            ? 'All your cloud vaults are already on this device.'
            : 'No cloud vaults yet. Open a local vault and enable sync in Settings → Vault Sync.'}
        </div>
      ) : null}
      {load.kind === 'ready' && listedVaults.length > 0 ? (
        <div
          className={styles['recent-vault-list']}
          data-testid="cloud-vault-list"
        >
          {listedVaults.map((remote) => {
            const bound =
              props.excludeCloudIds === undefined &&
              boundCloudIds.has(remote.cloudVaultId);
            const busy = busyId === remote.cloudVaultId;
            return (
              <div
                key={remote.cloudVaultId}
                className={styles['cloud-vault-row']}
                data-testid={`cloud-vault-row-${remote.cloudVaultId}`}
              >
                <div className={styles['cloud-vault-identity']}>
                  <VaultIcon appearance={remote.profile} />
                  <span className={styles['recent-vault-text']}>
                    <strong>{remote.name}</strong>{' '}
                    <small>
                      {remote.updatedAt !== null
                        ? `Updated ${new Date(remote.updatedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`
                        : `Revision ${remote.revision}`}
                    </small>
                  </span>
                </div>
                {!bound && corruptCloudIds.has(remote.cloudVaultId) ? (
                  <span
                    className={styles['recent-vault-text']}
                    data-testid={`cloud-vault-corrupt-${remote.cloudVaultId}`}
                  >
                    <small>
                      Sync history is damaged here — download again to repair
                      from the verified cloud copy.
                    </small>
                  </span>
                ) : null}
                {bound ? (
                  <span
                    data-testid={`cloud-vault-bound-${remote.cloudVaultId}`}
                  >
                    Synced on this device
                  </span>
                ) : (
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={busyId !== null}
                    data-testid={`cloud-vault-download-${remote.cloudVaultId}`}
                    onClick={() => {
                      setBusyId(remote.cloudVaultId);
                      setNotice(null);
                      void (async () => {
                        try {
                          // Download & Open (transactional hardening):
                          // prepare → identity-bound PreparedRemoteVault (NO
                          // binding) → activate successfully → finalize with
                          // the prepared handle (local-only, transactional).
                          // State machine: STAGING --prepare/activation
                          // failure--> discard staging; STAGING --activate
                          // ok--> OPENED; OPENED --finalize ok--> COMMITTED;
                          // OPENED --finalize fail--> OPENED LOCAL VAULT
                          // (unbound, never destructively discarded).
                          const createEmpty = vaults.createEmptyVaultStore;
                          const canMaterialize =
                            typeof sync.materializeRemoteVault === 'function' &&
                            typeof sync.finalizeMaterializedVault ===
                              'function' &&
                            typeof createEmpty === 'function';
                          if (canMaterialize) {
                            const store = await createEmpty(remote.name);
                            // Cancelled destination choice: not an error,
                            // and nothing is bound.
                            if (store === null) return;
                            let prepared: Awaited<
                              ReturnType<typeof sync.materializeRemoteVault>
                            >;
                            try {
                              prepared = await sync.materializeRemoteVault(
                                remote.cloudVaultId,
                                store.id,
                                store.vault,
                              );
                            } catch (error) {
                              try {
                                await store.discard();
                              } catch {
                                // Cleanup never hides the primary error.
                              }
                              throw error;
                            }
                            let created: VaultChoice | null = null;
                            try {
                              created = await store.activate();
                            } catch (error) {
                              try {
                                await store.discard();
                              } catch {
                                // Cleanup never hides the primary error.
                              }
                              throw error;
                            }
                            // Activation cancelled (null): discard the
                            // unbound temporary store, bind nothing.
                            if (created === null) {
                              try {
                                await store.discard();
                              } catch {
                                // Best-effort only.
                              }
                              return;
                            }
                            // Activation succeeded: ownership transferred.
                            // The backing store is now an opened user vault;
                            // it must NEVER be destructively discarded from
                            // here, even if sync metadata fails.
                            try {
                              await sync.finalizeMaterializedVault(prepared);
                            } catch (error) {
                              // Finalize failed after activation: leave the
                              // vault locally usable but unbound. Park sync
                              // explicitly on the opened vault (best effort)
                              // and surface the metadata error without
                              // deleting anything.
                              try {
                                sync.setActiveLocalVault(store.id);
                              } catch {
                                // Selection memory is best-effort.
                              }
                              setNotice(
                                `Vault opened locally, but cloud sync could not be attached. ${downloadErrorCopy(error)}`,
                              );
                              onOpen(created);
                              return;
                            }
                            onOpen(created);
                            return;
                          }
                          const location = await vaults.chooseCreateLocation();
                          if (location === null) return;
                          const created = await location.create(remote.name);
                          if (created === null) return;
                          await created.activate();
                          await sync.attachRemoteVault(
                            remote.cloudVaultId,
                            created.id,
                          );
                          onOpen(created);
                        } catch (error) {
                          setNotice(downloadErrorCopy(error));
                        } finally {
                          setBusyId(null);
                        }
                      })();
                    }}
                  >
                    {busy ? 'Downloading…' : 'Download & Open'}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      ) : null}
      {notice !== null ? (
        <p role="alert" data-testid="cloud-vaults-notice">
          {notice}
        </p>
      ) : null}
    </section>
  );
}
