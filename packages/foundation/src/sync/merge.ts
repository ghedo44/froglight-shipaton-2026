/**
 * Three-way file-level merge.
 *
 * Eventual synchronization, not realtime collaboration:
 *
 * ```text
 * base = last synchronized manifest (this replica)
 * local = current local scan
 * remote = current remote HEAD manifest
 * ```
 *
 * Per path:
 *
 * ```text
 * local-only change → take local
 * remote-only change → take remote
 * same change → converged
 * concurrent change → conflict (both versions preserved, never dropped)
 * ```
 *
 * Conflict policy (V1):
 *
 * - concurrent file edits: the local version keeps the original path and
 *   the remote version is preserved at a deterministic conflict copy
 *   (`stem.conflict-<base6>-<local6>-<remote6><ext>`, derived from
 *   immutable blob identities — never wall-clock time); the next sync
 *   converges because both sides then share the merged state.
 *  Last-writer-wins timestamps are never used.
 * - delete-vs-edit preserves the edited version (no conflict copy: the
 *   deletion is overridden by documented rule, reported in the plan).
 * - file-vs-directory collisions keep the local occupant at the original
 *   path and relocate the remote subtree under a conflict directory.
 * - renames are delete+add; same-blob renames on both sides to different
 *   names keep both names (duplicated content, zero loss).
 */

import type { SyncManifest, SyncManifestEntry } from './contract.js';

export type SyncConflictKind =
  | 'edit-edit'
  | 'delete-edit'
  | 'edit-delete'
  | 'file-directory';

/** One preserved conflict: both versions survive with explicit placement. */
export interface SyncConflict {
  /** Original path. */
  readonly path: string;
  readonly kind: SyncConflictKind;
  /**
   * Where the relocated remote version lives (`edit-edit`: conflict file;
   * `file-directory`: conflict file or directory). Null when the edited
   * version simply occupies `path` (`delete-edit`, `edit-delete`).
   */
  readonly conflictPath: string | null;
  /** Which version occupies `path` in the merged manifest. */
  readonly kept: 'local' | 'remote';
}

export interface MergePlan {
  /** Converged entries including assigned conflict copies. */
  readonly merged: readonly SyncManifestEntry[];
  readonly conflicts: readonly SyncConflict[];
}

export interface MergeOptions {
  /** Clock for conflict-copy timestamps (injectable for determinism). */
  readonly now?: Date;
}

function sameFile(
  left: SyncManifestEntry | undefined,
  right: SyncManifestEntry | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  if (left.kind !== 'file' || right.kind !== 'file') return false;
  return left.blob === right.blob;
}

function splitName(path: string): { dir: string; stem: string; ext: string } {
  const slash = path.lastIndexOf('/');
  const dir = slash < 0 ? '' : path.slice(0, slash);
  const name = slash < 0 ? path : path.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  // Leading-dot names (`.env`) count as extensionless; `a.b.c` → `a.b` + `.c`.
  if (dot <= 0) return { dir, stem: name, ext: '' };
  return { dir, stem: name.slice(0, dot), ext: name.slice(dot) };
}

/** Short content identity for conflict names (`000000` when absent). */
function shortHex(blob: string | null | undefined): string {
  if (typeof blob !== 'string' || blob.length === 0) return '000000';
  const hex = blob.replace(/^sha256:/, '');
  if (!/^[0-9a-f]+$/.test(hex)) return '000000';
  return hex.slice(0, 6).padEnd(6, '0');
}

/**
 * Synchronous fingerprint for subtree identity (FNV-1a, 6 hex chars).
 * The merge runs synchronously (no WebCrypto), so directory-conflict
 * identity folds the sorted remote subtree into a short stable digest
 * instead of async-hashing it. Collision resistance comes from the
 * underlying blob hashes folded in; the digest only compacts them.
 */
function fingerprint(parts: readonly string[]): string {
  const input = parts.join('|');
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0').slice(0, 6);
}

export interface ConflictIdentity {
  /** Base blob at the path (null when the path is new on both sides). */
  readonly baseBlob?: string | null;
  /** Local blob at the path (null when locally absent). */
  readonly localBlob?: string | null;
  /** Remote blob at the path (null when remotely absent). */
  readonly remoteBlob?: string | null;
}

