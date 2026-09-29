/**
 * Editable table grid nodes + table editing behavior.
 *
 * Replaces the old `tableBlock` atom with a fully editable grid:
 *
 * - PM roles: `table` / `tableRow` / `tableCell` / `tableHeader` /
 *   `tableParagraph`. Node *names* are Froglight camelCase; the `tableRole`
 *   spec field (`table`/`row`/`cell`/`header_cell`) is what
 *   `prosemirror-tables` keys off (`tableNodeTypes` scans by role, never by
 *   name), so every `prosemirror-tables` command works unchanged.
 * - `blockId` lives at the `table` level only (stable canonical identity;
 *   flows through pm-map both ways). Rows/cells carry no ids — there is
 *   nothing canonical to attach them to.
 * - `header` + `align` ride as `table` attrs (canonical, byte-faithful via
 *   pm-map) and are RENDERED: the header row uses `th` cells, and each cell
 *   carries an ephemeral `align` attr (derived from its column at encode
 *   time) that renders `text-align`.
 * - Column widths are EPHEMERAL by design: no resize plugin is
 *   wired, `colwidth` is never written by any op, and pm-map strips it on
 *   decode. Widths never reach canonical bytes.
 *
 * Span policy: this module offers NO span-creating ops
 * (no merge/split/colspan/rowspan commands are wired, exposed, or
 * shortcut-bound), so live editing can never produce `colspan`/`rowspan >
 * 1`. Spans can still arrive from outside (pasted HTML tables), and pm-map
 * flattens them in document order WITH a `TABLE_SPAN_FLATTENED` warning —
 * never silent loss.
 *
 * Cell content is a single `tableParagraph` per cell (inline runs with
 * marks: bold/italic/link/resource keep working). No block nesting inside
 * cells: Enter moves the cell cursor down (creating a row at the grid end),
 * never splits a second paragraph into the cell.
 */

import { Extension, Node, mergeAttributes } from '@tiptap/core';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import { TextSelection } from '@tiptap/pm/state';
import { closeHistory } from '@tiptap/pm/history';
import {
  CellSelection,
  addColumnBefore,
  addColumnAfter,
  addRowBefore,
  addRowAfter,
  deleteColumn,
  deleteRow,
  deleteTable,
  findTable,
  goToNextCell,
  isInTable,
  moveCellForward,
  moveTableColumn,
  moveTableRow,
  nextCell,
  rowIsHeader,
  selectedRect,
  selectionCell,
  tableEditing,
  tableNodeTypes,
} from 'prosemirror-tables';
import { newBlockId } from './model-edit.js';

/** Slash size presets: engine-owned picker, 2×2 default.*/
export const TABLE_SIZE_PRESETS = [
  { id: '2x2', label: 'Table 2 × 2', rows: 2, cols: 2 },
  { id: '3x3', label: 'Table 3 × 3', rows: 3, cols: 3 },
  { id: '4x4', label: 'Table 4 × 4', rows: 4, cols: 4 },
] as const;

export interface TableSizePreset {
  readonly id: string;
  readonly label: string;
  readonly rows: number;
  readonly cols: number;
}

export function tablePresetById(id: string): TableSizePreset {
  return (
    TABLE_SIZE_PRESETS.find((preset) => preset.id === id) ??
    TABLE_SIZE_PRESETS[0]!
  );
}

/**
 * True when the selection lives inside the table grid: ancestor
 * scan for the `table` node. Shared by the grid keymap guards, the chrome
 * Tab yield, the indent/outdent refusals, the slash suppression, and the
 * Shift+click ownership decision below. Pure over editor state
 * so specs pin the decision table without DOM mouse geometry (jsdom cannot
 * drive PM's posAtCoords-gated click path with synthetic events — see the
 *  spec header).
 */
export function inTableGrid(state: EditorState): boolean {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth >= 0; depth -= 1) {
    if ($from.node(depth).type.name === 'table') return true;
  }
  return false;
}

