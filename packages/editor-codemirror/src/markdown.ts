/**
 * Markdown document editor provider — replaceable CodeMirror 6 adapter.
 *
 * The provider owns all DOM/editor details. Froglight application/session
 * code sees only MarkdownEditorProvider/MarkdownEditorHandle; no CodeMirror
 * type crosses this seam. Browser hosts get a real CodeMirror 6
 * editor; headless tests use a deterministic in-memory handle.
 *
 * Editor-local undo/redo (CodeMirror history) is deliberately separate from
 * persistent document revisions and workspace navigation, which live in the
 * workspace layer.
 */

import {
  sourceSelectionTheme,
  sourceSelectionAnchor,
  watchSourceSelection,
} from './source-selection.js';
import { EditorState } from '@codemirror/state';
import {
  EditorView,
  Decoration,
  ViewPlugin,
  keymap,
  highlightSpecialChars,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view';
import {
  defaultKeymap,
  history,
  historyKeymap,
  redo,
  redoDepth,
  undo,
  undoDepth,
} from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import {
  autocompletion,
  closeBrackets,
  startCompletion,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import {
  HighlightStyle,
  syntaxHighlighting,
  syntaxTree,
} from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { buildAddressIndex } from '@froglight/foundation';
import {
  writingCodeBlockControl,
  writingFormatToggleControl,
  writingLinkControl,
} from '@froglight/foundation';
import type {
  DocumentEditorTools,
  DocumentSession,
  MarkdownEditorHandle,
  MarkdownEditorProvider,
  ResourceResolver,
} from '@froglight/foundation';
import { CodemirrorMarkdownSkeleton } from './react/CodemirrorMarkdownSkeleton.jsx';

class HeadlessMarkdownEditorHandle implements MarkdownEditorHandle {
  #text: string;
  readonly #history: string[] = [];
  readonly #future: string[] = [];
  readonly #onDirtyText: (text: string) => void;
  #focused = false;
  #destroyed = false;

  constructor(initialText: string, onDirtyText: (text: string) => void) {
    this.#text = initialText;
    this.#onDirtyText = onDirtyText;
  }

  replaceAll(next: string): void {
    if (next === this.#text) return;
    this.#history.push(this.#text);
    this.#future.length = 0;
    this.#text = next;
    this.#onDirtyText(next);
  }

  getTextForTest(): string {
    return this.#text;
  }

  focus(): void {
    this.#focused = true;
  }

  hasFocus(): boolean {
    return this.#focused;
  }

  canExecCommand(id: 'undo' | 'redo'): boolean {
    return id === 'undo' ? this.#history.length > 0 : this.#future.length > 0;
  }

  execCommand(id: 'undo' | 'redo'): boolean {
    if (id === 'undo' && this.#history.length > 0) {
      const previous = this.#history.pop();
      if (previous === undefined) return false;
      this.#future.push(this.#text);
      this.#text = previous;
      this.#onDirtyText(previous);
      return true;
    }
    if (id === 'redo' && this.#future.length > 0) {
      const next = this.#future.pop();
      if (next === undefined) return false;
      this.#history.push(this.#text);
      this.#text = next;
      this.#onDirtyText(next);
      return true;
    }
    return false;
  }

  destroy(): void {
    this.#destroyed = true;
  }

  get destroyed(): boolean {
    return this.#destroyed;
  }
}

/** One parsed `[[destination]]`, `[[destination#fragment]]`, or aliased form. */
export interface ParsedWikiLink {
  /** Inclusive start offset of `[[`. */
  readonly from: number;
  /** Exclusive end offset of `]]`. */
  readonly to: number;
  readonly destination: string;
  readonly fragment?: string;
  readonly alias?: string;
}

const WIKI_LINK_PATTERN =
  /\[\[([^[\]#|]+)(?:#([^[\]|#]+))?(?:\|([^\]]+))?\]\]/g;

/** Parse wiki-links in a text slice; offsets are absolute into the full doc. */
export function parseWikiLinks(text: string, baseOffset = 0): ParsedWikiLink[] {
  const links: ParsedWikiLink[] = [];
  WIKI_LINK_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = WIKI_LINK_PATTERN.exec(text)) !== null) {
    const destination = match[1]?.trim() ?? '';
    if (destination === '') continue;
    const fragment = match[2]?.trim();
    links.push({
      from: baseOffset + match.index,
      to: baseOffset + match.index + match[0].length,
      destination,
      fragment:
        fragment !== undefined && fragment !== '' ? fragment : undefined,
      alias: match[3]?.trim(),
    });
  }
  return links;
}

function buildWikiLinkDecorations(view: EditorView): DecorationSet {
  const decorations: Array<{
    from: number;
    to: number;
    decoration: Decoration;
  }> = [];
  for (const { from, to } of view.visibleRanges) {
    const text = view.state.doc.sliceString(from, to);
    for (const link of parseWikiLinks(text, from)) {
      decorations.push({
        from: link.from,
        to: link.to,
        decoration: Decoration.mark({
          class: 'froglight-wiki-link',
          attributes: {
            'data-destination': link.destination,
            ...(link.fragment !== undefined
              ? { 'data-fragment': link.fragment }
              : {}),
          },
        }),
      });
    }
  }
  return Decoration.set(
    decorations.map(({ from, to, decoration }) => decoration.range(from, to)),
    true,
  );
}

const wikiLinkPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildWikiLinkDecorations(view);
    }
    update(update: ViewUpdate): void {
      if (update.docChanged || update.viewportChanged) {
        this.decorations = buildWikiLinkDecorations(update.view);
      }
    }
  },
  {
    decorations: (plugin) => plugin.decorations,
    eventHandlers: {
      mousedown(event, view) {
        if (event.button !== 0) return false;
        const target = event.target;
        if (!(target instanceof Element)) return false;
        const link = target.closest('.froglight-wiki-link');
        if (!(link instanceof HTMLElement)) return false;
        const destination = link.dataset.destination;
        if (destination === undefined || destination === '') return false;
        event.preventDefault();
        view.dom.dispatchEvent(
          new CustomEvent('froglight:open-link', {
            detail: {
              destination,
              ...(link.dataset.fragment
                ? { fragment: link.dataset.fragment }
                : {}),
            },
            bubbles: true,
          }),
        );
        return true;
      },
    },
  },
);

/** Workspace paths stay plain Markdown source; suggestions never insert opaque ids. */
function wikiLinkCompletion(
  resolver: ResourceResolver,
  searchImageFiles?: (query: string) => Promise<readonly string[]>,
) {
  return async (
    context: CompletionContext,
  ): Promise<CompletionResult | null> => {
    const line = context.state.doc.lineAt(context.pos);
    const before = line.text.slice(0, context.pos - line.from);
    const match = /(!?)\[\[([^[\]\n]*)$/.exec(before);
    if (!match) return null;
    const embed = match[1] === '!';
    const query = match[2] ?? '';
    if (query.includes('|') || query.includes('#')) return null;
    const from = context.pos - query.length;
    let suggestions;
    let imageFiles: readonly string[] = [];
    try {
      suggestions = await resolver.search(query);
      if (embed && searchImageFiles) imageFiles = await searchImageFiles(query);
    } catch {
      return null;
    }
    if (context.aborted) return null;
    const options = suggestions
      .filter((suggestion) =>
        embed
          ? (suggestion.target.kindId === 'froglight.markdown' ||
              suggestion.target.kindId === 'froglight.ink' ||
              /\.(?:png|jpe?g|gif|webp|avif|svg)$/i.test(suggestion.label)) &&
            !/[<>\n]/.test(suggestion.label)
          : suggestion.target.kindId === 'froglight.markdown' &&
            !suggestion.label.includes('[') &&
            !suggestion.label.includes(']') &&
            !suggestion.label.includes('\n'),
      )
      .slice(0, 40)
      .map((suggestion) => ({
        label: suggestion.label,
        detail: suggestion.detail,
        apply(
          view: EditorView,
          _completion: unknown,
          queryFrom: number,
          queryTo: number,
        ) {
          const tail = view.state.doc.sliceString(
            queryTo,
            Math.min(queryTo + 2, view.state.doc.length),
          );
          const closes = tail === ']]';
          const start = queryFrom - (embed ? 3 : 2);
          const replacement = `${embed ? '!' : ''}[[${suggestion.label}]]`;
          view.dispatch({
            changes: {
              from: start,
              to: queryTo + (closes ? 2 : 0),
              insert: replacement,
            },
            selection: { anchor: start + replacement.length },
          });
        },
      }));
    if (embed)
      for (const path of imageFiles) {
        options.push({
          label: path,
          detail: 'Image file',
          apply(
            view: EditorView,
            _completion: unknown,
            queryFrom: number,
            queryTo: number,
          ) {
            const closes =
              view.state.doc.sliceString(queryTo, queryTo + 2) === ']]';
            const start = queryFrom - 3;
            const replacement = `![[${path}]]`;
            view.dispatch({
              changes: {
                from: start,
                to: queryTo + (closes ? 2 : 0),
                insert: replacement,
              },
              selection: { anchor: start + replacement.length },
            });
          },
        });
      }
    return { from, options, filter: false, validFor: /^[^[\]\n]*$/ };
  };
}

/** Markdown punctuation stays legible while prose remains the visual lead. */
const markdownHighlightStyle = HighlightStyle.define([
  {
    tag: [tags.heading1, tags.heading2],
    color: 'var(--fl-text-primary)',
    fontWeight: '650',
  },
  {
    tag: [tags.heading3, tags.heading4, tags.heading5, tags.heading6],
    color: 'var(--fl-text-primary)',
    fontWeight: '600',
  },
  { tag: tags.strong, fontWeight: '650' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: [tags.link, tags.url], color: 'var(--fl-accent)' },
  {
    tag: [tags.quote, tags.meta, tags.processingInstruction],
    color: 'var(--fl-text-muted)',
  },
  { tag: [tags.monospace, tags.inserted], color: 'var(--fl-text-secondary)' },
  {
    tag: tags.deleted,
    color: 'var(--fl-text-muted)',
    textDecoration: 'line-through',
  },
]);

/** Theme driven by Froglight CSS variables so it follows light/dark settings. */
const froglightEditorTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      backgroundColor: 'var(--fl-surface-editor)',
      color: 'var(--fl-text-primary)',
      fontSize: 'var(--fl-editor-font-size, 16px)',
    },
    '.cm-scroller': {
      overflow: 'auto',
      fontFamily: 'var(--fl-font-sans)',
      lineHeight: '1.75',
      padding: '0 0 45vh',
    },
    '.cm-content': {
      caretColor: 'var(--fl-accent)',
      width: '100%',
      maxWidth: '74ch',
      margin: '0 auto',
    },
    '.cm-line': { padding: '0 12px' },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--fl-accent)' },
    '&.cm-focused': { outline: 'none' },
    '.cm-activeLine': { backgroundColor: 'transparent' },
    '.cm-selectionMatch': {
      backgroundColor: 'color-mix(in srgb, var(--fl-accent) 18%, transparent)',
    },
    '.froglight-wiki-link': {
      color: 'var(--fl-accent)',
      textDecoration: 'underline',
      textDecorationColor:
        'color-mix(in srgb, var(--fl-accent) 40%, transparent)',
      textUnderlineOffset: '3px',
      cursor: 'pointer',
    },
    '.cm-placeholder': { color: 'var(--fl-text-secondary)' },
  },
  { dark: false },
);

