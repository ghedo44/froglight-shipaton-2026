/**
 * Native purchases adapter conformance.
 *
 * The adapter owns every raw Tauri detail: exact command routing, arg
 * shapes, and the plugin-event subscription. A fake invoke/listen pair
 * stands in for the native host; no real IPC runs here.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  PURCHASES_CONFIGURE_COMMAND,
  PURCHASES_CUSTOMER_EVENT,
  PURCHASES_GET_CUSTOMER_INFO_COMMAND,
  PURCHASES_GET_OFFERINGS_COMMAND,
  PURCHASES_LOG_IN_COMMAND,
  PURCHASES_LOG_OUT_COMMAND,
  PURCHASES_PLUGIN_NAME,
  PURCHASES_PURCHASE_PACKAGE_COMMAND,
  PURCHASES_RESTORE_PURCHASES_COMMAND,
  createNativePurchaseTransport,
  createNativePurchases,
  seedPurchasesFromNative,
  type NativePurchaseListen,
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
  ...FREE_CUSTOMER,
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

function fakeInvoke(impl?: (command: string, args?: Record<string, unknown>) => unknown) {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const call = async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args });
    if (impl) return impl(command, args);
    if (command === PURCHASES_GET_OFFERINGS_COMMAND) return [];
    if (command === PURCHASES_PURCHASE_PACKAGE_COMMAND) {
      return { cancelled: false, customer: PRO_CUSTOMER };
    }
    return structuredClone(FREE_CUSTOMER);
  };
  return { calls, call };
}

function fakeListen() {
  const subscriptions: Array<{
    event: string;
    handler: (payload: unknown) => void;
  }> = [];
  let unlistens = 0;
  const listen: NativePurchaseListen = (event, handler) => {
    subscriptions.push({ event, handler });
    return () => {
      unlistens += 1;
    };
  };
  return { subscriptions, listen, unlistens: () => unlistens };
}

describe('native purchase transport routing', () => {
  it('pins exact Tauri command names', () => {
    expect(PURCHASES_CONFIGURE_COMMAND).toBe(
      'plugin:froglight-purchases|configure',
    );
    expect(PURCHASES_GET_CUSTOMER_INFO_COMMAND).toBe(
      'plugin:froglight-purchases|get_customer_info',
    );
    expect(PURCHASES_GET_OFFERINGS_COMMAND).toBe(
      'plugin:froglight-purchases|get_offerings',
    );
    expect(PURCHASES_PURCHASE_PACKAGE_COMMAND).toBe(
      'plugin:froglight-purchases|purchase_package',
    );
    expect(PURCHASES_RESTORE_PURCHASES_COMMAND).toBe(
      'plugin:froglight-purchases|restore_purchases',
    );
    expect(PURCHASES_LOG_IN_COMMAND).toBe('plugin:froglight-purchases|log_in');
    expect(PURCHASES_LOG_OUT_COMMAND).toBe(
      'plugin:froglight-purchases|log_out',
    );
    expect(PURCHASES_PLUGIN_NAME).toBe('froglight-purchases');
    expect(PURCHASES_CUSTOMER_EVENT).toBe('customer-info-updated');
  });

  it('routes every operation with camelCase args', async () => {
    const { calls, call } = fakeInvoke();
    const transport = createNativePurchaseTransport(call);
    await transport.getCustomerInfo();
    await transport.getOfferings();
    await transport.purchasePackage('default', '$rc_annual');
    await transport.restorePurchases();
    await transport.logIn('froglight-account-uuid-1');
    await transport.logOut();
    expect(calls).toEqual([
      { command: PURCHASES_GET_CUSTOMER_INFO_COMMAND, args: undefined },
      { command: PURCHASES_GET_OFFERINGS_COMMAND, args: undefined },
      {
        command: PURCHASES_PURCHASE_PACKAGE_COMMAND,
        args: { offeringId: 'default', packageId: '$rc_annual' },
      },
      { command: PURCHASES_RESTORE_PURCHASES_COMMAND, args: undefined },
      {
        command: PURCHASES_LOG_IN_COMMAND,
        args: { appUserId: 'froglight-account-uuid-1' },
      },
      { command: PURCHASES_LOG_OUT_COMMAND, args: undefined },
    ]);
  });

  it('forwards raw payloads for the store to validate', async () => {
    const sentinel = { sentinel: true };
    const { call } = fakeInvoke(() => sentinel);
    const transport = createNativePurchaseTransport(call);
    // Malformed payloads pass through here; PurchaseStore rejects them.
    await expect(transport.getCustomerInfo()).resolves.toBe(sentinel);
  });
});

describe('native purchase bootstrap', () => {
  it('subscribes before seeding so load-time updates cannot race', async () => {
    const order: string[] = [];
    const countingCall = async (command: string, args?: Record<string, unknown>) => {
      order.push('invoke');
      if (command === PURCHASES_GET_OFFERINGS_COMMAND) return [];
      void args;
      return structuredClone(FREE_CUSTOMER);
    };
    const { subscriptions, listen } = fakeListen();
    const host = createNativePurchases(countingCall);
    const stop = await seedPurchasesFromNative(host.service, {
      call: countingCall,
      listen: ((event, handler) => {
        order.push('listen');
        return listen(event, handler);
      }) as NativePurchaseListen,
    });
    expect(order).toEqual(['listen', 'invoke']);
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]!.event).toBe(PURCHASES_CUSTOMER_EVENT);
    expect(host.service.snapshot().customer).toEqual(FREE_CUSTOMER);
    stop();
  });

  it('delivers plugin events into the service and ignores malformed ones', async () => {
    const { call } = fakeInvoke();
    const { subscriptions, listen } = fakeListen();
    const host = createNativePurchases(call);
    await seedPurchasesFromNative(host.service, { call, listen });
    const handler = subscriptions[0]!.handler;
    handler(structuredClone(PRO_CUSTOMER));
    expect(host.service.snapshot().customer).toEqual(PRO_CUSTOMER);
    handler(null);
    handler('pro');
    expect(host.service.snapshot().customer).toEqual(PRO_CUSTOMER);
  });

  it('survives seed failures and keeps the channel live', async () => {
    const failing = vi.fn(async () => {
      throw new Error('no backend');
    });
    const { subscriptions, listen } = fakeListen();
    const host = createNativePurchases(failing);
    const stop = await seedPurchasesFromNative(host.service, {
      call: failing,
      listen,
    });
    // Best-effort seed: boot continues, the snapshot carries the error,
    // and later delegate updates still apply.
    expect(host.service.snapshot().ready).toBe(false);
    expect(host.service.snapshot().error).not.toBeNull();
    subscriptions[0]!.handler(structuredClone(PRO_CUSTOMER));
    expect(host.service.snapshot().customer).toEqual(PRO_CUSTOMER);
    expect(typeof stop).toBe('function');
  });

  it('unsubscribes exactly its own channel', async () => {
    const { call } = fakeInvoke();
    const { listen, unlistens } = fakeListen();
    const host = createNativePurchases(call);
    const stop = await seedPurchasesFromNative(host.service, { call, listen });
    expect(unlistens()).toBe(0);
    stop();
    expect(unlistens()).toBe(1);
  });

  it('configures RevenueCat before refreshing when a public key is provided', async () => {
    const { calls, call } = fakeInvoke();
    const { listen } = fakeListen();
    const host = createNativePurchases(call);
    await seedPurchasesFromNative(host.service, {
      apiKey: 'test_abc',
      call,
      listen,
    });
    expect(calls.map((entry) => entry.command)).toEqual([
      PURCHASES_CONFIGURE_COMMAND,
      PURCHASES_GET_CUSTOMER_INFO_COMMAND,
    ]);
    expect(calls[0]).toEqual({
      command: PURCHASES_CONFIGURE_COMMAND,
      args: { apiKey: 'test_abc' },
    });
  });

  it('skips configure when the key is missing or blank', async () => {
    for (const apiKey of [undefined, '', '   '] as const) {
      const { calls, call } = fakeInvoke();
      const { listen } = fakeListen();
      const host = createNativePurchases(call);
      await seedPurchasesFromNative(host.service, {
        ...(apiKey === undefined ? {} : { apiKey }),
        call,
        listen,
      });
      expect(calls.map((entry) => entry.command)).toEqual([
        PURCHASES_GET_CUSTOMER_INFO_COMMAND,
      ]);
    }
  });

  it('trims the public key before configuring', async () => {
    const { calls, call } = fakeInvoke();
    const { listen } = fakeListen();
    const host = createNativePurchases(call);
    await seedPurchasesFromNative(host.service, {
      apiKey: '  test_abc  ',
      call,
      listen,
    });
    expect(calls[0]).toEqual({
      command: PURCHASES_CONFIGURE_COMMAND,
      args: { apiKey: 'test_abc' },
    });
  });

  it('keeps booting when configure fails', async () => {
    const call = async (command: string, args?: Record<string, unknown>) => {
      if (command === PURCHASES_CONFIGURE_COMMAND) {
        throw new Error('UNSUPPORTED');
      }
      void args;
      return structuredClone(FREE_CUSTOMER);
    };
    const { listen } = fakeListen();
    const host = createNativePurchases(call);
    await seedPurchasesFromNative(host.service, {
      apiKey: 'test_abc',
      call,
      listen,
    });
    // Best-effort configure: the refresh still seeds the store.
    expect(host.service.snapshot().customer).toEqual(FREE_CUSTOMER);
  });
});
