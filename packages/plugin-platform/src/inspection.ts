import type { Runtime } from '@froglight/runtime';
import type { PermissionBroker } from './permissions.js';
import type { TrustTier } from '@froglight/sdk';

/** Extended inspection including permissions and package trust. */
export interface PluginInspectionEntry {
  readonly slotId: string;
  readonly pluginId: string;
  readonly tier: TrustTier;
  readonly granted: readonly string[];
  readonly manifestVersion: number;
  readonly source: 'folder' | 'zip';
}

export interface ExtendedInspection {
  readonly runtime: ReturnType<Runtime['inspect']>;
  readonly plugins: readonly PluginInspectionEntry[];
}

/**
 * Build extended inspection snapshot. The runtime's own `inspect()` already
 * covers slots/fibers/services/effects/retiringBindings/cycles/timings/failures;
 * this adds permission grants and tier labeling.
 */
export function buildExtendedInspection(
  runtime: Runtime,
  pluginInfos: ReadonlyMap<string, { broker: PermissionBroker; source: 'folder' | 'zip'; manifestVersion: number }>,
): ExtendedInspection {
  const base = runtime.inspect();
  const plugins: PluginInspectionEntry[] = base.slots.map((s) => {
    const info = pluginInfos.get(s.id);
    return {
      slotId: s.id,
      pluginId: s.pluginId,
      tier: info ? (info.broker as any).tier as TrustTier : 'trusted',
      granted: info ? [...info.broker.granted] : [],
      manifestVersion: info?.manifestVersion ?? 1,
      source: info?.source ?? 'folder',
    };
  });
  return { runtime: base, plugins };
}
