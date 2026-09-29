// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { forceParsing, syntaxTree } from '@codemirror/language';
import {
  EditorSelection,
  EditorState,
  StateEffect,
  Transaction,
} from '@codemirror/state';
import {
  latexModel,
  latexKindId,
  type DocumentEditorHandle,
  type DocumentToolSnapshot,
  type LaTeXSourceResolver,
  type LaTeXProvider,
  type LaTeXRenderResult,
} from '@froglight/foundation';
import { MockLaTeXProvider } from '@froglight/foundation/testing';
import type { DocumentSession } from '@froglight/foundation';
import {
  isValidLatexKey,
  LatexDocumentEditorProvider,
  normalizeLatexCiteKeys,
} from './latex.js';
import { resolveLatexAddress } from './latex-shared.js';
import {
  writingFormatToggleControl,
  type DocumentToolControl,
} from '@froglight/foundation';

function makeSession(initialRaw: string) {
  const model = latexModel(initialRaw);
  const dirty = { count: 0 };
  const session = {
    model,
    markDirty: () => {
      dirty.count += 1;
    },
  };
  return { session: session as unknown as DocumentSession, model, dirty };
}

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    latexProvider: () => new MockLaTeXProvider({ html: '<p>unused</p>' }),
    createResolver: ((_documentPath: string) => ({
      readFile: async () => '',
      assetUrl: async () => 'blob:mock',
    })) as (documentPath: string) => LaTeXSourceResolver,
    resolveDocumentPath: () => 'papers/thesis.tex',
    renderDebounceMillis: 5,
    ...overrides,
  };
}

type LatexTestHandle = DocumentEditorHandle & {
  replaceTextForTest(next: string): void;
  getTextForTest(): string;
  setSelectionForTest(anchor: number, head?: number): void;
  getSelectionForTest(): { readonly from: number; readonly to: number };
};

// jsdom has no Range#getClientRects, which CodeMirror's async measure loop
// calls off the critical assertion path. Polyfill it so those cycles stay
// silent instead of surfacing as unhandled jsdom errors.
const rangePrototype = (
  globalThis as unknown as { Range?: { prototype: Record<string, unknown> } }
).Range?.prototype;
if (
  rangePrototype !== undefined &&
  typeof rangePrototype['getClientRects'] !== 'function'
) {
  rangePrototype['getClientRects'] = () => [] as unknown as DOMRectList;
}

function makeHandle(
  initialRaw: string,
  overrides: Record<string, unknown> = {},
): { parent: HTMLElement; handle: LatexTestHandle; model: { raw: string } } {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const { session, model } = makeSession(initialRaw);
  const provider = new LatexDocumentEditorProvider(makeDeps(overrides));
  const handle = provider.createEditor({ session, parent }) as LatexTestHandle;
  return { parent, handle, model };
}

function snapshotOf(handle: LatexTestHandle): DocumentToolSnapshot {
  const tools = handle.tools;
  if (tools === undefined) throw new Error('semantic tools are unavailable');
  return tools.snapshot();
}

function execute(
  handle: LatexTestHandle,
  id: string,
  value?: string,
): boolean | Promise<boolean> {
  const tools = handle.tools;
  if (tools === undefined) throw new Error('semantic tools are unavailable');
  return value === undefined ? tools.execute(id) : tools.execute(id, value);
}

function diagnosticsOf(handle: LatexTestHandle) {
  const control = snapshotOf(handle).controls.find(
    (candidate) => candidate.id === 'latex.diagnostics',
  );
  if (control?.kind !== 'diagnostics')
    throw new Error('missing diagnostics control');
  return control;
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

function viewOf(parent: HTMLElement): EditorView {
  const element = parent.querySelector<HTMLElement>('.cm-editor');
  const view = element === null ? null : EditorView.findFromDOM(element);
  if (view === null) throw new Error('missing CodeMirror view');
  return view;
}

function pressEnter(view: EditorView): void {
  view.focus();
  view.contentDOM.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      keyCode: 13,
      bubbles: true,
      cancelable: true,
    }),
  );
}

// jsdom does not synthesize native text insertion from printable key events.
// Model that input as CM input.type transactions, but always use DOM Enter.
function typeSource(view: EditorView, source: string): void {
  // A burst of typing has one timestamp regardless of CI machine load.
  const time = Date.now();
  for (const character of source) {
    view.dispatch({
      changes: { from: view.state.selection.main.head, insert: character },
      selection: { anchor: view.state.selection.main.head + character.length },
      userEvent: 'input.type',
      annotations: Transaction.time.of(time),
    });
  }
}

