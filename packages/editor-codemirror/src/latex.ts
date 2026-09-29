/**
 * LaTeX editor provider — CodeMirror source editor.
 *
 * Edit-mode surface only: the sandboxed rendered preview lives in the
 * reading-view provider (`latex-reader.ts`) and mounts in `reading` mode
 * through the centralized DocumentReaderRegistry. This handle keeps a
 * debounced provider render purely for edit-time diagnostics; rendered HTML
 * is discarded here and canonical bytes flow through the shared session.
 */

import {
  sourceSelectionTheme,
  sourceSelectionAnchor,
  watchSourceSelection,
} from './source-selection.js';
import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, highlightSpecialChars } from '@codemirror/view';
import {
  defaultKeymap,
  history,
  historyKeymap,
  isolateHistory,
  redo,
  redoDepth,
  undo,
  undoDepth,
} from '@codemirror/commands';
import { latexHighlighting } from './latex-highlighting.js';
import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { flushSync } from 'react-dom';
import type {
  DocumentEditorHandle,
  DocumentEditorProvider,
  DocumentEditorTools,
  DocumentSession,
  DocumentToolControl,
  LaTeXDiagnostic,
  LaTeXDocumentHandle,
} from '@froglight/foundation';
import { latexKindId, writingFormatToggleControl } from '@froglight/foundation';
import { resolveLatexAddress, type LatexRenderDeps } from './latex-shared.js';
import { LatexEditorSkeleton } from './react/LatexEditorSkeleton.jsx';
export { PREVIEW_SANDBOX } from './latex-shared.js';

/** Render-capability dependencies for edit-time diagnostics. */
export type LatexDocumentEditorDeps = LatexRenderDeps;

const latexSourceTheme = EditorView.theme({
  '.cm-content': {
    width: '100%',
    maxWidth: '74ch',
    margin: '0 auto',
  },
  '.cm-line': { padding: '0 10px' },
});

/** Visible skeleton elements: owned by React, consumed by the engine. */
export interface LatexEditorSkeleton {
  readonly root: HTMLDivElement;
  readonly source: HTMLDivElement;
}

/**
 * Conservative portable LaTeX source actions (latex-toolbar-spec).
 *
 * The provider is the sole interpreter of caret/selection/source syntax. It
 * emits plain semantic state and performs literal source transformations
 * with selection/caret repair inside one provider-local undo transaction.
 * React sends semantic ids/values only and never inspects editor state.
 *
 * - Structure/emphasis/math occupy the top-bar center directly or through
 *   compact grouped triggers; environments/references/citations ride a
 *   compact insertion surface so nothing creates a second row.
 * - Insertion helpers never add packages or rewrite the preamble; they
 *   insert standard portable syntax at the caret/selection only.
 * - Citation insertion produces standard `\cite{}` and feeds existing
 *   parsing/relationships without claiming formatted bibliography output.
 * - No compile-to-PDF action exists until the separate compile capability
 *   does. No full BibTeX/package-management actions exist.
 */

const STRUCTURE_COMMANDS = [
  'section',
  'subsection',
  'subsubsection',
  'paragraph',
  'subparagraph',
] as const;
type StructureCommand = (typeof STRUCTURE_COMMANDS)[number];
const STRUCTURE_SET: ReadonlySet<string> = new Set(STRUCTURE_COMMANDS);

const LATEX_ENVIRONMENTS = ['itemize', 'enumerate', 'quote'] as const;
type LatexEnvironment = (typeof LATEX_ENVIRONMENTS)[number];
const ENVIRONMENT_SET: ReadonlySet<string> = new Set(LATEX_ENVIRONMENTS);

const BOLD_PLACEHOLDER = 'text';
const EMPHASIS_PLACEHOLDER = 'text';
const MATH_PLACEHOLDER = 'x';
const SECTION_PLACEHOLDER = 'Title';
const ITEM_PLACEHOLDER = 'Item';
const QUOTE_PLACEHOLDER = 'Quoted text';

/** Literal bodies are not LaTeX commands, even when they look like begins. */
const LITERAL_ENVIRONMENT =
  /^(?:verbatim|Verbatim|BVerbatim|LVerbatim|SaveVerbatim|lstlisting|minted|alltt|comment|filecontents)\*?$/;

