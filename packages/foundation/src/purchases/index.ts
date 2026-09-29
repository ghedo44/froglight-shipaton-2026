/**
 * Purchase/entitlement capability.
 *
 * Platform-neutral customer state, offerings, and purchase operations
 * behind `purchasesToken` (`froglight.purchases`). Native providers
 * translate SDK models into these DTOs at the plugin boundary; shared
 * consumers depend only on `PurchaseService`.
 *
 * Imported as `@froglight/foundation/purchases` so native adapters can
 * bind the capability without pulling the full foundation index.
 */

export {
  FROGLIGHT_PRO_ENTITLEMENT,
  PURCHASES_NATIVE_EVENT_CHANNEL,
  hasEntitlement,
  hasFroglightPro,
  type PurchaseCustomerState,
  type PurchaseEntitlementInfo,
  type PurchaseNativeEventName,
  type PurchaseOffering,
  type PurchasePackage,
  type PurchasePackageKind,
  type PurchasePeriod,
  type PurchasePrice,
  type PurchaseProduct,
  type PurchaseResult,
  type PurchaseService,
  type PurchaseSnapshot,
  type PurchaseSnapshotListener,
  type PurchaseTransport,
  type PurchaseTransportPurchaseResult,
} from './contract.js';
export {
  PurchaseError,
  isPurchaseError,
  isPurchaseErrorCode,
  normalizePurchaseError,
  type PurchaseErrorCode,
} from './errors.js';
export {
  PurchaseStore,
  asPurchaseCustomerState,
  unsupportedPurchaseTransport,
  type PurchaseStoreOptions,
} from './store.js';
export {
  createPurchaseHost,
  type PurchaseHost,
  type PurchaseHostOptions,
} from './plugin.js';
/**
 * Token re-export for hosts binding the capability without the full
 * index. The definition stays canonical in `src/tokens.ts` alongside
 * every other stable token; this alias keeps subpath consumers to one
 * import (no runtime cycle: `tokens.ts` only needs contract *types*).
 */
export { purchasesToken } from '../tokens.js';
