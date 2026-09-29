// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { DocumentToolSnapshot } from '@froglight/foundation';
import type { WorkbenchEditorToolsPort } from '../workbench-ports.js';
import { createDocumentToolbarRegistry } from '../document-toolbar-registry.js';
import { createToolbarPlacementRegistry } from '../toolbar/placement-registry.js';
import { createToolbarCompositionRegistry } from '../toolbar/composition-registry.js';
import { defaultToolbarComposition } from '../toolbar/default-composition.js';
import { defaultToolbarPlacements } from '../toolbar/default-placements.js';
import { WorkspaceContextProvider } from './workspace/WorkspaceContext.js';
import {
  Pane,
  toPaneViewModel,
  type PaneActions,
  type PaneHosts,
} from './workspace/components/Pane.jsx';
import type { InstalledUi } from '../workbench.js';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

function snapshot(): DocumentToolSnapshot {
  // primaries resolve through composition via semanticRoles;
  // geometric placements keep only history/zoom/selection utilities.
  return {
    context: 'Markdown paragraph',
    controls: [
      {
        kind: 'choice',
        id: 'markdown.block',
        group: 'block',
        label: 'Line style',
        value: 'paragraph',
        options: [{ value: 'paragraph', label: 'Paragraph' }],
        semanticRole: 'writing.style',
      },
      {
        kind: 'button',
        id: 'markdown.bold',
        group: 'format',
        label: 'Bold',
        shortLabel: 'B',
        semanticRole: 'writing.bold',
        activationRole: 'toggle',
      },
      {
        kind: 'input',
        id: 'markdown.link',
        group: 'insert',
        label: 'Link destination',
        actionLabel: 'Link',
        semanticRole: 'writing.link',
      },
    ] as DocumentToolSnapshot['controls'],
  };
}

describe('pane-scoped popover portal', () => {
  let root: Root | null = null;
  afterEach(async () => {
    await act(async () => root?.unmount());
    root = null;
    document.body.replaceChildren();
  });

  async function mountPane() {
    const host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const listeners = new Set<() => void>();
    const tools = {
      editorToolSnapshot: () => snapshot(),
      executeEditorTool: () => true,
      canExecEditorCommand: () => true,
      execEditorCommand: () => true,
      onDidChange: (l: () => void) => {
        listeners.add(l);
        return { dispose: () => listeners.delete(l) };
      },
    } as unknown as WorkbenchEditorToolsPort;
    const contributions = createDocumentToolbarRegistry();
    const placements = createToolbarPlacementRegistry();
    for (const p of defaultToolbarPlacements()) placements.registry.register(p);
    const composition = createToolbarCompositionRegistry();
    const defaults = defaultToolbarComposition();
    for (const entry of defaults.categories)
      composition.registry.registerCategory(entry);
    for (const entry of defaults.items)
      composition.registry.registerItem(entry);
    for (const entry of defaults.extensions)
      composition.registry.registerKindExtension(entry);
    const stubViews = {
      get: () => undefined,
      list: () => [],
      onDidChange: () => ({ dispose: () => undefined }),
    } as unknown as InstalledUi['views'];
    const ui = {
      services: { try: () => undefined },
      documentTools: contributions.registry,
      documentToolbarPlacements: placements.registry,
      toolbarComposition: composition.registry,
    } as unknown as InstalledUi;
    const model = toPaneViewModel({
      paneId: 'main',
      paneState: {
        pane: 'main',
        tabs: [
          { id: 'doc-1', kind: 'document', documentId: 'doc-1', viewId: null },
        ],
        activeTab: 'doc-1',
        mode: 'edit',
        documentId: 'doc-1',
        viewId: null,
        title: 'a.md',
        path: 'a.md',
        dirty: false,
        recoveryWarnings: [],
        canGoBack: false,
        canGoForward: false,
      } as never,
      focusedPane: 'main',
      mobile: false,
      documentById: new Map([
        [
          'doc-1',
          {
            documentId: 'doc-1',
            kindId: 'froglight.markdown',
            path: 'a.md',
            title: 'a.md',
          },
        ],
      ]) as never,
      views: stubViews as never,
      drag: null,
      dropTarget: null,
      revision: 0,
      settingsService: null,
      presentation: {
        kind: 'editor-readonly',
        kindId: 'froglight.markdown',
      } as never,
    });
    const noop = () => undefined;
    await act(async () => {
      root?.render(
        <WorkspaceContextProvider
          value={{
            controller: {} as never,
            ui,
            choice: {} as never,
            chrome: {} as never,
            onClose: () => undefined,
          }}
        >
          <Pane
            model={model}
            actions={
              {
                onPointerDownPane: noop,
                onActivateTab: noop,
                onCloseTab: noop,
                onFocusPane: noop,
                onOpenSwitcher: noop,
                onCreateNote: noop,
                onTabPointerDown: noop,
                onTabContextMenu: noop,
                onGoBack: noop,
                onGoForward: noop,
                onSplitRight: noop,
                onSplitDown: noop,
                onSetMode: noop,
                onOpenNoteMenu: noop,
                onPaneContextMenu: noop,
                onZoneEnter: noop,
                onZoneLeave: noop,
              } as PaneActions
            }
            hosts={
              {
                editorHosts: { current: new Map() },
                readerHosts: { current: new Map() },
              } as PaneHosts
            }
            views={stubViews}
            tools={tools}
          />
        </WorkspaceContextProvider>,
      );
    });
    return { host, contributions, placements, composition };
  }

  it('portals link popovers into the pane layer, not inside scrollable islands', async () => {
    const { host, contributions, placements, composition } = await mountPane();
    // Link is a direct writing action.
    await act(async () => {
      (
        host.querySelector(
          '[data-toolbar="writing-direct"] [aria-label="Link destination"]',
        ) as HTMLButtonElement
      ).click();
    });
    const dialog = host.querySelector(
      '[role="dialog"][aria-label="Link destination"]',
    );
    expect(dialog).not.toBeNull();
    // Not a descendant of the scrollable island (no clipping by island).
    expect((dialog as HTMLElement).closest('[data-anchor]')).toBeNull();
    // Inside the pane-scoped popover layer (not window-global).
    const layer = (dialog as HTMLElement).closest('[data-popover-layer]');
    expect(layer).not.toBeNull();
    expect(layer?.closest('[data-pane="main"]')).not.toBeNull();
    contributions.dispose();
    placements.dispose();
    composition.dispose();
  });

  it('does not leak popover state across panes (pane-scoped isolation)', async () => {
    const { host, contributions, placements, composition } = await mountPane();
    await act(async () => {
      (
        host.querySelector(
          '[data-toolbar="writing-direct"] [aria-label="Link destination"]',
        ) as HTMLButtonElement
      ).click();
    });
    expect(host.querySelector('[role="dialog"]')).not.toBeNull();
    // Exactly one pane layer owns the popover (no global leak).
    expect(host.querySelectorAll('[data-popover-layer]').length).toBe(1);
    expect(host.querySelectorAll('[role="dialog"]').length).toBe(1);
    contributions.dispose();
    placements.dispose();
    composition.dispose();
  });
});
