/**
 * Host-independent account state machine.
 *
 * Portable capability state: hosts inject an `AccountTransport` (Firebase
 * provider in later slices, fakes in tests, unconfigured fallback
 * elsewhere) and the store fans normalized DTOs out through an explicit
 * listener set. Provider-side auth changes (persistence recovery, remote
 * sign-out) arrive through the transport's `onAuthChange` subscription,
 * installed once per store.
 *
 * Identity rule: `AccountUser.id` is always the Firebase Auth
 * UID — the same value used as the RevenueCat App User ID, the Firestore
 * owner identity, and the Storage owner identity. Email is credential-
 * only and never an ownership identity.
 */

import { normalizeAccountError, AccountError } from './errors.js';
import type {
  AccountService,
  AccountSnapshot,
  AccountSnapshotListener,
  AccountTokenState,
  AccountTransport,
  AccountUser,
} from './contract.js';

function copyUser(user: AccountUser | null): AccountUser | null {
  if (user === null) return null;
  return { id: user.id, email: user.email };
}

function asUser(payload: unknown): AccountUser | null {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    Array.isArray(payload)
  ) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const id = record.id;
  if (typeof id !== 'string' || id.length === 0) return null;
  const email = record.email;
  if (email !== null && email !== undefined && typeof email !== 'string')
    return null;
  return { id, email: typeof email === 'string' ? email : null };
}

function normalizeEmail(email: string): string {
  return email.trim();
}

function validateCredentials(
  email: string,
  password: string,
): AccountError | null {
  const normalized = normalizeEmail(email);
  if (normalized.length === 0 || !normalized.includes('@')) {
    return new AccountError(
      'INVALID_EMAIL',
      'a valid email address is required',
    );
  }
  if (password.length < 6) {
    return new AccountError(
      'INVALID_PASSWORD',
      'password must be at least 6 characters',
    );
  }
  return null;
}

export interface AccountStoreOptions {
  readonly transport?: AccountTransport;
  readonly initialUser?: AccountUser | null;
}

export class AccountStore implements AccountService {
  private readonly transport: AccountTransport;
  private user: AccountUser | null;
  private ready = false;
  private pending = 0;
  private error: AccountError | null = null;
  private readonly listeners = new Set<AccountSnapshotListener>();
  private readonly unsubscribeTransport: (() => void) | null;

  constructor(options: AccountStoreOptions = {}) {
    this.transport = options.transport ?? unconfiguredAccountTransport;
    this.user =
      options.initialUser !== undefined && options.initialUser !== null
        ? { ...options.initialUser }
        : null;
    if (this.user !== null) this.ready = true;
    let unsubscribe: (() => void) | null = null;
    try {
      unsubscribe = this.transport.onAuthChange((next) => {
        const normalized = next === null ? null : asUser(next);
        // A corrupt provider report must never break account state: null
        // (signed out) applies, malformed non-null payloads are ignored.
        if (next !== null && normalized === null) return;
        this.user = normalized === null ? null : { ...normalized };
        this.ready = true;
        this.error = null;
        this.emit();
      });
    } catch {
      unsubscribe = null;
    }
    this.unsubscribeTransport = unsubscribe;
  }

  snapshot(): AccountSnapshot {
    return {
      ready: this.ready,
      loading: this.pending > 0,
      user: copyUser(this.user),
      error: this.error,
    };
  }

