/**
 * Vault sync protocol contracts.
 *
 * Froglight owns the synchronization protocol; Firebase is only the
 * initial backend provider. These types are provider-neutral:
 * manifests carry no Firebase semantics, blobs are content-addressed by
 * SHA-256, and the remote control plane is abstracted behind `SyncRemote`
 *  so the merge engine never touches Firestore/Storage APIs.
 *
 * ```text
 * Firestore: vault metadata + remote HEAD pointer (control plane)
 * Storage:   immutable manifests + content-addressed blobs (data plane)
 * ```
 */

import type { WorkspacePath } from '../paths.js';
import { VaultSyncError } from './errors.js';

/** Sync protocol version. Unknown versions are rejected, never guessed. */
export const SYNC_PROTOCOL_VERSION = 1;

/** Canonical manifest format discriminator. */
export const SYNC_MANIFEST_FORMAT = 'froglight.sync-manifest';

/** Content hash reference: `sha256:<64 lowercase hex>`. */
export type BlobRef = string;

/** Manifest hash reference: `sha256:<64 lowercase hex>`. */
export type ManifestHash = string;

/** One synced resource: a file (content-addressed) or a directory. */
export interface SyncManifestEntry {
  /** Workspace-relative path (`Notes/physics.md`); never root, never `..`. */
  readonly path: string;
  readonly kind: 'file' | 'directory';
  /** Content address for files; absent for directories. */
  readonly blob?: BlobRef;
  /** Byte size for files; absent for directories. */
  readonly size?: number;
}

/**
 * Versioned, immutable sync manifest. Deterministic: entries
 * are ordered by path, so identical vault states hash identically.
 */
export interface SyncManifest {
  readonly format: typeof SYNC_MANIFEST_FORMAT;
  readonly version: typeof SYNC_PROTOCOL_VERSION;
  /** Cloud vault identity (strong random UUID, never a local vault id). */
  readonly vaultId: string;
  /** Monotonic remote revision; local-only scans use the base revision. */
  readonly revision: number;
  /** Hash of the parent manifest, or null for revision 1. */
  readonly parentHash: ManifestHash | null;
  readonly entries: readonly SyncManifestEntry[];
}

/**
 * Remote HEAD document (`users/{uid}/vaults/{cloudVaultId}`).
 * Small by construction: metadata plus a pointer at the immutable
 * manifest. The manifest itself is never stored in this document.
 */
export interface RemoteHead {
  readonly protocolVersion: number;
  readonly name: string;
  readonly revision: number;
  readonly manifestHash: ManifestHash;
  /** Provider-visible manifest object path (bucket-relative). */
  readonly manifestObject: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly updatedByDeviceId: string;
}

/** Fields the committer supplies; timestamps are backend-issued. */
export interface RemoteHeadInput {
  readonly name: string;
  readonly revision: number;
  readonly manifestHash: ManifestHash;
  readonly manifestObject: string;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly updatedByDeviceId: string;
}

/** Expected HEAD for compare-and-swap; null creates the vault entry. */
export interface ExpectedHead {
  readonly revision: number;
  readonly manifestHash: ManifestHash;
}

/** Cloud vault listing row for remote discovery.*/
export interface RemoteVaultInfo {
  readonly profile?: import('../vault/profile.js').VaultProfile;
  readonly cloudVaultId: string;
  readonly name: string;
  readonly revision: number;
  readonly updatedAt: string | null;
}

/**
 * Local replica binding: device/replica metadata, never canonical vault
 * content. Persisted by the sync service;
 * the engine consumes and returns it without owning storage.
 */
export interface SyncBinding {
  readonly cloudVaultId: string;
  readonly baseRevision: number;
  readonly baseManifestHash: string | null;
  readonly deviceId: string;
}

/**
 * Last synchronized manifest known by this replica. Reconciliation
 * reconstructs all pending work from `base + local scan + remote HEAD`
 * after restart — no opaque offline mutation queue.
 */