/**
 * A bounded source-syntax check, not a TeX interpreter. Skip comments,
 * escaped control symbols and literal bodies; balance real environments so
 * a nested end cannot be mistaken for this begin's end. Malformed or
 * uncertain syntax declines assistance rather than repairing user source.
 */
function canPairEnvironment(source: string, beginAt: number): boolean {
  const tokens = /\\([A-Za-z]+|[^\r\n])|%[^\n]*|[{}]/g;
  const stack: { name: string; at: number }[] = [];
  let braces = 0;
  let candidateSeen = false;
  for (let token; (token = tokens.exec(source)) !== null; ) {
    const command = token[1];
    if (command === undefined) {
      if (token[0] === '{') braces++;
      if (token[0] === '}' && --braces < 0) return false;
      continue;
    }
    // Catcode changes and verbatim-like inline macros cannot be interpreted
    // safely by a lexical assist. Standard \verb can be skipped literally.
    if (/^(?:catcode|lstinline|mintinline)$/.test(command)) return false;
    if (command === 'verb') {
      let start = tokens.lastIndex;
      if (source[start] === '*') start++;
      const delimiter = source[start];
      if (delimiter === undefined || /\s|[A-Za-z]/.test(delimiter))
        return false;
      const end = source.indexOf(delimiter, start + 1);
      if (end < 0 || source.slice(start, end).includes('\n')) return false;
      tokens.lastIndex = end + 1;
      continue;
    }
    if (command !== 'begin' && command !== 'end') continue;
    const argument = /^\{([A-Za-z]+\*?)\}/.exec(source.slice(tokens.lastIndex));
    if (argument === null || braces !== 0) return false;
    const name = argument[1];
    if (name === undefined) return false;
    tokens.lastIndex += argument[0].length;
    if (command === 'begin') {
      if (LITERAL_ENVIRONMENT.test(name)) {
        // Only an exact, standalone delimiter line is unambiguous across
        // these literal environments. Inline examples (or lines with extra
        // content) do not end the body. Decline other termination variants.
        const endLine = `\n\\end{${name}}`;
        let end = source.indexOf(endLine, tokens.lastIndex);
        while (
          end >= 0 &&
          end + endLine.length < source.length &&
          source[end + endLine.length] !== '\n'
        ) {
          end = source.indexOf(endLine, end + endLine.length);
        }
        if (end < 0 || (token.index <= beginAt && beginAt < end)) return false;
        tokens.lastIndex = end + endLine.length;
        continue;
      }
      stack.push({ name, at: token.index });
      if (token.index === beginAt) candidateSeen = true;
    } else {
      const open = stack.pop();
      // A new begin inside an existing document has no end yet. Its
      // enclosing environment's end is the insertion boundary.
      if (open?.at === beginAt && stack.at(-1)?.name === name)
        return braces === 0;
      if (open?.name !== name || open.at === beginAt) return false;
    }
  }
  return candidateSeen && braces === 0 && stack.at(-1)?.at === beginAt;
}

/** Only the Enter key invokes this assist; document updates never do. */
function maybePairEnvironment(view: EditorView): boolean {
  const { state } = view;
  const selection = state.selection.main;
  if (
    state.readOnly ||
    view.composing ||
    !selection.empty ||
    state.selection.ranges.length !== 1
  )
    return false;
  const line = state.doc.lineAt(selection.head);
  if (selection.head !== line.to) return false;
  // No trailing spaces/comments/arguments: the caret must immediately follow
  // the closing brace on an otherwise standalone begin line.
  const match = /^([ \t]*)\\begin\{([A-Za-z]+\*?)\}$/.exec(line.text);
  if (match === null) return false;
  const indent = match[1];
  const env = match[2];
  if (indent === undefined || env === undefined) return false;
  if (!canPairEnvironment(state.doc.toString(), line.from + indent.length))
    return false;
  view.dispatch({
    changes: { from: line.to, insert: `\n${indent}\n${indent}\\end{${env}}` },
    selection: { anchor: line.to + 1 + indent.length },
    annotations: isolateHistory.of('full'),
    userEvent: 'input',
    scrollIntoView: true,
  });
  // CM history otherwise derives redo's caret by mapping the pre-edit
  // selection to the end of the insertion. Record the actual inner caret
  // as a selection-only event (not another undoable source edit).
  view.dispatch({ selection: view.state.selection });
  return true;
}

