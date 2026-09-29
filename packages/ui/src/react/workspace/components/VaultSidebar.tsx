/**
 * Left workspace sidebar: vault identity row plus the file-explorer view.
 *
 * On phones and tablets the sidebar becomes an overlay drawer; on desktop it
 * is a resizable column.
 */

import { useEffect, useState } from 'react';
import type { InstalledUi } from '../../../workbench.js';
import { Icon } from '../../Icon.jsx';
import { ViewSlot } from '../../ViewSlot.jsx';
import type { VaultAppearance } from '@froglight/foundation';
import { VaultIcon } from '../../VaultIcon.jsx';
import styles from '../../WorkspaceView.module.css';

export function VaultSidebar(props: {
  readonly appearance?: VaultAppearance;
  readonly vaultName: string;
  readonly vaultLocation: string;
  readonly mobile: boolean;
  readonly drawerOpen: boolean;
  readonly collapsed: boolean;
  readonly onVaultMenu: (anchor: HTMLElement | null) => void;
  readonly views: InstalledUi['views'];
  readonly revision: number;
  readonly resizer?: React.ReactNode;
}): React.ReactElement {
  const {
    appearance,
    vaultName,
    vaultLocation,
    mobile,
    drawerOpen,
    collapsed,
    onVaultMenu,
    views,
    revision,
    resizer,
  } = props;
  return (
    <aside
      id="workspace-sidebar"
      className={`${styles['fl-sidebar']}${mobile && drawerOpen ? ` ${styles.open}` : ''}${collapsed ? ` ${styles.closed}` : ''}`}
      data-fl-component="sidebar"
      aria-label="Sidebar"
    >
      <div className={styles['sidebar-inner']}>
        <div className={styles['vault-row']}>
          <VaultRowButton
            appearance={appearance}
            name={vaultName}
            location={vaultLocation}
            onOpen={(anchor) => onVaultMenu(anchor)}
          />
        </div>
        <SidebarViewSlot
          views={views}
          sidebarView="file-explorer"
          revision={revision}
        />
      </div>
      {resizer}
    </aside>
  );
}

function VaultRowButton(props: {
  readonly appearance?: VaultAppearance;
  readonly name: string;
  readonly location: string;
  readonly onOpen: (anchor: HTMLButtonElement | null) => void;
}): React.ReactElement {
  const { name, location, appearance, onOpen } = props;
  return (
    <button
      type="button"
      className={styles['vault-row-main']}
      aria-haspopup="menu"
      aria-label={`${name} vault options`}
      title={location}
      onClick={(event) => onOpen(event.currentTarget)}
    >
      <span className={styles['vault-row-chevron']}>
        <Icon name="chevron-down" size={12} />
      </span>
      <VaultIcon appearance={appearance} size={26} />
      <span className={styles['workspace-vault-name']}>{name}</span>
    </button>
  );
}

/** Sidebar view host: resolves the active view definition reactively. */
function SidebarViewSlot(props: {
  views: InstalledUi['views'];
  sidebarView: 'file-explorer';
  revision: number;
}): React.ReactElement {
  const { views, sidebarView, revision } = props;
  const [viewDef, setViewDef] = useState(() => views.get(sidebarView));
  useEffect(
    () =>
      views.onDidChange(() => {
        setViewDef(views.get(sidebarView));
      }).dispose,
    [views, sidebarView],
  );
  useEffect(() => {
    setViewDef(views.get(sidebarView));
  }, [sidebarView, views, revision]);
  return (
    <ViewSlot
      className={styles['sidebar-content']}
      view={viewDef}
      data-fl-keyboard-viewport=""
    />
  );
}
