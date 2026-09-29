/**
 * Firebase `AccountTransport`.
 *
 * The replaceable Firebase provider behind `froglight.account`: email +
 * password signup/login, SDK-owned session persistence with restart
 * recovery, sign-out, and ID-token refresh — all normalized into
 * Froglight-owned `AccountError` codes. No Firebase type leaks past this
 * package: consumers see only foundation DTOs.
 *
 * A null config selects the unconfigured fallback so the app still boots
 * and local Froglight keeps working without a Firebase project. Ordinary
 * local saves never wait for this transport.
 */

import {
  unconfiguredAccountTransport,
  type AccountTokenState,
  type AccountTransport,
  type AccountUser,
} from '@froglight/foundation/account';
import type { FirebaseProviderConfig } from './config.js';
import {
  createSdkFirebaseAuthBackend,
  getFirebaseApp,
  getFirebaseAuth,
  type FirebaseAuthBackend,
  type FirebaseBackendUser,
} from './auth-backend.js';
import { normalizeFirebaseAuthError } from './errors.js';

function toAccountUser(user: FirebaseBackendUser): AccountUser {
  return { id: user.uid, email: user.email };
}

export interface FirebaseAccountTransportOptions {
  /** Null selects the unconfigured fallback (local-only development). */
  readonly config: FirebaseProviderConfig | null;
  /**
   * Injected backend seam. Defaults to the real Firebase Web SDK backend
   * for `config`; tests inject fakes. When `backend` is provided,
   * `config` is only used for the null check.
   */
  readonly backend?: FirebaseAuthBackend;
}

/**
 * Create the Firebase-backed account transport. With a null config this
 * returns the shared unconfigured fallback (same instance foundation
 * ships) so hosts need no branching.
 */
export function createFirebaseAccountTransport(
  options: FirebaseAccountTransportOptions,
): AccountTransport {
  const { config } = options;
  if (config === null) return unconfiguredAccountTransport;
  const backend =
    options.backend ??
    createSdkFirebaseAuthBackend({
      auth: getFirebaseAuth(getFirebaseApp(config), {
        authEmulatorUrl: config.authEmulatorUrl,
      }),
    });
  return {
    async currentUser(): Promise<AccountUser | null> {
      try {
        const user = backend.currentUser();
        return user === null ? null : toAccountUser(user);
      } catch (error) {
        throw normalizeFirebaseAuthError(error);
      }
    },
    async createAccount(email: string, password: string): Promise<AccountUser> {
      try {
        return toAccountUser(await backend.createUser(email, password));
      } catch (error) {
        throw normalizeFirebaseAuthError(error);
      }
    },
    async signIn(email: string, password: string): Promise<AccountUser> {
      try {
        return toAccountUser(await backend.signIn(email, password));
      } catch (error) {
        throw normalizeFirebaseAuthError(error);
      }
    },
    async signOut(): Promise<void> {
      try {
        await backend.signOut();
      } catch (error) {
        throw normalizeFirebaseAuthError(error);
      }
    },
    async refreshToken(force = false): Promise<AccountTokenState> {
      try {
        const state = await backend.getToken(force);
        return {
          token: state.token,
          expiresAt: state.expiresAt,
          entitlements: [...state.entitlements],
        };
      } catch (error) {
        throw normalizeFirebaseAuthError(error);
      }
    },
    onAuthChange(listener: (user: AccountUser | null) => void): () => void {
      return backend.onAuthChange((user) => {
        listener(user === null ? null : toAccountUser(user));
      });
    },
  };
}
