import { describe, expect, it } from 'vitest';
import { moveTargetPath } from './file-explorer.js';
import { fuzzyScore, rankDocuments } from './switcher.js';

describe('moveTargetPath (drag & drop)', () => {
  it('moves a file into a folder keeping its name', () => {
    expect(moveTargetPath('notes/idea.md', false, 'archive')).toBe('archive/idea.md');
  });

  it('moves a file to vault root when dropped outside any folder', () => {
    expect(moveTargetPath('deep/nested/idea.md', false, '')).toBe('idea.md');
  });

  it('moves a folder into another folder', () => {
    expect(moveTargetPath('projects/alpha', true, 'archive')).toBe('archive/alpha');
  });

  it('rejects dropping a folder into itself or its own subtree', () => {
    expect(moveTargetPath('projects', true, 'projects')).toBeNull();
    expect(moveTargetPath('projects', true, 'projects/inner')).toBeNull();
  });

  it('treats same-location drops as no-ops', () => {
    expect(moveTargetPath('notes/idea.md', false, 'notes')).toBeNull();
    expect(moveTargetPath('notes', true, '')).toBeNull();
  });

  it('dropping beside a file targets that file’s parent folder', () => {
    // Dropping archive/todo.md beside notes/idea.md → notes/todo.md
    expect(moveTargetPath('archive/todo.md', false, 'notes')).toBe('notes/todo.md');
    // …but beside a sibling in the same folder is a no-op.
    expect(moveTargetPath('notes/idea.md', false, 'notes')).toBeNull();
  });

  it('rejects dropping a folder beside a file inside its own subtree', () => {
    expect(moveTargetPath('projects', true, 'projects/inner')).toBeNull();
  });

  it('accepts dropping a folder beside a file in an unrelated folder', () => {
    expect(moveTargetPath('projects/alpha', true, 'notes')).toBe('notes/alpha');
  });
});

describe('quick switcher ranking', () => {
  const documents = [
    { documentId: '1', title: 'Meeting notes', path: 'work/meeting-notes.md' },
    { documentId: '2', title: 'Groceries', path: 'personal/groceries.md' },
    { documentId: '3', title: 'meet', path: 'work/meet.md' },
  ];

  it('ranks exact title matches above partial path matches', () => {
    const ranked = rankDocuments(documents, 'meet');
    expect(ranked[0]?.document.documentId).toBe('3');
    expect(ranked.length).toBeGreaterThan(0);
  });

  it('matches across title and path with fuzzy subsequence', () => {
    const ranked = rankDocuments(documents, 'grc');
    expect(ranked[0]?.document.documentId).toBe('2');
  });

  it('returns everything in insertion order for an empty query, capped by limit', () => {
    const ranked = rankDocuments(documents, '', 2);
    expect(ranked.length).toBe(2);
  });

  it('never returns non-matching documents', () => {
    expect(rankDocuments(documents, 'zzzz').length).toBe(0);
  });

  it('scores empty query best and misses infinitely bad', () => {
    expect(fuzzyScore('', 'anything')).toBeLessThanOrEqual(0);
    expect(fuzzyScore('q', 'nothing here')).toBe(Number.POSITIVE_INFINITY);
  });
});
