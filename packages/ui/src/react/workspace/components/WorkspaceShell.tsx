/**
 * Workspace shell layout: titlebar with aligned tab strips, activity rail,
 * vault sidebar, dock panes, document sidebar, and transient overlays.
 *
 * Pure layout over the composition root's state: stable services come from
 * the workspace context, reactive data and callbacks arrive as props, and
 * per-pane presentation flows through the dock seam as view-model/actions
 * pairs.
 */

import type { Dispatch, Ref, SetStateAction } from 'react';
import type { RightSidebarContext } from '../../../right-sidebar-registry.js';
import type { Toast } from '../hooks/useToast.js';
import type { SidebarState } from '../hooks/useSidebarState.js';
import type { DragState } from '../hooks/useTabDrag.js';
import { MAIN_PANE, useWorkspace } from '../WorkspaceContext.js';
import type { WorkspaceSnapshot } from '../hooks/useControllerSnapshot.js';
import { Titlebar } from '../../Titlebar.jsx';
import { IconButton } from '../../Button.jsx';
import { TabStrip } from './TabStrip.jsx';
import { paneTabStripProps } from './Pane.jsx';
import { DockPanes, TopbarStrips, type DockTreeSeam } from './DockTree.jsx';
import { Pane } from './Pane.jsx';
import { ActivityRail, type ActivityId } from './ActivityRail.jsx';
import { BottomNav, type BottomNavId } from './BottomNav.jsx';
import { VaultSidebar } from './VaultSidebar.jsx';
import { InspectorSidebar, RightSidebarTabs } from './InspectorSidebar.jsx';
import { ToastRegion } from './ToastRegion.jsx';
import { SidebarResizer } from './SidebarResizer.jsx';
import styles from '../../WorkspaceView.module.css';
import type { WorkspacePresentationPolicy } from '../interaction-policy.js';

export interface WorkspaceShellProps {
  readonly snapshot: WorkspaceSnapshot;
  readonly toast: Toast | null;
  readonly mobile: boolean;
  readonly presentation: WorkspacePresentationPolicy;
  readonly mobileDrawerOpen: boolean;
  readonly setMobileDrawerOpen: Dispatch<SetStateAction<boolean>>;
  readonly switchingBreakpoints: boolean;
  readonly closeMobileDrawers: () => void;
  readonly sidebar: SidebarState;
  readonly dockSeam: DockTreeSeam;
  readonly drag: DragState | null;
  readonly ghost: { x: number; y: number } | null;
  readonly searchActive: boolean;
  readonly focusedShowsGraph: boolean;
  readonly settingsActive: boolean;
  readonly onToggleSidebar: () => void;
  readonly onSelectActivity: (id: ActivityId) => void;
  readonly onToggleSettings: () => void;
  readonly onSelectBottom: (id: BottomNavId) => void;
  readonly onVaultMenu: (anchor: HTMLElement | null) => void;
  readonly rightSidebarContext: RightSidebarContext | null;
  readonly onSelectInspectorPanel: (id: string) => void;
  readonly onToggleInspector: () => void;
  readonly overlays: React.ReactNode;
  readonly layoutRef: Ref<HTMLDivElement>;
}

