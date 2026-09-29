/**
 * Firebase account transport.
 *
 * Deterministic coverage over the `AccountTransport` contract with a fake
 * backend standing in for the Firebase SDK (no network, no emulator, no
 * secrets in CI):
 *
 * ```text
 * signup → UID identity (never email)
 * login / logout lifecycle
 * restart recovers the persisted user without touching local vaults
 * provider failures surface as stable Froglight error codes
 * null config selects the unconfigured fallback
 * token refresh returns the opaque provider token state
 * ```
 */

import { describe, expect, it } from 'vitest';
import {
  AccountStore,
  unconfiguredAccountTransport,
} from '@froglight/foundation/account';
import { createMemoryVault, workspacePath } from '@froglight/foundation';
import { createFirebaseAccountTransport } from './account.js';
import { parseServerEntitlements } from './auth-backend.js';
import type {
  FirebaseAuthBackend,
  FirebaseBackendUser,
} from './auth-backend.js';

interface FakeFirebaseDevice {
  user: FirebaseBackendUser | null;
  listeners: Set<(user: FirebaseBackendUser | null) => void>;
  calls: string[];
  failures: Map<string, unknown>;
}

function createFakeDevice(): FakeFirebaseDevice {
  return { user: null, listeners: new Set(), calls: [], failures: new Map() };
}

function createFakeBackend(device: FakeFirebaseDevice): FirebaseAuthBackend {
  const maybeFail = (name: string): void => {
    device.calls.push(name);
    const failure = device.failures.get(name);
    if (failure !== undefined) throw failure;
  };
  const announce = (user: FirebaseBackendUser | null): void => {
    for (const listener of [...device.listeners]) {
      listener(user === null ? null : { ...user });
    }
  };
  return {
    currentUser(): FirebaseBackendUser | null {
      device.calls.push('currentUser');
      return device.user === null ? null : { ...device.user };
    },
    async createUser(email: string): Promise<FirebaseBackendUser> {
      maybeFail('createUser');
      const created: FirebaseBackendUser = { uid: 'firebase-uid-1', email };
      device.user = created;
      announce(created);
      return { ...created };
    },
    async signIn(email: string): Promise<FirebaseBackendUser> {
      maybeFail('signIn');
      if (device.user !== null && device.user.email === email) {
        return { ...device.user };
      }
      const signedIn: FirebaseBackendUser = { uid: 'firebase-uid-1', email };
      device.user = signedIn;
      announce(signedIn);
      return { ...signedIn };
    },
    async signOut(): Promise<void> {
      maybeFail('signOut');
      device.user = null;
      announce(null);
    },
    async getToken(): Promise<{
      token: string | null;
      expiresAt: string | null;
      entitlements: readonly string[];
    }> {
      maybeFail('getToken');
      if (device.user === null)
        return { token: null, expiresAt: null, entitlements: [] };
      return {
        token: 'firebase-id-token',
        expiresAt: '2026-09-10T00:00:00.000Z',
        entitlements: [],
      };
    },
    onAuthChange(listener): () => void {
      device.listeners.add(listener);
      return () => {
        device.listeners.delete(listener);
      };
    },
  };
}

const TEST_CONFIG = {
  apiKey: 'public-key',
  authDomain: 'froglight-dev.firebaseapp.com',
  projectId: 'froglight-dev',
  storageBucket: 'froglight-dev.appspot.com',
  appId: '1:123:web:abc',
};

