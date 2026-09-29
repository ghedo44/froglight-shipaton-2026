/**
 * One tab strip: tabs, quick-switcher "+", aligned above its pane.
 *
 * Presentation-only: tab view-models derive once via `toTabStripTabs` and
 * the parent owns activation, closing, menus, and drag initiation.
 */

import { useEffect, useId, useRef } from 'react';
import { Icon } from '../../Icon.jsx';
import { iconForPath } from '../../../file-kinds.js';
import { documentKindId, type DocumentPresentationRegistry } from '@froglight/foundation';
import type { PaneView } from '../../../workbench.js';
import type { ViewRegistry } from '../../../view-registry.js';
import {
  TAB_TOUCH_LONG_PRESS_MS,
  pointerDragSlop,
} from '../interaction-policy.js';
import styles from '../../WorkspaceView.module.css';

const TOUCH_DOUBLE_TAP_INTERVAL_MS = 350;

export interface TabStripTab {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly title: string | undefined;
  readonly active: boolean;
  readonly dirty: boolean;
  readonly saveError?: boolean;
  readonly saveStatus?: string;
}

export interface TabStripModel {
  readonly tabs: TabStripTab[];
  /** Insertion slot for the dragged tab, or null when not dropping here. */
  readonly insertAt: number | null;
}

/** Presentation-only strip data; derives once per pane per revision. */
export function toTabStripModel(input: {
  readonly paneId: string;
  readonly paneState: PaneView;
  readonly documentById: ReadonlyMap<string, { title: string; path: string; kindId?: string }>;
  readonly presentations?: DocumentPresentationRegistry | null;
  readonly views: ViewRegistry;
  readonly dragging: boolean;
  readonly dropPane: string | null;
  readonly dropZone: string | null;
  readonly dropIndex?: number;
}): TabStripModel {
  const {
    paneId,
    paneState,
    documentById,
    presentations,
    views,
    dragging,
    dropPane,
    dropZone,
    dropIndex,
  } = input;
  return {
    tabs: toTabStripTabs(paneState, documentById, views, presentations),
    insertAt:
      dragging && dropPane === paneId && dropZone === 'tab'
        ? (dropIndex ?? null)
        : null,
  };
}
/** Presentation-only tab data; derives once per pane per revision. */
export function toTabStripTabs(
  paneState: PaneView,
  documentById: ReadonlyMap<string, { title: string; path: string; kindId?: string }>,
  views: ViewRegistry,
  presentations?: DocumentPresentationRegistry | null,
): TabStripTab[] {
  return paneState.tabs.map((tab) => {
    const tabView =
      tab.kind === 'view' && tab.viewId !== null
        ? views.get(tab.viewId)
        : undefined;
    const label =
      tab.kind === 'document'
        ? (documentById.get(tab.documentId ?? '')?.title ?? tab.id)
        : (tabView?.title ?? tab.viewId ?? 'View');
    return {
      id: tab.id,
      label,
      icon:
        tab.kind === 'document'
          ? (() => {
            const document = documentById.get(tab.documentId ?? '');
            return (document?.kindId
              ? presentations?.get(documentKindId(document.kindId))?.icon
              : undefined) ?? iconForPath(document?.path ?? '');
          })()
          : (tabView?.icon ?? (tab.viewId === 'graph' ? 'graph' : 'blocks')),
      title:
        tab.kind === 'document'
          ? documentById.get(tab.documentId ?? '')?.path
          : (tabView?.description ?? label),
      active: tab.id === paneState.activeTab,
      dirty: tab.dirty ?? (tab.id === paneState.activeTab && paneState.dirty),
      saveError: tab.saveError ?? false,
      saveStatus: tab.saveStatus,
    };
  });
}

export interface TabStripProps {
  readonly paneId: string;
  readonly tabs: readonly TabStripTab[];
  /** Insertion slot for the dragged tab, or null when not dropping here. */
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
  readonly onPaneContextMenu?: (
    event: Pick<
      React.MouseEvent<HTMLElement>,
      'clientX' | 'clientY' | 'currentTarget'
    >,
  ) => void;
}

