/**
 * Vault Sync settings section.
 *
 * Platform-neutral presentation over `VaultSyncService`: per-vault
 * opt-in sync, explicit sync status kept separate from local save status,
 * manual Sync now, and Disable Sync, which stops the replica and retains
 * the cloud copy.
 *
 * Authorization posture: client purchase state gates this UI
 * only. Backend writes succeed under the trusted server claim; a Rules
 * denial while the client is Pro surfaces as `waiting-for-entitlement`
 * ("Activating…"), never as a purchase error. Local saves never wait for
 * sync: the section always states files are saved locally
 * first.
 */

import { useState } from 'react';
import type { AccountService } from '@froglight/foundation/account';
import type { AccountIdentityService } from '@froglight/foundation';
import {
  hasFroglightPro,
  type PurchaseService,
} from '@froglight/foundation/purchases';
import type { VaultSyncService } from '@froglight/foundation';
import { Button } from './Button.jsx';
import { ProPaywall } from './ProPaywall.jsx';
import { useAccountSnapshot } from './useAccount.jsx';
import { usePurchaseSnapshot } from './usePurchases.jsx';
import { useServerPro } from './useServerPro.jsx';
import { useVaultSyncSnapshot } from './useVaultSync.jsx';
import { useObjectUrl } from './previews/shared.js';
import sectionStyles from './SettingsView.module.css';
import styles from './VaultSyncSettingsView.module.css';

export interface SyncCurrentVault {
  readonly id: string;
  readonly name: string;
}

export interface VaultSyncSettingsViewProps {
  /**
   * Shell resolvers for the host-owned services; null without a provider.
   * Must return stable instances across renders (the probes do).
   */
  readonly resolveAccount: () => AccountService | null;
  readonly resolvePurchases: () => PurchaseService | null;
  readonly resolveSync: () => VaultSyncService | null;
  readonly resolveIdentity: () => AccountIdentityService | null;
  /** The vault the host currently shows as active, if any. */
  readonly resolveCurrentVault: () => SyncCurrentVault | null;
}

/**
 * User-facing copy for stable sync codes. Names the problem and the
 * recovery; never leaks Firebase/SDK wording. The activating state is
 * reassurance, never an error.
 */
export function vaultSyncErrorCopy(code: string): string {
  switch (code) {
    case 'NOT_CONFIGURED':
      return 'Sync isn’t set up in this build yet. Your vaults stay on this device.';
    case 'NOT_AUTHENTICATED':
      return 'Sign in to sync vaults.';
    case 'PRO_REQUIRED':
      return 'Froglight Pro is required for cloud sync.';
    case 'ENTITLEMENT_PENDING':
      return 'Your Pro purchase is activating on the server. Sync begins automatically — nothing to fix.';
    case 'NETWORK':
      return 'Offline — changes are saved locally and sync when you’re back online.';
    case 'REMOTE_NOT_FOUND':
      return 'That cloud vault no longer exists.';
    case 'REMOTE_CHANGED':
      return 'Another device updated first. Try Sync now.';
    case 'CONFLICT':
      return 'Conflicting edits were kept as separate copies — nothing was overwritten.';
    case 'CORRUPT_MANIFEST':
      return 'The cloud copy looks damaged. Try again; your local files are safe.';
    case 'CORRUPT_SYNC_METADATA':
      return 'This device’s sync history is damaged, so cloud sync is paused. Your local files are safe — repair it from the verified cloud copy, or download the cloud vault again if the cloud copy has changed.';
    case 'REMATERIALIZE_REQUIRED':
      return 'The cloud copy has changed since this device last synced, so the damaged sync history can’t be rebuilt in place. Your local files are safe — download the cloud vault again to resume syncing from the verified copy.';
    case 'HASH_MISMATCH':
      return 'A download failed verification and was discarded. Try again.';
    case 'QUOTA_EXCEEDED':
      return 'Cloud quota exceeded. Free space or shrink large attachments, then try again.';
    case 'PERMISSION_DENIED':
      return 'The server denied that write. If you just subscribed, wait a moment and try Sync now.';
    default:
      return 'Something went wrong with sync. Your local files are safe — try again.';
  }
}

function errorCodeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = (error as Record<string, unknown>).code;
    if (typeof code === 'string') return code;
  }
  return 'UNKNOWN';
}

