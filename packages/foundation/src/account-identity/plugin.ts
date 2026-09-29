/**
 * Runtime binding for the account ↔ purchase identity coordinator
 *
 *
 * Hosts create one host object per bootstrap with
 * `createAccountIdentityHost` and register `definition` as a slot *after*
 * the account and purchases slots. The coordinator instance is host
 * bootstrap state so it outlives individual fibers: activation provides
 * the token binding plus the live services (withdrawn/detached on
 * dispose, satisfying the lifecycle invariant) while the coordinator
 * keeps the last-bound UID across reactivations.
 */

import { definePlugin, type PluginDefinition } from '@froglight/runtime';
import {
  accountIdentityToken,
  accountToken,
  purchasesToken,
} from '../tokens.js';
import {
  AccountIdentityCoordinator,
  type AccountIdentityCoordinatorOptions,
} from './coordinator.js';

export interface AccountIdentityHostOptions
  extends AccountIdentityCoordinatorOptions {
  readonly service?: AccountIdentityCoordinator;
}

export interface AccountIdentityHost {
  readonly definition: PluginDefinition;
  readonly service: AccountIdentityCoordinator;
}

export function createAccountIdentityHost(
  options: AccountIdentityHostOptions = {},
): AccountIdentityHost {
  const service = options.service ?? new AccountIdentityCoordinator(options);
  const definition = definePlugin({
    id: 'froglight.account-identity',
    requirements: { requires: [accountToken, purchasesToken] },
    activate: (ctx) => {
      ctx.provide(accountIdentityToken, service);
      const account = ctx.require(accountToken);
      const purchases = ctx.require(purchasesToken);
      ctx.effect(() => service.attach({ account, purchases }));
    },
  });
  return { definition, service };
}
