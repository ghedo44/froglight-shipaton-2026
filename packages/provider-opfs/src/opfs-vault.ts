/**
 * OPFS `VaultService` provider.
 *
 * Implements the portable vault contract over the browser
 * Origin Private File System (`navigator.storage.getDirectory()`). This is
 * the "real web storage foundation" the mission requires: the same
 * workspace/capability contracts that run over the in-memory and native
 * providers run unchanged over real browser storage.
 *
 * Security model:
 *
 * - the provider never touches anything outside its canonical root
 *   directory handle; every operation walks the handle tree from the root;
 * - `..`/`.`/NUL/backslash spellings are already rejected by the portable
 *   path layer before they reach the host;
 * - OPFS has no symlinks, so no symlink checks are needed.
 *
 * Write semantics: content is written via `FileSystemWritableFileStream`
 * (`createWritable` → `write` → `close`), which the spec guarantees is
 * atomic on close (swap-on-close). Durability is `unknown` because browser
 * flush semantics are not uniformly guaranteed.
 *
 * Capabilities are declared honestly for OPFS: case-sensitive lookups,
 * NFC name normalization, atomic replace, unknown durability, move support
 * (via copy+delete), reopen support.
 */

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
import { isDomException, mapOpfsError } from './error-map.js';

/** Test-only failure injector: return an error to make an operation fail. */
export type OpfsFailureInjector = (
  operation: VaultOperation,
  path: WorkspacePath,
) => Error | null;

export interface OpfsVaultOptions {
  /** Root directory handle (from `navigator.storage.getDirectory()`). */
  readonly root: FileSystemDirectoryHandle;
  /** Declared case semantics; defaults to `sensitive` (OPFS is case-sensitive). */
  readonly caseSensitivity?: 'sensitive' | 'insensitive';
  /** Declared normalization; defaults to `nfc` (OPFS stores NFC). */
  readonly nameNormalization?: 'none' | 'nfc';
  /** Test-only failure injection. */
  readonly fail?: OpfsFailureInjector;
}

function assertNotAborted(options: VaultOperationOptions | undefined, path: WorkspacePath): void {
  if (options?.signal?.aborted) {
    throw new VaultError('ABORTED', 'operation aborted', { path });
  }
}

export class OpfsVault implements VaultService {
  readonly capabilities: VaultCapabilities;
  readonly #root: FileSystemDirectoryHandle;
  readonly #fail: OpfsFailureInjector | null;
  readonly #caseSensitivity: 'sensitive' | 'insensitive';
  readonly #nameNormalization: 'none' | 'nfc';

  private constructor(options: OpfsVaultOptions) {
    this.#root = options.root;
    this.#fail = options.fail ?? null;
    this.#caseSensitivity = options.caseSensitivity ?? 'sensitive';
    this.#nameNormalization = options.nameNormalization ?? 'nfc';
    this.capabilities = {
      caseSensitivity: this.#caseSensitivity,
      nameNormalization: this.#nameNormalization,
      atomicReplace: true,
      durableFlush: 'unknown',
      supportsMove: true,
      supportsReopen: true,
    };
  }

  static async create(options: OpfsVaultOptions): Promise<OpfsVault> {
    if (!options.root || typeof options.root.getDirectoryHandle !== 'function') {
      throw new VaultError('INVALID_PATH', 'OPFS vault root must be a FileSystemDirectoryHandle', {
        path: null,
      });
    }
    return new OpfsVault(options);
  }

