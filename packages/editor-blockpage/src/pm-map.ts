/**
 * Canonical `.blockpage` model ↔ ProseMirror JSON mapping for the Tiptap
 * adapter behind the provider seam.
 *
 * Both directions work on plain data (ProseMirror JSON is not an editor
 * class), so this module is unit-testable without DOM. Runtime editor
 * types never cross the provider seam — only canonical models do.
 */

import type {
  BlockId,
  BlockPageModel,
  BlockRecord,
  JsonRecord,
  Mark,
  Run,
} from '@froglight/foundation';

/** Minimal ProseMirror JSON node shape (plain data). */
export interface PmNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: PmNode[];
  text?: string;
  marks?: PmMark[];
}

export interface PmMark {
  type: string;
  attrs?: Record<string, unknown>;
}

const BARE_MARKS = new Set(['bold', 'italic', 'code']);
const RUN_FIELDS = new Set(['text', 'marks']);
const LINK_MARK_FIELDS = new Set(['type', 'href']);
const RESOURCE_MARK_FIELDS = new Set(['type', 'target']);
const REMOTE_LOCATOR_FIELDS = new Set(['url']);
const LIST_ITEM_FIELDS = new Set(['runs', 'checked', 'children']);
const TABLE_ROW_FIELDS = new Set(['cells']);
let runMetadataSequence = 0;

