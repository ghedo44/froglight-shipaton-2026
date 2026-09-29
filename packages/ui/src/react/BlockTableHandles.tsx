import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import styles from './BlockTableHandles.module.css';

type Axis = 'row' | 'column';
type Target = { axis: Axis; index: number };
type Drag = Target & { x: number; y: number; to: number };
type Rect = { x: number; y: number; width: number; height: number };

interface TableGeometry {
  blockId: string;
  table: Rect;
  rows: Rect[];
  columns: Rect[];
}

function rectOf(element: Element): Rect {
  const rect = element.getBoundingClientRect();
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function findTable(anchor: Rect): HTMLTableElement | null {
  const tables = document.querySelectorAll<HTMLTableElement>(
    'table[data-flbp-grid][data-block-id]',
  );
  return (
    [...tables].find((table) => {
      const rect = table.getBoundingClientRect();
      return (
        Math.abs(rect.x - anchor.x) < 3 &&
        Math.abs(rect.y - anchor.y) < 3 &&
        Math.abs(rect.width - anchor.width) < 3
      );
    }) ?? null
  );
}

function measure(table: HTMLTableElement): TableGeometry | null {
  const blockId = table.dataset.blockId;
  if (!blockId) return null;
  const rows = [...table.querySelectorAll(':scope > tbody > tr')];
  const firstRow = rows[0];
  if (firstRow === undefined) return null;
  const cells = [...firstRow.querySelectorAll(':scope > td, :scope > th')];
  return {
    blockId,
    table: rectOf(table),
    rows: rows.map(rectOf),
    columns: cells.map(rectOf),
  };
}

/** Plain DOM geometry and semantic command IDs; no editor type crosses here. */
export function BlockTableHandles(props: {
  anchor: Rect;
  available: ReadonlySet<string>;
  onAction: (id: string, value: string) => void;
}): React.ReactElement | null {
  const [geometry, setGeometry] = useState<TableGeometry | null>(null);
  const [active, setActive] = useState<{ row: number; col: number } | null>(null);
  const [dragging, setDragging] = useState<Drag | null>(null);
  const [insertEdge, setInsertEdge] = useState<Axis | null>(null);
  const [open, setOpen] = useState<Target | null>(null);
  const dragPointer = useRef<{
    pointerId: number;
    axis: Axis;
    index: number;
    x: number;
    y: number;
    moved: boolean;
  } | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const targetPreviewRef = useRef<HTMLDivElement>(null);
  const suppressClick = useRef(false);
  useEffect(() => {
    const update = (): void => {
      const table = findTable(props.anchor);
      const anchorNode = window.getSelection()?.anchorNode;
      const selectedCell = (anchorNode instanceof Element
        ? anchorNode
        : anchorNode?.parentElement
      )?.closest('td, th');
      if (table === null) {
        setActive(null);
        return;
      }
      const cell = selectedCell !== null && selectedCell !== undefined && table.contains(selectedCell)
        ? selectedCell : table.querySelector('td:hover, th:hover');
      if (cell === null) {
        setActive(null);
        return;
      }
      const row = cell.closest('tr');
      const rows = [...table.querySelectorAll(':scope > tbody > tr')];
      const cells = row === null ? [] : [...row.querySelectorAll(':scope > td, :scope > th')];
      const rowIndex = row === null ? -1 : rows.indexOf(row);
      const colIndex = cells.indexOf(cell);
      setActive(rowIndex < 0 || colIndex < 0 ? null : { row: rowIndex, col: colIndex });
    };
    const pick = (event: PointerEvent): void => {
      const table = findTable(props.anchor);
      const target = event.target instanceof Element ? event.target : null;
      const cell = target?.closest('td, th');
      if (table === null || cell == null || !table.contains(cell)) return;
      const row = cell.closest('tr');
      const rows = [...table.querySelectorAll(':scope > tbody > tr')];
      const cells = row === null ? [] : [...row.querySelectorAll(':scope > td, :scope > th')];
      const rowIndex = row === null ? -1 : rows.indexOf(row);
      const colIndex = cells.indexOf(cell);
      if (rowIndex >= 0 && colIndex >= 0) setActive({ row: rowIndex, col: colIndex });
    };
    const hover = (event: PointerEvent): void => {
      if (dragPointer.current !== null) return;
      const table = findTable(props.anchor);
      const target = event.target instanceof Element ? event.target : null;
      const cell = target?.closest('td, th');
      if (table === null) return;
      if (cell == null || !table.contains(cell)) {
        const rect = table.getBoundingClientRect();
        if (event.clientX >= rect.left - 120 && event.clientX <= rect.right + 28 &&
            event.clientY >= rect.top - 48 && event.clientY <= rect.bottom + 28)
          return;
        setActive(null);
        return;
      }
      const row = cell.closest('tr');
      const rows = [...table.querySelectorAll(':scope > tbody > tr')];
      const cells = row === null ? [] : [...row.querySelectorAll(':scope > td, :scope > th')];
      const rowIndex = row === null ? -1 : rows.indexOf(row);
      const colIndex = cells.indexOf(cell);
      if (rowIndex >= 0 && colIndex >= 0)
        setActive((previous) => previous?.row === rowIndex && previous.col === colIndex
          ? previous : { row: rowIndex, col: colIndex });
    };
    document.addEventListener('selectionchange', update);
    document.addEventListener('pointerdown', pick, true);
    document.addEventListener('pointermove', hover, true);
    update();
    return () => {
      document.removeEventListener('selectionchange', update);
      document.removeEventListener('pointerdown', pick, true);
      document.removeEventListener('pointermove', hover, true);
    };
  }, [props.anchor.x, props.anchor.y, props.anchor.width]);
  useEffect(() => {
    if (geometry === null) return;
    const nearEdge = (event: PointerEvent): void => {
      if (event.pointerType !== 'mouse') return;
      const { table } = geometry;
      const inX = event.clientX >= table.x - 8 && event.clientX <= table.x + table.width + 28;
      const inY = event.clientY >= table.y - 8 && event.clientY <= table.y + table.height + 28;
      setInsertEdge(
        inX && Math.abs(event.clientY - (table.y + table.height)) < 22
          ? 'row'
          : inY && Math.abs(event.clientX - (table.x + table.width)) < 22
            ? 'column'
            : null,
      );
    };
    window.addEventListener('pointermove', nearEdge);
    return () => window.removeEventListener('pointermove', nearEdge);
  }, [geometry]);
  useEffect(() => {
    if (geometry === null || dragging === null) return;
    const table = document.querySelector<HTMLTableElement>(
      `table[data-flbp-grid][data-block-id="${CSS.escape(geometry.blockId)}"]`,
    );
    if (table === null) return;
    const rows = [...table.querySelectorAll<HTMLElement>(':scope > tbody > tr')];
    const cells = rows.map((row) => [...row.querySelectorAll<HTMLElement>(':scope > td, :scope > th')]);
    const source = dragging.axis === 'row' ? rows[dragging.index] : cells[0]?.[dragging.index];
    if (source === undefined) return;
    const sourceRect = source.getBoundingClientRect();
    const distance = dragging.axis === 'row' ? sourceRect.height : sourceRect.width;
    const selector = `table[data-flbp-grid][data-block-id="${CSS.escape(geometry.blockId)}"]`;
    const rules: string[] = [];
    if (dragging.axis === 'row') {
      rows.forEach((_row, index) => {
        const shift = index > dragging.index && index <= dragging.to ? -distance
          : index >= dragging.to && index < dragging.index ? distance : 0;
        const rowSelector = `${selector} > tbody > tr:nth-child(${index + 1})`;
        if (shift) rules.push(`${rowSelector} { transform: translateY(${shift}px); }`);
        if (index === dragging.index) rules.push(`${rowSelector} { opacity: .25; }`);
      });
    } else {
      cells.forEach((line, rowIndex) => line.forEach((_, index) => {
        const shift = index > dragging.index && index <= dragging.to ? -distance
          : index >= dragging.to && index < dragging.index ? distance : 0;
        const cellSelector = `${selector} > tbody > tr:nth-child(${rowIndex + 1}) > :nth-child(${index + 1})`;
        if (shift) rules.push(`${cellSelector} { transform: translateX(${shift}px); }`);
        if (index === dragging.index) rules.push(`${cellSelector} { opacity: .25; }`);
      }));
    }
    const style = document.createElement('style');
    style.dataset.flbpTableDragLayout = '';
    style.textContent = rules.join('\n');
    document.body.appendChild(style);
    const content = (): HTMLElement => {
      if (dragging.axis === 'row') {
        const tableClone = document.createElement('table');
        const row = source.cloneNode(true) as HTMLElement;
        row.style.opacity = '';
        row.style.transform = '';
        tableClone.createTBody().appendChild(row);
        return tableClone;
      } else {
        const clone = document.createElement('table');
        const body = clone.createTBody();
        for (const line of cells) {
          const row = body.insertRow();
          const cell = line[dragging.index];
          if (cell !== undefined) {
            const copy = cell.cloneNode(true) as HTMLElement;
            copy.style.opacity = '';
            copy.style.transform = '';
            row.appendChild(copy);
          }
        }
        return clone;
      }
    };
    previewRef.current?.replaceChildren(content());
    targetPreviewRef.current?.replaceChildren(content());
    return () => style.remove();
  }, [dragging, geometry]);
  useEffect(() => {
    if (open === null) return;
    const dismiss = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(null);
    };
    window.addEventListener('keydown', dismiss);
    return () => window.removeEventListener('keydown', dismiss);
  }, [open]);
  useEffect(() => {
    let table = findTable(props.anchor);
    const observer = new ResizeObserver(() => update());
    const update = (): void => {
      const next = findTable(props.anchor);
      if (next !== table) {
        if (table !== null) observer.unobserve(table);
        table = next;
        if (table !== null) observer.observe(table);
      }
      const measured = table === null ? null : measure(table);
      setGeometry((previous) =>
        JSON.stringify(previous) === JSON.stringify(measured)
          ? previous
          : measured,
      );
    };
    if (table !== null) observer.observe(table);
    const mutation = new MutationObserver(update);
    const host = table?.closest('.flbp-host');
    if (host !== null && host !== undefined)
      mutation.observe(host, { childList: true, subtree: true });
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      observer.disconnect();
      mutation.disconnect();
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [props.anchor.x, props.anchor.y, props.anchor.width]);
  if (geometry === null) return null;

  const run = (id: string, target: Target, to?: number): void => {
    if (!props.available.has(id)) return;
    props.onAction(
      id,
      JSON.stringify({
        blockId: geometry.blockId,
        row: target.axis === 'row' ? target.index : 0,
        col: target.axis === 'column' ? target.index : 0,
        ...(to === undefined ? {} : { to }),
      }),
    );
    setOpen(null);
  };
  const actions =
    open?.axis === 'row'
      ? [
          ['table.addRowBefore', 'Insert above'],
          ['table.addRow', 'Insert below'],
          ['table.removeRow', 'Delete row'],
          ['table.moveRowUp', 'Move up'],
          ['table.moveRowDown', 'Move down'],
          ...(open.index === 0 ? [['table.toggleHeader', 'Header row']] : []),
        ]
      : [
          ['table.addColumnBefore', 'Insert left'],
          ['table.addColumn', 'Insert right'],
          ['table.removeColumn', 'Delete column'],
          ['table.moveColumnLeft', 'Move left'],
          ['table.moveColumnRight', 'Move right'],
        ];
  const targetRect =
    open === null
      ? null
      : open.axis === 'row'
        ? geometry.rows[open.index]
        : geometry.columns[open.index];
  const destinationAt = (axis: Axis, point: number): number => {
    const slots = axis === 'row' ? geometry.rows : geometry.columns;
    return slots.reduce((best, slot, index) => {
      const center = axis === 'row' ? slot.y + slot.height / 2 : slot.x + slot.width / 2;
      return Math.abs(center - point) < best.distance
        ? { index, distance: Math.abs(center - point) } : best;
    }, { index: 0, distance: Number.POSITIVE_INFINITY }).index;
  };
  const handle = (
    axis: Axis,
    rect: Rect,
    index: number,
  ): React.ReactElement => {
    const target = { axis, index };
    const isOpen = open?.axis === axis && open.index === index;
    const isDrop = dragging?.axis === axis && dragging.to === index;
    const visible =
      dragging !== null ||
      open?.axis === axis ||
      (axis === 'row' ? active?.row === index : active?.col === index);
    const size = window.matchMedia?.('(pointer: coarse)').matches ? 44 : 24;
    return (
      <button
        key={`${axis}-${index}`}
        type="button"
        className={styles.handle}
        data-flbp-table-row-handle={axis === 'row' ? index : undefined}
        data-flbp-table-column-handle={axis === 'column' ? index : undefined}
        data-drop={isDrop ? 'true' : undefined}
        data-visible={visible ? 'true' : 'false'}
        aria-hidden={!visible}
        tabIndex={visible ? 0 : -1}
        aria-label={`${axis === 'row' ? 'Row' : 'Column'} ${index + 1} actions`}
        aria-expanded={isOpen}
        style={
          axis === 'row'
            ? {
                left: Math.max(4, geometry.table.x - size - 6),
                top: rect.y + rect.height / 2 - size / 2,
              }
            : {
                left: rect.x + rect.width / 2 - size / 2,
                top: geometry.table.y - size,
              }
        }
        onClick={() => {
          if (suppressClick.current) {
            suppressClick.current = false;
            return;
          }
          setOpen(isOpen ? null : target);
        }}
        onPointerDown={(event) => {
          event.preventDefault();
          dragPointer.current = {
            pointerId: event.pointerId,
            axis,
            index,
            x: event.clientX,
            y: event.clientY,
            moved: false,
          };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const drag = dragPointer.current;
          if (drag?.pointerId !== event.pointerId) return;
          if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 8 && !drag.moved) return;
          drag.moved = true;
          const point = axis === 'row' ? event.clientY : event.clientX;
          const to = destinationAt(axis, point);
          setDragging({ axis, index, to, x: event.clientX, y: event.clientY });
        }}
        onPointerUp={(event) => {
          const drag = dragPointer.current;
          if (drag?.pointerId !== event.pointerId) return;
          dragPointer.current = null;
          if (drag.moved) {
            event.preventDefault();
            suppressClick.current = true;
            window.setTimeout(() => {
              suppressClick.current = false;
            }, 500);
            const destination = destinationAt(axis, axis === 'row' ? event.clientY : event.clientX);
            if (destination !== index)
              run(
                axis === 'row' ? 'table.moveRowUp' : 'table.moveColumnLeft',
                target,
                destination,
              );
          }
          setDragging(null);
        }}
        onPointerCancel={() => {
          dragPointer.current = null;
          setDragging(null);
        }}
      >
        <span aria-hidden="true">⋮⋮</span>
      </button>
    );
  };
  const dragSource = dragging === null ? null :
    (dragging.axis === 'row' ? geometry.rows[dragging.index] : geometry.columns[dragging.index]);
  const dragTarget = dragging === null ? null :
    (dragging.axis === 'row' ? geometry.rows[dragging.to] : geometry.columns[dragging.to]);
  const coarse = window.matchMedia?.('(pointer: coarse)').matches === true;
  return createPortal(
    <div className={styles.layer} data-flbp-table-handles="">
      {dragging !== null && dragSource != null && dragTarget != null ? (
        <>
          <div ref={previewRef} className={styles.dragPreview} aria-hidden="true" style={
            dragging.axis === 'row'
              ? { left: geometry.table.x, top: dragging.y - dragSource.height / 2,
                  width: geometry.table.width, height: dragSource.height }
              : { left: dragging.x - dragSource.width / 2,
                  top: geometry.table.y, width: dragSource.width,
                  height: geometry.table.height }
          } />
          <div ref={targetPreviewRef} className={styles.targetPreview} aria-hidden="true" style={
            dragging.axis === 'row'
              ? { left: geometry.table.x, top: dragTarget.y,
                  width: geometry.table.width, height: dragSource.height }
              : { left: dragTarget.x, top: geometry.table.y,
                  width: dragSource.width,
                  height: geometry.table.height }
          } />
        </>
      ) : null}
      {geometry.rows.map((rect, index) => handle('row', rect, index))}
      {geometry.columns.map((rect, index) => handle('column', rect, index))}
      {(insertEdge === 'row' || (coarse && active !== null)) ? (
        <button
          type="button"
          className={styles.insertRow}
          aria-label="Add table row at bottom"
          style={{ left: geometry.table.x, top: geometry.table.y + geometry.table.height + 4, width: geometry.table.width }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => run('table.addRow', { axis: 'row', index: geometry.rows.length - 1 })}
        >+
        </button>
      ) : null}
      {(insertEdge === 'column' || (coarse && active !== null)) ? (
        <button
          type="button"
          className={styles.insertColumn}
          aria-label="Add table column at right"
          style={{ left: geometry.table.x + geometry.table.width + 4, top: geometry.table.y, height: geometry.table.height }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => run('table.addColumn', { axis: 'column', index: geometry.columns.length - 1 })}
        >+
        </button>
      ) : null}
      {open !== null && targetRect !== undefined && targetRect !== null ? (
        <>
          <button
            type="button"
            className={styles.scrim}
            aria-label="Close table actions"
            onClick={() => setOpen(null)}
          />
          <div
            className={styles.menu}
            role="dialog"
            aria-label={`${open.axis === 'row' ? 'Row' : 'Column'} ${open.index + 1} actions`}
            style={{
              left: Math.max(
                8,
                Math.min(
                  window.innerWidth - 200,
                  open.axis === 'row' ? geometry.table.x : targetRect.x,
                ),
              ),
              top: Math.max(
                8,
                Math.min(
                  window.innerHeight - 270,
                  open.axis === 'row' ? targetRect.y : geometry.table.y,
                ),
              ),
            }}
          >
            <div className={styles.heading}>
              {open.axis === 'row' ? 'Row' : 'Column'} {open.index + 1}
            </div>
            {actions.map(([id, label]) => (
              <button
                key={id}
                type="button"
                disabled={
                  !props.available.has(id) ||
                  (id === 'table.moveRowUp' && open.index === 0) ||
                  (id === 'table.moveRowDown' &&
                    open.index === geometry.rows.length - 1) ||
                  (id === 'table.moveColumnLeft' && open.index === 0) ||
                  (id === 'table.moveColumnRight' &&
                    open.index === geometry.columns.length - 1)
                }
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => run(id, open)}
              >
                {label}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>,
    document.body,
  );
}