/**
 * Deterministic, collision-safe conflict path. Derived from immutable
 * merge inputs (base/local/remote blob identities at the path) — never
 * from wall-clock time — so two devices reconciling the same conflict
 * generate byte-identical paths and CAS retries converge instead of
 * creating duplicate copies. Numeric disambiguation against every path
 * the merged manifest already occupies guarantees an existing conflict
 * file is never overwritten.
 */
export function assignConflictPath(
  occupied: ReadonlySet<string>,
  original: string,
  remoteBlob: string,
  now?: Date,
  identity: ConflictIdentity = {},
): string {
  const { dir, stem, ext } = splitName(original);
  const prefix = dir === '' ? '' : `${dir}/`;
  void now;
  const baseShort = shortHex(identity.baseBlob ?? null);
  const localShort = shortHex(identity.localBlob ?? null);
  const remoteShort = shortHex(remoteBlob);
  const base = `${prefix}${stem}.conflict-${baseShort}-${localShort}-${remoteShort}`;
  let candidate = `${base}${ext}`;
  let counter = 2;
  while (occupied.has(candidate)) {
    candidate = `${base}-${counter}${ext}`;
    counter += 1;
  }
  return candidate;
}

/** Conflict directory for a relocated remote subtree (same guarantees). */
export function assignConflictDirectory(
  occupied: ReadonlySet<string>,
  original: string,
  remoteBlob: string,
  now?: Date,
  identity: ConflictIdentity & { readonly subtree?: readonly string[] } = {},
): string {
  // Directories never take the original extension: the name is built
  // directly (re-splitting the file-style name would strip at the
  // `.conflict-` dot for extensionless originals and collide).
  const { dir, stem } = splitName(original);
  const prefix = dir === '' ? '' : `${dir}/`;
  void now;
  void remoteBlob;
  const baseShort = shortHex(identity.baseBlob ?? null);
  const localShort = shortHex(identity.localBlob ?? null);
  const subtree = identity.subtree ?? [];
  const digest =
    subtree.length > 0
      ? fingerprint(subtree)
      : shortHex(identity.remoteBlob ?? null);
  const base = `${prefix}${stem}.conflict-${baseShort}-${localShort}-${digest}`;
  let candidate = base;
  let counter = 2;
  while (occupied.has(candidate)) {
    candidate = `${base}-${counter}`;
    counter += 1;
  }
  return candidate;
}

interface FileMaps {
  readonly base: ReadonlyMap<string, SyncManifestEntry>;
  readonly local: ReadonlyMap<string, SyncManifestEntry>;
  readonly remote: ReadonlyMap<string, SyncManifestEntry>;
}

function fileMap(
  manifest: SyncManifest,
): ReadonlyMap<string, SyncManifestEntry> {
  const map = new Map<string, SyncManifestEntry>();
  for (const entry of manifest.entries) {
    if (entry.kind === 'file') map.set(entry.path, entry);
  }
  return map;
}

function dirSet(manifest: SyncManifest): ReadonlySet<string> {
  const set = new Set<string>();
  for (const entry of manifest.entries) {
    if (entry.kind === 'directory') set.add(entry.path);
  }
  return set;
}

/** Explicit dirs plus every ancestor implied by a file entry. */
function effectiveDirs(
  explicit: ReadonlySet<string>,
  files: ReadonlyMap<string, SyncManifestEntry>,
): ReadonlySet<string> {
  const present = new Set(explicit);
  for (const path of files.keys()) {
    const segments = path.split('/');
    for (let end = 1; end < segments.length; end += 1) {
      present.add(segments.slice(0, end).join('/'));
    }
  }
  return present;
}

/**
 * Three-way merge over file entries plus explicit directory sets.
 * Inputs must already be validated (`parseSyncManifest`); paths are
 * compared as opaque code-unit strings. Pure and deterministic given
 * `now` — no I/O, no network.
 */
