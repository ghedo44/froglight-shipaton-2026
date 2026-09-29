/**
 * Real Tiptap/ProseMirror block-page editor provider.
 *
 * The Notion-style interaction checklist lives entirely here, behind the
 * document editor registry seam: canonical plain-data models cross
 * the boundary via `onDirtyModel`; ProseMirror types never do.
 */

import { Editor, Extension } from '@tiptap/core';
import {
  DOMParser as PMDOMParser,
  Node as PMNode,
  Fragment,
  Slice,
  type Mark,
  type MarkType,
} from '@tiptap/pm/model';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import {
  AllSelection,
  NodeSelection,
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from '@tiptap/pm/state';
import { closeHistory } from '@tiptap/pm/history';
import { StarterKit } from '@tiptap/starter-kit';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';

import { BlockDragController, blockDragSource, blockDropTransaction } from './block-drag.js';
import { itemToBlocks, splitListAt } from './list-structure.js';
import { blockAtPointerHeight } from './block-hover.js';
import { enterToggleSummary } from './toggle-interaction.js';
import { froglightExtensions } from './extensions.js';
import {
  modelToPmDoc,
  pmDocToModel,
  unseenTableWarningMessages,
  type PmStructuralWarning,
} from './pm-map.js';
import {
  TABLE_OP_IDS,
  TABLE_SIZE_PRESETS,
  buildTableNode,
  caretTableGeometry,
  inTableGrid,
  runTableMoveToCommand,
  runTableOpCommand,
  selectTableCellForAction,
  type TableOpId,
} from './table-grid.js';
import { cloneModel, newBlockId } from './model-edit.js';
import {
  htmlToPasteLines,
  preStripPayloadTags,
  splitPasteLines,
} from './paste-sanitize.js';
import {
  InMemoryBlockRegistry,
  isResourceTarget,
  writingFormatToggleControl,
  writingLinkControl,
  type BlockPageEditorHandle,
  type BlockPageEditorInput,
  type BlockPageModel,
  type DocumentAssetStore,
  type BlockRegistry,
  type DocumentEditorTools,
  LazyCompositionController,
  type CompositionRequest,
  type CompositionPresentationHandle,
  type CompositionSnapshot,
  type ResourceTarget,
  type ResourceSuggestion,
} from '@froglight/foundation';
import {
  MAX_MEDIA_BYTES,
  asCommittedUploadLocator,
  isFetchableRemoteUrl,
  mediaSourceToBytes,
  prepareMediaBytes,
} from './media-security.js';
import {
  MEDIA_PICK_EVENT,
  MEDIA_PICKED_EVENT,
  revokeMediaBlobUrls,
  syncMediaViews,
  type BlockPageMediaEditorInput,
  type FetchFn,
} from './media-view.js';
import {
  MAX_MATH_DIAGRAM_SOURCE_BYTES,
  cancelMathDiagramRenders,
  closeMathDiagramOverlay,
  isMathDiagramOverlayOpen,
  markMathDiagramVisible,
  openMathDiagramOverlay,
  syncMathDiagramViews,
  type MathDiagramOverlayHandle,
} from './math-diagram-view.js';
import {
  BlockpageHostSkeleton,
  type BlockpageSkeleton,
} from './react/BlockpageHostSkeleton.jsx';
import { positionBlockpageOverlay } from './overlay-geometry.js';
import { SLASH_GROUPS, slashPresentation } from './slash-presentation.js';

function sideControlIcon(kind: 'add' | 'grip' | 'chevron'): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('aria-hidden', 'true');
  if (kind === 'grip') {
    for (const x of [8, 16]) for (const y of [5.5, 12, 18.5]) {
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
      dot.setAttribute('cx', String(x));
      dot.setAttribute('cy', String(y));
      dot.setAttribute('r', '1.6');
      dot.setAttribute('fill', 'currentColor');
      svg.appendChild(dot);
    }
  } else {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', kind === 'add' ? 'M12 3v18M3 12h18' : 'M7 5 L18 12 L7 19 Z');
    path.setAttribute('stroke', kind === 'chevron' ? 'none' : 'currentColor');
    if (kind === 'chevron') path.setAttribute('fill', 'currentColor');
    path.setAttribute('stroke-width', kind === 'chevron' ? '2.3' : '1.8');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
  }
  return svg;
}

/**
 * Native arrow-key selection movement is reflected in the DOM before the
 * browser's asynchronous `selectionchange` reaches ProseMirror. If Enter
 * follows Ctrl/Cmd+A → ArrowRight in that window, the visible caret is
 * collapsed but editor state still holds an AllSelection, so the default
 * Enter keymap consumes the key without splitting. Reconcile only that
 * narrow mismatch; ordinary text/node selections and IME input stay on
 * ProseMirror's normal path.
 */
function reconcileCollapsedDomCaret(view: EditorView): void {
  if (!(view.state.selection instanceof AllSelection)) return;
  const selection = view.dom.ownerDocument.getSelection();
  if (
    selection === null ||
    !selection.isCollapsed ||
    selection.anchorNode === null ||
    selection.focusNode === null ||
    !view.dom.contains(selection.anchorNode) ||
    !view.dom.contains(selection.focusNode)
  )
    return;
  let position: number;
  try {
    position = view.posAtDOM(selection.anchorNode, selection.anchorOffset);
  } catch {
    // Detached/stale DOM selections are left to ProseMirror's normal sync.
    return;
  }
  const caret = TextSelection.near(view.state.doc.resolve(position));
  view.dispatch(
    view.state.tr.setSelection(caret).setMeta('addToHistory', false),
  );
}

/**
 * Text-editable block containers where inline marks/links are meaningful.
 * Code blocks are textblocks but suppress inline formatting by provider
 * semantics; atom/special nodes (divider, image, composition, opaque,
 * groups) never do. Table grid cells edit through `tableParagraph` (listed
 * here so cell marks keep working); the grid structure itself (`table`,
 * `tableRow`, `tableCell`, `tableHeader`) never takes inline controls.
 * UI contains no node-name checks — the provider omits controls here.
 */
const INLINE_EDITABLE_BLOCKS = new Set([
  'paragraph',
  'heading',
  'blockquote',
  'toggle',
  'callout',
  'bulletList',
  'orderedList',
  'listItem',
  'tableParagraph',
]);

/**
 * Turn-into allow-list is derived from the single catalog source;
 * `turnIntoValuesFor` below builds it from
 * `turnIntoCatalogItems` + `turnIntoValueFor`, so validation, snapshot
 * options, and handle-menu entries can never fork into a static mirror.
 * No hardcoded TURN_INTO_VALUES set remains.
 */

/**
 * Destination validity for link submission, shared with the Markdown
 * provider contract: empty input must never mutate source; destinations
 * containing whitespace would parse as surprising syntax, so the provider
 * rejects them without changes.
 */
function isValidBlockLinkDestination(value: string): boolean {
  const trimmed = value.trim();
  return trimmed !== '' && !/\s/.test(trimmed);
}

/** Minimal mark view for extMark link detection (provider-owned). */
interface ExtMarkView {
  readonly type: { readonly name: string };
  readonly attrs: Record<string, unknown>;
}
// Provider chrome styles live in the colocated stylesheets imported by
// react/BlockpageHostSkeleton.tsx (BlockpageHost.module.css for the
// Froglight-owned host, styles/prose-mirror.css for ProseMirror-owned DOM).
// The engine never injects styles at runtime.

/**
 * One slash-catalog row (single entry source). The builder below
 * feeds `#slashEntries` now; reuses it for turn-into/handle menus.
 * `keywords` stays a single space-delimited string (registry contract);
 * normalization (lowercase, split on whitespace, typeId always matched)
 * happens once in `filterSlashCatalog`, never per call site.
 *
 * NOTE: `label` here is catalog presentation (from
 * `BlockTypeDescriptor.label`, hints). Never confuse it with
 * `BlockRecord.label` (per-instance composition label in model.ts).
 */
interface SlashCatalogItem {
  readonly id: string;
  readonly label: string;
  readonly keywords: string;
  readonly hint?: string;
  /** Set for registry opaque rows; core rows leave it absent. */
  readonly typeId?: string;
  readonly action:
    | {
        readonly kind: 'turn-into';
        readonly type: string;
        readonly level?: number;
      }
    | { readonly kind: 'toggle-bullet' }
    | { readonly kind: 'toggle-ordered' }
    | { readonly kind: 'todo' }
    | { readonly kind: 'insert'; readonly insertType: string }
    | {
        readonly kind: 'resource-picker';
        readonly resourceType: ResourceBlockType;
      }
    | { readonly kind: 'opaque'; readonly opaqueTypeId: string };
}

type HandleMenuEntry =
  | SlashCatalogItem
  | {
      readonly label: string;
      readonly action:
        | { readonly kind: 'move-relative'; readonly direction: -1 | 1 }
        | { readonly kind: 'delete-block' | 'show-transforms' | 'back' };
    };

/**
 * Display label for a registry descriptor (fallback contract):
 * `label?.trim() || shortLabel?.trim() || typeId`, so a falsy/blank hint
 * never blanks the menu.
 */
function slashLabelFor(descriptor: {
  readonly label?: string;
  readonly shortLabel?: string;
  readonly typeId: string;
}): string {
  const label = descriptor.label?.trim();
  if (label !== undefined && label !== '') return label;
  const short = descriptor.shortLabel?.trim();
  if (short !== undefined && short !== '') return short;
  return descriptor.typeId;
}

/**
 * THE keyword normalization: lowercase, split on whitespace, drop empties.
 * Single definition shared by every catalog row (core + registry).
 */
function normalizeSlashKeywords(keywords?: string): string[] {
  if (keywords === undefined) return [];
  return keywords
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token !== '');
}

/**
 * Combined haystack for one row: label + keyword tokens + hint + typeId
 * (always, even when keywords are absent). Lowercased once so the filter
 * stays case-insensitive without per-field branches.
 */
function slashHaystack(item: {
  readonly label: string;
  readonly keywords: string;
  readonly hint?: string;
  readonly typeId?: string;
}): string {
  return [
    item.label,
    ...normalizeSlashKeywords(item.keywords),
    item.hint ?? '',
    item.typeId ?? '',
  ]
    .join(' ')
    .toLowerCase();
}

/**
 * Single catalog builder: every insertable core row (Paragraph,
 * Bullet, Numbered, Todo, Quote, Toggle, Callout, Code, Divider,
 * Image, Table, the resource 4-pack via the existing picker path) plus one
 * opaque insert row per trusted-registry descriptor with human labels from
 * hints. Unfiltered and stably ordered; filtering lives in
 * `filterSlashCatalog` so later consumers share both.
 */
function buildSlashCatalog(registry: BlockRegistry): SlashCatalogItem[] {
  const core: SlashCatalogItem[] = [
    {
      id: 'core:paragraph',
      label: 'Paragraph',
      keywords: 'text plain body',
      action: { kind: 'turn-into', type: 'paragraph' },
    },
    ...[1, 2, 3, 4, 5, 6].map((level) => ({
      id: `core:heading-${level}`,
      label: `Heading ${level}`,
      keywords: `h${level} title section`,
      action: { kind: 'turn-into', type: 'heading', level } as const,
    })),
    {
      id: 'core:bullet',
      label: 'Bullet list',
      keywords: 'unordered ul list',
      action: { kind: 'toggle-bullet' } as const,
    },
    {
      id: 'core:numbered',
      label: 'Numbered list',
      keywords: 'ordered ol list',
      action: { kind: 'toggle-ordered' } as const,
    },
    {
      id: 'core:quote',
      label: 'Quote',
      keywords: 'blockquote citation',
      action: { kind: 'turn-into', type: 'quote' } as const,
    },
    {
      id: 'core:todo',
      label: 'To-do item',
      keywords: 'task checkbox todo check',
      action: { kind: 'todo' } as const,
    },
    {
      id: 'core:toggle',
      label: 'Toggle',
      keywords: 'collapse details fold',
      action: { kind: 'turn-into', type: 'toggle' } as const,
    },
    {
      id: 'core:callout',
      label: 'Callout',
      keywords: 'note info warning banner',
      action: { kind: 'turn-into', type: 'callout' } as const,
    },
    {
      id: 'core:code',
      label: 'Code block',
      keywords: 'snippet pre fenced',
      action: { kind: 'turn-into', type: 'code' } as const,
    },
    {
      id: 'core:divider',
      label: 'Divider',
      keywords: 'hr rule separator ---',
      action: { kind: 'insert', insertType: 'divider' } as const,
    },
    {
      id: 'core:image',
      label: 'Image',
      keywords: 'picture figure photo',
      action: { kind: 'insert', insertType: 'image' } as const,
    },
    {
      id: 'core:video',
      label: 'Video',
      keywords: 'video movie clip mp4',
      action: { kind: 'insert', insertType: 'video' } as const,
    },
    {
      id: 'core:audio',
      label: 'Audio',
      keywords: 'audio sound music mp3',
      action: { kind: 'insert', insertType: 'audio' } as const,
    },
    {
      id: 'core:file',
      label: 'File',
      keywords: 'file attachment document pdf',
      action: { kind: 'insert', insertType: 'file' } as const,
    },
    {
      id: 'core:table',
      label: 'Table',
      keywords: 'grid rows cells',
      action: { kind: 'insert', insertType: 'table' } as const,
    },
    {
      id: 'core:math',
      label: 'Math',
      keywords: 'latex equation formula katex $$',
      action: { kind: 'insert', insertType: 'math' } as const,
    },
    {
      id: 'core:diagram',
      label: 'Diagram',
      keywords: 'mermaid flowchart graph sequence gantt',
      action: { kind: 'insert', insertType: 'diagram' } as const,
    },
    ...(
      [
        ['Resource link', 'resource-link', 'note mention card'],
        ['Resource embed', 'resource-embed', 'preview embed'],
        ['Transclusion', 'transclusion', 'section block include'],
        ['Linked view', 'linked-view', 'database view'],
      ] as const
    ).map(([label, resourceType, keywords]) => ({
      id: `core:${resourceType}`,
      label,
      keywords,
      action: { kind: 'resource-picker', resourceType } as const,
    })),
  ];
  // Trusted-tier registry only: each descriptor becomes an
  // opaque insert row labeled from its hints. Empty registry ⇒ core only.
  const opaques: SlashCatalogItem[] = registry.list().map((descriptor) => ({
    id: `opaque:${descriptor.typeId}`,
    label: slashLabelFor(descriptor),
    keywords: descriptor.keywords ?? '',
    ...(descriptor.hint !== undefined ? { hint: descriptor.hint } : {}),
    typeId: descriptor.typeId,
    action: { kind: 'opaque', opaqueTypeId: descriptor.typeId } as const,
  }));
  return [...core, ...opaques];
}

/** Shared filter: empty query returns the full catalog; else haystack substring. */
function filterSlashCatalog(
  items: readonly SlashCatalogItem[],
  query: string,
): SlashCatalogItem[] {
  const needle = query.toLowerCase();
  if (needle === '') return [...items];
  return items.filter((item) => slashHaystack(item).includes(needle));
}

/**
 * Turn-into-compatible catalog subset: slash rows whose action converts
 * the current block instead of inserting a new one: paragraph, bullet,
 * numbered list, to-do, quote, toggle, callout, and code.
 * Insert/resource/opaque rows never appear here. Order follows the catalog
 * (stable slash ordering); labels are the slash labels verbatim so toolbar
 * and handle menus converge instead of forking a second inventory
 *
 */
function turnIntoCatalogItems(registry: BlockRegistry): SlashCatalogItem[] {
  return buildSlashCatalog(registry).filter(
    (item) =>
      item.action.kind === 'turn-into' ||
      item.action.kind === 'toggle-bullet' ||
      item.action.kind === 'toggle-ordered' ||
      item.action.kind === 'todo',
  );
}

/**
 * Durable toolbar value for one turn-into catalog row. Headings keep the
 * existing `heading:N` shape (round-trip); list rows map to the
 * compact `bullet`/`ordered`/`todo` values; the rest use their turn-into
 * type verbatim. Insert/resource/opaque rows are not turn-into rows and map
 * to null (callers filter through `turnIntoCatalogItems` first, so null is
 * unreachable there — never silently default them to `todo`).
 */
function turnIntoValueFor(item: SlashCatalogItem): string | null {
  const action = item.action;
  if (action.kind === 'turn-into') {
    return action.level !== undefined
      ? `${action.type}:${action.level}`
      : action.type;
  }
  if (action.kind === 'toggle-bullet') return 'bullet';
  if (action.kind === 'toggle-ordered') return 'ordered';
  if (action.kind === 'todo') return 'todo';
  return null;
}

/**
 * Registry-aware turn-into allow-list: the exact value set the
 * toolbar snapshot offers, derived from the same catalog subset — never a
 * hardcoded mirror. Opaque/resource/insert rows map to null and never enter
 * the set, so empty and opaque-seeded registries derive identically.
 */
function turnIntoValuesFor(registry: BlockRegistry): Set<string> {
  const values = new Set<string>();
  for (const item of turnIntoCatalogItems(registry)) {
    const value = turnIntoValueFor(item);
    if (value !== null) values.add(value);
  }
  return values;
}

/**
 * Inline trigger range for one slash commit: "/" + the typed query
 * immediately before the caret. Every fused commit deletes this range inside
 * the same transaction as its effect, and no commit path deletes
 * it before its outcome is decided.
 */
interface SlashTrigger {
  readonly start: number;
  readonly end: number;
}

interface BlockHit {
  node: PMNode;
  pos: number;
  parent: PMNode;
}

interface ResourceChoice {
  readonly target: ResourceTarget;
  readonly label: string;
  readonly viewId?: string;
}
type ResourceBlockType =
  | 'resource-link'
  | 'resource-embed'
  | 'transclusion'
  | 'linked-view';

type MarkdownMarkState = { readonly active: boolean; readonly mixed: boolean };

/**
 * Raw selection facts from exactly one document traversal. `#analyzeSelection`
 * derives every capability from one instance — no consumer re-walks the
 * document unless editor state has changed.
 */
interface SelectionFacts {
  readonly empty: boolean;
  readonly touchedBlocks: Array<{
    readonly name: string;
    readonly attrs: Record<string, unknown>;
  }>;
  readonly keyedRoots: Array<{
    readonly name: string;
    readonly attrs: Record<string, unknown>;
  }>;
  readonly current: {
    readonly name: string;
    readonly attrs: Record<string, unknown>;
  } | null;
  /** Mark sets of every text node in range (range selections only). */
  readonly textMarks: Array<readonly Mark[]>;
  /** Caret marks (collapsed selections only): stored marks or $from marks. */
  readonly caretMarks: readonly Mark[];
  /** Caret `isActive` per mark name (collapsed selections only). */
  readonly caretActive: Readonly<Record<string, boolean>>;
  /** Caret `isActive('link')` for the current selection. */
  readonly linkActive: boolean;
  /** Caret link href from `getAttributes('link')` when active. */
  readonly linkHref?: string;
  readonly markTypes: Readonly<Record<string, MarkType | undefined>>;
}

interface SelectionAnalysis {
  readonly touchedBlocks: ReadonlyArray<{
    readonly name: string;
    readonly attrs: Record<string, unknown>;
  }>;
  readonly keyedRoots: ReadonlyArray<{
    readonly name: string;
    readonly attrs: Record<string, unknown>;
  }>;
  readonly blockType:
    | { readonly kind: 'single'; readonly value: string }
    | { readonly kind: 'mixed' }
    | { readonly kind: 'unsupported' };
  readonly context: string;
  readonly inlineFormatting: boolean;
  readonly marks: {
    readonly bold: MarkdownMarkState;
    readonly italic: MarkdownMarkState;
    readonly strike: MarkdownMarkState;
    readonly code: MarkdownMarkState;
  };
  readonly link: {
    readonly applicable: boolean;
    readonly href?: string;
    readonly active: boolean;
  };
  readonly turnInto: boolean;
  readonly nodeName: string;
  readonly markApplicable: boolean;
}

/**
 * Duck-typed uploadable file: a File/Blob-like carrying
 * `arrayBuffer()` (the `uploadMedia` source contract) with optional
 * `name`/`size` metadata. Never `instanceof File/Blob`: jsdom and
 * cross-realm drag payloads fail realm checks while still satisfying the
 * structural contract (the `mediaSourceToBytes` duck-typing precedent).
 */
interface UploadableFileLike {
  arrayBuffer(): Promise<ArrayBuffer>;
  readonly name?: unknown;
  // `size` passes through structurally: real File/Blob sizes are numbers,
  // and `mediaSourceToBytes` re-checks `typeof size === 'number'` before
  // trusting it (a lying size only fails the pre-check early), so the
  // guard below validates `arrayBuffer` alone.
  readonly size?: number;
}

function isUploadableFileLike(value: unknown): value is UploadableFileLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { arrayBuffer?: unknown }).arrayBuffer === 'function'
  );
}

/**
 * Collect File/Blob entries from a clipboard or drop payload;
 * `files` first, then `items` (`getAsFile()` kinds) — both
 * standard platform shapes, both duck-typed. Anything else (text, HTML,
 * URIs, the internal block MIME) yields no entries and keeps its existing
 * handling.
 */
function collectUploadableFiles(
  payload:
    | { readonly files?: unknown; readonly items?: unknown }
    | null
    | undefined,
): UploadableFileLike[] {
  if (payload === null || payload === undefined) return [];
  const out: UploadableFileLike[] = [];
  const files = payload.files as ArrayLike<unknown> | null | undefined;
  if (
    files !== null &&
    files !== undefined &&
    typeof files.length === 'number'
  ) {
    for (let index = 0; index < files.length; index += 1) {
      const entry = files[index];
      if (isUploadableFileLike(entry)) out.push(entry);
    }
    if (out.length > 0) return out;
  }
  const items = payload.items as ArrayLike<unknown> | null | undefined;
  if (
    items !== null &&
    items !== undefined &&
    typeof items.length === 'number'
  ) {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index] as {
        readonly kind?: unknown;
        getAsFile?: unknown;
      };
      if (
        item !== null &&
        typeof item === 'object' &&
        item.kind === 'file' &&
        typeof item.getAsFile === 'function'
      ) {
        let file: unknown = null;
        try {
          file = (item.getAsFile as () => unknown)();
        } catch {
          file = null;
        }
        if (isUploadableFileLike(file)) out.push(file);
      }
    }
  }
  return out;
}

/**
 * True when a paste clipboard carries text in either flavor;
 * shared by the grid and non-grid handlePaste branches so the
 * all-refuse fall-through probe stays identical in both.
 */
function clipboardHasText(clipboard: {
  getData(kind: string): string;
}): boolean {
  try {
    return (
      clipboard.getData('text/plain') !== '' ||
      clipboard.getData('text/html') !== ''
    );
  } catch {
    return false;
  }
}

/**
 * Synchronous pre-ingest refusal probe: true when a
 * collected file is already known to refuse without reading its bytes —
 * empty declared size or declared size over MAX_MEDIA_BYTES (mirrors the
 * `mediaSourceToBytes` declared-size pre-check + `assertUploadableBytes`
 * empty gate). Unknown sizes cannot pre-refuse (content sniff needs the
 * async read) and count as potentially valid, so a mixed clipboard with an
 * unsized file keeps files-win. Used by handlePaste to decide whether an
 * all-refuse file set should fall through to the text path.
 *
 * Documented files-win text loss: files-win claims synchronously
 * (`preventDefault` at paste time), so accompanying text is dropped before
 * the async ingest runs. When the ingest then refuses (unsized file whose
 * bytes arrive empty, lying declared size, sniff failure), the text is
 * already gone — post-`preventDefault` fall-through is impossible, so the
 * loss is inherent to the sync decision, not a bug to repair async. Pinned
 * in creation-integration.spec.ts (unsized-empty + text, lying-size + text).
 */
function isPreRefusedUploadableFile(file: UploadableFileLike): boolean {
  const size = (file as { size?: unknown }).size;
  if (typeof size !== 'number') return false;
  if (size === 0) return true;
  if (size > MAX_MEDIA_BYTES) return true;
  return false;
}

/**
 * True when a foreign drag carries file entries: the
 * host `dragover` gate claims ONLY these (so the file drop below fires)
 * while every other foreign drag keeps native handling (the
 * relevance gate stays intact). `types` is a frozen array in modern
 * browsers and a DOMStringList in older ones — probe both defensively.
 */
