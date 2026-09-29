import {
  StreamLanguage,
  syntaxHighlighting,
  languageDataProp,
  type StreamParser,
} from '@codemirror/language';
import { stex, stexMath } from '@codemirror/legacy-modes/mode/stex';

interface SourceState {
  text: unknown;
  math: unknown;
  mathEnd: string | null;
  literal: string | null;
  inlineLiteral: boolean;
  environment: { name: string; closing: boolean } | null;
}

const literalEnvironment =
  /^(?:verbatim|Verbatim|BVerbatim|LVerbatim|SaveVerbatim|lstlisting|minted|alltt|comment|filecontents)\*?$/;
const mathEnvironment =
  /^(?:math|displaymath|equation|align|alignat|flalign|gather|multline|eqnarray)\*?$/;

/** stex's shallow stack copy otherwise shares mutable bracketNo/argument records
 * with CM parser checkpoints. Methods use `this`; retain their descriptors and
 * prototypes while isolating each record. Immutable style tables stay shared.
 */
function copyTextState(state: unknown): unknown {
  const copy = stex.copyState?.(state) as { cmdState: object[] };
  copy.cmdState = copy.cmdState.map((command) =>
    Object.create(
      Object.getPrototypeOf(command),
      Object.getOwnPropertyDescriptors(command),
    ),
  );
  return copy;
}

/**
 * Compatibility shim, not a TeX parser. Installed stex handles ordinary
 * commands/arguments/comments, but has no literal or math-environment state.
 * Only those boundaries are added here; macros/catcode changes are not expanded.
 * Delimited math stays active across blank lines. Literal environment ends
 * must occupy a line (standard verbatim may have a trailing comment), so
 * example commands inside a body remain literal.
 */
const sourceParser: StreamParser<SourceState> = {
  name: 'latex-source',
  languageData: stex.languageData,
  startState: (indent) => ({
    text: stex.startState?.(indent),
    math: stexMath.startState?.(indent),
    mathEnd: null,
    literal: null,
    inlineLiteral: false,
    environment: null,
  }),
  copyState: (state) => ({
    ...state,
    text: copyTextState(state.text),
    math: stexMath.copyState?.(state.math),
  }),
  blankLine: (state, indent) => {
    if (state.literal === null && state.mathEnd === null)
      stex.blankLine?.(state.text, indent);
  },
  token: (stream, state) => {
    if (state.literal !== null) {
      const line = stream.string.trim();
      const end = `\\end{${state.literal}}`;
      const standardVerbatim = /^verbatim\*?$/.test(state.literal);
      const endsLiteral = line === end || (
        standardVerbatim && line.startsWith(end) &&
        /^[ \t]*%/.test(line.slice(end.length))
      );
      if (stream.sol() && endsLiteral) {
        state.literal = null;
        if (stream.eatSpace()) return null;
      } else {
        stream.skipToEnd();
        return 'string';
      }
    }
    if (state.inlineLiteral) {
      state.inlineLiteral = false;
      const delimiter = stream.next();
      if (delimiter !== undefined && delimiter !== null) {
        while (!stream.eol() && stream.next() !== delimiter) {
          /* literal */
        }
      }
      return 'string';
    }
    if (state.environment !== null) {
      const { name, closing } = state.environment;
      state.environment = null;
      stream.match(`{${name}}`);
      if (!closing && literalEnvironment.test(name)) state.literal = name;
      if (!closing && mathEnvironment.test(name))
        state.mathEnd = `\\end{${name}}`;
      if (closing && state.mathEnd === `\\end{${name}}`) state.mathEnd = null;
      return 'atom';
    }
    if (state.mathEnd !== null && stream.match(state.mathEnd, false)) {
      const end = state.mathEnd;
      state.mathEnd = null;
      if (!end.startsWith('\\end')) {
        stream.match(end);
        return 'keyword';
      }
    }
    const environment = /^\\(begin|end)\{([A-Za-z]+\*?)\}/.exec(
      stream.string.slice(stream.pos),
    );
    if (environment !== null) {
      const name = environment[2];
      if (name !== undefined) {
        stream.match(`\\${environment[1]}`);
        state.environment = { name, closing: environment[1] === 'end' };
        return 'tag';
      }
    }
    if (stream.match(/^\\verb\*?(?=[^A-Za-z\s])/, false)) {
      stream.match(/^\\verb\*?/);
      state.inlineLiteral = !stream.eol();
      return 'tag';
    }
    if (state.mathEnd === null) {
      for (const [open, close] of [
        ['\\[', '\\]'],
        ['\\(', '\\)'],
        ['$$', '$$'],
        ['$', '$'],
      ] as const) {
        if (stream.match(open)) {
          state.mathEnd = close;
          return 'keyword';
        }
      }
      return stex.token(stream, state.text);
    }
    return stexMath.token(stream, state.math);
  },
};

const language = StreamLanguage.define(sourceParser);

// Keep classes and their theme-token CSS local to this provider. The public
// tag names let this adapter use CM's highlighter without another dependency.
const classes: Readonly<Record<string, string>> = {
  tagName: 'fl-latex-command',
  atom: 'fl-latex-atom',
  comment: 'fl-latex-comment',
  keyword: 'fl-latex-math',
  'special(variableName)': 'fl-latex-math',
  number: 'fl-latex-math',
  string: 'fl-latex-literal',
  bracket: 'fl-latex-bracket',
};

export const latexHighlighting = [
  language,
  syntaxHighlighting({
    scope: (type) => type.prop(languageDataProp) === language.data,
    style: (tags) => {
      const names = tags.flatMap((tag) => classes[tag.toString()] ?? []);
      return names.length > 0 ? names.join(' ') : null;
    },
  }),
];