/**
 * Source-first Markdown toolbar semantics (markdown-toolbar-spec).
 *
 * The provider is the sole interpreter of caret/selection/source syntax. It
 * emits plain semantic state (block value, provider-computed active/mixed,
 * enabledness, link prefill) and performs literal source transformations
 * with selection/caret repair inside one provider-local undo transaction.
 * React sends semantic ids/values only and never inspects editor state.
 */

const BOLD_DELIMS = ['**', '__'] as const;
const BOLD_WRAP = '**';
const ITALIC_DELIMS = ['_', '*'] as const;
const ITALIC_WRAP = '_';
const LINK_PLACEHOLDER_LABEL = 'link text';

/** Syntax-tree mark names from the incremental Markdown parse (lezer). */
const MARK_BOLD = 'StrongEmphasis';
const MARK_ITALIC = 'Emphasis';
const MARK_CODE = 'InlineCode';
const MARK_LINK = 'Link';
const MARK_URL = 'URL';
/** Code contexts where inline authoring would produce surprising syntax. */
const CODE_NODES = new Set([
  'InlineCode',
  'CodeText',
  'FencedCode',
  'CodeBlock',
]);
/** Fenced/indented block code: structural transforms are unsafe here too. */
const FENCED_NODES = new Set(['CodeText', 'FencedCode', 'CodeBlock']);
/** One boring module-level set per mark (no lookup cache needed). */
const MARK_BOLD_NAMES: ReadonlySet<string> = new Set([MARK_BOLD]);
const MARK_ITALIC_NAMES: ReadonlySet<string> = new Set([MARK_ITALIC]);
const MARK_CODE_NAMES: ReadonlySet<string> = new Set([MARK_CODE]);
const MARK_LINK_NAMES: ReadonlySet<string> = new Set([MARK_LINK]);

