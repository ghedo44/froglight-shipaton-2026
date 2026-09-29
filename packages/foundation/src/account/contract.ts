/**
 * Account capability contract.
 *
 * Platform-neutral Froglight-owned identity behind `accountToken`
 * (`froglight.account`). The Firebase UID is the stable opaque Froglight
 * account identity: it doubles as the RevenueCat App User ID,
 * the Firestore owner identity, and the Storage owner identity. Email is
 * only a credential/login property and never an ownership identity.
 *
 * Host- and framework-free: no Firebase, Firestore, Storage, Tauri, DOM,
 * or React types leak into this surface. Providers translate SDK models
 * into these DTOs at the plugin boundary; shared consumers depend only on
 * `AccountService`.
 */

import type { AccountError } from './errors.js';

/** Stable opaque account identity. Always a Firebase Auth UID, never email. */
export type AccountId = string;

/** Authenticated user. `id` is the Firebase UID; email is login-only. */
export interface AccountUser {
  readonly id: AccountId;
  readonly email: string | null;
}

export interface AccountSnapshot {
  /** True after the first restore/seed (signed in or confirmed signed out). */
  readonly ready: boolean;
  readonly loading: boolean;
  readonly user: AccountUser | null;
  readonly error: AccountError | null;
}

export type AccountSnapshotListener = (snapshot: AccountSnapshot) => void;

/**
 * Opaque ID-token state. The token string itself is an uninterpreted
 * bearer credential minted by the provider (Firebase ID token for the
 * Firebase provider); Foundation never parses it. `expiresAt` is an
 * ISO-8601 timestamp or null when the provider does not report one.
 * `entitlements` carries the trusted server-issued entitlement ids read
 * from the token's custom claims (RevenueCat `revenueCatEntitlements`
 * for the Firebase provider; empty when unknown, signed out,
 * or unconfigured. Client `PurchaseService` state never appears here —
 * this is backend authorization state only.
 */
export interface AccountTokenState {
  readonly token: string | null;
  readonly expiresAt: string | null;
  readonly entitlements: readonly string[];
}

/** Trusted server entitlement check (never client purchase state). */
export function hasServerEntitlement(
  state: AccountTokenState | null,
  entitlement: string,
): boolean {
  if (state === null) return false;
  return state.entitlements.includes(entitlement);
}

/**
 * Host-provided authentication operations. Implemented by the Firebase
 * provider (later slices), fakes in tests, or an unconfigured fallback
 * that reports `NOT_CONFIGURED` so local Froglight keeps working.
 */
export interface AccountTransport {
  currentUser(): Promise<AccountUser | null>;
  createAccount(email: string, password: string): Promise<AccountUser>;
  signIn(email: string, password: string): Promise<AccountUser>;
  signOut(): Promise<void>;
  refreshToken(force?: boolean): Promise<AccountTokenState>;
  /**
   * Observe provider-side auth changes (persistence recovery, remote
   * sign-out, token refresh). Returns an unsubscribe function.
   */
  onAuthChange(listener: (user: AccountUser | null) => void): () => void;
}

/**
 * Stable account service behind `accountToken`. Framework- and host-free:
 * feed it with an `AccountTransport` from the Firebase provider, fakes in
 * tests, or the unconfigured fallback.
 */
export interface AccountService {
  snapshot(): AccountSnapshot;
  /** Subscribe to every snapshot change; returns an unregister function. */
  subscribe(listener: AccountSnapshotListener): () => void;
  /**
   * Recover the persisted session after restart. Queries the provider for
   * the current user without affecting local vault capability: signed-out
   * stays signed-out, signed-in restores the UID identity.
   */
  restore(): Promise<void>;
  createAccount(email: string, password: string): Promise<AccountUser>;
  signIn(email: string, password: string): Promise<AccountUser>;
  signOut(): Promise<void>;
  refreshToken(force?: boolean): Promise<AccountTokenState>;
}
