import { createElement } from 'react';
import { createServiceToken, definePlugin } from '@froglight/runtime';
import {
  documentAssetStoreToken,
  documentRegistryToken,
  documentPresentationToken,
  ensureDirectory,
  externalFileDropToken,
  isVaultError,
  isWorkspacePath,
  inkPageKindId,
  markdownKindId,
  notebookKindId,
  pdfProviderToken,
  parentPath,
  vaultToken,
  workspacePath,
  workspaceToken,
  emptySurface,
  boundedFrame,
  emptyNotebook,
  imageObject,
  pdfNotebookPage,
  resolveDocumentLink,
  sha256Hex,
  splitLinkDestination,
  type DocumentAssetStore,
  type DocumentKindId,
  type DocumentId,
  type ExternalFileDropService,
  type PdfProvider,
  type VaultEntry,
  type WorkspacePath,
  type WorkspaceService,
} from '@froglight/foundation';
import { viewRegistryToken } from './view-registry.js';
import { FileExplorerView } from './react/index.js';
import {
  buildFileTree,
  FILE_TREE_DRAG_MIME,
  type FileTreeNode,
} from './file-tree.js';
import { fileNameOf, mimeForPath } from './file-kinds.js';
import { noteKindOption, type NoteKindOption } from './note-kinds.js';

export interface FileExplorerService {
  /** Full workspace tree (folders + documents). */
  tree(): Promise<readonly FileTreeNode[]>;
  /** Resolve an existing non-document file linked from a document path. */
  resolveRawFileLink(
    destination: string,
    sourcePath?: string,
  ): Promise<{ path: string } | { ambiguous: true } | null>;
  /** Registered document kinds that provide blank-document creation. */
  creatableKinds(): readonly NoteKindOption[];
  /** Create a folder (recursive). */
  createFolder(path: string): Promise<void>;
  /** Create a note named `name` inside `folder` ('' = root). Returns its documentId. */
  createNote(
    folder: string,
    name: string,
    kindId?: DocumentKindId,
  ): Promise<string>;
  /** Rename/move a document to a new full path. */
  moveDocument(documentId: string, toPath: string): Promise<void>;
  /** Duplicate saved content with fresh identities and a collision-safe path. */
  duplicateDocument(documentId: string): Promise<string>;
  /** Recoverable documents removed from the active workspace. */
  listTrash(): readonly {
    readonly documentId: string;
    readonly path: string;
    readonly kindId: string;
  }[];
  /** Restore a document, choosing a collision-safe path if necessary. */
  restoreDocument(documentId: string): Promise<string>;
  /** Irreversibly remove a document already in Trash. */
  permanentlyDeleteDocument(documentId: string): Promise<void>;
  /** Move a folder and everything under it. */
  moveFolder(fromPath: string, toPath: string): Promise<void>;
  /** Delete one document. */
  deleteDocument(documentId: string): Promise<void>;
  /** Delete a folder subtree (documents first, then folders bottom-up). */
  deleteFolder(path: string): Promise<number>;
  /** Import an external file's bytes into `targetFolder` (creates a document for known kinds, otherwise a raw vault file). */
  importFile(
    targetFolder: string,
    fileName: string,
    data: Uint8Array,
  ): Promise<void>;
  /** Import a file and return its collision-safe vault path for immediate linking. */
  importFileWithPath?(
    targetFolder: string,
    fileName: string,
    data: Uint8Array,
  ): Promise<string>;
  /** Move a raw vault file (not a workspace document). */
  moveRawFile(fromPath: string, toPath: string): Promise<void>;
  /** Delete a raw vault file (not a workspace document). */
  deleteRawFile(path: string): Promise<void>;
  /** Read raw vault file bytes (for preview). */
  readRawFile(path: string): Promise<Uint8Array>;
  /**
   * Read a raw vault file as a blob, lazily backed by disk where the vault
   * can supply a `File`; otherwise eagerly from bytes. Optional: preview
   * callers fall back to `readRawFile` when absent.
   */
  readRawFileBlob?(path: string): Promise<Blob>;
  /** Create a Notebook (.notebook) from an existing vault PDF (document or raw file). */
  createNotebookFromPdf(sourcePath: string): Promise<string>;
  /** Create an Ink drawing (.ink) from an existing vault image (png/jpg/etc.). */
  createInkFromImage(sourcePath: string): Promise<string>;
  onDidChange(listener: () => void): { dispose(): void };
  /** Refresh explorer views after a workspace move made by another owner. */
  refresh(): void;
}

export const fileExplorerToken = createServiceToken<FileExplorerService>(
  'froglight.file-explorer',
);

