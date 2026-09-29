/**
 * Keyboard- and pointer-accessible sidebar resize handle.
 */

import type { SidebarSide, SidebarState } from '../hooks/useSidebarState.js';
import { RIGHT_SIDEBAR_WIDTH, SIDEBAR_WIDTH } from '../hooks/useSidebarState.js';
import styles from '../../WorkspaceView.module.css';

export function SidebarResizer(props: {
  readonly side: SidebarSide;
  readonly api: SidebarState;
}): React.ReactElement {
  const { side, api } = props;
  const left = side === 'left';
  const width = left ? api.sidebarWidth : api.rightSidebarWidth;
  const bounds = left ? SIDEBAR_WIDTH : RIGHT_SIDEBAR_WIDTH;
  return (
    <div
      className={`${styles['fl-sidebar-resizer']} ${styles[side]}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={
        left ? 'Resize workspace sidebar' : 'Resize document sidebar'
      }
      aria-valuemin={bounds.min}
      aria-valuemax={bounds.max}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={(event) => api.beginSidebarResize(side, event)}
      onKeyDown={(event) => {
        const grows = left
          ? event.key === 'ArrowRight'
          : event.key === 'ArrowLeft';
        const shrinks = left
          ? event.key === 'ArrowLeft'
          : event.key === 'ArrowRight';
        if (event.key === 'Home') {
          event.preventDefault();
          api.edgeSidebarSize(side, 'min');
        } else if (event.key === 'End') {
          event.preventDefault();
          api.edgeSidebarSize(side, 'max');
        } else if (grows || shrinks) {
          event.preventDefault();
          api.stepSidebarSize(side, grows ? 1 : -1);
        }
      }}
    />
  );
}
