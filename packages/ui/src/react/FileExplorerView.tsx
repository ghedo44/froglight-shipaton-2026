import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parentPath, workspacePath, documentKindId, type DocumentPresentationRegistry } from '@froglight/foundation';
import { PREVIEW_VIEW_ID_PREFIX } from '../view-registry.js';
import { fileNameOf, iconForPath, previewKindForPath } from '../file-kinds.js';
import type { FileTreeNode } from '../file-tree.js';
import { moveTargetPath, type FileExplorerService } from '../file-explorer.js';
import {
  describeDropTransfer,
  importExternalCandidates,
  isExternalFileDrag,
  isExternalFileDrop,
  isInternalNodeDrag,
  resolveExternalDropTarget,
  type ExternalImportCandidate,
} from '../file-explorer.js';
import { FILE_TREE_DRAG_MIME } from '../file-tree.js';
import type { ExternalFileDropService } from '@froglight/foundation';
import { workspaceEvents } from '../ui-events.js';
import { uiConfirm, uiNewNote, uiPrompt } from '../dialogs.js';
import {
  registerContextMenu,
  showContextMenu,
  type MenuEntry,
} from '../menu.js';
import { Icon } from './Icon.jsx';
import { Button, IconButton } from './Button.jsx';
import styles from './FileExplorer.module.css';

const DRAG_MIME = FILE_TREE_DRAG_MIME;
const HOVER_EXPAND_MS = 650;
const TOAST_ERROR_MS = 4000;
const TOAST_INFO_MS = 2500;

function treeRowStyle(depth: number, rootPadding: number): React.CSSProperties {
  if (depth === 0) return { paddingLeft: `${rootPadding}px` };
  const inset = depth * 14 + 14;
  return {
    marginLeft: `${inset}px`,
    width: `calc(100% - ${inset + 2}px)`,
    paddingLeft: '4px',
  };
}

interface DragPayload {
  readonly path: string;
  readonly kind: 'file' | 'folder';
  readonly documentId?: string;
}

interface Toast {
  readonly id: number;
  readonly text: string;
  readonly muted: boolean;
}

interface CollectedTree {
  readonly knownIds: ReadonlySet<string>;
  readonly pathById: ReadonlyMap<string, string>;
  readonly knownPaths: ReadonlySet<string>;
}

function collectTree(tree: readonly FileTreeNode[]): CollectedTree {
  const knownIds = new Set<string>();
  const pathById = new Map<string, string>();
  const knownPaths = new Set<string>();
  const walk = (nodes: readonly FileTreeNode[]): void => {
    for (const node of nodes) {
      if (node.kind === 'file') {
        knownPaths.add(node.path);
        if (node.documentId !== undefined) {
          knownIds.add(node.documentId);
          pathById.set(node.documentId, node.path);
        }
      } else {
        walk(node.children);
      }
    }
  };
  walk(tree);
  return { knownIds, pathById, knownPaths };
}