  #normalize(name: string): string {
    return this.#nameNormalization === 'nfc' ? name.normalize('NFC') : name;
  }

  #fold(name: string): string {
    return this.#caseSensitivity === 'insensitive' ? name.toLowerCase() : name;
  }

  #failIfNeeded(operation: VaultOperation, path: WorkspacePath): void {
    if (this.#fail) {
      const error = this.#fail(operation, path);
      if (error !== null) {
        throw error;
      }
    }
  }

  /**
   * Walk from root to the parent of `path`, returning the parent handle
   * and the normalized leaf name. Throws `NOT_FOUND` if any intermediate
   * directory is missing, `NOT_DIRECTORY` if an intermediate is a file.
   */
  async #resolveParent(
    path: WorkspacePath,
  ): Promise<{ parent: FileSystemDirectoryHandle; leafName: string }> {
    const segments = parsePath(path);
    if (segments.length === 0) {
      throw new VaultError('INVALID_PATH', 'invalid path', { path });
    }
    const rawLeaf = segments[segments.length - 1];
    if (rawLeaf === undefined) {
      throw new VaultError('INVALID_PATH', `invalid path: ${path}`, { path });
    }
    const leafName = this.#normalize(rawLeaf);
    const parentSegments = segments.slice(0, -1);
    let current = this.#root;
    for (const rawSegment of parentSegments) {
      const segment = this.#normalize(rawSegment);
      let next: FileSystemDirectoryHandle | null = null;
      if (this.#caseSensitivity === 'insensitive') {
        let found: FileSystemDirectoryHandle | null = null;
        for await (const [name, handle] of this.#entries(current)) {
          if (this.#fold(name) === this.#fold(segment) && handle.kind === 'directory') {
            found = handle as FileSystemDirectoryHandle;
            break;
          }
        }
        next = found;
      } else {
        try {
          next = await current.getDirectoryHandle(segment);
        } catch (error) {
          if (isDomException(error, 'NotFoundError')) {
            next = null;
          } else if (isDomException(error, 'TypeMismatchError')) {
            throw new VaultError('NOT_DIRECTORY', `not a directory: ${path}`, { path });
          } else {
            throw mapOpfsError(error, path);
          }
        }
      }
      if (next === null) {
        throw new VaultError('NOT_FOUND', `no such directory: ${path}`, { path });
      }
      // Verify it's a directory (not a file)
      if (next.kind !== 'directory') {
        throw new VaultError('NOT_DIRECTORY', `not a directory: ${path}`, { path });
      }
      current = next;
    }
    return { parent: current, leafName };
  }

  /**
   * Get the handle for `path`, or null if not found. Handles case-insensitive
   * and NFC normalization. Throws `NOT_DIRECTORY` if an intermediate is a file.
   */
  async #getHandle(path: WorkspacePath): Promise<FileSystemHandle | null> {
    if (path === ROOT_PATH) {
      return this.#root;
    }
    const segments = parsePath(path);
    let current: FileSystemDirectoryHandle = this.#root;
    for (let i = 0; i < segments.length; i++) {
      const rawSegment = segments[i];
      if (rawSegment === undefined) return null;
      const segment = this.#normalize(rawSegment);
      const isLast = i === segments.length - 1;

      if (this.#caseSensitivity === 'insensitive') {
        // Scan directory for case-insensitive match
        let found: FileSystemHandle | null = null;
        let foundName: string | null = null;
        for await (const [name, handle] of this.#entries(current)) {
          if (this.#fold(name) === this.#fold(segment)) {
            found = handle;
            foundName = name;
            break;
          }
        }
        if (!found) return null;
        if (isLast) return found;
        if (found.kind !== 'directory') {
          throw new VaultError('NOT_DIRECTORY', `not a directory: ${path}`, { path });
        }
        // For insensitive, we need to get the actual handle with correct case
        // The found handle is already correct
        current = found as FileSystemDirectoryHandle;
        void foundName;
      } else {
        // Sensitive: try directory, then file
        if (isLast) {
          // Try directory first
          try {
            return await current.getDirectoryHandle(segment);
          } catch (dirError) {
            if (isDomException(dirError, 'NotFoundError')) {
              try {
                return await current.getFileHandle(segment);
              } catch (fileError) {
                if (isDomException(fileError, 'NotFoundError')) {
                  return null;
                }
                throw mapOpfsError(fileError, path);
              }
            }
            if (isDomException(dirError, 'TypeMismatchError')) {
              // It's a file, try file handle
              try {
                return await current.getFileHandle(segment);
              } catch (fileError) {
                if (isDomException(fileError, 'NotFoundError')) {
                  return null;
                }
                throw mapOpfsError(fileError, path);
              }
            }
            throw mapOpfsError(dirError, path);
          }
        } else {
          // Intermediate: must be directory
          try {
            current = await current.getDirectoryHandle(segment);
          } catch (error) {
            if (isDomException(error, 'NotFoundError')) {
              return null;
            }
            if (isDomException(error, 'TypeMismatchError')) {
              throw new VaultError('NOT_DIRECTORY', `not a directory: ${path}`, { path });
            }
            throw mapOpfsError(error, path);
          }
        }
      }
    }
    return current;
  }

  #entries(
    dir: FileSystemDirectoryHandle,
  ): AsyncIterable<[string, FileSystemHandle]> {
    const maybeEntries = (dir as unknown as { entries?: () => AsyncIterable<[string, FileSystemHandle]> }).entries;
    if (typeof maybeEntries === 'function') {
      return maybeEntries.call(dir);
    }
    return dir as unknown as AsyncIterable<[string, FileSystemHandle]>;
  }

  async #listEntries(dir: FileSystemDirectoryHandle): Promise<Array<[string, FileSystemHandle]>> {
    const result: Array<[string, FileSystemHandle]> = [];
    for await (const entry of this.#entries(dir)) {
      result.push(entry);
    }
    return result;
  }

  async stat(path: WorkspacePath, options?: VaultOperationOptions): Promise<VaultStat> {
    assertNotAborted(options, path);
    if (path === ROOT_PATH) {
      return { path, kind: 'directory', size: 0, modifiedMillis: null };
    }
    // Ensure parent exists (throws NOT_FOUND/NOT_DIRECTORY if not)
    const segments = parsePath(path);
    if (segments.length > 1) {
      await this.#resolveParent(path);
    }
    const handle = await this.#getHandle(path);
    if (handle === null) {
      throw new VaultError('NOT_FOUND', `no such resource: ${path}`, { path });
    }
    if (handle.kind === 'directory') {
      return { path, kind: 'directory', size: 0, modifiedMillis: null };
    }
    // File: get size and modified time
    const fileHandle = handle as FileSystemFileHandle;
    try {
      const file = await fileHandle.getFile();
      return {
        path,
        kind: 'file',
        size: file.size,
        modifiedMillis: file.lastModified,
      };
    } catch (error) {
      throw mapOpfsError(error, path);
    }
  }

  async list(path: WorkspacePath, options?: VaultOperationOptions): Promise<readonly VaultEntry[]> {
    assertNotAborted(options, path);
    let dirHandle: FileSystemDirectoryHandle;
    if (path === ROOT_PATH) {
      dirHandle = this.#root;
    } else {
      // Ensure parent exists and path is a directory
      const segments = parsePath(path);
      if (segments.length > 1) {
        await this.#resolveParent(path);
      }
      const handle = await this.#getHandle(path);
      if (handle === null) {
        throw new VaultError('NOT_FOUND', `no such directory: ${path}`, { path });
      }
      if (handle.kind !== 'directory') {
        throw new VaultError('NOT_DIRECTORY', `not a directory: ${path}`, { path });
      }
      dirHandle = handle as FileSystemDirectoryHandle;
    }
    const entries: VaultEntry[] = [];
    try {
      for await (const [name, handle] of this.#entries(dirHandle)) {
        entries.push({ name, kind: handle.kind as 'file' | 'directory' });
      }
    } catch (error) {
      throw mapOpfsError(error, path);
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return entries;
  }

  async createDirectory(path: WorkspacePath, options?: VaultOperationOptions): Promise<void> {
    assertNotAborted(options, path);
    if (path === ROOT_PATH) {
      throw new VaultError('ALREADY_EXISTS', 'the vault root already exists', { path });
    }
    const { parent, leafName } = await this.#resolveParent(path);
    // Check if already exists (case-sensitive/insensitive + NFC)
    const existing = await this.#getHandle(path);
    if (existing !== null) {
      throw new VaultError('ALREADY_EXISTS', `already exists: ${path}`, { path });
    }
    this.#failIfNeeded('createDirectory', path);
    try {
      await parent.getDirectoryHandle(leafName, { create: true });
    } catch (error) {
      if (isDomException(error, 'InvalidStateError') || isDomException(error, 'NotAllowedError')) {
        throw new VaultError('ALREADY_EXISTS', `already exists: ${path}`, { path });
      }
      throw mapOpfsError(error, path);
    }
  }

  async read(path: WorkspacePath, options?: VaultOperationOptions): Promise<Uint8Array> {
    assertNotAborted(options, path);
    if (path === ROOT_PATH) {
      throw new VaultError('IS_DIRECTORY', 'cannot read the vault root', { path });
    }
    const segments = parsePath(path);
    if (segments.length > 1) {
      await this.#resolveParent(path);
    }
    const handle = await this.#getHandle(path);
    if (handle === null) {
      throw new VaultError('NOT_FOUND', `no such resource: ${path}`, { path });
    }
    if (handle.kind !== 'file') {
      throw new VaultError('IS_DIRECTORY', `is a directory: ${path}`, { path });
    }
    try {
      const file = await (handle as FileSystemFileHandle).getFile();
      const buffer = await file.arrayBuffer();
      return new Uint8Array(buffer);
    } catch (error) {
      if (error instanceof VaultError) throw error;
      throw mapOpfsError(error, path);
    }
  }

  /**
   * Returns the OPFS-backed `File`, which the browser streams from disk on
   * demand — previewing a large video never loads its bytes into memory.
   */
  async readFile(path: WorkspacePath, options?: VaultOperationOptions): Promise<File> {
    assertNotAborted(options, path);
    if (path === ROOT_PATH) {
      throw new VaultError('IS_DIRECTORY', 'cannot read the vault root', { path });
    }
    const segments = parsePath(path);
    if (segments.length > 1) {
      await this.#resolveParent(path);
    }
    const handle = await this.#getHandle(path);
    if (handle === null) {
      throw new VaultError('NOT_FOUND', `no such resource: ${path}`, { path });
    }
    if (handle.kind !== 'file') {
      throw new VaultError('IS_DIRECTORY', `is a directory: ${path}`, { path });
    }
    try {
      return await (handle as FileSystemFileHandle).getFile();
    } catch (error) {
      if (error instanceof VaultError) throw error;
      throw mapOpfsError(error, path);
    }
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
    const { parent, leafName } = await this.#resolveParent(path);
    // Check if target is a directory
    const existing = await this.#getHandle(path);
    if (existing !== null && existing.kind === 'directory') {
      throw new VaultError('IS_DIRECTORY', `is a directory: ${path}`, { path });
    }
    let targetName = leafName;
    if (this.#caseSensitivity === 'insensitive' && existing !== null) {
      for await (const [name] of this.#entries(parent)) {
        if (this.#fold(name) === this.#fold(leafName)) {
          targetName = name;
          break;
        }
      }
    }
    this.#failIfNeeded('write', path);
    try {
      const fileHandle = await parent.getFileHandle(targetName, { create: true });
      const writable = await (fileHandle as FileSystemFileHandle & { createWritable: () => Promise<FileSystemWritableFileStream> }).createWritable();
      // Check failure injection after creating writable but before committing
      // (simulates mid-write failure)
      if (this.#fail) {
        const injected = this.#fail('write', path);
        if (injected !== null) {
          try {
            await writable.close();
          } catch {
            // ignore
          }
          // Remove the file if it was newly created and we failed
          // For atomicity, we need to ensure previous content remains
          // If existing was null, remove the new file; if existing, previous content is already overwritten?
          // OPFS writable is atomic on close, so if we abort before close, previous content remains
          // We should abort the writable
          try {
            await (writable as unknown as { abort: () => Promise<void> }).abort();
          } catch {
            // ignore
          }
          throw injected;
        }
      }
      await writable.write(data as unknown as ArrayBuffer);
      await writable.close();
    } catch (error) {
      if (error instanceof VaultError) throw error;
      throw mapOpfsError(error, path);
    }
  }

  async remove(path: WorkspacePath, options?: VaultOperationOptions): Promise<void> {
    assertNotAborted(options, path);
    if (path === ROOT_PATH) {
      throw new VaultError('CONFLICT', 'the vault root may never be removed', { path });
    }
    const { parent, leafName } = await this.#resolveParent(path);
    const handle = await this.#getHandle(path);
    if (handle === null) {
      throw new VaultError('NOT_FOUND', `no such resource: ${path}`, { path });
    }
    let actualName = leafName;
    if (this.#caseSensitivity === 'insensitive') {
      for await (const [name] of this.#entries(parent)) {
        if (this.#fold(name) === this.#fold(leafName)) {
          actualName = name;
          break;
        }
      }
    }
    this.#failIfNeeded('remove', path);
    try {
      if (handle.kind === 'directory') {
        // Check if empty
        const entries = await this.#listEntries(handle as FileSystemDirectoryHandle);
        if (entries.length > 0) {
          throw new VaultError('CONFLICT', `directory is not empty: ${path}`, { path });
        }
        await parent.removeEntry(actualName);
      } else {
        await parent.removeEntry(actualName);
      }
    } catch (error) {
      if (error instanceof VaultError) throw error;
      if (isDomException(error, 'NotFoundError')) {
        throw new VaultError('NOT_FOUND', `no such resource: ${path}`, { path });
      }
      if (isDomException(error, 'InvalidStateError')) {
        throw new VaultError('CONFLICT', `directory is not empty: ${path}`, { path });
      }
      throw mapOpfsError(error, path);
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
    // Ensure parents exist
    await this.#resolveParent(from);
    await this.#resolveParent(to);
    const source = await this.#getHandle(from);
    if (source === null) {
      throw new VaultError('NOT_FOUND', `no such resource: ${from}`, { path: from });
    }
    const target = await this.#getHandle(to);
    if (target !== null) {
      throw new VaultError('CONFLICT', `target already exists: ${to}`, { path: to });
    }
    this.#failIfNeeded('move', from);
    // OPFS has no native move, so copy + delete
    try {
      if (source.kind === 'file') {
        const data = await this.read(from);
        await this.write(to, data);
        await this.remove(from);
      } else {
        // Directory: recursively copy
        await this.#copyDirectory(from, to);
        await this.#removeDirectoryRecursive(from);
      }
    } catch (error) {
      if (error instanceof VaultError) throw error;
      throw mapOpfsError(error, from);
    }
  }

  async #copyDirectory(from: WorkspacePath, to: WorkspacePath): Promise<void> {
    await this.createDirectory(to);
    const entries = await this.list(from);
    for (const entry of entries) {
      const fromChild = `${from}/${entry.name}` as WorkspacePath;
      const toChild = `${to}/${entry.name}` as WorkspacePath;
      if (entry.kind === 'directory') {
        await this.#copyDirectory(fromChild, toChild);
      } else {
        const data = await this.read(fromChild);
        await this.write(toChild, data);
      }
    }
  }

  async #removeDirectoryRecursive(path: WorkspacePath): Promise<void> {
    const entries = await this.list(path);
    for (const entry of entries) {
      const child = `${path}/${entry.name}` as WorkspacePath;
      if (entry.kind === 'directory') {
        await this.#removeDirectoryRecursive(child);
      } else {
        await this.remove(child);
      }
    }
    await this.remove(path);
  }
}

/** Re-exported for plugin configs that reuse the provider types. */
export type { VaultService, WorkspacePath };
