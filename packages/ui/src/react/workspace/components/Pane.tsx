/**
 * One dock pane: single top bar, editor/reader hosts, floating toolbar
 * layer, view tabs, the empty-pane card, and the tab-drag drop overlay.
 *
 * Render inputs arrive as a single view-model, interactions as a single
 * actions object; stable services (registries) come from the workspace
 * context. Editor hosts stay stable per pane across mode toggles and
 * controller-driven opens.
 *
 * This module also owns pane-local assembly (`buildDockTreePane`): the
 * composition root resolves dependencies and supplies narrow workbench
 * ports plus root callbacks, while title/menu/drag/reading/tool action
 * construction lives here, never reaching for the aggregate controller.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  joinPath,
  parentPath,
  pathName,
  settingsToken,
  documentPresentationToken,
  documentKindId,
  workspacePath,
  type DocumentPresentationRegistry,
} from '@froglight/foundation';
import type {
  DockTabView,
  PaneModeView,
  PaneView,
  WorkbenchDocumentView,
} from '../../../workbench.js';
import type {
  WorkbenchDockPort,
  WorkbenchDocumentPort,
  WorkbenchEditorToolsPort,
  WorkbenchReadingPort,
  WorkbenchReadingPresentation,
  WorkbenchStatePort,
} from '../../../workbench-ports.js';
import type { WorkspaceDocumentRouter } from '../routing/documentRouter.js';
import type { InstalledUi } from '../../../workbench.js';
import type { WorkspaceSettingsService } from '../../../workspace-settings.js';
import type { ViewDef } from '../../../view-registry.js';
import { PREVIEW_VIEW_ID_PREFIX as PREVIEW_VIEW_PREFIX } from '../../../view-registry.js';
import {
  showContextMenu,
  isEditableTarget,
  type MenuEntry,
  type MenuPointAnchor,
} from '../../../menu.js';
import { workspaceEvents as events } from '../../../ui-events.js';
import { documentSettingKey } from '../../../document-preferences.js';
import { uiConfirm } from '../../../dialogs.js';
import { Button } from '../../Button.jsx';
import { ViewSlot } from '../../ViewSlot.jsx';
import {
  FloatingToolbarLayer,
  TopbarCenterTools,
  UnifiedToolbarProvider,
  type UnifiedToolbarProps,
} from '../../UnifiedToolbar.jsx';
import { ToolbarPopoverScope } from '../../toolbar-popover.jsx';
import { ToolbarCustomizationStore } from '../../../toolbar/toolbar-customization.js';
import { fileExplorerToken } from '../../../file-explorer.js';
import { DocumentName } from '../../DocumentName.jsx';
import { useWorkspace } from '../WorkspaceContext.js';
import type { DragState } from '../hooks/useTabDrag.js';
import type { DropTarget, DropZone } from '../model/dropTargets.js';
import { buildTabMenuEntries } from '../actions/tabMenus.js';
import { buildNoteMenuEntries } from '../actions/noteMenus.js';
import type { Notify } from '../hooks/useToast.js';
import {
  PaneHeader,
  toPaneHeaderModel,
  type PaneHeaderModel,
} from './PaneHeader.jsx';
import { DropOverlay } from './DropOverlay.jsx';
import {
  toTabStripModel,
  type TabStripModel,
  type TabStripTab,
} from './TabStrip.jsx';
import type { DockTreePane } from './DockTree.jsx';
import styles from '../../WorkspaceView.module.css';
import readerStyles from '../../MarkdownReaderView.module.css';

export interface PaneHosts {
  readonly editorHosts: { readonly current: Map<string, HTMLElement> };
  readonly readerHosts: { readonly current: Map<string, HTMLElement> };
}

export interface PaneViewModel {
  readonly paneId: string;
  readonly state: PaneView;
  readonly focused: boolean;
  readonly mobile: boolean;
  readonly strip: TabStripModel;
  readonly header: PaneHeaderModel;
  readonly activeTab: DockTabView | null;
  readonly showsEditor: boolean;
  readonly separateReader: boolean;
  readonly showsNativeReader: boolean;
  readonly viewDef: ViewDef | undefined;
  readonly isPreviewFill: boolean;
  readonly showToolbar: boolean;
  readonly toolbarDocumentId: string;
  readonly toolbarKindId: string;
  readonly showEmpty: boolean;
  readonly dropVisible: boolean;
  readonly dropActiveZone: DropZone | null;
  readonly revision: number;
  readonly settingsService: WorkspaceSettingsService | null;
  readonly document: WorkbenchDocumentView | null;
}

/** Presentation-only pane data; derives once per pane per revision. */
export function toPaneViewModel(input: {
  readonly paneId: string;
  readonly paneState: PaneView;
  readonly focusedPane: string | null;
  readonly mobile: boolean;
  readonly documentById: ReadonlyMap<string, WorkbenchDocumentView>;
  readonly presentations?: DocumentPresentationRegistry | null;
  readonly views: InstalledUi['views'];
  readonly drag: DragState | null;
  readonly dropTarget: DropTarget | null;
  readonly revision: number;
  readonly settingsService: WorkspaceSettingsService | null;
  readonly presentation: WorkbenchReadingPresentation;
  readonly availableModes?: readonly PaneModeView[];
}): PaneViewModel {
  const {
    paneId,
    paneState,
    focusedPane,
    mobile,
    documentById,
    presentations,
    views,
    drag,
    dropTarget,
    revision,
    settingsService,
    presentation,
  } = input;
  const activeTab =
    paneState.tabs.find((tab) => tab.id === paneState.activeTab) ?? null;
  const showsEditor = activeTab?.kind === 'document';
  // Centralized reading decision: the presentation query resolves which
  // surface a reading tab mounts. Kinds with a registered reader mount the
  // reader host; other kinds keep the native read-only editor surface.
  const separateReader = showsEditor && presentation.kind === 'separate-reader';
  const showsNativeReader =
    showsEditor && paneState.mode === 'reading' && !separateReader;
  const viewDef =
    activeTab?.kind === 'view' && activeTab.viewId !== null
      ? views.get(activeTab.viewId)
      : undefined;
  return {
    paneId,
    state: paneState,
    focused: focusedPane === paneId,
    mobile,
    strip: toTabStripModel({
      paneId,
      paneState,
      documentById,
      presentations,
      views,
      dragging: drag !== null,
      dropPane: dropTarget?.pane ?? null,
      dropZone: dropTarget?.zone ?? null,
      ...(dropTarget?.index !== undefined
        ? { dropIndex: dropTarget.index }
        : {}),
    }),
    header: toPaneHeaderModel(paneState, input.availableModes),
    activeTab,
    showsEditor,
    document: showsEditor
      ? (documentById.get(paneState.documentId ?? '') ?? null)
      : null,
    separateReader,
    showsNativeReader,
    viewDef,
    isPreviewFill: activeTab?.viewId?.startsWith(PREVIEW_VIEW_PREFIX) === true,
    showToolbar:
      showsEditor &&
      paneState.mode !== 'reading' &&
      presentations?.get(documentKindId(documentById.get(paneState.documentId ?? '')?.kindId ?? ''))
        ?.shell?.toolbar !== 'none',
    toolbarDocumentId: paneState.documentId ?? '',
    toolbarKindId: documentById.get(paneState.documentId ?? '')?.kindId ?? '',
    showEmpty: !showsEditor && activeTab?.kind !== 'view',
    dropVisible: drag !== null && !mobile,
    dropActiveZone: dropTarget?.pane === paneId ? dropTarget.zone : null,
    revision,
    settingsService,
  };
}

