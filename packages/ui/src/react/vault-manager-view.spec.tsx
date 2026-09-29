// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { Runtime, definePlugin } from '@froglight/runtime';
import type { ViewDef } from '../view-registry.js';
import { viewRegistryToken, viewRegistryPlugin } from '../view-registry.js';
import { vaultManagerPlugin, vaultManagerToken } from '../vault-manager.js';
import type { VaultManagerService } from '../vault-manager.js';
import { VaultManagerView } from './VaultManagerView.jsx';
import { ViewSlot } from './ViewSlot.jsx';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

function vaultComponentView(): ViewDef {
  return {
    id: 'vault-switcher',
    area: 'header',
    title: 'Vault',
    component: VaultManagerView,
  };
}

async function mountView(view: ViewDef): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(createElement(ViewSlot, { view }));
  });
  return host;
}

function unmount(): void {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
}

afterEach(unmount);

async function captureVaultManager(): Promise<{
  runtime: Runtime;
  manager: VaultManagerService;
  view: ViewDef | undefined;
}> {
  const runtime = new Runtime();
  await runtime.registerSlot({ id: 'views', plugin: viewRegistryPlugin });
  await runtime.registerSlot({ id: 'vault-manager', plugin: vaultManagerPlugin });
  let manager: VaultManagerService | null = null;
  let view: ViewDef | undefined;
  await runtime.registerSlot({
    id: 'vault-manager-probe',
    plugin: definePlugin({
      id: 'test.vault-manager-probe',
      requirements: { requires: [viewRegistryToken, vaultManagerToken] },
      activate: (ctx) => {
        manager = ctx.require(vaultManagerToken);
        view = ctx.require(viewRegistryToken).get('vault-switcher');
      },
    }),
  });
  if (manager === null) throw new Error('vault manager did not activate');
  return { runtime, manager, view };
}

describe('vault manager React view (ViewSlot seam)', () => {
  it('renders an empty vault-switcher element with no handlers', async () => {
    const mounted = await mountView(vaultComponentView());
    const switcher = mounted.querySelector('.vault-switcher');
    expect(switcher).not.toBeNull();
    expect(switcher?.textContent).toBe('');
    expect(switcher?.querySelectorAll('*').length).toBe(0);
  });

  it('mounts the registered vault-switcher component and disposes it on unmount', async () => {
    const { runtime, view } = await captureVaultManager();
    try {
      expect(view).toBeDefined();
      expect(view?.component).toBe(VaultManagerView);
      expect(view).not.toHaveProperty('render');
      const mounted = await mountView(view!);
      expect(mounted.querySelector('.vault-switcher')).not.toBeNull();
      unmount();
      expect(host).toBeNull();
      expect(document.querySelector('.vault-switcher')).toBeNull();
    } finally {
      await runtime.dispose();
    }
  });

  it('vault-manager plugin allows create/open vault', async () => {
    const { runtime, manager } = await captureVaultManager();
    try {
      const created = await manager.createVault('Second');
      expect(manager.listVaults().length).toBeGreaterThanOrEqual(2);
      expect(manager.getCurrent()?.id).toBe(created.id);
      const first = manager.listVaults()[0]!;
      await manager.openVault(first.id);
      expect(manager.getCurrent()?.id).toBe(first.id);
    } finally {
      await runtime.dispose();
    }
  });
});
