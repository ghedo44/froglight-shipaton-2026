/**
 * Settings section registry — the capability behind the settings modal's
 * navigation. Any plugin (first-party included) registers sections here; the
 * modal renders whatever is currently registered.
 *
 * Semantics mirror the view registry: a later registration for the same id
 * temporarily shadows the previous contribution, and disposing the
 * replacement restores it instead of deleting whatever happens to be there.
 */

import { createServiceToken, definePlugin } from '@froglight/runtime';
import type { ComponentType } from 'react';

export interface SettingsSectionDef {
  /** Stable dot-namespaced identity, e.g. `froglight.appearance`. */
  readonly id: string;
  /** Sidebar label, e.g. "Appearance". */
  readonly name: string;
  /**
   * Sidebar group heading. Core sections use "Options"; plugins pass their
   * own name so users can tell which plugin owns which settings.
   */
  readonly group?: string;
  /** Optional icon name from the shared icon registry. */
  readonly icon?: string;
  /** Sort key within the group (lower first). Unordered sections sort last. */
  readonly order?: number;
  /** Extra search terms beyond the section name. */
  readonly keywords?: readonly string[];
  /**
   * React component mounted directly by the settings modal — the only
   * presentation shape. Trusted UI plugins take it from the UI
   * package React entrypoint.
   */
  readonly component: ComponentType;
}

export interface SettingsSectionRegistry {
  register(section: SettingsSectionDef): { dispose(): void };
  /** Current sections in display order (group rank, then order, then name). */
  list(): readonly SettingsSectionDef[];
  get(id: string): SettingsSectionDef | undefined;
  onDidChange(listener: () => void): { dispose(): void };
}

export const settingsRegistryToken = createServiceToken<SettingsSectionRegistry>(
  'froglight.settings-registry',
);

export interface CreatedSettingsSectionRegistry {
  readonly registry: SettingsSectionRegistry;
  /** Release every change listener (fiber shutdown). */
  dispose(): void;
}

/** Group heading for first-party core sections; sorts before all others. */
export const CORE_SETTINGS_GROUP = 'Options';
const CORE_GROUP = CORE_SETTINGS_GROUP;
/** Group heading used when a section does not declare one. */
export const DEFAULT_SETTINGS_GROUP = 'Plugins';
/** Unordered sections sort after every explicitly ordered one. */
const UNORDERED = Number.MAX_SAFE_INTEGER;

function groupRank(group: string | undefined): number {
  return (group ?? DEFAULT_SETTINGS_GROUP) === CORE_GROUP ? 0 : 1;
}

function compareSections(a: SettingsSectionDef, b: SettingsSectionDef): number {
  const groupDelta = groupRank(a.group) - groupRank(b.group);
  if (groupDelta !== 0) return groupDelta;
  const groupA = a.group ?? DEFAULT_SETTINGS_GROUP;
  const groupB = b.group ?? DEFAULT_SETTINGS_GROUP;
  if (groupA !== groupB) return groupA.localeCompare(groupB);
  const orderDelta = (a.order ?? UNORDERED) - (b.order ?? UNORDERED);
  if (orderDelta !== 0) return orderDelta;
  return a.name.localeCompare(b.name);
}

export function createSettingsSectionRegistry(): CreatedSettingsSectionRegistry {
  const sections = new Map<string, SettingsSectionDef>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };

  const registry: SettingsSectionRegistry = {
    register(section) {
      const previous = sections.get(section.id);
      sections.set(section.id, section);
      notify();
      let disposed = false;
      return {
        dispose() {
          if (disposed) return;
          disposed = true;
          if (sections.get(section.id) !== section) return;
          if (previous === undefined) sections.delete(section.id);
          else sections.set(section.id, previous);
          notify();
        },
      };
    },
    list: () => [...sections.values()].sort(compareSections),
    get: (id) => sections.get(id),
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

export const settingsRegistryPlugin = definePlugin({
  id: 'froglight.settings-registry',
  activate: (ctx) => {
    const created = createSettingsSectionRegistry();
    ctx.provide(settingsRegistryToken, created.registry);
    ctx.effect(() => created.dispose);
  },
});
