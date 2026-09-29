/**
 * Native filesystem `VaultService` provider.
 *
 * Implements the portable vault contract over a real host
 * directory using Node's `fs/promises`. This is the "real native storage
 * foundation" the mission requires: the same workspace/capability
 * contracts that run over the in-memory reference provider run unchanged
 * over real, durable, reopenable storage.
 *
 * Security model:
 *
 * - the provider never touches anything outside its canonical root:
 *   every operation realpaths the parent directory and rejects paths that
 *   resolve outside the root (`UNSUPPORTED`);
 * - symlinks are not followed: a symlink at the final path element makes
 *   the operation fail with `UNSUPPORTED`, and symlink entries are
 *   excluded from listings (host links have no representation in the
 *   portable contract and the vault never creates them);
 * - `..`/`.`/NUL/backslash spellings are already rejected by the portable
 *   path layer before they reach the host.
 *
 * Write semantics: content is written to a sibling temporary file
 * (`.<name>.froglight-tmp-<uuid>`), fsynced, closed, and renamed over the
 * target, so a completed `write` is never observed partially written
 * (atomicReplace) and survives process crash (durableFlush: rename plus a
 * best-effort directory fsync).
 *
 * Capabilities are declared honestly for a POSIX host: case-sensitive
 * lookups (runtime-probed), no name normalization, atomic replace,
 * durable flush, move support, reopen support.
 */

import { randomUUID } from 'node:crypto';
import { open, mkdir, readdir, readFile, realpath, rename, rm, stat, lstat, unlink, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Dirent, Stats } from 'node:fs';
import {
  isWithinPath,
  parsePath,
  ROOT_PATH,
  VaultError,
  type WorkspacePath,
  type VaultCapabilities,
  type VaultEntry,
  type VaultOperation,
  type VaultOperationOptions,
  type VaultService,
  type VaultStat,
} from '@froglight/foundation';
import { isFsNotFound, mapFsError } from './error-map.js';

/** Test-only failure injector: return an error to make an operation fail. */
export type NativeFsFailureInjector = (
  operation: VaultOperation,
  path: WorkspacePath,
) => Error | null;

export interface NativeFsVaultOptions {
  /**
   * Absolute host path of the workspace root directory. Created
   * recursively when missing.
   */
  readonly root: string;
  /**
   * Declared case semantics; when omitted the provider probes the root
   * directory at create time and reports what the host actually does
   * (`unknown` when the probe itself cannot run).
   */
  readonly caseSensitivity?: 'sensitive' | 'insensitive' | 'unknown';
  /** Test-only failure injection (checked before each mutation commits). */
  readonly fail?: NativeFsFailureInjector;
}

function assertNotAborted(options: VaultOperationOptions | undefined, path: WorkspacePath): void {
  if (options?.signal?.aborted) {
    throw new VaultError('ABORTED', 'operation aborted', { path });
  }
}

/** True when `candidate` is the canonical root or below it. */
function isWithinRoot(candidate: string, realRoot: string): boolean {
  return candidate === realRoot || candidate.startsWith(`${realRoot}/`);
}

/**
 * Probe how name lookups actually behave on this host: write one probe file
 * and try to stat a differently-cased spelling of it. The probe file is
 * removed before the vault is handed out.
 */
async function probeCaseSensitivity(root: string): Promise<'sensitive' | 'insensitive' | 'unknown'> {
  const probe = `.froglight-case-probe-${randomUUID()}`;
  const exact = join(root, probe);
  const different = join(root, probe.toUpperCase());
  try {
    await mkdir(root, { recursive: true });
    await writeFileAtomic(exact, new Uint8Array(0), root, null);
    try {
      await lstat(different);
      return 'insensitive';
    } catch {
      return 'sensitive';
    }
  } catch {
    return 'unknown';
  } finally {
    await rm(exact, { force: true }).catch(() => undefined);
  }
}

/** Atomic temp-file write used by both `write` and the case probe. */
async function writeFileAtomic(
  target: string,
  data: Uint8Array,
  parent: string,
  fail: NativeFsFailureInjector | null,
  path?: WorkspacePath,
): Promise<void> {
  const tmp = join(parent, `.froglight-tmp-${randomUUID()}`);
  const handle = await open(tmp, 'wx');
  try {
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
  if (fail !== null && path !== undefined) {
    const injected = fail('write', path);
    if (injected !== null) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw injected;
    }
  }
  await rename(tmp, target);
  // Best-effort directory fsync so the rename is durable across a crash.
  await fsyncDirectory(parent);
}

