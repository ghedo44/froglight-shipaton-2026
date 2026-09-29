// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { LauncherView } from './LauncherView.jsx';
import { createHarness, makeChoice } from './test-support.js';

const state = vi.hoisted(() => ({
  bindings: [
    {
      localVaultId: 'synced',
      cloudVaultId: 'cloud-a',
      name: 'Research',
      enabled: true,
    },
    {
      localVaultId: 'paused',
      cloudVaultId: 'cloud-b',
      name: 'Archive',
      enabled: false,
    },
  ],
}));
vi.mock('./useVaultSync.jsx', () => ({
  useVaultSyncSnapshot: () => ({ snapshot: state }),
}));

it('partitions remembered vaults and moves a disabled replica back to Local without reloading', async () => {
  const onOpen = vi.fn();
  const binding = state.bindings[0];
  if (binding === undefined) throw new Error('Missing sync fixture');
  const synced = makeChoice({ id: 'synced', name: 'Research' });
  const h = await createHarness([
    synced,
    makeChoice({ id: 'paused', name: 'Archive' }),
    makeChoice({ id: 'local', name: 'Private notes' }),
  ]);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = async () => {
    await act(async () =>
      root.render(<LauncherView vaults={h.adapter} onOpen={onOpen} />),
    );
  };
  try {
    await render();
    const panel = () => host.querySelector('[role="tabpanel"]');
    expect(panel()?.textContent).toContain('Archive');
    expect(panel()?.textContent).toContain('Private notes');
    expect(panel()?.textContent).not.toContain('Research');
    await act(async () =>
      host.querySelector<HTMLButtonElement>('#vault-tab-synced')?.click(),
    );
    expect(panel()?.textContent).toContain('Research');
    expect(panel()?.textContent).not.toContain('Archive');
    await act(async () =>
      host
        .querySelector<HTMLButtonElement>(
          '[data-testid="open-recent-vault-button-0"]',
        )
        ?.click(),
    );
    expect(onOpen).toHaveBeenCalledWith(synced);
    binding.enabled = false;
    await render();
    expect(panel()?.textContent).not.toContain('Research');
    await act(async () =>
      host.querySelector<HTMLButtonElement>('#vault-tab-local')?.click(),
    );
    expect(panel()?.textContent).toContain('Research');
    expect(panel()?.textContent).toContain('Archive');
  } finally {
    binding.enabled = true;
    await act(async () => root.unmount());
    host.remove();
    await h.dispose();
  }
});
