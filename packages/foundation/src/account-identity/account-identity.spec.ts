/**
 * Account and purchase identity coordinator conformance.
 *
 * ```text
 * signed out → no cloud write authority (ensure throws, identify untouched)
 * sign in as uid A → purchases.identify(A) → customer A → refresh
 * sign out → clearIdentity BEFORE Firebase signOut, vaults untouched
 * sign in as uid B → RevenueCat becomes B, no A state leaks
 * ```
 *
 * Fakes stand in for Firebase Auth and the RevenueCat native provider;
 * no network, no emulator, no secrets.
 */

import { describe, expect, it, vi } from 'vitest';
import { Runtime, definePlugin } from '@froglight/runtime';
import {
  accountIdentityToken,
  accountToken,
  purchasesToken,
} from '../tokens.js';
import type { AccountTransport, AccountUser } from '../account/contract.js';
import { AccountStore, createAccountHost } from '../account/index.js';
import type {
  PurchaseCustomerState,
  PurchaseTransport,
} from '../purchases/contract.js';
import { PurchaseStore, createPurchaseHost } from '../purchases/index.js';
import { createMemoryVault } from '../vault/memory.js';
import { workspacePath } from '../paths.js';
import { AccountIdentityCoordinator } from './coordinator.js';
import { createAccountIdentityHost } from './plugin.js';

function testCustomer(appUserId: string): PurchaseCustomerState {
  return {
    appUserId,
    activeEntitlementIds: [],
    entitlements: {},
  };
}

interface AccountFake {
  transport: AccountTransport;
  calls: string[];
  backendUser: AccountUser | null;
  listeners: Set<(user: AccountUser | null) => void>;
  announce(user: AccountUser | null): void;
}

