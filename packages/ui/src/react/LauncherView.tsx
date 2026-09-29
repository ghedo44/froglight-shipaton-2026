import { DialogHeader, DialogBody } from './DialogParts.jsx';
import { Dialog, type DialogHandle } from './primitives/Dialog.jsx';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import {
  DEFAULT_VAULT_APPEARANCE,
  type VaultAppearance,
  accountIdentityToken,
  accountToken,
  vaultSyncToken,
} from '@froglight/foundation';
import type { AccountService } from '@froglight/foundation/account';
import type { VaultSyncService } from '@froglight/foundation';
import type {
  VaultChoice,
  VaultCreateLocation,
  VaultHostAdapter,
} from '../launcher.js';
import type { InstalledUi } from '../workbench.js';
import { noWindowChrome, type WindowChrome } from '../window-chrome.js';
import { Button, IconButton } from './Button.jsx';
import { CloudVaultsView } from './CloudVaultsView.jsx';
import { Icon } from './Icon.jsx';
import styles from './LauncherView.module.css';
import { VaultIcon } from './VaultIcon.jsx';
import { VaultAppearancePicker } from './VaultAppearancePicker.jsx';
import { FrogMark } from './FrogMark.jsx';
import { Titlebar } from './Titlebar.jsx';
import { isEditableTarget } from '../menu.js';
import { useAboveKeyboard } from './useAboveKeyboard.js';
import { settingsRegistryToken } from '../settings-registry.js';
import { SettingsModal } from './SettingsModal.jsx';
import { BackupVaultContext } from './VaultBackupSettingsView.jsx';
import { useAccountSnapshot } from './useAccount.jsx';
import { useVaultSyncSnapshot } from './useVaultSync.jsx';
import { LoginDialog } from './LoginDialog.jsx';

/**
 * Vault launcher surface: brand header, primary actions, recent vaults,
 * and the create-vault modal. Hosts only see `VaultHostAdapter`.
 * Behavior parity with the previous imperative renderer; presentation is
 * free to evolve independently.
 *
 * Hosts with custom window chrome get a slim draggable bar above the page;
 * a plain browser tab renders the launcher full-page with no app bar.
 */