/** Open the parent directory and fsync it; best-effort across platforms. */
async function fsyncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch {
    // Some hosts refuse to open/fsync directories (EINVAL/EISDIR/...);
    // the rename itself is already atomic either way.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export class NativeFsVault implements VaultService {
  readonly capabilities: VaultCapabilities;
  readonly #root: string;
  readonly #realRoot: string;
  readonly #fail: NativeFsFailureInjector | null;
  readonly #caseSensitivity: 'sensitive' | 'insensitive' | 'unknown';

  private constructor(options: NativeFsVaultOptions, realRoot: string) {
    this.#root = options.root;
    this.#realRoot = realRoot;
    this.#fail = options.fail ?? null;
    this.#caseSensitivity = options.caseSensitivity ?? 'sensitive';
    this.capabilities = {
      caseSensitivity: this.#caseSensitivity,
      nameNormalization: 'none',
      atomicReplace: true,
      durableFlush: true,
      supportsMove: true,
      supportsReopen: true,
    };
  }

  /**
   * Create a vault rooted at `options.root` (created recursively when
   * missing). The root is canonicalized with `realpath` and the case
   * sensitivity is probed when not declared.
   */
  static async create(options: NativeFsVaultOptions): Promise<NativeFsVault> {
    if (typeof options.root !== 'string' || options.root.length === 0) {
      throw new VaultError('INVALID_PATH', 'native vault root must be a non-empty path', {
        path: null,
      });
    }
    await mkdir(options.root, { recursive: true });
    const realRoot = await realpath(options.root);
    const caseSensitivity =
      options.caseSensitivity ?? (await probeCaseSensitivity(options.root));
    return new NativeFsVault(
      { root: options.root, caseSensitivity, fail: options.fail },
      realRoot,
    );
  }

  /**
   * Resolve the parent directory of `path` and verify it is inside the
   * canonical root. Throws `NOT_FOUND` when the parent is missing and
   * `UNSUPPORTED` when the parent resolves outside the root (symlink
   * escape) or when any intermediate component is a symlink.
   */
  async #guardedParent(path: WorkspacePath): Promise<string> {
    const segments = parsePath(path);
    if (segments.length <= 1) {
      // Root's parent is the root itself; just verify root is not a symlink escape
      // (it can't be, but we still check for consistency).
      return this.#root;
    }
    // Walk each prefix of the parent path, checking for symlinks and
    // resolving case-insensitively when needed.
    let currentHost = this.#root;
    for (let i = 0; i < segments.length - 1; i++) {
      const segment = segments[i];
      if (segment === undefined) { continue; }
      const nextHost = await this.#resolveSegment(currentHost, segment, path);
      if (nextHost === null) {
        throw new VaultError('NOT_FOUND', `no such directory: ${path}`, { path });
      }
      // Check the resolved entry is not a symlink and is a directory
      let st: Stats;
      try {
        st = await lstat(nextHost);
      } catch (error) {
        throw mapFsError(error, path);
      }
      if (st.isSymbolicLink()) {
        throw new VaultError('UNSUPPORTED', `symlinks are not supported: ${path}`, { path });
      }
      if (!st.isDirectory()) {
        throw new VaultError('NOT_DIRECTORY', `not a directory: ${path}`, { path });
      }
      // Verify the canonical path is still within the root (defense in depth)
      let canonical: string;
      try {
        canonical = await realpath(nextHost);
      } catch (error) {
        throw mapFsError(error, path);
      }
      if (!isWithinRoot(canonical, this.#realRoot)) {
        throw new VaultError('UNSUPPORTED', `path escapes the vault root: ${path}`, { path });
      }
      currentHost = nextHost;
    }
    return currentHost;
  }

  /** Resolve a single path segment inside `dirHost`, case-insensitively when needed. */
  async #resolveSegment(
    dirHost: string,
    segment: string,
    vaultPath: WorkspacePath,
  ): Promise<string | null> {
    if (this.#caseSensitivity !== 'insensitive') {
      const candidate = join(dirHost, segment);
      try {
        await lstat(candidate);
        return candidate;
      } catch (error) {
        if (isFsNotFound(error)) {
          return null;
        }
        throw mapFsError(error, vaultPath);
      }
    }
    // Insensitive: scan directory for case-insensitive match
    let dirents: Dirent[];
    try {
      dirents = await readdir(dirHost, { withFileTypes: true });
    } catch (error) {
      throw mapFsError(error, vaultPath);
    }
    const folded = segment.toLowerCase();
    for (const dirent of dirents) {
      if (dirent.name.toLowerCase() === folded) {
        return join(dirHost, dirent.name);
      }
    }
    return null;
  }

  /** lstat the final element; `null` when absent. Rejects symlinks. Handles case-insensitive lookup. */
  async #guardedLeaf(path: WorkspacePath): Promise<{ stats: Stats; host: string } | null> {
    const segments = parsePath(path);
    if (segments.length === 0) {
      return null;
    }
    const parentHost = await this.#guardedParent(path);
    const leafName = segments[segments.length - 1];
    if (leafName === undefined) { return null; }
    let leafHost: string | null;
    if (this.#caseSensitivity === 'insensitive') {
      leafHost = await this.#resolveSegment(parentHost, leafName, path);
      if (leafHost === null) {
        return null;
      }
    } else {
      leafHost = join(parentHost, leafName);
      try {
        await lstat(leafHost);
      } catch (error) {
        if (isFsNotFound(error)) {
          return null;
        }
        throw mapFsError(error, path);
      }
    }
    let entry: Stats;
    try {
      entry = await lstat(leafHost);
    } catch (error) {
      if (isFsNotFound(error)) {
        return null;
      }
      throw mapFsError(error, path);
    }
    if (entry.isSymbolicLink()) {
      throw new VaultError('UNSUPPORTED', `symlinks are not supported: ${path}`, { path });
    }
    return { stats: entry, host: leafHost };
  }

  async stat(path: WorkspacePath, options?: VaultOperationOptions): Promise<VaultStat> {
    assertNotAborted(options, path);
    if (path === ROOT_PATH) {
      await stat(this.#realRoot);
      return { path, kind: 'directory', size: 0, modifiedMillis: null };
    }
    await this.#guardedParent(path);
    const leaf = await this.#guardedLeaf(path);
    if (leaf === null) {
      throw new VaultError('NOT_FOUND', `no such resource: ${path}`, { path });
    }
    if (leaf.stats.isDirectory()) {
      return { path, kind: 'directory', size: 0, modifiedMillis: null };
    }
    return {
      path,
      kind: 'file',
      size: leaf.stats.size,
      modifiedMillis: Math.round(leaf.stats.mtimeMs),
    };
  }

  async list(path: WorkspacePath, options?: VaultOperationOptions): Promise<readonly VaultEntry[]> {
    assertNotAborted(options, path);
    if (path === ROOT_PATH) {
      let dirents: Dirent[];
      try {
        dirents = await readdir(this.#root, { withFileTypes: true });
      } catch (error) {
        throw mapFsError(error, path);
      }
      const entries: VaultEntry[] = [];
      for (const dirent of dirents) {
        if (dirent.isSymbolicLink()) {
          continue;
        }
        entries.push({ name: dirent.name, kind: dirent.isDirectory() ? 'directory' : 'file' });
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return entries;
    }
    await this.#guardedParent(path);
    const leaf = await this.#guardedLeaf(path);
    if (leaf === null) {
      throw new VaultError('NOT_FOUND', `no such directory: ${path}`, { path });
    }
    if (!leaf.stats.isDirectory()) {
      throw new VaultError('NOT_DIRECTORY', `not a directory: ${path}`, { path });
    }
    let dirents: Dirent[];
    try {
      dirents = await readdir(leaf.host, { withFileTypes: true });
    } catch (error) {
      throw mapFsError(error, path);
    }
    const entries: VaultEntry[] = [];
    for (const dirent of dirents) {
      if (dirent.isSymbolicLink()) {
        // Host links are outside the portable model; never expose them.
        continue;
      }
      entries.push({ name: dirent.name, kind: dirent.isDirectory() ? 'directory' : 'file' });
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return entries;
  }

  async createDirectory(path: WorkspacePath, options?: VaultOperationOptions): Promise<void> {
    assertNotAborted(options, path);
    if (path === ROOT_PATH) {
      throw new VaultError('ALREADY_EXISTS', 'the vault root already exists', { path });
    }
    const parentHost = await this.#guardedParent(path);
    const leaf = await this.#guardedLeaf(path);
    if (leaf !== null) {
      throw new VaultError('ALREADY_EXISTS', `already exists: ${path}`, { path });
    }
    this.#failIfNeeded('createDirectory', path);
    const segments = parsePath(path);
    const leafName = segments[segments.length - 1];
    if (leafName === undefined) { throw new VaultError('INVALID_PATH', `invalid path: ${path}`, { path }); }
    const host = join(parentHost, leafName);
    try {
      await mkdir(host);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
        throw new VaultError('ALREADY_EXISTS', `already exists: ${path}`, { path });
      }
      throw mapFsError(error, path);
    }
  }

  async read(path: WorkspacePath, options?: VaultOperationOptions): Promise<Uint8Array> {
    assertNotAborted(options, path);
    if (path === ROOT_PATH) {
      throw new VaultError('IS_DIRECTORY', 'cannot read the vault root', { path });
    }
    await this.#guardedParent(path);
    const leaf = await this.#guardedLeaf(path);
    if (leaf === null) {
      throw new VaultError('NOT_FOUND', `no such resource: ${path}`, { path });
    }
    if (!leaf.stats.isFile()) {
      throw new VaultError('IS_DIRECTORY', `is a directory: ${path}`, { path });
    }
    let data: Uint8Array;
    try {
      const buffer = await readFile(leaf.host);
      data = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    } catch (error) {
      throw mapFsError(error, path);
    }
    // Copy so callers cannot alias the host buffer.
    return Uint8Array.from(data);
  }

  async write(
    path: WorkspacePath,
    data: Uint8Array,
    options?: VaultOperationOptions,
  ): Promise<void> {
    assertNotAborted(options, path);
    if (path === ROOT_PATH) {
      throw new VaultError('IS_DIRECTORY', 'cannot write the vault root', { path });
    }
    const parentHost = await this.#guardedParent(path);
    const leaf = await this.#guardedLeaf(path);
    if (leaf !== null && !leaf.stats.isFile()) {
      throw new VaultError('IS_DIRECTORY', `is a directory: ${path}`, { path });
    }
    // For case-insensitive, overwrite the existing file's actual host path
    const writeSegments = parsePath(path);
    const writeLeafName = writeSegments[writeSegments.length - 1];
    if (writeLeafName === undefined) { throw new VaultError('INVALID_PATH', `invalid path: ${path}`, { path }); }
    const targetHost = leaf?.host ?? join(parentHost, writeLeafName);
    try {
      await writeFileAtomic(targetHost, data, parentHost, this.#fail, path);
    } catch (error) {
      if (error instanceof VaultError) {
        throw error;
      }
      throw mapFsError(error, path);
    }
  }

  async remove(path: WorkspacePath, options?: VaultOperationOptions): Promise<void> {
    assertNotAborted(options, path);
    if (path === ROOT_PATH) {
      throw new VaultError('CONFLICT', 'the vault root may never be removed', { path });
    }
    await this.#guardedParent(path);
    const leaf = await this.#guardedLeaf(path);
    if (leaf === null) {
      throw new VaultError('NOT_FOUND', `no such resource: ${path}`, { path });
    }
    this.#failIfNeeded('remove', path);
    try {
      if (leaf.stats.isDirectory()) {
        await rmdir(leaf.host);
      } else {
        await unlink(leaf.host);
      }
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOTEMPTY') {
        throw new VaultError('CONFLICT', `directory is not empty: ${path}`, { path });
      }
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        throw new VaultError('NOT_FOUND', `no such resource: ${path}`, { path });
      }
      throw mapFsError(error, path);
    }
  }

  async move(
    from: WorkspacePath,
    to: WorkspacePath,
    options?: VaultOperationOptions,
  ): Promise<void> {
    assertNotAborted(options, from);
    if (from === ROOT_PATH || to === ROOT_PATH) {
      throw new VaultError('CONFLICT', 'the vault root may never be moved', { path: from });
    }
    if (isWithinPath(to, from)) {
      throw new VaultError('CONFLICT', `cannot move a path into its own subtree: ${from}`, {
        path: from,
      });
    }
    await this.#guardedParent(from);
    const toParent = await this.#guardedParent(to);
    const source = await this.#guardedLeaf(from);
    if (source === null) {
      throw new VaultError('NOT_FOUND', `no such resource: ${from}`, { path: from });
    }
    const target = await this.#guardedLeaf(to);
    if (target !== null) {
      throw new VaultError('CONFLICT', `target already exists: ${to}`, { path: to });
    }
    this.#failIfNeeded('move', from);
    const toSegments = parsePath(to);
    const toLeafName = toSegments[toSegments.length - 1];
    if (toLeafName === undefined) { throw new VaultError('INVALID_PATH', `invalid path: ${to}`, { path: to }); }
    const toHost = join(toParent, toLeafName);
    try {
      await rename(source.host, toHost);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        throw new VaultError('NOT_FOUND', `no such resource: ${from}`, { path: from });
      }
      throw mapFsError(error, from);
    }
    // Moving a directory subtree changes the parent; fsync both parents so
    // the move is durable.
    await fsyncDirectory(dirname(source.host)).catch(() => undefined);
  }

  #failIfNeeded(operation: VaultOperation, path: WorkspacePath): void {
    if (this.#fail) {
      const error = this.#fail(operation, path);
      if (error !== null) {
        throw error;
      }
    }
  }
}

/** Re-exported for plugin configs that reuse the provider types. */
export type { VaultService, WorkspacePath };