export interface SyncBase {
  readonly manifest: SyncManifest;
  readonly hash: ManifestHash;
}

/**
 * Remote provider abstraction. Merge logic depends only on
 * this contract; Firebase implements it in the provider, while tests use
 * the memory remote. All methods reject with `VaultSyncError` on failure; a lost
 * HEAD race rejects with code `REMOTE_CHANGED` so the engine can reload
 * and retry instead of overwriting newer state.
 *
 * Immutability contract: blobs and manifests are
 * content-addressed and immutable. `uploadBlob(hash, bytes)` must never
 * store bytes that do not hash to `hash` — providers verify and reject
 * with `HASH_MISMATCH`/`CORRUPT_MANIFEST`. A repeat upload of the same
 * hash with byte-identical content is idempotent success (production
 * Storage denies the second create as permission-denied; the provider
 * verifies the existing object and maps the safe duplicate to success
 * instead of an entitlement failure). A repeat with different bytes is
 * corruption, never silently accepted.
 */
export interface SyncRemote {
  listVaults(): Promise<readonly RemoteVaultInfo[]>;
  readHead(vaultId: string): Promise<RemoteHead | null>;
  loadManifest(
    vaultId: string,
    manifestHash: ManifestHash,
    manifestObject: string,
  ): Promise<SyncManifest>;
  hasBlob(vaultId: string, blob: BlobRef): Promise<boolean>;
  uploadBlob(vaultId: string, blob: BlobRef, bytes: Uint8Array): Promise<void>;
  downloadBlob(vaultId: string, blob: BlobRef): Promise<Uint8Array>;
  uploadManifest(
    vaultId: string,
    manifest: SyncManifest,
  ): Promise<{ hash: ManifestHash; object: string }>;
  compareAndSwapHead(
    vaultId: string,
    expected: ExpectedHead | null,
    next: RemoteHeadInput,
  ): Promise<RemoteHead>;
  /**
   * Notify on remote HEAD changes (control-plane listener).
   * Returns an unregister function; implementations must not create one
   * listener per file.
   *
   * Subscription-owned errors: `onError` receives failures for THIS
   * subscription only (network loss, revoked access). Providers must
   * invoke the callback supplied for that specific `watchHead()`
   * subscription — never a host-global error hook — so a queued error
   * from vault A can never be published into vault B. Callers capture
   * replica ownership at subscribe time and discard stale callbacks
   * without logging an error, refreshing entitlements, or emitting state.
   */
  watchHead(
    vaultId: string,
    onHead: (head: RemoteHead | null) => void,
    onError?: (error: unknown) => void,
  ): () => void;
  /**
   * Optional identity-scoped view: a remote bound to one immutable owner
   * for a whole multi-call reconcile. Providers with account-partitioned
   * remote namespaces (Firebase `users/{uid}/…`, and any future backend
   * that partitions by account) MUST implement this when the service
   * relies on identity-stable reconciliation: the service captures
   * `forUid(uid)` once at cycle/prepare start and uses the scoped view
   * for every subsequent call, so later calls can never address a new
   * sign-in's namespace even if the live account switches mid-cycle.
   *
   * A generic outer guard (`createIdentityPinnedRemote`) can only check
   * identity BEFORE delegating to one provider method; it cannot prevent
   * an arbitrary provider from re-reading live identity AFTER an await
   * inside that method. Only an immutable scoped view closes that hole,
   * so the wrapper's guard is defense-in-depth (stale-cycle abort), not
   * a substitute for scoping. Production Firebase implements `forUid`;
   * non-partitioned doubles (memory remote in tests) may omit it.
   */
  forUid?(uid: string): SyncRemote;
}

