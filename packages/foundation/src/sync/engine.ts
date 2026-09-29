/**
 * Vault reconcile engine.
 *
 * Crash-safe remote commit protocol over abstract local + remote state:
 *
 * ```text
 * scan/hash local state
 *   → read remote HEAD
 *   → three-way merge (base / local / remote)
 *   → apply merged state locally (deletes, then hash-verified downloads)
 *   → upload missing immutable blobs
 *   → upload immutable manifest
 *   → compare-and-swap HEAD (transactional; retry on contention)
 *   → report the new base (the caller persists it as its SyncBinding)
 * ```
 *
 * Local saves never wait for this engine: it observes committed
 * vault state after the fact. An interrupted run is always recoverable —
 * blobs and manifests are immutable and content-addressed, so re-running
 * reconciles idempotently and the previous HEAD stays valid until the CAS
 * succeeds. Restart recovery falls out of the same property:
 * the caller reloads its persisted base and reconciles again.
 *
 * The engine is provider-neutral: local state flows through `VaultService`
 * (memory vaults in tests, real providers later) and remote state through
 * `SyncRemote`. No Firebase types appear here.
 */

import { parentPath, ROOT_PATH, type WorkspacePath } from '../paths.js';
import type { VaultService } from '../vault/contract.js';
import { ensureDirectory } from '../vault/helpers.js';
import { VaultSyncError } from './errors.js';
import {
  buildManifest,
  emptyManifest,
  hashBytes,
  hashManifest,
  manifestsEqual,
  parseSyncManifest,
} from './manifest.js';
import { threeWayMerge, type MergePlan, type SyncConflict } from './merge.js';
import { mergePropertySidecarBytes } from './property-sidecar-merge.js';
import type {
  SyncBase,
  SyncManifest,
  SyncManifestEntry,
  SyncRemote,
} from './contract.js';

export interface ReconcileInput {
  readonly vault: VaultService;
  readonly remote: SyncRemote;
  /** Cloud vault identity (UUID, never a local vault id). */
  readonly vaultId: string;
  /** Display name recorded in the HEAD document. */
  readonly name: string;
  /** Last synchronized manifest, or null before the first sync. */
  readonly base: SyncBase | null;
  /** Opaque per-device replica identifier (diagnostics, HEAD metadata). */
  readonly deviceId: string;
  /** Clock for conflict-copy timestamps (injectable for determinism). */
  readonly now?: Date;
  /** HEAD contention retries before surfacing `REMOTE_CHANGED`. */
  readonly maxCommitAttempts?: number;
  /**
   * Local paths to leave out of the synced set (derived state, device
   * caches). The policy must be identical across replicas. Defaults to
   * syncing everything scanned.
   */
  readonly exclude?: (path: string) => boolean;
  /**
   * Dirty-session deferral: file paths whose remote
   * changes must NOT be materialized yet because an open session holds
   * unsaved edits. Deferred paths are still merged truthfully (so the
   * cloud advances for everyone), but `applyMerged` skips writing or
   * removing them and the reported base keeps the local values — the
   * replica stays truthful about what it actually holds, so a later
   * save reconciles as a genuine concurrent edit and a revert converges
   * by downloading. Applies to file paths only; directory entries pass
   * through. Defaults to deferring nothing.
   */
  readonly defer?: (path: string) => boolean;
  /**
   * Stage notifications for status reporting (service snapshot phases).
   * Sync, fast, and optional; throwing hooks are contained and never
   * break the reconcile.
   */
  readonly onProgress?: (stage: SyncProgressStage) => void;
  /**
   * Incremental local-state cache (optimization only). The file set stays
   * authoritative (every cycle lists the vault); the cache only skips
   * re-reading unchanged content. Omitted means a full authoritative
   * scan (restart/recovery path).
   */
  readonly incremental?: IncrementalScanOptions;
  /**
   * Identity-stable abort hook: returns true when
   * the account/generation captured at cycle start is no longer live
   * (sign-out, account switch, suspend). The engine checks it before
   * every remote side-effect boundary and aborts with `ACCOUNT_CHANGED`
   * instead of performing a write under the wrong UID. Reads also abort
   * so a stale cycle can never observe another account's partition.
   * Omitted means no abort (tests, single-identity flows).
   */
  readonly shouldAbort?: () => boolean;
  /**
   * Remote-apply → application reconciliation seam:
   * invoked immediately after the engine materializes remote bytes
   * locally and BEFORE any blob/manifest upload or HEAD CAS, so a later
   * network/CAS failure can never leave stale clean-editor state behind
   * (lifecycle corrected to run inside the protocol, not after
   * it). Receives only clean-applied paths (dirty-deferred paths never
   * appear). A throwing hook blocks further protocol advancement for
   * that attempt — the error propagates and the caller must retry the
   * hook before advancing the base. Foundation stays UI-neutral: this is
   * a semantic canonical-change notification only.
   */
  readonly onLocalApplied?: (
    notification: import('./contract.js').SyncAppliedNotification,
  ) => Promise<void> | void;
  /**
   * Durable conflict-report seam. Runs after conflict copies have been
   * materialized locally and before outbound upload/CAS, so a later failure
   * cannot make a preserved conflict invisible to recovery UI.
   */
  readonly onConflictsPreserved?: (
    conflicts: readonly SyncConflict[],
  ) => Promise<void> | void;
  /**
   * Post-apply checkpoint seam: invoked after remote
   * bytes are materialized AND `onLocalApplied` succeeded, but BEFORE
   * any outbound blob/manifest upload or HEAD CAS. Receives the truthful
   * local merge ancestor for the just-applied remote (remote manifest
   * adjusted for deferred dirty paths — never including uncommitted
   * local edits). The caller should durably persist it so a later
   * outbound network failure followed by another device's commit (R3)
   * does not misclassify already-materialized R2 bytes as local edits
   * on retry. A throwing hook aborts the attempt before any upload/CAS
   * (checkpoint persistence failure must not continue into state that
   * restart recovery cannot reconstruct truthfully).
   */
  readonly onCheckpoint?: (
    checkpoint: import('./contract.js').SyncBase,
  ) => Promise<void> | void;
}