export function TabStrip(props: TabStripProps): React.ReactElement {
  const {
    paneId,
    tabs,
    insertAt,
    onTabPointerDown,
    onTabClick,
    onTabAuxClick,
    onTabContextMenu,
    onTabClose,
    onOpenSwitcher,
    onPaneContextMenu,
  } = props;
  const id = useId();
  const stripRoot = useRef<HTMLDivElement | null>(null);
  const blankPress = useRef<{
    pointerId: number;
    x: number;
    y: number;
    timer: ReturnType<typeof setTimeout>;
  } | null>(null);
  const cancelBlankPress = (): void => {
    if (blankPress.current !== null) clearTimeout(blankPress.current.timer);
    blankPress.current = null;
  };
  useEffect(() => {
    const strip = stripRoot.current;
    const suppressBlankSelection = (event: TouchEvent): void => {
      if (
        event.target instanceof Element &&
        event.target.closest(`button, .${styles['fl-tab-slot']}`) === null &&
        event.cancelable
      ) event.preventDefault();
    };
    // Blank space owns only the pane menu; tabs retain native horizontal scroll.
    strip?.addEventListener('touchstart', suppressBlankSelection, {
      passive: false,
    });
    return () => {
      cancelBlankPress();
      strip?.removeEventListener('touchstart', suppressBlankSelection);
    };
  }, []);
  // Touch holds promote to tab drags; only quick, unmoved releases count
  // toward opening the active tab's menu.
  const touchPress = useRef<{
    tabId: string;
    pointerId: number;
    startX: number;
    startY: number;
    startedAt: number;
    moved: boolean;
  } | null>(null);
  const lastTouchTap = useRef<{ tabId: string; endedAt: number } | null>(null);
  const tabId = (index: number) => `${id}-tab-${index}`;
  return (
    <div
      className={styles.tabstrip}
      data-pane-strip={paneId}
      ref={stripRoot}
      onContextMenu={(event) => {
        if (
          (event.target as HTMLElement).closest(
            `button, .${styles['fl-tab-slot']}`,
          )
        )
          return;
        cancelBlankPress();
        event.preventDefault();
        event.stopPropagation();
        onPaneContextMenu?.(event);
      }}
      onPointerDown={(event) => {
        cancelBlankPress();
        if (
          event.pointerType !== 'touch' ||
          event.isPrimary === false ||
          (event.target as HTMLElement).closest(
            `button, .${styles['fl-tab-slot']}`,
          )
        )
          return;
        const anchor = {
          clientX: event.clientX,
          clientY: event.clientY,
          currentTarget: event.currentTarget,
        };
        blankPress.current = {
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          timer: setTimeout(() => {
            blankPress.current = null;
            onPaneContextMenu?.(anchor);
          }, TAB_TOUCH_LONG_PRESS_MS),
        };
      }}
      onPointerMove={(event) => {
        const press = blankPress.current;
        if (
          press?.pointerId === event.pointerId &&
          Math.hypot(event.clientX - press.x, event.clientY - press.y) >
            pointerDragSlop('touch')
        )
          cancelBlankPress();
      }}
      onPointerUp={cancelBlankPress}
      onPointerCancel={cancelBlankPress}
      onPointerLeave={cancelBlankPress}
    >
      {/* Own only activation tabs, not their sibling close/switcher buttons.
          Keep the visual slots intact for scrolling and drag hit testing. */}
      <span
        role="tablist"
        aria-label="Open documents"
        aria-owns={tabs.length ? tabs.map((_, index) => tabId(index)).join(' ') : undefined}
      />
      <div
        className={styles['tabstrip-tabs']}
        onWheel={(event) => {
          const element = event.currentTarget;
          if (event.deltaY === 0 || element.scrollWidth <= element.clientWidth)
            return;
          event.preventDefault();
          element.scrollBy({ left: event.deltaY, behavior: 'auto' });
        }}
      >
        {tabs.map((tab, index) => (
          <div
            key={tab.id}
            className={styles['fl-tab-slot']}
            data-no-window-drag=""
          >
            {insertAt === index ? (
              <span className={styles['fl-tab-insert']} aria-hidden="true" />
            ) : null}
            <div
              className={`${styles['fl-tab']}${tab.active ? ` ${styles.active}` : ''}`}
              role="presentation"
              draggable={false}
              onPointerDown={(event) => {
                if (
                  (event.target as HTMLElement).closest(
                    `.${styles['fl-tab-close']}`,
                  )
                ) {
                  touchPress.current = null;
                  lastTouchTap.current = null;
                  return;
                }
                if (event.pointerType === 'touch' && event.isPrimary !== false) {
                  touchPress.current = {
                    tabId: tab.id,
                    pointerId: event.pointerId,
                    startX: event.clientX,
                    startY: event.clientY,
                    startedAt: event.timeStamp,
                    moved: false,
                  };
                } else {
                  touchPress.current = null;
                  lastTouchTap.current = null;
                }
                onTabPointerDown(event, tab.id);
              }}
              onPointerMove={(event) => {
                const press = touchPress.current;
                if (press?.pointerId !== event.pointerId) return;
                if (
                  Math.hypot(
                    event.clientX - press.startX,
                    event.clientY - press.startY,
                  ) > pointerDragSlop('touch')
                ) {
                  press.moved = true;
                  lastTouchTap.current = null;
                }
              }}
              onPointerUp={(event) => {
                const press = touchPress.current;
                if (press?.pointerId !== event.pointerId) return;
                touchPress.current = null;
                const duration = event.timeStamp - press.startedAt;
                if (
                  press.moved ||
                  duration >= TAB_TOUCH_LONG_PRESS_MS ||
                  Math.hypot(
                    event.clientX - press.startX,
                    event.clientY - press.startY,
                  ) > pointerDragSlop('touch')
                ) {
                  lastTouchTap.current = null;
                  return;
                }
                const previousTap = lastTouchTap.current;
                if (
                  tab.active &&
                  previousTap?.tabId === tab.id &&
                  press.startedAt - previousTap.endedAt <=
                    TOUCH_DOUBLE_TAP_INTERVAL_MS
                ) {
                  lastTouchTap.current = null;
                  onTabContextMenu(event, tab.id);
                  return;
                }
                lastTouchTap.current = {
                  tabId: tab.id,
                  endedAt: event.timeStamp,
                };
              }}
              onPointerCancel={(event) => {
                if (touchPress.current?.pointerId !== event.pointerId) return;
                touchPress.current = null;
                lastTouchTap.current = null;
              }}
              onContextMenu={(event) => {
                // Innermost wins: keep the pane menu from replacing this one.
                touchPress.current = null;
                lastTouchTap.current = null;
                event.preventDefault();
                event.stopPropagation();
                onTabContextMenu(event, tab.id);
              }}
              onAuxClick={(event) => {
                if (event.button === 1) {
                  event.preventDefault();
                  onTabAuxClick(tab.id);
                }
              }}
            >
              <button
                type="button"
                className={styles['fl-tab-main']}
                role="tab"
                id={tabId(index)}
                aria-selected={tab.active}
                aria-description={tab.saveStatus ?? (tab.saveError
                  ? 'Save failed. Open this tab to retry.'
                  : tab.dirty ? 'Unsaved changes' : undefined)}
                draggable={false}
                title={tab.saveStatus === undefined ? tab.title : `${tab.title ?? tab.label} — ${tab.saveStatus}`}
                onClick={(event) => {
                  if (event.detail === 0) lastTouchTap.current = null;
                  onTabClick(tab.id, tab.active);
                }}
              >
                <span className={styles['fl-tab-icon']} style={{ width: 14 }}>
                  <Icon name={tab.icon} size={13} />
                </span>
                <span className={styles['fl-tab-label']}>{tab.label}</span>
                {tab.dirty || tab.saveError ? (
                  <span
                    className={styles['fl-tab-dirty']}
                    data-save-error={tab.saveError || undefined}
                    aria-hidden="true"
                    title={tab.saveStatus ?? (tab.saveError ? 'Save failed. Open this tab to retry.' : 'Unsaved changes')}
                  />
                ) : null}
              </button>
              <button
                type="button"
                className={styles['fl-tab-close']}
                draggable={false}
                aria-label={`Close ${tab.label}`}
                title={`Close ${tab.label}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onTabClose(tab.id);
                }}
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          </div>
        ))}
        {insertAt === tabs.length ? (
          <span
            className={`${styles['fl-tab-insert']} ${styles.end}`}
            aria-hidden="true"
          />
        ) : null}
      </div>
      <button
        type="button"
        className={styles['tab-new']}
        title="Quick switcher"
        aria-label="Open quick switcher"
        onClick={onOpenSwitcher}
      >
        <Icon name="plus" size={14} />
      </button>
    </div>
  );
}
