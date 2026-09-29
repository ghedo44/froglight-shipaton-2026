/**
 * Block Registry capability.
 *
 * Trusted-tier plugins register Block Types through this registry; the
 * permission gate (`workspace.blocks.register`) lives on the trusted side
 * of the facade boundary, not here. Registration is a plain reversible
 * Disposer so runtime effect scopes own cleanup.
 */

import { FroglightError } from '../errors.js';
import { isValidNamespacedTypeId } from './model.js';

export interface BlockTypeDescriptor {
  /** Dot-namespaced id. */
  readonly typeId: string;
  readonly version: number;
  /**
   * Optional Markdown export mapping for conversion participation; absent
   * means the type exports only via explicit warning-omission.
   */
  readonly toMarkdown?: (record: Record<string, unknown>) => string | null;
  /**
   * Optional presentation hints for registry-driven catalogs.
   * Consumers fall back to `typeId` when `label` is absent.
   */
  readonly label?: string;
  /** Short label for compact catalog display; falls back to `label`, then `typeId`. */
  readonly shortLabel?: string;
  /** One-line usage hint shown alongside the catalog entry. */
  readonly hint?: string;
  /** Search keywords matched by the catalog filter; the typeId is always matched. */
  readonly keywords?: string;
}

export interface BlockRegistry {
  register(descriptor: BlockTypeDescriptor): { dispose(): void };
  get(typeId: string): BlockTypeDescriptor;
  list(): readonly BlockTypeDescriptor[];
}

export class InMemoryBlockRegistry implements BlockRegistry {
  readonly #types = new Map<string, BlockTypeDescriptor>();

  register(descriptor: BlockTypeDescriptor): { dispose(): void } {
    if (!isValidNamespacedTypeId(descriptor.typeId)) {
      throw new FroglightError(
        'INVALID_BLOCK_TYPE_ID',
        `block type id must be dot-namespaced: ${descriptor.typeId}`,
      );
    }
    if (this.#types.has(descriptor.typeId)) {
      throw new FroglightError('DUPLICATE_BLOCK_TYPE', `block type already registered: ${descriptor.typeId}`);
    }
    this.#types.set(descriptor.typeId, descriptor);
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.#types.delete(descriptor.typeId);
      },
    };
  }

  get(typeId: string): BlockTypeDescriptor {
    const descriptor = this.#types.get(typeId);
    if (descriptor === undefined) {
      throw new FroglightError('UNKNOWN_BLOCK_TYPE', `unknown block type: ${typeId}`);
    }
    return descriptor;
  }

  list(): readonly BlockTypeDescriptor[] {
    return [...this.#types.values()];
  }
}
