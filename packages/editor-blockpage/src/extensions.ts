/**
 * Froglight block-page Tiptap node/mark extensions.
 *
 * Every mapped node carries a stable `blockId` attr so canonical ids
 * survive editing. Ephemeral UI state (collapse) rides as attrs too but
 * never reaches the canonical model (pm-map strips it).
 */

import { Node, Mark, Extension, mergeAttributes } from '@tiptap/core';
import {
  BulletList,
  OrderedList,
  ListItem as ListItemBase,
} from '@tiptap/extension-list';
import type { JSONContent } from '@tiptap/core';
import { FlbpInputRules } from './input-rules.js';
import {
  FlbpTableGrid,
  Table,
  TableCell,
  TableHeader,
  TableParagraph,
  TableRow,
} from './table-grid.js';

/** Read a record payload safely from an opaque wrapper's script tag. */
function parsePayloadFrom(el: HTMLElement): Record<string, unknown> {
  const raw = el.querySelector(
    'script[type="application/json"].flbp-opaque-payload',
  )?.textContent;
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function parsePreservedFields(
  element: HTMLElement,
): Record<string, unknown> | null {
  return parseJsonRecordAttribute(element, 'data-flbp-preserved');
}

function parseJsonRecordAttribute(
  element: HTMLElement,
  name: string,
): Record<string, unknown> | null {
  const raw = element.getAttribute(name);
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

const preservedAttribute = {
  default: null,
  // A split creates a new canonical owner. Extension metadata stays with
  // the original node instead of being duplicated onto the minted block.
  keepOnSplit: false,
  parseHTML: parsePreservedFields,
  renderHTML: (attrs: Record<string, unknown>) =>
    attrs.preserved !== null && attrs.preserved !== undefined
      ? { 'data-flbp-preserved': JSON.stringify(attrs.preserved) }
      : {},
};

export interface FlbpTableRecord {
  readonly columnCount?: number;
  readonly header?: boolean;
  readonly align?: string[];
  readonly rows?: Array<{ cells?: Array<Array<{ text?: string }>> }>;
  readonly [key: string]: unknown;
}

/**
 * Table grid nodes live in `./table-grid.js`: `table` / `tableRow` /
 * `tableCell` / `tableHeader` / `tableParagraph` replace the old
 * `tableBlock` atom. Re-exported here so the extension list below stays the
 * single wiring point.
 */
export {
  Table,
  TableRow,
  TableCell,
  TableHeader,
  TableParagraph,
  FlbpTableGrid,
} from './table-grid.js';

export const Toggle = Node.create({
  name: 'toggle',
  group: 'block',
  content: 'paragraph block*',
  defining: true,
  addAttributes() {
    return {
      blockId: { default: null },
      collapsed: {
        default: false,
        parseHTML: (el) => el.getAttribute('data-collapsed') === 'true',
        renderHTML: (attrs) =>
          attrs.collapsed ? { 'data-collapsed': 'true' } : {},
      },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-flbp-toggle]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'div',
      mergeAttributes({ 'data-flbp-toggle': '' }, HTMLAttributes, {
        'data-block-id': String(node.attrs.blockId ?? ''),
        class: node.attrs.collapsed ? 'flbp-toggle collapsed' : 'flbp-toggle',
      }),
      0,
    ];
  },
});

export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return {
      blockId: { default: null },
      icon: { default: null },
      tone: { default: null },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-flbp-callout]' }];
  },
  renderHTML({ node }) {
    return [
      'div',
      mergeAttributes(
        { 'data-flbp-callout': '', class: 'flbp-callout' },
        { 'data-block-id': String(node.attrs.blockId ?? '') },
        {
          'data-icon': String(node.attrs.icon ?? ''),
          'data-tone': String(node.attrs.tone ?? ''),
        },
      ),
      0,
    ];
  },
});

export const Divider = Node.create({
  name: 'divider',
  group: 'block',
  atom: true,
  addAttributes() {
    return { blockId: { default: null } };
  },
  parseHTML() {
    return [{ tag: 'hr[data-flbp-divider]' }];
  },
  renderHTML({ node }) {
    return [
      'hr',
      mergeAttributes(
        { 'data-flbp-divider': '' },
        { 'data-block-id': String(node.attrs.blockId ?? '') },
      ),
    ];
  },
});

