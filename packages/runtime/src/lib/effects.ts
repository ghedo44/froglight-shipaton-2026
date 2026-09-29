/**
 * Effect scopes: reversible registrations with deterministic cleanup.
 *
 * Every runtime-aware registration reduces to this one ownership mechanism
 * Cleanup runs in reverse registration order; every cleanup runs
 * even when a previous one fails, and failures are aggregated for the owner.
 *
 * Scope invariants:
 *
 * - reverse-order cleanup;
 * - every cleanup is attempted, failures are aggregated;
 * - no registrations after disposal (`add` throws);
 * - disposal is idempotent.
 *
 * Ownership: the runtime does not track which scope owns a resource object.
 * Callers must not register the same resource into multiple scopes; doing so
 * would run its cleanup once per scope. This is a caller contract, not an
 * enforced invariant.
 */

import { EffectScopeDisposedError, asError } from './errors.js';

/**
 * A reversible registration/resource with a deterministic owner and cleanup
 * action.
 */
export interface Effect {
  readonly dispose: () => void | Promise<void>;
}

/**
 * An ordered list of owned effects. Disposal runs every cleanup in reverse
 * registration order and collects failures instead of stopping early.
 */
export class EffectScope {
  #effects: Effect[] = [];
  #disposed = false;

  /** Number of effects currently owned by this scope. */
  get size(): number {
    return this.#effects.length;
  }

  /** True once this scope has been disposed; `add` is then rejected. */
  get disposed(): boolean {
    return this.#disposed;
  }

  /** Add an effect to the scope. Throws once the scope is disposed. */
  add(effect: Effect): void {
    if (this.#disposed) {
      throw new EffectScopeDisposedError();
    }
    this.#effects.push(effect);
  }

  /**
   * Dispose all effects in reverse registration order. Every cleanup runs,
   * even when a previous one fails; failures are returned to the caller.
   * Subsequent calls are no-ops (idempotent).
   */
  async dispose(): Promise<Error[]> {
    if (this.#disposed) {
      return [];
    }
    this.#disposed = true;
    const failures: Error[] = [];
    while (this.#effects.length > 0) {
      const effect = this.#effects.pop() as Effect;
      try {
        await effect.dispose();
      } catch (error) {
        failures.push(asError(error));
      }
    }
    return failures;
  }
}
