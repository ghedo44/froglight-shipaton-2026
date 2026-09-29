/**
 * The portable `VaultService` contract.
 *
 * A vault is a byte-oriented, host-independent resource store rooted at a
 * workspace. Every operation uses `WorkspacePath`; host path conventions,
 * Node `Buffer`s, and browser `FileSystemHandle` objects never cross this
 * contract.
 *
 * Providers declare their host-dependent semantics through
 * `VaultCapabilities` so consumers never have to guess:
 *
 * - `caseSensitivity` — how name lookups behave on this host;
 * - `nameNormalization` — whether entry names are Unicode-normalized by the
 *   host (OPFS stores NFC-normalized names; POSIX filesystems do not
 *   normalize);
 * - `atomicReplace` — a completed `write` is never observed partially
 *   written;
 * - `durableFlush` — whether a completed write survives process/host
 *   crash; `"unknown"` is the honest answer for most real hosts;
 * - `supportsMove` — whether `move` is implemented;
 * - `supportsReopen` — whether a fresh provider instance can be created
 *   over the same backing state (needed for persistence-style tests).
 *
 * Errors are structured `VaultError`s with stable codes; consumers never
 * parse error strings. `AbortSignal` is honored where cancellation
 * matters: an already-aborted signal rejects with `ABORTED`.
 */

import type { WorkspacePath } from '../paths.js';

/** The operation name used by test failure injectors. */
export type VaultOperation =
  | 'stat'
  | 'list'
  | 'createDirectory'
  | 'read'
  | 'write'
  | 'remove'
  | 'move';

/** Per-provider case lookup semantics. */
export type PathCaseSensitivity = 'sensitive' | 'insensitive' | 'unknown';

/** Per-provider entry-name Unicode handling. */
export type NameNormalization = 'none' | 'nfc';

/** Declared provider capabilities. */
export interface VaultCapabilities {
  readonly caseSensitivity: PathCaseSensitivity;
  readonly nameNormalization: NameNormalization;
  /** A completed `write` is never observed partially written. */
  readonly atomicReplace: boolean;
  /** True when a completed write survives process/host crash. */
  readonly durableFlush: boolean | 'unknown';
  /** True when `move` is implemented (not all hosts support it). */
  readonly supportsMove: boolean;
  /** True when a fresh instance over the same backing state sees prior data. */
  readonly supportsReopen: boolean;
}

/** A single directory entry (name + kind). */
export interface VaultEntry {
  readonly name: string;
  readonly kind: 'file' | 'directory';
}

/**
 * Minimal structural shape of the lazy file object returned by
 * `readFile`. The runtime value is the host's file object (a `Blob`
 * subclass in web environments); it is typed structurally so this
 * contract stays environment-neutral.
 */
export interface VaultFile {
  readonly name: string;
  readonly size: number;
  readonly type: string;
  arrayBuffer(): Promise<ArrayBuffer>;
  text(): Promise<string>;
}

/** Stat information for one resource. */
export interface VaultStat {
  readonly path: WorkspacePath;
  readonly kind: 'file' | 'directory';
  /** Size in bytes; `0` for directories. */
  readonly size: number;
  /** Last-modified epoch milliseconds; `null` for directories/unknown. */
  readonly modifiedMillis: number | null;
}

/** Per-operation options. */
export interface VaultOperationOptions {
  readonly signal?: AbortSignal;
}

/**
 * The host-independent workspace resource store.
 *
 * Semantics:
 *
 * - `stat` — metadata for the path; `NOT_FOUND` when missing.
 * - `list` — directory entries in deterministic (code-unit sorted) order;
 *   `NOT_DIRECTORY` when the path is a file; `NOT_FOUND` when missing.
 * - `createDirectory` — exact creation; parents must exist (`NOT_FOUND`);
 *   an existing file or directory at the path is `ALREADY_EXISTS`.
 *   Use the portable `ensureDirectory` helper for recursive creation.
 * - `read` — complete resource bytes; `IS_DIRECTORY` for directories.
 * - `write` — atomic replace of a file (creates it when absent); parent
 *   must exist (`NOT_FOUND`); `IS_DIRECTORY` when the target is a
 *   directory.
 * - `remove` — removes a file or an empty directory; a non-empty directory
 *   is `CONFLICT`; the root may never be removed (`CONFLICT`).
 * - `move` — moves a file or directory subtree; an existing target is
 *   `CONFLICT`; moving a path into its own subtree is `CONFLICT`.
 */
export interface VaultService {
  /** Host-coordinated conditional publication; a mismatch preserves both versions. */
  writeIfUnchanged?(path: WorkspacePath, data: Uint8Array, checksum: string): Promise<void>;
  readonly capabilities: VaultCapabilities;
  stat(path: WorkspacePath, options?: VaultOperationOptions): Promise<VaultStat>;
  list(path: WorkspacePath, options?: VaultOperationOptions): Promise<readonly VaultEntry[]>;
  createDirectory(path: WorkspacePath, options?: VaultOperationOptions): Promise<void>;
  read(path: WorkspacePath, options?: VaultOperationOptions): Promise<Uint8Array>;
  /**
   * Read a file as a lazy file object when the backend can supply one
   * without loading its full contents (e.g. an OPFS handle, which streams
   * from disk). Optional: callers must fall back to `read` when absent.
   * Declared structurally to keep this contract environment-neutral; real
   * runtime values are the host's file objects.
   */
  readFile?(path: WorkspacePath, options?: VaultOperationOptions): Promise<VaultFile>;
  write(path: WorkspacePath, data: Uint8Array, options?: VaultOperationOptions): Promise<void>;
  remove(path: WorkspacePath, options?: VaultOperationOptions): Promise<void>;
  move(from: WorkspacePath, to: WorkspacePath, options?: VaultOperationOptions): Promise<void>;
}
