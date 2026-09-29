import { useEffect, useState } from 'react';
import type {
  InstalledUi,
  VaultChoice,
  WorkbenchControllerView,
} from '../workbench.js';
import type { VaultHostAdapter } from '../launcher.js';
import type { WindowChrome } from '../window-chrome.js';
import { LauncherView } from './LauncherView.jsx';
import { WorkspaceView } from './WorkspaceView.jsx';

/**
 * Top-level application state machine: the launcher is the resting surface;
 * a workspace mounts only while one vault choice is active, and closing it
 * returns to the launcher.
 */
export function FroglightApp(props: {
  controller: WorkbenchControllerView;
  vaults: VaultHostAdapter;
  ui: InstalledUi;
  /** Host-provided root: imperative views dispatch app events here. */
  eventTarget?: HTMLElement;
  /** Window-chrome adapter; the plain-browser fallback renders a bare header. */
  chrome: WindowChrome;
}): React.ReactElement {
  const { controller, vaults, ui, eventTarget, chrome } = props;
  const [activeChoice, setActiveChoice] = useState<VaultChoice | null>(null);

  // Report the launcher selection to the shell: the Vault Sync
  // settings read it as "Current vault" and the sync service parks cloud
  // work while another vault is visible. Runs as an effect so host vault
  // activation (which opens the workspace) settles first.
  useEffect(() => {
    ui.setActiveVault(
      activeChoice === null
        ? null
        : { id: activeChoice.id, name: activeChoice.name },
    );
  }, [ui, activeChoice]);

  if (activeChoice === null) {
    return (
      <LauncherView
        vaults={vaults}
        onOpen={setActiveChoice}
        chrome={chrome}
        ui={ui}
      />
    );
  }

  return (
    <WorkspaceView
      key={activeChoice.id}
      controller={controller}
      ui={ui}
      choice={activeChoice}
      vaults={vaults}
      eventTarget={eventTarget}
      chrome={chrome}
      onClose={() => setActiveChoice(null)}
    />
  );
}
