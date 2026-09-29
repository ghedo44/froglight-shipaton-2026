// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { Runtime, definePlugin, type ServiceToken } from '@froglight/runtime';
import {
  InMemorySearchService,
  documentRegistryToken,
  markdownKind,
  memoryVaultPlugin,
  relationshipsToken,
  searchToken,
  workspacePlugin,
  workspaceToken,
} from '@froglight/foundation';
import type { ViewDef, ViewRegistry } from '../view-registry.js';
import { viewRegistryPlugin, viewRegistryToken } from '../view-registry.js';
import { graphViewPlugin, type GraphService } from '../graph-view.js';
import type { ForceGraphEdge, ForceGraphNode } from '../graph-force.js';
import { workspaceEvents } from '../ui-events.js';
import { GraphView } from './GraphView.jsx';
import styles from './GraphView.module.css';
import { ViewSlot } from './ViewSlot.jsx';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has neither ResizeObserver nor a canvas implementation; the graph
// render contract under test only needs mount/interaction/dispose behavior.
// Harness pins mirrored from view-registry-pane.spec.ts (read-only).
class ResizeObserverStub {
  observe(): void {
    return undefined;
  }
  disconnect(): void {
    return undefined;
  }
  unobserve(): void {
    return undefined;
  }
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

interface StubGraphService extends GraphService {
  buildCalls(): number;
  emitChange(): void;
}

function stubNode(id: string): ForceGraphNode {
  return { id, x: 0, y: 0, vx: 0, vy: 0, fixed: false };
}

function stubService(
  nodes: readonly ForceGraphNode[] = [stubNode('a'), stubNode('b')],
  edges: readonly ForceGraphEdge[] = [{ source: 'a', target: 'b' }],
): StubGraphService {
  let calls = 0;
  const listeners = new Set<() => void>();
  const labels = new Map([
    ['a', { label: 'Alpha', path: 'a.md', kindId: 'froglight.markdown', kindLabel: 'Markdown' }],
    ['b', { label: 'Beta', path: 'b.md', kindId: 'plugin.diagram', kindLabel: 'Diagram' }],
  ]);
  return {
    async build() {
      calls += 1;
      return {
        nodes: nodes.map((node) => ({ ...node })),
        edges: [...edges],
      };
    },
    labels() {
      return labels;
    },
    onDidChange(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    buildCalls() {
      return calls;
    },
    emitChange() {
      for (const listener of [...listeners]) listener();
    },
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mountThroughSlot(view: ViewDef): Promise<HTMLElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(createElement(ViewSlot, { view }));
  });
  // Flush the async graph rebuild so empty-state and layout settle.
  await act(async () => {
    await Promise.resolve();
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

function componentView(service: GraphService): ViewDef {
  return {
    id: 'graph',
    area: 'pane',
    title: 'Graph',
    component: () => createElement(GraphView, { service }),
  };
}

function canvasOf(mounted: HTMLElement): HTMLCanvasElement {
  const canvas = mounted.querySelector<HTMLCanvasElement>(
    `canvas.${styles['graph-canvas']}`,
  );
  if (canvas === null) throw new Error('graph canvas missing');
  // jsdom has no pointer-capture implementation; the view only needs the
  // capture call not to throw during drag handling.
  (
    canvas as unknown as { setPointerCapture(id: number): void }
  ).setPointerCapture = () => undefined;
  return canvas;
}

function pointerEvent(
  canvas: HTMLCanvasElement,
  type: string,
  x: number,
  y: number,
): void {
  canvas.dispatchEvent(
    new MouseEvent(type, { bubbles: true, clientX: x, clientY: y }),
  );
}

/** Synchronous hover sweep: finds node 'a' (right of center) without drift. */
function locateNode(mounted: HTMLElement, y = 300): { x: number; y: number } {
  const canvas = canvasOf(mounted);
  // Descending: node 'a' initializes at x=592 (angle 0 of the 800x600 seed
  // circle) while node 'b' sits left at x=208, so the first hit is 'a'.
  for (let x = 680; x >= 180; x -= 4) {
    pointerEvent(canvas, 'pointermove', x, y);
    if (canvas.style.cursor === 'pointer') return { x, y };
  }
  throw new Error('no graph node hovered during sweep');
}

function openedDocuments(mounted: HTMLElement): string[] {
  const opened: string[] = [];
  mounted.addEventListener(workspaceEvents.open, (event) => {
    opened.push(
      (event as CustomEvent<{ documentId: string }>).detail.documentId,
    );
  });
  return opened;
}

async function composeGraphView(): Promise<{
  runtime: Runtime;
  views: ViewRegistry;
}> {
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
        ctx.effect(
          () =>
            ctx.require(documentRegistryToken).register(markdownKind).dispose,
        );
      },
    }),
  });
  await runtime.registerSlot({
    id: 'view-registry',
    plugin: viewRegistryPlugin,
  });
  await runtime.registerSlot({ id: 'graph-view', plugin: graphViewPlugin });

  let views: ViewRegistry | null = null;
  await runtime.registerSlot({
    id: 'probe',
    plugin: definePlugin({
      id: 'test.graph-probe',
      requirements: {
        requires: [viewRegistryToken, workspaceToken, relationshipsToken],
      },
      activate: (ctx) => {
        views = ctx.require(viewRegistryToken);
      },
    }),
  });
  if (views === null) throw new Error('composition failed');
  return { runtime, views };
}

