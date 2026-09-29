/**
 * Per-concern structural ports for the UI-facing workbench contract (#44).
 *
 * `WorkbenchControllerView` was one mega-interface mixing snapshots, dock
 * mutation, document/session lifecycle, history, editor tools, reading
 * presentation, and host attachment — every consumer depended on
 * capabilities it never used. These narrow ports split the surface by
 * consumer concern; top-level composition boundaries accept the aggregate
 * (`WorkbenchControllerView`).
 *
 * Rules:
 * - The seam stays UI-owned: `@froglight/ui` never imports
 *   `@froglight/application`. The real application controller satisfies
 *   these contracts structurally.
 * - Host-bearing `unknown` parameters appear ONLY on `WorkbenchHostPort`.
 *   No dock/document/reading/tools port exposes raw host parameters —
 *   useSessionOpener resolves hosts internally and the controller queue
 *   stays the sole execution serializer.
 * - Core methods are required. Optionality remains only for genuinely
 *   optional profile capabilities (PDF import/export).
 * - Reading presentation resolves through ONE required discriminated query
 *   (`readingPresentation`); shell code never probes for optional seam
 *   methods independently.
 */

import type {
  DocumentKindId,
  DocumentReaderProvider,
  DocumentToolSnapshot,
} from '@froglight/foundation';
import type { DockNodeView } from './dock-tree.js';
import type {
  DockMoveTargetView,
  OpenLinkResultView,
  PaneModeView,
  PaneView,
  WorkbenchDocumentView,
  WorkbenchStateView,
} from './workbench-view.js';

/** Dock structure snapshot: pane tree, focused pane, maximized pane. */
export interface DockStateView {
  readonly root: DockNodeView | null;
  readonly focusedPane: string | null;
  readonly maximizedPane: string | null;
}

/**
 * Reading presentation for one pane, resolved through a single required
 * query. `separate-reader` mounts a registered reader into the pane's
 * reader host; `editor-readonly` keeps the editor's read-only surface.
 */
export type WorkbenchReadingPresentation =
  | {
      readonly kind: 'separate-reader';
      readonly provider: DocumentReaderProvider;
      readonly kindId: DocumentKindId;
    }
  | {
      readonly kind: 'editor-readonly';
      readonly kindId: DocumentKindId | null;
    };

/** Snapshot/subscription surface: documents, panes, and focus. */
export interface WorkbenchStatePort {
  readonly state: WorkbenchStateView;
  /** Pane the shell currently targets with save/history/edit commands. */
  readonly focusedPane: string;
  onDidChange(listener: () => void): { dispose(): void };
  listDocuments(): readonly WorkbenchDocumentView[];
  paneStates(): readonly PaneView[];
  focusPane(pane: string): void;
}