/** Canonical align values; anything else is preserved verbatim, never rendered. */
function renderAlign(align: unknown): string | null {
  return align === 'left' || align === 'center' || align === 'right'
    ? align
    : null;
}

export const Table = Node.create({
  name: 'table',
  group: 'block',
  content: 'tableRow+',
  isolating: true,
  // Role `table` reaches the schema via extendNodeSchema below (Tiptap only
  // forwards allowlisted spec fields; see FlbpTableGrid).
  addAttributes() {
    return {
      blockId: { default: null },
      header: { default: false },
      align: { default: null },
    };
  },
  parseHTML() {
    return [
      {
        tag: 'table[data-flbp-grid]',
        getAttrs: (el) => {
          const host = el as HTMLElement;
          let align: unknown = null;
          try {
            const parsed: unknown = JSON.parse(
              host.getAttribute('data-align') ?? 'null',
            );
            if (Array.isArray(parsed)) align = parsed;
          } catch {
            align = null;
          }
          return {
            blockId: host.getAttribute('data-block-id') ?? null,
            header: host.getAttribute('data-header') === 'true',
            align,
          };
        },
      },
    ];
  },
  renderHTML({ node, HTMLAttributes }) {
    const align = Array.isArray(node.attrs.align) ? node.attrs.align : null;
    return [
      'table',
      mergeAttributes(
        { 'data-flbp-grid': '', class: 'flbp-table-grid' },
        HTMLAttributes,
        {
          'data-block-id': String(node.attrs.blockId ?? ''),
          'data-header': String(node.attrs.header === true),
          ...(align !== null ? { 'data-align': JSON.stringify(align) } : {}),
        },
      ),
      ['tbody', 0],
    ];
  },
});

export const TableRow = Node.create({
  name: 'tableRow',
  content: '(tableCell | tableHeader)*',
  // Role `row` — see extendNodeSchema below.
  parseHTML() {
    return [{ tag: 'tr' }];
  },
  renderHTML() {
    return ['tr', 0];
  },
});

const cellAttrs = {
  colspan: { default: 1 },
  rowspan: { default: 1 },
  // Ephemeral presentation only: written by pm-map encode from the
  // column's canonical align so alignment renders per cell; stripped by
  // pm-map decode (the table-level `align` is authoritative).
  align: { default: null },
  // Ephemeral width hint: never written by any op; stripped decode.
  colwidth: { default: null },
};

function cellGetAttrs(kind: 'td' | 'th') {
  return [
    {
      tag: kind,
      getAttrs: (el: HTMLElement | string) => {
        if (typeof el === 'string') return null;
        const style = el.getAttribute('style') ?? '';
        const alignMatch = /text-align:\s*(left|center|right)/.exec(style);
        const colspan = Number(el.getAttribute('colspan') ?? '1');
        const rowspan = Number(el.getAttribute('rowspan') ?? '1');
        return {
          colspan: Number.isFinite(colspan)
            ? Math.max(1, Math.floor(colspan))
            : 1,
          rowspan: Number.isFinite(rowspan)
            ? Math.max(1, Math.floor(rowspan))
            : 1,
          align: alignMatch !== null ? alignMatch[1] : null,
          colwidth: null,
        };
      },
    },
  ];
}

function cellRenderHTML(kind: 'td' | 'th') {
  return ({ node }: { node: { attrs: Record<string, unknown> } }) => {
    const align = renderAlign(node.attrs.align);
    const colspan =
      typeof node.attrs.colspan === 'number' && node.attrs.colspan > 1
        ? { colspan: String(node.attrs.colspan) }
        : {};
    const rowspan =
      typeof node.attrs.rowspan === 'number' && node.attrs.rowspan > 1
        ? { rowspan: String(node.attrs.rowspan) }
        : {};
    return [
      kind,
      mergeAttributes(
        { class: kind === 'th' ? 'flbp-th' : 'flbp-td' },
        colspan,
        rowspan,
        align !== null ? { style: `text-align: ${align}` } : {},
      ),
      0,
    ] as const;
  };
}

