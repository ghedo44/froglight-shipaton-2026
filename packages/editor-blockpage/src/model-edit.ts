/**
 * Shared canonical-model helpers for the transitional block-page editor
 * provider. Editing never normalizes opaque payloads: models are cloned as
 * parsed JSON so unknown fields survive byte-stable round trips.
 */

import type { BlockId, BlockPageModel } from '@froglight/foundation';

export function cloneModel(model: BlockPageModel): BlockPageModel {
  return JSON.parse(JSON.stringify(model)) as BlockPageModel;
}

let idCounter = 0;

/** Fresh opaque block id; uniqueness within one editing lifetime suffices. */
export function newBlockId(prefix = 'b'): BlockId {
  idCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${idCounter.toString(36)}`;
}
