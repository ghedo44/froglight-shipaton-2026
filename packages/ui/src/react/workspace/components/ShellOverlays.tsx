/**
 * Modal overlays of the workspace shell: quick switcher / scoped search and
 * the settings modal. Dialog owns their exit transition.
 *
 * Global overlays portal to `document.body` (containing-block
 * fix): `.froglight-layout` carries `contain: layout paint`, which would
 * otherwise establish the containing block for fixed descendants and
 * detach keyboard-aware backdrops from the real viewport. The portal keeps
 * the workspace containment intact while overlays lay out against the
 * viewport.
 */

import type { InstalledUi } from '../../../workbench.js';
import type { WorkbenchStatePort } from '../../../workbench-ports.js';
import type { SettingsSectionRegistry } from '../../../settings-registry.js';
import type { VaultHostAdapter } from '../../../launcher.js';
import { SwitcherOverlay } from '../../SwitcherOverlay.jsx';
import { SettingsModal } from '../../SettingsModal.jsx';
import { BackupVaultContext } from '../../VaultBackupSettingsView.jsx';
import type { DialogHandle } from '../../primitives/Dialog.jsx';
import type { Ref } from 'react';

export interface SwitcherState {
  readonly pane: string;
  readonly mode: 'quick' | 'search';
  /** Remount identity so a rapid close/reopen cannot retain settled state. */
  readonly instance: number;
}

export function ShellOverlays(props: {
  readonly documents: Pick<WorkbenchStatePort, 'listDocuments'>;
  readonly ui: InstalledUi;
  readonly switcher: SwitcherState | null;
  readonly onPickDocument: (
    pane: string,
    documentId: string,
    address?: string,
  ) => void;
  readonly onCloseSwitcher: () => void;
  readonly settingsOpen: boolean;
  readonly settingsCloseRef?: Ref<DialogHandle>;
  /** Null when the settings registry is unavailable: renders nothing. */
  readonly settingsRegistry: SettingsSectionRegistry | null;
  readonly backupVaults?: VaultHostAdapter;
  readonly onCloseSettings: () => void;
}): React.ReactNode {
  const {
    documents,
    ui,
    switcher,
    onPickDocument,
    onCloseSwitcher,
    settingsOpen,
    settingsCloseRef,
    settingsRegistry,
    backupVaults,
    onCloseSettings,
  } = props;
  return (
    <>
      {switcher !== null ? (
        <SwitcherOverlay
          key={switcher.instance}
          listDocuments={() => {
            try {
              return documents.listDocuments();
            } catch {
              return [];
            }
          }}
          search={(query) => ui.search.search(query)}
          onPick={(documentId, address) => {
            onPickDocument(switcher.pane, documentId, address);
          }}
          onClose={() => onCloseSwitcher()}
        />
      ) : null}

      {settingsOpen && settingsRegistry !== null ? (
        <BackupVaultContext.Provider
          value={backupVaults === undefined ? null : { vaults: backupVaults }}
        >
          <SettingsModal
            registry={settingsRegistry}
            closeRef={settingsCloseRef}
            onClose={onCloseSettings}
          />
        </BackupVaultContext.Provider>
      ) : null}
    </>
  );
}
