/**
 * Purchase/entitlement capability conformance.
 *
 * Host- and framework-free: platform-neutral DTOs, error normalization,
 * cancellation semantics, restore authority, and the runtime lifecycle
 * invariant. No RevenueCat, StoreKit, or Tauri types appear here — fakes
 * stand in for every native provider.
 */

import { describe, expect, it } from 'vitest';
import { Runtime, definePlugin } from '@froglight/runtime';
import { purchasesToken } from '../tokens.js';
import {
  FROGLIGHT_PRO_ENTITLEMENT,
  PURCHASES_NATIVE_EVENT_CHANNEL,
  hasEntitlement,
  hasFroglightPro,
  type PurchaseCustomerState,
  type PurchaseOffering,
  type PurchaseTransport,
} from './contract.js';
import {
  PurchaseError,
  isPurchaseError,
  normalizePurchaseError,
} from './errors.js';
import { PurchaseStore, asPurchaseCustomerState } from './store.js';
import { createPurchaseHost } from './plugin.js';

const FREE_CUSTOMER: PurchaseCustomerState = {
  appUserId: 'anon-test-user',
  activeEntitlementIds: [],
  entitlements: {
    pro: {
      active: false,
      productId: null,
      expirationDate: null,
      willRenew: null,
    },
  },
};

const PRO_CUSTOMER: PurchaseCustomerState = {
  appUserId: 'anon-test-user',
  activeEntitlementIds: ['pro'],
  entitlements: {
    pro: {
      active: true,
      productId: 'froglight_pro_annual',
      expirationDate: '2027-09-30T00:00:00.000Z',
      willRenew: true,
    },
  },
};

const OFFERINGS: readonly PurchaseOffering[] = [
  {
    id: 'default',
    packages: [
      {
        id: '$rc_monthly',
        kind: 'monthly',
        product: {
          id: 'froglight_pro_monthly',
          title: 'Froglight Pro Monthly',
          description: 'Monthly subscription',
          price: {
            formatted: '$4.99',
            currencyCode: 'USD',
            amountMicros: 4990000,
          },
          period: 'month',
        },
      },
      {
        id: '$rc_annual',
        kind: 'annual',
        product: {
          id: 'froglight_pro_annual',
          title: 'Froglight Pro Annual',
          description: 'Annual subscription',
          price: {
            formatted: '$49.99',
            currencyCode: 'USD',
            amountMicros: 49990000,
          },
          period: 'year',
        },
      },
    ],
  },
];

function fakeTransport(
  overrides: Partial<PurchaseTransport> = {},
): PurchaseTransport & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async getCustomerInfo() {
      calls.push('getCustomerInfo');
      return structuredClone(FREE_CUSTOMER);
    },
    async getOfferings() {
      calls.push('getOfferings');
      return structuredClone(OFFERINGS);
    },
    async purchasePackage(offeringId, packageId) {
      calls.push(`purchasePackage:${offeringId}:${packageId}`);
      return { cancelled: false, customer: structuredClone(PRO_CUSTOMER) };
    },
    async restorePurchases() {
      calls.push('restorePurchases');
      return structuredClone(PRO_CUSTOMER);
    },
    async logIn(appUserId) {
      calls.push(`logIn:${appUserId}`);
      return structuredClone({ ...FREE_CUSTOMER, appUserId });
    },
    async logOut() {
      calls.push('logOut');
      return structuredClone(FREE_CUSTOMER);
    },
    ...overrides,
  };
}

describe('purchase errors', () => {
  it('normalizes native-shaped failures to stable codes', () => {
    const normalized = normalizePurchaseError({
      code: 'INVALID_PACKAGE',
      message: 'no such package',
    });
    expect(normalized).toBeInstanceOf(PurchaseError);
    expect(normalized.code).toBe('INVALID_PACKAGE');
    expect(isPurchaseError(normalized)).toBe(true);
  });

  it('maps unknown codes and values to UNKNOWN without throwing', () => {
    expect(normalizePurchaseError({ code: 'RC_FUTURE_CODE' }).code).toBe(
      'UNKNOWN',
    );
    expect(normalizePurchaseError(new Error('boom')).code).toBe('UNKNOWN');
    expect(normalizePurchaseError('boom').code).toBe('UNKNOWN');
    expect(normalizePurchaseError(null).code).toBe('UNKNOWN');
  });

  it('passes PurchaseError through unchanged', () => {
    const original = new PurchaseError('NETWORK', 'offline');
    expect(normalizePurchaseError(original)).toBe(original);
  });
});

