/**
 * Firebase sync host construction.
 *
 * Env resolution is pure (no `import.meta` / `process` reads here — hosts
 * pass their env surface in), the unconfigured remote keeps local-only
 * boots honest, and host construction never touches canonical vault
 * content.
 */

import { describe, expect, it } from 'vitest';
import {
  createUnconfiguredSyncRemote,
  resolveFirebaseConfigFromEnv,
  resolveFirebaseEmulatorHosts,
} from './config-env.js';

describe('resolveFirebaseConfigFromEnv', () => {
  it('resolves the documented VITE_FROGLIGHT_FIREBASE_* spellings', () => {
    expect(
      resolveFirebaseConfigFromEnv({
        VITE_FROGLIGHT_FIREBASE_API_KEY: 'key',
        VITE_FROGLIGHT_FIREBASE_AUTH_DOMAIN: 'app.firebaseapp.com',
        VITE_FROGLIGHT_FIREBASE_PROJECT_ID: 'proj',
        VITE_FROGLIGHT_FIREBASE_STORAGE_BUCKET: 'proj.appspot.com',
        VITE_FROGLIGHT_FIREBASE_APP_ID: '1:2:web:3',
      }),
    ).toEqual({
      apiKey: 'key',
      authDomain: 'app.firebaseapp.com',
      projectId: 'proj',
      storageBucket: 'proj.appspot.com',
      appId: '1:2:web:3',
    });
  });

  it('ignores unprefixed FROGLIGHT_* spellings (Vite never exposes them)', () => {
    expect(
      resolveFirebaseConfigFromEnv({
        FROGLIGHT_FIREBASE_API_KEY: 'invisible',
      } as never),
    ).toBeNull();
  });

  it('returns null when incomplete so local-only boots keep working', () => {
    expect(resolveFirebaseConfigFromEnv({})).toBeNull();
    expect(
      resolveFirebaseConfigFromEnv({
        VITE_FROGLIGHT_FIREBASE_API_KEY: 'key',
        VITE_FROGLIGHT_FIREBASE_PROJECT_ID: 'proj',
      }),
    ).toBeNull();
  });

  it('carries the dev-only auth emulator URL through', () => {
    expect(
      resolveFirebaseConfigFromEnv({
        VITE_FROGLIGHT_FIREBASE_API_KEY: 'key',
        VITE_FROGLIGHT_FIREBASE_AUTH_DOMAIN: 'app.firebaseapp.com',
        VITE_FROGLIGHT_FIREBASE_PROJECT_ID: 'proj',
        VITE_FROGLIGHT_FIREBASE_STORAGE_BUCKET: 'proj.appspot.com',
        VITE_FROGLIGHT_FIREBASE_APP_ID: '1:2:web:3',
        VITE_FROGLIGHT_FIREBASE_AUTH_EMULATOR_URL: 'http://127.0.0.1:9099',
      }),
    ).toMatchObject({ authEmulatorUrl: 'http://127.0.0.1:9099' });
  });
});

describe('resolveFirebaseEmulatorHosts', () => {
  it('passes emulator hosts through only when set', () => {
    expect(resolveFirebaseEmulatorHosts({})).toEqual({});
    expect(
      resolveFirebaseEmulatorHosts({
        VITE_FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
        VITE_FIREBASE_STORAGE_EMULATOR_HOST: '127.0.0.1:9199',
      }),
    ).toEqual({
      firestoreHost: '127.0.0.1:8080',
      storageHost: '127.0.0.1:9199',
    });
  });
});

describe('createUnconfiguredSyncRemote', () => {
  it('denies every cloud call with NOT_CONFIGURED', async () => {
    const remote = createUnconfiguredSyncRemote();
    await expect(remote.listVaults()).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });
    await expect(remote.readHead('v')).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });
    expect(() => remote.watchHead('v', () => undefined)).toThrow(
      expect.objectContaining({ code: 'NOT_CONFIGURED' }),
    );
  });
});
