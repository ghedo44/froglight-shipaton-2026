/**
 * Runtime binding for the stylus accessory capability.
 *
 * Hosts create one service per bootstrap with `createStylusHost` and
 * register `definition` as a slot. The service instance is host bootstrap
 * state — like the Rust-side vault state — so it outlives individual
 * fibers: activation provides the token binding (withdrawn on dispose,
 * satisfying the lifecycle invariant) while the service keeps observed
 * capabilities across reactivations.
 */

import { definePlugin, type PluginDefinition } from '@froglight/runtime';
import { stylusToken } from '../tokens.js';
import type { StylusCapabilities } from './contract.js';
import { InMemoryStylusService } from './service.js';

export interface StylusHostOptions {
  readonly initialCapabilities?: StylusCapabilities;
  readonly service?: InMemoryStylusService;
}

export interface StylusHost {
  readonly definition: PluginDefinition;
  readonly service: InMemoryStylusService;
}

export function createStylusHost(options: StylusHostOptions = {}): StylusHost {
  const service =
    options.service ?? new InMemoryStylusService(options.initialCapabilities);
  const definition = definePlugin({
    id: 'froglight.stylus',
    activate: (ctx) => {
      ctx.provide(stylusToken, service);
    },
  });
  return { definition, service };
}