export const ImageBlock = Node.create({
  name: 'imageBlock',
  group: 'block',
  atom: true,
  addAttributes() {
    return {
      blockId: { default: null },
      src: { default: '' },
      sha256: { default: '' },
      alt: { default: null },
      // Presentation text: caption/name ride alongside alt and are
      // rendered as TEXT ONLY (textContent, never HTML). Vault-only: images
      // never carry a remote locator (remote applies to
      // video/audio/file only).
      caption: { default: null },
      name: { default: null },
    };
  },
  parseHTML() {
    return [
      {
        tag: 'figure[data-flbp-image]',
        getAttrs: (el) => {
          const host = el as HTMLElement;
          return {
            blockId: host.getAttribute('data-block-id') ?? null,
            src: host.getAttribute('data-src') ?? '',
            sha256: host.getAttribute('data-sha256') ?? '',
            alt: host.getAttribute('data-alt'),
            caption: host.getAttribute('data-caption'),
            name: host.getAttribute('data-name'),
          };
        },
      },
    ];
  },
  renderHTML({ node }) {
    const alt = typeof node.attrs.alt === 'string' ? node.attrs.alt : '';
    const caption =
      typeof node.attrs.caption === 'string' ? node.attrs.caption : null;
    const name = typeof node.attrs.name === 'string' ? node.attrs.name : null;
    const label = caption ?? (alt !== '' ? alt : null);
    return [
      'figure',
      mergeAttributes(
        { 'data-flbp-image': '', class: 'flbp-image' },
        { 'data-block-id': String(node.attrs.blockId ?? '') },
        { 'data-src': String(node.attrs.src ?? '') },
        { 'data-sha256': String(node.attrs.sha256 ?? '') },
        ...(alt !== '' ? [{ 'data-alt': alt }] : []),
        ...(caption !== null ? [{ 'data-caption': caption }] : []),
        ...(name !== null ? [{ 'data-name': name }] : []),
      ),
      ['div', { class: 'flbp-image-ph' }],
      ['figcaption', label ?? ''],
    ];
  },
});

/**
 * Shared media attrs: vault identity (`src` +
 * `sha256`) plus the opt-in remote locator (`remoteUrl`, https-only,
 * validated at rest by the codec and re-validated before every fetch) plus
 * presentation text (`name`/`caption`/`alt`, text-only). The PM layer may
 * hold BOTH locators transiently for in-session fallback preview, but
 * pm-map decodes remote-when-present and DROPS the vault `src` on save —
 * opting in replaces the vault reference (destructive; re-upload restores
 * the same bytes via content-addressed dedupe, disclosed on the
 * `media.remoteUrl` control). Exactly-one locator survives in canonical.
 */
function mediaAttrs() {
  return {
    blockId: { default: null },
    src: { default: '' },
    sha256: { default: '' },
    remoteUrl: { default: null },
    remotePreserved: { default: null },
    name: { default: null },
    caption: { default: null },
    alt: { default: null },
  };
}

function mediaGetAttrs(tag: string) {
  return [
    {
      tag,
      getAttrs: (el: HTMLElement | string) => {
        if (typeof el === 'string') return null;
        const host = el as HTMLElement;
        return {
          blockId: host.getAttribute('data-block-id') ?? null,
          src: host.getAttribute('data-src') ?? '',
          sha256: host.getAttribute('data-sha256') ?? '',
          remoteUrl: host.getAttribute('data-remote-url'),
          remotePreserved: parseJsonRecordAttribute(
            host,
            'data-remote-preserved',
          ),
          name: host.getAttribute('data-name'),
          caption: host.getAttribute('data-caption'),
          alt: host.getAttribute('data-alt'),
        };
      },
    },
  ];
}

