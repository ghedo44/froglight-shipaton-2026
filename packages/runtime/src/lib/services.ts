/**
 * Typed service tokens and owned service bindings.
 *
 * A service token is a stable typed identity for a capability contract.
 * TypeScript code receives compile-time typing without coupling the contract
 * identity to a concrete provider class.
 *
 * Bindings are staged while their provider fiber is activating and only
 * become dependency-visible when the activation commits. A service provided
 * by a plugin whose activation has not successfully completed must never
 * satisfy other plugins.
 *
 * Bindings pass through three visibility states:
 *
 * - staged: reserved by an activating fiber, not dependency-visible;
 * - active: committed, satisfies new activations and resolves `ctx.require`;
 * - retiring: the owning fiber is being torn down. New activations must not
 *   consider the service available (`getActive` excludes retiring bindings),
 *   but existing consumers may still resolve it while their own cleanup runs
 *   (`getResolvable`), so provider cleanup never runs before its consumers
 *   finish.
 */

import type { FiberHandle } from './types.js';

/** Symbol used at runtime to identify service tokens. */
const TOKEN_MARK = Symbol('froglight.serviceToken');

/**
 * A typed service token. The type parameter is the contract a consumer may
 * depend on; the token never references a concrete provider.
 */
export interface ServiceToken<T = unknown> {
  readonly [TOKEN_MARK]: true;
  /** Stable identity used for diagnostics and binding keys. */
  readonly id: string;
  /** Nominal marker for the service contract type. */
  readonly _service?: T;
}

/**
 * Create a typed service token with a stable identity. Use the same token
 * value (module-level constant) for both provision and consumption so the
 * service graph stays consistent.
 */
export function createServiceToken<T>(id: string): ServiceToken<T> {
  if (typeof id !== 'string' || id.length === 0) {
    throw new TypeError('service token id must be a non-empty string');
  }
  return { [TOKEN_MARK]: true, id } as ServiceToken<T>;
}

/** Internal registry entry pairing a token with its owner fiber. */
export interface BindingRecord {
  readonly token: ServiceToken;
  readonly implementation: unknown;
  readonly fiber: FiberHandle;
}

/**
 * Internal registry of service bindings with staged/committed/retiring
 * semantics.
 *
 * - `stage` reserves a token for an activating fiber (duplicate detection);
 * - `commit` makes a fiber's staged bindings dependency-visible;
 * - `retire` moves a fiber's committed bindings to the retiring state: they
 *   stop satisfying new activations but remain resolvable by consumers that
 *   are already unloading;
 * - `getActive` only ever returns committed bindings; `getResolvable` also
 *   returns retiring bindings for in-cleanup consumers;
 * - `hasReserved` includes retiring bindings, so a replacement provider
 *   cannot stage the same token while the old provider is being torn down
 *   (that would let a mid-cleanup consumer resolve the replacement instead
 *   of the service it actually used).
 */
export interface ServiceRegistry {
  /** Reserve a binding owned by `fiber`; not dependency-visible until commit. */
  stage(binding: BindingRecord): void;
  /** Commit all staged bindings of `fiber`: they become dependency-visible. */
  commit(fiberId: string): void;
  /**
   * Move every committed binding of `fiber` to the retiring state (called
   * synchronously when the fiber's teardown cascade starts).
   */
  retire(fiberId: string): void;
  /** Remove the binding registered by `fiber` for `token` (if any). */
  withdraw(token: ServiceToken, fiberId: string): void;
  /** Remove every binding owned by `fiber` (staged, committed, retiring). */
  withdrawAll(fiberId: string): void;
  /** The committed implementation for `token`, if any (never retiring). */
  getActive(token: ServiceToken): unknown | undefined;
  /** The committed implementation for the token with this id, if any. */
  getActiveById(tokenId: string): unknown | undefined;
  /**
   * The committed implementation for `token`, or the retiring implementation
   * if the provider is being torn down (for consumers in cleanup).
   */
  getResolvable(token: ServiceToken): unknown | undefined;
  /** True if the binding for `token` is currently retiring. */
  isRetiring(token: ServiceToken): boolean;
  /** True if a staged, committed, or retiring binding exists for `token`. */
  hasReserved(token: ServiceToken): boolean;
  /** All committed (active) bindings. */
  all(): readonly BindingRecord[];
  /** All staged (not yet committed) bindings. */
  staged(): readonly BindingRecord[];
  /** All retiring bindings (visible in introspection). */
  retiring(): readonly BindingRecord[];
}
