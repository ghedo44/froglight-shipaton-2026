/**
 * Account capability.
 *
 * Platform-neutral authenticated identity behind `accountToken`
 * (`froglight.account`). The Firebase UID is the stable opaque Froglight
 * account identity — also the RevenueCat App User ID and the Firestore /
 * Storage owner identity. Email is credential-only.
 *
 * Imported as `@froglight/foundation/account` so providers bind the
 * capability without pulling the full foundation index.
 */

export {
  hasServerEntitlement,
  type AccountId,
  type AccountService,
  type AccountSnapshot,
  type AccountSnapshotListener,
  type AccountTokenState,
  type AccountTransport,
  type AccountUser,
} from './contract.js';
export {
  AccountError,
  isAccountError,
  isAccountErrorCode,
  normalizeAccountError,
  type AccountErrorCode,
} from './errors.js';
export {
  AccountStore,
  unconfiguredAccountTransport,
  type AccountStoreOptions,
} from './store.js';
export {
  createAccountHost,
  type AccountHost,
  type AccountHostOptions,
} from './plugin.js';
/**
 * Token re-export for hosts binding the capability without the full
 * index. The definition stays canonical in `src/tokens.ts` alongside
 * every other stable token; this alias keeps subpath consumers to one
 * import (no runtime cycle: `tokens.ts` only needs contract *types*).
 */
export { accountToken } from '../tokens.js';
