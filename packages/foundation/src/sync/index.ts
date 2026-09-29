/**
 * Vault sync protocol.
 *
 * Froglight-owned file-level sync: versioned content-addressed manifests,
 * three-way merge with conflict preservation, and a provider-neutral
 * remote contract. The Firebase provider implements `SyncRemote`; this
 * package ships the engine plus the memory remote for deterministic tests.
 */

export {
  SYNC_MANIFEST_FORMAT,
  SYNC_PROTOCOL_VERSION,
  isRemoteChanged,
  type BlobRef,
  type ExpectedHead,
  type ManifestHash,
  type PreparedRemoteVault,
  type RemoteHead,
  type RemoteHeadInput,
  type RemoteVaultInfo,
  type StoredSyncState,
  type SyncBase,
  type SyncBinding,
  type SyncDirtyTracker,
  type SyncManifest,
  type SyncManifestEntry,
  type SyncRemote,
  type AccountSyncState,
  type SyncAppliedNotification,
  type SyncWorkspaceReconciler,
  type VaultSyncAttachInput,
  type VaultSyncBinding,
  type VaultSyncBindingView,
  type VaultSyncConflictRecovery,
  type VaultSyncConflictSummary,
  type VaultSyncEnableInput,
  type VaultSyncPhase,
  type VaultSyncService,
  type VaultSyncSnapshot,
  type VaultSyncSnapshotListener,
  type VaultSyncStorage,
} from './contract.js';
export {
  VaultSyncError,
  isVaultSyncError,
  isVaultSyncErrorCode,
  normalizeSyncError,
  type VaultSyncErrorCode,
} from './errors.js';
export {
  SYNC_LIMITS,
  blobHex,
  blobRef,
  buildManifest,
  canonicalizeManifest,
  emptyManifest,
  hashBytes,
  hashManifest,
  isBlobRef,
  isManifestHash,
  manifestsEqual,
  parseManifestBytes,
  parseRemoteHead,
  parseSyncManifest,
  sortManifestEntries,
} from './manifest.js';
export {
  assignConflictDirectory,
  assignConflictPath,
  threeWayMerge,
  type MergeOptions,
  type MergePlan,
  type SyncConflict,
  type SyncConflictKind,
} from './merge.js';
export { MemorySyncRemote } from './remote-memory.js';
export { isDefaultExcludedSyncPath } from './exclude.js';
export {
  ObservableVaultService,
  SyncScheduler,
  asObservableVault,
  withObservableVault,
  type SyncSchedulerOptions,
  type SyncSchedulerTimer,
  type VaultMutation,
  type VaultMutationListener,
} from './mutations.js';
export {
  ManualDirtyTracker,
  VaultSyncStore,
  createIdentityPinnedRemote,
  createMemorySyncStorage,
  generateCloudVaultId,
  generateDeviceId,
  type VaultSyncEntitlementOptions,
  type VaultSyncServiceOptions,
  type VaultSyncSignOutDrainOutcome,
  type VaultSyncSignOutOptions,
} from './service.js';
export { parseStoredSyncState } from './persisted-state.js';
export {
  WorkspaceDirtyTracker,
  WorkspaceSyncReconciler,
  type WorkspaceDirtyTrackerOptions,
  type WorkspaceSyncReconcilerOptions,
} from './workspace-tracker.js';
export {
  createVaultSyncAttachment,
  createVaultSyncHost,
  type VaultSyncHost,
  type VaultSyncHostOptions,
} from './plugin.js';
export {
  createLocalScanCache,
  reconcileVault,
  verifyBlob,
  type IncrementalScanOptions,
  type LocalScanCache,
  type LocalScanCacheEntry,
  type ReconcileInput,
  type ReconcileResult,
  type SyncProgressStage,
} from './engine.js';
