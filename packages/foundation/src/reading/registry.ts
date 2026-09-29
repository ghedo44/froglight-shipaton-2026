import type { DocumentKindId } from '../identity.js';
import type { DocumentSession } from '../session.js';

/**
 * Read-only presentation handle for one opened document.
 *
 * A reader renders derived presentation state (preview HTML, formatted
 * output) and never owns canonical persistence, dirty state, or editor
 * undo history. Canonical bytes stay authoritative in the session model;
 * reader output is always rebuildable.
 */
export interface DocumentReaderHandle {
  /** Refresh derived output from the live session model. */
  update(): void;
  /** Reveal a portable in-document address, when the reader supports it. */
  revealAddress?(address: string): void;
  destroy(): void;
}

/**
 * Reading-view provider for one or more document kinds.
 *
 * The application resolves readers by DocumentKindId, mirroring
 * DocumentEditorProvider. Kinds without a registered reader use their
 * editor's read-only surface (`setReadOnly(true)`); kinds with a reader
 * mount the reader in `reading` mode instead of the editor host.
 */
export interface DocumentReaderProvider {
  readonly id: string;
  readonly kindIds: readonly DocumentKindId[];
  createReader(input: {
    readonly session: DocumentSession;
    readonly parent: unknown;
  }): DocumentReaderHandle;
}

export interface DocumentReaderRegistry {
  register(provider: DocumentReaderProvider): { dispose(): void };
  get(kindId: DocumentKindId): DocumentReaderProvider | null;
  list(): readonly DocumentReaderProvider[];
  onDidChange(listener: (kindIds: readonly DocumentKindId[]) => void): {
    dispose(): void;
  };
}

/**
 * Reversible reader registry. Later registrations shadow earlier providers
 * for the same kind and disposal restores the previous provider.
 */
export class InMemoryDocumentReaderRegistry implements DocumentReaderRegistry {
  readonly #providers = new Map<string, DocumentReaderProvider[]>();

  readonly #listeners = new Set<(kindIds: readonly DocumentKindId[]) => void>();

  onDidChange(listener: (kindIds: readonly DocumentKindId[]) => void): { dispose(): void } {
    this.#listeners.add(listener);
    return { dispose: () => { this.#listeners.delete(listener); } };
  }

  register(provider: DocumentReaderProvider): { dispose(): void } {
    for (const kindId of provider.kindIds) {
      const stack = this.#providers.get(kindId) ?? [];
      stack.push(provider);
      this.#providers.set(kindId, stack);
    }
    const remove = (): void => {
      for (const kindId of provider.kindIds) {
        const stack = this.#providers.get(kindId);
        if (stack === undefined) continue;
        const index = stack.lastIndexOf(provider);
        if (index !== -1) stack.splice(index, 1);
        if (stack.length === 0) this.#providers.delete(kindId);
      }
    };
    const errors = this.#notify(provider.kindIds);
    if (errors.length > 0) {
      // No owner has received a disposer yet. Undo the push, then reconcile
      // every observer back to the restored selection before rejecting.
      remove();
      this.#notify(provider.kindIds);
      throw errors[0];
    }
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        remove();
        // Withdrawal cannot be rolled back: its effect owner is gone. Isolate
        // observer failures so all observers see restoration and cleanup ends.
        this.#notify(provider.kindIds);
      },
    };
  }

  #notify(kindIds: readonly DocumentKindId[]): unknown[] {
    const errors: unknown[] = [];
    for (const listener of [...this.#listeners]) {
      try { listener(kindIds); } catch (error) { errors.push(error); }
    }
    return errors;
  }

  get(kindId: DocumentKindId): DocumentReaderProvider | null {
    const stack = this.#providers.get(kindId);
    return stack?.[stack.length - 1] ?? null;
  }

  list(): readonly DocumentReaderProvider[] {
    return [...new Set([...this.#providers.values()].flat())];
  }
}