export function WorkspaceShell(props: WorkspaceShellProps): React.ReactElement {
  const {
    snapshot,
    toast,
    mobile,
    presentation,
    mobileDrawerOpen,
    setMobileDrawerOpen,
    switchingBreakpoints,
    closeMobileDrawers,
    sidebar,
    dockSeam,
    drag,
    ghost,
    searchActive,
    focusedShowsGraph,
    settingsActive,
    onToggleSidebar,
    onSelectActivity,
    onToggleSettings,
    onSelectBottom,
    onVaultMenu,
    rightSidebarContext,
    onSelectInspectorPanel,
    onToggleInspector,
    overlays,
    layoutRef,
  } = props;
  const { ui, chrome, choice } = useWorkspace();
  const { dock } = snapshot;
  const rightSidebarVisible = sidebar.rightSidebarVisible;
  const rightSidebarPanel = sidebar.rightSidebarPanel;
  const transientChrome = presentation.layout !== 'wide';
  const ghostTitle =
    drag === null
      ? ''
      : (() => {
          const paneState = snapshot.paneStateOf(drag.fromPane);
          const tab = paneState.tabs.find(
            (candidate) => candidate.id === drag.tabId,
          );
          return tab?.kind === 'document'
            ? (snapshot.documentById.get(tab.documentId ?? '')?.title ?? 'Tab')
            : (ui.views.get(tab?.viewId ?? '')?.title ?? 'Tab');
        })();

  return (
    <div
      className={`${styles['froglight-layout']}${!transientChrome && !sidebar.sidebarVisible ? ` ${styles['sidebar-collapsed']}` : ''}${!transientChrome && !rightSidebarVisible ? ` ${styles['right-sidebar-collapsed']}` : ''}${sidebar.sidebarResize !== null ? ` ${styles['sidebar-resizing']}` : ''}${switchingBreakpoints ? ` ${styles['sidebar-switching']}` : ''}`}
      data-fl-component="workspace"
      data-layout={presentation.layout}
      data-density={presentation.controlDensity}
      ref={layoutRef}
      style={
        {
          '--fl-layout-sidebar-width': `${sidebar.sidebarWidth}px`,
          '--fl-layout-right-sidebar-width': `${sidebar.rightSidebarWidth}px`,
        } as React.CSSProperties
      }
    >
      <Titlebar chrome={chrome}>
        {mobile ? (
          <IconButton
            icon="panel-left"
            size={16}
            label={mobileDrawerOpen ? 'Close sidebar' : 'Open sidebar'}
            title={mobileDrawerOpen ? 'Close sidebar' : 'Open sidebar'}
            className={styles['titlebar-toggle']}
            aria-expanded={mobileDrawerOpen}
            aria-controls="workspace-sidebar"
            onClick={() => setMobileDrawerOpen((open) => !open)}
          />
        ) : null}
        <div className={styles['fl-topbar-row']}>
          {mobile ? (
            (() => {
              const focused = dock.focusedPane ?? MAIN_PANE;
              const { model, actions } = dockSeam.paneFor(focused);
              return (
                <TabStrip
                  paneId={focused}
                  {...paneTabStripProps(model, actions)}
                />
              );
            })()
          ) : dock.root !== null ? (
            <TopbarStrips root={dock.root} {...dockSeam} />
          ) : null}
        </div>
        <IconButton
          icon="panel-right"
          size={16}
          label="Toggle document sidebar"
          title={
            rightSidebarVisible
              ? 'Close document sidebar'
              : 'Open document sidebar'
          }
          className={styles['titlebar-inspector-toggle']}
          active={rightSidebarVisible}
          aria-controls="document-sidebar"
          aria-expanded={rightSidebarVisible}
          onClick={onToggleInspector}
        />
        <div className={styles['fl-titlebar-inspector']}>
          {rightSidebarVisible ? (
            <RightSidebarTabs
              registry={ui.rightSidebar}
              context={rightSidebarContext}
              activePanel={rightSidebarPanel}
              onSelect={onSelectInspectorPanel}
            />
          ) : null}
        </div>
      </Titlebar>

      <div className={styles['fl-body']}>
        <ActivityRail
          views={ui.views}
          sidebarVisible={
            transientChrome ? mobileDrawerOpen : sidebar.sidebarVisible
          }
          searchActive={searchActive}
          graphActive={focusedShowsGraph}
          settingsActive={settingsActive}
          onToggleSidebar={
            transientChrome
              ? () => setMobileDrawerOpen((open) => !open)
              : onToggleSidebar
          }
          onSelectActivity={onSelectActivity}
          onToggleSettings={onToggleSettings}
        />

        <VaultSidebar
          appearance={choice.profile}
          vaultName={choice.name}
          vaultLocation={choice.location}
          mobile={transientChrome}
          drawerOpen={mobileDrawerOpen}
          collapsed={!transientChrome && !sidebar.sidebarVisible}
          onVaultMenu={onVaultMenu}
          views={ui.views}
          revision={snapshot.revision}
          resizer={
            !transientChrome && sidebar.sidebarVisible ? (
              <SidebarResizer side="left" api={sidebar} />
            ) : null
          }
        />

        <main className={styles['fl-main']} data-fl-component="main">
          {mobile ? (
            (() => {
              const focused = dock.focusedPane ?? MAIN_PANE;
              const { model, actions } = dockSeam.paneFor(focused);
              return (
                <Pane
                  model={model}
                  actions={actions}
                  hosts={dockSeam.hosts}
                  views={ui.views}
                  tools={dockSeam.tools}
                />
              );
            })()
          ) : dock.root !== null ? (
            <DockPanes
              root={dock.root}
              mobile={mobile}
              maximizedPane={dock.maximizedPane}
              focusedPane={dock.focusedPane}
              {...dockSeam}
            />
          ) : null}
        </main>

        <InspectorSidebar
          registry={ui.rightSidebar}
          context={rightSidebarContext}
          activePanel={rightSidebarPanel}
          open={rightSidebarVisible}
          onSelect={onSelectInspectorPanel}
          onClose={transientChrome ? closeMobileDrawers : undefined}
          resizer={
            !transientChrome && rightSidebarVisible ? (
              <SidebarResizer side="right" api={sidebar} />
            ) : null
          }
        />
      </div>

      <ToastRegion toast={toast} />

      <BottomNav
        searchActive={searchActive}
        graphActive={focusedShowsGraph}
        settingsActive={settingsActive}
        onSelect={onSelectBottom}
      />

      <div
        className={`${styles['fl-backdrop']}${mobileDrawerOpen || (transientChrome && rightSidebarVisible) ? ` ${styles.visible}` : ''}`}
        onClick={closeMobileDrawers}
      />

      {drag !== null && ghost !== null ? (
        <div
          className={styles['fl-drag-ghost']}
          style={{ left: ghost.x + 12, top: ghost.y + 10 }}
        >
          {ghostTitle}
        </div>
      ) : null}

      {overlays}
    </div>
  );
}
