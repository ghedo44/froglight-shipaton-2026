/**
 * Purchase/entitlement capability contract.
 *
 * Platform-neutral Froglight-owned DTOs behind `purchasesToken`
 * (`froglight.purchases`). No RevenueCat, StoreKit, Tauri, DOM, or React
 * types leak into this surface: native providers translate SDK models into
 * these DTOs at the plugin boundary, and shared consumers depend only on
 * `PurchaseService`.
 *
 * The plugin knows about entitlements, offerings, packages, and customer
 * state. It never decides what "Froglight Pro" means — application policy
 * (`FROGLIGHT_PRO_ENTITLEMENT` / `hasFroglightPro`) owns that mapping.
 */

import type { PurchaseError } from './errors.js';

/** Native event channel the Tauri hosts call into. */
export const PURCHASES_NATIVE_EVENT_CHANNEL = '__FROGLIGHT_PURCHASES_EVENT__';

export type PurchaseNativeEventName = 'customerInfo' | string;

/** Application policy: the RevenueCat entitlement that grants Froglight Pro. */
export const FROGLIGHT_PRO_ENTITLEMENT = 'pro';

export interface PurchasePrice {
  /** Localized formatted price from the store (authoritative, never hardcoded). */
  readonly formatted: string;
  readonly currencyCode: string | null;
  readonly amountMicros?: number;
}

export type PurchasePeriod =
  | 'week'
  | 'month'
  | 'twoMonths'
  | 'threeMonths'
  | 'sixMonths'
  | 'year'
  | null;

export interface PurchaseProduct {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly price: PurchasePrice;
  readonly period: PurchasePeriod;
}

export type PurchasePackageKind =
  | 'weekly'
  | 'monthly'
  | 'twoMonth'
  | 'threeMonth'
  | 'sixMonth'
  | 'annual'
  | 'lifetime'
  | 'custom';

export interface PurchasePackage {
  /** RevenueCat package identifier (for example `$rc_monthly`). */
  readonly id: string;
  readonly kind: PurchasePackageKind;
  readonly product: PurchaseProduct;
}

export interface PurchaseOffering {
  /** RevenueCat offering identifier (for example `default`). */
  readonly id: string;
  readonly packages: readonly PurchasePackage[];
}

export interface PurchaseEntitlementInfo {
  readonly active: boolean;
  readonly productId: string | null;
  readonly expirationDate: string | null;
  readonly willRenew: boolean | null;
}

export interface PurchaseCustomerState {
  readonly appUserId: string;
  readonly activeEntitlementIds: readonly string[];
  readonly entitlements: Readonly<Record<string, PurchaseEntitlementInfo>>;
}

export interface PurchaseSnapshot {
  /** True after the first successful seed (refresh or native event). */
  readonly ready: boolean;
  readonly loading: boolean;
  readonly customer: PurchaseCustomerState | null;
  readonly error: PurchaseError | null;
}

export type PurchaseResult =
  | {
      readonly status: 'purchased';
      readonly customer: PurchaseCustomerState;
    }
  | {
      readonly status: 'cancelled';
      readonly customer: PurchaseCustomerState | null;
    };

export type PurchaseSnapshotListener = (snapshot: PurchaseSnapshot) => void;

/**
 * Host-provided native operations. Implemented with Tauri invoke on native,
 * noop/unsupported elsewhere. Identifiers are semantic (`offeringId`,
 * `packageId`) — callers never hand a product object back to native.
 */
export interface PurchaseTransport {
  getCustomerInfo(): Promise<PurchaseCustomerState>;
  getOfferings(): Promise<readonly PurchaseOffering[]>;
  purchasePackage(
    offeringId: string,
    packageId: string,
  ): Promise<PurchaseTransportPurchaseResult>;
  restorePurchases(): Promise<PurchaseCustomerState>;
  logIn(appUserId: string): Promise<PurchaseCustomerState>;
  logOut(): Promise<PurchaseCustomerState>;
}

export type PurchaseTransportPurchaseResult =
  | {
      readonly cancelled: false;
      readonly customer: PurchaseCustomerState;
    }
  | {
      readonly cancelled: true;
      readonly customer: PurchaseCustomerState | null;
    };

/**
 * Stable purchase service behind `purchasesToken`. Framework- and
 * host-free: feed it with a `PurchaseTransport` from the Tauri adapter,
 * a web provider later, or fakes in tests.
 */
export interface PurchaseService {
  snapshot(): PurchaseSnapshot;
  /** Subscribe to every snapshot change; returns an unregister function. */
  subscribe(listener: PurchaseSnapshotListener): () => void;
  /** Seed/refresh customer state from the host. */
  refresh(): Promise<void>;
  offerings(): Promise<readonly PurchaseOffering[]>;
  purchase(offeringId: string, packageId: string): Promise<PurchaseResult>;
  restore(): Promise<PurchaseResult>;
  /** Authenticated identity: bind RevenueCat to the Froglight account ID
   * (the Firebase Auth UID). The account ↔ purchase identity
   * coordinator calls this on sign-in; account-bound flows ensure it
   * before starting a paid subscription. Anonymous until sign-in. */
  identify?(appUserId: string): Promise<PurchaseCustomerState>;
  clearIdentity?(): Promise<PurchaseCustomerState>;
  /**
   * Ingest one native event (low-frequency CustomerInfo updates).
   * Malformed payloads are ignored and never throw.
   */
  handleNativeEvent(event: PurchaseNativeEventName, payload: unknown): void;
}

/** Application policy: does this customer hold the Froglight Pro entitlement? */
export function hasFroglightPro(
  customer: PurchaseCustomerState | null,
): boolean {
  if (customer === null) return false;
  return customer.activeEntitlementIds.includes(FROGLIGHT_PRO_ENTITLEMENT);
}

/** Minimal entitlement gate around a customer state (never scattered string checks). */
export function hasEntitlement(
  customer: PurchaseCustomerState | null,
  entitlement: string,
): boolean {
  if (customer === null) return false;
  return customer.activeEntitlementIds.includes(entitlement);
}
