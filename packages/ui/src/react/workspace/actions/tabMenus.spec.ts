import { describe, expect, it, vi } from 'vitest';
import type { DockTabView } from '../../../workbench-view.js';
import { buildTabMenuEntries } from './tabMenus.js';

const docTab = (id: string): DockTabView => ({
  id,
  kind: 'document',
  documentId: id,
  viewId: null,
});

function context(
  overrides: Partial<Parameters<typeof buildTabMenuEntries>[0]> = {},
) {
  return {
    pane: 'main',
    desktopLayout: true,
    leafIds: () => ['main'],
    otherTabs: () => [] as DockTabView[],
    canSplitWithTab: true,
    splitWithTab: vi.fn(),
    moveTabToPane: vi.fn(),
    closeTab: vi.fn(),
    closeOtherTabs: vi.fn(),
    closeAllTabs: vi.fn(),
    ...overrides,
  };
}

describe('buildTabMenuEntries', () => {
  it('offers one-gesture splits on desktop only', () => {
    const desktop = buildTabMenuEntries(context());
    expect(
      desktop.map((entry) => (entry === 'separator' ? entry : entry.label)),
    ).toContain('Split right with this tab');
    const phone = buildTabMenuEntries(context({ desktopLayout: false }));
    expect(
      phone.map((entry) => (entry === 'separator' ? entry : entry.label)),
    ).not.toContain('Split right with this tab');
  });

  it('labels a live document split as an empty new pane', () => {
    const entries = buildTabMenuEntries(context({ canSplitWithTab: false }));
    const labels = entries.map((entry) =>
      entry === 'separator' ? entry : entry.label,
    );
    expect(labels).toContain('Split right');
    expect(labels).not.toContain('Split right with this tab');
  });

  it('offers a move fallback only when another pane exists', () => {
    const single = buildTabMenuEntries(context());
    expect(
      single.map((entry) => (entry === 'separator' ? entry : entry.label)),
    ).not.toContain('Move to next pane');
    const multi = buildTabMenuEntries(
      context({ leafIds: () => ['main', 'pane-2'] }),
    );
    expect(
      multi.map((entry) => (entry === 'separator' ? entry : entry.label)),
    ).toContain('Move to next pane');
  });

  it('moves to the next pane in visual order', () => {
    const ctx = context({ leafIds: () => ['main', 'pane-2', 'pane-3'] });
    const entries = buildTabMenuEntries(ctx);
    const move = entries.find(
      (entry) => entry !== 'separator' && entry.label === 'Move to next pane',
    )!;
    expect(move).not.toBe('separator');
    if (move !== 'separator') move.run?.();
    expect(ctx.moveTabToPane).toHaveBeenCalledWith('pane-2');
  });

  it('offers close-others only when other tabs exist', () => {
    const alone = buildTabMenuEntries(context());
    expect(
      alone.map((entry) => (entry === 'separator' ? entry : entry.label)),
    ).not.toContain('Close other tabs');
    const ctx = context({ otherTabs: () => [docTab('doc-2')] });
    const entries = buildTabMenuEntries(ctx);
    const closeOthers = entries.find(
      (entry) => entry !== 'separator' && entry.label === 'Close other tabs',
    )!;
    if (closeOthers !== 'separator') closeOthers.run?.();
    expect(ctx.closeOtherTabs).toHaveBeenCalledTimes(1);
  });

  it('offers close-all even for the only tab and runs its callback', () => {
    const ctx = context();
    const entries = buildTabMenuEntries(ctx);
    const closeAll = entries.find(
      (entry) => entry !== 'separator' && entry.label === 'Close all',
    );
    expect(closeAll).toBeDefined();
    if (closeAll !== undefined && closeAll !== 'separator') closeAll.run?.();
    expect(ctx.closeAllTabs).toHaveBeenCalledTimes(1);
  });

  it('wires split and close runs to their callbacks', () => {
    const ctx = context();
    const entries = buildTabMenuEntries(ctx);
    const split = entries.find(
      (entry) =>
        entry !== 'separator' && entry.label === 'Split down with this tab',
    )!;
    if (split !== 'separator') split.run?.();
    expect(ctx.splitWithTab).toHaveBeenCalledWith('down');
    const close = entries.find(
      (entry) => entry !== 'separator' && entry.label === 'Close tab',
    )!;
    if (close !== 'separator') close.run?.();
    expect(ctx.closeTab).toHaveBeenCalledTimes(1);
  });
});