export const TableCell = Node.create({
  name: 'tableCell',
  content: 'tableParagraph',
  isolating: true,
  // Role `cell` — see extendNodeSchema below.
  addAttributes() {
    return { ...cellAttrs };
  },
  parseHTML() {
    return cellGetAttrs('td');
  },
  renderHTML: cellRenderHTML('td'),
});

export const TableHeader = Node.create({
  name: 'tableHeader',
  content: 'tableParagraph',
  isolating: true,
  // Role `header_cell` — see extendNodeSchema below.
  addAttributes() {
    return { ...cellAttrs };
  },
  parseHTML() {
    return cellGetAttrs('th');
  },
  renderHTML: cellRenderHTML('th'),
});

/**
 * The single paragraph inside a grid cell. Deliberately NOT in the `block`
 * group (never a top-level block, never a turn-into/drag target) and
 * carrying no `blockId` (identity lives at the table level).
 */
export const TableParagraph = Node.create({
  name: 'tableParagraph',
  content: 'inline*',
  defining: true,
  parseHTML() {
    return [{ tag: 'p' }];
  },
  renderHTML({ HTMLAttributes }) {
    return [
      'p',
      mergeAttributes(
        { 'data-flbp-cell-para': '', class: 'flbp-cell-para' },
        HTMLAttributes,
      ),
      0,
    ];
  },
});

/** Clamp a requested grid dimension to the supported insert range. */
export function sanitizeTableSize(raw: unknown, fallback: number): number {
  const n = typeof raw === 'number' ? raw : Number(raw ?? fallback);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(12, Math.max(1, Math.floor(n)));
}

/**
 * Build a fresh grid under the caller's schema (insert path). Pure builder:
 * no selection reads, no dispatch — the caller fuses it into its
 * closeHistory transaction (outcome-before-mutation: dimensions are clamped
 * so the node always builds).
 */
export function buildTableNode(
  schema: {
    nodes: Record<
      string,
      {
        create(
          attrs?: Record<string, unknown> | null,
          content?: unknown,
        ): { nodeSize: number };
      }
    >;
  },
  options: {
    blockId?: string;
    rows?: number;
    cols?: number;
    header?: boolean;
    align?: unknown;
  },
): { nodeSize: number } {
  const rows = sanitizeTableSize(options.rows, 2);
  const cols = sanitizeTableSize(options.cols, 2);
  const header = options.header === true;
  const align = Array.isArray(options.align) ? options.align : null;
  const grid: { nodeSize: number }[] = [];
  for (let r = 0; r < rows; r += 1) {
    const cells: { nodeSize: number }[] = [];
    for (let c = 0; c < cols; c += 1) {
      const cellAlign =
        align !== null && align[c] !== undefined ? align[c] : null;
      const paragraph = schema.nodes.tableParagraph!.create(null);
      const cellType =
        header && r === 0 ? schema.nodes.tableHeader! : schema.nodes.tableCell!;
      cells.push(
        cellType.create(
          { colspan: 1, rowspan: 1, align: cellAlign, colwidth: null },
          paragraph,
        ),
      );
    }
    grid.push(schema.nodes.tableRow!.create(null, cells));
  }
  return schema.nodes.table!.create(
    { blockId: options.blockId ?? newBlockId(), header, align },
    grid,
  );
}

/**
 * IME guard: grid keymap ops must never fire mid-composition.
 * Tiptap keyboard-shortcut methods receive `{ editor }` only — never the
 * KeyboardEvent — so only `view.composing` is observable here. The chrome
 * `handleKeyDown` (which does see the event) additionally checks
 * `event.isComposing` before its own branches, and the slash/resource
 * appendTransaction detection guards on `view.composing` the same way the
 * input-rules engine layer short-circuits `handleTextInput`.
 */
