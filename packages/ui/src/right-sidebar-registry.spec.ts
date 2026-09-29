import { describe, expect, it } from 'vitest';
import { Runtime, definePlugin } from '@froglight/runtime';
import {
  createRightSidebarRegistry,
  rightSidebarRegistryPlugin,
  rightSidebarRegistryToken,
  type RightSidebarContext,
  type RightSidebarPanelDef,
} from './right-sidebar-registry.js';

const context = (kindId = 'froglight.markdown'): RightSidebarContext => ({
  pane: 'main',
  documentId: 'doc-1',
  kindId,
  title: 'Note',
  path: 'note.md',
  mode: 'edit',
  availableModes: ['edit', 'reading'],
  dirty: false,
  text: '# Note',
  openDocument: () => undefined,
  revealAddress: () => undefined,
  setMode: () => undefined,
  exportPdf: () => undefined,
});

const panel = (
  id: string,
  overrides: Partial<RightSidebarPanelDef> = {},
): RightSidebarPanelDef => ({
  id,
  title: overrides.title ?? id,
  icon: overrides.icon ?? 'file',
  component: overrides.component ?? (() => null),
  ...overrides,
});

describe('right sidebar registry', () => {
  it('registers through an owner scope and cleans up on deactivate/reactivate', async () => {
    const runtime = new Runtime();
    await runtime.registerSlot({
      id: 'right-sidebar-registry',
      plugin: rightSidebarRegistryPlugin,
    });
    let captured:
      | import('./right-sidebar-registry.js').RightSidebarRegistry
      | null = null;
    const owner = definePlugin({
      id: 'test.inspector-owner',
      requirements: { requires: [rightSidebarRegistryToken] },
      activate: (ctx) => {
        captured = ctx.require(rightSidebarRegistryToken);
        ctx.effect(() => captured!.register(panel('test.panel')).dispose);
      },
    });

    await runtime.registerSlot({ id: 'inspector-owner', plugin: owner });
    expect(captured!.list(context()).map(({ id }) => id)).toEqual([
      'test.panel',
    ]);
    await runtime.removeSlot('inspector-owner');
    expect(captured!.list(context())).toEqual([]);
    await runtime.registerSlot({ id: 'inspector-owner', plugin: owner });
    expect(captured!.list(context()).map(({ id }) => id)).toEqual([
      'test.panel',
    ]);
    await runtime.dispose();
  });

  it('filters by document context, sorts, and restores shadowed panels', () => {
    const { registry } = createRightSidebarRegistry();
    const first = registry.register(
      panel('shared', { title: 'First', order: 20 }),
    );
    registry.register(
      panel('markdown-only', {
        title: 'Outline',
        order: 10,
        when: ({ kindId }) => kindId === 'froglight.markdown',
      }),
    );
    const replacement = registry.register(
      panel('shared', { title: 'Replacement', order: 30 }),
    );

    expect(registry.list(context()).map(({ id }) => id)).toEqual([
      'markdown-only',
      'shared',
    ]);
    expect(registry.list(context('froglight.ink')).map(({ id }) => id)).toEqual(
      ['shared'],
    );
    replacement.dispose();
    expect(registry.get('shared')?.title).toBe('First');
    first.dispose();
    expect(registry.get('shared')).toBeUndefined();
  });
});
