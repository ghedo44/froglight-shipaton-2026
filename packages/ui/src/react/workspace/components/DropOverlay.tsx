/**
 * Drop-zone overlay rendered across a pane while a tab is dragged.
 *
 * Center moves the tab; edges split in that direction. Phones never show
 * pane-edge zones (tab-strip reordering only).
 */

import styles from '../../WorkspaceView.module.css';
import type { DropZone } from '../model/dropTargets.js';

const zones: DropZone[] = ['left', 'right', 'top', 'bottom', 'center'];

function zoneLabel(zone: DropZone): string {
  return zone === 'center'
    ? 'Move tab here'
    : `Split ${zone === 'top' ? 'up' : zone === 'bottom' ? 'down' : zone}`;
}

export function DropOverlay(props: {
  readonly paneId: string;
  /** False while no drag is active (or on phones): renders nothing. */
  readonly visible: boolean;
  readonly activeZone: DropZone | null;
  readonly onZoneEnter: (pane: string, zone: DropZone) => void;
  readonly onZoneLeave: (pane: string) => void;
}): React.ReactElement | null {
  const { paneId, visible, activeZone, onZoneEnter, onZoneLeave } = props;
  if (!visible) return null;
  return (
    <div className={styles['fl-dropzones']}>
      {zones.map((zone) => {
        const label = zoneLabel(zone);
        return (
          <div
            key={zone}
            data-zone={zone}
            className={`${styles['fl-dropzone']}${activeZone === zone ? ` ${styles.active}` : ''}`}
            aria-label={label}
            title={label}
            onPointerEnter={() => onZoneEnter(paneId, zone)}
            onPointerMove={() => onZoneEnter(paneId, zone)}
            onPointerLeave={() => onZoneLeave(paneId)}
          >
            {activeZone === zone ? (
              <span className={styles['fl-dropzone-label']}>{label}</span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