describe('purchase store', () => {
  it('starts unready with no customer and reports the event channel', () => {
    const store = new PurchaseStore({ transport: fakeTransport() });
    expect(store.snapshot()).toMatchObject({
      ready: false,
      loading: false,
      customer: null,
      error: null,
    });
    expect(PURCHASES_NATIVE_EVENT_CHANNEL).toBe(
      '__FROGLIGHT_PURCHASES_EVENT__',
    );
  });

  it('seeds customer state through refresh and notifies once per phase', async () => {
    const store = new PurchaseStore({ transport: fakeTransport() });
    const seen: boolean[] = [];
    const dispose = store.subscribe(() => seen.push(store.snapshot().loading));
    await store.refresh();
    expect(store.snapshot()).toMatchObject({ ready: true, loading: false });
    expect(store.snapshot().customer).toEqual(FREE_CUSTOMER);
    expect(hasFroglightPro(store.snapshot().customer)).toBe(false);
    // begin(true) + end(false): exactly two emissions for one refresh.
    expect(seen).toEqual([true, false]);
    dispose();
    await store.refresh();
    expect(seen).toHaveLength(2);
  });

  it('applies native CustomerInfo events and ignores malformed payloads', () => {
    const store = new PurchaseStore({ transport: fakeTransport() });
    const seen: number[] = [];
    const dispose = store.subscribe(() => seen.push(1));
    store.handleNativeEvent('customerInfo', structuredClone(PRO_CUSTOMER));
    expect(store.snapshot().customer).toEqual(PRO_CUSTOMER);
    expect(hasFroglightPro(store.snapshot().customer)).toBe(true);
    const count = seen.length;
    store.handleNativeEvent('customerInfo', null);
    store.handleNativeEvent('customerInfo', { appUserId: '' });
    store.handleNativeEvent('customerInfo', 'pro');
    store.handleNativeEvent('unknown-event', structuredClone(FREE_CUSTOMER));
    expect(store.snapshot().customer).toEqual(PRO_CUSTOMER);
    expect(seen).toHaveLength(count);
    dispose();
  });

  it('validates customer payloads defensively', () => {
    expect(asPurchaseCustomerState(null)).toBeNull();
    expect(asPurchaseCustomerState({})).toBeNull();
    expect(
      asPurchaseCustomerState({
        appUserId: 'u',
        activeEntitlementIds: ['pro'],
        entitlements: { pro: { active: 'yes' } },
      }),
    ).toBeNull();
    expect(
      asPurchaseCustomerState({
        appUserId: 'u',
        activeEntitlementIds: 'pro',
        entitlements: {},
      }),
    ).toBeNull();
  });

  it('purchase success updates the entitlement immediately', async () => {
    const transport = fakeTransport();
    const store = new PurchaseStore({ transport });
    await store.refresh();
    expect(hasFroglightPro(store.snapshot().customer)).toBe(false);
    const result = await store.purchase('default', '$rc_annual');
    expect(result.status).toBe('purchased');
    expect(transport.calls).toContain('purchasePackage:default:$rc_annual');
    expect(hasFroglightPro(store.snapshot().customer)).toBe(true);
    expect(store.snapshot().error).toBeNull();
  });

  it('purchase cancellation is not an error and preserves prior state', async () => {
    const transport = fakeTransport({
      async purchasePackage() {
        return { cancelled: true as const, customer: null };
      },
    });
    const store = new PurchaseStore({ transport });
    await store.refresh();
    const before = store.snapshot().customer;
    const result = await store.purchase('default', '$rc_monthly');
    expect(result).toEqual({ status: 'cancelled', customer: before });
    expect(store.snapshot().customer).toEqual(before);
    expect(store.snapshot().error).toBeNull();
  });

  it('rejects empty identifiers without touching the transport', async () => {
    const transport = fakeTransport();
    const store = new PurchaseStore({ transport });
    await expect(store.purchase('', '$rc_annual')).rejects.toMatchObject({
      code: 'INVALID_OFFERING',
    });
    await expect(store.purchase('default', '')).rejects.toMatchObject({
      code: 'INVALID_PACKAGE',
    });
    expect(transport.calls).not.toContainEqual(
      expect.stringContaining('purchasePackage'),
    );
  });

  it('restore makes the returned CustomerInfo authoritative', async () => {
    const store = new PurchaseStore({ transport: fakeTransport() });
    await store.refresh();
    expect(hasFroglightPro(store.snapshot().customer)).toBe(false);
    const result = await store.restore();
    expect(result.status).toBe('purchased');
    expect(hasFroglightPro(store.snapshot().customer)).toBe(true);
  });

  it('surfaces transport failures as snapshot errors and rethrows', async () => {
    const store = new PurchaseStore({
      transport: fakeTransport({
        async getCustomerInfo(): Promise<PurchaseCustomerState> {
          throw new PurchaseError('NETWORK', 'offline');
        },
      }),
    });
    await expect(store.refresh()).rejects.toMatchObject({ code: 'NETWORK' });
    expect(store.snapshot().error?.code).toBe('NETWORK');
  });

  it('supports future identity methods without exposing them in v1 UI', async () => {
    const store = new PurchaseStore({ transport: fakeTransport() });
    const identified = await store.identify('froglight-account-uuid-1');
    expect(identified.appUserId).toBe('froglight-account-uuid-1');
    await expect(store.identify('')).rejects.toMatchObject({
      code: 'CONFIGURATION',
    });
    const cleared = await store.clearIdentity();
    expect(cleared.appUserId).toBe('anon-test-user');
  });

  it('reports the Firebase UID as the current RevenueCat identity after identify', async () => {
    const store = new PurchaseStore({ transport: fakeTransport() });
    const firebaseUid = 'abc123';
    const identified = await store.identify(firebaseUid);
    expect(identified.appUserId).toBe(firebaseUid);
    expect(store.snapshot().customer?.appUserId).toBe(firebaseUid);
  });

  it('desktop-style unsupported transports fail cleanly', async () => {
    const store = new PurchaseStore();
    await expect(store.refresh()).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });
    await expect(store.offerings()).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });
    await expect(store.purchase('default', '$rc_annual')).rejects.toMatchObject(
      {
        code: 'UNSUPPORTED',
      },
    );
    expect(store.snapshot().ready).toBe(false);
  });

  it('listener failures never break dispatch', async () => {
    const store = new PurchaseStore({ transport: fakeTransport() });
    store.subscribe(() => {
      throw new Error('ui listener blew up');
    });
    let second = 0;
    store.subscribe(() => {
      second += 1;
    });
    await store.refresh();
    expect(second).toBeGreaterThan(0);
  });

  it('application policy owns the pro mapping, not the plugin', () => {
    expect(FROGLIGHT_PRO_ENTITLEMENT).toBe('pro');
    expect(hasFroglightPro(PRO_CUSTOMER)).toBe(true);
    expect(hasFroglightPro(FREE_CUSTOMER)).toBe(false);
    expect(hasFroglightPro(null)).toBe(false);
    expect(hasEntitlement(PRO_CUSTOMER, 'pro')).toBe(true);
    expect(hasEntitlement(PRO_CUSTOMER, 'other')).toBe(false);
  });
});

