/**
 * Document-aware right sidebar.
 *
 * The shell owns presentation and focused context; document panels arrive
 * through the effect-owned `RightSidebarRegistry`, so new panels require a
 * plugin contribution rather than a shell branch. First-party Outline and
 * Document settings dogfood the same seam.
 */

import {
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
} from 'react';
import type {
  RightSidebarContext,
  RightSidebarPanelDef,
  RightSidebarRegistry,
} from '../../../right-sidebar-registry.js';
import { Icon } from '../../Icon.jsx';
import styles from '../../WorkspaceView.module.css';
import panelsStyles from '../../RightSidebarPanels.module.css';

export interface InspectorModel {
  readonly panels: readonly InspectorPanel[];
  readonly activeId: string | null;
}

interface InspectorPanel extends RightSidebarPanelDef {
  readonly members?: readonly RightSidebarPanelDef[];
}

/** Presentation-only panel data; derives once per revision. */
export function toInspectorModel(
  registry: RightSidebarRegistry,
  context: RightSidebarContext | null,
  activePanel: string,
): InspectorModel {
  const registered = context === null ? [] : registry.list(context);
  const groups = new Map<string, RightSidebarPanelDef[]>();
  const panels: InspectorPanel[] = [];
  for (const panel of registered) {
    if (panel.group === undefined) {
      panels.push(panel);
      continue;
    }
    const members = groups.get(panel.group.id);
    if (members !== undefined) {
      members.push(panel);
      continue;
    }
    const first = [panel];
    groups.set(panel.group.id, first);
    panels.push({
      id: panel.group.id,
      title: panel.group.title,
      icon: panel.group.icon,
      order: panel.group.order,
      component: panel.component,
      members: first,
    });
  }
  panels.sort(
    (a, b) =>
      (a.order ?? Number.MAX_SAFE_INTEGER) -
        (b.order ?? Number.MAX_SAFE_INTEGER) || a.title.localeCompare(b.title),
  );
  const panel =
    panels.find(
      (candidate) =>
        candidate.id === activePanel ||
        candidate.members?.some((member) => member.id === activePanel),
    ) ?? panels[0];
  return { panels, activeId: panel?.id ?? null };
}

