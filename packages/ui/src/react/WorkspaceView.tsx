import { DocumentRecoveryDialog } from './DocumentRecoveryDialog.jsx';
import { PublicationConflictDialog } from './PublicationConflictDialog.jsx';
import {
  DEFAULT_VAULT_APPEARANCE,
  vaultToken,
  vaultSyncToken,
  navigationToken,
  documentPresentationToken,
  workspaceToken,
  isFroglightError,
  type DocumentSession,
  type DocumentRecoveryError,
} from '@froglight/foundation';
/**
 * The mounted workspace shell: a dock of pane splits whose tab strips align
 * in the top bar, per-pane document headers (history, title, mode, note
 * menu), quick switcher, sidebar views, and the global context-menu policy.
 *
 * The workbench controller is the single owner of dock state;
 * this tree subscribes and renders. Editor engines own everything inside a
 * pane's editor host — those hosts are stable DOM nodes per pane whose
 * lifetime spans mode toggles and controller-driven opens.
 *
 * This module is the thin composition root: dependency resolution, hook
 * composition, per-pane view-model/actions wiring, and rendering of
 * `WorkspaceShell`. All mechanics live in `hooks/`, `actions/`, `model/`,
 * and `components/`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DialogHandle } from './primitives/Dialog.jsx';
import type {
  InstalledUi,
  PaneModeView,
  VaultChoice,
  WorkbenchControllerView,
} from '../workbench.js';
import type {
  WorkbenchOutlineDocumentLike,
  WorkbenchOutlineProviderLike,
} from '../workbench-view.js';
import { settingsRegistryToken } from '../settings-registry.js';
import { workspaceSettingsToken } from '../workspace-settings.js';
import { closeOpenMenu, showContextMenu } from '../menu.js';
import { noWindowChrome, type WindowChrome } from '../window-chrome.js';
import { uiNewNote } from '../dialogs.js';
import { fileExplorerToken } from '../file-explorer.js';
import { workspaceEvents as events } from '../ui-events.js';
import { WorkspaceContextProvider } from './workspace/WorkspaceContext.js';
import {
  useControllerSnapshot,
  emptyPaneState,
} from './workspace/hooks/useControllerSnapshot.js';
import { useToast } from './workspace/hooks/useToast.js';
import { useSidebarState } from './workspace/hooks/useSidebarState.js';
import { useResponsiveWorkspace } from './workspace/hooks/useResponsiveWorkspace.js';
import { useSessionOpener } from './workspace/hooks/useSessionOpener.js';
import { usePreviewViews } from './workspace/hooks/usePreviewViews.js';
import { useWorkspaceDocumentIntentEvents } from './workspace/hooks/useWorkspaceDocumentIntentEvents.js';
import { useActiveDocumentPublication } from './workspace/hooks/useActiveDocumentPublication.js';
import { createWorkspaceDocumentRouter } from './workspace/routing/documentRouter.js';
import { createWorkbenchDocumentPort } from '../workbench-adapters.js';
import { useGlobalInteractionPolicy } from './workspace/hooks/useGlobalInteractionPolicy.js';
import { useStylusAccessory } from './workspace/hooks/useStylusAccessory.js';
import { usePdfImport } from './workspace/hooks/usePdfImport.js';
import { useKeyboardShortcuts } from './workspace/hooks/useKeyboardShortcuts.js';
import { useTabDrag } from './workspace/hooks/useTabDrag.js';
import {
  buildRightSidebarContext,
  useSidebarOutlineInvalidation,
  type SidebarOutlineRegistryLike,
} from './workspace/hooks/useRightSidebarContext.js';
import { buildNotePath } from './workspace/actions/noteCreation.js';
import { buildDockTreePane } from './workspace/components/Pane.jsx';
import type {
  DockTreePane,
  DockTreeSeam,
} from './workspace/components/DockTree.jsx';
import { EditVaultDialog } from './EditVaultDialog.jsx';
import { useVaultProfile } from './useVaultProfile.js';
import { WorkspaceShell } from './workspace/components/WorkspaceShell.jsx';
import {
  ShellOverlays,
  type SwitcherState,
} from './workspace/components/ShellOverlays.jsx';
import type { ActivityId } from './workspace/components/ActivityRail.jsx';
import type { VaultHostAdapter } from '../launcher.js';
import type { BottomNavId } from './workspace/components/BottomNav.jsx';

export function WorkspaceView(props: {
  controller: WorkbenchControllerView;
  ui: InstalledUi;
  choice: VaultChoice;
  vaults?: VaultHostAdapter;
  eventTarget?: HTMLElement;
  chrome?: WindowChrome;
  onClose: () => void;
}): React.ReactElement {
  const {
    controller,
    ui,
    choice,
    vaults,
    eventTarget,
    chrome = noWindowChrome(),
    onClose,
  } = props;
  const profileVault = ui.services.try(vaultToken) ?? null;
  const profileSync = ui.services.try(vaultSyncToken) ?? null;
  const fallbackProfile = useMemo(
    () => choice.profile ?? { name: choice.name, ...DEFAULT_VAULT_APPEARANCE },
    [choice],
  );
  const {
    profile,
    setProfile,
    error: profileError,
  } = useVaultProfile(profileVault, profileSync, fallbackProfile);
  const [editingVault, setEditingVault] = useState(false);
  const displayedChoice = useMemo(
    () => ({ ...choice, profile, name: profile.name }),
    [choice, profile],
  );
  useEffect(() => {
    ui.setActiveVault({ id: choice.id, name: profile.name });
  }, [ui, choice.id, profile.name]);
  const views = ui.views;
  const settingsService = ui.services.try(workspaceSettingsToken) ?? null;
  const settingsRegistry = ui.services.try(settingsRegistryToken) ?? null;
  const presentations = ui.services.try(documentPresentationToken);
  const [, setPresentationRevision] = useState(0);
  useEffect(() => {
    if (!presentations) return;
    return presentations.onDidChange(() => setPresentationRevision((revision) => revision + 1)).dispose;
  }, [presentations]);

  const snapshot = useControllerSnapshot(controller, controller, ui);
  const { revision, bump, documentById, dock, paneStates, paneStateOf } =
    snapshot;
  const { toast, notify } = useToast();
  const [recoveryError, setRecoveryError] = useState<DocumentRecoveryError | null>(null);
  const sidebar = useSidebarState({ settings: settingsService });
  const {
    mobile,
    presentation,
    mobileDrawerOpen,
    setMobileDrawerOpen,
    switchingBreakpoints,
    closeMobileDrawers,
  } = useResponsiveWorkspace({
    inspectorVisible: sidebar.rightSidebarVisible,
    setInspectorVisible: sidebar.setRightSidebarVisible,
  });

  const rootRef = useRef<HTMLDivElement | null>(null);
  const getRoot = useCallback(() => rootRef.current, []);
  const dispatchWorkspaceEvent = useCallback(
    (name: string, detail: unknown): void => {
      (eventTarget ?? rootRef.current)?.dispatchEvent(
        new CustomEvent(name, { detail, bubbles: true }),
      );
    },
    [eventTarget],
  );
  const closeDrawer = useCallback((): void => {
    setMobileDrawerOpen(false);
  }, [setMobileDrawerOpen]);

  const session = useSessionOpener({
    host: controller,
    reading: controller,
    state: controller,
    settingsService,
    paneStates,
    revision,
    choice,
    notify,
    onInitialized: bump,
    onRecoveryError: setRecoveryError,
  });
  // Document-only port: adapts the host-bearing controller so UI calls
  // `createAndOpen(path, opts)` / `openDocument(id, opts)` forward as
  // `controller.createAndOpen(path, undefined, opts)` /
  // `controller.openDocument(id, undefined, opts)`. Never pass the raw
  // controller as a `WorkbenchDocumentPort`.
  const documents = useMemo(
    () => createWorkbenchDocumentPort(controller),
    [controller],
  );
  const { ensurePreviewView, resolveRawFileLink } = usePreviewViews({
    ui,
    paneStates,
    revision,
    notify,
    dispatchWorkspaceEvent,
  });
  // One document router owns routing policy and reconciliation; hooks and
  // DOM events are edge adapters only. The controller stays the sole
  // promise-serialization authority for per-pane transitions. The router's
  // workbench adapter is built from narrow ports, never the aggregate.
  const router = useMemo(
    () =>
      createWorkspaceDocumentRouter({
        workbench: {
          get focusedPane() {
            return controller.focusedPane;
          },
          leafIds: () => controller.leafIds(),
          paneStates: () => controller.paneStates(),
          splitPane: (pane, direction, opts) =>
            controller.splitPane(pane, direction, opts),
          focusPane: (pane) => controller.focusPane(pane),
          liveOwnerOf: controller.liveOwnerOf.bind(controller),
          discardRedirectedSplit:
            controller.discardRedirectedSplit.bind(controller),
          openDocument: (pane, documentId, address, opts) =>
            session.requestOpen(pane, documentId, address, opts),
          openLink: (destination, pane) =>
            controller.openLink(
              destination,
              pane === undefined ? undefined : { pane },
            ),
          openView: (viewId, opts) => controller.openView(viewId, opts),
          closeTab: (pane, tabId) => controller.closeTab(pane, tabId),
          activateTab: (pane, tabId) => controller.activateTab(pane, tabId),
          pruneMissingDocuments: () => controller.pruneMissingDocuments(),
          revealAddress: (pane, address, opts) =>
            controller.revealAddress(pane, address, opts),
          hasPendingOpen: (pane) => session.hasPendingOpen(pane),
        },
        previews: { ensurePreviewView, resolveRawFileLink },
        effects: {
          notify,
          closeDrawer,
          bump,
          publishActiveDocument: (detail) =>
            dispatchWorkspaceEvent(events.activeDocument, detail),
          isCompact: () => mobile,
        },
      }),
    [
      controller,
      session,
      ensurePreviewView,
      resolveRawFileLink,
      notify,
      closeDrawer,
      bump,
      dispatchWorkspaceEvent,
      mobile,
    ],
  );
  const dragApi = useTabDrag({
    state: controller,
    dock: controller,
    mobile: !presentation.allowVisibleSplit,
    notify,
  });

  const [switcher, setSwitcher] = useState<SwitcherState | null>(null);
  const switcherInstance = useRef(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsCloseRef = useRef<DialogHandle | null>(null);
  const [closingVault, setClosingVault] = useState(false);

  const openSwitcherFor = useCallback(
    (pane: string): void => {
      closeOpenMenu();
      switcherInstance.current += 1;
      setSwitcher({ pane, mode: 'quick', instance: switcherInstance.current });
    },
    [],
  );
  const openSearchFor = useCallback(
    (pane: string): void => {
      closeOpenMenu();
      switcherInstance.current += 1;
      setSwitcher({ pane, mode: 'search', instance: switcherInstance.current });
    },
    [],
  );
  const closeSwitcher = useCallback((): void => {
    setSwitcher(null);
  }, []);
  const openSettingsModal = useCallback((): void => {
    settingsCloseRef.current?.cancelClose();
    setSettingsOpen(true);
  }, []);
  const closeSettingsModal = useCallback((): void => {
    setSettingsOpen(false);
  }, []);
  const toggleSettingsModal = useCallback((): void => {
    if (settingsCloseRef.current?.isClosing()) openSettingsModal();
    else if (settingsOpen) closeSettingsModal();
    else openSettingsModal();
  }, [closeSettingsModal, openSettingsModal, settingsOpen]);

  useWorkspaceDocumentIntentEvents({
    router,
    navigation: ui.services.try(navigationToken),
    resolveResource: (resourceId) =>
      ui.services
        .try(workspaceToken)
        ?.listDocuments()
        .find((ref) => String(ref.location.resourceId) === resourceId)
        ?.documentId,
    onMissingResource: () =>
      notify('The linked document is unavailable.', 'error'),
    eventTarget,
    getRoot,
  });
  useActiveDocumentPublication({
    state: controller,
    eventTarget,
    getRoot,
    revision,
    focusedPane: controller.focusedPane,
    dispatchWorkspaceEvent,
  });
  useGlobalInteractionPolicy({
    documents,
    bump,
    openSettings: openSettingsModal,
  });
  usePdfImport({
    pdf: controller,
    focusedPane: controller.focusedPane,
    eventTarget,
    getRoot,
    notify,
    closeDrawers: closeMobileDrawers,
  });

  const [publicationConflict, setPublicationConflict] = useState<DocumentSession | null>(null);
  const handleSave = useCallback((): void => {
    const workspace = ui.services.try(workspaceToken);
    const id = controller.paneStates().find(pane => pane.pane === controller.focusedPane)?.documentId;
    const ref = workspace?.listDocuments().find(document => document.documentId === id);
    const session = ref === undefined ? null : workspace?.getOpenDocument(ref.documentId) ?? null;
    if (session !== null && isFroglightError(session.lastError) && session.lastError.code === 'CONFLICT') {
      setPublicationConflict(session);
      return;
    }
    void controller.saveActive().catch(() => null).then(result => {
      if (result === null) return;
      if (result.committed) notify('Saved to vault');
      else if (isFroglightError(result.error) && result.error.code === 'CONFLICT' && session !== null && workspace?.getOpenDocument(session.document.documentId) === session) {
        setPublicationConflict(session);
      } else notify(`Save failed: ${String(result.error)}`, 'error');
    });
  }, [controller, notify, ui]);

  const toggleReadingMode = useCallback((): void => {
    const pane = controller.focusedPane;
    const state =
      controller.paneStates().find((candidate) => candidate.pane === pane) ??
      emptyPaneState(pane);
    if (state.activeTab === null) return;
    const next: PaneModeView =
      controller.tabMode(pane) === 'reading' ? 'edit' : 'reading';
    controller.setTabMode(pane, state.activeTab, next);
  }, [controller]);

  const toggleSidebarView = useCallback((): void => {
    if (mobile) {
      sidebar.setRightSidebarVisible(false);
      setMobileDrawerOpen(true);
      return;
    }
    sidebar.setSidebarVisible((visible) => !visible);
  }, [mobile, sidebar, setMobileDrawerOpen]);

  const setInspectorOpen = useCallback(
    (open: boolean): void => {
      sidebar.setRightSidebarVisible(open);
      if (mobile && open) setMobileDrawerOpen(false);
      if (!mobile) settingsService?.set('workspace.rightSidebar.visible', open);
    },
    [mobile, sidebar, settingsService, setMobileDrawerOpen],
  );

  const selectInspectorPanel = useCallback(
    (id: string): void => {
      sidebar.setRightSidebarPanel(id);
      setInspectorOpen(true);
    },
    [sidebar, setInspectorOpen],
  );

  const openQuickSwitcher = useCallback((): void => {
    openSwitcherFor(controller.focusedPane);
  }, [controller, openSwitcherFor]);
  const openSearch = useCallback((): void => {
    openSearchFor(controller.focusedPane);
  }, [controller, openSearchFor]);
  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const handleOpenSearch = (): void => openSearch();
    root.addEventListener(events.openSearch, handleOpenSearch);
    return () => root.removeEventListener(events.openSearch, handleOpenSearch);
  }, [openSearch]);
  const split = useCallback(
    (direction: 'right' | 'down'): void => {
      if (mobile) return;
      controller.splitPane(controller.focusedPane, direction);
    },
    [controller, mobile],
  );

  const shortcuts = useMemo(
    () => ({
      save: handleSave,
      toggleReadingMode,
      toggleSidebar: toggleSidebarView,
      openQuickSwitcher,
      openSearch,
      split,
    }),
    [
      handleSave,
      toggleReadingMode,
      toggleSidebarView,
      openQuickSwitcher,
      openSearch,
      split,
    ],
  );
  useKeyboardShortcuts({ mobile, shortcuts });

  async function handleCloseTab(pane: string, tabId: string): Promise<void> {
    try {
      await controller.closeTab(pane, tabId);
    } catch (error) {
      notify(`Close failed: ${String(error)}`, 'error');
    }
  }

  function openViewTab(viewId: string): void {
    closeMobileDrawers();
    void controller.openView(viewId, { pane: controller.focusedPane });
  }

  async function createNoteInRoot(): Promise<void> {
    const noteChoice = await uiNewNote({
      kinds: ui.services.try(fileExplorerToken)?.creatableKinds() ?? [],
    });
    if (noteChoice === null || noteChoice.kind.kindId === null) return;
    const path = buildNotePath(noteChoice.name, noteChoice.kind.extension);
    try {
      const created = await documents.createAndOpen(path, {
        kindId: noteChoice.kind.kindId,
      });
      const documentId =
        created !== null &&
        created !== undefined &&
        typeof created === 'object' &&
        'documentId' in created
          ? String((created as { documentId: unknown }).documentId)
          : null;
      if (documentId === null) {
        notify('Create failed', 'error');
      }
    } catch (error) {
      console.error('Create note failed', error);
      notify("Couldn't create the note.", 'error');
    }
  }

  async function handleCloseVault(): Promise<void> {
    if (closingVault) return;
    setClosingVault(true);
    try {
      await controller.closeVaultView();
      onClose();
    } catch (error) {
      setClosingVault(false);
      notify(`Close failed: ${String(error)}`, 'error');
    }
  }

  /** Vault identity menu: the home of "Close vault" (sidebar anchor). */
  function openVaultMenu(anchor: HTMLElement | null): void {
    if (anchor === null) return;
    showContextMenu(
      [
        {
          label: 'Edit vault…',
          icon: 'edit',
          run: () => {
            if (profileError !== null) {
              notify(profileError, 'error');
              return;
            }
            if (profileVault === null) {
              notify('Vault is unavailable.', 'error');
              return;
            }
            setEditingVault(true);
          },
        },
        {
          label: 'Close vault',
          icon: 'close',
          run: () => void handleCloseVault(),
        },
      ],
      anchor,
    );
  }

  const focusedState = paneStateOf(controller.focusedPane);
  const focusedShowsGraph = focusedState.viewId === 'graph';
  const focusedDocument =
    focusedState.documentId === null
      ? null
      : (documentById.get(focusedState.documentId) ?? null);
  // The workbench owns outline extraction and caching. A structural host
  // without that capability simply has no outline rows.
  const outlineProvider = controller as WorkbenchOutlineProviderLike;
  const outlineRegistry: SidebarOutlineRegistryLike | undefined =
    outlineProvider.outlineRegistry;
  const outlineModelProvider = outlineProvider.getOutlineModel;
  const structuredOutline = useMemo((): {
    readonly model?: unknown;
    readonly hasModel: boolean;
    readonly revision?: string | number;
  } => {
    if (focusedDocument === null) return { hasModel: false };
    const outlineDoc: WorkbenchOutlineDocumentLike | null = focusedDocument;
    if (outlineDoc.outlineModel !== undefined) {
      return { model: outlineDoc.outlineModel, hasModel: true };
    }
    if (outlineDoc.model !== undefined) {
      return { model: outlineDoc.model, hasModel: true };
    }
    if (
      typeof outlineModelProvider === 'function' &&
      focusedState.documentId !== null
    ) {
      try {
        const resolved = outlineModelProvider(focusedState.documentId);
        if (
          typeof resolved === 'object' &&
          resolved !== null &&
          'model' in resolved
        ) {
          const wrapper = resolved as {
            readonly model: unknown;
            readonly revision?: string | number;
          };
          return {
            model: wrapper.model,
            hasModel: true,
            ...(wrapper.revision !== undefined
              ? { revision: wrapper.revision }
              : {}),
          };
        }
        if (resolved !== null && resolved !== undefined) {
          return { model: resolved, hasModel: true };
        }
      } catch {
        return { hasModel: false };
      }
    }
    return { hasModel: false };
    // the shell revision joins the keys so in-place session
    // commits (which bump the shell via the session content subscription
    // and mint a new dirty-aware outline key) re-resolve the model even
    // when the focused document identity is unchanged. A stable key still
    // hits the registry's frozen rows downstream.
  }, [
    focusedDocument,
    focusedState.documentId,
    outlineModelProvider,
    revision,
  ]);
  useSidebarOutlineInvalidation(
    outlineRegistry,
    focusedDocument?.kindId ?? null,
    focusedState.documentId,
  );
  // Keyed memo: the registry `getOutline` read runs inside the
  // builder, so the whole context build is memoized on the registry
  // reference, kind/model/revision/identity, and shell revision. A stable
  // revision hit returns the same frozen rows without recompute.
  // text-derived outlines (no structured model) never use the
  // global shell revision as their outline key — the registry would
  // recompute on every background-document bump. Omitting the revision
  // lets the registry fall back to `stableKeyOf(text)`, so only a text
  // change recomputes while background bumps hit the frozen rows.
  // Structured legacy models without a revision omit the same way so the
  // content-hash fallback recomputes instead of hitting stale rows.
  const focusedPaneId = controller.focusedPane;
  const structuredHasModel = structuredOutline.hasModel;
  const structuredModel = structuredOutline.model;
  const structuredRevision = structuredOutline.revision;
  const rightSidebarContext = useMemo(
    () =>
      buildRightSidebarContext({
        reading: controller,
        pdf: controller,
        tools: controller,
        focusedPane: focusedPaneId,
        openDocument: (documentId, address) => {
          void router.dispatch({
            type: 'open-document',
            documentId,
            pane: focusedPaneId,
            disposition: 'foreground',
            ...(address === undefined ? {} : { address }),
          });
        },
        focusedState,
        focusedDocument,
        notify,
        outlineRegistry,
        ...(structuredHasModel ? { outlineModel: structuredModel } : {}),
        ...(structuredHasModel && structuredRevision !== undefined
          ? { outlineRevision: structuredRevision }
          : {}),
      }),
    [
      controller,
      focusedPaneId,
      router,
      focusedState,
      focusedDocument,
      notify,
      outlineRegistry,
      structuredHasModel,
      structuredModel,
      structuredRevision,
      revision,
    ],
  );
  // Stylus accessory actions: squeeze opens the built-in Pencil
  // quick palette (core DocumentToolSnapshot tools plus optional
  // `stylusMenuRegistryToken` contributions in a More section), double-tap
  // honors the system preferred action, and the rubber end auto-selects the
  // eraser with restore on release.
  useStylusAccessory({
    services: ui.services,
    tools: controller,
    focusedPane: controller.focusedPane,
    menuContext: {
      pane: controller.focusedPane,
      documentId: focusedState.documentId,
      kindId: focusedDocument?.kindId ?? null,
    },
  });

  const activityClick = (id: 'search' | 'graph'): void => {
    if (id === 'search') {
      openSearchFor(controller.focusedPane);
    } else if (id === 'graph') {
      // Graph lives in a pane tab; toggling closes the focused
      // graph tab when one is already showing.
      if (focusedShowsGraph && focusedState.activeTab !== null) {
        void handleCloseTab(controller.focusedPane, focusedState.activeTab);
        return;
      }
      openViewTab('graph');
    }
  };

  const bottomClick = (id: BottomNavId): void => {
    if (id === 'new-note') {
      void createNoteInRoot();
      return;
    }
    if (id === 'settings') {
      toggleSettingsModal();
      return;
    }
    if (id === 'graph') {
      openViewTab('graph');
      return;
    }
    activityClick(id);
  };

  const paneFor = (paneId: string): DockTreePane =>
    buildDockTreePane({
      paneId,
      ports: {
        state: controller,
        dock: controller,
        documents,
        reading: controller,
        router,
      },
      callbacks: {
        onOpenSwitcher: openSwitcherFor,
        onCreateNote: () => void createNoteInRoot(),
        onOpenProperties: () => selectInspectorPanel('database-properties'),
        notify,
        bump,
        dispatchWorkspaceEvent,
      },
      snapshot: {
        paneState: paneStateOf(paneId),
        paneStateOf,
        focusedPane: dock.focusedPane,
        documentById,
        revision,
      },
      mobile,
      views,
      presentations,
      settingsService,
      drag: dragApi,
    });

  const dockSeam: DockTreeSeam = {
    hosts: {
      editorHosts: session.editorHosts,
      readerHosts: session.readerHosts,
    },
    paneFor,
    dock: controller,
    tools: controller,
  };

  return (
    <WorkspaceContextProvider
      value={{
        controller,
        ui,
        choice: displayedChoice,
        ...(eventTarget !== undefined ? { eventTarget } : {}),
        chrome,
        onClose,
      }}
    >
      <WorkspaceShell
        snapshot={snapshot}
        toast={toast}
        mobile={mobile}
        presentation={presentation}
        mobileDrawerOpen={mobileDrawerOpen}
        setMobileDrawerOpen={setMobileDrawerOpen}
        switchingBreakpoints={switchingBreakpoints}
        closeMobileDrawers={closeMobileDrawers}
        sidebar={sidebar}
        dockSeam={dockSeam}
        drag={dragApi.drag}
        ghost={dragApi.ghost}
        searchActive={switcher?.mode === 'search'}
        focusedShowsGraph={focusedShowsGraph}
        settingsActive={settingsOpen}
        onToggleSidebar={toggleSidebarView}
        onSelectActivity={(id: ActivityId) => activityClick(id)}
        onToggleSettings={toggleSettingsModal}
        onSelectBottom={bottomClick}
        onVaultMenu={openVaultMenu}
        rightSidebarContext={rightSidebarContext}
        onSelectInspectorPanel={selectInspectorPanel}
        onToggleInspector={() => setInspectorOpen(!sidebar.rightSidebarVisible)}
        layoutRef={rootRef}
        overlays={
          <>
            {recoveryError !== null ? (
              <DocumentRecoveryDialog error={recoveryError} onClose={() => setRecoveryError(null)} />
            ) : null}
            {publicationConflict !== null ? (
              <PublicationConflictDialog session={publicationConflict}
                onClose={() => setPublicationConflict(null)}
                onSaved={() => { setPublicationConflict(null); notify('Saved to vault'); }} />
            ) : null}
            {editingVault && profileVault !== null ? (
              <EditVaultDialog
                vault={profileVault}
                profile={profile}
                onSaved={(next) => {
                  setProfile(next);
                  setEditingVault(false);
                }}
                onClose={() => setEditingVault(false)}
              />
            ) : null}
            <ShellOverlays
              documents={controller}
              ui={ui}
              switcher={switcher}
              onPickDocument={(pane, documentId, address) =>
                void router.dispatch({
                  type: 'open-document',
                  documentId,
                  ...(address !== undefined ? { address } : {}),
                  disposition: 'foreground',
                  pane,
                })
              }
              onCloseSwitcher={closeSwitcher}
              settingsOpen={settingsOpen}
              settingsCloseRef={settingsCloseRef}
              settingsRegistry={settingsRegistry}
              backupVaults={vaults}
              onCloseSettings={closeSettingsModal}
            />
          </>
        }
      />
    </WorkspaceContextProvider>
  );
}
