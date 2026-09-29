/**
 * Host environment configuration for the Firebase provider.
 *
 * SDK-free seam: this module imports nothing from `firebase/*`, so hosts
 * can resolve public config (and the local-only fallback remote) without
 * pulling the Firebase SDK into the critical startup bundle. Hosts
 * dynamic-import the full provider (`firebase-host.js`, account
 * transport, backends) only when a complete config is present.
 *
 * Only `VITE_*` names are supported: Vite exposes exactly the
 * `VITE_`-prefixed subset of the environment through `import.meta.env`,
 * so documenting any other spelling would promise configuration the app
 * can never see.
 */

import { VaultSyncError } from '@froglight/foundation';
import type { SyncRemote } from '@froglight/foundation';
import {
  resolveFirebaseProviderConfig,
  type FirebaseProviderConfig,
} from './config.js';

/**
 * Environment values hosts read for Firebase config. Every key is a
 * `VITE_`-prefixed `import.meta.env` entry; absent/incomplete values
 * select the local-only fallback instead of failing boot.
 * All values are public identifiers, never secrets.
 */
export interface FirebaseEnvValues {
  readonly VITE_FROGLIGHT_FIREBASE_API_KEY?: string;
  readonly VITE_FROGLIGHT_FIREBASE_AUTH_DOMAIN?: string;
  readonly VITE_FROGLIGHT_FIREBASE_PROJECT_ID?: string;
  readonly VITE_FROGLIGHT_FIREBASE_STORAGE_BUCKET?: string;
  readonly VITE_FROGLIGHT_FIREBASE_APP_ID?: string;
  readonly VITE_FROGLIGHT_FIREBASE_AUTH_EMULATOR_URL?: string;
  readonly VITE_FIRESTORE_EMULATOR_HOST?: string;
  readonly VITE_FIREBASE_STORAGE_EMULATOR_HOST?: string;
}

function pick(
  env: FirebaseEnvValues,
  key: keyof FirebaseEnvValues,
): string | undefined {
  const value = env[key];
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  return undefined;
}

/**
 * Resolve public Firebase web config from host environment values.
 * Returns null when absent/incomplete — the caller then runs local-only
 *  instead of failing boot.
 */
export function resolveFirebaseConfigFromEnv(
  env: FirebaseEnvValues,
): FirebaseProviderConfig | null {
  const authEmulatorUrl = pick(
    env,
    'VITE_FROGLIGHT_FIREBASE_AUTH_EMULATOR_URL',
  );
  return resolveFirebaseProviderConfig({
    apiKey: pick(env, 'VITE_FROGLIGHT_FIREBASE_API_KEY'),
    authDomain: pick(env, 'VITE_FROGLIGHT_FIREBASE_AUTH_DOMAIN'),
    projectId: pick(env, 'VITE_FROGLIGHT_FIREBASE_PROJECT_ID'),
    storageBucket: pick(env, 'VITE_FROGLIGHT_FIREBASE_STORAGE_BUCKET'),
    appId: pick(env, 'VITE_FROGLIGHT_FIREBASE_APP_ID'),
    ...(authEmulatorUrl !== undefined ? { authEmulatorUrl } : {}),
  });
}

/** Emulator hosts for manual verification (never production). */
export interface FirebaseEmulatorHosts {
  readonly firestoreHost?: string;
  readonly storageHost?: string;
}

/** Read emulator hosts from the same env surface (Vite dev only). */
export function resolveFirebaseEmulatorHosts(
  env: FirebaseEnvValues,
): FirebaseEmulatorHosts {
  const firestoreHost = env.VITE_FIRESTORE_EMULATOR_HOST;
  const storageHost = env.VITE_FIREBASE_STORAGE_EMULATOR_HOST;
  return {
    ...(typeof firestoreHost === 'string' && firestoreHost.length > 0
      ? { firestoreHost }
      : {}),
    ...(typeof storageHost === 'string' && storageHost.length > 0
      ? { storageHost }
      : {}),
  };
}

/**
 * Unconfigured sync remote: every cloud call fails with
 * `NOT_CONFIGURED` while local vaults keep working. Keeps the sync
 * service constructible (and its settings UI honest) without a Firebase
 * project — and without importing the Firebase SDK.
 */
export function createUnconfiguredSyncRemote(): SyncRemote {
  const denied = (operation: string): VaultSyncError =>
    new VaultSyncError(
      'NOT_CONFIGURED',
      `cloud sync is not configured (${operation}); local vaults keep working`,
    );
  return {
    async listVaults(): Promise<never> {
      throw denied('listVaults');
    },
    async readHead(): Promise<never> {
      throw denied('readHead');
    },
    async loadManifest(): Promise<never> {
      throw denied('loadManifest');
    },
    async hasBlob(): Promise<never> {
      throw denied('hasBlob');
    },
    async uploadBlob(): Promise<never> {
      throw denied('uploadBlob');
    },
    async downloadBlob(): Promise<never> {
      throw denied('downloadBlob');
    },
    async uploadManifest(): Promise<never> {
      throw denied('uploadManifest');
    },
    async compareAndSwapHead(): Promise<never> {
      throw denied('compareAndSwapHead');
    },
    watchHead(): () => void {
      throw denied('watchHead');
    },
  };
}
