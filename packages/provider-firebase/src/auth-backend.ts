/**
 * Firebase Auth backend seam.
 *
 * `FirebaseAuthBackend` is the only surface the account transport needs:
 * the production implementation delegates to the Firebase modular Web
 * SDK (suitable for both the PWA and the Tauri WebView — no native
 * Firebase plugin, while tests inject fakes. No Firebase type
 * crosses this module's public boundary: users are plain
 * `{ uid, email }` records.
 */

import {
  browserLocalPersistence,
  connectAuthEmulator,
  createUserWithEmailAndPassword,
  getIdTokenResult,
  inMemoryPersistence,
  indexedDBLocalPersistence,
  initializeAuth,
  getAuth,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut as firebaseSignOut,
  type Auth,
  type Persistence,
} from 'firebase/auth';
import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import type { FirebaseProviderConfig } from './config.js';

/** Plain provider-neutral user record. `uid` is the Firebase Auth UID. */
export interface FirebaseBackendUser {
  readonly uid: string;
  readonly email: string | null;
}

/** Minimal Auth surface the transport consumes (real SDK or fake). */
export interface FirebaseAuthBackend {
  currentUser(): FirebaseBackendUser | null;
  createUser(email: string, password: string): Promise<FirebaseBackendUser>;
  signIn(email: string, password: string): Promise<FirebaseBackendUser>;
  signOut(): Promise<void>;
  getToken(
    force: boolean,
  ): Promise<{
    token: string | null;
    expiresAt: string | null;
    entitlements: readonly string[];
  }>;
  onAuthChange(
    listener: (user: FirebaseBackendUser | null) => void,
  ): () => void;
}

/**
 * Trusted server entitlements from ID-token custom claims.
 * The RevenueCat Firebase Extension maintains
 * `revenueCatEntitlements: ["pro", ...]`; anything malformed degrades to
 * empty (Free) rather than failing the refresh.
 */
export function parseServerEntitlements(claims: unknown): readonly string[] {
  if (typeof claims !== 'object' || claims === null) return [];
  const record = claims as Record<string, unknown>;
  const raw = record.revenueCatEntitlements;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is string => typeof entry === 'string' && entry.length > 0,
  );
}

function toBackendUser(uid: string, email: string | null): FirebaseBackendUser {
  return { uid, email };
}

function readBackendUser(value: {
  readonly uid: string;
  readonly email: string | null;
}): FirebaseBackendUser | null {
  if (typeof value.uid !== 'string' || value.uid.length === 0) return null;
  return toBackendUser(value.uid, value.email ?? null);
}

/**
 * Persistence chain for `initializeAuth`: IndexedDB first (durable
 * restart recovery in the PWA and the Tauri WebView), then
 * localStorage-backed, then memory-only so private-mode hosts still boot
 * (signed-out) instead of failing initialization.
 */
export const FIREBASE_AUTH_PERSISTENCE: readonly Persistence[] = [
  indexedDBLocalPersistence,
  browserLocalPersistence,
  inMemoryPersistence,
];

function appKey(config: FirebaseProviderConfig): string {
  return `${config.projectId}::${config.apiKey}`;
}

const appCache = new Map<string, FirebaseApp>();

/** One `FirebaseApp` per config; repeated host construction reuses it. */
export function getFirebaseApp(config: FirebaseProviderConfig): FirebaseApp {
  const key = appKey(config);
  const cached = appCache.get(key);
  if (cached !== undefined) return cached;
  const existing = getApps();
  if (existing.length > 0) {
    // Single-project hosts reuse the default app; multi-project hosts
    // fall through to a named app below.
    const match = existing.find(
      (app) => app.options.projectId === config.projectId,
    );
    if (match !== undefined) {
      appCache.set(key, match);
      return match;
    }
  }
  const options = {
    apiKey: config.apiKey,
    authDomain: config.authDomain,
    projectId: config.projectId,
    storageBucket: config.storageBucket,
    appId: config.appId,
  };
  const app =
    existing.length === 0
      ? initializeApp(options)
      : initializeApp(options, key);
  appCache.set(key, app);
  return app;
}

/**
 * One `Auth` per app. `initializeAuth` (explicit persistence chain) may
 * only run once per app; later callers receive the existing instance.
 * `getApp` is used by tests only to reset singleton state.
 */
export function getFirebaseAuth(
  app: FirebaseApp,
  options: {
    readonly persistence?: readonly Persistence[];
    readonly authEmulatorUrl?: string;
  } = {},
): Auth {
  const persistence = [...(options.persistence ?? FIREBASE_AUTH_PERSISTENCE)];
  try {
    const auth = initializeAuth(app, { persistence });
    if (options.authEmulatorUrl !== undefined) {
      connectAuthEmulator(auth, options.authEmulatorUrl);
    }
    return auth;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      (error as Record<string, unknown>).code === 'auth/already-initialized'
    ) {
      return getAuth(app);
    }
    throw error;
  }
}

/** Test-only reset for the module-level app cache. */
export function resetFirebaseAppCacheForTests(): void {
  appCache.clear();
}

export interface SdkFirebaseAuthBackendOptions {
  readonly auth: Auth;
}

/** Production backend: thin delegation to the Firebase Web SDK. */
export function createSdkFirebaseAuthBackend(
  options: SdkFirebaseAuthBackendOptions,
): FirebaseAuthBackend {
  const { auth } = options;
  return {
    currentUser(): FirebaseBackendUser | null {
      const user = auth.currentUser;
      if (user === null) return null;
      return readBackendUser(user);
    },
    async createUser(
      email: string,
      password: string,
    ): Promise<FirebaseBackendUser> {
      const credential = await createUserWithEmailAndPassword(
        auth,
        email,
        password,
      );
      const user = readBackendUser(credential.user);
      if (user === null) throw new Error('Firebase returned a malformed user');
      return user;
    },
    async signIn(
      email: string,
      password: string,
    ): Promise<FirebaseBackendUser> {
      const credential = await signInWithEmailAndPassword(
        auth,
        email,
        password,
      );
      const user = readBackendUser(credential.user);
      if (user === null) throw new Error('Firebase returned a malformed user');
      return user;
    },
    async signOut(): Promise<void> {
      await firebaseSignOut(auth);
    },
    async getToken(
      force: boolean,
    ): Promise<{
      token: string | null;
      expiresAt: string | null;
      entitlements: readonly string[];
    }> {
      const user = auth.currentUser;
      if (user === null) return { token: null, expiresAt: null, entitlements: [] };
      const result = await getIdTokenResult(user, force);
      let expiresAt: string | null = null;
      try {
        const parsed = new Date(result.expirationTime);
        if (!Number.isNaN(parsed.getTime())) expiresAt = parsed.toISOString();
      } catch {
        expiresAt = null;
      }
      return {
        token: result.token,
        expiresAt,
        entitlements: parseServerEntitlements(result.claims),
      };
    },
    onAuthChange(
      listener: (user: FirebaseBackendUser | null) => void,
    ): () => void {
      return onAuthStateChanged(auth, (user) => {
        if (user === null) {
          listener(null);
          return;
        }
        const mapped = readBackendUser(user);
        // A malformed SDK report must never break account state.
        if (mapped === null) return;
        listener(mapped);
      });
    },
  };
}
