import type {
  DocumentToolControl,
  DocumentToolSnapshot,
} from '@froglight/foundation';
import { createServiceToken, definePlugin } from '@froglight/runtime';

/** Plain context available to trusted document-toolbar contributions. */
export interface DocumentToolbarContext {
  readonly pane: string;
  readonly documentId: string;
  readonly kindId: string;
  readonly editor: DocumentToolSnapshot | null;
}

/**
 * One reversible plugin contribution to the shared document toolbar.
 * Controls remain semantic data; plugins never receive or return React DOM.
 */
export interface DocumentToolbarContribution {
  readonly id: string;
  readonly order?: number;
  readonly when?: (context: DocumentToolbarContext) => boolean;
  controls(context: DocumentToolbarContext): readonly DocumentToolControl[];
  execute(
    context: DocumentToolbarContext,
    id: string,
    value?: string,
  ): boolean | Promise<boolean>;
}

export interface DocumentToolbarRegistry {
  register(contribution: DocumentToolbarContribution): { dispose(): void };
  controls(context: DocumentToolbarContext): readonly DocumentToolControl[];
  execute(
    context: DocumentToolbarContext,
    id: string,
    value?: string,
  ): boolean | Promise<boolean>;
  /**
   * Execute through one resolved owner only. The toolbar resolves ownership
   * before rendering (provider > shell > contribution) and routes via this
   * channel so a contribution can never hijack a provider-owned id while
   * the provider control remains visible.
   */
  executeOwned(
    contributionId: string,
    context: DocumentToolbarContext,
    id: string,
    value?: string,
  ): boolean | Promise<boolean>;
  /**
   * Contribution owning `id` in deterministic order, or null when no active
   * contribution exposes it. Used to assemble owned pool with precedence.
   */
  ownerOf(context: DocumentToolbarContext, id: string): string | null;
  /**
   * Per-contribution controls in deterministic order (no dedup across
   * contributions). Used to assemble owned pool with exact ownership and
   * duplicate diagnostics.
   */
  entries(context: DocumentToolbarContext): readonly {
    readonly contributionId: string;
    readonly controls: readonly DocumentToolControl[];
  }[];
  onDidChange(listener: () => void): { dispose(): void };
}

export const documentToolbarRegistryToken =
  createServiceToken<DocumentToolbarRegistry>(
    'froglight.document-toolbar-registry',
  );

export function createDocumentToolbarRegistry(): {
  readonly registry: DocumentToolbarRegistry;
  dispose(): void;
} {
  const contributions = new Map<string, DocumentToolbarContribution>();
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of listeners) listener();
  };
  const active = (
    context: DocumentToolbarContext,
  ): DocumentToolbarContribution[] =>
    [...contributions.values()]
      .filter((contribution) => contribution.when?.(context) !== false)
      .sort(
        (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id),
      );

  const registry: DocumentToolbarRegistry = {
    register(contribution) {
      const previous = contributions.get(contribution.id);
      contributions.set(contribution.id, contribution);
      notify();
      let disposed = false;
      return {
        dispose() {
          if (disposed) return;
          disposed = true;
          if (contributions.get(contribution.id) !== contribution) return;
          if (previous === undefined) contributions.delete(contribution.id);
          else contributions.set(contribution.id, previous);
          notify();
        },
      };
    },
    controls(context) {
      const seen = new Set<string>();
      const controls: DocumentToolControl[] = [];
      for (const contribution of active(context)) {
        for (const control of contribution.controls(context)) {
          if (seen.has(control.id)) continue;
          seen.add(control.id);
          controls.push(control);
        }
      }
      return controls;
    },
    execute(context, id, value) {
      const owner = active(context).find((contribution) =>
        contribution.controls(context).some((control) => control.id === id),
      );
      return owner?.execute(context, id, value) ?? false;
    },
    executeOwned(contributionId, context, id, value) {
      const owner = active(context).find(
        (contribution) => contribution.id === contributionId,
      );
      if (owner === undefined) return false;
      const exposes = owner
        .controls(context)
        .some((control) => control.id === id);
      if (!exposes) return false;
      return owner.execute(context, id, value);
    },
    ownerOf(context, id) {
      const owner = active(context).find((contribution) =>
        contribution.controls(context).some((control) => control.id === id),
      );
      return owner?.id ?? null;
    },
    entries(context) {
      return active(context).map((contribution) => ({
        contributionId: contribution.id,
        controls: contribution.controls(context),
      }));
    },
    onDidChange(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };

  return {
    registry,
    dispose() {
      contributions.clear();
      listeners.clear();
    },
  };
}

/** Runtime-owned registry: activation/disposal owns every contribution. */
export const documentToolbarRegistryPlugin = definePlugin({
  id: 'froglight.document-toolbar-registry',
  activate: (ctx) => {
    const created = createDocumentToolbarRegistry();
    ctx.provide(documentToolbarRegistryToken, created.registry);
    ctx.effect(() => created.dispose);
  },
});