function fakeAccount(order: string[]): AccountFake {
  const calls: string[] = [];
  const listeners = new Set<(user: AccountUser | null) => void>();
  const fake: AccountFake = {
    calls,
    backendUser: null,
    listeners,
    announce(user) {
      fake.backendUser = user === null ? null : { ...user };
      for (const listener of [...listeners]) {
        listener(user === null ? null : { ...user });
      }
    },
    transport: {
      async currentUser() {
        calls.push('currentUser');
        return fake.backendUser === null ? null : { ...fake.backendUser };
      },
      async createAccount(email: string) {
        calls.push(`createAccount:${email}`);
        const created: AccountUser = { id: 'firebase-uid-a', email };
        fake.announce(created);
        return { ...created };
      },
      async signIn(email: string) {
        calls.push(`signIn:${email}`);
        order.push('account:signIn');
        const signedIn: AccountUser =
          fake.backendUser !== null && fake.backendUser.email === email
            ? { ...fake.backendUser }
            : { id: 'firebase-uid-a', email };
        fake.announce(signedIn);
        return { ...signedIn };
      },
      async signOut() {
        calls.push('signOut');
        order.push('account:firebaseSignOut');
        fake.announce(null);
      },
      async refreshToken() {
        calls.push('refreshToken');
        return { token: 'token', expiresAt: null, entitlements: [] };
      },
      onAuthChange(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  };
  return fake;
}

interface PurchaseFake {
  transport: PurchaseTransport;
  calls: string[];
}

function fakePurchases(order: string[]): PurchaseFake {
  const calls: string[] = [];
  let uid = 'anon-test-user';
  const snapshot = (): PurchaseCustomerState => testCustomer(uid);
  return {
    calls,
    transport: {
      async getCustomerInfo() {
        calls.push('getCustomerInfo');
        return snapshot();
      },
      async getOfferings() {
        calls.push('getOfferings');
        return [];
      },
      async purchasePackage(offeringId, packageId) {
        calls.push(`purchasePackage:${offeringId}:${packageId}:${uid}`);
        order.push(`purchases:purchase:${uid}`);
        return { cancelled: false, customer: snapshot() };
      },
      async restorePurchases() {
        calls.push('restorePurchases');
        return snapshot();
      },
      async logIn(appUserId) {
        calls.push(`logIn:${appUserId}`);
        order.push(`purchases:identify:${appUserId}`);
        uid = appUserId;
        return snapshot();
      },
      async logOut() {
        calls.push('logOut');
        order.push('purchases:clearIdentity');
        uid = 'anon-after-logout';
        return snapshot();
      },
    },
  };
}

function setup(order: string[] = []) {
  const accountFake = fakeAccount(order);
  const purchaseFake = fakePurchases(order);
  const account = new AccountStore({ transport: accountFake.transport });
  const purchases = new PurchaseStore({ transport: purchaseFake.transport });
  const coordinator = new AccountIdentityCoordinator();
  const detach = coordinator.attach({ account, purchases });
  return { account, purchases, coordinator, detach, accountFake, purchaseFake };
}

describe('account ↔ purchase identity coordinator', () => {
  it('binds the Firebase UID on sign-in: identify(uid) then refresh', async () => {
    const { account, purchases, coordinator, detach } = setup();
    await account.signIn('ada@example.com', 'secret12');
    await vi.waitFor(() => {
      expect(coordinator.snapshot().identifiedUid).toBe('firebase-uid-a');
    });
    expect(purchases.snapshot().customer?.appUserId).toBe('firebase-uid-a');
    detach();
    account.dispose();
  });

  it('proves identify-before-refresh ordering on the transport log', async () => {
    const { account, coordinator, detach, purchaseFake } = setup();
    await account.signIn('ada@example.com', 'secret12');
    await coordinator.ensureAccountIdentity();
    const logInIndex = purchaseFake.calls.findIndex((call) =>
      call.startsWith('logIn:'),
    );
    const refreshIndex = purchaseFake.calls.findIndex(
      (call) => call === 'getCustomerInfo',
    );
    expect(logInIndex).toBeGreaterThanOrEqual(0);
    expect(refreshIndex).toBeGreaterThan(logInIndex);
    detach();
    account.dispose();
  });

  it('refuses account-bound work while signed out without touching identity', async () => {
    const { purchases, coordinator, detach, purchaseFake } = setup();
    await expect(coordinator.ensureAccountIdentity()).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    expect(purchaseFake.calls).not.toContainEqual(
      expect.stringContaining('logIn'),
    );
    expect(purchases.snapshot().customer).toBeNull();
    detach();
  });

  it('re-binds a stale purchase identity before account-bound purchase', async () => {
    const order: string[] = [];
    const { account, purchases, coordinator, detach } = setup(order);
    await account.signIn('ada@example.com', 'secret12');
    await coordinator.ensureAccountIdentity();
    // Simulate a stale provider (restart lost the anonymous→UID bind).
    purchases.handleNativeEvent('customerInfo', testCustomer('anon-test-user'));
    await purchases.purchase('default', '$rc_annual');
    // ensureAccountIdentity first repairs the binding…
    await coordinator.ensureAccountIdentity();
    await purchases.purchase('default', '$rc_annual');
    const purchaseCalls = order.filter((entry) =>
      entry.startsWith('purchases:purchase:'),
    );
    expect(purchaseCalls.at(-1)).toBe('purchases:purchase:firebase-uid-a');
    // …and never under the unrelated anonymous identity after repair.
    const identifyIndex = order.findIndex(
      (entry) => entry === 'purchases:identify:firebase-uid-a',
    );
    let lastPurchaseIndex = -1;
    for (let i = order.length - 1; i >= 0; i -= 1) {
      if (order[i]!.startsWith('purchases:purchase:')) {
        lastPurchaseIndex = i;
        break;
      }
    }
    expect(identifyIndex).toBeGreaterThanOrEqual(0);
    expect(identifyIndex).toBeLessThan(lastPurchaseIndex);
    detach();
    account.dispose();
  });

  it('signs out in order: hook → clearIdentity → Firebase signOut, vaults intact', async () => {
    const order: string[] = [];
    order.push('begin');
    const hook = vi.fn(async () => {
      order.push('hook:stopSync');
    });
    const accountFake = fakeAccount(order);
    const purchaseFake = fakePurchases(order);
    const account = new AccountStore({ transport: accountFake.transport });
    const purchases = new PurchaseStore({ transport: purchaseFake.transport });
    const coordinator = new AccountIdentityCoordinator({
      onBeforeSignOut: hook,
    });
    const detach = coordinator.attach({ account, purchases });
    const { vault } = createMemoryVault();
    await vault.write(
      workspacePath('local.md'),
      new TextEncoder().encode('keep'),
    );

    await account.signIn('ada@example.com', 'secret12');
    await coordinator.ensureAccountIdentity();
    order.length = 0;
    await coordinator.signOut();

    expect(hook).toHaveBeenCalledTimes(1);
    expect(order).toEqual([
      'hook:stopSync',
      'purchases:clearIdentity',
      'account:firebaseSignOut',
    ]);
    expect(account.snapshot().user).toBeNull();
    expect(purchases.snapshot().customer?.appUserId).toBe('anon-after-logout');
    expect(coordinator.snapshot().identifiedUid).toBeNull();
    const kept = await vault.read(workspacePath('local.md'));
    expect(new TextDecoder().decode(kept)).toBe('keep');
    detach();
    account.dispose();
  });

  it('replaces identity A → B with no state leaking across users', async () => {
    const { account, purchases, coordinator, detach, accountFake } = setup();
    await account.signIn('a@example.com', 'secret12');
    await coordinator.ensureAccountIdentity();
    expect(purchases.snapshot().customer?.appUserId).toBe('firebase-uid-a');

    accountFake.backendUser = { id: 'firebase-uid-b', email: 'b@example.com' };
    accountFake.announce({ id: 'firebase-uid-b', email: 'b@example.com' });
    await vi.waitFor(() => {
      expect(coordinator.snapshot().identifiedUid).toBe('firebase-uid-b');
    });
    expect(purchases.snapshot().customer?.appUserId).toBe('firebase-uid-b');
    expect(account.snapshot().user).toEqual({
      id: 'firebase-uid-b',
      email: 'b@example.com',
    });
    detach();
    account.dispose();
  });

  it('withdraws purchase identity on external sign-out', async () => {
    const {
      account,
      purchases,
      coordinator,
      detach,
      accountFake,
      purchaseFake,
    } = setup();
    await account.signIn('ada@example.com', 'secret12');
    await coordinator.ensureAccountIdentity();
    purchaseFake.calls.length = 0;
    accountFake.announce(null);
    await vi.waitFor(() => {
      expect(coordinator.snapshot().identifiedUid).toBeNull();
    });
    expect(purchaseFake.calls).toContain('logOut');
    expect(account.snapshot().user).toBeNull();
    expect(purchases.snapshot().customer?.appUserId).toBe('anon-after-logout');
    detach();
    account.dispose();
  });

  it('recovers a persisted session after restart and binds before purchase', async () => {
    const order: string[] = [];
    const accountFake = fakeAccount(order);
    const purchaseFake = fakePurchases(order);
    accountFake.backendUser = {
      id: 'firebase-uid-a',
      email: 'ada@example.com',
    };
    const account = new AccountStore({ transport: accountFake.transport });
    const purchases = new PurchaseStore({ transport: purchaseFake.transport });
    const coordinator = new AccountIdentityCoordinator();
    const detach = coordinator.attach({ account, purchases });
    // Restart recovery: the persisted Firebase session restores…
    await account.restore();
    // …and the coordinator binds it without waiting for another event.
    await vi.waitFor(() => {
      expect(coordinator.snapshot().identifiedUid).toBe('firebase-uid-a');
    });
    await coordinator.ensureAccountIdentity();
    expect(purchases.snapshot().customer?.appUserId).toBe('firebase-uid-a');
    detach();
    account.dispose();
  });

  it('surfaces identify failures and recovers on retry', async () => {
    const { account, coordinator, detach, purchaseFake } = setup();
    await account.signIn('ada@example.com', 'secret12');
    await coordinator.ensureAccountIdentity();
    expect(coordinator.snapshot().identifiedUid).toBe('firebase-uid-a');

    // Transport starts failing: the next bind attempt rejects…
    const failing = {
      ...purchaseFake.transport,
      async logIn(): Promise<PurchaseCustomerState> {
        throw new Error('offline');
      },
    };
    const broken = new PurchaseStore({ transport: failing });
    coordinator.detach();
    const reattach = coordinator.attach({ account, purchases: broken });
    // Force staleness so ensure must re-bind through the broken transport.
    broken.handleNativeEvent('customerInfo', testCustomer('anon-test-user'));
    await expect(coordinator.ensureAccountIdentity()).rejects.toMatchObject({
      code: 'UNKNOWN',
    });
    expect(coordinator.snapshot().error?.code).toBe('UNKNOWN');
    reattach();
    detach();
    account.dispose();
  });
});

describe('coordinator sign-out lifecycle (the auth listener survives sign-out)', () => {
  it('automatically identifies B after a coordinated sign-out then sign-in', async () => {
    const { account, purchases, coordinator, detach, accountFake } = setup();
    accountFake.announce({ id: 'uid-a', email: 'a@example.com' });
    await vi.waitFor(() => {
      expect(coordinator.snapshot().identifiedUid).toBe('uid-a');
    });
    expect(purchases.snapshot().customer?.appUserId).toBe('uid-a');

    await coordinator.signOut();
    expect(coordinator.snapshot().identifiedUid).toBeNull();
    expect(account.snapshot().user).toBeNull();

    // A later sign-in must reconcile through the SAME listener that the
    // coordinated sign-out must never retire.
    accountFake.announce({ id: 'uid-b', email: 'b@example.com' });
    await vi.waitFor(() => {
      expect(coordinator.snapshot().identifiedUid).toBe('uid-b');
    });
    expect(purchases.snapshot().customer?.appUserId).toBe('uid-b');
    detach();
    account.dispose();
  });

  it('survives repeated sign-in/sign-out cycles', async () => {
    const { coordinator, detach, accountFake, purchaseFake } = setup();
    for (const uid of ['uid-a', 'uid-b', 'uid-c', 'uid-a']) {
      accountFake.announce({ id: uid, email: `${uid}@example.com` });
      await vi.waitFor(() => {
        expect(coordinator.snapshot().identifiedUid).toBe(uid);
      });
      await coordinator.signOut();
      expect(coordinator.snapshot().identifiedUid).toBeNull();
    }
    // One identify per sign-in, one clear per sign-out, strictly ordered.
    const identifies = purchaseFake.calls.filter((call) =>
      call.startsWith('logIn:'),
    );
    const clears = purchaseFake.calls.filter((call) => call === 'logOut');
    expect(identifies).toEqual([
      'logIn:uid-a',
      'logIn:uid-b',
      'logIn:uid-c',
      'logIn:uid-a',
    ]);
    expect(clears).toHaveLength(4);
    detach();
  });

  it('handles rapid A → B replacement right after a coordinated sign-out', async () => {
    const { coordinator, detach, accountFake } = setup();
    accountFake.announce({ id: 'uid-a', email: 'a@example.com' });
    await vi.waitFor(() => {
      expect(coordinator.snapshot().identifiedUid).toBe('uid-a');
    });
    // The teardown completes first (its trailing null event is a no-op
    // once the purchase identity is already cleared); B arrives
    // immediately afterwards and binds through the surviving listener.
    await coordinator.signOut();
    accountFake.announce({ id: 'uid-b', email: 'b@example.com' });
    await vi.waitFor(() => {
      expect(coordinator.snapshot().identifiedUid).toBe('uid-b');
    });
    detach();
  });

  it('abandons an in-flight identify when sign-out wins the race', async () => {
    const order: string[] = [];
    const accountFake = fakeAccount(order);
    const purchaseFake = fakePurchases(order);
    let releaseLogin: () => void = () => undefined;
    const loginGate = new Promise<void>((resolve) => {
      releaseLogin = resolve;
    });
    const gatedLogIn = purchaseFake.transport.logIn;
    purchaseFake.transport.logIn = async (appUserId: string) => {
      purchaseFake.calls.push(`logIn-enter:${appUserId}`);
      await loginGate;
      return gatedLogIn(appUserId);
    };
    const account = new AccountStore({ transport: accountFake.transport });
    const purchases = new PurchaseStore({ transport: purchaseFake.transport });
    const coordinator = new AccountIdentityCoordinator();
    const detach = coordinator.attach({ account, purchases });

    // A signs in; the identify parks inside the gated logIn.
    accountFake.announce({ id: 'uid-a', email: 'a@example.com' });
    await vi.waitFor(() => {
      expect(purchaseFake.calls).toContain('logIn-enter:uid-a');
    });
    // Coordinated sign-out while the identify is still in flight.
    const signedOut = coordinator.signOut();
    releaseLogin();
    await signedOut;
    expect(coordinator.snapshot().identifiedUid).toBeNull();

    // B signs in afterwards: the stale A identify must not resurrect,
    // and B binds cleanly through the surviving listener.
    accountFake.announce({ id: 'uid-b', email: 'b@example.com' });
    await vi.waitFor(() => {
      expect(coordinator.snapshot().identifiedUid).toBe('uid-b');
    });
    expect(purchases.snapshot().customer?.appUserId).toBe('uid-b');
    detach();
    account.dispose();
  });
});

describe('account identity runtime binding', () => {
  it('provides one binding, detaches on dispose, restores on reactivate', async () => {
    const runtime = new Runtime();
    const accountHost = createAccountHost({
      transport: fakeAccount([]).transport,
    });
    const purchaseHost = createPurchaseHost({
      transport: fakePurchases([]).transport,
    });
    const identityHost = createAccountIdentityHost();
    await runtime.registerSlot({
      id: 'account',
      plugin: accountHost.definition,
    });
    await runtime.registerSlot({
      id: 'purchases',
      plugin: purchaseHost.definition,
    });
    const slot = await runtime.registerSlot({
      id: 'account-identity',
      plugin: identityHost.definition,
    });
    expect(slot.id).toBe('account-identity');

    let observed = 0;
    const probe = await runtime.registerSlot({
      id: 'identity-probe',
      plugin: definePlugin({
        id: 'froglight.account-identity.probe',
        requirements: { requires: [accountIdentityToken] },
        activate: (ctx) => {
          ctx.require(accountIdentityToken);
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

    // Detach withdraws auto-binding: later sign-ins no longer identify.
    await runtime.removeSlot(slot.id);
    await accountHost.service.signIn('ada@example.com', 'secret12');
    await vi.waitFor(() => {
      expect(accountHost.service.snapshot().user?.id).toBe('firebase-uid-a');
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(purchaseHost.service.snapshot().customer).toBeNull();

    await runtime.registerSlot({
      id: 'account-identity',
      plugin: identityHost.definition,
    });
    let observedAgain = 0;
    await runtime.registerSlot({
      id: 'identity-probe',
      plugin: definePlugin({
        id: 'froglight.account-identity.probe2',
        requirements: { requires: [accountIdentityToken] },
        activate: (ctx) => {
          const service = ctx.require(accountIdentityToken);
          if (service === identityHost.service) observedAgain += 1;
        },
      }),
    });
    expect(observedAgain).toBe(1);
    // Reactivation re-attaches: the still-signed-in UID binds.
    await vi.waitFor(() => {
      expect(identityHost.service.snapshot().identifiedUid).toBe(
        'firebase-uid-a',
      );
    });

    await runtime.dispose();
    accountHost.service.dispose();
    identityHost.service.detach();
  });

  it('stays dormant while purchases are unavailable and binds once they arrive', async () => {
    const runtime = new Runtime();
    const accountHost = createAccountHost({
      transport: fakeAccount([]).transport,
    });
    const identityHost = createAccountIdentityHost();
    await runtime.registerSlot({
      id: 'account',
      plugin: accountHost.definition,
    });
    await runtime.registerSlot({
      id: 'account-identity',
      plugin: identityHost.definition,
    });
    await accountHost.service.signIn('ada@example.com', 'secret12');
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(identityHost.service.snapshot().identifiedUid).toBeNull();

    const purchaseHost = createPurchaseHost({
      transport: fakePurchases([]).transport,
    });
    await runtime.registerSlot({
      id: 'purchases',
      plugin: purchaseHost.definition,
    });
    await vi.waitFor(() => {
      expect(identityHost.service.snapshot().identifiedUid).toBe(
        'firebase-uid-a',
      );
    });
    await runtime.dispose();
    accountHost.service.dispose();
    identityHost.service.detach();
  });

  it('requires both account and purchases tokens', async () => {
    const runtime = new Runtime();
    const identityHost = createAccountIdentityHost();
    await runtime.registerSlot({
      id: 'account-identity',
      plugin: identityHost.definition,
    });
    let resolved: unknown = 'unresolved';
    await runtime.registerSlot({
      id: 'identity-probe',
      plugin: definePlugin({
        id: 'froglight.account-identity.probe3',
        requirements: { requires: [accountToken, purchasesToken] },
        activate: (ctx) => {
          resolved = {
            account: ctx.require(accountToken),
            purchases: ctx.require(purchasesToken),
          };
        },
      }),
    });
    // Neither provider is registered, so the probe never activates.
    expect(resolved).toBe('unresolved');
    await runtime.dispose();
    identityHost.service.detach();
  });
});
