import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { notebookKindId } from '@froglight/foundation';
import { documentSettingKey } from '../document-preferences.js';
import type {
  NotebookPdfExportOptions,
  PdfExportOptions,
  RightSidebarContext,
  RightSidebarOutlineEntry,
} from '../right-sidebar-registry.js';
import type { WorkspaceSettingsService } from '../workspace-settings.js';
import { Button } from './Button.jsx';
import { Icon } from './Icon.jsx';
import { renderControl } from './tool-controls.jsx';
import styles from './RightSidebarPanels.module.css';

export interface OutlinePanelProps {
  readonly context: RightSidebarContext;
}

export interface DocumentSettingsPanelProps {
  readonly context: RightSidebarContext;
  readonly settings: WorkspaceSettingsService | null;
}

/** One provider-neutral property section, rendered from the live tool snapshot. */
export function DocumentInspectorPanel(props: {
  readonly context: RightSidebarContext;
  readonly section: 'pages' | 'canvas' | 'selection';
}): React.ReactElement {
  const section = props.context.inspector?.sections.find(
    (candidate) => candidate.id === props.section,
  );
  return (
    <div
      className={styles['right-sidebar-panel']}
      data-inspector-section={props.section}
    >
      <h2 className={styles['right-sidebar-heading']}>
        {section?.label ?? ''}
      </h2>
      {props.section === 'pages' ? (
        <PageBrowser context={props.context} />
      ) : null}
      {props.section !== 'pages' ? (
        <InspectorControls context={props.context} section={props.section} />
      ) : null}
    </div>
  );
}