function detectBlockValue(lineText: string): string {
  const prefix =
    lineText.match(
      /^(#{1,6}\s+|>\s+|(?:[-*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)/,
    )?.[0] ?? '';
  if (prefix.startsWith('#')) return `heading:${prefix.indexOf(' ')}`;
  if (prefix.startsWith('>')) return 'quote';
  if (/\[[ xX]\]/.test(prefix)) return 'task';
  if (/^\d/.test(prefix)) return 'numbered';
  return prefix !== '' ? 'bullet' : 'paragraph';
}

function describeBlockContext(blockValue: string): string {
  // Accessibility/debug metadata only; never rendered as persistent chrome.
  if (blockValue.startsWith('heading:'))
    return `Markdown heading ${blockValue.slice('heading:'.length)}`;
  if (blockValue === 'paragraph') return 'Markdown paragraph';
  return `Markdown ${blockValue}`;
}

interface NamedRange {
  readonly name: string;
  readonly from: number;
  readonly to: number;
}

/** Innermost syntax ancestor with a name in `names`, or null. */
function innermostNamedAt(
  state: EditorState,
  pos: number,
  names: ReadonlySet<string>,
  side: -1 | 0 | 1,
): NamedRange | null {
  const clamped = Math.max(0, Math.min(pos, state.doc.length));
  const cursor = syntaxTree(state).cursorAt(clamped, side);
  do {
    if (names.has(cursor.name))
      return { name: cursor.name, from: cursor.from, to: cursor.to };
  } while (cursor.parent());
  return null;
}

/** True when any syntax node in `names` overlaps `[from, to)`. */
function touchesNamed(
  state: EditorState,
  from: number,
  to: number,
  names: ReadonlySet<string>,
): boolean {
  if (from === to) return innermostNamedAt(state, from, names, 0) !== null;
  if (innermostNamedAt(state, from, names, 1) !== null) return true;
  if (to > from && innermostNamedAt(state, to - 1, names, 0) !== null)
    return true;
  let found = false;
  syntaxTree(state).iterate({
    from,
    to,
    enter: (node) => {
      if (names.has(node.name)) {
        found = true;
        return false;
      }
      return undefined;
    },
  });
  return found;
}

export interface MarkdownMarkState {
  readonly active: boolean;
  readonly mixed: boolean;
}

/**
 * Provider-computed active/mixed state for one inline mark.
 *
 * - Caret: active only when strictly inside the mark (never on a boundary),
 *   so typing at the edge has predictable plain/marked semantics. Mixed is
 *   always false for a caret — there is no ambiguity to report.
 * - Range: active when one mark node fully contains the selection; otherwise
 *   mixed when the selection merely overlaps mark syntax, so the toolbar
 *   never claims a formatting state it cannot prove.
 */
export function markdownMarkState(
  state: EditorState,
  from: number,
  to: number,
  names: ReadonlySet<string>,
): MarkdownMarkState {
  if (from === to) {
    const hit = innermostNamedAt(state, from, names, 0);
    return {
      active:
        (hit !== null && from > hit.from && from < hit.to) ||
        emptyMarkAt(state, from, names) !== null,
      mixed: false,
    };
  }
  const container = innermostNamedAt(state, from, names, 1);
  if (
    container !== null &&
    container.from <= from &&
    to <= container.to &&
    from < to
  )
    return { active: true, mixed: false };
  return { active: false, mixed: touchesNamed(state, from, to, names) };
}

export interface MarkdownEnclosingMark {
  readonly nodeFrom: number;
  readonly nodeTo: number;
  readonly contentFrom: number;
  readonly contentTo: number;
  readonly openingDelimiter: string;
  readonly closingDelimiter: string;
}

/** Toolbar-created empty delimiter pairs have no syntax-tree mark yet. */
function emptyMarkAt(
  state: EditorState,
  pos: number,
  names: ReadonlySet<string>,
): MarkdownEnclosingMark | null {
  const isCode = names.has(MARK_CODE);
  if (
    touchesNamed(state, pos, pos, isCode ? FENCED_NODES : CODE_NODES)
  )
    return null;
  const delims = isCode
    ? ['`']
    : names.has(MARK_BOLD)
      ? BOLD_DELIMS
      : names.has(MARK_ITALIC)
        ? ITALIC_DELIMS
        : [];
  for (const delimiter of delims) {
    const from = pos - delimiter.length;
    const to = pos + delimiter.length;
    if (
      from < 0 ||
      to > state.doc.length ||
      state.doc.sliceString(from, pos) !== delimiter ||
      state.doc.sliceString(pos, to) !== delimiter
    )
      continue;
    if (!isCode) {
      let backslashes = 0;
      for (let index = from - 1; index >= 0; index--) {
        if (state.doc.sliceString(index, index + 1) !== '\\') break;
        backslashes++;
      }
      if (backslashes % 2 !== 0) continue;
    }
    if (
      (from > 0 &&
        state.doc.sliceString(from - 1, from) === delimiter[0]) ||
      (to < state.doc.length &&
        state.doc.sliceString(to, to + 1) === delimiter[0])
    )
      continue;
    return {
      nodeFrom: from,
      nodeTo: to,
      contentFrom: pos,
      contentTo: pos,
      openingDelimiter: delimiter,
      closingDelimiter: delimiter,
    };
  }
  return null;
}

/**
 * Shared syntax-based enclosing-mark helper (review slice 3).
 *
 * Determines whether the caret/selection is fully contained in one applicable
 * syntax mark, using the same containment rule as `markdownMarkState` so
 * snapshot active state and toggle removal converge:
 *
 * - Caret: strictly inside the mark (never on a boundary).
 * - Range: one mark node fully contains `[from, to)`.
 *
 * Returns node/content boundaries plus opening/closing delimiters, or null
 * when no single mark can be proven (plain or mixed).
 */
export function markdownEnclosingMark(
  state: EditorState,
  from: number,
  to: number,
  names: ReadonlySet<string>,
): MarkdownEnclosingMark | null {
  let node: NamedRange | null = null;
  if (from === to) {
    const hit = innermostNamedAt(state, from, names, 0);
    if (hit === null || !(from > hit.from && from < hit.to))
      return emptyMarkAt(state, from, names);
    node = hit;
  } else {
    const container = innermostNamedAt(state, from, names, 1);
    if (
      container === null ||
      !(container.from <= from && to <= container.to && from < to)
    )
      return null;
    node = container;
  }
  const nodeText = state.doc.sliceString(node.from, node.to);
  const isBold = names.has(MARK_BOLD);
  const isItalic = names.has(MARK_ITALIC);
  const isCode = names.has(MARK_CODE);
  if (isBold) {
    // StrongEmphasis: `**...**` or `__...__`.
    let opening: string | null = null;
    let closing: string | null = null;
    if (
      nodeText.startsWith('**') &&
      nodeText.endsWith('**') &&
      nodeText.length >= 4
    ) {
      opening = '**';
      closing = '**';
    } else if (
      nodeText.startsWith('__') &&
      nodeText.endsWith('__') &&
      nodeText.length >= 4
    ) {
      opening = '__';
      closing = '__';
    } else {
      return null;
    }
    return {
      nodeFrom: node.from,
      nodeTo: node.to,
      contentFrom: node.from + opening.length,
      contentTo: node.to - closing.length,
      openingDelimiter: opening,
      closingDelimiter: closing,
    };
  }
  if (isItalic) {
    // Emphasis: `_..._` or `*...*` (single). StrongEmphasis never reaches
    // here because it has a different node name.
    if (nodeText.length < 3) return null;
    const first = nodeText[0];
    const last = nodeText[nodeText.length - 1];
    if (
      (first === '_' || first === '*') &&
      first === last &&
      nodeText.length >= 3
    ) {
      // Single-char delimiters must not claim a longer run: `_` must not
      // match `__bold__` (but that node would be StrongEmphasis anyway).
      // Guard the degenerate `***`/`___` edge by requiring the second char
      // to differ from the delimiter for singletons.
      if (nodeText[1] === first && nodeText.length === 3) return null;
      return {
        nodeFrom: node.from,
        nodeTo: node.to,
        contentFrom: node.from + 1,
        contentTo: node.to - 1,
        openingDelimiter: first,
        closingDelimiter: last,
      };
    }
    return null;
  }
  if (isCode) {
    // InlineCode: one or more backticks plus optional single padding spaces
    // when the content touches a backtick (see `toggleInlineCode`).
    const openMatch = nodeText.match(/^(`+)/);
    const closeMatch = nodeText.match(/(`+)$/);
    if (openMatch === null || closeMatch === null) return null;
    const opening = openMatch[1]!;
    const closing = closeMatch[1]!;
    if (opening !== closing) return null;
    if (nodeText.length < opening.length * 2 + 1)
      return emptyMarkAt(state, from, names);
    return {
      nodeFrom: node.from,
      nodeTo: node.to,
      contentFrom: node.from + opening.length,
      contentTo: node.to - closing.length,
      openingDelimiter: opening,
      closingDelimiter: closing,
    };
  }
  return null;
}

/** Existing link target at `pos` (caret strictly inside, or range start). */
export function markdownLinkTargetAt(
  state: EditorState,
  from: number,
  to: number,
): {
  readonly url: string;
  readonly linkFrom: number;
  readonly linkTo: number;
  readonly urlFrom: number;
  readonly urlTo: number;
} | null {
  const link =
    from === to
      ? innermostNamedAt(state, from, MARK_LINK_NAMES, 0)
      : innermostNamedAt(state, from, MARK_LINK_NAMES, 1);
  if (link === null) return null;
  if (from === to && !(from > link.from && from < link.to)) return null;
  if (from !== to && !(link.from <= from && to <= link.to)) return null;
  let url: NamedRange | null = null;
  syntaxTree(state).iterate({
    from: link.from,
    to: link.to,
    enter: (node) => {
      if (node.name === MARK_URL) {
        url = { name: node.name, from: node.from, to: node.to };
        return false;
      }
      return undefined;
    },
  });
  if (url === null) return null;
  const found: NamedRange = url;
  return {
    url: state.doc.sliceString(found.from, found.to),
    linkFrom: link.from,
    linkTo: link.to,
    urlFrom: found.from,
    urlTo: found.to,
  };
}

/**
 * Destination validity for link submission. Empty input must never mutate
 * source; destinations containing whitespace would parse as surprising
 * title/gap syntax, so the provider rejects them without changes.
 */
export function isValidLinkDestination(value: string): boolean {
  const trimmed = value.trim();
  return trimmed !== '' && !/\s/.test(trimmed);
}

/** Fence run one backtick longer than any run inside `text`. */
export function codeFenceFor(text: string): string {
  let longest = 0;
  const pattern = /`+/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null)
    longest = Math.max(longest, match[0].length);
  return '`'.repeat(longest + 1);
}

/**
 * True when `text` is already wrapped with one of `delims`. Single-character
 * delimiters must not match a longer run (`*` must not claim `**bold**`).
 */
function wrappedWith(text: string, delims: readonly string[]): string | null {
  for (const delim of delims) {
    if (
      text.length >= delim.length * 2 &&
      text.startsWith(delim) &&
      text.endsWith(delim)
    ) {
      if (delim.length === 1) {
        const second = text[1];
        const penultimate = text[text.length - 2];
        if (second === delim || penultimate === delim) continue;
      }
      return delim;
    }
  }
  return null;
}

/** Wrap-or-unwrap `selection` with a fixed delimiter pair (toggle). */
function toggleFixedWrap(
  view: EditorView,
  from: number,
  to: number,
  selected: string,
  delims: readonly string[],
  wrapWith: string,
  names: ReadonlySet<string>,
): void {
  // Convergent path: if the snapshot can prove active (enclosing syntax
  // mark contains the caret/selection), remove that mark instead of
  // wrapping a second time. Uses the same containment rule as the snapshot.
  const enclosing = markdownEnclosingMark(view.state, from, to, names);
  if (enclosing !== null) {
    const inner = view.state.doc.sliceString(
      enclosing.contentFrom,
      enclosing.contentTo,
    );
    const openingLen = enclosing.openingDelimiter.length;
    const nodeFrom = enclosing.nodeFrom;
    const clamp = (pos: number): number =>
      Math.max(nodeFrom, Math.min(pos, nodeFrom + inner.length));
    if (from === to) {
      const caret = clamp(from - openingLen);
      view.dispatch({
        changes: {
          from: enclosing.nodeFrom,
          to: enclosing.nodeTo,
          insert: inner,
        },
        selection: { anchor: caret },
        scrollIntoView: true,
      });
      return;
    }
    const anchor = clamp(from - openingLen);
    const head = clamp(to - openingLen);
    view.dispatch({
      changes: {
        from: enclosing.nodeFrom,
        to: enclosing.nodeTo,
        insert: inner,
      },
      selection: { anchor, head },
      scrollIntoView: true,
    });
    return;
  }
  if (from === to) {
    view.dispatch({
      changes: {
        from,
        to,
        insert: `${wrapWith}${wrapWith}`,
      },
      selection: { anchor: from + wrapWith.length },
      scrollIntoView: true,
    });
    return;
  }
  const hit = wrappedWith(selected, delims);
  if (hit !== null) {
    const inner = selected.slice(hit.length, selected.length - hit.length);
    view.dispatch({
      changes: { from, to, insert: inner },
      selection: { anchor: from, head: from + inner.length },
      scrollIntoView: true,
    });
    return;
  }
  view.dispatch({
    changes: { from, to, insert: `${wrapWith}${selected}${wrapWith}` },
    selection: {
      anchor: from + wrapWith.length,
      head: from + wrapWith.length + selected.length,
    },
    scrollIntoView: true,
  });
}

/** Toggle inline code with delimiter-length/space validity. */
function toggleInlineCode(
  view: EditorView,
  from: number,
  to: number,
  selected: string,
): void {
  // Convergent path: active code mark contains the caret/selection, so
  // remove the enclosing fences (plus one optional padding space pair)
  // instead of wrapping a second time.
  const enclosing = markdownEnclosingMark(
    view.state,
    from,
    to,
    MARK_CODE_NAMES,
  );
  if (enclosing !== null) {
    const innerWithSpaces = view.state.doc.sliceString(
      enclosing.contentFrom,
      enclosing.contentTo,
    );
    const padded =
      innerWithSpaces.startsWith(' ') &&
      innerWithSpaces.endsWith(' ') &&
      innerWithSpaces.length >= 2;
    const unpadded = padded ? innerWithSpaces.slice(1, -1) : innerWithSpaces;
    // An empty span is a pending inline-code mark, so its delimiters unwrap.
    if (unpadded !== '' || from !== to || innerWithSpaces === '') {
      const prefixLen = enclosing.openingDelimiter.length + (padded ? 1 : 0);
      const nodeFrom = enclosing.nodeFrom;
      const clamp = (pos: number): number =>
        Math.max(nodeFrom, Math.min(pos, nodeFrom + unpadded.length));
      if (from === to) {
        const caret = clamp(from - prefixLen);
        view.dispatch({
          changes: {
            from: enclosing.nodeFrom,
            to: enclosing.nodeTo,
            insert: unpadded,
          },
          selection: { anchor: caret },
          scrollIntoView: true,
        });
        return;
      }
      const anchor = clamp(from - prefixLen);
      const head = clamp(to - prefixLen);
      view.dispatch({
        changes: {
          from: enclosing.nodeFrom,
          to: enclosing.nodeTo,
          insert: unpadded,
        },
        selection: { anchor, head },
        scrollIntoView: true,
      });
      return;
    }
  }
  if (from === to) {
    view.dispatch({
      changes: { from, to, insert: '``' },
      selection: { anchor: from + 1 },
      scrollIntoView: true,
    });
    return;
  }
  const unwrap = selected.match(/^(`+)([\s\S]*)\1$/);
  const inner = unwrap?.[2];
  if (
    unwrap !== null &&
    inner !== undefined &&
    inner !== '' &&
    !inner.startsWith('`') &&
    !inner.endsWith('`')
  ) {
    // Strip one optional padding space pair (the wrap path adds them when
    // the content touches a backtick).
    const unpadded =
      inner.startsWith(' ') && inner.endsWith(' ') && inner.length >= 2
        ? inner.slice(1, -1)
        : inner;
    view.dispatch({
      changes: { from, to, insert: unpadded },
      selection: { anchor: from, head: from + unpadded.length },
      scrollIntoView: true,
    });
    return;
  }
  const fence = codeFenceFor(selected);
  const padded =
    selected.startsWith('`') || selected.endsWith('`')
      ? `${fence} ${selected} ${fence}`
      : `${fence}${selected}${fence}`;
  view.dispatch({
    changes: { from, to, insert: padded },
    selection: {
      anchor: from + fence.length + (padded[fence.length] === ' ' ? 1 : 0),
      head:
        from +
        fence.length +
        (padded[fence.length] === ' ' ? 1 : 0) +
        selected.length,
    },
    scrollIntoView: true,
  });
}

/** Shared keyboard/toolbar transforms: one source outcome per input method. */
function codeFlags(
  state: EditorState,
  from: number,
  to: number,
): { readonly inCode: boolean; readonly inFenced: boolean } {
  return {
    inCode: touchesNamed(state, from, to, CODE_NODES),
    inFenced: touchesNamed(state, from, to, FENCED_NODES),
  };
}

/** Shared keyboard/toolbar transforms: one source outcome per input method. */
function applyBoldTransform(view: EditorView): boolean {
  const selection = view.state.selection.main;
  // Mirror the snapshot's disabled state: never produce surprising syntax
  // inside code, no matter which entry point (toolbar, keyboard, API) runs.
  if (touchesNamed(view.state, selection.from, selection.to, CODE_NODES))
    return false;
  const selected = view.state.doc.sliceString(selection.from, selection.to);
  toggleFixedWrap(
    view,
    selection.from,
    selection.to,
    selected,
    BOLD_DELIMS,
    BOLD_WRAP,
    MARK_BOLD_NAMES,
  );
  return true;
}

function applyItalicTransform(view: EditorView): boolean {
  const selection = view.state.selection.main;
  if (touchesNamed(view.state, selection.from, selection.to, CODE_NODES))
    return false;
  const selected = view.state.doc.sliceString(selection.from, selection.to);
  toggleFixedWrap(
    view,
    selection.from,
    selection.to,
    selected,
    ITALIC_DELIMS,
    ITALIC_WRAP,
    MARK_ITALIC_NAMES,
  );
  return true;
}

function applyCodeTransform(view: EditorView): boolean {
  const selection = view.state.selection.main;
  // Inline code stays toggleable inside InlineCode (so it can be removed),
  // but fenced/indented code is off-limits like the snapshot advertises.
  if (touchesNamed(view.state, selection.from, selection.to, FENCED_NODES))
    return false;
  const selected = view.state.doc.sliceString(selection.from, selection.to);
  toggleInlineCode(view, selection.from, selection.to, selected);
  return true;
}

class CodemirrorMarkdownEditorHandle implements MarkdownEditorHandle {
  readonly #view: EditorView;
  readonly #wrapper: HTMLElement;
  readonly #root: Root;
  readonly #onDirtyText: (text: string) => void;
  readonly #hasWorkspaceSuggestions: boolean;
  readonly #importImage?: (name: string, bytes: Uint8Array) => Promise<string>;
  #fileInput: HTMLInputElement | null = null;
  readonly #toolListeners = new Set<() => void>();
  readonly tools: DocumentEditorTools;
  #destroyed = false;

  constructor(
    parent: HTMLElement,
    initialText: string,
    onDirtyText: (text: string) => void,
    resourceResolver?: ResourceResolver,
    searchImageFiles?: (query: string) => Promise<readonly string[]>,
    importImage?: (name: string, bytes: Uint8Array) => Promise<string>,
  ) {
    // One narrowly contained synchronous commit: the engine
    // needs the actual host element immediately, and createEditor is
    // synchronous. Never during normal rendering or engine updates.
    const skeletonRef: { current: MarkdownSkeleton | null } = {
      current: null,
    };
    const root = createRoot(parent);
    flushSync(() => {
      root.render(createElement(CodemirrorMarkdownSkeleton, { skeletonRef }));
    });
    const skeleton = skeletonRef.current;
    if (skeleton === null)
      throw new Error('codemirror markdown skeleton failed to commit');
    this.#root = root;
    this.#wrapper = skeleton.root;
    this.#onDirtyText = onDirtyText;
    this.#hasWorkspaceSuggestions = resourceResolver !== undefined;
    this.#importImage = importImage;

    const updateListener = EditorView.updateListener.of(
      (update: ViewUpdate) => {
        if (update.docChanged) this.#onDirtyText(update.state.doc.toString());
        if (update.docChanged || update.selectionSet) this.#notifyTools();
      },
    );

    const state = EditorState.create({
      doc: initialText,
      extensions: [
        highlightSpecialChars(),
        history(),
        sourceSelectionTheme,
        watchSourceSelection(() => this.#notifyTools()),
        EditorView.lineWrapping,
        froglightEditorTheme,
        syntaxHighlighting(markdownHighlightStyle),
        markdown({ base: markdownLanguage }),
        closeBrackets(),
        ...(resourceResolver
          ? [
              autocompletion({
                override: [
                  wikiLinkCompletion(resourceResolver, searchImageFiles),
                ],
                activateOnTyping: true,
                activateOnTypingDelay: 0,
              }),
            ]
          : []),
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          // Keyboard formatting converges on the same source outcomes as
          // the toolbar (one transform per input method).
          { key: 'Mod-b', run: (view) => applyBoldTransform(view) },
          { key: 'Mod-i', run: (view) => applyItalicTransform(view) },
        ]),
        wikiLinkPlugin,
        updateListener,
      ],
    });

    this.#view = new EditorView({ state, parent: this.#wrapper });
    const titleSlot = document.createElement('div');
    titleSlot.dataset.flDocumentTitleSlot = 'editor';
    this.#view.scrollDOM.prepend(titleSlot);
    this.tools = {
      snapshot: () => this.#toolSnapshot(),
      execute: (id, value) => this.#executeTool(id, value),
      onDidChange: (listener) => {
        this.#toolListeners.add(listener);
        return { dispose: () => this.#toolListeners.delete(listener) };
      },
    };
  }

  replaceAll(next: string): void {
    if (this.#destroyed)
      throw new Error('CodemirrorMarkdownEditorHandle is destroyed');
    const current = this.#view.state.doc.toString();
    if (next === current) return;
    this.#view.dispatch({
      changes: { from: 0, to: current.length, insert: next },
      selection: {
        anchor: Math.min(next.length, this.#view.state.selection.main.anchor),
      },
    });
  }

  getTextForTest(): string {
    return this.#view.state.doc.toString();
  }

  /** Test-only selection control (never used by production UI). */
  setSelectionForTest(anchor: number, head?: number): void {
    const length = this.#view.state.doc.length;
    const clamp = (pos: number): number => Math.max(0, Math.min(pos, length));
    this.#view.dispatch({
      selection: { anchor: clamp(anchor), head: clamp(head ?? anchor) },
      scrollIntoView: false,
    });
  }

  /** Test-only selection readback (never used by production UI). */
  getSelectionForTest(): { readonly from: number; readonly to: number } {
    const selection = this.#view.state.selection.main;
    return { from: selection.from, to: selection.to };
  }

  focus(): void {
    this.#view.focus();
  }

  hasFocus(): boolean {
    return this.#view.hasFocus;
  }

  canExecCommand(id: 'undo' | 'redo'): boolean {
    return id === 'undo'
      ? undoDepth(this.#view.state) > 0
      : redoDepth(this.#view.state) > 0;
  }

  execCommand(id: 'undo' | 'redo'): boolean {
    if (this.#destroyed) return false;
    return id === 'undo' ? undo(this.#view) : redo(this.#view);
  }

  revealAddress(address: string): void {
    if (this.#destroyed) return;
    const lineIndex = buildAddressIndex(this.#view.state.doc.toString()).get(
      address,
    );
    if (lineIndex === undefined) return;
    const line = this.#view.state.doc.line(
      Math.min(this.#view.state.doc.lines, lineIndex + 1),
    );
    this.#view.dispatch({
      selection: { anchor: line.from },
      scrollIntoView: true,
    });
  }

  #notifyTools(): void {
    for (const listener of this.#toolListeners) listener();
  }

  #toolSnapshot(): ReturnType<DocumentEditorTools['snapshot']> {
    const { state } = this.#view;
    const selection = state.selection.main;
    const line = state.doc.lineAt(selection.head);
    const blockValue = detectBlockValue(line.text);
    const context = describeBlockContext(blockValue);
    // Snapshot work stays line/selection-scoped: ancestor walks are O(depth)
    // and range iteration is bounded by the selection. Never serialize or
    // re-parse the whole document here.
    const bold = markdownMarkState(
      state,
      selection.from,
      selection.to,
      MARK_BOLD_NAMES,
    );
    const italic = markdownMarkState(
      state,
      selection.from,
      selection.to,
      MARK_ITALIC_NAMES,
    );
    const code = markdownMarkState(
      state,
      selection.from,
      selection.to,
      MARK_CODE_NAMES,
    );
    const { inCode, inFenced } = codeFlags(state, selection.from, selection.to);
    const linkTarget = markdownLinkTargetAt(
      state,
      selection.from,
      selection.to,
    );
    const inLink = linkTarget !== null;
    const contextualAnchor = sourceSelectionAnchor(this.#view);
    return {
      context,
      ...(contextualAnchor ? { contextualAnchor } : {}),
      controls: [
        {
          kind: 'choice',
          id: 'markdown.block',
          group: 'block',
          label: 'Line style',
          semanticRole: 'writing.style',
          value: /^heading:[1-5]$/.test(blockValue) ? blockValue : 'paragraph',
          options: [
            { value: 'paragraph', label: 'Paragraph' },
            { value: 'heading:1', label: 'Heading 1' },
            { value: 'heading:2', label: 'Heading 2' },
            { value: 'heading:3', label: 'Heading 3' },
            { value: 'heading:4', label: 'Heading 4' },
            { value: 'heading:5', label: 'Heading 5' },
          ],
          ...(inFenced ? { disabled: true as const } : {}),
        },
        ...(
          [
            ['quote', 'Quote'],
            ['bullet', 'Bullet list'],
            ['numbered', 'Numbered list'],
            ['task', 'Task list'],
          ] as const
        ).map(([name, label]) => ({
          kind: 'button' as const,
          id: `markdown.block.${name}`,
          group: 'block',
          semanticRole: `markdown.block.${name}`,
          label,
          icon:
            name === 'quote'
              ? 'quote'
              : name === 'bullet'
                ? 'list-bullet'
                : name === 'numbered'
                  ? 'list-numbered'
                  : 'list-check',
          active: blockValue === name,
          activationRole: 'toggle' as const,
          ...(inFenced ? { disabled: true as const } : {}),
        })),
        writingFormatToggleControl('markdown.bold', 'bold', {
          ...(bold.active ? { active: true } : {}),
          ...(bold.mixed ? { mixed: true } : {}),
          ...(inCode ? { disabled: true } : {}),
        }),
        writingFormatToggleControl('markdown.italic', 'italic', {
          ...(italic.active ? { active: true } : {}),
          ...(italic.mixed ? { mixed: true } : {}),
          ...(inCode ? { disabled: true } : {}),
        }),
        writingFormatToggleControl('markdown.code', 'code', {
          ...(code.active ? { active: true } : {}),
          ...(code.mixed ? { mixed: true } : {}),
          ...(inFenced ? { disabled: true } : {}),
        }),
        writingLinkControl('markdown.link', {
          ...(linkTarget !== null ? { value: linkTarget.url } : {}),
          ...(inLink ? { active: true } : {}),
          ...(inCode ? { disabled: true } : {}),
        }),
        writingCodeBlockControl('markdown.code-block', {
          ...(inFenced ? { disabled: true } : {}),
        }),
        ...(this.#hasWorkspaceSuggestions
          ? [
              {
                kind: 'button' as const,
                id: 'markdown.note-link',
                group: 'insert',
                semanticRole: 'markdown.insert.note-link',
                label: 'Link note',
                icon: 'link',
                ...(inCode || !selection.empty
                  ? { disabled: true as const }
                  : {}),
              },
              {
                kind: 'button' as const,
                id: 'markdown.embed',
                group: 'insert',
                semanticRole: 'markdown.insert.embed',
                label: 'Embed file',
                icon: 'file',
                ...(inCode || !selection.empty
                  ? { disabled: true as const }
                  : {}),
              },
            ]
          : []),
        ...(this.#importImage
          ? [
              {
                kind: 'button' as const,
                id: 'markdown.import-image',
                group: 'insert',
                semanticRole: 'markdown.insert.import-image',
                label: 'Import image',
                icon: 'file-image',
                ...(inCode || !selection.empty
                  ? { disabled: true as const }
                  : {}),
              },
            ]
          : []),
        {
          kind: 'table',
          id: 'markdown.table',
          group: 'insert',
          semanticRole: 'markdown.insert.table',
          label: 'Table',
          columns: 3,
          rows: 2,
          header: true,
          maxColumns: 20,
          maxRows: 50,
          ...(inFenced ? { disabled: true as const } : {}),
        },
        {
          kind: 'button',
          id: 'markdown.divider',
          group: 'insert',
          semanticRole: 'markdown.insert.divider',
          label: 'Divider',
          ...(inFenced || !selection.empty ? { disabled: true as const } : {}),
        },
      ],
    };
  }

  #executeTool(id: string, value?: string): boolean {
    if (this.#destroyed) return false;
    if (id === 'markdown.import-image' && this.#importImage) {
      const importImage = this.#importImage;
      const state = this.#view.state;
      const selection = state.selection.main;
      if (
        this.#fileInput ||
        !selection.empty ||
        touchesNamed(state, selection.from, selection.to, CODE_NODES)
      )
        return false;
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.png,.jpg,.jpeg,.gif,.webp,.avif';
      input.hidden = true;
      this.#fileInput = input;
      const clear = () => {
        input.remove();
        if (this.#fileInput === input) this.#fileInput = null;
      };
      input.addEventListener('cancel', clear, { once: true });
      input.addEventListener(
        'change',
        () => {
          const file = input.files?.[0];
          clear();
          if (!file || this.#destroyed) return;
          void (async () => {
            try {
              if (
                !/\.(?:png|jpe?g|gif|webp|avif)$/i.test(file.name) ||
                file.size > 8_000_000
              )
                throw new Error(
                  'Choose a PNG, JPEG, GIF, WebP or AVIF image under 8 MB',
                );
              const safeName = file.name.replace(/[[\]#|]/g, '-');
              const savedPath = await importImage(
                safeName,
                new Uint8Array(await file.arrayBuffer()),
              );
              if (this.#destroyed || this.#view.state.doc !== state.doc) return;
              this.#view.dispatch({
                changes: { from: selection.from, insert: `![[${savedPath}]]` },
                selection: { anchor: selection.from + savedPath.length + 5 },
                scrollIntoView: true,
              });
              this.#view.focus();
            } catch (error) {
              if (!this.#destroyed)
                window.alert(
                  `Could not import image: ${error instanceof Error ? error.message : String(error)}`,
                );
            }
          })();
        },
        { once: true },
      );
      document.body.append(input);
      input.click();
      return true;
    }
    if (
      (id === 'markdown.note-link' || id === 'markdown.embed') &&
      this.#hasWorkspaceSuggestions
    ) {
      const selection = this.#view.state.selection.main;
      if (
        !selection.empty ||
        touchesNamed(this.#view.state, selection.from, selection.to, CODE_NODES)
      )
        return false;
      const prefix = id === 'markdown.embed' ? '![[' : '[[';
      this.#view.dispatch({
        changes: { from: selection.from, insert: `${prefix}]]` },
        selection: { anchor: selection.from + prefix.length },
        scrollIntoView: true,
      });
      this.#view.focus();
      startCompletion(this.#view);
      return true;
    }
    if (id === 'markdown.table') {
      const match = /^(\d+):(\d+):(named|blank)$/.exec(value ?? '');
      if (match === null) return false;
      const columns = Number(match[1]);
      const rows = Number(match[2]);
      if (columns < 1 || columns > 20 || rows < 1 || rows > 50) return false;
      const state = this.#view.state;
      const selection = state.selection.main;
      if (touchesNamed(state, selection.from, selection.to, FENCED_NODES))
        return false;
      const header = Array.from({ length: columns }, (_, index) =>
        match[3] === 'named' ? `Column ${index + 1}` : ' ',
      );
      const cells = Array.from({ length: columns }, () => ' ');
      const line = state.doc.lineAt(selection.head);
      const prefix = line.text.length === 0 ? '' : '\n';
      const table = [
        `| ${header.join(' | ')} |`,
        `| ${Array.from({ length: columns }, () => '---').join(' | ')} |`,
        ...Array.from({ length: rows }, () => `| ${cells.join(' | ')} |`),
      ].join('\n');
      const insert = `${prefix}${table}\n`;
      this.#view.dispatch({
        changes: { from: line.to, insert },
        selection: { anchor: line.to + insert.length },
        scrollIntoView: true,
      });
      this.#view.focus();
      return true;
    }
    if (id === 'markdown.divider') {
      const state = this.#view.state;
      const selection = state.selection.main;
      if (
        !selection.empty ||
        touchesNamed(state, selection.from, selection.to, FENCED_NODES)
      )
        return false;
      const line = state.doc.lineAt(selection.head);
      const insert = line.text.trim() === '' ? '---\n' : '\n\n---\n';
      this.#view.dispatch({
        changes: { from: line.to, insert },
        selection: { anchor: line.to + insert.length },
        scrollIntoView: true,
      });
      this.#view.focus();
      return true;
    }
    const blockButton = /^markdown\.block\.(quote|bullet|numbered|task)$/.exec(
      id,
    );
    if ((id === 'markdown.block' && value !== undefined) || blockButton) {
      const selection = this.#view.state.selection.main;
      const currentLine = this.#view.state.doc.lineAt(selection.head);
      const requested = blockButton?.[1] ?? value;
      const nextValue =
        blockButton && detectBlockValue(currentLine.text) === requested
          ? 'paragraph'
          : requested;
      const prefixes: Record<string, string> = {
        paragraph: '',
        'heading:1': '# ',
        'heading:2': '## ',
        'heading:3': '### ',
        'heading:4': '#### ',
        'heading:5': '##### ',
        quote: '> ',
        bullet: '- ',
        numbered: '1. ',
        task: '- [ ] ',
      };
      const nextPrefix = prefixes[nextValue ?? ''];
      if (nextPrefix === undefined) return false;
      // Rewriting a prefix inside fenced code would corrupt a code sample;
      // the snapshot disables the selector there, so refuse here as well.
      if (
        touchesNamed(
          this.#view.state,
          selection.from,
          selection.to,
          FENCED_NODES,
        )
      )
        return false;
      const line = currentLine;
      const oldPrefix =
        line.text.match(
          /^(#{1,6}\s+|>\s+|(?:[-*]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)/,
        )?.[0] ?? '';
      const bodyFrom = line.from + oldPrefix.length;
      const mapSelectionPosition = (position: number): number =>
        position < line.from
          ? position
          : position <= bodyFrom
            ? line.from + nextPrefix.length
            : position + nextPrefix.length - oldPrefix.length;
      this.#view.dispatch({
        changes: {
          from: line.from,
          to: line.from + oldPrefix.length,
          insert: nextPrefix,
        },
        selection: {
          anchor: mapSelectionPosition(selection.anchor),
          head: mapSelectionPosition(selection.head),
        },
        scrollIntoView: true,
      });
      this.#view.focus();
      return true;
    }
    if (id === 'markdown.bold') {
      const handled = applyBoldTransform(this.#view);
      if (handled) this.#view.focus();
      return handled;
    }
    if (id === 'markdown.italic') {
      const handled = applyItalicTransform(this.#view);
      if (handled) this.#view.focus();
      return handled;
    }
    if (id === 'markdown.code') {
      const handled = applyCodeTransform(this.#view);
      if (handled) this.#view.focus();
      return handled;
    }
    if (id === 'markdown.code-block') {
      const selection = this.#view.state.selection.main;
      if (
        touchesNamed(
          this.#view.state,
          selection.from,
          selection.to,
          FENCED_NODES,
        )
      )
        return false;
      const selected = this.#view.state.doc.sliceString(
        selection.from,
        selection.to,
      );
      this.#view.dispatch({
        changes: {
          from: selection.from,
          to: selection.to,
          insert: `\`\`\`\n${selected}\n\`\`\``,
        },
        selection: {
          anchor: selection.from + '```\n'.length,
          head: selection.from + '```\n'.length + selected.length,
        },
        scrollIntoView: true,
      });
      this.#view.focus();
      return true;
    }
    if (id === 'markdown.link') {
      if (value === undefined || !isValidLinkDestination(value)) return false;
      const destination = value.trim();
      const { state } = this.#view;
      const selection = state.selection.main;
      if (touchesNamed(state, selection.from, selection.to, CODE_NODES))
        return false;
      const existing = markdownLinkTargetAt(
        state,
        selection.from,
        selection.to,
      );
      if (existing !== null) {
        // Edit the existing target in place; the label is untouched.
        this.#view.dispatch({
          changes: {
            from: existing.urlFrom,
            to: existing.urlTo,
            insert: destination,
          },
          selection: {
            anchor:
              existing.linkTo -
              (existing.urlTo - existing.urlFrom) +
              destination.length,
          },
          scrollIntoView: true,
        });
        this.#view.focus();
        return true;
      }
      if (selection.from !== selection.to) {
        const selected = state.doc.sliceString(selection.from, selection.to);
        const replacement = `[${selected}](${destination})`;
        this.#view.dispatch({
          changes: {
            from: selection.from,
            to: selection.to,
            insert: replacement,
          },
          selection: { anchor: selection.from + replacement.length },
          scrollIntoView: true,
        });
        this.#view.focus();
        return true;
      }
      const replacement = `[${LINK_PLACEHOLDER_LABEL}](${destination})`;
      this.#view.dispatch({
        changes: {
          from: selection.from,
          to: selection.to,
          insert: replacement,
        },
        selection: {
          anchor: selection.from + 1,
          head: selection.from + 1 + LINK_PLACEHOLDER_LABEL.length,
        },
        scrollIntoView: true,
      });
      this.#view.focus();
      return true;
    }
    return false;
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#fileInput?.remove();
    this.#fileInput = null;
    this.#toolListeners.clear();
    // Unmount first so React cleanly removes the skeleton it owns; the
    // engine teardown below then runs against detached nodes (its own
    // wrapper.remove() becomes a harmless no-op). Reversing the order yanks
    // React-managed DOM out from under the root and corrupts teardown.
    this.#root.unmount();
    this.#view.destroy();
    this.#wrapper.remove();
  }

  get destroyed(): boolean {
    return this.#destroyed;
  }
}