/**
 * Single citation/label key validity. Keys are trimmed outer whitespace;
 * inner whitespace, braces, backslashes, percent signs, and (for single
 * keys) commas would produce surprising source, so the provider rejects
 * them without mutating.
 */
export function isValidLatexKey(value: string): boolean {
  const trimmed = value.trim();
  return trimmed !== '' && !/[\s{}\\%,]/.test(trimmed);
}

/**
 * Citation value validity: comma-separated non-empty keys, each satisfying
 * `isValidLatexKey`. Returns normalized keys (trimmed, comma-joined with no
 * spaces for determinism) or null when the value must not mutate source.
 */
export function normalizeLatexCiteKeys(value: string): string | null {
  const parts = value.split(',').map((part) => part.trim());
  if (parts.length === 0) return null;
  for (const part of parts) {
    if (!isValidLatexKey(part)) return null;
  }
  return parts.join(',');
}

function wrapRange(
  view: EditorView,
  from: number,
  to: number,
  open: string,
  close: string,
  placeholder: string,
): void {
  const selected = view.state.doc.sliceString(from, to);
  if (from !== to) {
    view.dispatch({
      changes: { from, to, insert: open + selected + close },
      selection: {
        anchor: from + open.length,
        head: from + open.length + selected.length,
      },
      scrollIntoView: true,
    });
  } else {
    view.dispatch({
      changes: { from, to, insert: open + placeholder + close },
      selection: {
        anchor: from + open.length,
        head: from + open.length + placeholder.length,
      },
      scrollIntoView: true,
    });
  }
  view.focus();
}

/**
 * Replace the selection with `\command{key}` and park the caret after the
 * closing brace. Shared by label/reference/citation insertion so keyed
 * commands keep one caret-placement rule.
 */
function insertKeyedCommand(
  view: EditorView,
  from: number,
  to: number,
  command: string,
  key: string,
): void {
  const text = `\\${command}{${key}}`;
  view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: from + text.length },
    scrollIntoView: true,
  });
  view.focus();
}

function insertEnvironment(
  view: EditorView,
  from: number,
  to: number,
  env: LatexEnvironment,
): void {
  const selected = view.state.doc.sliceString(from, to);
  if (env === 'itemize' || env === 'enumerate') {
    const item = selected !== '' ? selected : ITEM_PLACEHOLDER;
    const head = `\\begin{${env}}\n\\item `;
    const tail = `\n\\end{${env}}`;
    view.dispatch({
      changes: { from, to, insert: head + item + tail },
      selection: {
        anchor: from + head.length,
        head: from + head.length + item.length,
      },
      scrollIntoView: true,
    });
  } else {
    const content = selected !== '' ? selected : QUOTE_PLACEHOLDER;
    const head = '\\begin{quote}\n';
    const tail = '\n\\end{quote}';
    view.dispatch({
      changes: { from, to, insert: head + content + tail },
      selection: {
        anchor: from + head.length,
        head: from + head.length + content.length,
      },
      scrollIntoView: true,
    });
  }
  view.focus();
}

type LatexDiagnosticsState =
  | 'pending'
  | 'unavailable'
  | 'clean'
  | 'notes'
  | 'errors'
  | 'failed';

class LatexDocumentEditorHandle implements DocumentEditorHandle {
  readonly #deps: LatexDocumentEditorDeps;
  readonly #session: DocumentSession;
  readonly #view: EditorView;
  readonly #wrapper: HTMLElement;
  readonly #root: Root;
  readonly #readOnly = new Compartment();
  #handle: LaTeXDocumentHandle | null = null;
  #renderTimer: ReturnType<typeof setTimeout> | null = null;
  #renderGeneration = 0;
  #destroyed = false;
  #diagnostics: readonly LaTeXDiagnostic[] = [];
  #diagnosticsState: LatexDiagnosticsState = 'pending';
  #diagnosticsFailure: string | null = null;
  readonly #toolListeners = new Set<() => void>();
  readonly tools: DocumentEditorTools;

