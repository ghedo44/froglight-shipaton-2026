import { describe, expect, it } from 'vitest';
import { decodeLaTeX, encodeLaTeX, latexFallbackTitleFromPath } from './codec.js';
import { latexKind, latexKindId, isLaTeXPath } from './kind.js';
import { latexModel } from './model.js';
import { latexSearchAnchors, latexSearchText } from './search.js';
import { refFor, newDocumentId, newResourceId } from '../documents.js';

function decode(raw: string) {
  return decodeLaTeX(
    new TextEncoder().encode(raw),
    refFor(newDocumentId(), latexKindId, newResourceId()),
  );
}

describe('LaTeX codec', () => {
  it('round-trips raw bytes byte-identically', () => {
    const raw = '\\documentclass{article}\n% keep % everything\n\\begin{document}x\\end{document}\n';
    const bytes = new TextEncoder().encode(raw);
    const decoded = decodeLaTeX(bytes, refFor(newDocumentId(), latexKindId, newResourceId()));
    expect(encodeLaTeX(decoded.model, refFor(newDocumentId(), latexKindId, newResourceId()))).toEqual(bytes);
    expect(decoded.model).toEqual(latexModel(raw));
  });

  it('recognizes.tex,.ltx, and.latex but not other extensions', () => {
    expect(latexKind.recognize?.(latexKindId)).toBe(true);
    expect(isLaTeXPath('notes/paper.TEX')).toBe(true);
    expect(isLaTeXPath('notes/old.ltx')).toBe(true);
    expect(isLaTeXPath('notes/modern.latex')).toBe(true);
    expect(isLaTeXPath('notes/texture.md')).toBe(false);
    expect(isLaTeXPath('notes/notes.md')).toBe(false);
    expect(latexKind.recognize?.('froglight.markdown')).toBe(false);
  });

  it('derives title metadata from \\title, sections, then fallback', () => {
    expect(decode('\\title{Explicit}\\begin{document}\\end{document}').metadata['title']).toBe('Explicit');
    expect(
      decode('\\begin{document}\\section{First Head}\\end{document}').metadata['title'],
    ).toBe('First Head');
    expect(
      decodeLaTeX(
        new TextEncoder().encode('\\begin{document}\\end{document}'),
        refFor(newDocumentId(), latexKindId, newResourceId()),
        { fallbackTitleFromPath: 'paper' },
      ).metadata['title'],
    ).toBe('paper');
  });

  it('carries author and document class in properties without touching source', () => {
    const decoded = decode('\\documentclass{article}\\author{Ada Lovelace}\\begin{document}\\end{document}');
    expect(decoded.metadata['properties']).toEqual({ author: 'Ada Lovelace', documentClass: 'article' });
  });

  it('projects include, bibliography, and image relationships with synthetic path targets', () => {
    const decoded = decode(
      [
        '\\documentclass{article}',
        '\\begin{document}',
        '\\input{chapters/one}',
        '\\includegraphics{fig.png}',
        '\\bibliography{refs}',
        '\\end{document}',
      ].join('\n'),
    );
    const types = decoded.relationships.map((edge) => edge.type);
    expect(types).toEqual(['latex.include', 'latex.image', 'latex.bibliography']);
    expect(decoded.relationships[0]!.target.documentId).toBe('chapters/one');
    expect(decoded.relationships[1]!.target.documentId).toBe('fig.png');
    expect(decoded.relationships[2]!.target.documentId).toBe('refs');
  });

  it('searchText masks comments and slices the body', () => {
    const raw = [
      '\\documentclass{article}',
      '% secret preamble note',
      '\\begin{document}',
      'visible text',
      '% secret body note',
      '\\end{document}',
    ].join('\n');
    const text = latexSearchText(raw);
    expect(text).not.toContain('secret');
    expect(text).toContain('visible text');
    expect(decode(raw).model.raw).toContain('% secret body note');
  });

  it('aligns label search anchors to the projection', () => {
    const raw = ['\\begin{document}', '\\section{One}\\label{s1}', 'alpha', '\\section{Two}\\label{s2}', 'beta', '\\end{document}'].join('\n');
    const projection = latexSearchText(raw);
    const anchors = latexSearchAnchors(raw);
    expect(anchors.map((anchor) => anchor.address)).toEqual(['s1', 's2']);
    for (const anchor of anchors) {
      expect(projection.slice(anchor.start, anchor.end)).toBeTruthy();
    }
    expect(anchors[0]!.end).toBe(anchors[1]!.start);
  });

  it('derives fallback title from paths with any recognized extension', () => {
    expect(latexFallbackTitleFromPath('notes/thesis.tex')).toBe('thesis');
    expect(latexFallbackTitleFromPath('notes/old.ltx')).toBe('old');
  });
});