  subscribe(listener: AccountSnapshotListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot);
      } catch {
        // Listener failures must never break account state dispatch.
      }
    }
  }

  private begin(): void {
    this.pending += 1;
    this.emit();
  }

  private end(): void {
    this.pending = Math.max(0, this.pending - 1);
    this.emit();
  }

  private applyUser(user: AccountUser): void {
    const normalized = asUser(user);
    if (normalized === null) {
      throw new AccountError(
        'UNKNOWN',
        'provider returned a malformed account user',
      );
    }
    this.user = { ...normalized };
    this.ready = true;
    this.error = null;
  }

  async restore(): Promise<void> {
    this.begin();
    try {
      const raw = await this.transport.currentUser();
      const normalized = raw === null ? null : asUser(raw);
      if (raw !== null && normalized === null) {
        throw new AccountError(
          'UNKNOWN',
          'provider returned a malformed account user',
        );
      }
      this.user = normalized === null ? null : { ...normalized };
      this.ready = true;
      this.error = null;
    } catch (error) {
      const normalized = normalizeAccountError(error);
      // Unconfigured hosts are a confirmed local-only state,
      // not a pending restore: mark ready so the UI renders the honest
      // unavailable copy instead of a forever-disabled form. Other
      // failures keep ready=false so callers know the seed did not settle.
      if (normalized.code === 'NOT_CONFIGURED') {
        this.user = null;
        this.ready = true;
      }
      this.error = normalized;
      throw this.error;
    } finally {
      this.end();
    }
  }

  async createAccount(email: string, password: string): Promise<AccountUser> {
    const invalid = validateCredentials(email, password);
    if (invalid !== null) throw invalid;
    this.begin();
    try {
      const raw = await this.transport.createAccount(
        normalizeEmail(email),
        password,
      );
      const normalized = asUser(raw);
      if (normalized === null) {
        throw new AccountError(
          'UNKNOWN',
          'provider returned a malformed account user',
        );
      }
      this.applyUser(normalized);
      return { ...normalized };
    } catch (error) {
      this.error = normalizeAccountError(error);
      throw this.error;
    } finally {
      this.end();
    }
  }

  async signIn(email: string, password: string): Promise<AccountUser> {
    const invalid = validateCredentials(email, password);
    if (invalid !== null) throw invalid;
    this.begin();
    try {
      const raw = await this.transport.signIn(normalizeEmail(email), password);
      const normalized = asUser(raw);
      if (normalized === null) {
        throw new AccountError(
          'UNKNOWN',
          'provider returned a malformed account user',
        );
      }
      this.applyUser(normalized);
      return { ...normalized };
    } catch (error) {
      this.error = normalizeAccountError(error);
      throw this.error;
    } finally {
      this.end();
    }
  }

  async signOut(): Promise<void> {
    this.begin();
    try {
      await this.transport.signOut();
      // Sign-out dismantles cloud authority but never deletes local vaults
      // or canonical data: only the session identity clears.
      this.user = null;
      this.ready = true;
      this.error = null;
    } catch (error) {
      this.error = normalizeAccountError(error);
      throw this.error;
    } finally {
      this.end();
    }
  }

  async refreshToken(force = false): Promise<AccountTokenState> {
    try {
      const raw = await this.transport.refreshToken(force);
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        throw new AccountError(
          'UNKNOWN',
          'provider returned a malformed token state',
        );
      }
      const record = raw as unknown as Record<string, unknown>;
      const token = record.token;
      const expiresAt = record.expiresAt;
      if (token !== null && token !== undefined && typeof token !== 'string') {
        throw new AccountError(
          'UNKNOWN',
          'provider returned a malformed token state',
        );
      }
      if (
        expiresAt !== null &&
        expiresAt !== undefined &&
        typeof expiresAt !== 'string'
      ) {
        throw new AccountError(
          'UNKNOWN',
          'provider returned a malformed token state',
        );
      }
      // Trusted server entitlements: providers report the custom
      // claim ids they observed; absent/malformed degrades to empty (no
      // entitlement) rather than failing the refresh — a missing claim is
      // the normal Free state, not a transport error.
      const rawEntitlements = record.entitlements;
      let entitlements: readonly string[] = [];
      if (rawEntitlements !== undefined && rawEntitlements !== null) {
        if (
          !Array.isArray(rawEntitlements) ||
          !rawEntitlements.every(
            (entry): entry is string =>
              typeof entry === 'string' && entry.length > 0,
          )
        ) {
          throw new AccountError(
            'UNKNOWN',
            'provider returned a malformed token state',
          );
        }
        entitlements = [...rawEntitlements];
      }
      return {
        token: typeof token === 'string' ? token : null,
        expiresAt: typeof expiresAt === 'string' ? expiresAt : null,
        entitlements,
      };
    } catch (error) {
      const normalized = normalizeAccountError(error);
      this.error = normalized;
      this.emit();
      throw normalized;
    }
  }

  /** Test/headless teardown: detach the provider auth subscription. */
  dispose(): void {
    try {
      this.unsubscribeTransport?.();
    } catch {
      // Detach is best-effort; store listeners are host-owned.
    }
    this.listeners.clear();
  }
}

/**
 * Fallback transport for hosts without an account provider (local-only
 * development, headless, tests without a fake). Reports a clean
 * `NOT_CONFIGURED` so the app still boots and local Froglight keeps
 * working while account/sync UI reports unavailable.
 */
export const unconfiguredAccountTransport: AccountTransport = {
  async currentUser(): Promise<AccountUser | null> {
    throw new AccountError(
      'NOT_CONFIGURED',
      'account provider is not configured',
    );
  },
  async createAccount(): Promise<AccountUser> {
    throw new AccountError(
      'NOT_CONFIGURED',
      'account provider is not configured',
    );
  },
  async signIn(): Promise<AccountUser> {
    throw new AccountError(
      'NOT_CONFIGURED',
      'account provider is not configured',
    );
  },
  async signOut(): Promise<void> {
    throw new AccountError(
      'NOT_CONFIGURED',
      'account provider is not configured',
    );
  },
  async refreshToken(): Promise<AccountTokenState> {
    throw new AccountError(
      'NOT_CONFIGURED',
      'account provider is not configured',
    );
  },
  onAuthChange(): () => void {
    return () => undefined;
  },
};
