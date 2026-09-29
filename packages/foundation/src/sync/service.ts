/**
 * Vault sync service.
 *
 * `VaultSyncStore` orchestrates one local vault replica against its
 * cloud vault: it observes committed mutations through an
 * `ObservableVaultService`, coalesces them through a single-flight
 * `SyncScheduler`, drives the crash-safe engine, and persists the
 * binding plus base so restarts reconstruct pending work.
 *
 *  adds Pro authorization handling (§61):
 * backend writes succeed only under the trusted server-issued
 * `revenueCatEntitlements` claim — client `PurchaseService` state gates
 * UI only and never authorizes the cloud. A Rules denial while the
 * client reports Pro but the server claim is still missing enters the
 * explicit `waiting-for-entitlement` phase (never a scary purchase
 * error); `ensureProEntitlement()` force-refreshes the ID token with
 * bounded backoff until the claim propagates, then sync begins.
 *
 * Load-bearing invariants:
 *
 * - Local saves never wait for the cloud: the service only observes
 *   committed writes and reads through the vault; no write path awaits
 *  network.
 * - Remote apply cannot echo: the engine runs against the observable's
 *   `silent` view, so downloaded bytes never emit mutation events. The
 *   coarser `suppress()` would also silence concurrent user saves and
 *   strand them until the next trigger — the silent view scopes silence
 *   to engine-originated calls only.
 * - Dirty sessions are never clobbered: deferred paths keep vault bytes
 *   and base entries (engine `defer`); the session's own save retriggers
 *   through the feed, and closing without saving needs no trigger at
 *  all.
 * - Sign-out detaches cloud listening but unlinks nothing: bindings and
 *   bases persist per UID; failsafe converges on the next sign-in
 *
 * - Sync metadata is UID-scoped and multi-binding: one account holds one
 *   binding per local vault, and UID A's bindings are never interpreted
 *   under UID B. Opening a vault activates its binding; switching parks
 *   the previous one without forgetting it.
 * - Remote-apply → workspace reconciliation runs before the base
 *   advances: clean open sessions are reloaded through the host-provided
 *   `SyncWorkspaceReconciler` seam so stale editors can never silently
 *   overwrite downloaded bytes. Dirty sessions stay deferred and
 *   untouched.
 */

import {
  reconcileVault,
  verifyBlob,
  type SyncProgressStage,
} from './engine.js';
import { VaultSyncError, normalizeSyncError } from './errors.js';
import { isDefaultExcludedSyncPath } from './exclude.js';
import { VAULT_PROFILE_PATH, decodeVaultProfile } from '../vault/profile.js';
import {
  hashBytes,
  hashManifest,
  isManifestHash,
  parseSyncManifest,
} from './manifest.js';
import {
  MAX_CONFLICTS_PER_BINDING,
  isSafeNonNegativeInt,
  parseStoredSyncState,
  verifyPersistedSyncBase,
} from './persisted-state.js';
import {
  ObservableVaultService,
  SyncScheduler,
  type VaultMutation,
} from './mutations.js';
import { createLocalScanCache, type LocalScanCache } from './engine.js';
import type { AccountService } from '../account/contract.js';
import { hasServerEntitlement } from '../account/contract.js';
import type { PurchaseService } from '../purchases/contract.js';
import { hasFroglightPro } from '../purchases/contract.js';
import {
  parentPath,
  ROOT_PATH,
  workspacePath,
  type WorkspacePath,
} from '../paths.js';
import type { VaultService } from '../vault/contract.js';
import { ensureDirectory } from '../vault/helpers.js';
import type {
  AccountSyncState,
  PreparedRemoteVault,
  RemoteVaultInfo,
  StoredSyncState,
  SyncAppliedNotification,
  SyncBase,
  SyncDirtyTracker,
  SyncManifest,
  SyncRemote,
  SyncWorkspaceReconciler,
  VaultSyncAttachInput,
  VaultSyncBinding,
  VaultSyncConflictRecovery,
  VaultSyncConflictSummary,
  VaultSyncEnableInput,
  VaultSyncPhase,
  VaultSyncService,
  VaultSyncSnapshot,
  VaultSyncSnapshotListener,
  VaultSyncStorage,
} from './contract.js';
import type { SyncConflict } from './merge.js';

/** Conflict export is deliberately bounded before and after the vault read. */
export const MAX_SYNC_CONFLICT_RECOVERY_BYTES = 8 * 1024 * 1024;

function conflictId(conflict: SyncConflict): string {
  return conflict.conflictPath ?? `${conflict.kind}:${conflict.path}`;
}

function appendConflictSummaries(
  existing: readonly VaultSyncConflictSummary[] | undefined,
  conflicts: readonly SyncConflict[],
  detectedAt: string,
): readonly VaultSyncConflictSummary[] {
  const byId = new Map((existing ?? []).map((entry) => [entry.id, entry]));
  for (const conflict of conflicts) {
    const id = conflictId(conflict);
    if (byId.has(id)) continue;
    byId.set(id, {
      id,
      path: conflict.path,
      kind: conflict.kind,
      conflictPath: conflict.conflictPath,
      kept: conflict.kept,
      detectedAt,
      recoveredAt: null,
    });
  }
  const summaries = [...byId.values()].sort((left, right) =>
    left.detectedAt.localeCompare(right.detectedAt),
  );
  if (summaries.length > MAX_CONFLICTS_PER_BINDING) {
    throw new VaultSyncError(
      'QUOTA_EXCEEDED',
      'too many unresolved sync conflicts; recover and acknowledge existing conflicts before syncing again',
    );
  }
  return summaries;
}

/** Replica key for per-replica pending workspace notifications. */
function replicaKey(
  uid: string,
  localVaultId: string,
  cloudVaultId: string,
): string {
  return JSON.stringify([uid, localVaultId, cloudVaultId]);
}

/** Context-bound pending remote-apply notification. */
interface PendingRemoteApplied {
  readonly uid: string;
  readonly localVaultId: string;
  readonly cloudVaultId: string;
  readonly notification: SyncAppliedNotification;
}

/**
 * The one live-replica eligibility predicate.
 * Protocol work runs only when ALL of these hold: signed in, not
 * suspended, not disposed, a `(localVaultId, vault)` replica is
 * attached, and the binding for EXACTLY that local vault id exists and
 * is enabled. No sole-binding fallback, no remembered-selection
 * fallback, no UI inference.
 */
interface LiveReplicaContext {
  readonly uid: string;
  readonly identityGeneration: number;
  readonly localVaultId: string;
  readonly cloudVaultId: string;
  readonly binding: VaultSyncBinding;
  readonly vault: ObservableVaultService;
}

/**
 * Identity-only ownership token for replica/epoch-owned transient state.
 * Async work that classifies an account-scoped failure (notably
 * `PERMISSION_DENIED` entitlement mapping) captures this before awaiting
 * and revalidates it after every await, so one account's failure can
 * never be classified against another account's Firebase claim or
 * RevenueCat purchase state.
 */
interface IdentityOwner {
  readonly uid: string;
  readonly identityGeneration: number;
}

/**
 * Full replica/presentation ownership token (final async-ownership pass).
 * Durable metadata mutations may legitimately commit for a non-visible
 * vault, but transient presentation (`#phase`, `#error`,
 * `#pendingChanges`, `#lastDeferred`) and listener/watcher lifecycle
 * belong to exactly one attached replica epoch. Capture before awaiting;
 * post-commit runtime effects run only while this still describes the
 * current attachment.
 */
interface ReplicaOwner {
  readonly uid: string;
  readonly identityGeneration: number;
  readonly operationGeneration: number;
  readonly vaultGeneration: number;
  readonly localVaultId: string;
  readonly cloudVaultId: string | null;
  readonly vault: ObservableVaultService | null;
}

/**
 * Mutable draft for one owner-scoped metadata mutation. Built only
 * inside the serialized lane from the current canonical state, so a
 * mutation can never reinstall unrelated state from a stale snapshot.
 */
interface MetadataDraft {
  readonly accounts: Map<string, Map<string, VaultSyncBinding>>;
  readonly accountActive: Map<string, string | null>;
  readonly deviceId: string;
}

interface MetadataCommitOptions<T> {
  /** Diagnostic label (tests/telemetry; never persisted). */
  readonly label: string;
  /** Throws to abort BEFORE any staging/persist (ownership pre-check). */
  readonly validateBefore?: () => void;
  /** Narrow mutation over the fresh draft; may throw (e.g. CONFLICT). */
  readonly mutate: (draft: MetadataDraft) => T;
  /**
   * Post-save lifecycle ownership check. Returning false keeps the
   * staged state OUT of memory (the durable write may already exist and
   * is superseded by the owning transition's own commit).
   */
  readonly validateAfterSave?: () => boolean;
}

interface MetadataCommitResult<T> {
  readonly value: T;
  readonly installed: boolean;
}

/** Validate an opaque prepared Download & Open handle. */
function parsePreparedRemoteVault(value: unknown): PreparedRemoteVault | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.kind !== 'prepared-remote-vault') return null;
  if (
    typeof record.cloudVaultId !== 'string' ||
    record.cloudVaultId.length === 0
  )
    return null;
  if (
    typeof record.localVaultId !== 'string' ||
    record.localVaultId.length === 0
  )
    return null;
  if (typeof record.name !== 'string' || record.name.length === 0) return null;
  if (typeof record.base !== 'object' || record.base === null) return null;
  const owner = record.owner as Record<string, unknown> | null;
  if (typeof owner !== 'object' || owner === null) return null;
  if (typeof owner.uid !== 'string' || owner.uid.length === 0) return null;
  // Identity ownership only: operationGeneration is deliberately NOT
  // accepted here (normal activation bumps it; see VaultSyncStore docs).
  if (!isSafeNonNegativeInt(owner.identityGeneration)) return null;
  return value as PreparedRemoteVault;
}

function randomId(): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } })
    .crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return cryptoObj.randomUUID();
  }
  // Same fallback shape as identity.ts: only for hosts without
  // crypto.randomUUID. Uniqueness across devices still holds in practice
  // (time + entropy); the value is opaque diagnostics, never security.
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Opaque per-device replica identifier (diagnostics only).*/
export function generateDeviceId(): string {
  return `device-${randomId()}`;
}

/** Strong random cloud vault identity (never a local id).*/
export function generateCloudVaultId(): string {
  return randomId();
}

/** In-memory sync metadata. Hosts inject durable storage; tests share one. */
export function createMemorySyncStorage(
  initial: StoredSyncState | null = null,
): VaultSyncStorage {
  let state = initial;
  return {
    async load(): Promise<StoredSyncState | null> {
      return state;
    },
    async save(next: StoredSyncState): Promise<void> {
      state = next;
    },
    async clear(): Promise<void> {
      state = null;
    },
  };
}

/**
 * Explicitly driven dirty tracker for hosts and tests: the workbench
 * marks session paths dirty/clean as editors change, save, and close
 * Production adapters connect this tracker to live sessions.
 */
export class ManualDirtyTracker implements SyncDirtyTracker {
  readonly #dirty = new Set<string>();

  markDirty(path: WorkspacePath): void {
    this.#dirty.add(path);
  }

  markClean(path: WorkspacePath): void {
    this.#dirty.delete(path);
  }

  clear(): void {
    this.#dirty.clear();
  }

  isDirty(path: WorkspacePath): boolean {
    return this.#dirty.has(path);
  }
}

export interface VaultSyncEntitlementOptions {
  /** Bounded claim-propagation retries; defaults to 5.*/
  readonly maxAttempts?: number;
  /** Base backoff delay in ms (exponential: base, 2×base, 4×base…); defaults to 1000. */
  readonly baseDelayMs?: number;
  /**
   * Injectable sleep for deterministic tests. Defaults to the shared
   * global timer (never a direct `setTimeout` reference: foundation
   * ships without DOM/Node libs, same pattern as `SyncSchedulerTimer`).
   */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Outcome of the bounded sign-out drain race. */
export type VaultSyncSignOutDrainOutcome = 'drained' | 'timeout';

/**
 * Injectable sign-out drain timing (lane split). The
 * default waits `drainTimeoutMs` via the shared global timer; tests inject
 * deterministic gates instead of sleeping. `raceTimeout` receives the
 * current durable-metadata chain (already rejection-normalized) and
 * resolves `'drained'` when it settles or `'timeout'` when the bound
 * elapses. The reconcile lane is deliberately never raced or awaited: a
 * hung network call must not hold up sign-out, and stale-epoch reconciles
 * are already inert by generation.
 */
export interface VaultSyncSignOutOptions {
  /** Drain bound in ms; defaults to 5000. */
  readonly drainTimeoutMs?: number;
  readonly raceTimeout?: (
    pending: Promise<void>,
    timeoutMs: number,
  ) => Promise<VaultSyncSignOutDrainOutcome>;
}

export interface VaultSyncServiceOptions {
  readonly remote: SyncRemote;
  readonly account: AccountService;
  readonly storage?: VaultSyncStorage;
  readonly tracker?: SyncDirtyTracker | null;
  /** Scheduler debounce window; defaults to 0.*/
  readonly debounceMs?: number;
  /**
   * Local paths to leave out of the synced set. Defaults to
   * {@link isDefaultExcludedSyncPath} (the in-vault derived index subtree,
   * OS junk, and editor temporaries); other derived search/preview state lives
   * outside the vault and never reaches the engine. Must be identical across
   * replicas.
   */
  readonly exclude?: (path: string) => boolean;
  /**
   * Client purchase state (UI gating only, never backend authorization,
   * When present, a Rules denial while the client reports Pro
   * but the server claim is missing enters `waiting-for-entitlement`
   * instead of a generic error; without it every denial stays
   * `PERMISSION_DENIED`. Null/omitted means client state is unknown.
   */
  readonly purchases?: PurchaseService | null;
  /** Claim-propagation retry tuning for `ensureProEntitlement`. */
  readonly entitlement?: VaultSyncEntitlementOptions;
  /**
   * Remote-apply → workspace/session reconciliation seam. Invoked with
   * clean-applied paths after the engine materializes remote bytes and
   * before the base advances, so open clean sessions reload before stale
   * editor state can overwrite downloaded bytes. Null/omitted means the
   * host manages sessions itself. Never receives dirty-deferred paths.
   */
  readonly reconciler?: SyncWorkspaceReconciler | null;
  /** Bounded sign-out drain timing (see `prepareForSignOut`). */
  readonly signOut?: VaultSyncSignOutOptions;
}

/**
 * Successful reconciles between authoritative full scans (incremental
 * failsafe). The value bounds worst-case drift from coarse file
 * modification times or dropped mutation hints; restarts and binding
 * changes always re-verify from a full scan regardless.
 */
const FULL_SCAN_EVERY = 20;

/** Vault-relative paths touched by one committed mutation. */
function mutationPaths(mutation: VaultMutation): readonly string[] {
  switch (mutation.type) {
    case 'write':
    case 'remove':
    case 'mkdir':
      return [mutation.path as string];
    case 'move':
      return [mutation.from as string, mutation.to as string];
  }
}

function phaseForStage(stage: SyncProgressStage): VaultSyncPhase {
  switch (stage) {
    case 'scan':
      return 'scanning';
    case 'merge':
      return 'merging';
    case 'download':
      return 'downloading';
    case 'upload':
      return 'uploading';
  }
}

type GlobalSleepScope = {
  setTimeout(task: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
};

/** Default entitlement backoff sleep via the shared global timer. */
function defaultEntitlementSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const scope = globalThis as unknown as GlobalSleepScope;
    scope.setTimeout(() => resolve(), ms);
  });
}

/**
 * Default bounded sign-out drain race. Resolves `'drained'` when the
 * current chain settles, `'timeout'` when the bound elapses — whichever
 * comes first. Never awaits the chain after a timeout (that would
 * re-enter the very wait the bound exists to escape).
 */
function defaultSignOutDrainRace(
  pending: Promise<void>,
  timeoutMs: number,
): Promise<VaultSyncSignOutDrainOutcome> {
  return new Promise<VaultSyncSignOutDrainOutcome>((resolve) => {
    const scope = globalThis as unknown as GlobalSleepScope;
    let settled = false;
    const timer = scope.setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve('timeout');
    }, timeoutMs);
    void pending.then(
      () => {
        if (settled) return;
        settled = true;
        scope.clearTimeout(timer);
        resolve('drained');
      },
      () => {
        if (settled) return;
        settled = true;
        scope.clearTimeout(timer);
        resolve('drained');
      },
    );
  });
}

/** Read a stable error code without narrowing to one error taxonomy. */
function errorCodeOf(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = (error as Record<string, unknown>).code;
    if (typeof code === 'string') return code;
  }
  return 'UNKNOWN';
}

/**
 * Identity-stable remote scope.
 *
 * A reconcile captures `uid + generation + binding identity` at cycle
 * start and operates only through this wrapper. Every method first asks
 * `shouldAbort()` (generation bumped by sign-out/account-switch/suspend,
 * UID mismatch, binding replacement); when aborted it throws
 * `ACCOUNT_CHANGED` BEFORE delegating, so no operation from a cycle
 * started under UID A can perform a Firestore/Storage write under UID B
 * — even if `getUid()` now resolves to B. When the underlying remote
 * offers `forUid(uid)` the wrapper prefers that immutable scope for reads
 * and writes; otherwise it guards the shared remote with the same abort
 * check.
 *
 * Explicit limitation: the outer guard alone CANNOT enforce namespace
 * isolation for providers that re-read live identity after an await
 * inside a single method — it only checks before delegating. Providers
 * with account-partitioned remote namespaces MUST implement
 * `forUid(uid)` for identity-stable multi-call reconciliation; the
 * service prefers the immutable scope whenever it exists and keeps the
 * generation abort as defense-in-depth (stale continuation) alongside
 * it. Non-partitioned doubles (memory remote) may omit `forUid`.
 */
export function createIdentityPinnedRemote(
  remote: SyncRemote,
  uid: string,
  shouldAbort: () => boolean,
): SyncRemote {
  const scoped: SyncRemote =
    typeof remote.forUid === 'function' ? remote.forUid(uid) : remote;
  const guard = (): void => {
    if (shouldAbort()) {
      throw new VaultSyncError(
        'ACCOUNT_CHANGED',
        'account identity changed during sync; aborting cycle',
      );
    }
  };
  return {
    async listVaults() {
      guard();
      return scoped.listVaults();
    },
    async readHead(vaultId) {
      guard();
      return scoped.readHead(vaultId);
    },
    async loadManifest(vaultId, hash, object) {
      guard();
      return scoped.loadManifest(vaultId, hash, object);
    },
    async hasBlob(vaultId, blob) {
      guard();
      return scoped.hasBlob(vaultId, blob);
    },
    async uploadBlob(vaultId, blob, bytes) {
      guard();
      return scoped.uploadBlob(vaultId, blob, bytes);
    },
    async downloadBlob(vaultId, blob) {
      guard();
      return scoped.downloadBlob(vaultId, blob);
    },
    async uploadManifest(vaultId, manifest) {
      guard();
      return scoped.uploadManifest(vaultId, manifest);
    },
    async compareAndSwapHead(vaultId, expected, next) {
      guard();
      return scoped.compareAndSwapHead(vaultId, expected, next);
    },
    watchHead(vaultId, onHead, onError?) {
      guard();
      return scoped.watchHead(vaultId, onHead, onError);
    },
    ...(typeof scoped.forUid === 'function'
      ? { forUid: (nextUid: string) => scoped.forUid!(nextUid) }
      : {}),
  };
}