function mediaRenderHTML(kind: 'video' | 'audio' | 'file') {
  return ({ node }: { node: { attrs: Record<string, unknown> } }) => {
    const caption =
      typeof node.attrs.caption === 'string' ? node.attrs.caption : null;
    const name = typeof node.attrs.name === 'string' ? node.attrs.name : null;
    const alt = typeof node.attrs.alt === 'string' ? node.attrs.alt : '';
    const remoteUrl =
      typeof node.attrs.remoteUrl === 'string' ? node.attrs.remoteUrl : null;
    const remotePreserved =
      typeof node.attrs.remotePreserved === 'object' &&
      node.attrs.remotePreserved !== null &&
      !Array.isArray(node.attrs.remotePreserved)
        ? node.attrs.remotePreserved
        : null;
    const label = caption ?? name ?? (alt !== '' ? alt : '');
    return [
      'figure',
      mergeAttributes(
        { [`data-flbp-${kind}`]: '', class: `flbp-${kind}` },
        { 'data-block-id': String(node.attrs.blockId ?? '') },
        { 'data-src': String(node.attrs.src ?? '') },
        { 'data-sha256': String(node.attrs.sha256 ?? '') },
        ...(remoteUrl !== null && remoteUrl !== ''
          ? [{ 'data-remote-url': remoteUrl }]
          : []),
        ...(remotePreserved !== null
          ? [{ 'data-remote-preserved': JSON.stringify(remotePreserved) }]
          : []),
        ...(name !== null ? [{ 'data-name': name }] : []),
        ...(caption !== null ? [{ 'data-caption': caption }] : []),
        ...(alt !== '' ? [{ 'data-alt': alt }] : []),
      ),
      ['div', { class: `flbp-${kind}-ph` }],
      ['figcaption', label ?? ''],
    ] as const;
  };
}

/**
 * Trusted-provider media atoms (enforcement: registration stays
 * provider-side; no plugin/registry path can add a media type — sandboxed
 * code never reaches `froglightExtensions()`).
 */
export const VideoBlock = Node.create({
  name: 'videoBlock',
  group: 'block',
  atom: true,
  addAttributes() {
    return mediaAttrs();
  },
  parseHTML() {
    return mediaGetAttrs('figure[data-flbp-video]');
  },
  renderHTML: mediaRenderHTML('video'),
});

export const AudioBlock = Node.create({
  name: 'audioBlock',
  group: 'block',
  atom: true,
  addAttributes() {
    return mediaAttrs();
  },
  parseHTML() {
    return mediaGetAttrs('figure[data-flbp-audio]');
  },
  renderHTML: mediaRenderHTML('audio'),
});

export const FileBlock = Node.create({
  name: 'fileBlock',
  group: 'block',
  atom: true,
  addAttributes() {
    return mediaAttrs();
  },
  parseHTML() {
    return mediaGetAttrs('figure[data-flbp-file]');
  },
  renderHTML: mediaRenderHTML('file'),
});

/**
 * Source-only math/diagram atoms.
 *
 * Canonical content is the source text alone (`froglight.math {source
 * latex}`, `froglight.diagram {source mermaid}`); rendered output is
 * derived and never serialized. The schema therefore carries NO display
 * flags — an invented `display`/`inline` attr would break round-trip, so
 * presentation stays ephemeral in the preview host (`math-diagram-view.ts`).
 * Math always renders display-mode; diagrams render their SVG flow.
 *
 * `renderHTML` emits a static skeleton only (`figure[data-flbp-*]` +
 * `data-source` + empty preview/source slots). Live previews hydrate
 * imperatively after each transaction (the `media-view.ts` pattern):
 * source text is set via `textContent`, rendered output is sanitized
 * before insertion — no raw HTML from block content ever reaches the DOM.
 */
function sourceBlockAttrs() {
  return {
    blockId: { default: null },
    source: { default: '' },
  };
}

function sourceBlockGetAttrs(tag: string) {
  return [
    {
      tag,
      getAttrs: (el: HTMLElement | string) => {
        if (typeof el === 'string') return null;
        const host = el as HTMLElement;
        return {
          blockId: host.getAttribute('data-block-id') ?? null,
          source: host.getAttribute('data-source') ?? '',
        };
      },
    },
  ];
}

function sourceBlockRenderHTML(kind: 'math' | 'diagram') {
  return ({ node }: { node: { attrs: Record<string, unknown> } }) => {
    const source =
      typeof node.attrs.source === 'string' ? node.attrs.source : '';
    return [
      'figure',
      mergeAttributes(
        { [`data-flbp-${kind}`]: '', class: `flbp-${kind}` },
        { 'data-block-id': String(node.attrs.blockId ?? '') },
        { 'data-source': source },
      ),
      ['div', { class: 'flbp-md-preview flbp-md-sandbox' }],
      ['div', { class: 'flbp-md-src' }],
    ] as const;
  };
}

export const MathBlock = Node.create({
  name: 'mathBlock',
  group: 'block',
  atom: true,
  addAttributes() {
    return sourceBlockAttrs();
  },
  parseHTML() {
    return sourceBlockGetAttrs('figure[data-flbp-math]');
  },
  renderHTML: sourceBlockRenderHTML('math'),
});