function gridComposing(editor: {
  readonly view: { readonly composing?: boolean };
}): boolean {
  try {
    return editor.view.composing === true;
  } catch {
    return false;
  }
}
/**
 * Whole-table cell selection (empty-table-select): Backspace/Delete removes
 * the table itself instead of merely clearing every cell. Returns the table
 * range when the CellSelection covers the full grid, else null.
 */
function wholeTableRange(state: EditorState): {
  tablePos: number;
  tableSize: number;
} | null {
  if (!(state.selection instanceof CellSelection)) return null;
  let rect: ReturnType<typeof selectedRect>;
  try {
    rect = selectedRect(state);
  } catch {
    return null;
  }
  if (
    rect.top !== 0 ||
    rect.left !== 0 ||
    rect.bottom !== rect.map.height ||
    rect.right !== rect.map.width
  ) {
    return null;
  }
  let found: ReturnType<typeof findTable>;
  try {
    found = findTable(state.selection.$from);
  } catch {
    return null;
  }
  if (found === null) return null;
  return { tablePos: found.pos, tableSize: found.node.nodeSize };
}

/**
 * Run one structural op as a single-undo command against a live editor.
 * Outcome-before-mutation: off-grid selections and inapplicable ops refuse
 * without dispatching. Shared by the grid keymap and the Document-Tools
 * executor so both surfaces converge on one history granularity.
 */
export function runTableOpCommand(
  editor: {
    readonly state: EditorState;
    readonly view: { dispatch(tr: Transaction): void; composing?: boolean };
  },
  op: TableOpId,
): boolean {
  if (gridComposing(editor)) return false;
  if (!isInTable(editor.state)) return false;
  let built: Transaction | null = null;
  if (
    !runTableOp(op, editor.state, (tr) => {
      built = tr;
    })
  ) {
    return false;
  }
  if (built === null) return false;
  editor.view.dispatch(closeHistory(built));
  return true;
}

/** Target a visible row/column handle without putting editor internals in UI. */
export function selectTableCellForAction(
  editor: {
    readonly state: EditorState;
    readonly view: { dispatch(tr: Transaction): void; composing?: boolean };
  },
  blockId: string,
  row: number,
  col: number,
): boolean {
  if (gridComposing(editor) || !Number.isInteger(row) || !Number.isInteger(col))
    return false;
  let tablePos: number | null = null;
  let tableNode: import('@tiptap/pm/model').Node | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === 'table' && node.attrs.blockId === blockId) {
      tablePos = pos;
      tableNode = node;
      return false;
    }
    return true;
  });
  if (tablePos === null || tableNode === null) return false;
  const table = tableNode as import('@tiptap/pm/model').Node;
  if (row < 0 || row >= table.childCount) return false;
  const targetRow = table.child(row);
  if (col < 0 || col >= targetRow.childCount) return false;
  let cellPos = tablePos + 2;
  for (let index = 0; index < row; index += 1)
    cellPos += table.child(index).nodeSize;
  for (let index = 0; index < col; index += 1)
    cellPos += targetRow.child(index).nodeSize;
  const textPos = cellPos + 2;
  if (editor.state.selection.from === textPos && editor.state.selection.empty)
    return true;
  editor.view.dispatch(
    editor.state.tr
      .setSelection(TextSelection.create(editor.state.doc, textPos))
      .setMeta('addToHistory', false),
  );
  return true;
}

/** One undo step for dragging a row or column to a specific index. */
export function runTableMoveToCommand(
  editor: {
    readonly state: EditorState;
    readonly view: { dispatch(tr: Transaction): void; composing?: boolean };
  },
  axis: 'row' | 'column',
  to: number,
): boolean {
  if (
    gridComposing(editor) ||
    !isInTable(editor.state) ||
    !Number.isInteger(to)
  )
    return false;
  let rect: ReturnType<typeof selectedRect>;
  try {
    rect = selectedRect(editor.state);
  } catch {
    return false;
  }
  const from = axis === 'row' ? rect.top : rect.left;
  const limit = axis === 'row' ? rect.map.height : rect.map.width;
  if (to < 0 || to >= limit || to === from) return false;
  let built: Transaction | null = null;
  const command =
    axis === 'row' ? moveTableRow({ from, to }) : moveTableColumn({ from, to });
  if (!command(editor.state, (tr) => (built = tr)) || built === null)
    return false;
  editor.view.dispatch(closeHistory(built));
  return true;
}