  constructor(
    deps: LatexDocumentEditorDeps,
    session: DocumentSession,
    parent: HTMLElement,
  ) {
    this.#deps = deps;
    this.#session = session;

    // One narrowly contained synchronous commit: the engine
    // needs the actual source element immediately, and createEditor
    // is synchronous. Never during normal rendering or engine updates.
    const skeletonRef: { current: LatexEditorSkeleton | null } = {
      current: null,
    };
    const root = createRoot(parent);
    flushSync(() => {
      root.render(createElement(LatexEditorSkeleton, { skeletonRef }));
    });
    const skeleton = skeletonRef.current;
    if (skeleton === null)
      throw new Error('latex editor skeleton failed to commit');
    this.#root = root;
    this.#wrapper = skeleton.root;
    const editorPane = skeleton.source;

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        const next = update.state.doc.toString();
        const model = this.#session.model as unknown as { raw: string };
        // unchanged-text guard (Markdown adapter parity,
        // editor-adapters.ts:55-59): no-op dispatches must never markDirty
        // or bump the shell. Without this, selection-only or redundant
        // commits advance the outline key and spam notifies.
        if (next === model.raw) return;
        model.raw = next;
        this.#session.markDirty();
        // Never report stale `clean` while new source waits for analysis:
        // reset to pending immediately, then debounce the render.
        // coalesce: `markDirty` already bumped the shell
        // synchronously via the session content subscription (outline
        // freshness + toolbar snapshot on that single bump). A second
        // synchronous tools notify here would bump the shell twice per
        // keystroke (Maximum update depth spam on long docs). It is
        // suppressed on this path; async diagnostics completion still
        // notifies through its own path below.
        if (this.#diagnosticsState !== 'unavailable') {
          this.#diagnosticsState = 'pending';
        }
        this.#scheduleRender();
      }
    });

    const initialText = (session.model as unknown as { raw: string }).raw ?? '';
    const state = EditorState.create({
      doc: initialText,
      extensions: [
        highlightSpecialChars(),
        history(),
        sourceSelectionTheme,
        watchSourceSelection(() => this.#notifyTools()),
        EditorView.lineWrapping,
        latexSourceTheme,
        EditorView.contentAttributes.of({ 'aria-label': 'LaTeX source' }),
        keymap.of([
          { key: 'Enter', run: maybePairEnvironment },
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        latexHighlighting,
        this.#readOnly.of(EditorState.readOnly.of(false)),
        updateListener,
      ],
    });
    this.#view = new EditorView({ state, parent: editorPane });

    this.tools = {
      snapshot: () => this.#toolSnapshot(),
      execute: (id, value) => this.#executeTool(id, value),
      onDidChange: (listener) => {
        this.#toolListeners.add(listener);
        return { dispose: () => this.#toolListeners.delete(listener) };
      },
    };

    // Synchronous availability seed so the first snapshot never claims a
    // clean document before the debounced analysis runs: pending when
    // analysis is possible, unavailable only when it cannot be performed.
    if (
      this.#deps.latexProvider() === null ||
      this.#deps.resolveDocumentPath(this.#session) === null
    ) {
      this.#diagnosticsState = 'unavailable';
    } else {
      this.#diagnosticsState = 'pending';
    }
    this.#scheduleRender();
  }

  #scheduleRender(): void {
    if (this.#destroyed) return;
    // Supersede in-flight analysis at source change, not after the debounce.
    // A completion in this window must not replace pending with stale results.
    this.#renderGeneration += 1;
    if (this.#renderTimer !== null) clearTimeout(this.#renderTimer);
    this.#renderTimer = setTimeout(() => {
      this.#renderTimer = null;
      void this.#render();
    }, this.#deps.renderDebounceMillis ?? 500);
  }

  async #render(): Promise<void> {
    if (this.#destroyed) return;
    const generation = ++this.#renderGeneration;
    const provider = this.#deps.latexProvider();
    const documentPath = this.#deps.resolveDocumentPath(this.#session);
    const resolver =
      documentPath !== null ? this.#deps.createResolver(documentPath) : null;
    if (provider === null || resolver === null) {
      if (!this.#isCurrentGeneration(generation)) return;
      this.#diagnostics = [];
      this.#diagnosticsState = 'unavailable';
      this.#diagnosticsFailure = null;
      this.#notifyTools();
      return;
    }
    const entry = (this.#session.model as unknown as { raw: string }).raw;
    try {
      const handle = await provider.open({ entry, resolve: resolver });
      if (!this.#isCurrentGeneration(generation)) {
        await handle.close();
        return;
      }
      const owned = await this.#replaceRenderHandle(handle, generation);
      if (!owned) return;
      // Rendered HTML belongs to the reading view; edit mode keeps the
      // diagnostics so breakage is never silent. Canonical bytes are never
      // mutated here: diagnostics are derived state only.
      const result = await handle.render();
      if (!this.#isCurrentGeneration(generation)) return;
      // Totals come from the full set; only the popover list is capped.
      const allDiagnostics = result.diagnostics;
      this.#diagnostics = allDiagnostics;
      this.#diagnosticsFailure = null;
      const errors = allDiagnostics.filter(
        (d) => d.code !== 'LATEX_INFO',
      ).length;
      this.#diagnosticsState =
        errors > 0 ? 'errors' : allDiagnostics.length > 0 ? 'notes' : 'clean';
      this.#notifyTools();
    } catch (error) {
      if (!this.#isCurrentGeneration(generation)) return;
      const message = error instanceof Error ? error.message : String(error);
      this.#diagnostics = [];
      this.#diagnosticsState = 'failed';
      this.#diagnosticsFailure = message;
      this.#notifyTools();
    }
  }

  #isCurrentGeneration(generation: number): boolean {
    return !this.#destroyed && generation === this.#renderGeneration;
  }

  /**
   * Take ownership of a freshly opened render handle: install it, close the
   * previous one, and re-check the generation after the close await (a
   * newer render may have taken ownership while we waited). Returns false
   * when stale — the caller must not render or publish. On the stale path
   * the just-installed handle is closed and cleared, but only when no newer
   * generation has installed its own handle meanwhile (that owner closes
   * what it installed).
   */
  async #replaceRenderHandle(
    handle: LaTeXDocumentHandle,
    generation: number,
  ): Promise<boolean> {
    if (!this.#isCurrentGeneration(generation)) {
      await handle.close();
      return false;
    }
    const previous = this.#handle;
    this.#handle = handle;
    if (previous !== null) await previous.close();
    if (!this.#isCurrentGeneration(generation)) {
      if (this.#handle === handle) {
        this.#handle = null;
        await handle.close();
      }
      return false;
    }
    return true;
  }

  #notifyTools(): void {
    for (const listener of this.#toolListeners) listener();
  }

  #diagnosticsControl(): Extract<DocumentToolControl, { kind: 'diagnostics' }> {
    const state = this.#diagnosticsState;
    if (state === 'pending') {
      return {
        kind: 'diagnostics',
        id: 'latex.diagnostics',
        group: 'diagnostics',
        label: 'LaTeX analyzing…',
        state,
        errorCount: 0,
        noteCount: 0,
        entries: [],
      };
    }
    if (state === 'unavailable') {
      return {
        kind: 'diagnostics',
        id: 'latex.diagnostics',
        group: 'diagnostics',
        label: 'LaTeX preview unavailable',
        state,
        errorCount: 0,
        noteCount: 0,
        entries: [
          {
            id: 'unavailable',
            message:
              'Preview provider unavailable. Source editing remains available.',
            code: 'LATEX_PROVIDER_UNAVAILABLE',
            navigable: false,
          },
        ],
      };
    }
    if (state === 'failed') {
      return {
        kind: 'diagnostics',
        id: 'latex.diagnostics',
        group: 'diagnostics',
        label: 'LaTeX diagnostics failed',
        state,
        errorCount: 0,
        noteCount: 0,
        entries:
          this.#diagnosticsFailure !== null
            ? [
                {
                  id: 'failure',
                  message: this.#diagnosticsFailure,
                  code: 'LATEX_INFO',
                  navigable: false,
                },
              ]
            : [],
      };
    }
    // Totals from the full set; only the popover list is capped at 50.
    const allDiagnostics = this.#diagnostics;
    const errors = allDiagnostics.filter((d) => d.code !== 'LATEX_INFO').length;
    const notes = allDiagnostics.length - errors;
    const label =
      state === 'clean'
        ? 'LaTeX no issues'
        : errors > 0
          ? `LaTeX ${errors} issue${errors === 1 ? '' : 's'}`
          : `LaTeX ${notes} note${notes === 1 ? '' : 's'}`;
    const truncated = allDiagnostics.length > 50;
    const visibleEntries = allDiagnostics.slice(0, 50);
    return {
      kind: 'diagnostics',
      id: 'latex.diagnostics',
      group: 'diagnostics',
      label,
      state,
      errorCount: errors,
      noteCount: notes,
      ...(truncated
        ? { truncated: true as const, totalCount: allDiagnostics.length }
        : {}),
      entries: visibleEntries.map((diagnostic, index) => ({
        id: String(index),
        message: diagnostic.message,
        code: diagnostic.code,
        ...(diagnostic.path !== undefined ? { path: diagnostic.path } : {}),
        ...(diagnostic.line !== undefined ? { line: diagnostic.line } : {}),
        navigable:
          diagnostic.line !== undefined && diagnostic.path === 'document.tex',
      })),
    };
  }

  #toolSnapshot(): ReturnType<DocumentEditorTools['snapshot']> {
    // Command categories (latex-toolbar-spec): every control below is a
    // source edit (literal `.tex` transformation through the editor),
    // except `latex.diagnostics`, which is a diagnostic action whose
    // navigable entries execute source navigation. Existing pane actions
    // (reading-mode switch) and history (provider-local undo/redo) ride
    // their established channels, not Document Tools.
    return {
      // Accessible metadata only; the shared toolbar never renders this as
      // persistent visible chrome.
      context: 'LaTeX',
      contextualAnchor: sourceSelectionAnchor(this.#view),
      controls: [
        {
          kind: 'choice',
          id: 'latex.structure',
          group: 'structure',
          label: 'Structure',
          semanticRole: 'writing.style',
          value: '',
          options: [
            { value: '', label: 'Structure…' },
            { value: 'section', label: 'Section' },
            { value: 'subsection', label: 'Subsection' },
            { value: 'subsubsection', label: 'Subsubsection' },
            { value: 'paragraph', label: 'Paragraph heading' },
            { value: 'subparagraph', label: 'Subparagraph heading' },
          ],
        },
        writingFormatToggleControl('latex.bold', 'bold', {}),
        // `\emph{}` keeps its semantic label through the documented
        // builder exemption; role/icon/order/group/activationRole converge.
        writingFormatToggleControl(
          'latex.emphasis',
          'italic',
          {},
          { label: 'Emphasis' },
        ),
        {
          kind: 'button',
          id: 'latex.inline-math',
          semanticRole: 'latex.math.inline',
          group: 'math',
          label: 'Inline math',
          shortLabel: '$x$',
        },
        {
          kind: 'button',
          id: 'latex.display-math',
          semanticRole: 'latex.math.display',
          group: 'math',
          label: 'Display math',
          shortLabel: '\\[x\\]',
        },
        ...(
          [
            ['itemize', 'Bulleted list'],
            ['enumerate', 'Numbered list'],
            ['quote', 'Quotation'],
          ] as const
        ).map(([environment, label]) => ({
          kind: 'button' as const,
          id: `latex.environment.${environment}`,
          semanticRole: `latex.environment.${environment}`,
          group: 'insert',
          label,
        })),
        {
          kind: 'input',
          id: 'latex.label',
          semanticRole: 'latex.reference.label',
          group: 'references',
          label: 'Label name',
          placeholder: 'label-key',
          actionLabel: 'Label',
        },
        {
          kind: 'input',
          id: 'latex.ref',
          semanticRole: 'latex.reference.ref',
          group: 'references',
          label: 'Reference label',
          placeholder: 'label-key',
          actionLabel: 'Ref',
          icon: 'link',
        },
        {
          kind: 'input',
          id: 'latex.cite',
          semanticRole: 'latex.reference.cite',
          group: 'references',
          label: 'Citation key',
          placeholder: 'citation-key',
          actionLabel: 'Cite',
          icon: 'book',
        },
        this.#diagnosticsControl(),
      ],
    };
  }

  #executeTool(id: string, value?: string): boolean {
    if (this.#destroyed) return false;
    const selection = this.#view.state.selection.main;
    const { from, to } = selection;
    if (id === 'latex.structure') {
      if (value === undefined || value === '' || !STRUCTURE_SET.has(value))
        return false;
      const command = value as StructureCommand;
      wrapRange(
        this.#view,
        from,
        to,
        `\\${command}{`,
        '}',
        SECTION_PLACEHOLDER,
      );
      return true;
    }
    if (id === 'latex.bold') {
      wrapRange(this.#view, from, to, '\\textbf{', '}', BOLD_PLACEHOLDER);
      return true;
    }
    if (id === 'latex.emphasis') {
      wrapRange(this.#view, from, to, '\\emph{', '}', EMPHASIS_PLACEHOLDER);
      return true;
    }
    if (id === 'latex.inline-math') {
      wrapRange(this.#view, from, to, '$', '$', MATH_PLACEHOLDER);
      return true;
    }
    if (id === 'latex.display-math') {
      wrapRange(this.#view, from, to, '\\[', '\\]', MATH_PLACEHOLDER);
      return true;
    }
    if (id.startsWith('latex.environment.')) {
      const environment = id.slice('latex.environment.'.length);
      if (!ENVIRONMENT_SET.has(environment)) return false;
      insertEnvironment(this.#view, from, to, environment as LatexEnvironment);
      return true;
    }
    if (id === 'latex.label') {
      if (value === undefined || !isValidLatexKey(value)) return false;
      insertKeyedCommand(this.#view, from, to, 'label', value.trim());
      return true;
    }
    if (id === 'latex.ref') {
      if (value === undefined || !isValidLatexKey(value)) return false;
      insertKeyedCommand(this.#view, from, to, 'ref', value.trim());
      return true;
    }
    if (id === 'latex.cite') {
      if (value === undefined) return false;
      const normalized = normalizeLatexCiteKeys(value);
      if (normalized === null) return false;
      insertKeyedCommand(this.#view, from, to, 'cite', normalized);
      return true;
    }
    if (id === 'latex.diagnostics') {
      if (value === undefined) return false;
      const index = Number(value);
      if (!Number.isInteger(index) || index < 0) return false;
      const diagnostic = this.#diagnostics[index];
      if (
        diagnostic === undefined ||
        diagnostic.line === undefined ||
        diagnostic.path !== 'document.tex'
      )
        return false;
      this.#scrollSourceToLine(diagnostic.line);
      this.#view.focus();
      return true;
    }
    return false;
  }

  #scrollSourceToLine(line: number): void {
    const target = Math.min(this.#view.state.doc.lines, Math.max(1, line + 1));
    const lineBlock = this.#view.state.doc.line(target);
    this.#view.dispatch({
      selection: { anchor: lineBlock.from },
      scrollIntoView: true,
    });
  }

  revealAddress(address: string): void {
    const hit = resolveLatexAddress(
      (this.#session.model as unknown as { raw: string }).raw,
      address,
    );
    if (hit !== null) this.#scrollSourceToLine(hit.line);
  }

  /** Test-only full-document replacement (same discipline as the CM stub). */
  replaceTextForTest(next: string): void {
    if (this.#destroyed) return;
    const current = this.#view.state.doc.toString();
    if (next === current) return;
    this.#view.dispatch({
      changes: { from: 0, to: current.length, insert: next },
    });
  }

  /** Test-only source readback (never used by production UI). */
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

  setReadOnly(readOnly: boolean): void {
    if (this.#destroyed) return;
    this.#view.dispatch({
      effects: this.#readOnly.reconfigure(EditorState.readOnly.of(readOnly)),
    });
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

  flush(): void {
    if (this.#renderTimer !== null) {
      clearTimeout(this.#renderTimer);
      this.#renderTimer = null;
      void this.#render();
    }
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    if (this.#renderTimer !== null) clearTimeout(this.#renderTimer);
    this.#renderGeneration += 1;
    const handle = this.#handle;
    this.#handle = null;
    if (handle !== null) void handle.close();
    // Unmount first so React cleanly removes the skeleton it owns; the
    // engine teardown below then runs against detached nodes (its own
    // wrapper.remove() becomes a harmless no-op). Reversing the order yanks
    // React-managed DOM out from under the root and corrupts teardown.
    this.#root.unmount();
    this.#view.destroy();
    this.#wrapper.remove();
  }
}

export class LatexDocumentEditorProvider implements DocumentEditorProvider {
  readonly id = 'latex';
  readonly kindIds = [latexKindId];
  readonly #deps: LatexDocumentEditorDeps;

  constructor(deps: LatexDocumentEditorDeps) {
    this.#deps = deps;
  }

  createEditor(input: {
    readonly session: DocumentSession;
    readonly parent: unknown;
  }): DocumentEditorHandle {
    return new LatexDocumentEditorHandle(
      this.#deps,
      input.session,
      input.parent as HTMLElement,
    );
  }
}
