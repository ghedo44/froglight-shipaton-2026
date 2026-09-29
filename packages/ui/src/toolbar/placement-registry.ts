/**
 * Unified toolbar placement registry.
 *
 * Placements are the UI-owned presentation layouts consumed by the unified
 * document toolbar. A placement maps stable semantic control ids to one
 * geometric anchor — the pane top-bar center or one of the eight
 * pane-scoped floating anchors — with document-kind/context predicates,
 * deterministic ordering, and responsive hints.
 *
 * The registry follows the repository's standard effect-owned registry
 * pattern: registration is reversible, re-registering the same placement id
 * shadows and disposal restores the previous binding. Resolution order is
 * deterministic (`order`, then `id`) and never depends on activation order.
 *
 * Trusted same-realm authority only: placements are plain
 * data, but the registry token is not exposed to Worker-sandboxed plugins
 * until a declarative untrusted UI model exists. Placement contributions
 * never return arbitrary editor DOM and never mutate provider roots.
 */

import { createServiceToken, definePlugin } from '@froglight/runtime';
import type { DocumentToolbarContext } from '../document-toolbar-registry.js';

/** Stable geometric anchors for unified toolbar placement. */
export type ToolbarAnchor =
  | 'topbar-center'
  | 'float.top-left'
  | 'float.top-center'
  | 'float.top-right'
  | 'float.left-center'
  | 'float.right-center'
  | 'float.bottom-left'
  | 'float.bottom-center'
  | 'float.bottom-right'
  | 'float.selection';

export const TOOLBAR_ANCHORS: readonly ToolbarAnchor[] = [
  'topbar-center',
  'float.top-left',
  'float.top-center',
  'float.top-right',
  'float.left-center',
  'float.right-center',
  'float.bottom-left',
  'float.bottom-center',
  'float.bottom-right',
  'float.selection',
];

export const FLOATING_TOOLBAR_ANCHORS: readonly Exclude<
  ToolbarAnchor,
  'topbar-center'
>[] = [
  'float.top-left',
  'float.top-center',
  'float.top-right',
  'float.left-center',
  'float.right-center',
  'float.bottom-left',
  'float.bottom-center',
  'float.bottom-right',
  'float.selection',
];

/**
 * One reversible placement contribution: where stable semantic controls
 * render. `controlIds` reference semantic `DocumentToolControl` ids owned by
 * editor providers or document-toolbar contributions; placement never owns
 * editor-library state.
 */
export interface ToolbarPlacementContribution {
  /** Registration identity; re-registering shadows and disposal restores. */
  readonly id: string;
  /** Kinds this placement applies to; omitted applies to every kind. */
  readonly kindIds?: readonly string[];
  readonly anchor: ToolbarAnchor;
  /** Deterministic position among placements sharing an anchor. */
  readonly order?: number;
  readonly when?: (context: DocumentToolbarContext) => boolean;
  /** Semantic control ids in render order; absent ids are skipped. */
  readonly controlIds: readonly string[];
  /**
   * Responsive importance: higher survives compaction longer. Lower-priority
   * controls move into overflow first. Defaults to 0.
   */
  readonly priority?: number;
  /** Compact presentation hint; `auto` lets the shell decide. */
  readonly compact?: ToolbarCompactMode;
}

/** Responsive compaction policy for one placement group. */
export type ToolbarCompactMode = 'auto' | 'always' | 'never';

export interface ToolbarPlacementRegistry {
  register(contribution: ToolbarPlacementContribution): { dispose(): void };
  /** Active placements matching `context`, in deterministic order. */
  placementsFor(
    context: DocumentToolbarContext,
  ): readonly ToolbarPlacementContribution[];
  onDidChange(listener: () => void): { dispose(): void };
}

export const documentToolbarPlacementToken =
  createServiceToken<ToolbarPlacementRegistry>(
    'froglight.document-toolbar-placement',
  );

export function createToolbarPlacementRegistry(): {
  readonly registry: ToolbarPlacementRegistry;
  dispose(): void;
} {
  interface Entry {
    readonly contribution: ToolbarPlacementContribution;
    readonly previous: Entry | null;
  }
  const entries = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  const matches = (
    contribution: ToolbarPlacementContribution,
    context: DocumentToolbarContext,
  ): boolean => {
    if (
      contribution.kindIds !== undefined &&
      !contribution.kindIds.includes(context.kindId)
    )
      return false;
    return contribution.when?.(context) !== false;
  };

  const registry: ToolbarPlacementRegistry = {
    register(contribution) {
      const previous = entries.get(contribution.id) ?? null;
      entries.set(contribution.id, { contribution, previous });
      notify();
      let disposed = false;
      return {
        dispose() {
          if (disposed) return;
          disposed = true;
          if (entries.get(contribution.id)?.contribution !== contribution)
            return;
          if (previous === null) entries.delete(contribution.id);
          else entries.set(contribution.id, previous);
          notify();
        },
      };
    },
    placementsFor(context) {
      return [...entries.values()]
        .map((entry) => entry.contribution)
        .filter((contribution) => matches(contribution, context))
        .sort(
          (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id),
        );
    },
    onDidChange(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };

  return {
    registry,
    dispose() {
      entries.clear();
      listeners.clear();
    },
  };
}

export type ToolbarPlacementPluginConfig = {
  /** Default placements (first-party document layouts), owned by the slot. */
  readonly placements?: readonly ToolbarPlacementContribution[];
};

/** Runtime-owned registry: activation/disposal owns every default placement. */
export const documentToolbarPlacementPlugin =
  definePlugin<ToolbarPlacementPluginConfig>({
    id: 'froglight.document-toolbar-placement',
    activate: (ctx) => {
      const created = createToolbarPlacementRegistry();
      const disposers = (ctx.config.placements ?? []).map((placement) =>
        created.registry.register(placement),
      );
      ctx.provide(documentToolbarPlacementToken, created.registry);
      ctx.effect(() => () => {
        for (const disposer of disposers) disposer.dispose();
        created.dispose();
      });
    },
  });