const MAX_TREE_DEPTH = 24;

function relativeLinkPath(base: string, target: string): string | null {
  const parts = base === '' ? [] : base.split('/');
  for (const part of target.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  const path = parts.join('/');
  return isWorkspacePath(path) && path !== '' ? path : null;
}

/**
 * Compute the destination path when `draggedPath` is dropped into
 * `targetFolder`. Returns null for invalid drops (a folder into itself or
 * its own subtree, or a no-op move).
 */
export function moveTargetPath(
  draggedPath: string,
  isFolder: boolean,
  targetFolder: string,
): string | null {
  const name = draggedPath.split('/').pop() ?? '';
  if (name === '') return null;
  if (isFolder) {
    if (targetFolder === draggedPath) return null;
    if (targetFolder.startsWith(`${draggedPath}/`)) return null;
  }
  const destination = targetFolder === '' ? name : `${targetFolder}/${name}`;
  if (destination === draggedPath) return null;
  return destination;
}

/**
 * One external file awaiting import. Browser `File` objects and native
 * `ExternalDropFile` handles both adapt to this shape so
 * `importExternalCandidates` stays the single import seam before
 * `FileExplorerService.importFile()`.
 */
export interface ExternalImportCandidate {
  readonly name: string;
  readBytes(): Promise<Uint8Array>;
}

export interface ExternalImportResult {
  readonly imported: number;
  readonly failed: number;
  readonly errors: readonly unknown[];
}

/**
 * Shared browser/native import loop. Reads every candidate lazily and
 * forwards `name + bytes` to `FileExplorerService.importFile()` — the only
 * authority that decides how bytes become documents or raw vault files.
 * Failures are collected per file so one unreadable drop never blocks the
 * rest; callers surface `errors` through toasts/diagnostics.
 */
export async function importExternalCandidates(
  service: Pick<FileExplorerService, 'importFile'>,
  candidates: readonly ExternalImportCandidate[],
  targetFolder: string,
): Promise<ExternalImportResult> {
  let imported = 0;
  let failed = 0;
  const errors: unknown[] = [];
  for (const candidate of candidates) {
    try {
      const bytes = await candidate.readBytes();
      await service.importFile(targetFolder, candidate.name, bytes);
      imported += 1;
    } catch (error) {
      failed += 1;
      errors.push(error);
    }
  }
  return { imported, failed, errors };
}

interface DragTypes {
  readonly types: ReadonlyArray<string>;
}

interface DropData extends DragTypes {
  readonly files: ArrayLike<unknown>;
}

/** Custom MIME for internal tree moves (row drags within the explorer). */
export { FILE_TREE_DRAG_MIME };

/**
 * Internal-drag guard. `getData` is blocked in the protected drag-data
 * phase, so availability is checked against the type list only — and via
 * `Array.from` because `DataTransfer.types` is a plain array in Chromium
 * but a `DOMStringList` (no `.includes`) in Firefox and some WebKitGTK
 * builds. Calling `.includes` directly throws there, killing the dragover
 * handler before `preventDefault()`: the block-pointer + dead-drop symptom.
 */
export function isInternalNodeDrag(
  dataTransfer: DragTypes | DataTransfer | null,
): boolean {
  if (dataTransfer === null || dataTransfer === undefined) return false;
  const types = (dataTransfer as DragTypes).types;
  if (types === null || types === undefined) return false;
  try {
    return Array.from(types as ArrayLike<string>).includes(FILE_TREE_DRAG_MIME);
  } catch {
    return false;
  }
}

/**
 * Dragover guard: `getData` is blocked in the protected drag-data phase,
 * so availability is checked against the type list only. `files` may be
 * empty on WebKit during dragover — that must still be accepted.
 */
export function isExternalFileDrag(
  dataTransfer: DragTypes | DataTransfer | null,
): boolean {
  if (dataTransfer === null || dataTransfer === undefined) return false;
  const types = (dataTransfer as DragTypes).types;
  if (types === null || types === undefined) return false;
  try {
    return Array.from(types as ArrayLike<string>).includes('Files');
  } catch {
    return false;
  }
}

/** Drop-time guard: the drop carries files (type list is engine-dependent). */
export function isExternalFileDrop(
  dataTransfer: DropData | DataTransfer | null,
): boolean {
  if (dataTransfer === null || dataTransfer === undefined) return false;
  const files = (dataTransfer as DropData).files;
  if (files !== null && files !== undefined) {
    try {
      // Files present means external: internal tree drags never carry
      // files, and some engines (Linux WebKitGTK) omit the `Files` type
      // while still delivering real file data.
      if ((files as ArrayLike<unknown>).length > 0) return true;
    } catch {
      return false;
    }
  }
  // No readable files: fall back to the type list (may still be empty in
  // the protected phase, which correctly rejects).
  if (!isExternalFileDrag(dataTransfer)) return false;
  if (files === null || files === undefined) return false;
  try {
    return (files as ArrayLike<unknown>).length > 0;
  } catch {
    return false;
  }
}

export interface DropTransferShape {
  readonly types: readonly string[];
  readonly fileCount: number;
}

/**
 * Snapshot what an engine exposed on a drop that the tree did not
 * recognize. Logged via `console.debug` on the unrecognized-drop path so
 * engine quirks (missing types, empty files) can be diagnosed from a
 * user report without reproducing their exact OS/WebView combination.
 */
export function describeDropTransfer(
  dataTransfer: DropData | DataTransfer | null,
): DropTransferShape {
  if (dataTransfer === null || dataTransfer === undefined) {
    return { types: [], fileCount: 0 };
  }
  let types: readonly string[] = [];
  try {
    const raw = (dataTransfer as DragTypes).types;
    if (raw !== null && raw !== undefined) {
      types = Array.from(raw as ArrayLike<string>);
    }
  } catch {
    types = [];
  }
  let fileCount = 0;
  try {
    const files = (dataTransfer as DropData).files;
    if (files !== null && files !== undefined) {
      fileCount = (files as ArrayLike<unknown>).length;
    }
  } catch {
    fileCount = 0;
  }
  return { types, fileCount };
}

/**
 * Resolve a native drop's viewport coordinates to a vault folder.
 *
 * - folder row → its path
 * - file row → its parent folder (root files → `''`)
 * - tree body / empty state → `''` (vault root)
 * - outside the explorer or no hit → `null` (reject)
 *
 * Rows expose path/kind identity through `data-path`/`data-kind`, so no
 * second tree model is needed. Pure over the DOM: `elementFromPoint` is
 * read from the root's owner document and may be stubbed in tests.
 */
export function resolveExternalDropTarget(
  root: HTMLElement,
  x: number,
  y: number,
): string | null {
  const doc = root.ownerDocument;
  const fromPoint = (
    doc as Document & {
      elementFromPoint?: (x: number, y: number) => Element | null;
    }
  ).elementFromPoint;
  if (typeof fromPoint !== 'function') return null;
  let hit: Element | null = null;
  try {
    hit = fromPoint.call(doc, x, y);
  } catch {
    return null;
  }
  if (hit === null) return null;
  if (!root.contains(hit)) return null;
  const element = hit as HTMLElement;
  const closest =
    typeof element.closest === 'function'
      ? element.closest('[data-path]')
      : null;
  if (closest !== null && root.contains(closest)) {
    const row = closest as HTMLElement;
    const path = row.dataset.path ?? '';
    const kind = row.dataset.kind;
    if (path === '') return '';
    if (kind === 'folder') return path;
    if (kind === 'file') return String(parentPath(workspacePath(path)));
    return path;
  }
  return '';
}

/** Safe stem for a converted document's title and file name. */
function conversionTitle(path: string): string {
  const fileName = fileNameOf(path);
  const stem = fileName.replace(/\.[^.]+$/, '').trim();
  const safe = stem
    // eslint-disable-next-line no-control-regex -- intentional C0 control strip for file names
    .replace(/[\u0000-\u001f]/g, '-')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\.+$/g, '')
    .trim();
  return safe === '' ? 'Untitled' : safe;
}

