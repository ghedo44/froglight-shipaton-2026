/**
 * Account capability conformance.
 *
 * Host- and framework-free: platform-neutral identity, error
 * normalization, sign in/out lifecycle, restart recovery, and the runtime
 * lifecycle invariant. No Firebase, Firestore, or Storage types appear
 * here — fakes stand in for every provider.
 */

import { describe, expect, it } from 'vitest';
import { Runtime, definePlugin } from '@froglight/runtime';
import { accountToken } from '../tokens.js';
import type {
  AccountTokenState,
  AccountTransport,
  AccountUser,
} from './contract.js';
import {
  AccountError,
  isAccountError,
  normalizeAccountError,
} from './errors.js';
import { AccountStore } from './store.js';
import { createAccountHost } from './plugin.js';

const ALICE: AccountUser = { id: 'uid-alice-123', email: 'alice@example.com' };
const BOB: AccountUser = { id: 'uid-bob-456', email: 'bob@example.com' };

interface FakeAccountBackend {
  user: AccountUser | null;
  listeners: Set<(user: AccountUser | null) => void>;
  calls: string[];
}

function fakeTransport(
  backend?: FakeAccountBackend,
  overrides: Partial<AccountTransport> = {},
): AccountTransport & { backend: FakeAccountBackend; calls: string[] } {
  const state: FakeAccountBackend = backend ?? {
    user: null,
    listeners: new Set(),
    calls: [],
  };
  const transport: AccountTransport & {
    backend: FakeAccountBackend;
    calls: string[];
  } = {
    backend: state,
    calls: state.calls,
    async currentUser() {
      state.calls.push('currentUser');
      return state.user === null ? null : { ...state.user };
    },
    async createAccount(email: string) {
      state.calls.push(`createAccount:${email}`);
      const created: AccountUser = { id: 'uid-alice-123', email };
      state.user = created;
      for (const listener of [...state.listeners]) listener({ ...created });
      return { ...created };
    },
    async signIn(email: string) {
      state.calls.push(`signIn:${email}`);
      if (state.user !== null && state.user.email === email) {
        return { ...state.user };
      }
      const signedIn: AccountUser = { id: 'uid-alice-123', email };
      state.user = signedIn;
      for (const listener of [...state.listeners]) listener({ ...signedIn });
      return { ...signedIn };
    },
    async signOut() {
      state.calls.push('signOut');
      state.user = null;
      for (const listener of [...state.listeners]) listener(null);
    },
    async refreshToken(): Promise<AccountTokenState> {
      state.calls.push('refreshToken');
      return { token: 'opaque-token', expiresAt: null, entitlements: [] };
    },
    onAuthChange(listener) {
      state.listeners.add(listener);
      return () => {
        state.listeners.delete(listener);
      };
    },
    ...overrides,
  };
  return transport;
}

describe('account errors', () => {
  it('normalizes provider-shaped failures to stable codes', () => {
    const normalized = normalizeAccountError({
      code: 'EMAIL_IN_USE',
      message: 'taken',
    });
    expect(normalized).toBeInstanceOf(AccountError);
    expect(normalized.code).toBe('EMAIL_IN_USE');
    expect(isAccountError(normalized)).toBe(true);
  });

  it('maps unknown codes and values to UNKNOWN without throwing', () => {
    expect(normalizeAccountError({ code: 'FIREBASE_FUTURE' }).code).toBe(
      'UNKNOWN',
    );
    expect(normalizeAccountError(new Error('boom')).code).toBe('UNKNOWN');
    expect(normalizeAccountError('boom').code).toBe('UNKNOWN');
    expect(normalizeAccountError(null).code).toBe('UNKNOWN');
  });

  it('passes AccountError through unchanged', () => {
    const original = new AccountError('NETWORK', 'offline');
    expect(normalizeAccountError(original)).toBe(original);
  });
});

