/**
 * Structure extraction for LaTeX.
 *
 * Provider-independent, host-free parsing of the constructs Froglight needs
 * for metadata, search anchors, relationships, and outline navigation:
 * sectioning, labels, citations, includes, graphics, bibliography targets,
 * packages, and document class. Line numbers are zero-based and refer to the
 * raw source.
 */

import {
  lineOfOffset,
  maskTeXComments,
  latexToPlainText,
  readCommandArgument,
} from './tex-scan.js';

export interface LaTeXSection {
  /** section=1, subsection=2, subsubsection=3, paragraph=4. */
  readonly level: number;
  readonly title: string;
  readonly line: number;
  readonly starred: boolean;
}

export interface LaTeXLabel {
  readonly name: string;
  readonly line: number;
}

export interface LaTeXCitation {
  readonly keys: readonly string[];
  readonly line: number;
}

export interface LaTeXInclude {
  readonly path: string;
  readonly kind: 'input' | 'include';
  readonly line: number;
}

export interface LaTeXGraphic {
  readonly path: string;
  readonly line: number;
}

export interface LaTeXBibliography {
  readonly files: readonly string[];
  readonly line: number;
  readonly style?: string;
}

export interface LaTeXStructure {
  readonly documentClass?: string;
  readonly title?: string;
  readonly author?: string;
  readonly sections: readonly LaTeXSection[];
  readonly labels: readonly LaTeXLabel[];
  readonly citations: readonly LaTeXCitation[];
  readonly includes: readonly LaTeXInclude[];
  readonly graphics: readonly LaTeXGraphic[];
  readonly bibliographies: readonly LaTeXBibliography[];
  readonly packages: readonly string[];
  readonly hasBody: boolean;
}

const SECTION_LEVELS: Record<string, number> = {
  part: 0,
  chapter: 0,
  section: 1,
  subsection: 2,
  subsubsection: 3,
  paragraph: 4,
  subparagraph: 5,
};

interface CommandHit {
  readonly name: string;
  readonly matchEnd: number;
}

function scanCommand(text: string, pattern: RegExp, callback: (hit: CommandHit) => void): void {
  pattern.lastIndex = 0;
  let match = pattern.exec(text);
  while (match !== null) {
    callback({ name: match[0], matchEnd: match.index + match[0].length });
    match = pattern.exec(text);
  }
}

/** Extract normalized structure from raw LaTeX source. Never throws on odd input. */
export function extractLaTeXStructure(raw: string): LaTeXStructure {
  const masked = maskTeXComments(raw);

  let documentClass: string | undefined;
  scanCommand(masked, /\\documentclass(?![a-zA-Z])/g, (hit) => {
    if (documentClass !== undefined) return;
    const arg = readCommandArgument(masked, hit.matchEnd);
    if (arg !== null) documentClass = arg.arg.trim();
  });

  let title: string | undefined;
  scanCommand(masked, /\\title(?![a-zA-Z])/g, (hit) => {
    if (title !== undefined) return;
    const arg = readCommandArgument(masked, hit.matchEnd);
    if (arg !== null) {
      const text = latexToPlainText(arg.arg);
      if (text !== '') title = text;
    }
  });

  let author: string | undefined;
  scanCommand(masked, /\\author(?![a-zA-Z])/g, (hit) => {
    if (author !== undefined) return;
    const arg = readCommandArgument(masked, hit.matchEnd);
    if (arg !== null) {
      const text = latexToPlainText(arg.arg);
      if (text !== '') author = text;
    }
  });

  const sections: LaTeXSection[] = [];
  scanCommand(masked, /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)(\*)?(?![a-zA-Z])/g, (hit) => {
    const m = /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)(\*)?$/.exec(hit.name);
    if (m === null) return;
    const name = m[1]!;
    const arg = readCommandArgument(masked, hit.matchEnd);
    if (arg === null) return;
    const heading = latexToPlainText(arg.arg);
    sections.push({
      level: SECTION_LEVELS[name] ?? 9,
      title: heading,
      line: lineOfOffset(raw, hit.matchEnd - 1),
      starred: m[2] === '*',
    });
  });

  const labels: LaTeXLabel[] = [];
  scanCommand(masked, /\\label(?![a-zA-Z])/g, (hit) => {
    const arg = readCommandArgument(masked, hit.matchEnd);
    if (arg === null) return;
    const name = arg.arg.trim();
    if (name !== '') labels.push({ name, line: lineOfOffset(raw, hit.matchEnd - 1) });
  });

  const citations: LaTeXCitation[] = [];
  scanCommand(masked, /\\(?:cite|citep|citet|Citep|Citet|autocite|textcite|parencite)(?![a-zA-Z])/g, (hit) => {
    const arg = readCommandArgument(masked, hit.matchEnd);
    if (arg === null) return;
    const keys = arg.arg
      .split(',')
      .map((key) => key.trim())
      .filter((key) => key !== '');
    if (keys.length > 0) {
      citations.push({ keys, line: lineOfOffset(raw, hit.matchEnd - 1) });
    }
  });

  const includes: LaTeXInclude[] = [];
  scanCommand(masked, /\\(input|include)(?![a-zA-Z])/g, (hit) => {
    const m = /\\(input|include)$/.exec(hit.name);
    if (m === null) return;
    const arg = readCommandArgument(masked, hit.matchEnd);
    if (arg === null) return;
    const path = arg.arg.trim();
    if (path !== '') {
      includes.push({
        path,
        kind: m[1] === 'include' ? 'include' : 'input',
        line: lineOfOffset(raw, hit.matchEnd - 1),
      });
    }
  });

  const graphics: LaTeXGraphic[] = [];
  scanCommand(masked, /\\includegraphics(?![a-zA-Z])/g, (hit) => {
    const arg = readCommandArgument(masked, hit.matchEnd);
    if (arg === null) return;
    const path = arg.arg.trim();
    if (path !== '') graphics.push({ path, line: lineOfOffset(raw, hit.matchEnd - 1) });
  });

  const bibliographies: LaTeXBibliography[] = [];
  let bibliographyStyle: string | undefined;
  scanCommand(masked, /\\bibliographystyle(?![a-zA-Z])/g, (hit) => {
    if (bibliographyStyle !== undefined) return;
    const arg = readCommandArgument(masked, hit.matchEnd);
    if (arg === null) return;
    const style = arg.arg.trim();
    if (style !== '') bibliographyStyle = style;
  });
  scanCommand(masked, /\\bibliography(?![a-zA-Z])/g, (hit) => {
    const arg = readCommandArgument(masked, hit.matchEnd);
    if (arg === null) return;
    const files = arg.arg
      .split(',')
      .map((file) => file.trim())
      .filter((file) => file !== '');
    if (files.length === 0) return;
    bibliographies.push({
      files,
      line: lineOfOffset(raw, hit.matchEnd - 1),
      ...(bibliographyStyle !== undefined ? { style: bibliographyStyle } : {}),
    });
  });

  const packages: string[] = [];
  scanCommand(masked, /\\usepackage(?![a-zA-Z])/g, (hit) => {
    const arg = readCommandArgument(masked, hit.matchEnd);
    if (arg === null) return;
    for (const name of arg.arg.split(',')) {
      const trimmed = name.trim();
      if (trimmed !== '' && !packages.includes(trimmed)) packages.push(trimmed);
    }
  });

  const hasBody = /\\begin\{document\}/.test(masked);

  return {
    ...(documentClass !== undefined ? { documentClass } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(author !== undefined ? { author } : {}),
    sections,
    labels,
    citations,
    includes,
    graphics,
    bibliographies,
    packages,
    hasBody,
  };
}
