// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { TabStrip, toTabStripTabs } from './TabStrip.jsx';
import { createViewRegistry } from '../../../view-registry.js';

it('owns only tabs in the tablist while close, switcher and drag remain operable', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onTabClick = vi.fn(), onTabClose = vi.fn(), onOpenSwitcher = vi.fn(), onTabPointerDown = vi.fn();
  try {
    await act(async () => root.render(<TabStrip paneId="main" tabs={[
      { id: 'a', label: 'A', title: 'A', icon: 'file', active: true, dirty: false },
      { id: 'b', label: 'B', title: 'B', icon: 'file', active: false, dirty: false },
    ]} insertAt={null} onTabClick={onTabClick} onTabClose={onTabClose}
      onOpenSwitcher={onOpenSwitcher} onTabPointerDown={onTabPointerDown}
      onTabAuxClick={() => undefined} onTabContextMenu={() => undefined} />));
    const list = host.querySelector('[role="tablist"]')!;
    expect(list.querySelector('button:not([role="tab"])')).toBeNull();
    const owned = (list.getAttribute('aria-owns') ?? '').split(' ').map(id => document.getElementById(id));
    expect(owned.map(el => el?.getAttribute('role'))).toEqual(['tab', 'tab']);
    expect(owned.map(el => el?.getAttribute('aria-selected'))).toEqual(['true', 'false']);
    await act(async () => {
      owned[1]?.click();
      owned[1]?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      host.querySelector<HTMLButtonElement>('[aria-label="Close B"]')?.click();
      host.querySelector<HTMLButtonElement>('[aria-label="Open quick switcher"]')?.click();
    });
    expect(onTabClick).toHaveBeenCalledWith('b', false);
    expect(onTabPointerDown).toHaveBeenCalledOnce();
    expect(onTabClose).toHaveBeenCalledWith('b');
    expect(onOpenSwitcher).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});


it('keeps unsaved and failed-save state on an inactive document tab', () => {
  const views = createViewRegistry();
  try {
    const tabs = toTabStripTabs({
      pane: 'main', activeTab: 'b', mode: 'edit', documentId: 'b', viewId: null,
      title: 'B', path: 'B.md', dirty: false, recoveryWarnings: [],
      canGoBack: false, canGoForward: false,
      tabs: [
        { id: 'a', kind: 'document', documentId: 'a', viewId: null, dirty: true, saveError: true },
        { id: 'b', kind: 'document', documentId: 'b', viewId: null },
      ],
    }, new Map([
      ['a', { title: 'A', path: 'A.md' }],
      ['b', { title: 'B', path: 'B.md' }],
    ]), views.registry);
    expect(tabs[0]).toMatchObject({ active: false, dirty: true, saveError: true });
    expect(tabs[1]).toMatchObject({ active: true, dirty: false, saveError: false });
  } finally {
    views.dispose();
  }
});
