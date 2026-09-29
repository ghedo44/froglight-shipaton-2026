// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import {
  InMemorySettingsService,
  settingsToken,
  type DocumentKindId,
} from '@froglight/foundation';
import type { ServiceToken } from '@froglight/runtime';
import type { InstalledUi } from '../../../workbench.js';
import { noWindowChrome } from '../../../window-chrome.js';
import {
  TOOLBAR_CUSTOMIZATION_STORAGE_KEY,
  type ToolbarCustomizationStore,
} from '../../../toolbar/toolbar-customization.js';
import { createHarness, makeChoice } from '../../test-support.js';
import { WorkspaceContextProvider } from '../WorkspaceContext.js';

const toolbarCapture = vi.hoisted(() => ({
  slotCustomization: null as unknown,
}));

vi.mock('../../UnifiedToolbar.jsx', () => ({
  UnifiedToolbarProvider: (props: {
    readonly children?: ReactNode;
    readonly slotCustomization?: unknown;
  }) => {
    toolbarCapture.slotCustomization = props.slotCustomization ?? null;
    return props.children ?? null;
  },
  TopbarCenterTools: () => null,
  FloatingToolbarLayer: () => null,
  useUnifiedToolbarLayout: () => ({ snapshot: null }),
}));

import { Pane, toPaneViewModel, type PaneActions } from './Pane.jsx';

const noop = (): void => undefined;

const actions: PaneActions = {
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
};

function uiWithSettings(
  base: InstalledUi,
  settings: InMemorySettingsService,
): InstalledUi {
  return {
    ...base,
    services: {
      try<T>(token: ServiceToken<T>): T | undefined {
        if (token.id === settingsToken.id) return settings as T;
        return base.services.try(token);
      },
    },
  };
}

describe('Pane toolbar customization persistence', () => {
  it('binds one settings-backed store per service identity and disposes replaced stores', async () => {
    const harness = await createHarness();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const firstSettings = new InMemorySettingsService();
    const secondSettings = new InMemorySettingsService();
    const model = toPaneViewModel({
      paneId: 'main',
      paneState: {
        pane: 'main',
        tabs: [
          {
            id: 'doc-1',
            kind: 'document',
            documentId: 'doc-1',
            viewId: null,
          },
        ],
        activeTab: 'doc-1',
        mode: 'edit',
        documentId: 'doc-1',
        viewId: null,
        title: 'Welcome',
        path: 'notes/welcome.md',
        dirty: false,
        recoveryWarnings: [],
        canGoBack: false,
        canGoForward: false,
        editorAvailable: true,
      },
      focusedPane: 'main',
      mobile: false,
      documentById: new Map([
        [
          'doc-1',
          {
            documentId: 'doc-1',
            kindId: 'froglight.ink' as DocumentKindId,
            title: 'Welcome',
            path: 'notes/welcome.md',
          },
        ],
      ]),
      views: harness.ui.views,
      drag: null,
      dropTarget: null,
      revision: 0,
      settingsService: null,
      presentation: {
        kind: 'editor-readonly',
        kindId: 'froglight.ink' as DocumentKindId,
      },
    });
    const hosts = {
      editorHosts: { current: new Map<string, HTMLElement>() },
      readerHosts: { current: new Map<string, HTMLElement>() },
    };

    const render = async (ui: InstalledUi): Promise<void> => {
      await act(async () => {
        root.render(
          <WorkspaceContextProvider
            value={{
              controller: harness.controller,
              ui,
              choice: makeChoice({ id: 'test', name: 'Test vault' }),
              chrome: noWindowChrome(),
              onClose: noop,
            }}
          >
            <Pane
              model={model}
              actions={actions}
              hosts={hosts}
              views={ui.views}
              tools={harness.controller}
            />
          </WorkspaceContextProvider>,
        );
      });
    };

    try {
      await render(uiWithSettings(harness.ui, firstSettings));
      const firstStore =
        toolbarCapture.slotCustomization as ToolbarCustomizationStore;
      expect(firstStore.setSlotSizeAt('pen', 0, 9)).toBe(true);
      expect(firstSettings.get(TOOLBAR_CUSTOMIZATION_STORAGE_KEY)).toContain(
        '"slotSizesPen":[9',
      );

      await render(uiWithSettings(harness.ui, secondSettings));
      const secondStore =
        toolbarCapture.slotCustomization as ToolbarCustomizationStore;
      expect(secondStore).not.toBe(firstStore);
      expect(secondStore.setSlotSizeAt('pen', 0, 11)).toBe(true);
      expect(secondSettings.get(TOOLBAR_CUSTOMIZATION_STORAGE_KEY)).toContain(
        '"slotSizesPen":[11',
      );

      firstSettings.remove(TOOLBAR_CUSTOMIZATION_STORAGE_KEY);
      firstStore.setSlotSizeAt('pen', 0, 13);
      expect(
        firstSettings.get(TOOLBAR_CUSTOMIZATION_STORAGE_KEY),
      ).toBeUndefined();

      await act(async () => root.unmount());
      secondSettings.remove(TOOLBAR_CUSTOMIZATION_STORAGE_KEY);
      secondStore.setSlotSizeAt('pen', 0, 15);
      expect(
        secondSettings.get(TOOLBAR_CUSTOMIZATION_STORAGE_KEY),
      ).toBeUndefined();
    } finally {
      if (host.childElementCount > 0) {
        await act(async () => root.unmount());
      }
      host.remove();
      await harness.dispose();
    }
  });
});
