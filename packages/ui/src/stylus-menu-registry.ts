import type { MenuEntry } from './menu.js';
import { createServiceToken, definePlugin } from '@froglight/runtime';

/**
 * Plain context available to stylus-menu contributions. Identity only —
 * contributions never receive editor handles, DOM nodes, or services.
 */
export interface StylusMenuContext {
  readonly pane: string;
  readonly documentId: string | null;
  readonly kindId: string | null;
}

/**
 * One reversible plugin contribution to the stylus accessory menu (the
 * GoodNotes-style palette opened by Apple Pencil squeeze and equivalent
 * accessory gestures). Entries are semantic menu data; plugins never
 * receive or return React DOM. The shell owns presentation.
 */
export interface StylusMenuContribution {
  readonly id: string;
  readonly order?: number;
  readonly when?: (context: StylusMenuContext) => boolean;
  entries(context: StylusMenuContext): readonly MenuEntry[];
}

export interface StylusMenuRegistry {
  register(contribution: StylusMenuContribution): { dispose(): void };
  entries(context: StylusMenuContext): readonly MenuEntry[];
  ownerOf(context: StylusMenuContext, index: number): string | null;
  onDidChange(listener: () => void): { dispose(): void };
}

export const stylusMenuRegistryToken = createServiceToken<StylusMenuRegistry>(
  'froglight.stylus-menu-registry',
);

export function createStylusMenuRegistry(): {
  readonly registry: StylusMenuRegistry;
  dispose(): void;
} {
  const contributions = new Map<string, StylusMenuContribution>();
  const listeners = new Set<() => void>();
  const notify = (): void => {
    for (const listener of listeners) listener();
  };
  const active = (context: StylusMenuContext): StylusMenuContribution[] =>
    [...contributions.values()]
      .filter((contribution) => contribution.when?.(context) !== false)
      .sort(
        (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id),
      );

  const registry: StylusMenuRegistry = {
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
    entries(context) {
      const entries: MenuEntry[] = [];
      for (const contribution of active(context)) {
        entries.push(...contribution.entries(context));
      }
      return entries;
    },
    ownerOf(context, index) {
      let cursor = 0;
      for (const contribution of active(context)) {
        const count = contribution.entries(context).length;
        if (index >= cursor && index < cursor + count) return contribution.id;
        cursor += count;
      }
      return null;
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
export const stylusMenuRegistryPlugin = definePlugin({
  id: 'froglight.stylus-menu-registry',
  activate: (ctx) => {
    const created = createStylusMenuRegistry();
    ctx.provide(stylusMenuRegistryToken, created.registry);
    ctx.effect(() => created.dispose);
  },
});