export const DiagramBlock = Node.create({
  name: 'diagramBlock',
  group: 'block',
  atom: true,
  addAttributes() {
    return sourceBlockAttrs();
  },
  parseHTML() {
    return sourceBlockGetAttrs('figure[data-flbp-diagram]');
  },
  renderHTML: sourceBlockRenderHTML('diagram'),
});

/**
 * Legacy `tableBlock` atom: superseded by the editable grid in
 * `./table-grid.js`. The export remains so already-rendered documents and
 * the table-block spec's parse-rule probe keep resolving; it is NO LONGER
 * wired into `froglightExtensions()` and pm-map no longer encodes it.
 */
export const TableBlock = Node.create({
  name: 'tableBlock',
  group: 'block',
  atom: true,
  addAttributes() {
    return {
      blockId: { default: null },
      record: { default: {} },
    };
  },
  parseHTML() {
    return [
      {
        tag: 'table[data-flbp-table]',
        getAttrs: (el) => {
          const host = el as HTMLElement;
          let record: Record<string, unknown> = {};
          try {
            const parsed: unknown = JSON.parse(
              host.getAttribute('data-record') ?? '{}',
            );
            if (
              typeof parsed === 'object' &&
              parsed !== null &&
              !Array.isArray(parsed)
            )
              record = parsed as Record<string, unknown>;
          } catch {
            record = {};
          }
          return {
            blockId: host.getAttribute('data-block-id') ?? null,
            record,
          };
        },
      },
    ];
  },
  renderHTML({ node }) {
    const record = (node.attrs.record ?? {}) as FlbpTableRecord;
    // Header/align preservation policy: header/align ride
    // verbatim in the canonical record and round-trip byte-faithful through
    // pm-map + getAttrs. The renderer deliberately does not interpret them
    // into <th>/alignment styling — it emits plain <tbody> rows — so policy
    // is preserve, never reinterpret.
    const columns = sanitizeColumnCount(record.columnCount);
    const rows = record.rows ?? [];
    const body = rows.map((row) => {
      const cells = row.cells ?? [];
      const width = Math.max(columns, cells.length);
      const tds: Array<['td', Record<string, never>, string]> = [];
      for (let i = 0; i < width; i += 1) {
        tds.push([
          'td',
          {},
          cells[i]?.map((run) => run?.text ?? '').join('') ?? '',
        ]);
      }
      return ['tr', {}, ...tds] as unknown as ReturnType<
        typeof mergeAttributes
      >;
    });
    return [
      'table',
      mergeAttributes(
        { 'data-flbp-table': '', class: 'flbp-table' },
        { 'data-block-id': String(node.attrs.blockId ?? '') },
        { 'data-record': JSON.stringify(record) },
      ),
      ['tbody', ...body],
    ];
  },
});

/**
 * Clamp a table column count to a finite integer >= 1.
 * Non-finite counts (NaN/Infinity from corrupt payloads) previously flowed
 * into `Math.max`/loop bounds — NaN rendered zero cells, Infinity hung the
 * renderer in an unbounded loop — so corrupt records could blank or freeze
 * the page. Now they degrade to a single column.
 */
function sanitizeColumnCount(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw ?? 1);
  if (!Number.isFinite(n)) return 1;
  return Math.max(1, Math.floor(n));
}

export const OpaqueBlock = Node.create({
  name: 'opaqueBlock',
  group: 'block',
  content: 'block*',
  defining: true,
  addAttributes() {
    return {
      blockId: { default: null },
      typeId: { default: 'unknown.block' },
      payload: { default: {} },
    };
  },
  parseHTML() {
    return [
      {
        tag: 'div[data-flbp-opaque]',
        getAttrs: (el) => {
          const host = el as HTMLElement;
          return {
            typeId: host.getAttribute('data-type-id') ?? 'unknown.block',
            payload: parsePayloadFrom(host),
          };
        },
      },
    ];
  },
  renderHTML({ node }) {
    return [
      'div',
      mergeAttributes(
        { 'data-flbp-opaque': '', class: 'flbp-opaque' },
        { 'data-block-id': String(node.attrs.blockId ?? '') },
        { 'data-type-id': String(node.attrs.typeId ?? '') },
      ),
      ['span', { class: 'flbp-chip' }, String(node.attrs.typeId ?? '')],
      [
        'script',
        { type: 'application/json', class: 'flbp-opaque-payload' },
        JSON.stringify(node.attrs.payload ?? {}),
      ],
      ['div', { class: 'flbp-opaque-body' }, 0],
    ];
  },
});

