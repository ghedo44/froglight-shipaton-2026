/**
 * Account ↔ purchase identity coordinator.
 *
 * One identity only: the Firebase UID becomes the RevenueCat App User ID
 * before any account-bound purchase or sync, and ordered sign-out
 * dismantles cloud authority without touching local vaults.
 */

export {
  type AccountIdentityService,
  type AccountIdentitySnapshot,
  type AccountIdentitySnapshotListener,
} from './contract.js';
export {
  AccountIdentityCoordinator,
  type AccountIdentityBinding,
  type AccountIdentityCoordinatorOptions,
} from './coordinator.js';
export {
  createAccountIdentityHost,
  type AccountIdentityHost,
  type AccountIdentityHostOptions,
} from './plugin.js';
/**
 * Token re-export for hosts binding the capability without the full
 * index. The definition stays canonical in `src/tokens.ts` alongside
 * every other stable token; this alias keeps subpath consumers to one
 * import (no runtime cycle: `tokens.ts` only needs contract *types*).
 */
export { accountIdentityToken } from '../tokens.js';