export interface PaneActions {
  readonly onPointerDownPane: () => void;
  readonly onActivateTab: (tabId: string, active: boolean) => void;
  readonly onCloseTab: (tabId: string) => void;
  readonly onFocusPane: () => void;
  readonly onOpenSwitcher: () => void;
  readonly onCreateNote: () => void;
  readonly onTabPointerDown: (
    event: React.PointerEvent<HTMLElement>,
    tabId: string,
  ) => void;
  readonly onTabContextMenu: (
    event: React.MouseEvent | React.PointerEvent,
    tabId: string,
  ) => void;
  readonly onGoBack: () => void;
  readonly onGoForward: () => void;
  readonly onSplitRight: () => void;
  readonly onSplitDown: () => void;
  readonly onSetMode: (mode: PaneModeView) => void;
  readonly onOpenNoteMenu: (anchor: HTMLElement | MenuPointAnchor) => void;
  readonly onPaneContextMenu: (
    event: Pick<React.MouseEvent, 'clientX' | 'clientY' | 'currentTarget'>,
  ) => void;
  readonly onZoneEnter: (pane: string, zone: DropZone) => void;
  readonly onZoneLeave: (pane: string) => void;
}

/** Narrow workbench ports one pane's assembly may use. */
export interface DockPanePorts {
  readonly state: WorkbenchStatePort;
  readonly dock: WorkbenchDockPort;
  readonly documents: WorkbenchDocumentPort;
  readonly reading: WorkbenchReadingPort;
  readonly router: WorkspaceDocumentRouter;
}

