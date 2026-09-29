/**
 * Firestore sync backend seam.
 *
 * `FirestoreSyncBackend` is the only Firestore surface the sync remote
 * needs: HEAD document reads, vault listing, transactional
 * compare-and-swap, and a single-document watcher. The production
 * implementation delegates to the Firebase modular Web SDK; tests inject
 * in-memory fakes. Documents cross this boundary as plain
 * `Record<string, unknown>` — validation into `RemoteHead` happens in
 * `sync-remote.ts`, never here, and no Firestore type leaks past this
 * package.
 *
 * Timestamps note: the transaction stamps `createdAt`/`updatedAt` as ISO
 * strings from the committer's clock (rather than server timestamps) so
 * both remotes behave identically for conformance. Revision — not wall
 * time — is the ordering authority, and `createdAt` is preserved from
 * the first commit, never rewritten.
 */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  runTransaction,
  type Firestore,
} from 'firebase/firestore';
import type { ExpectedHead, RemoteHeadInput } from '@froglight/foundation';

function headDocPath(uid: string, vaultId: string): string {
  return `users/${uid}/vaults/${vaultId}`;
}

function headCollectionPath(uid: string): string {
  return `users/${uid}/vaults`;
}

/** Minimal Firestore surface the sync remote consumes (real SDK or fake). */
export interface FirestoreSyncBackend {
  getHeadDocument(
    uid: string,
    vaultId: string,
  ): Promise<Record<string, unknown> | null>;
  listHeadDocuments(
    uid: string,
  ): Promise<readonly { id: string; data: Record<string, unknown> }[]>;
  /**
   * Transactionally replace the HEAD document. Returns the written
   * document, or null when `expected` no longer matches (lost race —
   * the caller maps that to `REMOTE_CHANGED`, never an overwrite).
   */
  compareAndSwapHeadDocument(
    uid: string,
    vaultId: string,
    expected: ExpectedHead | null,
    next: RemoteHeadInput,
  ): Promise<Record<string, unknown> | null>;
  /**
   * Invoke `listener` with the current document and on every change.
   * Returns an unsubscribe function. Snapshot errors have no channel on
   * `SyncRemote`, so they go to `onError`, which entitlement handling uses
   * to surface
   * revoked access); without it they are contained, never thrown.
   */
  watchHeadDocument(
    uid: string,
    vaultId: string,
    listener: (data: Record<string, unknown> | null) => void,
    onError?: (error: unknown) => void,
  ): () => void;
}

function matchesExpected(
  current: Record<string, unknown> | null,
  expected: ExpectedHead | null,
): boolean {
  if (expected === null) return current === null;
  return (
    current !== null &&
    current.revision === expected.revision &&
    current.manifestHash === expected.manifestHash
  );
}

export interface SdkFirestoreSyncBackendOptions {
  readonly firestore: Firestore;
}

/** Production backend: thin delegation to the Firebase Web SDK. */
export function createSdkFirestoreSyncBackend(
  options: SdkFirestoreSyncBackendOptions,
): FirestoreSyncBackend {
  const { firestore } = options;
  return {
    async getHeadDocument(
      uid: string,
      vaultId: string,
    ): Promise<Record<string, unknown> | null> {
      const snap = await getDoc(doc(firestore, headDocPath(uid, vaultId)));
      return snap.exists() ? snap.data() : null;
    },
    async listHeadDocuments(
      uid: string,
    ): Promise<readonly { id: string; data: Record<string, unknown> }[]> {
      const snaps = await getDocs(
        collection(firestore, headCollectionPath(uid)),
      );
      return snaps.docs.map((snap) => ({ id: snap.id, data: snap.data() }));
    },
    async compareAndSwapHeadDocument(
      uid: string,
      vaultId: string,
      expected: ExpectedHead | null,
      next: RemoteHeadInput,
    ): Promise<Record<string, unknown> | null> {
      return runTransaction(firestore, async (transaction) => {
        const ref = doc(firestore, headDocPath(uid, vaultId));
        const snap = await transaction.get(ref);
        const current = snap.exists()
          ? (snap.data() as Record<string, unknown>)
          : null;
        if (!matchesExpected(current, expected)) return null;
        const now = new Date().toISOString();
        const createdAt =
          current !== null && typeof current.createdAt === 'string'
            ? current.createdAt
            : now;
        const written: Record<string, unknown> = {
          protocolVersion: 1,
          ...next,
          createdAt,
          updatedAt: now,
        };
        transaction.set(ref, written);
        return written;
      });
    },
    watchHeadDocument(
      uid: string,
      vaultId: string,
      listener: (data: Record<string, unknown> | null) => void,
      onError?: (error: unknown) => void,
    ): () => void {
      return onSnapshot(
        doc(firestore, headDocPath(uid, vaultId)),
        (snap) => {
          try {
            listener(snap.exists() ? snap.data() : null);
          } catch {
            // A throwing consumer must never break the watcher.
          }
        },
        (error) => {
          try {
            onError?.(error);
          } catch {
            // Error reporting must never break the watcher either.
          }
        },
      );
    },
  };
}
