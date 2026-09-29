/**
 * Host-independent purchase state machine.
 *
 * The store is portable capability state: hosts inject a
 * `PurchaseTransport` (Tauri invoke on native, unsupported elsewhere) and
 * the service fans normalized DTOs out through explicit listener sets.
 * Native `CustomerInfo` updates arrive through `handleNativeEvent` as
 * state — like the stylus `get_capabilities` seed — so a load-time report
 * that fired before the JS subscriber existed is recovered by the
 * follow-up `refresh()` query instead of being lost.
 */

import { normalizePurchaseError, PurchaseError } from './errors.js';
import {
  PURCHASES_NATIVE_EVENT_CHANNEL,
  type PurchaseCustomerState,
  type PurchaseNativeEventName,
  type PurchaseOffering,
  type PurchaseResult,
  type PurchaseService,
  type PurchaseSnapshot,
  type PurchaseSnapshotListener,
  type PurchaseTransport,
} from './contract.js';

export { PURCHASES_NATIVE_EVENT_CHANNEL };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : null;
}

function asNullableBoolean(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'boolean' ? value : null;
}

function copyCustomerState(customer: PurchaseCustomerState): PurchaseCustomerState {
  return {
    appUserId: customer.appUserId,
    activeEntitlementIds: [...customer.activeEntitlementIds],
    entitlements: { ...customer.entitlements },
  };
}

function copyOfferings(
  offerings: readonly PurchaseOffering[],
): readonly PurchaseOffering[] {
  return offerings.map((offering) => ({
    id: offering.id,
    packages: offering.packages.map((pkg) => ({
      id: pkg.id,
      kind: pkg.kind,
      product: {
        id: pkg.product.id,
        title: pkg.product.title,
        description: pkg.product.description,
        price: { ...pkg.product.price },
        period: pkg.product.period,
      },
    })),
  }));
}

/**
 * Validate an unknown native payload as a `PurchaseCustomerState`.
 * Returns a normalized copy or null when malformed. Unknown extra fields
 * are dropped at this DTO boundary by design — shared consumers only see
 * the fields Froglight needs.
 */
export function asPurchaseCustomerState(payload: unknown): PurchaseCustomerState | null {
  if (!isPlainObject(payload)) return null;
  const appUserId = asString(payload.appUserId);
  if (appUserId === null || appUserId.length === 0) return null;
  if (!Array.isArray(payload.activeEntitlementIds)) return null;
  const activeEntitlementIds: string[] = [];
  for (const entry of payload.activeEntitlementIds) {
    if (typeof entry !== 'string') return null;
    activeEntitlementIds.push(entry);
  }
  if (!isPlainObject(payload.entitlements)) return null;
  const entitlements: Record<string, PurchaseCustomerState['entitlements'][string]> = {};
  for (const [key, value] of Object.entries(payload.entitlements)) {
    if (!isPlainObject(value)) return null;
    if (typeof value.active !== 'boolean') return null;
    entitlements[key] = {
      active: value.active,
      productId: asNullableString(value.productId),
      expirationDate: asNullableString(value.expirationDate),
      willRenew: asNullableBoolean(value.willRenew),
    };
  }
  return { appUserId, activeEntitlementIds, entitlements };
}

export interface PurchaseStoreOptions {
  readonly transport?: PurchaseTransport;
  readonly initialCustomer?: PurchaseCustomerState | null;
}

export class PurchaseStore implements PurchaseService {
  private readonly transport: PurchaseTransport;
  private customer: PurchaseCustomerState | null;
  private ready = false;
  private pending = 0;
  private error: PurchaseError | null = null;
  private readonly listeners = new Set<PurchaseSnapshotListener>();

  constructor(options: PurchaseStoreOptions = {}) {
    this.transport = options.transport ?? unsupportedPurchaseTransport;
    this.customer =
      options.initialCustomer !== undefined && options.initialCustomer !== null
        ? copyCustomerState(options.initialCustomer)
        : null;
    if (this.customer !== null) this.ready = true;
  }

  snapshot(): PurchaseSnapshot {
    return {
      ready: this.ready,
      loading: this.pending > 0,
      customer: this.customer === null ? null : copyCustomerState(this.customer),
      error: this.error,
    };
  }