describe('LaTeX source highlighting', () => {
  it('isolates command records across parser checkpoints during edit/undo/redo', () => {
    const source =
      '\\documentclass[' +
      'a'.repeat(520) +
      '\n]\n' +
      ' '.repeat(40) +
      '{article}\n';
    const { parent, handle, model } = makeHandle(source);
    const view = viewOf(parent);
    const parsed = (editor: EditorView) => {
      expect(forceParsing(editor, editor.state.doc.length, 1000)).toBe(true);
      return syntaxTree(editor.state).toString();
    };
    const assertFresh = () => {
      const fresh = makeHandle(model.raw);
      try {
        expect(parsed(view)).toBe(parsed(viewOf(fresh.parent)));
        expect(
          [...parent.querySelectorAll('.fl-latex-atom')].some((node) =>
            node.textContent?.includes('article'),
          ),
        ).toBe(true);
      } finally {
        fresh.handle.destroy();
        fresh.parent.remove();
      }
    };
    try {
      assertFresh();
      const at = source.indexOf('article') + 'article'.length;
      view.dispatch({
        changes: { from: at, insert: 'x' },
        userEvent: 'input.type',
      });
      assertFresh();
      expect(handle.execCommand('undo')).toBe(true);
      expect(model.raw).toBe(source);
      assertFresh();
      expect(handle.execCommand('redo')).toBe(true);
      assertFresh();
    } finally {
      handle.destroy();
      parent.remove();
    }
  });

  it.each(['', '  '])(
    'ends standard verbatim before a trailing comment with %s spacing',
    (spacing) => {
      const source = `\\begin{verbatim}\n% $x$ \\fake\n\\end{verbatim}${spacing}% finished\n\\section{Real} $y$`;
      const { parent, handle } = makeHandle(source);
      try {
        expect(parent.querySelector('.fl-latex-literal')?.textContent).toBe(
          '% $x$ \\fake',
        );
        expect(parent.querySelector('.fl-latex-comment')?.textContent).toBe(
          '% finished',
        );
        expect(
          [...parent.querySelectorAll('.fl-latex-command')].some(
            (node) => node.textContent === '\\section',
          ),
        ).toBe(true);
        expect(
          [...parent.querySelectorAll('.fl-latex-math')]
            .map((node) => node.textContent)
            .join(''),
        ).toBe('$y$');
      } finally {
        handle.destroy();
        parent.remove();
      }
    },
  );

  it('preserves post-verbatim classification when typing a terminator comment and undo/redo', () => {
    const source =
      '\\begin{verbatim}\n% literal\n\\end{verbatim}\n\\section{Real} $y$';
    const { parent, handle } = makeHandle(source);
    try {
      const view = viewOf(parent);
      const snapshot = () => parent.querySelectorAll('.cm-line')[3]?.innerHTML;
      const before = snapshot();
      expect(before).toContain('fl-latex-command');
      const at = source.indexOf('\\end{verbatim}') + '\\end{verbatim}'.length;
      view.dispatch({
        changes: { from: at, insert: '% finished' },
        userEvent: 'input.type',
      });
      expect(snapshot()).toBe(before);
      expect(handle.execCommand('undo')).toBe(true);
      expect(snapshot()).toBe(before);
      expect(handle.execCommand('redo')).toBe(true);
      expect(snapshot()).toBe(before);
    } finally {
      handle.destroy();
      parent.remove();
    }
  });

  const cases = [
    ['command', '\\section{Title}', '\\section', 'command'],
    [
      'environment',
      '\\begin{itemize}\n\\item Text\n\\end{itemize}',
      'itemize',
      'atom',
    ],
    [
      'comment',
      '% $x$ \\section{ignored}',
      '% $x$ \\section{ignored}',
      'comment',
    ],
    ['inline math', 'Prose $x$ prose', 'x', 'math'],
    ['display math', '\\[x + 1\\]', 'x', 'math'],
    [
      'math environment',
      '\\begin{equation}\nx + 1\n\\end{equation}',
      'x',
      'math',
    ],
    [
      'verbatim',
      '\\begin{verbatim}\n% $x$ \\section{literal}\n\\end{verbatim}',
      '% $x$ \\section{literal}',
      'literal',
    ],
    ['inline verb', '\\verb|% $x$|', '|% $x$|', 'literal'],
  ] as const;

  it.each(cases)(
    'renders %s classification across edits and undo/redo',
    (_name, source, token, category) => {
      const { parent, handle, model } = makeHandle(source);
      const assertToken = () => {
        const spans = [...parent.querySelectorAll(`.fl-latex-${category}`)];
        expect(spans.some((span) => span.textContent?.includes(token))).toBe(
          true,
        );
      };
      try {
        assertToken();
        const view = viewOf(parent);
        view.dispatch({
          changes: { from: 0, insert: 'Intro\n' },
          userEvent: 'input.type',
        });
        assertToken();
        expect(handle.execCommand('undo')).toBe(true);
        expect(model.raw).toBe(source);
        assertToken();
        expect(handle.execCommand('redo')).toBe(true);
        assertToken();
      } finally {
        handle.destroy();
        parent.remove();
      }
    },
  );

  it.each([
    ['dollar', '$x\n\ny$\nprose', '$x\n\ny$', 'math'],
    ['display', '\\[x\n\ny\\]\nprose', '\\[x\n\ny\\]', 'math'],
    [
      'environment',
      '\\begin{align*}\nx\n\ny\n\\end{align*}\nprose',
      'y',
      'math',
    ],
    [
      'literal',
      '\\begin{verbatim}\n% x\n\nexample \\end{verbatim}\n$y$\n\\end{verbatim}\nprose',
      '$y$',
      'literal',
    ],
  ])(
    'retains %s state across blank lines and restores after boundary edits',
    (_name, source, _body, category) => {
      const { parent, handle, model } = makeHandle(source);
      try {
        const view = viewOf(parent);
        const snapshot = () =>
          [...parent.querySelectorAll('.cm-line')].map(
            (line) => line.innerHTML,
          );
        const original = snapshot();
        expect(parent.querySelector(`.fl-latex-${category}`)).not.toBeNull();
        expect(
          [...parent.querySelectorAll(`.fl-latex-${category}`)].some((node) =>
            node.textContent?.includes('y'),
          ),
        ).toBe(true);
        expect(
          [
            ...parent.querySelectorAll('.fl-latex-math, .fl-latex-literal'),
          ].some((node) => node.textContent?.includes('prose')),
        ).toBe(false);
        // Removing the opening delimiter must invalidate following lines, not
        // merely move the old token decorations. Undo restores the exact DOM.
        const firstLine = view.state.doc.line(1);
        view.dispatch({
          changes: { from: 0, to: firstLine.to },
          userEvent: 'delete',
        });
        expect(snapshot()).not.toEqual(original);
        expect(parent.querySelector('.fl-latex-literal')).toBeNull();
        expect(handle.execCommand('undo')).toBe(true);
        expect(model.raw).toBe(source);
        expect(snapshot()).toEqual(original);
      } finally {
        handle.destroy();
        parent.remove();
      }
    },
  );

  it.each([
    [
      'equation',
      '\\begin{equation}\nx + 1\n\\end{equation}\n\\section{Next}\n$y$',
    ],
    ['align*', '\\begin{align*}\nx\n\\end{align*}\n\\section{After} $y$'],
  ])(
    'exits %s math environment for following commands and inline math',
    (_env, source) => {
      const { parent, handle } = makeHandle(source);
      try {
        // Inside the environment stays math.
        expect(
          [...parent.querySelectorAll('.fl-latex-math')].some((node) =>
            node.textContent?.includes('x'),
          ),
        ).toBe(true);
        // Post-environment command exits math mode via the mathEnd===null gate.
        expect(
          [...parent.querySelectorAll('.fl-latex-command')].some(
            (node) => node.textContent === '\\section',
          ),
        ).toBe(true);
        // Post-environment title prose is not fed to stexMath.
        expect(
          [...parent.querySelectorAll('.fl-latex-math')].some(
            (node) =>
              node.textContent?.includes('Next') ||
              node.textContent?.includes('After'),
          ),
        ).toBe(false);
        // Post-environment $y$ delimiters re-enter math via the delimiter gate
        // (both $ delimiters carry math ink; via stexMath they would be error).
        expect(
          [...parent.querySelectorAll('.fl-latex-math')]
            .map((node) => node.textContent)
            .join(''),
        ).toContain('$y$');
        expect(
          [...parent.querySelectorAll('.fl-latex-math')]
            .map((node) => node.textContent)
            .filter((text) => text === '$'),
        ).toHaveLength(2);
      } finally {
        handle.destroy();
        parent.remove();
      }
    },
  );

  it('keeps commands and math inside inline verb literal and resumes on the same line', () => {
    const { parent, handle } = makeHandle(
      '\\verb*|% $x$ \\fake| \\section{Real} $y$',
    );
    try {
      expect(parent.querySelector('.fl-latex-literal')?.textContent).toBe(
        '|% $x$ \\fake|',
      );
      expect(parent.querySelector('.fl-latex-comment')).toBeNull();
      expect(
        [...parent.querySelectorAll('.fl-latex-command')].map(
          (node) => node.textContent,
        ),
      ).toEqual(['\\verb*', '\\section']);
      expect(
        [...parent.querySelectorAll('.fl-latex-math')]
          .map((node) => node.textContent)
          .join(''),
      ).toBe('$y$');
    } finally {
      handle.destroy();
      parent.remove();
    }
  });

  it('does not classify prose as math or escaped percent as a comment', () => {
    const { parent, handle } = makeHandle('Ordinary prose \\% safe');
    try {
      expect(parent.querySelector('.fl-latex-math')).toBeNull();
      expect(parent.querySelector('.fl-latex-comment')).toBeNull();
      expect(parent.querySelector('.fl-latex-command')?.textContent).toBe(
        '\\%',
      );
    } finally {
      handle.destroy();
      parent.remove();
    }
  });
});

