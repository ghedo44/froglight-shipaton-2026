import { describe, expect, it } from 'vitest';
import { extractLaTeXStructure } from './structure.js';

describe('extractLaTeXStructure', () => {
  it('extracts document class, title, author, and sections with zero-based lines', () => {
    const raw = [
      '\\documentclass{article}',
      '\\title{My Notes}',
      '\\author{Ada}',
      '\\begin{document}',
      '\\maketitle',
      '\\section{First}',
      'text',
      '\\subsection{Deep}',
      'more',
      '\\section*{Starred}',
      '\\end{document}',
    ].join('\n');
    const structure = extractLaTeXStructure(raw);
    expect(structure.documentClass).toBe('article');
    expect(structure.title).toBe('My Notes');
    expect(structure.author).toBe('Ada');
    expect(structure.hasBody).toBe(true);
    expect(structure.sections).toEqual([
      { level: 1, title: 'First', line: 5, starred: false },
      { level: 2, title: 'Deep', line: 7, starred: false },
      { level: 1, title: 'Starred', line: 9, starred: true },
    ]);
  });

  it('extracts labels, citations, includes, graphics, and bibliography targets', () => {
    const raw = [
      '\\documentclass{article}',
      '\\usepackage{graphicx,hyperref}',
      '\\bibliographystyle{plain}',
      '\\begin{document}',
      '\\label{sec:intro}',
      'See \\cite{knuth84, lamport94} and \\citep{texbook}.',
      '\\input{chapters/one}',
      '\\include{chapters/two}',
      '\\includegraphics[width=5cm]{fig.png}',
      '\\bibliography{refs, more-refs}',
      '\\end{document}',
    ].join('\n');
    const structure = extractLaTeXStructure(raw);
    expect(structure.labels).toEqual([{ name: 'sec:intro', line: 4 }]);
    expect(structure.citations).toEqual([
      { keys: ['knuth84', 'lamport94'], line: 5 },
      { keys: ['texbook'], line: 5 },
    ]);
    expect(structure.includes).toEqual([
      { path: 'chapters/one', kind: 'input', line: 6 },
      { path: 'chapters/two', kind: 'include', line: 7 },
    ]);
    expect(structure.graphics).toEqual([{ path: 'fig.png', line: 8 }]);
    expect(structure.packages).toEqual(['graphicx', 'hyperref']);
    expect(structure.bibliographies).toEqual([
      { files: ['refs', 'more-refs'], line: 9, style: 'plain' },
    ]);
  });

  it('ignores commented-out commands but preserves line positions', () => {
    const raw = [
      '\\documentclass{article}',
      '% \\section{Ghost}',
      '\\begin{document}',
      '100\\% sure \\cite{real}',
      '\\end{document}',
    ].join('\n');
    const structure = extractLaTeXStructure(raw);
    expect(structure.sections).toEqual([]);
    expect(structure.citations).toEqual([{ keys: ['real'], line: 3 }]);
  });

  it('handles multi-line titles and tolerates unterminated arguments', () => {
    const raw = [
      '\\documentclass{article}',
      '\\title{A Very',
      'Long Title}',
      '\\begin{document}',
      '\\section{Broken',
      '\\end{document}',
    ].join('\n');
    const structure = extractLaTeXStructure(raw);
    expect(structure.title).toBe('A Very Long Title');
    // Unterminated section argument contributes no section.
    expect(structure.sections).toEqual([]);
  });

  it('does not confuse \\include with \\includegraphics', () => {
    const raw = [
      '\\documentclass{article}',
      '\\begin{document}',
      '\\includegraphics{pic.png}',
      '\\end{document}',
    ].join('\n');
    const structure = extractLaTeXStructure(raw);
    expect(structure.includes).toEqual([]);
    expect(structure.graphics).toEqual([{ path: 'pic.png', line: 2 }]);
  });
});