/** Dock layout and tab-strip operations. No host parameters. */
export interface WorkbenchDockPort {
  onDidChange(listener: () => void): { dispose(): void };
  dockState(): DockStateView;
  /** Pane ids in visual order. */
  leafIds(): string[];
  /**
   * Split `pane`, focusing and returning the new (empty) pane. When
   * `opts.preserveFocus` is true, the previously focused pane stays focused
   * (background split semantic).
   */
  splitPane(
    pane: string,
    direction: 'right' | 'down' | 'left' | 'up',
    opts?: { preserveFocus?: boolean },
  ): string;
  /** Activate a tab within its pane (saves + reopens sessions as needed). */
  activateTab(pane: string, tabId: string): Promise<void>;
  /** Close a tab; closing a pane's last tab closes and rebalances the pane. */
  closeTab(pane: string, tabId: string): Promise<void>;
  closePane(pane: string): Promise<void>;
  /**
   * Move a tab to another pane or into a fresh split beside one. Host
   * rebinding after a cross-pane move reconciles through `WorkbenchHostPort`
   * (reattach on host mismatch), never through parameters here.
   */
  moveTab(
    fromPane: string,
    tabId: string,
    target: DockMoveTargetView,
  ): Promise<string | null>;
  /** Open a registered workspace view (e.g. graph) as a tab; returns tab id. */
  openView(
    viewId: string,
    opts?: { pane?: string; preserveFocus?: boolean },
  ): Promise<string>;
  /** Move a whole pane beside another pane. */
  movePaneBeside(
    fromPane: string,
    targetPane: string,
    direction: 'right' | 'down' | 'left' | 'up',
  ): void;
  /** Set the ratio of the split that directly contains `pane` (clamped). */
  setSplitRatio(pane: string, ratio: number): void;
  /** Set the ratio of the exact split identified by its root-relative path. */
  setSplitRatioAt(path: readonly ('first' | 'second')[], ratio: number): void;
  /** Toggle the maximized pane (default: the focused pane). */
  toggleMaximize(pane?: string): void;
  /** Close every pane except `keep` (default: focused), migrating tabs in. */
  closeOtherPanes(keep?: string): Promise<void>;
  /**
   *  synchronous live-owner probe (controller-owned, no UI
   * duplication). Returns the pane currently owning a live session for
   * `documentId`, or `null` when the document is not live anywhere.
   * Required core member: UI split guards call this synchronously before
   * `splitPane` so a duplicate never materializes a fresh leaf it
   * will not use. Synchronous with no lane waits.
   */
  liveOwnerOf(documentId: string): string | null;
  /**
   *  safety net for UI split races: after an externally created
   * split + `openDocument`, a redirect leaves the fresh split empty
   * (no session, no tabs, no document). Remove exactly that empty leaf so
   * pane count stays stable across repeated splits. Never touches a pane
   * that gained content. Required core member. Synchronous with no lane
   * waits.
   */
  discardRedirectedSplit(created: string, documentId: string): void;
}

/** Document/session/navigation operations. No host parameters. */
export interface WorkbenchDocumentPort {
  onDidChange(listener: () => void): { dispose(): void };
  createAndOpen(
    path: string,
    opts?: { pane?: string; kindId?: string },
  ): Promise<unknown>;
  openDocument(
    documentId: string,
    opts?: { pane?: string; address?: string; preserveFocus?: boolean },
  ): Promise<void>;
  openLink(
    destination: string,
    opts?: { readonly pane?: string },
  ): Promise<OpenLinkResultView>;
  deleteDocument(documentId: string): Promise<void>;
  /** Rename or move a document while keeping live pane paths in sync. */
  moveDocumentTo?(documentId: string, toPath: string): Promise<void>;
  /**
   * Prune tabs whose documents no longer exist after an external deletion
   * (e.g. the file-explorer service removes canonical bytes directly).
   * Safe to call when nothing is missing.
   */
  pruneMissingDocuments(): Promise<void>;
  saveActive(): Promise<{ committed: boolean; error: unknown } | null>;
  savePane(
    pane: string,
  ): Promise<{ committed: boolean; error: unknown } | null>;
  goBack(): Promise<boolean>;
  goForward(): Promise<boolean>;
}

/** Semantic editor tools for the active editor, without editor internals. */
export interface WorkbenchEditorToolsPort {
  onDidChange(listener: () => void): { dispose(): void };
  execEditorCommand(command: 'undo' | 'redo', pane?: string): boolean;
  canExecEditorCommand(command: 'undo' | 'redo', pane?: string): boolean;
  /** Semantic provider tools for one pane's active editor. */
  editorToolSnapshot(pane?: string): DocumentToolSnapshot | null;
  /** Execute a semantic provider tool without exposing editor internals. */
  executeEditorTool(
    pane: string,
    id: string,
    value?: string,
  ): boolean | Promise<boolean>;
}