/**
 * Reconcile stages, in order: `scan` (local scan + HEAD read), `merge`
 * (three-way merge), `download` (materialize merged state locally),
 * `upload` (push missing blobs, the manifest, and the HEAD swap).
 * Pull-only reconciles end after `download`.
 */
export type SyncProgressStage = 'scan' | 'merge' | 'download' | 'upload';

export interface ReconcileResult {
  /** New synchronized base for the caller to persist. */
  readonly base: SyncBase;
  readonly revision: number;
  /** True when a new remote revision was committed. */
  readonly committed: boolean;
  /** True when local files/directories were created, updated, or removed. */
  readonly appliedLocalChanges: boolean;
  /** Sorted vault-relative paths created, updated, or removed locally. */
  readonly appliedPaths: readonly string[];
  /** Sorted vault-relative paths created or updated from remote bytes. */
  readonly appliedWritten: readonly string[];
  /** Sorted vault-relative paths removed to match the merged state. */
  readonly appliedRemoved: readonly string[];
  readonly uploadedBlobs: number;
  readonly uploadedBytes: number;
  readonly downloadedFiles: number;
  readonly downloadedBytes: number;
  readonly conflicts: readonly SyncConflict[];
  /** Files listed in the authoritative local scan (this cycle, all attempts). */
  readonly scannedFiles: number;
  /** Local files actually read and hashed (cache misses + forced paths). */
  readonly hashedFiles: number;
}

const DEFAULT_MAX_COMMIT_ATTEMPTS = 5;

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { readonly code?: unknown }).code === 'NOT_FOUND'
  );
}

function asPath(value: string): WorkspacePath {
  return value as WorkspacePath;
}

interface LocalScan {
  readonly entries: SyncManifestEntry[];
  /** Blob → one local path holding it (for commit uploads). */
  readonly blobSources: ReadonlyMap<string, string>;
  /** Explicit empty directories in the local vault. */
  readonly directories: ReadonlySet<string>;
  /** Every local directory (empty or not) seen during the scan. */
  readonly allDirectories: ReadonlySet<string>;
  /** Every local file path (for delete reconciliation). */
  readonly files: ReadonlySet<string>;
  /** Files actually read and hashed (cache misses + forced paths). */
  readonly hashedFiles: number;
}

/** Cached content identity for one local path (optimization only). */
export interface LocalScanCacheEntry {
  readonly size: number;
  readonly modifiedMillis: number | null;
  readonly blob: string;
}

/**
 * Incremental local-state cache (optimization, never correctness
 * authority). The file SET always comes from a full vault listing; the
 * cache only skips re-reading and re-hashing content whose size and
 * modification time are unchanged since the last scan. Mutation hints
 * (vault mutation feed) and explicit full scans override it; a restart
 * starts from an empty cache and therefore performs one authoritative
 * full scan. Remote-applied files update/invalidate their entries, and
 * stale keys for vanished paths are pruned per scan.
 */
export interface LocalScanCache {
  get(path: string): LocalScanCacheEntry | undefined;
  set(path: string, entry: LocalScanCacheEntry): void;
  delete(path: string): void;
  clear(): void /** Drop every key not in `keep` (post-scan prune of renames/deletes). */;
  prune(keep: ReadonlySet<string>): void;
}

/** Create an empty incremental scan cache (per replica binding). */
export function createLocalScanCache(): LocalScanCache {
  const entries = new Map<string, LocalScanCacheEntry>();
  return {
    get: (path) => entries.get(path),
    set: (path, entry) => {
      entries.set(path, entry);
    },
    delete: (path) => {
      entries.delete(path);
    },
    clear: () => {
      entries.clear();
    },
    prune: (keep) => {
      for (const path of [...entries.keys()]) {
        if (!keep.has(path)) entries.delete(path);
      }
    },
  };
}

/**
 * Incremental scan tuning. `cache` carries content identities across
 * cycles; `forceHash` (mutation-hint paths) is always re-read even when
 * the stat matches; `forceFullScan` ignores the cache entirely for one
 * recovery cycle.
 */
export interface IncrementalScanOptions {
  readonly cache: LocalScanCache;
  readonly forceHash?: ReadonlySet<string>;
  readonly forceFullScan?: boolean;
}

