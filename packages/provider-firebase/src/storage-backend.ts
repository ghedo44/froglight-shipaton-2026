/**
 * Storage sync backend seam.
 *
 * `StorageSyncBackend` is the only Storage surface the sync remote
 * needs: existence probes, immutable uploads, verified downloads, and
 * prefix listing (so `loadManifest` can resolve a content hash to the
 * revision-prefixed object name the rules require). The production
 * implementation delegates to the Firebase modular Web SDK; tests inject
 * in-memory fakes. Object paths are bucket-relative
 * (`users/{uid}/vaults/{id}/…`); no Storage type leaks past this package.
 */

import {
  getBytes,
  getMetadata,
  listAll,
  ref,
  uploadBytes,
  uploadBytesResumable,
  type FirebaseStorage,
} from 'firebase/storage';

/**
 * Blobs at or above this size upload through a resumable session instead
 * of a single buffered `uploadBytes` call, so a dropped connection
 * resumes rather than restarting a large asset from zero. Below it the
 * single-request path avoids session overhead. Downloads already resolve
 * to one typed-array view (`new Uint8Array(buffer)` aliases, never
 * copies); ranged/streaming reads stay open as a follow-up on top of the
 * vault's lazy-file seams without changing this contract.
 */
export const RESUMABLE_UPLOAD_THRESHOLD_BYTES = 8 * 1024 * 1024;

function readCode(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as Record<string, unknown>).code;
  return typeof code === 'string' ? code : null;
}

/** Minimal Storage surface the sync remote consumes (real SDK or fake). */
export interface StorageSyncBackend {
  /** True when the object exists. Only not-found maps to false. */
  exists(objectPath: string): Promise<boolean>;
  upload(
    objectPath: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<void>;
  download(objectPath: string): Promise<Uint8Array>;
  /** Names (not full paths) of objects directly under `prefix`. */
  listNames(prefix: string): Promise<readonly string[]>;
}

export interface SdkStorageSyncBackendOptions {
  readonly storage: FirebaseStorage;
}

/** Production backend: thin delegation to the Firebase Web SDK. */
export function createSdkStorageSyncBackend(
  options: SdkStorageSyncBackendOptions,
): StorageSyncBackend {
  const { storage } = options;
  return {
    async exists(objectPath: string): Promise<boolean> {
      try {
        await getMetadata(ref(storage, objectPath));
        return true;
      } catch (error) {
        // Absence is a normal answer (dedup probe); anything else is a
        // real failure the caller must see normalized, not swallowed.
        if (readCode(error) === 'storage/object-not-found') return false;
        throw error;
      }
    },
    async upload(
      objectPath: string,
      bytes: Uint8Array,
      contentType: string,
    ): Promise<void> {
      // No defensive copy: the SDK transmits the caller's buffer (and the
      // sync engine retains it only for the verified round-trip), so large
      // assets are never duplicated in memory on this path.
      if (bytes.length < RESUMABLE_UPLOAD_THRESHOLD_BYTES) {
        await uploadBytes(ref(storage, objectPath), bytes, { contentType });
        return;
      }
      const task = uploadBytesResumable(ref(storage, objectPath), bytes, {
        contentType,
      });
      await task;
    },
    async download(objectPath: string): Promise<Uint8Array> {
      const buffer = await getBytes(ref(storage, objectPath));
      return new Uint8Array(buffer);
    },
    async listNames(prefix: string): Promise<readonly string[]> {
      const listing = await listAll(ref(storage, prefix));
      return listing.items.map((item) => item.name);
    },
  };
}