function freshConversionId(): string {
  const random = globalThis.crypto?.getRandomValues(new Uint32Array(1))[0] ?? 0;
  return random.toString(36);
}

function freshConversionPageId(pageIndex: number): string {
  return `pdf-${pageIndex}-${freshConversionId()}`;
}

/**
 * Natural pixel size of an image when the host can decode it cheaply;
 * a sane default otherwise. The created ink canvas starts at this size,
 * so it is user-resizable after creation.
 */
async function naturalImageSize(
  bytes: Uint8Array,
): Promise<{ width: number; height: number }> {
  type BitmapFactory = (input: Blob) => Promise<{
    width: number;
    height: number;
    close(): void;
  }>;
  const factory = (globalThis as { createImageBitmap?: BitmapFactory })
    .createImageBitmap;
  if (factory === undefined) return { width: 960, height: 720 };
  try {
    const bitmap = await factory(new Blob([bytes as BlobPart]));
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return { width: 960, height: 720 };
  }
}

function uniquePathCandidate(base: string, counter: number): string {
  if (counter === 0) return base;
  const slash = base.lastIndexOf('/');
  const dir = slash === -1 ? '' : base.slice(0, slash);
  const name = slash === -1 ? base : base.slice(slash + 1);
  const dot = name.lastIndexOf('.');
  const stem = dot <= 0 ? name : name.slice(0, dot);
  const ext = dot <= 0 ? '' : name.slice(dot);
  const nextName = `${stem} (${counter})${ext}`;
  return dir === '' ? nextName : `${dir}/${nextName}`;
}

