import { describe, expect, it } from 'vitest';
import { latexJoinPath, latexDirOf, latexEnsureTexExtension, latexEnsureBibExtension } from './resolve.js';

describe('LaTeX path resolution', () => {
  it('joins references relative to the referencing file directory', () => {
    expect(latexJoinPath('chapters', 'one.tex')).toBe('chapters/one.tex');
    expect(latexJoinPath('chapters', './two.tex')).toBe('chapters/two.tex');
    expect(latexJoinPath('', 'main.tex')).toBe('main.tex');
    expect(latexJoinPath('a/b', '../shared/c.tex')).toBe('a/shared/c.tex');
  });

  it('allows traversal that stays inside the workspace, rejects only escape above root', () => {
    // `a/../outside.tex` resolves to a workspace resource — allowed.
    expect(latexJoinPath('a', '../outside.tex')).toBe('outside.tex');
    expect(() => latexJoinPath('', '../outside.tex')).toThrowError(/escapes the workspace root/);
    expect(() => latexJoinPath('a', '../../../outside.tex')).toThrowError(/escapes the workspace root/);
  });

  it('rejects absolute, backslash, drive-letter, NUL, and empty references', () => {
    expect(() => latexJoinPath('a', '/etc/passwd')).toThrowError(/absolute/);
    expect(() => latexJoinPath('a', 'C:/temp/x.tex')).toThrowError(/drive-letter/);
    expect(() => latexJoinPath('a', 'sub\\x.tex')).toThrowError(/backslash/);
    expect(() => latexJoinPath('a', 'x\0y')).toThrowError(/NUL/);
    expect(() => latexJoinPath('a', '')).toThrowError(/empty/);
    expect(() => latexJoinPath('a', '..')).toThrowError();
  });

  it('appends extensions only when missing', () => {
    expect(latexEnsureTexExtension('chapters/one')).toBe('chapters/one.tex');
    expect(latexEnsureTexExtension('chapters/one.tex')).toBe('chapters/one.tex');
    expect(latexEnsureBibExtension('refs')).toBe('refs.bib');
    expect(latexEnsureBibExtension('refs.bib')).toBe('refs.bib');
  });

  it('computes directory parts', () => {
    expect(latexDirOf('a/b/c.tex')).toBe('a/b');
    expect(latexDirOf('c.tex')).toBe('');
  });
});