function readPayload(dataTransfer: DataTransfer | null): DragPayload | null {
  if (dataTransfer === null) return null;
  const raw = dataTransfer.getData(DRAG_MIME);
  if (raw === '') return null;
  try {
    const parsed = JSON.parse(raw) as Partial<DragPayload>;
    if (
      typeof parsed.path !== 'string' ||
      parsed.path === '' ||
      (parsed.kind !== 'file' && parsed.kind !== 'folder')
    ) {
      return null;
    }
    return {
      path: parsed.path,
      kind: parsed.kind,
      ...(typeof parsed.documentId === 'string'
        ? { documentId: parsed.documentId }
        : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Dragover guard. `getData` is blocked in protected mode during dragover,
 * so availability must be checked against the type list; the payload is
 * only read at drop time.
 */
function hasDragPayload(dataTransfer: DataTransfer | null): boolean {
  // Hardened for Linux WebKitGTK/Firefox where `types` is a DOMStringList
  // without `.includes` — a direct call throws and kills dragover before
  // `preventDefault()` (block pointer, dead drops).
  return isInternalNodeDrag(dataTransfer);
}

function hasExternalFiles(dataTransfer: DataTransfer | null): boolean {
  // Shared WebKit-compatible guard: during dragover `files` may be empty,
  // so availability is checked against the type list only.
  return isExternalFileDrag(dataTransfer);
}

function hasExternalFilesAtDrop(dataTransfer: DataTransfer | null): boolean {
  return isExternalFileDrop(dataTransfer);
}

/**
 * Engine diagnostic: a drop reached the tree but neither the external nor
 * the internal guard recognized it. Logged (debug level, no PII — type
 * names and a file count only) so an engine quirk can be identified from a
 * user report without reproducing their OS/WebView combination.
 */
function logUnrecognizedDrop(dataTransfer: DataTransfer | null): void {
  try {
    console.debug(
      '[file-explorer] unrecognized drop',
      describeDropTransfer(dataTransfer),
    );
  } catch {
    // Diagnostics must never break drop handling.
  }
}

export interface FileExplorerViewProps {
  readonly service: FileExplorerService;
  readonly presentations?: DocumentPresentationRegistry | null;
  readonly activeDocumentId?: string;
  readonly activePreviewPath?: string;
  /**
   * Optional native file-drop source (`froglight.file-drop`). Absent on
   * web/desktop hosts where the browser HTML5 path is primary; bound on
   * Android where WebView drops are unreliable. When present, native
   * enter/over/leave/drop drive the same drop-target visuals and the same
   * `importExternalCandidates` seam as browser `DataTransfer` drops.
   */
  readonly externalDrop?: ExternalFileDropService | null;
}

/**
 * File explorer — declarative React over `FileExplorerService`.
 *
 * Styles: ./FileExplorer.module.css imported explicitly, so the import
 * trail names the stylesheet (components layer).
 *
 * Converted from the imperative `renderFileExplorer` builder with identical
 * user-visible behavior: same DOM structure, classes, datasets, indentation,
 * drag/drop outcomes, menus, dialogs, toasts, and reveal/scroll policy. The
 * service stays the framework-free source of truth; this component owns only
 * presentation state (expanded folders, active highlight, toasts, drop
 * marks). Registered as `component`, never `render`.
 */
export function FileExplorerView(
  props: FileExplorerViewProps,
): React.ReactElement {
  const { service } = props;
  const [tree, setTree] = useState<readonly FileTreeNode[]>([]);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  const [activeDocumentId, setActiveDocumentId] = useState<string | undefined>(
    props.activeDocumentId,
  );
  const [activePreviewPath, setActivePreviewPath] = useState<
    string | undefined
  >(props.activePreviewPath);
  const [toasts, setToasts] = useState<readonly Toast[]>([]);
  const [trash, setTrash] = useState<
    ReturnType<FileExplorerService['listTrash']>
  >([]);
  const [trashOpen, setTrashOpen] = useState(false);
  /** Bumped whenever the active row must be scrolled into view. */
  const [revealSeq, setRevealSeq] = useState(0);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const aliveRef = useRef(true);
  const toastIdRef = useRef(0);
  const timersRef = useRef(new Set<ReturnType<typeof setTimeout>>());
  const dragRef = useRef<{
    marked: HTMLElement | null;
    mode: 'into' | 'beside' | null;
    active: DragPayload | null;
    timer: ReturnType<typeof setTimeout> | null;
  }>({ marked: null, mode: null, active: null, timer: null });

  const collected = useMemo(() => collectTree(tree), [tree]);

  const later = useCallback((ms: number, task: () => void): void => {
    const timer = setTimeout(() => {
      timersRef.current.delete(timer);
      if (aliveRef.current) task();
    }, ms);
    timersRef.current.add(timer);
  }, []);

  const pushToast = useCallback(
    (text: string, muted: boolean, ms: number): void => {
      toastIdRef.current += 1;
      const id = toastIdRef.current;
      setToasts((current) => [...current, { id, text, muted }]);
      later(ms, () => {
        setToasts((current) => current.filter((toast) => toast.id !== id));
      });
    },
    [later],
  );

  const reportError = useCallback(
    (error: unknown): void => {
      pushToast(
        error instanceof Error ? error.message : String(error),
        false,
        TOAST_ERROR_MS,
      );
    },
    [pushToast],
  );

  const refresh = useCallback(async (): Promise<readonly FileTreeNode[]> => {
    const next = await service.tree();
    if (!aliveRef.current) return next;
    setTree(next);
    setTrash(service.listTrash());
    return next;
  }, [service]);

  const dispatch = useCallback((type: string, detail: unknown): void => {
    rootRef.current?.dispatchEvent(
      new CustomEvent(type, { detail, bubbles: true }),
    );
  }, []);

  const openDocument = useCallback(
    (documentId: string): void => {
      dispatch(workspaceEvents.open, { documentId });
    },
    [dispatch],
  );

  // ------------------------------------------------------------ row actions
  const previewRawFile = useCallback(
    async (path: string): Promise<void> => {
      dispatch(workspaceEvents.openPreview, { path });
    },
    [dispatch],
  );

  const importVaultPdfAsNotebook = useCallback(
    async (path: string): Promise<void> => {
      try {
        let bytes = await service.readRawFile(path);
        // Vault providers from another bundle realm may hand back a
        // Uint8Array subclass the shell's instanceof check would reject;
        // normalize only when needed so same-realm bytes stay zero-copy.
        if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
        dispatch(workspaceEvents.importPdf, {
          name: fileNameOf(path),
          bytes,
        });
      } catch (error) {
        reportError(error);
      }
    },
    [dispatch, reportError, service],
  );

  const convertRawFile = useCallback(
    async (path: string): Promise<void> => {
      try {
        const documentId = await service.createInkFromImage(path);
        await refresh();
        openDocument(documentId);
      } catch (error) {
        reportError(error);
      }
    },
    [openDocument, refresh, reportError, service],
  );

  const runCreateNote = useCallback(
    async (folder: string, initialKindId?: string): Promise<void> => {
      const creatableKinds = service.creatableKinds();
      const choice = await uiNewNote({
        kinds: creatableKinds,
        ...(initialKindId === undefined ? {} : { initialKindId }),
      });
      if (choice === null || choice.kind.kindId === null) return;
      const documentId = await service.createNote(
        folder,
        choice.name,
        choice.kind.kindId,
      );
      setExpanded((current) => new Set(current).add(folder));
      await refresh();
      openDocument(documentId);
    },
    [openDocument, refresh, service],
  );

  const runCreateFolder = useCallback(
    async (folder: string): Promise<void> => {
      const name = await uiPrompt('New folder', { placeholder: 'Folder name' });
      if (name === null) return;
      await service.createFolder(folder === '' ? name : `${folder}/${name}`);
      setExpanded((current) => {
        const next = new Set(current);
        next.add(folder === '' ? name : `${folder}/${name}`);
        next.add(folder);
        return next;
      });
      await refresh();
    },
    [refresh, service],
  );

  const runRenameFolder = useCallback(
    async (path: string): Promise<void> => {
      const currentName = path.split('/').pop() ?? path;
      const name = await uiPrompt('Rename folder', {
        initialValue: currentName,
        description: 'Renaming moves every note inside this folder.',
      });
      if (name === null || name === currentName) return;
      const slash = path.lastIndexOf('/');
      const parent = slash === -1 ? '' : path.slice(0, slash);
      const next = parent === '' ? name : `${parent}/${name}`;
      await service.moveFolder(path, next);
      setExpanded((current) => {
        const updated = new Set(current);
        updated.delete(path);
        updated.add(next);
        return updated;
      });
      await refresh();
    },
    [refresh, service],
  );

  const runDeleteFolder = useCallback(
    async (path: string, name: string): Promise<void> => {
      const ok = await uiConfirm(
        `Move documents in “${name}” to Trash?`,
        'Documents inside this folder will move to Trash. Move any other files separately before deleting the folder.',
        'Move to Trash',
      );
      if (!ok) return;
      await service.deleteFolder(path);
      // Canonical bytes are gone but workbench tabs still reference them:
      // ask the shell to prune dangling tabs (folder deletes remove several
      // at once, so the shell diffs instead of trusting an id list).
      dispatch(workspaceEvents.documentsDeleted, { folder: path });
      await refresh();
    },
    [dispatch, refresh, service],
  );

  const runRenameFile = useCallback(
    async (id: string, path: string, fileName: string): Promise<void> => {
      const dot = fileName.lastIndexOf('.');
      const ext = dot > 0 ? fileName.slice(dot) : '.md';
      const name = await uiPrompt('Rename note', {
        initialValue: path,
        confirmLabel: 'Save',
        description: `Enter a path relative to this vault. The ${ext} extension is preserved.`,
      });
      if (name === null) return;
      const trimmed = name.trim();
      if (trimmed === '') return;
      const next = trimmed.endsWith(ext) ? trimmed : `${trimmed}${ext}`;
      if (next === path) return;
      try {
        await service.moveDocument(id, next);
      } catch (error) {
        reportError(error);
        return;
      }
      await refresh();
    },
    [refresh, reportError, service],
  );

  const runDuplicateFile = useCallback(
    async (id: string): Promise<void> => {
      try {
        const duplicateId = await service.duplicateDocument(id);
        await refresh();
        openDocument(duplicateId);
      } catch (error) {
        reportError(error);
      }
    },
    [openDocument, refresh, reportError, service],
  );

  const runDeleteFile = useCallback(
    async (id: string, fileName: string): Promise<void> => {
      const ok = await uiConfirm(
        `Move “${fileName}” to Trash?`,
        'You can restore this document from Trash later.',
        'Move to Trash',
      );
      if (!ok) return;
      await service.deleteDocument(id);
      // The controller owns tab strips but the service removed the bytes
      // directly: notify the shell so dangling tabs are pruned before the
      // next click can throw `unknown document`.
      dispatch(workspaceEvents.documentsDeleted, { documentIds: [id] });
      await refresh();
    },
    [dispatch, refresh, service],
  );

  const runRestoreFile = useCallback(
    async (id: string): Promise<void> => {
      try {
        const restoredId = await service.restoreDocument(id);
        await refresh();
        openDocument(restoredId);
      } catch (error) {
        reportError(error);
      }
    },
    [openDocument, refresh, reportError, service],
  );

  const runPermanentDelete = useCallback(
    async (id: string, name: string): Promise<void> => {
      const confirmed = await uiConfirm(
        `Delete “${name}” permanently?`,
        'This removes the trashed document and its properties. It cannot be restored.',
      );
      if (!confirmed) return;
      try {
        await service.permanentlyDeleteDocument(id);
        await refresh();
      } catch (error) {
        reportError(error);
      }
    },
    [refresh, reportError, service],
  );

  const runRenameRawFile = useCallback(
    async (path: string): Promise<void> => {
      const name = await uiPrompt('Rename file', {
        initialValue: path,
        confirmLabel: 'Save',
        description:
          'Enter a path relative to this vault, including the filename and extension.',
      });
      const next = name?.trim();
      if (next === undefined || next === '' || next === path) return;
      try {
        await service.moveRawFile(path, next);
      } catch (error) {
        reportError(error);
        return;
      }
      dispatch(workspaceEvents.previewMoved, { from: path, to: next });
      await refresh();
    },
    [dispatch, refresh, reportError, service],
  );

  const runDeleteRawFile = useCallback(
    async (path: string, fileName: string): Promise<void> => {
      const ok = await uiConfirm(
        `Delete “${fileName}”?`,
        'The file will be removed from your vault.',
      );
      if (!ok) return;
      await service.deleteRawFile(path);
      dispatch(workspaceEvents.previewDeleted, { path });
      await refresh();
    },
    [dispatch, refresh, service],
  );

  // ------------------------------------------------------------------ menus
  const fileMenuEntries = useCallback(
    (id: string, path: string, name: string): MenuEntry[] => {
      const icon = iconForPath(path);
      const entries: MenuEntry[] = [
        { label: 'Open', icon, run: () => openDocument(id) },
        {
          label: 'Open in new tab',
          run: () => {
            dispatch(workspaceEvents.openBackground, { documentId: id });
          },
        },
      ];
      if (previewKindForPath(path) === 'pdf') {
        entries.push({
          label: 'Import as notebook',
          icon: 'notebook',
          run: () => void importVaultPdfAsNotebook(path),
        });
      }
      entries.push(
        'separator',
        {
          label: 'Rename / move',
          run: () => void runRenameFile(id, path, name),
        },
        {
          label: 'Duplicate',
          run: () => void runDuplicateFile(id),
        },
        {
          label: 'Delete',
          danger: true,
          run: () => void runDeleteFile(id, name),
        },
      );
      return entries;
    },
    [
      dispatch,
      importVaultPdfAsNotebook,
      openDocument,
      runDuplicateFile,
      runDeleteFile,
      runRenameFile,
    ],
  );

  const rawFileMenuEntries = useCallback(
    (path: string, name: string): MenuEntry[] => {
      const entries: MenuEntry[] = [
        {
          label: 'Preview',
          icon: iconForPath(path),
          run: () => void previewRawFile(path),
        },
        {
          label: 'Open in new tab',
          run: () => {
            dispatch(workspaceEvents.openBackground, {
              viewId: `${PREVIEW_VIEW_ID_PREFIX}${path}`,
            });
          },
        },
      ];
      // One-step conversions: the source file always stays untouched.
      if (previewKindForPath(path) === 'pdf') {
        entries.push({
          label: 'Import as notebook',
          icon: 'notebook',
          run: () => void importVaultPdfAsNotebook(path),
        });
      }
      if (previewKindForPath(path) === 'image') {
        entries.push({
          label: 'Create ink drawing',
          icon: 'ink',
          run: () => void convertRawFile(path),
        });
      }
      entries.push(
        {
          label: 'Rename / move',
          run: () => void runRenameRawFile(path),
        },
        {
          label: 'Delete',
          danger: true,
          run: () => void runDeleteRawFile(path, name),
        },
      );
      return entries;
    },
    [
      convertRawFile,
      dispatch,
      importVaultPdfAsNotebook,
      previewRawFile,
      runDeleteRawFile,
      runRenameRawFile,
    ],
  );

  const folderMenuEntries = useCallback(
    (folderPath: string): MenuEntry[] => [
      {
        label: 'New note',
        icon: 'file-plus',
        run: () => void runCreateNote(folderPath),
      },
      {
        label: 'New subfolder',
        icon: 'folder-plus',
        run: () => void runCreateFolder(folderPath),
      },
      { label: 'Rename', run: () => void runRenameFolder(folderPath) },
      {
        label: 'Delete',
        danger: true,
        run: () => {
          const segments = folderPath.split('/');
          const folderName = segments[segments.length - 1] ?? folderPath;
          void runDeleteFolder(folderPath, folderName);
        },
      },
    ],
    [runCreateFolder, runCreateNote, runDeleteFolder, runRenameFolder],
  );

  // ------------------------------------------------------- active highlight
  /**
   * Highlight the workspace's active document or raw-file preview. A changed
   * id/path (or an explicit reveal request from a user-driven open) expands
   * ancestor folders and scrolls the row into view; same-id notifies only
   * keep the class in sync so background state changes never yank the user's
   * scroll position.
   */
  const expandAncestors = useCallback((path: string): void => {
    const segments = path.split('/');
    segments.pop();
    let prefix = '';
    const ancestors: string[] = [];
    for (const segment of segments) {
      prefix = prefix === '' ? segment : `${prefix}/${segment}`;
      ancestors.push(prefix);
    }
    if (ancestors.length === 0) return;
    setExpanded((current) => {
      let changed = false;
      const next = new Set(current);
      for (const ancestor of ancestors) {
        if (!next.has(ancestor)) {
          next.add(ancestor);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, []);

  const setActiveDocument = useCallback(
    async (
      documentId: string | null,
      reveal: boolean,
      previewPath: string | null,
    ): Promise<void> => {
      const nextDoc = documentId ?? undefined;
      const nextPreview = previewPath ?? undefined;
      if (
        nextDoc === activeDocumentId &&
        nextPreview === activePreviewPath &&
        !reveal
      ) {
        return;
      }
      const changed =
        nextDoc !== activeDocumentId || nextPreview !== activePreviewPath;
      setActiveDocumentId(nextDoc);
      setActivePreviewPath(nextPreview);
      if (nextDoc === undefined && nextPreview === undefined) return;
      const targetPath =
        nextDoc !== undefined ? collected.pathById.get(nextDoc) : nextPreview;
      if (targetPath === undefined) {
        if (changed) {
          // A note created elsewhere (e.g. the first-run welcome note):
          // rebuild so the row exists, then reveal it.
          const next = await refresh();
          const after = collectTree(next);
          const found =
            nextDoc !== undefined ? after.pathById.get(nextDoc) : nextPreview;
          if (found === undefined) return;
          expandAncestors(found);
          setRevealSeq((seq) => seq + 1);
        }
        return;
      }
      if (changed || reveal) {
        expandAncestors(targetPath);
        setRevealSeq((seq) => seq + 1);
      }
    },
    [activeDocumentId, activePreviewPath, collected, expandAncestors, refresh],
  );

  // Scroll the active row into view only when a reveal was requested —
  // class sync itself is derived during render.
  useEffect(() => {
    if (revealSeq === 0) return;
    const row = bodyRef.current?.querySelector<HTMLElement>(
      `.${styles['tree-row']}.${styles['tree-file']}.${styles.active}`,
    );
    // happy-dom and some test environments lack scrollIntoView; scrolling is
    // a progressive enhancement, never a correctness requirement.
    if (
      row !== null &&
      row !== undefined &&
      typeof row.scrollIntoView === 'function'
    ) {
      row.scrollIntoView({ block: 'nearest' });
    }
  }, [revealSeq, tree, expanded]);

  // ------------------------------------------------------------ dep targets
  const clearDropMark = useCallback((): void => {
    const drag = dragRef.current;
    if (drag.marked !== null) {
      drag.marked.classList.remove(
        styles['drop-target'],
        styles['drop-beside'],
      );
      drag.marked = null;
      drag.mode = null;
    }
    if (drag.timer !== null) {
      clearTimeout(drag.timer);
      drag.timer = null;
    }
    bodyRef.current?.classList.remove(styles['drop-root']);
  }, []);

  useEffect(() => () => clearDropMark(), [clearDropMark]);

  const markRow = useCallback(
    (row: HTMLElement, mode: 'into' | 'beside'): void => {
      const drag = dragRef.current;
      if (drag.marked !== row || drag.mode !== mode) {
        clearDropMark();
        drag.marked = row;
        drag.mode = mode;
        row.classList.add(
          mode === 'into' ? styles['drop-target'] : styles['drop-beside'],
        );
      }
      bodyRef.current?.classList.remove(styles['drop-root']);
    },
    [clearDropMark],
  );

  const scheduleHoverExpand = useCallback(
    (folderPath: string, isOpen: boolean): void => {
      const drag = dragRef.current;
      if (isOpen || drag.timer !== null) return;
      drag.timer = setTimeout(() => {
        drag.timer = null;
        if (!aliveRef.current) return;
        setExpanded((current) => {
          if (current.has(folderPath)) return current;
          const next = new Set(current);
          next.add(folderPath);
          return next;
        });
        // Refresh rebuilds the rows; re-apply the drop highlight so the
        // target does not visually lose focus mid-drag.
        void refresh().then(() => {
          if (!aliveRef.current) return;
          const fresh = bodyRef.current?.querySelector<HTMLElement>(
            `.${styles['tree-row']}.${styles['tree-folder']}[data-path="${CSS.escape(folderPath)}"]`,
          );
          if (fresh !== null && fresh !== undefined) markRow(fresh, 'into');
        });
      }, HOVER_EXPAND_MS);
    },
    [markRow, refresh],
  );

  const handleDrop = useCallback(
    async (
      dataTransfer: DataTransfer | null,
      targetFolder: string,
    ): Promise<void> => {
      const payload = readPayload(dataTransfer);
      if (payload === null) return;
      const destination = moveTargetPath(
        payload.path,
        payload.kind === 'folder',
        targetFolder,
      );
      if (destination === null) return;
      try {
        if (payload.kind === 'folder') {
          await service.moveFolder(payload.path, destination);
          setExpanded((current) => {
            const next = new Set(current);
            next.delete(payload.path);
            next.add(destination);
            return next;
          });
        } else if (payload.documentId !== undefined) {
          await service.moveDocument(payload.documentId, destination);
        } else {
          // Raw vault file (no documentId) — move via vault.
          await service.moveRawFile(payload.path, destination);
        }
        setExpanded((current) => new Set(current).add(targetFolder));
        await refresh();
      } catch (error) {
        reportError(error);
      }
    },
    [refresh, reportError, service],
  );

  const handleExternalDrop = useCallback(
    async (
      dataTransfer: DataTransfer | null,
      targetFolder: string,
    ): Promise<void> => {
      if (!isExternalFileDrop(dataTransfer)) return;
      const files = [...(dataTransfer as DataTransfer).files];
      if (files.length === 0) return;
      // Windows/OS drops may contain directories as files with empty type; we
      // filter to actual files. Traversing subdirectories via webkitGetAsEntry
      // is deferred — files inside dropped folders are not auto-imported yet.
      const candidates: readonly ExternalImportCandidate[] = files.map(
        (file) => ({
          name: file.name,
          readBytes: async () => new Uint8Array(await file.arrayBuffer()),
        }),
      );
      const { imported, failed, errors } = await importExternalCandidates(
        service,
        candidates,
        targetFolder,
      );
      for (const error of errors) reportError(error);
      if (imported > 0) {
        setExpanded((current) => new Set(current).add(targetFolder));
        await refresh();
        if (failed === 0) {
          pushToast(
            imported === 1
              ? `Imported 1 file into "${targetFolder || '/'}".`
              : `Imported ${imported} files into "${targetFolder || '/'}".`,
            true,
            TOAST_INFO_MS,
          );
        }
      }
    },
    [pushToast, refresh, reportError, service],
  );

  const handleNativeCandidates = useCallback(
    async (
      candidates: readonly ExternalImportCandidate[],
      targetFolder: string,
    ): Promise<void> => {
      if (candidates.length === 0) return;
      const { imported, failed, errors } = await importExternalCandidates(
        service,
        candidates,
        targetFolder,
      );
      for (const error of errors) reportError(error);
      if (imported > 0) {
        setExpanded((current) => new Set(current).add(targetFolder));
        await refresh();
        if (failed === 0) {
          pushToast(
            imported === 1
              ? `Imported 1 file into "${targetFolder || '/'}".`
              : `Imported ${imported} files into "${targetFolder || '/'}".`,
            true,
            TOAST_INFO_MS,
          );
        }
      }
    },
    [pushToast, refresh, reportError, service],
  );

  const markNativePosition = useCallback(
    (x: number, y: number): void => {
      const root = rootRef.current;
      if (root === null) return;
      const doc = root.ownerDocument;
      const fromPoint = (
        doc as Document & {
          elementFromPoint?: (x: number, y: number) => Element | null;
        }
      ).elementFromPoint;
      let hit: Element | null = null;
      try {
        hit =
          typeof fromPoint === 'function' ? fromPoint.call(doc, x, y) : null;
      } catch {
        hit = null;
      }
      if (hit === null || !root.contains(hit)) {
        clearDropMark();
        bodyRef.current?.classList.remove(styles['external-drop']);
        return;
      }
      const element = hit as HTMLElement;
      const datasetRow =
        typeof element.closest === 'function'
          ? (element.closest('[data-path]') as HTMLElement | null)
          : null;
      if (datasetRow !== null && root.contains(datasetRow)) {
        const kind = datasetRow.dataset.kind;
        const path = datasetRow.dataset.path ?? '';
        if (kind === 'folder' && path !== '') {
          markRow(datasetRow, 'into');
          const isOpen = datasetRow.classList.contains(styles.open);
          scheduleHoverExpand(path, isOpen);
          return;
        }
        if (kind === 'file') {
          markRow(datasetRow, 'beside');
          return;
        }
      }
      clearDropMark();
      bodyRef.current?.classList.add(styles['drop-root']);
      bodyRef.current?.classList.add(styles['external-drop']);
    },
    [clearDropMark, markRow, scheduleHoverExpand],
  );

  // Native file-drop source (Android): same visuals and same import seam as
  // browser DataTransfer drops. No-op when the host leaves the token
  // unbound (web/desktop keep the HTML5 path).
  useEffect(() => {
    const source = props.externalDrop ?? null;
    if (source === null || source === undefined) return undefined;
    const sub = source.listen((event) => {
      if (event.type === 'enter' || event.type === 'over') {
        markNativePosition(event.position.x, event.position.y);
        return;
      }
      if (event.type === 'leave') {
        clearDropMark();
        bodyRef.current?.classList.remove(styles['external-drop']);
        return;
      }
      if (event.type !== 'drop') return;
      const root = rootRef.current;
      if (root === null) return;
      const target = resolveExternalDropTarget(
        root,
        event.position.x,
        event.position.y,
      );
      clearDropMark();
      bodyRef.current?.classList.remove(styles['external-drop']);
      if (target === null) {
        // Rejected (outside the explorer): release native tokens so the
        // host drops its temporary URI permissions instead of leaking them.
        for (const file of event.files) {
          try {
            void file.release?.();
          } catch {
            // Release is best-effort.
          }
        }
        return;
      }
      void handleNativeCandidates(event.files, target);
    });
    return () => sub.dispose();
  }, [
    props.externalDrop,
    markNativePosition,
    clearDropMark,
    handleNativeCandidates,
  ]);

  // ----------------------------------------------------------------- mount
  useEffect(() => {
    aliveRef.current = true;
    void refresh();
    const subscription = service.onDidChange(() => {
      void refresh();
    });
    return () => {
      aliveRef.current = false;
      subscription.dispose();
    };
  }, [refresh, service]);

  // The shell publishes the focused pane's active document or raw-file
  // preview; the explorer mirrors it onto tree rows (rebuilding only when
  // the row does not exist yet).
  useEffect(() => {
    const activeListener = (event: Event): void => {
      const detail = event instanceof CustomEvent ? event.detail : null;
      if (detail === null || typeof detail !== 'object') return;
      const detailRecord = detail as {
        documentId?: unknown;
        previewPath?: unknown;
        viewId?: unknown;
        reveal?: unknown;
      };
      const previewFromViewId =
        typeof detailRecord.viewId === 'string' &&
        detailRecord.viewId.startsWith(PREVIEW_VIEW_ID_PREFIX)
          ? detailRecord.viewId.slice(PREVIEW_VIEW_ID_PREFIX.length)
          : null;
      const previewPath =
        typeof detailRecord.previewPath === 'string'
          ? detailRecord.previewPath
          : previewFromViewId;
      void setActiveDocument(
        typeof detailRecord.documentId === 'string'
          ? detailRecord.documentId
          : null,
        detailRecord.reveal === true,
        previewPath,
      );
    };
    document.addEventListener(workspaceEvents.activeDocument, activeListener);
    return () => {
      document.removeEventListener(
        workspaceEvents.activeDocument,
        activeListener,
      );
    };
  }, [setActiveDocument]);

  useEffect(
    () => () => {
      aliveRef.current = false;
      for (const timer of timersRef.current) clearTimeout(timer);
      timersRef.current.clear();
      if (dragRef.current.timer !== null) {
        clearTimeout(dragRef.current.timer);
        dragRef.current.timer = null;
      }
    },
    [],
  );

  // ------------------------------------------------------------------ rows
  const attachMenu = useCallback(
    (getEntries: () => MenuEntry[]) =>
      (element: HTMLElement | null): void | (() => void) => {
        if (element === null) return undefined;
        const registration = registerContextMenu(element, () => getEntries());
        return () => registration.dispose();
      },
    [],
  );

  const onHeaderImportPdf = useCallback((): void => {
    fileInputRef.current?.click();
  }, []);

  const onHeaderImportImage = useCallback((): void => {
    imageInputRef.current?.click();
  }, []);

  const onHeaderImportFile = useCallback((): void => {
    importInputRef.current?.click();
  }, []);

  const onPdfInputChange = useCallback((): void => {
    const input = fileInputRef.current;
    const file = input?.files?.[0];
    if (input !== null) input.value = '';
    if (file === undefined) return;
    void file.arrayBuffer().then(
      (buffer) => {
        dispatch(workspaceEvents.importPdf, {
          name: file.name,
          bytes: new Uint8Array(buffer),
        });
      },
      (error: unknown) => reportError(error),
    );
  }, [dispatch, reportError]);

  const onImageInputChange = useCallback((): void => {
    const input = imageInputRef.current;
    const files = Array.from(input?.files ?? []);
    if (input !== null) input.value = '';
    void (async () => {
      for (const file of files) {
        try {
          if (service.importFileWithPath === undefined) {
            throw new Error('Image import is unavailable');
          }
          const path = await service.importFileWithPath(
            '',
            file.name,
            new Uint8Array(await file.arrayBuffer()),
          );
          const documentId = await service.createInkFromImage(path);
          await service.deleteRawFile(path);
          await refresh();
          openDocument(documentId);
        } catch (error) {
          reportError(error);
        }
      }
    })();
  }, [openDocument, refresh, reportError, service]);

  const onFileInputChange = useCallback((): void => {
    const input = importInputRef.current;
    const files = Array.from(input?.files ?? []);
    if (input !== null) input.value = '';
    void (async () => {
      const result = await importExternalCandidates(
        service,
        files.map((file) => ({
          name: file.name,
          readBytes: async () => new Uint8Array(await file.arrayBuffer()),
        })),
        '',
      );
      if (result.imported > 0) await refresh();
      for (const error of result.errors) reportError(error);
    })().catch(reportError);
  }, [refresh, reportError, service]);

  const onHeaderCreateFolder = useCallback((): void => {
    void runCreateFolder('').catch((error: unknown) => reportError(error));
  }, [reportError, runCreateFolder]);

  const onOpenCreateMenu = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>): void => {
      showContextMenu(
        [
          {
            label: 'New document',
            icon: 'file-plus',
            run: () => void runCreateNote('').catch(reportError),
          },
          {
            label: 'New folder',
            icon: 'folder-plus',
            run: onHeaderCreateFolder,
          },
          'separator',
          {
            label: 'Import PDF as notebook',
            icon: 'file-import',
            run: onHeaderImportPdf,
          },
          {
            label: 'Import image as ink',
            icon: 'file-image',
            run: onHeaderImportImage,
          },
          {
            label: 'Import file',
            icon: 'file-import',
            run: onHeaderImportFile,
          },
        ],
        event.currentTarget,
      );
    },
    [
      onHeaderCreateFolder,
      onHeaderImportFile,
      onHeaderImportImage,
      onHeaderImportPdf,
      reportError,
      runCreateNote,
    ],
  );

  const toggleFolder = useCallback((folderPath: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(folderPath)) next.delete(folderPath);
      else next.add(folderPath);
      return next;
    });
  }, []);

  const renderNode = useCallback(
    (node: FileTreeNode, depth: number): React.ReactElement => {
      if (node.kind === 'folder') {
        const isOpen = expanded.has(node.path);
        return (
          <div key={node.path}>
            {/* Row container: no interactive role. Activation lives in the
                dedicated inner button so the sibling menu button is never
                nested inside another control; drag/drop and the context
                menu stay on the container. Direct clicks on row padding or
                indent forward to the button so single-click opens anywhere
                on the row (no role/tabIndex/keys here — keyboard users
                operate the button itself). */}
            <div
              className={`${styles['tree-row']} ${styles['tree-folder']}${isOpen ? ` ${styles.open}` : ''}`}
              data-path={node.path}
              data-kind="folder"
              draggable
              style={treeRowStyle(depth, 0)}
              onClick={(event) => {
                if (event.target !== event.currentTarget) return;
                event.currentTarget
                  .querySelector<HTMLButtonElement>(
                    `button.${styles['tree-activate']}`,
                  )
                  ?.click();
              }}
              onDragStart={(event) => {
                event.dataTransfer?.setData(
                  DRAG_MIME,
                  JSON.stringify({ path: node.path, kind: 'folder' }),
                );
                event.dataTransfer?.setData('text/plain', node.path);
                if (event.dataTransfer) {
                  event.dataTransfer.effectAllowed = 'move';
                }
                dragRef.current.active = { path: node.path, kind: 'folder' };
                event.currentTarget.classList.add(styles.dragging);
                rootRef.current?.classList.add(styles.dragging);
              }}
              onDragEnd={(event) => {
                dragRef.current.active = null;
                event.currentTarget.classList.remove(styles.dragging);
                rootRef.current?.classList.remove(styles.dragging);
                clearDropMark();
              }}
              onDragOver={(event) => {
                const dt = event.dataTransfer;
                if (hasDragPayload(dt)) {
                  if (
                    dragRef.current.active === null ||
                    dragRef.current.active.path === node.path
                  ) {
                    return;
                  }
                  event.preventDefault();
                  event.stopPropagation();
                  dt.dropEffect = 'move';
                  markRow(event.currentTarget, 'into');
                  scheduleHoverExpand(node.path, isOpen);
                  return;
                }
                if (hasExternalFiles(dt)) {
                  event.preventDefault();
                  event.stopPropagation();
                  dt.dropEffect = 'copy';
                  markRow(event.currentTarget, 'into');
                  scheduleHoverExpand(node.path, isOpen);
                }
              }}
              onDragLeave={() => {
                const marked = dragRef.current.marked;
                if (marked !== null && marked.dataset.path === node.path) {
                  clearDropMark();
                }
              }}
              onDrop={(event) => {
                event.preventDefault();
                event.stopPropagation();
                clearDropMark();
                if (hasExternalFilesAtDrop(event.dataTransfer)) {
                  void handleExternalDrop(event.dataTransfer, node.path);
                  return;
                }
                if (readPayload(event.dataTransfer) === null) {
                  logUnrecognizedDrop(event.dataTransfer);
                }
                void handleDrop(event.dataTransfer, node.path);
              }}
              ref={attachMenu(() => folderMenuEntries(node.path))}
            >
              <button
                type="button"
                className={styles['tree-activate']}
                aria-expanded={isOpen}
                onClick={() => toggleFolder(node.path)}
              >
                <span className={styles['tree-caret']}>
                  <Icon name="chevron-right" size={12} />
                </span>
                <span className={styles['tree-folder-icon']}>
                  <Icon name={isOpen ? 'folder-open' : 'folder'} size={15} />
                </span>
                <span className={styles['tree-label']}>{node.name}</span>
              </button>
              <IconButton
                icon="more"
                size={16}
                label={`${node.name} options`}
                title={`${node.name} options`}
                className={`icon-more ${styles['row-menu']}`}
                onClick={(event) => {
                  event.stopPropagation();
                  showContextMenu(
                    folderMenuEntries(node.path),
                    event.currentTarget,
                  );
                }}
              />
            </div>
            {isOpen ? (
              <div
                className={styles['tree-children']}
                style={
                  { '--tree-indent': `${depth * 14}px` } as React.CSSProperties
                }
              >
                {node.children.map((child) => renderNode(child, depth + 1))}
              </div>
            ) : null}
          </div>
        );
      }
      const isActive =
        node.documentId !== undefined
          ? activeDocumentId === node.documentId
          : activePreviewPath === node.path;
      const rowMenuEntries =
        node.documentId !== undefined
          ? fileMenuEntries(node.documentId, node.path, node.name)
          : rawFileMenuEntries(node.path, node.name);
      const activateFileRow = (): void => {
        if (node.documentId !== undefined) {
          // Optimistic select so a single tap shows feedback instantly on
          // touch devices; the shell's active-document publish confirms it.
          void setActiveDocument(node.documentId, false, null);
          openDocument(node.documentId);
        } else {
          void setActiveDocument(null, false, node.path);
          void previewRawFile(node.path);
        }
      };
      return (
        // Row container: no interactive role. The dedicated activation
        // button owns click/keyboard activation (native button semantics
        // cover Enter/Space); the menu button stays a sibling so no
        // interactive control is nested inside another. Plain divs keep
        // server/client markup identical (hydration-safe). Direct clicks
        // on row padding/indent forward to the button so single-click and
        // middle-click open anywhere on the row.
        <div
          key={node.path}
          className={`${styles['tree-row']} ${styles['tree-file']}${isActive ? ` ${styles.active}` : ''}`}
          data-path={node.path}
          data-kind="file"
          {...(node.documentId !== undefined
            ? { 'data-document-id': node.documentId }
            : {})}
          draggable
          style={treeRowStyle(depth, 16)}
          onClick={(event) => {
            if (event.target !== event.currentTarget) return;
            event.currentTarget
              .querySelector<HTMLButtonElement>(
                `button.${styles['tree-activate']}`,
              )
              ?.click();
          }}
          onAuxClick={(event) => {
            if (
              event.button !== 1 ||
              node.documentId === undefined ||
              event.target !== event.currentTarget
            ) {
              return;
            }
            event.preventDefault();
            dispatch(workspaceEvents.openBackground, {
              documentId: node.documentId,
            });
          }}
          onDragStart={(event) => {
            event.dataTransfer?.setData(
              DRAG_MIME,
              JSON.stringify(
                node.documentId !== undefined
                  ? {
                      path: node.path,
                      kind: 'file',
                      documentId: node.documentId,
                    }
                  : { path: node.path, kind: 'file' },
              ),
            );
            event.dataTransfer?.setData('text/plain', node.path);
            if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
            dragRef.current.active =
              node.documentId !== undefined
                ? {
                    path: node.path,
                    kind: 'file',
                    documentId: node.documentId,
                  }
                : { path: node.path, kind: 'file' };
            event.currentTarget.classList.add(styles.dragging);
            rootRef.current?.classList.add(styles.dragging);
          }}
          onDragEnd={(event) => {
            dragRef.current.active = null;
            event.currentTarget.classList.remove(styles.dragging);
            rootRef.current?.classList.remove(styles.dragging);
            clearDropMark();
          }}
          onDragOver={(event) => {
            const dt = event.dataTransfer;
            if (hasDragPayload(dt)) {
              if (dragRef.current.active === null) return;
              if (dragRef.current.active.path === node.path) return;
              if (dragRef.current.active.kind === 'folder') {
                const parentText = String(parentPath(workspacePath(node.path)));
                if (
                  parentText === dragRef.current.active.path ||
                  parentText.startsWith(`${dragRef.current.active.path}/`)
                ) {
                  return;
                }
              }
              event.preventDefault();
              event.stopPropagation();
              dt.dropEffect = 'move';
              markRow(event.currentTarget, 'beside');
              return;
            }
            if (hasExternalFiles(dt)) {
              event.preventDefault();
              event.stopPropagation();
              dt.dropEffect = 'copy';
              markRow(event.currentTarget, 'beside');
            }
          }}
          onDragLeave={() => {
            const marked = dragRef.current.marked;
            if (marked !== null && marked.dataset.path === node.path) {
              clearDropMark();
            }
          }}
          onDrop={(event) => {
            event.preventDefault();
            event.stopPropagation();
            clearDropMark();
            const parent = String(parentPath(workspacePath(node.path)));
            if (hasExternalFilesAtDrop(event.dataTransfer)) {
              void handleExternalDrop(event.dataTransfer, parent);
              return;
            }
            if (readPayload(event.dataTransfer) === null) {
              logUnrecognizedDrop(event.dataTransfer);
            }
            void handleDrop(event.dataTransfer, parent);
          }}
          ref={attachMenu(() => rowMenuEntries)}
        >
          <button
            type="button"
            className={styles['tree-activate']}
            aria-current={isActive ? true : undefined}
            onClick={activateFileRow}
            onAuxClick={(event) => {
              if (event.button !== 1 || node.documentId === undefined) return;
              event.preventDefault();
              dispatch(workspaceEvents.openBackground, {
                documentId: node.documentId,
              });
            }}
          >
            <span className={styles['tree-file-icon']}>
              <Icon name={node.kindId
                ? (props.presentations?.get(documentKindId(node.kindId))?.icon ?? iconForPath(node.path))
                : iconForPath(node.path)} size={16} />
            </span>
            <span className={styles['tree-label']}>{node.name}</span>
          </button>
          <IconButton
            icon="more"
            size={16}
            label={`${node.name} options`}
            title={`${node.name} options`}
            className={`icon-more ${styles['row-menu']}`}
            onClick={(event) => {
              event.stopPropagation();
              showContextMenu(rowMenuEntries, event.currentTarget);
            }}
          />
        </div>
      );
    },
    [
      activeDocumentId,
      activePreviewPath,
      attachMenu,
      clearDropMark,
      dispatch,
      expanded,
      fileMenuEntries,
      folderMenuEntries,
      handleDrop,
      handleExternalDrop,
      markRow,
      openDocument,
      previewRawFile,
      rawFileMenuEntries,
      scheduleHoverExpand,
      setActiveDocument,
      toggleFolder,
    ],
  );

  return (
    <div
      ref={rootRef}
      className={styles['file-explorer']}
      data-testid="file-explorer"
    >
      <div className={styles['explorer-header']}>
        <span className="sidebar-heading">Documents</span>
        <div className={styles['explorer-actions']}>
          <Button
            variant="ghost"
            className={styles['new-button']}
            aria-haspopup="menu"
            aria-label="New"
            onClick={onOpenCreateMenu}
          >
            <Icon name="plus" size={15} />
            <span>New</span>
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,.pdf"
            hidden
            tabIndex={-1}
            onChange={onPdfInputChange}
          />
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            tabIndex={-1}
            onChange={onImageInputChange}
          />
          <input
            ref={importInputRef}
            type="file"
            multiple
            hidden
            tabIndex={-1}
            onChange={onFileInputChange}
          />
        </div>
      </div>
      <div
        ref={bodyRef}
        className={styles['explorer-tree']}
        onDragOver={(event) => {
          const dt = event.dataTransfer;
          if (hasDragPayload(dt)) {
            event.preventDefault();
            dt.dropEffect = 'move';
            bodyRef.current?.classList.add(styles['drop-root']);
            bodyRef.current?.classList.remove(styles['external-drop']);
            return;
          }
          if (hasExternalFiles(dt)) {
            event.preventDefault();
            dt.dropEffect = 'copy';
            bodyRef.current?.classList.add(styles['drop-root']);
            bodyRef.current?.classList.add(styles['external-drop']);
            return;
          }
          bodyRef.current?.classList.remove(styles['external-drop']);
        }}
        onDragLeave={(event) => {
          if (event.target === bodyRef.current) {
            clearDropMark();
            bodyRef.current?.classList.remove(styles['external-drop']);
          }
        }}
        onDrop={(event) => {
          const dt = event.dataTransfer;
          if (hasExternalFilesAtDrop(dt)) {
            event.preventDefault();
            clearDropMark();
            bodyRef.current?.classList.remove(styles['external-drop']);
            void handleExternalDrop(dt, '');
            return;
          }
          if (!hasDragPayload(dt)) {
            logUnrecognizedDrop(dt);
            return;
          }
          event.preventDefault();
          clearDropMark();
          bodyRef.current?.classList.remove(styles['external-drop']);
          void handleDrop(dt, '');
        }}
      >
        {tree.length === 0 ? (
          <div className={styles['explorer-empty']}>
            <span>No documents yet</span>
            <Button
              variant="ghost"
              className={styles['empty-create']}
              aria-haspopup="menu"
              onClick={onOpenCreateMenu}
            >
              <Icon name="plus" size={14} />
              Create a document
            </Button>
          </div>
        ) : (
          tree.map((node) => renderNode(node, 0))
        )}
      </div>
      <section className={styles.trash} aria-label="Trash">
        <button
          type="button"
          className={styles.trashToggle}
          aria-expanded={trashOpen}
          onClick={() => setTrashOpen((open) => !open)}
        >
          Trash ({trash.length})
        </button>
        {trashOpen && (
          <div className={styles.trashItems}>
            {trash.length === 0 ? (
              <p>Trash is empty.</p>
            ) : (
              trash.map((item) => {
                const name = item.path.split('/').pop() ?? item.path;
                return (
                  <div key={item.documentId} className={styles.trashItem}>
                    <span title={item.path}>{name}</span>
                    <button
                      type="button"
                      aria-label={`Restore ${name}`}
                      onClick={() => void runRestoreFile(item.documentId)}
                    >
                      Restore
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete ${name} permanently`}
                      onClick={() =>
                        void runPermanentDelete(item.documentId, name)
                      }
                    >
                      Delete permanently
                    </button>
                  </div>
                );
              })
            )}
          </div>
        )}
      </section>
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={styles['explorer-error-toast']}
          {...(toast.muted
            ? { style: { color: 'var(--fl-text-secondary)' } }
            : {})}
        >
          {toast.text}
        </div>
      ))}
    </div>
  );
}
