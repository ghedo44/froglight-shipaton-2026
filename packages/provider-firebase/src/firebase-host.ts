/**
 * Firebase sync host construction.
 *
 * Hosts (PWA + Tauri WebView) build the replaceable Firebase backend from
 * public web config and inject it into Froglight-owned capabilities:
 *
 * ```text
 * Firebase Auth  → froglight.account (transport)
 * Firestore      → control plane backend
 * Storage        → data-plane backend
 * SyncRemote     → provider-neutral remote over both backends
 * VaultSyncStore → froglight.vault-sync
 * VaultSyncHost  → runtime slot definition
 * ```
 *
 * A null config means local-only development: the account
 * transport reports `NOT_CONFIGURED` and the sync remote denies every
 * cloud call with `NOT_CONFIGURED` — the app still boots and local
 * vaults keep working. The sync service itself always exists so settings
 * UI renders an honest unavailable state instead of a missing section.
 *
 * No Firebase type leaks past this package: consumers receive foundation
 * DTOs and the runtime host definition only.
 */

import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore';
import { getStorage, connectStorageEmulator } from 'firebase/storage';
import {
  VaultSyncStore,
  WorkspaceDirtyTracker,
  WorkspaceSyncReconciler,
  createVaultSyncHost,
  type AccountService,
  type StoredSyncState,
  type SyncRemote,
  type VaultSyncStorage,
  type VaultSyncStore as VaultSyncStoreType,
  type VaultSyncHost as FoundationVaultSyncHost,
  type WorkspaceService,
} from '@froglight/foundation';
import type { PurchaseService } from '@froglight/foundation/purchases';
import type { FirebaseProviderConfig } from './config.js';
import { getFirebaseApp } from './auth-backend.js';
import { createSdkFirestoreSyncBackend } from './firestore-backend.js';
import { createSdkStorageSyncBackend } from './storage-backend.js';
import { createFirebaseSyncRemote } from './sync-remote.js';
import { createLocalStorageSyncStorage } from './sync-storage.js';

import {
  createUnconfiguredSyncRemote,
  resolveFirebaseConfigFromEnv,
  resolveFirebaseEmulatorHosts,
  type FirebaseEmulatorHosts,
  type FirebaseEnvValues,
} from './config-env.js';

export {
  createUnconfiguredSyncRemote,
  resolveFirebaseConfigFromEnv,
  resolveFirebaseEmulatorHosts,
  type FirebaseEmulatorHosts,
  type FirebaseEnvValues,
};

function splitHostPort(value: string): { host: string; port: number } | null {
  const separator = value.lastIndexOf(':');
  if (separator <= 0) return null;
  const port = Number(value.slice(separator + 1));
  if (!Number.isInteger(port) || port <= 0) return null;
  return { host: value.slice(0, separator), port };
}

export interface FirebaseSyncHostOptions {
  /** Null selects the unconfigured remote (local-only).*/
  readonly config: FirebaseProviderConfig | null;
  readonly account: AccountService;
  /** Client purchase state for UI gating only (never authorization). */
  readonly purchases?: PurchaseService | null;
  /** Live workspace lookup for the session-backed dirty tracker. */
  readonly getWorkspace: () => WorkspaceService | null;
  /** Host sync-metadata storage; defaults to localStorage + memory. */
  readonly storage?: VaultSyncStorage;
  /** Manual-verification emulator hosts (dev only, never production). */
  readonly emulators?: FirebaseEmulatorHosts;
}

export interface FirebaseSyncHost {
  readonly remote: SyncRemote;
  readonly service: VaultSyncStoreType;
  readonly host: FoundationVaultSyncHost;
  /** The resolved config, or null when running local-only. */
  readonly config: FirebaseProviderConfig | null;
}

/**
 * Build the Firebase sync backend + Froglight-owned sync service for one
 * host bootstrap. The service instance is host state (outlives fibers);
 * register `host.definition` (host lifetime, account-only) as a runtime
 * slot after the account slot AND `host.attachment` (workspace lifetime,
 * vault + sync) so the launcher keeps `vaultSyncToken` with no vault open
 * while the active observable vault stays attached during workspaces.
 */
export function createFirebaseSyncHost(
  options: FirebaseSyncHostOptions,
): FirebaseSyncHost {
  const { config, account } = options;
  if (config === null) {
    const remote = createUnconfiguredSyncRemote();
    const service = new VaultSyncStore({
      remote,
      account,
      storage: options.storage ?? createLocalStorageSyncStorage(),
      tracker: new WorkspaceDirtyTracker({
        getWorkspace: options.getWorkspace,
      }),
      reconciler: new WorkspaceSyncReconciler({
        getWorkspace: options.getWorkspace,
      }),
      ...(options.purchases !== undefined
        ? { purchases: options.purchases }
        : {}),
    });
    return { remote, service, host: createVaultSyncHost({ service }), config };
  }
  const app = getFirebaseApp(config);
  const firestore = getFirestore(app);
  const storage = getStorage(app);
  const firestoreEmulator = options.emulators?.firestoreHost;
  if (firestoreEmulator !== undefined) {
    const parsed = splitHostPort(firestoreEmulator);
    if (parsed !== null) {
      try {
        connectFirestoreEmulator(firestore, parsed.host, parsed.port);
      } catch {
        // Emulator wiring is best-effort manual verification; production
        // paths never set these hosts.
      }
    }
  }
  const storageEmulator = options.emulators?.storageHost;
  if (storageEmulator !== undefined) {
    const parsed = splitHostPort(storageEmulator);
    if (parsed !== null) {
      try {
        connectStorageEmulator(storage, parsed.host, parsed.port);
      } catch {
        // Same best-effort posture as Firestore above.
      }
    }
  }
  const remote = createFirebaseSyncRemote({
    firestore: createSdkFirestoreSyncBackend({ firestore }),
    storage: createSdkStorageSyncBackend({ storage }),
    getUid: () => account.snapshot().user?.id ?? null,
    // HEAD watcher failures have no throw channel: they travel through
    // the per-`watchHead()` `onError` subscription callback owned by
    // `VaultSyncStore.#attachWatcher()` — never a host-global hook — so
    // a stale vault-A error can never be published into vault B.
  });
  const service = new VaultSyncStore({
    remote,
    account,
    storage: options.storage ?? createLocalStorageSyncStorage(),
    tracker: new WorkspaceDirtyTracker({
      getWorkspace: options.getWorkspace,
    }),
    reconciler: new WorkspaceSyncReconciler({
      getWorkspace: options.getWorkspace,
    }),
    ...(options.purchases !== undefined
      ? { purchases: options.purchases }
      : {}),
  });
  return { remote, service, host: createVaultSyncHost({ service }), config };
}

/** Test seam: persist sync state without touching localStorage. */
export function createTestSyncStorage(
  initial: StoredSyncState | null = null,
): VaultSyncStorage {
  let state = initial;
  return {
    async load(): Promise<StoredSyncState | null> {
      return state;
    },
    async save(next: StoredSyncState): Promise<void> {
      state = next;
    },
    async clear(): Promise<void> {
      state = null;
    },
  };
}