describe('graph React view (ViewSlot seam)', () => {
  it('maps every asserted class through the CSS module', () => {
    for (const name of [
      'graph-view',
      'graph-toolbar',
      'graph-canvas-wrap',
      'graph-canvas',
      'graph-empty',
      'hidden',
    ]) {
      expect(styles[name], `module class ${name}`).toMatch(/\S/);
    }
  });

  it('renders the frozen DOM structure: toolbar, canvas, empty state', async () => {
    const mounted = await mountThroughSlot(componentView(stubService()));
    // Theme anchor pin (mirrors theme-shell.spec.ts): the shell styles the
    // graph through its colocated module, so the root hook must survive.
    expect(
      mounted.querySelector('[data-fl-component="graph-view"]'),
    ).not.toBeNull();
    const button = mounted.querySelector<HTMLButtonElement>(
      `.${styles['graph-toolbar']} [data-fl-component="button"][data-variant="secondary"]`,
    );
    expect(button).not.toBeNull();
    expect(button?.type).toBe('button');
    expect(button?.textContent).toBe('Recenter');
    expect(
      mounted.querySelector(
        `.${styles['graph-canvas-wrap']} canvas.${styles['graph-canvas']}`,
      ),
    ).not.toBeNull();
    expect(
      mounted.querySelector(`.${styles['graph-empty']}`)?.textContent,
    ).toBe('No notes yet — create a few and connect them.');
  });

  it('hides the empty state when notes exist', async () => {
    const mounted = await mountThroughSlot(componentView(stubService()));
    expect(
      mounted
        .querySelector(`.${styles['graph-empty']}`)
        ?.classList.contains(styles.hidden),
    ).toBe(true);
  });

  it('groups document types by kind identity even when extensions match', async () => {
    const mounted = await mountThroughSlot(componentView(stubService()));
    const labels = Array.from(mounted.querySelectorAll(`.${styles['graph-format']} span`))
      .map((node) => node.textContent);
    expect(labels).toEqual(['Markdown', 'Diagram']);
  });

  it('shows the empty state when the vault has no notes', async () => {
    const mounted = await mountThroughSlot(componentView(stubService([], [])));
    const empty = mounted.querySelector(`.${styles['graph-empty']}`);
    expect(empty).not.toBeNull();
    expect(empty?.classList.contains(styles.hidden)).toBe(false);
  });

  it('recenters without rebuilding derived connections', async () => {
    const service = stubService();
    const mounted = await mountThroughSlot(componentView(service));
    expect(service.buildCalls()).toBe(1);
    const button = mounted.querySelector<HTMLElement>(
      `.${styles['graph-toolbar']} [data-fl-component="button"]`,
    );
    await act(async () => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(service.buildCalls()).toBe(1);
  });

  it('refreshes automatically when the completed projection changes', async () => {
    const service = stubService();
    await mountThroughSlot(componentView(service));
    expect(service.buildCalls()).toBe(1);
    await act(async () => service.emitChange());
    expect(service.buildCalls()).toBe(2);
  });

  it('opens the document on node click without a drag', async () => {
    const mounted = await mountThroughSlot(componentView(stubService()));
    const opened = openedDocuments(mounted);
    const at = locateNode(mounted);
    const canvas = canvasOf(mounted);
    act(() => {
      pointerEvent(canvas, 'pointerdown', at.x, at.y);
      pointerEvent(canvas, 'pointerup', at.x, at.y);
    });
    expect(opened).toEqual(['a']);
  });

  it('does not open when the pointer drags away from the node', async () => {
    const mounted = await mountThroughSlot(componentView(stubService()));
    const opened = openedDocuments(mounted);
    const at = locateNode(mounted);
    const canvas = canvasOf(mounted);
    act(() => {
      pointerEvent(canvas, 'pointerdown', at.x, at.y);
      pointerEvent(canvas, 'pointermove', at.x + 60, at.y + 60);
      pointerEvent(canvas, 'pointerup', at.x + 60, at.y + 60);
    });
    expect(opened).toEqual([]);
  });

  it('highlights hovered nodes with a pointer cursor', async () => {
    const mounted = await mountThroughSlot(componentView(stubService()));
    const canvas = canvasOf(mounted);
    expect(canvas.style.cursor).not.toBe('pointer');
    locateNode(mounted);
    expect(canvas.style.cursor).toBe('pointer');
    act(() => {
      pointerEvent(canvas, 'pointermove', 400, 590);
    });
    // Far from every node the hover clears back to the grab cursor.
    expect(canvas.style.cursor).toBe('grab');
  });

  it('keeps wheel zoom non-passive so pinch/scroll never scrolls the page', async () => {
    const mounted = await mountThroughSlot(componentView(stubService()));
    const canvas = canvasOf(mounted);
    const event = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: -100,
    });
    canvas.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('mounts the component through the ViewSlot seam', async () => {
    const service = stubService();
    const mounted = await mountThroughSlot(componentView(service));
    expect(mounted.querySelector(`.${styles['graph-view']}`)).not.toBeNull();
    expect(
      mounted.querySelector(
        `.${styles['graph-toolbar']} [data-fl-component="button"]`,
      )?.textContent,
    ).toBe('Recenter');
    expect(
      mounted.querySelector(`canvas.${styles['graph-canvas']}`),
    ).not.toBeNull();
  });

  it('dispose removes change listeners before remount', async () => {
    const service = stubService();
    await mountThroughSlot(componentView(service));
    unmount();
    const mounted = await mountThroughSlot(componentView(service));
    const callsAfterRemount = service.buildCalls();
    await act(async () => service.emitChange());
    expect(service.buildCalls()).toBe(callsAfterRemount + 1);
    expect(
      mounted.querySelectorAll(
        `.${styles['graph-toolbar']} > [data-fl-component="button"]`,
      ).length,
    ).toBe(1);
  });

  it('the graph view registers as a component-only pane tab', async () => {
    const { runtime, views } = await composeGraphView();
    const graph = views.get('graph');
    expect(graph).toBeDefined();
    expect(graph?.area).toBe('pane');
    expect(graph?.component).toBeDefined();
    expect(graph).not.toHaveProperty('render');
    await runtime.dispose();
  });
});
