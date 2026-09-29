/**
 * OPFS implementation of the host-owned derived-cache storage port
 * (final scalability pass, item 4).
 *
 * Derived compiled geometry is DISPOSABLE cache data — never Vault
 * content, never synced through cloud vault sync. It lives in its own
 * origin-private directory (`froglight-derived-cache`), one compact
 * binary record per document id; deleting the directory is harmless
 * (canonical content recompiles from samples). Writes are atomic on
 * close (`FileSystemWritableFileStream` swap semantics).
 */

import type { DerivedCacheStoragePort } from '@froglight/foundation';

/** OPFS directory holding all derived-cache records. */
export const OPFS_DERIVED_CACHE_DIRECTORY = 'froglight-derived-cache';

/** Safe filename for an arbitrary document id (`/` → `%2F`). */
function recordName(documentId: string): string {
  return `${encodeURIComponent(documentId)}.fdc`;
}

export interface OpfsDerivedCacheStorageOptions {
  /**
   * Origin directory resolver; defaults to
   * `navigator.storage.getDirectory()`. Tests may inject a scoped root.
   */
  readonly origin?: () => Promise<FileSystemDirectoryHandle>;
}

export class OpfsDerivedCacheStorage implements DerivedCacheStoragePort {
  readonly #origin: (() => Promise<FileSystemDirectoryHandle>) | null;

  constructor(options: OpfsDerivedCacheStorageOptions = {}) {
    this.#origin = options.origin ?? null;
  }

  async #directory(create: boolean): Promise<FileSystemDirectoryHandle> {
    const origin =
      this.#origin !== null
        ? await this.#origin()
        : await navigator.storage.getDirectory();
    return origin.getDirectoryHandle(OPFS_DERIVED_CACHE_DIRECTORY, {
      create,
    });
  }

  async load(documentId: string): Promise<Uint8Array | null> {
    try {
      const directory = await this.#directory(false);
      const handle = await directory.getFileHandle(recordName(documentId));
      const file = await handle.getFile();
      return new Uint8Array(await file.arrayBuffer());
    } catch {
      // Missing directory/record (or a degraded OPFS) is a clean miss.
      return null;
    }
  }

  async save(documentId: string, bytes: Uint8Array): Promise<void> {
    const directory = await this.#directory(true);
    const handle = await directory.getFileHandle(recordName(documentId), {
      create: true,
    });
    const writable = await handle.createWritable();
    try {
      // Copy into an ArrayBuffer-backed view: the write chunk contract
      // rejects SharedArrayBuffer-backed views.
      await writable.write(new Uint8Array(bytes));
    } finally {
      await writable.close();
    }
  }

  async remove(documentId: string): Promise<void> {
    try {
      const directory = await this.#directory(false);
      await directory.removeEntry(recordName(documentId));
    } catch {
      // Absent records/directories are already removed.
    }
  }
}
