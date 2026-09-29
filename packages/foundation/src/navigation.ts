/**
 * Workspace navigation history.
 *
 * Editor/provider-local navigation (cursor position, undo/redo) stays in
 * the editor integration. This service is the Froglight-owned
 * workspace navigation: open documents and their locations, with back and
 * forward semantics. It is editor-neutral and JSON-serializable.
 */

export interface NavigationEntry {
  /** Resource identity, never a raw path. */
  readonly resourceId: string;
  /** Optional in-resource address (e.g. block id or cell path). */
  readonly address?: string;
}

export interface NavigationService {
  /** Current entry; `null` when history is empty. */
  readonly current: NavigationEntry | null;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  /** Push a new entry; truncates any forward branch. */
  push(entry: NavigationEntry): void;
  /** Replace the current entry without growing history. */
  replace(entry: NavigationEntry): void;
  /** Go back; no-op when unavailable. */
  back(): void;
  /** Go forward; no-op when unavailable. */
  forward(): void;
  /** Clear all history. */
  clear(): void;
  /** Subscribe to changes; returns a disposer. */
  onChange(listener: () => void): Disposer;
}

export interface Disposer {
  readonly dispose: () => void;
}

/** In-memory navigation history. */
export class InMemoryNavigationService implements NavigationService {
  #entries: NavigationEntry[] = [];
  #index = -1;
  readonly #listeners = new Set<() => void>();

  get current(): NavigationEntry | null {
    return this.#index >= 0 ? { ...this.#entries[this.#index] } : null;
  }

  get canGoBack(): boolean {
    return this.#index > 0;
  }

  get canGoForward(): boolean {
    return this.#index >= 0 && this.#index < this.#entries.length - 1;
  }

  push(entry: NavigationEntry): void {
    // Truncate the forward branch.
    this.#entries = [...this.#entries.slice(0, this.#index + 1), normalizeEntry(entry)];
    this.#index = this.#entries.length - 1;
    this.#emit();
  }

  replace(entry: NavigationEntry): void {
    if (this.#index < 0) {
      this.#entries = [normalizeEntry(entry)];
      this.#index = 0;
    } else {
      this.#entries = [...this.#entries];
      this.#entries[this.#index] = normalizeEntry(entry);
    }
    this.#emit();
  }

  back(): void {
    if (this.canGoBack) {
      this.#index -= 1;
      this.#emit();
    }
  }

  forward(): void {
    if (this.canGoForward) {
      this.#index += 1;
      this.#emit();
    }
  }

  clear(): void {
    this.#entries = [];
    this.#index = -1;
    this.#emit();
  }

  onChange(listener: () => void): Disposer {
    this.#listeners.add(listener);
    return {
      dispose: () => {
        this.#listeners.delete(listener);
      },
    };
  }

  #emit(): void {
    for (const listener of [...this.#listeners]) {
      listener();
    }
  }
}

function normalizeEntry(entry: NavigationEntry): NavigationEntry {
  return entry.address === undefined ? { resourceId: entry.resourceId } : { ...entry };
}
