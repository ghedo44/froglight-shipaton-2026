import type { DocumentKindId } from '../identity.js';
import type { DocumentSession } from '../session.js';
import type { DocumentEditorTools } from './tools.js';
import type { StylusInputPolicy } from '../stylus/contract.js';

/** Editor handle shared by every document family. */
export interface DocumentEditorHandle {
  /** Optional semantic tools rendered by the shared React toolbar. */
  readonly tools?: DocumentEditorTools;
  /** Switch the provider's rendered surface between editable and read-only. */
  setReadOnly?(readOnly: boolean): void;
  focus(): void;
  hasFocus(): boolean;
  execCommand(id: 'undo' | 'redo'): boolean;
  canExecCommand?(id: 'undo' | 'redo'): boolean;
  /** Commit provider-local pending input before persistence. */
  flush?(): void;
  /** Reveal a portable in-document address, when the provider supports it. */
  revealAddress?(address: string): void;
  /** Derived PNG appearance for a page-addressed export; never canonical content. */
  renderPageImage?(
    address: string,
    dpi: number,
    signal?: AbortSignal,
  ): Promise<Uint8Array>;
  destroy(): void;
}

/**
 * Editor provider for one or more document kinds.
 *
 * The application resolves providers by DocumentKindId. A Markdown editor,
 * PDF viewer/annotator, block editor, notebook editor, or surface editor can
 * all participate without the workbench knowing their implementation type.
 */
export interface DocumentEditorProvider {
  readonly id: string;
  readonly kindIds: readonly DocumentKindId[];
  createEditor(input: {
    readonly session: DocumentSession;
    readonly parent: unknown;
    readonly stylusInput?: StylusInputPolicy;
    /** Absent for ordinary workspace documents. */
    readonly context?: {
      readonly kind: 'template';
      readonly templateId: string;
    };
  }): DocumentEditorHandle;
}

export interface DocumentEditorRegistry {
  register(provider: DocumentEditorProvider): { dispose(): void };
  get(kindId: DocumentKindId): DocumentEditorProvider | null;
  list(): readonly DocumentEditorProvider[];
  onDidChange(listener: (kindIds: readonly DocumentKindId[]) => void): {
    dispose(): void;
  };
}

/**
 * Reversible editor registry. Later registrations shadow earlier providers
 * for the same kind and disposal restores the previous provider.
 */
export class InMemoryDocumentEditorRegistry implements DocumentEditorRegistry {
  readonly #providers = new Map<string, DocumentEditorProvider[]>();
  readonly #listeners = new Set<(kindIds: readonly DocumentKindId[]) => void>();

  onDidChange(listener: (kindIds: readonly DocumentKindId[]) => void): {
    dispose(): void;
  } {
    this.#listeners.add(listener);
    return {
      dispose: () => {
        this.#listeners.delete(listener);
      },
    };
  }

  register(provider: DocumentEditorProvider): { dispose(): void } {
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
      try {
        listener(kindIds);
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }

  get(kindId: DocumentKindId): DocumentEditorProvider | null {
    const stack = this.#providers.get(kindId);
    return stack?.[stack.length - 1] ?? null;
  }

  list(): readonly DocumentEditorProvider[] {
    return [...new Set([...this.#providers.values()].flat())];
  }
}