function unknownFields(
  value: Record<string, unknown>,
  known: ReadonlySet<string>,
): Record<string, unknown> | undefined {
  const entries: Array<[string, unknown]> = [];
  for (const [key, item] of Object.entries(value)) {
    if (!known.has(key)) entries.push([key, structuredClone(item)]);
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function appendUnknownFields<T extends Record<string, unknown>>(
  known: T,
  extras: unknown,
  reserved: ReadonlySet<string>,
): T {
  if (typeof extras !== 'object' || extras === null || Array.isArray(extras))
    return known;
  const output = known as Record<string, unknown>;
  for (const [key, value] of Object.entries(extras)) {
    if (reserved.has(key)) continue;
    Object.defineProperty(output, key, {
      value: structuredClone(value),
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return known;
}

/**
 * Canonical `strikethrough` ↔ Tiptap `strike`. The schema mark is
 * named `strike`; the canonical bare mark is `strikethrough` (CORE_MARKS).
 * Both spellings decode to canonical `strikethrough` so old `strike`
 * payloads normalize instead of leaking provider naming into canonical
 * models.
 */
function canonicalToPmMarkName(mark: string): string | null {
  if (mark === 'strikethrough' || mark === 'strike') return 'strike';
  return BARE_MARKS.has(mark) ? mark : null;
}

// --- canonical → ProseMirror JSON ---

function marksToPm(marks: readonly Mark[] | undefined): PmMark[] | undefined {
  if (marks === undefined || marks.length === 0) return undefined;
  const out: PmMark[] = [];
  for (const mark of marks) {
    if (typeof mark === 'string') {
      const pmName = canonicalToPmMarkName(mark);
      out.push(
        pmName !== null
          ? { type: pmName }
          : { type: 'extMark', attrs: { name: mark, json: mark } },
      );
    } else if (!Array.isArray(mark) && (mark as JsonRecord).type === 'link') {
      const record = mark as JsonRecord;
      out.push({
        type: 'link',
        attrs: {
          href: (mark as { href: string }).href,
          preserved: unknownFields(record, LINK_MARK_FIELDS),
        },
      });
    } else if (
      !Array.isArray(mark) &&
      (mark as JsonRecord).type === 'resource'
    ) {
      const record = mark as JsonRecord;
      out.push({
        type: 'resourceMark',
        attrs: {
          target: record.target,
          preserved: unknownFields(record, RESOURCE_MARK_FIELDS),
        },
      });
    } else {
      const record = mark as JsonRecord;
      const name = typeof record.type === 'string' ? record.type : 'unknown';
      out.push({
        type: 'extMark',
        attrs: { name, json: JSON.stringify(record) },
      });
    }
  }
  return out;
}

function runsToInline(runs: readonly Run[] | undefined): PmNode[] {
  const nodes: PmNode[] = [];
  for (const run of runs ?? []) {
    // Empty text nodes are invalid ProseMirror content. A plain empty run is
    // the editable blank-paragraph shape and needs no carrier. If the run
    // has marks or extension members, keep the complete canonical value as
    // an inert inline atom so those fields survive §6 round-trips.
    if (run.text === '') {
      if (Object.keys(run).some((key) => key !== 'text')) {
        nodes.push({ type: 'emptyRun', attrs: { run: structuredClone(run) } });
      }
      continue;
    }
    const pmMarks = marksToPm(run.marks) ?? [];
    const preserved = unknownFields(
      run as unknown as Record<string, unknown>,
      RUN_FIELDS,
    );
    if (preserved !== undefined) {
      runMetadataSequence += 1;
      pmMarks.push({
        type: 'runMetadata',
        attrs: { key: `run-${runMetadataSequence}`, fields: preserved },
      });
    }
    nodes.push({
      type: 'text',
      text: run.text,
      ...(pmMarks.length > 0 ? { marks: pmMarks } : {}),
    });
  }
  return nodes;
}

function runsParagraph(runs: readonly Run[] | undefined): PmNode {
  return { type: 'paragraph', content: runsToInline(runs) };
}

/** Collect every id referenced as a structural child anywhere in the document. */
function claimedIds(model: BlockPageModel): Set<BlockId> {
  const claimed = new Set<BlockId>();
  const claimFrom = (record: BlockRecord): void => {
    if (Array.isArray(record.children)) {
      for (const kid of record.children)
        if (typeof kid === 'string') claimed.add(kid);
    }
    if (record.type === 'froglight.list' && Array.isArray(record.items)) {
      for (const item of record.items as Array<{ children?: BlockId[] }>) {
        for (const kid of item.children ?? []) claimed.add(kid);
      }
    }
  };
  for (const record of Object.values(model.blocks)) claimFrom(record);
  return claimed;
}

function declaredChildren(record: BlockRecord): BlockId[] {
  return Array.isArray(record.children) ? (record.children as BlockId[]) : [];
}

function childNodesOf(model: BlockPageModel, record: BlockRecord): PmNode[] {
  return declaredChildren(record).flatMap((kid) =>
    model.blocks[kid] !== undefined ? blockToNodes(model, kid) : [],
  );
}

/** Overflow group carrying universal children of non-container parents. */
function groupOverflow(
  model: BlockPageModel,
  record: BlockRecord,
  id: BlockId,
): PmNode[] {
  const kids = declaredChildren(record);
  if (kids.length === 0) return [];
  return [
    {
      type: 'blockGroup',
      attrs: { owner: id },
      content: kids.flatMap((kid) =>
        model.blocks[kid] !== undefined ? blockToNodes(model, kid) : [],
      ),
    },
  ];
}

/** Warning emitted when pm-map normalizes a table grid.*/
export interface PmTableWarning {
  readonly code:
    | 'TABLE_SPAN_FLATTENED'
    | 'TABLE_RAGGED_NORMALIZED'
    | 'TABLE_WIDTH_TRUNCATED';
  readonly blockId: BlockId;
  /** Human-readable detail (cell position / span size); diagnostics only. */
  readonly detail?: string;
}

/** Every structural warning emitted by the ProseMirror mapping. */
export type PmStructuralWarning = PmTableWarning;

/**
 * Provider-side disclosure for live table normalizations.
 *
 * DECISION: the open-time warning surface for canonical bytes is
 * `decodeBlockPage().warnings` → `DocumentSession.recoveryWarnings` →
 * workbench pane snapshot → `notify('Recovery report: …', 'error')`
 * (see `useSessionOpener.reportRecovery`). That surface is open/reload-time
 * only: the session field is readonly with no mutator, and the provider input
 * carries the session opaquely (`void input.session`), so live-edit
 * normalizations (pasted-HTML spans, >64-column truncation — both post-open
 * by construction, since no editing op can create spans and grids stay
 * rectangular) can never reach it without a public-contract change, which is
 * out of scope. The minimal disclosure consistent with repo patterns is
 * `console.warn` — the existing provider-side disclosure precedent
 * (`editor.ts` fallback-host wiring fault) — deduplicated per warning
 * signature so steady typing never spams. Pure helper (no console access)
 * so specs pin the channel without DOM: the handle drains it and warns.
 */
export function unseenTableWarningMessages(
  warnings: readonly PmTableWarning[],
  seen: Set<string>,
): string[] {
  const messages: string[] = [];
  for (const warning of warnings) {
    const key = `${warning.code}:${String(warning.blockId)}:${warning.detail ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    messages.push(
      `[froglight/blockpage] table normalization ${warning.code} ` +
        `(block ${String(warning.blockId)}${warning.detail !== undefined ? ` — ${warning.detail}` : ''}); ` +
        `content preserved, structure normalized.`,
    );
  }
  return messages;
}

// --- table grid mapping ---
//
// Canonical shape (UNCHANGED, model.ts): columnCount, align[], header?,
// rows[].cells of Run[][]. The grid is its editable projection:
//
// - encode (`tableRecordToGrid`): header row renders as `tableHeader`
//   (`th`) cells, every other row as `tableCell` (`td`); each cell's
//   ephemeral `align` is derived from its column's canonical align entry so
//   alignment renders per cell; `colwidth` is never written because widths
//   are ephemeral. Ragged/corrupt payloads are padded to a rectangle here;
//   the renderer must never hang. NaN/Infinity column counts degrade to one
//   column, while the
//   decode direction reports the same class of normalization WITH warnings
//   below, where a channel exists.
// - decode (`gridToTableFields`): `colwidth` and per-cell `align` are
//   stripped (table-level `align` is authoritative); `colspan`/`rowspan > 1`
// (only reachable via pasted HTML — no span op exists) flatten
//   in document order with TABLE_SPAN_FLATTENED; rows shorter than the grid
//   width pad with empty cells with TABLE_RAGGED_NORMALIZED. Span extents
//   and the grid width are clamped (≤64) so corrupt payloads cannot hang
//   the page. blockId rides at the table level; row/cell ids never exist.

/**
 * Clamp a table column count to a finite integer >= 1. Non-finite values
 * from corrupt payloads degrade to a single column instead of blanking or
 * hanging the page in an unbounded loop.
 */
function clampColumnCount(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw ?? 1);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.floor(n));
}

/** Read one canonical cell as runs; non-array payloads degrade to empty. */
function canonicalCellRuns(cell: unknown): Run[] {
  if (!Array.isArray(cell)) return [{ text: '' }];
  const runs = (cell as unknown[]).filter(
    (run): run is Run =>
      typeof run === 'object' &&
      run !== null &&
      !Array.isArray(run) &&
      typeof (run as { text?: unknown }).text === 'string',
  );
  return runs.length > 0 ? runs : [{ text: '' }];
}

function tableRecordToGrid(id: BlockId, record: BlockRecord): PmNode[] {
  const rawRows: unknown[] = Array.isArray(record.rows) ? record.rows : [];
  const header = record.header === true;
  const align = Array.isArray(record.align)
    ? [...(record.align as unknown[])]
    : undefined;
  const parsedRows: unknown[][] = rawRows.map((row) => {
    if (typeof row === 'object' && row !== null && !Array.isArray(row)) {
      const cells = (row as { cells?: unknown }).cells;
      return Array.isArray(cells) ? cells : [];
    }
    return [];
  });
  const widest = parsedRows.reduce(
    (max, cells) => Math.max(max, cells.length),
    0,
  );
  // Rectangular grid, never empty, never hanging on corrupt counts.
  const width = Math.max(1, clampColumnCount(record.columnCount), widest);
  const content = parsedRows.length > 0 ? parsedRows : [[]];
  return [
    {
      type: 'table',
      attrs: {
        blockId: id,
        header,
        ...(align !== undefined ? { align } : {}),
      },
      content: content.map((cells, rowIndex) => ({
        type: 'tableRow',
        ...(rawRows[rowIndex] !== undefined &&
        typeof rawRows[rowIndex] === 'object' &&
        rawRows[rowIndex] !== null &&
        !Array.isArray(rawRows[rowIndex])
          ? {
              attrs: {
                preserved: unknownFields(
                  rawRows[rowIndex] as Record<string, unknown>,
                  TABLE_ROW_FIELDS,
                ),
              },
            }
          : {}),
        content: Array.from({ length: width }, (_, colIndex) => {
          const runs = canonicalCellRuns(cells[colIndex]);
          const cellAlign =
            align !== undefined && align[colIndex] !== undefined
              ? align[colIndex]
              : null;
          return {
            type: header && rowIndex === 0 ? 'tableHeader' : 'tableCell',
            attrs: { colspan: 1, rowspan: 1, align: cellAlign, colwidth: null },
            content: [{ type: 'tableParagraph', content: runsToInline(runs) }],
          };
        }),
      })),
    },
  ];
}

/** Clamp a span extent to a sane range so corrupt payloads cannot hang. */
function clampSpan(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw ?? 1);
  if (!Number.isFinite(n)) return 1;
  return Math.min(64, Math.max(1, Math.floor(n)));
}

/** Collect a cell's inline runs in document order (any paragraph shape). */
function cellToRuns(cell: PmNode): Run[] {
  const inline: PmNode[] = [];
  const gather = (nodes: PmNode[] | undefined): void => {
    for (const node of nodes ?? []) {
      if (node.type === 'text') {
        inline.push(node);
        continue;
      }
      if (
        node.type === 'tableParagraph' ||
        node.type === 'paragraph' ||
        node.type === 'tableCell' ||
        node.type === 'tableHeader'
      ) {
        gather(node.content);
      }
    }
  };
  gather(cell.content);
  const runs = inlineToRuns(inline);
  return runs;
}

function gridToTableFields(
  node: PmNode,
  blockId: BlockId,
  warn: (warning: PmTableWarning) => void,
): {
  columnCount: number;
  header: boolean;
  align?: unknown[];
  rows: Array<{ cells: Run[][] } & Record<string, unknown>>;
} {
  const attrs = node.attrs ?? {};
  const sourceRows = (node.content ?? []).filter(
    (child) => child.type === 'tableRow',
  );
  // Reconstruct the grid honoring rowspans: `occupied[col]` counts how many
  // more rows column `col` is covered by a rowspan from above. Spanned slots
  // become empty cells — the spanning cell's own content appears exactly
  // once, in document order (never duplicated, never dropped).
  const occupied: number[] = [];
  const outRows: Run[][][] = [];
  // Width truncation: corrupt payloads (dozens of spanned columns)
  // must not hang the page — the grid clamps to 64 WITH a warning below,
  // never silent loss.
  let truncated = false;
  for (let rowIndex = 0; rowIndex < sourceRows.length; rowIndex += 1) {
    const sourceCells = (sourceRows[rowIndex]!.content ?? []).filter(
      (child) => child.type === 'tableCell' || child.type === 'tableHeader',
    );
    const out: Run[][] = [];
    let col = 0;
    const takeOccupied = (): void => {
      while (col < occupied.length && occupied[col]! > 0) {
        occupied[col]! -= 1;
        out.push([{ text: '' }]);
        col += 1;
      }
    };
    takeOccupied();
    for (const cell of sourceCells) {
      takeOccupied();
      const colspan = clampSpan(cell.attrs?.colspan);
      const rowspan = clampSpan(cell.attrs?.rowspan);
      if (colspan > 1 || rowspan > 1) {
        warn({
          code: 'TABLE_SPAN_FLATTENED',
          blockId,
          detail: `row ${rowIndex} col ${col} ${colspan}x${rowspan}`,
        });
      }
      out.push(cellToRuns(cell));
      for (let extra = 1; extra < colspan; extra += 1) {
        out.push([{ text: '' }]);
      }
      while (occupied.length < col + colspan) occupied.push(0);
      for (let c = col; c < col + colspan; c += 1) {
        occupied[c] = Math.max(occupied[c]!, rowspan - 1);
      }
      col += colspan;
      if (out.length > 64 || col > 64) {
        truncated = true;
        break;
      }
    }
    while (col < occupied.length && occupied[col]! > 0) {
      occupied[col]! -= 1;
      out.push([{ text: '' }]);
      col += 1;
    }
    outRows.push(out);
  }
  let width = outRows.reduce((max, row) => Math.max(max, row.length), 0);
  const naturalWidth = width;
  width = Math.min(64, Math.max(1, width));
  if (naturalWidth > 64) truncated = true;
  if (outRows.length === 0) {
    warn({ code: 'TABLE_RAGGED_NORMALIZED', blockId, detail: 'empty grid' });
    outRows.push([]);
  }
  let ragged = false;
  const rows = outRows.map((cells, rowIndex) => {
    let known: { cells: Run[][] } & Record<string, unknown>;
    if (cells.length < width) {
      ragged = true;
      known = {
        cells: [
          ...cells,
          ...Array.from(
            { length: width - cells.length },
            () => [{ text: '' }] as Run[],
          ),
        ],
      };
    } else {
      known = { cells: cells.slice(0, width) };
    }
    return appendUnknownFields(
      known,
      sourceRows[rowIndex]?.attrs?.preserved,
      TABLE_ROW_FIELDS,
    );
  });
  if (ragged) {
    warn({
      code: 'TABLE_RAGGED_NORMALIZED',
      blockId,
      detail: `padded to ${width}`,
    });
  }
  if (truncated) {
    warn({
      code: 'TABLE_WIDTH_TRUNCATED',
      blockId,
      detail: `clamped to ${width}`,
    });
  }
  const firstRowHasHeader = (sourceRows[0]?.content ?? []).some(
    (child) => child.type === 'tableHeader',
  );
  const header =
    typeof attrs.header === 'boolean' ? attrs.header : firstRowHasHeader;
  const align = Array.isArray(attrs.align) ? [...attrs.align] : undefined;
  return {
    columnCount: width,
    header,
    ...(align !== undefined ? { align } : {}),
    rows,
  };
}

function blockToNodesRaw(model: BlockPageModel, id: BlockId): PmNode[] {
  const record = model.blocks[id];
  if (record === undefined) return [];
  switch (record.type) {
    case 'froglight.paragraph':
    case 'froglight.heading': {
      const isHeading = record.type === 'froglight.heading';
      const main: PmNode = {
        type: isHeading ? 'heading' : 'paragraph',
        attrs: isHeading
          ? { blockId: id, level: record.level }
          : { blockId: id },
        content: runsToInline(record.runs as Run[] | undefined),
      };
      return [main, ...groupOverflow(model, record, id)];
    }
    case 'froglight.code': {
      const language =
        typeof record.language === 'string'
          ? { language: record.language }
          : {};
      const codeText = String(record.text ?? '');
      return [
        {
          type: 'codeBlock',
          attrs: { blockId: id, ...language },
          // Empty code blocks carry empty content (empty text nodes are
          // invalid ProseMirror); decoding maps empty back to text:''.
          ...(codeText === ''
            ? {}
            : { content: [{ type: 'text', text: codeText }] }),
        },
        ...groupOverflow(model, record, id),
      ];
    }
    case 'froglight.divider':
      return [
        { type: 'divider', attrs: { blockId: id } },
        ...groupOverflow(model, record, id),
      ];
    case 'froglight.image': {
      const alt = typeof record.alt === 'string' ? { alt: record.alt } : {};
      const caption =
        typeof record.caption === 'string' ? { caption: record.caption } : {};
      const name = typeof record.name === 'string' ? { name: record.name } : {};
      return [
        {
          type: 'imageBlock',
          attrs: {
            blockId: id,
            src: String(record.src),
            sha256: String(record.sha256),
            ...alt,
            ...caption,
            ...name,
          },
        },
        ...groupOverflow(model, record, id),
      ];
    }
    case 'froglight.video':
    case 'froglight.audio':
    case 'froglight.file': {
      // media atoms: vault identity or opt-in remote (exactly-one in
      // canonical) plus presentation text. The PM layer may hold both
      // locators transiently for in-session fallback preview, but decode
      // keeps remote-when-present and DROPS the vault `src` on save —
      // opting in replaces the vault reference (destructive; re-upload
      // restores via content-addressed dedupe, see the `media.remoteUrl`
      // control disclosure).
      const nodeType =
        record.type === 'froglight.video'
          ? 'videoBlock'
          : record.type === 'froglight.audio'
            ? 'audioBlock'
            : 'fileBlock';
      const remote =
        typeof record.remote === 'object' &&
        record.remote !== null &&
        !Array.isArray(record.remote) &&
        typeof (record.remote as { url?: unknown }).url === 'string'
          ? {
              remoteUrl: String((record.remote as { url: string }).url),
              remotePreserved: unknownFields(
                record.remote as Record<string, unknown>,
                REMOTE_LOCATOR_FIELDS,
              ),
            }
          : {};
      const vault =
        typeof record.src === 'string'
          ? { src: String(record.src) }
          : { src: '' };
      const pin =
        typeof record.sha256 === 'string'
          ? { sha256: String(record.sha256) }
          : { sha256: '' };
      const name = typeof record.name === 'string' ? { name: record.name } : {};
      const caption =
        typeof record.caption === 'string' ? { caption: record.caption } : {};
      const alt = typeof record.alt === 'string' ? { alt: record.alt } : {};
      return [
        {
          type: nodeType,
          attrs: {
            blockId: id,
            ...vault,
            ...pin,
            ...remote,
            ...name,
            ...caption,
            ...alt,
          },
        },
        ...groupOverflow(model, record, id),
      ];
    }
    case 'froglight.math':
    case 'froglight.diagram': {
      // source-only atoms: the source string is canonical;
      // rendered output is derived and never serialized, so encode carries
      // NOTHING but blockId + source (an invented display flag would break
      // round-trip). Non-string sources ride VERBATIM (media remoteUrl
      // precedent) so the codec — not the provider — reports the shape
      // violation; missing sources default to ''. Universal children ride
      // the overflow group like every other atom.
      const nodeType =
        record.type === 'froglight.math' ? 'mathBlock' : 'diagramBlock';
      const raw = (record as { source?: unknown }).source;
      return [
        {
          type: nodeType,
          attrs: {
            blockId: id,
            source: typeof raw === 'string' ? raw : ((raw ?? '') as unknown),
          },
        },
        ...groupOverflow(model, record, id),
      ];
    }
    case 'froglight.table': {
      return [
        ...tableRecordToGrid(id, record),
        ...groupOverflow(model, record, id),
      ];
    }
    case 'froglight.resource-link':
    case 'froglight.resource-embed':
    case 'froglight.transclusion':
    case 'froglight.linked-view': {
      const { id: _drop, ...rest } = record;
      void _drop;
      return [
        { type: 'compositionBlock', attrs: { blockId: id, record: rest } },
        ...groupOverflow(model, record, id),
      ];
    }
    case 'froglight.list': {
      const items = Array.isArray(record.items)
        ? (record.items as Array<{
            runs?: Run[];
            checked?: boolean;
            children?: BlockId[];
          }>)
        : [];
      const listNode: PmNode = {
        type: record.ordered === true ? 'orderedList' : 'bulletList',
        attrs: {
          listId: id,
          ...(record.ordered === true && typeof record.start === 'number'
            ? { start: record.start }
            : {}),
        },
        content: items.map((item) => ({
          type: 'listItem',
          attrs: {
            ...(item.checked !== undefined ? { checked: item.checked } : {}),
            preserved: unknownFields(
              item as unknown as Record<string, unknown>,
              LIST_ITEM_FIELDS,
            ),
          },
          content: [
            runsParagraph(item.runs),
            ...(item.children ?? []).flatMap((kid) =>
              model.blocks[kid] !== undefined ? blockToNodes(model, kid) : [],
            ),
          ],
        })),
      };
      // List-level children ride as following siblings (loss-table edge).
      const followers = declaredChildren(record).flatMap((kid) =>
        model.blocks[kid] !== undefined ? blockToNodes(model, kid) : [],
      );
      return [listNode, ...followers];
    }
    case 'froglight.quote':
      return [
        {
          type: 'blockquote',
          attrs: { blockId: id },
          content: [
            runsParagraph(record.runs as Run[] | undefined),
            ...childNodesOf(model, record),
          ],
        },
      ];
    case 'froglight.toggle':
      return [
        {
          type: 'toggle',
          attrs: { blockId: id },
          content: [
            runsParagraph(record.runs as Run[] | undefined),
            ...childNodesOf(model, record),
          ],
        },
      ];
    case 'froglight.callout': {
      const icon = typeof record.icon === 'string' ? { icon: record.icon } : {};
      const tone = typeof record.tone === 'string' ? { tone: record.tone } : {};
      return [
        {
          type: 'callout',
          attrs: { blockId: id, ...icon, ...tone },
          content: [
            runsParagraph(record.runs as Run[] | undefined),
            ...childNodesOf(model, record),
          ],
        },
      ];
    }
    default: {
      // Opaque plugin record: payload preserved verbatim, structural
      // children stay editable inside the wrapper.
      const payload: Record<string, unknown> = structuredClone(record);
      const typeId = String(record.type);
      return [
        {
          type: 'opaqueBlock',
          attrs: { blockId: id, typeId, payload },
          content: childNodesOf(model, record),
        },
      ];
    }
  }
}

/** Keep provider-unknown core fields in the PM node that owns the record. */
function blockToNodes(model: BlockPageModel, id: BlockId): PmNode[] {
  const record = model.blocks[id];
  if (record === undefined) return [];
  const nodes = blockToNodesRaw(model, id);
  const preserved = unknownCoreFields(record);
  if (preserved === undefined) return nodes;
  const owner = nodes.find(
    (node) => node.attrs?.blockId === id || node.attrs?.listId === id,
  );
  if (owner !== undefined) owner.attrs = { ...(owner.attrs ?? {}), preserved };
  return nodes;
}

/** Build the ProseMirror JSON document for a canonical model. */
export function modelToPmDoc(model: BlockPageModel): PmNode {
  const claimed = claimedIds(model);
  const roots = model.rootOrder.filter((id) => !claimed.has(id));
  return {
    type: 'doc',
    content: roots.flatMap((id) => blockToNodes(model, id)),
  };
}

// --- ProseMirror JSON → canonical ---

function pmMarksToCanonical(marks: PmMark[] | undefined): Mark[] {
  const out: Mark[] = [];
  for (const mark of marks ?? []) {
    if (mark.type === 'runMetadata') continue;
    if (mark.type === 'strike' || mark.type === 'strikethrough') {
      out.push('strikethrough');
      continue;
    }
    if (BARE_MARKS.has(mark.type)) {
      out.push(mark.type);
      continue;
    }
    if (mark.type === 'link') {
      const href = typeof mark.attrs?.href === 'string' ? mark.attrs.href : '';
      out.push(
        appendUnknownFields(
          { type: 'link', href },
          mark.attrs?.preserved,
          LINK_MARK_FIELDS,
        ) as Mark,
      );
      continue;
    }
    if (mark.type === 'resourceMark') {
      const target = mark.attrs?.target;
      if (
        typeof target === 'object' &&
        target !== null &&
        !Array.isArray(target)
      ) {
        out.push(
          appendUnknownFields(
            {
              type: 'resource',
              target: structuredClone(target),
            },
            mark.attrs?.preserved,
            RESOURCE_MARK_FIELDS,
          ) as JsonRecord,
        );
      }
      continue;
    }
    if (mark.type === 'extMark') {
      const raw = mark.attrs?.json;
      if (typeof raw === 'string') {
        try {
          const parsed: unknown = JSON.parse(raw);
          if (
            typeof parsed === 'object' &&
            parsed !== null &&
            !Array.isArray(parsed)
          ) {
            out.push(parsed as JsonRecord);
            continue;
          }
        } catch {
          // Plain-string custom mark name.
        }
        out.push(raw);
        continue;
      }
    }
    out.push(mark.type);
  }
  return out;
}

function inlineToRuns(content: PmNode[] | undefined): Run[] {
  const runs: Run[] = [];
  const claimedMetadata = new Set<string>();
  for (const node of content ?? []) {
    if (node.type === 'emptyRun') {
      const run = node.attrs?.run;
      if (
        typeof run === 'object' &&
        run !== null &&
        !Array.isArray(run) &&
        (run as Record<string, unknown>).text === ''
      ) {
        runs.push(structuredClone(run) as unknown as Run);
      }
      continue;
    }
    if (node.type !== 'text') continue;
    const marks = pmMarksToCanonical(node.marks);
    const run = (
      marks.length > 0
        ? { text: node.text ?? '', marks }
        : { text: node.text ?? '' }
    ) as Run & Record<string, unknown>;
    const metadata = node.marks?.find((mark) => mark.type === 'runMetadata');
    const key = metadata?.attrs?.key;
    if (
      metadata !== undefined &&
      (typeof key !== 'string' || !claimedMetadata.has(key))
    ) {
      appendUnknownFields(run, metadata.attrs?.fields, RUN_FIELDS);
      if (typeof key === 'string') claimedMetadata.add(key);
    }
    runs.push(run);
  }
  return runs.length > 0 ? runs : [{ text: '' }];
}

/** Split container content into summary-run source and trailing child nodes. */
function splitSummary(content: PmNode[] | undefined): {
  runsSource: PmNode | undefined;
  rest: PmNode[];
} {
  const nodes = content ?? [];
  const index = nodes.findIndex((n) => n.type === 'paragraph');
  if (index === -1) return { runsSource: undefined, rest: nodes };
  return {
    runsSource: nodes[index],
    rest: nodes.filter((_, i) => i !== index),
  };
}

export function pmDocToModel(
  doc: PmNode,
  base?: Pick<BlockPageModel, 'formatVersion' | 'meta'> &
    Partial<Pick<BlockPageModel, 'blocks'>> &
    Record<string, unknown>,
): { model: BlockPageModel; warnings: PmStructuralWarning[] } {
  const blocks: Record<BlockId, BlockRecord> = {};
  const preservedById = new Map<BlockId, unknown>();
  const rootOrder: BlockId[] = [];
  const warnings: PmStructuralWarning[] = [];
  const warn = (warning: PmStructuralWarning): void => {
    warnings.push(warning);
  };
  const roots = new Set<BlockId>();
  const addRoot = (id: BlockId): void => {
    if (!roots.has(id)) {
      roots.add(id);
      rootOrder.push(id);
    }
  };
  let counter = 0;
  const used = new Set<BlockId>();
  const freshId = (): BlockId => {
    let candidate: string;
    do {
      counter += 1;
      candidate = `nb-${counter}`;
    } while (candidate in blocks || used.has(candidate));
    used.add(candidate);
    return candidate;
  };
  const idOf = (node: PmNode): BlockId => {
    const raw = node.attrs?.blockId;
    if (typeof raw === 'string' && raw !== '' && !used.has(raw)) {
      used.add(raw);
      preservedById.set(raw, node.attrs?.preserved);
      return raw;
    }
    const id = freshId();
    preservedById.set(id, node.attrs?.preserved);
    return id;
  };

  const addChildren = (nodes: PmNode[] | undefined): BlockId[] => {
    const ids: BlockId[] = [];
    for (const node of nodes ?? []) {
      const id = addNode(node);
      if (id !== '') ids.push(id);
    }
    return ids;
  };

  function addNode(node: PmNode): BlockId {
    switch (node.type) {
      case 'paragraph':
      case 'heading': {
        const id = idOf(node);
        const isHeading = node.type === 'heading';
        blocks[id] = {
          id,
          type: isHeading ? 'froglight.heading' : 'froglight.paragraph',
          ...(isHeading
            ? { level: (node.attrs?.level as number | undefined) ?? 1 }
            : {}),
          runs: inlineToRuns(node.content),
        };
        return id;
      }
      case 'codeBlock': {
        const id = idOf(node);
        const language = node.attrs?.language;
        blocks[id] = {
          id,
          type: 'froglight.code',
          ...(typeof language === 'string' ? { language } : {}),
          text: (node.content ?? []).map((n) => n.text ?? '').join('\n'),
        };
        return id;
      }
      case 'divider': {
        const id = idOf(node);
        blocks[id] = { id, type: 'froglight.divider' };
        return id;
      }
      case 'imageBlock': {
        const id = idOf(node);
        const alt = node.attrs?.alt;
        const caption = node.attrs?.caption;
        const name = node.attrs?.name;
        blocks[id] = {
          id,
          type: 'froglight.image',
          src: String(node.attrs?.src ?? ''),
          sha256: String(node.attrs?.sha256 ?? ''),
          ...(typeof alt === 'string' ? { alt } : {}),
          // Caption/name survive as preserved presentation fields (image
          // validation allows extras; editable caption).
          ...(typeof caption === 'string' ? { caption } : {}),
          ...(typeof name === 'string' ? { name } : {}),
        };
        return id;
      }
      case 'videoBlock':
      case 'audioBlock':
      case 'fileBlock': {
        // remote-when-present decodes to the opt-in remote locator
        // (preserved verbatim so the codec can warn REMOTE_URL_REJECTED on
        // invalid shapes); otherwise vault identity. Presentation text only
        // when strings. Universal children ride the overflow group like the
        // image atom (caller attaches via blockGroup decoding).
        const id = idOf(node);
        const coreType =
          node.type === 'videoBlock'
            ? 'froglight.video'
            : node.type === 'audioBlock'
              ? 'froglight.audio'
              : 'froglight.file';
        const remoteUrl = node.attrs?.remoteUrl;
        const name = node.attrs?.name;
        const caption = node.attrs?.caption;
        const alt = node.attrs?.alt;
        const presentation = {
          ...(typeof name === 'string' ? { name } : {}),
          ...(typeof caption === 'string' ? { caption } : {}),
          ...(typeof alt === 'string' ? { alt } : {}),
        };
        if (typeof remoteUrl === 'string' && remoteUrl !== '') {
          const pin = node.attrs?.sha256;
          blocks[id] = {
            id,
            type: coreType,
            remote: appendUnknownFields(
              { url: String(remoteUrl) },
              node.attrs?.remotePreserved,
              REMOTE_LOCATOR_FIELDS,
            ),
            ...(typeof pin === 'string' && pin !== '' ? { sha256: pin } : {}),
            ...presentation,
          };
        } else {
          blocks[id] = {
            id,
            type: coreType,
            src: String(node.attrs?.src ?? ''),
            sha256: String(node.attrs?.sha256 ?? ''),
            ...presentation,
          };
        }
        return id;
      }
      case 'mathBlock':
      case 'diagramBlock': {
        // source-only atoms decode to `{source}` and nothing else —
        // preview DOM (rendered HTML/SVG, error text) never lives in PM
        // attrs so it can never leak into canonical bytes. Non-string
        // sources ride verbatim (encode-side mirror) for codec reporting;
        // missing sources default to ''. Universal children ride the
        // overflow group (caller attaches via blockGroup decoding).
        const id = idOf(node);
        const coreType =
          node.type === 'mathBlock' ? 'froglight.math' : 'froglight.diagram';
        const raw = node.attrs?.source;
        blocks[id] = {
          id,
          type: coreType,
          source: typeof raw === 'string' ? raw : ((raw ?? '') as unknown),
        } as BlockRecord;
        return id;
      }
      case 'table': {
        // Editable grid: rows/cells/header/align decode through
        // gridToTableFields (span flatten + ragged normalize with warnings).
        // Row/cell ephemeral attrs (colwidth, per-cell align) never reach
        // canonical bytes; universal children ride the overflow group below.
        const id = idOf(node);
        const fields = gridToTableFields(node, id, warn);
        blocks[id] = {
          id,
          type: 'froglight.table',
          columnCount: fields.columnCount,
          ...(fields.align !== undefined ? { align: fields.align } : {}),
          // Normalized: `header` is present only when true (constructor
          // options semantics — an explicit `false` and an absent flag are
          // semantically identical and both decode to no header row).
          ...(fields.header ? { header: true } : {}),
          rows: fields.rows,
        } as BlockRecord;
        return id;
      }
      case 'tableRow':
      case 'tableCell':
      case 'tableHeader':
      case 'tableParagraph':
        // Grid internals never stand alone: a row/cell/paragraph outside
        // its table is corrupt chrome, decoded away (never a block).
        return '';
      case 'tableBlock': {
        // Legacy atom: stashed PM JSON still recovers
        // byte-faithful through the old passthrough.
        const id = idOf(node);
        const record = (node.attrs?.record ?? {}) as Record<string, unknown>;
        blocks[id] = { ...record, id } as BlockRecord;
        return id;
      }
      case 'compositionBlock': {
        const id = idOf(node);
        const record = structuredClone(
          (node.attrs?.record ?? {}) as Record<string, unknown>,
        );
        blocks[id] = { ...record, id } as BlockRecord;
        return id;
      }
      case 'blockquote':
      case 'toggle':
      case 'callout': {
        const id = idOf(node);
        const { runsSource, rest } = splitSummary(node.content);
        const kids = addChildren(rest);
        const coreType =
          node.type === 'blockquote'
            ? 'froglight.quote'
            : node.type === 'toggle'
              ? 'froglight.toggle'
              : 'froglight.callout';
        blocks[id] = {
          id,
          type: coreType,
          ...(node.type === 'callout' && typeof node.attrs?.icon === 'string'
            ? { icon: node.attrs.icon }
            : {}),
          ...(node.type === 'callout' && typeof node.attrs?.tone === 'string'
            ? { tone: node.attrs.tone }
            : {}),
          runs: inlineToRuns(runsSource?.content),
          ...(kids.length > 0 ? { children: kids } : {}),
        };
        return id;
      }
      case 'bulletList':
      case 'orderedList': {
        const rawListId = node.attrs?.listId;
        const id =
          typeof rawListId === 'string' &&
          rawListId !== '' &&
          !used.has(rawListId)
            ? (used.add(rawListId), rawListId)
            : freshId();
        preservedById.set(id, node.attrs?.preserved);
        const items: Array<{
          runs: Run[];
          checked?: boolean;
          children?: BlockId[];
        }> = [];
        for (const itemNode of node.content ?? []) {
          if (itemNode.type !== 'listItem') continue;
          // Only the summary and unkeyed continuation paragraphs are item
          // text. Keyed paragraphs are canonical child blocks.
          const isItemText = (n: PmNode, index: number) =>
            n.type === 'paragraph' && (index === 0 || !n.attrs?.blockId);
          const paragraphs = (itemNode.content ?? []).filter(isItemText);
          const restNodes = (itemNode.content ?? []).filter(
            (n, index) => !isItemText(n, index),
          );
          const runs = paragraphs.flatMap((p) => inlineToRuns(p.content));
          const checked = itemNode.attrs?.checked;
          const kids = addChildren(restNodes);
          items.push(
            appendUnknownFields(
              {
                runs: runs.length > 0 ? runs : [{ text: '' }],
                ...(checked === false || checked === true ? { checked } : {}),
                ...(kids.length > 0 ? { children: kids } : {}),
              },
              itemNode.attrs?.preserved,
              LIST_ITEM_FIELDS,
            ),
          );
        }
        blocks[id] = {
          id,
          type: 'froglight.list',
          ordered: node.type === 'orderedList',
          ...(node.type === 'orderedList' &&
          typeof node.attrs?.start === 'number' &&
          node.attrs.start !== 1
            ? { start: node.attrs.start }
            : {}),
          items,
        };
        return id;
      }
      case 'opaqueBlock': {
        const id = idOf(node);
        const payload = structuredClone(
          (node.attrs?.payload ?? {}) as Record<string, unknown>,
        );
        const typeId = String(node.attrs?.typeId ?? 'unknown.block');
        const kids = addChildren(node.content);
        payload.id = id;
        payload.type = typeId;
        if (kids.length > 0) payload.children = kids;
        else delete payload.children;
        blocks[id] = payload as BlockRecord;
        return id;
      }
      case 'blockGroup': {
        const kids = addChildren(node.content);
        const owner = node.attrs?.owner;
        if (typeof owner === 'string' && owner in blocks) {
          if (kids.length > 0) {
            const parent = blocks[owner] as { children?: BlockId[] };
            parent.children = [
              ...new Set([...(parent.children ?? []), ...kids]),
            ];
          }
        } else {
          for (const kid of kids) addRoot(kid);
        }
        return '';
      }
      default:
        return '';
    }
  }

  const topLevel = [...(doc.content ?? [])];
  // ProseMirror's view layer appends a trailing empty textblock for caret
  // space; it is chrome, never content (no blockId, nothing inside).
  const last = topLevel[topLevel.length - 1];
  if (
    last !== undefined &&
    last.type === 'paragraph' &&
    (last.attrs?.blockId === undefined || last.attrs?.blockId === null) &&
    (last.content === undefined || last.content.length === 0)
  ) {
    topLevel.pop();
  }
  for (const node of topLevel) {
    const id = addNode(node);
    if (id !== '') addRoot(id);
  }

  for (const [id, record] of Object.entries(blocks)) {
    blocks[id] = appendUnknownFields(
      record,
      preservedById.get(id),
      coreFieldNames(record.type),
    );
    const original = base?.blocks?.[id];
    if (original !== undefined && original.type === record.type) {
      blocks[id] = preserveUnknownCoreFields(record, original);
    }
  }

  const model = {
    ...(base ?? {}),
    formatVersion: base?.formatVersion ?? 1,
    meta: base?.meta ?? {},
    rootOrder,
    blocks,
  } as BlockPageModel;
  return { model, warnings };
}

const CORE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  'froglight.paragraph': ['runs'],
  'froglight.heading': ['level', 'runs'],
  'froglight.list': ['ordered', 'start', 'items'],
  'froglight.code': ['language', 'text'],
  'froglight.table': ['columnCount', 'align', 'header', 'rows'],
  'froglight.image': ['src', 'sha256', 'alt', 'name', 'caption'],
  'froglight.quote': ['runs'],
  'froglight.divider': [],
  'froglight.toggle': ['runs'],
  'froglight.callout': ['icon', 'tone', 'runs'],
  'froglight.resource-link': ['target', 'label'],
  'froglight.resource-embed': ['target', 'label', 'presentation'],
  'froglight.transclusion': ['target', 'label', 'presentation'],
  'froglight.linked-view': ['target', 'viewId', 'label', 'overrides'],
  'froglight.video': ['src', 'remote', 'sha256', 'name', 'caption', 'alt'],
  'froglight.audio': ['src', 'remote', 'sha256', 'name', 'caption', 'alt'],
  'froglight.file': ['src', 'remote', 'sha256', 'name', 'caption', 'alt'],
  'froglight.math': ['source'],
  'froglight.diagram': ['source'],
};

function coreFieldNames(type: string): ReadonlySet<string> {
  return new Set(['id', 'type', 'children', ...(CORE_FIELDS[type] ?? [])]);
}

function unknownCoreFields(
  record: BlockRecord,
): Record<string, unknown> | undefined {
  return unknownFields(record, coreFieldNames(record.type));
}

/** Keep provider-unknown fields while decoded canonical fields stay authoritative. */
function preserveUnknownCoreFields(
  decoded: BlockRecord,
  original: BlockRecord,
): BlockRecord {
  const fields = CORE_FIELDS[decoded.type];
  if (fields === undefined) return decoded;
  const merged = structuredClone(original);
  for (const key of ['id', 'type', 'children', ...fields]) {
    if (Object.prototype.hasOwnProperty.call(decoded, key)) {
      merged[key] = structuredClone(decoded[key]);
    } else {
      delete merged[key];
    }
  }
  return merged;
}
