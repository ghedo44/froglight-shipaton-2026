/**
 * `@froglight/provider-native-fs` — the native filesystem vault provider.
 *
 *  proof that the host-independent workspace/capability contracts
 * run unchanged over real native storage: this package implements the
 * portable `VaultService` contract over a host directory and re-runs the
 * full contract suite plus a provider-swap lifecycle test against it.
 */

export {
  NativeFsVault,
  type NativeFsVaultOptions,
  type NativeFsFailureInjector,
} from './native-fs-vault.js';
export { mapFsError } from './error-map.js';
export { nativeFsVaultPlugin, type NativeFsVaultPluginConfig } from './plugin.js';
