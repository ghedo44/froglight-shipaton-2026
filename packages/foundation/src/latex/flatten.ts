/**
 * LaTeX flattener: single-string expansion for providers whose API takes one
 * source text.
 *
 * Pure, provider-independent machinery. Expands `\input`/`\include` against a
 * Froglight-owned `readFile`, tracks an output-line provenance map, enforces
 * cycle/depth/size limits as visible diagnostics (never silent truncation),
 * and rewrites known-missing macros into honest placeholders:
 *
 * - `\cite{keys}` → `[key1, key2]` text (citations are parsed, not formatted);
 * - `\bibliography{files}` → provenance comment + diagnostic (formatting deferred);
 * - `thebibliography`/`\bibitem` → `description`-list approximation;
 * - `\graphicspath` → stripped (the initial provider's grammar crashes on it);
 * - `\newcommand`/`\renewcommand`/`\providecommand`/`\def` → neutralized with
 *   an unsupported-macro diagnostic (no TeX macro expansion is implemented).
 *
 * Invariant: `maskTeXComments` preserves string length exactly, so every
 * index computed on masked text is valid on the real text.
 */

import { LATEX_LIMITS, type LaTeXDiagnostic, type LaTeXSourceMapping } from './contracts.js';
import { latexDirOf, latexEnsureTexExtension, latexEnsureBibExtension, latexRelativeJoinPath } from './resolve.js';
import { maskTeXComments, readCommandArgument, scanBraceGroup, scanOptionalArg } from './tex-scan.js';

export interface FlattenResult {
  readonly source: string;
  /** One entry per output line (0-based). */
  readonly lineMap: readonly LaTeXSourceMapping[];
  readonly diagnostics: readonly LaTeXDiagnostic[];
  /** Citation keys in first-appearance order. */
  readonly citations: readonly string[];
  /** Resolved workspace paths of expanded `\input`/`\include` files. */
  readonly includedFiles: readonly string[];
  /** Resolved workspace paths of `\bibliography` targets. */
  readonly bibliographyFiles: readonly string[];
}

export interface FlattenInput {
  /** Workspace path of the entry document (for relative resolution only). */
  readonly entryPath: string;
  readonly entrySource: string;
  readonly readFile: (path: string) => Promise<string>;
  readonly limits?: Partial<{
    maxIncludeDepth: number;
    maxFileBytes: number;
    maxFlattenedBytes: number;
  }>;
}

const CITE_PATTERN = /\\(?:cite|citep|citet|Citep|Citet|autocite|textcite|parencite)(?![a-zA-Z])/g;
const INPUT_PATTERN = /\\(input|include)(?![a-zA-Z])/;

class Flattener {
  readonly #outLines: string[] = [];
  readonly #lineMap: LaTeXSourceMapping[] = [];
  readonly #diagnostics: LaTeXDiagnostic[] = [];
  readonly #citations: string[] = [];
  readonly #includedFiles: string[] = [];
  readonly #bibliographyFiles: string[] = [];
  readonly #active = new Set<string>();
  readonly #readFile: (path: string) => Promise<string>;
  readonly #limits: FlattenInput['limits'];
  #totalChars = 0;
  #totalLimitReported = false;

  constructor(readFile: (path: string) => Promise<string>, limits: FlattenInput['limits']) {
    this.#readFile = readFile;
    this.#limits = limits;
  }

  flatten(input: FlattenInput): Promise<FlattenResult> {
    this.#active.add(input.entryPath);
    return this.#processFile(input.entryPath, input.entrySource, 0).then(() => ({
      source: this.#outLines.join('\n'),
      lineMap: this.#lineMap,
      diagnostics: this.#diagnostics,
      citations: [...this.#citations],
      includedFiles: [...this.#includedFiles],
      bibliographyFiles: [...this.#bibliographyFiles],
    }));
  }

