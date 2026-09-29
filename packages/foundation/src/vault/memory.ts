/**
 * Deterministic in-memory vault provider.
 *
 * This is the reference model for the `VaultService` contract: the contract
 * suite runs against it first, and its semantics define what the native and
 * OPFS providers must match. It is a test/reference provider, not a
 * production storage backend.
 *
 * Properties:
 *
 * - deterministic listing order (code-unit sorted names);
 * - configurable case sensitivity (`sensitive` default, `insensitive` for
 *   tests of declared provider semantics);
 * - no dependency on Node filesystem or browser storage APIs;
 * - optional failure injection (`fail(op, path)`) with commit-then-rollback
 *   semantics, so atomicity/session tests can simulate mid-commit failures
 *   deterministically without timers;
 * - reopen support: multiple instances may share one `MemoryVaultState`, so
 *   persistence-style lifecycles are testable without process restarts.
 */

import { isWithinPath, parsePath, ROOT_PATH } from '../paths.js';
import type { WorkspacePath } from '../paths.js';
import { VaultError } from '../errors.js';
import type {
  VaultCapabilities,
  VaultEntry,
  VaultOperation,
  VaultOperationOptions,
  VaultService,
  VaultStat,
} from './contract.js';

/** Internal tree node. */
export interface MemoryDirNode {
  readonly kind: 'directory';
  entries: Map<string, MemoryFileNode | MemoryDirNode>;
}

export interface MemoryFileNode {
  readonly kind: 'file';
  bytes: Uint8Array;
  modifiedMillis: number;
}

type MemoryNode = MemoryFileNode | MemoryDirNode;

/** The shared backing state of one in-memory vault. */
export interface MemoryVaultState {
  /** @internal tree root; do not mutate from outside the provider. */
  readonly tree: MemoryDirNode;
}

/**
 * Create a fresh backing state. Pass the same state to several
 * `MemoryVault` instances to simulate reopen/persistence across instances.
 */
export function createMemoryVaultState(): MemoryVaultState {
  return { tree: { kind: 'directory', entries: new Map() } };
}

/** Test-only failure injector: return an error to make an operation fail. */
export type VaultFailureInjector = (
  operation: VaultOperation,
  path: WorkspacePath,
) => Error | null;

export interface MemoryVaultOptions {
  /**
   * Shared backing state; a fresh one is created when omitted. Pass the
   * same state to several vault instances to simulate reopen/persistence.
   */
  readonly state?: MemoryVaultState;
  readonly caseSensitivity?: 'sensitive' | 'insensitive';
  /** Test-only failure injection (commit-then-rollback for mutating ops). */
  readonly fail?: VaultFailureInjector;
  /** Clock for `modifiedMillis` (defaults to `Date.now`). */
  readonly now?: () => number;
}

function assertNotAborted(options: VaultOperationOptions | undefined, path: WorkspacePath): void {
  if (options?.signal?.aborted) {
    throw new VaultError('ABORTED', 'operation aborted', { path });
  }
}

export class MemoryVault implements VaultService {
  readonly capabilities: VaultCapabilities;
  readonly #state: MemoryVaultState;
  readonly #caseSensitivity: 'sensitive' | 'insensitive';
  readonly #fail: VaultFailureInjector | null;
  readonly #now: () => number;

  constructor(state: MemoryVaultState = createMemoryVaultState(), options: MemoryVaultOptions = {}) {
    this.#state = state;
    this.#caseSensitivity = options.caseSensitivity ?? 'sensitive';
    this.#fail = options.fail ?? null;
    this.#now = options.now ?? (() => Date.now());
    this.capabilities = {
      caseSensitivity: this.#caseSensitivity,
      nameNormalization: 'none',
      atomicReplace: true,
      // In-memory state never survives process exit.
      durableFlush: false,
      supportsMove: true,
      supportsReopen: true,
    };
  }

