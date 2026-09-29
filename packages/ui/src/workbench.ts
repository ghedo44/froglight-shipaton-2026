import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
export type {
  DockMoveTargetView,
  DockTabView,
  OpenLinkResultView,
  PaneModeView,
  PaneView,
  WorkbenchDocumentView,
  WorkbenchStateView,
} from './workbench-view.js';
export type {
  DockStateView,
  WorkbenchControllerView,
  WorkbenchDocumentPort,
  WorkbenchDockPort,
  WorkbenchEditorToolsPort,
  WorkbenchHostPort,
  WorkbenchImportExportPort,
  WorkbenchReadingPort,
  WorkbenchReadingPresentation,
  WorkbenchStatePort,
} from './workbench-ports.js';
export {
  createWorkbenchDocumentPort,
  asWorkbenchHostPort,
  type HostBearingDocumentSource,
} from './workbench-adapters.js';
import type { WorkbenchControllerView } from './workbench-ports.js';
import type { Runtime, ServiceToken } from '@froglight/runtime';
import { createServiceProbe, definePlugin } from '@froglight/runtime';
import {
  accountIdentityToken,
  accountToken,
  commandsToken,
  keyboardInsetToken,
  settingsToken,
  navigationToken,
  workspaceToken,
  documentRegistryToken,
  documentPresentationToken,
  stylusToken,
  vaultToken,
  vaultSyncToken,
  type CommandService,
} from '@froglight/foundation';
import { purchasesToken } from '@froglight/foundation/purchases';
import { attachKeyboardShell } from './platform/keyboard-inset.js';
import { installWebviewDropGuard } from './drop-guard.js';
import {
  communityToolbarToken,
  uiViewsToken,
  uiSettingsToken,
  type CommunityPluginManager,
} from '@froglight/plugin-platform';
import { fileExplorerPlugin, fileExplorerToken } from './file-explorer.js';
import {
  searchUiPlugin,
  searchUiToken,
  type SearchUiService,
} from './search-ui.js';
import { themePlugin } from './theme.js';
import { createSettingsViewPlugin } from './settings-view.js';
import {
  settingsRegistryPlugin,
  settingsRegistryToken,
  type SettingsSectionRegistry,
} from './settings-registry.js';
import {
  workspaceSettingsPlugin,
  workspaceSettingsToken,
} from './workspace-settings.js';
import { graphViewPlugin } from './graph-view.js';
import {
  viewRegistryPlugin,
  viewRegistryToken,
  type ViewRegistry,
} from './view-registry.js';
import { CommunityActivityContent } from './react/workspace/components/CommunityActivityContent.jsx';
import { resolveIconPath } from './icons.js';
import {
  documentToolbarRegistryPlugin,
  documentToolbarRegistryToken,
  type DocumentToolbarRegistry,
} from './document-toolbar-registry.js';
import {
  documentToolbarPlacementPlugin,
  documentToolbarPlacementToken,
  type ToolbarPlacementContribution,
  type ToolbarPlacementRegistry,
  type ToolbarPlacementPluginConfig,
} from './toolbar/placement-registry.js';
import {
  toolbarCompositionPlugin,
  toolbarCompositionToken,
  type ToolbarCompositionPluginConfig,
  type ToolbarCompositionRegistry,
} from './toolbar/composition-registry.js';
import { defaultToolbarComposition } from './toolbar/default-composition.js';
import { createCommunityToolbarHost } from './toolbar/community-lifecycle.js';
import {
  rightSidebarRegistryPlugin,
  rightSidebarRegistryToken,
  type RightSidebarRegistry,
} from './right-sidebar-registry.js';
import {
  stylusMenuRegistryPlugin,
  stylusMenuRegistryToken,
  type StylusMenuRegistry,
} from './stylus-menu-registry.js';
import {
  documentOutlinePlugin,
  documentSettingsPanelPlugin,
  documentInspectorPanelPlugin,
  databaseDocumentPropertiesPlugin,
  knowledgePanelsPlugin,
} from './right-sidebar-panels.js';
import type { VaultChoice, VaultHostAdapter } from './launcher.js';
import { noWindowChrome, type WindowChrome } from './window-chrome.js';
import { FroglightApp } from './react/FroglightApp.jsx';
import { KeyboardInsetProvider } from './react/useKeyboardInset.js';
import { disposeOverlayHost } from './react/overlays.jsx';