/** Reading presentation: one discriminated query plus tab-mode controls. */
export interface WorkbenchReadingPort {
  onDidChange(listener: () => void): { dispose(): void };
  readingPresentation(pane: string): WorkbenchReadingPresentation;
  /**
   * Projected Markdown source for the pane's document when the live session
   * exposes one; `null` otherwise. Used for derived projections (sidebar
   * print); presentation mounting decisions use `readingPresentation`.
   */
  getPaneText(pane: string): string | null;
  /** Presentation mode of one tab (defaults to the pane's active tab). */
  tabMode(pane: string, tabId?: string): PaneModeView;
  /** Core-supported modes, independent of current provider availability. */
  availableTabModes(pane: string, tabId?: string): readonly PaneModeView[];
  /** Set the edit/reading presentation of one tab. */
  setTabMode(pane: string, tabId: string, mode: PaneModeView): void;
  /** Reveal a portable in-document address in the pane's active presentation. */
  revealAddress(
    pane: string,
    address: string,
    opts?: { preserveFocus?: boolean },
  ): boolean;
}

/**
 * Host attachment: the ONLY port that accepts or compares editor/reader
 * host objects (opaque `unknown`, reference identity). No host-id registry:
 * the provider ultimately receives the host object through the controller.
 */
export interface WorkbenchHostPort {
  onDidChange(listener: () => void): { dispose(): void };
  initialize(editorParent: unknown): Promise<void>;
  /** True while the pane owns a live session or an in-flight replacement. */
  isPaneActive(pane: string): boolean;
  /** True when the pane's live editor is mounted in this exact UI host. */
  isPaneAttached(pane: string, editorParent: unknown): boolean;
  /** Provider/capability revision, independent of attachment success notifications. */
  attachmentGeneration?(pane: string): number;
  /**
   * Open a document session mounted into `editorParent`. Host-readiness
   * callers (shell mailbox) use this; routing policy never touches hosts.
   */
  openDocument(
    documentId: string,
    editorParent: unknown,
    opts?: { pane?: string; address?: string; preserveFocus?: boolean },
  ): Promise<void>;
  /** Remount an existing pane session after its UI host was replaced. */
  reattachPane(
    pane: string,
    editorParent: unknown,
    readerParent?: unknown,
  ): Promise<void>;
  /** Attach the shell's stable reading-view host for `pane`. */
  setReaderHost(pane: string, readerParent: unknown): void;
  /** True when the pane's stored reading host is exactly `readerParent`. */
  isReaderAttached(pane: string, readerParent: unknown): boolean;
}

/**
 * Genuinely optional profile capabilities (notebook PDF import/export).
 * The only port allowed optional members.
 */
export interface WorkbenchImportExportPort {
  importPdfAsNotebook?(
    input: {
      readonly name: string;
      readonly bytes: Uint8Array;
      readonly password?: string;
      readonly selectedPageIndexes?: readonly number[];
    },
    opts?: { readonly pane?: string },
  ): Promise<{ readonly documentId: string; readonly pageCount: number }>;
  exportNotebookPdf?(
    input: {
      readonly mode: 'preserve' | 'flatten';
      readonly rasterDpi?: number;
    },
    pane?: string,
  ): Promise<{
    readonly bytes: Uint8Array;
    readonly filename: string;
    readonly warnings: readonly {
      readonly code: string;
      readonly detail?: string;
    }[];
  }>;
}

/**
 * Aggregate: the full controller surface. ONLY top-level
 * composition boundaries (`mountFroglightApp`, `FroglightApp`,
 * `WorkspaceView`, test harnesses) accept this. Leaf hooks and components
 * depend on the narrow port(s) they use. Vault/session shell lifecycle
 * (`closeVaultView`, `dispose`) lives here, not on any narrow port.
 */
export type WorkbenchControllerView = WorkbenchStatePort &
  WorkbenchDockPort &
  WorkbenchDocumentPort &
  WorkbenchEditorToolsPort &
  WorkbenchReadingPort &
  WorkbenchHostPort &
  WorkbenchImportExportPort & {
    closeVaultView(): Promise<void>;
    dispose(): Promise<void>;
  };
