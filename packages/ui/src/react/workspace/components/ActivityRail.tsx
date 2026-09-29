/**
 * Primary activity rail: sidebar toggle, search, graph, and settings.
 */

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../../Icon.jsx';
import { ViewSlot } from '../../ViewSlot.jsx';
import type { ViewRegistry } from '../../../view-registry.js';
import styles from '../../WorkspaceView.module.css';

const activityItems = [
  { id: 'search', icon: 'search', title: 'Search' },
  { id: 'graph', icon: 'graph', title: 'Graph view' },
] as const;

export type ActivityId = (typeof activityItems)[number]['id'];

export function ActivityRail(props: {
  readonly views: ViewRegistry;
  readonly sidebarVisible: boolean;
  readonly searchActive: boolean;
  readonly graphActive: boolean;
  readonly settingsActive: boolean;
  readonly onToggleSidebar: () => void;
  readonly onSelectActivity: (id: ActivityId) => void;
  readonly onToggleSettings: () => void;
}): React.ReactElement {
  const {
    sidebarVisible,
    searchActive,
    graphActive,
    settingsActive,
    onToggleSidebar,
    onSelectActivity,
    onToggleSettings,
  } = props;
  const [revision, setRevision] = useState(0);
  const [openId, setOpenId] = useState<string | null>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(
    null,
  );
  useEffect(
    () => props.views.onDidChange(() => setRevision((n) => n + 1)).dispose,
    [props.views],
  );
  const contributed = props.views.list('activity');
  const openView = contributed.find((view) => view.id === openId);
  useEffect(() => {
    if (openId && !props.views.get(openId)) setOpenId(null);
  }, [revision, openId, props.views]);
  const dragStart = (event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button'))
      return;
    const windowElement = event.currentTarget.parentElement;
    if (!windowElement) return;
    const rect = windowElement.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;
    event.currentTarget.setPointerCapture(event.pointerId);
    const header = event.currentTarget;
    const move = (moveEvent: PointerEvent) => {
      setPosition({
        x: Math.max(
          0,
          Math.min(window.innerWidth - rect.width, moveEvent.clientX - offsetX),
        ),
        y: Math.max(
          0,
          Math.min(
            window.innerHeight - rect.height,
            moveEvent.clientY - offsetY,
          ),
        ),
      });
    };
    const stop = () => {
      header.removeEventListener('pointermove', move);
      header.removeEventListener('pointerup', stop);
      header.removeEventListener('pointercancel', stop);
    };
    header.addEventListener('pointermove', move);
    header.addEventListener('pointerup', stop);
    header.addEventListener('pointercancel', stop);
  };
  return (
    <>
      <nav
        className={styles['fl-activity']}
        data-fl-component="activity"
        aria-label="Primary"
      >
        <ActivityButton
          id="sidebar-toggle"
          icon="panel-left"
          title={sidebarVisible ? 'Close sidebar' : 'Open sidebar'}
          ariaLabel="Toggle sidebar"
          ariaExpanded={sidebarVisible}
          ariaControls="workspace-sidebar"
          size={36}
          iconSize={18}
          active={sidebarVisible}
          onClick={onToggleSidebar}
        />
        {activityItems.map((item) => (
          <ActivityButton
            key={item.id}
            {...item}
            size={36}
            iconSize={18}
            active={item.id === 'search' ? searchActive : graphActive}
            onClick={() => onSelectActivity(item.id)}
          />
        ))}
        {contributed.map((view) => (
          <ActivityButton
            key={view.id}
            id={view.id}
            icon={view.icon ?? 'blocks'}
            title={view.title ?? view.id}
            size={36}
            iconSize={18}
            active={openId === view.id}
            onClick={() => {
              setOpenId(openId === view.id ? null : view.id);
              setPosition(null);
            }}
          />
        ))}
        <span className={styles['activity-spacer']} />
        <ActivityButton
          id="settings"
          icon="settings"
          title="Settings"
          size={36}
          iconSize={18}
          active={settingsActive}
          onClick={onToggleSettings}
        />
      </nav>
      {openView &&
        createPortal(
          <section
            key={openView.id}
            className={styles['activity-window']}
            style={
              position
                ? { left: position.x, top: position.y, transform: 'none' }
                : undefined
            }
            role="dialog"
            aria-modal="false"
            aria-label={openView.title ?? openView.id}
          >
            <header
              className={styles['activity-window-header']}
              onPointerDown={dragStart}
            >
              <span>{openView.title}</span>
              <button
                type="button"
                aria-label={`Close ${openView.title}`}
                onClick={() => setOpenId(null)}
              >
                <Icon name="close" size={16} />
              </button>
            </header>
            <ViewSlot view={openView} />
          </section>,
          document.body,
        )}
    </>
  );
}

export function ActivityButton(props: {
  id: string;
  icon: string;
  title: string;
  ariaLabel?: string;
  ariaExpanded?: boolean;
  ariaControls?: string;
  size: number;
  iconSize: number;
  active: boolean;
  onClick(): void;
}): React.ReactElement {
  return (
    <button
      type="button"
      className={`${styles['activity-button']}${props.active ? ` ${styles.active}` : ''}`}
      data-activity={props.id}
      title={props.title}
      aria-label={props.ariaLabel ?? props.title}
      {...(props.ariaExpanded === undefined
        ? {}
        : { 'aria-expanded': props.ariaExpanded })}
      {...(props.ariaControls === undefined
        ? {}
        : { 'aria-controls': props.ariaControls })}
      onClick={props.onClick}
    >
      <Icon name={props.icon} size={props.iconSize} />
    </button>
  );
}
