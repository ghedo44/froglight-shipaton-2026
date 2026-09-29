// @vitest-environment jsdom
/**
 * UI service-probe lifecycle across launcher/workspace transitions.
 *
 * Native startup orders `createApp(...)` → `installDefaultUi(...)` →
 * `app.closeVault()` → `mountFroglightApp(...)`. Withdrawing the bootstrap
 * vault tears down every workspace-scoped provider. Host-lifetime keyboard
 * state must remain independently observable, while workspace-scoped
 * search/settings/explorer references clear and reactivate with the vault.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { Runtime, definePlugin } from '@froglight/runtime';
import {
  InMemorySearchService,
  createKeyboardInset,
  documentId,
  keyboardInsetToken,
  memoryVaultPlugin,
  resourceId,
  searchToken,
  settingsToken,
  workspacePlugin,
} from '@froglight/foundation';
import {
  installDefaultUi,
  mountFroglightApp,
  type InstalledUi,
  type WorkbenchMount,
} from './workbench.js';
import { fileExplorerToken } from './file-explorer.js';
import { workspaceSettingsToken } from './workspace-settings.js';
import { settingsRegistryToken } from './settings-registry.js';
import { detachKeyboardShell } from './platform/keyboard-inset.js';
import {
  createFakeVaultAdapter,
  createFakeWorkbenchController,
} from './react/test-support.js';

interface NativeOrderingHarness {
  readonly runtime: Runtime;
  readonly keyboard: ReturnType<typeof createKeyboardInset>;
  readonly search: InMemorySearchService;
  readonly ui: InstalledUi;
}

async function registerWorkspaceChain(
  runtime: Runtime,
  search: InMemorySearchService,
): Promise<void> {
  await runtime.registerSlot({ id: 'vault', plugin: memoryVaultPlugin });
  await runtime.registerSlot({
    id: 'search',
    plugin: definePlugin({
      id: 'test.search-binding',
      activate: (ctx) => {
        ctx.provide(searchToken, search);
      },
    }),
  });
  await runtime.registerSlot({ id: 'workspace', plugin: workspacePlugin });
}

/** Mirror the real native bootstrap ordering before `closeVault()`. */
async function createNativeOrderingHarness(): Promise<NativeOrderingHarness> {
  const runtime = new Runtime();
  const keyboard = createKeyboardInset();
  await runtime.registerSlot({
    id: 'keyboard-inset',
    plugin: keyboard.definition,
  });
  const search = new InMemorySearchService();
  await registerWorkspaceChain(runtime, search);
  const ui = await installDefaultUi(runtime);
  return { runtime, keyboard, search, ui };
}

/** `app.closeVault()` withdraws the vault slot and its dependent chain. */
async function closeVault(runtime: Runtime): Promise<void> {
  await runtime.removeSlot('vault');
}

function slotState(runtime: Runtime, id: string): string | undefined {
  return runtime.inspect().slots.find((slot) => slot.id === id)?.state;
}

let harness: NativeOrderingHarness | null = null;
let mounted: WorkbenchMount | null = null;

afterEach(async () => {
  if (mounted !== null) {
    await act(async () => {
      await mounted!.dispose();
    });
    mounted = null;
  }
  detachKeyboardShell();
  document.documentElement.style.removeProperty('--fl-keyboard-inset-height');
  document.body.innerHTML = '';
  if (harness !== null) {
    await harness.runtime.dispose();
    harness.keyboard.store.dispose();
    harness = null;
  }
});

describe('keyboard capability survives the launcher transition (Test A)', () => {
  it('retains the host keyboard store identity across closeVault', async () => {
    harness = await createNativeOrderingHarness();
    const { runtime, keyboard, ui } = harness;

    expect(ui.services.try(keyboardInsetToken)).toBe(keyboard.store);
    expect(slotState(runtime, 'ui-keyboard-inset-probe')).toBe('active');

    await closeVault(runtime);

    // The keyboard has its own host-lifetime probe, so workspace withdrawal
    // cannot dispose or null its capture.
    expect(ui.services.try(keyboardInsetToken)).toBe(keyboard.store);
    expect(slotState(runtime, 'ui-keyboard-inset-probe')).toBe('active');

    // UI-owned registries survive; workspace-scoped refs clear.
    expect(ui.services.try(settingsRegistryToken)).toBeDefined();
    expect(ui.services.try(workspaceSettingsToken)).toBeUndefined();
    expect(ui.services.try(settingsToken)).toBeUndefined();
    expect(ui.services.try(fileExplorerToken)).toBeUndefined();
  });
});

describe('mounted launcher reacts to keyboard after closeVault (Test B)', () => {
  it('applies an exact keyboard target through the real mount path', async () => {
    harness = await createNativeOrderingHarness();
    const { runtime, keyboard, ui } = harness;
    await closeVault(runtime);

    const root = document.createElement('div');
    document.body.appendChild(root);
    const controller = createFakeWorkbenchController();
    const adapter = createFakeVaultAdapter();
    await act(async () => {
      mounted = await mountFroglightApp(root, controller, adapter, ui);
    });

    keyboard.store.handleNativeEvent('target', {
      height: 320,
      durationMs: 250,
      measurement: 'exact',
    });
    expect(
      document.documentElement.style.getPropertyValue(
        '--fl-keyboard-inset-height',
      ),
    ).toBe('320px');
  });
});

