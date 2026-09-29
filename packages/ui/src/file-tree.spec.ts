import { describe, expect, it } from 'vitest';
import { buildFileTree, type FileTreeNode } from './file-tree.js';

describe('buildFileTree', () => {
  it('builds nested folders and sorts folders before files', () => {
    const tree = buildFileTree(
      ['notes/b.md', 'notes/a.md', 'z-root.md', 'projects/froglight/plan.md'],
      ['empty-folder'],
    );
    const names = tree.map((node) => `${node.name}:${node.kind}`);
    expect(names).toEqual([
      'empty-folder:folder',
      'notes:folder',
      'projects:folder',
      'z-root.md:file',
    ]);
    const notes = tree.find((node) => node.name === 'notes') as Extract<FileTreeNode, { kind: 'folder' }>;
    expect(notes.children.map((child) => child.name)).toEqual(['a.md', 'b.md']);
  });

  it('sorts naturally within a folder (2 before 10)', () => {
    const tree = buildFileTree(['d/10.md', 'd/2.md', 'd/1.md'], []);
    const d = tree[0] as Extract<FileTreeNode, { kind: 'folder' }>;
    expect(d.children.map((child) => child.name)).toEqual(['1.md', '2.md', '10.md']);
  });

  it('keeps document ids on file nodes', () => {
    const tree = buildFileTree([{ path: 'a/b.md', documentId: 'doc-1' }], []);
    const a = tree[0] as Extract<FileTreeNode, { kind: 'folder' }>;
    const b = a.children[0] as Extract<FileTreeNode, { kind: 'file' }>;
    expect(b.documentId).toBe('doc-1');
    expect(b.path).toBe('a/b.md');
  });

  it('merges folder chains without duplicating segments', () => {
    const tree = buildFileTree(['a/b/x.md', 'a/b/y.md', 'a/c.md'], []);
    expect(tree).toHaveLength(1);
    const a = tree[0] as Extract<FileTreeNode, { kind: 'folder' }>;
    expect(a.children.map((child) => child.name)).toEqual(['b', 'c.md']);
  });

  it('does not mutate its inputs', () => {
    const files = ['b.md', 'a.md'];
    const folders = ['f'];
    buildFileTree(files, folders);
    expect(files).toEqual(['b.md', 'a.md']);
    expect(folders).toEqual(['f']);
  });
});
