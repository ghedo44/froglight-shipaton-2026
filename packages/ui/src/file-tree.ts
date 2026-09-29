/**
 * Explorer tree model: pure, host-free mapping from workspace paths to a
 * nested folder/file tree used by the file explorer view.
 */

/** Custom MIME for internal tree moves (row drags within the explorer). */
export const FILE_TREE_DRAG_MIME = 'application/x-froglight-node';

export type FileTreeNode =
  | {
      readonly kind: 'folder';
      readonly name: string;
      readonly path: string;
      readonly children: FileTreeNode[];
    }
  | {
      readonly kind: 'file';
      readonly name: string;
      readonly path: string;
      readonly documentId?: string;
      readonly kindId?: string;
    };

/** Resolve the correct file icon for a workspace path based on its extension. */
export { iconForPath } from './file-kinds.js';

interface FileInput {
  readonly path: string;
  readonly documentId?: string;
  readonly kindId?: string;
}

function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

interface MutableFolder {
  kind: 'folder';
  name: string;
  path: string;
  children: Map<string, MutableFolder | { kind: 'file'; name: string; path: string; documentId?: string; kindId?: string }>;
}

/** Build a sorted tree from file paths (with optional ids) and folder paths. */
export function buildFileTree(
  files: readonly (FileInput | string)[],
  folders: readonly string[] = [],
): FileTreeNode[] {
  const root: MutableFolder = { kind: 'folder', name: '', path: '', children: new Map() };

  const ensureFolder = (segments: readonly string[]): MutableFolder => {
    let node = root;
    for (const segment of segments) {
      const existing = node.children.get(segment);
      if (existing === undefined) {
        const created: MutableFolder = {
          kind: 'folder',
          name: segment,
          path: node.path === '' ? segment : `${node.path}/${segment}`,
          children: new Map(),
        };
        node.children.set(segment, created);
        node = created;
      } else if (existing.kind === 'folder') {
        node = existing;
      }
    }
    return node;
  };

  for (const rawFolder of folders) {
    if (rawFolder === '') continue;
    ensureFolder(rawFolder.split('/'));
  }

  for (const entry of files) {
    const file: FileInput = typeof entry === 'string' ? { path: entry } : entry;
    if (file.path === '') continue;
    const segments = file.path.split('/');
    const name = segments[segments.length - 1] ?? '';
    if (name === '') continue;
    const parent = ensureFolder(segments.slice(0, -1));
    parent.children.set(name, {
      kind: 'file',
      name,
      path: file.path,
      ...(file.documentId !== undefined ? { documentId: file.documentId } : {}),
      ...(file.kindId !== undefined ? { kindId: file.kindId } : {}),
    });
  }

  const materialize = (node: MutableFolder): FileTreeNode[] => {
    const folders: FileTreeNode[] = [];
    const files2: FileTreeNode[] = [];
    for (const child of node.children.values()) {
      if (child.kind === 'folder') {
        folders.push({
          kind: 'folder',
          name: child.name,
          path: child.path,
          children: materialize(child),
        });
      } else {
        files2.push({
          kind: 'file',
          name: child.name,
          path: child.path,
          ...(child.documentId !== undefined ? { documentId: child.documentId } : {}),
          ...(child.kindId !== undefined ? { kindId: child.kindId } : {}),
        });
      }
    }
    folders.sort((a, b) => naturalCompare(a.name, b.name));
    files2.sort((a, b) => naturalCompare(a.name, b.name));
    return [...folders, ...files2];
  };

  return materialize(root);
}
