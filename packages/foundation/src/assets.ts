/**
 * Document asset store contract: binary assets referenced by
 * canonical formats are stored once in the vault and referenced by
 * relative path plus SHA-256. Ingestion is deduplicated by content hash;
 * the store never touches canonical document bytes.
 */

import type { WorkspacePath } from './paths.js';

export interface StoredAsset {
  /** Vault-relative path of the stored asset (forward slashes). */
  readonly path: WorkspacePath;
  /** Lowercase hex SHA-256 of the stored bytes. */
  readonly sha256: string;
}

export interface DocumentAssetStore {
  /**
   * Store asset bytes, returning the vault-relative path and integrity
   * hash to reference from a document. Identical bytes may reuse an
   * existing path; implementations must remain idempotent.
   */
  put(
    data: Uint8Array,
    options?: { readonly suggestedName?: string },
  ): Promise<StoredAsset>;
  /** Read previously stored asset bytes back. */
  read(path: WorkspacePath): Promise<Uint8Array>;
}