describe('account store', () => {
  it('starts unready and signed out', () => {
    const store = new AccountStore({ transport: fakeTransport() });
    expect(store.snapshot()).toMatchObject({
      ready: false,
      loading: false,
      user: null,
      error: null,
    });
    store.dispose();
  });

  it('restores a signed-out session without touching vault capability', async () => {
    const store = new AccountStore({ transport: fakeTransport() });
    await store.restore();
    expect(store.snapshot()).toMatchObject({ ready: true, user: null });
    store.dispose();
  });

  it('creates an account and reports the UID identity (never email)', async () => {
    const store = new AccountStore({ transport: fakeTransport() });
    const seen: boolean[] = [];
    const dispose = store.subscribe(() => seen.push(store.snapshot().loading));
    const user = await store.createAccount('alice@example.com', 'secret12');
    expect(user.id).toBe('uid-alice-123');
    expect(user.email).toBe('alice@example.com');
    // Identity is the UID: email is credential-only, never the id.
    expect(user.id).not.toContain('@');
    expect(store.snapshot().user).toEqual(user);
    expect(store.snapshot().error).toBeNull();
    // begin(true) … end(false); the fake provider also pushes an
    // `onAuthChange` report mid-operation, so an extra loading-true
    // emission between them is valid.
    expect(seen[0]).toBe(true);
    expect(seen[seen.length - 1]).toBe(false);
    expect(seen.every((loading) => loading === true)).toBe(false);
    dispose();
    store.dispose();
  });

  it('signs in, signs out, and clears only the session identity', async () => {
    const backend: FakeAccountBackend = {
      user: { ...ALICE },
      listeners: new Set(),
      calls: [],
    };
    const store = new AccountStore({ transport: fakeTransport(backend) });
    await store.restore();
    expect(store.snapshot().user).toEqual(ALICE);
    await store.signOut();
    expect(store.snapshot()).toMatchObject({ ready: true, user: null });
    expect(store.snapshot().error).toBeNull();
    // Sign-out is session teardown, not data deletion: the fake backend
    // holds no vault content and nothing here touches canonical storage.
    const signedIn = await store.signIn('alice@example.com', 'secret12');
    expect(signedIn.id).toBe('uid-alice-123');
    expect(store.snapshot().user?.id).toBe('uid-alice-123');
    store.dispose();
  });

  it('recovers the signed-in user after restart from provider persistence', async () => {
    const backend: FakeAccountBackend = {
      user: { ...BOB },
      listeners: new Set(),
      calls: [],
    };
    const first = new AccountStore({ transport: fakeTransport(backend) });
    await first.restore();
    expect(first.snapshot().user).toEqual(BOB);
    first.dispose();
    // A new store over the same provider backend is a restart: the
    // persisted session recovers without re-entering credentials.
    const second = new AccountStore({ transport: fakeTransport(backend) });
    expect(second.snapshot()).toMatchObject({ ready: false, user: null });
    await second.restore();
    expect(second.snapshot().user).toEqual(BOB);
    second.dispose();
  });

  it('applies provider auth changes as state', async () => {
    const transport = fakeTransport();
    const store = new AccountStore({ transport });
    await store.restore();
    expect(store.snapshot().user).toBeNull();
    transport.backend.user = { ...ALICE };
    for (const listener of [...transport.backend.listeners]) {
      listener({ ...ALICE });
    }
    expect(store.snapshot().user).toEqual(ALICE);
    store.dispose();
  });

  it('ignores malformed provider auth reports without breaking state', async () => {
    const transport = fakeTransport();
    const store = new AccountStore({ transport });
    await store.signIn('alice@example.com', 'secret12');
    const before = store.snapshot().user;
    for (const listener of [...transport.backend.listeners]) {
      listener({ id: '', email: 'x' } as unknown as AccountUser);
      listener('uid' as unknown as AccountUser);
    }
    expect(store.snapshot().user).toEqual(before);
    store.dispose();
  });

  it('validates credentials without touching the transport', async () => {
    const transport = fakeTransport();
    const store = new AccountStore({ transport });
    await expect(
      store.signIn('not-an-email', 'secret12'),
    ).rejects.toMatchObject({
      code: 'INVALID_EMAIL',
    });
    await expect(store.signIn('a@b.c', 'short')).rejects.toMatchObject({
      code: 'INVALID_PASSWORD',
    });
    await expect(store.createAccount('', 'secret12')).rejects.toMatchObject({
      code: 'INVALID_EMAIL',
    });
    expect(transport.calls).not.toContainEqual(
      expect.stringContaining('signIn'),
    );
    expect(transport.calls).not.toContainEqual(
      expect.stringContaining('createAccount'),
    );
    store.dispose();
  });

  it('trims email before delegating to the provider', async () => {
    const transport = fakeTransport();
    const store = new AccountStore({ transport });
    await store.signIn('  alice@example.com  ', 'secret12');
    expect(transport.calls).toContain('signIn:alice@example.com');
    store.dispose();
  });

  it('surfaces transport failures as snapshot errors and rethrows', async () => {
    const store = new AccountStore({
      transport: fakeTransport(undefined, {
        async currentUser(): Promise<AccountUser | null> {
          throw new AccountError('NETWORK', 'offline');
        },
      }),
    });
    await expect(store.restore()).rejects.toMatchObject({ code: 'NETWORK' });
    expect(store.snapshot().error?.code).toBe('NETWORK');
    store.dispose();
  });

  it('refreshes the opaque token without exposing provider types', async () => {
    const store = new AccountStore({ transport: fakeTransport() });
    const state = await store.refreshToken();
    expect(state).toEqual({
      token: 'opaque-token',
      expiresAt: null,
      entitlements: [],
    });
    const forced = await store.refreshToken(true);
    expect(forced.token).toBe('opaque-token');
    store.dispose();
  });

  it('passes trusted server entitlements through the refresh', async () => {
    const store = new AccountStore({
      transport: fakeTransport(undefined, {
        async refreshToken(): Promise<AccountTokenState> {
          return { token: 't', expiresAt: null, entitlements: ['pro'] };
        },
      }),
    });
    const state = await store.refreshToken(true);
    expect(state.entitlements).toEqual(['pro']);
    const { hasServerEntitlement } = await import('./contract.js');
    expect(hasServerEntitlement(state, 'pro')).toBe(true);
    expect(hasServerEntitlement(state, 'other')).toBe(false);
    expect(hasServerEntitlement(null, 'pro')).toBe(false);
    store.dispose();
  });

  it('rejects malformed entitlement payloads without leaking provider types', async () => {
    const store = new AccountStore({
      transport: fakeTransport(undefined, {
        async refreshToken(): Promise<AccountTokenState> {
          return {
            token: 't',
            expiresAt: null,
            entitlements: ['pro', 42] as unknown as string[],
          };
        },
      }),
    });
    await expect(store.refreshToken()).rejects.toMatchObject({
      code: 'UNKNOWN',
    });
    store.dispose();
  });

  it('unconfigured providers fail cleanly so local use keeps working', async () => {
    const store = new AccountStore();
    await expect(store.restore()).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });
    await expect(store.signIn('a@b.c', 'secret12')).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });
    await expect(store.refreshToken()).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });
    // Unconfigured is a confirmed local-only state: ready so
    // the UI renders the honest unavailable copy instead of a
    // forever-disabled form, with the error preserved for that branch.
    expect(store.snapshot().ready).toBe(true);
    expect(store.snapshot().user).toBeNull();
    expect(store.snapshot().error).toMatchObject({
      code: 'NOT_CONFIGURED',
    });
    store.dispose();
  });

  it('listener failures never break dispatch', async () => {
    const store = new AccountStore({ transport: fakeTransport() });
    store.subscribe(() => {
      throw new Error('ui listener blew up');
    });
    let second = 0;
    store.subscribe(() => {
      second += 1;
    });
    await store.restore();
    expect(second).toBeGreaterThan(0);
    store.dispose();
  });

  it('copies user snapshots defensively', async () => {
    const store = new AccountStore({ transport: fakeTransport() });
    const user = await store.signIn('alice@example.com', 'secret12');
    (user as { id: string }).id = 'mutated';
    expect(store.snapshot().user?.id).toBe('uid-alice-123');
    store.dispose();
  });
});