/** Explorer over the whole workspace; document kinds open via their own editors. */
export const fileExplorerPlugin = definePlugin({
  id: 'froglight.file-explorer',
  requirements: {
    requires: [workspaceToken, vaultToken, documentRegistryToken],
    optionallyRequires: [
      documentAssetStoreToken,
      documentPresentationToken,
      pdfProviderToken,
      externalFileDropToken,
    ],
  },
  activate: (ctx) => {
    const workspace: WorkspaceService = ctx.require(workspaceToken);
    const vault = ctx.require(vaultToken);
    const registry = ctx.require(documentRegistryToken);
    const presentations = ctx.try(documentPresentationToken);
    const assetStore: DocumentAssetStore | null =
      ctx.try(documentAssetStoreToken) ?? null;
    const pdfProvider: PdfProvider | null = ctx.try(pdfProviderToken) ?? null;
    const externalDrop: ExternalFileDropService | null =
      ctx.try(externalFileDropToken) ?? null;
    const listeners = new Set<() => void>();
    const notify = (): void => {
      for (const listener of [...listeners]) listener();
    };

    async function listFolders(
      dir: WorkspacePath,
      depth: number,
      acc: string[],
    ): Promise<void> {
      if (depth > MAX_TREE_DEPTH) return;
      let entries: readonly VaultEntry[];
      try {
        entries = await vault.list(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.kind !== 'directory') continue;
        if (
          entry.name === '.froglight' ||
          entry.name === 'attachments' ||
          entry.name.startsWith('.')
        )
          continue;
        const childPath: string =
          dir === '' ? entry.name : `${dir}/${entry.name}`;
        acc.push(childPath);
        await listFolders(childPath as WorkspacePath, depth + 1, acc);
      }
    }

    async function listVaultFiles(
      dir: WorkspacePath,
      depth: number,
      acc: string[],
    ): Promise<void> {
      if (depth > MAX_TREE_DEPTH) return;
      let entries: readonly VaultEntry[];
      try {
        entries = await vault.list(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        if (
          entry.name === '.froglight' ||
          entry.name === 'attachments' ||
          entry.name.startsWith('.')
        )
          continue;
        const childPath: string =
          dir === '' ? entry.name : `${dir}/${entry.name}`;
        if (entry.kind === 'directory') {
          await listVaultFiles(childPath as WorkspacePath, depth + 1, acc);
        } else {
          acc.push(childPath);
        }
      }
    }

    async function ensureUniquePath(initial: string): Promise<string> {
      let counter = 0;
      let candidate = initial;
      while (true) {
        const workspacePathCandidate = workspacePath(
          normalizeFolder(candidate) === ''
            ? candidate
            : normalizeFolder(candidate),
        );
        // Check vault existence
        let vaultExists = false;
        try {
          await vault.stat(workspacePathCandidate);
          vaultExists = true;
        } catch (error) {
          if (isVaultError(error) && error.code === 'NOT_FOUND') {
            vaultExists = false;
          } else {
            throw error;
          }
        }
        const documentExists =
          workspace.findByResourcePath(workspacePathCandidate) !== null;
        if (!vaultExists && !documentExists) return candidate;
        counter += 1;
        candidate = uniquePathCandidate(initial, counter);
        if (counter > 999)
          throw new Error(`cannot find unique path for ${initial}`);
      }
    }

    async function deleteFolderRecursive(dir: WorkspacePath): Promise<number> {
      const files: string[] = [];
      await listVaultFiles(dir, 0, files);
      const tracked = new Set(
        workspace
          .listDocuments()
          .map((ref) =>
            String(workspace.resolveResourcePath(ref.location.resourceId)),
          ),
      );
      if (files.some((path) => !tracked.has(path)))
        throw new Error(
          'Folder contains files outside the document workspace. Move or delete those files separately.',
        );
      let deleted = 0;
      for (const ref of workspace.listDocuments()) {
        const path = String(
          workspace.resolveResourcePath(ref.location.resourceId),
        );
        if (path === dir || path.startsWith(`${dir}/`)) {
          await workspace.removeDocument(ref.documentId);
          deleted += 1;
        }
      }
      await removeEmptyDirShells(dir);
      return deleted;
    }

    /** Remove a directory subtree that no longer holds documents. */
    async function removeEmptyDirShells(dir: WorkspacePath): Promise<void> {
      let entries: readonly VaultEntry[] = [];
      try {
        entries = await vault.list(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        const child = (
          dir === '' ? entry.name : `${dir}/${entry.name}`
        ) as WorkspacePath;
        if (entry.kind === 'directory') {
          await removeEmptyDirShells(child);
        }
      }
      if (dir !== '') await vault.remove(dir).catch(() => undefined);
    }

    const service: FileExplorerService = {
      async tree() {
        const workspaceFiles = workspace.listDocuments().map((ref) => ({
          path: String(workspace.resolveResourcePath(ref.location.resourceId)),
          documentId: String(ref.documentId),
          kindId: String(ref.kindId),
        }));
        const workspacePaths = new Set(workspaceFiles.map((f) => f.path));
        const vaultRawFiles: string[] = [];
        await listVaultFiles('' as WorkspacePath, 0, vaultRawFiles);
        const rawFiles = vaultRawFiles.filter((p) => !workspacePaths.has(p));
        const allFiles = [...workspaceFiles, ...rawFiles];
        const folders: string[] = [];
        await listFolders('' as WorkspacePath, 0, folders);
        return buildFileTree(allFiles, folders);
      },
      async resolveRawFileLink(destination, sourcePath) {
        const { path: linkedPath } = splitLinkDestination(destination.trim());
        if (
          linkedPath === '' ||
          /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(linkedPath) ||
          linkedPath.startsWith('{') ||
          linkedPath.startsWith('[')
        ) {
          return null;
        }

        // Registered documents keep the workbench's existing link semantics.
        const sourceRef =
          sourcePath !== undefined && isWorkspacePath(sourcePath)
            ? workspace.findByResourcePath(sourcePath)
            : null;
        if (
          resolveDocumentLink(
            workspace,
            destination,
            sourceRef?.location.resourceId,
          ) !== null
        ) {
          return null;
        }

        // Match the source folder first, then the vault root. A bare name in
        // another folder is usable only when it identifies one raw file.
        const candidates: string[] = [];
        if (
          sourcePath !== undefined &&
          isWorkspacePath(sourcePath) &&
          !linkedPath.startsWith('/')
        ) {
          const directory = sourcePath.slice(0, sourcePath.lastIndexOf('/') + 1);
          const relative = relativeLinkPath(
            directory.replace(/\/$/, ''),
            linkedPath,
          );
          if (relative !== null) candidates.push(relative);
        }
        const rootPath = relativeLinkPath('', linkedPath.replace(/^\.?\//, ''));
        if (rootPath !== null) candidates.push(rootPath);
        for (const candidate of new Set(candidates)) {
          if (workspace.findByResourcePath(workspacePath(candidate)) !== null) {
            continue;
          }
          try {
            if ((await vault.stat(workspacePath(candidate))).kind === 'file') {
              return { path: candidate };
            }
          } catch (error) {
            if (!isVaultError(error) || error.code !== 'NOT_FOUND') throw error;
          }
        }

        const key = rootPath?.toLowerCase();
        if (key === undefined) return null;
        const files: string[] = [];
        await listVaultFiles('' as WorkspacePath, 0, files);
        const matches = files.filter((path) => {
          if (workspace.findByResourcePath(workspacePath(path)) !== null) {
            return false;
          }
          const normalized = path.toLowerCase();
          return normalized === key || normalized.endsWith(`/${key}`);
        });
        if (matches.length > 1) return { ambiguous: true };
        return matches[0] === undefined ? null : { path: matches[0] };
      },
      creatableKinds() {
        return registry.list().flatMap((kind) => {
          const option = noteKindOption(kind, presentations);
          return option === null ? [] : [option];
        });
      },
      async createFolder(path) {
        const target = workspacePath(normalizeFolder(path));
        await ensureDirectory(vault, target);
        notify();
      },
      async createNote(folder, name, kindId = markdownKindId) {
        const kind = registry.get(kindId);
        const creation = kind.creation;
        if (creation === undefined) {
          throw new Error(
            `Document kind ${kindId} cannot create a blank document`,
          );
        }
        const extension = creation.extension.startsWith('.')
          ? creation.extension
          : `.${creation.extension}`;
        if (!/^\.[a-z0-9][a-z0-9._-]*$/i.test(extension)) {
          throw new Error(
            `Document kind ${kindId} has an invalid file extension`,
          );
        }
        const cleanName = sanitizeSegment(name, extension);
        if (cleanName === null || cleanName === '')
          throw new Error(`invalid note name ${JSON.stringify(name)}`);
        const base = normalizeFolder(folder);
        const initial =
          base === ''
            ? `${cleanName}${extension}`
            : `${base}/${cleanName}${extension}`;
        // Never overwrite: an existing note with the same name yields
        // "Name (1).ext", "Name (2).ext", … instead of clobbering bytes.
        const path = await ensureUniquePath(initial);
        const storedName = fileNameOf(path);
        const title = storedName.slice(0, -extension.length) || 'Untitled';
        const ref = await workspace.createDocument({
          kindId,
          path: workspacePath(path),
          initialModel: creation.createInitialModel(title),
        });
        await workspace.rebuildDerivedState();
        notify();
        return String(ref.documentId);
      },
      async moveDocument(documentId, toPath) {
        const target = normalizeDocPath(toPath);
        await workspace.moveDocument(documentId as never, target);
        await workspace.rebuildDerivedState();
        notify();
      },
      async duplicateDocument(documentId) {
        const ref = workspace
          .listDocuments()
          .find((item) => String(item.documentId) === documentId);
        if (!ref) throw new Error('Document unavailable');
        if (workspace.getOpenDocument(ref.documentId)?.dirty)
          throw new Error('Save this document before duplicating it');
        const sourcePath = workspace.resolveResourcePath(
          ref.location.resourceId,
        );
        const targetPath = await ensureUniquePath(String(sourcePath));
        const duplicate = await workspace.duplicateDocument(
          ref.documentId,
          workspacePath(targetPath),
        );
        await workspace.rebuildDerivedState();
        notify();
        return String(duplicate.documentId);
      },
      listTrash() {
        return workspace.listTrashedDocuments().map((record) => ({
          documentId: String(record.documentId),
          path: String(record.originalResource),
          kindId: String(record.kindId),
        }));
      },
      async restoreDocument(documentId) {
        const record = workspace
          .listTrashedDocuments()
          .find((item) => String(item.documentId) === documentId);
        if (!record) throw new Error('Trashed document unavailable');
        const targetPath = await ensureUniquePath(
          String(record.originalResource),
        );
        const restored = await workspace.restoreDocument(
          record.documentId,
          workspacePath(targetPath),
        );
        await workspace.rebuildDerivedState();
        notify();
        return String(restored.documentId);
      },
      async permanentlyDeleteDocument(documentId) {
        await workspace.permanentlyDeleteDocument(documentId as DocumentId);
        notify();
      },
      async moveFolder(fromPath, toPath) {
        const from = normalizeFolder(fromPath);
        const to = normalizeFolder(toPath);
        if (from === to) return;
        if (to.startsWith(`${from}/`))
          throw new Error('cannot move a folder into itself');
        // Move each document record-by-record (moves the file and updates
        // the identity record), then drop the empty directory shells.
        for (const ref of workspace.listDocuments()) {
          const path = String(
            workspace.resolveResourcePath(ref.location.resourceId),
          );
          if (path === from || path.startsWith(`${from}/`)) {
            await workspace.moveDocument(
              ref.documentId,
              workspacePath(`${to}${path.slice(from.length)}`),
            );
          }
        }
        // Also move raw vault files that are not tracked as documents.
        {
          const rawFiles: string[] = [];
          await listVaultFiles(from as WorkspacePath, 0, rawFiles); // Fallback: if from is a directory that itself hasn't been listed as file, also collect direct vault files via broader scan and filter by prefix.
          if (rawFiles.length === 0) {
            const allRaw: string[] = [];
            await listVaultFiles('' as WorkspacePath, 0, allRaw);
            for (const p of allRaw) {
              if (p === from || p.startsWith(`${from}/`)) rawFiles.push(p);
            }
          }
          const workspacePaths = new Set(
            workspace
              .listDocuments()
              .map((r) =>
                String(workspace.resolveResourcePath(r.location.resourceId)),
              ),
          );
          const rawFailures: string[] = [];
          for (const rawPath of rawFiles) {
            if (workspacePaths.has(rawPath)) continue;
            const dest = `${to}${rawPath.slice(from.length)}`;
            try {
              await ensureDirectory(
                vault,
                parentPath(workspacePath(dest)) as WorkspacePath,
              );
              await vault.move(workspacePath(rawPath), workspacePath(dest));
            } catch (error) {
              // Best-effort for raw files, but only for benign races between
              // the scan and the move (vanished source, appeared target).
              // Anything else (permission, quota, I/O) is collected and
              // reported after the remaining files are attempted — silently
              // dropping user bytes would be data loss.
              if (
                isVaultError(error) &&
                (error.code === 'CONFLICT' ||
                  error.code === 'ALREADY_EXISTS' ||
                  error.code === 'NOT_FOUND')
              ) {
                continue;
              }
              rawFailures.push(rawPath);
            }
          }
          if (rawFailures.length > 0) {
            throw new Error(
              `moved folder but ${rawFailures.length} file(s) could not be moved: ${rawFailures.slice(0, 3).join(', ')}${rawFailures.length > 3 ? ', …' : ''}`,
            );
          }
        }
        await removeEmptyDirShells(from as WorkspacePath);
        await workspace.rebuildDerivedState();
        notify();
      },
      async deleteDocument(documentId) {
        await workspace.removeDocument(documentId as never);
        await workspace.rebuildDerivedState();
        notify();
      },
      async deleteFolder(path) {
        const deleted = await deleteFolderRecursive(
          workspacePath(normalizeFolder(path)),
        );
        await workspace.rebuildDerivedState();
        notify();
        return deleted;
      },
      async importFile(targetFolder, fileName, data) {
        if (!service.importFileWithPath)
          throw new Error('File import is unavailable');
        await service.importFileWithPath(targetFolder, fileName, data);
      },
      async importFileWithPath(targetFolder, fileName, data) {
        // Sanitize the incoming file name (Windows names may contain controls; preserve extension).
        const sanitized = fileName
          .replace(/[\\/]/g, '-')
          // eslint-disable-next-line no-control-regex -- intentional NUL strip for file names
          .replace(/\u0000/g, '')
          .trim()
          // eslint-disable-next-line no-control-regex
          .replace(/[\u0000-\u001f]/g, '');
        const baseName = sanitized === '' ? 'Untitled' : sanitized;
        const normalizedFolder = normalizeFolder(targetFolder);
        const initialPath =
          normalizedFolder === ''
            ? baseName
            : `${normalizedFolder}/${baseName}`;
        const dest = await ensureUniquePath(initialPath);
        const dot = dest.lastIndexOf('.');
        const ext = dot === -1 ? '' : dest.slice(dot).toLowerCase();
        const kind = registry.forImportExtension(ext);
        if (kind !== null) {
          const kindId = kind.id;
          const dummyRef = {
            documentId: 'dummy' as never,
            kindId,
            location: { resourceId: 'dummy' as never },
          };
          let model: unknown;
          try {
            const decoded = kind.decode(data, dummyRef);
            model = decoded.model;
          } catch {
            // Decode failed (e.g., corrupt blockpage JSON) → fall back to raw vault file.
            const vaultPath = workspacePath(dest);
            await ensureDirectory(
              vault,
              parentPath(vaultPath) as WorkspacePath,
            );
            await vault.write(vaultPath, data);
            notify();
            return dest;
          }
          const vaultPath = workspacePath(dest);
          await ensureDirectory(vault, parentPath(vaultPath) as WorkspacePath);
          await workspace.createDocument({
            kindId,
            path: vaultPath,
            initialModel: model,
          });
          await workspace.rebuildDerivedState();
          notify();
          return dest;
        }
        // Unknown extension → raw vault file (images, videos, audios, .tex, etc.)
        const vaultPath = workspacePath(dest);
        await ensureDirectory(vault, parentPath(vaultPath) as WorkspacePath);
        await vault.write(vaultPath, data);
        notify();
        return dest;
      },
      async createNotebookFromPdf(sourcePath) {
        if (assetStore === null || pdfProvider === null) {
          throw new Error('PDF import is unavailable in this profile');
        }
        const bytes = await vault.read(workspacePath(sourcePath));
        const title = conversionTitle(sourcePath);
        const asset = await assetStore.put(bytes, {
          suggestedName: 'source.pdf',
        });
        // Verify the stored bytes match the referenced hash before building pages.
        const storedBytes = await assetStore.read(asset.path);
        if ((await sha256Hex(storedBytes)) !== asset.sha256) {
          throw new Error(
            `stored PDF asset hash does not match ${asset.sha256}`,
          );
        }
        const notebook = emptyNotebook(title);
        const handle = await pdfProvider.open({ bytes: storedBytes });
        try {
          for (
            let pageIndex = 0;
            pageIndex < handle.pageCount;
            pageIndex += 1
          ) {
            const info = await handle.getPageInfo(pageIndex);
            const id = freshConversionPageId(pageIndex);
            notebook.pages[id] = pdfNotebookPage(id, {
              asset,
              pageIndex,
              pageBox: info.geometry.pageBox,
            });
            notebook.pageOrder.push(id);
          }
        } finally {
          await handle.close();
        }
        const parent = parentPath(workspacePath(sourcePath));
        const dest = await ensureUniquePath(
          parent === '' ? `${title}.notebook` : `${parent}/${title}.notebook`,
        );
        const ref = await workspace.createDocument({
          kindId: notebookKindId,
          path: workspacePath(dest),
          initialModel: notebook,
        });
        await workspace.rebuildDerivedState();
        notify();
        return String(ref.documentId);
      },
      async createInkFromImage(sourcePath) {
        if (assetStore === null) {
          throw new Error('Ink creation is unavailable in this profile');
        }
        const bytes = await vault.read(workspacePath(sourcePath));
        const name = conversionTitle(sourcePath);
        const asset = await assetStore.put(bytes, {
          suggestedName: sourcePath.split('/').pop() ?? 'image',
        });
        const size = await naturalImageSize(bytes);
        // The canvas starts at the image's size; the image fills it exactly.
        const surface = emptySurface(boundedFrame(size.width, size.height));
        const id = `img-${freshConversionId()}`;
        surface.order.push(id);
        surface.objects[id] = imageObject(id, {
          x: 0,
          y: 0,
          width: size.width,
          height: size.height,
          src: asset.path,
          sha256: asset.sha256,
        });
        const parent = parentPath(workspacePath(sourcePath));
        const dest = await ensureUniquePath(
          parent === '' ? `${name}.ink` : `${parent}/${name}.ink`,
        );
        const ref = await workspace.createDocument({
          kindId: inkPageKindId,
          path: workspacePath(dest),
          initialModel: surface,
        });
        await workspace.rebuildDerivedState();
        notify();
        return String(ref.documentId);
      },
      async moveRawFile(fromPath, toPath) {
        const from = normalizeFolder(fromPath);
        const to = normalizeFolder(toPath);
        if (from === to) return;
        await ensureDirectory(
          vault,
          parentPath(workspacePath(to)) as WorkspacePath,
        );
        await vault.move(workspacePath(from), workspacePath(to));
        notify();
      },
      async deleteRawFile(path) {
        await vault.remove(workspacePath(normalizeFolder(path)));
        notify();
      },
      async readRawFile(path) {
        return vault.read(workspacePath(path));
      },
      async readRawFileBlob(path) {
        const resolved = workspacePath(path);
        if (vault.readFile !== undefined) {
          const file = await vault.readFile(resolved);
          // Web hosts return a real Blob (the OPFS File streams from disk,
          // no full read); a minimal VaultFile is materialized instead.
          if (typeof (file as { stream?: unknown }).stream === 'function') {
            return file as unknown as Blob;
          }
          return new Blob([await file.arrayBuffer()], { type: file.type });
        }
        const bytes = await vault.read(resolved);
        return new Blob([bytes as BlobPart], { type: mimeForPath(path) });
      },
      onDidChange(listener) {
        listeners.add(listener);
        return { dispose: () => listeners.delete(listener) };
      },
      refresh: notify,
    };

    ctx.provide(fileExplorerToken, service);
    ctx.effect(() => () => listeners.clear());
    ctx.effect(() => registry.onDidChange(notify).dispose);
    if (presentations) ctx.effect(() => presentations.onDidChange(notify).dispose);

    const views = ctx.try(viewRegistryToken);
    if (views !== undefined) {
      ctx.effect(
        () =>
          views.register({
            id: 'file-explorer',
            area: 'sidebar',
            title: 'Files',
            component: function FileExplorerViewHost() {
              return createElement(FileExplorerView, {
                service,
                externalDrop,
                presentations,
              });
            },
          }).dispose,
      );
    }
  },
});

function normalizeFolder(path: string): string {
  return path
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
    .join('/');
}

function normalizeDocPath(path: string): WorkspacePath {
  const normalized = normalizeFolder(path);
  const hasExtension = /\.[^/]+$/.test(normalized);
  return workspacePath(hasExtension ? normalized : `${normalized}.md`);
}

function sanitizeSegment(name: string, extension = '.md'): string | null {
  // Intentional control-character strip (the exact case no-control-regex flags).
  const segment = name
    .trim()
    .replace(/\\/g, '-')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, '');
  if (segment === '' || segment === '.' || segment === '..') return null;
  if (!/^[^/]*$/.test(segment)) return null;
  const suffix = extension.startsWith('.') ? extension : `.${extension}`;
  const stem = segment.toLowerCase().endsWith(suffix.toLowerCase())
    ? segment.slice(0, -suffix.length)
    : segment;
  return stem === '' || stem === '.' || stem === '..' ? null : stem;
}

/** True when a vault error means "already exists" (idempotent creates). */
export function isAlreadyExistsError(error: unknown): boolean {
  return isVaultError(error) && error.code === 'ALREADY_EXISTS';
}