/** Root-owned concerns the pane assembly calls back into. */
export interface DockPaneCallbacks {
  readonly onOpenSwitcher: (pane: string) => void;
  readonly onCreateNote: () => void;
  readonly onOpenProperties?: () => void;
  readonly notify: Notify;
  readonly bump: () => void;
  readonly dispatchWorkspaceEvent: (name: string, detail: unknown) => void;
}

export interface DockPaneDrag {
  readonly drag: DragState | null;
  readonly dropTarget: DropTarget | null;
  readonly startTabDrag: (
    event: React.PointerEvent<HTMLElement>,
    pane: string,
    tabId: string,
  ) => void;
  readonly onPaneZoneEnter: (pane: string, zone: DropZone) => void;
  readonly clearDropTarget: (pane: string) => void;
}

/**
 * Assemble one pane's view-model and actions from narrow ports. The
 * composition root supplies ports, snapshot data, and root callbacks;
 * everything pane-specific (tab activation with dangling-tab pruning,
 * history walking, splits, reading toggles, tab/note menus) lives here.
 */
export function buildDockTreePane(input: {
  readonly paneId: string;
  readonly ports: DockPanePorts;
  readonly callbacks: DockPaneCallbacks;
  readonly snapshot: {
    readonly paneState: PaneView;
    readonly paneStateOf: (paneId: string) => PaneView;
    readonly focusedPane: string | null;
    readonly documentById: ReadonlyMap<string, WorkbenchDocumentView>;
    readonly revision: number;
  };
  readonly mobile: boolean;
  readonly views: InstalledUi['views'];
  readonly presentations?: DocumentPresentationRegistry | null;
  readonly settingsService: WorkspaceSettingsService | null;
  readonly drag: DockPaneDrag;
}): DockTreePane {
  const {
    paneId,
    ports,
    callbacks,
    snapshot,
    mobile,
    views,
    presentations,
    settingsService,
    drag,
  } = input;
  const { state, dock, documents, reading, router } = ports;
  const { paneState, paneStateOf, focusedPane, documentById, revision } =
    snapshot;
  const { notify, bump, dispatchWorkspaceEvent } = callbacks;

  async function handleActivateTab(pane: string, tabId: string): Promise<void> {
    try {
      state.focusPane(pane);
      await dock.activateTab(pane, tabId);
    } catch (error) {
      // A dangling tab (deleted outside the controller) must never crash
      // the shell: prune it and surface a toast instead.
      try {
        await documents.pruneMissingDocuments();
        bump();
      } catch {
        // Pruning is best-effort; the toast below still explains the click.
      }
      notify(`Open failed: ${String(error)}`, 'error');
    }
  }

  async function handleCloseTab(pane: string, tabId: string): Promise<void> {
    try {
      await dock.closeTab(pane, tabId);
    } catch (error) {
      notify(`Close failed: ${String(error)}`, 'error');
    }
  }

  /**
   * Split `pane` and show the same tab in the new pane — the tab stays put
   * (Obsidian-style split, not a move).
   *
   * A live document has one controller-owned session. Its split creates a
   * usable empty pane; inactive tabs can open their document in the new pane.
   * The race net discards a new leaf if another owner appears before opening.
   */
  async function splitWithTab(
    pane: string,
    tab: DockTabView,
    direction: 'right' | 'down',
  ): Promise<void> {
    if (mobile) return;
    if (tab.kind === 'document' && tab.documentId !== null) {
      const live = dock.liveOwnerOf(tab.documentId);
      if (live !== null) {
        dock.splitPane(pane, direction);
        return;
      }
      const created = dock.splitPane(pane, direction);
      await router.dispatch({
        type: 'open-document',
        documentId: tab.documentId,
        disposition: 'foreground',
        pane: created,
      });
      dock.discardRedirectedSplit(created, tab.documentId);
      return;
    }
    if (tab.viewId !== null) {
      const created = dock.splitPane(pane, direction);
      void dock.openView(tab.viewId, { pane: created });
    }
  }

  const model: PaneViewModel = toPaneViewModel({
    paneId,
    paneState,
    focusedPane,
    mobile,
    documentById,
    presentations,
    views,
    drag: drag.drag,
    dropTarget: drag.dropTarget,
    revision,
    settingsService,
    presentation: reading.readingPresentation(paneId),
    availableModes: reading.availableTabModes(paneId),
  });
  const actions: PaneActions = {
    onPointerDownPane: () => {
      if (focusedPane !== paneId) state.focusPane(paneId);
    },
    onActivateTab: (tabId, active) => {
      if (!active) void handleActivateTab(paneId, tabId);
      else state.focusPane(paneId);
    },
    onCloseTab: (tabId) => void handleCloseTab(paneId, tabId),
    onFocusPane: () => state.focusPane(paneId),
    onOpenSwitcher: () => callbacks.onOpenSwitcher(paneId),
    onCreateNote: () => callbacks.onCreateNote(),
    onTabPointerDown: (event, tabId) => drag.startTabDrag(event, paneId, tabId),
    onTabContextMenu: (event, tabId) => {
      const tab = paneState.tabs.find((candidate) => candidate.id === tabId);
      if (tab === undefined) return;
      showContextMenu(
        buildTabMenuEntries({
          pane: paneId,
          desktopLayout: !mobile,
          leafIds: () => dock.leafIds(),
          otherTabs: () =>
            paneStateOf(paneId).tabs.filter(
              (candidate) => candidate.id !== tabId,
            ),
          canSplitWithTab:
            tab.kind !== 'document' ||
            tab.documentId === null ||
            dock.liveOwnerOf(tab.documentId) === null,
          splitWithTab: (direction) =>
            void splitWithTab(paneId, tab, direction),
          moveTabToPane: (next) => {
            void dock.moveTab(paneId, tabId, {
              kind: 'pane',
              pane: next,
            });
          },
          closeTab: () => void handleCloseTab(paneId, tabId),
          closeOtherTabs: () => {
            for (const candidate of paneStateOf(paneId).tabs.filter(
              (other) => other.id !== tabId,
            ))
              void handleCloseTab(paneId, candidate.id);
          },
          closeAllTabs: () => {
            for (const candidate of paneStateOf(paneId).tabs) {
              void handleCloseTab(paneId, candidate.id);
            }
          },
        }),
        {
          x: event.clientX,
          y: event.clientY,
          invoker: event.currentTarget as HTMLElement,
        },
      );
    },
    onGoBack: () => {
      state.focusPane(paneId);
      void documents.goBack().then((moved) => moved && bump());
    },
    onGoForward: () => {
      state.focusPane(paneId);
      void documents.goForward().then((moved) => moved && bump());
    },
    onSplitRight: () => dock.splitPane(paneId, 'right'),
    onSplitDown: () => dock.splitPane(paneId, 'down'),
    onSetMode: (mode) => {
      state.focusPane(paneId);
      const current = paneStateOf(paneId);
      if (current.activeTab === null) return;
      try {
        reading.setTabMode(paneId, current.activeTab, mode);
      } catch (error) {
        // A provider may refuse the presentation change synchronously; the
        // shell must survive it with the same feedback as other failed
        // pane operations, and never let the exception escape the click.
        notify(`Mode change failed: ${String(error)}`, 'error');
      }
    },
    onOpenNoteMenu: (anchor) => {
      state.focusPane(paneId);
      const current = paneStateOf(paneId);
      const docId = current.documentId;
      if (docId === null) return;
      const document = documentById.get(docId);
      const readingDefault =
        settingsService?.get<boolean>(
          documentSettingKey(docId, 'view'),
          false,
        ) ?? false;
      showContextMenu(
        buildNoteMenuEntries({
          documentId: docId,
          documentTitle: document?.title ?? null,
          documentPath: document?.path ?? '',
          openProperties: callbacks.onOpenProperties,
          ...(!mobile
            ? {
                splitRight: () => dock.splitPane(paneId, 'right'),
                splitDown: () => dock.splitPane(paneId, 'down'),
              }
            : {}),
          readingDefault,
          revealInExplorer: () => {
            dispatchWorkspaceEvent(events.activeDocument, {
              documentId: docId,
              previewPath: null,
              reveal: true,
            });
          },
          writeClipboard: (text) =>
            navigator.clipboard?.writeText(text) ?? Promise.resolve(),
          onClipboardUnavailable: () =>
            notify('Clipboard unavailable', 'error'),
          makeCopy: (copyPath) => {
            void documents
              .createAndOpen(copyPath)
              .then(() => bump())
              .catch((error: unknown) =>
                notify(`Copy failed: ${String(error)}`, 'error'),
              );
          },
          setReadingDefault: (value) => {
            settingsService?.set(documentSettingKey(docId, 'view'), value);
          },
          applyReadingModeNow: () => {
            reading.setTabMode(paneId, docId, 'reading');
          },
          deleteDocument: () => {
            void uiConfirm(
              `Move “${document?.title ?? 'this document'}” to Trash?`,
              'You can restore this document from Trash later.',
              'Move to Trash',
            )
              .then((confirmed) => {
                if (!confirmed) return;
                return documents.deleteDocument(docId);
              })
              .catch((error: unknown) => {
                notify(`Delete failed: ${String(error)}`, 'error');
              });
          },
        }),
        anchor,
      );
    },
    onPaneContextMenu: (event) => {
      const entries: MenuEntry[] = mobile
        ? []
        : [
            {
              label: 'Split left',
              run: () => dock.splitPane(paneId, 'left'),
            },
            {
              label: 'Split right',
              icon: 'split-right',
              run: () => dock.splitPane(paneId, 'right'),
            },
            {
              label: 'Split up',
              run: () => dock.splitPane(paneId, 'up'),
            },
            {
              label: 'Split down',
              icon: 'split-down',
              run: () => dock.splitPane(paneId, 'down'),
            },
          ];
      entries.push({
        label: 'Close pane',
        icon: 'close',
        run: () => void dock.closePane(paneId),
      });
      if (dock.leafIds().length > 1) {
        entries.push({
          label: 'Close other panes',
          run: () => void dock.closeOtherPanes(paneId),
        });
      }
      showContextMenu(entries, {
        x: event.clientX,
        y: event.clientY,
        invoker: event.currentTarget as HTMLElement,
      });
    },
    onZoneEnter: (pane, zone) => drag.onPaneZoneEnter(pane, zone),
    onZoneLeave: (pane) => drag.clearDropTarget(pane),
  };
  return { model, actions };
}