/**
 * Grid keymap (clean-room reimplementation of the standard
 * prosemirror-tables interaction pattern — cell cursor, Tab nav, guarded
 * Backspace — with Froglight wiring): Tab/Shift-Tab move between cells,
 * Enter moves down (creating a trailing row at the grid end), Backspace is
 * guarded at cell starts, and a whole-table cell selection deletes the
 * table. Structural shortcuts (Mod-Alt-Arrows) run the same single-undo
 * ops as the semantic controls. No merge/split/span commands are bound
 * anywhere.
 */
export const FlbpTableGrid = Extension.create({
  name: 'flbpTableGrid',

  /**
   * Inject the `tableRole` spec field Tiptap's schema builder would
   * otherwise drop (it forwards an explicit allowlist only). Roles are
   * what `prosemirror-tables` keys off — `tableNodeTypes` scans by role,
   * never by node name — so this mapping is the load-bearing piece that
   * makes every table command recognize the grid.
   */
  extendNodeSchema(extension) {
    const roles: Record<string, string> = {
      table: 'table',
      tableRow: 'row',
      tableCell: 'cell',
      tableHeader: 'header_cell',
    };
    const role = roles[extension.name];
    return role !== undefined ? { tableRole: role } : {};
  },

  addProseMirrorPlugins() {
    return [tableEditing({ allowTableNodeSelection: false })];
  },

  addKeyboardShortcuts() {
    return {
      Tab: () => {
        if (gridComposing(this.editor)) return false;
        if (!isInTable(this.editor.state)) return false;
        return this.editor.commands.command(({ state, dispatch, view }) =>
          goToNextCell(1)(state, dispatch, view),
        );
      },
      'Shift-Tab': () => {
        if (gridComposing(this.editor)) return false;
        if (!isInTable(this.editor.state)) return false;
        return this.editor.commands.command(({ state, dispatch, view }) =>
          goToNextCell(-1)(state, dispatch, view),
        );
      },
      Enter: () => {
        if (gridComposing(this.editor)) return false;
        if (!isInTable(this.editor.state)) return false;
        return this.editor.commands.command(({ state, dispatch }) => {
          const $cell = selectionCell(state);
          const $below = nextCell($cell, 'vert', 1);
          if ($below !== null) {
            if (dispatch) {
              dispatch(
                closeHistory(
                  state.tr
                    .setSelection(
                      TextSelection.between($below, moveCellForward($below)),
                    )
                    .scrollIntoView(),
                ),
              );
            }
            return true;
          }
          // Last row: create a trailing row, then step into it — one
          // intercepted transaction (single undo).
          if (!dispatch) return true;
          let built: Transaction | null = null;
          if (
            !addRowAfter(state, (tr) => {
              built = tr;
            })
          ) {
            return false;
          }
          const tr = built as unknown as Transaction;
          const mapped = tr.mapping.map($cell.pos);
          const $mapped = tr.doc.resolve(mapped);
          const $target = nextCell($mapped, 'vert', 1);
          if ($target === null) {
            dispatch(closeHistory(tr));
            return true;
          }
          dispatch(
            closeHistory(
              tr
                .setSelection(
                  TextSelection.between($target, moveCellForward($target)),
                )
                .scrollIntoView(),
            ),
          );
          return true;
        });
      },
      Backspace: () => {
        if (gridComposing(this.editor)) return false;
        const whole = wholeTableRange(this.editor.state);
        if (whole !== null) {
          return this.editor.commands.command(({ tr }) => {
            closeHistory(tr);
            tr.delete(whole.tablePos, whole.tablePos + whole.tableSize);
            return true;
          });
        }
        // Guarded inside cells: at the start of a cell paragraph Backspace
        // must never escape into (or delete) grid structure.
        const selection = this.editor.state.selection;
        return (
          selection.empty &&
          selection.$head.parentOffset === 0 &&
          selection.$head.parent.type.name === 'tableParagraph'
        );
      },
      Delete: () => {
        if (gridComposing(this.editor)) return false;
        const whole = wholeTableRange(this.editor.state);
        if (whole === null) return false;
        return this.editor.commands.command(({ tr }) => {
          closeHistory(tr);
          tr.delete(whole.tablePos, whole.tablePos + whole.tableSize);
          return true;
        });
      },
      // Structural shortcuts — the same single-undo ops as the
      // Document-Tools surface (Mod-Alt avoids the browser-history trap of
      // bare Alt-Left/Right and stays clear of tableEditing's arrows).
      'Mod-Alt-ArrowDown': () => runTableOpCommand(this.editor, 'addRow'),
      'Mod-Alt-ArrowRight': () => runTableOpCommand(this.editor, 'addColumn'),
      'Mod-Alt-ArrowUp': () => runTableOpCommand(this.editor, 'removeRow'),
      'Mod-Alt-ArrowLeft': () => runTableOpCommand(this.editor, 'removeColumn'),
    };
  },
});