export function LauncherView(props: {
  vaults: VaultHostAdapter;
  onOpen: (choice: VaultChoice) => void;
  chrome?: WindowChrome;
  /**
   * Installed shell: resolves the account/sync services for the
   * Cloud vaults section. Optional so older hosts and tests keep working;
   * without it the launcher shows local vaults only.
   */
  ui?: InstalledUi | null;
}): React.ReactElement {
  const { vaults, onOpen, chrome = noWindowChrome(), ui = null } = props;
  const [message, setMessage] = useState<{ text: string; error: boolean }>({
    text: '',
    error: false,
  });
  const [recents, setRecents] = useState<readonly VaultChoice[] | null>(null);
  const [creating, setCreating] = useState(false);
  const createCloseRef = useRef<DialogHandle | null>(null);
  const [settingsSection, setSettingsSection] = useState<string | null>(null);
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);
  const accountMenuRef = useRef<HTMLDivElement | null>(null);
  const account = ui?.services.try(accountToken) ?? null;
  const { snapshot: accountSnapshot } = useAccountSnapshot(account);
  const { snapshot: syncSnapshot } = useVaultSyncSnapshot(
    ui?.services.try(vaultSyncToken) ?? null,
  );
  const [vaultTab, setVaultTab] = useState<'local' | 'synced'>('local');
  const [cloudVisited, setCloudVisited] = useState(false);
  useEffect(() => {
    if (vaultTab === 'synced') setCloudVisited(true);
  }, [vaultTab]);
  const bindings = syncSnapshot.bindings;
  const syncedIds = new Set(
    bindings
      .filter((binding) => binding.enabled)
      .map((binding) => binding.localVaultId),
  );
  const visibleVaults = recents?.filter(
    (choice) => syncedIds.has(choice.id) === (vaultTab === 'synced'),
  );
  // A remembered local copy owns its row, even when sync is disabled.
  const localCloudIds = bindings
    .filter(
      (binding) =>
        binding.baseCorrupt !== true &&
        recents?.some((choice) => choice.id === binding.localVaultId),
    )
    .map((binding) => binding.cloudVaultId);
  const settingsRegistry = ui?.services.try(settingsRegistryToken) ?? null;

  useEffect(() => {
    if (!accountMenuOpen) return;
    const dismiss = (event: PointerEvent): void => {
      if (!accountMenuRef.current?.contains(event.target as Node))
        setAccountMenuOpen(false);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setAccountMenuOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', dismiss);
      document.removeEventListener('keydown', escape);
    };
  }, [accountMenuOpen]);

  const openCreateModal = useCallback((): void => {
    createCloseRef.current?.cancelClose();
    setCreating(true);
  }, []);
  const closeCreateModal = useCallback((): void => {
    setCreating(false);
  }, []);

  useEffect(() => {
    const suppressBrowserMenu = (event: MouseEvent): void => {
      if (!isEditableTarget(event.target)) event.preventDefault();
    };
    document.addEventListener('contextmenu', suppressBrowserMenu, true);
    return () =>
      document.removeEventListener('contextmenu', suppressBrowserMenu, true);
  }, []);

  const showMessage = (text: string, error = false): void => {
    setMessage({ text, error });
  };

  /** Non-Error rejections (e.g. host/plugin objects) must stay diagnosable. */
  const describe = (error: unknown): string => {
    if (error instanceof Error) return error.message;
    try {
      return JSON.stringify(error, Object.getOwnPropertyNames(error as object));
    } catch {
      return describe(error);
    }
  };

  const openChoice = (choice: VaultChoice): void => {
    showMessage(`Opening ${choice.name}…`);
    void choice
      .activate()
      .then(() => onOpen(choice))
      .catch((error: unknown) =>
        showMessage(`Could not open vault: ${describe(error)}`, true),
      );
  };

  useLayoutEffect(() => {
    let alive = true;
    void vaults
      .listRecent()
      .then((recent) => {
        if (!alive) return;
        setRecents(
          [...recent].sort(
            (a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0),
          ),
        );
      })
      .catch((error: unknown) => {
        if (alive)
          showMessage(`Could not load recent vaults: ${describe(error)}`, true);
      });
    return () => {
      alive = false;
    };
  }, [vaults]);

  return (
    <div
      className={styles['froglight-launcher-root']}
      data-testid="vault-launcher"
    >
      {chrome.kind !== 'none' ? (
        <Titlebar chrome={chrome}>
          <span className={styles['fl-titlebar-brand']}>
            <span className={styles['workspace-vault-mark']}>
              <FrogMark />
            </span>
            <span className={styles['fl-titlebar-brand-name']}>Froglight</span>
          </span>
        </Titlebar>
      ) : null}
      <main className={styles['vault-launcher']}>
        <section className={styles['vault-launcher-brand']}>
          <div className={styles['vault-launcher-mark']}>
            <FrogMark />
          </div>
          <h1 data-testid="vault-launcher-title">Froglight</h1>
          <p data-testid="vault-launcher-tagline">
            Your notes. Plain files. Local-first.
          </p>
        </section>

        <div className={styles['vault-launcher-actions']}>
          <Button
            type="button"
            variant="primary"
            data-testid="create-vault-button"
            onClick={openCreateModal}
          >
            Create new vault
          </Button>
          <Button
            type="button"
            data-testid="open-vault-button"
            onClick={() => {
              showMessage('Choose a vault folder…');
              void vaults
                .openVault()
                .then((choice) => {
                  if (choice === null) {
                    showMessage('');
                    return;
                  }
                  openChoice(choice);
                })
                .catch((error: unknown) =>
                  showMessage(`Could not open vault: ${describe(error)}`, true),
                );
            }}
          >
            Open existing vault
          </Button>
        </div>

        <div
          className={`${styles['vault-launcher-message']}${message.error ? ` ${styles.error}` : ''}`}
          data-testid="vault-launcher-message"
        >
          {message.text}
        </div>

        <div
          className={styles['vault-tabs']}
          role="tablist"
          aria-label="Vaults"
        >
          {(['local', 'synced'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              id={`vault-tab-${tab}`}
              aria-selected={vaultTab === tab}
              aria-controls="vault-panel"
              tabIndex={vaultTab === tab ? 0 : -1}
              onClick={() => setVaultTab(tab)}
              onKeyDown={(event) => {
                if (
                  !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(
                    event.key,
                  )
                )
                  return;
                event.preventDefault();
                const next =
                  event.key === 'Home'
                    ? 'local'
                    : event.key === 'End'
                      ? 'synced'
                      : tab === 'local'
                        ? 'synced'
                        : 'local';
                setVaultTab(next);
                document.getElementById(`vault-tab-${next}`)?.focus();
              }}
            >
              {tab === 'local' ? 'Local' : 'Synced'}
              {recents !== null && tab === 'local' && (
                <span className={styles['vault-count']}>
                  {recents.filter((choice) => !syncedIds.has(choice.id)).length}
                </span>
              )}
            </button>
          ))}
        </div>
        <div
          id="vault-panel"
          role="tabpanel"
          aria-labelledby={`vault-tab-${vaultTab}`}
          className={styles['vault-panel']}
        >
          <p className={styles['vault-description']}>
            {vaultTab === 'local'
              ? 'On this device. Open a vault to start working.'
              : 'Across your devices. Download a cloud vault or open a local copy.'}
          </p>
          <section
            hidden={vaultTab === 'synced' && visibleVaults?.length === 0}
            className={styles['recent-vaults']}
          >
            <div
              className={styles['recent-vaults-heading']}
              data-testid="recent-vaults-heading"
            >
              {vaultTab === 'local' ? 'Local vaults' : 'On this device'}
            </div>
            <div
              className={styles['recent-vault-list']}
              data-testid="recent-vault-list"
            >
              {visibleVaults === undefined ? (
                <p role="status">Loading vaults…</p>
              ) : visibleVaults.length === 0 && vaultTab === 'local' ? (
                <div
                  className={styles['recent-vault-empty']}
                  data-testid="recent-vault-empty-state"
                >
                  <strong>No local vaults yet.</strong>
                  <span>Create a vault or open an existing folder.</span>
                </div>
              ) : (
                (visibleVaults ?? []).map((choice, index) => (
                  <div
                    key={choice.id}
                    className={styles['recent-vault-row']}
                    data-testid={`recent-vault-row-${index}`}
                  >
                    <button
                      type="button"
                      className={styles['recent-vault-card']}
                      data-testid={`open-recent-vault-button-${index}`}
                      onClick={() => openChoice(choice)}
                    >
                      <VaultIcon appearance={choice.profile} />
                      <span className={styles['recent-vault-text']}>
                        <strong data-testid={`recent-vault-name-${index}`}>
                          {choice.name}
                        </strong>
                        <small data-testid={`recent-vault-location-${index}`}>
                          {choice.profileError ??
                            (vaultTab === 'synced'
                              ? `Available offline · ${choice.location}`
                              : choice.location)}
                        </small>
                      </span>
                    </button>
                    <IconButton
                      icon="close"
                      size={14}
                      label={`Forget ${choice.name}`}
                      title="Remove from recent vaults"
                      className={styles['recent-vault-forget']}
                      data-testid={`forget-recent-vault-button-${index}`}
                      onClick={() => {
                        void vaults
                          .forgetVault(choice.id)
                          .then(() => {
                            setRecents(
                              (current) =>
                                current?.filter(
                                  (candidate) => candidate.id !== choice.id,
                                ) ?? current,
                            );
                          })
                          .catch((error: unknown) => {
                            showMessage(
                              `Could not remove recent vault: ${describe(error)}`,
                              true,
                            );
                          });
                      }}
                    />
                  </div>
                ))
              )}
            </div>
          </section>

          {ui !== null &&
          (cloudVisited || vaultTab === 'synced') &&
          accountSnapshot.user !== null ? (
            <div hidden={vaultTab !== 'synced'}>
              <CloudVaultsView
                key={accountSnapshot.user.id}
                excludeCloudIds={localCloudIds}
                vaults={vaults}
                onOpen={onOpen}
                resolveAccount={(): AccountService | null =>
                  ui.services.try(accountToken) ?? null
                }
                resolveSync={(): VaultSyncService | null =>
                  ui.services.try(vaultSyncToken) ?? null
                }
              />
            </div>
          ) : null}

          {vaultTab === 'synced' && accountSnapshot.user === null ? (
            <div className={styles['recent-vault-empty']}>
              <strong>Your vaults, on every device</strong>
              <span>
                Sign in to access your synced vaults. Cloud sync requires
                Froglight Pro.
              </span>
              <Button variant="primary" onClick={() => setLoginOpen(true)}>
                Sign in
              </Button>
            </div>
          ) : null}
        </div>

        {creating ? (
          <CreateVaultModal
            vaults={vaults}
            closeRef={createCloseRef}
            onClose={closeCreateModal}
            onCreated={(created) => {
              setCreating(false);
              openChoice(created);
            }}
          />
        ) : null}
      </main>
      <footer className={styles['launcher-footer']}>
        <button
          type="button"
          className={styles['launcher-footer-button']}
          data-testid="launcher-settings-button"
          disabled={settingsRegistry === null}
          onClick={() => setSettingsSection('froglight.appearance')}
        >
          <Icon name="settings" size={18} />
          <span>Settings</span>
        </button>
        <div className={styles['launcher-account']} ref={accountMenuRef}>
          <button
            type="button"
            className={styles['launcher-footer-button']}
            data-testid="launcher-account-button"
            aria-expanded={
              accountSnapshot.user !== null ? accountMenuOpen : undefined
            }
            onClick={() => {
              if (accountSnapshot.user === null) setLoginOpen(true);
              else setAccountMenuOpen((open) => !open);
            }}
          >
            <Icon name="lock" size={17} />
            <span className={styles['launcher-account-label']}>
              {accountSnapshot.user?.email ??
                (accountSnapshot.user ? 'Account' : 'Log in')}
            </span>
          </button>
          {accountMenuOpen && accountSnapshot.user !== null ? (
            <div className={styles['launcher-account-menu']}>
              <div
                className={styles['launcher-account-email']}
                title={accountSnapshot.user.email ?? undefined}
              >
                {accountSnapshot.user.email ?? 'Account'}
              </div>
              <button
                type="button"
                disabled={signingOut}
                onClick={() => {
                  const identity = ui?.services.try(accountIdentityToken);
                  const run = identity
                    ? identity.signOut()
                    : account?.signOut();
                  if (run === undefined) {
                    setAccountError('Account is unavailable. Try again.');
                    return;
                  }
                  setSigningOut(true);
                  setAccountError(null);
                  void run
                    .then(() => setAccountMenuOpen(false))
                    .catch(() =>
                      setAccountError('Could not sign out. Try again.'),
                    )
                    .finally(() => setSigningOut(false));
                }}
              >
                {signingOut ? 'Signing out…' : 'Sign out'}
              </button>
              {accountError !== null ? (
                <p role="alert">{accountError}</p>
              ) : null}
            </div>
          ) : null}
        </div>
      </footer>
      {settingsSection !== null && settingsRegistry !== null
        ? createPortal(
            <BackupVaultContext.Provider value={{ vaults, onOpen }}>
              <SettingsModal
                registry={settingsRegistry}
                initialSectionId={settingsSection}
                onClose={() => setSettingsSection(null)}
              />
            </BackupVaultContext.Provider>,
            document.body,
          )
        : null}
      {loginOpen ? (
        <LoginDialog
          resolveAccount={() => ui?.services.try(accountToken) ?? null}
          resolveIdentity={() => ui?.services.try(accountIdentityToken) ?? null}
          onClose={() => setLoginOpen(false)}
        />
      ) : null}
    </div>
  );
}