export function Pane(props: {
  readonly model: PaneViewModel;
  readonly actions: PaneActions;
  readonly hosts: PaneHosts;
  readonly views: InstalledUi['views'];
  readonly tools: WorkbenchEditorToolsPort;
}): React.ReactElement {
  const { model, tools } = props;
  const { ui } = useWorkspace();
  const { paneId } = model;
  const settings = ui.services.try(settingsToken);
  const slotCustomization = useMemo(
    () =>
      new ToolbarCustomizationStore(settings === undefined ? {} : { settings }),
    [settings],
  );
  useEffect(
    () => () => {
      slotCustomization.dispose();
    },
    [slotCustomization],
  );
  const toolbarProps: UnifiedToolbarProps = {
    tools,
    contributions: ui.documentTools,
    placements: ui.documentToolbarPlacements,
    composition: ui.toolbarComposition,
    pane: paneId,
    documentId: model.toolbarDocumentId,
    kindId: model.toolbarKindId,
    slotCustomization,
  };
  // Single toolbar computation per pane: both the top-bar center and the
  // floating layer consume the same pane-level model with one subscription
  // per source, not one per surface. Always wrapped (even in reading mode
  // with no visible toolbar) so edit/reading toggles preserve DOM identity
  // for header references instead of remounting the pane section.
  return (
    <UnifiedToolbarProvider {...toolbarProps}>
      <PaneContent
        model={model}
        actions={props.actions}
        hosts={props.hosts}
        views={props.views}
        toolbarProps={toolbarProps}
      />
    </UnifiedToolbarProvider>
  );
}