  #diag(directive: LaTeXDiagnostic): void {
    this.#diagnostics.push(directive);
  }

  #push(line: string, path: string, sourceLine: number): void {
    this.#outLines.push(line);
    this.#lineMap.push({ outputLine: this.#outLines.length - 1, path, sourceLine });
    this.#totalChars += line.length + 1;
  }

  #placeholderComment(message: string, path: string, sourceLine: number): void {
    this.#push(`% froglight: ${message}`, path, sourceLine);
  }

  async #processFile(path: string, source: string, depth: number): Promise<void> {
    const maxFileBytes = this.#limits?.maxFileBytes ?? LATEX_LIMITS.maxFileBytes;
    if (new TextEncoder().encode(source).byteLength > maxFileBytes) {
      this.#diag({
        code: 'LATEX_RESOURCE_LIMIT',
        message: `file exceeds the ${maxFileBytes}-byte include limit`,
        path,
      });
      return;
    }

    const lines = source.split('\n');
    const maskedLines = maskTeXComments(source).split('\n');

    let i = 0;
    while (i < lines.length) {
      const maskedLine = maskedLines[i]!;
      if (INPUT_PATTERN.test(maskedLine)) {
        i = await this.#expandInclude(lines, maskedLines, i, path, depth);
        continue;
      }
      if (/\\graphicspath(?![a-zA-Z])/.test(maskedLine)) {
        this.#diag({
          code: 'LATEX_UNSUPPORTED_COMMAND',
          message: '\\graphicspath is not supported by the active preview provider; images resolve relative to the document',
          path,
          line: i,
        });
        this.#placeholderComment('\\graphicspath removed', path, i);
        i += 1;
        continue;
      }
      const definition = /\\(newcommand|renewcommand|providecommand|def)(?![a-zA-Z])/.exec(maskedLine);
      if (definition !== null) {
        i = this.#neutralizeDefinition(lines, maskedLines, i, path, definition[1]!);
        continue;
      }
      if (/\\bibliography(?![a-zA-Z])/.test(maskedLine)) {
        i = this.#rewriteBibliographyCommand(lines, maskedLines, i, path);
        continue;
      }
      if (/\\begin\{thebibliography\}/.test(maskedLine)) {
        i = this.#rewriteTheBibliography(lines, maskedLines, i, path);
        continue;
      }
      if (CITE_PATTERN.test(maskedLine)) {
        this.#push(this.#rewriteCiteLine(lines[i]!, maskedLine), path, i);
        i += 1;
        continue;
      }
      this.#push(lines[i]!, path, i);
      i += 1;
    }
  }

  async #expandInclude(
    lines: string[],
    maskedLines: string[],
    startLine: number,
    fromPath: string,
    depth: number,
  ): Promise<number> {
    const maskedLine = maskedLines[startLine]!;
    const match = INPUT_PATTERN.exec(maskedLine);
    const arg = match !== null ? readCommandArgument(maskedLine, match.index + match[0].length) : null;
    const rawRef = arg?.arg.trim() ?? '';
    const kind = match?.[1] === 'include' ? 'include' : 'input';
    if (arg === null || rawRef === '') {
      // Unclosed brace across lines or empty argument: pass through untouched.
      this.#push(lines[startLine]!, fromPath, startLine);
      return startLine + 1;
    }

    const maxDepth = this.#limits?.maxIncludeDepth ?? LATEX_LIMITS.maxIncludeDepth;
    if (depth + 1 > maxDepth) {
      this.#diag({
        code: 'LATEX_RESOURCE_LIMIT',
        message: `include depth exceeds the ${maxDepth}-level limit at \\${kind}{${rawRef}}`,
        path: fromPath,
        line: startLine,
      });
      this.#placeholderComment(`include depth limit reached (${rawRef})`, fromPath, startLine);
      return startLine + 1;
    }

    let resolved: string;
    try {
      resolved = latexEnsureTexExtension(latexRelativeJoinPath(latexDirOf(fromPath), rawRef));
    } catch (error) {
      this.#diag({
        code: 'LATEX_RESOLVE_DENIED',
        message: error instanceof Error ? error.message : 'include reference denied',
        path: fromPath,
        line: startLine,
      });
      this.#placeholderComment(`include refused (${rawRef})`, fromPath, startLine);
      return startLine + 1;
    }

    if (this.#active.has(resolved)) {
      this.#diag({
        code: 'LATEX_CYCLE',
        message: `cyclic include detected: ${resolved}`,
        path: fromPath,
        line: startLine,
      });
      this.#placeholderComment(`cyclic include removed (${resolved})`, fromPath, startLine);
      return startLine + 1;
    }

    let content: string;
    try {
      content = await this.#readFile(resolved);
    } catch (error) {
      const code = (error as { code?: string }).code;
      this.#diag({
        code: code === 'LATEX_RESOLVE_DENIED' ? 'LATEX_RESOLVE_DENIED' : 'LATEX_RESOLVE_MISSING',
        message: `include target unavailable: ${resolved}`,
        path: fromPath,
        line: startLine,
      });
      this.#placeholderComment(`include unavailable (${resolved})`, fromPath, startLine);
      return startLine + 1;
    }

    // Total-size accounting happens once the content is known: refusing an
    // include is a visible diagnostic, never silent truncation.
    const maxTotal = this.#limits?.maxFlattenedBytes ?? LATEX_LIMITS.maxFlattenedBytes;
    if (this.#totalLimitReported || this.#totalChars + content.length > maxTotal) {
      if (!this.#totalLimitReported) {
        this.#totalLimitReported = true;
        this.#diag({
          code: 'LATEX_RESOURCE_LIMIT',
          message: `flattened source would exceed the ${maxTotal}-byte limit; further includes are refused`,
          path: fromPath,
          line: startLine,
        });
      }
      this.#placeholderComment(`include refused (flattened size limit): ${resolved}`, fromPath, startLine);
      return startLine + 1;
    }

    this.#includedFiles.push(resolved);
    this.#active.add(resolved);
    await this.#processFile(resolved, content, depth + 1);
    this.#active.delete(resolved);
    return startLine + 1;
  }

  /**
   * Drop a macro definition (possibly spanning lines) and report it. The
   * definition shape is `\newcommand{\name}[n][default]{body}` or
   * `\def\name{body}`.
   */
  #neutralizeDefinition(
    lines: string[],
    maskedLines: string[],
    startLine: number,
    path: string,
    macro: string,
  ): number {
    const isDef = macro === 'def';
    let combined = '';
    let endLine = startLine;
    let completed = -1;
    while (endLine < lines.length) {
      combined += maskedLines[endLine];
      if (endLine + 1 < lines.length) combined += '\n';
      endLine += 1;
      const done = isDef ? this.#definitionEndForDef(combined) : this.#definitionEndForNewcommand(combined);
      if (done !== null) {
        completed = done;
        break;
      }
    }
    if (completed === null || completed < 0) {
      this.#diag({
        code: 'LATEX_PARSE_ERROR',
        message: `\\${macro} definition is not terminated`,
        path,
        line: startLine,
      });
      return lines.length;
    }
    this.#diag({
      code: 'LATEX_UNSUPPORTED_COMMAND',
      message: `\\${macro} custom macros are not supported by the active preview provider`,
      path,
      line: startLine,
    });
    this.#placeholderComment(`\\${macro} definition removed`, path, startLine);
    return endLine;
  }

  /** Returns the combined-text offset past the definition, or null if incomplete. */
  #definitionEndForNewcommand(text: string): number | null {
    const match = /\\(?:newcommand|renewcommand|providecommand)(?![a-zA-Z])/.exec(text);
    if (match === null) return null;
    let cursor = match.index + match[0].length;
    // Name group.
    let group = readCommandArgument(text, cursor);
    if (group === null) return -1;
    cursor = group.end;
    // Optional [n] and [default].
    for (let i = 0; i < 2; i += 1) {
      let probe = cursor;
      while (probe < text.length && (text[probe] === ' ' || text[probe] === '\t')) probe += 1;
      if (text[probe] !== '[') break;
      const optionalEnd = scanOptionalArg(text, probe);
      if (optionalEnd === -1) return -1;
      cursor = optionalEnd;
    }
    // Body group.
    group = readCommandArgument(text, cursor);
    if (group === null) return -1;
    return group.end;
  }

  /** `\def\name{body}` — returns the offset past the body group, or null/-1. */
  #definitionEndForDef(text: string): number | null {
    const match = /\\def(?![a-zA-Z])/.exec(text);
    if (match === null) return null;
    let cursor = match.index + match[0].length;
    while (cursor < text.length && (text[cursor] === ' ' || text[cursor] === '\t')) cursor += 1;
    if (text[cursor] !== '\\') return -1;
    cursor += 1;
    while (cursor < text.length && /[a-zA-Z]/.test(text[cursor]!)) cursor += 1;
    const group = readCommandArgument(text, cursor);
    if (group === null) return -1;
    return group.end;
  }

  #rewriteBibliographyCommand(lines: string[], maskedLines: string[], startLine: number, path: string): number {
    const maskedLine = maskedLines[startLine]!;
    const match = /\\bibliography(?![a-zA-Z])/.exec(maskedLine);
    const arg = match !== null ? readCommandArgument(maskedLine, match.index + match[0].length) : null;
    if (arg !== null) {
      for (const file of arg.arg.split(',')) {
        const ref = file.trim();
        if (ref === '') continue;
        try {
          this.#bibliographyFiles.push(latexEnsureBibExtension(latexRelativeJoinPath(latexDirOf(path), ref)));
        } catch (error) {
          this.#diag({
            code: 'LATEX_RESOLVE_DENIED',
            message: error instanceof Error ? error.message : 'bibliography reference denied',
            path,
            line: startLine,
          });
        }
      }
    }
    this.#diag({
      code: 'LATEX_INFO',
      message: 'bibliography formatting is not available in this preview; citations render as placeholder labels',
      path,
      line: startLine,
    });
    this.#placeholderComment(`\\bibliography removed (${arg?.arg.trim() ?? ''})`, path, startLine);
    void lines;
    return startLine + 1;
  }

  #rewriteTheBibliography(lines: string[], maskedLines: string[], startLine: number, path: string): number {
    this.#diag({
      code: 'LATEX_INFO',
      message: 'thebibliography is approximated as a labeled list by the active preview provider',
      path,
      line: startLine,
    });
    this.#push('\\begin{description}', path, startLine);
    let i = startLine + 1;
    while (i < lines.length) {
      const maskedLine = maskedLines[i]!;
      if (/\\end\{thebibliography\}/.test(maskedLine)) {
        this.#push('\\end{description}', path, i);
        return i + 1;
      }
      const bibitem = /\\bibitem(?![a-zA-Z])/.exec(maskedLine);
      if (bibitem !== null) {
        let labelStart = bibitem.index + bibitem[0].length;
        const optional = scanOptionalArg(maskedLine, labelStart);
        if (optional !== -1) labelStart = optional;
        while (maskedLine[labelStart] === ' ') labelStart += 1;
        const groupEnd = scanBraceGroup(maskedLine, labelStart);
        const label = groupEnd !== -1 ? maskedLine.slice(labelStart + 1, groupEnd - 1).trim() : '';
        const rest = groupEnd !== -1 ? lines[i]!.slice(groupEnd) : '';
        this.#push(`\\item[${label || 'cite'}]${rest}`, path, i);
        i += 1;
        continue;
      }
      if (CITE_PATTERN.test(maskedLine)) {
        this.#push(this.#rewriteCiteLine(lines[i]!, maskedLine), path, i);
        i += 1;
        continue;
      }
      this.#push(lines[i]!, path, i);
      i += 1;
    }
    this.#diag({
      code: 'LATEX_PARSE_ERROR',
      message: 'thebibliography environment is not terminated',
      path,
      line: startLine,
    });
    this.#push('\\end{description}', path, startLine);
    return i;
  }

  /** Rewrite `\cite{...}` occurrences on one line into `[keys]` placeholders. */
  #rewriteCiteLine(realLine: string, maskedLine: string): string {
    const pattern = new RegExp(CITE_PATTERN.source, 'g');
    let out = '';
    let cursor = 0;
    let match = pattern.exec(maskedLine);
    while (match !== null) {
      const arg = readCommandArgument(maskedLine, match.index + match[0].length);
      if (arg === null) {
        // Unclosed argument: keep the remainder verbatim.
        break;
      }
      const keys = arg.arg
        .split(',')
        .map((key) => key.trim())
        .filter((key) => key !== '');
      for (const key of keys) {
        if (!this.#citations.includes(key)) this.#citations.push(key);
      }
      out += realLine.slice(cursor, match.index);
      out += `[${keys.join(', ')}]`;
      cursor = arg.end;
      pattern.lastIndex = arg.end;
      match = pattern.exec(maskedLine);
    }
    if (cursor === 0 && out === '') return realLine;
    out += realLine.slice(cursor);
    return out;
  }
}