function CreateVaultModal(props: {
  vaults: VaultHostAdapter;
  closeRef?: React.Ref<DialogHandle>;
  onClose: () => void;
  onCreated: (created: VaultChoice) => void;
}): React.ReactElement {
  const { vaults, onClose, onCreated, closeRef: externalCloseRef } = props;
  const [name, setName] = useState('');
  const [appearance, setAppearance] = useState<VaultAppearance>(
    DEFAULT_VAULT_APPEARANCE,
  );
  const [location, setLocation] = useState<VaultCreateLocation | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const nameInputRef = useRef<HTMLInputElement | null>(null);
  const chooseLocationRef = useRef<HTMLButtonElement | null>(null);
  const activeRef = useRef(true);
  const closeRef = useRef<DialogHandle | null>(null);
  const dialogRef = useAboveKeyboard<HTMLElement>();

  useLayoutEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  useLayoutEffect(() => {
    const coarse =
      typeof window.matchMedia === 'function' &&
      (window.matchMedia('(pointer: coarse)').matches ||
        window.matchMedia('(any-pointer: coarse)').matches);
    (coarse ? chooseLocationRef.current : nameInputRef.current)?.focus({
      preventScroll: true,
    });
  }, []);

  const canCreate = !busy && location !== null && name.trim().length > 0;

  // Global viewport overlays must not live below `#app`: the iOS WebKit
  // pan guard may transform the app root, which would make a fixed modal use
  // that transformed root as its containing block. Portal to body so the
  // backdrop remains viewport-fixed; the card itself FLIP-glides with the
  // keyboard via useAboveKeyboard.
  return (
    <Dialog open closeRef={(handle) => {
      closeRef.current = handle;
      if (typeof externalCloseRef === 'function') externalCloseRef(handle);
      else if (externalCloseRef) externalCloseRef.current = handle;
    }} dismissible={!busy}
      className={styles['vault-modal-backdrop']}
      data-testid="create-vault-modal-backdrop"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <Dialog.Content unstyled
        ref={dialogRef}
        className={styles['vault-modal']}
        aria-labelledby="create-vault-title"
        data-testid="create-vault-modal"
      >
        <DialogHeader>
          <h2 id="create-vault-title" data-testid="create-vault-modal-title">
            Create a new vault
          </h2>
        </DialogHeader>
        <DialogBody>
          <p
            className={styles['vault-modal-description']}
            data-testid="create-vault-modal-description"
          >
            Choose a name, icon, and where to create the vault folder.
          </p>

          <label className={styles['vault-field']}>
            <span>Vault name</span>
            <input
              ref={nameInputRef}
              type="text"
              placeholder="My Vault"
              maxLength={120}
              autoComplete="off"
              data-testid="create-vault-name-input"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>

          <VaultAppearancePicker
            value={appearance}
            onChange={setAppearance}
            disabled={busy}
          />
          <div className={styles['vault-field']}>
            <span>Location</span>
            <div className={styles['vault-location-row']}>
              <div
                className={`${styles['vault-location-value']}${location === null ? ` ${styles.empty}` : ''}`}
                data-testid="create-vault-location-value"
              >
                {location === null ? 'No location selected' : location.label}
              </div>
              <Button
                ref={chooseLocationRef}
                type="button"
                data-testid="choose-vault-location-button"
                onClick={() => {
                  void vaults
                    .chooseCreateLocation()
                    .then((selection) => {
                      if (!activeRef.current) return;
                      if (selection === null) {
                        setError('No location was selected.');
                        return;
                      }
                      setLocation(selection);
                      setError('');
                    })
                    .catch((err: unknown) => {
                      if (!activeRef.current) return;
                      setError(`Could not choose location: ${String(err)}`);
                    });
                }}
              >
                Choose location
              </Button>
            </div>
          </div>

          <div
            className={styles['vault-modal-error']}
            data-testid="create-vault-error"
          >
            {error}
          </div>

          <div className={styles['vault-modal-actions']}>
            <Button
              type="button"
              data-testid="cancel-create-vault-button"
              disabled={busy}
              onClick={() => closeRef.current?.close()}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="primary"
              data-testid="confirm-create-vault-button"
              disabled={!canCreate}
              onClick={() => {
                if (location === null || !name.trim() || busy) return;
                setBusy(true);
                setError('');
                void location
                  .create(name.trim(), appearance)
                  .then((created) => {
                    if (!activeRef.current) return;
                    if (created === null) {
                      setBusy(false);
                      return;
                    }
                    closeRef.current?.close(() => onCreated(created));
                  })
                  .catch((err: unknown) => {
                    if (!activeRef.current) return;
                    setBusy(false);
                    setError(`Could not create vault: ${String(err)}`);
                  });
              }}
            >
              Create vault
            </Button>
          </div>
        </DialogBody>
      </Dialog.Content>
    </Dialog>
  );
}

// hmr-probe