export const BlockGroup = Node.create({
  name: 'blockGroup',
  group: 'block',
  content: 'block*',
  defining: true,
  addAttributes() {
    return {
      owner: { default: null },
    };
  },
  parseHTML() {
    return [{ tag: 'div[data-flbp-group]' }];
  },
  renderHTML({ node, HTMLAttributes }) {
    return [
      'div',
      mergeAttributes({ 'data-flbp-group': '' }, HTMLAttributes, {
        'data-owner': String(node.attrs.owner ?? ''),
        class: 'flbp-group',
      }),
      0,
    ];
  },
});

/** Carrier for unknown canonical marks; inert styling, byte-faithful payload. */
export const ExtMark = Mark.create({
  name: 'extMark',
  inclusive: false,
  addAttributes() {
    return {
      name: { default: '' },
      json: { default: '' },
    };
  },
  parseHTML() {
    return [{ tag: 'span[data-ext-mark]' }];
  },
  renderHTML({ mark }) {
    return [
      'span',
      {
        'data-ext-mark': String(mark.attrs.json ?? ''),
        title: String(mark.attrs.name ?? ''),
      },
      0,
    ];
  },
});

/** Unknown members belonging to one canonical text run. */
export const RunMetadata = Mark.create({
  name: 'runMetadata',
  inclusive: false,
  addAttributes() {
    return {
      key: { default: '' },
      fields: { default: {} },
    };
  },
  parseHTML() {
    return [
      {
        tag: 'span[data-flbp-run-metadata]',
        getAttrs: (element) => {
          const host = element as HTMLElement;
          return {
            key: host.getAttribute('data-flbp-run-key') ?? '',
            fields: parsePreservedFields(host) ?? {},
          };
        },
      },
    ];
  },
  renderHTML({ mark }) {
    return [
      'span',
      {
        'data-flbp-run-metadata': '',
        'data-flbp-run-key': String(mark.attrs.key ?? ''),
        'data-flbp-preserved': JSON.stringify(mark.attrs.fields ?? {}),
      },
      0,
    ];
  },
});

/**
 * Empty canonical runs cannot be represented by a ProseMirror text node.
 * This zero-content inline owner keeps the complete run in editor state so
 * marks and extension members participate in moves, history, and deletion.
 */
export const EmptyRun = Node.create({
  name: 'emptyRun',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: false,
  addAttributes() {
    return { run: { default: { text: '' } } };
  },
  parseHTML() {
    return [
      {
        tag: 'span[data-flbp-empty-run]',
        getAttrs: (element) => {
          try {
            const parsed: unknown = JSON.parse(
              element.getAttribute('data-flbp-empty-run') ?? '{}',
            );
            return {
              run:
                typeof parsed === 'object' &&
                parsed !== null &&
                !Array.isArray(parsed) &&
                (parsed as Record<string, unknown>).text === ''
                  ? parsed
                  : { text: '' },
            };
          } catch {
            return { run: { text: '' } };
          }
        },
      },
    ];
  },
  renderHTML({ node }) {
    return [
      'span',
      {
        'data-flbp-empty-run': JSON.stringify(node.attrs.run ?? { text: '' }),
        'aria-hidden': 'true',
      },
    ];
  },
});

/** Stable internal resource mark; target JSON is plain canonical data. */
export const ResourceMark = Mark.create({
  name: 'resourceMark',
  inclusive: false,
  addAttributes() {
    return { target: { default: null } };
  },
  parseHTML() {
    return [
      {
        tag: 'span[data-flbp-resource]',
        getAttrs: (element) => {
          try {
            return {
              target: JSON.parse(element.getAttribute('data-target') ?? '{}'),
            };
          } catch {
            return { target: {} };
          }
        },
      },
    ];
  },
  renderHTML({ mark, HTMLAttributes }) {
    return [
      'span',
      mergeAttributes(HTMLAttributes, {
        'data-flbp-resource': '',
        'data-target': JSON.stringify(mark.attrs.target ?? {}),
        class: 'flbp-resource-mark',
      }),
      0,
    ];
  },
});

