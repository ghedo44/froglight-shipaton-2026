/**
 * Low-level TeX text scanning helpers shared by the structure parser and the
 * flattener. Pure string processing: no editor, DOM, or provider types.
 *
 * Offsets always refer to the string given to the scanner. Callers mask
 * comments first (`maskTeXComments`) so offsets stay aligned with the
 * original raw text.
 */

/**
 * Return a same-length copy of `raw` where unescaped `%` comments are
 * replaced with spaces. Length and line structure are preserved so every
 * offset in the masked text maps 1:1 back to the original.
 */
export function maskTeXComments(raw: string): string {
  let out = '';
  let comment = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (ch === '\n') {
      comment = false;
      out += ch;
      continue;
    }
    if (comment) {
      out += ' ';
      continue;
    }
    if (ch === '\\') {
      // Escaped character: copy both; `\%` is a literal percent.
      const next = raw[i + 1] ?? '';
      out += ch + next;
      i += 1;
      continue;
    }
    if (ch === '%') {
      comment = true;
      out += ' ';
      continue;
    }
    out += comment ? ' ' : ch;
  }
  return out;
}

/**
 * Starting at `start` (which must point at `{`), walk a brace-balanced group
 * while honoring `\{`/`\}` escapes. Returns the index just past the matching
 * `}`, or -1 when unbalanced before end of text.
 */
export function scanBraceGroup(text: string, start: number): number {
  if (text[start] !== '{') return -1;
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/**
 * Scan a `[...]` optional argument starting at `start`. Returns the index
 * just past the closing `]`, or -1 when absent/unbalanced. Nested brackets
 * are not tracked (LaTeX optional args rarely nest); escaped brackets are.
 */
export function scanOptionalArg(text: string, start: number): number {
  if (text[start] !== '[') return -1;
  for (let i = start + 1; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === ']') return i + 1;
  }
  return -1;
}

/**
 * Extract the first brace-balanced argument of a command whose match ends at
 * `matchEnd`, skipping any `[...]` optional arguments between them. Returns
 * the argument content (without braces) plus the index just past the closing
 * brace, or null when no group follows.
 */
export function readCommandArgument(
  text: string,
  matchEnd: number,
): { readonly arg: string; readonly end: number } | null {
  let i = matchEnd;
  // Skip whitespace and optional arguments.
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i += 1;
  while (text[i] === '[') {
    const end = scanOptionalArg(text, i);
    if (end === -1) return null;
    i = end;
    while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i += 1;
  }
  if (text[i] !== '{') return null;
  const groupEnd = scanBraceGroup(text, i);
  if (groupEnd === -1) return null;
  return { arg: text.slice(i + 1, groupEnd - 1), end: groupEnd };
}

/** Zero-based line number of character offset `offset` in `text`. */
export function lineOfOffset(text: string, offset: number): number {
  let line = 0;
  for (let i = 0; i < offset && i < text.length; i += 1) {
    if (text[i] === '\n') line += 1;
  }
  return line;
}

/**
 * Reduce a LaTeX fragment to plain display text: strip control sequences
 * (keeping nothing of their names) and drop brace grouping characters.
 * Used for metadata titles/author display only — never for canonical data.
 */
export function latexToPlainText(fragment: string): string {
  let out = '';
  for (let i = 0; i < fragment.length; i += 1) {
    const ch = fragment[i]!;
    if (ch === '\\') {
      // Skip the command name (letters) or the escaped single char.
      const next = fragment[i + 1] ?? '';
      if (/[a-zA-Z]/.test(next)) {
        i += 1;
        while (i + 1 < fragment.length && /[a-zA-Z]/.test(fragment[i + 1]!)) i += 1;
      } else {
        i += 1;
        out += next === '%' || next === '&' || next === '#' || next === '_' || next === '{' || next === '}' ? next : '';
      }
      continue;
    }
    if (ch === '{' || ch === '}') continue;
    if (ch === '~') {
      out += ' ';
      continue;
    }
    out += ch;
  }
  return out.replace(/\s+/g, ' ').trim();
}
