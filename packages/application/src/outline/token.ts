import { createServiceToken } from '@froglight/runtime';
import type { OutlineRegistry } from './registry.js';

export const outlineRegistryToken =
  createServiceToken<OutlineRegistry>('froglight.outline-registry');