export type { VaultChoice };
export type { VaultHostAdapter };

/** Live lookup of runtime-provided services for shell wiring. */
export interface UiServiceLookup {
  try<T>(token: ServiceToken<T>): T | undefined;
}

export interface UiCapabilities {
  readonly iframePdf: boolean;
}

export interface InstalledUi {
  readonly views: ViewRegistry;
  readonly documentTools: DocumentToolbarRegistry;
  readonly documentToolbarPlacements: ToolbarPlacementRegistry;
  readonly toolbarComposition: ToolbarCompositionRegistry;
  readonly rightSidebar: RightSidebarRegistry;
  readonly search: SearchUiService;
  readonly services: UiServiceLookup;
  /**
   * Host-declared environment capabilities. Defaults declare full support,
   * so unknown hosts keep full behavior; native webviews that cannot render
   * inline PDFs declare `iframePdf: false`.
   */
  readonly capabilities: UiCapabilities;
  /**
   * Report the vault the host currently shows as active (the launcher
   * selection), or null on the launcher with no vault open. Feeds the
   * Vault Sync settings ("Current vault") and parks cloud work for
   * non-visible vaults via `VaultSyncService.setActiveLocalVault`
   * `FroglightApp` calls this on every selection change;
   * hosts never call it directly.
   */
  setActiveVault(vault: { id: string; name: string } | null): void;
  /** The last vault reported via `setActiveVault`, if any. */
  getActiveVault(): { id: string; name: string } | null;
}

