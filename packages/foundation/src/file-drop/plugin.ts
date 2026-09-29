/**
 * Runtime binding for the external file-drop capability
 * (`froglight.file-drop`).
 *
 * Hosts create one service per bootstrap with `createFileDropHost` and
 * register `definition` as a slot. The service instance is host bootstrap
 * state — like the Rust-side vault state — so it outlives individual
 * fibers: activation provides the token binding (withdrawn on dispose,
 * satisfying the lifecycle invariant) while the service keeps its resolver
 * across reactivations.
 */

import { definePlugin, type PluginDefinition } from '@froglight/runtime';
import { externalFileDropToken } from '../tokens.js';
import {
  InMemoryExternalFileDropService,
  type InMemoryFileDropOptions,
} from './service.js';

export interface FileDropHostOptions extends InMemoryFileDropOptions {
  readonly service?: InMemoryExternalFileDropService;
}

export interface FileDropHost {
  readonly definition: PluginDefinition;
  readonly service: InMemoryExternalFileDropService;
}

export function createFileDropHost(
  options: FileDropHostOptions = {},
): FileDropHost {
  const service =
    options.service ??
    new InMemoryExternalFileDropService({ resolver: options.resolver ?? null });
  const definition = definePlugin({
    id: 'froglight.file-drop',
    activate: (ctx) => {
      ctx.provide(externalFileDropToken, service);
    },
  });
  return { definition, service };
}
