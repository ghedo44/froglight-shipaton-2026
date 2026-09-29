// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Runtime, definePlugin, type ServiceToken } from '@froglight/runtime';
import type { ViewRegistry } from './view-registry.js';
import type { WorkspaceService } from '@froglight/foundation';
import {
  InMemorySearchService,
  documentRegistryToken,
  markdownKind,
  markdownKindId,
  markdownModel,
  memoryVaultPlugin,
  relationshipsToken,
  searchToken,
  workspacePath,
  workspacePlugin,
  workspaceToken,
} from '@froglight/foundation';
import { graphViewPlugin, viewRegistryToken } from './index.js';
import { viewRegistryPlugin } from './view-registry.js';

async function compose() {
  const runtime = new Runtime();
  const search = new InMemorySearchService();
  await runtime.registerSlot({ id: 'vault', plugin: memoryVaultPlugin });
  await runtime.registerSlot({
    id: 'search',
    plugin: definePlugin({
      id: 'test.search-binding',
      activate: (ctx) => {
        ctx.provide(searchToken as ServiceToken<InMemorySearchService>, search);
      },
    }),
  });
  await runtime.registerSlot({ id: 'workspace', plugin: workspacePlugin });
  await runtime.registerSlot({
    id: 'markdown-kind',
    plugin: definePlugin({
      id: 'test.markdown-kind',
      requirements: { requires: [documentRegistryToken] },
      activate: (ctx) => {
        ctx.effect(() => ctx.require(documentRegistryToken).register(markdownKind).dispose);
      },
    }),
  });
  await runtime.registerSlot({ id: 'view-registry', plugin: viewRegistryPlugin });
  await runtime.registerSlot({ id: 'graph-view', plugin: graphViewPlugin });

  let views: ViewRegistry | null = null;
  let workspace: WorkspaceService | null = null;
  await runtime.registerSlot({
    id: 'probe',
    plugin: definePlugin({
      id: 'test.pane-area-probe',
      requirements: {
        requires: [viewRegistryToken, workspaceToken, relationshipsToken],
      },
      activate: (ctx) => {
        views = ctx.require(viewRegistryToken);
        workspace = ctx.require(workspaceToken);
      },
    }),
  });
  const registeredViews = requireValue<ViewRegistry>(views);
  const registeredWorkspace = requireValue<WorkspaceService>(workspace);
  return { runtime, views: registeredViews, workspace: registeredWorkspace };
}

function requireValue<T>(value: T | null): T {
  if (value === null) throw new Error('composition failed');
  return value;
}

// jsdom has neither ResizeObserver nor a canvas implementation; the graph
// render contract under test only needs mount/dispose behavior.
class ResizeObserverStub {
  observe(): void { return undefined; }
  disconnect(): void { return undefined; }
  unobserve(): void { return undefined; }
}
(globalThis as Record<string, unknown>).ResizeObserver ??= ResizeObserverStub;
HTMLCanvasElement.prototype.getContext = (() =>
  new Proxy(
    {},
    {
      get: () => () => undefined,
      set: () => true,
    },
  )) as unknown as HTMLCanvasElement['getContext'];

describe('pane-area views', () => {
  it('registers pane-area views and lists them separately from full-area views', async () => {
    const { runtime, views } = await compose();
    const disposer = views.register({
      id: 'test-pane-view',
      area: 'pane',
      title: 'Panes only',
      component: () => null,
    });
    expect(views.list('pane').map((view) => view.id)).toContain('test-pane-view');
    expect(views.list('main').map((view) => view.id)).not.toContain('test-pane-view');
    disposer.dispose();
    expect(views.list('pane').map((view) => view.id)).not.toContain('test-pane-view');
    await runtime.dispose();
  });

  it('rejects views without a component', async () => {
    const { runtime, views } = await compose();
    expect(() =>
      views.register({
        id: 'test-broken-view',
        area: 'pane',
        title: 'Broken',
      } as never),
    ).toThrow(/must provide a React component/);
    await runtime.dispose();
  });

  it('the graph view registers as a component-only pane tab, not a full-area takeover', async () => {
    const { runtime, views, workspace } = await compose();
    await workspace.createDocument({
      kindId: markdownKindId,
      path: workspacePath('note.md'),
      initialModel: markdownModel('# Hi'),
    });
    const graph = views.get('graph');
    expect(graph).toBeDefined();
    expect(graph?.area).toBe('pane');
    expect(graph?.component).toBeDefined();
    expect(graph).not.toHaveProperty('render');
    await runtime.dispose();
  });
});