function InspectorControls(props: {
  readonly context: RightSidebarContext;
  readonly section: 'pages' | 'canvas' | 'selection';
}): React.ReactElement | null {
  const section = props.context.inspector?.sections.find(
    (candidate) => candidate.id === props.section,
  );
  if (section === undefined) return null;
  return (
    <div className={styles['document-inspector-controls']}>
      {section.controls.map((control) => (
        <div className={styles['document-inspector-row']} key={control.id}>
          <span>{control.label}</span>
          {control.kind === 'choice' ? (
            <select
              className={styles['document-inspector-select']}
              aria-label={control.label}
              value={control.value}
              disabled={control.disabled}
              onChange={(event) =>
                props.context.executeInspectorControl?.(
                  control.id,
                  event.target.value,
                )
              }
            >
              {control.options.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          ) : (
            renderControl(control, (id, value) =>
              props.context.executeInspectorControl?.(id, value),
            )
          )}
        </div>
      ))}
    </div>
  );
}

function pageDropIndex(
  pages: readonly { readonly id: string }[],
  sourceId: string,
  targetId: string,
  after: boolean,
): number {
  const from = pages.findIndex((page) => page.id === sourceId);
  const target = pages.findIndex((page) => page.id === targetId);
  if (from < 0 || target < 0) return -1;
  const insertion = target + Number(after);
  return insertion > from ? insertion - 1 : insertion;
}

function PageBrowser(props: {
  readonly context: RightSidebarContext;
}): React.ReactElement | null {
  const pages = props.context.inspector?.pages;
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [lastSelected, setLastSelected] = useState<string | null>(null);
  const [menu, setMenu] = useState<{
    pageId: string;
    left: number;
    top: number;
  } | null>(null);
  const browserRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const pointerStart = useRef<{
    id: number;
    sourceId: string;
    x: number;
    y: number;
    offsetX: number;
    offsetY: number;
    width: number;
  } | null>(null);
  const dragging = useRef(false);
  const scrollFrame = useRef<number | null>(null);
  const pointerPosition = useRef<{ x: number; y: number } | null>(null);
  const lastDrop = useRef<{
    targetId: string;
    after: boolean;
    axis: 'horizontal' | 'vertical';
    finalIndex: number;
  } | null>(null);
  const suppressClick = useRef(false);
  const [dragPreview, setDragPreview] = useState<{
    sourceId: string;
    left: number;
    top: number;
    width: number;
    targetId: string | null;
    after: boolean;
    axis: 'horizontal' | 'vertical';
  } | null>(null);
  useEffect(() => {
    setSelected(new Set());
    setLastSelected(null);
    setMenu(null);
    setDragPreview(null);
    pointerStart.current = null;
    dragging.current = false;
    lastDrop.current = null;
    pointerPosition.current = null;
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = null;
  }, [props.context.documentId]);
  useEffect(
    () => () => {
      if (scrollFrame.current !== null)
        cancelAnimationFrame(scrollFrame.current);
    },
    [],
  );
  useEffect(() => {
    if (menu === null) return;
    menuRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const dismiss = (event: PointerEvent): void => {
      if (
        event.target instanceof Node &&
        !menuRef.current?.contains(event.target) &&
        !menuTriggerRef.current?.contains(event.target)
      )
        setMenu(null);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [menu]);
  useEffect(() => {
    if (pages === undefined) return;
    const browser = browserRef.current;
    if (browser === null) return;
    const request = (id: string): void =>
      props.context.executeInspectorControl?.('notebook.page.preview', id);
    if (typeof IntersectionObserver !== 'function') {
      for (const page of pages.slice(0, 12))
        if (page.thumbnail === undefined) request(page.id);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const id = (entry.target as HTMLElement).dataset.pageId;
          if (id !== undefined) request(id);
          observer.unobserve(entry.target);
        }
      },
      { root: null },
    );
    for (const element of browser.querySelectorAll<HTMLElement>(
      '[data-page-id]:not([data-has-preview="true"])',
    ))
      observer.observe(element);
    return () => observer.disconnect();
  }, [pages, props.context]);
  if (pages === undefined) return null;
  const selectedPages = pages.filter((page) => selected.has(page.id));
  const action = (id: string, value?: string): void =>
    props.context.executeInspectorControl?.(id, value);
  const beginDrag = (
    event: React.PointerEvent<HTMLButtonElement>,
    sourceId: string,
  ): void => {
    if (event.button !== 0) return;
    const rect = event.currentTarget
      .closest(`.${styles['page-browser-item']}`)
      ?.querySelector<HTMLButtonElement>('[data-page-id]')
      ?.getBoundingClientRect();
    if (rect === undefined) return;
    pointerStart.current = {
      id: event.pointerId,
      sourceId,
      x: event.clientX,
      y: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      width: rect.width,
    };
    lastDrop.current = null;
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const dropAt = (
    x: number,
    y: number,
  ): {
    targetId: string;
    after: boolean;
    axis: 'horizontal' | 'vertical';
  } | null => {
    const browser = browserRef.current;
    if (browser === null) return null;
    const bounds = browser.getBoundingClientRect();
    if (
      x < bounds.left - 12 ||
      x > bounds.right + 12 ||
      y < bounds.top - 12 ||
      y > bounds.bottom + 12
    )
      return null;
    const cards = [
      ...browser.querySelectorAll<HTMLButtonElement>('[data-page-id]'),
    ];
    if (cards.length === 0) return null;
    const columns =
      getComputedStyle(browser).gridTemplateColumns.split(' ').length;
    const axis = columns > 1 ? 'horizontal' : 'vertical';
    const nearest = cards
      .map((card) => {
        const rect = card.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        return {
          card,
          rect,
          distance: (centerX - x) ** 2 + (centerY - y) ** 2,
        };
      })
      .sort((a, b) => a.distance - b.distance)[0];
    if (nearest === undefined || nearest.card.dataset.pageId === undefined)
      return null;
    if (nearest.card.dataset.pageId === pointerStart.current?.sourceId)
      return null;
    return {
      targetId: nearest.card.dataset.pageId,
      after:
        axis === 'horizontal'
          ? x >= nearest.rect.left + nearest.rect.width / 2
          : y >= nearest.rect.top + nearest.rect.height / 2,
      axis,
    };
  };
  const clearDrag = (): void => {
    pointerStart.current = null;
    dragging.current = false;
    lastDrop.current = null;
    pointerPosition.current = null;
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = null;
    setDragPreview(null);
  };
  const updateDragAt = (x: number, y: number): void => {
    const start = pointerStart.current;
    if (start === null) return;
    const drop = dropAt(x, y);
    const finalIndex =
      drop === null
        ? -1
        : pageDropIndex(pages ?? [], start.sourceId, drop.targetId, drop.after);
    const targetId =
      finalIndex !== -1 &&
      finalIndex !== pages?.findIndex((page) => page.id === start.sourceId)
        ? (drop?.targetId ?? null)
        : null;
    lastDrop.current =
      drop !== null && targetId !== null ? { ...drop, finalIndex } : null;
    setDragPreview({
      sourceId: start.sourceId,
      left: x - start.offsetX,
      top: y - start.offsetY,
      width: start.width,
      targetId,
      after: drop?.after ?? false,
      axis: drop?.axis ?? 'horizontal',
    });
  };
  const autoScroll = (): void => {
    const pointer = pointerPosition.current;
    const scroll =
      browserRef.current?.closest<HTMLElement>('[role="tabpanel"]');
    if (pointer === null || scroll === undefined || scroll === null) return;
    const bounds = scroll.getBoundingClientRect();
    const edge = 48;
    const delta =
      pointer.y < bounds.top + edge
        ? -Math.min(12, (bounds.top + edge - pointer.y) / 4)
        : pointer.y > bounds.bottom - edge
          ? Math.min(12, (pointer.y - (bounds.bottom - edge)) / 4)
          : 0;
    if (delta !== 0) {
      const previous = scroll.scrollTop;
      scroll.scrollTop += delta;
      if (scroll.scrollTop !== previous) updateDragAt(pointer.x, pointer.y);
    }
    scrollFrame.current = requestAnimationFrame(autoScroll);
  };
  const moveDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    const start = pointerStart.current;
    if (start === null || start.id !== event.pointerId) return;
    if (!dragging.current) {
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < 6)
        return;
      dragging.current = true;
      browserRef.current?.setPointerCapture(event.pointerId);
      scrollFrame.current = requestAnimationFrame(autoScroll);
    }
    pointerPosition.current = { x: event.clientX, y: event.clientY };
    updateDragAt(event.clientX, event.clientY);
  };
  const endDrag = (event: React.PointerEvent<HTMLDivElement>): void => {
    const start = pointerStart.current;
    if (start === null || start.id !== event.pointerId) return;
    const wasDragging = dragging.current;
    const finalIndex = wasDragging ? (lastDrop.current?.finalIndex ?? -1) : -1;
    const from = pages?.findIndex((page) => page.id === start.sourceId) ?? -1;
    clearDrag();
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (!wasDragging) return;
    suppressClick.current = true;
    window.setTimeout(() => {
      suppressClick.current = false;
    }, 0);
    if (finalIndex < 0 || finalIndex === from) return;
    const anchor = pages?.[finalIndex];
    if (anchor !== undefined)
      action('notebook.page.reorder', `${start.sourceId}|${anchor.id}`);
  };
  const openMenu = (
    pageId: string,
    trigger: HTMLButtonElement,
    x: number,
    y: number,
  ): void => {
    menuTriggerRef.current = trigger;
    setMenu({
      pageId,
      left: Math.max(8, Math.min(x, window.innerWidth - 176)),
      top: Math.max(8, Math.min(y, window.innerHeight - 196)),
    });
  };
  const menuPage = pages.find((page) => page.id === menu?.pageId);
  const menuTargets =
    menuPage !== undefined &&
    selected.has(menuPage.id) &&
    selectedPages.length > 1
      ? selectedPages
      : menuPage === undefined
        ? []
        : [menuPage];
  const draggedPage = pages.find((page) => page.id === dragPreview?.sourceId);
  const draggedPageNumber =
    pages.findIndex((page) => page.id === dragPreview?.sourceId) + 1;
  // Keep drop geometry stable until release; an insertion marker previews the move.
  return (
    <div className={styles['page-browser']}>
      <div
        className={styles['page-browser-list']}
        ref={browserRef}
        aria-label="Page thumbnails"
        onPointerMove={moveDrag}
        onPointerUp={endDrag}
        onPointerCancel={clearDrag}
        onKeyDown={(event) => {
          if (event.key !== 'Escape' || !dragging.current) return;
          event.preventDefault();
          clearDrag();
        }}
      >
        {pages.map((page, index) => {
          return (
            <div
              className={styles['page-browser-item']}
              key={page.id}
              data-drop-target={
                dragPreview?.targetId === page.id
                  ? dragPreview.after
                    ? 'after'
                    : 'before'
                  : undefined
              }
              data-drop-axis={dragPreview?.axis}
            >
              <button
                type="button"
                className={styles['page-browser-thumb']}
                data-page-id={page.id}
                data-has-preview={String(page.thumbnail !== undefined)}
                data-current={String(page.current)}
                data-dragging={String(dragPreview?.sourceId === page.id)}
                aria-label={page.label}
                aria-pressed={selected.has(page.id)}
                draggable={false}
                onDragStart={(event) => event.preventDefault()}
                onPointerDown={(event) => {
                  if (event.pointerType !== 'touch') beginDrag(event, page.id);
                }}
                onClick={(event) => {
                  if (suppressClick.current) {
                    event.preventDefault();
                    return;
                  }
                  if (event.shiftKey && lastSelected !== null) {
                    const start = pages.findIndex(
                      (candidate) => candidate.id === lastSelected,
                    );
                    const next = new Set(selected);
                    for (
                      let at = Math.min(start, index);
                      at <= Math.max(start, index);
                      at += 1
                    )
                      if (pages[at] !== undefined) next.add(pages[at]!.id);
                    setSelected(next);
                  } else if (event.metaKey || event.ctrlKey) {
                    const next = new Set(selected);
                    if (next.has(page.id)) next.delete(page.id);
                    else next.add(page.id);
                    setSelected(next);
                  } else {
                    setSelected(new Set([page.id]));
                    action('notebook.go-to-page', String(index + 1));
                  }
                  setLastSelected(page.id);
                }}
                onContextMenu={(event) => {
                  event.preventDefault();
                  openMenu(
                    page.id,
                    event.currentTarget,
                    event.clientX,
                    event.clientY,
                  );
                }}
              >
                <span className={styles['page-browser-preview']}>
                  {page.thumbnail !== undefined ? (
                    <img src={page.thumbnail} alt="" draggable={false} />
                  ) : null}
                </span>
                <span>{index + 1}</span>
              </button>
              <button
                type="button"
                className={styles['page-browser-drag-handle']}
                aria-label={`Move page ${index + 1}`}
                onPointerDown={(event) => beginDrag(event, page.id)}
              >
                <svg
                  width="12"
                  height="16"
                  viewBox="0 0 12 16"
                  aria-hidden="true"
                  fill="currentColor"
                >
                  <path d="M3 3h2v2H3zM7 3h2v2H7zM3 7h2v2H3zM7 7h2v2H7zM3 11h2v2H3zM7 11h2v2H7z" />
                </svg>
              </button>
              <button
                type="button"
                className={styles['page-browser-menu-trigger']}
                aria-label={`Page ${index + 1} actions`}
                aria-haspopup="menu"
                aria-expanded={menu?.pageId === page.id}
                onClick={(event) => {
                  if (menu?.pageId === page.id) {
                    setMenu(null);
                    return;
                  }
                  const rect = event.currentTarget.getBoundingClientRect();
                  openMenu(
                    page.id,
                    event.currentTarget,
                    rect.right - 156,
                    rect.bottom + 4,
                  );
                }}
              >
                <Icon name="more" size={14} />
              </button>
            </div>
          );
        })}
      </div>
      {dragPreview !== null && draggedPage !== undefined
        ? createPortal(
            <div
              className={styles['page-browser-drag-preview']}
              data-page-drag-preview={dragPreview.sourceId}
              style={{
                left: dragPreview.left,
                top: dragPreview.top,
                width: dragPreview.width,
              }}
              aria-hidden="true"
            >
              <span className={styles['page-browser-preview']}>
                {draggedPage.thumbnail !== undefined ? (
                  <img src={draggedPage.thumbnail} alt="" draggable={false} />
                ) : null}
              </span>
              <span>{draggedPageNumber}</span>
            </div>,
            document.body,
          )
        : null}
      {menuPage !== undefined
        ? createPortal(
            <div
              className={styles['page-browser-menu']}
              ref={menuRef}
              role="menu"
              aria-label={`Page ${pages.indexOf(menuPage) + 1} actions`}
              style={{ left: menu?.left, top: menu?.top }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setMenu(null);
                  menuTriggerRef.current?.focus();
                } else if (
                  event.key === 'ArrowDown' ||
                  event.key === 'ArrowUp'
                ) {
                  event.preventDefault();
                  const items = [
                    ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                      'button:not(:disabled)',
                    ),
                  ];
                  const current = items.indexOf(
                    document.activeElement as HTMLButtonElement,
                  );
                  const step = event.key === 'ArrowDown' ? 1 : -1;
                  items[
                    (current + step + items.length) % items.length
                  ]?.focus();
                }
              }}
            >
              {[
                ['Add before', 'notebook.page.add-before', menuPage.id],
                ['Add after', 'notebook.page.add-after', menuPage.id],
                [
                  'Duplicate',
                  'notebook.page.duplicate-selected',
                  menuTargets.map((page) => page.id).join('|'),
                ],
                [
                  'Delete',
                  'notebook.page.delete-selected',
                  menuTargets.map((page) => page.id).join('|'),
                ],
              ].map(([label, id, value]) => (
                <button
                  key={id}
                  type="button"
                  role="menuitem"
                  disabled={
                    id === 'notebook.page.delete-selected' && pages.length <= 1
                  }
                  onClick={() => {
                    action(id, value);
                    setMenu(null);
                    menuTriggerRef.current?.focus();
                  }}
                >
                  {label}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

/**
 * Derived per-row view data for the generic outline renderer.
 */
export interface OutlineRowView {
  readonly entry: RightSidebarOutlineEntry;
  /** Zero-based indent relative to the shallowest row. */
  readonly depth: number;
  /**
   * React reconciliation key: `entry.id` when unique within
   * this outline (unique-id fast path keeps DOM stability); on collision
   * qualified as `${id}::${index}` so duplicate-id rows still reconcile
   * without duplicate-key errors while staying warn-and-render-both.
   */
  readonly key: string;
}

export interface OutlineView {
  readonly baseLevel: number;
  readonly rows: readonly OutlineRowView[];
}

const EMPTY_OUTLINE_VIEW: OutlineView = { baseLevel: 1, rows: [] };
const EMPTY_OUTLINE_ROWS: readonly RightSidebarOutlineEntry[] = [];

/**
 * Normalize provider rows into indent depths (pure; the panel memoizes it
 * on the rows reference). Only `{ id, address, level, label }` is consumed
 * — a row `kind` never influences presentation, so every provider shares
 * the single renderer below. Keys preserve the stable-id contract: unique
 * ids key by `entry.id` (DOM stability); colliding ids fall back to
 * `${id}::${index}` so keys stay unique without dedupe.
 */
export function resolveOutlineView(
  entries: readonly RightSidebarOutlineEntry[],
): OutlineView {
  if (entries.length === 0) return EMPTY_OUTLINE_VIEW;
  const baseLevel = Math.min(...entries.map((entry) => entry.level));
  const idCounts = new Map<string, number>();
  for (const entry of entries) {
    idCounts.set(entry.id, (idCounts.get(entry.id) ?? 0) + 1);
  }
  return {
    baseLevel,
    rows: entries.map((entry, index) => ({
      entry,
      depth: Math.max(0, entry.level - baseLevel),
      key:
        (idCounts.get(entry.id) ?? 0) > 1 ? `${entry.id}::${index}` : entry.id,
    })),
  };
}

/**
 * Outline panel — declarative React over the panel context.
 *
 * Generic provider outline (tasks): `context.outline`
 * rows render verbatim through one provider-neutral path. Stable-id
 * contract: every row `id` is stable within one outline and keys the React
 * row (never the revision), so focus and reveal targets survive edits;
 * `address` is the portable in-document address passed verbatim to
 * `context.revealAddress`. Duplicate ids within one outline are a provider
 * bug: dev builds warn (see below) and both rows still render
 * (warn-and-render-both) so the bug stays visible; unique ids keep DOM
 * nodes stable via id keys while colliding ids qualify as
 * `${id}::${index}` so reconciliation never sees duplicate
 * keys. The only nav seam is
 * `context.revealAddress(entry.address)`; unknown addresses are the
 * delegate's graceful no-op. The context object passes through unchanged —
 * plain data, never engine objects. Panels register as components; the
 * shell mounts them directly.
 */
export function OutlinePanel(props: OutlinePanelProps): React.ReactElement {
  const { context } = props;
  const entries = context.outline ?? EMPTY_OUTLINE_ROWS;
  // Revision-keyed upstream caches return the same frozen row reference on
  // a hit, so memoizing on the reference skips full rebuilds across
  // keystrokes at a stable revision. `outlineRevision` joins the memo key
  // so a revision advance always recomputes even if a provider ever reused
  // a reference across revisions (outline-half: the subscription
  // pushes new references only when rows actually change). The revision is
  // read through the void expression so the cache-buster intent is explicit
  // without a per-revision branch.
  const view = useMemo(() => {
    void context.outlineRevision;
    return resolveOutlineView(entries);
  }, [entries, context.outlineRevision]);
  if (
    typeof process !== 'undefined' &&
    process.env?.NODE_ENV !== 'production'
  ) {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const entry of entries) {
      if (seen.has(entry.id)) duplicates.push(entry.id);
      else seen.add(entry.id);
    }
    if (duplicates.length > 0) {
      console.warn(
        `[outline-panel] duplicate outline ids (stable-id contract): ${duplicates.join(', ')}`,
      );
    }
  }
  if (entries.length === 0) {
    return <div className={`${styles['right-sidebar-panel']} outline-panel`} />;
  }
  return (
    <div className={`${styles['right-sidebar-panel']} outline-panel`}>
      <h2 className={styles['right-sidebar-heading']}>Outline</h2>
      <nav className={styles['outline-tree']} aria-label="Document outline">
        {view.rows.map(({ entry, depth, key }) => (
          <button
            key={key}
            type="button"
            className={styles['outline-entry']}
            data-level={String(entry.level)}
            style={{ '--_outline-depth': String(depth) } as React.CSSProperties}
            title={entry.label}
            onClick={() => context.revealAddress(entry.address)}
          >
            {entry.label}
          </button>
        ))}
      </nav>
    </div>
  );
}

/**
 * Document settings panel — declarative React over the panel context plus
 * the workspace-settings service closure.
 *
 * Converted from the imperative `renderDocumentSettings` builder with
 * identical user-visible behavior: same DOM structure, classes, labels,
 * ordering, handlers, and settings keys. Local select/toggle state mirrors
 * the previous mutable `let` bindings so the export buttons read the latest
 * choice. The context object passes through unchanged.
 */
export function DocumentSettingsPanel(
  props: DocumentSettingsPanelProps,
): React.ReactElement {
  const { context, settings } = props;
  const viewKey = documentSettingKey(context.documentId, 'view');
  const [readingView, setReadingView] = useState<boolean>(
    () => settings?.get(viewKey, false) ?? false,
  );
  const notebookModeKey = documentSettingKey(
    context.documentId,
    'notebookPdfMode',
  );
  const notebookDpiKey = documentSettingKey(
    context.documentId,
    'notebookPdfDpi',
  );
  const [notebookMode, setNotebookMode] = useState<'preserve' | 'flatten'>(
    () =>
      settings?.get<'preserve' | 'flatten'>(notebookModeKey, 'preserve') ??
      'preserve',
  );
  const [dpi, setDpi] = useState<'150' | '300'>(
    () => settings?.get<'150' | '300'>(notebookDpiKey, '150') ?? '150',
  );
  const pageSizeKey = documentSettingKey(context.documentId, 'pdfPageSize');
  const marginKey = documentSettingKey(context.documentId, 'pdfMargins');
  const titleKey = documentSettingKey(context.documentId, 'pdfIncludeTitle');
  const [pageSize, setPageSize] = useState<'a4' | 'letter'>(
    () => settings?.get<'a4' | 'letter'>(pageSizeKey, 'a4') ?? 'a4',
  );
  const [margins, setMargins] = useState<'normal' | 'narrow'>(
    () => settings?.get<'normal' | 'narrow'>(marginKey, 'normal') ?? 'normal',
  );
  const [includeTitle, setIncludeTitle] = useState<boolean>(
    () => settings?.get<boolean>(titleKey, true) ?? true,
  );

  const typeLabel = context.kindId.replace(/^froglight\./, '');
  const details = (
    <section className={styles['document-settings-group']}>
      <h3>Details</h3>
      <div className={`${styles['document-setting-row']} ${styles.readonly}`}>
        <span>Name</span>
        <span
          className={styles['document-setting-value']}
          title={context.title}
        >
          {context.title}
        </span>
      </div>
      <div className={`${styles['document-setting-row']} ${styles.readonly}`}>
        <span>Location</span>
        <span className={styles['document-setting-value']} title={context.path}>
          {context.path}
        </span>
      </div>
      <div className={`${styles['document-setting-row']} ${styles.readonly}`}>
        <span>Type</span>
        <span className={styles['document-setting-value']} title={typeLabel}>
          {typeLabel}
        </span>
      </div>
    </section>
  );
  const behavior = (
    <section className={styles['document-settings-group']}>
      <h3>Open behavior</h3>
      <label className={styles['document-setting-row']}>
        <span>Current view</span>
        <select
          aria-label="Current view"
          value={context.mode}
          onChange={(event) => {
            const next = event.currentTarget
              .value as import('@froglight/foundation').DocumentPresentationMode;
            context.setMode(next);
          }}
        >
          {context.availableModes.map((mode) => (
            <option key={mode} value={mode}>
              {mode === 'edit'
                ? 'Editing'
                : mode === 'split'
                  ? 'Split'
                  : 'Reading'}
            </option>
          ))}
        </select>
      </label>
      <label className={`${styles['document-setting-row']} ${styles.toggle}`}>
        <span className={styles['document-setting-copy']}>
          <span>Open in reading view</span>
          <small>Use reading view when this document opens.</small>
        </span>
        <input
          type="checkbox"
          checked={readingView}
          onChange={(event) => {
            const next = event.currentTarget.checked;
            setReadingView(next);
            settings?.set(viewKey, next);
          }}
        />
      </label>
    </section>
  );

  if (context.kindId === String(notebookKindId)) {
    const pages = context.inspector?.pages ?? [];
    const currentPage = pages.find((page) => page.current) ?? pages[0];
    const pageAction = (id: string): void => {
      if (currentPage !== undefined)
        context.executeInspectorControl?.(id, currentPage.id);
    };
    return (
      <div
        className={`${styles['right-sidebar-panel']} document-settings-panel`}
      >
        <h2 className={styles['right-sidebar-heading']}>Document</h2>
        {context.inspector?.sections.some(
          (section) => section.id === 'pages',
        ) ? (
          <section className={styles['document-settings-group']}>
            <h3>Page settings</h3>
            <InspectorControls context={context} section="pages" />
            <div className={styles['page-settings-actions']}>
              <button
                type="button"
                disabled={currentPage === undefined}
                onClick={() => pageAction('notebook.page.add-before')}
              >
                Add before
              </button>
              <button
                type="button"
                disabled={currentPage === undefined}
                onClick={() => pageAction('notebook.page.add-after')}
              >
                Add after
              </button>
              <button
                type="button"
                disabled={currentPage === undefined}
                onClick={() => pageAction('notebook.page.duplicate-selected')}
              >
                Duplicate
              </button>
              <button
                type="button"
                disabled={pages.length <= 1}
                onClick={() => pageAction('notebook.page.delete-selected')}
              >
                Delete
              </button>
            </div>
          </section>
        ) : null}
        {details}
        {behavior}
        <section className={styles['document-settings-group']}>
          <h3>PDF export</h3>
          <label className={styles['document-setting-row']}>
            <span>Output</span>
            <select
              aria-label="Output"
              value={notebookMode}
              onChange={(event) => {
                const next = event.currentTarget.value as
                  | 'preserve'
                  | 'flatten';
                setNotebookMode(next);
                settings?.set(notebookModeKey, next);
              }}
            >
              <option value="preserve">Preserve source text and vectors</option>
              <option value="flatten">Flattened compatibility copy</option>
            </select>
          </label>
          <label className={styles['document-setting-row']}>
            <span>Flattened quality</span>
            <select
              aria-label="Flattened quality"
              value={dpi}
              onChange={(event) => {
                const next = event.currentTarget.value as '150' | '300';
                setDpi(next);
                settings?.set(notebookDpiKey, next);
              }}
            >
              <option value="150">150 DPI</option>
              <option value="300">300 DPI</option>
            </select>
          </label>
          <p className={styles['document-setting-hint']}>
            Flattened output rasterizes every page, so selectable text, vectors,
            links, and outlines are lost.
          </p>
          <Button
            type="button"
            variant="primary"
            className={styles['document-export-button']}
            disabled={context.exportNotebookPdf === undefined}
            onClick={() => {
              const options: NotebookPdfExportOptions = {
                mode: notebookMode,
                ...(notebookMode === 'flatten'
                  ? { rasterDpi: Number(dpi) }
                  : {}),
              };
              context.exportNotebookPdf?.(options);
            }}
          >
            Export notebook as PDF…
          </Button>
        </section>
      </div>
    );
  }

  if (context.text === null) {
    return (
      <div
        className={`${styles['right-sidebar-panel']} document-settings-panel`}
      >
        <h2 className={styles['right-sidebar-heading']}>Document</h2>
        {details}
        {behavior}
        {context.exportPng !== undefined ? (
          <section className={styles['document-settings-group']}>
            <h3>Export</h3>
            <Button
              type="button"
              className={styles['document-export-button']}
              onClick={context.exportPng}
            >
              Export PNG…
            </Button>
          </section>
        ) : null}
      </div>
    );
  }

  return (
    <div className={`${styles['right-sidebar-panel']} document-settings-panel`}>
      <h2 className={styles['right-sidebar-heading']}>Document</h2>
      {details}
      {behavior}
      <section className={styles['document-settings-group']}>
        <h3>PDF export</h3>
        <label className={styles['document-setting-row']}>
          <span>Paper size</span>
          <select
            aria-label="Paper size"
            value={pageSize}
            onChange={(event) => {
              const next = event.currentTarget.value as 'a4' | 'letter';
              setPageSize(next);
              settings?.set(pageSizeKey, next);
            }}
          >
            <option value="a4">A4</option>
            <option value="letter">Letter</option>
          </select>
        </label>
        <label className={styles['document-setting-row']}>
          <span>Margins</span>
          <select
            aria-label="Margins"
            value={margins}
            onChange={(event) => {
              const next = event.currentTarget.value as 'normal' | 'narrow';
              setMargins(next);
              settings?.set(marginKey, next);
            }}
          >
            <option value="normal">Standard</option>
            <option value="narrow">Narrow</option>
          </select>
        </label>
        <label className={`${styles['document-setting-row']} ${styles.toggle}`}>
          <span className={styles['document-setting-copy']}>
            <span>Include document title</span>
            <small>Add the file title above the exported content.</small>
          </span>
          <input
            type="checkbox"
            checked={includeTitle}
            onChange={(event) => {
              const next = event.currentTarget.checked;
              setIncludeTitle(next);
              settings?.set(titleKey, next);
            }}
          />
        </label>
        <Button
          type="button"
          variant="primary"
          className={styles['document-export-button']}
          disabled={context.text === null}
          title={
            context.text === null
              ? 'PDF export is not available for this document type yet'
              : 'Open the system print dialog to save this document as PDF'
          }
          onClick={() => {
            const options: PdfExportOptions = {
              pageSize,
              margins,
              includeTitle,
            };
            context.exportPdf(options);
          }}
        >
          Export as PDF…
        </Button>
      </section>
    </div>
  );
}