describe('LaTeX typed Enter pairing', () => {
  it.each(['itemize', 'enumerate', 'quote', 'customEnvironment', 'align*'])(
    'isolates %s pairing from preceding and following typing; propagates model/dirty',
    (env) => {
      const parent = document.createElement('div');
      document.body.appendChild(parent);
      const { session, model, dirty } = makeSession('');
      const handle = new LatexDocumentEditorProvider(makeDeps()).createEditor({
        session,
        parent,
      });
      const view = viewOf(parent);
      try {
        const source = `\\begin{${env}}`;
        typeSource(view, source);
        expect(model.raw).toBe(source);
        const count = dirty.count;
        pressEnter(view);
        const paired = `${source}\n\n\\end{${env}}`;
        const caret = source.length + 1;
        expect(model.raw).toBe(paired);
        expect(dirty.count).toBe(count + 1);
        expect(view.state.selection.main.head).toBe(caret);
        expect(handle.execCommand('undo')).toBe(true);
        expect(model.raw).toBe(source);
        expect(view.state.selection.main.head).toBe(source.length);
        expect(dirty.count).toBe(count + 2);
        expect(handle.execCommand('redo')).toBe(true);
        expect(model.raw).toBe(paired);
        expect(view.state.selection.main.head).toBe(caret);
        typeSource(view, 'body');
        expect(handle.execCommand('undo')).toBe(true);
        expect(model.raw).toBe(paired);
        expect(view.state.selection.main.head).toBe(caret);
        expect(handle.execCommand('undo')).toBe(true);
        expect(model.raw).toBe(source);
        expect(view.state.selection.main.head).toBe(source.length);
        expect(handle.execCommand('undo')).toBe(true);
        expect(model.raw).toBe('');
      } finally {
        handle.destroy();
        parent.remove();
      }
    },
  );

  it.each(['  ', '\t', '\t  '])(
    'preserves leading indentation %j',
    (indent) => {
      const source = `${indent}\\begin{quote}`;
      const { parent, handle, model } = makeHandle(source + '\nafter');
      try {
        handle.setSelectionForTest(source.length);
        pressEnter(viewOf(parent));
        expect(model.raw).toBe(
          `${source}\n${indent}\n${indent}\\end{quote}\nafter`,
        );
        expect(handle.getSelectionForTest()).toEqual({
          from: source.length + 1 + indent.length,
          to: source.length + 1 + indent.length,
        });
      } finally {
        handle.destroy();
        parent.remove();
      }
    },
  );

  it.each([
    '% \\begin{quote}|',
    '\\\\begin{quote}|',
    '\\\\\\begin{quote}|',
    'text \\begin{quote}|',
    '\\begin{quote}| trailing',
    '\\begin{quo|te}',
    '\\begin{quote} |',
    '\\begin{quote} % comment|',
    '\\begin{quote}[option]|',
    '\\begin{bad name}|',
    '\\begin{\\macro}|',
    '\\begin{verbatim}\n\\begin{quote}|\n\\end{verbatim}',
    '\\begin{verbatim*}\n\\begin{quote}|',
    '\\begin{Verbatim}\n\\begin{quote}|',
    '\\begin{lstlisting}\n\\begin{quote}|',
    '\\begin{minted}{tex}\n\\begin{quote}|',
    '\\begin{comment}\n\\begin{quote}|',
    '\\begin{comment}\nexample \\end{comment}\n\\begin{quote}|',
    '\\begin{Verbatim}\nexample \\end{Verbatim}\n\\begin{quote}|',
    '\\begin{comment}\n\\end{comment} example\n\\begin{quote}|',
    '\\begin{Verbatim}\n\\end{Verbatim} example\n\\begin{quote}|',
    '\\begin{comment}\nexample \\end{comment}\n\\begin{quote}|\n\\end{comment}',
    '\\begin{Verbatim}\nexample \\end{Verbatim}\n\\begin{quote}|\n\\end{Verbatim}',
    '\\verb!\\begin{quote}|',
    '\\newcommand{\\foo}{\n\\begin{quote}|\n}',
    '\\catcode`!=0\n\\begin{quote}|',
    '\\begin{quote}|\n\\end{quote}',
    '\\begin{quote}|\n% comment\n\\end{quote}',
    '\\begin{quote}|\n\\begin{quote}\n\\end{quote}\n\\end{quote}',
    '\\begin{quote}|\n\\begin{itemize}\n\\end{itemize}\n\\end{quote}',
    '\\begin{quote}|\n\\end{itemize}',
    '\\begin{quote}|\n\\begin{unfinished}',
  ])('falls through to normal Enter for unsafe syntax %j', (marked) => {
    const caret = marked.indexOf('|');
    const source = marked.replace('|', '');
    const { parent, handle, model } = makeHandle(source);
    try {
      handle.setSelectionForTest(caret);
      pressEnter(viewOf(parent));
      expect(model.raw).toBe(
        source.slice(0, caret) +
          '\n' +
          source.slice(caret).replace(/^[ \t]+/, ''),
      );
    } finally {
      handle.destroy();
      parent.remove();
    }
  });

  it.each([
    ['% \\begin{verbatim}\n', ''],
    ['\\begin{verbatim}\nanything\n\\end{verbatim}\n', ''],
    ['\\begin{comment}\nexample \\end{comment}\n\\end{comment}\n', ''],
    ['\\begin{Verbatim}\nexample \\end{Verbatim}\n\\end{Verbatim}\n', ''],
    ['\\begin{Verbatim*}\nanything\n\\end{Verbatim*}\n', ''],
    ['\\verb!\\begin{verbatim}!\n', ''],
    ['', '\n% \\end{quote}'],
    ['', '\n\\\\end{quote}'],
    ['', '\n\\verb!\\end{quote}!'],
    ['', '\n\\begin{quote}\n\\end{quote}'],
    ['', '\n\\begin{itemize}\n\\end{itemize}'],
  ])(
    'ignores literal/comment ends and balances nested environments (%j, %j)',
    (prefix, suffix) => {
      const before = prefix + '\\begin{quote}';
      const { parent, handle, model } = makeHandle(before + suffix);
      try {
        handle.setSelectionForTest(before.length);
        pressEnter(viewOf(parent));
        expect(model.raw).toBe(before + '\n\n\\end{quote}' + suffix);
      } finally {
        handle.destroy();
        parent.remove();
      }
    },
  );

  it.each(['readOnly', 'composition', 'selection', 'multiple'])(
    'declines for %s',
    (guard) => {
      const source = 'first\n\\begin{quote}';
      const { parent, handle, model } = makeHandle(source);
      const view = viewOf(parent);
      try {
        handle.setSelectionForTest(source.length);
        if (guard === 'readOnly') {
          if (handle.setReadOnly === undefined)
            throw new Error('missing readOnly control');
          handle.setReadOnly(true);
        }
        if (guard === 'composition')
          vi.spyOn(view, 'composing', 'get').mockReturnValue(true);
        if (guard === 'selection')
          handle.setSelectionForTest(source.length - 1, source.length);
        if (guard === 'multiple') {
          view.dispatch({
            effects: StateEffect.appendConfig.of(
              EditorState.allowMultipleSelections.of(true),
            ),
          });
          view.dispatch({
            selection: EditorSelection.create(
              [
                EditorSelection.cursor(0),
                EditorSelection.cursor(source.length),
              ],
              1,
            ),
          });
        }
        pressEnter(view);
        expect(model.raw).not.toContain('\\end{quote}');
        if (guard === 'readOnly') expect(model.raw).toBe(source);
        if (guard === 'selection')
          expect(model.raw).toBe(source.slice(0, -1) + '\n');
        if (guard === 'multiple') expect(model.raw).toBe('\n' + source + '\n');
      } finally {
        vi.restoreAllMocks();
        handle.destroy();
        parent.remove();
      }
    },
  );

  it('does not assist on open, paste or ordinary input transactions', () => {
    const source = '\\begin{quote}';
    const { parent, handle, model } = makeHandle(source);
    try {
      expect(model.raw).toBe(source);
      const view = viewOf(parent);
      view.dispatch({
        changes: { from: 0, to: source.length, insert: source + '\n' },
        userEvent: 'input.paste',
      });
      expect(model.raw).toBe(source + '\n');
      handle.setSelectionForTest(model.raw.length);
      typeSource(view, '\\begin{itemize}\n');
      expect(model.raw).toBe(source + '\n\\begin{itemize}\n');
    } finally {
      handle.destroy();
      parent.remove();
    }
  });
});