/**
 * Identity-bound prepared Download & Open transaction (identity-generation
 * fix).
 *
 * `materializeRemoteVault()` returns this opaque handle instead of a naked
 * `SyncBase` so `finalizePreparedRemoteVault()` can prove
 * `prepare identity === finalize identity`. Callers must treat it as
 * opaque: do not synthesize one by hand (the `kind` brand exists to catch
 * accidental construction); obtain it only from `materializeRemoteVault`
 * and pass it back to finalization after successful activation.
 *
 * Ownership is authentication identity only (`uid + identityGeneration`):
 * ordinary vault activation intentionally performs runtime vault
 * replacement (sync detach/attach, provider replacement, workspace
 * recreation), which bumps operation/vault generations — so
 * `operationGeneration` MUST NOT be used here, otherwise a successful
 * Download & Open activation invalidates its own prepared transaction.
 * An account change (including sign-out/sign-in back as the same UID,
 * which starts a new authentication epoch) invalidates the token.
 *
 * Finalization is local-only: `name`/`base` were verified at prepare time,
 * so no network HEAD re-read is needed (or performed).
 */
export interface PreparedRemoteVault {
  readonly kind: 'prepared-remote-vault';
  readonly cloudVaultId: string;
  readonly localVaultId: string;
  /** Verified remote display name captured at prepare time. */
  readonly name: string;
  /** Verified base exactly describing the bytes in the staging target. */
  readonly base: SyncBase;
  readonly owner: {
    /** UID that prepared the download. */
    readonly uid: string;
    /**
     * Authentication epoch captured at prepare time. Incremented only on
     * auth identity discontinuity (UID change, sign-out, ordered
     * sign-out invalidation, disposal) — never on attach/detach,
     * vault/provider/binding replacement, enable/disable, or ordinary
     * reconcile invalidation.
     */
    readonly identityGeneration: number;
  };
}

/** Narrow `VaultSyncError` guard for HEAD contention retries. */
export function isRemoteChanged(error: unknown): boolean {
  return error instanceof VaultSyncError && error.code === 'REMOTE_CHANGED';
}

export type VaultSyncPhase =
  | 'idle'
  | 'scanning'
  | 'uploading'
  | 'downloading'
  | 'merging'
  | 'waiting-for-entitlement'
  | 'error';

/** The synced vault as the UI and hosts see it. Device metadata stays out. */
export interface VaultSyncBindingView {
  /** Whether this remembered replica is enabled, including parked vaults. */
  readonly enabled: boolean;
  readonly cloudVaultId: string;
  readonly localVaultId: string;
  readonly name: string;
  /**
   * True when this replica's persisted merge base is corrupt and cloud
   * reconciliation is parked. Display/decision
   * only: the host can offer `repairCorruptBinding()` and, when the
   * cloud copy has advanced, re-materialize by downloading the cloud
   * vault again (which replaces the corrupt binding only after
   * activation succeeds).
   */
  readonly baseCorrupt?: boolean;
}

/**
 * Durable user-facing record of one conflict preserved by reconciliation.
 * The referenced vault bytes remain authoritative; acknowledging this record
 * only clears the notice and never removes either conflict copy.
 */
export interface VaultSyncConflictSummary {
  /** Stable within the binding, derived from the preserved conflict path. */
  readonly id: string;
  readonly path: string;
  readonly kind: 'edit-edit' | 'delete-edit' | 'edit-delete' | 'file-directory';
  readonly conflictPath: string | null;
  readonly kept: 'local' | 'remote';
  readonly detectedAt: string;
  /** Set after Froglight has read and offered the exact preserved bytes. */
  readonly recoveredAt: string | null;
}

/** Exact bounded bytes prepared for an explicit conflict-copy download. */
export interface VaultSyncConflictRecovery {
  readonly conflictId: string;
  readonly fileName: string;
  readonly bytes: Uint8Array;
}

