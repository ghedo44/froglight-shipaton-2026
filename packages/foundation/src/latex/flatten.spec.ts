import { describe, expect, it } from 'vitest';
import { flattenLaTeX, applyLaTeXAssetUrls } from './flatten.js';
import type { FlattenInput } from './flatten.js';

function makeVault(files: Record<string, string>) {
  return async (path: string): Promise<string> => {
    const hit = files[path];
    if (hit === undefined) {
      const error = new Error(`not found: ${path}`) as Error & { code: string };
      error.code = 'NOT_FOUND';
      throw error;
    }
    return hit;
  };
}

function flatten(files: Record<string, string>, entryPath = 'main.tex', overrides?: Partial<FlattenInput>) {
  return flattenLaTeX({
    entryPath,
    entrySource: files[entryPath]!,
    readFile: makeVault(files),
    ...overrides,
  });
}

describe('flattenLaTeX', () => {
  it('expands \\input and \\include recursively with a provenance line map', async () => {
    const result = await flatten({
      'main.tex': ['\\documentclass{article}', '\\begin{document}', '\\input{chapters/one}', '\\include{chapters/two}', '\\end{document}'].join('\n'),
      'chapters/one.tex': 'chapter one',
      'chapters/two.tex': 'chapter two',
    });
    expect(result.source).toContain('chapter one');
    expect(result.source).toContain('chapter two');
    expect(result.includedFiles).toEqual(['chapters/one.tex', 'chapters/two.tex']);
    // Provenance: the "chapter one" output line maps into chapters/one.tex line 0.
    const oneIndex = result.source.split('\n').findIndex((line) => line === 'chapter one');
    expect(result.lineMap[oneIndex]).toEqual({ outputLine: oneIndex, path: 'chapters/one.tex', sourceLine: 0 });
    const twoIndex = result.source.split('\n').findIndex((line) => line === 'chapter two');
    expect(result.lineMap[twoIndex]).toEqual({ outputLine: twoIndex, path: 'chapters/two.tex', sourceLine: 0 });
  });

  it('reports missing includes as diagnostics with a placeholder, never throwing', async () => {
    const result = await flatten({
      'main.tex': '\\begin{document}\n\\input{ghost}\n\\end{document}',
    });
    expect(result.source).toContain('% froglight: include unavailable');
    expect(result.diagnostics.some((d) => d.code === 'LATEX_RESOLVE_MISSING' && d.line === 1)).toBe(true);
  });

  it('detects cycles and terminates with a diagnostic', async () => {
    const result = await flatten({
      'main.tex': '\\begin{document}\n\\input{a}\n\\end{document}',
      'a.tex': 'A\n\\input{b}',
      'b.tex': 'B\n\\input{a}',
    });
    expect(result.source).toContain('A');
    expect(result.source).toContain('B');
    expect(result.source).toContain('% froglight: cyclic include removed');
    expect(result.diagnostics.some((d) => d.code === 'LATEX_CYCLE')).toBe(true);
    // Non-cyclic repeat inclusion is legal: the same file may appear twice.
    const repeated = await flatten({
      'main.tex': '\\input{a}\n\\input{a}',
      'a.tex': 'X',
    });
    expect(repeated.source.split('\n').filter((line) => line === 'X')).toHaveLength(2);
    expect(repeated.diagnostics).toEqual([]);
  });

  it('defers workspace-root enforcement to the resolver: escape attempts reach readFile and its denial is reported', async () => {
    // The flattener passes '..'-prefixed references through to readFile;
    // the vault-backed resolver (application layer) rejects what escapes
    // the real workspace. Simulate that resolver here.
    const readFile = async (path: string): Promise<string> => {
      if (path.startsWith('..')) {
        const error = new Error('denied') as Error & { code: string };
        error.code = 'LATEX_RESOLVE_DENIED';
        throw error;
      }
      if (path !== 'sibling.tex') {
        const error = new Error(`not found: ${path}`) as Error & { code: string };
        error.code = 'NOT_FOUND';
        throw error;
      }
      return 'shared';
    };
    const result = await flattenLaTeX({
      entryPath: 'main.tex',
      entrySource: '\\begin{document}\n\\input{../secrets}\n\\input{sibling}\n\\end{document}',
      readFile,
    });
    expect(result.diagnostics.some((d) => d.code === 'LATEX_RESOLVE_DENIED' && d.line === 1)).toBe(true);
    expect(result.source).toContain('shared');
    expect(result.source).toContain('% froglight: include unavailable');
  });

  it('resolves sibling-directory references through the lenient relative namespace', async () => {
    // A child included from a subdirectory referencing its own sibling.
    const result = await flatten({
      'main.tex': '\\input{chapters/one}',
      'chapters/one.tex': 'ONE\n\\input{two}',
      'chapters/two.tex': 'TWO',
    });
    expect(result.source).toContain('ONE');
    expect(result.source).toContain('TWO');
    expect(result.includedFiles).toEqual(['chapters/one.tex', 'chapters/two.tex']);
  });

  it('rewrites \\cite into placeholder labels and records keys in order', async () => {
    const result = await flatten({
      'main.tex': ['\\begin{document}', 'As shown \\cite{knuth84} and \\cite{lamport94,knuth84}.', '\\end{document}'].join('\n'),
    });
    expect(result.source).toContain('As shown [knuth84] and [lamport94, knuth84].');
    expect(result.citations).toEqual(['knuth84', 'lamport94']);
  });

  it('rewrites \\cite inside comments as nothing at all (comments mask first)', async () => {
    const result = await flatten({
      'main.tex': '\\begin{document}\n% \\cite{ghost}\nreal \\cite{real}\n\\end{document}',
    });
    expect(result.citations).toEqual(['real']);
    expect(result.source).toContain('% \\cite{ghost}');
  });

  it('neutralizes custom macro definitions with diagnostics', async () => {
    const result = await flatten({
      'main.tex': [
        '\\documentclass{article}',
        '\\newcommand{\\foo}[1]{bar #1}',
        '\\def\\baz{qux}',
        '\\begin{document}',
        'body',
        '\\end{document}',
      ].join('\n'),
    });
    expect(result.source).not.toMatch(/\\newcommand\{\\foo\}/);
    expect(result.source).not.toMatch(/\\def\\baz/);
    expect(result.source).toContain('body');
    const codes = result.diagnostics.map((d) => d.code);
    expect(codes).toContain('LATEX_UNSUPPORTED_COMMAND');
  });

  it('strips \\graphicspath with a diagnostic', async () => {
    const result = await flatten({
      'main.tex': '\\graphicspath{{img/}}\n\\begin{document}\\end{document}',
    });
    expect(result.source).not.toMatch(/\\graphicspath\{\{/);
    expect(result.diagnostics.some((d) => d.code === 'LATEX_UNSUPPORTED_COMMAND' && d.message.includes('graphicspath'))).toBe(true);
  });

  it('removes \\bibliography targets with diagnostics and records resolved.bib paths', async () => {
    const result = await flatten({
      'main.tex': '\\begin{document}\n\\bibliography{refs}\n\\end{document}',
    });
    expect(result.source).not.toContain('\\bibliography{refs}');
    expect(result.bibliographyFiles).toEqual(['refs.bib']);
    expect(result.diagnostics.some((d) => d.code === 'LATEX_INFO' && d.message.includes('bibliography'))).toBe(true);
  });

  it('approximates thebibliography as a description list with labels', async () => {
    const result = await flatten({
      'main.tex': [
        '\\begin{document}',
        '\\begin{thebibliography}{9}',
        '% a comment',
        '\\bibitem{knuth84} Knuth, \\emph{The TeXbook}, 1984.',
        '\\end{thebibliography}',
        '\\end{document}',
      ].join('\n'),
    });
    expect(result.source).toContain('\\begin{description}');
    expect(result.source).toContain('\\item[knuth84] Knuth, \\emph{The TeXbook}, 1984.');
    expect(result.source).toContain('\\end{description}');
    expect(result.source).not.toContain('thebibliography');
    expect(result.diagnostics.some((d) => d.code === 'LATEX_INFO' && d.message.includes('thebibliography'))).toBe(true);
  });

  it('enforces include depth and total size limits with structured diagnostics', async () => {
    const chain: Record<string, string> = {};
    for (let i = 0; i < 20; i += 1) {
      chain[`${i}.tex`] = `L${i}\n\\input{${i + 1}}`;
    }
    const depth = await flatten(chain, '0.tex', { limits: { maxIncludeDepth: 5 } });
    expect(depth.diagnostics.some((d) => d.code === 'LATEX_RESOURCE_LIMIT' && d.message.includes('depth'))).toBe(true);

    const big = await flatten(
      {
        'main.tex': '\\input{big}',
        'big.tex': 'x'.repeat(300) + '\n\\input{big2}',
        'big2.tex': 'y'.repeat(300),
      },
      'main.tex',
      { limits: { maxFlattenedBytes: 400 } },
    );
    expect(big.diagnostics.some((d) => d.code === 'LATEX_RESOURCE_LIMIT' && d.message.includes('flattened'))).toBe(true);
  });

  it('leaves commented-out includes unexpanded', async () => {
    const result = await flatten({
      'main.tex': '% \\input{ghost}\nreal',
    });
    expect(result.includedFiles).toEqual([]);
    expect(result.source).toContain('% \\input{ghost}');
  });
});

describe('applyLaTeXAssetUrls', () => {
  it('substitutes includegraphics paths with resolved URLs, preserving line structure', async () => {
    const source = ['\\begin{document}', '\\includegraphics[width=5cm]{fig.png}', '\\end{document}'].join('\n');
    const result = await applyLaTeXAssetUrls(source, async (path) => `blob:mock/${path}`);
    expect(result.source).toBe(['\\begin{document}', '\\includegraphics[width=5cm]{blob:mock/fig.png}', '\\end{document}'].join('\n'));
    expect(result.diagnostics).toEqual([]);
  });

  it('reports missing assets as diagnostics and keeps the original path', async () => {
    const source = '\\includegraphics{ghost.png}';
    const result = await applyLaTeXAssetUrls(source, async () => {
      const error = new Error('nope') as Error & { code: string };
      error.code = 'LATEX_RESOLVE_MISSING';
      throw error;
    });
    expect(result.source).toBe(source);
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]!.code).toBe('LATEX_RESOLVE_MISSING');
  });
});
