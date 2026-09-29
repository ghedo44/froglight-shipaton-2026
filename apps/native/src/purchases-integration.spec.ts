/**
 * Purchases end-to-end proof.
 *
 * The RevenueCat integration contract at the logic level: the real
 * `PurchaseStore` drives the real native adapter transport against a
 * scripted native backend (standing in for the Rust/Swift plugin). No
 * mocks of the store or the adapter — only the IPC boundary is faked.
 *
 * Proves: seed → offerings → purchase → `pro` active → restart (fresh
 * store, same backend) → still active → restore authoritative, plus
 * cancellation and failure-code propagation. The StoreKit sheet and
 * RevenueCat servers stay on the device side (slices 6–7).
 */

import { describe, expect, it } from 'vitest';
import {
  PurchaseStore,
  hasFroglightPro,
} from '@froglight/foundation/purchases';
import {
  PURCHASES_GET_CUSTOMER_INFO_COMMAND,
  PURCHASES_GET_OFFERINGS_COMMAND,
  PURCHASES_PURCHASE_PACKAGE_COMMAND,
  PURCHASES_RESTORE_PURCHASES_COMMAND,
  createNativePurchaseTransport,
} from './purchases.js';

const FREE_CUSTOMER = {
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

const PRO_CUSTOMER = {
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

const OFFERINGS = [
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

/** Scripted stand-in for the Rust/Swift plugin with server-side memory. */
function createBackend(initial: 'free' | 'pro' = 'free') {
  let customer =
    initial === 'pro' ? structuredClone(PRO_CUSTOMER) : structuredClone(FREE_CUSTOMER);
  let purchaseCalls = 0;
  const commands: string[] = [];
  const call = async (command: string, args?: Record<string, unknown>) => {
    commands.push(command);
    if (command === PURCHASES_GET_CUSTOMER_INFO_COMMAND) {
      return structuredClone(customer);
    }
    if (command === PURCHASES_GET_OFFERINGS_COMMAND) {
      return structuredClone(OFFERINGS);
    }
    if (command === PURCHASES_PURCHASE_PACKAGE_COMMAND) {
      purchaseCalls += 1;
      const packageId = args?.packageId;
      if (packageId !== '$rc_monthly' && packageId !== '$rc_annual') {
        throw { code: 'INVALID_PACKAGE', message: 'unknown package' };
      }
      customer = structuredClone(PRO_CUSTOMER);
      return { cancelled: false, customer: structuredClone(customer) };
    }
    if (command === PURCHASES_RESTORE_PURCHASES_COMMAND) {
      return structuredClone(customer);
    }
    throw { code: 'UNKNOWN', message: `unexpected command ${command}` };
  };
  return {
    call,
    commands,
    purchases: () => purchaseCalls,
    serverCustomer: () => structuredClone(customer),
  };
}

function createStore(call: (command: string, args?: Record<string, unknown>) => Promise<unknown>) {
  return new PurchaseStore({ transport: createNativePurchaseTransport(call) });
}

describe('purchase milestone end to end', () => {
  it('free → purchase → pro → restart → still pro → restore', async () => {
    const backend = createBackend('free');
    const store = createStore(backend.call);

    // Fresh install: nothing seeded yet.
    expect(store.snapshot()).toMatchObject({ ready: false, customer: null });

    // Offering loads with localized store prices (never hardcoded in UI).
    await store.refresh();
    expect(hasFroglightPro(store.snapshot().customer)).toBe(false);
    const offerings = await store.offerings();
    expect(offerings).toHaveLength(1);
    expect(offerings[0]!.packages.map((pkg) => pkg.product.price.formatted)).toEqual([
      '$4.99',
      '$49.99',
    ]);

    // Purchase activates the entitlement immediately.
    const result = await store.purchase('default', '$rc_annual');
    expect(result.status).toBe('purchased');
    expect(backend.purchases()).toBe(1);
    expect(hasFroglightPro(store.snapshot().customer)).toBe(true);

    // Restart: a fresh store against the same backend stays pro.
    const restarted = createStore(backend.call);
    await restarted.refresh();
    expect(hasFroglightPro(restarted.snapshot().customer)).toBe(true);

    // Restore returns the server state as authoritative.
    const restored = await restarted.restore();
    expect(restored.status).toBe('purchased');
    expect(hasFroglightPro(restarted.snapshot().customer)).toBe(true);
  });

  it('cancelling the sheet is not an error and keeps the free state', async () => {
    const backend = createBackend('free');
    const store = createStore(async (command, args) => {
      if (command === PURCHASES_PURCHASE_PACKAGE_COMMAND) {
        void args;
        return { cancelled: true, customer: null };
      }
      return backend.call(command, args);
    });
    await store.refresh();
    const before = store.snapshot().customer;
    const result = await store.purchase('default', '$rc_monthly');
    expect(result).toEqual({ status: 'cancelled', customer: before });
    expect(store.snapshot().error).toBeNull();
    expect(hasFroglightPro(store.snapshot().customer)).toBe(false);
  });

  it('native failure codes propagate end to end with the code intact', async () => {
    const backend = createBackend('free');
    const store = createStore(backend.call);
    await store.refresh();
    await expect(store.purchase('default', '$rc_nope')).rejects.toMatchObject({
      code: 'INVALID_PACKAGE',
    });
    expect(store.snapshot().error?.code).toBe('INVALID_PACKAGE');
    // A failed purchase never activates the entitlement.
    expect(hasFroglightPro(store.snapshot().customer)).toBe(false);
  });

  it('delegate customer updates apply without a method call', async () => {
    const backend = createBackend('free');
    const store = createStore(backend.call);
    await store.refresh();
    expect(hasFroglightPro(store.snapshot().customer)).toBe(false);
    // The Swift PurchasesDelegate fired (e.g. renewal processed elsewhere).
    store.handleNativeEvent('customerInfo', backend.serverCustomer());
    store.handleNativeEvent('customerInfo', structuredClone(PRO_CUSTOMER));
    expect(hasFroglightPro(store.snapshot().customer)).toBe(true);
  });
});