describe('LatexDocumentEditorProvider (jsdom)', () => {
  it('pairs a standalone begin on actual Enter with one undoable source edit', () => {
    const source = '\\begin{itemize}';
    const { parent, handle, model } = makeHandle(source);
    try {
      handle.setSelectionForTest(source.length);
      handle.focus();
      const content = parent.querySelector('.cm-content');
      if (content === null) throw new Error('missing editor content');
      content.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          code: 'Enter',
          keyCode: 13,
          bubbles: true,
          cancelable: true,
        }),
      );
      const paired = source + '\n\n\\end{itemize}';
      expect(handle.getTextForTest()).toBe(paired);
      expect(model.raw).toBe(paired);
      expect(handle.getSelectionForTest()).toEqual({
        from: source.length + 1,
        to: source.length + 1,
      });
      expect(handle.execCommand('undo')).toBe(true);
      expect(handle.getTextForTest()).toBe(source);
      expect(handle.getSelectionForTest()).toEqual({
        from: source.length,
        to: source.length,
      });
      expect(handle.execCommand('redo')).toBe(true);
      expect(handle.getTextForTest()).toBe(paired);
    } finally {
      handle.destroy();
      parent.remove();
    }
  });

  it('mounts a source-only editor with no preview iframe or permanent status chrome', async () => {
    const { parent, handle, model } = makeHandle('\\section{One}\nalpha\n');

    expect(parent.querySelector('iframe')).toBeNull();
    expect(parent.querySelector('.cm-editor')).not.toBeNull();
    expect(parent.querySelector('.froglight-latex-source')).not.toBeNull();
    // Diagnostics live in the unified toolbar; edit mode keeps no permanent
    // provider-owned status strip (latex-toolbar-spec completion gate).
    expect(parent.querySelector('.froglight-latex-status')).toBeNull();
    expect(parent.querySelector('.froglight-latex-diagnostics')).toBeNull();
    expect(handle.execCommand('undo')).toBe(false);
    handle.destroy();
    expect(parent.querySelector('.cm-editor')).toBeNull();
    void model;
    parent.remove();
  });

  it('exposes the semantic source toolset without editor/renderer internals', () => {
    const { parent, handle } = makeHandle('\\section{One}\n');
    const snapshot = snapshotOf(handle);
    // Accessible metadata only; never a persistent visible `LaTeX source`
    // label in the toolbar.
    expect(snapshot.context).toBe('LaTeX');
    expect(snapshot.context).not.toBe('LaTeX source');
    const ids = snapshot.controls.map((control) => control.id);
    expect(ids).toEqual([
      'latex.structure',
      'latex.bold',
      'latex.emphasis',
      'latex.inline-math',
      'latex.display-math',
      'latex.environment.itemize',
      'latex.environment.enumerate',
      'latex.environment.quote',
      'latex.label',
      'latex.ref',
      'latex.cite',
      'latex.diagnostics',
    ]);
    const kinds = new Map(
      snapshot.controls.map((control) => [control.id, control.kind]),
    );
    expect(kinds.get('latex.structure')).toBe('choice');
    expect(kinds.get('latex.bold')).toBe('button');
    expect(kinds.get('latex.emphasis')).toBe('button');
    expect(kinds.get('latex.inline-math')).toBe('button');
    expect(kinds.get('latex.display-math')).toBe('button');
    expect(kinds.get('latex.environment.itemize')).toBe('button');
    expect(kinds.get('latex.label')).toBe('input');
    expect(kinds.get('latex.ref')).toBe('input');
    expect(kinds.get('latex.cite')).toBe('input');
    expect(kinds.get('latex.diagnostics')).toBe('diagnostics');
    // Plain data only: no rendered HTML, iframe, resolver, or CodeMirror
    // selection crosses the seam.
    expect(JSON.stringify(snapshot)).not.toContain('cm-');
    expect(JSON.stringify(snapshot)).not.toContain('iframe');
    expect(JSON.stringify(snapshot)).not.toContain('__cm');
    handle.destroy();
    parent.remove();
  });

  it('routes portable Writing controls through the shared builder', () => {
    const { parent, handle } = makeHandle('\\section{One}\n');
    const byId = new Map(
      snapshotOf(handle).controls.map((control) => [control.id, control]),
    );
    // Production-wired proof: the real snapshot deep-equals the shared
    // builder output, so the UI composition specs may use faithful doubles
    // without importing this provider package (layer direction). Any
    // hand-edit divergence here fails loudly.
    expect(byId.get('latex.bold')).toEqual(
      writingFormatToggleControl('latex.bold', 'bold', {}),
    );
    expect(byId.get('latex.emphasis')).toEqual(
      writingFormatToggleControl(
        'latex.emphasis',
        'italic',
        {},
        { label: 'Emphasis' },
      ),
    );
    const structure = byId.get('latex.structure');
    const expectedStyle: DocumentToolControl = {
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
    };
    expect(structure).toEqual(expectedStyle);
    handle.destroy();
    parent.remove();
  });

  it('pushes edits into the session model and refreshes diagnostics without mutating canonical bytes', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const { session, model, dirty } = makeSession('\\section{One}\nalpha\n');
    const before = model.raw;
    const provider = new LatexDocumentEditorProvider(makeDeps());
    const handle = provider.createEditor({
      session,
      parent,
    }) as LatexTestHandle;

    handle.replaceTextForTest('\\section{One}\nalphaX\n');
    expect(model.raw).toContain('alphaX');

    await flush();
    await flush();
    expect(dirty.count).toBeGreaterThan(0);
    const diagnostics = diagnosticsOf(handle);
    expect(diagnostics.state).toBe('clean');
    expect(diagnostics.label).toContain('no issues');
    // Diagnostics refresh is derived state only.
    expect(model.raw).toBe('\\section{One}\nalphaX\n');
    expect(model.raw).not.toBe(before);
    handle.destroy();
    parent.remove();
  });

  it('inserts section structure with placeholder selection when empty', () => {
    const { parent, handle } = makeHandle('hello\n');
    handle.setSelectionForTest(0);
    expect(execute(handle, 'latex.structure', 'section')).toBe(true);
    expect(handle.getTextForTest()).toBe('\\section{Title}hello\n');
    // Placeholder title selected for immediate typing.
    expect(handle.getSelectionForTest()).toEqual({ from: 9, to: 14 });
    handle.destroy();
    parent.remove();
  });

  it('uses the selection as the section title when present', () => {
    const { parent, handle } = makeHandle('Intro\n');
    handle.setSelectionForTest(0, 5);
    expect(execute(handle, 'latex.structure', 'subsection')).toBe(true);
    expect(handle.getTextForTest()).toBe('\\subsection{Intro}\n');
    expect(handle.getSelectionForTest()).toEqual({ from: 12, to: 17 });
    handle.destroy();
    parent.remove();
  });

  it('inserts a paragraph heading and direct quotation environment', () => {
    const { parent, handle } = makeHandle('Title');
    handle.setSelectionForTest(0, 5);
    expect(execute(handle, 'latex.structure', 'paragraph')).toBe(true);
    expect(handle.getTextForTest()).toBe('\\paragraph{Title}');
    handle.setSelectionForTest(handle.getTextForTest().length);
    expect(execute(handle, 'latex.environment.quote')).toBe(true);
    expect(handle.getTextForTest()).toContain(
      '\\begin{quote}\nQuoted text\n\\end{quote}',
    );
    handle.destroy();
    parent.remove();
  });

  it('rejects unknown structure values without mutating source', () => {
    const { parent, handle } = makeHandle('alpha\n');
    const before = handle.getTextForTest();
    expect(execute(handle, 'latex.structure', 'chapter')).toBe(false);
    expect(execute(handle, 'latex.structure', '')).toBe(false);
    expect(execute(handle, 'latex.structure')).toBe(false);
    expect(handle.getTextForTest()).toBe(before);
    handle.destroy();
    parent.remove();
  });

  it('wraps selections with emphasis helpers and inserts skeletons when empty', () => {
    const { parent, handle } = makeHandle('hello world\n');
    // Bold wraps exactly the intended range.
    handle.setSelectionForTest(0, 5);
    expect(execute(handle, 'latex.bold')).toBe(true);
    expect(handle.getTextForTest()).toBe('\\textbf{hello} world\n');
    expect(handle.getSelectionForTest()).toEqual({ from: 8, to: 13 });

    // Emphasis with no selection inserts a skeleton with caret placement.
    handle.setSelectionForTest(handle.getTextForTest().length);
    expect(execute(handle, 'latex.emphasis')).toBe(true);
    expect(handle.getTextForTest()).toContain('\\emph{text}');
    handle.destroy();
    parent.remove();
  });

  it('inserts portable inline and display math', () => {
    const { parent, handle } = makeHandle('a\n');
    handle.setSelectionForTest(0, 1);
    expect(execute(handle, 'latex.inline-math')).toBe(true);
    expect(handle.getTextForTest()).toBe('$a$\n');

    handle.setSelectionForTest(0, 3);
    expect(execute(handle, 'latex.display-math')).toBe(true);
    expect(handle.getTextForTest()).toBe('\\[$a$\\]\n');
    handle.destroy();
    parent.remove();
  });

  it('inserts supported environments without touching surrounding macros', () => {
    const { parent, handle } = makeHandle(
      '\\usepackage{amsmath}\n\\mymacro{keep}\nbody\n',
    );
    const text = handle.getTextForTest();
    handle.setSelectionForTest(text.length);
    expect(execute(handle, 'latex.environment.itemize')).toBe(true);
    const next = handle.getTextForTest();
    expect(next).toContain('\\begin{itemize}\n\\item Item\n\\end{itemize}');
    // Unknown packages/macros outside the explicit range preserved exactly.
    expect(next).toContain('\\usepackage{amsmath}');
    expect(next).toContain('\\mymacro{keep}');

    expect(execute(handle, 'latex.environment.table')).toBe(false);
    handle.destroy();
    parent.remove();
  });

  it('inserts label, reference, and citation keys with validation', () => {
    const { parent, handle } = makeHandle('see here\n');
    handle.setSelectionForTest(8);
    expect(execute(handle, 'latex.label', 'sec:intro')).toBe(true);
    expect(handle.getTextForTest()).toContain('\\label{sec:intro}');
    expect(execute(handle, 'latex.ref', 'sec:intro')).toBe(true);
    expect(handle.getTextForTest()).toContain('\\ref{sec:intro}');
    expect(execute(handle, 'latex.cite', 'doe2024,smith2023')).toBe(true);
    expect(handle.getTextForTest()).toContain('\\cite{doe2024,smith2023}');

    // Empty, whitespace, and brace/escape values never mutate source.
    const before = handle.getTextForTest();
    expect(execute(handle, 'latex.label', '')).toBe(false);
    expect(execute(handle, 'latex.label', '  ')).toBe(false);
    expect(execute(handle, 'latex.label', 'a b')).toBe(false);
    expect(execute(handle, 'latex.ref', 'a{b')).toBe(false);
    expect(execute(handle, 'latex.cite', 'doe2024,')).toBe(false);
    expect(execute(handle, 'latex.cite')).toBe(false);
    expect(handle.getTextForTest()).toBe(before);
    handle.destroy();
    parent.remove();
  });

  it('validates citation and label keys without editor state', () => {
    expect(isValidLatexKey('sec:intro')).toBe(true);
    expect(isValidLatexKey('')).toBe(false);
    expect(isValidLatexKey('a b')).toBe(false);
    expect(isValidLatexKey('a{b')).toBe(false);
    expect(normalizeLatexCiteKeys('doe2024, smith2023')).toBe(
      'doe2024,smith2023',
    );
    expect(normalizeLatexCiteKeys('doe2024,')).toBeNull();
    expect(normalizeLatexCiteKeys('')).toBeNull();
  });

  it('preserves unknown surrounding content when toolbar edits apply', () => {
    const { parent, handle } = makeHandle(
      '% comment\n\\usepackage{weird}\n\\weirdmacro{a}{b}\nhello\n',
    );
    handle.setSelectionForTest(handle.getTextForTest().length - 1 - 5 + 0, 0);
    // Select `hello` deterministically.
    const text = handle.getTextForTest();
    const start = text.indexOf('hello');
    handle.setSelectionForTest(start, start + 5);
    expect(execute(handle, 'latex.bold')).toBe(true);
    const next = handle.getTextForTest();
    expect(next).toContain('% comment');
    expect(next).toContain('\\usepackage{weird}');
    expect(next).toContain('\\weirdmacro{a}{b}');
    expect(next).toContain('\\textbf{hello}');
    handle.destroy();
    parent.remove();
  });

  it('participates in provider-local undo and redo like typed edits', () => {
    const { parent, handle } = makeHandle('alpha\n');
    handle.setSelectionForTest(0, 5);
    expect(execute(handle, 'latex.bold')).toBe(true);
    expect(handle.getTextForTest()).toBe('\\textbf{alpha}\n');
    expect(handle.execCommand('undo')).toBe(true);
    expect(handle.getTextForTest()).toBe('alpha\n');
    expect(handle.execCommand('redo')).toBe(true);
    expect(handle.getTextForTest()).toBe('\\textbf{alpha}\n');
    handle.destroy();
    parent.remove();
  });

  it('reports clean diagnostics after analysis', async () => {
    const { parent, handle } = makeHandle('\\section{One}\n');
    await flush();
    await flush();
    const diagnostics = diagnosticsOf(handle);
    expect(diagnostics.state).toBe('clean');
    expect(diagnostics.errorCount).toBe(0);
    expect(diagnostics.noteCount).toBe(0);
    expect(diagnostics.entries).toEqual([]);
    expect(diagnostics.label).toContain('no issues');
    handle.destroy();
    parent.remove();
  });

  it('reports notes separately from errors', async () => {
    const { parent, handle } = makeHandle('\\section{One}\n', {
      latexProvider: () =>
        new MockLaTeXProvider({
          html: '',
          diagnostics: [
            { code: 'LATEX_INFO', message: 'a note', path: 'document.tex' },
          ],
        }),
    });
    await flush();
    await flush();
    const diagnostics = diagnosticsOf(handle);
    expect(diagnostics.state).toBe('notes');
    expect(diagnostics.errorCount).toBe(0);
    expect(diagnostics.noteCount).toBe(1);
    expect(diagnostics.entries).toHaveLength(1);
    expect(diagnostics.entries[0]!.navigable).toBe(false);
    handle.destroy();
    parent.remove();
  });

  it('reports unsupported-command errors with navigable entries', async () => {
    const { parent, handle } = makeHandle('\\foobar{x}\n', {
      latexProvider: () =>
        new MockLaTeXProvider({
          html: '',
          diagnostics: [
            {
              code: 'LATEX_UNSUPPORTED_COMMAND',
              message: 'unknown macro: \\foobar',
              path: 'document.tex',
              line: 0,
            },
          ],
        }),
    });
    await flush();
    await flush();
    const diagnostics = diagnosticsOf(handle);
    expect(diagnostics.state).toBe('errors');
    expect(diagnostics.errorCount).toBe(1);
    expect(diagnostics.label).toContain('1 issue');
    expect(diagnostics.entries).toHaveLength(1);
    expect(diagnostics.entries[0]).toMatchObject({
      id: '0',
      code: 'LATEX_UNSUPPORTED_COMMAND',
      line: 0,
      navigable: true,
    });
    handle.destroy();
    parent.remove();
  });

  it('jumps to the source line for navigable diagnostics', async () => {
    const { parent, handle } = makeHandle('line one\nline two\nline three\n', {
      latexProvider: () =>
        new MockLaTeXProvider({
          html: '',
          diagnostics: [
            {
              code: 'LATEX_UNSUPPORTED_COMMAND',
              message: 'unknown macro on line three',
              path: 'document.tex',
              line: 2,
            },
          ],
        }),
    });
    await flush();
    await flush();
    expect(execute(handle, 'latex.diagnostics', '0')).toBe(true);
    const selection = handle.getSelectionForTest();
    const text = handle.getTextForTest();
    const expected = text.indexOf('line three');
    expect(selection.from).toBe(expected);
    // Non-navigable values never move the editor.
    expect(execute(handle, 'latex.diagnostics', '99')).toBe(false);
    expect(execute(handle, 'latex.diagnostics')).toBe(false);
    handle.destroy();
    parent.remove();
  });

  it('marks diagnostics from other files as non-navigable', async () => {
    const { parent, handle } = makeHandle('\\input{other}\n', {
      latexProvider: () =>
        new MockLaTeXProvider({
          html: '',
          diagnostics: [
            {
              code: 'LATEX_PARSE_ERROR',
              message: 'broken include',
              path: 'chapters/other.tex',
              line: 4,
            },
          ],
        }),
    });
    await flush();
    await flush();
    const diagnostics = diagnosticsOf(handle);
    expect(diagnostics.state).toBe('errors');
    expect(diagnostics.entries[0]!.navigable).toBe(false);
    expect(execute(handle, 'latex.diagnostics', '0')).toBe(false);
    handle.destroy();
    parent.remove();
  });

  it('reports provider-unavailable distinctly from clean while keeping source commands usable', async () => {
    const { parent, handle } = makeHandle('\\section{One}\n', {
      latexProvider: () => null,
    });
    await flush();
    await flush();
    const diagnostics = diagnosticsOf(handle);
    expect(diagnostics.state).toBe('unavailable');
    expect(diagnostics.label).toContain('unavailable');
    expect(diagnostics.entries).toHaveLength(1);
    expect(diagnostics.entries[0]!.navigable).toBe(false);
    // Rendering is optional: source authoring still works offline.
    handle.setSelectionForTest(0, 0);
    expect(execute(handle, 'latex.bold')).toBe(true);
    expect(handle.getTextForTest()).toContain('\\textbf{text}');
    handle.destroy();
    parent.remove();
  });

  it('reports analysis failure distinctly without mutating source', async () => {
    const { parent, handle } = makeHandle('\\section{One}\n', {
      latexProvider: () =>
        new MockLaTeXProvider({
          html: '',
          renderErrorCode: 'LATEX_PARSE_ERROR',
        }),
    });
    const before = handle.getTextForTest();
    await flush();
    await flush();
    const diagnostics = diagnosticsOf(handle);
    expect(diagnostics.state).toBe('failed');
    expect(handle.getTextForTest()).toBe(before);
    handle.destroy();
    parent.remove();
  });

  it('notifies toolbar listeners when diagnostics refresh', async () => {
    const { parent, handle } = makeHandle('\\section{One}\n');
    const tools = handle.tools;
    if (tools === undefined) throw new Error('missing tools');
    let count = 0;
    const sub = tools.onDidChange(() => {
      count += 1;
    });
    await flush();
    await flush();
    expect(count).toBeGreaterThan(0);
    sub.dispose();
    handle.destroy();
    parent.remove();
  });

  it('registers no compile-to-PDF or bibliography-formatting actions', () => {
    const { parent, handle } = makeHandle('\\section{One}\n');
    const ids = snapshotOf(handle).controls.map((control) => control.id);
    for (const id of ids) {
      expect(id).not.toMatch(/compile|pdf|export|bibliography|bibtex/i);
    }
    expect(execute(handle, 'latex.compile-pdf')).toBe(false);
    expect(execute(handle, 'latex.export-pdf')).toBe(false);
    expect(execute(handle, 'latex.bibliography')).toBe(false);
    handle.destroy();
    parent.remove();
  });

  it('marks writing format toggles as toggle activationRole', () => {
    const { parent, handle } = makeHandle('\\section{One}\n');
    try {
      const snapshot = snapshotOf(handle);
      for (const id of ['latex.bold', 'latex.emphasis']) {
        const control = snapshot.controls.find((c) => c.id === id);
        if (control?.kind !== 'button') throw new Error(`missing button ${id}`);
        expect(control.activationRole).toBe('toggle');
      }
    } finally {
      handle.destroy();
      parent.remove();
    }
  });

  it('keeps kind binding to the latex document kind', () => {
    const provider = new LatexDocumentEditorProvider(makeDeps());
    expect(provider.id).toBe('latex');
    expect(provider.kindIds).toEqual([latexKindId]);
  });
});

