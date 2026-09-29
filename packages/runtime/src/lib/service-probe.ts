/**
 * Generic lifecycle-aware service capture.
 *
 * A probe is a normal runtime consumer with one hard service requirement.
 * It activates when the provider exists, clears its capture when the owning
 * fiber disposes, and automatically reactivates when a replacement provider
 * becomes available. This is the correct primitive for live optional
 * capabilities: soft requirements are introspection-only and do not
 * reactivate when availability changes.
 */

import type { PluginDefinition } from './types.js';
import { definePlugin } from './types.js';
import type { ServiceToken } from './services.js';

export interface ServiceProbeOptions<T> {
  /** Stable plugin id used by runtime diagnostics. */
  readonly pluginId: string;
  /** Service token whose active provider should be observed. */
  readonly token: ServiceToken<T>;
}

/**
 * Instance-owned live capture of one service token.
 *
 * Register `probe.plugin` as a slot, then read the currently active provider
 * through `probe.get()`. The capture is never module-global and follows the
 * runtime's activate -> dispose -> reactivate lifecycle exactly.
 */
export class ServiceProbe<T> {
  #current: T | null = null;
  readonly plugin: PluginDefinition;

  constructor(options: ServiceProbeOptions<T>) {
    const { pluginId, token } = options;
    this.plugin = definePlugin({
      id: pluginId,
      requirements: { requires: [token] },
      activate: (ctx) => {
        this.#current = ctx.require(token);
        ctx.effect(() => () => {
          this.#current = null;
        });
      },
    });
  }

  get(): T | null {
    return this.#current;
  }

  /**
   * Explicitly clear a capture when an owner withdraws a provider slot before
   * the reconciler reaches this consumer. Normal probe lifecycles clear via
   * the effect scope automatically.
   */
  clear(): void {
    this.#current = null;
  }
}

export function createServiceProbe<T>(
  options: ServiceProbeOptions<T>,
): ServiceProbe<T> {
  return new ServiceProbe(options);
}