export interface VaultSyncSnapshot {
  readonly enabled: boolean;
  readonly phase: VaultSyncPhase;
  readonly binding: VaultSyncBindingView | null;
  /** Every remembered binding for the current account (active + parked). */
  readonly bindings: readonly VaultSyncBindingView[];
  /**
   * The vault the host currently shows as active (launcher selection),
   * or null when no vault is open or the host does not report it. When
   * set and different from `binding.localVaultId`, the service parks:
   * no reconciles run for the non-visible vault (never deletes;
   * parking never unlinks). Hosts report it via
   * `setActiveLocalVault()`; the settings/launcher UI compares the two.
   */
  readonly activeLocalVaultId: string | null;
  /**
   * Mutations observed since the last successful reconcile. UI telemetry
   * only — not an authoritative queue length. Multiple mutations
   * coalesce into one reconcile, mid-run saves are recounted by the
   * automatic rerun, failures/deferrals/sign-out/vault-switch park or
   * reset it, and background remote-only reconciles do not touch it.
   * Never interpret a stale count as unsynced changes from another
   * account/vault: account/vault switches reset it to zero. Converges
   * to zero with the work, never negative.
   */
  readonly pendingChanges: number;
  readonly lastSyncedAt: string | null;
  readonly lastRevision: number | null;
  /** Paths held back by dirty-session deferral in the last reconcile. */
  readonly deferredPaths: readonly string[];
  /** Unacknowledged conflicts for this snapshot's account and binding only. */
  readonly conflicts: readonly VaultSyncConflictSummary[];
  readonly error: VaultSyncError | null;
}

export type VaultSyncSnapshotListener = (snapshot: VaultSyncSnapshot) => void;

export interface VaultSyncEnableInput {
  /** Opaque host handle for the local vault. Never a path or email. */
  readonly localVaultId: string;
  readonly name: string;
}

/**
 * Dirty-session seam. It fails closed by deferring paths unless cleanliness
 * can be proven. The
 * service asks per file path whether an open session holds unsaved edits;
 * deferred paths keep their vault bytes and their base entries until
 * clean. No commit callback is needed: the session's save is itself a
 * vault mutation, so the feed retriggers the reconcile; closing without
 * saving needs no trigger at all (vault and base already agree). Must be
 * pure and total (never throws — fail closed by returning true).
 *
 * Fail-closed rule: `isDirty` returns false only when it can prove clean.
 * No workspace → false. Workspace exists but a required lookup
 * unexpectedly fails → true (defer; failure to prove clean is not
 * permission to overwrite canonical bytes beneath a potentially dirty
 * session).
 *
 * Production workbench-backed trackers are not wired yet; hosts can use
 * `ManualDirtyTracker`.
 */
export interface SyncDirtyTracker {
  isDirty(path: WorkspacePath): boolean;
}

/**
 * Local paths materialized from the remote during a reconcile, split for
 * the workspace/session seam. Only clean-applied paths appear here:
 * dirty-deferred paths keep their vault bytes and never enter this set.
 */
export interface SyncAppliedNotification {
  /** Sorted vault-relative paths created or updated from remote bytes. */
  readonly written: readonly string[];
  /** Sorted vault-relative paths removed to match the merged state. */
  readonly removed: readonly string[];
}

/**
 * Workspace/session reconciliation seam (remote-apply → application
 * state; fail-closed hardening). Foundation sync owns vault bytes and the
 * base; the host owns open sessions, workspace registries, and derived
 * indexes. After the engine materializes remote bytes, the service invokes
 * this seam BEFORE persisting the advanced base, so a stale clean editor
 * can never survive behind downloaded bytes and later overwrite them:
 *
 * - dirty sessions are never touched here (they were deferred, not
 *   applied — their save retriggers through the mutation feed);
 * - clean open sessions over `written` paths must be reloaded (or
 *   invalidated/reopened) before the base advances;
 * - workspace registries and search/index state must eventually reflect
 *   the applied paths (reload, close removed documents, rebuild).
 *
 * Fail-closed: any failure required to prove session coherence MUST
 * propagate (reject) — getWorkspace throw, reloadFromVault failure,
 * findByResourcePath failure for an affected path, getOpenDocument
 * failure, clean reload failure, clean close failure. The service keeps
 * the per-replica pending retry and the base/checkpoint does not advance.
 * Only rebuildable derived state (search index, secondary caches,
 * previews) may stay best-effort inside the implementation.
 *
 * Sync never imports React/UI concepts and never depends on application
 * implementation details: this semantic callback is the only coupling.
 * A throwing reconciler blocks the base advance (the next reconcile
 * retries idempotently); a null reconciler means the host manages
 * sessions itself and the base advances immediately.
 */