/** Structural row/col/header ops for the Document-Tools surface. */
export type TableOpId =
  | 'addRowBefore'
  | 'addRow'
  | 'addColumnBefore'
  | 'addColumn'
  | 'removeRow'
  | 'removeColumn'
  | 'moveRowUp'
  | 'moveRowDown'
  | 'moveColumnLeft'
  | 'moveColumnRight'
  | 'toggleHeader';

export const TABLE_OP_IDS: readonly string[] = [
  'table.addRowBefore',
  'table.addRow',
  'table.addColumnBefore',
  'table.addColumn',
  'table.removeRow',
  'table.removeColumn',
  'table.moveRowUp',
  'table.moveRowDown',
  'table.moveColumnLeft',
  'table.moveColumnRight',
  'table.toggleHeader',
];

/**
 * Run one structural op through prosemirror-tables commands on the caller's
 * transaction pipeline. The caller owns history (`closeHistory`) and
 * in-table guards; this switch owns the op inventory (no span ops exist —
 *
 *
 * Degenerate-grid policy: removing the last row/column deletes the table
 * itself (via `deleteTable`) instead of leaving a zero-row/zero-column
 * grid that no canonical shape can represent.
 */
export function runTableOp(
  op: TableOpId,
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
): boolean {
  switch (op) {
    case 'addRowBefore':
      return addRowBefore(state, dispatch);
    case 'addRow':
      return addRowAfter(state, dispatch);
    case 'addColumnBefore':
      return addColumnBefore(state, dispatch);
    case 'addColumn':
      return addColumnAfter(state, dispatch);
    case 'removeRow': {
      if (isLastRowOrColumn(state, 'row')) return deleteTable(state, dispatch);
      return deleteRow(state, dispatch);
    }
    case 'removeColumn': {
      if (isLastRowOrColumn(state, 'column'))
        return deleteTable(state, dispatch);
      return deleteColumn(state, dispatch);
    }
    case 'moveRowUp':
      return moveRowOrColumn(state, dispatch, 'row', -1);
    case 'moveRowDown':
      return moveRowOrColumn(state, dispatch, 'row', 1);
    case 'moveColumnLeft':
      return moveRowOrColumn(state, dispatch, 'column', -1);
    case 'moveColumnRight':
      return moveRowOrColumn(state, dispatch, 'column', 1);
    case 'toggleHeader':
      return toggleFirstRowHeader(state, dispatch);
  }
}

function isLastRowOrColumn(
  state: EditorState,
  axis: 'row' | 'column',
): boolean {
  try {
    const rect = selectedRect(state);
    return axis === 'row' ? rect.map.height <= 1 : rect.map.width <= 1;
  } catch {
    return false;
  }
}