describe('firebase account transport', () => {
  it('signs up with the UID as the stable identity, never email', async () => {
    const device = createFakeDevice();
    const transport = createFirebaseAccountTransport({
      config: TEST_CONFIG,
      backend: createFakeBackend(device),
    });
    const store = new AccountStore({ transport });
    const user = await store.createAccount('ada@example.com', 'secret12');
    expect(user.id).toBe('firebase-uid-1');
    expect(user.email).toBe('ada@example.com');
    expect(store.snapshot().user).toEqual(user);
    store.dispose();
  });

  it('recovers the persisted user after restart', async () => {
    const device = createFakeDevice();
    const first = new AccountStore({
      transport: createFirebaseAccountTransport({
        config: TEST_CONFIG,
        backend: createFakeBackend(device),
      }),
    });
    await first.signIn('ada@example.com', 'secret12');
    first.dispose();
    // A new transport + store over the same device backend is a restart:
    // the SDK-owned persisted session recovers without credentials.
    const second = new AccountStore({
      transport: createFirebaseAccountTransport({
        config: TEST_CONFIG,
        backend: createFakeBackend(device),
      }),
    });
    await second.restore();
    expect(second.snapshot()).toMatchObject({
      ready: true,
      user: { id: 'firebase-uid-1', email: 'ada@example.com' },
    });
    second.dispose();
  });

  it('recovers signed-out after restart without errors', async () => {
    const device = createFakeDevice();
    const store = new AccountStore({
      transport: createFirebaseAccountTransport({
        config: TEST_CONFIG,
        backend: createFakeBackend(device),
      }),
    });
    await store.restore();
    expect(store.snapshot()).toMatchObject({ ready: true, user: null });
    store.dispose();
  });

  it('leaves local vault capability unaffected by auth lifecycle', async () => {
    const device = createFakeDevice();
    const store = new AccountStore({
      transport: createFirebaseAccountTransport({
        config: TEST_CONFIG,
        backend: createFakeBackend(device),
      }),
    });
    const { vault } = createMemoryVault();
    await vault.write(
      workspacePath('local.md'),
      new TextEncoder().encode('local first'),
    );
    await store.signIn('ada@example.com', 'secret12');
    await store.signOut();
    // Canonical local content survives the full auth lifecycle untouched.
    const read = await vault.read(workspacePath('local.md'));
    expect(new TextDecoder().decode(read)).toBe('local first');
    expect(store.snapshot().user).toBeNull();
    store.dispose();
  });

  it('fans provider auth changes out to the store', async () => {
    const device = createFakeDevice();
    const store = new AccountStore({
      transport: createFirebaseAccountTransport({
        config: TEST_CONFIG,
        backend: createFakeBackend(device),
      }),
    });
    await store.restore();
    expect(store.snapshot().user).toBeNull();
    device.user = { uid: 'firebase-uid-9', email: 'grace@example.com' };
    for (const listener of [...device.listeners]) {
      listener({ uid: 'firebase-uid-9', email: 'grace@example.com' });
    }
    expect(store.snapshot().user).toEqual({
      id: 'firebase-uid-9',
      email: 'grace@example.com',
    });
    store.dispose();
  });

  it('refreshes the opaque ID token without leaking SDK types', async () => {
    const device = createFakeDevice();
    const store = new AccountStore({
      transport: createFirebaseAccountTransport({
        config: TEST_CONFIG,
        backend: createFakeBackend(device),
      }),
    });
    await store.signIn('ada@example.com', 'secret12');
    await expect(store.refreshToken()).resolves.toEqual({
      token: 'firebase-id-token',
      expiresAt: '2026-09-10T00:00:00.000Z',
      entitlements: [],
    });
    await store.signOut();
    // Signed out there is no bearer token — nulls, not an exception.
    await expect(store.refreshToken()).resolves.toEqual({
      token: null,
      expiresAt: null,
      entitlements: [],
    });
    store.dispose();
  });

  it('normalizes provider failures into stable codes', async () => {    const device = createFakeDevice();
    device.failures.set('createUser', {
      code: 'auth/email-already-in-use',
      message: 'taken',
    });
    device.failures.set('signIn', {
      code: 'auth/network-request-failed',
      message: 'offline',
    });
    const store = new AccountStore({
      transport: createFirebaseAccountTransport({
        config: TEST_CONFIG,
        backend: createFakeBackend(device),
      }),
    });
    await expect(
      store.createAccount('ada@example.com', 'secret12'),
    ).rejects.toMatchObject({ code: 'EMAIL_IN_USE' });
    await expect(
      store.signIn('ada@example.com', 'secret12'),
    ).rejects.toMatchObject({
      code: 'NETWORK',
    });
    store.dispose();
  });

  it('selects the unconfigured fallback for a null config', async () => {
    const transport = createFirebaseAccountTransport({ config: null });
    expect(transport).toBe(unconfiguredAccountTransport);
    const store = new AccountStore({ transport });
    await expect(store.restore()).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });
    // Local use keeps working: the failure is scoped to account state.
    expect(store.snapshot().user).toBeNull();
    store.dispose();
  });

  it('passes server entitlements from the backend token through', async () => {
    const device = createFakeDevice();
    const backend = createFakeBackend(device);
    const transport = createFirebaseAccountTransport({
      config: TEST_CONFIG,
      backend: {
        ...backend,
        async getToken() {
          return {
            token: 'firebase-id-token',
            expiresAt: null,
            entitlements: ['pro'],
          };
        },
      },
    });
    const store = new AccountStore({ transport });
    await store.signIn('ada@example.com', 'secret12');
    await expect(store.refreshToken(true)).resolves.toMatchObject({
      entitlements: ['pro'],
    });
    store.dispose();
  });
});

describe('parseServerEntitlements', () => {
  it('reads the RevenueCat custom claim as a string list', () => {
    expect(
      parseServerEntitlements({ revenueCatEntitlements: ['pro'] }),
    ).toEqual(['pro']);
    expect(
      parseServerEntitlements({ revenueCatEntitlements: ['pro', 'plus'] }),
    ).toEqual(['pro', 'plus']);
  });

  it('degrades malformed claims to empty (Free), never throws', () => {
    expect(parseServerEntitlements(null)).toEqual([]);
    expect(parseServerEntitlements(undefined)).toEqual([]);
    expect(parseServerEntitlements({})).toEqual([]);
    expect(parseServerEntitlements({ revenueCatEntitlements: 'pro' })).toEqual(
      [],
    );
    expect(parseServerEntitlements({ revenueCatEntitlements: [42] })).toEqual(
      [],
    );
    expect(
      parseServerEntitlements({ revenueCatEntitlements: ['pro', ''] }),
    ).toEqual(['pro']);
  });
});