export function VaultSyncSettingsView(
  props: VaultSyncSettingsViewProps,
): React.ReactElement {
  const {
    resolveAccount,
    resolvePurchases,
    resolveSync,
    resolveIdentity,
    resolveCurrentVault,
  } = props;
  const account = resolveAccount();
  const purchases = resolvePurchases();
  const service = resolveSync();
  const identity = resolveIdentity();
  const { snapshot: accountSnapshot } = useAccountSnapshot(account);
  const { snapshot: purchaseSnapshot } = usePurchaseSnapshot(purchases);
  // Platform-independent Pro gate: client purchase state (native) OR the
  // trusted server claim (any signed-in host, including web which has no
  // native purchase provider). Backend writes still authorize on the
  // server claim only; this gates presentation.
  const { isPro: serverIsPro, loading: serverLoading } = useServerPro(account);
  const { snapshot } = useVaultSyncSnapshot(service);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [conflictBusy, setConflictBusy] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<{
    readonly conflictId: string;
    readonly fileName: string;
    readonly blob: Blob;
  } | null>(null);
  const recoveryUrl = useObjectUrl(recovery?.blob ?? null);

  const current = resolveCurrentVault();

  if (service === null) {
    return (
      <div
        className={sectionStyles['settings-section']}
        data-fl-component="vault-sync-settings"
        data-state="unavailable"
      >
        <h2 className={sectionStyles['settings-section-title']}>Vault Sync</h2>
        <p className={styles['sync-lede']}>
          Sync isn’t available on this host yet. Your vaults stay on this device
          and keep working offline.
        </p>
      </div>
    );
  }

  const signedIn = accountSnapshot.user !== null;
  const isPro = hasFroglightPro(purchaseSnapshot.customer) || serverIsPro;
  const accountUnconfigured =
    accountSnapshot.error !== null &&
    (accountSnapshot.error as { readonly code?: unknown }).code ===
      'NOT_CONFIGURED';

  if (accountUnconfigured) {
    return (
      <div
        className={sectionStyles['settings-section']}
        data-fl-component="vault-sync-settings"
        data-state="unavailable"
      >
        <h2 className={sectionStyles['settings-section-title']}>Vault Sync</h2>
        <p className={styles['sync-lede']}>
          Sync isn’t set up in this build yet. Your vaults stay on this device
          and keep working offline.
        </p>
      </div>
    );
  }

  if (!signedIn) {
    return (
      <div
        className={sectionStyles['settings-section']}
        data-fl-component="vault-sync-settings"
        data-state="signed-out"
      >
        <h2 className={sectionStyles['settings-section-title']}>Vault Sync</h2>
        <p className={styles['sync-lede']}>
          Saved locally, always — sync is an optional copy for your other
          devices. Sign in (Account section) to sync this vault.
        </p>
      </div>
    );
  }

  if (!isPro) {
    if (serverLoading && !hasFroglightPro(purchaseSnapshot.customer)) {
      return (
        <div
          className={sectionStyles['settings-section']}
          data-fl-component="vault-sync-settings"
          data-state="checking"
        >
          <h2 className={sectionStyles['settings-section-title']}>
            Vault Sync
          </h2>
          <p className={styles['sync-lede']}>
            Checking your subscription status…
          </p>
        </div>
      );
    }
    return (
      <div
        className={sectionStyles['settings-section']}
        data-fl-component="vault-sync-settings"
        data-state="needs-pro"
      >
        <h2 className={sectionStyles['settings-section-title']}>Vault Sync</h2>
        <p className={styles['sync-lede']}>
          Cloud sync needs Froglight Pro. Your vault stays fully usable locally
          either way.
        </p>
        <ProPaywall
          service={purchases}
          serverIsPro={serverIsPro}
          serverLoading={serverLoading}
          ensureAccountIdentity={
            identity === null
              ? undefined
              : () => identity.ensureAccountIdentity()
          }
        />
      </div>
    );
  }

  const binding = snapshot.binding;
  const boundHere =
    binding !== null && current !== null && binding.localVaultId === current.id;
  const boundElsewhere =
    binding !== null && current !== null && binding.localVaultId !== current.id;
  // Explicit enabled semantics: a remembered binding for the current
  // vault with `enabled: false` is OFF — the cloud relationship is kept
  // and can be re-enabled, but no automatic reconciliation runs and the
  // corrupt-repair workflow stays dormant until sync is re-enabled.
  const enabledHere = boundHere && snapshot.enabled;
  // A disabled binding is never "parked": it is disabled. Parking
  // describes an ENABLED binding whose live replica is not the reported
  // selection (final async-ownership pass).
  const parked =
    binding !== null &&
    snapshot.enabled &&
    snapshot.activeLocalVaultId !== null &&
    binding.localVaultId !== snapshot.activeLocalVaultId;
  // Corrupt persisted merge base for the vault currently shown AND
  // enabled: cloud reconciliation is parked and `repairCorruptBinding()`
  // is the explicit verified reconstruction path. A disabled corrupt
  // binding stays Off (disabling is authoritative).
  const corruptBinding = enabledHere && binding?.baseCorrupt === true;

  const syncing =
    snapshot.phase === 'scanning' ||
    snapshot.phase === 'uploading' ||
    snapshot.phase === 'downloading' ||
    snapshot.phase === 'merging';

  let status: string;
  if (snapshot.phase === 'waiting-for-entitlement' && enabledHere) {
    status = 'Activating cloud sync…';
  } else if (enabledHere && syncing) {
    status = 'Syncing…';
  } else if (corruptBinding) {
    status = 'Paused — damaged sync history';
  } else if (enabledHere && snapshot.error !== null) {
    status = statusForError(snapshot.error.code);
  } else if (enabledHere && snapshot.pendingChanges > 0) {
    status = 'Sync pending';
  } else if (enabledHere) {
    status = 'Up to date';
  } else if (boundElsewhere && snapshot.enabled) {
    status = 'Up to date';
  } else {
    status = 'Off';
  }

  const canEnable = !busy && current !== null;
  const state =
    snapshot.phase === 'waiting-for-entitlement' && enabledHere
      ? 'activating'
      : binding !== null && snapshot.enabled
        ? 'on'
        : 'off';

  return (
    <div
      className={sectionStyles['settings-section']}
      data-fl-component="vault-sync-settings"
      data-state={state}
      aria-busy={busy}
    >
      <h2 className={sectionStyles['settings-section-title']}>Vault Sync</h2>
      <p className={styles['sync-lede']}>
        Saved locally, always. Keep this vault up to date across your devices,
        even after working offline.
      </p>
      <div className={styles['sync-summary']}>
        <div className={styles['sync-status']} data-testid="sync-status">
          <span className={styles['sync-status-label']}>Current vault:</span>{' '}
          <strong data-testid="sync-current-vault">
            {current?.name ?? 'None open'}
          </strong>
        </div>
        <div className={styles['sync-status']}>
          <span className={styles['sync-status-label']}>Sync:</span>{' '}
          <strong data-testid="sync-state">
            {binding === null
              ? 'Off'
              : boundHere
                ? enabledHere
                  ? 'On'
                  : 'Off'
                : snapshot.enabled
                  ? `On for ${binding.name}`
                  : `Off for ${binding.name}`}
          </strong>
        </div>
        <div className={styles['sync-status']}>
          <span className={styles['sync-status-label']}>Status:</span>{' '}
          <strong data-testid="sync-phase">{status}</strong>
        </div>
      </div>
      {current === null ? (
        <p className={styles['sync-meta']}>
          Open a vault from Home to manage its sync settings.
        </p>
      ) : null}
      {snapshot.lastSyncedAt !== null && boundHere ? (
        <p className={styles['sync-meta']}>
          Last synced{' '}
          <span data-testid="sync-last-synced">
            {new Date(snapshot.lastSyncedAt).toLocaleString(undefined, {
              dateStyle: 'medium',
              timeStyle: 'short',
            })}
          </span>
        </p>
      ) : null}
      {parked ? (
        <p className={styles['sync-meta']} data-testid="sync-parked">
          Paused — another vault is open. Reopen the synced vault to resume.
        </p>
      ) : null}
      {boundElsewhere && snapshot.enabled ? (
        <p className={styles['sync-meta']} data-testid="sync-elsewhere">
          Sync is on for “{binding.name}”. Enabling here moves sync to this
          vault; the cloud copy is kept, never deleted.
        </p>
      ) : null}
      {boundElsewhere && !snapshot.enabled ? (
        <p className={styles['sync-meta']} data-testid="sync-elsewhere">
          Sync is off for “{binding.name}”.
        </p>
      ) : null}
      {snapshot.deferredPaths.length > 0 ? (
        <p className={styles['sync-meta']} data-testid="sync-deferred">
          Waiting on {snapshot.deferredPaths.length} open{' '}
          {snapshot.deferredPaths.length === 1 ? 'editor' : 'editors'} with
          unsaved changes ({snapshot.deferredPaths.slice(0, 3).join(', ')}
          {snapshot.deferredPaths.length > 3 ? ', …' : ''}). Save or close them
          to finish syncing — nothing is overwritten meanwhile.
        </p>
      ) : null}
      {boundHere && snapshot.conflicts.length > 0 ? (
        <section
          className={styles['sync-conflicts']}
          aria-labelledby="sync-conflicts-title"
          data-testid="sync-conflicts"
        >
          <h3 id="sync-conflicts-title">Conflicts needing review</h3>
          <p className={styles['sync-meta']}>
            Froglight kept both versions. Recovery only clears this notice after
            you explicitly acknowledge it; the preserved vault copy is never
            deleted here.
          </p>
          <ul className={styles['sync-conflict-list']}>
            {snapshot.conflicts.map((conflict) => {
              const hiddenPropertyCopy =
                conflict.conflictPath?.startsWith('.froglight/properties/') ===
                true;
              const recovered =
                conflict.recoveredAt !== null ||
                recovery?.conflictId === conflict.id;
              return (
                <li key={conflict.id} className={styles['sync-conflict-item']}>
                  <strong>{conflict.path}</strong>
                  <span className={styles['sync-conflict-detail']}>
                    {conflict.conflictPath === null
                      ? 'The edited version remains at the original path.'
                      : hiddenPropertyCopy
                        ? 'A hidden property sidecar copy is preserved.'
                        : `Preserved copy: ${conflict.conflictPath}`}
                  </span>
                  <div className={styles['sync-conflict-actions']}>
                    <Button
                      type="button"
                      variant="secondary"
                      disabled={conflictBusy !== null}
                      data-testid={`sync-conflict-recover-${conflict.id}`}
                      onClick={() => {
                        setConflictBusy(conflict.id);
                        setNotice(null);
                        setRecovery(null);
                        void service
                          .prepareConflictRecovery(conflict.id)
                          .then((prepared) => {
                            setRecovery({
                              conflictId: prepared.conflictId,
                              fileName: prepared.fileName,
                              blob: new Blob([prepared.bytes.slice()], {
                                type: 'application/octet-stream',
                              }),
                            });
                          })
                          .catch((error: unknown) => {
                            setNotice(vaultSyncErrorCopy(errorCodeOf(error)));
                          })
                          .finally(() => setConflictBusy(null));
                      }}
                    >
                      {conflictBusy === conflict.id
                        ? 'Preparing…'
                        : 'Prepare recovery copy'}
                    </Button>
                    {recovery?.conflictId === conflict.id &&
                    recoveryUrl !== null ? (
                      <Button
                        variant="primary"
                        href={recoveryUrl}
                        download={recovery.fileName}
                        data-testid={`sync-conflict-download-${conflict.id}`}
                      >
                        Download exact copy
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="ghost"
                      disabled={
                        conflictBusy !== null ||
                        (hiddenPropertyCopy && !recovered)
                      }
                      data-testid={`sync-conflict-ack-${conflict.id}`}
                      onClick={() => {
                        setConflictBusy(conflict.id);
                        setNotice(null);
                        void service
                          .acknowledgeConflict(conflict.id)
                          .then(() => {
                            setRecovery((currentRecovery) =>
                              currentRecovery?.conflictId === conflict.id
                                ? null
                                : currentRecovery,
                            );
                          })
                          .catch((error: unknown) => {
                            setNotice(vaultSyncErrorCopy(errorCodeOf(error)));
                          })
                          .finally(() => setConflictBusy(null));
                      }}
                    >
                      Acknowledge
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
      <p className={styles['sync-meta']}>
        Conflicting edits are kept as separate copies so you can review both
        versions.
      </p>
      {snapshot.error !== null &&
      snapshot.phase !== 'waiting-for-entitlement' ? (
        <p role="alert" className={styles['sync-notice']} data-kind="error">
          {vaultSyncErrorCopy(snapshot.error.code)}
        </p>
      ) : null}
      {snapshot.phase === 'waiting-for-entitlement' ? (
        <p role="status" className={styles['sync-notice']} data-kind="info">
          {vaultSyncErrorCopy('ENTITLEMENT_PENDING')}
        </p>
      ) : null}
      {notice !== null ? (
        <p role="alert" className={styles['sync-notice']} data-kind="error">
          {notice}
        </p>
      ) : null}
      <div className={styles['sync-actions']}>
        {!enabledHere ? (
          <Button
            type="button"
            variant="primary"
            disabled={!canEnable}
            data-testid="sync-enable"
            onClick={() => {
              if (current === null) return;
              setBusy(true);
              setNotice(null);
              void (async () => {
                try {
                  // Bind the store identity before paid cloud work (§9):
                  // a signed-in user never purchases sync under an
                  // unrelated anonymous identity.
                  await identity?.ensureAccountIdentity();
                  // Enabling a disabled binding is intentionally the same
                  // call: the service preserves cloudVaultId, base,
                  // lastRevision, and deviceId instead of creating a new
                  // cloud vault. It never calls attachRemoteVault().
                  await service.enable({
                    localVaultId: current.id,
                    name: current.name,
                  });
                  // Force-refresh the server claim: purchases activate
                  // locally before the extension propagates (§15). A
                  // pending claim parks as Activating, never an error.
                  try {
                    await service.ensureProEntitlement();
                  } catch (error) {
                    if (errorCodeOf(error) !== 'ENTITLEMENT_PENDING')
                      throw error;
                  }
                } catch (error) {
                  setNotice(vaultSyncErrorCopy(errorCodeOf(error)));
                } finally {
                  setBusy(false);
                }
              })();
            }}
          >
            {busy ? 'Enabling…' : 'Enable Sync'}
          </Button>
        ) : (
          <>
            {corruptBinding ? (
              <Button
                type="button"
                variant="primary"
                disabled={busy}
                data-testid="sync-repair"
                onClick={() => {
                  setBusy(true);
                  setNotice(null);
                  void service
                    .repairCorruptBinding()
                    .catch((error: unknown) => {
                      setNotice(vaultSyncErrorCopy(errorCodeOf(error)));
                    })
                    .finally(() => {
                      setBusy(false);
                    });
                }}
              >
                {busy ? 'Repairing…' : 'Repair Sync'}
              </Button>
            ) : (
              <Button
                type="button"
                variant="primary"
                disabled={busy}
                data-testid="sync-now"
                onClick={() => {
                  setBusy(true);
                  setNotice(null);
                  void service
                    .reconcile()
                    .catch((error: unknown) => {
                      // ENTITLEMENT_PENDING already renders as Activating via
                      // the snapshot; anything else gets an inline note too.
                      if (errorCodeOf(error) !== 'ENTITLEMENT_PENDING') {
                        setNotice(vaultSyncErrorCopy(errorCodeOf(error)));
                      }
                    })
                    .finally(() => {
                      setBusy(false);
                    });
                }}
              >
                {busy ? 'Syncing…' : 'Sync now'}
              </Button>
            )}
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              data-testid="sync-disable"
              onClick={() => {
                setBusy(true);
                setNotice(null);
                void service
                  .disable()
                  .catch((error: unknown) => {
                    setNotice(vaultSyncErrorCopy(errorCodeOf(error)));
                  })
                  .finally(() => {
                    setBusy(false);
                  });
              }}
            >
              Disable Sync
            </Button>
          </>
        )}
      </div>
      {boundHere ? (
        <p className={styles['sync-meta']}>
          {enabledHere
            ? 'Disabling sync moves this vault to Local on Home. Your local files stay available and the cloud copy is kept.'
            : 'This vault is in Local on Home; the cloud copy is kept. Enable sync to reconnect it.'}
        </p>
      ) : null}
      <p className={styles['sync-privacy']}>
        Private to your account and encrypted in transit. Not end-to-end
        encrypted.
      </p>
    </div>
  );
}

function statusForError(code: string): string {
  switch (code) {
    case 'ENTITLEMENT_PENDING':
      return 'Activating cloud sync…';
    case 'PRO_REQUIRED':
      return 'Pro required';
    case 'NOT_AUTHENTICATED':
      return 'Sign in required';
    case 'NETWORK':
      return 'Offline — changes saved locally';
    case 'NOT_CONFIGURED':
      return 'Not configured';
    default:
      return 'Sync error';
  }
}