/** Atomic canonical composition record; provider output mounts after visibility. */
export const CompositionBlock = Node.create({
  name: 'compositionBlock',
  group: 'block',
  atom: true,
  selectable: true,
  addAttributes() {
    return { blockId: { default: null }, record: { default: {} } };
  },
  parseHTML() {
    return [{ tag: 'div[data-flbp-composition]' }];
  },
  renderHTML({ node }) {
    const record = node.attrs.record as Record<string, unknown>;
    const label =
      typeof record.label === 'string'
        ? record.label
        : String(record.type ?? 'Resource');
    return [
      'div',
      {
        'data-flbp-composition': '',
        'data-block-id': String(node.attrs.blockId ?? ''),
        'data-record': JSON.stringify(record),
        class: 'flbp-composition',
        tabindex: '0',
      },
      ['span', { class: 'flbp-composition-label' }, label],
    ];
  },
});

/**
 * Registers `blockId`/`listId`/`owner` identity attrs on the StarterKit-owned
 * core nodes so stable canonical ids survive parsing and serialization.
 */
const CoreIdentity = Extension.create({
  name: 'flbpCoreIdentity',
  addGlobalAttributes() {
    return [
      {
        types: ['paragraph', 'heading', 'codeBlock', 'blockquote'],
        attributes: {
          blockId: {
            default: null,
            parseHTML: (element) => element.getAttribute('data-block-id'),
            renderHTML: (attrs) =>
              attrs.blockId ? { 'data-block-id': String(attrs.blockId) } : {},
          },
        },
      },
      {
        types: ['bulletList', 'orderedList'],
        attributes: {
          listId: {
            default: null,
            parseHTML: (element) => element.getAttribute('data-list-id'),
            renderHTML: (attrs) =>
              attrs.listId ? { 'data-list-id': String(attrs.listId) } : {},
          },
        },
      },
    ];
  },
});

/**
 * Unknown canonical members ride with their owning PM nodes and therefore
 * participate in transforms, deletion, undo, and redo.
 */
const CorePreservation = Extension.create({
  name: 'flbpCorePreservation',
  addGlobalAttributes() {
    return [
      {
        types: [
          'paragraph',
          'heading',
          'codeBlock',
          'blockquote',
          'bulletList',
          'orderedList',
          'listItem',
          'toggle',
          'callout',
          'divider',
          'imageBlock',
          'videoBlock',
          'audioBlock',
          'fileBlock',
          'mathBlock',
          'diagramBlock',
          'table',
          'tableRow',
          'link',
          'resourceMark',
        ],
        attributes: { preserved: preservedAttribute },
      },
    ];
  },
});

/**
 * The list extensions come from `@tiptap/extension-list` (StarterKit's own
 * copies are disabled) so `listItem` registers exactly once. Extending —
 * not shadowing — keeps a single schema entry while carrying the to-do
 * `checked` attribute.
 */
export const TodoListItem = ListItemBase.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      checked: {
        default: null,
        parseHTML: (element) => {
          const raw = element.getAttribute('data-checked');
          return raw === 'true' ? true : raw === 'false' ? false : null;
        },
        renderHTML: (attrs) =>
          attrs.checked === true || attrs.checked === false
            ? { 'data-checked': String(attrs.checked) }
            : {},
      },
    };
  },
});

export function froglightExtensions() {
  return [
    Toggle,
    Callout,
    Divider,
    ImageBlock,
    VideoBlock,
    AudioBlock,
    FileBlock,
    // Source-only math/diagram atoms: LaTeX + Mermaid source with
    // lazy safe preview; rendered output never reaches canonical bytes.
    MathBlock,
    DiagramBlock,
    // Editable table grid: table/tableRow/tableCell/tableHeader/
    // tableParagraph + grid keymap replace the legacy tableBlock atom.
    Table,
    TableRow,
    TableCell,
    TableHeader,
    TableParagraph,
    FlbpTableGrid,
    OpaqueBlock,
    BlockGroup,
    ExtMark,
    RunMetadata,
    EmptyRun,
    ResourceMark,
    CompositionBlock,
    CoreIdentity,
    CorePreservation,
    BulletList,
    OrderedList,
    TodoListItem,
    // Centralized markdown input rules: priority-ordered
    // ahead of the StarterKit / extension-list rule plugins, so our
    // id-preserving single-undo adapters shadow the overlapping built-ins.
    FlbpInputRules,
  ];
}

/** Type helper for building JSON content without importing runtime types widely. */
export type { JSONContent };
