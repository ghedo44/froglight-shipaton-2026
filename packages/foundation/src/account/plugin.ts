/**
 * Runtime binding for the account capability.
 *
 * Hosts create one host object per bootstrap with `createAccountHost`
 * (injecting their transport) and register `definition` as a slot. The
 * store instance is host bootstrap state so it outlives individual
 * fibers: activation provides the token binding (withdrawn on dispose,
 * satisfying the lifecycle invariant) while the store keeps the session
 * identity across reactivations.
 */

import { definePlugin, type PluginDefinition } from '@froglight/runtime';
import { accountToken } from '../tokens.js';
import { AccountStore, type AccountStoreOptions } from './store.js';

export interface AccountHostOptions extends AccountStoreOptions {
  readonly service?: AccountStore;
}

export interface AccountHost {
  readonly definition: PluginDefinition;
  readonly service: AccountStore;
}

export function createAccountHost(
  options: AccountHostOptions = {},
): AccountHost {
  const service =
    options.service ??
    new AccountStore({
      transport: options.transport,
      initialUser: options.initialUser ?? null,
    });
  const definition = definePlugin({
    id: 'froglight.account',
    activate: (ctx) => {
      ctx.provide(accountToken, service);
    },
  });
  return { definition, service };
}