function moveRowOrColumn(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
  axis: 'row' | 'column',
  dir: -1 | 1,
): boolean {
  let rect: ReturnType<typeof selectedRect>;
  try {
    rect = selectedRect(state);
  } catch {
    return false;
  }
  if (axis === 'row') {
    const from = rect.top;
    const to = from + dir;
    if (to < 0 || to >= rect.map.height) return false;
    return moveTableRow({ from, to })(state, dispatch);
  }
  const from = rect.left;
  const to = from + dir;
  if (to < 0 || to >= rect.map.width) return false;
  return moveTableColumn({ from, to })(state, dispatch);
}

/**
 * Canonical header toggle: the FIRST row flips between header and normal
 * cells (plus the table `header` attr), wherever the caret sits. Single
 * transaction, single undo; keeps the attr and the rendered `th` cells in
 * sync so pm-map never has to guess.
 */
function toggleFirstRowHeader(
  state: EditorState,
  dispatch: ((tr: Transaction) => void) | undefined,
): boolean {
  let rect: ReturnType<typeof selectedRect>;
  try {
    rect = selectedRect(state);
  } catch {
    return false;
  }
  if (rect.table.childCount === 0) return false;
  const types = tableNodeTypes(state.schema);
  const makeHeader = !rowIsHeader(rect.map, rect.table, 0);
  const target = makeHeader ? types.header_cell : types.cell;
  if (dispatch) {
    const tr = state.tr;
    const tableType = tableNodeTypes(state.schema).table;
    // NOTE: never resolve the table via `doc.nodeAt(tableStart)` here —
    // nodeAt descends past left-boundary positions and returns the first
    // row instead (found live: the header flag silently landed on the row
    // while cells flipped). Locate by stable blockId and restate the type
    // explicitly so the markup cannot land on a descendant.
    const blockId = (rect.table.attrs as { blockId?: unknown }).blockId;
    let tablePos: number | null = null;
    tr.doc.descendants((node, pos) => {
      if (
        node.type === tableType &&
        (node.attrs as { blockId?: unknown }).blockId === blockId
      ) {
        tablePos = pos;
        return false;
      }
      return true;
    });
    if (tablePos === null) return false;
    tr.setNodeMarkup(tablePos, tableType, {
      ...rect.table.attrs,
      header: makeHeader,
    });
    const firstRow = rect.table.child(0);
    for (let i = 0; i < firstRow.childCount; i += 1) {
      const cell = firstRow.child(i);
      if (cell.type === target) continue;
      const pos = rect.tableStart + rect.map.positionAt(0, i, rect.table);
      tr.setNodeMarkup(pos, target, cell.attrs);
    }
    dispatch(tr);
  }
  return true;
}

export { deleteTable, isInTable };

/**
 * Live grid geometry for the Document-Tools snapshot: row/col
 * counts, header flag, and the caret's row/column for move-boundary
 * disabled states. Null outside tables. Provider-computed; the shared UI
 * never walks editor state.
 */
export function caretTableGeometry(state: EditorState): {
  readonly rows: number;
  readonly cols: number;
  readonly header: boolean;
  readonly row: number;
  readonly col: number;
} | null {
  if (!isInTable(state)) return null;
  let rect: ReturnType<typeof selectedRect>;
  try {
    rect = selectedRect(state);
  } catch {
    return null;
  }
  let width = 0;
  for (let r = 0; r < rect.table.childCount; r += 1) {
    width = Math.max(width, rect.table.child(r).childCount);
  }
  return {
    rows: rect.table.childCount,
    cols: Math.max(1, width),
    header:
      (rect.table.attrs as { header?: unknown } | undefined)?.header === true,
    row: Math.min(rect.top, Math.max(0, rect.table.childCount - 1)),
    col: Math.min(rect.left, Math.max(0, width - 1)),
  };
}
