// @vitest-environment jsdom
/**
 * Settings execution ownership.
 *
 * Trusted plugin settings for another tool must retain their contribution
 * owner end-to-end: `computeUnifiedToolbarModel` preserves ownership and
 * every settings popover (topbar placement groups + composition shelf)
 * executes through the resolved owner via `executeOwned`.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { DocumentToolControl } from '@froglight/foundation';
import type { DocumentToolSnapshot } from '@froglight/foundation';
import type { WorkbenchEditorToolsPort } from '../workbench-ports.js';
import { createDocumentToolbarRegistry } from '../document-toolbar-registry.js';
import { createToolbarPlacementRegistry } from '../toolbar/placement-registry.js';
import { createToolbarCompositionRegistry } from '../toolbar/composition-registry.js';
import {
  computeUnifiedToolbarModel,
  FloatingToolbarLayer,
  TopbarCenterTools,
} from './UnifiedToolbar.jsx';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function penTool(active: boolean): DocumentToolControl {
  return {
    kind: 'button',
    id: 'ink.tool.pen',
    group: 'draw',
    label: 'Pen',
    shortLabel: 'Pen',
    role: 'surface-tool',
    toolId: 'ink.tool.pen',
    semanticRole: 'surface.pen.ball',
    active,
  };
}

function pluginSettings(): DocumentToolControl {
  return {
    kind: 'choice',
    id: 'ink.settings.pen.size',
    group: 'settings',
    label: 'Size',
    value: '3.5',
    options: [
      { value: '2', label: 'Thin' },
      { value: '3.5', label: 'Medium' },
      { value: '6', label: 'Thick' },
    ],
  };
}

function providerSettings(): DocumentToolControl {
  return {
    kind: 'choice',
    id: 'ink.settings.pen.size',
    group: 'settings',
    label: 'Size',
    value: '3.5',
    options: [
      { value: '2', label: 'Thin' },
      { value: '3.5', label: 'Medium' },
      { value: '6', label: 'Thick' },
    ],
  };
}

function makeTools(snapshot: DocumentToolSnapshot): {
  calls: Array<readonly [id: string, value?: string]>;
  port: WorkbenchEditorToolsPort;
} {
  const calls: Array<readonly [id: string, value?: string]> = [];
  return {
    calls,
    port: {
      onDidChange: () => ({ dispose: () => undefined }),
      execEditorCommand: () => false,
      canExecEditorCommand: () => true,
      editorToolSnapshot: () => snapshot,
      executeEditorTool: (_pane: string, id: string, value?: string) => {
        calls.push([id, value] as const);
        return true;
      },
    } as unknown as WorkbenchEditorToolsPort,
  };
}

describe('settings execution ownership', () => {
  it('preserves contribution ownership for unplaced settings controls', () => {
    const snapshot: DocumentToolSnapshot = {
      context: 'Ink canvas',
      controls: [penTool(true)],
    };
    const tools = makeTools(snapshot);
    const contributions = createDocumentToolbarRegistry();
    const placements = createToolbarPlacementRegistry();
    placements.registry.register({
      id: 'test.primary',
      anchor: 'topbar-center',
      controlIds: ['ink.tool.pen'],
    });
    contributions.registry.register({
      id: 'plugin-b.settings',
      controls: () => [pluginSettings()],
      execute: () => true,
    });
    const computed = computeUnifiedToolbarModel({
      tools: tools.port,
      contributions: contributions.registry,
      placements: placements.registry,
      pane: 'pane-1',
      documentId: 'doc-1',
      kindId: 'froglight.ink',
    });
    expect(computed.settingsControls.map((owned) => owned.control.id)).toEqual([
      'ink.settings.pen.size',
    ]);
    expect(computed.settingsControls[0]?.owner).toEqual({
      kind: 'contribution',
      contributionId: 'plugin-b.settings',
    });
    expect(
      computed.ownedById.get('ink.settings.pen.size')?.owner,
    ).toEqual({
      kind: 'contribution',
      contributionId: 'plugin-b.settings',
    });
    contributions.dispose();
    placements.dispose();
  });

  it('preserves provider ownership for provider settings', () => {
    const snapshot: DocumentToolSnapshot = {
      context: 'Ink canvas',
      controls: [penTool(true), providerSettings()],
    };
    const tools = makeTools(snapshot);
    const contributions = createDocumentToolbarRegistry();
    const placements = createToolbarPlacementRegistry();
    placements.registry.register({
      id: 'test.primary',
      anchor: 'topbar-center',
      controlIds: ['ink.tool.pen'],
    });
    const computed = computeUnifiedToolbarModel({
      tools: tools.port,
      contributions: contributions.registry,
      placements: placements.registry,
      pane: 'pane-1',
      documentId: 'doc-1',
      kindId: 'froglight.ink',
    });
    expect(computed.settingsControls.map((owned) => owned.control.id)).toEqual([
      'ink.settings.pen.size',
    ]);
    expect(computed.settingsControls[0]?.owner).toEqual({ kind: 'provider' });
    contributions.dispose();
    placements.dispose();
  });

  describe('mounted popovers', () => {
    let root: Root | null = null;
    let host: HTMLElement | null = null;

    afterEach(() => {
      act(() => root?.unmount());
      root = null;
      host?.remove();
      host = null;
    });

    function mountTopbar(
      snapshot: DocumentToolSnapshot,
      configure: (input: {
        contributions: ReturnType<typeof createDocumentToolbarRegistry>;
        placements: ReturnType<typeof createToolbarPlacementRegistry>;
      }) => void,
    ): {
      toolsCalls: Array<readonly [id: string, value?: string]>;
      contributionCalls: Array<readonly [id: string, value?: string]>;
      contributionOwned: Array<readonly [contributionId: string, id: string, value?: string]>;
      cleanup: () => void;
    } {
      const made = makeTools(snapshot);
      const contributions = createDocumentToolbarRegistry();
      const placements = createToolbarPlacementRegistry();
      placements.registry.register({
        id: 'test.primary',
        anchor: 'topbar-center',
        controlIds: ['ink.tool.pen'],
      });
      const contributionCalls: Array<readonly [id: string, value?: string]> =
        [];
      const contributionOwned: Array<
        readonly [contributionId: string, id: string, value?: string]
      > = [];
      // Capture the resolved owner channel directly: the popover must call
      // executeOwned with the contribution id, not the provider channel.
      const innerExecuteOwned =
        contributions.registry.executeOwned.bind(contributions.registry);
      contributions.registry.executeOwned = ((
        contributionId: string,
        context: never,
        id: string,
        value?: string,
      ) => {
        contributionOwned.push([contributionId, id, value] as const);
        return innerExecuteOwned(
          contributionId as never,
          context as never,
          id as never,
          value as never,
        );
      }) as unknown as typeof contributions.registry.executeOwned;
      contributions.registry.register({
        id: 'plugin-b.settings',
        controls: () => [pluginSettings()],
        execute: (_context, id, value) => {
          contributionCalls.push([id, value] as const);
          return true;
        },
      });
      configure({ contributions, placements });
      host = document.createElement('div');
      document.body.appendChild(host);
      root = createRoot(host);
      const toolsPort = made.port;
      const contributionsRegistry = contributions.registry;
      const placementsRegistry = placements.registry;
      act(() => {
        root!.render(
          <TopbarCenterTools
            tools={toolsPort}
            contributions={contributionsRegistry}
            placements={placementsRegistry}
            pane="pane-1"
            documentId="doc-1"
            kindId="froglight.ink"
          />,
        );
      });
      return {
        toolsCalls: made.calls,
        contributionCalls,
        contributionOwned,
        cleanup: () => {
          contributions.dispose();
          placements.dispose();
        },
      };
    }

    it('routes topbar plugin-owned settings through the contribution owner', () => {
      const snapshot: DocumentToolSnapshot = {
        context: 'Ink canvas',
        controls: [penTool(true)],
      };
      const { toolsCalls, contributionCalls, contributionOwned, cleanup } =
        mountTopbar(snapshot, () => undefined);
      try {
        const trigger = host!.querySelector(
          '[data-toolbar="topbar-center"] button[aria-label="Pen"]',
        );
        if (!(trigger instanceof HTMLButtonElement))
          throw new Error('missing Pen trigger');
        // Second tap opens the settings popover without executing.
        act(() => trigger.click());
        expect(toolsCalls).toEqual([]);
        const panel = host!.querySelector('[role="dialog"]');
        expect(panel?.getAttribute('aria-label')).toBe('Pen settings');
        const size = panel?.querySelector('select[aria-label="Size"]');
        if (!(size instanceof HTMLSelectElement))
          throw new Error('missing Size select');
        act(() => {
          size.value = '6';
          size.dispatchEvent(new Event('change', { bubbles: true }));
        });
        expect(contributionCalls).toEqual([['ink.settings.pen.size', '6']]);
        expect(contributionOwned).toEqual([
          ['plugin-b.settings', 'ink.settings.pen.size', '6'],
        ]);
        // Plugin-owned settings never touch the provider command channel.
        expect(toolsCalls).toEqual([]);
      } finally {
        cleanup();
      }
    });

    it('routes composition-shelf plugin-owned settings through the contribution owner', async () => {
      const snapshot: DocumentToolSnapshot = {
        context: 'Ink canvas',
        controls: [penTool(true)],
      };
      const made = makeTools(snapshot);
      const contributions = createDocumentToolbarRegistry();
      const placements = createToolbarPlacementRegistry();
      const composition = createToolbarCompositionRegistry();
      composition.registry.registerCategory({
        id: 'surface.write',
        familyId: 'surface',
        label: 'Write',
        icon: 'pen',
      });
      composition.registry.registerItem({
        id: 'item-pen',
        categoryId: 'surface.write',
        semanticRole: 'surface.pen.ball',
      });
      composition.registry.registerKindExtension({
        id: 'ext-ink',
        kindIds: ['froglight.ink'],
        familyIds: ['surface'],
      });
      const contributionCalls: Array<readonly [id: string, value?: string]> =
        [];
      const contributionOwned: Array<
        readonly [contributionId: string, id: string, value?: string]
      > = [];
      const innerExecuteOwned =
        contributions.registry.executeOwned.bind(contributions.registry);
      contributions.registry.executeOwned = ((
        contributionId: string,
        context: never,
        id: string,
        value?: string,
      ) => {
        contributionOwned.push([contributionId, id, value] as const);
        return innerExecuteOwned(
          contributionId as never,
          context as never,
          id as never,
          value as never,
        );
      }) as unknown as typeof contributions.registry.executeOwned;
      contributions.registry.register({
        id: 'plugin-b.settings',
        controls: () => [pluginSettings()],
        execute: (_context, id, value) => {
          contributionCalls.push([id, value] as const);
          return true;
        },
      });
      host = document.createElement('div');
      document.body.appendChild(host);
      root = createRoot(host);
      try {
        const toolsPort = made.port;
        const contributionsRegistry = contributions.registry;
        const placementsRegistry = placements.registry;
        const compositionRegistry = composition.registry;
        await act(async () => {
          root!.render(
            <FloatingToolbarLayer
              tools={toolsPort}
              contributions={contributionsRegistry}
              placements={placementsRegistry}
              composition={compositionRegistry}
              pane="pane-1"
              documentId="doc-1"
              kindId="froglight.ink"
            />,
          );
        });
        const shelf = host!.querySelector('[data-tool-shelf="surface.write"]');
        expect(shelf).not.toBeNull();
        const trigger = shelf!.querySelector('button[aria-label="Pen"]');
        if (!(trigger instanceof HTMLButtonElement))
          throw new Error('missing shelf Pen trigger');
        await act(async () => trigger.click());
        expect(made.calls).toEqual([]);
        const panel = host!.querySelector('[role="dialog"]');
        expect(panel?.getAttribute('aria-label')).toBe('Pen settings');
        const size = panel?.querySelector('select[aria-label="Size"]');
        if (!(size instanceof HTMLSelectElement))
          throw new Error('missing shelf Size select');
        await act(async () => {
          size.value = '6';
          size.dispatchEvent(new Event('change', { bubbles: true }));
        });
        expect(contributionCalls).toEqual([['ink.settings.pen.size', '6']]);
        expect(contributionOwned).toEqual([
          ['plugin-b.settings', 'ink.settings.pen.size', '6'],
        ]);
        expect(made.calls).toEqual([]);
      } finally {
        contributions.dispose();
        placements.dispose();
        composition.dispose();
      }
    });
  });
});