export interface SyncWorkspaceReconciler {
  handleRemoteApplied(
    notification: SyncAppliedNotification,
  ): Promise<void> | void;
}

/**
 * Persisted sync state: device/replica metadata, never canonical vault
 * content. Lives outside the vault in host storage —
 * seeding it from vault content would leak replica metadata across
 * devices on the next sync.
 *
 * Account scoping (UID-partitioned): every binding lives under the
 * owning Firebase UID that created it. The remote path itself resolves
 * as `users/{currentUid}/vaults/{cloudVaultId}`, so interpreting UID A's
 * binding under UID B would address a different (or nonexistent) cloud
 * vault. The map key is the binding owner; sign-out parks (never
 * deletes) and sign-in restores only that UID's bindings.
 */
export interface VaultSyncBinding {
  readonly cloudVaultId: string;
  readonly localVaultId: string;
  readonly name: string;
  readonly deviceId: string;
  readonly base: SyncBase | null;
  readonly lastSyncedAt: string | null;
  readonly lastRevision: number | null;
  /** False after `disable()`; the binding is remembered but parked. */
  readonly enabled: boolean;
  /** Preserved until explicit recovery and acknowledgement by the user. */
  readonly conflicts?: readonly VaultSyncConflictSummary[];
  /**
   * Persisted base failed structural validation (or the raw marker was
   * loaded). The binding is preserved — the local vault MUST NOT be
   * treated as a brand-new replica — but cloud reconciliation parks with
   * `CORRUPT_SYNC_METADATA` until the base is rebuilt from verified
   * remote state. Never set from a verified base; never silently cleared.
   */
  readonly baseCorrupt?: boolean;
}

/** One account's replica bindings, keyed by local vault id. */
export interface AccountSyncState {
  readonly bindings: Readonly<Record<string, VaultSyncBinding>>;
  /** Last active local vault for this account (host selection memory). */
  readonly activeLocalVaultId: string | null;
}

export interface StoredSyncState {
  readonly version: 1;
  readonly deviceId: string;
  readonly accounts: Readonly<Record<string, AccountSyncState>>;
}

/**
 * Host storage for sync metadata (web persistence on web, app storage
 * on native, memory in tests). Corrupt or unreadable state must degrade
 * to a fresh start, never brick local use — the service validates on
 * load.
 */
export interface VaultSyncStorage {
  load(): Promise<StoredSyncState | null>;
  save(state: StoredSyncState): Promise<void>;
  clear(): Promise<void>;
}

/**
 * Stable sync service behind `vaultSyncToken` (`froglight.vault-sync`,
 * Observes the attached local vault replica and reconciles
 * its UID-scoped binding with that binding's cloud vault (one account
 * may remember several bindings while only the visible vault's runs);
 * ordinary local saves never wait for it.
 * Cloud work requires a signed-in account (`NOT_AUTHENTICATED`
 * otherwise); Pro gating beyond that is UI flow (paywall) plus backend
 * Rules enforcement — the service never trusts client entitlement state
 * for authorization. The service also supports an explicit
 * `waiting-for-entitlement` phase: a Rules denial while the client
 * reports Pro but the trusted server claim is still missing surfaces as
 * `ENTITLEMENT_PENDING` (activating), never as a purchase failure.
 */
/**
 * Atomic local replica descriptor. The physical
 * observable vault and its host local-vault identity always enter the
 * sync service together; the service NEVER infers the attached identity
 * from the remembered selection, the number of bindings, previous active
 * vaults, UI state, or fallback heuristics. A vault alone is not a
 * syncable replica.
 */
