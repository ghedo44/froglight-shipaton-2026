/**
 * Runtime binding for the keyboard-inset capability.
 *
 * Hosts create one host object per bootstrap with `createKeyboardInset`
 * (injecting their transport) and register `definition` as a slot. The
 * store instance is host bootstrap state — like the Rust-side vault state
 * — so it outlives individual fibers: activation provides the token
 * binding (withdrawn on dispose, satisfying the lifecycle invariant) while
 * the store keeps the observed heights across reactivations.
 */

import { definePlugin, type PluginDefinition } from '@froglight/runtime';
import { keyboardInsetToken } from '../tokens.js';
import type { KeyboardInsetTransport } from './contract.js';
import { KeyboardInsetStore, type KeyboardInsetStorage } from './store.js';

export interface KeyboardInsetHostOptions {
  readonly transport?: KeyboardInsetTransport;
  readonly storage?: KeyboardInsetStorage | null;
}

export interface KeyboardInsetHost {
  readonly definition: PluginDefinition;
  readonly store: KeyboardInsetStore;
}

export function createKeyboardInset(
  options: KeyboardInsetHostOptions = {},
): KeyboardInsetHost {
  const store = new KeyboardInsetStore({
    transport: options.transport,
    storage: options.storage ?? null,
  });
  const definition = definePlugin({
    id: 'froglight.keyboard-inset',
    activate: (ctx) => {
      ctx.provide(keyboardInsetToken, store);
    },
  });
  return { definition, store };
}
