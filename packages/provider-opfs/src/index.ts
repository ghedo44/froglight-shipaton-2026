/**
 * `@froglight/provider-opfs` — the OPFS vault provider.
 *
 *  proof that the host-independent workspace/capability contracts
 * run unchanged over real browser storage: this package implements the
 * portable `VaultService` contract over `navigator.storage.getDirectory()`
 * and re-runs the full contract suite plus a provider-swap lifecycle test
 * against it (via Playwright in a real browser).
 */

export {
  OpfsVault,
  type OpfsVaultOptions,
  type OpfsFailureInjector,
} from './opfs-vault.js';
export {
  OpfsDerivedCacheStorage,
  OPFS_DERIVED_CACHE_DIRECTORY,
  type OpfsDerivedCacheStorageOptions,
} from './derived-cache-storage.js';
export { mapOpfsError, isDomException } from './error-map.js';
export { opfsVaultPlugin, type OpfsVaultPluginConfig } from './plugin.js';