/** Install default first-party UI contributions. */
export async function installDefaultUi(
  runtime: Runtime,
  options: {
    /** Render-time resolver for the vault's community plugin catalog. */
    readonly community?: () => CommunityPluginManager | null;
    /** Default unified toolbar placements. */
    readonly toolbarPlacements?: readonly ToolbarPlacementContribution[];
    readonly toolbarComposition?: ToolbarCompositionPluginConfig;
    /** Host environment capabilities; defaults declare full support. */
    readonly capabilities?: Partial<UiCapabilities>;
  } = {},
): Promise<InstalledUi> {
  interface StableProbe {
    views: ViewRegistry | null;
    settingsSections: SettingsSectionRegistry | null;
    documentTools: DocumentToolbarRegistry | null;
    documentToolbarPlacements: ToolbarPlacementRegistry | null;
    toolbarComposition: ToolbarCompositionRegistry | null;
    rightSidebar: RightSidebarRegistry | null;
    stylusMenu: StylusMenuRegistry | null;
  }

  /**
   * One stable probe owns only registries installed by this UI composition.
   * Every optional or workspace/host-scoped capability gets its own generic
   * service probe below, so provider appearance/withdrawal follows runtime
   * lifecycle instead of depending on bootstrap ordering.
   */
  const stableProbeState: StableProbe = {
    views: null,
    settingsSections: null,
    documentTools: null,
    documentToolbarPlacements: null,
    toolbarComposition: null,
    rightSidebar: null,
    stylusMenu: null,
  };
  const stableProbe = definePlugin({
    id: 'froglight.ui.registry-probe',
    requirements: {
      requires: [
        viewRegistryToken,
        settingsRegistryToken,
        documentToolbarRegistryToken,
        documentToolbarPlacementToken,
        toolbarCompositionToken,
        rightSidebarRegistryToken,
        stylusMenuRegistryToken,
      ],
    },
    activate: (ctx) => {
      stableProbeState.views = ctx.require(viewRegistryToken);
      stableProbeState.settingsSections = ctx.require(settingsRegistryToken);
      stableProbeState.documentTools = ctx.require(
        documentToolbarRegistryToken,
      );
      stableProbeState.documentToolbarPlacements = ctx.require(
        documentToolbarPlacementToken,
      );
      stableProbeState.toolbarComposition = ctx.require(
        toolbarCompositionToken,
      );
      stableProbeState.rightSidebar = ctx.require(rightSidebarRegistryToken);
      stableProbeState.stylusMenu = ctx.require(stylusMenuRegistryToken);
      ctx.effect(() => () => {
        stableProbeState.views = null;
        stableProbeState.settingsSections = null;
        stableProbeState.documentTools = null;
        stableProbeState.documentToolbarPlacements = null;
        stableProbeState.toolbarComposition = null;
        stableProbeState.rightSidebar = null;
        stableProbeState.stylusMenu = null;
      });
    },
  });

  // Live service probes are deliberately one-token/one-lifetime. This keeps
  // host capabilities independent from workspace withdrawal and lets a host
  // capability registered after UI installation activate without ceremony.
  const keyboardProbe = createServiceProbe({
    pluginId: 'froglight.ui.keyboard-inset-probe',
    token: keyboardInsetToken,
  });
  const stylusProbe = createServiceProbe({
    pluginId: 'froglight.ui.stylus-probe',
    token: stylusToken,
  });
  const purchasesProbe = createServiceProbe({
    pluginId: 'froglight.ui.purchases-probe',
    token: purchasesToken,
  });
  const accountProbe = createServiceProbe({
    pluginId: 'froglight.ui.account-probe',
    token: accountToken,
  });
  const identityProbe = createServiceProbe({
    pluginId: 'froglight.ui.account-identity-probe',
    token: accountIdentityToken,
  });
  const vaultSyncProbe = createServiceProbe({
    pluginId: 'froglight.ui.vault-sync-probe',
    token: vaultSyncToken,
  });
  const vaultProbe = createServiceProbe({
    pluginId: 'froglight.ui.vault-probe',
    token: vaultToken,
  });
  const searchProbe = createServiceProbe({
    pluginId: 'froglight.ui.search-probe',
    token: searchUiToken,
  });
  const workspaceSettingsProbe = createServiceProbe({
    pluginId: 'froglight.ui.workspace-settings-probe',
    token: workspaceSettingsToken,
  });
  const workspaceProbe = createServiceProbe({
    pluginId: 'froglight.ui.workspace-probe',
    token: workspaceToken,
  });
  const documentRegistryProbe = createServiceProbe({
    pluginId: 'froglight.ui.document-registry-probe',
    token: documentRegistryToken,
  });
  const documentPresentationProbe = createServiceProbe({
    pluginId: 'froglight.ui.document-presentation-probe',
    token: documentPresentationToken,
  });
  const navigationProbe = createServiceProbe({
    pluginId: 'froglight.ui.navigation-probe',
    token: navigationToken,
  });
  const settingsProbe = createServiceProbe({
    pluginId: 'froglight.ui.settings-probe',
    token: settingsToken,
  });
  const explorerProbe = createServiceProbe({
    pluginId: 'froglight.ui.file-explorer-probe',
    token: fileExplorerToken,
  });
  // Live workspace commands for the community toolbar broker.
  // `commandsToken` is workspace-scoped — present only while a vault
  // is open — so the broker resolves it live per execution through this
  // probe instead of capturing one revision at bind time. Absent commands
  // fail closed (execute → false), never throw into the toolbar.
  const commandsProbe = createServiceProbe({
    pluginId: 'froglight.ui.commands-probe',
    token: commandsToken,
  });

  // The vault the host currently shows as active (launcher selection).
  // Written by `FroglightApp` on every selection change; read at render
  // time by the Vault Sync settings section. A plain box (not a service)
  // is enough: the sync service itself tracks parking through
  // `setActiveLocalVault`, called alongside (see `setActiveVault` below).
  const activeVaultBox: { current: { id: string; name: string } | null } = {
    current: null,
  };

  await runtime.registerSlot({
    id: 'settings-registry',
    plugin: settingsRegistryPlugin,
  });
  await runtime.registerSlot({
    id: 'view-registry',
    plugin: viewRegistryPlugin,
  });
  await runtime.registerSlot({
    id: 'document-toolbar-registry',
    plugin: documentToolbarRegistryPlugin,
  });
  const toolbarPlacementsConfig: ToolbarPlacementPluginConfig = {
    placements: options.toolbarPlacements ?? [],
  };
  await runtime.registerSlot({
    id: 'document-toolbar-placement',
    plugin: documentToolbarPlacementPlugin,
    config: toolbarPlacementsConfig,
  });
  const toolbarCompositionConfig: ToolbarCompositionPluginConfig =
    options.toolbarComposition ?? defaultToolbarComposition();
  await runtime.registerSlot({
    id: 'toolbar-composition',
    plugin: toolbarCompositionPlugin,
    config: toolbarCompositionConfig,
  });
  await runtime.registerSlot({
    id: 'right-sidebar-registry',
    plugin: rightSidebarRegistryPlugin,
  });
  await runtime.registerSlot({
    id: 'stylus-menu-registry',
    plugin: stylusMenuRegistryPlugin,
  });
  // The trusted plugin facade contributes activity-window content through the
  // shared view registry. Other view and settings contributions remain metadata.
  await runtime.registerSlot({
    id: 'ui-views-binding',
    plugin: definePlugin({
      id: 'froglight.ui.views-binding',
      requirements: { requires: [viewRegistryToken] },
      activate: (ctx) => {
        const views = new Map<string, { id: string; title?: string }>();
        const viewRegistry = ctx.require(viewRegistryToken);
        ctx.provide(uiViewsToken, {
          register(view) {
            if (view.area === 'activity') {
              if (!view.title || typeof view.mount !== 'function')
                throw new TypeError(
                  'activity views require a title and mount function',
                );
              const mount = view.mount;
              const registration = viewRegistry.register({
                id: view.id,
                area: 'activity',
                title: view.title,
                icon:
                  view.icon && resolveIconPath(view.icon)
                    ? (view.icon as import('./icons.js').IconName)
                    : 'blocks',
                component: () =>
                  createElement(CommunityActivityContent, {
                    mount,
                  }),
              });
              return registration;
            }
            const previous = views.get(view.id);
            const entry = { id: view.id, title: view.title };
            views.set(view.id, entry);
            let disposed = false;
            const dispose = () => {
              if (disposed) return;
              disposed = true;
              if (views.get(view.id) !== entry) return;
              if (previous === undefined) views.delete(view.id);
              else views.set(view.id, previous);
            };
            ctx.effect(() => dispose);
            return { dispose };
          },
        });
        const sections = new Map<
          string,
          {
            id: string;
            name: string;
            group?: string;
            icon?: string;
            order?: number;
            keywords?: readonly string[];
          }
        >();
        ctx.provide(uiSettingsToken, {
          register(section) {
            const previous = sections.get(section.id);
            const entry = {
              id: section.id,
              name: section.name,
              group: section.group,
              icon: section.icon,
              order: section.order,
              keywords: section.keywords,
            };
            sections.set(section.id, entry);
            let disposed = false;
            const dispose = () => {
              if (disposed) return;
              disposed = true;
              if (sections.get(section.id) !== entry) return;
              if (previous === undefined) sections.delete(section.id);
              else sections.set(section.id, previous);
            };
            ctx.effect(() => dispose);
            return { dispose };
          },
        });
      },
    }),
  });
  await runtime.registerSlot({ id: 'theme', plugin: themePlugin });
  // Production community toolbar host: exposes the
  // platform's `communityToolbarToken` so community fibers resolve their
  // `facades.toolbar.register` DTO through the real composition +
  // document-toolbar registries with broker routing to workspace commands.
  // Requires the UI-owned registries; workspace commands stay optional and
  // live (see `commandsProbe`) because the workspace appears and withdraws
  // with the vault while this binding is app-lifetime.
  await runtime.registerSlot({
    id: 'community-toolbar-binding',
    plugin: definePlugin({
      id: 'froglight.community-toolbar.binding',
      requirements: {
        requires: [toolbarCompositionToken, documentToolbarRegistryToken],
      },
      activate: (ctx) => {
        const composition = ctx.require(toolbarCompositionToken);
        const controls = ctx.require(documentToolbarRegistryToken);
        const liveCommands: Pick<CommandService, 'execute'> = {
          execute: (id) =>
            commandsProbe.get()?.execute(id) ??
            Promise.resolve({
              ok: false as const,
              error: new Error(`no workspace commands available for '${id}'`),
            }),
        };
        ctx.provide(
          communityToolbarToken,
          createCommunityToolbarHost({
            composition,
            controls,
            commands: liveCommands,
          }),
        );
      },
    }),
  });
  await runtime.registerSlot({
    id: 'workspace-settings',
    plugin: workspaceSettingsPlugin,
  });
  await runtime.registerSlot({
    id: 'document-outline',
    plugin: documentOutlinePlugin,
  });
  await runtime.registerSlot({
    id: 'document-settings-panel',
    plugin: documentSettingsPanelPlugin,
  });
  await runtime.registerSlot({
    id: 'document-inspector-panel',
    plugin: documentInspectorPanelPlugin,
  });
  await runtime.registerSlot({
    id: 'database-document-properties',
    plugin: databaseDocumentPropertiesPlugin,
  });
  // Knowledge panels: four always-visible
  // tabs over the derived relationship graph. Optionally-requires workspace
  // services so cold-boot launcher and withdrawn vaults render the
  // unavailable empty state; live probe-closure resolution refreshes on
  // vault open/close/reopen without sticky unavailability.
  await runtime.registerSlot({
    id: 'knowledge-panels',
    plugin: knowledgePanelsPlugin,
  });
  await runtime.registerSlot({
    id: 'file-explorer',
    plugin: fileExplorerPlugin,
  });
  await runtime.registerSlot({ id: 'search-ui', plugin: searchUiPlugin });
  await runtime.registerSlot({
    id: 'settings',
    plugin: createSettingsViewPlugin({
      ...options,
      purchases: () => purchasesProbe.get() ?? null,
      account: () => accountProbe.get() ?? null,
      identity: () => identityProbe.get() ?? null,
      vaultSync: () => vaultSyncProbe.get() ?? null,
      vault: () => vaultProbe.get() ?? null,
      currentVault: () => activeVaultBox.current,
    }),
  });
  await runtime.registerSlot({ id: 'graph-view', plugin: graphViewPlugin });
  await runtime.registerSlot({
    id: 'ui-registry-probe',
    plugin: stableProbe,
  });
  await runtime.registerSlot({
    id: 'ui-keyboard-inset-probe',
    plugin: keyboardProbe.plugin,
  });
  await runtime.registerSlot({
    id: 'ui-stylus-probe',
    plugin: stylusProbe.plugin,
  });
  await runtime.registerSlot({
    id: 'ui-purchases-probe',
    plugin: purchasesProbe.plugin,
  });
  await runtime.registerSlot({
    id: 'ui-account-probe',
    plugin: accountProbe.plugin,
  });
  await runtime.registerSlot({
    id: 'ui-account-identity-probe',
    plugin: identityProbe.plugin,
  });
  await runtime.registerSlot({
    id: 'ui-vault-sync-probe',
    plugin: vaultSyncProbe.plugin,
  });
  await runtime.registerSlot({
    id: 'ui-vault-probe',
    plugin: vaultProbe.plugin,
  });
  await runtime.registerSlot({
    id: 'ui-search-probe',
    plugin: searchProbe.plugin,
  });
  await runtime.registerSlot({
    id: 'ui-workspace-settings-probe',
    plugin: workspaceSettingsProbe.plugin,
  });
  await runtime.registerSlot({
    id: 'ui-workspace-probe',
    plugin: workspaceProbe.plugin,
  });
  await runtime.registerSlot({
    id: 'ui-document-registry-probe',
    plugin: documentRegistryProbe.plugin,
  });
  await runtime.registerSlot({
    id: 'ui-document-presentation-probe',
    plugin: documentPresentationProbe.plugin,
  });
  await runtime.registerSlot({
    id: 'ui-navigation-probe',
    plugin: navigationProbe.plugin,
  });
  await runtime.registerSlot({
    id: 'ui-settings-probe',
    plugin: settingsProbe.plugin,
  });
  await runtime.registerSlot({
    id: 'ui-file-explorer-probe',
    plugin: explorerProbe.plugin,
  });
  await runtime.registerSlot({
    id: 'ui-commands-probe',
    plugin: commandsProbe.plugin,
  });

  if (
    stableProbeState.views === null ||
    stableProbeState.settingsSections === null ||
    stableProbeState.documentTools === null ||
    stableProbeState.documentToolbarPlacements === null ||
    stableProbeState.toolbarComposition === null ||
    stableProbeState.rightSidebar === null ||
    stableProbeState.stylusMenu === null
  ) {
    throw new Error('UI registries failed to activate');
  }

  const liveSearch: SearchUiService = {
    search(query) {
      return searchProbe.get()?.search(query) ?? Promise.resolve([]);
    },
  };

  const serviceReaders = new Map<string, () => unknown>([
    [workspaceToken.id, () => workspaceProbe.get() ?? undefined],
    [documentRegistryToken.id, () => documentRegistryProbe.get() ?? undefined],
    [
      documentPresentationToken.id,
      () => documentPresentationProbe.get() ?? undefined,
    ],
    [navigationToken.id, () => navigationProbe.get() ?? undefined],
    [settingsToken.id, () => settingsProbe.get() ?? undefined],
    [
      workspaceSettingsToken.id,
      () => workspaceSettingsProbe.get() ?? undefined,
    ],
    [
      settingsRegistryToken.id,
      () => stableProbeState.settingsSections ?? undefined,
    ],
    [fileExplorerToken.id, () => explorerProbe.get() ?? undefined],
    [keyboardInsetToken.id, () => keyboardProbe.get() ?? undefined],
    [stylusToken.id, () => stylusProbe.get() ?? undefined],
    [purchasesToken.id, () => purchasesProbe.get() ?? undefined],
    [accountToken.id, () => accountProbe.get() ?? undefined],
    [accountIdentityToken.id, () => identityProbe.get() ?? undefined],
    [vaultSyncToken.id, () => vaultSyncProbe.get() ?? undefined],
    [vaultToken.id, () => vaultProbe.get() ?? undefined],
    [
      stylusMenuRegistryToken.id,
      () => stableProbeState.stylusMenu ?? undefined,
    ],
    [
      toolbarCompositionToken.id,
      () => stableProbeState.toolbarComposition ?? undefined,
    ],
  ]);

  return {
    views: stableProbeState.views,
    documentTools: stableProbeState.documentTools,
    documentToolbarPlacements: stableProbeState.documentToolbarPlacements,
    toolbarComposition: stableProbeState.toolbarComposition,
    rightSidebar: stableProbeState.rightSidebar,
    search: liveSearch,
    capabilities: {
      iframePdf: options.capabilities?.iframePdf ?? true,
    },
    services: {
      try<T>(token: ServiceToken<T>): T | undefined {
        return serviceReaders.get(token.id)?.() as T | undefined;
      },
    },
    setActiveVault(vault) {
      activeVaultBox.current = vault;
      // Park cloud work for non-visible vaults: the sync host
      // fiber still owns the vault attachment; parking only stops
      // scheduling reconciles for the bound-but-hidden vault.
      try {
        vaultSyncProbe.get()?.setActiveLocalVault(vault?.id ?? null);
      } catch {
        // Parking is best-effort shell bookkeeping; the service treats a
        // missing report as "unknown" and keeps working.
      }
    },
    getActiveVault() {
      return activeVaultBox.current;
    },
  };
}