describe('account runtime binding', () => {
  it('provides one binding, withdraws on dispose, restores on reactivate', async () => {
    const runtime = new Runtime();
    const host = createAccountHost({ transport: fakeTransport() });
    const slot = await runtime.registerSlot({
      id: 'account',
      plugin: host.definition,
    });
    expect(slot.id).toBe('account');

    let observed = 0;
    const probe = await runtime.registerSlot({
      id: 'account-probe',
      plugin: definePlugin({
        id: 'froglight.account.probe',
        requirements: { requires: [accountToken] },
        activate: (ctx) => {
          ctx.require(accountToken);
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
    await runtime.registerSlot({ id: 'account', plugin: host.definition });
    let observedAgain = 0;
    await runtime.registerSlot({
      id: 'account-probe',
      plugin: definePlugin({
        id: 'froglight.account.probe',
        requirements: { requires: [accountToken] },
        activate: (ctx) => {
          const service = ctx.require(accountToken);
          if (service === host.service) observedAgain += 1;
        },
      }),
    });
    expect(observedAgain).toBe(1);

    await runtime.dispose();
    host.service.dispose();
  });

  it('keeps the session identity across reactivations (host-owned state)', async () => {
    const runtime = new Runtime();
    const host = createAccountHost({ transport: fakeTransport() });
    await host.service.signIn('alice@example.com', 'secret12');
    await runtime.registerSlot({ id: 'account', plugin: host.definition });
    await runtime.removeSlot('account');
    await runtime.registerSlot({ id: 'account', plugin: host.definition });
    let observed: AccountUser | null = null;
    await runtime.registerSlot({
      id: 'account-probe',
      plugin: definePlugin({
        id: 'froglight.account.probe2',
        requirements: { requires: [accountToken] },
        activate: (ctx) => {
          observed = ctx.require(accountToken).snapshot().user;
        },
      }),
    });
    expect(observed).toEqual({
      id: 'uid-alice-123',
      email: 'alice@example.com',
    });
    await runtime.dispose();
    host.service.dispose();
  });
});