it('names the LaTeX source textbox for assistive technology', () => {
  const { parent, handle } = makeHandle('Hello');
  try {
    expect(
      parent
        .querySelector('.cm-content[role="textbox"]')
        ?.getAttribute('aria-label'),
    ).toBe('LaTeX source');
  } finally {
    handle.destroy();
    parent.remove();
  }
});

describe('LaTeX revealAddress accepts extractor slug addresses', () => {
  // Extractor parity: plain-text slugs, markdown-style -1/-2 dedup,
  // section-<line> fallback for empty slugs, empty titles skipped.
  const SOURCE = [
    '\\section{Introduction}',
    'Content one.',
    '\\section{Introduction}',
    'Content two.',
    '\\section{Methods & Materials}',
    'Content three.',
    '\\section{$$$}',
    'Odd.',
  ].join('\n');

  function lineStartOf(text: string, line: number): number {
    return (
      text.split('\n').slice(0, line).join('\n').length + (line === 0 ? 0 : 1)
    );
  }

  it('scrolls to the first section for a bare slug', () => {
    const { parent, handle } = makeHandle(SOURCE);
    try {
      handle.revealAddress?.('introduction');
      const text = handle.getTextForTest();
      expect(handle.getSelectionForTest()).toEqual({
        from: lineStartOf(text, 0),
        to: lineStartOf(text, 0),
      });
    } finally {
      handle.destroy();
      parent.remove();
    }
  });

  it('resolves duplicate titles deterministically per dedup order', () => {
    const { parent, handle } = makeHandle(SOURCE);
    try {
      const text = handle.getTextForTest();
      handle.revealAddress?.('introduction');
      expect(handle.getSelectionForTest().from).toBe(lineStartOf(text, 0));
      handle.revealAddress?.('introduction-1');
      expect(handle.getSelectionForTest().from).toBe(lineStartOf(text, 2));
    } finally {
      handle.destroy();
      parent.remove();
    }
  });

  it('resolves slugs with punctuation and the section-<line> fallback', () => {
    const { parent, handle } = makeHandle(SOURCE);
    try {
      const text = handle.getTextForTest();
      handle.revealAddress?.('methods-materials');
      expect(handle.getSelectionForTest().from).toBe(lineStartOf(text, 4));
      // `\section{$$$}` has an empty slug, so the extractor falls back to
      // `section-<line>` (line 6 here).
      handle.revealAddress?.('section-6');
      expect(handle.getSelectionForTest().from).toBe(lineStartOf(text, 6));
    } finally {
      handle.destroy();
      parent.remove();
    }
  });

  it('resolves an exact-title address to the first matching section', () => {
    const { parent, handle } = makeHandle(SOURCE);
    try {
      const text = handle.getTextForTest();
      handle.revealAddress?.('Introduction');
      expect(handle.getSelectionForTest().from).toBe(lineStartOf(text, 0));
    } finally {
      handle.destroy();
      parent.remove();
    }
  });

  it('reaches every row of suffix-colliding titles at its own line', () => {
    const source = [
      '\\section{Hello}',
      'one.',
      '\\section{Hello}',
      'two.',
      '\\section{Hello-1}',
      'three.',
    ].join('\n');
    const { parent, handle } = makeHandle(source);
    try {
      const text = handle.getTextForTest();
      handle.revealAddress?.('hello');
      expect(handle.getSelectionForTest().from).toBe(lineStartOf(text, 0));
      handle.revealAddress?.('hello-1');
      expect(handle.getSelectionForTest().from).toBe(lineStartOf(text, 2));
      handle.revealAddress?.('hello-1-1');
      expect(handle.getSelectionForTest().from).toBe(lineStartOf(text, 4));
      // Unknown suffixes still miss silently without moving the caret.
      handle.setSelectionForTest(5);
      const before = handle.getSelectionForTest();
      expect(() => handle.revealAddress?.('hello-1-2')).not.toThrow();
      expect(handle.getSelectionForTest()).toEqual(before);
    } finally {
      handle.destroy();
      parent.remove();
    }
  });

  it('keeps section-<line> fallbacks globally unique against real slugs (round-trip)', () => {
    // Mirrors the extractor fixture: `\section{$$$}` on line 1 falls back to
    // `section-1`, so the real `\section{Section-1}` on line 2 takes
    // `section-1-1`. Both rows stay reachable at distinct lines.
    const source = [
      '\\section{Hello}',
      '\\section{$$$}',
      '\\section{Section-1}',
    ].join('\n');
    expect(resolveLatexAddress(source, 'hello')).toMatchObject({
      title: 'Hello',
      line: 0,
    });
    expect(resolveLatexAddress(source, 'section-1')).toMatchObject({
      title: '$$$',
      line: 1,
    });
    expect(resolveLatexAddress(source, 'section-1-1')).toMatchObject({
      title: 'Section-1',
      line: 2,
    });
    expect(resolveLatexAddress(source, 'section-1-2')).toBeNull();
    const { parent, handle } = makeHandle(source);
    try {
      const text = handle.getTextForTest();
      handle.revealAddress?.('section-1');
      expect(handle.getSelectionForTest().from).toBe(lineStartOf(text, 1));
      handle.revealAddress?.('section-1-1');
      expect(handle.getSelectionForTest().from).toBe(lineStartOf(text, 2));
      expect(handle.getSelectionForTest().from).not.toBe(lineStartOf(text, 1));
    } finally {
      handle.destroy();
      parent.remove();
    }
  });

  it('treats commented-out sections as unknown: resolver null + silent no-op', () => {
    const source = ['% \\section{Ghost}', '\\section{Real}', 'body'].join('\n');
    // The extractor excludes Ghost by comment masking; the resolver must too.
    expect(resolveLatexAddress(source, 'Ghost')).toBeNull();
    expect(resolveLatexAddress(source, 'ghost')).toBeNull();
    expect(resolveLatexAddress(source, 'real')).toMatchObject({
      title: 'Real',
      line: 1,
    });
    const { parent, handle } = makeHandle(source);
    try {
      handle.setSelectionForTest(0);
      const before = handle.getSelectionForTest();
      expect(() => handle.revealAddress?.('Ghost')).not.toThrow();
      expect(() => handle.revealAddress?.('ghost')).not.toThrow();
      expect(handle.getSelectionForTest()).toEqual(before);
      // Sanity: the live row still reveals.
      const text = handle.getTextForTest();
      handle.revealAddress?.('real');
      expect(handle.getSelectionForTest().from).toBe(lineStartOf(text, 1));
    } finally {
      handle.destroy();
      parent.remove();
    }
  });

  it('treats unknown addresses as a silent no-op that never throws', () => {
    const { parent, handle } = makeHandle(SOURCE);
    try {
      handle.setSelectionForTest(5);
      const before = handle.getSelectionForTest();
      expect(() => handle.revealAddress?.('no-such-section')).not.toThrow();
      expect(() => handle.revealAddress?.('')).not.toThrow();
      expect(() => handle.revealAddress?.('introduction-2')).not.toThrow();
      expect(handle.getSelectionForTest()).toEqual(before);
    } finally {
      handle.destroy();
      parent.remove();
    }
  });
});