describe('search lifecycle across vault close/reopen (Test C)', () => {
  it('serves live search, falls back empty in the launcher, re-observes on reopen', async () => {
    harness = await createNativeOrderingHarness();
    const { runtime, search, ui } = harness;
    search.indexDocument(
      documentId('doc-1'),
      { resourceId: resourceId('res-1') },
      '# Meeting notes\n\nThe launcher-regression phrase lives here.',
    );

    await expect(ui.search.search('launcher-regression')).resolves.toEqual([
      expect.objectContaining({ documentId: 'doc-1' }),
    ]);

    await closeVault(runtime);
    await expect(ui.search.search('launcher-regression')).resolves.toEqual([]);

    await runtime.registerSlot({ id: 'vault', plugin: memoryVaultPlugin });
    await expect(ui.search.search('launcher-regression')).resolves.toEqual([
      expect.objectContaining({ documentId: 'doc-1' }),
    ]);
  });
});

describe('probe lifecycle ownership (Test D)', () => {
  it('keeps host probes active while workspace probes dispose/reactivate', async () => {
    harness = await createNativeOrderingHarness();
    const { runtime, keyboard, ui } = harness;

    expect(slotState(runtime, 'ui-registry-probe')).toBe('active');
    expect(slotState(runtime, 'ui-keyboard-inset-probe')).toBe('active');
    expect(slotState(runtime, 'ui-search-probe')).toBe('active');
    expect(slotState(runtime, 'ui-workspace-settings-probe')).toBe('active');
    expect(slotState(runtime, 'ui-settings-probe')).toBe('active');
    expect(slotState(runtime, 'ui-file-explorer-probe')).toBe('active');
    expect(ui.services.try(keyboardInsetToken)).toBe(keyboard.store);
    const initialSettings = ui.services.try(settingsToken);
    expect(initialSettings).toBeDefined();

    await closeVault(runtime);
    expect(slotState(runtime, 'ui-registry-probe')).toBe('active');
    expect(slotState(runtime, 'ui-keyboard-inset-probe')).toBe('active');
    expect(slotState(runtime, 'ui-search-probe')).not.toBe('active');
    expect(slotState(runtime, 'ui-workspace-settings-probe')).not.toBe(
      'active',
    );
    expect(slotState(runtime, 'ui-settings-probe')).not.toBe('active');
    expect(slotState(runtime, 'ui-file-explorer-probe')).not.toBe('active');
    expect(ui.services.try(keyboardInsetToken)).toBe(keyboard.store);
    expect(ui.services.try(workspaceSettingsToken)).toBeUndefined();
    expect(ui.services.try(settingsToken)).toBeUndefined();
    expect(ui.services.try(fileExplorerToken)).toBeUndefined();
    await expect(ui.search.search('anything')).resolves.toEqual([]);

    await runtime.registerSlot({ id: 'vault', plugin: memoryVaultPlugin });
    expect(slotState(runtime, 'ui-registry-probe')).toBe('active');
    expect(slotState(runtime, 'ui-keyboard-inset-probe')).toBe('active');
    expect(slotState(runtime, 'ui-search-probe')).toBe('active');
    expect(slotState(runtime, 'ui-workspace-settings-probe')).toBe('active');
    expect(slotState(runtime, 'ui-settings-probe')).toBe('active');
    expect(slotState(runtime, 'ui-file-explorer-probe')).toBe('active');
    expect(ui.services.try(keyboardInsetToken)).toBe(keyboard.store);
    expect(ui.services.try(workspaceSettingsToken)).toBeDefined();
    expect(ui.services.try(settingsToken)).toBeDefined();
    expect(ui.services.try(settingsToken)).not.toBe(initialSettings);
    expect(ui.services.try(fileExplorerToken)).toBeDefined();
  });
});

describe('late host capability lifecycle (Test E)', () => {
  it('observes a keyboard provider added, withdrawn, and replaced after UI install', async () => {
    const runtime = new Runtime();
    const search = new InMemorySearchService();
    const first = createKeyboardInset();
    const second = createKeyboardInset();
    try {
      await registerWorkspaceChain(runtime, search);
      const ui = await installDefaultUi(runtime);

      expect(ui.services.try(keyboardInsetToken)).toBeUndefined();
      expect(slotState(runtime, 'ui-keyboard-inset-probe')).not.toBe('active');

      await runtime.registerSlot({
        id: 'keyboard-inset',
        plugin: first.definition,
      });
      expect(slotState(runtime, 'ui-keyboard-inset-probe')).toBe('active');
      expect(ui.services.try(keyboardInsetToken)).toBe(first.store);

      await runtime.removeSlot('keyboard-inset');
      expect(slotState(runtime, 'ui-keyboard-inset-probe')).not.toBe('active');
      expect(ui.services.try(keyboardInsetToken)).toBeUndefined();

      await runtime.registerSlot({
        id: 'keyboard-inset',
        plugin: second.definition,
      });
      expect(slotState(runtime, 'ui-keyboard-inset-probe')).toBe('active');
      expect(ui.services.try(keyboardInsetToken)).toBe(second.store);
    } finally {
      await runtime.dispose();
      first.store.dispose();
      second.store.dispose();
    }
  });
});