  #fold(name: string): string {
    return this.#caseSensitivity === 'insensitive' ? name.toLowerCase() : name;
  }

  /** Locate the parent directory node of `path`; `NOT_FOUND` when missing. */
  #parentNode(path: WorkspacePath, options: VaultOperationOptions | undefined): MemoryDirNode {
    assertNotAborted(options, path);
    const segments = parsePath(path);
    let node: MemoryDirNode = this.#state.tree;
    for (const segment of segments.slice(0, -1)) {
      const child = this.#lookup(node, segment);
      if (child === undefined) {
        throw new VaultError('NOT_FOUND', `no such directory: ${path}`, { path });
      }
      if (child.kind !== 'directory') {
        throw new VaultError('NOT_DIRECTORY', `not a directory: ${path}`, { path });
      }
      node = child;
    }
    return node;
  }

  /** Case-aware entry lookup inside one directory. */
  #lookup(dir: MemoryDirNode, name: string): MemoryNode | undefined {
    return this.#lookupEntry(dir, name)?.[1];
  }

  /** Case-aware lookup returning the actual map key alongside the node. */
  #lookupEntry(dir: MemoryDirNode, name: string): readonly [string, MemoryNode] | undefined {
    const direct = dir.entries.get(name);
    if (direct !== undefined) {
      return [name, direct];
    }
    if (this.#caseSensitivity === 'insensitive') {
      const folded = this.#fold(name);
      for (const [entryName, node] of dir.entries) {
        if (this.#fold(entryName) === folded) {
          return [entryName, node];
        }
      }
    }
    return undefined;
  }

  /**
   * Case-aware insertion: updates the existing differently-cased entry.
   * Returns the map key the node was stored under.
   */
  #insert(dir: MemoryDirNode, name: string, node: MemoryNode): string {
    if (this.#caseSensitivity === 'insensitive') {
      const folded = this.#fold(name);
      for (const entryName of dir.entries.keys()) {
        if (this.#fold(entryName) === folded) {
          dir.entries.set(entryName, node);
          return entryName;
        }
      }
    }
    dir.entries.set(name, node);
    return name;
  }

  /** Case-aware removal; returns the removed key and node. */
  #removeName(
    dir: MemoryDirNode,
    name: string,
  ): readonly [string, MemoryNode] | undefined {
    if (this.#caseSensitivity === 'insensitive') {
      const folded = this.#fold(name);
      for (const [entryName, node] of dir.entries) {
        if (this.#fold(entryName) === folded) {
          dir.entries.delete(entryName);
          return [entryName, node];
        }
      }
      return undefined;
    }
    const node = dir.entries.get(name);
    if (node === undefined) {
      return undefined;
    }
    dir.entries.delete(name);
    return [name, node];
  }

  #failIfNeeded(operation: VaultOperation, path: WorkspacePath): void {
    if (this.#fail) {
      const error = this.#fail(operation, path);
      if (error !== null) {
        throw error;
      }
    }
  }

  #mutate<TReturn>(
    operation: VaultOperation,
    path: WorkspacePath,
    apply: () => TReturn,
    rollback: () => void,
  ): TReturn {
    // Commit-then-check with rollback: a failure injected after the commit
    // must leave the tree exactly as it was (no partial state).
    const result = apply();
    try {
      this.#failIfNeeded(operation, path);
    } catch (error) {
      rollback();
      throw error;
    }
    return result;
  }

  async stat(path: WorkspacePath, options?: VaultOperationOptions): Promise<VaultStat> {
    assertNotAborted(options, path);
    this.#failIfNeeded('stat', path);
    if (path === ROOT_PATH) {
      return { path, kind: 'directory', size: 0, modifiedMillis: null };
    }
    const parent = this.#parentNode(path, options);
    const name = path.split('/').at(-1) as string;
    const node = this.#lookup(parent, name);
    if (node === undefined) {
      throw new VaultError('NOT_FOUND', `no such resource: ${path}`, { path });
    }
    if (node.kind === 'file') {
      return { path, kind: 'file', size: node.bytes.byteLength, modifiedMillis: node.modifiedMillis };
    }
    return { path, kind: 'directory', size: 0, modifiedMillis: null };
  }

  async list(path: WorkspacePath, options?: VaultOperationOptions): Promise<readonly VaultEntry[]> {
    assertNotAborted(options, path);
    this.#failIfNeeded('list', path);
    const dir = this.#directoryNode(path, options);
    const entries: VaultEntry[] = [];
    for (const [name, node] of dir.entries) {
      entries.push({ name, kind: node.kind });
    }
    // Deterministic order: code-unit sorted, independent of insertion order.
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return entries;
  }

  #directoryNode(path: WorkspacePath, options: VaultOperationOptions | undefined): MemoryDirNode {
    if (path === ROOT_PATH) {
      return this.#state.tree;
    }
    const parent = this.#parentNode(path, options);
    const name = path.split('/').at(-1) as string;
    const node = this.#lookup(parent, name);
    if (node === undefined) {
      throw new VaultError('NOT_FOUND', `no such directory: ${path}`, { path });
    }
    if (node.kind !== 'directory') {
      throw new VaultError('NOT_DIRECTORY', `not a directory: ${path}`, { path });
    }
    return node;
  }

  async createDirectory(path: WorkspacePath, options?: VaultOperationOptions): Promise<void> {
    assertNotAborted(options, path);
    if (path === ROOT_PATH) {
      throw new VaultError('ALREADY_EXISTS', 'the vault root already exists', { path });
    }
    const parent = this.#parentNode(path, options);
    const name = path.split('/').at(-1) as string;
    if (this.#lookup(parent, name) !== undefined) {
      throw new VaultError('ALREADY_EXISTS', `already exists: ${path}`, { path });
    }
    this.#mutate(
      'createDirectory',
      path,
      () => this.#insert(parent, name, { kind: 'directory', entries: new Map() }),
      () => {
        this.#removeName(parent, name);
      },
    );
  }

  async read(path: WorkspacePath, options?: VaultOperationOptions): Promise<Uint8Array> {
    assertNotAborted(options, path);
    this.#failIfNeeded('read', path);
    if (path === ROOT_PATH) {
      throw new VaultError('IS_DIRECTORY', 'cannot read the vault root', { path });
    }
    const parent = this.#parentNode(path, options);
    const name = path.split('/').at(-1) as string;
    const node = this.#lookup(parent, name);
    if (node === undefined) {
      throw new VaultError('NOT_FOUND', `no such resource: ${path}`, { path });
    }
    if (node.kind !== 'file') {
      throw new VaultError('IS_DIRECTORY', `is a directory: ${path}`, { path });
    }
    // Copy so callers cannot mutate vault state through the returned bytes.
    return node.bytes.slice();
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
    const parent = this.#parentNode(path, options);
    const name = path.split('/').at(-1) as string;
    const prior = this.#lookupEntry(parent, name);
    if (prior !== undefined && prior[1].kind !== 'file') {
      throw new VaultError('IS_DIRECTORY', `is a directory: ${path}`, { path });
    }
    const next: MemoryFileNode = {
      kind: 'file',
      bytes: data.slice(),
      modifiedMillis: this.#now(),
    };
    let insertedKey = name;
    this.#mutate(
      'write',
      path,
      () => {
        insertedKey = this.#insert(parent, name, next);
      },
      () => {
        parent.entries.delete(insertedKey);
        if (prior !== undefined) {
          parent.entries.set(prior[0], prior[1]);
        }
      },
    );
  }

  async remove(path: WorkspacePath, options?: VaultOperationOptions): Promise<void> {
    assertNotAborted(options, path);
    if (path === ROOT_PATH) {
      throw new VaultError('CONFLICT', 'cannot remove the vault root', { path });
    }
    const parent = this.#parentNode(path, options);
    const name = path.split('/').at(-1) as string;
    const node = this.#lookup(parent, name);
    if (node === undefined) {
      throw new VaultError('NOT_FOUND', `no such resource: ${path}`, { path });
    }
    if (node.kind === 'directory' && node.entries.size > 0) {
      throw new VaultError('CONFLICT', `directory is not empty: ${path}`, { path });
    }
    let removed: readonly [string, MemoryNode] | undefined;
    this.#mutate(
      'remove',
      path,
      () => {
        removed = this.#removeName(parent, name);
      },
      () => {
        if (removed !== undefined) {
          parent.entries.set(removed[0], removed[1]);
        }
      },
    );
  }

  async move(
    from: WorkspacePath,
    to: WorkspacePath,
    options?: VaultOperationOptions,
  ): Promise<void> {
    assertNotAborted(options, from);
    if (from === ROOT_PATH) {
      throw new VaultError('CONFLICT', 'cannot move the vault root', { path: from });
    }
    if (from === to || isWithinPath(to, from)) {
      throw new VaultError('CONFLICT', 'cannot move a path into its own subtree', {
        path: from,
      });
    }
    const fromParent = this.#parentNode(from, options);
    const toParent = this.#parentNode(to, options);
    const fromName = from.split('/').at(-1) as string;
    const toName = to.split('/').at(-1) as string;
    const node = this.#lookup(fromParent, fromName);
    if (node === undefined) {
      throw new VaultError('NOT_FOUND', `no such resource: ${from}`, { path: from });
    }
    if (this.#lookup(toParent, toName) !== undefined) {
      throw new VaultError('CONFLICT', `target already exists: ${to}`, { path: to });
    }
    let removed: readonly [string, MemoryNode] | undefined;
    let insertedKey = toName;
    this.#mutate(
      'move',
      from,
      () => {
        removed = this.#removeName(fromParent, fromName);
        insertedKey = this.#insert(toParent, toName, node);
      },
      () => {
        toParent.entries.delete(insertedKey);
        if (removed !== undefined) {
          fromParent.entries.set(removed[0], removed[1]);
        }
      },
    );
  }
}

/** Convenience: a fresh state plus vault for one-off tests. */
export function createMemoryVault(options: MemoryVaultOptions = {}): {
  readonly state: MemoryVaultState;
  readonly vault: MemoryVault;
} {
  const state = options.state ?? createMemoryVaultState();
  return { state, vault: new MemoryVault(state, options) };
}
