import { describe, expect, it } from 'vitest';
import { isDefaultExcludedSyncPath } from './exclude.js';

describe('isDefaultExcludedSyncPath', () => {
  it('syncs ordinary vault content including portable records', () => {
    expect(isDefaultExcludedSyncPath('Notes/physics.md')).toBe(false);
    expect(isDefaultExcludedSyncPath('Assets/book.pdf')).toBe(false);
    expect(isDefaultExcludedSyncPath('.froglight/settings.json')).toBe(false);
    expect(
      isDefaultExcludedSyncPath('.froglight/revisions/doc-1/index.json'),
    ).toBe(false);
    expect(isDefaultExcludedSyncPath('.froglight/trash/documents/doc-1')).toBe(
      false,
    );
    expect(isDefaultExcludedSyncPath('.froglight/dock.json')).toBe(false);
  });

  it('excludes the disposable derived index subtree', () => {
    expect(isDefaultExcludedSyncPath('.froglight/indexes')).toBe(true);
    expect(
      isDefaultExcludedSyncPath('.froglight/indexes/database.sqlite'),
    ).toBe(true);
    expect(isDefaultExcludedSyncPath('.froglight/indexes-old/data')).toBe(
      false,
    );
  });

  it('excludes OS droppings in any directory', () => {
    expect(isDefaultExcludedSyncPath('.DS_Store')).toBe(true);
    expect(isDefaultExcludedSyncPath('Notes/.DS_Store')).toBe(true);
    expect(isDefaultExcludedSyncPath('Thumbs.db')).toBe(true);
    expect(isDefaultExcludedSyncPath('Desktop.ini')).toBe(true);
  });

  it('excludes editor and lock temporaries', () => {
    expect(isDefaultExcludedSyncPath('Notes/draft.tmp')).toBe(true);
    expect(isDefaultExcludedSyncPath('Notes/draft.lock')).toBe(true);
    expect(isDefaultExcludedSyncPath('Notes/notes~')).toBe(true);
    expect(isDefaultExcludedSyncPath('Notes/~$locked.docx')).toBe(true);
    expect(isDefaultExcludedSyncPath('Notes/.~lock.tmp')).toBe(true);
    expect(isDefaultExcludedSyncPath('Notes/edit.swp')).toBe(true);
    expect(isDefaultExcludedSyncPath('Notes/edit.swo')).toBe(true);
  });

  it('is basename-scoped so similar real names still sync', () => {
    expect(isDefaultExcludedSyncPath('Notes/tmp-notes.md')).toBe(false);
    expect(isDefaultExcludedSyncPath('Notes/locking.md')).toBe(false);
  });
});