function dragCarriesFiles(
  transfer: { readonly types?: unknown } | null | undefined,
): boolean {
  if (transfer === null || transfer === undefined) return false;
  const types = transfer.types as
    | {
        includes?: unknown;
        contains?: unknown;
      }
    | null
    | undefined;
  if (types === null || types === undefined) return false;
  try {
    if (typeof types.includes === 'function') {
      return (types.includes as (entry: string) => boolean).call(
        types,
        'Files',
      );
    }
    if (typeof types.contains === 'function') {
      return (types.contains as (entry: string) => boolean).call(
        types,
        'Files',
      );
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Host picker answer event detail: the skeleton re-dispatches
 * `flbp:media-picked` with the requesting block id plus the picked
 * `File[]` snapshot. Both are untrusted (bubbling DOM event) — the
 * listener re-validates before routing into `uploadMedia`.
 */
interface MediaPickedDetail {
  readonly blockId?: unknown;
  readonly files?: unknown;
}

export class TiptapBlockpageEditorHandle implements BlockPageEditorHandle {
  readonly #input: BlockPageEditorInput;
  readonly #container: HTMLElement;
  readonly #host: HTMLElement;
  readonly #root: Root;
  readonly #registry: BlockRegistry;
  readonly #editor: Editor;
  #latestModel: BlockPageModel;
  #lastDocument: PMNode | null = null;
  /**
   * Preserve schema-supported marks for paragraph-only rich clipboard
   * flavor when its visible text agrees with `text/plain`. The same raw
   * pre-strip used by the plain HTML path removes fetch-capable payloads
   * before detached DOM parsing; ProseMirror then admits only marks in the
   * active schema. Lists, tables, and other structural HTML continue
   * through the deterministic line insertion path below.
   */
  #insertRichPaste(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    view: { state: any; dispatch(tr: any): void },
    plain: string,
    html: string,
  ): boolean {
    const lines = splitPasteLines(plain);
    if (lines.length === 0) return false;
    const { state } = view;
    const { $from, $to } = state.selection;
    if (
      $from.parent !== $to.parent ||
      !$from.parent.isTextblock ||
      $from.parent.type.name === 'codeBlock' ||
      $from.parent.type.name === 'tableParagraph'
    ) {
      return false;
    }
    const host = this.#host.ownerDocument.createElement('div');
    host.innerHTML = preStripPayloadTags(html);
    const parsed = PMDOMParser.fromSchema(state.schema).parseSlice(host, {
      preserveWhitespace: true,
    });
    const richLines: Fragment[] = [];
    let hasMark = false;
    let supportedStructure = true;
    parsed.content.forEach((node) => {
      if (
        !node.isTextblock ||
        (node.type.name !== 'paragraph' && node.type.name !== 'heading')
      ) {
        supportedStructure = false;
        return;
      }
      node.content.descendants((child) => {
        if (child.isText && child.marks.length > 0) hasMark = true;
        return true;
      });
      richLines.push(node.content);
    });
    const richText = richLines
      .map((line) => line.textBetween(0, line.size))
      .join('');
    if (
      !supportedStructure ||
      richLines.length === 0 ||
      richText !== lines.join('') ||
      !hasMark
    ) {
      return false;
    }
    return this.#insertPasteLines(
      view,
      richLines.map((line) => line.textBetween(0, line.size)),
      richLines,
    );
  }

  /**
   * Signatures of table normalization warnings already disclosed via
   * console.warn: `#reportTableWarnings` drains each sync's
   * `pmDocToModel` warnings through `unseenTableWarningMessages` so steady
   * typing never re-logs a known normalization.
   */
  readonly #tableWarningSeen = new Set<string>();
  #slashOpen = false;
  #slashQuery = '';
  #slashActive = 0;
  #resourceOpen = false;
  #resourceQuery = '';
  #resourceTrigger = '';
  #resourceTriggerLength = 0;
  #resourceActive = 0;
  #resourceRequest = 0;
  #resourceBlockType: ResourceBlockType | null = null;
  #resourceChoices: readonly ResourceChoice[] = [];
  #anchorPos: number | null = null;
  #hoveredId: string | null = null;
  #hoveredListItem: HTMLElement | null = null;
  #handleMenuItem: HTMLElement | null = null;
  #handleMenuAnchor: HTMLElement | null = null;
  #handleFromTouch = false;
  #typingHidesHandles = false;
  #hoverPointer: { x: number; y: number } | null = null;
  readonly #hoverEvents = new AbortController();
  #hoverFrame = 0;
  #hoveredTableId: string | null = null;
  #blockDrag: BlockDragController | null = null;
  readonly #stickyMarks = new Set<'bold' | 'italic' | 'strike' | 'code'>();

  /** Drag-handle turn-into menu: engine-owned overlay.*/
  #handleMenuOpen = false;
  #handleMenuTransforms = false;
  #handleMenuBlockId: string | null = null;
  #handleMenuActive = 0;
  /**
   * Open math/diagram source overlay (controller, wiring):
   * at most one per host; closed on Esc/dismiss/commit, readOnly, destroy.
   */
  #mathDiagramOverlay: MathDiagramOverlayHandle | null = null;
  /**
   * Coarse tap-vs-drag tracker shared by todo checkbox + figure taps
   * pointerdown parks the origin; pointerup beyond ~10px is a
   * scroll/drag and never toggles or opens. The 500ms suppression window
   * below then swallows the compatibility mouse click that follows a
   * handled tap (tap-vs-drag + 500ms suppression, same as the gutter).
   */
  #tapStartX = 0;
  #tapStartY = 0;
  #tapTracking = false;
  #suppressTapClickUntil = 0;
  /**
   * Provider contextual anchor: edge-gated
   * scroll/resize notifications mirror the ink/notebook/whiteboard
   * `selectionViewportBounds` precedent — the snapshot carries plain
   * viewport `{x, y, width, height}` and `onDidChange` fires only when the
   * rect actually moves (transactions already notify unconditionally).
   */
  #lastAnchorKey: string | null = null;
  #anchorCleanup: (() => void) | null = null;
  /**
   * Anchor-presence disclosure: block ids whose contextual controls
   * rendered without a resolvable viewport anchor (detached element).
   * Warned once per id; landing keeps this silent in normal mounts.
   */
  readonly #anchorWarningSeen = new Set<string>();
  /**
   * Host picker answer routing: the host-owned
   * `input[data-flbp-media-picker]` re-dispatches picked files as
   * `flbp:media-picked`; this handle answers by routing the first file
   * into the existing `uploadMedia(blockId, bytes)` primitive (same bound
   * vault store, same hash-before-render + single-undo). The skeleton
   * never touches the vault, and the pick gesture chain
   * (`flbp:pick-media` → input.click in the same task) is untouched —
   * this listener only handles the async answer event.
   */
  #mediaPickedCleanup: (() => void) | null = null;
  /**
   * Table size picker: engine-owned overlay offering the
   * TABLE_SIZE_PRESETS grid choice after the slash Table row commits.
   * The slash trigger range is held (never deleted) until a size commits
   * into the fused insert — cancel leaves the trigger text untouched.
   */
  #tablePickerOpen = false;
  #tablePickerActive = 0;
  #tablePickerTrigger: SlashTrigger | null = null;
  /** Outstanding transient reveal highlight (cleared on next reveal/destroy). */
  #revealTimer: ReturnType<typeof setTimeout> | null = null;
  #revealedElement: HTMLElement | null = null;
  #destroyed = false;
  /** Chrome exists + editor assigned; transactions during construction skip UI sync. */
  #chromeReady = false;
  /**
   * Deterministic sync counters (structural gate, never wall-clock):
   * `blocksVisited` counts child slots identity-compared per `#syncNow`
   * leavesOnly scan; `blocksDecoded` counts leaf blocks canonically
   * re-decoded; `fullDecodes` counts full-document conversions. Reference
   * preservation alone does not prove O(1) — these counters do: steady
   * typing shows `blocksDecoded == changed leaves` (bounded, typically 1)
   * with zero `fullDecodes`, while `blocksVisited` documents the O(n)
   * cheap identity scan honestly.
   */
  readonly #syncStats = { blocksVisited: 0, blocksDecoded: 0, fullDecodes: 0 };

  /** Snapshot of deterministic sync counters (tests/diagnostics). */
  syncStats(): {
    blocksVisited: number;
    blocksDecoded: number;
    fullDecodes: number;
  } {
    return { ...this.#syncStats };
  }
  readonly #toolListeners = new Set<() => void>();
  readonly #compositionControllers = new Map<
    Element,
    LazyCompositionController
  >();
  readonly #presentations = new Map<Element, CompositionPresentationHandle>();
  readonly #compositionSnapshots = new Map<Element, CompositionSnapshot>();
  readonly #compositionRecords = new Map<Element, string>();
  readonly #compositionObserver: IntersectionObserver | null;
  /**
   * Media hydration deps: vault reads for offline preview + remote
   * fetch for explicit per-block loads. `assets` mirrors the notebook lazy
   * pattern (extended input or provider deps — the foundation seam stays
   * unchanged); `fetchFn` defaults to the host fetch and is mocked in specs
   * (never real network in tests).
   */
  readonly #assets: DocumentAssetStore | null;
  readonly #fetchFn: FetchFn | null;
  readonly #mediaObserver: IntersectionObserver | null;
  /**
   * Lazy-preview gate for math/diagram figures: off-screen figures
   * keep the inspectable source until this observer marks them visible
   * (then re-syncs into the debounced render). Mirrors the composition
   * visibility pattern; absent without IntersectionObserver (tests), where
   * figures render on sync.
   */
  readonly #mathDiagramObserver: IntersectionObserver | null;
  readonly tools: DocumentEditorTools;

  constructor(
    input: BlockPageMediaEditorInput,
    container: HTMLElement,
    deps?: {
      readonly assets?: DocumentAssetStore | null;
      readonly fetchFn?: FetchFn | null;
    },
  ) {
    this.#input = input;
    this.#container = container;
    // Typed asset/fetch seam: the extended provider input
    // carries the optional bindings (no cast — the foundation seam stays
    // unchanged); absent bindings fail safe to placeholders downstream.
    this.#assets = input.assets ?? deps?.assets ?? null;
    this.#fetchFn =
      input.fetchFn ??
      deps?.fetchFn ??
      (typeof fetch === 'function' ? (fetch as unknown as FetchFn) : null);
    // One narrowly contained synchronous commit: the engine
    // needs the actual host element immediately, and createEditor is
    // synchronous. Never during normal rendering or engine updates.
    const skeletonRef: { current: BlockpageSkeleton | null } = {
      current: null,
    };
    const root = createRoot(container);
    flushSync(() => {
      root.render(createElement(BlockpageHostSkeleton, { skeletonRef }));
    });
    const skeleton = skeletonRef.current;
    if (skeleton === null)
      throw new Error('blockpage skeleton failed to commit');
    this.#root = root;
    // The colocated host module is the sizing contract for this editor
    // (same pattern as the CodeMirror provider's host module): it gives the
    // host flex sizing, height, scroll, and the shared writing column.
    // Without it the ProseMirror surface collapses to max-content width
    // inside the flex editor area — an empty page renders 0px wide (white
    // pane, no errors). React owns these classes now; the
    // engine only appends its surface and chrome inside the committed div.
    const host = skeleton.host;
    this.#host = host;
    this.#registry = input.blockRegistry ?? new InMemoryBlockRegistry();
    this.#latestModel = cloneModel(input.initialModel);
    this.#editor = new Editor({
      element: host,
      extensions: [
        StarterKit.configure({
          // Canonical external-link marks map to the native `link` mark.
          // Keep automatic URL creation disabled: Froglight's explicit
          // toolbar and sanitized paste paths own link creation.
          link: {
            autolink: false,
            linkOnPaste: false,
            openOnClick: false,
          },
          bulletList: false,
          orderedList: false,
          listItem: false,
          // the legacy horizontalRule input rule (`---`/`---`/
          // `___ `/`*** `) produces a `horizontalRule` node with no canonical
          // mapping (pm-map `default` decodes it away), so every declined
          // trigger it caught silently lost user-typed text. Our divider
          // adapter owns `---` on trigger-only top-level paragraphs;
          // declined input must stay literal, never convert.
          horizontalRule: false,
        }),
        ...froglightExtensions(),
        this.#chromePlugin(),
        this.#collapseDecorations(),
      ],
      content: modelToPmDoc(input.initialModel),
      // A schema/mapping mismatch must stop the provider from mounting.
      // Tiptap's unchecked fallback strips invalid JSON into an editable
      // blank document, which could then overwrite authoritative bytes.
      enableContentCheck: true,
      onUpdate: () => this.#syncNow(),
      onTransaction: () => {
        this.#blockDrag?.update();
        if (this.#hoverPointer && !this.#hoverFrame) this.#hoverFrame = requestAnimationFrame(this.#followHover);
        if (!this.#chromeReady) return;
        this.#notifyTools();
        queueMicrotask(() => this.#syncCompositionMounts());
        queueMicrotask(() => this.#syncMediaViews());
        queueMicrotask(() => this.#syncMathDiagramViews());
        queueMicrotask(() => this.#syncStickyMarks());
      },
    });
    this.#mediaObserver =
      typeof IntersectionObserver === 'function'
        ? new IntersectionObserver(() => undefined, {
            root: host,
            rootMargin: '240px',
          })
        : null;
    this.#mathDiagramObserver =
      typeof IntersectionObserver === 'function'
        ? new IntersectionObserver(
            (entries) => {
              let advanced = false;
              for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                markMathDiagramVisible(entry.target);
                advanced = true;
              }
              if (advanced) void this.#syncMathDiagramViews();
            },
            { root: host, rootMargin: '240px' },
          )
        : null;
    this.#compositionObserver =
      typeof IntersectionObserver === 'function'
        ? new IntersectionObserver(
            (entries) => {
              for (const entry of entries)
                this.#compositionControllers
                  .get(entry.target)
                  ?.setVisible(entry.isIntersecting);
            },
            { root: host, rootMargin: '240px' },
          )
        : null;
    this.#lastDocument = this.#editor.state.doc;
    this.#buildChrome();
    this.#chromeReady = true;
    this.#syncCompositionMounts();
    void this.#syncMediaViews();
    void this.#syncMathDiagramViews();
    this.tools = {
      snapshot: () => this.#toolSnapshot(),
      execute: (id, value) => this.#executeTool(id, value),
      onDidChange: (listener) => {
        this.#toolListeners.add(listener);
        return { dispose: () => this.#toolListeners.delete(listener) };
      },
    };
    // Host picker answer routing: answer the skeleton's
    // `flbp:media-picked` re-dispatch by routing into `uploadMedia`.
    // First-file Replace semantics: the pick names exactly one block, so
    // the first file replaces it; extra files are ignored (host
    // drop/paste stays the multi-file ingestion path). Malformed events
    // (missing blockId/files) are a no-op; `uploadMedia` refuses invalid
    // bytes with no mutation (outcome-before-mutation).
    const onMediaPicked = (event: Event): void => {
      if (this.#destroyed) return;
      const detail = (event as CustomEvent<MediaPickedDetail>).detail;
      const blockId =
        typeof detail?.blockId === 'string' && detail.blockId !== ''
          ? detail.blockId
          : null;
      const files = detail?.files;
      const first: unknown =
        Array.isArray(files) && files.length > 0 ? files[0] : null;
      if (blockId === null || first === null || first === undefined) return;
      void this.uploadMedia(
        blockId,
        first as {
          arrayBuffer(): Promise<ArrayBuffer>;
          size?: number;
        },
      );
    };
    host.addEventListener(MEDIA_PICKED_EVENT, onMediaPicked);
    this.#mediaPickedCleanup = () =>
      host.removeEventListener(MEDIA_PICKED_EVENT, onMediaPicked);
  }

  // --- provider contract ---

  focus(): void {
    this.#editor.commands.focus();
  }

  hasFocus(): boolean {
    return this.#editor.isFocused;
  }

  setReadOnly(readOnly: boolean): void {
    this.#editor.setEditable(!readOnly);
    this.#blockDrag?.update();
    this.#host.dataset.readOnly = String(readOnly);
    for (const [element, snapshot] of this.#compositionSnapshots) {
      this.#presentations.get(element)?.update(snapshot, readOnly);
    }
    if (readOnly) {
      this.#closeSlash();
      this.#closeHandleMenu();
      this.#closeTablePicker();
      this.#closeMathDiagramOverlay();
    }
  }

  execCommand(id: 'undo' | 'redo'): boolean {
    if (id === 'undo') return this.#editor.commands.undo();
    if (id === 'redo') return this.#editor.commands.redo();
    return false;
  }

  canExecCommand(id: 'undo' | 'redo'): boolean {
    return id === 'undo'
      ? this.#editor.can().undo()
      : this.#editor.can().redo();
  }

  flush(): void {
    // Force any browser DOM mutation still queued by ProseMirror's observer
    // into editor state before the workbench performs its close/save gate.
    const observer = (
      this.#editor.view as unknown as { domObserver?: { flush(): void } }
    ).domObserver;
    observer?.flush();
    this.#syncNow();
  }

  /**
   * Exact reveal seam: the opaque address is a block id
   * passed verbatim (mirrors the Markdown slug→line and Notebook
   * jumpToAddress patterns). On hit the block scrolls into view with a
   * transient ephemeral highlight and the method returns true; unknown or
   * empty addresses return false without side effects — a prior transient
   * highlight is preserved until its timer expires (only a new hit
   * replaces it, destroy clears it). Focus-neutral: a background reveal
   * never steals focus (the controller focuses separately unless
   * `preserveFocus`). Never mutates canonical bytes. A destroyed handle
   * reports false without throwing.
   */
  revealAddress(address: string): boolean {
    if (this.#destroyed) return false;
    if (typeof address !== 'string' || address === '') return false;
    let hit: BlockHit | null = null;
    try {
      hit = this.#findBy(
        (node) =>
          (typeof node.attrs.blockId === 'string' &&
            node.attrs.blockId === address) ||
          (typeof node.attrs.listId === 'string' &&
            node.attrs.listId === address),
      );
    } catch {
      return false;
    }
    if (hit === null) return false;
    // Move the ProseMirror selection just inside the block (best-effort;
    // atom contexts fall back to a node selection). Dispatched without
    // focusing: background reveals must not steal DOM focus.
    try {
      const doc = this.#editor.state.doc;
      const resolved = doc.resolve(Math.min(hit.pos + 1, doc.content.size));
      const selection = (() => {
        try {
          return TextSelection.near(resolved);
        } catch {
          return new NodeSelection(resolved);
        }
      })();
      this.#editor.view.dispatch(
        this.#editor.state.tr.setSelection(selection).scrollIntoView(),
      );
    } catch {
      // Selection is best-effort; the DOM scroll + highlight below still
      // performs the exact reveal.
    }
    try {
      const element = this.#rootElementFor(address);
      if (element !== null) {
        if (
          typeof element.scrollIntoView === 'function' &&
          element.isConnected
        ) {
          try {
            element.scrollIntoView({ block: 'center' });
          } catch {
            // jsdom and overflow edge cases: highlight still reveals.
          }
        }
        this.#clearRevealHighlight();
        element.classList.add('flbp-reveal');
        this.#revealedElement = element;
        this.#revealTimer = setTimeout(
          () => this.#clearRevealHighlight(),
          1200,
        );
      }
    } catch {
      // DOM highlight is best-effort; the hit itself already resolved true.
    }
    return true;
  }

  #clearRevealHighlight(): void {
    if (this.#revealTimer !== null) {
      clearTimeout(this.#revealTimer);
      this.#revealTimer = null;
    }
    this.#revealedElement?.classList.remove('flbp-reveal');
    this.#revealedElement = null;
  }

  /** Drain one sync's table warnings to the provider disclosure channel. */
  #reportTableWarnings(
    warnings: readonly {
      readonly code: string;
      readonly blockId: unknown;
      readonly detail?: string;
    }[],
  ): void {
    const messages = unseenTableWarningMessages(
      warnings as Parameters<typeof unseenTableWarningMessages>[0],
      this.#tableWarningSeen,
    );
    for (const message of messages) console.warn(message);
  }

  #reportStructuralWarnings(warnings: readonly PmStructuralWarning[]): void {
    this.#reportTableWarnings(warnings);
  }

  #notifyTools(): void {
    for (const listener of this.#toolListeners) listener();
  }

  /**
   * Collect every selection fact in exactly one document traversal.
   * Collapsed carets fall back to the single current root (no traversal);
   * ranges walk `nodesBetween` once, gathering touched textblocks/atoms,
   * keyed roots, and text-node mark sets together. Atoms in this schema
   * (divider, image, composition) are leaves and textblocks have no
   * block children, so an unpruned walk visits the same blocks the old
   * per-purpose traversals saw; nested keyed nodes are filtered post-hoc
   * to preserve the old prune-at-keyed-root semantics. Grid structure
   * (`table`, `tableRow`, `tableCell`, `tableHeader`) is neither textblock
   * nor atom, so only the inner `tableParagraph` textblocks surface here —
   * the keyed table root carries identity below.
   */
  #collectSelectionFacts(): SelectionFacts {
    const { state } = this.#editor;
    const { from, to, empty } = state.selection;
    const markTypes: Record<string, MarkType | undefined> = {
      bold: state.schema.marks['bold'],
      italic: state.schema.marks['italic'],
      strike: state.schema.marks['strike'],
      code: state.schema.marks['code'],
      link: state.schema.marks['link'],
      extMark: state.schema.marks['extMark'],
    };
    const currentNode = this.#currentRoot();
    const current =
      currentNode === null
        ? null
        : {
            name: currentNode.node.type.name,
            attrs: currentNode.node.attrs as Record<string, unknown>,
          };
    const linkActive = this.#editor.isActive('link');
    let linkHref: string | undefined;
    if (linkActive) {
      const attrs = this.#editor.getAttributes('link') as {
        href?: unknown;
      };
      if (typeof attrs.href === 'string' && attrs.href !== '') {
        linkHref = attrs.href;
      }
    }
    if (empty) {
      const caretMarks = (state.storedMarks ??
        state.selection.$from.marks()) as readonly Mark[];
      const caretActive: Record<string, boolean> = {};
      for (const name of ['bold', 'italic', 'strike', 'code']) {
        caretActive[name] = this.#editor.isActive(name);
      }
      // a collapsed caret in a grid cell resolves its
      // current root to the whole `table` (identity lives at the table
      // level), which would report touched=[table] → inlineFormatting false,
      // hiding mark controls the cell supports. Derive the touched block
      // from `$from.parent` (`tableParagraph`, inline-capable) while the
      // keyed root stays the table — table context/controls are preserved
      // (context still "Table", grid ops still offered) and marks appear.
      const $from = state.selection.$from;
      const cellParent = $from.parent;
      const inCell = cellParent.type.name === 'tableParagraph';
      const touchedSingle = inCell
        ? [
            {
              name: cellParent.type.name,
              attrs: cellParent.attrs as Record<string, unknown>,
            },
          ]
        : current === null
          ? []
          : [{ name: current.name, attrs: current.attrs }];
      const single =
        current === null ? [] : [{ name: current.name, attrs: current.attrs }];
      return {
        empty: true,
        touchedBlocks: [...touchedSingle],
        keyedRoots: [...single],
        current,
        textMarks: [],
        caretMarks,
        caretActive,
        linkActive,
        ...(linkHref !== undefined ? { linkHref } : {}),
        markTypes,
      };
    }
    const touchedBlocks: SelectionFacts['touchedBlocks'] = [];
    const seenBlocks = new Set<string>();
    const keyedHits: Array<{
      readonly from: number;
      readonly to: number;
      readonly name: string;
      readonly attrs: Record<string, unknown>;
    }> = [];
    const textMarks: Array<readonly Mark[]> = [];
    state.doc.nodesBetween(from, to, (node, pos) => {
      // Text nodes match `isTextblock` in this schema, so they must be
      // claimed for mark collection first and never as touched blocks
      // (the old per-purpose walk pruned at textblocks and never saw them).
      // Text is a leaf: pruning here changes nothing else.
      if (node.isText) {
        textMarks.push(node.marks);
        return false;
      }
      const key = this.#keyOf(node);
      if (key !== null) {
        keyedHits.push({
          from: pos,
          to: pos + node.nodeSize,
          name: node.type.name,
          attrs: node.attrs as Record<string, unknown>,
        });
      }
      if (node.isTextblock || node.isAtom) {
        const blockKey = `${node.type.name}:${pos}`;
        if (!seenBlocks.has(blockKey)) {
          seenBlocks.add(blockKey);
          touchedBlocks.push({
            name: node.type.name,
            attrs: node.attrs as Record<string, unknown>,
          });
        }
      }
      return true;
    });
    // Keep topmost keyed roots only (see #topmostKeyedRoots): a hit
    // contained in an earlier ancestor hit belongs to the same root block.
    if (touchedBlocks.length === 0 && current !== null) {
      touchedBlocks.push({ name: current.name, attrs: current.attrs });
    }
    const keyedRoots = this.#topmostKeyedRoots(keyedHits);
    if (keyedRoots.length === 0 && current !== null) {
      keyedRoots.push({ name: current.name, attrs: current.attrs });
    }
    return {
      empty: false,
      touchedBlocks,
      keyedRoots,
      current,
      textMarks,
      caretMarks: [],
      caretActive: {},
      linkActive,
      ...(linkHref !== undefined ? { linkHref } : {}),
      markTypes,
    };
  }

  /** Topmost keyed hits: drop any hit contained in an earlier ancestor hit. */
  #topmostKeyedRoots(
    hits: ReadonlyArray<{
      readonly from: number;
      readonly to: number;
      readonly name: string;
      readonly attrs: Record<string, unknown>;
    }>,
  ): Array<{ readonly name: string; readonly attrs: Record<string, unknown> }> {
    const kept: Array<(typeof hits)[number]> = [];
    const seen = new Set<string>();
    for (const hit of hits) {
      let nested = false;
      for (const ancestor of kept) {
        if (
          hit.from >= ancestor.from &&
          hit.to <= ancestor.to &&
          hit !== ancestor
        ) {
          nested = true;
          break;
        }
      }
      if (nested) continue;
      const id = `${hit.name}:${hit.from}`;
      if (seen.has(id)) continue;
      seen.add(id);
      kept.push(hit);
    }
    return kept.map((hit) => ({ name: hit.name, attrs: hit.attrs }));
  }

  /**
   * Provider-computed active/mixed state for one inline mark from collected
   * facts, consistent with the Markdown provider's contract: caret state
   * follows stored marks and is never mixed; a range is active only when
   * every text node carries the mark and mixed when merely some do.
   */
  #markRangeFromFacts(
    facts: SelectionFacts,
    markName: string,
  ): {
    readonly active: boolean;
    readonly mixed: boolean;
  } {
    if (facts.empty) {
      return {
        active: facts.caretActive[markName] === true,
        mixed: false,
      };
    }
    const markType = facts.markTypes[markName];
    if (markType === undefined) return { active: false, mixed: false };
    let total = 0;
    let marked = 0;
    for (const marks of facts.textMarks) {
      total += 1;
      if (markType.isInSet(marks as Mark[])) marked += 1;
    }
    if (total === 0 || marked === 0) return { active: false, mixed: false };
    if (marked === total) return { active: true, mixed: false };
    return { active: false, mixed: true };
  }

  /** Extract an extMark link href from a mark list, if present. */
  #extLinkHrefOf(marks: readonly ExtMarkView[]): string | null {
    for (const mark of marks) {
      if (mark.type.name !== 'extMark') continue;
      if (mark.attrs['name'] !== 'link') continue;
      const raw = mark.attrs['json'];
      if (typeof raw !== 'string') continue;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (
          typeof parsed === 'object' &&
          parsed !== null &&
          !Array.isArray(parsed) &&
          typeof (parsed as { href?: unknown }).href === 'string'
        ) {
          const href = (parsed as { href: string }).href;
          if (href !== '') return href;
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  /**
   * Link mark detection from collected facts (no document traversal).
   * Returns applicability based purely on marks/selection; callers must also
   * require `inlineFormatting` so mixed/unsupported selections never expose
   * a misleading Link action.
   */
  #linkMarkFromFacts(facts: SelectionFacts): {
    readonly applicable: boolean;
    readonly href?: string;
    readonly active: boolean;
  } {
    // Native link mark first (future-proof when the Link extension returns).
    const linkType = facts.markTypes['link'];
    if (linkType !== undefined) {
      if (facts.linkActive) {
        if (facts.empty) {
          if (facts.linkHref !== undefined) {
            return { applicable: true, href: facts.linkHref, active: true };
          }
          return { applicable: false, active: false };
        }
        let total = 0;
        let linked = 0;
        for (const marks of facts.textMarks) {
          total += 1;
          if (linkType.isInSet(marks as Mark[])) linked += 1;
        }
        if (total === 0) return { applicable: false, active: false };
        if (
          linked === total &&
          facts.linkHref !== undefined &&
          facts.linkHref !== ''
        ) {
          return { applicable: true, href: facts.linkHref, active: true };
        }
        return { applicable: true, active: false };
      }
      if (!facts.empty) return { applicable: true, active: false };
      return { applicable: false, active: false };
    }
    // extMark fallback: links persist as `{type:'link', href}` payloads.
    const extType = facts.markTypes['extMark'];
    if (extType === undefined) return { applicable: false, active: false };
    if (facts.empty) {
      const href = this.#extLinkHrefOf(
        facts.caretMarks as unknown as readonly ExtMarkView[],
      );
      if (href !== null) return { applicable: true, href, active: true };
      return { applicable: false, active: false };
    }
    let total = 0;
    const hrefs = new Set<string>();
    let allLinked = true;
    for (const marks of facts.textMarks) {
      total += 1;
      const href = this.#extLinkHrefOf(
        marks as unknown as readonly ExtMarkView[],
      );
      if (href === null) {
        allLinked = false;
        continue;
      }
      hrefs.add(href);
    }
    if (total === 0) return { applicable: false, active: false };
    if (allLinked && hrefs.size === 1) {
      const only = [...hrefs][0]!;
      return { applicable: true, href: only, active: true };
    }
    return { applicable: true, active: false };
  }

  /** True when inline marks/links are meaningful for `nodeName`. */
  #inlineFormattingAllowed(nodeName: string): boolean {
    if (nodeName === 'codeBlock') return false;
    return INLINE_EDITABLE_BLOCKS.has(nodeName);
  }

  /**
   * True when `nodeName` supports turn-into. Text containers and lists are
   * allowed. Atoms and special blocks, table grids, column regions, groups,
   * and opaque rows are rejected because they have no text-container
   * representation to preserve. Media and math/diagram rules also reject
   * those conversions without mutation.
   */
  #turnIntoAble(nodeName: string): boolean {
    return (
      nodeName === 'paragraph' ||
      nodeName === 'heading' ||
      nodeName === 'blockquote' ||
      nodeName === 'codeBlock' ||
      nodeName === 'toggle' ||
      nodeName === 'callout' ||
      nodeName === 'bulletList' ||
      nodeName === 'orderedList'
    );
  }

  /** Type value for one block (same mapping as the snapshot selector). */
  #typeValueFor(nodeName: string, attrs: Record<string, unknown>): string {
    if (nodeName === 'heading') {
      const level = typeof attrs['level'] === 'number' ? attrs['level'] : 1;
      const clamped = Number.isFinite(level)
        ? Math.min(6, Math.max(1, Math.floor(level)))
        : 1;
      return `heading:${clamped}`;
    }
    if (nodeName === 'blockquote') return 'quote';
    if (nodeName === 'codeBlock') return 'code';
    if (nodeName === 'orderedList') return 'ordered';
    if (nodeName === 'bulletList') return 'bullet';
    return nodeName;
  }

  /**
   * Refine a list type value through live state: a bullet list whose focused
   * item carries a to-do `checked` mark reports `todo` so the durable
   * selector reflects the To-do item row; plain bullets stay `bullet`.
   * Falls back to the base value when the list cannot be located.
   */
  #refineListValue(base: string): string {
    if (base !== 'bullet') return base;
    try {
      const { $from } = this.#editor.state.selection;
      for (let depth = $from.depth; depth >= 0; depth -= 1) {
        const node = $from.node(depth);
        if (node.type.name !== 'bulletList' && node.type.name !== 'orderedList')
          continue;
        let todo = false;
        node.descendants((child) => {
          if (todo) return false;
          if (
            child.type.name === 'listItem' &&
            (child.attrs.checked === true || child.attrs.checked === false)
          )
            todo = true;
          return !todo;
        });
        return todo ? 'todo' : base;
      }
    } catch {
      return base;
    }
    return base;
  }

  /**
   * Contiguous extMark link range around the caret sharing `href`.
   * Used to update an existing link in place when the popover submits from
   * a collapsed caret. Provider-computed; ProseMirror positions never cross
   * the toolbar contract.
   */
  #linkRangeAtCaret(
    href: string,
  ): { readonly from: number; readonly to: number } | null {
    const { state } = this.#editor;
    if (!state.selection.empty) return null;
    const caret = state.selection.$from.pos;
    const atCaret = this.#extLinkHrefOf(
      state.selection.$from.marks() as unknown as readonly ExtMarkView[],
    );
    let caretHref = atCaret;
    if (caretHref !== href) {
      const stored = state.storedMarks;
      if (stored === null || stored === undefined) return null;
      caretHref = this.#extLinkHrefOf(
        stored as unknown as readonly ExtMarkView[],
      );
      if (caretHref !== href) return null;
    }
    // Collect text runs carrying this href, then expand contiguously.
    const runs: Array<{ readonly from: number; readonly to: number }> = [];
    state.doc.descendants((node, pos) => {
      if (!node.isText) return true;
      const nodeHref = this.#extLinkHrefOf(
        node.marks as unknown as readonly ExtMarkView[],
      );
      if (nodeHref === href) runs.push({ from: pos, to: pos + node.nodeSize });
      return true;
    });
    const containing = runs.filter(
      ({ from, to }) => from <= caret && caret <= to,
    );
    if (containing.length === 0) return null;
    let from = Math.min(...containing.map((run) => run.from));
    let to = Math.max(...containing.map((run) => run.to));
    // Merge adjacent same-href runs (split by other marks still contiguous).
    let grew = true;
    while (grew) {
      grew = false;
      for (const run of runs) {
        if (run.to === from) {
          from = run.from;
          grew = true;
        } else if (run.from === to) {
          to = run.to;
          grew = true;
        }
      }
    }
    if (from >= to) return null;
    return { from, to };
  }

  /**
   * Single-source selection analysis: computed once per editor state and
   * shared by toolbar snapshot, link state, mark active/mixed state,
   * execution guards, block-type capability, and indent/outdent. Keeps
   * capability derivation structurally single-source for performance and
   * correctness.
   */
  #analyzeSelection(): SelectionAnalysis {
    // One traversal per editor state: every capability below derives from
    // the same facts instance. Indent/outdent use their existing targeted
    // read-only mirrors (computed once here, never re-queried per consumer).
    const facts = this.#collectSelectionFacts();
    const touched = facts.touchedBlocks;
    const keyed = facts.keyedRoots;
    const fallbackName = facts.current?.name ?? 'paragraph';
    let inlineFormatting: boolean;
    let turnInto: boolean;
    let blockType: SelectionAnalysis['blockType'];
    let context: string;
    let nodeName: string;
    if (touched.length === 0) {
      inlineFormatting = this.#inlineFormattingAllowed(fallbackName);
      turnInto = this.#turnIntoAble(fallbackName);
      blockType = { kind: 'unsupported' };
      context = 'Paragraph';
      nodeName = fallbackName;
    } else {
      inlineFormatting =
        touched.length > 0 &&
        touched.every((block) => this.#inlineFormattingAllowed(block.name));
      // Turn-into/block-type use keyed-root granularity so incompatible
      // roots (atoms, opaque, groups) stay disabled; inline uses textblocks.
      // Turn-into additionally requires a single keyed root: the
      // executor rejects multi-root ranges instead of turning only the
      // anchor, so the snapshot must not offer the selector there.
      const keyedForType = keyed.length > 0 ? keyed : touched;
      turnInto =
        keyedForType.length === 1 &&
        keyedForType.every((block) => this.#turnIntoAble(block.name));
      const contextFor = (
        name: string,
        attrs: Record<string, unknown>,
      ): string => {
        if (name === 'heading') {
          const level = typeof attrs['level'] === 'number' ? attrs['level'] : 1;
          const clamped = Number.isFinite(level)
            ? Math.min(6, Math.max(1, Math.floor(level)))
            : 1;
          return `Heading ${clamped}`;
        }
        if (name === 'codeBlock') return 'Code block';
        if (name === 'blockquote') return 'Quote';
        if (name === 'paragraph') return 'Paragraph';
        if (name === 'bulletList') return 'Bullet list';
        if (name === 'orderedList') return 'Numbered list';
        // Source atoms: human context names instead of the raw
        // node-name fallback ('MathBlock'/'DiagramBlock').
        if (name === 'mathBlock') return 'Math';
        if (name === 'diagramBlock') return 'Diagram';
        return `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
      };
      if (!turnInto) {
        blockType = { kind: 'unsupported' };
        if (keyedForType.length === 1) {
          const only = keyedForType[0]!;
          nodeName = only.name;
          context = contextFor(only.name, only.attrs);
        } else {
          nodeName = keyedForType[0]?.name ?? fallbackName;
          context = 'Multiple blocks';
        }
      } else {
        const values = keyedForType.map((block) =>
          this.#refineListValue(this.#typeValueFor(block.name, block.attrs)),
        );
        const first = values[0]!;
        if (values.every((value) => value === first)) {
          blockType = { kind: 'single', value: first };
          const only = keyedForType[0]!;
          nodeName = only.name;
          context =
            first === 'todo' ? 'To-do item' : contextFor(only.name, only.attrs);
        } else {
          blockType = { kind: 'mixed' };
          nodeName = keyedForType[0]?.name ?? fallbackName;
          context = 'Multiple blocks';
        }
      }
    }
    // Link is available only when the complete relevant selection supports
    // it (all blocks inline-capable) and the mark range itself is
    // link-compatible (has text / caret in link).
    const markLink = this.#linkMarkFromFacts(facts);
    const link = inlineFormatting && markLink.applicable;
    const marks = {
      bold: this.#markRangeFromFacts(facts, 'bold'),
      italic: this.#markRangeFromFacts(facts, 'italic'),
      strike: this.#markRangeFromFacts(facts, 'strike'),
      code: this.#markRangeFromFacts(facts, 'code'),
    } as const;
    return {
      touchedBlocks: touched,
      keyedRoots: keyed,
      blockType,
      context,
      inlineFormatting,
      marks: {
        bold: { ...marks.bold },
        italic: { ...marks.italic },
        strike: { ...marks.strike },
        code: { ...marks.code },
      },
      link: {
        applicable: link,
        ...(markLink.href !== undefined && link ? { href: markLink.href } : {}),
        active: link && markLink.active,
      },
      turnInto,
      nodeName,
      markApplicable: markLink.applicable,
    };
  }

  /**
   * Table grid controls: the required surface
   * for row/col/header ops — no provider-owned toolbar DOM. Empty outside
   * tables. Move buttons disable at grid edges; the header toggle reflects
   * the live flag; add/remove stay enabled (removing the last row/column
   * deletes the table itself — see runTableOp's degenerate-grid policy).
   */
  #tableControls(
    nodeName: string,
  ): ReturnType<DocumentEditorTools['snapshot']>['controls'] {
    if (nodeName !== 'table' && this.#hoveredTableId === null) return [];
    // Multi-root ranges never claim table ops (indent/outdent precedent):
    // ops act on the anchor table, so the snapshot must not offer them.
    if (this.#hoveredTableId === null && !this.#editor.state.selection.empty && this.#touchedRootCount() > 1) {
      return [];
    }
    const hovered = this.#hoveredTableId === null ? null : this.#findBy(
      (node) => node.type.name === 'table' && node.attrs.blockId === this.#hoveredTableId,
    )?.node ?? null;
    const caretGeometry = nodeName === 'table' ? caretTableGeometry(this.#editor.state) : null;
    const geometry = hovered === null ? caretGeometry : {
      row: 0,
      col: 0,
      rows: hovered.childCount,
      cols: hovered.firstChild?.childCount ?? 0,
      header: Boolean(hovered.attrs.header),
    };
    if (geometry === null) return [];
    const button = (
      op: string,
      label: string,
      state: { active?: true; disabled?: true } = {},
    ) =>
      ({
        kind: 'button',
        id: op,
        group: 'table',
        label,
        semanticRole: op,
        ...state,
      }) as ReturnType<DocumentEditorTools['snapshot']>['controls'][number];
    return [
      button('table.addRowBefore', 'Insert row above'),
      button('table.addRow', 'Add row'),
      button('table.addColumnBefore', 'Insert column left'),
      button('table.addColumn', 'Add column'),
      button('table.removeRow', 'Remove row'),
      button('table.removeColumn', 'Remove column'),
      button('table.moveRowUp', 'Move row up', {
        ...(hovered === null && geometry.row <= 0 ? { disabled: true as const } : {}),
      }),
      button('table.moveRowDown', 'Move row down', {
        ...(hovered === null && geometry.row >= geometry.rows - 1
          ? { disabled: true as const }
          : {}),
      }),
      button('table.moveColumnLeft', 'Move column left', {
        ...(hovered === null && geometry.col <= 0 ? { disabled: true as const } : {}),
      }),
      button('table.moveColumnRight', 'Move column right', {
        ...(hovered === null && geometry.col >= geometry.cols - 1
          ? { disabled: true as const }
          : {}),
      }),
      button('table.toggleHeader', 'Header row', {
        ...(geometry.header ? { active: true as const } : {}),
      }),
    ];
  }

  /**
   * Execute one `table.*` semantic control. Outcome-before-mutation: unknown
   * ids and off-grid selections refuse without dispatching; every op fuses
   * into one closeHistory transaction (single undo per op).
   */
  #tableOp(id: string, value?: string): boolean {
    const op = (TABLE_OP_IDS.find((known) => known === id) ?? '').slice(
      'table.'.length,
    ) as TableOpId | '';
    if (op === '') return false;
    const currentTable = this.#currentRoot()?.node;
    if (value === undefined && currentTable?.type.name !== 'table') return false;
    if (value !== undefined) {
      let target: unknown;
      try {
        target = JSON.parse(value);
      } catch {
        return false;
      }
      if (
        typeof target !== 'object' ||
        target === null ||
        !('blockId' in target) ||
        !('row' in target) ||
        !('col' in target) ||
        typeof target.blockId !== 'string' ||
        !Number.isInteger(target.row) ||
        !Number.isInteger(target.col)
      )
        return false;
      const targetTable = this.#findBy((node) =>
        node.type.name === 'table' && node.attrs.blockId === target.blockId,
      )?.node;
      if (targetTable === undefined) return false;
      if ('to' in target && !Number.isInteger(target.to)) return false;
      const axis =
        op === 'moveRowUp' || op === 'moveRowDown'
          ? 'row'
          : op === 'moveColumnLeft' || op === 'moveColumnRight'
            ? 'column'
            : null;
      if (
        'to' in target &&
        (axis === null ||
          (target.to as number) < 0 ||
          (target.to as number) >=
            (axis === 'row'
              ? targetTable.childCount
              : (targetTable.firstChild?.childCount ?? 0)))
      )
        return false;
      if (
        !selectTableCellForAction(
          this.#editor,
          target.blockId,
          target.row as number,
          target.col as number,
        )
      )
        return false;
      if ('to' in target) {
        return (
          axis !== null &&
          runTableMoveToCommand(this.#editor, axis, target.to as number)
        );
      }
    }
    // Converge with the snapshot: multi-root ranges never run table ops.
    if (!this.#editor.state.selection.empty && this.#touchedRootCount() > 1) {
      return false;
    }
    return runTableOpCommand(this.#editor, op);
  }

  // --- media blocks ---

  static readonly #MEDIA_NODES = new Set([
    'imageBlock',
    'videoBlock',
    'audioBlock',
    'fileBlock',
  ]);

  /**
   * Insert types refused inside the table grid: tables, media placeholders,
   * math/diagram source atoms. A grid caret sits in a cell, and
   * silently landing content after the table being edited is surprising, so
   * these refuse with no mutation. This matches slash suppression: the fused
   * slash path holds the trigger untouched. Legacy insertables
   * (divider/toggle/callout/resource/opaque) keep their after-table behavior.
   */
  static readonly #GRID_GUARDED_INSERTS = new Set([
    'table',
    'image',
    'video',
    'audio',
    'file',
    'math',
    'diagram',
  ]);

  /**
   * Current media root, if the selection roots at exactly one media atom.
   * Multi-root ranges never resolve (indent/outdent/table precedent): the
   * snapshot must not offer per-block caption/remote controls there and
   * execute must refuse instead of editing only the anchor.
   */
  #mediaRoot(): { node: PMNode; pos: number; kind: string } | null {
    const current = this.#currentRoot();
    if (current === null) return null;
    if (!TiptapBlockpageEditorHandle.#MEDIA_NODES.has(current.node.type.name)) {
      return null;
    }
    if (!this.#editor.state.selection.empty && this.#touchedRootCount() > 1) {
      return null;
    }
    return {
      node: current.node,
      pos: current.pos,
      kind: current.node.type.name,
    };
  }

  /** Hydrate media previews under the host (vault eager, remote gated). */
  async #syncMediaViews(): Promise<void> {
    if (this.#destroyed) return;
    try {
      await syncMediaViews(this.#host, {
        ...(this.#assets !== null ? { assets: this.#assets } : {}),
        ...(this.#fetchFn !== null ? { fetchFn: this.#fetchFn } : {}),
        ...(this.#mediaObserver !== null
          ? { observer: this.#mediaObserver }
          : {}),
      });
    } catch {
      // Hydration is best-effort derived content; canonical sync already ran.
    }
  }

  /** Re-run hydration for one block (retry control: no canonical mutation). */
  #retryMediaViews(blockId: string): boolean {
    const element = this.#rootElementFor(blockId);
    if (element !== null) {
      delete element.dataset.flbpMediaSig;
    }
    void this.#syncMediaViews();
    return true;
  }

  /**
   * Media semantic controls: the REQUIRED surface for
   * caption/alt/name edits + opt-in remote + retry — no provider toolbar
   * DOM. Text inputs carry the live value; remote opt-in carries the
   * current URL as its prefill. Vault-only images omit remote controls.
   */
  #mediaControls(): ReturnType<DocumentEditorTools['snapshot']>['controls'] {
    const hit = this.#mediaRoot();
    if (hit === null) return [];
    const attrs = hit.node.attrs as Record<string, unknown>;
    const str = (key: string): string | undefined =>
      typeof attrs[key] === 'string' && attrs[key] !== ''
        ? (attrs[key] as string)
        : undefined;
    const textInput = (
      id: string,
      label: string,
      actionLabel: string,
      value?: string,
    ): ReturnType<DocumentEditorTools['snapshot']>['controls'][number] =>
      ({
        kind: 'input',
        id,
        group: 'media',
        label,
        placeholder: '',
        actionLabel,
        semanticRole: id,
        ...(value !== undefined ? { value } : {}),
      }) as ReturnType<DocumentEditorTools['snapshot']>['controls'][number];
    const button = (
      id: string,
      label: string,
      state: { disabled?: true } = {},
    ): ReturnType<DocumentEditorTools['snapshot']>['controls'][number] =>
      ({
        kind: 'button',
        id,
        group: 'media',
        label,
        semanticRole: id,
        ...state,
      }) as ReturnType<DocumentEditorTools['snapshot']>['controls'][number];
    const isImage = hit.node.type.name === 'imageBlock';
    const mediaKind = hit.node.type.name.replace('Block', '');
    const remote = str('remoteUrl');
    return [
      ...(!isImage
        ? [textInput('media.name', 'Media name', 'Set name', str('name'))]
        : []),
      textInput(
        'media.caption',
        'Media caption',
        'Set caption',
        str('caption'),
      ),
      textInput('media.alt', 'Alt text', 'Set alt text', str('alt')),
      button('media.details', 'Save media details'),
      button('media.replace', `Replace ${mediaKind}`, {
        ...(!this.#editor.isEditable ? { disabled: true } : {}),
      }),
      ...(!isImage
        ? [
            // Destructiveness disclosure: opting in REPLACES
            // the vault reference on save (pm-map decodes remote-only and
            // drops the vault src) — re-upload restores the same bytes via
            // content-addressed dedupe. The vault flow stays the default.
            textInput(
              'media.remoteUrl',
              'Remote URL (https only — opt-in; replaces the vault ref on save, re-upload restores it)',
              'Use remote (replaces vault)',
              remote,
            ),
            ...(remote !== undefined
              ? [button('media.clearRemote', 'Use vault instead')]
              : []),
          ]
        : []),
      button('media.retry', 'Retry media load'),
    ];
  }

  /**
   * Write presentation/remote attrs on the current media root in one
   * closeHistory transaction (single undo). Outcome-before-mutation: the
   * root is re-resolved and every value validated BEFORE dispatch.
   */
  #setMediaAttrs(patch: Record<string, unknown>): boolean {
    const hit = this.#mediaRoot();
    if (hit === null) return false;
    if (!this.#editor.isEditable) return false;
    const fresh = this.#findBy((node) => node === hit.node);
    const target = fresh ?? hit;
    const next = {
      ...(target.node.attrs as Record<string, unknown>),
      ...patch,
    };
    const tr = closeHistory(this.#editor.state.tr);
    tr.setNodeMarkup(target.pos, undefined, next);
    this.#editor.view.dispatch(tr);
    void this.#syncMediaViews();
    return true;
  }

  #executeMedia(id: string, value?: string): boolean | null {
    if (!id.startsWith('media.')) return null;
    const hit = this.#mediaRoot();
    if (hit === null) return false;
    const isImage = hit.node.type.name === 'imageBlock';
    if (id === 'media.details') {
      if (value === undefined) return false;
      let details: unknown;
      try {
        details = JSON.parse(value);
      } catch {
        return false;
      }
      if (details === null || typeof details !== 'object') return false;
      const fields = details as Record<string, unknown>;
      const patch: Record<string, string | null> = {};
      for (const field of ['name', 'caption', 'alt'] as const) {
        if (!(field in fields)) continue;
        if (field === 'name' && isImage) return false;
        const text = fields[field];
        if (typeof text !== 'string') return false;
        patch[field] = text === '' ? null : text;
      }
      return Object.keys(patch).length > 0 && this.#setMediaAttrs(patch);
    }
    if (id === 'media.caption' || id === 'media.alt' || id === 'media.name') {
      // Text-only: stored verbatim, rendered via textContent —
      // never interpreted as HTML. Empty submits clear the field.
      if (value === undefined) return false;
      if (isImage && id === 'media.name') return false;
      return this.#setMediaAttrs({
        [id === 'media.caption'
          ? 'caption'
          : id === 'media.alt'
            ? 'alt'
            : 'name']: value === '' ? null : value,
      });
    }
    if (id === 'media.remoteUrl') {
      // Explicit per-block opt-in: never default, always
      // validated here AND re-validated before every fetch. Refusal leaves
      // the locator untouched (outcome-before-mutation).
      if (isImage) return false;
      if (value === undefined) return false;
      const url = value.trim();
      if (!isFetchableRemoteUrl(url)) return false;
      return this.#setMediaAttrs({ remoteUrl: url });
    }
    if (id === 'media.clearRemote') {
      if (isImage) return false;
      const attrs = hit.node.attrs as Record<string, unknown>;
      if (typeof attrs['remoteUrl'] !== 'string' || attrs['remoteUrl'] === '') {
        return false;
      }
      // Refuse to orphan: without vault bytes clearing would leave neither
      // locator (invalid canonical). The vault upload must come first.
      if (typeof attrs['src'] !== 'string' || attrs['src'] === '') return false;
      return this.#setMediaAttrs({ remoteUrl: null });
    }
    if (id === 'media.retry') {
      const blockId = hit.node.attrs.blockId;
      if (typeof blockId !== 'string' || blockId === '') return false;
      // No canonical mutation: re-hydration only (no history step).
      return this.#retryMediaViews(blockId);
    }
    if (id === 'media.replace') {
      if (!this.#editor.isEditable) return false;
      const blockId = hit.node.attrs.blockId;
      if (typeof blockId !== 'string' || blockId === '') return false;
      const element = this.#rootElementFor(blockId);
      if (element === null) return false;
      const kind = hit.node.type.name.replace('Block', '');
      element.dispatchEvent(
        new CustomEvent(MEDIA_PICK_EVENT, {
          detail: { blockId, kind, capture: false },
          bubbles: true,
          cancelable: true,
        }),
      );
      return true;
    }
    return false;
  }

  // --- math/diagram blocks ---

  static readonly #MATH_DIAGRAM_NODES = new Set(['mathBlock', 'diagramBlock']);

  /**
   * Current math/diagram root, if the selection roots at exactly one
   * source atom. Multi-root ranges never resolve (media/table precedent):
   * the snapshot must not offer per-block source controls there and
   * execute must refuse instead of editing only the anchor.
   */
  #mathDiagramRoot(): { node: PMNode; pos: number; kind: string } | null {
    const current = this.#currentRoot();
    if (current === null) return null;
    if (
      !TiptapBlockpageEditorHandle.#MATH_DIAGRAM_NODES.has(
        current.node.type.name,
      )
    ) {
      return null;
    }
    if (!this.#editor.state.selection.empty && this.#touchedRootCount() > 1) {
      return null;
    }
    return {
      node: current.node,
      pos: current.pos,
      kind: current.node.type.name,
    };
  }

  /** Hydrate math/diagram previews under the host (lazy, debounced, sandboxed). */
  async #syncMathDiagramViews(): Promise<void> {
    if (this.#destroyed) return;
    try {
      await syncMathDiagramViews(this.#host, {
        ...(this.#mathDiagramObserver !== null
          ? { observer: this.#mathDiagramObserver }
          : {}),
      });
    } catch {
      // Hydration is best-effort derived content; canonical sync already ran.
    }
  }

  /** Re-run preview hydration for one block (retry control: no canonical mutation). */
  #retryMathDiagramViews(blockId: string): boolean {
    let element: Element | null = null;
    try {
      element = this.#host.querySelector(
        `figure[data-block-id="${CSS.escape(blockId)}"]`,
      );
    } catch {
      element = null;
    }
    // No matching figure under the host: nothing re-hydrated.
    if (!(element instanceof HTMLElement)) return false;
    delete element.dataset.flbpMdSig;
    void this.#syncMathDiagramViews();
    return true;
  }

  /**
   * Math/diagram semantic controls: the REQUIRED surface
   * for source edits + preview retry — no provider toolbar DOM. The source
   * input carries the live source as its value; submitting commits through
   * snapshot/execute with closing history semantics. In-place editing also
   * opens through the engine-owned textarea overlay (controller,
   *  wiring here: slash math/diagram rows, figure click/tap/Enter),
   * which commits through the same `math.source` / `diagram.source` path
   * below. Keyboard flow: slash inserts the block (standard Enter-commits /
   * Esc-dismisses overlay semantics); the source control itself follows
   * host dialog conventions (submit on confirm, cancel without mutation).
   */
  #mathDiagramControls(): ReturnType<
    DocumentEditorTools['snapshot']
  >['controls'] {
    const hit = this.#mathDiagramRoot();
    if (hit === null) return [];
    const attrs = hit.node.attrs as Record<string, unknown>;
    const source = typeof attrs['source'] === 'string' ? attrs['source'] : '';
    const isMath = hit.node.type.name === 'mathBlock';
    const sourceId = isMath ? 'math.source' : 'diagram.source';
    const editId = isMath ? 'math.edit' : 'diagram.edit';
    const retryId = isMath ? 'math.retry' : 'diagram.retry';
    return [
      {
        kind: 'button',
        id: editId,
        group: 'mathDiagram',
        label: 'Edit source',
        semanticRole: editId,
      } as ReturnType<DocumentEditorTools['snapshot']>['controls'][number],
      {
        kind: 'input',
        id: sourceId,
        group: 'mathDiagram',
        label: isMath ? 'Math source (LaTeX)' : 'Diagram source (Mermaid)',
        placeholder: '',
        actionLabel: 'Set source',
        semanticRole: sourceId,
        value: source,
      } as ReturnType<DocumentEditorTools['snapshot']>['controls'][number],
      {
        kind: 'button',
        id: retryId,
        group: 'mathDiagram',
        label: 'Retry preview',
        semanticRole: retryId,
      } as ReturnType<DocumentEditorTools['snapshot']>['controls'][number],
    ];
  }

  /**
   * Write the source attr on the current math/diagram root in one
   * closeHistory transaction (single undo). Outcome-before-mutation: the
   * root is re-resolved and the value validated (string, within the source
   * byte cap) BEFORE dispatch; refusal leaves the document untouched.
   */
  #setMathDiagramSource(patch: Record<string, unknown>): boolean {
    const hit = this.#mathDiagramRoot();
    if (hit === null) return false;
    if (!this.#editor.isEditable) return false;
    const fresh = this.#findBy((node) => node === hit.node);
    const target = fresh ?? hit;
    const tr = closeHistory(this.#editor.state.tr);
    tr.setNodeMarkup(target.pos, undefined, {
      ...(target.node.attrs as Record<string, unknown>),
      ...patch,
    });
    this.#editor.view.dispatch(tr);
    void this.#syncMathDiagramViews();
    return true;
  }

  #executeMathDiagram(id: string, value?: string): boolean | null {
    if (!id.startsWith('math.') && !id.startsWith('diagram.')) return null;
    const hit = this.#mathDiagramRoot();
    if (hit === null) return false;
    const isMath = hit.node.type.name === 'mathBlock';
    const sourceId = isMath ? 'math.source' : 'diagram.source';
    const editId = isMath ? 'math.edit' : 'diagram.edit';
    const retryId = isMath ? 'math.retry' : 'diagram.retry';
    if (id === editId) {
      const blockId = hit.node.attrs.blockId;
      return (
        typeof blockId === 'string' && this.#openMathDiagramOverlay(blockId)
      );
    }
    if (id === sourceId) {
      // Text-only: stored verbatim, rendered via textContent or
      // the text-only renderer input — never interpreted as HTML. Empty
      // submits clear to the empty-source placeholder. Over-cap submits
      // refuse without mutation (the preview could never render them).
      if (value === undefined) return false;
      if (typeof value !== 'string') return false;
      let bytes = value.length * 4;
      try {
        bytes = new TextEncoder().encode(value).byteLength;
      } catch {
        // Fall back to the estimate above.
      }
      if (bytes > MAX_MATH_DIAGRAM_SOURCE_BYTES) return false;
      return this.#setMathDiagramSource({ source: value });
    }
    if (id === retryId) {
      const blockId = hit.node.attrs.blockId;
      if (typeof blockId !== 'string' || blockId === '') return false;
      // No canonical mutation: re-hydration only (no history step).
      return this.#retryMathDiagramViews(blockId);
    }
    return false;
  }

  /** Live figure element backing one math/diagram block (overlay anchor). */
  #mathDiagramFigureFor(blockId: string): HTMLElement | null {
    const root = this.#rootElementFor(blockId);
    if (root !== null && root.tagName === 'FIGURE') return root;
    let figure: Element | null = null;
    try {
      figure = this.#host.querySelector(
        `figure[data-block-id="${CSS.escape(blockId)}"]`,
      );
    } catch {
      figure = null;
    }
    return figure instanceof HTMLElement ? figure : root;
  }

  /** Block ids of every math/diagram node in the current document. */
  #mathDiagramBlockIds(kind?: 'math' | 'diagram'): Set<string> {
    const ids = new Set<string>();
    this.#editor.state.doc.descendants((node) => {
      const name = node.type.name;
      if (name !== 'mathBlock' && name !== 'diagramBlock') return true;
      if (kind === 'math' && name !== 'mathBlock') return true;
      if (kind === 'diagram' && name !== 'diagramBlock') return true;
      const raw = node.attrs.blockId;
      if (typeof raw === 'string' && raw !== '') ids.add(raw);
      return true;
    });
    return ids;
  }

  /**
   * Open the engine-owned source overlay for one math/diagram block,
   * anchored to the live figure rect. Escape returns focus to the editor;
   * commits route through the `math.source` /
   * `diagram.source` semantic path (single closeHistory undo). Read-only
   * and unknown ids refuse without UI.
   */
  #openMathDiagramOverlay(blockId: string): boolean {
    if (!this.#editor.isEditable) return false;
    const hit = this.#findBy(
      (node) =>
        (node.type.name === 'mathBlock' || node.type.name === 'diagramBlock') &&
        node.attrs.blockId === blockId,
    );
    if (hit === null) return false;
    const kind = hit.node.type.name === 'mathBlock' ? 'math' : 'diagram';
    const attrs = hit.node.attrs as Record<string, unknown>;
    const initialSource =
      typeof attrs['source'] === 'string' ? attrs['source'] : '';
    const anchor = this.#mathDiagramFigureFor(blockId);
    try {
      this.#closeMathDiagramOverlay();
      const overlay = openMathDiagramOverlay(
        this.#host,
        anchor,
        { kind, blockId, initialSource },
        {
          onCommit: (source) =>
            this.#commitOverlaySource(blockId, kind, source),
          returnFocus: () => {
            try {
              this.#editor.commands.focus();
            } catch {
              // Focus return is best-effort (Esc path included).
            }
          },
        },
      );
      this.#mathDiagramOverlay = overlay;
      return overlay !== null;
    } catch {
      return false;
    }
  }

  /**
   * Commit overlay source through the `math.source` / `diagram.source`
   * semantic path: re-select the overlay's block, verify the selection
   * roots there, then run the shared single-undo executor — the overlay
   * can never commit to a block the caret wandered away from.
   */
  #commitOverlaySource(
    blockId: string,
    kind: 'math' | 'diagram',
    source: string,
  ): boolean {
    if (!this.#editor.isEditable) return false;
    if (!this.blockCommand('select-block', { blockId })) return false;
    const root = this.#mathDiagramRoot();
    if (root === null) return false;
    const raw = (root.node.attrs as Record<string, unknown>)['blockId'];
    if (raw !== blockId) return false;
    const sourceId = kind === 'math' ? 'math.source' : 'diagram.source';
    const outcome = this.#executeMathDiagram(sourceId, source);
    return outcome ?? false;
  }

  /** Open the overlay for a freshly slash-inserted math/diagram block. */
  #openMathDiagramOverlayForNew(
    before: ReadonlySet<string>,
    kind: 'math' | 'diagram',
  ): void {
    if (!this.#editor.isEditable) return;
    for (const id of this.#mathDiagramBlockIds(kind)) {
      if (!before.has(id)) {
        this.#openMathDiagramOverlay(id);
        return;
      }
    }
  }

  #closeMathDiagramOverlay(): void {
    this.#mathDiagramOverlay = null;
    try {
      closeMathDiagramOverlay(this.#host);
    } catch {
      // Dismiss is best-effort; teardown removes chrome below regardless.
    }
  }

  /** True while the source overlay is open (Esc handling, teardown). */
  #isMathDiagramOverlayOpen(): boolean {
    if (this.#mathDiagramOverlay !== null) {
      try {
        if (this.#mathDiagramOverlay.isOpen()) return true;
      } catch {
        // Fall through to the DOM probe below.
      }
      this.#mathDiagramOverlay = null;
    }
    try {
      return isMathDiagramOverlayOpen(this.#host);
    } catch {
      return false;
    }
  }

  /**
   * Provider-side vault ingestion (upload path):
   *
   * bytes (Uint8Array | ArrayBuffer | Blob/File-like) → cap + sniff +
   * sha256 (hash-BEFORE-preview) → `DocumentAssetStore.put`
   * (content-addressed `attachments/<sha256>`, idempotent — mirrors
   * `application/src/asset-store.ts`; the hash IS the filename so
   * identical bytes deduplicate) → one closeHistory commit of vault
   * `{src, sha256}` (upload always makes the vault canonical and clears
   * any remote opt-in; the vault flow stays the default.
   *
   * Without a bound store the same canonical `{src, sha256}` commits and
   * reads miss into the offline placeholder with retry — canonical bytes
   * stay identical (headless twin mirrors this shape). Outcome-before-
   * mutation: validation + hashing + the store write all complete BEFORE
   * any transaction; any failure returns false with no dispatch. Single
   * undo per successful upload.
   */
  async uploadMedia(
    blockId: string | null,
    source:
      | Uint8Array
      | ArrayBuffer
      | { arrayBuffer(): Promise<ArrayBuffer>; size?: number },
    options?: { readonly fileName?: string },
  ): Promise<boolean> {
    if (this.#destroyed || !this.#editor.isEditable) return false;
    // grid refusal: null-path inserts never land from a
    // grid caret (mirror #insertBlock GRID_GUARDED). Refuse before reading
    // bytes or touching the asset store, so a grid drop/paste leaves no
    // vault side effect either. The blockId path replaces by id lookup
    // (not caret-relative) and stays caret-independent.
    if (blockId === null && this.#inTableGrid(this.#editor.state)) return false;
    // Single-read reuse: convert the source ONCE, then hash
    // (prepare) and store (put) from the same bytes — File/Blob-likes pay
    // one `arrayBuffer()`, never two. Declared-size pre-check inside
    // refuses oversized File-likes before reading the body at all.
    let bytes: Uint8Array;
    try {
      bytes = await mediaSourceToBytes(source, { byteCap: MAX_MEDIA_BYTES });
    } catch {
      return false;
    }
    let prepared: Awaited<ReturnType<typeof prepareMediaBytes>>;
    try {
      prepared = await prepareMediaBytes(bytes, {
        byteCap: MAX_MEDIA_BYTES,
        ...(options?.fileName !== undefined
          ? { suggestedName: options.fileName }
          : {}),
      });
    } catch {
      return false;
    }
    // Store owns naming: commit the returned vault path + pin,
    // not the locally derived guess. The default asset-store names
    // `attachments/<sha256>` (identical by construction — pinned by the
    // byte-identity specs), but a custom store may qualify names further;
    // canonical must name what the store actually wrote. The returned
    // locator is re-validated (vault path + hex pin) BEFORE commit: a
    // rogue/buggy store returning `../../evil` refuses with no dispatch
    // instead of persisting a string that hard-bricks the next open.
    let src = prepared.src;
    let sha256 = prepared.sha256;
    if (this.#assets !== null) {
      // Grid race re-check before the vault put (orphan-window
      // narrowing): the caret may have moved into a cell during the async
      // hash above — refuse before storing bytes no block will reference.
      // A residual put→dispatch race can still store unreferenced bytes;
      // that orphan is benign (content-addressed vault entry, no model
      // mutation, no history step) and the pre-dispatch re-check below
      // still refuses the insert.
      if (blockId === null && this.#inTableGrid(this.#editor.state))
        return false;
      try {
        const stored = await this.#assets.put(bytes, {
          ...(options?.fileName !== undefined
            ? { suggestedName: options.fileName }
            : {}),
        });
        const committed = asCommittedUploadLocator(stored);
        if (committed === null) return false;
        src = committed.src;
        sha256 = committed.sha256;
      } catch {
        return false;
      }
    }
    const schema = this.#editor.schema;
    if (blockId !== null) {
      const hit = this.#findBy(
        (node) =>
          TiptapBlockpageEditorHandle.#MEDIA_NODES.has(node.type.name) &&
          node.attrs.blockId === blockId,
      );
      if (hit === null) return false;
      const tr = closeHistory(this.#editor.state.tr);
      const { remoteUrl: _drop, ...kept } = hit.node.attrs as Record<
        string,
        unknown
      >;
      void _drop;
      tr.setNodeMarkup(hit.pos, undefined, {
        ...kept,
        src,
        sha256,
        remoteUrl: null,
      });
      this.#editor.view.dispatch(tr);
      this.#syncNow();
      void this.#syncMediaViews();
      return true;
    }
    // Insert-after-current: pick the node type from the sniffed bytes
    // (image kinds → imageBlock, video → videoBlock, audio → audioBlock,
    // anything else → fileBlock). Pure builder first (outcome decided
    // before mutation), then one fused insert transaction.
    // Grid race re-check: the caret may have moved into a cell
    // during the async hash/store above — refuse before dispatch so no
    // history step lands after the table.
    if (blockId === null && this.#inTableGrid(this.#editor.state)) return false;
    const mime = prepared.mime;
    const insertType = mime.startsWith('image/')
      ? 'imageBlock'
      : mime.startsWith('video/')
        ? 'videoBlock'
        : mime.startsWith('audio/')
          ? 'audioBlock'
          : 'fileBlock';
    const nodeType = schema.nodes[insertType];
    if (nodeType === undefined) return false;
    const node = nodeType.create({
      blockId: newBlockId(),
      src,
      sha256,
      // Images are vault-only (no remote locator attr on imageBlock), so
      // the remote key is omitted on image creates rather than nulled.
      ...(insertType === 'imageBlock' ? {} : { remoteUrl: null }),
      name: null,
      caption: null,
      alt: '',
    });
    const current = this.#currentRoot();
    const insertAt = current === null ? 0 : current.pos + current.node.nodeSize;
    this.#editor.view.dispatch(
      closeHistory(this.#editor.state.tr).insert(insertAt, node as never),
    );
    this.#syncNow();
    void this.#syncMediaViews();
    return true;
  }

  /**
   * Host file ingestion: foreign drops + pastes carrying
   * File/Blob entries route into the `uploadMedia` primitive — bytes
   * → cap + sniff + sha256 → vault `{src, sha256}` — with kind inference
   * from the sniff (`uploadMedia` picks image/video/audio/file itself, so
   * the drop/paste path never guesses from extensions). One closeHistory
   * commit per file (single undo each); validation/hash/store failures
   * refuse that file with no dispatch (outcome-before-mutation) while later
   * files still ingest. Fire-and-forget by contract: plugin props are
   * synchronous, so each upload runs async and `#syncNow` picks the commit
   * up on completion.
   *
   * Single-file Add/Capture/Replace takes a different
   * path: empty-card buttons or the shared contextual toolbar dispatch
   * `flbp:pick-media`, the host-owned picker answers, and the
   * `flbp:media-picked` answer event routes into
   * `uploadMedia(blockId, firstFile)` via the constructor listener (never
   * provider toolbar DOM per — the engine never creates the
   * file input). Drops/pastes stay the multi-file ingestion path here.
   */
  async #ingestDroppedFiles(
    files: readonly UploadableFileLike[],
  ): Promise<void> {
    if (this.#destroyed || !this.#editor.isEditable) return;
    // Grid refusal: file ingestion never lands from a grid
    // caret — mirror #insertBlock GRID_GUARDED. Refuse before any async
    // work with no dispatch (no mutation, no history step). The uploadMedia
    // null branch re-checks at commit time for caret races; this entry
    // check captures the event-time caret synchronously.
    if (this.#inTableGrid(this.#editor.state)) return;
    for (const file of files) {
      try {
        const name =
          typeof file.name === 'string' && file.name !== ''
            ? file.name
            : undefined;
        await this.uploadMedia(
          null,
          file,
          ...(name !== undefined ? [{ fileName: name } as const] : []),
        );
      } catch {
        // Per-file refusal (uploadMedia already returns false without
        // mutation on validation failure; this guards unexpected throws) —
        // the next file still ingests.
      }
    }
  }

  /**
   * Creation surface: semantic insert buttons
   * for the insert-only catalog rows — table (default 2×2; pass a
   * TABLE_SIZE_PRESETS id as the execute value for 3×3/4×4), the four media
   * placeholders (invalid until `uploadMedia` replaces the locator), math /
   * diagram source atoms. Turn-into can never produce these
   * (atom rule), so `block.type` stays turn-into-only while creation
   * converges on `#insertBlock` (single undo, same guards, same catalog
   * source). No provider toolbar DOM — host-rendered semantic controls only.
   *
   * Omitted in-grid (slash-suppression precedent).
   */
  #insertControls(): ReturnType<DocumentEditorTools['snapshot']>['controls'] {
    if (this.#inTableGrid(this.#editor.state)) return [];
    const button = (
      insertType: string,
      label: string,
    ): ReturnType<DocumentEditorTools['snapshot']>['controls'][number] =>
      ({
        kind: 'button',
        id: `block.insert.${insertType}`,
        group: 'insert',
        label,
        semanticRole: `block.insert.${insertType}`,
      }) as ReturnType<DocumentEditorTools['snapshot']>['controls'][number];
    return [
      button('table', 'Insert table'),
      button('image', 'Insert image'),
      button('video', 'Insert video'),
      button('audio', 'Insert audio'),
      button('file', 'Insert file'),
      button('math', 'Insert math'),
      button('diagram', 'Insert diagram'),
    ];
  }

  /**
   * Execute one `block.insert.*` semantic control through `#insertBlock`
   * (single undo, outcome-before-mutation). Table honors a preset id value
   * (`2x2`/`3x3`/`4x4`); absent value commits the 2×2 default (the overlay
   * picker stays the slash affordance); unknown preset ids refuse without
   * mutation (precedent). Unknown insert ids refuse.
   */
  #executeInsert(id: string, value?: string): boolean | null {
    if (!id.startsWith('block.insert.')) return null;
    const insertType = id.slice('block.insert.'.length);
    if (insertType === 'table') {
      if (value === undefined) return this.#insertBlock({ type: 'table' });
      const preset = TABLE_SIZE_PRESETS.find((known) => known.id === value);
      if (preset === undefined) return false;
      return this.#insertBlock({
        type: 'table',
        rows: preset.rows,
        cols: preset.cols,
      });
    }
    switch (insertType) {
      case 'image':
      case 'video':
      case 'audio':
      case 'file':
      case 'math':
      case 'diagram':
        return this.#insertBlock({ type: insertType });
      default:
        return false;
    }
  }

  /**
   * Provider-side viewport anchor for object-bound contextual controls
   * plain viewport
   * `{x, y, width, height}` in client coordinates, mirroring the
   * ink/notebook/whiteboard `selectionViewportBounds` precedent (DOM stays
   * behind the provider seam; the shell positions `float.selection` from
   * this rect). Present exactly when the snapshot offers table, media,
   * math/diagram controls; null otherwise. A missing element
   * for a controlled block discloses once via console.warn instead
   * of silently leaving the island unmounted while diagnostics look
   * healthy — landing keeps this silent in normal mounts.
   */
  #selectionViewportBounds(): {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  } | null {
    const mathHit = this.#hoveredTableId === null ? this.#mathDiagramRoot() : null;
    const mediaHit = mathHit === null ? this.#mediaRoot() : null;
    const current =
      mathHit === null && mediaHit === null ? this.#currentRoot() : null;
    const tableHit = this.#hoveredTableId === null
      ? current !== null && current.node.type.name === 'table' ? current : null
      : this.#findBy((node) => node.type.name === 'table' && node.attrs.blockId === this.#hoveredTableId);
    let kind: string | null = null;
    let blockId: string | null = null;
    if (mathHit !== null) {
      kind = mathHit.kind;
      const raw = mathHit.node.attrs.blockId;
      blockId = typeof raw === 'string' && raw !== '' ? raw : null;
    } else if (mediaHit !== null) {
      kind = mediaHit.kind;
      const raw = mediaHit.node.attrs.blockId;
      blockId = typeof raw === 'string' && raw !== '' ? raw : null;
    } else if (tableHit !== null) {
      kind = 'table';
      const raw = tableHit.node.attrs.blockId;
      blockId = typeof raw === 'string' && raw !== '' ? raw : null;
    }
    if (kind === null || blockId === null) {
      const selection = this.#editor.state.selection;
      const { from, to } = selection;
      const touchCaret =
        from === to &&
        typeof window !== 'undefined' &&
        window.matchMedia?.('(pointer: coarse)').matches === true;
      if (
        !selection.$from.parent.isTextblock ||
        !selection.$to.parent.isTextblock ||
        (from === to && !touchCaret) ||
        this.#touchedRootCount() > 1
      )
        return null;
      try {
        const viewport = this.#host.getBoundingClientRect();
        if (from === to) {
          const block = this.#editor.view.nodeDOM(selection.$from.before());
          if (block instanceof HTMLElement) {
            const rect = block.getBoundingClientRect();
            // Empty paragraphs may report caret geometry from their widgets.
            // Their textblock still tells us whether the caret is offscreen.
            if (
              rect.height > 0 &&
              (rect.bottom < viewport.top || rect.top > viewport.bottom)
            )
              return null;
          }
        }
        const start = this.#editor.view.coordsAtPos(from);
        const end = this.#editor.view.coordsAtPos(to);
        const left = Math.min(start.left, end.left);
        const right = Math.max(start.right, end.right);
        const top = Math.min(start.top, end.top);
        const bottom = Math.max(start.bottom, end.bottom);
        // An offscreen caret must not drive shell updates on every scroll frame.
        if (bottom < viewport.top || top > viewport.bottom) return null;
        return { x: left, y: top, width: right - left, height: bottom - top };
      } catch {
        return null;
      }
    }
    // Multi-root ranges offer no per-block controls (table/media/math
    // precedent), so they carry no anchor either.
    if (this.#hoveredTableId === null && !this.#editor.state.selection.empty && this.#touchedRootCount() > 1)
      return null;
    const element = this.#rootElementFor(blockId);
    if (element === null) {
      if (!this.#anchorWarningSeen.has(blockId)) {
        this.#anchorWarningSeen.add(blockId);
        console.warn(
          `[blockpage] contextual ${kind} controls without a viewport anchor ` +
            `for block ${blockId} — the floating toolbar cannot mount there.`,
        );
      }
      return null;
    }
    let rect: { left: number; top: number; width: number; height: number };
    try {
      rect = element.getBoundingClientRect();
    } catch {
      return null;
    }
    const anchor = {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    };
    if (
      !Number.isFinite(anchor.x) ||
      !Number.isFinite(anchor.y) ||
      !Number.isFinite(anchor.width) ||
      !Number.isFinite(anchor.height)
    )
      return null;
    return anchor;
  }

  /** Edge-gated anchor notification: scroll/resize moves the rect
   * without a transaction, so the host/scroll + resize listeners below
   * notify only when the derived anchor actually changes. */
  #notifyAnchorIfMoved(): void {
    if (this.#destroyed || !this.#chromeReady) return;
    let key: string | null = null;
    try {
      const anchor = this.#selectionViewportBounds();
      key = anchor === null ? null : JSON.stringify(anchor);
    } catch {
      return;
    }
    if (key !== this.#lastAnchorKey) {
      this.#lastAnchorKey = key;
      this.#notifyTools();
    }
  }

  #watchAnchor(): void {
    let frame = 0;
    const onMove = (): void => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        this.#notifyAnchorIfMoved();
        this.#positionOpenChrome();
      });
    };
    try {
      this.#host.addEventListener('scroll', onMove, true);
    } catch {
      // Best-effort; transactions still notify.
    }
    let onResize: (() => void) | null = null;
    try {
      if (
        typeof window !== 'undefined' &&
        typeof window.addEventListener === 'function'
      ) {
        onResize = onMove;
        window.addEventListener('resize', onResize);
      }
    } catch {
      onResize = null;
    }
    this.#anchorCleanup = () => {
      cancelAnimationFrame(frame);
      try {
        this.#host.removeEventListener('scroll', onMove, true);
      } catch {
        // Best-effort teardown.
      }
      try {
        if (onResize !== null && typeof window !== 'undefined')
          window.removeEventListener('resize', onResize);
      } catch {
        // Best-effort teardown.
      }
    };
  }

  #toolSnapshot(): ReturnType<DocumentEditorTools['snapshot']> {
    // Single-source analysis: snapshot and execute converge on the same
    // inline/link/turn-into/indent rules over every touched root.
    const analysis = this.#analyzeSelection();
    const inlineAllowed = analysis.inlineFormatting;
    // Durable selector: single → actual value; mixed/unsupported → disabled
    // paragraph fallback so the <select> never claims a single type for a
    // multi-block selection or renders an invalid state.
    const typeValue =
      analysis.blockType.kind === 'single'
        ? analysis.blockType.value
        : 'paragraph';
    const turnIntoAble =
      analysis.turnInto && analysis.blockType.kind === 'single';
    const context = analysis.context;
    const markControls = !inlineAllowed
      ? []
      : (
          [
            ['block.bold', 'bold'],
            ['block.italic', 'italic'],
            ['block.strike', 'strike'],
            ['block.code', 'code'],
          ] as const
        ).map(([id, slot]) => {
          const range = analysis.marks[slot];
          return writingFormatToggleControl(id, slot, {
            ...(range.active ? { active: true } : {}),
            ...(range.mixed ? { mixed: true } : {}),
          });
        });
    const link = analysis.link;
    // Table grid ops: semantic controls are
    // the required surface — no provider-owned toolbar DOM. Present only
    // when the selection roots at the grid table; computed from live state
    // (header flag, grid geometry, caret row/column) so disabled/active
    // never lies. Cell marks keep flowing through the writing controls.
    const tableControls = this.#tableControls(analysis.nodeName);
    // Media controls: semantic caption /
    // remote / retry controls when rooted at a media atom; empty elsewhere.
    const mediaControls = this.#mediaControls();
    // Math/diagram controls:
    // semantic source / retry controls when rooted at a source atom.
    const mathDiagramControls = this.#mathDiagramControls();
    // Creation controls: semantic insert
    // buttons for the insert-only catalog rows; empty in-grid.
    const insertControls = this.#insertControls();
    // Contextual anchor: table/media/math selections
    // mount `float.selection` from this plain viewport rect (ink/notebook/
    // whiteboard precedent); absent elsewhere.
    const contextualAnchor = this.#selectionViewportBounds();
    // Compare scroll geometry with the last published selection, including
    // selections that changed through a transaction before the first scroll.
    this.#lastAnchorKey = contextualAnchor === null
      ? null
      : JSON.stringify(contextualAnchor);
    return {
      context,
      ...(contextualAnchor !== null ? { contextualAnchor } : {}),
      controls: [
        {
          kind: 'choice',
          id: 'block.type',
          group: 'block',
          label: 'Block type',
          semanticRole: 'writing.style',
          value: typeValue,
          options: turnIntoCatalogItems(this.#registry).flatMap((item) => {
            const value = turnIntoValueFor(item);
            return value === null ? [] : [{ value, label: item.label }];
          }),
          ...(turnIntoAble ? {} : { disabled: true as const }),
        },
        ...markControls,
        ...(link.applicable
          ? [
              writingLinkControl('block.link', {
                ...(link.href !== undefined ? { value: link.href } : {}),
                ...(link.active ? { active: true } : {}),
              }),
            ]
          : []),
        ...tableControls,
        ...mediaControls,
        ...mathDiagramControls,
        ...insertControls,
      ],
    };
  }

  #toggleWritingMark(
    mark: 'bold' | 'italic' | 'strike' | 'code',
    execute: () => boolean,
  ): boolean {
    const collapsed = this.#editor.state.selection.empty;
    const outcome = execute();
    if (outcome && collapsed) {
      if (this.#editor.isActive(mark)) this.#stickyMarks.add(mark);
      else this.#stickyMarks.delete(mark);
    }
    return outcome;
  }

  #syncStickyMarks(): void {
    if (this.#destroyed || this.#stickyMarks.size === 0) return;
    const state = this.#editor.state;
    if (!state.selection.empty || !this.#analyzeSelection().inlineFormatting) return;
    const marks = [...(state.storedMarks ?? state.selection.$from.marks())];
    let changed = false;
    for (const name of this.#stickyMarks) {
      const type = state.schema.marks[name];
      if (type === undefined || marks.some((mark) => mark.type === type)) continue;
      marks.push(type.create());
      changed = true;
    }
    if (changed)
      this.#editor.view.dispatch(
        state.tr.setStoredMarks(marks).setMeta('addToHistory', false),
      );
  }

  #executeTool(id: string, value?: string): boolean {
    const analysis = this.#analyzeSelection();
    if (id === 'block.type' && value !== undefined) {
      // Registry-aware derived allow-list: validation converges
      // with the snapshot options instead of a static mirror.
      if (!turnIntoValuesFor(this.#registry).has(value)) return false;
      // Converge with the snapshot: only single compatible selections expose
      // turn-into; mixed/unsupported never silently turn just the anchor.
      if (!analysis.turnInto || analysis.blockType.kind !== 'single')
        return false;
      if (value === 'bullet' || value === 'ordered' || value === 'todo')
        return this.#turnIntoList(value);
      const [type, rawLevel] = value.split(':');
      return this.#turnInto({
        type,
        ...(rawLevel !== undefined ? { level: Number(rawLevel) } : {}),
      });
    }
    // Guard disabled-context transforms through execute, not just the UI:
    // code/special/mixed contexts omit controls, but programmatic calls must
    // also refuse rather than produce surprising ProseMirror transactions.
    // Uses the same single-source analysis as the snapshot.
    const inlineAllowed = analysis.inlineFormatting;
    if (
      (id === 'block.bold' ||
        id === 'block.italic' ||
        id === 'block.strike' ||
        id === 'block.code') &&
      !inlineAllowed
    )
      return false;
    if (id === 'block.bold')
      return this.#toggleWritingMark('bold', () => this.#editor.chain().focus().toggleBold().run());
    if (id === 'block.italic')
      return this.#toggleWritingMark('italic', () => this.#editor.chain().focus().toggleItalic().run());
    if (id === 'block.strike')
      return this.#toggleWritingMark('strike', () => this.#editor.chain().focus().toggleStrike().run());
    if (id === 'block.code')
      return this.#toggleWritingMark('code', () => this.#editor.chain().focus().toggleCode().run());
    if (id === 'block.link') {
      if (value === undefined || !isValidBlockLinkDestination(value))
        return false;
      if (!inlineAllowed) return false;
      const href = value.trim();
      const link = analysis.link;
      if (!link.applicable) return false;
      // Caret inside an existing link: update that link's destination in
      // place so the label is untouched and focus returns to the editor.
      // Unknown marks on the same range survive: only the old link payload
      // is removed, everything else is preserved.
      if (this.#editor.state.selection.empty && link.href !== undefined) {
        const range = this.#linkRangeAtCaret(link.href);
        const commands = this.#editor.commands as unknown as Record<
          string,
          ((arg: unknown) => boolean) | undefined
        >;
        if (typeof commands.setLink === 'function') {
          // Native link path: extend to the full mark range first.
          try {
            return this.#editor
              .chain()
              .focus()
              .extendMarkRange('link')
              .setLink({ href })
              .run();
          } catch {
            // Fall through to the extMark transaction below.
          }
        }
        if (range !== null) {
          const extType = this.#editor.state.schema.marks['extMark'];
          if (extType !== undefined) {
            if (href === link.href) {
              this.#editor.commands.focus();
              return true;
            }
            const oldJson = JSON.stringify({ type: 'link', href: link.href });
            const nextMark = extType.create({
              name: 'link',
              json: JSON.stringify({ type: 'link', href }),
            });
            // Replace only the old link payload per text node so unknown
            // extMarks on the same range survive. Text nodes cannot use
            // setNodeMarkup, so remove all extMarks per node then re-add
            // the preserved unknowns plus the new link. Bare marks
            // (bold/italic/...) are a different type and survive removeMark.
            const edits: Array<{
              pos: number;
              size: number;
              kept: readonly (typeof nextMark)[];
            }> = [];
            this.#editor.state.doc.nodesBetween(
              range.from,
              range.to,
              (node, pos) => {
                if (!node.isText) return;
                const hasOld = node.marks.some(
                  (mark) =>
                    mark.type === extType &&
                    (mark.attrs as { name?: unknown }).name === 'link' &&
                    (mark.attrs as { json?: unknown }).json === oldJson,
                );
                if (!hasOld) return;
                const kept = node.marks.filter(
                  (mark) =>
                    !(
                      mark.type === extType &&
                      (mark.attrs as { name?: unknown }).name === 'link'
                    ) && mark.type === extType,
                );
                edits.push({ pos, size: node.nodeSize, kept });
              },
            );
            if (edits.length === 0) return false;
            const tr = this.#editor.state.tr;
            for (const edit of edits) {
              tr.removeMark(edit.pos, edit.pos + edit.size, extType);
              for (const keptMark of edit.kept)
                tr.addMark(edit.pos, edit.pos + edit.size, keptMark);
              tr.addMark(edit.pos, edit.pos + edit.size, nextMark);
            }
            this.#editor.view.dispatch(tr);
            this.#editor.commands.focus();
            return true;
          }
        }
      }
      const commands = this.#editor.commands as unknown as Record<
        string,
        ((arg: unknown) => boolean) | undefined
      >;
      if (typeof commands.setLink === 'function') {
        return this.#editor.chain().focus().setLink({ href }).run();
      }
      return this.#editor
        .chain()
        .focus()
        .setMark('extMark', {
          name: 'link',
          json: JSON.stringify({ type: 'link', href }),
        })
        .run();
    }
    // Creation controls: semantic insert buttons converge with the
    // snapshot through #insertBlock (in-grid refuses); unknown insert ids
    // refuse without mutation.
    if (id.startsWith('block.insert.')) {
      const outcome = this.#executeInsert(id, value);
      return outcome ?? false;
    }
    // Table grid ops: semantic controls only; programmatic calls
    // converge with the snapshot (off-grid refuses, edges refuse).
    if (id.startsWith('table.')) return this.#tableOp(id, value);
    // Media controls: converge with the snapshot; off-media refuses.
    if (id.startsWith('media.')) {
      const outcome = this.#executeMedia(id, value);
      return outcome ?? false;
    }
    // Math/diagram controls: converge with the snapshot;
    // off-atom refuses without mutation.
    if (id.startsWith('math.') || id.startsWith('diagram.')) {
      const outcome = this.#executeMathDiagram(id, value);
      return outcome ?? false;
    }
    return false;
  }

  /** Structured command channel for Block Page interactions. */
  blockCommand(id: string, arg?: unknown): boolean {
    switch (id) {
      case 'turn-into':
        return this.#turnInto((arg ?? {}) as { type?: string; level?: number });
      case 'insert-block':
        return this.#insertBlock(
          (arg ?? {}) as {
            type?: string;
            typeId?: string;
            target?: ResourceTarget;
            label?: string;
            viewId?: string;
            rows?: number;
            cols?: number;
          },
        );
      case 'move-block':
        return this.#moveBlock(
          (arg ?? {}) as { blockId?: string; index?: number },
        );
      case 'move-block-under':
        return this.#moveBlockUnder(
          (arg ?? {}) as { blockId?: string; parentId?: string },
        );
      case 'toggle-collapse':
        return this.#toggleCollapse((arg ?? {}) as { target?: string });
      case 'set-item-checked':
        return this.#setItemChecked(
          Boolean((arg as { value?: boolean } | undefined)?.value),
        );
      case 'clear-selection':
        this.#editor.commands.setTextSelection(
          this.#editor.state.selection.head,
        );
        return true;
      // Programmatic text insertion routed through the REAL typing pipeline
      // (handleTextInput props → input rules), like a physical keyboard.
      case 'insert-text': {
        const text = String(
          (arg as { text?: unknown } | undefined)?.text ?? '',
        );
        if (text === '') return true;
        const { view } = this.#editor;
        const { from, to } = view.state.selection;
        let handled = false;
        // Mirror ProseMirror's physical typing path: someProp stops at the
        // first handler that claims the input. Without the early return a
        // doc-shrinking rule (code fence, divider) dispatches mid-iteration
        // and later plugins resolve the stale caret against the smaller
        // document (RangeError). (probe: '```js ' + space crashed here.)
        view.someProp('handleTextInput', (handler) => {
          handled =
            handler(view, from, to, text, () =>
              view.state.tr.insertText(text, from, to),
            ) || handled;
          return handled;
        });
        if (!handled) view.dispatch(view.state.tr.insertText(text, from, to));
        return true;
      }
      case 'select-block': {
        // Test-only channel: focus one keyed block (atoms like
        // image/video/audio/file need a NodeSelection; production UI moves
        // selection via the editor). Refuses unknown ids without mutation.
        const wanted = (arg ?? {}) as { blockId?: unknown };
        if (typeof wanted.blockId !== 'string' || wanted.blockId === '') {
          return false;
        }
        const hit = this.#findBy(
          (node) => this.#keyOf(node) === wanted.blockId,
        );
        if (hit === null) return false;
        try {
          const resolved = this.#editor.state.doc.resolve(hit.pos);
          let selection;
          try {
            selection = new NodeSelection(resolved);
          } catch {
            selection = TextSelection.near(resolved);
          }
          this.#editor.view.dispatch(
            this.#editor.state.tr.setSelection(selection),
          );
        } catch {
          return false;
        }
        return true;
      }
      case 'set-selection': {
        const range = (arg ?? {}) as { from?: number; to?: number };
        const doc = this.#editor.state.doc;
        const from = Math.max(0, Math.min(range.from ?? 0, doc.content.size));
        const to = Math.max(from, Math.min(range.to ?? from, doc.content.size));
        try {
          this.#editor.view.dispatch(
            this.#editor.state.tr.setSelection(
              TextSelection.create(doc, from, to),
            ),
          );
        } catch {
          // Atom/special contexts (divider, image, composition, the table
          // grid root) may lack a text offset for a TextSelection — fall
          // back to a node selection so toolbar snapshots can observe the
          // special context.
          // Test-only channel; production UI moves selection via the editor.
          const resolved = (() => {
            try {
              return doc.resolve(from);
            } catch {
              return null;
            }
          })();
          if (resolved === null) return false;
          this.#editor.view.dispatch(
            this.#editor.state.tr.setSelection(new NodeSelection(resolved)),
          );
        }
        return true;
      }
      default:
        return false;
    }
  }

  getModelForTest(): BlockPageModel {
    this.#syncNow();
    return cloneModel(this.#latestModel);
  }

  applyDocumentMetadata(meta: BlockPageModel['meta']): void {
    this.#latestModel.meta = meta;
  }

  destroy(): void {
    this.#destroyed = true;
    this.#clearRevealHighlight();
    this.#closeMathDiagramOverlay();
    try {
      this.#anchorCleanup?.();
    } catch {
      // Best-effort teardown.
    }
    this.#anchorCleanup = null;
    try {
      this.#mediaPickedCleanup?.();
    } catch {
      // Best-effort teardown.
    }
    this.#mediaPickedCleanup = null;
    for (const presentation of this.#presentations.values())
      presentation.dispose();
    this.#presentations.clear();
    this.#compositionSnapshots.clear();
    this.#compositionRecords.clear();
    // Unmount first so React cleanly removes the skeleton it owns; the
    // engine teardown below then runs against detached nodes (its own
    // host.remove() becomes a harmless no-op). Reversing the order yanks
    // React-managed DOM out from under the root and corrupts teardown.
    this.#root.unmount();
    this.#compositionObserver?.disconnect();
    this.#mediaObserver?.disconnect();
    this.#mathDiagramObserver?.disconnect();
    // Pending debounced preview renders must never fire past teardown.
    try {
      cancelMathDiagramRenders(this.#host);
    } catch {
      // Best-effort teardown.
    }
    // Runtime-only blob: URLs must never leak past the editor lifetime (and
    // never reach canonical bytes — they live on element properties only).
    try {
      revokeMediaBlobUrls(this.#host);
    } catch {
      // Best-effort teardown.
    }
    for (const controller of this.#compositionControllers.values())
      controller.dispose();
    this.#compositionControllers.clear();
    this.#hoverEvents.abort();
    cancelAnimationFrame(this.#hoverFrame);
    this.#blockDrag?.destroy();
    this.#editor.destroy();
    this.#host.querySelector('.flbp-turninto-menu')?.remove();
    this.#host.querySelector('.flbp-slash')?.remove();
    this.#host.querySelector('.flbp-drag-handle')?.remove();
    this.#host.remove();
    if (
      this.#container !== this.#host &&
      this.#container.classList.contains('flbp-fallback-host')
    ) {
      this.#container.remove();
    }
    this.#toolListeners.clear();
  }

  // --- canonical sync ---

  #syncNow(): void {
    const document = this.#editor.state.doc;
    if (document === this.#lastDocument) return;
    const base = this.#latestModel;
    let model: BlockPageModel | null = null;
    // ProseMirror nodes are immutable. Ordinary text edits retain every
    // untouched sibling, so only changed leaf blocks need canonical decoding.
    // Structural edits use the complete preservation-aware converter below.
    // Grid cell edits intentionally take the full-decode path: a
    // changed `table` node carries no per-cell identity (blockId lives at
    // the table level), so there is no leaf allowlist entry that could stay
    // correct — the table allowlist is empty by design, never an omission.
    const previous = this.#lastDocument;
    if (previous && previous.childCount === document.childCount) {
      const changed: PMNode[] = [];
      let leavesOnly = true;
      this.#syncStats.blocksVisited += document.childCount;
      for (let index = 0; index < document.childCount; index++) {
        const node = document.child(index);
        const old = previous.child(index);
        if (node === old) continue;
        const id = node.attrs.blockId;
        if (
          !['paragraph', 'heading', 'codeBlock'].includes(node.type.name) ||
          node.type !== old.type ||
          !id ||
          id !== old.attrs.blockId ||
          !this.#latestModel.blocks[id]
        ) {
          leavesOnly = false;
          break;
        }
        changed.push(node);
      }
      if (leavesOnly) {
        this.#syncStats.blocksDecoded += changed.length;
        const decoded = pmDocToModel(
          { type: 'doc', content: changed.map((node) => node.toJSON()) },
          base,
        );
        // Changed leaves cannot be grid cells or column internals. The table
        // allowlist is intentionally empty; column regions take the full
        // decode path because no leaf allowlist entry can remain correct.
        // Drain warnings uniformly rather than swallowing them.
        this.#reportStructuralWarnings(decoded.warnings);
        const updates = decoded.model.blocks;
        model = {
          ...this.#latestModel,
          blocks: { ...this.#latestModel.blocks, ...updates },
        };
      }
    }
    if (model === null) this.#syncStats.fullDecodes += 1;
    if (model === null) {
      const decoded = pmDocToModel(this.#editor.getJSON(), base);
      this.#reportStructuralWarnings(decoded.warnings);
      model = decoded.model;
    }
    this.#lastDocument = document;
    this.#latestModel = model;
    // Canonical records are immutable values. Share unchanged records across
    // snapshots rather than JSON-cloning the entire page on every keystroke.
    // The maps/order remain fresh so consumers can install the snapshot in
    // their session without mutating this handle's containers.
    this.#input.onDirtyModel({
      ...model,
      rootOrder: [...model.rootOrder],
      blocks: { ...model.blocks },
    });
  }

  // --- structured commands ---

  #run(name: string, ...args: unknown[]): boolean {
    const commands = this.#editor.commands as unknown as Record<
      string,
      (...a: unknown[]) => boolean
    >;
    const command = commands[name];
    return typeof command === 'function'
      ? command.call(this.#editor.commands, ...args)
      : false;
  }

  #findBy(predicate: (node: PMNode) => boolean): BlockHit | null {
    let hit: BlockHit | null = null;
    this.#editor.state.doc.descendants((node, pos, parent) => {
      if (hit !== null) return false;
      if (predicate(node))
        hit = { node, pos, parent: parent ?? this.#editor.state.doc };
      return hit === null;
    });
    return hit;
  }

  #currentRoot(): { node: PMNode; pos: number } | null {
    const selection = this.#editor.state.selection as unknown as {
      readonly node?: PMNode;
      readonly from?: number;
      readonly $from: {
        depth: number;
        node(depth: number): PMNode;
        before(depth: number): number;
      };
    };
    // Atom/special contexts surface as node selections (divider, image,
    // composition, or the table grid root): report the selected node
    // directly so snapshots suppress inline controls through provider data.
    // Duck-type instead of
    // `instanceof` so duplicate prosemirror-state copies cannot break it.
    if (
      selection.node !== undefined &&
      typeof selection.from === 'number' &&
      typeof selection.node.type?.name === 'string'
    ) {
      return { node: selection.node, pos: selection.from };
    }
    const { $from } = selection;
    let documentChild: { node: PMNode; pos: number } | null = null;
    for (let depth = $from.depth; depth >= 1; depth -= 1) {
      if (this.#keyOf($from.node(depth)) !== null) {
        return { node: $from.node(depth), pos: $from.before(depth) };
      }
      if ($from.node(depth - 1).type.name === 'doc') {
        documentChild = { node: $from.node(depth), pos: $from.before(depth) };
      }
    }
    return documentChild;
  }

  #textOf(node: PMNode): string {
    const texts: string[] = [];
    node.descendants((child) => {
      if (child.isText) texts.push(child.text ?? '');
    });
    return texts.join('\n');
  }

  #turnInto(
    arg: { type?: string; level?: number },
    trigger?: SlashTrigger,
  ): boolean {
    // List-family destinations reuse the toggle path (same as slash catalog
    // bullet/ordered/todo rows): outcome-before-mutation guards first, then
    // one fused chain. Handles both slash (trigger) and toolbar/handle
    // (no trigger) callers so all three surfaces converge.
    if (
      arg.type === 'bullet' ||
      arg.type === 'ordered' ||
      arg.type === 'todo'
    ) {
      if (trigger !== undefined) {
        // Slash fused path: validate on the pre-commit state, then delete
        // the trigger and toggle in one chain (one undo step). Reuse the
        // existing slash list commits which already fuse correctly.
        const listType = arg.type === 'ordered' ? 'orderedList' : 'bulletList';
        if (!this.#slashToggleRangeValid()) return false;
        if (arg.type === 'todo') {
          const { $from, empty } = this.#editor.state.selection;
          if (!empty || !$from.parent.isTextblock) return false;
          if ($from.parent.type.name === 'codeBlock') return false;
          if (this.#slashToggleWouldLift('bulletList')) return false;
          return this.#editor
            .chain()
            .command(({ tr }) => {
              closeHistory(tr);
              if (trigger.end > trigger.start)
                tr.delete(trigger.start, trigger.end);
              return true;
            })
            .toggleBulletList()
            .command(({ tr }) => this.#stampListIdAroundCaret(tr))
            .command(({ tr }) => this.#stripInnerParagraphIds(tr))
            .command(({ tr }) => this.#checkTodoItem(tr))
            .command(({ tr }) => this.#focusListAroundCaret(tr))
            .run();
        }
        const fused = this.#editor.chain().command(({ tr }) => {
          closeHistory(tr);
          if (trigger.end > trigger.start)
            tr.delete(trigger.start, trigger.end);
          return true;
        });
        const toggled =
          listType === 'bulletList'
            ? fused.toggleBulletList()
            : fused.toggleOrderedList();
        return toggled
          .command(({ tr }) => this.#stampListIdAroundCaret(tr))
          .command(({ tr }) => this.#stripInnerParagraphIds(tr))
          .command(({ tr }) => this.#focusListAroundCaret(tr))
          .run();
      }
      return this.#turnIntoList(arg.type);
    }
    const current = this.#currentRoot();
    if (current === null || arg.type === undefined) return false;
    // Single-root guard (converges with the toolbar snapshot, which only
    // exposes turn-into for single compatible selections): a range spanning
    // multiple keyed roots rejects instead of silently turning the anchor.
    if (!this.#editor.state.selection.empty && this.#touchedRootCount() > 1)
      return false;
    // Turn-into preserves content: only text-container sources participate.
    // Atoms, media, math/diagram blocks, composition, groups, and opaque
    // nodes refuse conversion rather than dropping payload. Table grids
    // refuse as both sources and targets because cells have no single
    // text-container mapping. Lists route through
    // #turnIntoList above; reaching here from a list source with a non-list
    // target unwraps single-item lists to paragraph first (see below).
    const sourceName = current.node.type.name;
    const isListSource =
      sourceName === 'bulletList' || sourceName === 'orderedList';
    if (isListSource) {
      // list-source policy: a list unwraps to paragraph — one
      // paragraph per item, each item's inline content (text/marks) preserved
      // via its first paragraph fragment with fresh paragraph ids by design
      // (inner list paragraphs carry no blockId, same as input-rule list
      // creation); nested blocks ride as trailing siblings so nothing is
      // dropped (see #turnListIntoParagraph). Non-paragraph targets reject
      // without mutation. List-to-list conversions route through
      // #turnIntoList above and never reach here.
      if (arg.type !== 'paragraph') return false;
      return this.#turnListIntoParagraph(current);
    }
    const turnable =
      sourceName === 'paragraph' ||
      sourceName === 'heading' ||
      sourceName === 'blockquote' ||
      sourceName === 'codeBlock' ||
      sourceName === 'toggle' ||
      sourceName === 'callout';
    if (!turnable) return false;
    if (trigger !== undefined) {
      // Fused slash commit: every guard above already passed on
      // the pre-commit state, so the outcome is decided before any mutation.
      // Trigger deletion + replacement share one transaction (one undo step,
      // same #insertPasteLines pattern): delete first, rebuild the
      // replacement from the trigger-free node, replace in the same tr.
      // closeHistory starts a fresh undo group: without it the commit merges
      // with the adjacent trigger typing (history newGroupDelay), and one
      // undo would rewind past the trigger instead of restoring it.
      const tr = closeHistory(this.#editor.state.tr);
      if (trigger.end > trigger.start) tr.delete(trigger.start, trigger.end);
      const mpos = tr.mapping.map(current.pos);
      const fresh = tr.doc.nodeAt(mpos);
      if (fresh === null) return false;
      const built = this.#buildTurnIntoReplacement(fresh, arg);
      if (built === null) return false;
      tr.replaceWith(
        mpos,
        mpos + fresh.nodeSize,
        Fragment.fromArray([built.replacement, ...built.trailing]),
      );
      this.#editor.view.dispatch(tr);
      return true;
    }
    const built = this.#buildTurnIntoReplacement(current.node, arg);
    if (built === null) return false;
    // Single undoable transaction: source range becomes replacement plus
    // any preserved tail siblings (leaf targets) — no drops, one history step.
    // closeHistory opens a fresh undo group (same as the fused slash path and
    // #turnIntoList): without it the turn-into merges with adjacent typing
    // into one undo step. The caret stays in the turned block:
    // without an explicit selection the mapped caret can land in the
    // StarterKit trailing paragraph on same-shape replaces
    // (heading->heading), leaving the toolbar describing the wrong block.
    // Setting it in the same tr adds no history step.
    const tr = closeHistory(this.#editor.state.tr).replaceWith(
      current.pos,
      current.pos + current.node.nodeSize,
      Fragment.fromArray([built.replacement, ...built.trailing]),
    );
    try {
      const inside = tr.doc.resolve(
        Math.min(current.pos + 1, tr.doc.content.size),
      );
      tr.setSelection(TextSelection.near(inside));
    } catch {
      // Best-effort: the replacement itself already committed above.
    }
    this.#editor.view.dispatch(tr);
    return true;
  }

  /**
   * List-family turn-into for toolbar/handle paths (no slash trigger).
   * Uses the real Tiptap toggle commands in one chain (one undo step) so
   * outcomes converge with the slash catalog rows. Outcome-before-
   * mutation: guards refuse before any dispatch; Tiptap toggle failure
   * (e.g. invalid wrapping) also leaves the document untouched.
   */
  #turnIntoList(kind: 'bullet' | 'ordered' | 'todo'): boolean {
    const current = this.#currentRoot();
    if (current === null) return false;
    if (!this.#editor.state.selection.empty && this.#touchedRootCount() > 1)
      return false;
    const sourceName = current.node.type.name;
    const allowed =
      sourceName === 'paragraph' ||
      sourceName === 'heading' ||
      sourceName === 'blockquote' ||
      sourceName === 'codeBlock' ||
      sourceName === 'toggle' ||
      sourceName === 'callout' ||
      sourceName === 'bulletList' ||
      sourceName === 'orderedList';
    if (!allowed) return false;
    // Code content must never become a to-do (same as the slash path):
    // the toggle would destroy code semantics on decode.
    if (sourceName === 'codeBlock' && kind === 'todo') return false;
    if (kind === 'bullet') {
      if (sourceName === 'bulletList') {
        // Plain bullets are a no-op; todos unmark in one transaction.
        if (!this.#listHasChecked(current.node)) return true;
        return this.#setWholeListChecked(current, null);
      }
      return this.#editor
        .chain()
        .command(({ tr }) => {
          closeHistory(tr);
          return true;
        })
        .toggleBulletList()
        .command(({ tr }) => this.#stampListIdAroundCaret(tr))
        .command(({ tr }) => this.#stripInnerParagraphIds(tr))
        .command(({ tr }) => this.#focusListAroundCaret(tr))
        .run();
    }
    if (kind === 'ordered') {
      if (sourceName === 'orderedList') return true;
      // Ordered todos are not a thing: clear converted checked marks in the
      // same chain (same undo step), only when the source carried any.
      const hadChecked =
        sourceName === 'bulletList' && this.#listHasChecked(current.node);
      return this.#editor
        .chain()
        .command(({ tr }) => {
          closeHistory(tr);
          return true;
        })
        .toggleOrderedList()
        .command(({ tr }) => this.#stampListIdAroundCaret(tr))
        .command(({ tr }) => this.#stripInnerParagraphIds(tr))
        .command(({ tr }) => {
          if (hadChecked) this.#clearCheckedAroundCaret(tr);
          return true;
        })
        .command(({ tr }) => this.#focusListAroundCaret(tr))
        .run();
    }
    // kind === 'todo'
    if (sourceName === 'bulletList') {
      if (this.#listAllChecked(current.node)) return true;
      return this.#setWholeListChecked(current, false);
    }
    if (sourceName === 'orderedList') {
      return this.#editor
        .chain()
        .command(({ tr }) => {
          closeHistory(tr);
          return true;
        })
        .toggleBulletList()
        .command(({ tr }) => this.#stampListIdAroundCaret(tr))
        .command(({ tr }) => this.#stripInnerParagraphIds(tr))
        .command(({ tr }) => this.#markWholeListTodo(tr))
        .command(({ tr }) => this.#focusListAroundCaret(tr))
        .run();
    }
    if (!this.#slashToggleRangeValid()) return false;
    if (this.#slashToggleWouldLift('bulletList')) return false;
    return this.#editor
      .chain()
      .command(({ tr }) => {
        closeHistory(tr);
        return true;
      })
      .toggleBulletList()
      .command(({ tr }) => this.#stampListIdAroundCaret(tr))
      .command(({ tr }) => this.#stripInnerParagraphIds(tr))
      .command(({ tr }) => this.#checkTodoItem(tr))
      .command(({ tr }) => this.#focusListAroundCaret(tr))
      .run();
  }

  /**
   * Stamp a fresh listId on the caret's owning list when it lacks one.
   * Tiptap toggles create bare lists (null id, like the older slash
   * path); without an id the snapshot falls back to the inner paragraph and
   * the toolbar misreports the new list. Scoped to the caret's list only so
   * unrelated null-id lists elsewhere keep their identity. Always returns
   * true so the chain continues (missing list = toggle already failed and
   * reports through the chain result).
   */
  #stampListIdAroundCaret(tr: Transaction): boolean {
    const $c = tr.selection.$from;
    for (let depth = $c.depth; depth >= 0; depth -= 1) {
      const node = $c.node(depth);
      if (node.type.name !== 'bulletList' && node.type.name !== 'orderedList')
        continue;
      const raw = node.attrs.listId;
      if (typeof raw === 'string' && raw !== '') return true;
      const sourcePreserved = $c.parent.attrs.preserved;
      tr.setNodeMarkup($c.before(depth), undefined, {
        ...node.attrs,
        listId: newBlockId(),
        ...(sourcePreserved === null || sourcePreserved === undefined
          ? {}
          : { preserved: sourcePreserved }),
      });
      return true;
    }
    return true;
  }

  /**
   * Keep the caret inside the caret's owning list (same reasoning as the
   * #turnInto caret fix): Tiptap toggles can leave the mapped caret in the
   * StarterKit trailing paragraph, so the toolbar would describe the wrong
   * block. In-chain, adds no history step. Always true so the chain continues.
   */
  #focusListAroundCaret(tr: Transaction): boolean {
    const $c = tr.selection.$from;
    for (let depth = $c.depth; depth >= 0; depth -= 1) {
      const node = $c.node(depth);
      if (node.type.name !== 'bulletList' && node.type.name !== 'orderedList')
        continue;
      try {
        const inside = tr.doc.resolve(
          Math.min($c.before(depth) + 2, tr.doc.content.size),
        );
        tr.setSelection(TextSelection.near(inside));
      } catch {
        // Best-effort.
      }
      return true;
    }
    return true;
  }

  /** Clear every checked mark on the caret's owning list, in-transaction. */
  #clearCheckedAroundCaret(tr: Transaction): void {
    const $c = tr.selection.$from;
    for (let depth = $c.depth; depth >= 0; depth -= 1) {
      const node = $c.node(depth);
      if (node.type.name !== 'bulletList' && node.type.name !== 'orderedList')
        continue;
      const listPos = $c.before(depth);
      const listSize = node.nodeSize;
      const edits: Array<{ pos: number; attrs: Record<string, unknown> }> = [];
      tr.doc.descendants((child, pos) => {
        if (
          child.type.name === 'listItem' &&
          pos >= listPos &&
          pos < listPos + listSize &&
          child.attrs.checked !== null &&
          child.attrs.checked !== undefined
        ) {
          edits.push({ pos, attrs: { ...child.attrs, checked: null } });
        }
        return true;
      });
      for (const edit of edits)
        tr.setNodeMarkup(edit.pos, undefined, edit.attrs);
      return;
    }
  }

  /** Clear the source paragraph ID after wrapping it as an item's summary.
   * Later keyed paragraphs are owned child blocks and retain their identity.
   */
  #stripInnerParagraphIds(tr: Transaction): boolean {
    const $c = tr.selection.$from;
    for (let depth = $c.depth; depth >= 0; depth -= 1) {
      const node = $c.node(depth);
      if (node.type.name !== 'bulletList' && node.type.name !== 'orderedList')
        continue;
      const listPos = $c.before(depth);
      const edits: Array<{ pos: number; attrs: Record<string, unknown> }> = [];
      let itemPos = listPos + 1;
      const items: PMNode[] = [];
      node.forEach((item) => items.push(item));
      for (const item of items) {
        if (item.type.name === 'listItem') {
          let kidPos = itemPos + 1;
          const kids: PMNode[] = [];
          item.forEach((kid) => kids.push(kid));
          for (const kid of kids) {
            if (
              kid === item.firstChild &&
              kid.type.name === 'paragraph' &&
              typeof kid.attrs.blockId === 'string' &&
              kid.attrs.blockId !== ''
            ) {
              edits.push({
                pos: kidPos,
                attrs: { ...kid.attrs, blockId: null },
              });
            }
            kidPos += kid.nodeSize;
          }
        }
        itemPos += item.nodeSize;
      }
      for (const edit of edits)
        tr.setNodeMarkup(edit.pos, undefined, edit.attrs);
      return true;
    }
    return true;
  }

  /** True when any listItem under the list carries a to-do checked mark. */
  #listHasChecked(list: PMNode): boolean {
    let found = false;
    list.descendants((child) => {
      if (found) return false;
      if (
        child.type.name === 'listItem' &&
        (child.attrs.checked === true || child.attrs.checked === false)
      )
        found = true;
      return !found;
    });
    return found;
  }

  /** True when every listItem under the list carries a checked mark. */
  #listAllChecked(list: PMNode): boolean {
    let all = true;
    let count = 0;
    list.descendants((child) => {
      if (child.type.name !== 'listItem') return true;
      count += 1;
      if (child.attrs.checked !== true && child.attrs.checked !== false)
        all = false;
      return true;
    });
    return count > 0 && all;
  }

  /**
   * Set every listItem checked mark under the hit list in one transaction
   * (one undo step). `value` null clears todos back to plain bullets;
   * false marks a plain list as todo (existing true marks preserved).
   */
  #setWholeListChecked(
    hit: { node: PMNode; pos: number },
    value: boolean | null,
  ): boolean {
    const tr = closeHistory(this.#editor.state.tr);
    let changed = false;
    const edits: Array<{ pos: number; attrs: Record<string, unknown> }> = [];
    tr.doc.descendants((node, pos) => {
      if (
        node.type.name === 'listItem' &&
        pos >= hit.pos &&
        pos < hit.pos + hit.node.nodeSize
      ) {
        const current = node.attrs.checked as unknown;
        if (value === null ? current !== null : current === null) {
          edits.push({
            pos,
            attrs: { ...node.attrs, checked: value },
          });
        }
      }
      return true;
    });
    if (edits.length === 0) return true;
    for (const edit of edits) {
      tr.setNodeMarkup(edit.pos, undefined, edit.attrs);
      changed = true;
    }
    if (!changed) return true;
    this.#editor.view.dispatch(tr);
    return true;
  }

  /** Mark every unchecked listItem around the chain caret as todo. */
  #markWholeListTodo(tr: Transaction): boolean {
    const $c = tr.selection.$from;
    for (let depth = $c.depth; depth >= 0; depth -= 1) {
      if ($c.node(depth).type.name !== 'listItem') continue;
      // Found the caret item: expand to the owning list and mark all.
      for (let up = depth; up >= 0; up -= 1) {
        const ancestor = $c.node(up);
        if (
          ancestor.type.name !== 'bulletList' &&
          ancestor.type.name !== 'orderedList'
        )
          continue;
        const listPos = $c.before(up);
        const edits: Array<{ pos: number; attrs: Record<string, unknown> }> =
          [];
        tr.doc.descendants((node, pos) => {
          if (
            node.type.name === 'listItem' &&
            pos >= listPos &&
            pos < listPos + ancestor.nodeSize
          ) {
            if (
              node.attrs.checked === null ||
              node.attrs.checked === undefined
            ) {
              edits.push({
                pos,
                attrs: { ...node.attrs, checked: false },
              });
            }
          }
          return true;
        });
        for (const edit of edits) {
          tr.setNodeMarkup(edit.pos, undefined, edit.attrs);
        }
        return true;
      }
      return true;
    }
    return false;
  }

  /**
   * Unwrap a list into one paragraph per item in a single transaction
   * (single undo). Item inline content (text+runs+marks) is preserved via
   * the item's first paragraph fragment; nested blocks ride as trailing
   * siblings so nothing is dropped. Fresh paragraph ids by design (inner
   * list paragraphs carry no blockId, same as input-rule list creation).
   */
  #turnListIntoParagraph(hit: { node: PMNode; pos: number }): boolean {
    const node = hit.node;
    if (node.type.name !== 'bulletList' && node.type.name !== 'orderedList')
      return false;
    const schema = this.#editor.schema;
    const paragraphType = schema.nodes.paragraph;
    if (paragraphType === undefined) return false;
    const items: PMNode[] = [];
    node.forEach((child) => {
      if (child.type.name === 'listItem') items.push(child);
    });
    if (items.length === 0) return false;
    const out: PMNode[] = [];
    for (const [itemIndex, item] of items.entries()) {
      const kids: PMNode[] = [];
      item.forEach((child) => kids.push(child));
      const firstPara = kids.find((kid) => kid.type.name === 'paragraph');
      const rest = kids.filter((kid) => kid !== firstPara);
      const inline =
        firstPara !== undefined ? firstPara.content : Fragment.empty;
      const blockAttrs = {
        blockId: newBlockId(),
        ...(itemIndex === 0 && node.attrs.preserved !== null
          ? { preserved: node.attrs.preserved }
          : {}),
      };
      out.push(
        inline.size > 0
          ? paragraphType.create(blockAttrs, inline)
          : paragraphType.create(blockAttrs),
      );
      for (const tail of rest) out.push(tail);
    }
    const tr = closeHistory(this.#editor.state.tr);
    tr.replaceWith(hit.pos, hit.pos + node.nodeSize, Fragment.fromArray(out));
    // Keep the caret in the first unwrapped paragraph (same reasoning as
    // #turnInto: no extra history step, toolbar keeps describing the block).
    try {
      const inside = tr.doc.resolve(Math.min(hit.pos + 1, tr.doc.content.size));
      tr.setSelection(TextSelection.near(inside));
    } catch {
      // Best-effort.
    }
    this.#editor.view.dispatch(tr);
    return true;
  }

  /**
   * Pure replacement builder for #turnInto (no selection reads, no dispatch):
   * shared by the toolbar path and the fused slash path so guards/outcomes
   * stay identical and only transaction assembly differs. Returns null for
   * unknown targets and the code-target non-text-tail guard.
   */
  #buildTurnIntoReplacement(
    node: PMNode,
    arg: { type?: string; level?: number },
  ): { replacement: PMNode; trailing: PMNode[] } | null {
    const schema = this.#editor.schema;
    const blockId =
      typeof node.attrs.blockId === 'string' && node.attrs.blockId !== ''
        ? node.attrs.blockId
        : newBlockId();
    const preserved = node.attrs.preserved;
    const carried =
      preserved === null || preserved === undefined ? {} : { preserved };
    // Summary inline + trailing children for containers. Textblocks carry
    // their full inline content; toggle/callout/blockquote carry a summary
    // paragraph plus editable tail children that must survive as siblings
    // (leaf targets) or nested content (container targets).
    let inline: Fragment;
    let tail: PMNode[] = [];
    if (node.isTextblock) {
      inline = node.content;
    } else {
      const kids: PMNode[] = [];
      node.forEach((child) => kids.push(child));
      const first = kids[0];
      if (first !== undefined && first.type.name === 'paragraph') {
        inline = first.content;
        tail = kids.slice(1);
      } else {
        inline = Fragment.empty;
        tail = kids;
      }
    }
    const summaryParagraph = (): PMNode =>
      schema.nodes.paragraph.create(null, inline.size > 0 ? inline : undefined);
    let replacement: PMNode;
    let trailing: PMNode[] = [];
    switch (arg.type) {
      case 'heading': {
        // Heading levels clamp to the schema range 1-6 (non-finite levels
        // default to 1): an out-of-range level never throws out of
        // NodeType.create mid-command.
        const rawLevel = arg.level ?? 1;
        const level = Number.isFinite(rawLevel)
          ? Math.min(6, Math.max(1, Math.floor(rawLevel)))
          : 1;
        replacement = schema.nodes.heading.create(
          { blockId, level, ...carried },
          inline.size > 0 ? inline : undefined,
        );
        trailing = tail;
        break;
      }
      case 'paragraph':
        replacement = schema.nodes.paragraph.create(
          { blockId, ...carried },
          inline.size > 0 ? inline : undefined,
        );
        trailing = tail;
        break;
      case 'quote':
        replacement = schema.nodes.blockquote.create(
          { blockId, ...carried },
          Fragment.fromArray([summaryParagraph(), ...tail]),
        );
        break;
      case 'code': {
        // Code is plain text: textblock tails flatten into the value via
        // #textOf, but non-text tails (atoms like image/composition/
        // divider, grid tables, nested containers, lists) have no text
        // representation — flattening would silently drop their payload
        // Reject explicitly so the caller picks another target;
        // nothing is lost.
        if (tail.some((kid) => !kid.isTextblock)) return null;
        const text = this.#textOf(node);
        replacement = schema.nodes.codeBlock.create(
          { blockId, ...carried },
          text !== '' ? schema.text(text) : undefined,
        );
        // Explicit code-target flattening policy: container text descendants
        // flatten into the code value as text lines (#textOf already joins
        // every descendant run, summary and tail alike), so no tail sibling
        // is emitted — otherwise text would duplicate. The guard above
        // guarantees the tail held text only, so nothing is dropped.
        trailing = [];
        break;
      }
      case 'toggle':
        replacement = schema.nodes.toggle.create(
          { blockId, ...carried },
          Fragment.fromArray([summaryParagraph(), ...tail]),
        );
        break;
      case 'callout': {
        // Same-type re-apply keeps canonical icon/tone; fresh callouts get
        // the provider defaults. Never silently wipe canonical decoration.
        const icon =
          node.type.name === 'callout' && typeof node.attrs.icon === 'string'
            ? node.attrs.icon
            : '';
        const tone =
          node.type.name === 'callout' && typeof node.attrs.tone === 'string'
            ? node.attrs.tone
            : 'info';
        replacement = schema.nodes.callout.create(
          { blockId, icon, tone, ...carried },
          Fragment.fromArray([summaryParagraph(), ...tail]),
        );
        break;
      }
      default:
        return null;
    }
    return { replacement, trailing };
  }

  #insertBlock(
    arg: {
      type?: string;
      typeId?: string;
      target?: ResourceTarget;
      label?: string;
      viewId?: string;
      rows?: number;
      cols?: number;
    },
    trigger?: SlashTrigger,
  ): boolean {
    const node = this.#buildInsertNode(arg);
    // Outcome-before-mutation: an unbuildable node refuses with
    // no transaction, so the slash trigger is never deleted for nothing.
    if (node === null) return false;
    // the guarded insertables never land from a grid caret (decision
    // documented on #GRID_GUARDED_INSERTS). Refused before any mutation so
    // the fused slash trigger — were one ever to reach here — survives
    // untouched, and programmatic/toolbar commits leave the model identical.
    if (
      arg.type !== undefined &&
      TiptapBlockpageEditorHandle.#GRID_GUARDED_INSERTS.has(arg.type) &&
      this.#inTableGrid(this.#editor.state)
    ) {
      return false;
    }
    const current = this.#currentRoot();
    const insertAt = current === null ? 0 : current.pos + current.node.nodeSize;
    const selectInsertedTable = (tr: Transaction, tablePos: number): void => {
      if (arg.type !== 'table') return;
      const selection = TextSelection.findFrom(
        tr.doc.resolve(Math.min(tablePos + 1, tr.doc.content.size)),
        1,
        true,
      );
      if (selection === null)
        throw new Error('inserted table has no editable cell');
      tr.setSelection(selection);
    };
    if (trigger !== undefined) {
      // Fused slash commit: trigger deletion + insert share one
      // transaction (one undo step). The insert position sits after the
      // trigger range, so map it through the deletion in the same tr.
      // closeHistory keeps the commit its own undo unit (see #turnInto).
      const tr = closeHistory(this.#editor.state.tr);
      if (trigger.end > trigger.start) tr.delete(trigger.start, trigger.end);
      const mappedInsertAt = tr.mapping.map(insertAt);
      tr.insert(mappedInsertAt, node);
      selectInsertedTable(tr, mappedInsertAt);
      this.#editor.view.dispatch(tr);
      return true;
    }
    // No-trigger programmatic insert: open a fresh undo group
    // so type-then-insert within newGroupDelay stays two undo steps
    // (mirror the fused slash path above and leaf turnInto).
    const tr = closeHistory(this.#editor.state.tr).insert(insertAt, node);
    selectInsertedTable(tr, insertAt);
    this.#editor.view.dispatch(tr);
    return true;
  }

  /**
   * Pure node builder for #insertBlock (no selection reads, no dispatch):
   * shared by the block-command path and the fused slash path so validation
   * stays identical and only transaction assembly differs.
   */
  #buildInsertNode(arg: {
    type?: string;
    typeId?: string;
    target?: ResourceTarget;
    label?: string;
    viewId?: string;
    rows?: number;
    cols?: number;
  }): PMNode | null {
    const schema = this.#editor.schema;
    let node: PMNode | null = null;
    // Every inserted node carries a fresh stable id at creation, as in the
    // paste path. Keyed lookup (hover/drag/move-block) and the
    // duplicate-id dedupe plugin both key on blockId/listId, so a null id
    // would leave the new block unaddressable until the next full decode.
    // No inserted type creates a list container here, so no listId applies.
    switch (arg.type) {
      case 'divider':
        node = schema.nodes.divider.create({ blockId: newBlockId() });
        break;
      case 'image':
        // Unified vault placeholder prefix: every slash-insert
        // media placeholder starts at `attachments/` (never `assets/`) so
        // empty locators share one obviously-invalid shape. Invalid until
        // `uploadMedia` replaces it with vault `{src, sha256}`.
        node = schema.nodes.imageBlock.create({
          blockId: newBlockId(),
          src: 'attachments/',
          sha256: '',
          alt: '',
        });
        break;
      case 'video':
      case 'audio':
      case 'file': {
        // media placeholders (mirror the image placeholder): a fresh
        // stable id with an empty locator. Invalid until `uploadMedia`
        // replaces it with vault `{src, sha256}` — the codec preserves the
        // placeholder verbatim as opaque in the meantime, never fetched.
        const mediaType =
          arg.type === 'video'
            ? schema.nodes.videoBlock
            : arg.type === 'audio'
              ? schema.nodes.audioBlock
              : schema.nodes.fileBlock;
        if (mediaType === undefined) return null;
        node = mediaType.create({
          blockId: newBlockId(),
          src: 'attachments/',
          sha256: '',
          remoteUrl: null,
          name: null,
          caption: null,
          alt: '',
        });
        break;
      }
      case 'table': {
        // Editable grid: dimensions clamp inside buildTableNode
        // (default 2×2); header/align start unset (plain grid).
        const built = buildTableNode(schema, {
          blockId: newBlockId(),
          rows: arg.rows,
          cols: arg.cols,
        });
        node = built as unknown as PMNode;
        break;
      }
      case 'math':
      case 'diagram': {
        // source atoms: a fresh stable id with an empty source.
        // Empty renders the empty-source placeholder until `math.source` /
        // `diagram.source` commits text; the codec preserves the empty
        // source verbatim in the meantime (valid canonical — never fetched).
        const sourceType =
          arg.type === 'math'
            ? schema.nodes.mathBlock
            : schema.nodes.diagramBlock;
        if (sourceType === undefined) return null;
        node = sourceType.create({ blockId: newBlockId(), source: '' });
        break;
      }
      case 'toggle':
        node = schema.nodes.toggle.create(
          { blockId: newBlockId() },
          Fragment.fromArray([
            schema.nodes.paragraph.create({ blockId: newBlockId() }),
          ]),
        );
        break;
      case 'callout':
        node = schema.nodes.callout.create(
          { blockId: newBlockId(), icon: '', tone: 'info' },
          Fragment.fromArray([
            schema.nodes.paragraph.create({ blockId: newBlockId() }),
          ]),
        );
        break;
      case 'opaque':
        node = schema.nodes.opaqueBlock.create({
          blockId: newBlockId(),
          payload: {},
          typeId: arg.typeId ?? 'unknown.block',
        });
        break;
      case 'resource-link':
      case 'resource-embed':
      case 'transclusion':
      case 'linked-view': {
        if (arg.target === undefined) return null;
        // Converge every resource insertion on the stable ResourceTarget
        // contract: malformed targets reject without a
        // transaction instead of inserting unstable marks.
        if (!isResourceTarget(arg.target)) return null;
        if (arg.type === 'transclusion' && arg.target.address === undefined)
          return null;
        if (
          arg.type === 'linked-view' &&
          (arg.viewId === undefined || arg.viewId === '')
        )
          return null;
        node = schema.nodes.compositionBlock.create({
          blockId: newBlockId(),
          record: {
            type: `froglight.${arg.type}`,
            target: structuredClone(arg.target),
            ...(arg.label !== undefined ? { label: arg.label } : {}),
            ...(arg.viewId !== undefined ? { viewId: arg.viewId } : {}),
          },
        });
        break;
      }
      default:
        return null;
    }
    return node;
  }

  /**
   * Sanitized paste insertion: plain lines split/merge in one
   * undoable transaction through the normal pipeline, so `pm-map` decodes
   * and opaque/unknown marks elsewhere survive. Code contexts take the
   * literal path (newlines stay inside the code value, no split).
   */
  #insertPasteLines(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    view: { state: any; dispatch(tr: any): void },
    lines: readonly string[],
    richLines?: readonly Fragment[],
  ): boolean {
    if (lines.length === 0) return true;
    const schema = this.#editor.schema;
    const { state } = view;
    const { from, to } = state.selection;
    // Normalize ranges first so collapsed logic below always applies; the
    // delete + insert share one transaction (one history step).
    let tr = state.tr;
    if (from !== to) tr = tr.delete(from, to);
    const $c = tr.selection.$from;
    const parent = $c.parent;
    // Code blocks keep newlines literally (no block split).
    if (parent.type.name === 'codeBlock') {
      const text = lines.join('\n');
      if (text === '') return true;
      view.dispatch(tr.insertText(text));
      return true;
    }
    // cell paste: a cell holds exactly one
    // `tableParagraph` (single-paragraph model) — splicing block-level
    // `paragraph` nodes into a `tableCell` would corrupt the grid. Join
    // multi-line payloads with a space into one text insert through
    // `tableParagraph` content only (own undo unit via closeHistory, same
    // granularity as the split/merge path below); never a paragraph splice.
    if (parent.type.name === 'tableParagraph') {
      const text = lines.join(' ');
      if (text === '') return true;
      view.dispatch(closeHistory(tr.insertText(text)));
      return true;
    }
    const inlineLines =
      richLines ??
      lines.map((line) =>
        line === '' ? Fragment.empty : Fragment.from(schema.text(line)),
      );
    if (!parent.isTextblock) {
      // Atom/special context: insert lines as new paragraphs after the
      // current position (never into the atom itself, never a drop).
      const nodes = inlineLines.map((line) =>
        line.size === 0
          ? schema.nodes.paragraph.create({ blockId: newBlockId() })
          : schema.nodes.paragraph.create({ blockId: newBlockId() }, line),
      );
      view.dispatch(tr.insert($c.pos, Fragment.fromArray(nodes)));
      return true;
    }
    if (lines.length === 1) {
      const only = inlineLines[0]!;
      if (only.size === 0) return true;
      if (richLines === undefined) view.dispatch(tr.insertText(lines[0]!));
      else view.dispatch(tr.replaceSelection(new Slice(only, 0, 0)));
      return true;
    }
    // Multi-line split/merge inside one textblock: prefix + first line,
    // middle lines as empty-or-text paragraphs, last line + suffix. First
    // keeps the parent type/attrs (heading level preserved); the rest are
    // paragraphs. Block ids: first reuses the parent id, the rest are fresh
    // so hover/move-block stay stable. Single replaceWith = single undo.
    const parentDepth = $c.depth;
    const parentPos = $c.before(parentDepth);
    const parentOffset = $c.parentOffset;
    let prefix: Fragment;
    let suffix: Fragment;
    try {
      prefix = parent.content.cut(0, parentOffset);
      suffix = parent.content.cut(parentOffset, parent.content.size);
    } catch {
      return false;
    }
    const firstContent = prefix.append(inlineLines[0]!);
    const lastContent = inlineLines[inlineLines.length - 1]!.append(suffix);
    const middle = inlineLines.slice(1, -1);
    const parentAttrs = { ...(parent.attrs as Record<string, unknown>) };
    const sourcePreserved = parentAttrs['preserved'];
    const carriedPreserved =
      sourcePreserved === null || sourcePreserved === undefined
        ? {}
        : { preserved: sourcePreserved };
    const firstAttrs =
      parent.type.name === 'heading'
        ? {
            blockId: parentAttrs['blockId'] ?? newBlockId(),
            level: parentAttrs['level'] ?? 1,
            ...carriedPreserved,
          }
        : {
            blockId: parentAttrs['blockId'] ?? newBlockId(),
            ...carriedPreserved,
          };
    const first =
      firstContent.size > 0
        ? parent.type.create(firstAttrs, firstContent)
        : parent.type.create(firstAttrs);
    const middles = middle.map((line) =>
      line.size === 0
        ? schema.nodes.paragraph.create({ blockId: newBlockId() })
        : schema.nodes.paragraph.create({ blockId: newBlockId() }, line),
    );
    const last =
      lastContent.size > 0
        ? schema.nodes.paragraph.create({ blockId: newBlockId() }, lastContent)
        : schema.nodes.paragraph.create({ blockId: newBlockId() });
    view.dispatch(
      tr.replaceWith(
        parentPos,
        parentPos + parent.nodeSize,
        Fragment.fromArray([first, ...middles, last]),
      ),
    );
    return true;
  }

  #syncCompositionMounts(): void {
    const registry = this.#input.compositionRegistry;
    if (registry === undefined) return;
    const present = new Set<Element>();
    for (const element of this.#host.querySelectorAll(
      '[data-flbp-composition]',
    )) {
      present.add(element);
      const serialized = element.getAttribute('data-record') ?? '{}';
      if (
        this.#compositionControllers.has(element) &&
        this.#compositionRecords.get(element) === serialized
      )
        continue;
      this.#compositionControllers.get(element)?.dispose();
      this.#presentations.get(element)?.dispose();
      this.#presentations.delete(element);
      this.#compositionRecords.set(element, serialized);
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(
          element.getAttribute('data-record') ?? '{}',
        ) as Record<string, unknown>;
      } catch {
        continue;
      }
      const request = this.#compositionRequest(record);
      if (request === null) continue;
      const controller = new LazyCompositionController(
        registry,
        request,
        (snapshot) => this.#renderComposition(element as HTMLElement, snapshot),
      );
      this.#compositionControllers.set(element, controller);
      if (this.#compositionObserver !== null)
        this.#compositionObserver.observe(element);
      else controller.setVisible(true);
    }
    for (const [element, controller] of this.#compositionControllers) {
      if (present.has(element)) continue;
      this.#compositionObserver?.unobserve(element);
      controller.dispose();
      this.#presentations.get(element)?.dispose();
      this.#presentations.delete(element);
      this.#compositionSnapshots.delete(element);
      this.#compositionRecords.delete(element);
      this.#compositionControllers.delete(element);
    }
  }

  #compositionRequest(
    record: Record<string, unknown>,
  ): CompositionRequest | null {
    // Converge on the stable ResourceTarget contract, as in the insert-block
    // path. Malformed targets skip mounting instead of feeding
    // the registry a target it can never resolve.
    if (!isResourceTarget(record.target)) return null;
    const role =
      record.type === 'froglight.resource-embed'
        ? 'preview'
        : record.type === 'froglight.transclusion'
          ? 'transclusion'
          : record.type === 'froglight.linked-view'
            ? 'linked-view'
            : null;
    if (role === null) return null;
    return {
      role,
      target: record.target,
      ...(typeof record.viewId === 'string' ? { viewId: record.viewId } : {}),
      ...(typeof record.presentation === 'object' &&
      record.presentation !== null &&
      !Array.isArray(record.presentation)
        ? { presentation: record.presentation as never }
        : {}),
      ...(typeof record.overrides === 'object' &&
      record.overrides !== null &&
      !Array.isArray(record.overrides)
        ? { overrides: record.overrides as never }
        : {}),
    };
  }

  #renderComposition(
    element: HTMLElement,
    snapshot: CompositionSnapshot,
  ): void {
    this.#compositionSnapshots.set(element, snapshot);
    element.dataset.state = snapshot.state;
    if ('presentation' in snapshot && snapshot.presentation) {
      const existing = this.#presentations.get(element);
      if (existing) {
        existing.update(snapshot, !this.#editor.isEditable);
        return;
      }
      const presentation = this.#input.compositionPresenter?.mount({
        parent: element,
        snapshot,
        readOnly: !this.#editor.isEditable,
        onUnavailable: () => {
          element.textContent =
            'The view presentation provider is unavailable. The linked view is preserved.';
        },
        invoke: async (action, input) => {
          await this.#compositionControllers
            .get(element)
            ?.invoke(action, input);
        },
        configure: (patch) => {
          if (!this.#editor.isEditable)
            throw new Error('The host document is read-only');
          const id = element.getAttribute('data-block-id');
          const hit = this.#findBy(
            (node) =>
              node.type.name === 'compositionBlock' &&
              node.attrs.blockId === id,
          );
          if (!hit) throw new Error('The linked block is unavailable');
          const record = hit.node.attrs.record as Record<string, unknown>;
          const next = {
            ...record,
            ...(patch.viewId !== undefined ? { viewId: patch.viewId } : {}),
            ...(patch.overrides !== undefined
              ? { overrides: patch.overrides }
              : {}),
          };
          this.#editor.view.dispatch(
            this.#editor.state.tr.setNodeMarkup(hit.pos, undefined, {
              ...hit.node.attrs,
              record: next,
            }),
          );
          this.#syncNow();
        },
      });
      if (presentation) {
        this.#presentations.set(element, presentation);
        return;
      }
    }
    this.#presentations.get(element)?.dispose();
    this.#presentations.delete(element);
    delete element.dataset.hasImage;
    element.textContent = '';
    if (snapshot.state === 'loading') {
      element.textContent = 'Loading…';
      return;
    }
    if (snapshot.state === 'placeholder') {
      const message = document.createElement('span');
      message.textContent = snapshot.message;
      element.appendChild(message);
    } else {
      let hasImage = false;
      if (
        snapshot.image !== undefined &&
        snapshot.image.mimeType === 'image/png' &&
        snapshot.image.dataUrl.startsWith('data:image/png;base64,')
      ) {
        const image = document.createElement('img');
        image.className = 'flbp-composition-image';
        image.src = snapshot.image.dataUrl;
        image.alt = snapshot.image.alt;
        image.width = snapshot.image.width;
        image.height = snapshot.image.height;
        image.draggable = false;
        image.decoding = 'async';
        element.appendChild(image);
        hasImage = true;
      }
      const pages = (snapshot.images ?? []).filter(
        (image) =>
          image.mimeType === 'image/png' &&
          image.dataUrl.startsWith('data:image/png;base64,'),
      );
      if (pages.length > 0) {
        const pageList = document.createElement('div');
        pageList.className = 'flbp-composition-pages';
        for (const page of pages) {
          const figure = document.createElement('figure');
          figure.className = 'flbp-composition-page';
          const image = document.createElement('img');
          image.src = page.dataUrl;
          image.alt = page.alt;
          image.width = page.width;
          image.height = page.height;
          image.draggable = false;
          image.decoding = 'async';
          figure.appendChild(image);
          pageList.appendChild(figure);
        }
        element.appendChild(pageList);
        hasImage = true;
      }
      if (hasImage) element.dataset.hasImage = 'true';
      const imageOnly = snapshot.imageOnly === true;
      if (imageOnly && !hasImage) {
        const message = document.createElement('div');
        message.className = 'flbp-composition-summary';
        message.textContent = 'Image preview unavailable';
        element.appendChild(message);
      }
      if (!imageOnly && snapshot.title !== undefined) {
        const title = document.createElement('div');
        title.className = 'flbp-composition-title';
        title.textContent = snapshot.title;
        element.appendChild(title);
      }
      if (!imageOnly && snapshot.summary !== undefined) {
        const summary = document.createElement('div');
        summary.className = 'flbp-composition-summary';
        summary.textContent = snapshot.summary;
        element.appendChild(summary);
      }
      for (const item of snapshot.items ?? []) {
        const row = document.createElement('div');
        row.className = 'flbp-composition-item';
        row.setAttribute('role', 'group');
        const text = document.createElement('span');
        text.textContent = item.text;
        row.appendChild(text);
        for (const action of item.actions ?? []) {
          const button = document.createElement('button');
          button.type = 'button';
          button.textContent = action.label;
          button.disabled = action.enabled === false;
          button.addEventListener('click', () => {
            void this.#compositionControllers
              .get(element)
              ?.invoke(action.id, { itemId: item.id });
          });
          row.appendChild(button);
        }
        element.appendChild(row);
      }
    }
    for (const action of snapshot.actions ?? []) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = action.label;
      button.disabled = action.enabled === false;
      button.addEventListener('click', () => {
        void this.#compositionControllers.get(element)?.invoke(action.id);
      });
      element.appendChild(button);
    }
  }

  #keyOf(node: PMNode): string | null {
    if (typeof node.attrs.blockId === 'string' && node.attrs.blockId !== '')
      return node.attrs.blockId;
    if (typeof node.attrs.listId === 'string' && node.attrs.listId !== '')
      return node.attrs.listId;
    if (typeof node.attrs.owner === 'string' && node.attrs.owner !== '')
      return node.attrs.owner;
    return null;
  }

  /**
   * True when the selection lives inside the table grid. The
   * chrome Tab handler yields to the FlbpTableGrid keymap in that case so
   * indent/outdent can never lift cell content out of the grid. Delegates
   * to the shared table-grid scan (unit-pinned, see spec).
   */
  #inTableGrid(state: EditorState): boolean {
    return inTableGrid(state);
  }

  /**
   * Count topmost keyed roots touched by the current selection.
   * Prunes at the first keyed ancestor so nested children of one container
   * count once; mirrors `#topmostKeyedRoots` without allocating hit lists.
   */
  #touchedRootCount(): number {
    const { state } = this.#editor;
    const { from, to } = state.selection;
    const keys = new Set<string>();
    state.doc.nodesBetween(from, to, (node, pos) => {
      const key = this.#keyOf(node);
      if (key !== null) {
        keys.add(`${key}:${pos}`);
        return false;
      }
      return true;
    });
    return keys.size;
  }

  #findIn(doc: PMNode, key: string): BlockHit | null {
    let hit: BlockHit | null = null;
    doc.descendants((node, pos, parent) => {
      if (hit !== null) return false;
      if (this.#keyOf(node) === key) hit = { node, pos, parent: parent ?? doc };
      return hit === null;
    });
    return hit;
  }

  /** Swap complete sibling subtrees without changing their parent or ids. */
  #siblingMove(blockId: string, direction: -1 | 1): Transaction | null {
    const source = this.#findBy((node) => this.#keyOf(node) === blockId);
    if (source === null) return null;
    const siblings = source.parent.content.content;
    const index = siblings.indexOf(source.node);
    if (index < 0) return null;
    const moved = this.#movableFragment(source);
    let neighborIndex =
      direction < 0 ? index - 1 : index + moved.content.childCount;
    // A block's universal children are stored in its following owner group.
    if (direction < 0 && siblings[neighborIndex]?.type.name === 'blockGroup')
      neighborIndex -= 1;
    const neighbor = siblings[neighborIndex];
    if (neighbor === undefined || this.#keyOf(neighbor) === null) return null;
    const neighborPos =
      direction < 0
        ? source.pos -
          siblings
            .slice(neighborIndex, index)
            .reduce((size, node) => size + node.nodeSize, 0)
        : moved.to;
    const adjacent = this.#movableFragment({
      node: neighbor,
      pos: neighborPos,
      parent: source.parent,
    });
    const replacement =
      direction < 0
        ? moved.content.append(adjacent.content)
        : adjacent.content.append(moved.content);
    const startIndex = Math.min(index, neighborIndex);
    if (
      !source.parent.canReplace(
        startIndex,
        startIndex + replacement.childCount,
        replacement,
      )
    )
      return null;
    return closeHistory(
      this.#editor.state.tr.replaceWith(
        Math.min(moved.from, adjacent.from),
        Math.max(moved.to, adjacent.to),
        replacement,
      ),
    );
  }

  #moveBlock(arg: { blockId?: string; index?: number }): boolean {
    if (typeof arg.blockId !== 'string') return false;
    const source = this.#findBy((node) => this.#keyOf(node) === arg.blockId);
    if (source === null) return false;
    const fromIndex = Array.from(
      this.#editor.state.doc.content.content,
    ).findIndex((n) => this.#keyOf(n) === arg.blockId);
    const moved = this.#movableFragment(source);
    const tr = this.#editor.state.tr;
    tr.delete(moved.from, moved.to);
    this.#removeEmptyGroups(tr);
    const siblings: PMNode[] = [];
    tr.doc.forEach((child) => siblings.push(child));
    const rawIndex = Math.max(
      0,
      Math.min(arg.index ?? siblings.length + 1, siblings.length + 1),
    );
    // Arg indexes the pre-deletion order; compensate once past the removed slot.
    const targetIndex =
      fromIndex !== -1 && rawIndex > fromIndex
        ? rawIndex - moved.content.childCount
        : rawIndex;
    // Root-level gaps sit at the cumulative child-size boundary (0 = before
    // the first child); appending lands just before the document close.
    const insertAt =
      targetIndex >= siblings.length
        ? tr.doc.content.size
        : siblings
            .slice(0, targetIndex)
            .reduce((sum, n) => sum + n.nodeSize, 0);
    tr.insert(insertAt, moved.content);
    this.#editor.view.dispatch(tr);
    return true;
  }

  #moveBlockUnder(arg: { blockId?: string; parentId?: string; index?: number }): boolean {
    if (
      typeof arg.blockId !== 'string' ||
      typeof arg.parentId !== 'string' ||
      arg.blockId === arg.parentId
    )
      return false;
    const source = this.#findBy((node) => this.#keyOf(node) === arg.blockId);
    const parent = this.#findBy((node) => this.#keyOf(node) === arg.parentId);
    if (source === null || parent === null) return false;
    if (parent.node.type.name !== 'toggle') return false;
    const moved = this.#movableFragment(source);
    if (parent.pos >= moved.from && parent.pos < moved.to) return false;
    const tr = closeHistory(this.#editor.state.tr).delete(moved.from, moved.to);
    this.#removeEmptyGroups(tr);
    const freshParent = this.#findIn(tr.doc, arg.parentId);
    if (freshParent === null) return false;
    let index = arg.index ?? freshParent.node.childCount;
    if (source.parent === parent.node && arg.index !== undefined) {
      const sourceIndex = parent.node.content.content.indexOf(source.node);
      if (sourceIndex >= 0 && arg.index > sourceIndex) index -= 1;
    }
    index = Math.max(1, Math.min(index, freshParent.node.childCount));
    let insertAt = freshParent.pos + 1;
    for (let i = 0; i < index; i += 1)
      insertAt += freshParent.node.child(i).nodeSize;
    tr.insert(insertAt, moved.content);
    this.#editor.view.dispatch(tr);
    return true;
  }

  #movableFragment(source: BlockHit): {
    content: Fragment;
    from: number;
    to: number;
  } {
    const siblings = source.parent.content.content;
    const index = siblings.indexOf(source.node);
    const key = this.#keyOf(source.node);
    const follower = index >= 0 ? siblings[index + 1] : undefined;
    if (
      key !== null &&
      follower?.type.name === 'blockGroup' &&
      follower.attrs.owner === key
    ) {
      return {
        content: Fragment.fromArray([source.node, follower]),
        from: source.pos,
        to: source.pos + source.node.nodeSize + follower.nodeSize,
      };
    }
    return {
      content: Fragment.from(source.node),
      from: source.pos,
      to: source.pos + source.node.nodeSize,
    };
  }

  #removeEmptyGroups(tr: Transaction): void {
    const empty: Array<{ pos: number; size: number }> = [];
    tr.doc.descendants((node, pos) => {
      if (node.type.name === 'blockGroup' && node.childCount === 0)
        empty.push({ pos, size: node.nodeSize });
      return true;
    });
    for (const group of empty.reverse())
      tr.delete(group.pos, group.pos + group.size);
  }

  #toggleCollapse(arg: { target?: string }): boolean {
    const target = arg.target ?? '';
    const flip = (
      predicate: (node: PMNode) => boolean,
      attr: string,
    ): boolean => {
      const hit = this.#findBy(predicate);
      if (hit === null) return false;
      const tr = this.#editor.state.tr.setNodeMarkup(hit.pos, undefined, {
        ...hit.node.attrs,
        [attr]: !hit.node.attrs[attr],
      });
      this.#editor.view.dispatch(tr);
      return true;
    };
    if (target.startsWith('list:')) {
      const listId = target.slice(5);
      return flip(
        (node) =>
          (node.type.name === 'bulletList' ||
            node.type.name === 'orderedList') &&
          node.attrs.listId === listId,
        'subCollapsed',
      );
    }
    return flip(
      (node) => node.type.name === 'toggle' && node.attrs.blockId === target,
      'collapsed',
    );
  }

  /**
   * Toggle one to-do item:
   * targets the INNERMOST listItem containing the position (nested todos
   * flip the tapped row, never the outer ancestor) and commits in one
   * closeHistory transaction so rapid toggles stay single-undo each instead
   * of merging with preceding typing. Refuses outside list items and when
   * read-only without mutation.
   */
  #setItemCheckedAtPos(pos: number, value: boolean): boolean {
    if (!this.#editor.isEditable) return false;
    let bestPos = -1;
    let bestSize = Number.POSITIVE_INFINITY;
    this.#editor.state.doc.descendants((node, nodePos) => {
      if (
        node.type.name === 'listItem' &&
        pos >= nodePos &&
        pos <= nodePos + node.nodeSize &&
        node.nodeSize < bestSize
      ) {
        bestPos = nodePos;
        bestSize = node.nodeSize;
      }
      return true;
    });
    if (bestPos < 0) return false;
    const nodeAt = this.#editor.state.doc.nodeAt(bestPos);
    if (nodeAt === null) return false;
    this.#editor.view.dispatch(
      closeHistory(this.#editor.state.tr).setNodeMarkup(bestPos, undefined, {
        ...nodeAt.attrs,
        checked: value,
      }),
    );
    return true;
  }

  #setItemChecked(value: boolean): boolean {
    return this.#setItemCheckedAtPos(this.#editor.state.selection.from, value);
  }

  /**
   * Toggle the to-do row backing a tapped `li[data-checked]` element
   * resolves the tapped row to a document position through the
   * view (never the ambient caret, which may sit in another block) and
   * delegates to the innermost single-undo path above.
   */
  #toggleTodoElement(li: HTMLElement): boolean {
    if (!this.#editor.isEditable) return false;
    let pos: number;
    try {
      pos = this.#editor.view.posAtDOM(li, 0);
    } catch {
      return false;
    }
    let current: boolean | null = null;
    try {
      const raw = li.getAttribute('data-checked');
      current = raw === 'true' ? true : raw === 'false' ? false : null;
    } catch {
      current = null;
    }
    // Unparseable state still toggles deterministically: fall back to the
    // document attrs at the resolved position.
    if (current === null) {
      const nodeAt = (() => {
        try {
          return this.#editor.state.doc.nodeAt(pos);
        } catch {
          return null;
        }
      })();
      const checked = nodeAt?.attrs.checked;
      current = checked === true;
    }
    return this.#setItemCheckedAtPos(pos, !current);
  }

  /**
   * True when a pointer lands on the drawn checkbox zone of a to-do row
   * (mis-tap guard, 768x1024): taps within ~30px of the row's left
   * edge toggle; taps on the text body edit instead. Layout-free hosts
   * (jsdom, zero rects) accept unconditionally so the behavior stays
   * drive-testable without geometry.
   */
  #isTodoCheckboxTap(li: HTMLElement, clientX: number): boolean {
    try {
      const rect = li.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) return true;
      return clientX <= rect.left + 30;
    } catch {
      return true;
    }
  }

  // --- provider chrome (slash menu and block drag handle) ---
  // Engine-owned dynamic overlays: the slash /
  // resource menus, drag handle, and drop line are created once per editor,
  // positioned from live ProseMirror coordinates on every interaction, and
  // shown/hidden by engine state. Presentation lives in the colocated
  // provider stylesheet (styles/prose-mirror.css); only the stable host
  // wrapper is React-owned. Composition bodies rendered into ProseMirror
  // decorations below are likewise engine-owned derived content.

  #buildChrome(): void {
    // A coarse pointer commits on pointerup and hides its overlay. Cancelling
    // the matching touchend prevents Chrome from retargeting the later
    // compatibility mouse sequence to newly exposed editor content.
    const suppressTouchClickThrough = (overlay: HTMLElement): void => {
      overlay.addEventListener(
        'touchend',
        (event) => {
          const item = (event.target as HTMLElement).closest(
            '.flbp-slash-item',
          );
          if (item instanceof HTMLElement) event.preventDefault();
        },
        { passive: false },
      );
    };
    const menu = document.createElement('div');
    menu.className = 'flbp-slash';
    menu.style.display = 'none';
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('aria-label', 'Block commands');
    menu.addEventListener('mousedown', (event) => event.preventDefault());
    menu.addEventListener('click', (event) => {
      const item = (event.target as HTMLElement).closest('.flbp-slash-item');
      if (item instanceof HTMLElement)
        this.#applySlashEntry(Number(item.dataset.index ?? 0));
    });
    // Touch tap parity: coarse pointers commit on pointerup even when the
    // synthetic click is delayed or suppressed; the click handler above
    // stays the mouse path. Guard double-commit via the menu's display.
    menu.addEventListener('pointerup', (event) => {
      if (event.pointerType === 'mouse') return;
      const item = (event.target as HTMLElement).closest('.flbp-slash-item');
      if (item instanceof HTMLElement)
        this.#applySlashEntry(Number(item.dataset.index ?? 0));
    });
    suppressTouchClickThrough(menu);
    this.#host.appendChild(menu);

    const resources = document.createElement('div');
    resources.className = 'flbp-slash flbp-resource-menu';
    resources.style.display = 'none';
    resources.setAttribute('role', 'listbox');
    resources.setAttribute('aria-label', 'Resource suggestions');
    resources.addEventListener('mousedown', (event) => event.preventDefault());
    resources.addEventListener('click', (event) => {
      const item = (event.target as HTMLElement).closest('.flbp-slash-item');
      if (item instanceof HTMLElement)
        this.#applyResourceChoice(Number(item.dataset.index ?? 0));
    });
    resources.addEventListener('pointerup', (event) => {
      if (event.pointerType === 'mouse') return;
      const item = (event.target as HTMLElement).closest('.flbp-slash-item');
      if (item instanceof HTMLElement)
        this.#applyResourceChoice(Number(item.dataset.index ?? 0));
    });
    suppressTouchClickThrough(resources);
    this.#host.appendChild(resources);

    // Table size picker: preset dimensions for the slash Table
    // row. Like the resource menu, this provider-owned overlay uses its
    // colocated stylesheet and commits plain data through
    // commit through #insertBlock.
    const tableSizes = document.createElement('div');
    tableSizes.className = 'flbp-slash flbp-table-menu';
    tableSizes.style.display = 'none';
    tableSizes.setAttribute('role', 'listbox');
    tableSizes.setAttribute('aria-label', 'Table size');
    tableSizes.addEventListener('mousedown', (event) => event.preventDefault());
    tableSizes.addEventListener('click', (event) => {
      const item = (event.target as HTMLElement).closest('.flbp-slash-item');
      if (item instanceof HTMLElement)
        this.#applyTableSize(Number(item.dataset.index ?? 0));
    });
    tableSizes.addEventListener('pointerup', (event) => {
      if (event.pointerType === 'mouse') return;
      const item = (event.target as HTMLElement).closest('.flbp-slash-item');
      if (item instanceof HTMLElement)
        this.#applyTableSize(Number(item.dataset.index ?? 0));
    });
    suppressTouchClickThrough(tableSizes);
    this.#host.appendChild(tableSizes);

    const add = document.createElement('button');
    add.className = 'flbp-add-block';
    add.type = 'button';
    add.appendChild(sideControlIcon('add'));
    add.title = 'Add block';
    add.setAttribute('aria-label', 'Add block');
    add.addEventListener('mousedown', (event) => event.preventDefault());
    add.addEventListener('click', () => {
      if (this.#hoveredId !== null) this.#addBlockAt(this.#hoveredId);
    });
    this.#host.appendChild(add);

    const drag = document.createElement('button');
    drag.className = 'flbp-drag-handle';
    drag.appendChild(sideControlIcon('grip'));
    drag.type = 'button';
    drag.title = 'Block actions (drag to move)';
    drag.setAttribute('aria-label', 'Block actions');
    drag.setAttribute('aria-haspopup', 'listbox');
    drag.setAttribute('aria-expanded', 'false');
    drag.draggable = false;
    this.#blockDrag = new BlockDragController(this.#host, this.#editor.view);
    const openActions = (): void => {
      if (this.#hoveredId === null) return;
      if (this.#handleMenuOpen) this.#closeHandleMenu();
      else this.#openHandleMenu(this.#hoveredId);
    };
    drag.addEventListener('click', () => {
      if (!this.#blockDrag?.suppressClick) openActions();
    });
    drag.addEventListener('pointerdown', (event) => {
      if (this.#handleMenuOpen || this.#hoveredId === null) return;
      const source = this.#hoveredListItem ?? this.#rootElementFor(this.#hoveredId);
      if (source) this.#blockDrag?.start(event, source, openActions);
    });
    this.#host.appendChild(drag);

    // Drag-handle turn-into menu: engine-owned overlay
    // sharing the slash chrome. Lists the same
    // turn-into-compatible catalog targets as the toolbar; choosing an entry
    // runs the same #turnInto/#turnIntoList path as slash/toolbar.
    const turnInto = document.createElement('div');
    turnInto.className = 'flbp-slash flbp-turninto-menu';
    turnInto.style.display = 'none';
    turnInto.setAttribute('role', 'listbox');
    turnInto.setAttribute('aria-label', 'Block actions');
    turnInto.addEventListener('mousedown', (event) => event.preventDefault());
    turnInto.addEventListener('click', (event) => {
      const item = (event.target as HTMLElement).closest('.flbp-slash-item');
      if (item instanceof HTMLElement)
        this.#applyHandleMenuEntry(Number(item.dataset.index ?? 0));
    });
    turnInto.addEventListener('pointerup', (event) => {
      if (event.pointerType === 'mouse') return;
      const item = (event.target as HTMLElement).closest('.flbp-slash-item');
      if (item instanceof HTMLElement)
        this.#applyHandleMenuEntry(Number(item.dataset.index ?? 0));
    });
    suppressTouchClickThrough(turnInto);
    this.#host.appendChild(turnInto);

    // Whole-list actions have their own handle, outside the list-item gutter.
    const listDrag = document.createElement('button');
    listDrag.type = 'button';
    listDrag.className = 'flbp-list-drag-handle';
    listDrag.setAttribute('aria-label', 'List actions');
    listDrag.setAttribute('aria-haspopup', 'listbox');
    listDrag.setAttribute('aria-expanded', 'false');
    listDrag.title = 'List actions (drag to move the whole list)';
    listDrag.appendChild(sideControlIcon('grip'));
    const openListActions = (): void => {
      if (this.#handleMenuOpen) { this.#closeHandleMenu(); return; }
      const list = this.#hoveredListItem?.parentElement;
      if (!list?.dataset.listId) return;
      this.#hoveredListItem = null;
      this.#hoveredId = list.dataset.listId;
      this.#openHandleMenu(list.dataset.listId, listDrag);
    };
    listDrag.addEventListener('pointerdown', (event) => {
      const list = this.#hoveredListItem?.parentElement;
      if (list && !this.#handleMenuOpen) this.#blockDrag?.start(event, list, openListActions);
    });
    listDrag.addEventListener('click', () => {
      if (!this.#blockDrag?.suppressClick) openListActions();
    });
    this.#host.appendChild(listDrag);

    this.#wireHost();
    // Anchor scroll/resize watch: edge-gated onDidChange when the
    // contextual rect moves without a transaction. Passive listeners only —
    // scroll is never blocked.
    this.#watchAnchor();
  }

  #followHover = (): void => {
    this.#hoverFrame = 0;
    if (this.#typingHidesHandles || !this.#hoverPointer || this.#handleFromTouch || this.#handleMenuOpen || this.#blockDrag?.busy) return;
    const { x, y } = this.#hoverPointer;
    const rect = this.#host.getBoundingClientRect();
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) return;
    const block = blockAtPointerHeight(this.#editor.view, y);
    if (!block) return;
    const item = block.matches('li') ? block : null;
    const id = item?.parentElement?.dataset.listId ?? block.dataset.blockId ?? block.dataset.listId;
    const handle = this.#host.querySelector<HTMLElement>('.flbp-drag-handle');
    if (!id || !handle) return;
    this.#hoveredId = id;
    this.#hoveredListItem = item;
    this.#positionDragHandle(block, handle, false);
  };

  #wireHost(): void {
    const hideWhileTyping = (event: Event): void => {
      if (!(event.target instanceof Element) || !event.target.closest('.ProseMirror')) return;
      this.#typingHidesHandles = true;
      this.#host.querySelectorAll('.flbp-drag-handle, .flbp-list-drag-handle, .flbp-add-block')
        .forEach((control) => control.classList.remove('visible'));
    };
    for (const type of ['beforeinput', 'compositionstart'])
      this.#host.addEventListener(type, hideWhileTyping, { capture: true, signal: this.#hoverEvents.signal });
    this.#host.addEventListener('keydown', (event) => {
      if (event.isComposing || ['Enter', 'Backspace', 'Delete', 'Tab'].includes(event.key) ||
          (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey))
        hideWhileTyping(event);
    }, { capture: true, signal: this.#hoverEvents.signal });
    const scheduleHover = (): void => {
      if (!this.#hoverFrame) this.#hoverFrame = requestAnimationFrame(this.#followHover);
    };
    this.#host.addEventListener('pointermove', (event) => {
      if (event.pointerType !== 'mouse') return;
      this.#typingHidesHandles = false;
      this.#hoverPointer = { x: event.clientX, y: event.clientY };
      if ((event.target as Element).closest('.flbp-drag-handle, .flbp-list-drag-handle, .flbp-add-block, .flbp-slash')) return;
      scheduleHover();
    }, { passive: true, signal: this.#hoverEvents.signal });
    this.#host.addEventListener('pointerleave', () => { this.#hoverPointer = null; }, { signal: this.#hoverEvents.signal });
    window.addEventListener('scroll', scheduleHover, { passive: true, capture: true, signal: this.#hoverEvents.signal });
    window.addEventListener('resize', scheduleHover, { passive: true, signal: this.#hoverEvents.signal });
    this.#host.addEventListener('pointerover', (event) => {
      if (event.pointerType === 'mouse') this.#handleFromTouch = false;
      const table = (event.target as HTMLElement).closest<HTMLTableElement>('table[data-flbp-grid][data-block-id]');
      const nextTableId = table?.dataset.blockId ?? null;
      if (nextTableId === null && this.#hoveredTableId !== null) {
        const previous = this.#rootElementFor(this.#hoveredTableId);
        const rect = previous?.getBoundingClientRect();
        if (rect !== undefined && event.clientX >= rect.left - 120 &&
            event.clientX <= rect.right + 28 && event.clientY >= rect.top - 48 &&
            event.clientY <= rect.bottom + 28)
          return;
      }
      if ((table !== null || (event.target as HTMLElement).closest('.ProseMirror') !== null)
        && nextTableId !== this.#hoveredTableId) {
        this.#hoveredTableId = nextTableId;
        this.#notifyTools();
      }
    });
    this.#host.addEventListener('pointerdown', (event) => {
      this.#typingHidesHandles = false;
      this.#handleFromTouch = event.pointerType !== 'mouse';
      // Coarse tap tracker: parks the origin for todo
      // checkbox + figure taps. A pointerup beyond ~10px is a scroll/drag
      // and never toggles or opens — the compat click afterwards is
      // swallowed by the 500ms suppression window instead.
      if (event.pointerType !== 'mouse') {
        this.#tapStartX = event.clientX;
        this.#tapStartY = event.clientY;
        this.#tapTracking = true;
      }
      // Dismiss the handle menu on outside press (but never when the press
      // lands inside the menu or on the handle itself).
      if (this.#handleMenuOpen) {
        const target = event.target as HTMLElement;
        if (
          target.closest('.flbp-turninto-menu') === null &&
          target.closest('.flbp-drag-handle, .flbp-list-drag-handle') === null
        )
          this.#closeHandleMenu();
      }
      if (
        event.pointerType === 'mouse' ||
        (event.target as HTMLElement).closest(
          '.flbp-drag-handle, .flbp-list-drag-handle, .flbp-add-block',
        ) !== null
      )
        return;
      const block = (event.target as HTMLElement).closest<HTMLElement>(
        '[data-block-id], [data-list-id]',
      );
      const dragHandle =
        this.#host.querySelector<HTMLElement>('.flbp-drag-handle');
      if (block === null || dragHandle === null || !this.#host.contains(block))
        return;
      const id = block.dataset.blockId ?? block.dataset.listId ?? null;
      if (id === null) return;
      this.#hoveredId = id;
      const item = (event.target as HTMLElement).closest('li');
      this.#hoveredListItem =
        item instanceof HTMLElement && item.parentElement?.hasAttribute('data-list-id')
          ? item
          : null;
      this.#positionDragHandle(this.#hoveredListItem ?? block, dragHandle, true);
    });
    this.#host.addEventListener('mouseover', (event) => {
      if (this.#handleFromTouch) return;
      // Freeze the gutter handle while the turn-into menu is open:
      // hover must not reposition or retarget the handle mid-menu.
      if (this.#handleMenuOpen || this.#blockDrag?.busy) return;
      const target = event.target;
      const current = this.#hoveredListItem ??
        (this.#hoveredId === null ? null : this.#rootElementFor(this.#hoveredId));
      if (target instanceof HTMLElement && current !== null &&
          target !== current && target.contains(current)) {
        const row = current.getBoundingClientRect();
        if (event.clientY >= row.top && event.clientY <= row.bottom)
          return;
      }
      const rootBlock = (event.target as HTMLElement).closest(
        '[data-block-id], [data-list-id]',
      );
      if (!(rootBlock instanceof HTMLElement)) return;
      const id =
        rootBlock.dataset['blockId'] ?? rootBlock.dataset['listId'] ?? null;
      if (id === null) return;
      this.#hoveredId = id;
      const item = (event.target as HTMLElement).closest('li');
      this.#hoveredListItem =
        item instanceof HTMLElement && item.parentElement?.hasAttribute('data-list-id')
          ? item
          : null;
      const dragHandle = this.#host.querySelector('.flbp-drag-handle');
      if (dragHandle instanceof HTMLElement) {
        // Park the handle in the gutter just left of the writing column —
        // not at the host edge, which sits far away from the text.
        this.#positionDragHandle(this.#hoveredListItem ?? rootBlock, dragHandle, false);
      }
    });
    this.#host.addEventListener('mouseleave', () => {
      // Touch compatibility mouse events must not hide the tapped block handle.
      if (this.#handleFromTouch || this.#blockDrag?.busy) return;
      // Keep the handle visible while its menu is open (frozen).
      if (this.#handleMenuOpen) return;
      this.#hoveredId = null;
      this.#hoveredListItem = null;
      this.#host
        .querySelector('.flbp-drag-handle')
        ?.classList.remove('visible');
      this.#host.querySelector('.flbp-add-block')?.classList.remove('visible');
      this.#host.querySelector('.flbp-list-drag-handle')?.classList.remove('visible');
    });
    this.#host.addEventListener('click', (event) => {
      const emptyToggle = (event.target as HTMLElement).closest<HTMLElement>('.flbp-toggle-empty');
      if (emptyToggle?.dataset.toggleId && this.#editor.isEditable) {
        const hit = this.#findBy((node) => this.#keyOf(node) === emptyToggle.dataset.toggleId);
        if (hit?.node.type.name === 'toggle' && hit.node.childCount === 1) {
          const at = hit.pos + hit.node.nodeSize - 1;
          const tr = closeHistory(this.#editor.state.tr).insert(at, this.#editor.schema.nodes.paragraph.create({ blockId: newBlockId() }));
          tr.setSelection(TextSelection.create(tr.doc, at + 1));
          this.#editor.view.dispatch(tr);
          this.#editor.view.focus();
        }
        return;
      }
      // To-do checkbox tap:
      // mouse path — the coarse path lives on pointerup below, and its
      // 500ms suppression window swallows the compat click here. Only the
      // checkbox zone toggles; text-body clicks keep editing (mis-tap
      // guard, 768x1024). `closest` targets the innermost row.
      const todoRow = (event.target as HTMLElement).closest('li[data-checked]');
      if (todoRow instanceof HTMLElement) {
        if (
          Date.now() < this.#suppressTapClickUntil ||
          !this.#isTodoCheckboxTap(todoRow, event.clientX)
        ) {
          // Suppressed compat click, or a text-body click: fall through to
          // the resource/figure handling below (a link inside a todo still
          // opens; plain text just places the caret).
        } else {
          this.#toggleTodoElement(todoRow);
          return;
        }
      }
      // Math/diagram figure click (edit-source): mouse path opens
      // the source overlay anchored to the live figure.
      const figure = (event.target as HTMLElement).closest(
        'figure[data-flbp-math], figure[data-flbp-diagram]',
      );
      if (figure instanceof HTMLElement) {
        if (Date.now() >= this.#suppressTapClickUntil) {
          const blockId = figure.getAttribute('data-block-id');
          if (blockId !== null && blockId !== '')
            this.#openMathDiagramOverlay(blockId);
        }
        return;
      }
      const resource = (event.target as HTMLElement).closest(
        '[data-flbp-resource], [data-flbp-composition]',
      );
      if (resource instanceof HTMLElement) this.#openResourceElement(resource);
      const chevron = (event.target as HTMLElement).closest('.flbp-chevron');
      if (
        chevron instanceof HTMLElement &&
        typeof chevron.dataset.target === 'string' &&
        Date.now() >= this.#suppressTapClickUntil
      ) {
        this.blockCommand('toggle-collapse', {
          target: chevron.dataset.target,
        });
      }
    });
    // Coarse tap parity: touch taps commit on pointerup
    // even when the synthetic click is delayed; taps that moved (scroll)
    // never act. Handled taps arm the 500ms suppression so the compat
    // click lands inert. Mouse pointers stay on the click path above.
    this.#host.addEventListener('pointerup', (event) => {
      if (event.pointerType === 'mouse') {
        this.#tapTracking = false;
        return;
      }
      const tracking = this.#tapTracking;
      this.#tapTracking = false;
      if (!tracking) return;
      if (
        Math.abs(event.clientX - this.#tapStartX) > 10 ||
        Math.abs(event.clientY - this.#tapStartY) > 10
      )
        return;
      const target = event.target as HTMLElement;
      const chevron = target.closest<HTMLElement>('.flbp-chevron');
      if (chevron?.dataset.target !== undefined) {
        this.blockCommand('toggle-collapse', { target: chevron.dataset.target });
        this.#suppressTapClickUntil = Date.now() + 500;
        return;
      }
      const todoRow = target.closest('li[data-checked]');
      if (
        todoRow instanceof HTMLElement &&
        this.#isTodoCheckboxTap(todoRow, event.clientX) &&
        this.#toggleTodoElement(todoRow)
      ) {
        this.#suppressTapClickUntil = Date.now() + 500;
        return;
      }
      const figure = target.closest(
        'figure[data-flbp-math], figure[data-flbp-diagram]',
      );
      if (figure instanceof HTMLElement) {
        const blockId = figure.getAttribute('data-block-id');
        if (
          blockId !== null &&
          blockId !== '' &&
          this.#openMathDiagramOverlay(blockId)
        )
          this.#suppressTapClickUntil = Date.now() + 500;
      }
    });
    this.#host.addEventListener('pointercancel', () => {
      this.#tapTracking = false;
    });
    this.#host.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        // Math/diagram figure keyboard path (edit-source): Enter on
        // a focused figure opens the source overlay instead of splitting.
        const figure = (event.target as HTMLElement).closest(
          'figure[data-flbp-math], figure[data-flbp-diagram]',
        );
        if (figure instanceof HTMLElement) {
          const blockId = figure.getAttribute('data-block-id');
          if (
            blockId !== null &&
            blockId !== '' &&
            this.#openMathDiagramOverlay(blockId)
          ) {
            event.preventDefault();
            return;
          }
        }
      }
      if (event.key !== 'Enter') return;
      const resource = (event.target as HTMLElement).closest(
        '[data-flbp-composition]',
      );
      if (
        !(resource instanceof HTMLElement) ||
        !this.#openResourceElement(resource)
      )
        return;
      event.preventDefault();
    });
    // File imports retain native drag and drop. Block moves use pointer events.
    this.#host.addEventListener('dragover', (event) => {
      if (dragCarriesFiles((event as DragEvent).dataTransfer)) {
        event.preventDefault();
        if (event.dataTransfer != null) event.dataTransfer.dropEffect = 'copy';
      }
    });
    this.#host.addEventListener(
      'drop',
      (event) => {
        const files = collectUploadableFiles((event as DragEvent).dataTransfer);
        if (files.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        void this.#ingestDroppedFiles(files);
      },
      true,
    );
  }

  #positionDragHandle(
    block: HTMLElement,
    dragHandle: HTMLElement,
    coarse: boolean,
  ): void {
    if (this.#typingHidesHandles) return;
    const hostRect = this.#host.getBoundingClientRect();
    const blockRect = block.getBoundingClientRect();
    // Media, tables, and wide layouts may center their visible node inside
    // the writing measure. Keep the side controls in the measure's gutter;
    // otherwise they can cover interactive content inside the block.
    const writingLeft = this.#editor.view.dom.getBoundingClientRect().left;
    const listLeft = block.matches('li')
      ? block.closest('[data-list-id]')?.getBoundingClientRect().left
      : undefined;
    const blockLeft = block.matches('li, [data-flbp-toggle]') || block.closest('[data-flbp-toggle]')
      ? listLeft ?? blockRect.left : Math.min(blockRect.left, writingLeft + 32);
    const size = coarse ? 44 : 28;
    // The handle is absolutely positioned inside the scrolling host. DOM
    // rects are viewport-relative, so add the host scroll offset back into
    // local coordinates. Keep long blocks anchored near their first line
    // instead of centering the handle halfway down a table/list/card.
    const tableBlock = block.matches('table[data-flbp-grid]');
    const firstLine = block.matches('li, [data-flbp-toggle]')
      ? block.querySelector<HTMLElement>(':scope > p')
      : block.matches('p, h1, h2, h3, h4, h5, h6') ? block : null;
    const anchor = firstLine ?? block;
    const anchorRect = anchor.getBoundingClientRect();
    const anchorStyle = getComputedStyle(anchor);
    const lineHeight = Number.parseFloat(anchorStyle.lineHeight);
    const paddingTop = Number.parseFloat(anchorStyle.paddingTop) || 0;
    const top = Math.max(0, Math.round(
      anchorRect.top - hostRect.top + this.#host.scrollTop +
      (firstLine !== null && Number.isFinite(lineHeight)
        ? paddingTop + (lineHeight - size) / 2
        : Math.min(4, Math.max(0, (blockRect.height - size) / 2))),
    ));
    const gutter = blockLeft - hostRect.left;
    // Both controls share one geometry. Tables reserve the inner gutter for
    // row handles; list markers reserve the space immediately beside text.
    const dragInset = tableBlock ? size * 2 + 18 : size + 8;
    const left = Math.max(size + 4, Math.round(gutter - dragInset));
    dragHandle.style.top = `${top}px`;
    dragHandle.style.left = `${left}px`;
    dragHandle.classList.add('visible');
    dragHandle.dataset.targetBlockId = this.#hoveredId ?? '';
    dragHandle.setAttribute('aria-label', block.matches('li') ? 'List item actions' : 'Block actions');
    dragHandle.title = block.matches('li') ? 'List item actions (drag to move this item)' : 'Block actions (drag to move)';
    const listHandle = this.#host.querySelector<HTMLElement>('.flbp-list-drag-handle');
    const list = block.matches('li') ? block.parentElement : null;
    listHandle?.classList.toggle('visible', list !== null);
    if (listHandle && list) {
      const rect = list.getBoundingClientRect();
      listHandle.style.top = `${rect.top - hostRect.top + this.#host.scrollTop}px`;
      listHandle.style.left = `${Math.min(hostRect.width - size, rect.right - hostRect.left + 6)}px`;
    }
    const add = this.#host.querySelector<HTMLElement>('.flbp-add-block');
    if (add !== null) {
      add.style.top = dragHandle.style.top;
      add.style.left = `${Math.max(0, left - size - 4)}px`;
      add.classList.add('visible');
    }
  }

  #addBlockAt(blockId: string): void {
    if (this.#hoveredListItem !== null && this.#addListItemAt(this.#hoveredListItem))
      return;
    const hit = this.#findBy((node) => this.#keyOf(node) === blockId);
    if (hit === null) return;
    this.#closeHandleMenu();
    this.#closeResourceMenu();
    if (hit.node.isTextblock && hit.node.content.size === 0) {
      if (!this.#focusHandleBlock(blockId)) return;
      this.#editor.view.dispatch(
        closeHistory(this.#editor.state.tr).insertText('/'),
      );
    } else {
      const paragraph = this.#editor.schema.nodes.paragraph?.create(
        { blockId: newBlockId() },
        this.#editor.schema.text('/'),
      );
      if (paragraph === undefined) return;
      const pos = hit.node.type.name === 'toggle'
        ? hit.pos + hit.node.nodeSize - 1
        : this.#movableFragment(hit).to;
      const tr = closeHistory(this.#editor.state.tr).insert(pos, paragraph);
      tr.setSelection(TextSelection.create(tr.doc, pos + 2));
      this.#editor.view.dispatch(tr);
    }
    this.#editor.view.dom.focus({ preventScroll: true });
  }

  #listItemHit(element: HTMLElement): {
    listId: string;
    index: number;
    listPos: number;
    listNode: PMNode;
    itemPos: number;
    itemNode: PMNode;
  } | null {
    const listElement = element.parentElement;
    const listId = listElement?.getAttribute('data-list-id');
    if (!listId || !listElement) return null;
    const index = [...listElement.children].indexOf(element);
    const list = this.#findBy(
      (node) =>
        (node.type.name === 'bulletList' || node.type.name === 'orderedList') &&
        node.attrs.listId === listId,
    );
    if (list === null || index < 0 || index >= list.node.childCount) return null;
    const itemNode = list.node.child(index);
    if (itemNode.type.name !== 'listItem') return null;
    let itemPos = list.pos + 1;
    for (let i = 0; i < index; i += 1) itemPos += list.node.child(i).nodeSize;
    return { listId, index, listPos: list.pos, listNode: list.node, itemPos, itemNode };
  }

  #addListItemAt(element: HTMLElement): boolean {
    const hit = this.#listItemHit(element);
    if (hit === null) return false;
    const paragraph = this.#editor.schema.nodes.paragraph?.create({ blockId: newBlockId() });
    const item = this.#editor.schema.nodes.listItem?.create(
      { checked: typeof hit.itemNode.attrs.checked === 'boolean' ? false : null },
      paragraph,
    );
    if (item === undefined) return false;
    const at = hit.itemPos + hit.itemNode.nodeSize;
    const tr = closeHistory(this.#editor.state.tr).insert(at, item);
    tr.setSelection(TextSelection.create(tr.doc, at + 2));
    this.#editor.view.dispatch(tr);
    this.#editor.view.dom.focus({ preventScroll: true });
    return true;
  }

  #openResourceElement(resource: HTMLElement): boolean {
    if (this.#input.openResource === undefined) return false;
    try {
      if (resource.hasAttribute('data-flbp-resource')) {
        const target: unknown = JSON.parse(
          resource.getAttribute('data-target') ?? '{}',
        );
        if (!isResourceTarget(target)) return false;
        this.#input.openResource(target);
        return true;
      }
      const record = JSON.parse(
        resource.getAttribute('data-record') ?? '{}',
      ) as { type?: unknown; target?: ResourceTarget };
      if (
        record.type !== 'froglight.resource-link' ||
        !isResourceTarget(record.target)
      )
        return false;
      this.#input.openResource(record.target);
      return true;
    } catch {
      // Malformed preserved records remain visible but are not navigable.
      return false;
    }
  }

  #rootElementFor(blockId: string): HTMLElement | null {
    const pm = this.#host.querySelector('.ProseMirror');
    if (pm === null) return null;
    return (
      Array.from(
        pm.querySelectorAll<HTMLElement>('[data-block-id], [data-list-id]'),
      ).find(
        (child) =>
          child.dataset.blockId === blockId || child.dataset.listId === blockId,
      ) ?? null
    );
  }

  #slashEntries(): SlashCatalogItem[] {
    return filterSlashCatalog(
      buildSlashCatalog(this.#registry),
      this.#slashQuery,
    ).sort(
      (left, right) =>
        SLASH_GROUPS.indexOf(
          slashPresentation(left).group as (typeof SLASH_GROUPS)[number],
        ) -
        SLASH_GROUPS.indexOf(
          slashPresentation(right).group as (typeof SLASH_GROUPS)[number],
        ),
    );
  }

  /** Execute one catalog row through the canonical command paths. */
  #applyCatalogItem(item: SlashCatalogItem, trigger: SlashTrigger): boolean {
    const action = item.action;
    switch (action.kind) {
      case 'turn-into':
        return this.#turnInto(
          {
            type: action.type,
            ...(action.level !== undefined ? { level: action.level } : {}),
          },
          trigger,
        );
      case 'toggle-bullet':
        return this.#slashListCommit('bulletList', trigger);
      case 'toggle-ordered':
        return this.#slashListCommit('orderedList', trigger);
      case 'todo':
        return this.#slashTodoCommit(trigger);
      case 'insert':
        // The Table row opens the size picker: the trigger is
        // held, never deleted, until a preset commits or Escape dismisses.
        if (action.insertType === 'table') {
          this.#openTablePicker(trigger);
          return true;
        }
        // Math/diagram rows (over,
        // the fused insert commits first (single undo, trigger
        // deleted in the same transaction), then the engine-owned source
        // overlay opens anchored to the live figure so touch keyboards can
        // type the source immediately. The overlay commit is a second,
        // separate undo unit by design (empty insert + source text).
        if (action.insertType === 'math' || action.insertType === 'diagram') {
          const before = this.#mathDiagramBlockIds(action.insertType);
          if (!this.#insertBlock({ type: action.insertType }, trigger))
            return false;
          this.#openMathDiagramOverlayForNew(before, action.insertType);
          return true;
        }
        return this.#insertBlock({ type: action.insertType }, trigger);
      case 'resource-picker':
        // Outcome-before-mutation: without a resolver the picker
        // can never open, so refuse with the trigger untouched instead of
        // deleting it and reporting success. With a resolver the trigger is
        // removed up front (as before) and the async picker commits later via
        // #applyResourceChoice — async by nature, outside the single-tr scope.
        if (this.#input.resourceResolver === undefined) return false;
        // the trigger delete is its own undo unit — closeHistory
        // keeps it from merging with the adjacent /resource typing
        // (history newGroupDelay). The later async picker commit stays a
        // separate step by design.
        if (trigger.end > trigger.start) {
          this.#editor.view.dispatch(
            closeHistory(this.#editor.state.tr).delete(
              trigger.start,
              trigger.end,
            ),
          );
        }
        this.#openResourceMenu(
          '',
          0,
          this.#editor.state.selection.from,
          action.resourceType,
        );
        return true;
      case 'opaque':
        return this.#insertBlock(
          {
            type: 'opaque',
            typeId: action.opaqueTypeId,
          },
          trigger,
        );
    }
  }

  /**
   * Structural pre-check shared by the fused list commits: the slash caret
   * must be collapsed in a textblock with a valid toggle range, mirroring
   * the `if (!range) return false` early-out of Tiptap's toggleList. Runs
   * before any mutation so a would-be failure refuses with the trigger
   * untouched. Deliberately not `can().toggleX()`: the dry-run disagrees
   * with the real run in code contexts (false vs converting wrap), while the
   * fused chain below always observes the same live state the real run does.
   */
  #slashToggleRangeValid(): boolean {
    const { $from, empty } = this.#editor.state.selection;
    if (!empty || !$from.parent.isTextblock) return false;
    return $from.blockRange($from) !== null;
  }

  /**
   * True when a toggle from the current collapsed caret would LIFT the
   * surrounding same-type list instead of wrapping: mirrors the
   * `isInsideExistingList && same type` branch of Tiptap's toggleList (nearest
   * list ancestor, `range.depth - listDepth <= 1`) without dispatching
   * anything. Whole-doc-selection lift cannot arise from a collapsed slash
   * caret, so only the ancestor case matters. A different-type nearest list
   * converts (keeps a listItem) and no list at all wraps — both fine.
   */
  #slashToggleWouldLift(listType: 'bulletList' | 'orderedList'): boolean {
    const { $from } = this.#editor.state.selection;
    const range = $from.blockRange($from);
    if (range === null) return true;
    for (let depth = $from.depth; depth >= 0; depth -= 1) {
      const name = $from.node(depth).type.name;
      if (name !== 'bulletList' && name !== 'orderedList') continue;
      if (name !== listType) return false;
      return range.depth >= 1 && range.depth - depth <= 1;
    }
    return false;
  }

  /**
   * Fused list-toggle commit: trigger deletion + the real
   * toggleBulletList/toggleOrderedList share one Tiptap chain — one
   * transaction, one dispatch, one undo step (verified: post-undo model
   * equals the pre-commit model). The toggle observes the chainable
   * (post-delete) state, exactly as the old delete-then-toggle sequence did,
   * so outcomes are unchanged; only history granularity is. closeHistory
   * first: the commit must be its own undo unit, never merged with the
   * adjacent trigger typing (see #turnInto). The trailing stamp/strip/focus
   * steps are the same three in-chain commands as #turnIntoList:
   * without them the new list keeps a null listId and a stale inner blockId
   * and the toolbar misreports it as a paragraph.
   */
  #slashListCommit(
    listType: 'bulletList' | 'orderedList',
    trigger: SlashTrigger,
  ): boolean {
    if (!this.#slashToggleRangeValid()) return false;
    const fused = this.#editor.chain().command(({ tr }) => {
      closeHistory(tr);
      if (trigger.end > trigger.start) tr.delete(trigger.start, trigger.end);
      return true;
    });
    const toggled =
      listType === 'bulletList'
        ? fused.toggleBulletList()
        : fused.toggleOrderedList();
    return toggled
      .command(({ tr }) => this.#stampListIdAroundCaret(tr))
      .command(({ tr }) => this.#stripInnerParagraphIds(tr))
      .command(({ tr }) => this.#focusListAroundCaret(tr))
      .run();
  }

  /**
   * Fused to-do commit: trigger deletion + toggleBulletList +
   * checked:false marking share one chain (one undo step). No Tiptap command
   * boundary prevents the fusion — the chain threads a single tr — so there
   * is no limitation to carry to. The final marking step is infallible
   * by construction: the guards below refuse code contexts outright and any
   * toggle that would lift (no listItem left around the caret), while the
   * remaining wrap/convert outcomes always keep one. Stamp/strip/focus match
   * #turnIntoList so slash todos report as To-do items.
   */
  #slashTodoCommit(trigger: SlashTrigger): boolean {
    const { $from, empty } = this.#editor.state.selection;
    if (!empty || !$from.parent.isTextblock) return false;
    // Code content must never become a to-do: the toggle would
    // convert-and-wrap, destroying code semantics (and content) on decode.
    // Refuse with the trigger untouched.
    if ($from.parent.type.name === 'codeBlock') return false;
    if (!this.#slashToggleRangeValid()) return false;
    // A toggle that would lift leaves no listItem to check — refuse before
    // mutating instead of deleting the trigger and reporting failure.
    if (this.#slashToggleWouldLift('bulletList')) return false;
    return this.#editor
      .chain()
      .command(({ tr }) => {
        closeHistory(tr);
        if (trigger.end > trigger.start) tr.delete(trigger.start, trigger.end);
        return true;
      })
      .toggleBulletList()
      .command(({ tr }) => this.#stampListIdAroundCaret(tr))
      .command(({ tr }) => this.#stripInnerParagraphIds(tr))
      .command(({ tr }) => this.#checkTodoItem(tr))
      .command(({ tr }) => this.#focusListAroundCaret(tr))
      .run();
  }

  /** Mark the listItem around the chain caret as an unchecked to-do. */
  #checkTodoItem(tr: Transaction): boolean {
    const $c = tr.selection.$from;
    for (let depth = $c.depth; depth >= 0; depth -= 1) {
      if ($c.node(depth).type.name !== 'listItem') continue;
      const pos = $c.before(depth);
      const item = tr.doc.nodeAt(pos);
      if (item === null) return false;
      tr.setNodeMarkup(pos, undefined, { ...item.attrs, checked: false });
      return true;
    }
    return false;
  }

  #applySlashEntry(index: number): boolean {
    // Touch pointerup + click both fire: the second event must be a no-op.
    if (!this.#slashOpen) return false;
    // belt-and-braces — slash cannot open in-grid, but a
    // stale commit must still refuse with the trigger untouched.
    if (this.#inTableGrid(this.#editor.state)) {
      this.#closeSlash();
      return false;
    }
    const entry = this.#slashEntries()[index];
    const queryLength = this.#slashQuery.length;
    this.#closeSlash();
    if (entry === undefined) return false;
    // The trigger never survives a successful command: its range ("/" + the
    // typed filter) travels with the entry into the fused commit, which
    // deletes it inside the same transaction as its effect — or refuses
    // without touching it when the outcome is decided against committing.
    const { from } = this.#editor.state.selection;
    const start = Math.max(0, from - (queryLength + 1));
    return this.#applyCatalogItem(entry, { start, end: from });
  }

  #closeSlash(): void {
    this.#slashOpen = false;
    this.#slashQuery = '';
    this.#slashActive = 0;
    if (this.#menuEl() !== null) this.#menuEl()!.style.display = 'none';
  }

  #menuEl(): HTMLElement | null {
    return this.#host.querySelector(
      '.flbp-slash:not(.flbp-resource-menu):not(.flbp-turninto-menu)',
    );
  }

  #resourceMenuEl(): HTMLElement | null {
    return this.#host.querySelector('.flbp-resource-menu');
  }

  #tableMenuEl(): HTMLElement | null {
    return this.#host.querySelector('.flbp-table-menu');
  }

  #handleMenuEl(): HTMLElement | null {
    return this.#host.querySelector('.flbp-turninto-menu');
  }

  #positionMenuAtSelection(menu: HTMLElement): void {
    try {
      const coords = this.#editor.view.coordsAtPos(
        this.#editor.state.selection.from,
      );
      positionBlockpageOverlay(
        this.#host,
        menu,
        {
          left: coords.left,
          top: coords.top,
          right: coords.right,
          bottom: coords.bottom,
          width: Math.max(0, coords.right - coords.left),
          height: Math.max(0, coords.bottom - coords.top),
        },
        { maxHeight: 360 },
      );
    } catch {
      menu.style.left = `${this.#host.scrollLeft + 8}px`;
      menu.style.top = `${this.#host.scrollTop + 8}px`;
    }
  }

  #positionHandleMenu(menu: HTMLElement): void {
    const drag = this.#handleMenuAnchor;
    const block =
      this.#handleMenuBlockId !== null
        ? this.#rootElementFor(this.#handleMenuBlockId)
        : null;
    const anchor = drag?.isConnected === true ? drag : block;
    if (anchor === null) {
      menu.style.left = `${this.#host.scrollLeft + 8}px`;
      menu.style.top = `${this.#host.scrollTop + 8}px`;
      return;
    }
    try {
      const rect = anchor.getBoundingClientRect();
      positionBlockpageOverlay(
        this.#host,
        menu,
        {
          left: rect.left,
          top: rect.top,
          right: rect.right,
          bottom: rect.bottom,
          width: rect.width,
          height: rect.height,
        },
        { maxHeight: 360 },
      );
    } catch {
      menu.style.left = `${this.#host.scrollLeft + 8}px`;
      menu.style.top = `${this.#host.scrollTop + 8}px`;
    }
  }

  #positionOpenChrome(): void {
    if (this.#slashOpen) {
      const menu = this.#menuEl();
      if (menu !== null) this.#positionMenuAtSelection(menu);
    }
    if (this.#resourceOpen) {
      const menu = this.#resourceMenuEl();
      if (menu !== null) this.#positionMenuAtSelection(menu);
    }
    if (this.#tablePickerOpen) {
      const menu = this.#tableMenuEl();
      if (menu !== null) this.#positionMenuAtSelection(menu);
    }
    if (this.#handleMenuOpen) {
      const menu = this.#handleMenuEl();
      if (menu !== null) this.#positionHandleMenu(menu);
    }
  }

  /**
   * Turn-into entries for the drag-handle menu: the same
   * catalog subset as the toolbar, unfiltered and stably ordered.
   * Builder stays provider-local (never exported).
   */
  #handleMenuEntries(): HandleMenuEntry[] {
    if (this.#handleMenuItem !== null) {
      const hit = this.#listItemHit(this.#handleMenuItem);
      if (hit === null) return [];
      if (this.#handleMenuTransforms) return [
        { label: 'Back to block actions', action: { kind: 'back' } },
        ...turnIntoCatalogItems(this.#registry).filter((entry) => entry.action.kind === 'turn-into'),
      ];
      return [
        { label: 'Turn into…', action: { kind: 'show-transforms' } },
        ...(hit.index > 0 ? [{ label: 'Move up', action: { kind: 'move-relative', direction: -1 } } as const] : []),
        ...(hit.index < hit.listNode.childCount - 1 ? [{ label: 'Move down', action: { kind: 'move-relative', direction: 1 } } as const] : []),
        { label: 'Delete item', action: { kind: 'delete-block' } },
      ];
    }
    const moves: Array<{
      label: string;
      action: { kind: 'move-relative'; direction: -1 | 1 };
    }> = [];
    const id = this.#handleMenuBlockId;
    if (id !== null) {
      for (const direction of [-1, 1] as const) {
        if (this.#siblingMove(id, direction) !== null)
          moves.push({
            label: direction < 0 ? 'Move up' : 'Move down',
            action: { kind: 'move-relative', direction },
          });
      }
    }
    const hit =
      id === null ? null : this.#findBy((node) => this.#keyOf(node) === id);
    const transforms =
      hit === null
        ? []
        : turnIntoCatalogItems(this.#registry).filter((entry) => {
            const source = hit.node.type.name;
            const action = entry.action;
            const listAction =
              action.kind === 'toggle-bullet' ||
              action.kind === 'toggle-ordered' ||
              action.kind === 'todo';
            if (source === 'bulletList' || source === 'orderedList') {
              if (listAction) {
                if (
                  source === 'bulletList' &&
                  action.kind === 'toggle-bullet' &&
                  !this.#listHasChecked(hit.node)
                )
                  return false;
                if (
                  source === 'orderedList' &&
                  action.kind === 'toggle-ordered'
                )
                  return false;
                return true;
              }
              return action.kind === 'turn-into' && action.type === 'paragraph';
            }
            const turnable =
              source === 'paragraph' ||
              source === 'heading' ||
              source === 'blockquote' ||
              source === 'codeBlock' ||
              source === 'toggle' ||
              source === 'callout';
            if (!turnable) return false;
            if (source === 'codeBlock' && action.kind === 'todo') return false;
            if (listAction) return true;
            if (action.kind !== 'turn-into') return false;
            if (source === 'paragraph' && action.type === 'paragraph')
              return false;
            if (source === 'blockquote' && action.type === 'quote')
              return false;
            if (source === 'codeBlock' && action.type === 'code') return false;
            if (source === 'toggle' && action.type === 'toggle') return false;
            if (source === 'callout' && action.type === 'callout') return false;
            if (
              source === 'heading' &&
              action.type === 'heading' &&
              action.level === hit.node.attrs.level
            )
              return false;
            return true;
          });
    if (this.#handleMenuTransforms) {
      return [
        { label: 'Back to block actions', action: { kind: 'back' } },
        ...transforms,
      ];
    }
    return [
      ...(transforms.length > 0
        ? [
            {
              label: 'Turn into…',
              action: { kind: 'show-transforms' } as const,
            },
          ]
        : []),
      ...moves,
      { label: 'Delete block', action: { kind: 'delete-block' } },
    ];
  }

  /**
   * Open the handle menu for one block id. Freezes the gutter handle
   * hover/mouseleave stop retargeting until close. Positions from
   * the drag handle (or the block element as fallback) like the slash menu
   * positions from caret coordinates.
   *
   * The menu omits transforms that would be no-ops or cannot apply to the
   * selected structure. This keeps the catalog authoritative while avoiding
   * rows that silently do nothing. Opening preserves the current selection
   * and focuses the editor without scrolling it back to an offscreen caret.
   */
  #openHandleMenu(blockId: string, anchor?: HTMLElement): void {
    const hit = this.#findBy((node) => this.#keyOf(node) === blockId);
    if (hit === null) return;
    this.#closeSlash();
    this.#closeResourceMenu();
    this.#handleMenuOpen = true;
    this.#handleMenuTransforms = false;
    this.#handleMenuAnchor = anchor ?? this.#host.querySelector<HTMLElement>('.flbp-drag-handle');
    this.#handleMenuAnchor?.setAttribute('aria-expanded', 'true');
    this.#handleMenuBlockId = blockId;
    this.#handleMenuItem = this.#hoveredListItem?.parentElement?.dataset.listId === blockId
      ? this.#hoveredListItem : null;
    this.#handleMenuActive = 0;
    this.#renderHandleMenu();
    this.#editor.view.dom.focus({ preventScroll: true });
  }

  #closeHandleMenu(): void {
    if (!this.#handleMenuOpen) return;
    this.#handleMenuOpen = false;
    this.#handleMenuTransforms = false;
    this.#handleMenuAnchor?.setAttribute('aria-expanded', 'false');
    this.#handleMenuAnchor = null;
    this.#handleMenuBlockId = null;
    this.#handleMenuItem = null;
    this.#handleMenuActive = 0;
    const menu = this.#handleMenuEl();
    if (menu !== null) {
      menu.style.display = 'none';
      menu.removeAttribute('aria-activedescendant');
    }
  }

  #renderHandleMenu(): void {
    const menu = this.#handleMenuEl();
    if (menu === null || !this.#handleMenuOpen) return;
    const entries = this.#handleMenuEntries();
    menu.textContent = '';
    this.#handleMenuActive = Math.min(
      Math.max(0, this.#handleMenuActive),
      Math.max(0, entries.length - 1),
    );
    const firstMove = entries.findIndex(
      (entry) => entry.action.kind === 'move-relative',
    );
    entries.forEach((entry, index) => {
      if (index === 0) {
        const heading = document.createElement('div');
        heading.className = 'flbp-menu-group-label';
        heading.setAttribute('role', 'presentation');
        heading.textContent = this.#handleMenuTransforms
          ? 'Turn into'
          : this.#handleMenuItem !== null ? 'List item' : 'Block';
        menu.appendChild(heading);
      }
      if (index === firstMove && firstMove > 0) {
        const heading = document.createElement('div');
        heading.className = 'flbp-menu-group-label';
        heading.setAttribute('role', 'presentation');
        heading.textContent = 'Move';
        menu.appendChild(heading);
      }
      const item = document.createElement('div');
      item.className =
        index === this.#handleMenuActive
          ? 'flbp-slash-item active'
          : 'flbp-slash-item';
      item.dataset.index = String(index);
      item.id = `flbp-turninto-${index}`;
      item.setAttribute('role', 'option');
      item.setAttribute(
        'aria-selected',
        String(index === this.#handleMenuActive),
      );
      item.textContent = entry.label;
      menu.appendChild(item);
    });
    menu.style.display = entries.length > 0 ? 'block' : 'none';
    if (entries.length > 0) {
      menu.setAttribute(
        'aria-activedescendant',
        `flbp-turninto-${this.#handleMenuActive}`,
      );
      this.#positionHandleMenu(menu);
    } else {
      menu.removeAttribute('aria-activedescendant');
    }
  }

  /**
   * Move the selection into the menu's block, then run the same command
   * path as slash/toolbar (no trigger, single undo). Outcome-before-
   * mutation: focus failure or unknown action refuses with the menu
   * dismissed and the model untouched. Focus is VERIFIED after moving
   * atoms/regions have no inner caret, so `TextSelection.near`
   * can wander into a neighbor (or an invalid position) — turning that
   * neighbor for a menu opened elsewhere would be a surprise mutation, so
   * the commit refuses unless the focused keyed root IS the menu's block.
   * The incompatible-block policy stays: dismissed menu, untouched model,
   * no history step.
   */
  #applyHandleMenuEntry(index: number): boolean {
    // Touch pointerup + click both fire: the second event must be a no-op.
    if (!this.#handleMenuOpen) return false;
    const entry = this.#handleMenuEntries()[index];
    const blockId = this.#handleMenuBlockId;
    const item = this.#handleMenuItem;
    if (
      entry?.action.kind === 'show-transforms' ||
      entry?.action.kind === 'back'
    ) {
      this.#handleMenuTransforms = entry.action.kind === 'show-transforms';
      this.#handleMenuActive = 0;
      this.#renderHandleMenu();
      return true;
    }
    this.#closeHandleMenu();
    if (entry === undefined || blockId === null) return false;
    if (item !== null) {
      const hit = this.#listItemHit(item);
      const source = blockDragSource(this.#editor.view, item);
      if (hit === null || source === null) return false;
      if (entry.action.kind === 'turn-into') {
        const tr = closeHistory(this.#editor.state.tr);
        const content = itemToBlocks(hit.itemNode, this.#editor.schema, entry.action.type, entry.action.level);
        if (splitListAt(tr, hit.itemPos, content, 1) === null) return false;
        this.#editor.view.dispatch(tr);
      } else if (entry.action.kind === 'move-relative') {
        const to = entry.action.direction < 0
          ? hit.itemPos - hit.listNode.child(hit.index - 1).nodeSize
          : hit.itemPos + hit.itemNode.nodeSize + hit.listNode.child(hit.index + 1).nodeSize;
        const tr = blockDropTransaction(this.#editor.view, source, to);
        if (tr === null) return false;
        this.#editor.view.dispatch(tr);
      } else if (entry.action.kind === 'delete-block') {
        const from = hit.listNode.childCount === 1 ? hit.listPos : hit.itemPos;
        const size = hit.listNode.childCount === 1 ? hit.listNode.nodeSize : hit.itemNode.nodeSize;
        this.#editor.view.dispatch(closeHistory(this.#editor.state.tr).delete(from, from + size));
      } else return false;
      this.#editor.view.dom.focus({ preventScroll: true });
      return true;
    }
    if (entry.action.kind === 'delete-block') {
      const hit = this.#findBy((node) => this.#keyOf(node) === blockId);
      if (hit === null) return false;
      const fragment = this.#movableFragment(hit);
      const index = hit.parent.content.content.indexOf(hit.node);
      if (index < 0) return false;
      const replacement =
        hit.parent === this.#editor.state.doc &&
        fragment.content.childCount === this.#editor.state.doc.childCount
          ? Fragment.from(
              this.#editor.schema.nodes.paragraph.create({
                blockId: newBlockId(),
              }),
            )
          : Fragment.empty;
      if (
        !hit.parent.canReplace(
          index,
          index + fragment.content.childCount,
          replacement,
        )
      )
        return false;
      const tr = closeHistory(
        this.#editor.state.tr.replaceWith(
          fragment.from,
          fragment.to,
          replacement,
        ),
      );
      this.#removeEmptyGroups(tr);
      this.#editor.view.dispatch(tr);
      this.#editor.view.dom.focus({ preventScroll: true });
      return true;
    }
    if (entry.action.kind === 'move-relative') {
      const transaction = this.#siblingMove(blockId, entry.action.direction);
      if (transaction === null) return false;
      this.#editor.view.dispatch(transaction);
      this.#focusHandleBlock(blockId);
      return true;
    }
    if (!this.#focusHandleBlock(blockId)) return false;
    let focusedKey: string | null = null;
    try {
      const focused = this.#currentRoot();
      const node = focused?.node as PMNode | null | undefined;
      focusedKey =
        node === null || node === undefined ? null : this.#keyOf(node);
    } catch {
      focusedKey = null;
    }
    if (focusedKey !== blockId) return false;
    // Guard multi-root like the toolbar: a range selection spanning roots
    // refuses instead of turning only the anchor.
    if (!this.#editor.state.selection.empty && this.#touchedRootCount() > 1)
      return false;
    const action = entry.action;
    switch (action.kind) {
      case 'turn-into':
        return this.#turnInto({
          type: action.type,
          ...(action.level !== undefined ? { level: action.level } : {}),
        });
      case 'toggle-bullet':
        return this.#turnIntoList('bullet');
      case 'toggle-ordered':
        return this.#turnIntoList('ordered');
      case 'todo':
        return this.#turnIntoList('todo');
      default:
        return false;
    }
  }

  /**
   * Focus the menu's block without stealing scroll: caret just inside
   * textblocks, node selection for atoms. Returns false when the block
   * cannot be located (menu already dismissed, nothing mutated).
   */
  #focusHandleBlock(blockId: string): boolean {
    const hit = this.#findBy((node) => this.#keyOf(node) === blockId);
    if (hit === null) return false;
    try {
      const doc = this.#editor.state.doc;
      const resolved = doc.resolve(Math.min(hit.pos + 1, doc.content.size));
      let selection;
      try {
        selection = TextSelection.near(resolved);
      } catch {
        selection = new NodeSelection(resolved);
      }
      this.#editor.view.dispatch(this.#editor.state.tr.setSelection(selection));
      this.#editor.commands.focus();
      return true;
    } catch {
      return false;
    }
  }

  #openResourceMenu(
    query: string,
    triggerLength: number,
    from: number,
    blockType: ResourceBlockType | null = null,
    trigger?: string,
  ): void {
    const resolver = this.#input.resourceResolver;
    if (resolver === undefined) return;
    this.#resourceOpen = true;
    this.#resourceQuery = query;
    this.#resourceTrigger =
      trigger ?? (triggerLength === 2 ? '[[' : triggerLength === 1 ? '@' : '');
    this.#resourceTriggerLength = triggerLength;
    this.#resourceBlockType = blockType;
    this.#resourceActive = 0;
    const request = ++this.#resourceRequest;
    Promise.resolve(resolver.search(query))
      .then((suggestions) => {
        if (!this.#resourceOpen || request !== this.#resourceRequest) return;
        this.#resourceChoices = this.#resourceChoicesFrom(
          suggestions,
          blockType,
        );
        this.#renderResourceMenu(from);
      })
      .catch(() => {
        if (request === this.#resourceRequest) this.#resourceChoices = [];
      });
  }

  #resourceChoicesFrom(
    suggestions: readonly ResourceSuggestion[],
    blockType: ResourceBlockType | null,
  ): ResourceChoice[] {
    // Shared picker semantics ([[ / @ inline): only stable ResourceTargets
    // become choices. Malformed resolver payloads never reach the menu, so
    // commit cannot insert unstable marks.
    const stable = suggestions.filter((s) => isResourceTarget(s.target));
    if (blockType === 'transclusion') {
      return stable.flatMap((suggestion) =>
        (suggestion.addresses ?? []).map((entry) => ({
          target: { ...suggestion.target, address: entry.address },
          label: `${suggestion.label} — ${entry.label}`,
        })),
      );
    }
    if (blockType === 'linked-view') {
      return stable.flatMap((suggestion) =>
        (suggestion.views ?? []).map((entry) => ({
          target: suggestion.target,
          label: `${suggestion.label} — ${entry.label}`,
          viewId: entry.viewId,
        })),
      );
    }
    return stable.map((suggestion) => ({
      target: suggestion.target,
      label: suggestion.label,
    }));
  }

  #renderResourceMenu(from: number): void {
    const menu = this.#resourceMenuEl();
    if (menu === null) return;
    menu.textContent = '';
    this.#resourceActive = Math.min(
      Math.max(0, this.#resourceActive),
      Math.max(0, this.#resourceChoices.length - 1),
    );
    this.#resourceChoices.forEach((choice, index) => {
      const item = document.createElement('div');
      item.className =
        index === this.#resourceActive
          ? 'flbp-slash-item active'
          : 'flbp-slash-item';
      item.dataset.index = String(index);
      item.id = `flbp-resource-${index}`;
      item.setAttribute('role', 'option');
      item.setAttribute(
        'aria-selected',
        String(index === this.#resourceActive),
      );
      item.textContent = choice.label;
      menu.appendChild(item);
    });
    menu.style.display = this.#resourceChoices.length > 0 ? 'block' : 'none';
    if (this.#resourceChoices.length === 0) {
      menu.removeAttribute('aria-activedescendant');
      return;
    }
    menu.setAttribute(
      'aria-activedescendant',
      `flbp-resource-${this.#resourceActive}`,
    );
    this.#positionMenuAtSelection(menu);
  }

  #applyResourceChoice(index: number): boolean {
    // Touch pointerup + click both fire: the second event must be a no-op.
    if (!this.#resourceOpen) return false;
    const choice = this.#resourceChoices[index];
    if (choice === undefined) return false;
    if (!isResourceTarget(choice.target)) return false;
    const blockType = this.#resourceBlockType;
    if (blockType !== null) {
      this.#closeResourceMenu();
      return this.#insertBlock({
        type: blockType,
        target: structuredClone(choice.target),
        label: choice.label,
        ...(choice.viewId !== undefined ? { viewId: choice.viewId } : {}),
      });
    }
    const { from } = this.#editor.state.selection;
    const start = Math.max(
      0,
      from - this.#resourceTriggerLength - this.#resourceQuery.length,
    );
    // Async race guard: the resolver may resolve after the caret
    // moved or the trigger text changed (slow resolver + continued typing).
    // Revalidate that the commit range still holds exactly trigger + query
    // before deleting it; on mismatch dismiss without mutating.
    const expected = `${this.#resourceTrigger}${this.#resourceQuery}`;
    let actual: string | null = null;
    try {
      actual = this.#editor.state.doc.textBetween(
        start,
        from,
        undefined,
        '\uFFFC',
      );
    } catch {
      actual = null;
    }
    if (actual !== expected) {
      this.#closeResourceMenu();
      return false;
    }
    const mark = this.#editor.schema.marks.resourceMark.create({
      target: structuredClone(choice.target),
    });
    const text = this.#editor.schema.text(choice.label, [mark]);
    // the async inline commit is its own undo unit — closeHistory
    // keeps it from merging with the adjacent trigger typing
    // (wall-clock-dependent granularity without it).
    this.#editor.view.dispatch(
      closeHistory(this.#editor.state.tr).replaceWith(start, from, text),
    );
    this.#closeResourceMenu();
    return true;
  }

  #closeResourceMenu(): void {
    this.#resourceOpen = false;
    this.#resourceQuery = '';
    this.#resourceTrigger = '';
    this.#resourceChoices = [];
    this.#resourceActive = 0;
    this.#resourceBlockType = null;
    this.#resourceRequest += 1;
    const menu = this.#resourceMenuEl();
    if (menu !== null) menu.style.display = 'none';
  }

  /**
   * Table size picker: the slash Table row opens a preset
   * choice (2×2 default) instead of inserting blindly. The slash trigger
   * range is held here — never deleted — until a size commits through the
   * fused #insertBlock path (single undo) or Escape dismisses with the
   * trigger text untouched.
   */
  #openTablePicker(trigger: SlashTrigger): void {
    this.#tablePickerOpen = true;
    this.#tablePickerActive = 0;
    this.#tablePickerTrigger = trigger;
    this.#renderTablePicker(this.#editor.state.selection.from);
  }

  #renderTablePicker(from: number): void {
    const menu = this.#tableMenuEl();
    if (menu === null) return;
    menu.textContent = '';
    TABLE_SIZE_PRESETS.forEach((preset, index) => {
      const item = document.createElement('div');
      item.className =
        index === this.#tablePickerActive
          ? 'flbp-slash-item active'
          : 'flbp-slash-item';
      item.dataset.index = String(index);
      item.id = `flbp-table-${preset.id}`;
      item.setAttribute('role', 'option');
      item.setAttribute(
        'aria-selected',
        String(index === this.#tablePickerActive),
      );
      item.textContent = preset.label;
      menu.appendChild(item);
    });
    menu.style.display = 'block';
    menu.setAttribute(
      'aria-activedescendant',
      `flbp-table-${TABLE_SIZE_PRESETS[this.#tablePickerActive]!.id}`,
    );
    this.#positionMenuAtSelection(menu);
  }

  #applyTableSize(index: number): boolean {
    // Touch pointerup + click both fire: the second event must be a no-op.
    if (!this.#tablePickerOpen) return false;
    // an out-of-range index refuses with the trigger
    // untouched — never silently fall back to the 2×2 default for a size
    // the user did not choose. The picker stays open for a valid choice.
    const preset = TABLE_SIZE_PRESETS[index];
    if (preset === undefined) return false;
    const trigger = this.#tablePickerTrigger;
    this.#closeTablePicker();
    if (trigger === null) return false;
    return this.#insertBlock(
      { type: 'table', rows: preset.rows, cols: preset.cols },
      trigger,
    );
  }

  #closeTablePicker(): void {
    this.#tablePickerOpen = false;
    this.#tablePickerActive = 0;
    this.#tablePickerTrigger = null;
    const menu = this.#tableMenuEl();
    if (menu !== null) menu.style.display = 'none';
  }

  #renderSlash(from: number): void {
    const menu = this.#menuEl();
    if (menu === null) return;
    menu.textContent = '';
    const entries = this.#slashEntries();
    // The filter can shrink under a navigated index: clamp so commit always
    // targets the visible entry instead of deleting the trigger for nothing.
    this.#slashActive = Math.min(
      Math.max(0, this.#slashActive),
      Math.max(0, entries.length - 1),
    );
    let previousGroup = '';
    entries.forEach((entry, index) => {
      const { group, description, symbol } = slashPresentation(entry);
      if (group !== previousGroup) {
        const heading = document.createElement('div');
        heading.className = 'flbp-menu-group-label';
        heading.textContent = group;
        heading.setAttribute('role', 'presentation');
        menu.appendChild(heading);
        previousGroup = group;
      }
      const item = document.createElement('div');
      item.className =
        index === this.#slashActive
          ? 'flbp-slash-item active'
          : 'flbp-slash-item';
      item.dataset.index = String(index);
      item.id = `flbp-slash-${index}`;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(index === this.#slashActive));
      item.dataset.symbol = symbol;
      item.dataset.description = description;
      item.setAttribute('aria-description', description);
      item.title = description;
      item.textContent = entry.label;
      menu.appendChild(item);
    });
    menu.style.display = entries.length > 0 ? 'block' : 'none';
    if (entries.length > 0) {
      menu.setAttribute(
        'aria-activedescendant',
        `flbp-slash-${this.#slashActive}`,
      );
      this.#positionMenuAtSelection(menu);
    } else {
      menu.removeAttribute('aria-activedescendant');
    }
  }

  // --- ProseMirror plugins ---

  #chromePlugin() {
    // ProseMirror plugin props are plain functions; capture the handle once.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const handle = this;
    return Extension.create({
      name: 'flbpChrome',
      addProseMirrorPlugins() {
        return [
          new Plugin({
            key: new PluginKey('flbpChrome'),
            props: {
              handleKeyDown(view, event) {
                // IME guard: engine short-circuit mirroring the
                // input-rules posture. While composing, no chrome branch —
                // table picker, handle menu, resource/slash menus, Tab
                // indent, or Backspace join — may claim keys. The grid keymap
                // guards `view.composing` itself (shortcut methods never see
                // the event); appendTransaction detection guards below. jsdom
                // cannot run a real IME session: specs pin the event half
                // plus a synthetic compositionstart path and document that
                // limit honestly.
                if (view.composing || event.isComposing) return false;
                if (event.key === 'Enter') reconcileCollapsedDomCaret(view);
                // Source overlay Esc: dismisses with focus return
                // to the editor and no mutation (the overlay's own
                // textarea Esc is handled inside the controller).
                if (
                  event.key === 'Escape' &&
                  handle.#isMathDiagramOverlayOpen()
                ) {
                  event.preventDefault();
                  handle.#closeMathDiagramOverlay();
                  handle.focus();
                  return true;
                }
                // Table size picker first (same keyboard model as slash:
                // arrows move, Enter/Tab commits the preset, Esc dismisses
                // with the trigger untouched).
                if (handle.#tablePickerOpen) {
                  const count = TABLE_SIZE_PRESETS.length;
                  if (event.key === 'ArrowDown') {
                    handle.#tablePickerActive = Math.min(
                      count - 1,
                      handle.#tablePickerActive + 1,
                    );
                    handle.#renderTablePicker(view.state.selection.from);
                    return true;
                  }
                  if (event.key === 'ArrowUp') {
                    handle.#tablePickerActive = Math.max(
                      0,
                      handle.#tablePickerActive - 1,
                    );
                    handle.#renderTablePicker(view.state.selection.from);
                    return true;
                  }
                  if (event.key === 'Enter' || event.key === 'Tab') {
                    event.preventDefault();
                    handle.#applyTableSize(handle.#tablePickerActive);
                    return true;
                  }
                  if (event.key === 'Escape') {
                    handle.#closeTablePicker();
                    return true;
                  }
                  return false;
                }
                // Handle turn-into menu first (same keyboard model as slash:
                // arrows move, Enter/Tab commits, Esc dismisses).
                if (handle.#handleMenuOpen) {
                  const count = handle.#handleMenuEntries().length;
                  if (event.key === 'ArrowDown') {
                    handle.#handleMenuActive = Math.min(
                      Math.max(0, count - 1),
                      Math.max(0, handle.#handleMenuActive + 1),
                    );
                    handle.#renderHandleMenu();
                    return true;
                  }
                  if (event.key === 'ArrowUp') {
                    handle.#handleMenuActive = Math.max(
                      0,
                      handle.#handleMenuActive - 1,
                    );
                    handle.#renderHandleMenu();
                    return true;
                  }
                  if (
                    (event.key === 'Enter' || event.key === 'Tab') &&
                    count > 0
                  ) {
                    event.preventDefault();
                    handle.#applyHandleMenuEntry(handle.#handleMenuActive);
                    return true;
                  }
                  // Empty-catalog Tab edge: turnIntoCatalogItems always
                  // carries the core rows, so count > 0 holds whenever the
                  // menu is open and Tab commits above. With zero entries
                  // Tab/Enter deliberately fall through to the default
                  // instead of trapping keys or inventing an indent.
                  if (event.key === 'Escape') {
                    if (handle.#handleMenuTransforms) {
                      handle.#handleMenuTransforms = false;
                      handle.#handleMenuActive = 0;
                      handle.#renderHandleMenu();
                    } else {
                      handle.#closeHandleMenu();
                    }
                    return true;
                  }
                  // Other keys dismiss? No: typing while the menu is open
                  // keeps it (frozen handle) until commit/dismiss.
                  return false;
                }
                if (handle.#resourceOpen) {
                  const count = handle.#resourceChoices.length;
                  if (event.key === 'ArrowDown') {
                    handle.#resourceActive = Math.min(
                      Math.max(0, count - 1),
                      handle.#resourceActive + 1,
                    );
                    handle.#renderResourceMenu(view.state.selection.from);
                    return true;
                  }
                  if (event.key === 'ArrowUp') {
                    handle.#resourceActive = Math.max(
                      0,
                      handle.#resourceActive - 1,
                    );
                    handle.#renderResourceMenu(view.state.selection.from);
                    return true;
                  }
                  if (
                    (event.key === 'Enter' || event.key === 'Tab') &&
                    count > 0
                  )
                    return handle.#applyResourceChoice(handle.#resourceActive);
                  if (event.key === 'Escape') {
                    handle.#closeResourceMenu();
                    return true;
                  }
                } else if (handle.#slashOpen) {
                  const count = handle.#slashEntries().length;
                  if (event.key === 'ArrowDown') {
                    // Clamped both ends: count 0 never underflows to -1.
                    handle.#slashActive = Math.min(
                      Math.max(0, count - 1),
                      Math.max(0, handle.#slashActive + 1),
                    );
                    handle.#renderSlash(view.state.selection.from);
                    return true;
                  }
                  if (event.key === 'ArrowUp') {
                    handle.#slashActive = Math.max(0, handle.#slashActive - 1);
                    handle.#renderSlash(view.state.selection.from);
                    return true;
                  }
                  // Enter and Tab share commit semantics with the resource
                  // picker (keyboard parity): the count>0 guard
                  // mirrors the picker, so an empty filter falls through to
                  // the default newline instead of trapping Enter. A commit
                  // attempt always consumes the key — even when it refuses
                  // (no-resolver resource rows, inapplicable to-dos): refusal
                  // leaves the model untouched, and falling
                  // through would split the paragraph under a failed menu.
                  if (
                    (event.key === 'Enter' || event.key === 'Tab') &&
                    count > 0
                  ) {
                    event.preventDefault();
                    handle.#applySlashEntry(handle.#slashActive);
                    return true;
                  }
                  if (event.key === 'Escape') {
                    handle.#closeSlash();
                    return true;
                  }
                } else if (event.key === 'Escape') {
                  handle.blockCommand('clear-selection');
                  return true;
                }
                if (event.key === 'Enter' && !event.shiftKey && enterToggleSummary(view)) {
                  event.preventDefault();
                  return true;
                }
                if (event.key === 'Tab') {
                  // Grid cells own Tab: cell navigation lives in the
                  // FlbpTableGrid keymap. Yield here so indent/outdent can
                  // never lift cell content out of the grid.
                  if (handle.#inTableGrid(view.state)) return false;
                  // Keyboard-first structural editing.
                  const applied = event.shiftKey
                    ? handle.#run('liftListItem', 'listItem')
                    : handle.#run('sinkListItem', 'listItem');
                  if (applied) {
                    event.preventDefault();
                    return true;
                  }
                  return false;
                }
                if (event.key === 'Backspace') {
                  const { $from, empty } = view.state.selection;
                  if (empty && $from.parentOffset === 0 && $from.depth === 1) {
                    const boundary = $from.before(1);
                    if (
                      boundary > 0 &&
                      view.state.doc.resolve(boundary).parent.type.name ===
                        'doc'
                    ) {
                      try {
                        view.dispatch(view.state.tr.join(boundary));
                        return true;
                      } catch {
                        return false;
                      }
                    }
                  }
                }
                return false;
              },
              handleClick(view, pos, event) {
                // IME guard: clicks racing a composition must
                // not re-anchor the selection model mid-IME. (MouseEvent
                // carries no `isComposing` in TS types; read it structurally
                // — browsers set it on every UI event during composition.)
                const clickComposing =
                  view.composing ||
                  (event as unknown as { isComposing?: boolean })
                    .isComposing === true;
                if (clickComposing) return false;
                if (event.shiftKey) {
                  // inside the grid Shift+click belongs
                  // to tableEditing (rectangular CellSelection via its
                  // mousedown path, which already ran). Forcing a
                  // TextSelection here would clobber it — yield instead.
                  if (handle.#inTableGrid(view.state)) return false;
                  const anchor = handle.#anchorPos ?? pos;
                  view.dispatch(
                    view.state.tr.setSelection(
                      TextSelection.create(view.state.doc, anchor, pos),
                    ),
                  );
                  return true;
                }
                handle.#anchorPos = pos;
                // Commit the exact hit position rather than leaving single taps
                // to the browser's word-boundary caret adjustment. Native drag,
                // double-click and atom selections keep their existing paths.
                const target = event.target;
                if (
                  event.ctrlKey ||
                  event.metaKey ||
                  !(target instanceof Element) ||
                  target.closest('[contenteditable="false"]') !== null ||
                  !view.state.doc.resolve(pos).parent.inlineContent
                )
                  return false;
                view.focus();
                view.dispatch(
                  view.state.tr
                    .setSelection(TextSelection.create(view.state.doc, pos))
                    .setMeta('pointer', true),
                );
                return true;
              },
              handlePaste(view, event) {
                // File ingestion first:
                // pasted files route into uploadMedia (kind inferred from the
                // sniff), never into the text path below (a pasted screenshot
                // must not become its filename as paragraph text). Policy:
                // - grid caret with any potentially-valid file refuses
                //   entirely (no ingest, no text fall-through — cells hold
                //   text only, so files cannot join; claimed with no
                //   mutation, no history step; accompanying text is dropped
                //   with the claim, same files-win rationale as below);
                // - grid caret with all files synchronously pre-refused
                //   (empty/oversize declared size) + text present falls
                //   through to the text path (space-joined into the cell —
                //   nothing ingestible was claimed away);
                // - all files synchronously pre-refused (empty/oversize
                //   declared size) + text present falls through to the text
                //   path below (do NOT claim files — otherwise user text is
                //   lost); all-refuse with no text stays claimed with no
                //   mutation and no ingest (outcome-before-mutation — the
                //   files are known to refuse, so no arrayBuffer read is
                //   spent on a guaranteed refusal);
                // - otherwise files-win (claimed + async ingest; async
                //   refusals leave the model untouched while later files
                //   still ingest; accompanying text is dropped with the
                //   claim — see isPreRefusedUploadableFile).
                const clipboard = (event as ClipboardEvent).clipboardData;
                if (clipboard === undefined || clipboard === null) return false;
                const pastedFiles = collectUploadableFiles(clipboard);
                if (pastedFiles.length > 0) {
                  if (handle.#inTableGrid(view.state)) {
                    if (
                      pastedFiles.every(isPreRefusedUploadableFile) &&
                      clipboardHasText(clipboard)
                    ) {
                      // All-refuse + text in a cell: fall through to the
                      // text path below (space-joined via #insertPasteLines).
                    } else {
                      event.preventDefault();
                      return true;
                    }
                  } else if (pastedFiles.every(isPreRefusedUploadableFile)) {
                    if (!clipboardHasText(clipboard)) {
                      event.preventDefault();
                      return true;
                    }
                    // Text present: fall through to the text path below
                    // without claiming files.
                  } else {
                    event.preventDefault();
                    void handle.#ingestDroppedFiles(pastedFiles);
                    return true;
                  }
                }
                // Deterministic sanitized paste: plain-text lines
                // split/merge predictably in one undoable transaction.
                // HTML is reduced to text lines (scripts/styles stripped),
                // so untrusted markup never executes and no line is dropped.
                let lines: string[];
                try {
                  const plain = clipboard.getData('text/plain');
                  const html = clipboard.getData('text/html');
                  if (
                    plain !== '' &&
                    html !== '' &&
                    handle.#insertRichPaste(view, plain, html)
                  ) {
                    event.preventDefault();
                    return true;
                  }
                  if (plain !== '') lines = splitPasteLines(plain);
                  else {
                    if (html === '') return false;
                    lines = htmlToPasteLines(html);
                  }
                } catch {
                  return false;
                }
                if (lines.length === 0) {
                  event.preventDefault();
                  return true;
                }
                if (handle.#insertPasteLines(view, lines)) {
                  event.preventDefault();
                  return true;
                }
                return false;
              },
              handleDrop(view, event) {
                // Foreign file drops: route into
                // uploadMedia like pasted files. Internal block moves own
                // this path via the active pointer controller (the host capture listener
                // below) and fall through here untouched; non-file foreign
                // content keeps the default surface behavior. The host
                // capture drop listener is the primary path (it must claim
                // the event for the drop to fire at all); this prop is the
                // fallback when the host wiring is bypassed — whichever
                // claims first stopPropagation-guards, so no double ingest.
                // Grid caret refuses with no ingest (claimed, no mutation,
                // no history step — #ingestDroppedFiles re-checks). Dead in
                // practice while the host wiring stands (host capture claims
                // first, so no DOM-dispatched drop reaches this prop — the
                // grid refusal specs pin the host path); kept as the
                // bypass fallback, not separately unit-tested.
                void view;
                if (handle.#blockDrag?.busy) return true;
                const transfer = (event as DragEvent).dataTransfer;
                if (transfer === undefined || transfer === null) return false;
                const files = collectUploadableFiles(transfer);
                if (files.length === 0) return false;
                event.preventDefault();
                event.stopPropagation();
                if (handle.#inTableGrid(view.state)) return true;
                void handle.#ingestDroppedFiles(files);
                return true;
              },
            },
            appendTransaction(transactions, _oldState, newState) {
              // Canonical identity: splits/copies duplicate blockId attrs;
              // the first occurrence keeps the id, later duplicates are
              // re-id'd so hover/move-block always target the right block.
              // the scan walks ALL descendants (not just roots) —
              // an Enter-split inside a toggle duplicates the paragraph id
              // in nested content, and the old top-level-only `forEach`
              // left those duplicates until save minted `nb-N` replacements.
              //
              // Wrapper-owns-id exemption: wrap rules (input-rule quote)
              // stamp the source id on the wrapper while the wrapped paragraph
              // keeps it — `blockquote(p0) > paragraph(p0)` by
              // construction. The outer (earlier-in-doc-order) node owns the
              // id and the inner one is shadowed: #findBy already resolves
              // such pairs to the wrapper, and save folds the inner id into
              // the summary runs (splitSummary). Re-id'ing the inner node
              // would churn the doc out from under Tiptap's `undoInputRule`
              // doc-equality gate and break Backspace-undo parity, so a
              // duplicate already held by an ancestor is left alone — but only
              // the FIRST shadowed inner per wrapper (R1): an Enter-split of
              // the inner yields `blockquote(p0) > [paragraph(p0),
              // paragraph(p0)]`, and exempting every ancestor-held duplicate
              // would leave both inners sharing the id until save minted
              // `nb-N` via idOf/splitSummary. The walk remembers exempted
              // (wrapperPos,key) pairs; subsequent same-key descendants of
              // the same wrapper are re-id'd normally. Sibling splits
              // are unaffected (no ancestor holds the key).
              const seen = new Set<string>();
              const shadowExempted = new Set<string>();
              const splitCreatedOwner = transactions.some((transaction) =>
                transaction.steps.some((step) => {
                  const json = step.toJSON() as {
                    stepType?: unknown;
                    from?: unknown;
                    to?: unknown;
                    structure?: unknown;
                    slice?: { openStart?: unknown; openEnd?: unknown };
                  };
                  return (
                    json.stepType === 'replace' &&
                    json.from === json.to &&
                    json.structure === true &&
                    json.slice?.openStart === 1 &&
                    json.slice.openEnd === 1
                  );
                }),
              );
              let dedupe: typeof newState.tr | null = null;
              newState.doc.descendants((node, pos, parent, index) => {
                if ((node.type.name === 'bulletList' ||
                    node.type.name === 'orderedList') &&
                    (typeof node.attrs.listId !== 'string' ||
                      node.attrs.listId === '')) {
                  dedupe = (dedupe ?? newState.tr).setNodeMarkup(pos, undefined, {
                    ...node.attrs,
                    listId: newBlockId(),
                  });
                  return;
                }
                // Enter inside a toggle creates an unkeyed child. Give it a
                // stable identity before hover or drag can resolve its DOM;
                // the first paragraph is the toggle's own summary.
                if (parent?.type.name === 'toggle' && index > 0) {
                  const childAttr = node.type.name === 'bulletList' ||
                    node.type.name === 'orderedList' ? 'listId' : 'blockId';
                  if (node.attrs != null && childAttr in node.attrs &&
                      (typeof node.attrs[childAttr] !== 'string' ||
                        node.attrs[childAttr] === '')) {
                    dedupe = (dedupe ?? newState.tr).setNodeMarkup(pos, undefined, {
                      ...node.attrs,
                      [childAttr]: newBlockId(),
                    });
                    return;
                  }
                }
                // NB: text/attr-less descendants carry `attrs: null`, so
                // every read below is optional-chained (a top-level-only
                // `forEach` never met those nodes; `descendants` does).
                const attr =
                  typeof node.attrs?.blockId === 'string' &&
                  node.attrs.blockId !== ''
                    ? ('blockId' as const)
                    : typeof node.attrs?.listId === 'string' &&
                        node.attrs.listId !== ''
                      ? ('listId' as const)
                      : null;
                if (attr === null) return;
                const key = node.attrs[attr] as string;
                if (!seen.has(key)) {
                  seen.add(key);
                  return;
                }
                let ownedByAncestor = false;
                let wrapperPos = -1;
                try {
                  const $at = newState.doc.resolve(pos);
                  for (let depth = 0; depth <= $at.depth; depth += 1) {
                    if ($at.node(depth).attrs?.[attr] === key) {
                      ownedByAncestor = true;
                      wrapperPos = $at.before(depth);
                      break;
                    }
                  }
                } catch {
                  ownedByAncestor = false;
                  wrapperPos = -1;
                }
                if (ownedByAncestor) {
                  // First shadowed inner per wrapper keeps the shadow (quote
                  // Backspace-undo parity); later same-key siblings are real
                  // splits/copies and fall through to the re-id below.
                  const exemptKey = `${wrapperPos}:${key}`;
                  if (!shadowExempted.has(exemptKey)) {
                    shadowExempted.add(exemptKey);
                    return;
                  }
                }
                dedupe = (dedupe ?? newState.tr).setNodeMarkup(pos, undefined, {
                  ...node.attrs,
                  // Enter creates a new canonical owner. Unknown metadata
                  // remains with the first, stable-id node rather than being
                  // duplicated onto the split record. Other duplicate-id
                  // sources keep their own payload while receiving a new id.
                  ...(splitCreatedOwner ? { preserved: null } : {}),
                  ...(attr === 'blockId'
                    ? { blockId: newBlockId() }
                    : { listId: newBlockId() }),
                });
              });
              if (dedupe !== null) return dedupe;
              const { $from, empty } = newState.selection;
              if (!empty || !$from.parent.isTextblock) {
                if (handle.#slashOpen) handle.#closeSlash();
                return null;
              }
              // IME guard: composing text must never open or
              // drive menus; the trigger text is left alone.
              if (handle.#editor.view.composing) {
                if (handle.#slashOpen) handle.#closeSlash();
                if (handle.#resourceOpen) handle.#closeResourceMenu();
                return null;
              }
              const textBefore = $from.parent.textBetween(
                0,
                $from.parentOffset,
                undefined,
                '\uFFFC',
              );
              const resourceMatch = /(\[\[|@)([^\]\n]{0,80})$/.exec(textBefore);
              if (
                resourceMatch !== null &&
                handle.#input.resourceResolver !== undefined
              ) {
                if (handle.#slashOpen) handle.#closeSlash();
                if (handle.#handleMenuOpen) handle.#closeHandleMenu();
                handle.#openResourceMenu(
                  resourceMatch[2] ?? '',
                  resourceMatch[1]?.length ?? 1,
                  newState.selection.from,
                  null,
                  resourceMatch[1] ?? '',
                );
                return null;
              }
              if (handle.#resourceOpen && handle.#resourceBlockType === null)
                handle.#closeResourceMenu();
              // `/` never opens slash inside a grid cell.
              // Every slash commit from a cell is broken (inserts land after
              // the table; turn-into rows steal Enter/Tab for guaranteed
              // refusal), so suppress at detection: leave the trigger text
              // alone and let Enter/Tab fall through to the grid handlers.
              // The `[[`/`@` inline menu above still runs (cell-safe
              // text+mark); only slash-spawned block pickers are suppressed
              // (unreachable now that slash cannot open in-grid).
              if (handle.#inTableGrid(newState)) {
                if (handle.#slashOpen) handle.#closeSlash();
                return null;
              }
              // Search the visible catalog labels, including "Heading 2" and
              // "Resource link", without consuming another slash or newline.
              const match = /\/([A-Za-z0-9][A-Za-z0-9 -]{0,79}|)$/.exec(
                textBefore,
              );
              if (match === null) {
                if (handle.#slashOpen) handle.#closeSlash();
                return null;
              }
              if (handle.#handleMenuOpen) handle.#closeHandleMenu();
              handle.#slashOpen = true;
              handle.#slashQuery = match[1] ?? '';
              handle.#slashActive = 0;
              queueMicrotask(() =>
                handle.#renderSlash(newState.selection.from),
              );
              return null;
            },
          }),
        ];
      },
    });
  }

  #collapseDecorations() {
    return Extension.create({
      name: 'flbpCollapse',
      addProseMirrorPlugins() {
        return [
          new Plugin({
            key: new PluginKey('flbpCollapse'),
            props: {
              decorations(state) {
                const decorations: Decoration[] = [];
                const { $from, empty } = state.selection;
                if (empty && $from.parent.content.size === 0 &&
                    ['paragraph', 'heading'].includes($from.parent.type.name)) {
                  const pos = $from.before();
                  decorations.push(Decoration.node(pos, pos + $from.parent.nodeSize, {
                    class: 'flbp-active-empty',
                    'data-placeholder': "Enter text or type '/' for commands",
                  }));
                }
                state.doc.descendants((node, pos) => {
                  const collapsible =
                    node.type.name === 'toggle' ||
                    ((node.type.name === 'bulletList' ||
                      node.type.name === 'orderedList') &&
                      node.content.content.some(
                        (child) => child.childCount > 1,
                      ));
                  if (!collapsible) return true;
                  const target =
                    node.type.name === 'toggle'
                      ? String(node.attrs.blockId ?? '')
                      : `list:${String(node.attrs.listId ?? '')}`;
                  const chevron = document.createElement('button');
                  chevron.type = 'button';
                  chevron.className = 'flbp-chevron';
                  chevron.dataset.target = target;
                  chevron.contentEditable = 'false';
                  const isCollapsed = node.type.name === 'toggle'
                    ? node.attrs.collapsed === true
                    : node.attrs.subCollapsed === true;
                  chevron.setAttribute('aria-expanded', String(!isCollapsed));
                  chevron.setAttribute('aria-label', `${isCollapsed ? 'Expand' : 'Collapse'} ${node.type.name === 'toggle' ? 'toggle' : 'list'}`);
                  chevron.appendChild(sideControlIcon('chevron'));
                  if (node.type.name === 'toggle' && node.childCount === 1 && !isCollapsed) {
                    const add = document.createElement('button');
                    add.type = 'button';
                    add.className = 'flbp-toggle-empty';
                    add.contentEditable = 'false';
                    add.dataset.toggleId = target;
                    add.textContent = 'Empty toggle. Click to add a block.';
                    add.addEventListener('mousedown', (event) => event.preventDefault());
                    decorations.push(Decoration.widget(pos + node.nodeSize - 1, add, { side: -1, key: `empty:${target}` }));
                  }
                  decorations.push(
                    Decoration.widget(pos + (node.type.name === 'toggle' ? 2 : 3), chevron, { side: -1, key: `${target}:${isCollapsed}` }),
                  );
                  return true;
                });
                return DecorationSet.create(state.doc, decorations);
              },
            },
          }),
        ];
      },
    });
  }
}