/** Flatten entry source plus includes into single-string provider input. */
export async function flattenLaTeX(input: FlattenInput): Promise<FlattenResult> {
  const flattener = new Flattener(input.readFile, input.limits);
  return flattener.flatten(input);
}

/**
 * Substitute workspace asset paths inside `\includegraphics{...}` arguments
 * with preview-host-loadable URLs. Same-line replacements keep the flattener's
 * line map valid. Failures become diagnostics; the path is left untouched.
 */
export async function applyLaTeXAssetUrls(
  source: string,
  assetUrl: (path: string) => Promise<string>,
): Promise<{ source: string; diagnostics: LaTeXDiagnostic[] }> {
  const masked = maskTeXComments(source);
  const pattern = /\\includegraphics(?![a-zA-Z])/g;
  const diagnostics: LaTeXDiagnostic[] = [];
  let out = '';
  let cursor = 0;
  let match = pattern.exec(masked);
  while (match !== null) {
    const arg = readCommandArgument(masked, match.index + match[0].length);
    if (arg === null) {
      pattern.lastIndex = match.index + match[0].length;
      match = pattern.exec(masked);
      continue;
    }
    const path = arg.arg.trim();
    if (path === '') {
      pattern.lastIndex = arg.end;
      match = pattern.exec(masked);
      continue;
    }
    let url: string;
    try {
      url = await assetUrl(path);
    } catch (error) {
      const code = (error as { code?: string }).code;
      diagnostics.push({
        code: code === 'LATEX_RESOLVE_DENIED' ? 'LATEX_RESOLVE_DENIED' : 'LATEX_RESOLVE_MISSING',
        message: `asset unavailable: ${path}`,
        line: masked.slice(0, match.index).split('\n').length - 1,
      });
      pattern.lastIndex = arg.end;
      match = pattern.exec(masked);
      continue;
    }
    out += source.slice(cursor, arg.end - 1 - path.length);
    out += url;
    out += '}';
    cursor = arg.end;
    pattern.lastIndex = arg.end;
    match = pattern.exec(masked);
  }
  if (cursor === 0) return { source, diagnostics };
  out += source.slice(cursor);
  return { source: out, diagnostics };
}
