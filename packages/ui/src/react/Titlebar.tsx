import { useEffect, useState } from 'react';
import type { WindowChrome } from '../window-chrome.js';
import { Icon } from './Icon.jsx';
import styles from './Titlebar.module.css';

/**
 * The one titlebar surface. Hosts contribute behavior through a
 * `WindowChrome` adapter; the bar itself stays plain UI:
 *
 * - children sit at the left (workspace: mobile toggle, tab strip)
 * - empty space is a drag region when the host marks drag regions
 * - when `chrome.appControls` is set the bar draws minimize/maximize/close
 * - `chrome.inset()` padding keeps the bar clear of OS-drawn controls
 */
export function Titlebar(props: {
  chrome: WindowChrome;
  children?: React.ReactNode;
}): React.ReactElement {
  const { chrome } = props;
  const [inset, setInset] = useState(chrome.inset());
  const [maximized, setMaximized] = useState(chrome.maximized?.() ?? false);

  useEffect(() => {
    setInset(chrome.inset());
    setMaximized(chrome.maximized?.() ?? false);
    const disposeInset = chrome.onInsetChange?.(() => setInset(chrome.inset()));
    const disposeMaximized = chrome.onMaximizedChange?.(() => {
      setMaximized(chrome.maximized?.() ?? false);
    });
    return () => {
      disposeInset?.dispose();
      disposeMaximized?.dispose();
    };
  }, [chrome]);

  const dragMarker = chrome.dragRegion ? '' : undefined;
  const beginWindowDrag = (event: React.PointerEvent<HTMLElement>): void => {
    if (!chrome.dragRegion || event.button !== 0) return;
    const target = event.target as HTMLElement;
    // Explicit Tauri regions already initiate native dragging themselves;
    // delegation covers otherwise-empty descendants inside the titlebar.
    if (target.hasAttribute('data-tauri-drag-region')) return;
    if (
      target.closest(
        'button, a, input, select, textarea, [role="button"], [role="tab"], [role="separator"], [data-no-window-drag]',
      ) !== null
    )
      return;
    void chrome.startDragging?.();
  };
  return (
    <header
      className={styles['fl-titlebar']}
      data-fl-component="titlebar"
      data-tauri-drag-region={dragMarker}
      onPointerDown={beginWindowDrag}
      style={
        {
          '--fl-titlebar-inset-left': `${inset.left}px`,
          '--fl-titlebar-inset-right': `${inset.right}px`,
          '--fl-window-controls-width': chrome.appControls ? '132px' : '0px',
        } as React.CSSProperties
      }
    >
      <div className={styles['fl-titlebar-main']} data-tauri-drag-region={dragMarker}>
        {props.children}
      </div>
      <div className={styles['fl-titlebar-spacer']} data-tauri-drag-region={dragMarker} />
      {chrome.appControls ? (
        <div className={styles['fl-wincontrols']}>
          <button
            type="button"
            className={styles['fl-wincontrol']}
            aria-label="Minimize window"
            title="Minimize"
            onClick={() => void chrome.minimize()}
          >
            <Icon name="window-min" size={13} />
          </button>
          <button
            type="button"
            className={styles['fl-wincontrol']}
            aria-label={maximized ? 'Restore window' : 'Maximize window'}
            title={maximized ? 'Restore' : 'Maximize'}
            onClick={() => void chrome.toggleMaximize()}
          >
            <Icon
              name={maximized ? 'window-restore' : 'window-max'}
              size={13}
            />
          </button>
          <button
            type="button"
            className={`${styles['fl-wincontrol']} ${styles.close}`}
            aria-label="Close window"
            title="Close"
            onClick={() => void chrome.close()}
          >
            <Icon name="close" size={14} />
          </button>
        </div>
      ) : null}
    </header>
  );
}