  subscribe(listener: PurchaseSnapshotListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot);
      } catch {
        // Listener failures must never break purchase state dispatch.
      }
    }
  }

  private begin(): void {
    this.pending += 1;
    this.emit();
  }

  private end(): void {
    this.pending = Math.max(0, this.pending - 1);
    this.emit();
  }

  private applyCustomer(customer: PurchaseCustomerState): void {
    this.customer = copyCustomerState(customer);
    this.ready = true;
    this.error = null;
  }

  async refresh(): Promise<void> {
    this.begin();
    try {
      const raw = await this.transport.getCustomerInfo();
      const normalized = asPurchaseCustomerState(raw);
      if (normalized === null) {
        throw new PurchaseError('UNKNOWN', 'native host returned malformed customer state');
      }
      this.applyCustomer(normalized);
    } catch (error) {
      this.error = normalizePurchaseError(error);
      throw this.error;
    } finally {
      this.end();
    }
  }

  async offerings(): Promise<readonly PurchaseOffering[]> {
    try {
      const raw = await this.transport.getOfferings();
      if (!Array.isArray(raw)) {
        throw new PurchaseError('CONFIGURATION', 'native host returned malformed offerings');
      }
      return copyOfferings(raw);
    } catch (error) {
      const normalized = normalizePurchaseError(error);
      this.error = normalized;
      this.emit();
      throw normalized;
    }
  }

  async purchase(offeringId: string, packageId: string): Promise<PurchaseResult> {
    if (offeringId.length === 0) {
      throw new PurchaseError('INVALID_OFFERING', 'offering id must not be empty');
    }
    if (packageId.length === 0) {
      throw new PurchaseError('INVALID_PACKAGE', 'package id must not be empty');
    }
    this.begin();
    try {
      const result = await this.transport.purchasePackage(offeringId, packageId);
      if (result.cancelled) {
        // Cancellation preserves the previous entitlement state and is
        // never surfaced as an application error.
        const customer =
          result.customer !== null ? asPurchaseCustomerState(result.customer) : null;
        if (customer !== null) this.applyCustomer(customer);
        else this.error = null;
        this.ready = this.ready || customer !== null;
        const snapshot: PurchaseResult = {
          status: 'cancelled',
          customer: customer ?? (this.customer === null ? null : copyCustomerState(this.customer)),
        };
        return snapshot;
      }
      const normalized = asPurchaseCustomerState(result.customer);
      if (normalized === null) {
        throw new PurchaseError('UNKNOWN', 'native host returned malformed customer state');
      }
      this.applyCustomer(normalized);
      return { status: 'purchased', customer: copyCustomerState(normalized) };
    } catch (error) {
      this.error = normalizePurchaseError(error);
      throw this.error;
    } finally {
      this.end();
    }
  }

  async restore(): Promise<PurchaseResult> {
    this.begin();
    try {
      const raw = await this.transport.restorePurchases();
      const normalized = asPurchaseCustomerState(raw);
      if (normalized === null) {
        throw new PurchaseError('UNKNOWN', 'native host returned malformed customer state');
      }
      this.applyCustomer(normalized);
      return { status: 'purchased', customer: copyCustomerState(normalized) };
    } catch (error) {
      this.error = normalizePurchaseError(error);
      throw this.error;
    } finally {
      this.end();
    }
  }

  async identify(appUserId: string): Promise<PurchaseCustomerState> {
    if (appUserId.length === 0) {
      throw new PurchaseError('CONFIGURATION', 'app user id must not be empty');
    }
    this.begin();
    try {
      const raw = await this.transport.logIn(appUserId);
      const normalized = asPurchaseCustomerState(raw);
      if (normalized === null) {
        throw new PurchaseError('UNKNOWN', 'native host returned malformed customer state');
      }
      this.applyCustomer(normalized);
      return copyCustomerState(normalized);
    } catch (error) {
      this.error = normalizePurchaseError(error);
      throw this.error;
    } finally {
      this.end();
    }
  }

  async clearIdentity(): Promise<PurchaseCustomerState> {
    this.begin();
    try {
      const raw = await this.transport.logOut();
      const normalized = asPurchaseCustomerState(raw);
      if (normalized === null) {
        throw new PurchaseError('UNKNOWN', 'native host returned malformed customer state');
      }
      this.applyCustomer(normalized);
      return copyCustomerState(normalized);
    } catch (error) {
      this.error = normalizePurchaseError(error);
      throw this.error;
    } finally {
      this.end();
    }
  }

  handleNativeEvent(event: PurchaseNativeEventName, payload: unknown): void {
    if (event !== 'customerInfo') return;
    const normalized = asPurchaseCustomerState(payload);
    // A corrupt CustomerInfo report must never break purchase state.
    if (normalized === null) return;
    this.applyCustomer(normalized);
    this.emit();
  }
}

/**
 * Fallback transport for hosts without a purchase provider (desktop v1,
 * headless, tests without a fake). Returns a clean `UNSUPPORTED` rather
 * than panicking or presenting a mobile purchase API.
 */
export const unsupportedPurchaseTransport: PurchaseTransport = {
  async getCustomerInfo(): Promise<PurchaseCustomerState> {
    throw new PurchaseError('UNSUPPORTED', 'purchases are not supported on this host');
  },
  async getOfferings(): Promise<readonly PurchaseOffering[]> {
    throw new PurchaseError('UNSUPPORTED', 'purchases are not supported on this host');
  },
  async purchasePackage(): Promise<never> {
    throw new PurchaseError('UNSUPPORTED', 'purchases are not supported on this host');
  },
  async restorePurchases(): Promise<never> {
    throw new PurchaseError('UNSUPPORTED', 'purchases are not supported on this host');
  },
  async logIn(): Promise<never> {
    throw new PurchaseError('UNSUPPORTED', 'purchases are not supported on this host');
  },
  async logOut(): Promise<never> {
    throw new PurchaseError('UNSUPPORTED', 'purchases are not supported on this host');
  },
};