export class VaultSyncStore implements VaultSyncService {
  readonly #remote: SyncRemote;
  readonly #account: AccountService;
  readonly #storage: VaultSyncStorage;
  readonly #tracker: SyncDirtyTracker | null;
  readonly #exclude: (path: string) => boolean;
  readonly #debounceMs: number;
  readonly #purchases: PurchaseService | null;
  readonly #entitlementMaxAttempts: number;
  readonly #entitlementBaseDelayMs: number;
  readonly #entitlementSleep: (ms: number) => Promise<void>;
  readonly #signOutDrainTimeoutMs: number;
  readonly #signOutDrainRace: (
    pending: Promise<void>,
    timeoutMs: number,
  ) => Promise<VaultSyncSignOutDrainOutcome>;
  readonly #listeners = new Set<VaultSyncSnapshotListener>();

  /**
   * The authoritative syncable replica: physical vault AND host local
   * vault identity, always replaced together.
   * Protocol work only ever runs against this pair; there is deliberately
   * no state where a vault is attached but its local identity is unknown.
   */
  #attachedReplica: {
    readonly localVaultId: string;
    readonly vault: ObservableVaultService;
  } | null = null;
  #scheduler: SyncScheduler | null = null;
  #mutationUnsub: (() => void) | null = null;
  #watchUnsub: (() => void) | null = null;
  #accountUnsub: (() => void) | null = null;
  #lastUid: string | null = null;

  #deviceId: string | null = null;
  /** UID-scoped replica bindings: owner UID → (local vault id → binding). */
  #accounts = new Map<string, Map<string, VaultSyncBinding>>();
  /** Last active local vault per account (host selection memory). */
  #accountActive = new Map<string, string | null>();
  /** Currently signed-in UID (mirrors the account snapshot). */
  #currentUid: string | null = null;
  /**
   * Last signed-in UID (never cleared on sign-out). Signed-out snapshots
   * keep showing that account's remembered bindings (display only — no
   * cloud work runs without a live UID), so signing out never looks like
   * an unlink.
   */
  #lastActiveUid: string | null = null;
  /**
   * Host/UI remembered active selection (display + selection persistence
   * only). Precise rule (final async-ownership pass):
   *
   * ```text
   * runtime attachment determines WHICH replica sync belongs to
   *
   * host selection may temporarily PARK sync while composition is
   * inconsistent (`#liveReplicaContext()` returns null when the reported
   * selection disagrees with the attached replica during a host switch)
   *
   * host selection can never redirect vault B into vault A's binding
   * ```
   *
   * Protocol identity resolves exclusively through
   * `#liveReplicaContext()`; this field never selects the physical
   * replica.
   */
  #rememberedActiveLocalVaultId: string | null = null;
  #reconciler: SyncWorkspaceReconciler | null;
  /**
   * Incremental scan caches per replica binding (owner UID → local vault
   * id → cache). In-memory optimization only: restarts begin empty and
   * therefore perform one authoritative full scan, so missed hints can
   * never strand changes. The cache is also invalidated whenever
   * mutation-feed continuity for the replica is lost while local writes
   * may continue (disable, suspend/sign-out parking, detach/replace,
   * account transition, selection-mismatch parking, corrupt parking):
   * the next reconcile for that replica must not trust any pre-gap
   * size/mtime content identity and performs an authoritative
   * read/hash before the cache warms again. Mutation hints force
   * rehash, and a periodic full scan remains as a failsafe.
   */
  #scanCaches = new Map<string, Map<string, LocalScanCache>>();
  /** Mutation-hint paths observed since the last cycle started. */
  #mutatedPaths = new Set<string>();
  /** Successful reconciles per binding (periodic full-scan failsafe). */
  #reconcileCounts = new Map<string, number>();
  #suspended = false;
  #phase: VaultSyncPhase = 'idle';
  #pendingChanges = 0;
  #lastDeferred = new Set<string>();
  #error: VaultSyncError | null = null;
  #restored = false;
  // Auth can recover before restore(): never supersede unread durable metadata.
  #metadataLoaded = false;
  /**
   * Serialized durable-metadata lane (lane split).
   * Every `StoredSyncState` write holds this mutex across
   * `stage → persist → validate → install`, so durable writes stay
   * totally ordered and a stale transition never reinstalls memory.
   * Long-running protocol work (HEAD reads, manifests, blobs, CAS) NEVER
   * holds it: a hung network call must not block metadata mutation or the
   * next authentication epoch.
   */
  #metadataChain: Promise<void> = Promise.resolve();
  /**
   * Single-flight reconcile lane, abandonable by authentication epoch
   * (lane split). Reconciles for one live
   * `(identity, operation)` epoch serialize with each other, but a new
   * epoch never waits on a hung older one: the stale tail is abandoned
   * (its generations are already invalid, so it is inert), and the new
   * epoch proceeds immediately. This is what makes bounded sign-out
   * recoverable — `prepareForSignOut()` may return while an old remote
   * call stays unresolved forever, yet B can still bind and reconcile.
   */
  #reconcileTail: {
    readonly identityGeneration: number;
    readonly operationGeneration: number;
    readonly promise: Promise<void>;
  } | null = null;
  #entitlementGeneration = 0;
  /**
   * Three generations with distinct semantics (lifetime-split hardening):
   *
   * ```text
   * identityGeneration
   *     protects ownership/authentication identity.
   *     Incremented ONLY on auth discontinuity: UID A→B, UID→null,
   *     null→UID (new epoch even for the same UID), explicit
   *     invalidation during ordered sign-out, disposal. NEVER on
   *     attach/detach/setActiveLocalVault/vault replacement/binding
   *     replacement/enable/disable/ordinary reconcile invalidation.
   *     Prepared Download & Open tokens capture this (not operation).
   *
   * operationGeneration
   *     invalidates stale sync protocol work.
   *     Bumped by suspend, prepareForSignOut, account replacement,
   *     disable, binding switches, attach/detach. Each `#cycle` captures
   *     it; pinned remote + engine shouldAbort compare before every side
   *     effect so stale A never writes under B.
   *
   * vaultGeneration
   *     invalidates stale replica/workspace context.
   *     Bumped whenever the attached replica changes (attach/detach/
   *     binding replacement/disable/account switch/suspend). Each `#cycle`
   *     captures it; shouldAbort compares before every side effect and
   *     before workspace callbacks, so vault A's operation never invokes
   *     B's reconciler. Bumped BEFORE rewiring (invalidate → detach →
   *     replace → attach), never after.
   * ```
   *
   * These generation bumps are synchronous and deliberately OUTSIDE the
   * metadata lane: attachment/auth transitions must invalidate stale
   * protocol work immediately, while durable `StoredSyncState` writes
   * remain totally ordered by `#metadataChain`.
   */
  #identityGeneration = 0;
  /**
   * Reconcile generation: stale protocol-work invalidation (see above).
   */
  #operationGeneration = 0;
  /**
   * Replica generation: stale workspace-context invalidation (see above).
   */
  #vaultGeneration = 0;
  /** Permanent teardown: identity-owned operations stay invalid. */
  #disposed = false;
  /**
   * Pending workspace notifications from throwing reconcilers:
   * keyed by replica (`uid/localVaultId/cloudVaultId`). The engine
   * applied bytes but the application hook failed, so the base did not
   * advance. Retried at the start of the next cycle for the SAME replica
   * only — never replayed into another account/vault. Keeping per-replica
   * entries (instead of one global scalar) means parking B never loses
   * A's pending retry when A becomes live again.
   */
  #pendingRemoteApplied = new Map<string, PendingRemoteApplied>();

  constructor(options: VaultSyncServiceOptions) {
    this.#remote = options.remote;
    this.#account = options.account;
    this.#storage = options.storage ?? createMemorySyncStorage();
    this.#tracker = options.tracker ?? null;
    this.#exclude = options.exclude ?? isDefaultExcludedSyncPath;
    this.#debounceMs = options.debounceMs ?? 0;
    this.#purchases = options.purchases ?? null;
    this.#entitlementMaxAttempts = options.entitlement?.maxAttempts ?? 5;
    this.#entitlementBaseDelayMs = options.entitlement?.baseDelayMs ?? 1000;
    this.#entitlementSleep =
      options.entitlement?.sleep ?? defaultEntitlementSleep;
    this.#signOutDrainTimeoutMs = options.signOut?.drainTimeoutMs ?? 5000;
    this.#signOutDrainRace =
      options.signOut?.raceTimeout ?? defaultSignOutDrainRace;
    this.#reconciler = options.reconciler ?? null;
    this.#currentUid = options.account.snapshot().user?.id ?? null;
    if (this.#currentUid !== null) this.#lastActiveUid = this.#currentUid;
    this.#lastUid = this.#currentUid;
    this.#accountUnsub = options.account.subscribe(() => {
      this.#onAccountChange();
    });
  }

  /**
   * The `AccountService` this store authenticates against (composition
   * introspection). Hosts use it to prove the sync host and the account
   * host resolve the same instance: a service built over a different
   * store would read another account's session, so
   * `createVaultSyncHost` refuses such a composition at activation.
   */
  get accountService(): AccountService {
    return this.#account;
  }

  snapshot(): VaultSyncSnapshot {
    const binding = this.#snapshotBinding();
    const bindings = this.#snapshotBindings()
      .map((entry) => ({
        enabled: entry.enabled,
        cloudVaultId: entry.cloudVaultId,
        localVaultId: entry.localVaultId,
        name: entry.name,
        ...(entry.baseCorrupt === true ? { baseCorrupt: true } : {}),
      }))
      .sort((a, b) =>
        a.localVaultId < b.localVaultId
          ? -1
          : a.localVaultId > b.localVaultId
            ? 1
            : 0,
      );
    return {
      enabled: binding?.enabled ?? false,
      phase: this.#phase,
      binding:
        binding === null
          ? null
          : {
              enabled: binding.enabled,
              cloudVaultId: binding.cloudVaultId,
              localVaultId: binding.localVaultId,
              name: binding.name,
              ...(binding.baseCorrupt === true ? { baseCorrupt: true } : {}),
            },
      bindings,
      activeLocalVaultId: this.#rememberedActiveLocalVaultId,
      pendingChanges: this.#pendingChanges,
      lastSyncedAt: binding?.lastSyncedAt ?? null,
      lastRevision: binding?.lastRevision ?? null,
      deferredPaths: [...this.#lastDeferred].sort(),
      conflicts:
        this.#currentUid === null
          ? []
          : (binding?.conflicts?.map((entry) => ({ ...entry })) ?? []),
      error: this.#error,
    };
  }

  /**
   * Replace the workspace/session reconciler (host wiring for vault
   * replacement can re-point the seam without rebuilding the service).
   */
  setWorkspaceReconciler(reconciler: SyncWorkspaceReconciler | null): void {
    this.#reconciler = reconciler;
  }

  subscribe(listener: VaultSyncSnapshotListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Attach a local replica atomically as `(localVaultId, vault)`. The
   * identity is authoritative: the vault alone never determines which
   * binding is live. Idempotent; re-attaching (vault replacement, fiber
   * reactivation) invalidates stale protocol work BEFORE rewiring,
   * replaces the pair in one step, and wires only when a binding exists
   * for EXACTLY this local vault id and is enabled — otherwise it stays
   * parked. Never infers identity from remembered selection, binding
   * count, previous active vault, or UI state.
   */
  attach(input: VaultSyncAttachInput): void {
    const localVaultId = input.localVaultId;
    const vault = input.vault;
    if (typeof localVaultId !== 'string' || localVaultId.length === 0) {
      throw new VaultSyncError(
        'UNKNOWN',
        'attach requires a non-empty localVaultId',
      );
    }
    if (vault === null || typeof vault !== 'object') {
      throw new VaultSyncError(
        'UNKNOWN',
        'attach requires an observable vault',
      );
    }
    // Mutation-feed continuity for the previous replica ends here: its
    // backing state may stay writable while unobserved, so its scan
    // cache must not survive. Invalidate before rewiring; the incoming
    // replica likewise starts authoritative (its state may have changed
    // while unattached with no hints).
    const previousReplica = this.#attachedReplica;
    const previousUid = this.#currentUid;
    if (previousReplica !== null && previousUid !== null) {
      this.#invalidateScanCache(previousUid, previousReplica.localVaultId);
    }
    // Invalidate BEFORE rewiring so an in-flight A cycle aborts before
    // it can touch the replacement replica's workspace context.
    this.#operationGeneration += 1;
    this.#vaultGeneration += 1;
    this.#unwire();
    this.#attachedReplica = { localVaultId, vault };
    if (this.#currentUid !== null) {
      this.#invalidateScanCache(this.#currentUid, localVaultId);
    }
    // Replica switch re-scopes all transparent presentation: a stale A
    // callback must never increment B's pending count, B must not inherit
    // A's hints/phase/error, and B never inherits A's network/conflict
    // presentation. `#wire()` re-establishes valid replica-owned state.
    this.#resetTransientPresentation();
    this.#wire();
    this.#emit();
    if (this.#liveReplicaContext() !== null) {
      this.#scheduler?.request();
    }
  }

  /**
   * Detach the current replica (identity AND vault clear together).
   * Binding, base, and enabled state persist in memory (and storage);
   * listeners park and the scheduler resets.
   */
  detach(): void {
    // The detached vault stays writable while unobserved; its cache must
    // not survive for a later reattach of the same replica.
    const replica = this.#attachedReplica;
    const uid = this.#currentUid;
    if (replica !== null && uid !== null) {
      this.#invalidateScanCache(uid, replica.localVaultId);
    }
    this.#operationGeneration += 1;
    this.#vaultGeneration += 1;
    this.#unwire();
    this.#attachedReplica = null;
    this.#resetTransientPresentation();
    this.#emit();
  }

  /** Host teardown: detach everything, including the account feed. */
  dispose(): void {
    this.#entitlementGeneration += 1;
    // Permanent identity invalidation: prepared tokens must never survive
    // disposal even if the same UID signs in on a new service later.
    // detach() below bumps operation/vault only (never identity); the
    // identity bump here is the disposal-owned invalidation.
    this.#identityGeneration += 1;
    this.#disposed = true;
    this.detach();
    try {
      this.#accountUnsub?.();
    } catch {
      // Detach is best-effort.
    }
    this.#accountUnsub = null;
    this.#listeners.clear();
  }

  async restore(): Promise<void> {
    // One-shot boot load: enable()/attachRemoteVault() establish fresh
    // state and also mark restore complete, so no ordering of those
    // calls can clobber live state with stale storage.
    if (this.#restored) return;
    this.#restored = true;
    this.#currentUid = this.#account.snapshot().user?.id ?? null;
    if (this.#currentUid !== null) this.#lastActiveUid = this.#currentUid;
    this.#lastUid = this.#currentUid;
    let raw: unknown = null;
    try {
      raw = await this.#storage.load();
    } catch {
      raw = null;
    }
    const parsed = raw === null ? null : parseStoredSyncState(raw);
    if (parsed !== null) {
      this.#deviceId = parsed.deviceId;
      this.#adoptStoredAccounts(parsed);
    } else {
      this.#deviceId = generateDeviceId();
      this.#accounts.clear();
      this.#accountActive.clear();
      this.#metadataLoaded = true;
      try {
        await this.#withMetadataLane(() => this.#persist());
      } catch {
        // Boot must never fail on sync metadata; the next enable or
        // reconcile persists again.
      }
    }
    // Adopt the persisted active vault when the host has not reported a
    // selection yet (launcher restores it shortly after boot). Display
    // metadata only; it never selects the protocol replica.
    if (
      this.#rememberedActiveLocalVaultId === null &&
      this.#currentUid !== null
    ) {
      const remembered = this.#accountActive.get(this.#currentUid);
      if (remembered !== undefined && remembered !== null) {
        this.#rememberedActiveLocalVaultId = remembered;
      }
    }
    this.#wire();
    this.#emit();
    if (this.#liveReplicaContext() !== null) {
      this.#scheduler?.request();
    }
  }

  async listRemoteVaults(): Promise<readonly RemoteVaultInfo[]> {
    const uid = this.#requireUser().id;
    const cycleIdentity = this.#identityGeneration;
    const cycleGeneration = this.#operationGeneration;
    const shouldAbort = (): boolean =>
      this.#disposed ||
      this.#suspended ||
      this.#identityGeneration !== cycleIdentity ||
      this.#operationGeneration !== cycleGeneration ||
      (this.#account.snapshot().user?.id ?? null) !== uid;
    const scoped =
      typeof this.#remote.forUid === 'function'
        ? this.#remote.forUid(uid)
        : this.#remote;
    try {
      if (shouldAbort()) {
        throw new VaultSyncError(
          'ACCOUNT_CHANGED',
          'account identity changed during vault discovery',
        );
      }
      const listed = await scoped.listVaults();
      // An account replacement in flight must not populate B's UI with
      // A's vault list (React effect cleanup usually drops it, but the
      // service never returns stale-identity discovery either).
      if (shouldAbort()) {
        throw new VaultSyncError(
          'ACCOUNT_CHANGED',
          'account identity changed during vault discovery',
        );
      }
      // Display identity is canonical vault content, not a second Firestore
      // record. Read only its bounded blob from the verified current manifest.
      const detailed: RemoteVaultInfo[] = [];
      for (const row of listed) {
        if (shouldAbort())
          throw new VaultSyncError(
            'ACCOUNT_CHANGED',
            'Account changed during vault discovery',
          );
        const head = await scoped.readHead(row.cloudVaultId);
        if (shouldAbort())
          throw new VaultSyncError(
            'ACCOUNT_CHANGED',
            'Account changed during vault discovery',
          );
        if (head === null) continue;
        const manifest = await scoped.loadManifest(
          row.cloudVaultId,
          head.manifestHash,
          head.manifestObject,
        );
        if (shouldAbort())
          throw new VaultSyncError(
            'ACCOUNT_CHANGED',
            'Account changed during vault discovery',
          );
        if (
          manifest.vaultId !== row.cloudVaultId ||
          manifest.revision !== head.revision ||
          (await hashManifest(manifest)) !== head.manifestHash
        )
          throw new VaultSyncError(
            'CORRUPT_MANIFEST',
            'Vault details manifest failed verification',
          );
        const entry = manifest.entries.find(
          (item) => item.path === VAULT_PROFILE_PATH,
        );
        let profile;
        if (entry !== undefined) {
          if (
            entry.kind !== 'file' ||
            entry.blob === undefined ||
            (entry.size ?? Infinity) > 16384
          )
            throw new VaultSyncError(
              'CORRUPT_MANIFEST',
              'Invalid vault details entry',
            );
          if (shouldAbort())
            throw new VaultSyncError(
              'ACCOUNT_CHANGED',
              'Account changed during vault discovery',
            );
          const bytes = await scoped.downloadBlob(row.cloudVaultId, entry.blob);
          if (shouldAbort())
            throw new VaultSyncError(
              'ACCOUNT_CHANGED',
              'Account changed during vault discovery',
            );
          if (
            bytes.byteLength !== entry.size ||
            (await hashBytes(bytes)) !== entry.blob
          )
            throw new VaultSyncError(
              'HASH_MISMATCH',
              'Vault details failed verification',
            );
          profile = decodeVaultProfile(bytes);
        }
        detailed.push({
          ...row,
          name: profile?.name ?? head.name,
          revision: head.revision,
          updatedAt: head.updatedAt,
          ...(profile === undefined ? {} : { profile }),
        });
      }
      if (shouldAbort())
        throw new VaultSyncError(
          'ACCOUNT_CHANGED',
          'Account changed during vault discovery',
        );
      return detailed;
    } catch (error) {
      throw error instanceof VaultSyncError ? error : normalizeSyncError(error);
    }
  }

  async enable(input: VaultSyncEnableInput): Promise<void> {
    if (input.localVaultId.length === 0 || input.name.length === 0) {
      throw new VaultSyncError(
        'UNKNOWN',
        'localVaultId and name must not be empty',
      );
    }
    const user = this.#requireUser();
    // Abort in-flight cycles promptly (synchronous, outside the metadata
    // lane): the binding mutation below invalidates them, but a running
    // scan must stop before its next remote read. Identity is untouched:
    // enabling never changes authentication epochs.
    this.#operationGeneration += 1;
    this.#vaultGeneration += 1;
    const captureUid = user.id;
    const captureIdentity = this.#identityGeneration;
    const ownsIdentity = (): boolean => {
      const liveUid = this.#account.snapshot().user?.id ?? null;
      return (
        !this.#disposed &&
        !this.#suspended &&
        liveUid !== null &&
        liveUid === captureUid &&
        this.#identityGeneration === captureIdentity
      );
    };
    // Replica/presentation ownership for post-commit runtime effects
    // (final async-ownership pass): the durable mutation may commit for
    // a non-visible vault, but phase/error/listeners/scheduler belong to
    // the attachment captured here.
    const replicaOwner = this.#captureReplicaOwner(captureUid, captureIdentity);
    const { installed } = await this.#commitMetadata({
      label: 'enable',
      validateBefore: () => {
        if (!ownsIdentity()) {
          throw new VaultSyncError(
            'ACCOUNT_CHANGED',
            'account identity changed during enable; binding not installed',
          );
        }
      },
      // Narrow ownership: only this account's binding for this local
      // vault. The host-visible selection (`accountActive`) is owned
      // exclusively by `setActiveLocalVault()` — a protocol operation
      // never rewrites which vault the host says is open.
      mutate: (draft) => {
        let bindings = draft.accounts.get(captureUid);
        if (bindings === undefined) {
          bindings = new Map();
          draft.accounts.set(captureUid, bindings);
        }
        const existing = bindings.get(input.localVaultId);
        if (existing !== undefined) {
          bindings.set(input.localVaultId, {
            ...existing,
            name: input.name,
            enabled: true,
          });
        } else {
          // Fresh cloud identity. Bindings for other local
          // vaults under the same account are kept (multi-vault); the
          // previous cloud vault is left intact remotely, never deleted
          //
          bindings.set(input.localVaultId, {
            cloudVaultId: generateCloudVaultId(),
            localVaultId: input.localVaultId,
            name: input.name,
            deviceId: draft.deviceId,
            base: null,
            lastSyncedAt: null,
            lastRevision: null,
            enabled: true,
          });
        }
      },
      validateAfterSave: ownsIdentity,
    });
    if (!installed) {
      throw new VaultSyncError(
        'ACCOUNT_CHANGED',
        'account identity changed during enable; binding not installed',
      );
    }
    // Fresh state established: a later restore() must not clobber it.
    this.#restored = true;
    // Post-commit runtime effects are replica-owned: a stale enable(A)
    // completing after the runtime switched to B keeps its durable
    // binding but must not clear B's telemetry, rewire B, or schedule
    // B's work. Emit always so the bindings list converges.
    const ownsReplica =
      replicaOwner !== null &&
      this.#isCurrentReplicaOwner(replicaOwner) &&
      this.#attachedReplica?.localVaultId === input.localVaultId;
    if (!ownsReplica) {
      this.#emit();
      return;
    }
    // A binding replacement changes the live replica: invalidate
    // in-flight cycles BEFORE rewiring listeners.
    this.#operationGeneration += 1;
    this.#vaultGeneration += 1;
    this.#error = null;
    this.#phase = 'idle';
    // Presentation-state ownership: `setActiveLocalVault()` is the only
    // writer of the host-visible selection. Enabling a binding never
    // retroactively changes which vault the host says is open, so a
    // stale completing enable (save paused, runtime switched A→B) can
    // never re-park a newer B selection.
    this.#wire();
    this.#emit();
    if (this.#liveReplicaContext() !== null) {
      this.#scheduler?.request();
    }
  }

  async disable(): Promise<void> {
    // Capture the exact replica identity BEFORE invalidating generations:
    // the vault object, local id, UID/epoch, and cloud binding that this
    // transition parks. The post-bump `disableTarget` below carries the new
    // operation/vault epochs so `#isCurrentReplicaOwner` stays true only
    // while no newer attach/detach/enable/disable/suspend moved on.
    const replicaAtEntry = this.#attachedReplica;
    const uidAtEntry = this.#currentUid;
    const identityAtEntry = this.#identityGeneration;
    const localVaultIdAtEntry = replicaAtEntry?.localVaultId ?? null;
    const vaultAtEntry = replicaAtEntry?.vault ?? null;
    const cloudAtEntry =
      uidAtEntry !== null && localVaultIdAtEntry !== null
        ? (this.#accounts.get(uidAtEntry)?.get(localVaultIdAtEntry)
            ?.cloudVaultId ?? null)
        : null;
    // Mutation-feed continuity ends here while the local vault stays
    // writable: invalidate the target's scan cache BEFORE the period in
    // which mutation events can be missed (covers both successful disable
    // and a later failed-disable recovery, which must re-hash).
    if (uidAtEntry !== null && localVaultIdAtEntry !== null) {
      this.#invalidateScanCache(uidAtEntry, localVaultIdAtEntry);
    }
    this.#entitlementGeneration += 1;
    this.#operationGeneration += 1;
    this.#vaultGeneration += 1;
    // Park immediately BEFORE waiting on persistence: the old scheduler /
    // listeners are physically removed now, so no mutation, HEAD, or queued
    // scheduler callback can start protocol work while the durable
    // enabled/disabled state is undecided. Local vault writes stay usable;
    // only cloud-sync lifecycle is parked.
    this.#unwire();
    // Disable targets exactly the attached replica: the remembered
    // selection never redirects protocol ownership.
    if (
      replicaAtEntry === null ||
      uidAtEntry === null ||
      localVaultIdAtEntry === null ||
      vaultAtEntry === null
    ) {
      this.#emit();
      return;
    }
    const localVaultId = localVaultIdAtEntry;
    const captureUid = uidAtEntry;
    const captureIdentity = identityAtEntry;
    // Exact disable target BEFORE awaiting (final async-ownership pass):
    // the durable mutation may commit for A while the runtime already
    // shows B. Post-commit presentation/listeners run only while this
    // still owns the current attachment.
    const disableTarget: ReplicaOwner = {
      uid: captureUid,
      identityGeneration: captureIdentity,
      operationGeneration: this.#operationGeneration,
      vaultGeneration: this.#vaultGeneration,
      localVaultId,
      cloudVaultId: cloudAtEntry,
      vault: vaultAtEntry,
    };
    // A plain suspend parks but does not invalidate a disable for the same
    // parked replica; an account switch does.
    const ownsIdentity = (): boolean => {
      if (this.#disposed) return false;
      const liveUid = this.#account.snapshot().user?.id ?? null;
      return (
        liveUid === captureUid && this.#identityGeneration === captureIdentity
      );
    };
    let installed: boolean;
    try {
      const result = await this.#commitMetadata({
        label: 'disable',
        validateBefore: () => {
          if (!ownsIdentity()) {
            throw new VaultSyncError(
              'ACCOUNT_CHANGED',
              'account identity changed during disable; state not installed',
            );
          }
        },
        // Narrow ownership: the enabled flag for exactly this replica.
        mutate: (draft) => {
          const bindings = draft.accounts.get(captureUid);
          const current = bindings?.get(localVaultId);
          if (bindings !== undefined && current !== undefined) {
            bindings.set(localVaultId, { ...current, enabled: false });
          }
        },
        validateAfterSave: ownsIdentity,
      });
      installed = result.installed;
    } catch (error) {
      // Persistence (or lane-entry ownership) failed. The replica was
      // parked above, so an enabled replica would be left dead unless its
      // lifecycle is restored. Restore ONLY while the original replica
      // still owns the runtime attachment and its binding is still enabled;
      // a switch to B during the save owns B's lifecycle and must not be
      // disturbed. The original error always propagates.
      if (this.#isDisableRecoveryOwned(disableTarget)) {
        this.#wire();
        this.#emit();
        if (this.#liveReplicaContext() !== null) {
          this.#scheduler?.request();
        }
      }
      throw error;
    }
    if (!installed) {
      throw new VaultSyncError(
        'ACCOUNT_CHANGED',
        'account identity changed during disable; state not installed',
      );
    }
    // Metadata operation vs runtime presentation ownership are distinct:
    // the durable `enabled=false` stands even for a non-visible vault,
    // but transient telemetry/listeners/phase/error belong to the live
    // replica. A stale disable(A) completing after attach(B) must keep
    // A's durable flag yet leave B's listeners, watcher, telemetry, and
    // error state untouched.
    if (!this.#isCurrentReplicaOwner(disableTarget)) {
      // Bindings list changed (A disabled); publish it without touching
      // B's presentation or lifecycle.
      this.#emit();
      return;
    }
    this.#pendingChanges = 0;
    this.#lastDeferred = new Set();
    this.#phase = 'idle';
    this.#error = null;
    // Listeners park but the vault stays attached: re-enabling resumes
    // without host involvement. Already unwired above; this keeps the
    // parked state explicit without recreating the scheduler/listeners.
    this.#detachListeners();
    this.#emit();
  }

  async reconcile(): Promise<void> {
    this.#requireUser();
    if (this.#liveReplicaContext() === null) {
      throw new VaultSyncError(
        'NOT_CONFIGURED',
        'sync is not enabled for the open vault; open a synced vault to reconcile',
      );
    }
    await this.#withReconcileLane(() => this.#cycle());
  }

  async prepareConflictRecovery(
    requestedConflictId: string,
  ): Promise<VaultSyncConflictRecovery> {
    const uid = this.#requireUser().id;
    const identityGeneration = this.#identityGeneration;
    const replica = this.#attachedReplica;
    if (replica === null) {
      throw new VaultSyncError('NOT_CONFIGURED', 'open the synced vault first');
    }
    const binding = this.#accounts.get(uid)?.get(replica.localVaultId);
    const conflict = binding?.conflicts?.find(
      (entry) => entry.id === requestedConflictId,
    );
    if (binding === undefined || conflict === undefined) {
      throw new VaultSyncError(
        'CONFLICT',
        'that conflict does not belong to the open vault',
      );
    }
    const recoveryPath = conflict.conflictPath ?? conflict.path;
    const owns = (): boolean =>
      !this.#disposed &&
      this.#identityGeneration === identityGeneration &&
      (this.#account.snapshot().user?.id ?? null) === uid &&
      this.#attachedReplica === replica &&
      this.#accounts.get(uid)?.get(replica.localVaultId)?.cloudVaultId ===
        binding.cloudVaultId;
    const stat = await replica.vault.stat(workspacePath(recoveryPath));
    if (!owns()) {
      throw new VaultSyncError(
        'ACCOUNT_CHANGED',
        'account or vault changed during conflict recovery',
      );
    }
    if (stat.kind !== 'file') {
      throw new VaultSyncError(
        'UNSUPPORTED',
        'this conflict is a directory; recover it from the Files view',
      );
    }
    if (stat.size > MAX_SYNC_CONFLICT_RECOVERY_BYTES) {
      throw new VaultSyncError(
        'UNSUPPORTED',
        'the conflict copy is too large for Settings recovery',
      );
    }
    const bytes = await replica.vault.read(workspacePath(recoveryPath));
    if (!owns()) {
      throw new VaultSyncError(
        'ACCOUNT_CHANGED',
        'account or vault changed during conflict recovery',
      );
    }
    if (bytes.byteLength > MAX_SYNC_CONFLICT_RECOVERY_BYTES) {
      throw new VaultSyncError(
        'UNSUPPORTED',
        'the conflict copy is too large for Settings recovery',
      );
    }
    const recoveredAt = new Date().toISOString();
    const { installed } = await this.#commitMetadata({
      label: 'conflict-recovered',
      validateBefore: () => {
        if (!owns()) {
          throw new VaultSyncError(
            'ACCOUNT_CHANGED',
            'account or vault changed during conflict recovery',
          );
        }
      },
      mutate: (draft) => {
        const nextBinding = draft.accounts.get(uid)?.get(replica.localVaultId);
        const summaries = nextBinding?.conflicts;
        if (
          nextBinding === undefined ||
          nextBinding.cloudVaultId !== binding.cloudVaultId ||
          summaries === undefined
        ) {
          throw new VaultSyncError(
            'ACCOUNT_CHANGED',
            'sync binding changed during conflict recovery',
          );
        }
        const index = summaries.findIndex(
          (entry) => entry.id === requestedConflictId,
        );
        if (index < 0) {
          throw new VaultSyncError('CONFLICT', 'conflict was already resolved');
        }
        const next = summaries.map((entry, entryIndex) =>
          entryIndex === index ? { ...entry, recoveredAt } : entry,
        );
        draft.accounts.get(uid)?.set(replica.localVaultId, {
          ...nextBinding,
          conflicts: next,
        });
      },
      validateAfterSave: owns,
    });
    if (!installed) {
      throw new VaultSyncError(
        'ACCOUNT_CHANGED',
        'account or vault changed during conflict recovery',
      );
    }
    this.#emit();
    return {
      conflictId: requestedConflictId,
      fileName: recoveryPath.split('/').at(-1) ?? 'froglight-conflict-copy',
      bytes,
    };
  }

  async acknowledgeConflict(requestedConflictId: string): Promise<void> {
    const uid = this.#requireUser().id;
    const identityGeneration = this.#identityGeneration;
    const replica = this.#attachedReplica;
    if (replica === null) {
      throw new VaultSyncError('NOT_CONFIGURED', 'open the synced vault first');
    }
    const binding = this.#accounts.get(uid)?.get(replica.localVaultId);
    const conflict = binding?.conflicts?.find(
      (entry) => entry.id === requestedConflictId,
    );
    if (binding === undefined || conflict === undefined) {
      throw new VaultSyncError(
        'CONFLICT',
        'that conflict does not belong to the open vault',
      );
    }
    const hiddenPropertyCopy =
      conflict.conflictPath?.startsWith('.froglight/properties/') === true;
    if (hiddenPropertyCopy && conflict.recoveredAt === null) {
      throw new VaultSyncError(
        'CONFLICT',
        'download the preserved property copy before acknowledging it',
      );
    }
    const owns = (): boolean =>
      !this.#disposed &&
      this.#identityGeneration === identityGeneration &&
      (this.#account.snapshot().user?.id ?? null) === uid &&
      this.#attachedReplica === replica &&
      this.#accounts.get(uid)?.get(replica.localVaultId)?.cloudVaultId ===
        binding.cloudVaultId;
    const { installed } = await this.#commitMetadata({
      label: 'conflict-acknowledged',
      validateBefore: () => {
        if (!owns()) {
          throw new VaultSyncError(
            'ACCOUNT_CHANGED',
            'account or vault changed during conflict acknowledgement',
          );
        }
      },
      mutate: (draft) => {
        const nextBinding = draft.accounts.get(uid)?.get(replica.localVaultId);
        if (
          nextBinding === undefined ||
          nextBinding.cloudVaultId !== binding.cloudVaultId
        ) {
          throw new VaultSyncError(
            'ACCOUNT_CHANGED',
            'sync binding changed during conflict acknowledgement',
          );
        }
        const conflicts = (nextBinding.conflicts ?? []).filter(
          (entry) => entry.id !== requestedConflictId,
        );
        draft.accounts.get(uid)?.set(replica.localVaultId, {
          ...nextBinding,
          ...(conflicts.length > 0 ? { conflicts } : { conflicts: undefined }),
        });
      },
      validateAfterSave: owns,
    });
    if (!installed) {
      throw new VaultSyncError(
        'ACCOUNT_CHANGED',
        'account or vault changed during conflict acknowledgement',
      );
    }
    this.#emit();
  }

  /**
   * Claim-propagation gate. Bounded force-refresh
   * loop: the snapshot reports `waiting-for-entitlement` while polling,
   * backend writes stay denied throughout (never bypassed), and local
   * vaults stay fully usable. Sign-out, disable, or dispose aborts the
   * wait with `NOT_AUTHENTICATED`.
   *
   * Ownership (final async-ownership pass): one explicit entitlement
   * owner (`uid` + `entitlementGeneration`) gates every await boundary,
   * and every `#phase`/`#error`/`#emit()` publish additionally requires
   * full replica/presentation ownership. A stale refresh finishing after
   * sign-out, account switch, disable, or same-UID A→B replica switch
   * throws without publishing into the newer account/replica/disabled
   * state.
   */
  async ensureProEntitlement(): Promise<boolean> {
    const startUid = this.#requireUser().id;
    const startIdentity = this.#identityGeneration;
    const startOperation = this.#operationGeneration;
    const startVault = this.#vaultGeneration;
    const entitlementOwner = {
      uid: startUid,
      generation: ++this.#entitlementGeneration,
    };
    const startLive = this.#liveReplicaContext();
    const startAttached = this.#attachedReplica;
    const ownsEntitlement = (): boolean =>
      !this.#disposed &&
      !this.#suspended &&
      this.#entitlementGeneration === entitlementOwner.generation &&
      (this.#account.snapshot().user?.id ?? null) === entitlementOwner.uid;
    // Replica/presentation ownership for every publish in this operation.
    // Account claims are account-scoped, but waiting/error UI state is
    // replica-owned: a same-UID A→B attach bumps operation/vault epochs
    // without bumping the entitlement epoch, so identity checks alone
    // cannot make this safe.
    const ownsReplicaForPublish = (): boolean => {
      if (this.#disposed || this.#suspended) return false;
      if (this.#identityGeneration !== startIdentity) return false;
      if ((this.#account.snapshot().user?.id ?? null) !== startUid)
        return false;
      if (this.#currentUid !== startUid) return false;
      if (this.#operationGeneration !== startOperation) return false;
      if (this.#vaultGeneration !== startVault) return false;
      if (startLive === null) {
        return this.#liveReplicaContext() === null;
      }
      const current = this.#liveReplicaContext();
      if (current === null) return false;
      if (current.uid !== startLive.uid) return false;
      if (current.localVaultId !== startLive.localVaultId) return false;
      if (current.cloudVaultId !== startLive.cloudVaultId) return false;
      if (startAttached === null) return false;
      const attached = this.#attachedReplica;
      if (attached === null) return false;
      if (attached.localVaultId !== startAttached.localVaultId) return false;
      if (attached.vault !== startAttached.vault) return false;
      return true;
    };
    const ownsForPublish = (): boolean =>
      ownsEntitlement() && ownsReplicaForPublish();
    const stale = (): VaultSyncError =>
      new VaultSyncError('NOT_AUTHENTICATED', 'sign in before syncing');
    // Fast path: the cached token already carries the claim (no refresh,
    // no waiting UI).
    let fastHas = false;
    try {
      fastHas = await this.#hasServerPro(false);
    } catch (error) {
      const code = errorCodeOf(error);
      if (
        code === 'NOT_AUTHENTICATED' ||
        code === 'NOT_CONFIGURED' ||
        code === 'UNAUTHENTICATED'
      ) {
        throw error instanceof VaultSyncError ? error : stale();
      }
      fastHas = false;
    }
    if (!ownsEntitlement()) throw stale();
    if (fastHas) {
      // Fast success: no waiting state was entered. Clear any stale
      // waiting presentation only while still owning the publish target.
      if (!ownsForPublish()) throw stale();
      this.#phase = 'idle';
      this.#error = null;
      this.#emit();
      return true;
    }
    if (!ownsEntitlement()) {
      throw new VaultSyncError('NOT_AUTHENTICATED', 'sign in before syncing');
    }
    if (!ownsForPublish()) throw stale();
    // Enter waiting state only while owning the publish target.
    this.#phase = 'waiting-for-entitlement';
    this.#error = new VaultSyncError(
      'ENTITLEMENT_PENDING',
      'Pro purchase is activating on the server; sync will begin automatically',
    );
    this.#emit();
    for (
      let attempt = 0;
      attempt < this.#entitlementMaxAttempts;
      attempt += 1
    ) {
      if (!ownsEntitlement()) {
        throw new VaultSyncError('NOT_AUTHENTICATED', 'sign in before syncing');
      }
      const currentUid = this.#account.snapshot().user?.id ?? null;
      if (currentUid === null || currentUid !== startUid) {
        throw new VaultSyncError('NOT_AUTHENTICATED', 'sign in before syncing');
      }
      let refreshed = false;
      try {
        refreshed = await this.#hasServerPro(true);
      } catch (error) {
        // A failed refresh is not a failed entitlement: transient network
        // errors retry within the bound; auth/config errors fail fast.
        const code = errorCodeOf(error);
        if (
          code === 'NOT_AUTHENTICATED' ||
          code === 'NOT_CONFIGURED' ||
          code === 'UNAUTHENTICATED'
        ) {
          throw error instanceof VaultSyncError
            ? error
            : new VaultSyncError('NOT_AUTHENTICATED', 'sign in before syncing');
        }
        refreshed = false;
      }
      // Mandatory ownership check immediately after the awaited refresh,
      // BEFORE reading purchase state or publishing anything.
      if (!ownsEntitlement()) {
        throw new VaultSyncError('NOT_AUTHENTICATED', 'sign in before syncing');
      }
      if (!ownsReplicaForPublish()) throw stale();
      if (refreshed) {
        if (!ownsEntitlement()) {
          throw new VaultSyncError(
            'NOT_AUTHENTICATED',
            'sign in before syncing',
          );
        }
        if (!ownsForPublish()) throw stale();
        this.#phase = 'idle';
        this.#error = null;
        this.#emit();
        return true;
      }
      // Client without Pro never enters the propagation wait: it needs
      // the paywall, not more refreshes. Purchase-state read
      // and failure publish both require ownership.
      if (!ownsEntitlement()) {
        throw new VaultSyncError('NOT_AUTHENTICATED', 'sign in before syncing');
      }
      if (!ownsReplicaForPublish()) throw stale();
      if (!this.#isClientPro()) {
        if (!ownsForPublish()) throw stale();
        const failure = new VaultSyncError(
          'PRO_REQUIRED',
          'Froglight Pro is required for cloud sync',
        );
        this.#error = failure;
        this.#phase = 'error';
        this.#emit();
        throw failure;
      }
      const last = attempt === this.#entitlementMaxAttempts - 1;
      if (!last) {
        await this.#entitlementSleep(
          this.#entitlementBaseDelayMs * 2 ** attempt,
        );
        // Backoff sleep is an await boundary like any other: revalidate
        // before the next attempt reads or publishes.
        if (!ownsEntitlement()) {
          throw new VaultSyncError(
            'NOT_AUTHENTICATED',
            'sign in before syncing',
          );
        }
        if (!ownsReplicaForPublish()) throw stale();
      }
    }
    if (!ownsEntitlement()) {
      throw new VaultSyncError('NOT_AUTHENTICATED', 'sign in before syncing');
    }
    if (!ownsForPublish()) throw stale();
    // Bound exhausted with the client Pro but the server still Free:
    // keep the explicit activating state, never a purchase error.
    const pending = new VaultSyncError(
      'ENTITLEMENT_PENDING',
      'Pro purchase is still activating on the server; try Sync now shortly',
    );
    this.#error = pending;
    this.#phase = 'waiting-for-entitlement';
    this.#emit();
    throw pending;
  }

  /**
   * Report the host-visible vault (launcher selection). Presentation
   * metadata only: it feeds snapshots and selection
   * persistence and NEVER selects the physical `attach`ed replica.
   * Precise eligibility rule (final async-ownership pass):
   *
   * ```text
   * runtime attachment determines WHICH replica sync belongs to
   *
   * host selection may temporarily PARK sync while composition is
   * inconsistent (reported id != attached id → `#liveReplicaContext()`
   * returns null until the host finishes switching)
   *
   * host selection can never redirect vault B into vault A's binding
   * ```
   *
   * If the reported id differs from the attached replica the report is
   * still only recorded (display); sync keeps trusting the runtime
   * attachment.
   */
  setActiveLocalVault(localVaultId: string | null): void {
    if (this.#rememberedActiveLocalVaultId === localVaultId) return;
    // A report that disagrees with the attached replica parks sync while
    // the vault stays writable: invalidate before the coverage gap so a
    // later restore re-hashes authoritatively.
    const parkedReplica = this.#attachedReplica;
    const parkedUid = this.#currentUid;
    if (
      parkedReplica !== null &&
      parkedUid !== null &&
      localVaultId !== null &&
      localVaultId !== parkedReplica.localVaultId
    ) {
      this.#invalidateScanCache(parkedUid, parkedReplica.localVaultId);
    }
    this.#rememberedActiveLocalVaultId = localVaultId;
    if (this.#currentUid !== null) {
      const uid = this.#currentUid;
      // Selection ownership: only `accountActive[uid]`. The mutation
      // stages inside the serialized lane from current canonical state,
      // so a queued selection can never rewrite bindings from an old
      // snapshot, and a newer binding mutation is never clobbered.
      void this.#commitMetadata({
        label: 'selection',
        mutate: (draft) => {
          draft.accountActive.set(uid, localVaultId);
        },
      }).catch(() => {
        // Selection memory is best-effort; the next mutation persists it.
      });
    }
    // Re-evaluate eligibility only: a report can restore consistency with
    // the already-attached replica (or record a mismatch that parks it),
    // but it NEVER attaches/detaches/replaces the physical vault. Wiring
    // for the existing attachment is a pure consequence of the predicate.
    this.#wire();
    this.#emit();
    if (this.#liveReplicaContext() !== null) {
      this.#scheduler?.request();
    }
  }

  /**
   * Ordered sign-out teardown: stop scheduling new cloud
   * work and cancel entitlement waits while keeping the attached replica
   * reference and every UID-scoped binding/base. Local vaults are
   * untouched. Suspension is cleared ONLY by
   * `#resumeAfterAuthenticatedIdentity()` on a new signed-in epoch.
   */
  suspend(): void {
    // Parking keeps the attached replica reference while the vault stays
    // writable with no mutation coverage: invalidate before teardown.
    const replica = this.#attachedReplica;
    const uid = this.#currentUid;
    if (replica !== null && uid !== null) {
      this.#invalidateScanCache(uid, replica.localVaultId);
    }
    this.#entitlementGeneration += 1;
    this.#operationGeneration += 1;
    this.#vaultGeneration += 1;
    // Ordered sign-out teardown invalidates identity-owned operations:
    // prepared tokens must not survive suspension even if the UID matches.
    this.#identityGeneration += 1;
    this.#suspended = true;
    this.#unwire();
    // Parked telemetry and presentation reset (never imply another
    // account's work/errors). The binding itself is preserved.
    this.#resetTransientPresentation();
    this.#emit();
  }

  /**
   * Ordered sign-out barrier with a bounded drain.
   * Semantics:
   *
   * ```text
   * invalidate identity/operation/vault generations
   *   → suspended = true
   *   → detach mutation + HEAD listeners
   *   → dispose scheduler (no new runs)
   *   → wait for the durable-metadata chain up to the bound
   *   → if drained: persist metadata through the normal metadata lane
   *   → if timed out: sign out immediately, persistence skipped
   * ```
   *
   * The reconcile lane is deliberately NOT waited on (lane split): a hung
   * remote call may remain unresolved forever, while a later
   * authentication epoch can still bind and reconcile. The drain is
   * raced against the injectable `signOut.raceTimeout` bound. On timeout
   * this method NEVER re-enters `#withMetadataLane()`: the lane could be
   * blocked by the very hung save the bound exists to escape, and a late
   * persistence would mutate state after identity teardown. The safety
   * guarantee comes from identity-generation invalidation, UID-pinned
   * remotes, and operation/vault abort checks instead.
   *
   * The coordinator awaits this BEFORE `clearIdentity()` + Firebase
   * `signOut()`. A stale cycle finishing after sign-out may clean up
   * local internal state but must never write under the wrong UID,
   * resurrect listeners, advance another account's binding, or overwrite
   * newer state. Cleanup failures never hide the primary sign-out error.
   */
  async prepareForSignOut(): Promise<void> {
    // Same parking guarantee as suspend(): the vault remains open and
    // writable while the mutation feed is detached, so invalidate before
    // the coverage gap. The next authenticated resume re-hashes.
    const replica = this.#attachedReplica;
    const uid = this.#currentUid;
    if (replica !== null && uid !== null) {
      this.#invalidateScanCache(uid, replica.localVaultId);
    }
    this.#entitlementGeneration += 1;
    this.#operationGeneration += 1;
    this.#vaultGeneration += 1;
    // Explicit identity invalidation during ordered sign-out: even a
    // same-UID re-sign-in starts a new authentication epoch.
    this.#identityGeneration += 1;
    this.#suspended = true;
    this.#unwire();
    this.#resetTransientPresentation();
    this.#emit();
    const pending = this.#metadataChain.catch(() => undefined);
    const outcome = await this.#signOutDrainRace(
      pending,
      this.#signOutDrainTimeoutMs,
    );
    if (outcome === 'timeout') {
      // Persistence is deliberately skipped: the lane is still blocked by
      // stale work whose generations are already invalid. The next boot
      // reconstructs from base + scan + HEAD; waiting longer would only
      // delay sign-out.
      return;
    }
    try {
      // Drain completed: the lane is free, so the normal serialized
      // persistence can run without ever waiting on hung work.
      await this.#withMetadataLane(() => this.#persist());
    } catch {
      // Metadata persistence is best-effort at sign-out; the next boot
      // reconstructs from base + scan + HEAD.
    }
  }

  /**
   * UID-scoped account memory (bindings for one owner). Created on demand
   * so enabling the first vault under a fresh sign-in just works.
   */
  #bindingsFor(uid: string): Map<string, VaultSyncBinding> {
    let bindings = this.#accounts.get(uid);
    if (bindings === undefined) {
      bindings = new Map();
      this.#accounts.set(uid, bindings);
    }
    return bindings;
  }

  /**
   * Invalidate the incremental scan cache for one replica (optimization
   * only). The next reconcile for that replica performs an authoritative
   * full read/hash before the cache warms again. Call before listener
   * coverage is removed whenever the same logical replica may later
   * resume using its existing cache after a period where local writes
   * could occur unobserved. Touches only the in-memory optimization
   * cache: base, binding, history, and local files are never modified.
   */
  #invalidateScanCache(uid: string, localVaultId: string): void {
    const perUid = this.#scanCaches.get(uid);
    if (perUid === undefined) return;
    perUid.delete(localVaultId);
    if (perUid.size === 0) this.#scanCaches.delete(uid);
  }

  /** Clone live account maps for copy-on-write staging. */
  #cloneAccountMaps(): {
    accounts: Map<string, Map<string, VaultSyncBinding>>;
    active: Map<string, string | null>;
  } {
    const accounts = new Map<string, Map<string, VaultSyncBinding>>();
    for (const [uid, bindings] of this.#accounts) {
      accounts.set(uid, new Map(bindings));
    }
    return { accounts, active: new Map(this.#accountActive) };
  }

  /** Build the durable envelope from staged maps (no live mutation). */
  #buildStoredState(
    accounts: Map<string, Map<string, VaultSyncBinding>>,
    active: Map<string, string | null>,
    deviceId: string,
  ): StoredSyncState {
    const packed: Record<string, AccountSyncState> = {};
    for (const [uid, bindings] of accounts) {
      const entries: Record<string, VaultSyncBinding> = {};
      for (const [localVaultId, binding] of bindings) {
        entries[localVaultId] = { ...binding };
      }
      packed[uid] = {
        bindings: entries,
        activeLocalVaultId: active.get(uid) ?? null,
      };
    }
    return { version: 1, deviceId, accounts: packed };
  }

  /** Adopt validated stored accounts into memory (restore only). */
  #adoptStoredAccounts(stored: StoredSyncState): void {
    this.#metadataLoaded = true;
    this.#accounts.clear();
    this.#accountActive.clear();
    for (const [uid, state] of Object.entries(stored.accounts)) {
      const bindings = new Map<string, VaultSyncBinding>();
      for (const [localVaultId, binding] of Object.entries(state.bindings)) {
        bindings.set(localVaultId, { ...binding });
      }
      this.#accounts.set(uid, bindings);
      this.#accountActive.set(uid, state.activeLocalVaultId);
    }
  }

  /**
   * The one eligibility predicate for every protocol path (auto/manual
   * reconcile, listener and watcher attachment, scheduler runs, snapshot
   * binding). Returns null when any condition fails; callers park.
   */
  #liveReplicaContext(): LiveReplicaContext | null {
    if (this.#disposed || this.#suspended) return null;
    const uid = this.#currentUid;
    if (uid === null) return null;
    const replica = this.#attachedReplica;
    if (replica === null) return null;
    // Fail-closed composition check: a reported selection may disagree
    // with the runtime attachment while a host switch is in flight.
    // Protocol work trusts the attachment but parks until composition is
    // consistent; the report NEVER redirects the attached vault.
    if (
      this.#rememberedActiveLocalVaultId !== null &&
      this.#rememberedActiveLocalVaultId !== replica.localVaultId
    ) {
      return null;
    }
    const binding = this.#accounts.get(uid)?.get(replica.localVaultId) ?? null;
    if (binding === null || !binding.enabled) return null;
    return {
      uid,
      identityGeneration: this.#identityGeneration,
      localVaultId: replica.localVaultId,
      cloudVaultId: binding.cloudVaultId,
      binding,
      vault: replica.vault,
    };
  }

  /**
   * Display binding for snapshots. While signed in this is only ever the
   * exact binding of the attached replica (or null when none exists);
   * the signed-out view keeps the last account's remembered binding so
   * signing out never looks like an unlink. Display only — never used
   * for listener attachment, scheduling, reconcile, or cloud work.
   */
  #snapshotBinding(): VaultSyncBinding | null {
    const live = this.#liveReplicaContext();
    if (live !== null) return live.binding;
    if (this.#currentUid !== null) {
      // Signed in with no live replica: only the attached replica's own
      // binding may be shown — never a guessed one.
      if (this.#attachedReplica === null) return null;
      return (
        this.#accounts
          .get(this.#currentUid)
          ?.get(this.#attachedReplica.localVaultId) ?? null
      );
    }
    if (this.#lastActiveUid === null) return null;
    const bindings = this.#accounts.get(this.#lastActiveUid);
    if (bindings === undefined || bindings.size === 0) return null;
    const remembered = this.#rememberedActiveLocalVaultId;
    if (remembered !== null) {
      const found = bindings.get(remembered);
      if (found !== undefined) return found;
    }
    if (bindings.size === 1) return [...bindings.values()][0] ?? null;
    return null;
  }

  /** Every remembered binding for the display account (snapshot list). */
  #snapshotBindings(): VaultSyncBinding[] {
    const uid = this.#currentUid ?? this.#lastActiveUid;
    if (uid === null) return [];
    const bindings = this.#accounts.get(uid);
    if (bindings === undefined) return [];
    return [...bindings.values()].sort((a, b) =>
      a.localVaultId < b.localVaultId
        ? -1
        : a.localVaultId > b.localVaultId
          ? 1
          : 0,
    );
  }

  /**
   * Enter the metadata lane and run one owner-scoped mutation. Staging
   * starts from the current canonical state only after `validateBefore`,
   * so unrelated bindings/accounts can never be reinstalled from a stale
   * snapshot. Returns `installed: false` when the post-save ownership
   * check fails (the transition must not adopt staged state).
   */
  #commitMetadata<T>(
    options: MetadataCommitOptions<T>,
  ): Promise<MetadataCommitResult<T>> {
    return this.#withMetadataLane(() => this.#commitMetadataInLane(options));
  }

  /**
   * Metadata-lane-held variant: `#commitMetadata` enters the lane and
   * calls this; it must never nest the lane. Identical staging semantics.
   */
  async #commitMetadataInLane<T>(
    options: MetadataCommitOptions<T>,
  ): Promise<MetadataCommitResult<T>> {
    options.validateBefore?.();
    const cloned = this.#cloneAccountMaps();
    const draft: MetadataDraft = {
      accounts: cloned.accounts,
      accountActive: cloned.active,
      deviceId: this.#deviceId ?? generateDeviceId(),
    };
    const value = options.mutate(draft);
    await this.#storage.save(
      this.#buildStoredState(
        draft.accounts,
        draft.accountActive,
        draft.deviceId,
      ),
    );
    if (
      options.validateAfterSave !== undefined &&
      !options.validateAfterSave()
    ) {
      return { value, installed: false };
    }
    this.#metadataLoaded = true;
    this.#deviceId = draft.deviceId;
    this.#accounts = draft.accounts;
    this.#accountActive = draft.accountActive;
    return { value, installed: true };
  }

  /**
   * Durably latch a cryptographically corrupt persisted base in the
   * corrupt-base state machine.
   *
   * Structural corruption is detected at parse time (the binding loads
   * with `baseCorrupt` already persisted). A structurally valid base
   * whose digest fails verification is detected only at the pre-merge
   * gate, so without a durable marker the service would re-attempt
   * verification forever. This stages an owner-scoped, copy-on-write
   * transition setting `baseCorrupt: true`, persists it, and only then
   * installs it — a failed save mutates nothing in memory and the
   * corruption error still propagates (the in-flight cycle performs zero
   * remote work either way). Callers park listeners/watchers/scheduler
   * after a successful latch so no further cloud work starts.
   */
  async #latchCorruptBinding(
    uid: string,
    localVaultId: string,
    identityGeneration: number,
    expectedBinding: VaultSyncBinding,
  ): Promise<boolean> {
    const ownsIdentity = (): boolean => {
      if (this.#disposed || this.#suspended) return false;
      if (this.#identityGeneration !== identityGeneration) return false;
      return (this.#account.snapshot().user?.id ?? null) === uid;
    };
    let mutated = false;
    const { installed } = await this.#commitMetadata({
      label: 'corrupt-base-latch',
      validateBefore: () => {
        if (!ownsIdentity()) {
          throw new VaultSyncError(
            'ACCOUNT_CHANGED',
            'account identity changed during sync; aborting cycle',
          );
        }
      },
      mutate: (draft) => {
        const bindings = draft.accounts.get(uid);
        const current = bindings?.get(localVaultId);
        if (bindings === undefined || current === undefined) return;
        // Only latch the exact binding this cycle verified as corrupt: a
        // concurrent repair/replacement (new object) already owns the
        // newer state, and re-marking it would undo that repair.
        if (current !== expectedBinding) return;
        bindings.set(localVaultId, { ...current, baseCorrupt: true });
        mutated = true;
      },
      validateAfterSave: ownsIdentity,
    });
    return installed && mutated;
  }

  /**
   * Bind an existing cloud vault to a local vault id.
   *
   * Identity is pinned for the ENTIRE operation:
   * the UID + authentication epoch captured before the HEAD read are
   * revalidated immediately after it, at lane entry, and again on both
   * sides of the durable save. A stale attach (A signs out / B signs in
   * while the HEAD read is in flight) aborts with `ACCOUNT_CHANGED` and
   * NEVER reaches `storage.save` — no phantom binding is written under
   * any account.
   */
  async attachRemoteVault(
    cloudVaultId: string,
    localVaultId: string,
  ): Promise<void> {
    if (cloudVaultId.length === 0 || localVaultId.length === 0) {
      throw new VaultSyncError(
        'UNKNOWN',
        'cloudVaultId and localVaultId must not be empty',
      );
    }
    const user = this.#requireUser();
    const owner = {
      uid: user.id,
      identityGeneration: this.#identityGeneration,
    };
    const shouldAbort = (): boolean =>
      this.#disposed ||
      this.#suspended ||
      this.#identityGeneration !== owner.identityGeneration ||
      (this.#account.snapshot().user?.id ?? null) !== owner.uid;
    // Replica/presentation ownership for post-commit effects (final
    // async-ownership pass): the durable binding may commit for a
    // non-visible vault, but phase/error/listeners/scheduler belong to
    // the attachment captured here.
    const replicaOwnerAtStart = this.#captureReplicaOwner(
      owner.uid,
      owner.identityGeneration,
    );
    const remote = createIdentityPinnedRemote(
      this.#remote,
      owner.uid,
      shouldAbort,
    );
    let head;
    try {
      head = await remote.readHead(cloudVaultId);
    } catch (error) {
      throw error instanceof VaultSyncError ? error : normalizeSyncError(error);
    }
    // Identity boundary immediately after the awaited read: a switch that
    // landed while the read was in flight must not reach the lane.
    if (shouldAbort()) {
      throw new VaultSyncError(
        'ACCOUNT_CHANGED',
        'account identity changed during attach; binding not installed',
      );
    }
    if (head === null) {
      throw new VaultSyncError(
        'REMOTE_NOT_FOUND',
        `cloud vault ${cloudVaultId} does not exist`,
      );
    }
    const ownsIdentity = (): boolean => !shouldAbort();
    const { installed } = await this.#commitMetadata({
      label: 'attach-remote',
      // Lane-entry gate: revalidate the captured auth epoch before any
      // staging. A stale attach never stages and never saves.
      validateBefore: () => {
        if (!ownsIdentity()) {
          throw new VaultSyncError(
            'ACCOUNT_CHANGED',
            'account identity changed during attach; binding not installed',
          );
        }
      },
      // Narrow ownership: only this account's binding for this local
      // vault (or the idempotent name refresh). The host-visible
      // selection is owned by `setActiveLocalVault()` only. The conflict
      // check runs against the fresh draft.
      mutate: (draft) => {
        const nextBindings =
          draft.accounts.get(owner.uid) ?? new Map<string, VaultSyncBinding>();
        draft.accounts.set(owner.uid, nextBindings);
        // A local vault that is already bound must never silently change
        // cloud identity through an attach side effect: rebinding one
        // local vault to a different cloud vault is an explicit
        // destructive/unlink workflow, not something `attachRemoteVault`
        // does. The idempotent same-cloud refresh below is preserved.
        const existingForLocal = nextBindings.get(localVaultId);
        if (
          existingForLocal !== undefined &&
          existingForLocal.cloudVaultId !== cloudVaultId
        ) {
          throw new VaultSyncError(
            'CONFLICT',
            `local vault ${localVaultId} is already bound to a different cloud vault`,
          );
        }
        for (const existing of nextBindings.values()) {
          if (existing.cloudVaultId !== cloudVaultId) continue;
          if (existing.localVaultId === localVaultId) {
            // Idempotent re-attach of the same replica: refresh the name
            // and resume (pulls on the next reconcile).
            nextBindings.set(localVaultId, {
              ...existing,
              name: head.name,
              enabled: true,
            });
            return;
          }
          throw new VaultSyncError(
            'CONFLICT',
            `cloud vault ${cloudVaultId} is already synced as another local vault on this device`,
          );
        }
        nextBindings.set(localVaultId, {
          cloudVaultId,
          localVaultId,
          name: head.name,
          deviceId: draft.deviceId,
          base: null,
          lastSyncedAt: null,
          lastRevision: null,
          enabled: true,
        });
      },
      validateAfterSave: ownsIdentity,
    });
    if (!installed) {
      throw new VaultSyncError(
        'ACCOUNT_CHANGED',
        'account identity changed during attach; binding not installed',
      );
    }
    // Fresh state established: a later restore() must not clobber it.
    this.#restored = true;
    // Post-commit runtime effects are replica-owned: a stale attach
    // completing after A→B keeps its durable binding but must not bump
    // B's epochs, clear B's telemetry, rewire B, or schedule B's work.
    // Emit always so the bindings list converges.
    const ownsAttachReplica =
      replicaOwnerAtStart !== null &&
      this.#isCurrentReplicaOwner(replicaOwnerAtStart) &&
      this.#attachedReplica?.localVaultId === localVaultId;
    if (!ownsAttachReplica) {
      this.#emit();
      return;
    }
    this.#operationGeneration += 1;
    this.#vaultGeneration += 1;
    this.#error = null;
    this.#phase = 'idle';
    // Presentation-state ownership: the host reports the opened vault via
    // `setActiveLocalVault()`; attaching a binding never rewrites the
    // host-visible selection.
    this.#wire();
    this.#emit();
    if (this.#liveReplicaContext() !== null) {
      this.#scheduler?.request();
    }
  }

  /**
   * Prepare the first materialization for Download & Open (transactional).
   * Verify HEAD → manifest (hash, revision,
   * vault) → downloads and hash-verifies every byte into `target` (a
   * fresh empty backing store the caller created) and returns the
   * verified base WITHOUT persisting any binding. The caller must
   * `activate()` the store and only then call
   * `finalizeMaterializedVault(prepared)`; activation failure,
   * cancellation, or a corrupt blob therefore leaves no binding behind
   * (the caller discards the temporary store via
   * `EmptyVaultStore.discard()`).
   * The remote manifest is materialized verbatim — never merged against
   * initialized workspace metadata — and the prepared base exactly
   * describes the bytes in the target (no workspace record is created
   * here; the host opens it after activation). The prepared handle
   * captures `owner uid + identityGeneration + cloud/local ids + name`
   * so finalization can prove prepare identity === finalize identity
   * with no further network read. Ordinary vault activation (detach/
   * attach, provider replacement) bumps operation/vault generations but
   * never identity — so a valid Download & Open survives its own
   * activation while any authentication epoch replacement invalidates it.
   */
  async materializeRemoteVault(
    cloudVaultId: string,
    localVaultId: string,
    target: VaultService,
  ): Promise<PreparedRemoteVault> {
    if (cloudVaultId.length === 0 || localVaultId.length === 0) {
      throw new VaultSyncError(
        'UNKNOWN',
        'cloudVaultId and localVaultId must not be empty',
      );
    }
    const user = this.#requireUser();
    const cycleUid = user.id;
    const cycleIdentity = this.#identityGeneration;
    const cycleGeneration = this.#operationGeneration;
    const shouldAbort = (): boolean =>
      this.#identityGeneration !== cycleIdentity ||
      this.#operationGeneration !== cycleGeneration ||
      this.#disposed ||
      this.#suspended ||
      (this.#account.snapshot().user?.id ?? null) !== cycleUid;
    // Identity-stable reads for the whole prepare (same guarantee as
    // reconcile cycles): an account switch mid-download aborts before
    // any further remote traffic, never binding B's namespace.
    const pinnedRemote = createIdentityPinnedRemote(
      this.#remote,
      cycleUid,
      shouldAbort,
    );
    if (this.#deviceId === null) this.#deviceId = generateDeviceId();
    const bindings = this.#bindingsFor(user.id);
    for (const existing of bindings.values()) {
      if (existing.cloudVaultId === cloudVaultId) {
        // A corrupt binding may be replaced by a fresh Download & Open
        // (Strategy A recovery): the verified materialized store becomes
        // the new binding at finalize time. A healthy binding still
        // refuses duplicate materialization.
        if (existing.baseCorrupt === true) continue;
        throw new VaultSyncError(
          'CONFLICT',
          `cloud vault ${cloudVaultId} is already materialized on this device; open the bound vault instead`,
        );
      }
    }
    if (bindings.has(localVaultId)) {
      throw new VaultSyncError(
        'CONFLICT',
        `local vault ${localVaultId} is already bound; open it instead of re-downloading`,
      );
    }
    let head;
    try {
      if (shouldAbort()) {
        throw new VaultSyncError(
          'ACCOUNT_CHANGED',
          'account identity changed during download',
        );
      }
      head = await pinnedRemote.readHead(cloudVaultId);
    } catch (error) {
      throw error instanceof VaultSyncError ? error : normalizeSyncError(error);
    }
    if (head === null) {
      throw new VaultSyncError(
        'REMOTE_NOT_FOUND',
        `cloud vault ${cloudVaultId} does not exist`,
      );
    }
    let manifest;
    try {
      if (shouldAbort()) {
        throw new VaultSyncError(
          'ACCOUNT_CHANGED',
          'account identity changed during download',
        );
      }
      manifest = await pinnedRemote.loadManifest(
        cloudVaultId,
        head.manifestHash,
        head.manifestObject,
      );
    } catch (error) {
      throw error instanceof VaultSyncError ? error : normalizeSyncError(error);
    }
    if (manifest.vaultId !== cloudVaultId) {
      throw new VaultSyncError(
        'CORRUPT_MANIFEST',
        `manifest vault ${manifest.vaultId} does not match vault ${cloudVaultId}`,
      );
    }
    if (manifest.revision !== head.revision) {
      throw new VaultSyncError(
        'CORRUPT_MANIFEST',
        `manifest revision ${manifest.revision} does not match HEAD revision ${head.revision}`,
      );
    }
    if ((await hashManifest(manifest)) !== head.manifestHash) {
      throw new VaultSyncError(
        'CORRUPT_MANIFEST',
        'manifest content does not match its HEAD hash',
      );
    }
    // The target must be a fresh empty store: materializing over
    // initialized workspace metadata would turn the first sync into a
    // three-way merge against local-only files.
    let existing: readonly { name: string }[];
    try {
      existing = await target.list(ROOT_PATH);
    } catch (error) {
      throw error instanceof VaultSyncError ? error : normalizeSyncError(error);
    }
    if (existing.length > 0) {
      throw new VaultSyncError(
        'CONFLICT',
        'download target is not empty; open the existing vault instead',
      );
    }
    // Shallowest-first so parents exist before children write.
    const files = manifest.entries
      .filter((entry) => entry.kind === 'file')
      .sort(
        (a, b) =>
          a.path.split('/').length - b.path.split('/').length ||
          (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
      );
    const dirs = manifest.entries
      .filter((entry) => entry.kind === 'directory')
      .map((entry) => entry.path)
      .sort(
        (a, b) =>
          a.split('/').length - b.split('/').length ||
          (a < b ? -1 : a > b ? 1 : 0),
      );
    const asPath = (value: string): WorkspacePath => value as WorkspacePath;
    try {
      for (const entry of files) {
        if (shouldAbort()) {
          throw new VaultSyncError(
            'ACCOUNT_CHANGED',
            'account identity changed during download',
          );
        }
        if (entry.kind !== 'file') continue;
        const bytes = await pinnedRemote.downloadBlob(
          cloudVaultId,
          entry.blob!,
        );
        await verifyBlob(bytes, entry.blob!);
        const parent = parentPath(asPath(entry.path));
        if (parent !== ROOT_PATH) await ensureDirectory(target, parent);
        await target.write(asPath(entry.path), bytes);
      }
      for (const dir of dirs) {
        await ensureDirectory(target, asPath(dir));
      }
    } catch (error) {
      // Failure binds nothing: the caller discards the partial target
      // and the account keeps no record of the attempt.
      throw error instanceof VaultSyncError ? error : normalizeSyncError(error);
    }
    if (shouldAbort()) {
      throw new VaultSyncError(
        'ACCOUNT_CHANGED',
        'account identity changed during download',
      );
    }
    // No binding yet — the host must activate() first, then finalize
    // with the prepared handle. The base exactly describes the verified
    // bytes in target; the name is captured now so finalization stays
    // local-only (no live HEAD re-read across the identity boundary).
    return {
      kind: 'prepared-remote-vault',
      cloudVaultId,
      localVaultId,
      name: head.name,
      base: { manifest, hash: head.manifestHash },
      owner: { uid: cycleUid, identityGeneration: cycleIdentity },
    };
  }

  /**
   * Finalize a prepared Download & Open after successful activation.
   * Local-only: validates the prepared owner identity (`uid +
   * identityGeneration`, never operation generation) against the live
   * authentication epoch and persists the binding transactionally
   * (copy-on-write — no live mutation before the durable save succeeds).
   * Any identity mismatch throws `ACCOUNT_CHANGED` with zero binding
   * mutation. No network read is performed; `name`/`base` come from the
   * prepared transaction captured at prepare time. Must only be called
   * after `activate()` resolved; activation failure/cancel must never
   * reach here.
   *
   * A local vault activation, runtime provider replacement, sync
   * detach/attach cycle, or workspace recreation between prepare and
   * finalize is VALID (identity unchanged). An account change — including
   * sign-out/sign-in back as the same UID (new epoch) — invalidates.
   */
  async finalizeMaterializedVault(
    prepared: PreparedRemoteVault,
  ): Promise<void> {
    const parsed = parsePreparedRemoteVault(prepared);
    if (parsed === null) {
      throw new VaultSyncError(
        'UNKNOWN',
        'invalid prepared download transaction',
      );
    }
    const { cloudVaultId, localVaultId, name, base, owner } = parsed;
    // Identity gate FIRST, before any state inspection or mutation: the
    // prepared owner epoch must still be live. This proves
    // prepare identity === finalize identity. Operation/vault generations
    // are deliberately NOT checked: normal activation bumps them.
    const liveUser = this.#account.snapshot().user;
    if (liveUser === null || liveUser.id !== owner.uid) {
      throw new VaultSyncError(
        'ACCOUNT_CHANGED',
        'account identity changed between download prepare and finalize; binding not created',
      );
    }
    if (
      this.#disposed ||
      this.#suspended ||
      this.#identityGeneration !== owner.identityGeneration
    ) {
      throw new VaultSyncError(
        'ACCOUNT_CHANGED',
        'account identity changed between download prepare and finalize; binding not created',
      );
    }
    // Re-resolve through the live UID (never trust a cached uid): the
    // checks above already proved it equals the prepared owner.
    // Serialized with every other durable metadata commit (the reconcile
    // lane never holds the metadata lane, so a running cycle stages from
    // fresh canonical state at commit time); identity is re-gated inside
    // the lane before staging and after the save.
    const user = this.#requireUser();
    if (user.id !== owner.uid) {
      throw new VaultSyncError(
        'ACCOUNT_CHANGED',
        'account identity changed between download prepare and finalize; binding not created',
      );
    }
    // The prepared handle is an opaque object at runtime: never trust the
    // TypeScript shape. Verify the base structurally AND
    // cryptographically before it can be persisted as a merge ancestor
    // Local-only: hashing performs no network I/O.
    let verifiedBase: SyncBase;
    try {
      const manifest = parseSyncManifest(base.manifest);
      if (!isManifestHash(base.hash)) {
        throw new Error('prepared base hash is malformed');
      }
      verifiedBase = { manifest, hash: base.hash };
    } catch (error) {
      throw new VaultSyncError(
        'CORRUPT_SYNC_METADATA',
        'prepared download base failed structural validation',
        { cause: error },
      );
    }
    await verifyPersistedSyncBase(verifiedBase, cloudVaultId);
    if (
      this.#disposed ||
      this.#suspended ||
      this.#identityGeneration !== owner.identityGeneration
    ) {
      throw new VaultSyncError(
        'ACCOUNT_CHANGED',
        'account identity changed between download prepare and finalize; binding not created',
      );
    }
    const ownsPreparedIdentity = (): boolean => {
      if (
        this.#disposed ||
        this.#suspended ||
        this.#identityGeneration !== owner.identityGeneration
      ) {
        return false;
      }
      const liveUid = this.#account.snapshot().user?.id ?? null;
      return liveUid !== null && liveUid === owner.uid;
    };
    // Replica/presentation ownership for post-commit effects: capture the
    // attachment BEFORE the durable save. Normal activation bumps
    // operation/vault generations, so those are deliberately NOT part of
    // the prepared-identity gate above — but post-commit presentation
    // still belongs to the live replica, never a stale one.
    const finalizeReplicaOwner = this.#captureReplicaOwner(
      owner.uid,
      owner.identityGeneration,
    );
    const { installed } = await this.#commitMetadata({
      label: 'finalize-download',
      validateBefore: () => {
        if (!ownsPreparedIdentity()) {
          throw new VaultSyncError(
            'ACCOUNT_CHANGED',
            'account identity changed between download prepare and finalize; binding not created',
          );
        }
      },
      // Narrow ownership: the new binding for the prepared local vault
      // under the prepared identity epoch. The host-visible selection is
      // owned exclusively by `setActiveLocalVault()`; finalization never
      // rewrites it. Other bindings/accounts are preserved from the fresh
      // lane-local draft.
      mutate: (draft) => {
        const nextBindings =
          draft.accounts.get(owner.uid) ?? new Map<string, VaultSyncBinding>();
        draft.accounts.set(owner.uid, nextBindings);
        for (const existing of [...nextBindings.values()]) {
          if (existing.cloudVaultId !== cloudVaultId) continue;
          // Strategy A recovery: a corrupt binding for this cloud vault is
          // replaced by the freshly materialized verified replica. The
          // old local vault remains a normal local vault (files intact,
          // simply unbound). A healthy binding still refuses duplicates.
          if (existing.baseCorrupt === true) {
            nextBindings.delete(existing.localVaultId);
            continue;
          }
          throw new VaultSyncError(
            'CONFLICT',
            `cloud vault ${cloudVaultId} is already materialized on this device; open the bound vault instead`,
          );
        }
        if (nextBindings.has(localVaultId)) {
          throw new VaultSyncError(
            'CONFLICT',
            `local vault ${localVaultId} is already bound; open it instead of re-downloading`,
          );
        }
        nextBindings.set(localVaultId, {
          cloudVaultId,
          localVaultId,
          name,
          deviceId: draft.deviceId,
          base,
          lastSyncedAt: new Date().toISOString(),
          lastRevision: base.manifest.revision,
          enabled: true,
        });
      },
      validateAfterSave: ownsPreparedIdentity,
    });
    if (!installed) {
      throw new VaultSyncError(
        'ACCOUNT_CHANGED',
        'account identity changed between download prepare and finalize; binding not created',
      );
    }
    this.#restored = true;
    // Post-commit runtime effects are replica-owned: a stale finalize
    // completing after A→B keeps its durable binding but must not bump
    // B's epochs, clear B's telemetry, rewire B, or schedule B's work.
    const ownsFinalizeReplica =
      finalizeReplicaOwner !== null &&
      this.#isCurrentReplicaOwner(finalizeReplicaOwner) &&
      this.#attachedReplica?.localVaultId === localVaultId;
    if (!ownsFinalizeReplica) {
      this.#emit();
      return;
    }
    this.#operationGeneration += 1;
    this.#vaultGeneration += 1;
    this.#error = null;
    this.#phase = 'idle';
    this.#wire();
    this.#emit();
    if (this.#liveReplicaContext() !== null) {
      this.#scheduler?.request();
    }
  }

  /**
   * Explicit recovery from a corrupt persisted merge base using the
   * corrupt-base state machine.
   *
   * Conservative verified-ancestor reconstruction: the operation reads
   * the remote HEAD and manifest through an identity-pinned scope,
   * structurally and cryptographically verifies them exactly like
   * Download & Open, and installs the verified base ONLY when this
   * replica's last synchronized revision equals the current remote
   * revision. That equality proves the verified remote manifest is the
   * ancestor this replica actually materialized, so merge semantics stay
   * truthful (local edits are genuine edits over that ancestor).
   *
   * When the cloud copy has advanced (or no synchronized revision is
   * known), installing the newer remote manifest while arbitrary local
   * content is retained would falsely claim those bytes were already
   * materialized locally — and degrading to `base: null` would run a
   * first-sync union that can delete or misclassify remote content. Both
   * are refused with `REMATERIALIZE_REQUIRED`; the safe recovery for that
   * case is Download & Open into a fresh store, which the UI directs the
   * user to.
   *
   * The repair is owner-scoped and copy-on-write: identity is revalidated
   * around the reads and around the durable save, a failed save mutates
   * nothing, and local files are never touched. After a successful repair
   * the marker is cleared and normal reconciliation resumes.
   */
  async repairCorruptBinding(): Promise<void> {
    const live = this.#liveReplicaContext();
    if (live === null) {
      throw new VaultSyncError(
        'NOT_CONFIGURED',
        'sync is not enabled for the open vault; open the synced vault to repair',
      );
    }
    // Immutable repair owner: the repair is pinned to the EXACT
    // binding it started against, not merely the account UID. A
    // same-account rebind, replacement, disable, or removal must
    // invalidate it before any verified base can be persisted; otherwise
    // a paused repair could install cloud X's base into a binding that
    // now points at cloud Y.
    const repairOwner = {
      uid: live.uid,
      identityGeneration: live.identityGeneration,
      operationGeneration: this.#operationGeneration,
      vaultGeneration: this.#vaultGeneration,
      localVaultId: live.localVaultId,
      cloudVaultId: live.cloudVaultId,
      lastRevision: live.binding.lastRevision,
      binding: live.binding,
    };
    const identityOwned = (): boolean =>
      !this.#disposed &&
      !this.#suspended &&
      this.#identityGeneration === repairOwner.identityGeneration &&
      (this.#account.snapshot().user?.id ?? null) === repairOwner.uid;
    const shouldAbort = (): boolean =>
      !identityOwned() ||
      this.#operationGeneration !== repairOwner.operationGeneration ||
      this.#vaultGeneration !== repairOwner.vaultGeneration;
    const binding = repairOwner.binding;
    const uid = repairOwner.uid;
    const localVaultId = repairOwner.localVaultId;
    const cloudVaultId = repairOwner.cloudVaultId;
    // Idempotent fast path: nothing corrupt, nothing to do.
    if (binding.baseCorrupt !== true && binding.base === null) return;
    if (binding.baseCorrupt !== true && binding.base !== null) {
      try {
        await verifyPersistedSyncBase(binding.base, cloudVaultId);
        return;
      } catch {
        // Structurally valid but cryptographically corrupt (not yet
        // latched): continue into verified reconstruction below.
      }
    }
    if (repairOwner.lastRevision === null) {
      throw new VaultSyncError(
        'REMATERIALIZE_REQUIRED',
        'no synchronized revision is recorded for this replica, so the damaged sync history cannot be rebuilt in place; download the cloud vault again',
      );
    }
    const remote = createIdentityPinnedRemote(this.#remote, uid, shouldAbort);
    let head;
    try {
      head = await remote.readHead(cloudVaultId);
    } catch (error) {
      throw error instanceof VaultSyncError ? error : normalizeSyncError(error);
    }
    if (shouldAbort()) {
      throw new VaultSyncError(
        'ACCOUNT_CHANGED',
        'account identity changed during repair; sync history not repaired',
      );
    }
    if (head === null) {
      throw new VaultSyncError(
        'REMOTE_NOT_FOUND',
        `cloud vault ${cloudVaultId} does not exist`,
      );
    }
    let manifest: SyncManifest;
    try {
      manifest = await remote.loadManifest(
        cloudVaultId,
        head.manifestHash,
        head.manifestObject,
      );
    } catch (error) {
      throw error instanceof VaultSyncError ? error : normalizeSyncError(error);
    }
    // The verified remote state must be structurally AND
    // cryptographically sound before any persistence; a corrupt cloud
    // copy is `CORRUPT_MANIFEST`, never a repaired base.
    let verifiedBase: SyncBase;
    try {
      const parsed = parseSyncManifest(manifest);
      if (!isManifestHash(head.manifestHash)) {
        throw new Error('remote manifest hash is malformed');
      }
      if (parsed.vaultId !== cloudVaultId) {
        throw new Error('remote manifest belongs to a different cloud vault');
      }
      if (parsed.revision !== head.revision) {
        throw new Error('remote manifest revision does not match HEAD');
      }
      if ((await hashManifest(parsed)) !== head.manifestHash) {
        throw new Error('remote manifest content does not match its hash');
      }
      verifiedBase = { manifest: parsed, hash: head.manifestHash };
    } catch (error) {
      throw new VaultSyncError(
        'CORRUPT_MANIFEST',
        'verified cloud state failed validation during repair',
        { cause: error },
      );
    }
    if (shouldAbort()) {
      throw new VaultSyncError(
        'ACCOUNT_CHANGED',
        'account identity changed during repair; sync history not repaired',
      );
    }
    // Ancestor proof: only a remote at exactly the last revision this
    // replica synchronized to can truthfully replace the corrupt base.
    if (repairOwner.lastRevision !== head.revision) {
      throw new VaultSyncError(
        'REMATERIALIZE_REQUIRED',
        'the cloud copy has advanced since this device last synced, so the damaged sync history cannot be rebuilt in place; download the cloud vault again',
      );
    }
    const ownsRepair = (): boolean => !shouldAbort();
    const { installed } = await this.#commitMetadata({
      label: 'repair-corrupt-base',
      validateBefore: () => {
        if (!ownsRepair()) {
          throw new VaultSyncError(
            'ACCOUNT_CHANGED',
            'account identity changed during repair; sync history not repaired',
          );
        }
      },
      mutate: (draft) => {
        const bindings = draft.accounts.get(uid);
        const current = bindings?.get(localVaultId);
        if (bindings === undefined || current === undefined) {
          throw new VaultSyncError(
            'NOT_CONFIGURED',
            'the synced binding disappeared during repair',
          );
        }
        // Binding-stability proof: generation checks are NOT
        // sufficient evidence of binding contents inside the lane, so
        // inspect the FRESH binding before installing the verified base.
        // A rebind to another cloud vault, a replacement, or an already
        // repaired binding must never receive cloud X's verified base.
        if (
          current.localVaultId !== repairOwner.localVaultId ||
          current.cloudVaultId !== repairOwner.cloudVaultId ||
          current.lastRevision !== repairOwner.lastRevision ||
          current.baseCorrupt !== true
        ) {
          throw new VaultSyncError(
            'CONFLICT',
            'the synced binding changed during repair; sync history not repaired',
          );
        }
        // Explicit owner-scoped rebuild: replace ONLY this replica's
        // base/lastRevision and clear the corrupt marker. Name, device,
        // enabled state, lastSyncedAt, and every other binding/account
        // are preserved from the fresh lane-local draft.
        bindings.set(localVaultId, {
          cloudVaultId: current.cloudVaultId,
          localVaultId: current.localVaultId,
          name: current.name,
          deviceId: current.deviceId,
          base: verifiedBase,
          lastSyncedAt: current.lastSyncedAt,
          lastRevision: head.revision,
          enabled: current.enabled,
        });
      },
      validateAfterSave: ownsRepair,
    });
    if (!installed) {
      throw new VaultSyncError(
        'ACCOUNT_CHANGED',
        'account identity changed during repair; sync history not repaired',
      );
    }
    // The durable repair stands, but a lifecycle/suspension/replica
    // transition that landed during the save owns the new replica's
    // presentation: publish nothing into it. Identity alone is NOT
    // sufficient — a same-UID A→B switch keeps the UID/identity epoch
    // while changing operation/vault epochs and the live binding.
    if (!ownsRepair()) return;
    {
      const current = this.#liveReplicaContext();
      if (
        current === null ||
        current.uid !== repairOwner.uid ||
        current.localVaultId !== repairOwner.localVaultId ||
        current.cloudVaultId !== repairOwner.cloudVaultId
      ) {
        return;
      }
    }
    this.#operationGeneration += 1;
    this.#vaultGeneration += 1;
    this.#error = null;
    this.#phase = 'idle';
    this.#wire();
    this.#emit();
    if (this.#liveReplicaContext() !== null) {
      this.#scheduler?.request();
    }
  }

  /** True when the cloud vault is already bound under the current account. */
  isCloudVaultBound(cloudVaultId: string): boolean {
    if (this.#currentUid === null) return false;
    const bindings = this.#accounts.get(this.#currentUid);
    if (bindings === undefined) return false;
    for (const binding of bindings.values()) {
      if (binding.cloudVaultId === cloudVaultId) return true;
    }
    return false;
  }

  #requireUser(): { id: string } {
    const user = this.#account.snapshot().user;
    if (user === null) {
      throw new VaultSyncError('NOT_AUTHENTICATED', 'sign in before syncing');
    }
    return user;
  }

  #emit(): void {
    const snapshot = this.snapshot();
    for (const listener of [...this.#listeners]) {
      try {
        listener(snapshot);
      } catch {
        // Listener failures must never break sync dispatch.
      }
    }
  }

  #recordError(error: unknown, owns?: () => boolean): VaultSyncError {
    const normalized =
      error instanceof VaultSyncError ? error : normalizeSyncError(error);
    // Ownership gate: a terminal result from a stale cycle/replica
    // must never be published into the new replica's snapshot. When the
    // caller proves the owning epoch is gone, the error is swallowed as a
    // stale completion (returned normalized, nothing recorded/emitted).
    if (owns !== undefined && !owns()) {
      return normalized;
    }
    // A Rules denial is never recorded as a generic error when the
    // entitlement mapping applies: the caller (`#cycle`, `#autoCycle`,
    // watcher) already set the explicit waiting/error state. Recording
    // here would clobber `waiting-for-entitlement` back to `error`.
    if (
      normalized.code === 'PERMISSION_DENIED' ||
      normalized.code === 'ENTITLEMENT_PENDING' ||
      normalized.code === 'PRO_REQUIRED'
    ) {
      return normalized;
    }
    this.#error = normalized;
    this.#phase = 'error';
    this.#emit();
    return normalized;
  }

  /** Client Pro state gates UI only; absent purchases means unknown (never Pro). */
  #isClientPro(): boolean {
    try {
      const customer = this.#purchases?.snapshot().customer ?? null;
      return hasFroglightPro(customer);
    } catch {
      return false;
    }
  }

  /**
   * Trusted server claim check. `force=true` mints a fresh ID
   * token so a just-propagated extension claim becomes visible; `false`
   * reads the cached token. Returns false on transient failures (network)
   * so a blip never flips the UI to "needs purchase"; auth/config
   * failures propagate.
   */
  async #hasServerPro(force: boolean): Promise<boolean> {
    const state = await this.#account.refreshToken(force);
    return hasServerEntitlement(state, 'pro');
  }

  /**
   * Classify a Rules denial onto the explicit entitlement states WITHOUT
   * mutating sync presentation (final async-ownership pass, pure).
   * Returns `ENTITLEMENT_PENDING` (activating) when the client is Pro but
   * the server claim is still missing, `PRO_REQUIRED` when neither side
   * is Pro, and the original `PERMISSION_DENIED` otherwise (server Pro
   * but still denied — e.g. wrong-UID path). Never bypasses Rules: this
   * only labels the failure for UI.
   *
   * Account-claim classification stays UID/auth-epoch-owned (claims are
   * account-scoped): the caller supplies the `(uid, identityGeneration)`
   * whose failure is being classified, revalidated after the awaited
   * claim read so one account's failure is never classified against
   * another account's Firebase claim or RevenueCat purchase state.
   *
   * Publishing the result into `#phase`/`#error` is replica-owned and
   * belongs to the CALLER: after `await` it must revalidate FULL
   * replica/presentation ownership (`ownsCyclePresentation` or the
   * watcher subscription owner) before mutating or emitting. A stale A
   * classifier finishing after a same-UID A→B switch therefore returns a
   * value the caller discards — it can never publish
   * `ENTITLEMENT_PENDING`/`PRO_REQUIRED` into B.
   */
  async #classifyPermissionDenied(
    cause: VaultSyncError,
    owner: IdentityOwner,
  ): Promise<VaultSyncError> {
    if (!this.#isOwnedIdentity(owner)) return cause;
    let serverPro = false;
    try {
      serverPro = await this.#hasServerPro(false);
    } catch {
      serverPro = false;
    }
    if (!this.#isOwnedIdentity(owner)) return cause;
    if (serverPro) return cause;
    if (this.#isClientPro()) {
      return new VaultSyncError(
        'ENTITLEMENT_PENDING',
        'Pro purchase is activating on the server; sync will begin automatically',
        { cause },
      );
    }
    return new VaultSyncError(
      'PRO_REQUIRED',
      'Froglight Pro is required for cloud sync',
      { cause },
    );
  }

  /**
   * Publish a classified permission-denial result into sync presentation.
   * Caller must have already proven FULL replica/presentation ownership;
   * this helper performs no ownership checks itself.
   */
  #publishPermissionDenied(mapped: VaultSyncError): void {
    if (mapped.code === 'ENTITLEMENT_PENDING') {
      this.#error = mapped;
      this.#phase = 'waiting-for-entitlement';
      this.#emit();
      return;
    }
    if (mapped.code === 'PRO_REQUIRED') {
      this.#error = mapped;
      this.#phase = 'error';
      this.#emit();
    }
  }

  /**
   * Low-level whole-envelope durable write of the CURRENT in-memory state.
   * MUST only run inside the serialized metadata lane
   * (`#withMetadataLane`).
   * Used only where no narrow mutation applies (initial boot, signed-out
   * supersede after an account transition); all owner-scoped transitions
   * go through `#commitMetadata`/`#commitMetadataInLane` instead.
   */
  async #persist(): Promise<void> {
    if (this.#deviceId === null) this.#deviceId = generateDeviceId();
    const accounts: Record<string, AccountSyncState> = {};
    for (const [uid, bindings] of this.#accounts) {
      const packed: Record<string, VaultSyncBinding> = {};
      for (const [localVaultId, binding] of bindings) {
        packed[localVaultId] = { ...binding };
      }
      accounts[uid] = {
        bindings: packed,
        activeLocalVaultId: this.#accountActive.get(uid) ?? null,
      };
    }
    await this.#storage.save({
      version: 1,
      deviceId: this.#deviceId,
      accounts,
    });
  }

  /**
   * Ensure a live scheduler and wire listeners for the live replica.
   * Suspension is owned by authentication transitions and is NEVER
   * cleared here: `attach`, vault replacement, binding enable,
   * `setActiveLocalVault`, workspace recreation, and runtime attachment
   * reactivation all call `#wire()` and must leave sign-out teardown
   * armed.
   */
  #wire(): void {
    this.#ensureScheduler();
    // A corrupt persisted base is a parked state, not a crash: surface
    // the explicit metadata error on the snapshot (local vaults remain
    // fully usable) and attach nothing.
    const live = this.#liveReplicaContext();
    if (live !== null && live.binding.baseCorrupt === true) {
      this.#error = new VaultSyncError(
        'CORRUPT_SYNC_METADATA',
        'persisted sync base failed validation; cloud reconciliation is parked until the local sync base is rebuilt from verified remote state',
      );
      this.#phase = 'error';
    }
    this.#attachListeners();
  }

  /**
   * The one explicit authenticated resume. Clears suspension only when a
   * valid signed-in auth epoch is established through the account feed
   * (see `#onAccountChange`). Never called from attach/binding/UI paths.
   */
  #resumeAfterAuthenticatedIdentity(): void {
    if (this.#disposed) return;
    this.#suspended = false;
    this.#wire();
  }

  /** Park listeners and reset the scheduler; memory state is kept. */
  #unwire(): void {
    this.#detachListeners();
    if (this.#scheduler !== null) {
      this.#scheduler.dispose();
      this.#scheduler = null;
    }
  }

  #ensureScheduler(): void {
    if (this.#scheduler !== null && !this.#scheduler.disposed) return;
    // Scheduler ownership (final async-ownership pass): `dispose()` cannot
    // cancel an in-flight Promise, so an old scheduler's `#autoCycle()`
    // may still reject after A→B. `#autoCycle()` itself handles every
    // owner-aware failure and resolves normally; this hook is reserved for
    // unexpected programming failures and must never let a stale rejection
    // overwrite the current replica. Capture the attachment epoch here
    // and record only while it still owns the live replica.
    const liveAtCreate = this.#liveReplicaContext();
    const schedulerOwner: ReplicaOwner | null =
      liveAtCreate === null
        ? null
        : {
            uid: liveAtCreate.uid,
            identityGeneration: liveAtCreate.identityGeneration,
            operationGeneration: this.#operationGeneration,
            vaultGeneration: this.#vaultGeneration,
            localVaultId: liveAtCreate.localVaultId,
            cloudVaultId: liveAtCreate.cloudVaultId,
            vault: liveAtCreate.vault,
          };
    this.#scheduler = new SyncScheduler(() => this.#autoCycle(), {
      debounceMs: this.#debounceMs,
      onError: (error) => {
        try {
          // No live replica at creation and none now: nothing user-visible
          // to mutate — contain without publishing.
          if (schedulerOwner === null) {
            if (this.#liveReplicaContext() !== null) return;
            return;
          }
          if (!this.#isCurrentReplicaOwner(schedulerOwner)) return;
          this.#recordError(error, () =>
            this.#isCurrentReplicaOwner(schedulerOwner),
          );
        } catch {
          // Error reporting must never break the scheduler.
        }
      },
    });
  }

  #attachListeners(): void {
    this.#detachListeners();
    // Single eligibility predicate: signed in + not suspended/disposed +
    // attached replica + enabled binding for EXACTLY the attached id.
    const live = this.#liveReplicaContext();
    if (live === null || live.binding.baseCorrupt === true) return;
    const capturedUid = live.uid;
    const capturedIdentity = live.identityGeneration;
    const capturedLocalVaultId = live.localVaultId;
    const capturedVault = live.vault;
    const capturedVaultGeneration = this.#vaultGeneration;
    this.#mutationUnsub = capturedVault.onMutation(
      (mutation: VaultMutation) => {
        // Defense in depth: an observable that emits after detach must
        // never touch the new replica's telemetry or scheduler.
        const current = this.#liveReplicaContext();
        if (current === null) return;
        if (
          current.uid !== capturedUid ||
          current.localVaultId !== capturedLocalVaultId ||
          current.vault !== capturedVault ||
          this.#vaultGeneration !== capturedVaultGeneration ||
          this.#identityGeneration !== capturedIdentity
        ) {
          return;
        }
        for (const path of mutationPaths(mutation)) {
          this.#mutatedPaths.add(path);
        }
        this.#pendingChanges += 1;
        this.#emit();
        this.#scheduler?.request();
      },
    );
    this.#attachWatcher();
  }

  #attachWatcher(): void {
    this.#detachWatcher();
    const live = this.#liveReplicaContext();
    if (live === null) return;
    if (live.binding.baseCorrupt === true) return;
    const capturedUid = live.uid;
    const capturedIdentity = live.identityGeneration;
    const capturedOperation = this.#operationGeneration;
    const capturedLocalVaultId = live.localVaultId;
    const capturedCloudVaultId = live.cloudVaultId;
    const capturedVaultGeneration = this.#vaultGeneration;
    const identityOwner: IdentityOwner = {
      uid: capturedUid,
      identityGeneration: capturedIdentity,
    };
    const ownsWatcher = (): boolean => {
      if (
        !this.#isOwnedIdentity(identityOwner) ||
        this.#operationGeneration !== capturedOperation ||
        this.#vaultGeneration !== capturedVaultGeneration
      ) {
        return false;
      }
      const current = this.#liveReplicaContext();
      return (
        current !== null &&
        current.uid === capturedUid &&
        current.localVaultId === capturedLocalVaultId &&
        current.cloudVaultId === capturedCloudVaultId
      );
    };
    try {
      // UID-scoped watcher: production Firebase uses the immutable
      // `forUid(uid)` namespace so a callback can never be delivered for
      // another account's HEAD. Providers without it fall back to the
      // shared remote plus the replica guard below. Both HEAD and error
      // callbacks capture the SAME subscription ownership; a stale error
      // (queued before A→B, delivered after) returns without
      // error, refreshing entitlements, or emitting state.
      const scoped =
        typeof this.#remote.forUid === 'function'
          ? this.#remote.forUid(capturedUid)
          : this.#remote;
      this.#watchUnsub = scoped.watchHead(
        capturedCloudVaultId,
        () => {
          if (!ownsWatcher()) return;
          this.#scheduler?.request();
        },
        (error: unknown) => {
          try {
            void this.#handleWatcherError(error, identityOwner, ownsWatcher);
          } catch {
            // Error reporting must never break the watcher.
          }
        },
      );
    } catch (error) {
      // Benign race (sign-out landed mid-attach): steady state converges
      // through account events. Anything else resurfaces on reconcile.
      // Owner-gated so a stale attach failure never publishes into the
      // replacement replica.
      this.#recordError(error, ownsWatcher);
    }
  }

  /**
   * Subscription-owned watcher failure (final async-ownership pass).
   * `ownsWatcher` proves the subscription still belongs to the live
   * replica; when stale it returns before classification, refresh,
   * or emit. A current `PERMISSION_DENIED` is classified
   * purely, then published only after revalidating the same ownership —
   * so vault A's denial can never become vault B's entitlement state,
   * even under the same UID.
   */
  async #handleWatcherError(
    error: unknown,
    identityOwner: IdentityOwner,
    ownsWatcher: () => boolean,
  ): Promise<void> {
    const normalized =
      error instanceof VaultSyncError ? error : normalizeSyncError(error);
    if (!ownsWatcher()) return;
    if (normalized.code !== 'PERMISSION_DENIED') {
      this.#recordError(normalized, ownsWatcher);
      return;
    }
    const mapped = await this.#classifyPermissionDenied(
      normalized,
      identityOwner,
    );
    if (!ownsWatcher()) return;
    this.#publishPermissionDenied(mapped);
    // Non-entitlement denials (server Pro but still denied) stay
    // unrecorded here like reconcile: they surface authoritatively on
    // the next reconcile without clobbering waiting states.
  }

  #detachWatcher(): void {
    try {
      this.#watchUnsub?.();
    } catch {
      // Detach is best-effort.
    }
    this.#watchUnsub = null;
  }

  #detachListeners(): void {
    try {
      this.#mutationUnsub?.();
    } catch {
      // Detach is best-effort.
    }
    this.#mutationUnsub = null;
    this.#detachWatcher();
  }

  #onAccountChange(): void {
    const uid = this.#account.snapshot().user?.id ?? null;
    if (uid === this.#lastUid) return;
    // The outgoing replica stays writable while its mutation coverage is
    // parked (signed-out parking, or A parked while B is live): its cache
    // must not survive for a later resume under the same UID.
    const previousUid = this.#currentUid;
    const previousReplica = this.#attachedReplica;
    if (previousUid !== null && previousReplica !== null) {
      this.#invalidateScanCache(previousUid, previousReplica.localVaultId);
    }
    this.#lastUid = uid;
    // Any identity replacement aborts in-flight work: entitlement waits
    // (checked per attempt) AND active reconciles (pinned remote +
    // engine shouldAbort before every side effect). Bumping here
    // guarantees a stale A cycle can never write under B even if it
    // lingers past the switch. Identity bumps on EVERY UID discontinuity
    // (A→B, A→null, null→A) so a sign-out/sign-in back as the same UID
    // still starts a new authentication epoch and invalidates old
    // prepared tokens (UID equality alone is insufficient).
    this.#entitlementGeneration += 1;
    this.#operationGeneration += 1;
    this.#vaultGeneration += 1;
    this.#identityGeneration += 1;
    // Pending counts are per-account telemetry (never an authoritative
    // queue): a switch resets them so B never inherits A's unsynced
    // count. Mutation hints, deferred display, phase, and error are
    // likewise scoped to the old identity: A's network/conflict/error
    // presentation must never leak into B's snapshot. `#wire()` below
    // re-establishes valid state (e.g. CORRUPT_SYNC_METADATA) for the
    // newly live binding.
    this.#resetTransientPresentation();
    // Switch the live UID scope: UID A's bindings are never interpreted
    // under UID B (each account partition stands alone). Sign-out parks
    // but deletes nothing; the previous account's bindings, bases, and
    // remembered active vault all survive for the next sign-in.
    this.#currentUid = uid;
    if (uid !== null) this.#lastActiveUid = uid;
    if (uid === null) {
      // Signed out: stop ALL cloud listening and scheduling. The next
      // sign-in resumes explicitly through the authenticated path below.
      this.#unwire();
      this.#emit();
      // Serialized supersede: if a stale finalize/commit wrote S1 durably
      // while this switch landed, this S0 persist (queued behind the lane)
      // overwrites it so durable never retains a phantom binding that
      // memory rejected. Best-effort; next boot reconstructs anyway.
      if (this.#metadataLoaded) {
        void this.#withMetadataLane(() => this.#persist()).catch(
          () => undefined,
        );
      }
      return;
    }
    // Sign-in (including A → B replacement): the ONLY authenticated
    // resume path clears suspension and re-wires (recreating the
    // scheduler when sign-out/suspend disposed it); the next reconcile
    // re-evaluates the fresh identity. No attached replica or no binding
    // for it simply parks.
    this.#resumeAfterAuthenticatedIdentity();
    if (this.#liveReplicaContext() !== null) {
      this.#scheduler?.request();
    }
    this.#emit();
    if (this.#metadataLoaded) {
      void this.#withMetadataLane(() => this.#persist()).catch(() => undefined);
    }
  }

  /**
   * Durable-metadata lane. Actual invariant:
   *
   * - Durable `StoredSyncState` writes are totally ordered: every write
   *   runs `stage draft → persist → validate lifecycle ownership →
   *   install` while holding this mutex, so an older save can never
   *   overwrite a newer durable snapshot out of order and a stale
   *   transition never reinstalls staged memory after a newer lifecycle
   *   transition.
   * - Runtime attachment/generation state is deliberately NOT serialized
   *   here: attach/detach, `setActiveLocalVault`, and account/suspend
   *   transitions invalidate operation/vault/identity generations
   *   synchronously, OUTSIDE the lane, so stale protocol work aborts at
   *   its next boundary immediately instead of waiting for a queued write.
   * - Long-running protocol work (reconcile network calls, blob
   *   transfers, CAS) NEVER holds this mutex: those go through
   *   `#withReconcileLane`. A hung remote call therefore cannot poison
   *   metadata mutation for a later authentication epoch.
   * - Ordinary document saves never wait here — this lane serializes sync
   *   replica metadata only.
   *
   * Every waiter observes its own run.
   */
  async #withMetadataLane<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.#metadataChain;
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#metadataChain = previous.then(
      () => mine,
      () => mine,
    );
    await previous.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Reconcile single-flight lane, abandonable by authentication epoch.
   *
   * - Same `(identityGeneration, operationGeneration)` epoch: the new run
   *   waits for the current tail, so auto and manual reconciles for one
   *   live replica never overlap.
   * - Different epoch (sign-out/sign-in, suspend, attach/detach, binding
   *   replacement, disable): the stale tail is abandoned immediately and
   *   the new run starts without waiting. The stale run's generations are
   *   already invalid, so its pinned remote aborts every further remote
   *   side effect and its commits fail ownership validation — it may
   *   linger forever without holding back the new epoch.
   * - A queued invocation is bound to the epoch in which it ENTERED the
   *   lane: after waiting for its predecessor it revalidates
   *   that epoch and, when stale (account switch, suspend, dispose,
   *   attach/detach, binding replacement), is suppressed WITHOUT invoking
   *   the callback at all. A request queued under A therefore can never
   *   wake later and execute its callback (which would re-capture the
   *   CURRENT `#cycle` context) as replica B.
   *
   * Never awaited by `prepareForSignOut()` and never held across metadata
   * persistence: a hung network call cannot block B's bind/reconcile or
   * the durable-metadata lane.
   */
  async #withReconcileLane<T>(fn: () => Promise<T>): Promise<T | undefined> {
    const identityGeneration = this.#identityGeneration;
    const operationGeneration = this.#operationGeneration;
    const tail = this.#reconcileTail;
    const sameEpoch =
      tail !== null &&
      tail.identityGeneration === identityGeneration &&
      tail.operationGeneration === operationGeneration;
    const previous = sameEpoch ? tail.promise : Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.#reconcileTail = {
      identityGeneration,
      operationGeneration,
      promise: previous.then(
        () => mine,
        () => mine,
      ),
    };
    await previous.catch(() => undefined);
    // Stale queued work is suppressed at the lane primitive itself, so
    // every caller receives the same guarantee: it never invokes the
    // callback, never starts a cycle, and quietly resolves.
    if (!this.#isCurrentEpoch(identityGeneration, operationGeneration)) {
      release();
      return undefined;
    }
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /** True while `(identityGeneration, operationGeneration)` is still live. */
  #isCurrentEpoch(
    identityGeneration: number,
    operationGeneration: number,
  ): boolean {
    return (
      !this.#disposed &&
      !this.#suspended &&
      this.#identityGeneration === identityGeneration &&
      this.#operationGeneration === operationGeneration
    );
  }

  /** Identity-only liveness for account-scoped async classification. */
  #isOwnedIdentity(owner: IdentityOwner): boolean {
    if (this.#disposed || this.#suspended) return false;
    if (this.#identityGeneration !== owner.identityGeneration) return false;
    return (this.#account.snapshot().user?.id ?? null) === owner.uid;
  }

  /**
   * Full replica/presentation ownership (final async-ownership pass).
   * True only while the captured disable/enable/attach/finalize/repair
   * target still describes the CURRENT attachment: same UID + identity
   * epoch, same operation/vault epochs, same `localVaultId`, same vault
   * object, and (when the capture named a cloud vault) the same cloud
   * binding. Durable commits may land for a non-visible vault; this
   * gates only transient presentation and listener lifecycle.
   */
  #isCurrentReplicaOwner(owner: ReplicaOwner): boolean {
    if (this.#disposed || this.#suspended) return false;
    if (this.#identityGeneration !== owner.identityGeneration) return false;
    if (this.#operationGeneration !== owner.operationGeneration) return false;
    if (this.#vaultGeneration !== owner.vaultGeneration) return false;
    if ((this.#account.snapshot().user?.id ?? null) !== owner.uid) return false;
    if (this.#currentUid !== owner.uid) return false;
    const attached = this.#attachedReplica;
    if (attached === null) return false;
    if (owner.vault === null) return false;
    if (attached.localVaultId !== owner.localVaultId) return false;
    if (attached.vault !== owner.vault) return false;
    if (owner.cloudVaultId !== null) {
      const currentCloud =
        this.#accounts.get(owner.uid)?.get(owner.localVaultId)?.cloudVaultId ??
        null;
      if (currentCloud !== owner.cloudVaultId) return false;
    }
    return true;
  }

  /**
   * Disable-failure recovery ownership: the parked replica may be rewired
   * only while it still owns the runtime attachment AND its binding is
   * still enabled. Reuses the full replica/presentation ownership model
   * (`#isCurrentReplicaOwner` proves same UID, same auth epoch, same
   * operation/vault epochs expected for this disable transition, same
   * `localVaultId`, same vault instance, same cloud binding, not
   * suspended/disposed) plus the durable enabled check: the failed save
   * rolled back, so recovery runs only when the binding still reports
   * `enabled === true`.
   */
  #isDisableRecoveryOwned(owner: ReplicaOwner): boolean {
    if (!this.#isCurrentReplicaOwner(owner)) return false;
    const binding = this.#accounts.get(owner.uid)?.get(owner.localVaultId);
    if (binding === undefined) return false;
    return binding.enabled === true;
  }

  /** Capture the current attachment as a replica owner (null when detached). */
  #captureReplicaOwner(
    uid: string,
    identityGeneration: number,
  ): ReplicaOwner | null {
    const attached = this.#attachedReplica;
    if (attached === null) return null;
    const cloudVaultId =
      this.#accounts.get(uid)?.get(attached.localVaultId)?.cloudVaultId ?? null;
    return {
      uid,
      identityGeneration,
      operationGeneration: this.#operationGeneration,
      vaultGeneration: this.#vaultGeneration,
      localVaultId: attached.localVaultId,
      cloudVaultId,
      vault: attached.vault,
    };
  }

  /**
   * Reset replica-owned transient presentation on an identity/replica
   * ownership transition: pending telemetry, mutation hints,
   * deferred display, phase, and error all describe the PREVIOUS replica
   * and must never leak into the new one. `#wire()` immediately
   * re-establishes any valid replica-owned state (for example
   * `CORRUPT_SYNC_METADATA` when the newly live binding is corrupt).
   * Host-visible selection memory is deliberately untouched here:
   * `setActiveLocalVault()` remains its only writer.
   */
  #resetTransientPresentation(): void {
    this.#pendingChanges = 0;
    this.#mutatedPaths.clear();
    this.#lastDeferred = new Set();
    this.#phase = 'idle';
    this.#error = null;
  }

  async #autoCycle(): Promise<void> {
    // One predicate for eligibility; the cycle repeats the check after
    // entering the reconcile lane in case attachment changed while
    // queued. A corrupt persisted base parks automatic work entirely:
    // manual reconcile surfaces the explicit metadata error instead.
    const live = this.#liveReplicaContext();
    if (live === null || live.binding.baseCorrupt === true) return;
    const owner: IdentityOwner = {
      uid: live.uid,
      identityGeneration: live.identityGeneration,
    };
    const cycleGeneration = this.#operationGeneration;
    const cycleVaultGeneration = this.#vaultGeneration;
    const ownsPresentation = (): boolean => {
      if (
        !this.#isOwnedIdentity(owner) ||
        this.#operationGeneration !== cycleGeneration ||
        this.#vaultGeneration !== cycleVaultGeneration
      ) {
        return false;
      }
      const current = this.#liveReplicaContext();
      return (
        current !== null &&
        current.localVaultId === live.localVaultId &&
        current.cloudVaultId === live.cloudVaultId
      );
    };
    try {
      await this.#withReconcileLane(() => this.#cycle());
    } catch (error) {
      // Stale completions are swallowed here too: `#cycle` already gates
      // its own publications, and this catch must not reintroduce them.
      if (!ownsPresentation()) return;
      const normalized =
        error instanceof VaultSyncError ? error : normalizeSyncError(error);
      // `#cycle` already classified denials; an unmapped denial reaching
      // here (e.g. watcher-triggered races) gets the same pure treatment.
      // Classification itself never publishes: the result is published
      // below only while FULL replica/presentation ownership still holds
      // (a same-UID A→B switch invalidates even though identity matches),
      // and `#recordError` must not clobber waiting states (guarded there).
      if (normalized.code === 'PERMISSION_DENIED') {
        try {
          const mapped = await this.#classifyPermissionDenied(
            normalized,
            owner,
          );
          if (!ownsPresentation()) return;
          this.#publishPermissionDenied(mapped);
          throw mapped;
        } catch (mappedError) {
          if (!ownsPresentation()) return;
          this.#recordError(mappedError);
          return;
        }
      }
      this.#recordError(error, ownsPresentation);
    }
  }

  async #cycle(): Promise<void> {
    // Parked or suspended reconciles are no-ops (never an error): no
    // attached replica, no binding for exactly that replica, signed out,
    // or sign-out teardown armed.
    const context = this.#liveReplicaContext();
    if (context === null) return;
    const binding = context.binding;
    const vault = context.vault;
    // Identity+replica-stable capture (separate lifetimes): the whole
    // multi-step protocol operates under one immutable authentication
    // epoch AND vault identity. Any sign-out, account switch (including
    // same-UID re-sign-in), suspend/dispose (identity), binding
    // replacement, or vault attach/detach (operation/vault) bumps a
    // generation and aborts before the next remote side effect or
    // workspace callback — an operation started for (A, vault A) never
    // writes under B nor invokes B's workspace reconciler. Reconcile
    // captures uid + identity + operation + vault + cloud/local ids and
    // aborts if the live replica no longer matches.
    const cycleUid = context.uid;
    const cycleIdentity = context.identityGeneration;
    const cycleGeneration = this.#operationGeneration;
    const cycleVaultGeneration = this.#vaultGeneration;
    const cycleCloudVaultId = context.cloudVaultId;
    const cycleLocalVaultId = context.localVaultId;
    const shouldAbort = (): boolean =>
      this.#disposed ||
      this.#identityGeneration !== cycleIdentity ||
      this.#operationGeneration !== cycleGeneration ||
      this.#vaultGeneration !== cycleVaultGeneration ||
      (this.#account.snapshot().user?.id ?? null) !== cycleUid ||
      this.#suspended;
    const liveReplicaMatches = (): boolean => {
      const live = this.#liveReplicaContext();
      return (
        live !== null &&
        live.uid === cycleUid &&
        live.cloudVaultId === cycleCloudVaultId &&
        live.localVaultId === cycleLocalVaultId &&
        this.#currentUid === cycleUid
      );
    };
    const cycleOwner: IdentityOwner = {
      uid: cycleUid,
      identityGeneration: cycleIdentity,
    };
    /**
     * Transient publication ownership: the cycle may touch
     * phase/error/pending/deferred presentation only while it still owns
     * the live replica AND its generation epoch. A stale A cycle
     * finishing after a switch to B (success, NETWORK,
     * PERMISSION_DENIED, LOCAL_CHANGED, progress, workspace failure)
     * publishes nothing into B's snapshot and never schedules B's
     * scheduler as a consequence of old work.
     */
    const ownsCyclePresentation = (): boolean =>
      !shouldAbort() && liveReplicaMatches();
    // Flush a pending workspace notification for THIS replica only before
    // any new protocol work: the bytes already landed but the application
    // never reloaded, so retry the hook first. Other replicas' pendings
    // stay keyed (never replayed here). A second failure aborts the cycle
    // (base still unadvanced) and stays pending for the next attempt.
    const pendingKey = replicaKey(
      cycleUid,
      cycleLocalVaultId,
      cycleCloudVaultId,
    );
    const pendingForReplica = this.#pendingRemoteApplied.get(pendingKey);
    if (pendingForReplica !== undefined && this.#reconciler !== null) {
      if (shouldAbort()) return;
      if (!liveReplicaMatches()) return;
      try {
        await this.#reconciler.handleRemoteApplied(
          pendingForReplica.notification,
        );
      } catch (error) {
        const normalized =
          error instanceof VaultSyncError ? error : normalizeSyncError(error);
        // A workspace hook failure after the replica/epoch lapsed is a
        // stale completion: keep the replica-scoped pending notification
        // for its own next cycle and publish nothing into B.
        if (!ownsCyclePresentation()) return;
        throw this.#recordError(normalized);
      }
      if (shouldAbort()) return;
      if (!liveReplicaMatches()) return;
      this.#pendingRemoteApplied.delete(pendingKey);
    }
    this.#phase = 'scanning';
    this.#error = null;
    this.#emit();
    const deferred = new Set<string>();
    const tracker = this.#tracker;
    // Mutation hints are an optimization: paths written since the last
    // cycle start are always re-hashed even when their stat looks
    // unchanged. Hints collected mid-cycle stay queued for the follow-up
    // run the scheduler already owes.
    const forceHash = new Set(this.#mutatedPaths);
    this.#mutatedPaths.clear();
    const cacheKey = `${this.#currentUid ?? ''}/${binding.localVaultId}`;
    let perUid = this.#scanCaches.get(this.#currentUid ?? '');
    if (perUid === undefined) {
      perUid = new Map();
      this.#scanCaches.set(this.#currentUid ?? '', perUid);
    }
    let cache = perUid.get(binding.localVaultId);
    if (cache === undefined) {
      cache = createLocalScanCache();
      perUid.set(binding.localVaultId, cache);
    }
    // Periodic authoritative full scan (recovery truth): even with
    // matching stats and no hints, every Nth successful reconcile
    // re-hashes everything, bounding any mtime-granularity or
    // missed-event drift. Restarts always start uncached (full scan).
    const successes = this.#reconcileCounts.get(cacheKey) ?? 0;
    const forceFullScan = successes > 0 && successes % FULL_SCAN_EVERY === 0;
    // Prefer the immutable UID scope when the provider offers it; the
    // guard wrapper additionally aborts on generation change even for
    // providers without `forUid`.
    const pinnedRemote = createIdentityPinnedRemote(
      this.#remote,
      cycleUid,
      shouldAbort,
    );
    try {
      this.#requireUser();
      if (shouldAbort()) return;
      if (!liveReplicaMatches()) return;
      // A persisted merge base must be structurally AND cryptographically
      // trustworthy before it can influence merge behavior: structural
      // parse happened at load/commit; recompute the
      // digest here, BEFORE any remote read. Corruption parks the binding
      // with an explicit metadata error and performs zero cloud work — it
      // is never silently repaired to `base: null` (which could produce an
      // incorrect first-sync merge against a cloud vault with history).
      if (binding.baseCorrupt === true) {
        throw new VaultSyncError(
          'CORRUPT_SYNC_METADATA',
          'persisted sync base failed validation; cloud reconciliation is parked until the local sync base is rebuilt from verified remote state',
        );
      }
      if (binding.base !== null) {
        try {
          await verifyPersistedSyncBase(binding.base, binding.cloudVaultId);
        } catch (error) {
          if (
            error instanceof VaultSyncError &&
            error.code === 'CORRUPT_SYNC_METADATA'
          ) {
            // Latch the corruption durably BEFORE parking: without the
            // marker the service would re-attempt verification (and
            // potentially schedule remote work) on every cycle. Copy-on-
            // write: a failed latch save leaves canonical metadata
            // untouched; the error below still propagates and this cycle
            // already performed zero remote work.
            try {
              const latched = await this.#latchCorruptBinding(
                cycleUid,
                cycleLocalVaultId,
                cycleIdentity,
                binding,
              );
              // Only park the CURRENT replica's wiring: a stale cycle that
              // latched A's corruption durably after B attached must not
              // detach B's listeners/watcher/scheduler. Parking ends
              // mutation coverage while the vault stays writable, so the
              // replica's scan cache must not survive for post-repair use.
              if (latched && ownsCyclePresentation()) {
                this.#invalidateScanCache(cycleUid, cycleLocalVaultId);
                this.#unwire();
              }
            } catch {
              // Latching is best-effort; the corruption error is primary.
            }
          }
          throw error;
        }
      }
      const result = await reconcileVault({
        vault: vault.silent,
        remote: pinnedRemote,
        vaultId: binding.cloudVaultId,
        name: binding.name,
        base: binding.base,
        deviceId: binding.deviceId,
        exclude: this.#exclude,
        incremental: { cache, forceHash, forceFullScan },
        shouldAbort,
        defer:
          tracker === null
            ? undefined
            : (path) => {
                const dirty = tracker.isDirty(path as WorkspacePath);
                if (dirty) deferred.add(path);
                return dirty;
              },
        onProgress: (stage) => {
          // A stale cycle's progress callback must not move B's phase
          // (scanning/uploading/downloading/merging).
          if (!ownsCyclePresentation()) return;
          this.#phase = phaseForStage(stage);
          this.#emit();
        },
        // Immediate remote-apply → workspace reconciliation: runs
        // INSIDE the engine after local materialization and BEFORE any
        // upload/CAS, so a later network failure can never strand stale
        // clean-editor state. Throwing blocks the base advance; the
        // notification stays pending (keyed by replica) for the next
        // cycle. The replica guard runs BEFORE the hook so vault B never
        // receives vault A's paths.
        onLocalApplied: async (notification) => {
          if (shouldAbort()) {
            throw new VaultSyncError(
              'ACCOUNT_CHANGED',
              'account identity changed during sync; aborting cycle',
            );
          }
          if (!liveReplicaMatches()) {
            throw new VaultSyncError(
              'ACCOUNT_CHANGED',
              'active vault changed during sync; aborting cycle',
            );
          }
          if (this.#reconciler === null) return;
          try {
            await this.#reconciler.handleRemoteApplied(notification);
          } catch (error) {
            this.#pendingRemoteApplied.set(pendingKey, {
              uid: cycleUid,
              localVaultId: cycleLocalVaultId,
              cloudVaultId: cycleCloudVaultId,
              notification: { ...notification },
            });
            throw error;
          }
          this.#pendingRemoteApplied.delete(pendingKey);
        },
        // Conflict notices become durable immediately after the engine has
        // materialized their preserved paths and before outbound work. A
        // later upload/CAS/final-metadata failure therefore cannot advance
        // past a conflict while leaving Settings unaware of its copy.
        onConflictsPreserved: async (conflicts) => {
          if (shouldAbort() || !liveReplicaMatches()) {
            throw new VaultSyncError(
              'ACCOUNT_CHANGED',
              'account or vault changed during sync; aborting cycle',
            );
          }
          const detectedAt = new Date().toISOString();
          const ownsConflictCommit = (): boolean =>
            !this.#disposed &&
            !this.#suspended &&
            this.#identityGeneration === cycleIdentity &&
            (this.#account.snapshot().user?.id ?? null) === cycleUid;
          const { installed } = await this.#commitMetadata({
            label: 'conflicts-preserved',
            validateBefore: () => {
              if (!ownsConflictCommit()) {
                throw new VaultSyncError(
                  'ACCOUNT_CHANGED',
                  'account identity changed during sync; aborting cycle',
                );
              }
            },
            mutate: (draft) => {
              const nextBindings = draft.accounts.get(cycleUid);
              const liveStored = nextBindings?.get(cycleLocalVaultId);
              if (
                nextBindings === undefined ||
                liveStored === undefined ||
                liveStored.cloudVaultId !== cycleCloudVaultId
              ) {
                throw new VaultSyncError(
                  'ACCOUNT_CHANGED',
                  'sync binding changed during sync; aborting cycle',
                );
              }
              nextBindings.set(cycleLocalVaultId, {
                ...liveStored,
                conflicts: appendConflictSummaries(
                  liveStored.conflicts,
                  conflicts,
                  detectedAt,
                ),
              });
            },
            validateAfterSave: ownsConflictCommit,
          });
          if (!installed) {
            throw new VaultSyncError(
              'ACCOUNT_CHANGED',
              'account identity changed during sync; aborting cycle',
            );
          }
          if (ownsCyclePresentation()) this.#emit();
        },
        // Post-apply checkpoint (serialized lane): after remote
        // bytes + workspace hook succeed, persist the truthful remote
        // ancestor BEFORE outbound upload/CAS. A throwing checkpoint aborts
        // before any upload so restart recovery stays truthful.
        // Pre-save gates stay strict (no hook/upload after identity or
        // replica lapse). Post-save install is identity-scoped (uid +
        // epoch + live binding existence) rather than liveness-scoped: a
        // vault switch to B during A's checkpoint save must not leak A's
        // truth into B, but A's own ancestor must still land under A
        // (B untouched). The lane holds across stage→persist→install, so
        // no newer durable commit can interleave underneath.
        onCheckpoint: async (checkpoint) => {
          if (shouldAbort()) {
            throw new VaultSyncError(
              'ACCOUNT_CHANGED',
              'account identity changed during sync; aborting cycle',
            );
          }
          if (!liveReplicaMatches()) {
            throw new VaultSyncError(
              'ACCOUNT_CHANGED',
              'active vault changed during sync; aborting cycle',
            );
          }
          if (checkpoint.manifest.vaultId !== cycleCloudVaultId) {
            throw new VaultSyncError(
              'CORRUPT_MANIFEST',
              'checkpoint belongs to a different cloud vault',
            );
          }
          const ownsCheckpoint = (): boolean => {
            if (
              this.#disposed ||
              this.#suspended ||
              this.#identityGeneration !== cycleIdentity
            ) {
              return false;
            }
            const liveUid = this.#account.snapshot().user?.id ?? null;
            return liveUid === cycleUid;
          };
          // Checkpoint ownership is narrow: ONLY this replica's base.
          // Checkpoint advances the merge ancestor only; commit metadata
          // (lastSyncedAt/lastRevision) still reflects the last full
          // commit — the outbound edit is NOT claimed as synced.
          //
          // The reconcile lane does NOT hold the metadata lane (lane
          // split): this commit enters the durable lane for the narrow
          // stage→persist→validate→install window only.
          const { installed } = await this.#commitMetadata({
            label: 'checkpoint',
            validateBefore: () => {
              if (
                this.#disposed ||
                this.#suspended ||
                this.#identityGeneration !== cycleIdentity
              ) {
                throw new VaultSyncError(
                  'ACCOUNT_CHANGED',
                  'account identity changed during sync; aborting cycle',
                );
              }
            },
            mutate: (draft) => {
              const nextBindings = draft.accounts.get(cycleUid);
              const liveStored = nextBindings?.get(cycleLocalVaultId);
              // Binding-stable mutation: the checkpoint may advance
              // ONLY the exact binding this cycle captured. A replaced,
              // removed, or re-pointed binding (different cloud vault)
              // aborts before any staging/save instead of leaking A's
              // ancestor into another replica.
              if (
                nextBindings === undefined ||
                liveStored === undefined ||
                liveStored.cloudVaultId !== cycleCloudVaultId
              ) {
                throw new VaultSyncError(
                  'ACCOUNT_CHANGED',
                  'sync binding changed during sync; aborting cycle',
                );
              }
              nextBindings.set(cycleLocalVaultId, {
                ...liveStored,
                base: checkpoint,
              });
            },
            validateAfterSave: ownsCheckpoint,
          });
          if (!installed) {
            throw new VaultSyncError(
              'ACCOUNT_CHANGED',
              'account identity changed during sync; aborting cycle',
            );
          }
        },
      });
      // Only adopt results still belonging to this binding AND this
      // identity epoch: a disable, rebind, sign-out, or account switch
      // mid-flight must not resurrect stale state under the wrong owner —
      // and a completed A cycle must never advance B's binding/base even
      // if its remote writes were (correctly) aborted above. The staged
      // write touches only the cycle's replica key, so a vault switch to B
      // does not leak A's result into B (B untouched).
      if (shouldAbort()) return;
      if (!liveReplicaMatches()) return;
      const completedAt = new Date().toISOString();
      const ownsCommit = (): boolean => {
        if (
          this.#disposed ||
          this.#suspended ||
          this.#identityGeneration !== cycleIdentity
        ) {
          return false;
        }
        const liveUid = this.#account.snapshot().user?.id ?? null;
        return liveUid === cycleUid;
      };
      // Copy-on-write commit (serialized metadata lane): stage S1 from
      // the fresh lane-local draft, persist, revalidate ownership, then
      // install. Ownership is narrow: ONLY this replica's base +
      // lastSyncedAt + lastRevision. A save failure keeps S0 — never a
      // phantom in-memory binding. The metadata lane holds across the
      // whole commit; the reconcile lane never holds it (lane split).
      const { installed } = await this.#commitMetadata({
        label: 'reconcile-commit',
        validateBefore: () => {
          if (!ownsCommit()) {
            throw new VaultSyncError(
              'ACCOUNT_CHANGED',
              'account identity changed during sync; aborting cycle',
            );
          }
        },
        mutate: (draft) => {
          const nextBindings = draft.accounts.get(cycleUid);
          const liveStored = nextBindings?.get(cycleLocalVaultId);
          // Binding-stable mutation: commit ONLY the exact binding
          // this cycle captured (same cloud vault). A replaced, removed,
          // or re-pointed binding aborts before staging/save — A's result
          // is never installed into another replica, and a removed
          // binding is never resurrected.
          if (
            nextBindings === undefined ||
            liveStored === undefined ||
            liveStored.cloudVaultId !== cycleCloudVaultId
          ) {
            throw new VaultSyncError(
              'ACCOUNT_CHANGED',
              'sync binding changed during sync; aborting cycle',
            );
          }
          const unresolvedConflicts = appendConflictSummaries(
            liveStored.conflicts,
            result.conflicts,
            completedAt,
          );
          nextBindings.set(cycleLocalVaultId, {
            ...liveStored,
            base: result.base,
            lastSyncedAt: completedAt,
            lastRevision: result.revision,
            ...(unresolvedConflicts.length > 0
              ? { conflicts: unresolvedConflicts }
              : { conflicts: undefined }),
          });
        },
        validateAfterSave: ownsCommit,
      });
      if (!installed) return;
      // Install/telemetry publication belongs exclusively to the live
      // replica: `ownsCommit` above is deliberately identity-scoped (A's
      // own ancestor lands under A even when the visible vault changed),
      // but phase/error/pending/deferred/emit must not touch B.
      if (!ownsCyclePresentation()) return;
      this.#reconcileCounts.set(
        cacheKey,
        (this.#reconcileCounts.get(cacheKey) ?? 0) + 1,
      );
      this.#pendingChanges = 0;
      this.#lastDeferred = deferred;
      this.#phase = 'idle';
      this.#error = null;
      this.#emit();
    } catch (error) {
      // Stale-identity/replica aborts are silent (never an error, never a
      // base advance, never a retry for the old identity): the new
      // account/vault's own sync runs separately afterwards.
      if (error instanceof VaultSyncError && error.code === 'ACCOUNT_CHANGED') {
        return;
      }
      // Ownership gate: a terminal result from a stale cycle —
      // success, NETWORK, PERMISSION_DENIED, LOCAL_CHANGED, workspace
      // failure — is swallowed before it can publish into B, change B's
      // phase, or schedule B's scheduler from old work.
      if (!ownsCyclePresentation()) return;
      // Local-content races retry from a fresh scan via the scheduler
      // (the stale cache entry was already invalidated in the engine):
      // not corruption, not an error surface — just reschedule.
      if (error instanceof VaultSyncError && error.code === 'LOCAL_CHANGED') {
        this.#phase = 'idle';
        this.#emit();
        this.#scheduler?.request();
        return;
      }
      this.#lastDeferred = deferred;
      const normalized =
        error instanceof VaultSyncError ? error : normalizeSyncError(error);
      // Backend authorization is server-claim only: label a
      // Rules denial for UI without ever bypassing it. Classification is
      // pure (never publishes); the result below is published only while
      // FULL replica/presentation ownership still holds — a same-UID A→B
      // switch invalidates even though the identity epoch matches, so a
      // stale A classifier can never publish into B.
      if (normalized.code === 'PERMISSION_DENIED') {
        const mapped = await this.#classifyPermissionDenied(
          normalized,
          cycleOwner,
        );
        if (!ownsCyclePresentation()) return;
        this.#publishPermissionDenied(mapped);
        throw mapped;
      }
      throw this.#recordError(error, ownsCyclePresentation);
    }
  }
}