function PaneContent(props: {
  readonly model: PaneViewModel;
  readonly actions: PaneActions;
  readonly hosts: PaneHosts;
  readonly views: InstalledUi['views'];
  readonly toolbarProps: UnifiedToolbarProps;
}): React.ReactElement {
  const { model, actions, hosts, views, toolbarProps } = props;
  const { paneId } = model;
  const { controller, ui } = useWorkspace();
  const shell = model.document?.kindId
    ? ui.services.try(documentPresentationToken)
        ?.get(documentKindId(model.document.kindId))?.shell
    : undefined;
  const paneBodyRef = useRef<HTMLDivElement | null>(null);
  const [titleSlots, setTitleSlots] = useState<{
    editor: HTMLElement | null;
    reader: HTMLElement | null;
  }>({ editor: null, reader: null });
  useLayoutEffect(() => {
    const body = paneBodyRef.current;
    if (
      !body ||
      (shell?.title !== 'provider' && shell?.title !== 'overlay')
    )
      return;
    const findSlots = () => {
      const editor = body.querySelector<HTMLElement>(
        '[data-fl-document-title-slot="editor"]',
      );
      const reader = body.querySelector<HTMLElement>(
        '[data-fl-document-title-slot="reader"]',
      );
      setTitleSlots((current) =>
        current.editor === editor && current.reader === reader
          ? current
          : { editor, reader },
      );
    };
    findSlots();
    const observer = new MutationObserver(findSlots);
    observer.observe(body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [model.document?.documentId, shell?.title]);
  const documentName = (
    layout: 'markdown' | 'block' | 'reading',
    editable: boolean,
  ) =>
    model.document ? (
      <DocumentName
        key={model.document.documentId}
        name={
          pathName(workspacePath(model.document.path))?.replace(
            /\.[^.]+$/,
            '',
          ) ?? model.document.title
        }
        editable={editable}
        extension={model.document.path.slice(
          model.document.path.lastIndexOf('.'),
        )}
        layout={layout}
        onRename={async (nextName) => {
          const document = model.document;
          if (!document) return;
          if (
            controller.paneStates().find((pane) => pane.pane === paneId)
              ?.documentId !== document.documentId
          )
            throw new Error(
              'This document is no longer open in this pane. Refresh and retry.',
            );
          const filename =
            pathName(workspacePath(document.path)) ?? document.path;
          const dot = filename.lastIndexOf('.');
          const extension = dot > 0 ? filename.slice(dot) : '';
          const current = controller
            .listDocuments()
            .find((item) => item.documentId === document.documentId);
          if (!current || current.path !== document.path)
            throw new Error(
              'This document was renamed elsewhere. Refresh and retry.',
            );
          const nextPath = joinPath(
            parentPath(workspacePath(document.path)),
            `${nextName}${extension}`,
          );
          if (controller.listDocuments().some((item) => item.path === nextPath))
            throw new Error('A document with this name already exists.');
          if (!controller.moveDocumentTo)
            throw new Error('Renaming is unavailable in this workspace.');
          const saved = await controller.savePane(paneId);
          if (
            controller.paneStates().find((pane) => pane.pane === paneId)
              ?.documentId !== document.documentId
          )
            throw new Error(
              'This document is no longer open in this pane. Refresh and retry.',
            );
          if (!saved?.committed)
            throw (
              saved?.error ??
              new Error('Save this document before renaming it.')
            );
          await controller.moveDocumentTo(document.documentId, nextPath);
          ui.services.try(fileExplorerToken)?.refresh();
        }}
      />
    ) : null;
  const editorTitleLayout: 'markdown' | 'block' | null =
    shell?.title === 'provider'
      ? 'markdown'
      : shell?.title === 'overlay'
        ? 'block'
        : null;
  const editorTitleEditable =
    shell?.title === 'overlay'
      ? model.state.mode === 'edit'
      : model.state.mode !== 'reading';
  return (
    <section
      data-pane={paneId}
      data-presentation={model.state.mode}
      className={`${styles['fl-pane']}${model.focused ? ` ${styles.focused}` : ''}`}
      onPointerDown={actions.onPointerDownPane}
    >
      <ToolbarPopoverScope>
        <PaneHeader
          model={model.header}
          actions={{
            onGoBack: actions.onGoBack,
            onGoForward: actions.onGoForward,
            onPaneContextMenu: actions.onPaneContextMenu,
            onSetMode: actions.onSetMode,
            onOpenNoteMenu: actions.onOpenNoteMenu,
          }}
          views={views}
          allowVisibleSplit={!model.mobile}
          center={
            model.showToolbar ? (
              <TopbarCenterTools {...toolbarProps} />
            ) : undefined
          }
        />

        <div
          ref={paneBodyRef}
          className={
            model.showToolbar
              ? `${styles['fl-pane-body']} ${styles['fl-pane-body-floating']}`
              : styles['fl-pane-body']
          }
        >
          {editorTitleLayout && titleSlots.editor
            ? createPortal(
                documentName(editorTitleLayout, editorTitleEditable),
                titleSlots.editor,
              )
            : null}
          {shell?.title === 'provider' && titleSlots.reader
            ? createPortal(documentName('reading', false), titleSlots.reader)
            : null}
          {model.showsEditor &&
            (model.state.mode !== 'reading' || model.showsNativeReader) &&
            model.state.editorAvailable === false &&
            model.state.editorLoading !== true && (
              <p role="status">
                Document content is unavailable. Close and reopen this tab to
                try again.
              </p>
            )}
          <div
            role="region"
            aria-label="Document source"
            className={`${styles['editor-area']} fl-pane-editor`}
            onContextMenu={(event) => {
              if (isEditableTarget(event.target)) return;
              if (shell?.defaultContextMenu === false) {
                event.preventDefault();
                return;
              }
              if (
                event.target !== event.currentTarget &&
                !(event.target instanceof HTMLCanvasElement)
              )
                return;
              event.preventDefault();
              actions.onOpenNoteMenu({
                x: event.clientX,
                y: event.clientY,
                invoker: event.currentTarget,
              });
            }}
            style={{
              flex: 1,
              display:
                model.showsEditor &&
                (model.state.mode !== 'reading' || model.showsNativeReader)
                  ? 'flex'
                  : 'none',
              minWidth: 0,
              minHeight: 0,
            }}
            ref={(element) => {
              if (element === null) hosts.editorHosts.current.delete(paneId);
              else hosts.editorHosts.current.set(paneId, element);
            }}
          />

          {model.showToolbar ? (
            <FloatingToolbarLayer {...toolbarProps} />
          ) : null}

          {model.showsEditor &&
          model.state.mode !== 'edit' &&
          model.separateReader ? (
            <div
              role="region"
              aria-label="Document preview"
              tabIndex={0}
              className="reader-area fl-pane-reader"
              style={{
                flex: 1,
                display: 'flex',
                minWidth: 0,
                minHeight: 0,
              }}
              ref={(element) => {
                if (element === null) hosts.readerHosts.current.delete(paneId);
                else hosts.readerHosts.current.set(paneId, element);
              }}
            />
          ) : (
            <div
              className={`${readerStyles.preview} fl-pane-preview`}
              style={{ display: 'none' }}
              ref={(element) => {
                if (element === null) hosts.readerHosts.current.delete(paneId);
              }}
            />
          )}

          {model.activeTab?.kind === 'view' ? (
            <div
              className={styles['fl-pane-view']}
              style={{ flex: 1, minHeight: 0 }}
            >
              <ViewSlot
                view={model.viewDef}
                className={
                  model.isPreviewFill || model.viewDef?.id === 'graph'
                    ? styles['fl-pane-view-fill']
                    : undefined
                }
              />
            </div>
          ) : null}

          {model.showEmpty ? (
            <div className={styles['pane-empty']}>
              <div className={styles['pane-empty-card']}>
                <div className={styles['pane-empty-title']}>
                  No document open
                </div>
                <div className={styles['pane-empty-hint']}>
                  Choose a document from the workspace or create one.
                </div>
                <div className={styles['pane-empty-actions']}>
                  <Button
                    type="button"
                    variant="primary"
                    onClick={actions.onCreateNote}
                  >
                    Create document
                  </Button>
                  <Button type="button" onClick={actions.onOpenSwitcher}>
                    Search workspace
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
        </div>
        <DropOverlay
          paneId={paneId}
          visible={model.dropVisible}
          activeZone={model.dropActiveZone}
          onZoneEnter={actions.onZoneEnter}
          onZoneLeave={actions.onZoneLeave}
        />
      </ToolbarPopoverScope>
    </section>
  );
}

/** Tab-strip inputs for a pane, derived from the pane view-model. */
export function paneTabStripProps(
  model: PaneViewModel,
  actions: PaneActions,
): {
  readonly tabs: TabStripTab[];
  readonly insertAt: number | null;
  readonly onTabPointerDown: (
    event: React.PointerEvent<HTMLElement>,
    tabId: string,
  ) => void;
  readonly onTabClick: (tabId: string, active: boolean) => void;
  readonly onTabAuxClick: (tabId: string) => void;
  readonly onTabContextMenu: (
    event: React.MouseEvent | React.PointerEvent,
    tabId: string,
  ) => void;
  readonly onTabClose: (tabId: string) => void;
  readonly onOpenSwitcher: () => void;
  readonly onPaneContextMenu: PaneActions['onPaneContextMenu'];
} {
  return {
    tabs: model.strip.tabs,
    insertAt: model.strip.insertAt,
    onTabPointerDown: actions.onTabPointerDown,
    onTabClick: actions.onActivateTab,
    onTabAuxClick: actions.onCloseTab,
    onTabContextMenu: actions.onTabContextMenu,
    onTabClose: actions.onCloseTab,
    onOpenSwitcher: actions.onOpenSwitcher,
    onPaneContextMenu: actions.onPaneContextMenu,
  };
}