export function InspectorSidebar(props: {
  readonly registry: RightSidebarRegistry;
  readonly context: RightSidebarContext | null;
  readonly activePanel: string;
  readonly open: boolean;
  readonly onSelect: (id: string) => void;
  readonly resizer?: React.ReactNode;
  readonly onClose?: () => void;
}): React.ReactElement {
  const { registry, context, activePanel, open, onSelect, resizer } = props;
  const [, refresh] = useReducer((count: number) => count + 1, 0);
  useEffect(() => registry.onDidChange(refresh).dispose, [registry]);
  const { panels, activeId } = toInspectorModel(registry, context, activePanel);
  const panel = panels.find((candidate) => candidate.id === activeId);

  return (
    <aside
      id="document-sidebar"
      className={`${styles['fl-right-sidebar']}${open ? ` ${styles.open}` : ` ${styles.closed}`}`}
      data-fl-component="right-sidebar"
      aria-label="Document sidebar"
      aria-hidden={!open}
      inert={!open}
      onKeyDown={(event) => {
        if (
          event.key !== 'Escape' ||
          event.defaultPrevented ||
          props.onClose === undefined
        )
          return;
        if (
          event.target instanceof Element &&
          event.target.closest('[role="dialog"], [role="menu"]')
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        props.onClose();
        event.currentTarget.ownerDocument
          .querySelector<HTMLButtonElement>(
            '[aria-controls="document-sidebar"]',
          )
          ?.focus();
      }}
    >
      <div className={styles['fl-right-sidebar-mobile-tabs']}>
        <RightSidebarTabs
          registry={registry}
          context={context}
          activePanel={activePanel}
          onSelect={onSelect}
        />
      </div>
      {context !== null && panel !== undefined ? (
        <RightSidebarPanelSlot panel={panel} context={context} />
      ) : (
        <div
          className={`${panelsStyles['right-sidebar-empty']} ${panelsStyles['document-empty']}`}
        >
          <strong>No document selected</strong>
          <span>Open a document to see its details.</span>
        </div>
      )}
      {resizer}
    </aside>
  );
}

export function RightSidebarTabs(props: {
  registry: RightSidebarRegistry;
  context: RightSidebarContext | null;
  activePanel: string;
  onSelect(id: string): void;
}): React.ReactElement {
  const { registry, context, activePanel, onSelect } = props;
  const [, refresh] = useReducer((count: number) => count + 1, 0);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const [capacity, setCapacity] = useState(4);
  useEffect(() => registry.onDidChange(refresh).dispose, [registry]);
  useEffect(() => {
    if (!moreOpen) return;
    moreRef.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]')
      ?.focus();
    const dismiss = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !moreRef.current?.contains(event.target)
      )
        setMoreOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [moreOpen]);
  const { panels, activeId } = toInspectorModel(registry, context, activePanel);
  useLayoutEffect(() => {
    const tabs = tabsRef.current;
    if (tabs === null) return;
    const measure = (): void => {
      const width = tabs.getBoundingClientRect().width;
      if (width <= 0) return;
      const style = getComputedStyle(tabs);
      const button = tabs.querySelector<HTMLElement>('[role="tab"]');
      const tabWidth = button?.getBoundingClientRect().width ?? 0;
      if (tabWidth <= 0) return;
      const available =
        width -
        (Number.parseFloat(style.paddingLeft) || 0) -
        (Number.parseFloat(style.paddingRight) || 0);
      const gap = Number.parseFloat(style.columnGap) || 0;
      const next =
        panels.length * tabWidth <= available
          ? panels.length
          : Math.max(1, Math.floor((available - tabWidth - gap) / tabWidth));
      setCapacity((current) => (current === next ? current : next));
    };
    measure();
    const observer =
      typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    observer?.observe(tabs);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [panels.length]);
  const primary = panels.slice(0, capacity);
  const activeOverflow = panels.find(
    (panel) => panel.id === activeId && !primary.includes(panel),
  );
  const visible = activeOverflow
    ? [...primary.slice(0, -1), activeOverflow]
    : primary;
  const overflow = panels.filter((panel) => !visible.includes(panel));

  return (
    <div className={styles['right-sidebar-tabs']} ref={tabsRef}>
      <div
        className={styles['right-sidebar-tabs-inner']}
        role="tablist"
        aria-label="Document panels"
      >
        {visible.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            role="tab"
            className={`${styles['right-sidebar-tab']}${candidate.id === activeId ? ` ${styles.active}` : ''}`}
            data-right-panel={candidate.id}
            title={candidate.title}
            aria-label={candidate.title}
            aria-selected={candidate.id === activeId}
            onClick={() => onSelect(candidate.id)}
          >
            <Icon name={candidate.icon} size={17} />
          </button>
        ))}
      </div>
      {overflow.length > 0 ? (
        <div className={styles['right-sidebar-more']} ref={moreRef}>
          <button
            type="button"
            aria-label="More document panels"
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            title="More document panels"
            onClick={() => setMoreOpen((open) => !open)}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              event.preventDefault();
              setMoreOpen(false);
              event.currentTarget.focus();
            }}
          >
            <Icon name="more" size={17} />
          </button>
          {moreOpen ? (
            <div
              className={styles['right-sidebar-more-menu']}
              role="menu"
              aria-label="More document panels"
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setMoreOpen(false);
                  moreRef.current
                    ?.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')
                    ?.focus();
                }
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  const items = [
                    ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                      '[role="menuitem"]',
                    ),
                  ];
                  const current = items.indexOf(
                    document.activeElement as HTMLButtonElement,
                  );
                  const direction = event.key === 'ArrowDown' ? 1 : -1;
                  items[
                    (current + direction + items.length) % items.length
                  ]?.focus();
                }
              }}
            >
              {overflow.map((panel) => (
                <button
                  key={panel.id}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    onSelect(panel.id);
                    setMoreOpen(false);
                    moreRef.current
                      ?.querySelector<HTMLButtonElement>(
                        '[aria-haspopup="menu"]',
                      )
                      ?.focus();
                  }}
                >
                  {panel.title}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function RightSidebarPanelSlot(props: {
  panel: InspectorPanel;
  context: RightSidebarContext;
}): React.ReactElement {
  const { panel, context } = props;
  const Component = panel.component;
  return (
    <div
      key={`${panel.id}:${context.documentId}`}
      className={styles['right-sidebar-content']}
      role="tabpanel"
      aria-label={panel.title}
      data-fl-keyboard-viewport=""
    >
      {panel.members !== undefined ? (
        <div className={panelsStyles['right-sidebar-group']}>
          {panel.members.map((member) => {
            const Section = member.component;
            return (
              <section key={member.id} aria-label={member.title}>
                <Section context={context} />
              </section>
            );
          })}
        </div>
      ) : Component !== undefined ? (
        <Component context={context} />
      ) : null}
    </div>
  );
}
