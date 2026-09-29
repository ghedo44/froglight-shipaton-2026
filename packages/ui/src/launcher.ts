/**
 * Vault launcher contracts. Hosts only see `VaultHostAdapter`; the launcher
 * surface itself lives behind the shared mount and is framework-owned.
 */

/** One host-backed vault that can be activated into the shared application. */
export interface VaultChoice {
  readonly id: string;
  readonly name: string;
  readonly location: string;
  readonly lastOpenedAt?: number;
  readonly profileError?: string;
  readonly profile?: import('@froglight/foundation').VaultProfile;
  activate(): Promise<void>;
}

/** Opaque host-selected parent location used by the create-vault modal. */
export interface VaultCreateLocation {
  readonly label: string;
  create(
    name: string,
    appearance?: import('@froglight/foundation').VaultAppearance,
  ): Promise<VaultChoice | null>;
}

/** Host-only capabilities. No browser/Tauri/path object crosses this boundary. */
export interface VaultHostAdapter {
  listRecent(): Promise<readonly VaultChoice[]>;
  /** Open a remembered vault for read-only backup without activating a workspace. */
  openForBackup(
    id: string,
  ): Promise<import('@froglight/foundation').VaultService>;
  chooseCreateLocation(): Promise<VaultCreateLocation | null>;
  openVault(): Promise<VaultChoice | null>;
  forgetVault(id: string): Promise<void>;
  /**
   * Empty backing store for Download & Open first materialization
   * (optional). Creates a fresh empty vault location WITHOUT opening a
   * workspace inside it, so the cloud replica can be downloaded and
   * verified before the resulting local vault is presented as opened.
   * Returns null when the user cancels the destination choice. Hosts
   * without this capability use the legacy create-then-bind flow.
   */
  createEmptyVaultStore?(name: string): Promise<EmptyVaultStore | null>;
}

/**
 * Staging store for Download & Open first materialization (transactional).
 * `vault` is the raw local backing service the sync engine fills verbatim;
 * `activate` opens the materialized store as an ordinary local vault
 * (workspace, sessions, and all) and returns its launcher choice.
 *
 * Lifecycle (ownership-safe):
 *
 * ```text
 * STAGING --prepare/activation failure or cancel--> discard staging
 * STAGING --activate() ok--> OPENED (user vault, ownership transferred)
 * OPENED --finalize ok--> COMMITTED (synced)
 * OPENED --finalize fail--> OPENED LOCAL VAULT (unbound, never deleted)
 * ```
 *
 * `discard` may destroy ONLY a resource this transaction exclusively
 * created and still owns (STAGING). After successful `activate()` it must
 * be non-destructive (no-op); after `discard()` it is an idempotent
 * no-op; it never throws to hide the primary error and never deletes
 * user-created data. Hosts without safe deletion implement it as
 * forget-from-recents. The object is a staging target first and a user
 * vault after activation (a future rename to `VaultStagingStore` is
 * optional; the lifecycle above is what matters).
 */
export interface EmptyVaultStore {
  readonly id: string;
  readonly vault: import('@froglight/foundation').VaultService;
  activate(): Promise<VaultChoice | null>;
  discard(): Promise<void>;
}
