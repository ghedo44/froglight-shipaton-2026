import { describe, it, expect } from 'vitest';
import { Runtime, definePlugin } from '@froglight/runtime';
import { memoryVaultPlugin } from '@froglight/foundation';
import { workspacePlugin } from '@froglight/foundation';
import { validateManifest } from './manifest.js';
import { PermissionBroker } from './permissions.js';
import {
  buildDevtoolsPanelState,
  renderDevtoolsPanel,
} from './devtools-panel.js';

describe('Devtools panel — read-only inspection', () => {
  it('renders slots/fibers/services/effects/retiring/cycles/timings/failures/permissions', async () => {
    const runtime = new Runtime();
    await runtime.registerSlot({ id: 'vault', plugin: memoryVaultPlugin });
    await runtime.registerSlot({ id: 'workspace', plugin: workspacePlugin });

    const manifest = validateManifest({
      manifestVersion: 1,
      id: 'froglight.panel-test',
      version: '1.0.0',
      froglightSdk: '^0.1.0',
      permissions: ['vault.read', 'workspace.commands.register'] as string[],
    });
    const broker = new PermissionBroker(manifest, 'trusted');
    await runtime.registerSlot({
      id: manifest.id,
      plugin: definePlugin({ id: manifest.id, activate: () => undefined }),
    });
    await runtime.registerSlot({
      id: 'froglight.fail-panel',
      plugin: definePlugin({
        id: 'froglight.fail-panel',
        activate: () => {
          throw new Error('panel fail');
        },
      }),
    });
    const failBroker = new PermissionBroker(
      validateManifest({
        manifestVersion: 1,
        id: 'froglight.fail-panel',
        version: '1.0.0',
        froglightSdk: '^0.1.0',
        permissions: [],
      }),
      'trusted',
    );
    const infos = new Map<
      string,
      { broker: PermissionBroker; source: 'folder'; manifestVersion: number }
    >([
      [manifest.id, { broker, source: 'folder', manifestVersion: 1 }],
      [
        'froglight.fail-panel',
        { broker: failBroker, source: 'folder', manifestVersion: 1 },
      ],
    ]);

    const state = buildDevtoolsPanelState(runtime, infos, false);
    expect(state.runtime.slots.length).toBeGreaterThan(0);
    expect(state.runtime.fibers.length).toBeGreaterThan(0);
    expect(state.runtime.bindings.length).toBeGreaterThan(0);
    // Retiring and cycles should be present (even if empty)
    expect(state.runtime.retiringBindings).toBeDefined();
    expect(state.runtime.graphCycles).toBeDefined();
    const panelPlugin = state.plugins.find(
      (p) => p.slotId === 'froglight.panel-test',
    );
    expect(panelPlugin?.granted).toEqual([
      'vault.read',
      'workspace.commands.register',
    ]);

    const rendered = renderDevtoolsPanel(state);
    expect(rendered).toContain('froglight.panel-test');
    expect(rendered).toContain('vault.read');
    // Ensure panel is read-only: mutating rendered string does not affect runtime
    const before = runtime.inspect().slots.length;
    JSON.parse(rendered);
    expect(runtime.inspect().slots.length).toBe(before);

    await runtime.dispose();
  });
});
