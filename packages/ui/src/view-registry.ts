import type { ComponentType } from 'react';
import { createServiceToken, definePlugin } from '@froglight/runtime';
import type { IconName } from './icons.js';

/**
 * View-id namespace for raw-file preview tabs; the remainder of the id is
 * the vault path. Shared by the explorer (which dispatches open events
 * carrying such view ids) and the shell (which registers and resolves them).
 */
export const PREVIEW_VIEW_ID_PREFIX = 'preview:';

export interface ViewDef {
  readonly id: string;
  /**
   * Where the shell mounts the view: `sidebar` panels,
   * the per-tab document `header`, a `pane` tab beside documents, `main`
   * (a full-area takeover below the titlebar), or an `activity` window.
   */
  readonly area: 'sidebar' | 'header' | 'pane' | 'main' | 'activity';
  readonly title?: string;
  /** Icon for the tab strip or activity rail. */
  readonly icon?: IconName;
  /** Longer tab hover text (e.g. the full path behind a preview tab). */
  readonly description?: string;
  /**
   * React component mounted inside the view slot — the only presentation
   * shape. Trusted UI plugins take it from the UI package React
   * entrypoint; the generic plugin-platform container stays
   * framework-agnostic and carries no presentation member.
   */
  readonly component: ComponentType;
}

export interface ViewRegistry {
  register(view: ViewDef): { dispose(): void };
  list(area?: ViewDef['area']): readonly ViewDef[];
  get(id: string): ViewDef | undefined;
  onDidChange(listener: () => void): { dispose(): void };
}

export const viewRegistryToken = createServiceToken<ViewRegistry>(
  'froglight.view-registry',
);

export interface CreatedViewRegistry {
  readonly registry: ViewRegistry;
  /** Release every change listener (fiber shutdown). */
  dispose(): void;
}

/**
 * View registry with reversible replacement semantics.
 *
 * A later registration for the same id temporarily shadows the previous
 * contribution. Disposing the replacement restores the previous view instead
 * of deleting whatever happens to be registered at that id.
 */
export function createViewRegistry(): CreatedViewRegistry {
  const views = new Map<string, ViewDef>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };

  const registry: ViewRegistry = {
    register(view) {
      if (typeof view.component !== 'function') {
        throw new Error(`view "${view.id}" must provide a React component`);
      }
      const previous = views.get(view.id);
      views.set(view.id, view);
      notify();
      let disposed = false;
      return {
        dispose() {
          if (disposed) return;
          disposed = true;
          if (views.get(view.id) !== view) return;
          if (previous === undefined) views.delete(view.id);
          else views.set(view.id, previous);
          notify();
        },
      };
    },
    list: (area) =>
      area
        ? [...views.values()].filter((view) => view.area === area)
        : [...views.values()],
    get: (id) => views.get(id),
    onDidChange(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };

  return {
    registry,
    dispose: () => listeners.clear(),
  };
}

export const viewRegistryPlugin = definePlugin({
  id: 'froglight.view-registry',
  activate: (ctx) => {
    const created = createViewRegistry();
    ctx.provide(viewRegistryToken, created.registry);
    ctx.effect(() => created.dispose);
  },
});
