/**
 * Firebase `SyncRemote`.
 *
 * The replaceable Firebase provider behind the Froglight-owned sync
 * protocol: Firestore implements the control plane (HEAD docs),
 * Storage the data plane (immutable manifests + content-addressed
 * blobs). Merge logic never sees Firebase — it depends only on the
 * `SyncRemote` contract this module implements over the two backend
 * seams (`firestore-backend.ts`, `storage-backend.ts`).
 *
 * Identity rule: every path is built from the Firebase Auth
 * UID supplied by `getUid()`. Email never appears in a path, a document,
 * or a RevenueCat call; a null/empty UID fails fast with
 * `NOT_AUTHENTICATED` before any network traffic.
 *
 * Claim authorization integration: backend writes succeed only under the
 * server-issued `revenueCatEntitlements` claim (Firebase Rules). A Rules
 * denial surfaces as neutral `PERMISSION_DENIED` — refreshing the claim
 * (`AccountService.refreshToken(true)`) and the waiting-for-entitlement
 * UX belong to the account and sync UI, which builds on this provider.
 *
 * Manifest addressing note: rule-enforced object names are
 * revision-prefixed (`{revision}-{hex}.json`), and the HEAD document
 * carries the exact `manifestObject` pointer. `loadManifest` fetches that
 * object directly (no `listAll` over the manifests prefix, so sync never
 * pays O(number-of-revisions)). Downloaded bytes are always re-hashed to
 * prove the object is the manifest requested.
 *
 * Firestore `Timestamp` values (server timestamps) are normalized to ISO
 * strings at this boundary: Foundation receives provider-neutral DTOs
 * and never sees Firebase types.
 */

import {
  SYNC_LIMITS,
  VaultSyncError,
  blobHex,
  canonicalizeManifest,
  hashBytes,
  hashManifest,
  isBlobRef,
  isManifestHash,
  parseRemoteHead,
  parseSyncManifest,
  type BlobRef,
  type ExpectedHead,
  type ManifestHash,
  type RemoteHead,
  type RemoteHeadInput,
  type RemoteVaultInfo,
  type SyncManifest,
  type SyncRemote,
} from '@froglight/foundation';
import type { FirestoreSyncBackend } from './firestore-backend.js';
import type { StorageSyncBackend } from './storage-backend.js';
import { normalizeFirebaseSyncError } from './sync-errors.js';

const MANIFEST_CONTENT_TYPE = 'application/json';
const BLOB_CONTENT_TYPE = 'application/octet-stream';

function vaultsPath(uid: string): string {
  return `users/${uid}/vaults`;
}

function blobsPrefix(uid: string, vaultId: string): string {
  return `${vaultsPath(uid)}/${vaultId}/blobs`;
}

function manifestsPrefix(uid: string, vaultId: string): string {
  return `${vaultsPath(uid)}/${vaultId}/manifests`;
}

function blobObject(uid: string, vaultId: string, hex: string): string {
  return `${blobsPrefix(uid, vaultId)}/${hex}`;
}

function manifestObject(
  uid: string,
  vaultId: string,
  revision: number,
  hex: string,
): string {
  return `${manifestsPrefix(uid, vaultId)}/${revision}-${hex}.json`;
}

/**
 * Normalize a HEAD record crossing the provider boundary: Firestore
 * `Timestamp` values (objects with a `toDate()` method) and `Date`
 * instances become ISO strings. Foundation receives provider-neutral
 * ISO timestamps, never Firebase `Timestamp` objects.
 */
function normalizeHeadRecord(
  data: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...data };
  for (const field of ['createdAt', 'updatedAt'] as const) {
    const value = out[field];
    if (typeof value === 'string' || value === null || value === undefined) {
      continue;
    }
    if (value instanceof Date) {
      out[field] = value.toISOString();
      continue;
    }
    if (
      typeof value === 'object' &&
      value !== null &&
      'toDate' in value &&
      typeof (value as { toDate?: unknown }).toDate === 'function'
    ) {
      try {
        const date = (value as { toDate: () => Date }).toDate();
        out[field] = date.toISOString();
      } catch {
        // Leave the value untouched: validation rejects it loudly as
        // CORRUPT_MANIFEST instead of guessing.
      }
    }
  }
  return out;
}