export interface WorkbenchMount {
  dispose(): Promise<void>;
}

export interface FroglightMountOptions {
  /**
   * Host window-chrome adapter (native Tauri, installed PWA overlay, or the
   * plain-browser fallback). `null`/omitted renders a plain app header.
   */
  windowChrome?: WindowChrome | null;
}

/**
 * Mount the complete Froglight product shell.
 *
 * Startup always begins at the vault launcher. A workspace is mounted only
 * after one vault is activated, and closing it returns to the launcher.
 *
 * The shell is a single React root; hosts and plugin contracts are
 * framework-agnostic and unchanged.
 */
export async function mountFroglightApp(
  root: HTMLElement,
  controller: WorkbenchControllerView,
  vaults: VaultHostAdapter,
  ui: InstalledUi,
  options: FroglightMountOptions = {},
): Promise<WorkbenchMount> {
  const reactRoot = createRoot(root);
  const keyboardInset = ui.services.try(keyboardInsetToken) ?? null;
  // One resolved capability instance drives both layout and React semantic
  // state, so future components can use `useKeyboardInset()` without a
  // second host/platform integration path.
  const detachKeyboardShell = attachKeyboardShell({ store: keyboardInset });
  reactRoot.render(
    createElement(
      KeyboardInsetProvider,
      { service: keyboardInset },
      createElement(FroglightApp, {
        controller,
        vaults,
        ui,
        eventTarget: root,
        chrome: options.windowChrome ?? noWindowChrome(),
      }),
    ),
  );
  const chrome = options.windowChrome ?? null;
  // WebView drop guard: a file drop outside the explorer tree (or one the
  // tree guards do not recognize) must never navigate the WebView to the
  // file URL and wipe the app. The guard runs in the capture phase, so the
  // explorer's own import handlers still receive every event.
  const detachDropGuard =
    typeof window === 'undefined'
      ? () => undefined
      : installWebviewDropGuard(window);

  return {
    async dispose() {
      detachDropGuard();
      detachKeyboardShell();
      reactRoot.unmount();
      disposeOverlayHost();
      // The host adapter owns OS listeners; the mount owns the adapter.
      chrome?.dispose?.();
      await controller.dispose();
      root.replaceChildren();
    },
  };
}
