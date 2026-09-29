/**
 * Runtime binding for the purchase/entitlement capability.
 *
 * Hosts create one host object per bootstrap with `createPurchaseHost`
 * (injecting their transport) and register `definition` as a slot. The
 * store instance is host bootstrap state — like the Rust-side vault state
 * — so it outlives individual fibers: activation provides the token
 * binding (withdrawn on dispose, satisfying the lifecycle invariant) while
 * the store keeps seeded customer state across reactivations.
 */

import { definePlugin, type PluginDefinition } from '@froglight/runtime';
import { purchasesToken } from '../tokens.js';
import { PurchaseStore, type PurchaseStoreOptions } from './store.js';

export interface PurchaseHostOptions extends PurchaseStoreOptions {
  readonly service?: PurchaseStore;
}

export interface PurchaseHost {
  readonly definition: PluginDefinition;
  readonly service: PurchaseStore;
}

export function createPurchaseHost(options: PurchaseHostOptions = {}): PurchaseHost {
  const service =
    options.service ??
    new PurchaseStore({
      transport: options.transport,
      initialCustomer: options.initialCustomer ?? null,
    });
  const definition = definePlugin({
    id: 'froglight.purchases',
    activate: (ctx) => {
      ctx.provide(purchasesToken, service);
    },
  });
  return { definition, service };
}
