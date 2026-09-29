/**
 * Account ↔ purchase identity coordinator.
 *
 * Portable binding policy between the two identity-bearing capabilities:
 *
 * ```text
 * Firebase sign in
 *   → firebaseUser.uid
 *   → PurchaseService.identify(uid)
 *   → RevenueCat current App User ID = uid
 *   → purchase/entitlement refresh
 * ```
 *
 * Forced Firebase ID-token refresh after entitlement changes arrives
 * with claim propagation; this coordinator deliberately does not force
 * a token refresh on every bind.)
 *
 * Ordering guarantees:
 *
 * - All bind/unbind work runs through one serialized queue, so A → B →
 *   sign-out replacement can never interleave `logIn`/`logOut` calls.
 * - Sign-out always clears the purchase identity *before* Firebase
 *  sign-out, and never deletes local vaults or canonical
 *   data — the coordinator holds no vault reference at all.
 * - A signed-in user can never purchase Pro under an unrelated anonymous
 *   RevenueCat identity: `ensureAccountIdentity()` re-binds whenever the
 *   purchase identity is stale, and account-bound flows await it first.
 */

import { AccountError } from '../account/errors.js';
import type { AccountService } from '../account/contract.js';
import { PurchaseError } from '../purchases/errors.js';
import type { PurchaseService } from '../purchases/contract.js';
import type {
  AccountIdentityService,
  AccountIdentitySnapshot,
  AccountIdentitySnapshotListener,
} from './contract.js';

export interface AccountIdentityCoordinatorOptions {
  /**
   * Sync-teardown hook for ordered sign-out: stop
   * VaultSyncService, cancel listeners, persist sync metadata). Runs
   * before `clearIdentity`. VaultSyncService plugs in here in a later
   * slice; until then sign-out is purchase-identity + Firebase session.
   */
  readonly onBeforeSignOut?: () => Promise<void>;
}

export interface AccountIdentityBinding {
  readonly account: AccountService;
  readonly purchases: PurchaseService;
}

export class AccountIdentityCoordinator implements AccountIdentityService {
  private readonly onBeforeSignOut: (() => Promise<void>) | null;
  private account: AccountService | null = null;
  private purchases: PurchaseService | null = null;
  private unsubscribeAccount: (() => void) | null = null;
  private identifiedUid: string | null = null;
  private pending = 0;
  private error: AccountError | PurchaseError | null = null;
  private readonly listeners = new Set<AccountIdentitySnapshotListener>();
  private tail: Promise<void> = Promise.resolve();
  private attachGeneration = 0;
  private operationGeneration = 0;

  constructor(options: AccountIdentityCoordinatorOptions = {}) {
    this.onBeforeSignOut = options.onBeforeSignOut ?? null;
  }

  /**
   * Attach live services. Called once by the runtime definition on
   * activation; returns a disposer that detaches (dispose withdraws all
   * owned subscriptions — the lifecycle invariant). Re-attach after a
   * provider swap rebinds to the new instances.
   */
  attach(binding: AccountIdentityBinding): () => void {
    this.detach();
    this.attachGeneration += 1;
    const attachGeneration = this.attachGeneration;
    this.account = binding.account;
    this.purchases = binding.purchases;
    this.unsubscribeAccount = binding.account.subscribe(() => {
      // Capture generations at event time (not attach time): an ordinary
      // sign-out bumps only the operation generation, so callbacks fired
      // after the sign-out capture the fresh operation generation and stay
      // valid. Only a detach (attachGeneration bump) permanently retires
      // the listener.
      const currentAttach = this.attachGeneration;
      const currentOperation = this.operationGeneration;
      void this.enqueue(() => this.reconcile(currentAttach, currentOperation));
    });
    // Restart with a persisted session must bind without waiting for the
    // next auth event: reconcile the current state immediately.
    void this.enqueue(() =>
      this.reconcile(attachGeneration, this.operationGeneration),
    );
    return () => this.detach();
  }

  /** Detach services and drop subscriptions; keeps last-known snapshot. */
  detach(): void {
    this.attachGeneration += 1;
    this.operationGeneration += 1;
    try {
      this.unsubscribeAccount?.();
    } catch {
      // Detach is best-effort.
    }
    this.unsubscribeAccount = null;
    this.account = null;
    this.purchases = null;
  }

  snapshot(): AccountIdentitySnapshot {
    return {
      identifiedUid: this.identifiedUid,
      pending: this.pending > 0,
      error: this.error,
    };
  }