function checkBlobRef(blob: BlobRef): string {
  if (!isBlobRef(blob)) {
    throw new VaultSyncError(
      'CORRUPT_MANIFEST',
      `malformed blob reference: ${blob}`,
    );
  }
  return blobHex(blob);
}

function checkManifestHash(hash: ManifestHash): string {
  if (!isManifestHash(hash)) {
    throw new VaultSyncError(
      'CORRUPT_MANIFEST',
      `malformed manifest hash: ${hash}`,
    );
  }
  return hash.slice('sha256:'.length);
}

export interface FirebaseSyncRemoteOptions {
  readonly firestore: FirestoreSyncBackend;
  readonly storage: StorageSyncBackend;
  /**
   * Current Firebase Auth UID, or null when signed out. Read fresh on
   * every call so identity replacement can never operate on a
   * stale user's paths.
   */
  readonly getUid: () => string | null;
}

/** Firebase-backed `SyncRemote`. See the module header for the model. */
export function createFirebaseSyncRemote(
  options: FirebaseSyncRemoteOptions,
): SyncRemote {
  const { firestore, storage, getUid } = options;

  function requireUid(): string {
    const uid = getUid();
    if (uid === null || uid.length === 0) {
      throw new VaultSyncError(
        'NOT_AUTHENTICATED',
        'sign in before syncing vaults',
      );
    }
    return uid;
  }

  return {
    async listVaults(): Promise<readonly RemoteVaultInfo[]> {
      try {
        const uid = requireUid();
        const docs = await firestore.listHeadDocuments(uid);
        const out: RemoteVaultInfo[] = [];
        for (const { id, data } of docs) {
          // Discovery lists what it can: one corrupt HEAD must not hide
          // every healthy vault. Opening the corrupt vault still fails
          // loudly through readHead.
          try {
            const head = parseRemoteHead(normalizeHeadRecord(data));
            out.push({
              cloudVaultId: id,
              name: head.name,
              revision: head.revision,
              updatedAt: head.updatedAt,
            });
          } catch {
            continue;
          }
        }
        out.sort((a, b) => (a.cloudVaultId < b.cloudVaultId ? -1 : 1));
        return out;
      } catch (error) {
        throw normalizeFirebaseSyncError(error);
      }
    },

    async readHead(vaultId: string): Promise<RemoteHead | null> {
      try {
        const uid = requireUid();
        const data = await firestore.getHeadDocument(uid, vaultId);
        if (data === null) return null;
        return parseRemoteHead(normalizeHeadRecord(data));
      } catch (error) {
        throw normalizeFirebaseSyncError(error);
      }
    },

    async loadManifest(
      vaultId: string,
      manifestHash: ManifestHash,
      manifestObject: string,
    ): Promise<SyncManifest> {
      try {
        const uid = requireUid();
        const hex = checkManifestHash(manifestHash);
        const prefix = manifestsPrefix(uid, vaultId);
        if (
          typeof manifestObject !== 'string' ||
          !manifestObject.startsWith(`${prefix}/`) ||
          !manifestObject.endsWith(`-${hex}.json`)
        ) {
          throw new VaultSyncError(
            'CORRUPT_MANIFEST',
            `invalid manifest object pointer for ${manifestHash}`,
          );
        }
        const bytes = await storage.download(manifestObject);
        if (bytes.length > SYNC_LIMITS.maxManifestBytes) {
          throw new VaultSyncError(
            'CORRUPT_MANIFEST',
            `manifest exceeds ${SYNC_LIMITS.maxManifestBytes} bytes`,
          );
        }
        let decoded: unknown;
        try {
          decoded = JSON.parse(new TextDecoder().decode(bytes));
        } catch {
          throw new VaultSyncError(
            'CORRUPT_MANIFEST',
            'manifest is not valid JSON',
          );
        }
        const manifest = parseSyncManifest(decoded);
        if (manifest.vaultId !== vaultId) {
          throw new VaultSyncError(
            'CORRUPT_MANIFEST',
            `manifest vault ${manifest.vaultId} does not match vault ${vaultId}`,
          );
        }
        if ((await hashManifest(manifest)) !== manifestHash) {
          throw new VaultSyncError(
            'CORRUPT_MANIFEST',
            'manifest content does not match its hash',
          );
        }
        return manifest;
      } catch (error) {
        throw normalizeFirebaseSyncError(error);
      }
    },

    async hasBlob(vaultId: string, blob: BlobRef): Promise<boolean> {
      try {
        const uid = requireUid();
        const hex = checkBlobRef(blob);
        return await storage.exists(blobObject(uid, vaultId, hex));
      } catch (error) {
        throw normalizeFirebaseSyncError(error);
      }
    },

    async uploadBlob(
      vaultId: string,
      blob: BlobRef,
      bytes: Uint8Array,
    ): Promise<void> {
      try {
        const uid = requireUid();
        const hex = checkBlobRef(blob);
        if (bytes.length > SYNC_LIMITS.maxBlobBytes) {
          throw new VaultSyncError(
            'QUOTA_EXCEEDED',
            `blob exceeds the ${SYNC_LIMITS.maxBlobBytes} byte sync limit`,
          );
        }
        // Defense in depth, fail closed: the content-addressed provider
        // never stores bytes unless the content hash has been verified.
        // A hashing failure is an integrity failure, never a pass-through
        // to upload (fail closed, never catch-and-continue).
        let actual: string;
        try {
          actual = await hashBytes(bytes);
        } catch (error) {
          throw error instanceof VaultSyncError
            ? error
            : new VaultSyncError(
                'HASH_MISMATCH',
                'could not verify blob hash',
                {
                  cause: error,
                },
              );
        }
        if (actual !== blob) {
          throw new VaultSyncError(
            'HASH_MISMATCH',
            `upload bytes do not match requested hash ${blob} (got ${actual})`,
          );
        }
        const object = blobObject(uid, vaultId, hex);
        try {
          await storage.upload(object, bytes, BLOB_CONTENT_TYPE);
        } catch (uploadError) {
          // Immutable-create race vs entitlement denial: production Rules
          // deny the second create as
          // permission-denied (resource != null, update forbidden), which
          // is indistinguishable from a missing-Pro denial without
          // probing. A safe duplicate (existing object hashes to the
          // requested address) is idempotent success; a mismatched
          // existing object is corruption; absence rethrows the original
          // denial (genuine entitlement/ownership failure, never
          // swallowed).
          const normalized = normalizeFirebaseSyncError(uploadError);
          if (normalized.code !== 'PERMISSION_DENIED') throw normalized;
          let exists = false;
          try {
            exists = await storage.exists(object);
          } catch {
            throw normalized;
          }
          if (!exists) throw normalized;
          let current: Uint8Array;
          try {
            current = await storage.download(object);
          } catch {
            throw normalized;
          }
          // Fail closed here as well: an unverifiable existing object is
          // corruption, never idempotent success.
          let currentHash: string;
          try {
            currentHash = await hashBytes(current);
          } catch (error) {
            throw error instanceof VaultSyncError
              ? error
              : new VaultSyncError(
                  'HASH_MISMATCH',
                  `immutable blob ${blob} could not be verified`,
                  { cause: error },
                );
          }
          if (currentHash === blob) return;
          throw new VaultSyncError(
            'HASH_MISMATCH',
            `immutable blob ${blob} already exists with different content`,
          );
        }
      } catch (error) {
        throw normalizeFirebaseSyncError(error);
      }
    },

    async downloadBlob(vaultId: string, blob: BlobRef): Promise<Uint8Array> {
      try {
        const uid = requireUid();
        const hex = checkBlobRef(blob);
        return await storage.download(blobObject(uid, vaultId, hex));
      } catch (error) {
        throw normalizeFirebaseSyncError(error);
      }
    },

    async uploadManifest(
      vaultId: string,
      manifest: SyncManifest,
    ): Promise<{ hash: ManifestHash; object: string }> {
      try {
        const uid = requireUid();
        const parsed = parseSyncManifest({
          ...manifest,
          entries: [...manifest.entries],
        });
        if (parsed.vaultId !== vaultId) {
          throw new VaultSyncError(
            'CORRUPT_MANIFEST',
            `manifest vault ${parsed.vaultId} does not match vault ${vaultId}`,
          );
        }
        const canonical = canonicalizeManifest(parsed);
        const bytes = new TextEncoder().encode(canonical);
        if (bytes.length > SYNC_LIMITS.maxManifestBytes) {
          throw new VaultSyncError(
            'QUOTA_EXCEEDED',
            `manifest exceeds the ${SYNC_LIMITS.maxManifestBytes} byte sync limit`,
          );
        }
        // The engine recomputes this hash and rejects any mismatch, so
        // derive it through the same function (never a parallel formula).
        const hash = await hashManifest(parsed);
        const hex = hash.slice('sha256:'.length);
        const object = manifestObject(uid, vaultId, parsed.revision, hex);
        try {
          await storage.upload(object, bytes, MANIFEST_CONTENT_TYPE);
        } catch (uploadError) {
          // Same immutable idempotency as blobs (crash after manifest
          // upload, before HEAD): a safe duplicate is success, a
          // mismatched existing object is corruption, absence rethrows
          // the genuine denial (never misclassified as entitlement).
          const normalized = normalizeFirebaseSyncError(uploadError);
          if (normalized.code !== 'PERMISSION_DENIED') throw normalized;
          let exists = false;
          try {
            exists = await storage.exists(object);
          } catch {
            throw normalized;
          }
          if (!exists) throw normalized;
          let current: Uint8Array;
          try {
            current = await storage.download(object);
          } catch {
            throw normalized;
          }
          const currentText = new TextDecoder().decode(current);
          if (currentText === canonical) return { hash, object };
          throw new VaultSyncError(
            'CORRUPT_MANIFEST',
            `immutable manifest ${hash} already exists with different content`,
          );
        }
        return { hash, object };
      } catch (error) {
        throw normalizeFirebaseSyncError(error);
      }
    },

    async compareAndSwapHead(
      vaultId: string,
      expected: ExpectedHead | null,
      next: RemoteHeadInput,
    ): Promise<RemoteHead> {
      try {
        const uid = requireUid();
        const written = await firestore.compareAndSwapHeadDocument(
          uid,
          vaultId,
          expected,
          next,
        );
        if (written === null) {
          throw new VaultSyncError(
            'REMOTE_CHANGED',
            `HEAD changed under vault ${vaultId}: reload and retry`,
          );
        }
        return parseRemoteHead(normalizeHeadRecord(written));
      } catch (error) {
        throw normalizeFirebaseSyncError(error, { compareAndSwap: true });
      }
    },

    watchHead(
      vaultId: string,
      onHead: (head: RemoteHead | null) => void,
      onError?: (error: unknown) => void,
    ): () => void {
      // Identity is captured at subscribe time:  disposes sync
      // before Firebase sign-out and resubscribes on the next sign-in,
      // so a watcher can never leak one user's HEAD into another's
      // session. Subscription-local failures travel through this
      // subscription's `onError` only — never a host-global hook — so
      // ownership stays where the subscription was created.
      const uid = requireUid();
      return firestore.watchHeadDocument(
        uid,
        vaultId,
        (data) => {
          if (data === null) {
            onHead(null);
            return;
          }
          // The watcher is a lossy change hint; corrupt
          // snapshots are dropped here and surface authoritatively
          // through readHead on the next reconcile.
          try {
            onHead(parseRemoteHead(normalizeHeadRecord(data)));
          } catch {
            return;
          }
        },
        onError === undefined
          ? undefined
          : (error) => {
              try {
                onError(normalizeFirebaseSyncError(error));
              } catch {
                // Error reporting must never break the watcher.
              }
            },
      );
    },

    forUid(uid: string): SyncRemote {
      // Identity-stable scope: every path in the
      // returned view is built from the captured UID, never from the
      // live `getUid()`. A reconcile captures this once at cycle start
      // and uses it for the whole multi-step protocol, so later remote
      // calls can never operate under a new sign-in's namespace even if
      // the account switches mid-cycle (the service wrapper additionally
      // aborts the cycle on generation change before any further side
      // effect).
      if (uid.length === 0) {
        throw new VaultSyncError(
          'NOT_AUTHENTICATED',
          'sign in before syncing vaults',
        );
      }
      return createFirebaseSyncRemote({
        firestore,
        storage,
        getUid: () => uid,
      });
    },
  };
}