export function threeWayMerge(
  base: SyncManifest,
  local: SyncManifest,
  remote: SyncManifest,
  options: MergeOptions = {},
): MergePlan {
  const now = options.now ?? new Date();
  const maps: FileMaps = {
    base: fileMap(base),
    local: fileMap(local),
    remote: fileMap(remote),
  };
  const baseDirs = dirSet(base);
  const localDirs = dirSet(local);
  const remoteDirs = dirSet(remote);
  const baseEffective = effectiveDirs(baseDirs, maps.base);
  const localEffective = effectiveDirs(localDirs, maps.local);
  const remoteEffective = effectiveDirs(remoteDirs, maps.remote);

  const mergedFiles = new Map<string, SyncManifestEntry>();
  const conflicts: SyncConflict[] = [];
  const occupied = new Set<string>();
  for (const path of new Set([
    ...maps.base.keys(),
    ...maps.local.keys(),
    ...maps.remote.keys(),
    ...baseEffective,
    ...localEffective,
    ...remoteEffective,
  ])) {
    occupied.add(path);
  }

  // Remote subtree relocation targets must also reserve their descendants.
  const filePaths = new Set([
    ...maps.base.keys(),
    ...maps.local.keys(),
    ...maps.remote.keys(),
  ]);
  for (const path of [...filePaths].sort()) {
    const b = maps.base.get(path);
    const l = maps.local.get(path);
    const r = maps.remote.get(path);
    if (sameFile(l, r)) {
      if (l !== undefined) mergedFiles.set(path, l);
      continue;
    }
    if (sameFile(b, l)) {
      // Remote-only change (create / edit / delete).
      if (r !== undefined) mergedFiles.set(path, r);
      continue;
    }
    if (sameFile(b, r)) {
      // Local-only change (create / edit / delete).
      if (l !== undefined) mergedFiles.set(path, l);
      continue;
    }
    // Concurrent change on both sides.
    if (l !== undefined && r !== undefined) {
      // edit-edit: local keeps the path; remote is preserved as a copy.
      // Identity is deterministic from immutable inputs so identical
      // conflicts on different devices produce identical paths.
      const conflictPath = assignConflictPath(occupied, path, r.blob!, now, {
        baseBlob: b?.blob ?? null,
        localBlob: l.blob ?? null,
        remoteBlob: r.blob ?? null,
      });
      occupied.add(conflictPath);
      mergedFiles.set(path, l);
      mergedFiles.set(conflictPath, {
        path: conflictPath,
        kind: 'file',
        blob: r.blob,
        size: r.size,
      });
      conflicts.push({ path, kind: 'edit-edit', conflictPath, kept: 'local' });
      continue;
    }
    if (l === undefined && r !== undefined) {
      // Local deleted, remote edited: the edited version wins.
      mergedFiles.set(path, r);
      conflicts.push({
        path,
        kind: 'delete-edit',
        conflictPath: null,
        kept: 'remote',
      });
      continue;
    }
    if (l !== undefined && r === undefined) {
      // Remote deleted, local edited: the edited version wins.
      mergedFiles.set(path, l);
      conflicts.push({
        path,
        kind: 'edit-delete',
        conflictPath: null,
        kept: 'local',
      });
      continue;
    }
  }

  // Directories: boolean presence can never conflict (all 8 combinations
  // resolve to take-local / take-remote / converged). Directories deleted
  // on one side while the other side added files beneath them survive
  // implicitly through those files.
  const dirPresent = new Map<string, boolean>();
  const dirPaths = new Set([
    ...baseEffective,
    ...localEffective,
    ...remoteEffective,
  ]);
  for (const path of [...dirPaths].sort()) {
    const b = baseEffective.has(path);
    const l = localEffective.has(path);
    const r = remoteEffective.has(path);
    if (l === r) {
      dirPresent.set(path, l);
    } else if (b === l) {
      dirPresent.set(path, r);
    } else {
      dirPresent.set(path, l);
    }
  }

  // File-vs-directory collisions: the merged state wants both a file and
  // a directory at one path (concurrent kind change, e.g. local created a
  // file where remote created a directory). Validated manifests never hold
  // both on one side, so exactly one occupant is local-origin — and the
  // local occupant keeps the original path while the remote side relocates
  // (file → conflict copy, subtree → conflict directory). Nothing is lost.
  const relocatedRemoteFiles: SyncManifestEntry[] = [];
  const relocatedRemoteDirs: string[] = [];
  const remoteDescendantsOf = (root: string): SyncManifestEntry[] => {
    const out: SyncManifestEntry[] = [];
    for (const entry of remote.entries) {
      if (entry.path === root || entry.path.startsWith(`${root}/`))
        out.push(entry);
    }
    return out;
  };
  for (const path of [...dirPaths].sort()) {
    const mergedFile = mergedFiles.get(path);
    if (mergedFile === undefined || dirPresent.get(path) !== true) continue;
    const fileIsLocalOrigin = maps.local.get(path) !== undefined;
    if (!fileIsLocalOrigin) {
      // The file is remote-origin, the directory local-origin: the local
      // directory keeps `path`, the remote file moves to a conflict copy.
      const r = maps.remote.get(path)!;
      const conflictPath = assignConflictPath(occupied, path, r.blob!, now, {
        baseBlob: maps.base.get(path)?.blob ?? null,
        localBlob: null,
        remoteBlob: r.blob ?? null,
      });
      occupied.add(conflictPath);
      mergedFiles.delete(path);
      mergedFiles.set(conflictPath, {
        path: conflictPath,
        kind: 'file',
        blob: r.blob,
        size: r.size,
      });
      conflicts.push({
        path,
        kind: 'file-directory',
        conflictPath,
        kept: 'local',
      });
      continue;
    }
    // Local file keeps `path`; relocate the entire remote subtree.
    const subtree = remoteDescendantsOf(path);
    const localFile = maps.local.get(path);
    const subtreeFingerprint = [...subtree]
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
      .map((entry) =>
        entry.kind === 'file'
          ? `${entry.path}=${entry.blob}`
          : `${entry.path}/`,
      );
    const anchor =
      subtree.find((entry) => entry.kind === 'file')?.blob ?? 'sha256:000000';
    const conflictDir = assignConflictDirectory(occupied, path, anchor, now, {
      baseBlob:
        maps.base.get(path)?.blob ??
        ([...baseEffective].includes(path) ? 'sha256:000000' : null),
      localBlob: localFile?.blob ?? null,
      remoteBlob: anchor,
      subtree: subtreeFingerprint,
    });
    occupied.add(conflictDir);
    for (const entry of subtree) {
      const relocated =
        entry.path === path
          ? conflictDir
          : `${conflictDir}${entry.path.slice(path.length)}`;
      occupied.add(relocated);
      if (entry.kind === 'file') {
        relocatedRemoteFiles.push({
          path: relocated,
          kind: 'file',
          blob: entry.blob,
          size: entry.size,
        });
      } else {
        relocatedRemoteDirs.push(relocated);
      }
    }
    dirPresent.set(path, false);
    conflicts.push({
      path,
      kind: 'file-directory',
      conflictPath: conflictDir,
      kept: 'local',
    });
  }

  // Assemble: merged files + winning conflict copies + surviving explicit
  // dirs (ancestors implied by files stay implicit — an explicit dir that
  // is an ancestor of any merged file would collide, so it is dropped).
  const merged: SyncManifestEntry[] = [
    ...mergedFiles.values(),
    ...relocatedRemoteFiles,
  ];
  const fileAncestors = new Set<string>();
  for (const entry of merged) {
    const segments = entry.path.split('/');
    for (let end = 1; end < segments.length; end += 1) {
      fileAncestors.add(segments.slice(0, end).join('/'));
    }
  }
  const dirsOut = new Set<string>();
  for (const dir of relocatedRemoteDirs) {
    if (!fileAncestors.has(dir)) dirsOut.add(dir);
  }
  for (const path of [...dirPaths].sort()) {
    if (dirPresent.get(path) !== true) continue;
    if (fileAncestors.has(path)) continue;
    // Keep the explicit entry only when a side explicitly listed it.
    if (!localDirs.has(path) && !remoteDirs.has(path)) continue;
    dirsOut.add(path);
  }
  for (const dir of [...dirsOut].sort()) {
    merged.push({ path: dir, kind: 'directory' });
  }
  merged.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { merged, conflicts };
}