describe('diagnostics scheduling invalidates pending generations', () => {
  for (const outcome of ['success', 'failure'] as const) {
    it(`ignores old ${outcome} during debounce before newer analysis starts`, async () => {
      vi.useFakeTimers();
      let resolve!: (result: LaTeXRenderResult) => void;
      let reject!: (error: Error) => void;
      const old = new Promise<LaTeXRenderResult>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      let opens = 0;
      const provider: LaTeXProvider = {
        async open() {
          opens++;
          const current = opens;
          return {
            render: () =>
              current === 1
                ? old
                : Promise.resolve({ html: '', diagnostics: [] }),
            close: async () => undefined,
          };
        },
      };
      const { parent, handle, model } = makeHandle('source A', {
        latexProvider: () => provider,
        renderDebounceMillis: 100,
      });
      try {
        await vi.advanceTimersByTimeAsync(100);
        expect(opens).toBe(1);
        handle.replaceTextForTest('source B');
        expect(diagnosticsOf(handle).state).toBe('pending');
        if (outcome === 'success') resolve({ html: '', diagnostics: [] });
        else reject(new Error('obsolete failure from A'));
        await vi.advanceTimersByTimeAsync(0);
        expect(opens).toBe(1);
        expect(diagnosticsOf(handle).state).toBe('pending');
        expect(diagnosticsOf(handle).entries).toEqual([]);
        expect(model.raw).toBe('source B');
        await vi.advanceTimersByTimeAsync(100);
        expect(opens).toBe(2);
        expect(diagnosticsOf(handle).state).toBe('clean');
      } finally {
        handle.destroy();
        parent.remove();
        vi.useRealTimers();
      }
    });
  }
});
