import type { DocumentKindId } from './identity.js';

/** Shell policy and display data; independent of the canonical kind and editor. */
export interface DocumentPresentation {
  readonly kindId: DocumentKindId;
  readonly label?: string;
  readonly description?: string;
  readonly icon?: string;
  readonly shell?: {
    readonly toolbar?: 'document' | 'none';
    readonly defaultContextMenu?: boolean;
    readonly title?: 'provider' | 'overlay' | 'inline';
  };
}

export interface DocumentPresentationRegistry {
  register(presentation: DocumentPresentation): { dispose(): void };
  get(kindId: DocumentKindId): DocumentPresentation | null;
  list(): readonly DocumentPresentation[];
  onDidChange(listener: () => void): { dispose(): void };
}

export class InMemoryDocumentPresentationRegistry
  implements DocumentPresentationRegistry
{
  readonly #entries = new Map<DocumentKindId, DocumentPresentation>();
  readonly #listeners = new Set<() => void>();

  register(presentation: DocumentPresentation): { dispose(): void } {
    if (this.#entries.has(presentation.kindId))
      throw new Error(
        `Document presentation already registered: ${presentation.kindId}`,
      );
    this.#entries.set(presentation.kindId, presentation);
    this.#notify();
    return {
      dispose: () => {
        if (this.#entries.get(presentation.kindId) !== presentation) return;
        this.#entries.delete(presentation.kindId);
        this.#notify();
      },
    };
  }

  get(kindId: DocumentKindId): DocumentPresentation | null {
    return this.#entries.get(kindId) ?? null;
  }

  list(): readonly DocumentPresentation[] {
    return [...this.#entries.values()];
  }

  onDidChange(listener: () => void): { dispose(): void } {
    this.#listeners.add(listener);
    return {
      dispose: () => {
        this.#listeners.delete(listener);
      },
    };
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }
}
