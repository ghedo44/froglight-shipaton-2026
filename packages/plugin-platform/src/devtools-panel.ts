import type { Runtime } from '@froglight/runtime';
import { buildExtendedInspection } from './inspection.js';
import type { PermissionBroker } from './permissions.js';

/**
 * Trusted read-only devtools panel.
 * Reuses the same data as `runtime.inspect()` plus permission grants/tier.
 * Read-only — never allows mutation of broker grants or runtime state.
 */

export interface DevtoolsPanelState {
  readonly runtime: ReturnType<Runtime['inspect']>;
  readonly plugins: readonly {
    readonly slotId: string;
    readonly pluginId: string;
    readonly tier: string;
    readonly granted: readonly string[];
    readonly manifestVersion: number;
    readonly source: string;
  }[];
  readonly safeMode: boolean;
}

export function buildDevtoolsPanelState(
  runtime: Runtime,
  pluginInfos: ReadonlyMap<string, { broker: PermissionBroker; source: 'folder' | 'zip'; manifestVersion: number }>,
  safeMode: boolean,
): DevtoolsPanelState {
  const extended = buildExtendedInspection(runtime, pluginInfos);
  return {
    runtime: extended.runtime,
    plugins: extended.plugins,
    safeMode,
  };
}

// Minimal render helper for tests — returns JSON snapshot, never mutates.
export function renderDevtoolsPanel(state: DevtoolsPanelState): string {
  return JSON.stringify(
    {
      runtimeState: state.runtime.runtimeState,
      counts: state.runtime.counts,
      slots: state.runtime.slots.map((s) => ({ id: s.id, state: s.state, failure: s.failure?.message ?? null })),
      fibers: state.runtime.fibers.map((f) => ({
        id: f.id,
        slotId: f.slotId,
        state: f.state,
        bindingCount: f.bindingCount,
        effectCount: f.effectCount,
        hardRequiredTokens: f.hardRequiredTokens,
        softRequiredTokens: f.softRequiredTokens,
        providedTokens: f.providedTokens,
      })),
      bindings: state.runtime.bindings.map((b) => b.token.id),
      retiringBindings: state.runtime.retiringBindings.map((b) => b.token.id),
      graphCycles: state.runtime.graphCycles,
      subscriptions: state.runtime.subscriptions.length,
      plugins: state.plugins,
      safeMode: state.safeMode,
    },
    null,
    2,
  );
}
