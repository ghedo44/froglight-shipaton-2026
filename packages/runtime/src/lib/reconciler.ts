/**
 * Dependency reconciliation: compares configured plugin slots with available
 * hard requirements and drives the runtime to quiescence.
 */

import type { EventMap } from './events.js';
import type { ServiceRegistry } from './services.js';
import type {
  FiberState,
  PluginConfig,
  PluginDefinition,
  PluginRequirements,
} from './types.js';

export interface ReconcilableSlot<E extends EventMap = EventMap> {
  readonly id: string;
  readonly plugin: PluginDefinition<PluginConfig, E>;
  readonly state: 'inactive' | 'activating' | 'active' | 'failed';
  /** Current fiber, if any. Lifecycle state lets the reconciler distinguish
   * an invalid active fiber from one whose teardown is already owned by an
   * external/overlapping cascade. */
  readonly fiber: { readonly id: string; readonly state: FiberState } | null;
  readonly missingDynamicTokens: readonly string[];
}

export interface ReconcilerHost<E extends EventMap = EventMap> {
  readonly services: ServiceRegistry;
  readonly getSlots: () => readonly ReconcilableSlot<E>[];
  readonly activateSlot: (slot: ReconcilableSlot<E>) => Promise<boolean>;
  readonly disposeFiberOf: (slot: ReconcilableSlot<E>) => Promise<void>;
}

export class Reconciler<E extends EventMap = EventMap> {
  readonly #host: ReconcilerHost<E>;
  #draining: Promise<void> | null = null;
  #dirty = false;

  constructor(host: ReconcilerHost<E>) {
    this.#host = host;
  }

  requestReconcile(): void {
    this.#dirty = true;
    if (this.#draining === null) {
      this.#draining = this.#drain().finally(() => {
        this.#draining = null;
        if (this.#dirty) {
          this.requestReconcile();
        }
      });
    }
  }

  async awaitQuiescence(): Promise<void> {
    for (;;) {
      const draining = this.#draining;
      if (draining === null) {
        return;
      }
      await draining;
    }
  }

  async #drain(): Promise<void> {
    for (;;) {
      this.#dirty = false;

      // Teardown first. Fibers already `unloading` are deliberately excluded:
      // their disposal is owned by another cascade. A provider-rooted cascade
      // that depends on such a fiber will join its Fiber disposal promise;
      // the generic reconciler must not turn every retirement-window query
      // into a wait for unrelated cleanup to finish.
      const toDispose = this.#collectInvalid();
      if (toDispose.length > 0) {
        for (const slot of toDispose) {
          await this.#host.disposeFiberOf(slot);
        }
        continue;
      }

      // Only after invalid active/loading fibers are handled do we consider
      // activation. Retiring bindings never satisfy #hasAllRequirements.
      const toActivate = this.#collectActivatable();
      if (toActivate.length > 0) {
        const results = await Promise.all(
          toActivate.map((slot) => this.#host.activateSlot(slot)),
        );
        if (results.every((started) => !started)) {
          return;
        }
        continue;
      }
      return;
    }
  }

  #collectInvalid(): ReconcilableSlot<E>[] {
    const invalid: ReconcilableSlot<E>[] = [];
    for (const slot of this.#host.getSlots()) {
      if (slot.state === 'failed' || slot.state === 'activating') {
        continue;
      }
      if (
        slot.fiber !== null &&
        slot.fiber.state !== 'unloading' &&
        slot.fiber.state !== 'disposed' &&
        !this.#hasAllRequirements(slot.plugin.requirements)
      ) {
        invalid.push(slot);
      }
    }
    return invalid;
  }

  #collectActivatable(): ReconcilableSlot<E>[] {
    const activatable: ReconcilableSlot<E>[] = [];
    for (const slot of this.#host.getSlots()) {
      if (slot.state === 'failed' || slot.state === 'activating') {
        continue;
      }
      if (
        slot.fiber === null &&
        this.#hasAllRequirements(slot.plugin.requirements) &&
        !this.#isWaitingForDynamicRequirements(slot)
      ) {
        activatable.push(slot);
      }
    }
    return activatable;
  }

  #isWaitingForDynamicRequirements(slot: ReconcilableSlot<E>): boolean {
    for (const tokenId of slot.missingDynamicTokens) {
      if (this.#host.services.getActiveById(tokenId) === undefined) {
        return true;
      }
    }
    return false;
  }

  #hasAllRequirements(requirements?: PluginRequirements): boolean {
    for (const token of requirements?.requires ?? []) {
      if (this.#host.services.getActive(token) === undefined) {
        return false;
      }
    }
    return true;
  }
}