export interface VaultSyncAttachInput {
  /** Opaque host handle for the local vault. Never a path or email. */
  readonly localVaultId: string;
  /** The shared observable facade for that same local vault. */
  readonly vault: import('./mutations.js').ObservableVaultService;
}

export interface VaultSyncService {
  snapshot(): VaultSyncSnapshot;
  /** Subscribe to every snapshot change; returns an unregister function. */
  subscribe(listener: VaultSyncSnapshotListener): () => void;
  /**
   * Load persisted binding/base and reattach. Safe to call once at boot;
   * later calls are no-ops. Never throws for storage problems (degrades
   * to a fresh disabled service so local use always survives).
   */
  restore(): Promise<void>;
  /**
   * Attach the current local replica atomically as `(localVaultId, vault)`.
   * The identity is authoritative for every protocol decision: sync runs
   * only when a binding exists for EXACTLY this local vault id and is
   * enabled; otherwise it parks. Re-attaching replaces the replica
   * (identity + vault together) and rewires only when the new id is
   * bound; listeners never survive a replica change.
   */
  attach(input: VaultSyncAttachInput): void;
  /**
   * Detach the current replica. Binding, base, and enabled state persist;
   * no replica remains attached and cloud work parks.
   */
  detach(): void;
  /** Cloud vaults visible to the signed-in account (remote discovery). */
  listRemoteVaults(): Promise<readonly RemoteVaultInfo[]>;
  /**
   * Bind a local vault for sync. Resolves locally (persists, attaches,
   * schedules) without awaiting network, so enabling while offline
   * works; the first reconcile runs in the background and any failure
   * lands in the snapshot. Resumes the existing binding for the same
   * local vault; a different local vault starts a fresh cloud identity
   * (the previous cloud vault is left intact, never deleted).
   */
  enable(input: VaultSyncEnableInput): Promise<void>;
  /**
   * Stop syncing this replica. Listeners detach and the cloud is left
   * untouched; binding and base persist so re-enabling
   * resumes incrementally. Cancels any in-flight entitlement wait.
   */
  disable(): Promise<void>;
  /** Run one reconcile now (manual "Sync now"); serialized with auto runs. */
  reconcile(): Promise<void>;
  /**
   * Read one preserved conflict copy from the currently attached replica.
   * The read is size-bounded and returns the exact vault bytes. Success
   * durably records that recovery was offered; it never edits or removes the
   * conflict file.
   */
  prepareConflictRecovery(
    conflictId: string,
  ): Promise<VaultSyncConflictRecovery>;
  /**
   * Clear a conflict notice deliberately without deleting its preserved
   * vault copy. Hidden property-sidecar copies refuse acknowledgement until
   * the exact-byte recovery action has succeeded; visible conflicts can be
   * recovered directly through the Files view.
   */
  acknowledgeConflict(conflictId: string): Promise<void>;
  /**
   * Bind an existing cloud vault (download-and-open flow): verifies the
   * HEAD exists, adopts its name, and pulls on the next reconcile.
   * Refuses when the cloud vault is already bound to a different local
   * vault under the current account (`CONFLICT`) instead of creating a
   * duplicate replica.
   */
  attachRemoteVault(cloudVaultId: string, localVaultId: string): Promise<void>;
  /**
   * First-materialization flow for Download & Open (transactional):
   * verifies the HEAD, downloads and hash-verifies every byte into
   * `target` (a fresh empty backing store the caller created), and
   * returns an identity-bound prepared transaction WITHOUT persisting
   * any binding. The caller must `activate()` the store as an ordinary
   * local vault and only then call `finalizePreparedRemoteVault()` with
   * the prepared handle to persist the binding. The initial download
   * materializes the remote manifest directly — never a three-way merge
   * against initialized workspace metadata — and any failure (including
   * a corrupt blob) binds nothing. Resolves only when remote bytes
   * exist verified in the target.
   */
  materializeRemoteVault(
    cloudVaultId: string,
    localVaultId: string,
    target: import('../vault/contract.js').VaultService,
  ): Promise<PreparedRemoteVault>;
  /**
   * Finalize a prepared Download & Open after the host has successfully
   * activated the materialized store. Local-only: validates that the
   * current UID/generation still equal the prepared owner identity and
   * then persists the binding transactionally (copy-on-write: no live
   * mutation before durable save succeeds). Any identity mismatch throws
   * `ACCOUNT_CHANGED` with zero binding mutation. No network read is
   * performed — `name`/`base` come from the prepared transaction.
   * Must only be called after `activate()` resolved; activation failure,
   * cancellation, or a failed temporary store (discarded via
   * `EmptyVaultStore.discard()`) must never reach this method, so no
   * binding can exist for an unusable vault. Duplicate cloud/local
   * bindings are `CONFLICT`.
   */
  finalizeMaterializedVault(prepared: PreparedRemoteVault): Promise<void>;
  /**
   * Explicit recovery from a corrupt persisted merge base. Conservative
   * verified-ancestor reconstruction: verifies
   * the current remote HEAD/manifest cryptographically and rebuilds the
   * binding's base ONLY when the remote is still at the last revision
   * this replica synchronized to (which proves the verified remote
   * manifest is the ancestor the local bytes were materialized from).
   * Then clears `baseCorrupt` and resumes normal reconciliation.
   *
   * When the cloud copy has advanced, or no synchronized revision is
   * known, the operation refuses with `REMATERIALIZE_REQUIRED`: silently
   * adopting a newer remote manifest as the ancestor (or degrading to
   * `base: null` first-sync behavior) could misclassify or delete remote
   * content. In that case the safe recovery is Download & Open into a
   * fresh local store. Local files are never modified by repair, a failed
   * durable save mutates nothing, and an account-epoch change rejects
   * with `ACCOUNT_CHANGED` and installs nothing.
   */
  repairCorruptBinding(): Promise<void>;
  /** True when the cloud vault is already bound under the current account. */
  isCloudVaultBound(cloudVaultId: string): boolean;
  /**
   * Claim-propagation gate: force-refresh the ID
   * token with bounded backoff until the trusted server `pro` claim
   * appears, then return true. Throws `NOT_AUTHENTICATED` when signed
   * out, `PRO_REQUIRED` when the client is not Pro (needs the paywall),
   * and `ENTITLEMENT_PENDING` when the claim never arrives within the
   * bound (still activating — backend writes stay denied by design).
   * The snapshot reports `waiting-for-entitlement` while waiting.
   */
  ensureProEntitlement(): Promise<boolean>;
  /**
   * Report which local vault the host currently shows as active (the
   * launcher selection), or null when no vault is open. Presentation
   * metadata only: it feeds the snapshot and
   * selection persistence and NEVER selects the physical replica sync
   * operates on. The runtime attachment (`attach({ localVaultId, vault })`)
   * owns that truth. Parking never unlinks or deletes.
   */
  setActiveLocalVault(localVaultId: string | null): void;
  /**
   * Ordered sign-out teardown (coordinator hook): stop
   * scheduling new cloud work and cancel entitlement waits while keeping
   * the vault reference, binding, and base. The next sign-in re-wires
   * through the account listener; local vaults are untouched.
   */
  suspend(): void;
  /**
   * Ordered sign-out barrier: invalidate the active
   * reconcile generation, detach mutation + HEAD listeners, then wait
   * (bounded) until the in-flight cycle can no longer perform remote
   * side effects before the coordinator clears purchase identity and
   * signs out of Firebase. A stale cycle finishing after sign-out may
   * clean up local internal state but must never write under the wrong
   * UID, resurrect listeners, advance another account's binding, or
   * overwrite newer state. Cleanup failures are best-effort and never
   * hide the primary sign-out error.
   */
  prepareForSignOut(): Promise<void>;
}
