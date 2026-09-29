/**
 * `@froglight/provider-firebase` — the Firebase implementation provider.
 *
 * Replaceable backend behind Froglight-owned capabilities:
 * Firebase Auth implements `froglight.account`; Firestore and
 * Storage sync backends arrive in later slices. Shared Foundation never
 * imports this package — hosts inject its transports into capability
 * stores, so swapping providers never touches consumers.
 */

export {
  resolveFirebaseProviderConfig,
  type FirebaseProviderConfig,
} from './config.js';
export { normalizeFirebaseAuthError } from './errors.js';
export {
  normalizeFirebaseSyncError,
  type NormalizeFirebaseSyncErrorOptions,
} from './sync-errors.js';
export {
  createSdkFirestoreSyncBackend,
  type FirestoreSyncBackend,
  type SdkFirestoreSyncBackendOptions,
} from './firestore-backend.js';
export {
  createSdkStorageSyncBackend,
  type SdkStorageSyncBackendOptions,
  type StorageSyncBackend,
} from './storage-backend.js';
export {
  createFirebaseSyncRemote,
  type FirebaseSyncRemoteOptions,
} from './sync-remote.js';
export {
  createFirebaseSyncHost,
  createTestSyncStorage,
  createUnconfiguredSyncRemote,
  resolveFirebaseConfigFromEnv,
  resolveFirebaseEmulatorHosts,
  type FirebaseEmulatorHosts,
  type FirebaseEnvValues,
  type FirebaseSyncHost,
  type FirebaseSyncHostOptions,
} from './firebase-host.js';
export {
  createLocalStorageSyncStorage,
  DEFAULT_SYNC_STORAGE_KEY,
  type LocalStorageSyncStorageOptions,
  type SyncStorageBackend,
} from './sync-storage.js';
export {
  FIREBASE_AUTH_PERSISTENCE,
  createSdkFirebaseAuthBackend,
  getFirebaseApp,
  getFirebaseAuth,
  parseServerEntitlements,
  resetFirebaseAppCacheForTests,
  type FirebaseAuthBackend,
  type FirebaseBackendUser,
  type SdkFirebaseAuthBackendOptions,
} from './auth-backend.js';
export {
  createFirebaseAccountTransport,
  type FirebaseAccountTransportOptions,
} from './account.js';