/** Visible skeleton element: owned by React, consumed by the engine. */
export interface MarkdownSkeleton {
  readonly root: HTMLDivElement;
}

export class MarkdownDocumentEditorProvider implements MarkdownEditorProvider {
  constructor(
    private readonly options: {
      readonly importImage?: (
        name: string,
        bytes: Uint8Array,
      ) => Promise<string>;
    } = {},
  ) {}

  createEditor(input: {
    readonly session: DocumentSession<{ raw: string }>;
    readonly parent: unknown;
    readonly initialText: string;
    readonly onDirtyText: (text: string) => void;
    readonly resourceResolver?: ResourceResolver;
    readonly searchImageFiles?: (query: string) => Promise<readonly string[]>;
  }): MarkdownEditorHandle {
    void input.session;
    if (
      typeof document !== 'undefined' &&
      typeof HTMLElement !== 'undefined' &&
      input.parent instanceof HTMLElement
    ) {
      return new CodemirrorMarkdownEditorHandle(
        input.parent,
        input.initialText,
        input.onDirtyText,
        input.resourceResolver,
        input.searchImageFiles,
        this.options.importImage,
      );
    }
    return new HeadlessMarkdownEditorHandle(
      input.initialText,
      input.onDirtyText,
    );
  }
}

export type {
  MarkdownEditorHandle,
  MarkdownEditorProvider,
} from '@froglight/foundation';