describe('purchase runtime binding', () => {
  it('provides one binding, withdraws on dispose, restores on reactivate', async () => {
    const runtime = new Runtime();
    const host = createPurchaseHost({ transport: fakeTransport() });
    const slot = await runtime.registerSlot({
      id: 'purchases',
      plugin: host.definition,
    });
    expect(slot.id).toBe('purchases');

    let observed = 0;
    const probe = await runtime.registerSlot({
      id: 'purchases-probe',
      plugin: definePlugin({
        id: 'froglight.purchases.probe',
        requirements: { requires: [purchasesToken] },
        activate: (ctx) => {
          ctx.require(purchasesToken);
          observed += 1;
          ctx.effect(() => () => {
            observed -= 1;
          });
        },
      }),
    });
    expect(observed).toBe(1);

    await runtime.removeSlot(probe.id);
    expect(observed).toBe(0);

    await runtime.removeSlot(slot.id);
    await runtime.registerSlot({ id: 'purchases', plugin: host.definition });
    let observedAgain = 0;
    await runtime.registerSlot({
      id: 'purchases-probe',
      plugin: definePlugin({
        id: 'froglight.purchases.probe',
        requirements: { requires: [purchasesToken] },
        activate: (ctx) => {
          const service = ctx.require(purchasesToken);
          if (service === host.service) observedAgain += 1;
        },
      }),
    });
    expect(observedAgain).toBe(1);

    await runtime.dispose();
  });

  it('keeps seeded customer state across reactivations (host-owned state)', async () => {
    const runtime = new Runtime();
    const host = createPurchaseHost({ transport: fakeTransport() });
    host.service.handleNativeEvent(
      'customerInfo',
      structuredClone(PRO_CUSTOMER),
    );
    await runtime.registerSlot({ id: 'purchases', plugin: host.definition });
    await runtime.removeSlot('purchases');
    await runtime.registerSlot({ id: 'purchases', plugin: host.definition });
    let observed: PurchaseCustomerState | null = null;
    await runtime.registerSlot({
      id: 'purchases-probe',
      plugin: definePlugin({
        id: 'froglight.purchases.probe2',
        requirements: { requires: [purchasesToken] },
        activate: (ctx) => {
          observed = ctx.require(purchasesToken).snapshot().customer;
        },
      }),
    });
    expect(observed).toEqual(PRO_CUSTOMER);
    await runtime.dispose();
  });
});