async function scanLocal(
  vault: VaultService,
  exclude: (path: string) => boolean,
  incremental?: IncrementalScanOptions,
): Promise<LocalScan> {
  const entries: SyncManifestEntry[] = [];
  const blobSources = new Map<string, string>();
  const directories = new Set<string>();
  const allDirectories = new Set<string>();
  const files = new Set<string>();
  let hashedFiles = 0;
  const cache = incremental?.cache ?? null;
  const forceHash = incremental?.forceHash;
  const forceFullScan = incremental?.forceFullScan ?? false;
  const walk = async (dir: string): Promise<boolean> => {
    let children;
    try {
      children = await vault.list(dir === '' ? ROOT_PATH : asPath(dir));
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
    let nonEmpty = false;
    for (const child of children) {
      const path = dir === '' ? child.name : `${dir}/${child.name}`;
      if (exclude(path)) continue;
      nonEmpty = true;
      if (child.kind === 'directory') {
        allDirectories.add(path);
        const hasContent = await walk(path);
        if (!hasContent) {
          entries.push({ path, kind: 'directory' });
          directories.add(path);
        }
      } else {
        let blob: string | null = null;
        let size = 0;
        if (cache !== null && !forceFullScan && forceHash?.has(path) !== true) {
          // Fast path: unchanged size + mtime reuses the cached content
          // identity without reading the file at all.
          try {
            const stat = await vault.stat(asPath(path));
            const hit = cache.get(path);
            if (
              stat.kind === 'file' &&
              hit !== undefined &&
              hit.size === stat.size &&
              hit.modifiedMillis === stat.modifiedMillis
            ) {
              blob = hit.blob;
              size = hit.size;
            }
          } catch {
            // A failing stat falls through to the authoritative read.
            blob = null;
          }
        }
        if (blob === null) {
          const bytes = await vault.read(asPath(path));
          blob = await hashBytes(bytes);
          size = bytes.length;
          hashedFiles += 1;
          if (cache !== null) {
            let modifiedMillis: number | null = null;
            try {
              const stat = await vault.stat(asPath(path));
              modifiedMillis =
                stat.kind === 'file' ? stat.modifiedMillis : null;
            } catch {
              modifiedMillis = null;
            }
            cache.set(path, { size, modifiedMillis, blob });
          }
        }
        entries.push({ path, kind: 'file', blob, size });
        files.add(path);
        if (!blobSources.has(blob)) blobSources.set(blob, path);
      }
    }
    return nonEmpty;
  };
  await walk('');
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (cache !== null) {
    // Stale keys (renamed/deleted paths) must never accumulate: anything
    // the authoritative listing did not visit loses its entry.
    cache.prune(files);
  }
  return {
    entries,
    blobSources,
    directories,
    files,
    allDirectories,
    hashedFiles,
  };
}

/** Verify `bytes` against the manifest before any local write.*/
export async function verifyBlob(
  bytes: Uint8Array,
  expected: string,
): Promise<void> {
  const actual = await hashBytes(bytes);
  if (actual !== expected) {
    throw new VaultSyncError(
      'HASH_MISMATCH',
      `blob hash mismatch: expected ${expected}, got ${actual}`,
    );
  }
}

interface ApplyHooks {
  onDownload(size: number): void;
}

interface SemanticMergeResult {
  readonly plan: MergePlan;
  /** Verified downloaded and newly encoded blobs available to this attempt. */
  readonly blobs: ReadonlyMap<string, Uint8Array>;
}

function filesByPath(
  manifest: SyncManifest,
): ReadonlyMap<string, SyncManifestEntry> {
  return new Map(
    manifest.entries
      .filter((entry) => entry.kind === 'file')
      .map((entry) => [entry.path, entry]),
  );
}

/**
 * Resolve byte-level edit/edit conflicts for valid canonical property
 * sidecars when the concurrent changes touch independent fields. Invalid,
 * unsupported, or same-field input retains the ordinary conflict-copy plan.
 */
async function mergePropertySidecarConflicts(input: {
  readonly plan: MergePlan;
  readonly base: SyncManifest;
  readonly local: SyncManifest;
  readonly remote: SyncManifest;
  readonly vault: VaultService;
  readonly syncRemote: SyncRemote;
  readonly vaultId: string;
  readonly throwIfAborted: () => void;
  readonly onDownload: (size: number) => void;
}): Promise<SemanticMergeResult> {
  const candidates = input.plan.conflicts.filter(
    (conflict) =>
      conflict.kind === 'edit-edit' &&
      conflict.path.startsWith('.froglight/properties/') &&
      conflict.path.endsWith('.json') &&
      conflict.conflictPath !== null,
  );
  if (candidates.length === 0) return { plan: input.plan, blobs: new Map() };

  const baseFiles = filesByPath(input.base);
  const localFiles = filesByPath(input.local);
  const remoteFiles = filesByPath(input.remote);
  const downloaded = new Map<string, Uint8Array>();
  const generated = new Map<string, Uint8Array>();
  const resolved = new Map<
    string,
    { entry: SyncManifestEntry; conflictPath: string }
  >();
  const download = async (blob: string): Promise<Uint8Array> => {
    const cached = downloaded.get(blob);
    if (cached !== undefined) return cached;
    input.throwIfAborted();
    const bytes = await input.syncRemote.downloadBlob(input.vaultId, blob);
    await verifyBlob(bytes, blob);
    input.onDownload(bytes.byteLength);
    downloaded.set(blob, bytes);
    return bytes;
  };

  for (const conflict of candidates) {
    const base = baseFiles.get(conflict.path);
    const local = localFiles.get(conflict.path);
    const remote = remoteFiles.get(conflict.path);
    if (
      base?.kind !== 'file' ||
      local?.kind !== 'file' ||
      remote?.kind !== 'file' ||
      typeof base.blob !== 'string' ||
      typeof local.blob !== 'string' ||
      typeof remote.blob !== 'string' ||
      conflict.conflictPath === null
    ) {
      continue;
    }
    let localBytes: Uint8Array;
    try {
      localBytes = await input.vault.read(asPath(conflict.path));
    } catch {
      throw new VaultSyncError(
        'LOCAL_CHANGED',
        `local property sidecar vanished after scan: ${conflict.path}`,
      );
    }
    const localHash = await hashBytes(localBytes);
    if (localHash !== local.blob) {
      throw new VaultSyncError(
        'LOCAL_CHANGED',
        `local property sidecar changed after scan: ${conflict.path}`,
      );
    }
    let baseBytes: Uint8Array;
    try {
      baseBytes = await download(base.blob);
    } catch (error) {
      // Historical base blobs are normally immutable remote objects. A
      // checkpoint adjusted for a deferred local path can legitimately refer
      // to a local-only ancestor, though; fall back to whole-file preservation
      // when those bytes are unavailable rather than blocking reconciliation.
      if (
        error instanceof VaultSyncError &&
        error.code === 'REMOTE_NOT_FOUND'
      ) {
        continue;
      }
      throw error;
    }
    const merged = mergePropertySidecarBytes({
      path: conflict.path,
      base: baseBytes,
      local: localBytes,
      remote: await download(remote.blob),
    });
    if (merged === null) continue;
    const blob = await hashBytes(merged);
    generated.set(blob, merged);
    resolved.set(conflict.path, {
      entry: {
        path: conflict.path,
        kind: 'file',
        blob,
        size: merged.byteLength,
      },
      conflictPath: conflict.conflictPath,
    });
  }
  const available = new Map(downloaded);
  for (const [blob, bytes] of generated) available.set(blob, bytes);
  if (resolved.size === 0) return { plan: input.plan, blobs: available };

  const merged = input.plan.merged.filter((entry) => {
    const direct = resolved.get(entry.path);
    if (direct !== undefined) return false;
    for (const resolution of resolved.values()) {
      if (entry.path === resolution.conflictPath) return false;
    }
    return true;
  });
  for (const resolution of resolved.values()) merged.push(resolution.entry);
  merged.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  return {
    plan: {
      merged,
      conflicts: input.plan.conflicts.filter(
        (conflict) => !resolved.has(conflict.path),
      ),
    },
    blobs: available,
  };
}

/**
 * Materialize the merged manifest into the local vault.
 *
 * Ordering (kind transitions, deepest-first deletes):
 *
 * ```text
 * file removes deepest-first
 *   → directory removes deepest-first (incl. dir→file blockers)
 *   → file writes shallowest-first (parents first)
 *   → surviving directories created shallowest-first
 * ```
 *
 * A merged file at `P` while the vault holds a directory at `P` (dir →
 * file, including nested `folder/` → file `folder`) removes the local
 * subtree first — otherwise the write fails with `IS_DIRECTORY` and the
 * emptied directory survives to be rediscovered as a new local directory
 * on the next scan. A merged directory subtree while the vault holds a
 * file at an ancestor (file → dir) is handled by the file-remove pass
 * (the blocking file is absent from the merged file set), which always
 * runs before any creation. Newly-emptied directories are pruned in the
 * same pass (not only dirs that were already empty at scan time), so a
 * remotely deleted `folder/a.md` cannot leave an empty `folder/` behind
 * to be re-uploaded as a new local directory.
 *
 * Deferred file paths (dirty open sessions) are skipped for
 * both removes and writes, and directories pinned by a deferred file are
 * never pruned: the vault keeps its bytes and the caller keeps them in
 * the base (see `adjustBaseForDeferred`).
 */
async function applyMerged(
  vault: VaultService,
  remote: SyncRemote,
  vaultId: string,
  scan: LocalScan,
  merged: readonly SyncManifestEntry[],
  defer: (path: string) => boolean,
  hooks: ApplyHooks,
  cache: LocalScanCache | null = null,
): Promise<{ changed: boolean; written: string[]; removed: string[] }> {
  let changed = false;
  const written: string[] = [];
  const removed: string[] = [];
  const mergedFiles = new Map<string, SyncManifestEntry>();
  const mergedDirs = new Set<string>();
  for (const entry of merged) {
    if (entry.kind === 'file') mergedFiles.set(entry.path, entry);
    else mergedDirs.add(entry.path);
  }
  const mergedEffectiveDirs = new Set<string>(mergedDirs);
  for (const path of mergedFiles.keys()) {
    const segments = path.split('/');
    for (let end = 1; end < segments.length; end += 1) {
      mergedEffectiveDirs.add(segments.slice(0, end).join('/'));
    }
  }

  const depthOf = (path: string): number => path.split('/').length;
  const deepestFirst = (a: string, b: string): number =>
    depthOf(b) - depthOf(a) || (a < b ? -1 : a > b ? 1 : 0);
  const shallowestFirst = (a: string, b: string): number =>
    depthOf(a) - depthOf(b) || (a < b ? -1 : a > b ? 1 : 0);

  const isPinnedByDeferred = (dir: string): boolean => {
    for (const file of scan.files) {
      if (defer(file) && (file === dir || file.startsWith(`${dir}/`)))
        return true;
    }
    return false;
  };

  for (const path of [...scan.files]
    .filter((candidate) => !mergedFiles.has(candidate) && !defer(candidate))
    .sort(deepestFirst)) {
    await vault.remove(asPath(path));
    removed.push(path);
    changed = true;
    cache?.delete(path);
  }

  // Directories the merge dropped (including dir→file blockers and
  // newly-emptied parents of deleted files): deepest-first, best-effort.
  // Deferred-pinned subtrees are skipped so dirty sessions are untouched.
  for (const dir of [...scan.allDirectories]
    .filter(
      (candidate) =>
        !mergedEffectiveDirs.has(candidate) && !isPinnedByDeferred(candidate),
    )
    .sort(deepestFirst)) {
    try {
      await vault.remove(asPath(dir));
      removed.push(dir);
      changed = true;
      cache?.delete(dir);
    } catch (error) {
      if (isNotFound(error)) continue;
      const code =
        typeof error === 'object' && error !== null
          ? (error as Record<string, unknown>).code
          : null;
      // CONFLICT (still non-empty: excluded content the scan skipped) is
      // best-effort. Anything else is a real vault failure.
      if (code === 'CONFLICT') continue;
      throw error;
    }
  }

  const localFiles = new Map<string, SyncManifestEntry>();
  for (const entry of scan.entries) {
    if (entry.kind === 'file') localFiles.set(entry.path, entry);
  }
  const fileWrites = [...mergedFiles.values()]
    .filter(
      (entry) =>
        localFiles.get(entry.path)?.blob !== entry.blob && !defer(entry.path),
    )
    .sort((a, b) => shallowestFirst(a.path, b.path));
  for (const entry of fileWrites) {
    const bytes = await remote.downloadBlob(vaultId, entry.blob!);
    // Corrupted bytes never reach the vault; the valid local copy (if any)
    // is retained and the failure surfaces as HASH_MISMATCH.
    await verifyBlob(bytes, entry.blob!);
    const parent = parentPath(asPath(entry.path));
    if (parent !== ROOT_PATH) await ensureDirectory(vault, parent);
    await vault.write(asPath(entry.path), bytes);
    hooks.onDownload(bytes.length);
    written.push(entry.path);
    changed = true;
    if (cache !== null) {
      // Remote-applied bytes are known-good (hash-verified above): refresh
      // the cache entry so the next cycle skips re-reading them.
      try {
        const stat = await vault.stat(asPath(entry.path));
        if (stat.kind === 'file') {
          cache.set(entry.path, {
            size: stat.size,
            modifiedMillis: stat.modifiedMillis,
            blob: entry.blob!,
          });
        }
      } catch {
        cache.delete(entry.path);
      }
    }
  }

  for (const dir of [...mergedDirs].sort(shallowestFirst)) {
    try {
      await vault.stat(asPath(dir));
    } catch (error) {
      if (!isNotFound(error)) throw error;
      await ensureDirectory(vault, asPath(dir));
      changed = true;
    }
  }

  return { changed, written, removed };
}

/**
 * Rewrite a truthfully merged entry list into the base this replica may
 * honestly claim: every deferred file path takes its local scan value
 * (present → local entry, absent → dropped), everything else passes
 * through, and explicit directories shadowed by re-added files are
 * dropped (ancestors stay implicit, mirroring merge assembly). The cloud
 * still commits the truthful merge; only the local base diverges, so a
 * later save reconciles as a genuine concurrent edit and a revert
 * converges by downloading.
 */
function adjustBaseForDeferred(
  merged: readonly SyncManifestEntry[],
  scan: LocalScan,
  defer: (path: string) => boolean,
): SyncManifestEntry[] {
  const localFiles = new Map<string, SyncManifestEntry>();
  for (const entry of scan.entries) {
    if (entry.kind === 'file') localFiles.set(entry.path, entry);
  }
  const out: SyncManifestEntry[] = [];
  const seen = new Set<string>();
  for (const entry of merged) {
    seen.add(entry.path);
    if (entry.kind === 'file' && defer(entry.path)) {
      const local = localFiles.get(entry.path);
      if (local !== undefined) out.push(local);
      continue;
    }
    out.push(entry);
  }
  for (const [path, entry] of localFiles) {
    if (!seen.has(path) && defer(path)) out.push(entry);
  }
  const fileAncestors = new Set<string>();
  for (const entry of out) {
    if (entry.kind !== 'file') continue;
    const segments = entry.path.split('/');
    for (let end = 1; end < segments.length; end += 1) {
      fileAncestors.add(segments.slice(0, end).join('/'));
    }
  }
  return out.filter(
    (entry) => entry.kind !== 'directory' || !fileAncestors.has(entry.path),
  );
}

/**
 * Reconcile one vault replica against the shared remote. See the module
 * header for the protocol. Throws `VaultSyncError` (`REMOTE_NOT_FOUND`
 * when a persisted base exists but the remote vault is gone,
 * `HASH_MISMATCH` when a download fails verification,
 * `LOCAL_CHANGED` when a source file changed between scan and upload
 * (retry from a fresh scan — never poison the content address),
 * `ACCOUNT_CHANGED` when the identity captured at cycle start is no
 * longer live (abort before any further side effect),
 * `REMOTE_CHANGED` when contention outlasts the retry budget).
 *
 * Retry-state invariant: the merge base for attempt
 * N+1 is the remote HEAD applied in attempt N (adjusted for deferred
 * dirty paths), never the truthful merge candidate. Engine-applied
 * remote bytes must not be mistaken for user edits on retry — otherwise
 * a behind replica that applied R1 then lost a CAS to R2 would report a
 * spurious conflict instead of a clean remote-only fast-forward. Local
 * edits stay visible because the base advances to the applied remote,
 * not to the candidate that already contains them.
 */
export async function reconcileVault(
  input: ReconcileInput,
): Promise<ReconcileResult> {
  const now = input.now ?? new Date();
  const maxAttempts = input.maxCommitAttempts ?? DEFAULT_MAX_COMMIT_ATTEMPTS;
  const exclude = input.exclude ?? ((): boolean => false);
  const defer = input.defer ?? ((): boolean => false);
  const shouldAbort = input.shouldAbort ?? ((): boolean => false);
  const throwIfAborted = (): void => {
    if (shouldAbort()) {
      throw new VaultSyncError(
        'ACCOUNT_CHANGED',
        'account identity changed during sync; aborting cycle',
      );
    }
  };
  const report = (stage: SyncProgressStage): void => {
    try {
      input.onProgress?.(stage);
    } catch {
      // Progress hooks must never break the reconcile.
    }
  };
  if (input.base !== null && input.base.manifest.vaultId !== input.vaultId) {
    throw new VaultSyncError(
      'CORRUPT_MANIFEST',
      'sync base belongs to a different cloud vault',
    );
  }

  let uploadedBlobs = 0;
  let uploadedBytes = 0;
  let downloadedFiles = 0;
  let downloadedBytes = 0;
  let scannedFiles = 0;
  let hashedFiles = 0;
  const conflicts: SyncConflict[] = [];
  let appliedLocalChanges = false;
  // Provisional base for CAS retries (see header invariant). Starts as
  // the persisted base; after each attempt that applied remote bytes and
  // survived the workspace hook, it advances to that remote (deferred
  // paths keep their local values). Never persisted until a commit or
  // pull-only convergence succeeds.
  let currentBaseManifest: SyncManifest =
    input.base?.manifest ?? emptyManifest(input.vaultId);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    throwIfAborted();
    report('scan');
    const scan = await scanLocal(input.vault, exclude, input.incremental);
    scannedFiles += scan.files.size;
    hashedFiles += scan.hashedFiles;
    throwIfAborted();
    const head = await input.remote.readHead(input.vaultId);
    if (
      input.base !== null &&
      input.base.manifest.revision > 0 &&
      head === null
    ) {
      // A base recording prior commits with no remote vault means the
      // cloud copy is gone (or the binding was copied to a fresh
      // backend). Refusing is safer than resurrecting history as
      // revision 1. A revision-0 base merely means nothing ever synced,
      // so reconciling proceeds normally.
      throw new VaultSyncError(
        'REMOTE_NOT_FOUND',
        `remote vault ${input.vaultId} not found for a bound replica`,
      );
    }
    const remoteManifest: SyncManifest =
      head === null
        ? emptyManifest(input.vaultId)
        : await (async () => {
            throwIfAborted();
            return input.remote.loadManifest(
              input.vaultId,
              head.manifestHash,
              head.manifestObject,
            );
          })();
    if (head !== null) {
      // Trust-but-verify the manifest pointer: the object must hash to the
      // HEAD's manifest hash and belong to this vault at this revision.
      // Providers re-verify on load, but the engine never trusts a remote
      // pointer blindly.
      if (remoteManifest.vaultId !== input.vaultId) {
        throw new VaultSyncError(
          'CORRUPT_MANIFEST',
          `manifest vault ${remoteManifest.vaultId} does not match vault ${input.vaultId}`,
        );
      }
      if (remoteManifest.revision !== head.revision) {
        throw new VaultSyncError(
          'CORRUPT_MANIFEST',
          `manifest revision ${remoteManifest.revision} does not match HEAD revision ${head.revision}`,
        );
      }
      if ((await hashManifest(remoteManifest)) !== head.manifestHash) {
        throw new VaultSyncError(
          'CORRUPT_MANIFEST',
          'manifest content does not match its HEAD hash',
        );
      }
    }
    const baseManifest = currentBaseManifest;
    const localManifest = buildManifest({
      vaultId: input.vaultId,
      revision: head?.revision ?? input.base?.manifest.revision ?? 0,
      parentHash: input.base?.hash ?? null,
      entries: scan.entries,
    });
    report('merge');
    const filePlan = threeWayMerge(
      baseManifest,
      localManifest,
      remoteManifest,
      { now },
    );
    const semantic = await mergePropertySidecarConflicts({
      plan: filePlan,
      base: baseManifest,
      local: localManifest,
      remote: remoteManifest,
      vault: input.vault,
      syncRemote: input.remote,
      vaultId: input.vaultId,
      throwIfAborted,
      onDownload: (size) => {
        downloadedFiles += 1;
        downloadedBytes += size;
      },
    });
    const plan = semantic.plan;
    for (const conflict of plan.conflicts) conflicts.push(conflict);

    report('download');
    throwIfAborted();
    const applied = await applyMerged(
      input.vault,
      {
        ...input.remote,
        downloadBlob: async (vaultId, blob) => {
          const generated = semantic.blobs.get(blob);
          if (generated !== undefined) return generated;
          throwIfAborted();
          return input.remote.downloadBlob(vaultId, blob);
        },
      },
      input.vaultId,
      scan,
      plan.merged,
      defer,
      {
        onDownload: (size) => {
          downloadedFiles += 1;
          downloadedBytes += size;
        },
      },
      input.incremental?.cache ?? null,
    );
    if (applied.changed) {
      appliedLocalChanges = true;
    }
    const appliedWritten = [...applied.written].sort();
    const appliedRemoved = [...applied.removed].sort();
    const appliedPaths = [...appliedWritten, ...appliedRemoved].sort();

    // Immediate workspace reconciliation: the
    // application reloads clean sessions BEFORE any upload/CAS, so a
    // later network failure can never leave stale editor state behind.
    // Throwing blocks further protocol advancement for this attempt.
    if (
      input.onLocalApplied !== undefined &&
      (appliedWritten.length > 0 || appliedRemoved.length > 0)
    ) {
      await input.onLocalApplied({
        written: appliedWritten,
        removed: appliedRemoved,
      });
    }

    if (input.onConflictsPreserved !== undefined && plan.conflicts.length > 0) {
      throwIfAborted();
      await input.onConflictsPreserved(plan.conflicts);
    }

    // Post-apply checkpoint: once remote bytes are materialized
    // and the workspace hook succeeded, persist the truthful remote
    // ancestor BEFORE any failure-prone outbound work. Without this, a
    // network failure after apply followed by another device's R3 would
    // misclassify already-materialized R2 bytes as local edits on retry
    // (spurious conflicts). Deferred dirty paths keep local values.
    // A throwing checkpoint aborts before upload/CAS.
    if (
      input.onCheckpoint !== undefined &&
      (appliedWritten.length > 0 || appliedRemoved.length > 0) &&
      head !== null
    ) {
      throwIfAborted();
      const checkpointEntries = adjustBaseForDeferred(
        remoteManifest.entries,
        scan,
        defer,
      );
      const checkpointManifest = buildManifest({
        vaultId: input.vaultId,
        revision: remoteManifest.revision,
        parentHash: remoteManifest.parentHash,
        entries: checkpointEntries,
      });
      parseSyncManifest({
        ...checkpointManifest,
        entries: [...checkpointManifest.entries],
      });
      const checkpointHash = await hashManifest(checkpointManifest);
      await input.onCheckpoint({
        manifest: checkpointManifest,
        hash: checkpointHash,
      });
      // The provisional in-memory base for CAS retries also advances to
      // the just-applied remote now (not only after REMOTE_CHANGED), so
      // even a same-invocation upload failure followed by an internal
      // LOCAL_CHANGED retry stays truthful.
      currentBaseManifest = checkpointManifest;
    }

    // The base this replica may claim: truthful merge, except deferred
    // (dirty-session) paths keep their local values.
    const baseEntries = adjustBaseForDeferred(plan.merged, scan, defer);

    if (
      manifestsEqual(
        { ...remoteManifest, entries: plan.merged },
        remoteManifest,
      )
    ) {
      // Converged with remote: adopt the remote manifest as the new base
      // without committing (pull-only sync advances the base for free),
      // still adjusted for any deferral.
      const adjusted = buildManifest({
        vaultId: input.vaultId,
        revision: remoteManifest.revision,
        parentHash: remoteManifest.parentHash,
        entries: baseEntries,
      });
      parseSyncManifest({ ...adjusted, entries: [...adjusted.entries] });
      const hash = await hashManifest(adjusted);
      return {
        base: { manifest: adjusted, hash },
        revision: remoteManifest.revision,
        committed: false,
        appliedLocalChanges,
        appliedPaths,
        appliedWritten,
        appliedRemoved,
        scannedFiles,
        hashedFiles,
        uploadedBlobs,
        uploadedBytes,
        downloadedFiles,
        downloadedBytes,
        conflicts,
      };
    }

    // Guard the merge output before it can touch shared state: a merge bug
    // must fail locally, never corrupt the cloud vault.
    const revision = (head?.revision ?? 0) + 1;
    const candidate = buildManifest({
      vaultId: input.vaultId,
      revision,
      parentHash: head?.manifestHash ?? null,
      entries: plan.merged,
    });
    parseSyncManifest({ ...candidate, entries: [...candidate.entries] });
    const hash = await hashManifest(candidate);

    // The cloud commits the truthful merge; this replica's base keeps
    // local values for deferred paths.
    const adjustedBase = buildManifest({
      vaultId: input.vaultId,
      revision,
      parentHash: head?.manifestHash ?? null,
      entries: baseEntries,
    });
    parseSyncManifest({ ...adjustedBase, entries: [...adjustedBase.entries] });
    const baseHash = await hashManifest(adjustedBase);

    report('upload');
    throwIfAborted();
    const remoteBlobs = new Set<string>();
    for (const entry of remoteManifest.entries) {
      if (entry.kind === 'file' && typeof entry.blob === 'string')
        remoteBlobs.add(entry.blob);
    }
    let fileCount = 0;
    let totalBytes = 0;
    try {
      for (const entry of candidate.entries) {
        if (entry.kind !== 'file') continue;
        const entryBlob = entry.blob;
        const entrySize = entry.size;
        if (typeof entryBlob !== 'string' || typeof entrySize !== 'number') {
          throw new VaultSyncError(
            'CORRUPT_MANIFEST',
            `candidate file is missing its blob identity: ${entry.path}`,
          );
        }
        fileCount += 1;
        totalBytes += entrySize;
        if (remoteBlobs.has(entryBlob)) continue;
        throwIfAborted();
        if (!(await input.remote.hasBlob(input.vaultId, entryBlob))) {
          const generated = semantic.blobs.get(entryBlob);
          const source = scan.blobSources.get(entryBlob);
          if (source === undefined && generated === undefined) {
            // The file vanished between scan and upload (concurrent
            // local delete/move): not corruption, just a raced local
            // change. Invalidate the hint and retry from a fresh scan.
            input.incremental?.cache?.delete(source ?? '');
            throw new VaultSyncError(
              'LOCAL_CHANGED',
              `local source vanished after scan for blob ${entryBlob}`,
            );
          }
          let bytes: Uint8Array;
          if (generated !== undefined) {
            bytes = generated;
          } else {
            if (source === undefined) {
              throw new VaultSyncError(
                'LOCAL_CHANGED',
                `local source vanished after scan for blob ${entryBlob}`,
              );
            }
            try {
              bytes = await input.vault.read(asPath(source));
            } catch {
              input.incremental?.cache?.delete(source);
              throw new VaultSyncError(
                'LOCAL_CHANGED',
                `local source unreadable after scan: ${source}`,
              );
            }
          }
          // Content-address safety: never upload bytes under a stale
          // hash. The file may have changed between scan (hash A) and
          // upload (now version B). Uploading B under hash A would
          // permanently poison the immutable object key.
          const actual = await hashBytes(bytes);
          if (actual !== entryBlob) {
            // Invalidate the cached identity so the retry definitely
            // re-hashes the new bytes instead of reusing the stale hint.
            if (source !== undefined) input.incremental?.cache?.delete(source);
            throw new VaultSyncError(
              'LOCAL_CHANGED',
              `local file changed after scan: ${source}`,
            );
          }
          throwIfAborted();
          await input.remote.uploadBlob(input.vaultId, entryBlob, bytes);
          uploadedBlobs += 1;
          uploadedBytes += bytes.length;
        }
      }

      throwIfAborted();
      const uploaded = await input.remote.uploadManifest(
        input.vaultId,
        candidate,
      );
      if (uploaded.hash !== hash) {
        throw new VaultSyncError(
          'CORRUPT_MANIFEST',
          'remote stored a different manifest hash than committed',
        );
      }
      try {
        throwIfAborted();
        await input.remote.compareAndSwapHead(
          input.vaultId,
          head === null
            ? null
            : { revision: head.revision, manifestHash: head.manifestHash },
          {
            name: input.name,
            revision,
            manifestHash: hash,
            manifestObject: uploaded.object,
            fileCount,
            totalBytes,
            updatedByDeviceId: input.deviceId,
          },
        );
      } catch (error) {
        if (
          error instanceof VaultSyncError &&
          error.code === 'REMOTE_CHANGED' &&
          attempt < maxAttempts
        ) {
          // Advance the provisional base to the remote just applied
          // (deferred paths keep local values) so the retry does not
          // mistake engine-applied bytes for user edits.
          currentBaseManifest = buildManifest({
            vaultId: input.vaultId,
            revision: remoteManifest.revision,
            parentHash: remoteManifest.parentHash,
            entries: adjustBaseForDeferred(remoteManifest.entries, scan, defer),
          });
          continue;
        }
        throw error;
      }
    } catch (error) {
      if (
        error instanceof VaultSyncError &&
        error.code === 'LOCAL_CHANGED' &&
        attempt < maxAttempts
      ) {
        // Local raced the upload: the next attempt re-scans and re-hashes
        // (the stale cache entry was already invalidated above).
        continue;
      }
      if (
        error instanceof VaultSyncError &&
        (error.code === 'ACCOUNT_CHANGED' || error.code === 'NOT_AUTHENTICATED')
      ) {
        // Identity loss aborts the whole reconcile immediately — never
        // retry under a new identity with stale local/merge state.
        throw error;
      }
      throw error;
    }
    return {
      base: { manifest: adjustedBase, hash: baseHash },
      revision,
      committed: true,
      appliedLocalChanges,
      appliedPaths,
      appliedWritten,
      appliedRemoved,
      scannedFiles,
      hashedFiles,
      uploadedBlobs,
      uploadedBytes,
      downloadedFiles,
      downloadedBytes,
      conflicts,
    };
  }
  throw new VaultSyncError(
    'REMOTE_CHANGED',
    `HEAD contention outlasted ${maxAttempts} attempts for vault ${input.vaultId}`,
  );
}