  subscribe(listener: AccountIdentitySnapshotListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async ensureAccountIdentity(): Promise<void> {
    const account = this.account;
    const purchases = this.purchases;
    if (account === null || purchases === null) {
      throw new AccountError(
        'NOT_CONFIGURED',
        'identity coordinator is not attached',
      );
    }
    const user = account.snapshot().user;
    if (user === null) {
      throw new AccountError(
        'UNAUTHENTICATED',
        'sign in before purchasing Pro',
      );
    }
    const customer = purchases.snapshot().customer;
    if (this.identifiedUid === user.id && customer?.appUserId === user.id) {
      return;
    }
    const attachGeneration = this.attachGeneration;
    const operationGeneration = this.operationGeneration;
    await this.enqueue(() =>
      this.bindUid(user.id, attachGeneration, operationGeneration),
    );
  }

  async signOut(): Promise<void> {
    const account = this.account;
    const purchases = this.purchases;
    if (account === null || purchases === null) {
      throw new AccountError(
        'NOT_CONFIGURED',
        'identity coordinator is not attached',
      );
    }
    // Invalidate auto-reconcile tasks enqueued before this sign-out so a
    // stale auth event can never re-bind or double-clear mid-teardown —
    // without retiring the permanent auth listener (attachGeneration is
    // untouched, so later sign-ins reconcile normally).
    const attachGeneration = this.attachGeneration;
    const generation = ++this.operationGeneration;
    await this.enqueue(async () => {
      if (
        this.attachGeneration !== attachGeneration ||
        this.operationGeneration !== generation
      )
        return;
      await this.onBeforeSignOut?.();
      if (
        this.attachGeneration !== attachGeneration ||
        this.operationGeneration !== generation
      )
        return;
      let clearError: unknown = null;
      try {
        await this.clearPurchaseIdentity(purchases);
      } catch (error) {
        clearError = error;
      }
      if (
        this.attachGeneration !== attachGeneration ||
        this.operationGeneration !== generation
      )
        return;
      this.identifiedUid = null;
      this.error = null;
      this.emit();
      // Firebase sign-out always runs: cloud authority must be dismantled
      // even when clearing the purchase identity failed. A clear failure
      // is still reported after the session is gone.
      await account.signOut();
      if (clearError !== null) throw clearError;
    });
  }

  private emit(): void {
    const snapshot = this.snapshot();
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot);
      } catch {
        // Listener failures must never break identity dispatch.
      }
    }
  }

  /**
   * Serialize bind/unbind work. Previous failures never block later tasks
   * (`then(task, task)`), and the shared tail never rejects, so the queue
   * cannot wedge. Every failure is recorded in the snapshot; the returned
   * promise additionally settles per-task so awaited callers
   * (`ensureAccountIdentity`, `signOut`) observe it directly.
   */
  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.tail.then(task, task);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    run.then(undefined, (error: unknown) => {
      this.error =
        error instanceof AccountError || error instanceof PurchaseError
          ? error
          : new PurchaseError('UNKNOWN', 'identity binding failed', {
              cause: error,
            });
      this.emit();
    });
    this.begin();
    void run.then(
      () => this.end(),
      () => this.end(),
    );
    return run;
  }

  private begin(): void {
    this.pending += 1;
    this.emit();
  }

  private end(): void {
    this.pending = Math.max(0, this.pending - 1);
    this.emit();
  }

  private async reconcile(
    attachGeneration: number,
    operationGeneration: number,
  ): Promise<void> {
    if (
      this.attachGeneration !== attachGeneration ||
      this.operationGeneration !== operationGeneration
    )
      return;
    const account = this.account;
    const purchases = this.purchases;
    if (account === null || purchases === null) return;
    const user = account.snapshot().user;
    if (user === null) {
      // External sign-out (another device, revoked session): withdraw the
      // purchase identity so user B can never inherit user A's.
      if (this.identifiedUid !== null) {
        await this.clearPurchaseIdentity(purchases);
        if (
          this.attachGeneration !== attachGeneration ||
          this.operationGeneration !== operationGeneration
        )
          return;
        this.identifiedUid = null;
        this.error = null;
        this.emit();
      }
      return;
    }
    await this.bindUid(user.id, attachGeneration, operationGeneration);
  }

  private async bindUid(
    uid: string,
    attachGeneration: number,
    operationGeneration: number,
  ): Promise<void> {
    const purchases = this.purchases;
    if (purchases === null) {
      throw new AccountError(
        'NOT_CONFIGURED',
        'identity coordinator is not attached',
      );
    }
    // Re-check at task start: a reconcile and an ensureAccountIdentity for
    // the same UID may both be queued (restart race) — the second is a
    // no-op instead of a redundant logIn.
    const customer = purchases.snapshot().customer;
    if (this.identifiedUid === uid && customer?.appUserId === uid) return;
    if (typeof purchases.identify !== 'function') {
      throw new PurchaseError(
        'UNSUPPORTED',
        'purchase provider does not support identity binding',
      );
    }
    const identified = await purchases.identify(uid);
    if (
      this.attachGeneration !== attachGeneration ||
      this.operationGeneration !== operationGeneration
    )
      return;
    if (identified.appUserId !== uid) {
      throw new PurchaseError(
        'UNKNOWN',
        'purchase provider reported a different identity than requested',
      );
    }
    // Make the entitlement state authoritative for the new identity: a
    // stale cached CustomerInfo from the anonymous user must never gate
    // Pro UI after sign-in.
    await purchases.refresh();
    if (
      this.attachGeneration !== attachGeneration ||
      this.operationGeneration !== operationGeneration
    )
      return;
    this.identifiedUid = uid;
    this.error = null;
    this.emit();
  }

  private async clearPurchaseIdentity(
    purchases: PurchaseService,
  ): Promise<void> {
    if (typeof purchases.clearIdentity !== 'function') return;
    await purchases.clearIdentity();
  }
}
