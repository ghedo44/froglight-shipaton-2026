import type { PluginDefinition } from '@froglight/runtime';
import {
  DEFAULT_DOCUMENT_PRESENTATION_MODES,
  type DocumentPresentationMode,
  type DocumentKindDescriptor,
  ErrorCodes,
  FroglightError,
  InMemoryNavigationService,
  isWorkspacePath,
  markdownKindId,
  pathName,
  workspacePath,
  notebookKindId,
  pdfKindId,
  type CommandService,
  type DocumentId,
  type DocumentRef,
  type DocumentEditorHandle,
  type DocumentEditorProvider,
  type DocumentReaderHandle,
  type DocumentReaderProvider,
  type DocumentToolSnapshot,
  type DocumentKindId,
  type DocumentRecoveryWarning,
  type DocumentSession,
  type DocumentAssetStore,
  type NavigationService,
  type NotebookModel,
  type PdfProvider,
  type PdfExportProvider,
  type PdfExportWarning,
  type PdfSourceModel,
  type SaveResult,
  type SearchService,
  type WorkspaceService,
} from '@froglight/foundation';
import {
  importPdfAsNotebook as buildPdfNotebook,
  indexPdfBackedNotebookSource,
  indexStandalonePdfSource,
} from './pdf-import.js';
import { createWorkbenchOutlineRegistry } from './workbench-outline.js';
import type { InMemoryOutlineRegistry } from './outline/registry.js';
import {
  detachLeaf,
  findLeaf,
  firstLeaf,
  insertNode,
  leafIds as leafIdsOf,
  leafPane,
  removeLeaf,
  setLeafRatio,
  setSplitRatioAt as setDockSplitRatioAt,
  sideForDirection,
  splitLeaf,
  type DockNode,
} from './dock-model.js';
import type { DockLayoutStore } from './dock-layout.js';
import {
  LINK_ERROR_CODES,
  MAX_LINK_DESTINATION_LENGTH,
  MAX_LINK_PATH_LENGTH,
  formatResourceLink,
  isResourceLinkTarget,
  linkError,
  parseResourceLink,
  resolveDocumentLink,
  resolveResourceTarget,
  resourceTargetForDocument,
  splitLinkDestination,
  type ResourceTarget,
} from './link-resolution.js';

const AUTOSAVE_DELAY_MS = 800;
const PUBLICATION_DELAY_MS = 5000;

/** Matches `scheme:` prefixes so browser URLs are never link-canonical. */
const URL_SCHEME_PREFIX = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

function importedPdfTitle(filename: string): string {
  const withoutExtension = filename.replace(/\.pdf$/i, '').trim();
  const withoutControls = Array.from(withoutExtension, (character) =>
    character.charCodeAt(0) < 32 ? '-' : character,
  ).join('');
  const safe = withoutControls
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\.+$/g, '')
    .trim();
  return safe === '' ? 'Imported PDF' : safe;
}

function availableNotebookPath(
  workspace: WorkspaceService,
  title: string,
): ReturnType<typeof workspacePath> {
  for (let suffix = 1; suffix < 10_000; suffix += 1) {
    const label = suffix === 1 ? title : `${title} ${suffix}`;
    const candidate = workspacePath(`${label}.notebook`);
    if (workspace.findByResourcePath(candidate) === null) return candidate;
  }
  throw new Error('Could not allocate a Notebook path for the imported PDF');
}

/** Identifier of the primary (first) editor pane. */
export const MAIN_PANE = 'main';

/**
 * History-entry prefix for view opens. Resource ids of documents are
 * generated UUID-like strings, so this namespace never collides with one.
 */
const VIEW_HISTORY_PREFIX = 'view:';

/** Presentation of one tab; retained in rebuildable dock state, never canonical content. */
export type PaneMode = DocumentPresentationMode;

export type DockTabKind = 'document' | 'view';

/** One tab in a pane's strip: a document or a workspace view instance. */
export interface DockTabView {
  readonly id: string;
  readonly kind: DockTabKind;
  /** Document tabs: the opened document. */
  readonly documentId: string | null;
  /** View tabs: the registered view id (e.g. `graph`). */
  readonly viewId: string | null;
  /** Transient status projected by paneStates; never persisted in dock layout. */
  readonly dirty?: boolean;
  readonly saveError?: boolean;
}

export interface WorkbenchApplication {
  getWorkspace(): WorkspaceService | null;
  getSearch(): SearchService | null;
  getDocumentEditor(kindId: DocumentKindId): DocumentEditorProvider | null;
  onDocumentEditorProviderChange?(
    listener: (kindIds: readonly DocumentKindId[]) => void,
  ): { dispose(): void };
  getDocumentKind?(kindId: DocumentKindId): DocumentKindDescriptor | null;
  getOutlineRegistry?(): InMemoryOutlineRegistry;
  onDocumentPresentationCapabilityChange?(
    listener: (kindIds: readonly DocumentKindId[]) => void,
  ): { dispose(): void };
  onDocumentReaderProviderChange?(
    listener: (kindIds: readonly DocumentKindId[]) => void,
  ): { dispose(): void };
  getDocumentReader?(kindId: DocumentKindId): DocumentReaderProvider | null;
  getDocumentAssetStore?(): DocumentAssetStore | null;
  getPdfProvider?(): PdfProvider | null;
  getPdfExportProvider?(): PdfExportProvider | null;
  getNavigation?(): NavigationService | null;
  getCommands?(): CommandService | null;
  getDockLayout?(): import('./dock-layout.js').DockLayoutStore | null;
  onNotebookEditorProviderChange?(listener: () => void | Promise<void>): {
    dispose(): void;
  };
  replaceVault<C extends Readonly<Record<string, unknown>>>(
    plugin: PluginDefinition<C>,
    config?: C,
  ): Promise<void>;
  closeVault(): Promise<void>;
}

export interface WorkbenchDocument {
  readonly documentId: string;
  readonly kindId: string;
  readonly path: string;
  readonly title: string;
}

export interface WorkbenchSearchResult {
  readonly documentId: string;
  readonly title?: string;
  readonly excerpt: string;
}

export interface WorkbenchState {
  readonly activeDocumentId: string | null;
  readonly activeDocumentTitle: string | null;
  readonly activeDocumentPath: string | null;
  readonly dirty: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

/** Snapshot of one pane: its tab strip, active tab, and live session state. */
export interface PaneStateView {
  readonly pane: string;
  readonly tabs: readonly DockTabView[];
  readonly activeTab: string | null;
  /** Presentation mode of the active tab. */
  readonly mode: PaneMode;
  readonly documentId: string | null;
  readonly viewId: string | null;
  readonly title: string | null;
  readonly path: string | null;
  readonly dirty: boolean;
  /** Machine-readable warnings from the active session's partial recovery. */
  readonly recoveryWarnings: readonly DocumentRecoveryWarning[];
  readonly editorAvailable?: boolean;
  /** True while the active document's required editor is being attached. */
  readonly editorLoading?: boolean;
  /** This pane's own history trail (per-pane back/forward). */
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
}

/** Dock structure snapshot consumed by the shell renderer. */
export interface DockStateView {
  readonly root: DockNode | null;
  readonly focusedPane: string | null;
  readonly maximizedPane: string | null;
}

/** Target of a tab move: an existing pane, or a fresh split beside one. */
export type DockMoveTarget =
  | { readonly kind: 'pane'; readonly pane: string; readonly index?: number }
  | {
      readonly kind: 'split';
      readonly pane: string;
      readonly direction: 'right' | 'down' | 'left' | 'up';
    };

/** Serializable dock layout for per-vault persistence (derived state). */
export interface DockLayoutRecord {
  readonly format: 'froglight.dock';
  readonly version: 1;
  readonly root: DockNode | null;
  readonly panes: readonly {
    readonly pane: string;
    readonly tabs: readonly DockTabView[];
    readonly activeTab: string | null;
    readonly modes: readonly {
      readonly tab: string;
      readonly mode: PaneMode;
    }[];
  }[];
  readonly focusedPane: string | null;
}

/** Result of opening a link destination. */
export interface OpenLinkResult {
  /** True when the destination was missing and a new document was created. */
  readonly created: boolean;
  readonly documentId: string;
  /**
   * True when the requested navigation was fully honored: either no
   * sub-document address was requested (document open is the complete
   * success) or the address was confirmed through the active
   * presentation's existing `revealAddress` seam.
   *
   * False means document-open-only degrade: the document still opened,
   * but the requested address did not resolve to an exact reveal.
   * Callers must not treat `false` as exact success (honesty).
   *
   * Per-editor status: all four production providers implement
   * `revealAddress` (Markdown, Notebook, Block Page, Whiteboard —
   * closed the Block/Whiteboard gap). Boolean seams (Block Page,
   * Whiteboard) report exact: `false` means the address is unknown even
   * though the document opened. Legacy `void` seams (Markdown, Notebook,
   * LaTeX) report seam presence: `true` whenever the provider handles
   * the address, because `void` carries no miss signal (normalized via
   * `result !== false`). Migrating those seams to boolean is future
   * work; until then an unknown heading slug on a `void` seam still
   * reports `true`.
   */
  readonly revealed: boolean;
}

interface Disposable {
  dispose(): void;
}

type DockTab = DockTabView;

interface PaneRuntime {
  attachmentGeneration: number;
  session: DocumentSession | null;
  editor: DocumentEditorHandle | null;
  editorSubscription: Disposable | null;
  /** Reading-view handle; present in `split` and `reading` modes. */
  reader: DocumentReaderHandle | null;
  kindId: DocumentKindId | null;
  subscriptions: Disposable[];
  documentId: string | null;
  documentTitle: string | null;
  documentPath: string | null;
  tabs: DockTab[];
  activeTab: string | null;
  modes: Map<string, PaneMode>;
  /** This pane's own workspace back/forward trail. */
  readonly nav: NavigationService;
}

interface RetainedSession {
  readonly session: DocumentSession;
  save: Promise<void> | null;
  close: Promise<void> | null;
}

function createPaneRuntime(): PaneRuntime {
  return {
    attachmentGeneration: 0,
    session: null,
    editor: null,
    editorSubscription: null,
    reader: null,
    kindId: null,
    subscriptions: [],
    documentId: null,
    documentTitle: null,
    documentPath: null,
    tabs: [],
    activeTab: null,
    modes: new Map(),
    nav: new InMemoryNavigationService(),
  };
}

/** Shared product orchestration used unchanged by web and native hosts. */
export class WorkbenchController {
  readonly #app: WorkbenchApplication;
  readonly #listeners = new Set<() => void>();
  /** Live runtime per pane; tree membership is the source of truth. */
  readonly #panes = new Map<string, PaneRuntime>();
  /** Dirty sessions temporarily detached from panes while their save runs. */
  readonly #retainedSessions = new Map<string, RetainedSession>();
  readonly #sessionSaveOperations = new Map<DocumentSession, Promise<SaveResult | null>>();
  #root: DockNode = leafPane(MAIN_PANE);
  #focusedPane: string = MAIN_PANE;
  #maximizedPane: string | null = null;
  #editorParents = new Map<string, unknown>();
  /** Stable per-pane reading-view hosts handed to reader providers. */
  #readerParents = new Map<string, unknown>();
  /** Serializes every session/editor transition within each pane. */
  readonly #paneOpenOperations = new Map<string, Promise<void>>();
  #viewCounter = 0;
  /** True while a history-driven open is in flight (no new history push). */
  #restoringHistory = false;
  /** True while a tab switch or tab move reopens a session (no history push). */
  #restoringTab = false;
  /** Command registrations owned (and reversed) by this controller. */
  readonly #commandDisposers: { dispose(): void }[] = [];
  readonly #notebookProviderSubscription: { dispose(): void } | null;
  #commandsService: CommandService | null = null;
  /** True while tearing down for a vault switch/shutdown (no layout saves). */
  #suppressLayoutSave = false;
  #terminalOperations: Promise<void> = Promise.resolve();
  #terminalReservations = 0;
  #disposed = false;
  #disposalRequested = false;
  #disposeOperation: Promise<void> | null = null;
  /**
   *  coalescing, per-session: one record per live
   * session from a synchronous dirty/content bump until the microtask
   * drains, so only the redundant same-session tools bump in the same tick
   * is skipped. One shell bump per commit still fires synchronously
   * (freshness); only the redundant second bump is coalesced.
   * Async diagnostics completion (records drained) still notifies. Keyed
   * by session because per-session edit generations each start at 0 — a
   * global sequence key would suppress a second session's commit that
   * shares the same tick and sequence. A single shared drain clears every
   * record: all same-tick bumps are recorded before the microtask runs.
   */
  #coalescedBySession = new Map<object, { sequence: number; toolsSkipped: boolean }>();
  #coalesceDrainScheduled = false;

  /**
   * Single-bump coalescing for one content sequence.
   *
   * Content bumps (dirty + content for one `markDirty`) notify once per
   * session per sequence per tick; the redundant second bump for the SAME
   * session and sequence in the SAME tick is skipped. A new sequence
   * (next commit, even in the same tick) still notifies synchronously;
   * async changes after the microtask drains (records cleared) still
   * notify. A null sequence (legacy doubles without numeric
   * `contentSequence`) always notifies to preserve
   * hash-fallback freshness — never recorded, never skipped.
   *
   * Tools bumps coalesce ONLY the content-triple redundant
   * bump: the first tools bump for an already-notified session + sequence
   * in the same tick (the known docChanged-coupled second bump). A later
   * tools bump for the same sequence — a selection-driven snapshot
   * change such as the markdown `selectionSet` path — still notifies, as
   * does every tools bump once one skip has been consumed.
   */
  #notifyCoalesced(
    session: object | null,
    sequence: number | null,
    kind: 'content' | 'tools',
  ): boolean {
    if (session === null || sequence === null) {
      this.#notify();
      return true;
    }
    const seen = this.#coalescedBySession.get(session);
    if (kind === 'tools') {
      if (
        seen !== undefined &&
        seen.sequence === sequence &&
        !seen.toolsSkipped
      ) {
        seen.toolsSkipped = true;
        return false;
      }
    } else if (seen !== undefined && seen.sequence === sequence) {
      return false;
    }
    this.#coalescedBySession.set(session, {
      sequence,
      toolsSkipped: kind === 'tools',
    });
    if (!this.#coalesceDrainScheduled) {
      this.#coalesceDrainScheduled = true;
      queueMicrotask(() => {
        this.#coalesceDrainScheduled = false;
        this.#coalescedBySession.clear();
      });
    }
    this.#notify();
    return true;
  }

  /** Current content sequence for coalescing, or null for legacy doubles. */
  #sequenceOf(session: { contentSequence?: unknown } | null): number | null {
    if (session === null) return null;
    const sequence = (session as { contentSequence?: unknown }).contentSequence;
    return typeof sequence === 'number' && Number.isFinite(sequence)
      ? sequence
      : null;
  }

  /**
   * Production outline seam: the filler for the
   * UI-owned structural port `WorkbenchOutlineProviderLike` (no
   * `@froglight/ui` import — the shell reads this structurally via a cast).
   *
   * A real `InMemoryOutlineRegistry` with the shared first-party extractors,
   * owned by this controller: created with it, registrations disposed with
   * it (activate → one per kind, dispose → zero). `getOutlineModel` below
   * resolves the live session model plus its dirty-aware outline key
   * (`contentRevision` + `contentSequence`) so blockpage/notebook/latex
   * rows appear in the running app's Outline tab with referentially
   * stable rows at a stable revision and fresh rows after in-place
   * commits.
   */
  readonly outlineRegistry: InMemoryOutlineRegistry;
  readonly #disposeOutlineRegistry: () => void;

  #assertPaneAdmission(): void {
    if (this.#disposalRequested || this.#terminalReservations > 0) {
      throw new Error('Workbench pane admission is closed during teardown');
    }
  }

  /**
   * Close admission synchronously, then drain already admitted transitions.
   * A transfer can enroll new lanes while draining, but its original promise
   * covers those lanes too. Terminal bodies never enqueue/wait on themselves.
   */
  #reserveTerminal(run: () => Promise<void>): Promise<void> {
    this.#terminalReservations++;
    const pending = [...this.#paneOpenOperations.values(), this.#terminalOperations];
    const operation = Promise.all(pending.map(p => p.catch(() => undefined)))
      .then(run)
      .finally(() => { this.#terminalReservations--; });
    this.#terminalOperations = operation.then(() => undefined, () => undefined);
    return operation;
  }


  constructor(app: WorkbenchApplication) {
    this.#app = app;
    const sharedOutline = app.getOutlineRegistry?.();
    const outline = sharedOutline ? null : createWorkbenchOutlineRegistry();
    this.outlineRegistry = sharedOutline ?? outline!.registry;
    this.#disposeOutlineRegistry = outline?.dispose ?? (() => undefined);
    const editors = app.onDocumentEditorProviderChange?.((kindIds) =>
      this.#reconcileEditors(kindIds),
    );
    const readers = app.onDocumentReaderProviderChange?.((kindIds) => {
      const errors: unknown[] = [];
      for (const [name, pane] of this.#panes) {
        if (pane.kindId === null || !kindIds.includes(pane.kindId)) continue;
        pane.attachmentGeneration++;
        try {
          this.#teardownReader(pane);
          this.#syncPresentation(name);
        } catch (error) {
          errors.push(error);
        }
      }
      try { this.#notify(); } catch (error) { errors.push(error); }
      // Finish every pane before reporting failure to the registry. Acquisition
      // can then roll back; authoritative withdrawal isolates the error there.
      if (errors.length > 0) throw errors[0];
    });
    const presentation = app.onDocumentPresentationCapabilityChange?.((kindIds) => {
      // Keep the authoritative session, selected mode and content subscription;
      // only projections depend on the withdrawn/replaced render capability.
      const errors: unknown[] = [];
      for (const [name, pane] of this.#panes) {
        if (pane.kindId === null || !kindIds.includes(pane.kindId)) continue;
        pane.attachmentGeneration++;
        try {
          this.#teardownReader(pane);
          this.#teardownEditor(pane);
          this.#syncPresentation(name);
        } catch (error) {
          errors.push(error);
        }
      }
      try { this.#notify(); } catch (error) { errors.push(error); }
      if (errors.length > 0) throw errors[0];
    });
    // PDF capability replacement also affects Notebook engines without changing
    // their document-editor registration, so retain that independent signal.
    let pdfProvider = app.getPdfProvider?.();
    const paged = app.onNotebookEditorProviderChange?.(() => {
      const next = app.getPdfProvider?.();
      if (!editors || next !== pdfProvider) {
        pdfProvider = next;
        return this.#reconcilePagedEditors();
      }
      return undefined;
    });
    this.#notebookProviderSubscription = {
      dispose() {
        editors?.dispose();
        readers?.dispose();
        presentation?.dispose();
        paged?.dispose();
      },
    };
    this.#registerCommands();
  }

  /**
   * The command service is workspace-scoped and is replaced on vault
   * swaps; re-register whenever the service instance changed so dock
   * commands reconcile with the active composition (activate → one set,
   * dispose → zero, reactivate/swap → one set).
   */
  #registerCommands(): void {
    const commands = this.#app.getCommands?.() ?? null;
    if (commands === null || commands === this.#commandsService) return;
    for (const disposer of this.#commandDisposers) disposer.dispose();
    this.#commandDisposers.length = 0;
    this.#commandsService = commands;
    const register = (
      id: string,
      title: string,
      execute: () => unknown,
    ): void => {
      try {
        this.#commandDisposers.push(commands.register({ id, title, execute }));
      } catch (error) {
        // A duplicate means another owner already registered the id; leave
        // theirs in place rather than fighting over it. Anything else is a
        // real bug and must surface.
        if (
          !(error instanceof FroglightError) ||
          error.code !== ErrorCodes.DUPLICATE_COMMAND
        ) {
          throw error;
        }
      }
    };
    register('froglight.navigation.back', 'Back', () => this.goBack());
    register('froglight.navigation.forward', 'Forward', () => this.goForward());
    register('froglight.workspace.splitRight', 'Split right', () => {
      this.splitPane(this.#focusedPane, 'right');
    });
    register('froglight.workspace.splitDown', 'Split down', () => {
      this.splitPane(this.#focusedPane, 'down');
    });
    register('froglight.workspace.closePane', 'Close pane', () =>
      this.closePane(this.#focusedPane),
    );
    register('froglight.workspace.closeOtherPanes', 'Close other panes', () =>
      this.closeOtherPanes(),
    );
    register(
      'froglight.workspace.moveTabToNextPane',
      'Move tab to next pane',
      () => this.moveActiveTabToNextPane(),
    );
    register('froglight.workspace.focusNextPane', 'Focus next pane', () => {
      this.cycleFocus(1);
    });
    register(
      'froglight.workspace.focusPreviousPane',
      'Focus previous pane',
      () => {
        this.cycleFocus(-1);
      },
    );
    register(
      'froglight.workspace.toggleMaximize',
      'Toggle pane maximize',
      () => {
        this.toggleMaximize();
      },
    );
  }

  /**
   * The dock layout store is per vault: it is replaced on every vault
   * switch, so it must be resolved lazily through the app — never cached.
   */
  #dockLayoutStore(): DockLayoutStore | null {
    try {
      return this.#app.getDockLayout?.() ?? null;
    } catch {
      return null;
    }
  }

  #pane(pane: string): PaneRuntime {
    let runtime = this.#panes.get(pane);
    if (runtime === undefined) {
      runtime = createPaneRuntime();
      this.#panes.set(pane, runtime);
    }
    return runtime;
  }

  #sourceResourceForPane(
    workspace: WorkspaceService,
    pane: string,
  ): DocumentRef['location']['resourceId'] | undefined {
    const documentId = this.#panes.get(pane)?.documentId;
    if (documentId === null || documentId === undefined) return undefined;
    return workspace.listDocuments().find(
      (ref) => String(ref.documentId) === documentId,
    )?.location.resourceId;
  }

  get focusedPane(): string {
    return this.#focusedPane;
  }

  /** Pane ids in visual order — the dock tree's leaves. */
  leafIds(): string[] {
    return leafIdsOf(this.#root);
  }

  /** Dock structure for the shell renderer. */
  dockState(): DockStateView {
    const leaves = this.leafIds();
    return {
      root: this.#root,
      focusedPane: leaves.includes(this.#focusedPane)
        ? this.#focusedPane
        : (leaves[0] ?? null),
      maximizedPane: this.#maximizedPane,
    };
  }

  /** True while the pane owns a live session or an in-flight replacement. */
  isPaneActive(pane: string): boolean {
    return (
      this.#paneOpenOperations.has(pane) ||
      (this.#panes.get(pane)?.session !== null &&
        this.#panes.get(pane)?.session !== undefined)
    );
  }

  /** True only when the current host's required presentation handles exist. */
  isPaneAttached(pane: string, editorParent: unknown): boolean {
    const runtime = this.#panes.get(pane);
    if (runtime?.session == null || this.#editorParents.get(pane) !== editorParent) return false;
    const separate = runtime.kindId !== null && this.getDocumentReader(runtime.kindId) !== null;
    const mode = this.tabMode(pane);
    const needsEditor = mode !== 'reading' || !separate;
    const needsReader = mode !== 'edit' && separate;
    return (needsEditor ? runtime.editor !== null : runtime.editor === null) &&
      (needsReader ? runtime.reader !== null : runtime.reader === null);
  }

  /** Changes only when a provider/capability changes, not on failed attachment. */
  attachmentGeneration(pane: string): number {
    return this.#panes.get(pane)?.attachmentGeneration ?? 0;
  }

  /** Remount the active document without changing tabs, focus, or history. */
  async reattachPane(
    pane: string,
    editorParent: unknown,
    readerParent?: unknown,
  ): Promise<void> {
    return this.#queuePaneOperation(pane, async () => {
      const runtime = this.#panes.get(pane);
      const active = runtime?.tabs.find((tab) => tab.id === runtime.activeTab);
      if (
        runtime === undefined ||
        active?.kind !== 'document' ||
        active.documentId === null ||
        (this.isPaneAttached(pane, editorParent) &&
          (readerParent === undefined ||
            this.isReaderAttached(pane, readerParent)))
      ) {
        if (readerParent !== undefined) {
          this.#readerParents.set(pane, readerParent);
          if (
            runtime !== undefined &&
            runtime.session !== null &&
            this.tabMode(pane) !== 'edit'
          ) {
            this.#ensureReader(pane);
          }
        }
        return;
      }
      // Host replacement is a presentation change, not a storage reopen.
      if (this.#editorParents.get(pane) !== editorParent) this.#teardownEditor(runtime);
      if (readerParent !== undefined && this.#readerParents.get(pane) !== readerParent) {
        this.#teardownReader(runtime);
      }
      this.#editorParents.set(pane, editorParent);
      if (readerParent !== undefined) this.#readerParents.set(pane, readerParent);
      try {
        this.#syncPresentation(pane, true);
      } finally {
        // Publish failed attachment too; the same hosts must remain retriable.
        this.#notify();
      }
    });
  }

  /** Snapshot of every pane in visual order. */
  paneStates(): readonly PaneStateView[] {
    return this.leafIds().map((pane) => this.#paneStateOf(pane));
  }

  #paneStateOf(pane: string): PaneStateView {
    const runtime = this.#panes.get(pane);
    const activeTab = runtime?.activeTab ?? null;
    const tabs: readonly DockTabView[] = (runtime?.tabs ?? []).map(tab => {
      if (tab.kind !== 'document' || tab.documentId === null) return tab;
      const session = this.#retainedSessions.get(tab.documentId)?.session ??
        [...this.#panes.values()].find(candidate => candidate.documentId === tab.documentId)?.session ?? null;
      return {
        ...tab,
        dirty: session?.dirty ?? false,
        saveError: session !== null && (session.canRetrySave === true || session.lastError != null || session.persistenceError != null),
        saveStatus: session?.localJournalEnabled === true
          ? session.persistenceError != null ? 'Local save failed. Keep this tab open and retry saving.'
            : session.lastError != null ? 'Vault update failed. Local changes are preserved.'
            : (session.durableSeq ?? 0) < (session.editedSeq ?? 0) ? 'Saving locally…'
            : (session.publishedSeq ?? 0) < (session.editedSeq ?? 0) ? 'Saved locally. Vault update pending.'
            : 'Saved to vault.'
          : undefined,
      };
    });
    const active = tabs.find((tab) => tab.id === activeTab) ?? null;
    const mode =
      activeTab !== null ? (runtime?.modes.get(activeTab) ?? 'edit') : 'edit';
    const readerOnly =
      mode === 'reading' &&
      runtime !== undefined &&
      runtime.kindId !== null &&
      this.getDocumentReader(runtime.kindId) !== null;
    return {
      pane,
      tabs,
      activeTab,
      mode,
      documentId: active?.documentId ?? runtime?.documentId ?? null,
      viewId: active?.viewId ?? null,
      title: runtime?.documentTitle ?? null,
      path: runtime?.documentPath ?? null,
      dirty: runtime?.session?.dirty ?? false,
      recoveryWarnings: runtime?.session?.recoveryWarnings ?? [],
      editorAvailable: runtime?.editor != null,
      editorLoading:
        this.#paneOpenOperations.has(pane) &&
        active?.kind === 'document' &&
        (runtime?.editor ?? null) === null &&
        !readerOnly,
      canGoBack: runtime?.nav.canGoBack ?? false,
      canGoForward: runtime?.nav.canGoForward ?? false,
    };
  }

  get state(): WorkbenchState {
    const nav = this.#navigation();
    const runtime = this.#pane(this.#focusedPane);
    return {
      activeDocumentId: runtime.documentId,
      activeDocumentTitle: runtime.documentTitle,
      activeDocumentPath: runtime.documentPath,
      dirty: runtime.session?.dirty ?? false,
      canGoBack: nav?.canGoBack ?? false,
      canGoForward: nav?.canGoForward ?? false,
    };
  }

  onDidChange(listener: () => void): Disposable {
    this.#listeners.add(listener);
    return { dispose: () => this.#listeners.delete(listener) };
  }

  listDocuments(): readonly WorkbenchDocument[] {
    const workspace = this.#requireWorkspace();
    return workspace.listDocuments().map((ref) => {
      const path = workspace.resolveResourcePath(ref.location.resourceId);
      return {
        documentId: String(ref.documentId),
        kindId: String(ref.kindId),
        path: String(path),
        title: pathName(path) ?? String(path),
      };
    });
  }

  search(text: string): readonly WorkbenchSearchResult[] {
    const search = this.#app.getSearch();
    if (search === null || text.trim().length === 0) return [];
    return search.search({ text }).map((result) => ({
      documentId: String(result.documentId),
      title: result.title,
      excerpt: result.excerpt,
    }));
  }

  async initialize(editorParent: unknown): Promise<void> {
    this.#assertPaneAdmission();
    this.#registerCommands();
    this.#editorParents.set(MAIN_PANE, editorParent);
    const workspace = this.#requireWorkspace();
    await workspace.rebuildDerivedState();
    await this.rebuildStandalonePdfSearch();
    // A persisted dock layout wins over the legacy "open the first
    // document" startup; the shell reopens each pane's active document as
    // its editor host mounts.
    const stored = await this.#dockLayoutStore()?.load();
    this.#suppressLayoutSave = false;
    if (stored !== null && stored !== undefined) {
      await this.restoreDockLayout(stored);
      return;
    }
    const documents = this.listDocuments();
    if (documents.length === 0) {
      await this.createAndOpen('notes/welcome.md', editorParent);
      return;
    }
    const first = documents[0];
    if (first !== undefined)
      await this.openDocument(first.documentId, editorParent);
  }

  /** Rebuild provider-derived standalone PDF source text after index loss/startup. */
  async rebuildStandalonePdfSearch(): Promise<void> {
    const workspace = this.#requireWorkspace();
    const provider = this.#app.getPdfProvider?.() ?? null;
    const search = this.#app.getSearch();
    if (provider === null || search === null) return;
    for (const ref of workspace.listDocuments()) {
      if (ref.kindId !== pdfKindId) continue;
      try {
        const read = await workspace.readDocument<PdfSourceModel>(
          ref.documentId,
        );
        await indexStandalonePdfSource({
          documentId: ref.documentId,
          location: ref.location,
          bytes: read.model.bytes,
          provider,
          search,
        });
      } catch {
        // Locked/corrupt PDFs stay openable through their explicit recovery
        // UI; one failed source must not block workspace startup.
      }
    }
  }

  /** Current default creation action; additional document kinds add their own commands. */
  async createAndOpen(
    pathText: string,
    editorParent: unknown = undefined,
    opts: { pane?: string; kindId?: DocumentKindId; address?: string } = {},
  ): Promise<DocumentRef | null> {
    const workspace = this.#requireWorkspace();
    const path = workspacePath(pathText);
    const existing = workspace.findByResourcePath(path);
    if (existing === null) {
      const kindId = opts.kindId ?? markdownKindId;
      const kind = this.#app.getDocumentKind?.(kindId);
      const creation = kind?.creation;
      if (!creation) throw new Error(`Document kind ${kindId} cannot be created`);
      const fileName = pathName(path) ?? '';
      const extension = [creation.extension, ...(kind?.importExtensions ?? [])]
        .find((candidate) => fileName.toLowerCase().endsWith(candidate.toLowerCase()));
      const title =
        (extension !== undefined
          ? fileName.slice(0, -extension.length)
          : fileName) || 'Untitled';
      const created = await workspace.createDocument({
        kindId,
        path,
        initialModel: creation.createInitialModel(title),
      });
      // Keep derived indexes aware of the new document until a dedicated
      // creation projection event exists.
      await workspace.rebuildDerivedState();
      await this.openDocument(String(created.documentId), editorParent, opts);
      return created;
    }
    await this.openDocument(String(existing.documentId), editorParent, opts);
    return existing;
  }

  /** Import immutable PDF bytes into a new Notebook and open it in one step. */
  async importPdfAsNotebook(
    input: {
      readonly name: string;
      readonly bytes: Uint8Array;
      readonly password?: string;
      readonly selectedPageIndexes?: readonly number[];
    },
    opts: { readonly pane?: string } = {},
  ): Promise<{ readonly documentId: string; readonly pageCount: number }> {
    const workspace = this.#requireWorkspace();
    const assets = this.#app.getDocumentAssetStore?.() ?? null;
    const provider = this.#app.getPdfProvider?.() ?? null;
    if (assets === null || provider === null) {
      throw new Error('PDF import is unavailable in this profile');
    }
    const title = importedPdfTitle(input.name);
    const imported = await buildPdfNotebook({
      bytes: input.bytes,
      provider,
      assets,
      title,
      ...(input.password !== undefined ? { password: input.password } : {}),
      ...(input.selectedPageIndexes !== undefined
        ? { selectedPageIndexes: input.selectedPageIndexes }
        : {}),
    });
    const path = availableNotebookPath(workspace, title);
    const ref = await workspace.createDocument({
      kindId: notebookKindId,
      path,
      initialModel: imported.notebook,
    });
    await workspace.rebuildDerivedState();
    const search = this.#app.getSearch();
    if (search !== null) {
      await indexPdfBackedNotebookSource({
        documentId: ref.documentId,
        location: ref.location,
        notebook: imported.notebook,
        provider,
        assets,
        search,
        ...(input.password !== undefined ? { password: input.password } : {}),
      });
    }
    await this.openDocument(String(ref.documentId), undefined, {
      pane: opts.pane ?? this.#focusedPane,
    });
    return {
      documentId: String(ref.documentId),
      pageCount: imported.sourcePageIds.size,
    };
  }

  /** Export the active mixed Notebook through the replaceable PDF export provider. */
  async exportNotebookPdf(
    input: {
      readonly mode: 'preserve' | 'flatten';
      readonly rasterDpi?: number;
    },
    pane: string = this.#focusedPane,
  ): Promise<{
    readonly bytes: Uint8Array;
    readonly filename: string;
    readonly warnings: readonly PdfExportWarning[];
  }> {
    const runtime = this.#panes.get(pane);
    if (runtime?.kindId !== notebookKindId || runtime.session === null) {
      throw new Error('The active document is not a Notebook');
    }
    const provider = this.#app.getPdfExportProvider?.() ?? null;
    const assets = this.#app.getDocumentAssetStore?.() ?? null;
    if (provider === null || assets === null) {
      throw new Error('Notebook PDF export is unavailable in this profile');
    }
    runtime.editor?.flush?.();
    const renderPage = runtime.editor?.renderPageImage;
    if (input.mode === 'flatten' && renderPage === undefined) {
      throw new Error(
        'Flattened PDF export requires the visual Notebook provider',
      );
    }
    const result = await provider.exportNotebook({
      notebook: runtime.session.model as NotebookModel,
      mode: input.mode,
      assets,
      ...(input.rasterDpi !== undefined ? { rasterDpi: input.rasterDpi } : {}),
      ...(renderPage !== undefined
        ? {
            renderFlattenedPage: (pageId, dpi, signal) =>
              renderPage.call(runtime.editor, pageId, dpi, signal),
          }
        : {}),
    });
    const base = (runtime.documentTitle ?? 'Notebook').replace(
      /\.notebook$/i,
      '',
    );
    return { ...result, filename: `${base}.pdf` };
  }

  /**
   * Open any registered document kind with the provider registered for that
   * kind. When the document is already live in another pane (single
   * owner), the existing owner pane/tab is focused instead: its session,
   * dirty state, and handles are preserved, the target pane is left
   * untouched, and no second session is created. Otherwise the document
   * becomes (or activates) a tab in the target pane; opening into another
   * pane leaves every other pane's live session untouched.
   *
   * Background semantic: when `opts.preserveFocus` is true, opening into
   * another pane never modifies global focus — neither the logical focused
   * pane nor DOM/editor focus. The operation leaves `#focusedPane` exactly
   * as it found it, so a concurrent user focus change can never be
   * overwritten by a stale restore. Callers never repair focus ad-hoc and
   * no second async queue is introduced (`#paneOpenOperations` remains the
   * sole serializer).
   */
  async openDocument(
    documentId: string,
    editorParent: unknown = undefined,
    opts: { pane?: string; address?: string; preserveFocus?: boolean } = {},
  ): Promise<void> {
    const paneName = opts.pane ?? MAIN_PANE;
    return this.#queuePaneOperation(paneName, () =>
      this.#openDocumentNow(documentId, editorParent, opts),
    );
  }

  /**
   * A pane owns one live session, so all asynchronous transitions affecting
   * it must share one queue. Without this, a slower earlier tab selection can
   * finish after a newer selection and mount the wrong document under the
   * selected tab.
   */
  #queuePaneOperation<T>(paneName: string, run: () => Promise<T>): Promise<T> {
    return this.#queuePaneOperations([paneName], run);
  }

  /** Reserve every affected lane synchronously, never nest waits on held lanes. */
  #queuePaneOperations<T>(
    paneNames: readonly string[],
    run: (reserveNewPane: (name: string) => void) => Promise<T>,
  ): Promise<T> {
    this.#assertPaneAdmission();
    const names = [...new Set(paneNames)];
    const previous = names.map(name => this.#paneOpenOperations.get(name) ?? Promise.resolve());
    // Only newly allocated, unpublished panes may join a running reservation:
    // there can be no prior operation to wait for (and hence no nested wait).
    const reserveNewPane = (name: string): void => {
      if (this.#paneOpenOperations.has(name)) {
        throw new Error(`Cannot reserve an existing pane lane: ${name}`);
      }
      names.push(name);
      this.#paneOpenOperations.set(name, settled);
    };
    const operation = Promise.all(previous.map(pending => pending.catch(() => undefined)))
      .then(() => run(reserveNewPane));
    const settled = operation.then(() => undefined, () => undefined);
    for (const name of names) this.#paneOpenOperations.set(name, settled);
    void settled.then(() => {
      let changed = false;
      for (const name of names) {
        if (this.#paneOpenOperations.get(name) === settled) {
          this.#paneOpenOperations.delete(name);
          changed = true;
        }
      }
      if (!changed || this.#disposed) return;
      const settledUnavailable = names.some((name) => {
        const pane = this.#paneStateOf(name);
        const active = pane.tabs.find((tab) => tab.id === pane.activeTab);
        return (
          active?.kind === 'document' &&
          pane.editorAvailable === false &&
          (pane.mode !== 'reading' ||
            this.readingPresentation(name).kind === 'editor-readonly')
        );
      });
      if (settledUnavailable) {
        // The operation's own notification still sees its reservation as
        // pending. Publish after release so the shell can settle its loading
        // state and show an unavailable-editor message when needed.
        this.#notify();
      }
    });
    return settled.then(() => operation);
  }

  async #openDocumentNow(
    documentId: string,
    editorParent: unknown,
    opts: { pane?: string; address?: string; preserveFocus?: boolean },
  ): Promise<void> {
    const ref = this.#requireRef(documentId);
    const paneName = opts.pane ?? MAIN_PANE;
    const preserveFocus = opts.preserveFocus === true;
    // probe live owners before ensuring the target leaf. Ensuring
    // first would materialize a stray leaf for an unknown paneName even when
    // this open redirects to the live owner and leaves the target untouched.
    // single-owner redirect: a document already live in another pane
    // is never opened twice. Focus the existing owner tab and preserve its
    // session, dirty state, and handles; leave the target pane untouched and
    // never call `workspace.openDocument` (it would close the live session
    // and strand its unsaved source. Do not move the tab or synchronize
    // shared-session views.
    // Synchronous on the target lane only: no nested lane waits, so this
    // cannot deadlock against a concurrent owner-lane transition. The whole
    // redirect is one atomic mutation, mirroring the same-pane fast path.
    for (const [ownerName, owner] of this.#panes) {
      if (
        ownerName === paneName ||
        owner.documentId !== documentId ||
        owner.session === null
      ) {
        continue;
      }
      // Explicit opens also retry failed presentation acquisition on the
      // owner, using the owner's own host — never the target pane's DOM.
      // The live (possibly dirty) session is preserved; no storage reopen.
      if (
        !this.isPaneAttached(ownerName, this.#editorParents.get(ownerName) ?? null)
      ) {
        this.#syncPresentation(ownerName, preserveFocus);
      }
      const owned = owner.tabs.find(
        (tab) => tab.kind === 'document' && tab.documentId === documentId,
      );
      if (owned !== undefined) {
        owner.activeTab = owned.id;
      }
      if (this.#restoringHistory || this.#restoringTab) {
        this.#restoringHistory = false;
      } else {
        this.#pushHistory(
          ownerName,
          String(ref.location.resourceId),
          opts.address,
        );
      }
      if (opts.address !== undefined) {
        this.#revealThroughPresentation(ownerName, owner, opts.address);
      }
      if (!preserveFocus) {
        this.#focusedPane = ownerName;
        if (this.tabMode(ownerName) !== 'reading') owner.editor?.focus();
      }
      this.#notify();
      return;
    }
    // No live owner elsewhere: the target leaf is genuinely needed.
    this.#ensurePaneInTree(paneName);
    const pane = this.#pane(paneName);
    // Default the parent element to the target pane's own host so opening
    // into a background pane never mounts into another pane's DOM.
    const parent =
      editorParent !== undefined
        ? editorParent
        : (this.#editorParents.get(paneName) ?? null);
    if (editorParent !== undefined) {
      this.#editorParents.set(paneName, editorParent);
    }

    // Same-document address navigation must not tear the live session down:
    // when the same document is already active in this pane with a live
    // compatible session, only the address/reveal/history location changes.
    // The editor/session (and reader, in reading mode) stay alive.
    const liveSameDocument =
      pane.session !== null &&
      pane.documentId === documentId;
    if (liveSameDocument) {
      // Explicit opens also retry failed presentation acquisition. Preserve the
      // live dirty session; no storage reopen or availability signal is needed.
      if (!this.isPaneAttached(paneName, parent)) {
        this.#syncPresentation(paneName, preserveFocus);
      }
      const existing = pane.tabs.find(
        (tab) => tab.kind === 'document' && tab.documentId === documentId,
      );
      if (existing !== undefined) {
        pane.activeTab = existing.id;
      }
      if (this.#restoringHistory || this.#restoringTab) {
        this.#restoringHistory = false;
      } else {
        this.#pushHistory(
          paneName,
          String(ref.location.resourceId),
          opts.address,
        );
      }
      if (opts.address !== undefined) {
        const reading = this.tabMode(paneName) === 'reading';
        if (reading && pane.reader?.revealAddress !== undefined) {
          pane.reader.revealAddress(opts.address);
        } else {
          pane.editor?.revealAddress?.(opts.address);
        }
      }
      if (!preserveFocus) {
        this.#focusedPane = paneName;
        if (this.tabMode(paneName) !== 'reading') pane.editor?.focus();
      }
      this.#notify();
      return;
    }

    await this.#suspendActiveSession(pane);
    this.#editorParents.set(paneName, parent);

    const existing = pane.tabs.find(
      (tab) => tab.kind === 'document' && tab.documentId === documentId,
    );
    if (existing === undefined) {
      pane.tabs = [
        ...pane.tabs,
        { id: documentId, kind: 'document', documentId, viewId: null },
      ];
      pane.activeTab = documentId;
    } else {
      pane.activeTab = existing.id;
    }

    await this.#openSession(paneName, ref, parent, opts.address, preserveFocus);
    if (!preserveFocus) {
      this.#focusedPane = paneName;
    }
    this.#notify();
  }

  /**
   * Open a registered workspace view (e.g. the graph) as a tab in the target
   * pane. The pane's document session is saved and torn down while the view
   * tab is active; switching back to a document tab reopens it.
   *
   * When `opts.preserveFocus` is true, opening into another pane never
   * modifies global focus (background semantic): `#focusedPane` is left
   * exactly as found instead of restoring a possibly stale capture.
   */
  openView(
    viewId: string,
    opts: { pane?: string; preserveFocus?: boolean } = {},
  ): Promise<string> {
    const paneName = opts.pane ?? this.#focusedPane;
    return this.#queuePaneOperation(paneName, () =>
      this.#openViewNow(viewId, paneName, opts),
    );
  }

  async #openViewNow(
    viewId: string,
    paneName: string,
    opts: { preserveFocus?: boolean } = {},
  ): Promise<string> {
    this.#ensurePaneInTree(paneName);
    const pane = this.#pane(paneName);
    const preserveFocus = opts.preserveFocus === true;
    const focusTarget = (): void => {
      if (!preserveFocus) {
        this.#focusedPane = paneName;
      }
    };
    // One tab per view id per pane: re-opening activates the existing tab
    // (tearing down whatever session it displaced) instead of stacking a
    // duplicate — the same rule document opens follow.
    const existing = pane.tabs.find(
      (tab) => tab.kind === 'view' && tab.viewId === viewId,
    );
    if (existing !== undefined) {
      await this.#activateTabNow(paneName, existing.id);
      focusTarget();
      this.#recordViewHistory(paneName, viewId);
      this.#notify();
      return existing.id;
    }
    this.#viewCounter += 1;
    const tabId = `view:${viewId}:${this.#viewCounter}`;
    await this.#suspendActiveSession(pane);
    pane.tabs = [
      ...pane.tabs,
      { id: tabId, kind: 'view', documentId: null, viewId },
    ];
    pane.activeTab = tabId;
    focusTarget();
    this.#recordViewHistory(paneName, viewId);
    this.#notify();
    return tabId;
  }

  /**
   * View opens join the pane trail like document opens; a history-driven
   * open must not grow the trail (flag consumed, mirroring #openSession).
   */
  #recordViewHistory(paneName: string, viewId: string): void {
    if (this.#restoringHistory || this.#restoringTab) {
      this.#restoringHistory = false;
      return;
    }
    this.#pushHistory(paneName, `${VIEW_HISTORY_PREFIX}${viewId}`);
  }

  /**
   * Activate a tab within its pane: the outgoing session is saved and torn
   * down; document tabs reopen their session (without growing history).
   */
  async activateTab(pane: string, tabId: string): Promise<void> {
    return this.#queuePaneOperation(pane, () =>
      this.#activateTabNow(pane, tabId),
    );
  }

  async #activateTabNow(pane: string, tabId: string): Promise<void> {
    const runtime = this.#panes.get(pane);
    if (runtime === undefined || runtime.activeTab === tabId) return;
    const tab = runtime.tabs.find((candidate) => candidate.id === tabId);
    if (tab === undefined) return;
    // A tab can outlive its document when the document was deleted outside
    // the controller (e.g. the file-explorer service removes canonical
    // bytes directly). Clicking it must close the dangling tab and reveal
    // a neighbor — never throw `unknown document` and crash the shell.
    if (
      tab.kind === 'document' &&
      tab.documentId !== null &&
      !this.#hasDocument(tab.documentId)
    ) {
      await this.#closeTabNow(pane, tabId);
      return;
    }
    await this.#suspendActiveSession(runtime);
    runtime.activeTab = tabId;
    if (tab.kind === 'document' && tab.documentId !== null) {
      await this.#reopenQuietly(
        pane,
        tab.documentId,
        this.#editorParents.get(pane) ?? null,
      );
    }
    this.#notify();
  }

  /**
   * Close a tab. Closing a background tab only touches the strip; closing
   * the active tab tears down its session and activates a neighbor. When the
   * last tab goes away the pane closes and the tree rebalances.
   */
  async closeTab(pane: string, tabId: string): Promise<void> {
    return this.#queuePaneOperation(pane, () => this.#closeTabNow(pane, tabId));
  }

  async #closeTabNow(pane: string, tabId: string): Promise<void> {
    const runtime = this.#panes.get(pane);
    if (runtime === undefined) return;
    const index = runtime.tabs.findIndex((tab) => tab.id === tabId);
    if (index < 0) return;
    const tab = runtime.tabs[index];
    if (tab === undefined) return;
    const wasActive = runtime.activeTab === tabId;

    if (!wasActive) {
      if (tab.kind === 'document' && tab.documentId !== null) {
        const retained = this.#retainedSessions.get(tab.documentId);
        if (retained !== undefined) {
          if (retained.save !== null) await retained.save;
          if (retained.session.dirty) {
            await this.#saveSessionIfDirty(retained.session);
          }
          if (!retained.session.dirty && this.#retainedSessions.get(tab.documentId) === retained) {
            await this.#closeRetainedSession(tab.documentId, retained);
          }
        }
      }
      runtime.tabs = runtime.tabs.filter((tab) => tab.id !== tabId);
      runtime.modes.delete(tabId);
      this.#notify();
      return;
    }

    // Save before mutating the tab list. A failed save must leave the tab and
    // its pane visible so the user can recover instead of getting a blank
    // pane with no way back.
    await this.#saveIfDirty(runtime);

    // Read-only neighbor selection first: skip externally deleted documents
    // without mutating the strip, so a failed close below can keep the tab,
    // its mode and its pane exactly as the user left them.
    const openTabs = runtime.tabs.filter(
      (tab) =>
        tab.kind !== 'document' ||
        tab.documentId === null ||
        this.#hasDocument(tab.documentId),
    );
    const remaining = openTabs.filter((tab) => tab.id !== tabId);
    const next = remaining[Math.min(index, remaining.length - 1)];

    // Close before mutating anything. A failed close retains the tab,
    // activeTab, dock leaf and the session as the reachable recovery owner.
    await this.#teardownPaneSession(runtime);
    runtime.tabs = runtime.tabs.filter((tab) => tab.id !== tabId);
    runtime.modes.delete(tabId);
    // Drop externally deleted neighbors so they never render as raw ids.
    const valid = new Set(openTabs.map((tab) => tab.id));
    runtime.tabs = runtime.tabs.filter((tab) => valid.has(tab.id));
    for (const tab of [...runtime.modes.keys()]) {
      if (!valid.has(tab)) runtime.modes.delete(tab);
    }
    if (next !== undefined) {
      runtime.activeTab = next.id;
      if (next.kind === 'document' && next.documentId !== null) {
        await this.#reopenQuietly(
          pane,
          next.documentId,
          this.#editorParents.get(pane) ?? null,
        );
      }
    } else {
      runtime.activeTab = null;
      // Publish the tree change only after the session actually closed; a
      // failed close above never reaches this leaf removal.
      this.#removePaneFromTree(pane);
      this.#notify();
      return;
    }
    this.#notify();
  }

  /**
   * Close a pane, migrating its tabs into the neighboring pane (next in
   * visual order, else previous) so no open document is lost. Closing the
   * last pane empties the dock.
   */
  async closePane(pane: string): Promise<void> {
    // Migration chooses its neighbor at execution time; reserve current leaves
    // as well as the closing pane so that no neighbor transition is bypassed.
    return this.#queuePaneOperations([pane, ...this.leafIds()], () => this.#closePaneNow(pane));
  }

  async #closePaneNow(pane: string): Promise<void> {
    const runtime = this.#panes.get(pane);
    if (runtime === undefined) return;
    const leaves = this.leafIds();
    const neighbor =
      findLeaf(this.#root, pane) === null
        ? null
        : this.#migrationNeighbor(leaves, pane);
    if (neighbor === null) {
      // Pane is not in the tree (or is the last one): dispose outright.
      await this.#disposePaneRuntime(runtime);
      this.#removePaneFromTree(pane);
      this.#notify();
      return;
    }
    this.#migrateTabsInto(runtime, this.#pane(neighbor));

    await this.#disposePaneRuntime(runtime);
    this.#removePaneFromTree(pane);
    if (
      this.#focusedPane === pane ||
      !this.leafIds().includes(this.#focusedPane)
    ) {
      this.#focusedPane = neighbor;
    }
    this.#notify();
  }

  /** Move `source`'s tabs (and their modes) into `target`, deduplicating. */
  #migrateTabsInto(source: PaneRuntime, target: PaneRuntime): void {
    for (const tab of source.tabs) {
      const duplicate =
        tab.kind === 'document' &&
        target.tabs.some(
          (existing) =>
            existing.kind === 'document' &&
            existing.documentId === tab.documentId,
        );
      if (!duplicate) target.tabs = [...target.tabs, tab];
      const mode = source.modes.get(tab.id);
      if (mode !== undefined) target.modes.set(tab.id, mode);
    }
  }

  /** Reopen a pane's document without growing its history trail. */
  async #reopenQuietly(
    paneName: string,
    documentId: string,
    parent: unknown,
  ): Promise<void> {
    this.#restoringTab = true;
    try {
      await this.#openSession(paneName, this.#requireRef(documentId), parent);
    } finally {
      this.#restoringTab = false;
    }
  }

  #migrationNeighbor(leaves: string[], pane: string): string | null {
    const index = leaves.indexOf(pane);
    if (index < 0) return null;
    return leaves[index + 1] ?? leaves[index - 1] ?? null;
  }

  /**
   * Move a tab to another pane (with an optional strip index) or into a
   * fresh split beside a pane. The moved tab becomes active at its target.
   * When the source pane runs out of tabs it closes and the tree rebalances.
   */
  async moveTab(
    fromPane: string,
    tabId: string,
    target: DockMoveTarget,
    opts: { editorParent?: unknown; readerParent?: unknown } = {},
  ): Promise<string | null> {
    return this.#queuePaneOperations([fromPane, target.pane], reserveNewPane =>
      this.#moveTabNow(fromPane, tabId, target, opts, reserveNewPane));
  }

  async #moveTabNow(
    fromPane: string,
    tabId: string,
    target: DockMoveTarget,
    opts: { editorParent?: unknown; readerParent?: unknown },
    reserveNewPane: (name: string) => void,
  ): Promise<string | null> {
    const source = this.#panes.get(fromPane);
    if (source === undefined) return null;
    const tab = source.tabs.find((candidate) => candidate.id === tabId);
    if (tab === undefined) return null;

    // A strip reorder is a transition within one owner, not a transfer
    // between two panes. Keep the live editor when the active tab merely
    // changes position; when an inactive tab is dragged, replace the one
    // session once before activating it.
    if (target.kind === 'pane' && target.pane === fromPane) {
      const without = source.tabs.filter((candidate) => candidate.id !== tabId);
      const index = Math.max(
        0,
        Math.min(target.index ?? without.length, without.length),
      );
      source.tabs = [...without.slice(0, index), tab, ...without.slice(index)];
      if (source.activeTab !== tabId) {
        await this.#suspendActiveSession(source);
        source.activeTab = tabId;
        if (tab.kind === 'document' && tab.documentId !== null) {
          const parent =
            opts.editorParent !== undefined
              ? opts.editorParent
              : (this.#editorParents.get(fromPane) ?? null);
          this.#editorParents.set(fromPane, parent);
          if (opts.readerParent !== undefined) {
            this.#readerParents.set(fromPane, opts.readerParent);
          }
          await this.#reopenQuietly(fromPane, tab.documentId, parent);
        }
      }
      this.#focusedPane = fromPane;
      this.#notify();
      return null;
    }

    const existingTarget = target.kind === 'pane' ? this.#panes.get(target.pane) : undefined;
    // Settle the destination before detaching the authoritative source owner.
    // A failed save/close must leave the source tab, session and effects intact.
    if (source.activeTab === tabId) source.editor?.flush?.();
    if (existingTarget !== undefined) await this.#suspendActiveSession(existingTarget);
    const wasActive = source.activeTab === tabId;
    const sourceTabs = source.tabs;
    const remaining = source.tabs.filter((candidate) => candidate.id !== tabId);
    const mode = source.modes.get(tabId);
    // Transfer the live session, not saved/reopened bytes, to the destination.
    const transferred = wasActive && source.session !== null ? {
      session: source.session,
      kindId: source.kindId,
      documentId: source.documentId,
      documentTitle: source.documentTitle,
      documentPath: source.documentPath,
    } : null;
    if (transferred !== null) {
      this.#teardownEditor(source);
      source.session = null; // teardown below releases effects, not this session
    }
    source.tabs = remaining;
    source.modes.delete(tabId);
    if (wasActive && remaining.length === 0) {
      source.activeTab = null;
      // Reclaim an emptied source pane before waiting for the provider/session
      // teardown so the dock never renders a blank placeholder pane.
      if (fromPane !== target.pane) this.#removePaneFromTree(fromPane);
      await this.#teardownPaneSession(source);
    } else if (wasActive) {
      await this.#teardownPaneSession(source);
      const next = remaining[remaining.length - 1];
      if (next !== undefined) {
        source.activeTab = next.id;
        if (next.kind === 'document' && next.documentId !== null) {
          try {
            await this.#reopenQuietly(
              fromPane,
              next.documentId,
              this.#editorParents.get(fromPane) ?? null,
            );
          } catch (error) {
            if (transferred !== null) {
              // A neighbor may fail while opening or mounting. Release any
              // partial neighbor effects, then restore the unsaved source
              // session without a storage read, even if cleanup also fails.
              try {
                await this.#teardownPaneSession(source);
              } finally {
                Object.assign(source, transferred);
                source.tabs = sourceTabs;
                source.activeTab = tabId;
                if (mode !== undefined) source.modes.set(tabId, mode);
                this.#subscribeSession(source);
                this.#syncPresentation(fromPane, true);
                this.#notify();
              }
            }
            throw error;
          }
        }
      } else {
        source.activeTab = null;
      }
    }
    let createdPane: string | null = null;
    let targetPane: string;
    let insertTabs: (tabs: DockTab[]) => DockTab[] = (tabs) => [...tabs, tab];
    if (target.kind === 'split') {
      const newPaneId = this.#nextPaneId();
      reserveNewPane(newPaneId);
      const split = splitLeaf(
        this.#root,
        target.pane,
        target.direction,
        newPaneId,
      );
      this.#root = split.root;
      createdPane = split.created;
      targetPane = split.created;
      this.#pane(targetPane);
    } else {
      targetPane = target.pane;
      this.#ensurePaneInTree(targetPane);
      this.#pane(targetPane);
      insertTabs = (tabs) => {
        const without = tabs.filter((candidate) => candidate.id !== tabId);
        const index = Math.max(
          0,
          Math.min(target.index ?? without.length, without.length),
        );
        return [...without.slice(0, index), tab, ...without.slice(index)];
      };
    }

    const targetRuntime = this.#pane(targetPane);
    // The destination may already own an editor. Its effect scope must be
    // fully torn down before the incoming tab mounts into the same host.
    // Existing destinations were suspended before releasing the source;
    // a newly created destination has no session to suspend.
    targetRuntime.tabs = insertTabs(targetRuntime.tabs);
    if (mode !== undefined) targetRuntime.modes.set(tabId, mode);
    targetRuntime.activeTab = tabId;

    if (tab.kind === 'document' && tab.documentId !== null) {
      const parent =
        opts.editorParent !== undefined
          ? opts.editorParent
          : this.#editorParents.get(targetPane);
      if (parent !== undefined) {
        this.#editorParents.set(targetPane, parent);
        if (opts.readerParent !== undefined) {
          this.#readerParents.set(targetPane, opts.readerParent);
        }
      }
      if (transferred !== null) {
        Object.assign(targetRuntime, transferred);
        this.#subscribeSession(targetRuntime);
        this.#syncPresentation(targetPane);
      } else {
        // A fresh split has no committed host yet. Open the session now;
        // host binding will mount its editor when React commits the pane.
        await this.#reopenQuietly(targetPane, tab.documentId, parent ?? null);
      }
    }

    this.#focusedPane = targetPane;
    this.#notify();
    return createdPane;
  }

  /**
   * Split `pane` in the requested direction, focusing and returning the new
   * (empty) pane. When `opts.preserveFocus` is true, the split never modifies
   * global focus (background split semantic): `#focusedPane` is left exactly
   * as found.
   */
  splitPane(
    pane: string,
    direction: 'right' | 'down' | 'left' | 'up',
    opts: { preserveFocus?: boolean } = {},
  ): string {
    this.#assertPaneAdmission();
    const anchor =
      findLeaf(this.#root, pane) !== null
        ? pane
        : (firstLeaf(this.#root) ?? MAIN_PANE);
    const split = splitLeaf(this.#root, anchor, direction, this.#nextPaneId());
    this.#root = split.root;
    this.#pane(split.created);
    if (opts.preserveFocus !== true) {
      this.#focusedPane = split.created;
    }
    this.#notify();
    return split.created;
  }

  /**
   * Move a whole pane (its tab strip) to sit beside `targetPane` in the
   * given direction — dragging a group by its strip.
   */
  movePaneBeside(
    pane: string,
    targetPane: string,
    direction: 'right' | 'down' | 'left' | 'up',
  ): void {
    if (pane === targetPane || findLeaf(this.#root, pane) === null) return;
    const detached = detachLeaf(this.#root, pane);
    if (detached.subtree === null || detached.root === null) return;
    const { axis, side } = sideForDirection(direction);
    this.#root = insertNode(
      detached.root,
      targetPane,
      axis,
      side,
      detached.subtree,
    );
    if (!this.leafIds().includes(this.#focusedPane)) {
      this.#focusedPane = firstLeaf(this.#root) ?? MAIN_PANE;
    }
    this.#notify();
  }

  /** Set the ratio of the split that directly contains `pane` (clamped). */
  setSplitRatio(pane: string, ratio: number): void {
    if (findLeaf(this.#root, pane) === null) return;
    this.#root = setLeafRatio(this.#root, pane, ratio);
    this.#notify();
  }

  /** Set the ratio of the exact split identified by its root-relative path. */
  setSplitRatioAt(path: readonly ('first' | 'second')[], ratio: number): void {
    this.#root = setDockSplitRatioAt(this.#root, path, ratio);
    this.#notify();
  }

  /** Toggle the maximized pane (`undefined` targets the focused pane). */
  toggleMaximize(pane?: string): void {
    const target = pane ?? this.#focusedPane;
    this.#maximizedPane = this.#maximizedPane === target ? null : target;
    this.#notify();
  }

  /** Close every pane except the focused one, migrating tabs into it. */
  async closeOtherPanes(keep?: string): Promise<void> {
    this.#assertPaneAdmission();
    const target = keep ?? this.#focusedPane;
    return this.#reserveTerminal(() => this.#closeOtherPanesNow(target));
  }

  async #closeOtherPanesNow(target: string): Promise<void> {
    const others = this.leafIds().filter((leaf) => leaf !== target);
    if (others.length === 0) return;
    const kept = this.#pane(target);
    for (const pane of others) {
      const runtime = this.#panes.get(pane);
      if (runtime === undefined) continue;
      this.#migrateTabsInto(runtime, kept);
      await this.#disposePaneRuntime(runtime);
      this.#removePaneFromTree(pane);
    }
    this.#focusedPane = target;
    this.#notify();
  }

  /** Move the focused pane's active tab into the next pane (split if none). */
  async moveActiveTabToNextPane(): Promise<void> {
    const from = this.#focusedPane;
    const runtime = this.#panes.get(from);
    const tabId = runtime?.activeTab;
    if (runtime === undefined || tabId === null || tabId === undefined) return;
    const leaves = this.leafIds();
    const index = leaves.indexOf(from);
    const next = leaves[index + 1];
    if (next !== undefined) {
      await this.moveTab(from, tabId, { kind: 'pane', pane: next });
      return;
    }
    const previous = index > 0 ? leaves[index - 1] : null;
    if (previous !== null && previous !== undefined) {
      await this.moveTab(from, tabId, { kind: 'pane', pane: previous });
      return;
    }
    await this.moveTab(from, tabId, {
      kind: 'split',
      pane: from,
      direction: 'right',
    });
  }

  /** Focus the next/previous leaf in visual order (wrapping around). */
  cycleFocus(step: 1 | -1): void {
    const leaves = this.leafIds();
    if (leaves.length === 0) return;
    const index = leaves.indexOf(this.#focusedPane);
    const next =
      leaves[(index + step + leaves.length) % leaves.length] ?? leaves[0];
    if (next !== undefined) this.focusPane(next);
  }

  /**
   * Resolve a `[[…]]`/Markdown link destination and open its document,
   * creating a Markdown note when the destination is missing
   * (Obsidian-style create-on-click). Returns which happened.
   *
   * Address-aware: `[[Note#Heading]]` and Markdown `[text](Note#frag)`
   * resolve `Note`, open it, reveal the fragment through the active
   * editor/reader, and store `{ resourceId, address }` history.
   *
   * Flavor convergence: canonical copy-link JSON
   * (`{documentId,kindId,resourceId,address?}`) routes by stable identity
   * through `openResourceTarget`, so picker/paste/menu/copy-link share one
   * validation (`isResourceLinkTarget`) and one exact reveal. Browser URLs
   * are never canonical and are rejected without creating a document.
   * With `opts.openBeside`, the target opens in a fresh split beside the
   * source pane so the source stays visible.
   *
   * Background links: `opts.preserveFocus` threads through the whole
   * open (target `openDocument`, the beside `splitPane`, and the trailing
   * `revealAddress` safety net) so a background open never steals focus.
   *
   * Failures are coded `FroglightError`s (`LINK_ERROR_CODES`): malformed
   * copy-link JSON (`{`/`[`-leading text that parses to `null`) throws
   * `INVALID_RESOURCE_LINK` instead of falling through to create-on-click;
   * URL schemes and unsanitizable paths throw `INVALID_LINK_DESTINATION`.
   */
  async openLink(
    destination: string,
    opts: {
      pane?: string;
      openBeside?: boolean;
      preserveFocus?: boolean;
    } = {},
  ): Promise<OpenLinkResult> {
    if (typeof destination !== 'string') {
      throw linkError(
        LINK_ERROR_CODES.INVALID_RESOURCE_LINK,
        `invalid resource link ${JSON.stringify(destination)}`,
      );
    }
    const preserveFocus = opts.preserveFocus === true;
    if (opts.openBeside === true) {
      return this.openLinkBeside(destination, {
        ...(opts.pane !== undefined ? { pane: opts.pane } : {}),
        ...(preserveFocus ? { preserveFocus: true as const } : {}),
      });
    }
    const trimmed = destination.trim();
    if (trimmed.length > MAX_LINK_DESTINATION_LENGTH) {
      throw linkError(
        LINK_ERROR_CODES.INVALID_LINK_DESTINATION,
        `link destination exceeds ${MAX_LINK_DESTINATION_LENGTH} characters`,
      );
    }
    // Copy-link/paste flavor first: identity-based, rename/move-safe.
    const pasted = parseResourceLink(trimmed);
    if (pasted !== null) {
      return this.openResourceTarget(pasted, {
        ...(opts.pane !== undefined ? { pane: opts.pane } : {}),
        ...(preserveFocus ? { preserveFocus: true as const } : {}),
      });
    }
    // Malformed copy-link JSON must never become a document: `{`/`[`-leading
    // text that failed to parse is a broken identity link, not a note title.
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      throw linkError(
        LINK_ERROR_CODES.INVALID_RESOURCE_LINK,
        `invalid resource link ${JSON.stringify(destination)}`,
      );
    }
    if (URL_SCHEME_PREFIX.test(trimmed)) {
      throw linkError(
        LINK_ERROR_CODES.INVALID_LINK_DESTINATION,
        `cannot create a document for link ${JSON.stringify(destination)}`,
      );
    }
    const paneName = opts.pane ?? this.#focusedPane;
    const workspace = this.#requireWorkspace();
    const resolved = resolveDocumentLink(
      workspace,
      destination,
      this.#sourceResourceForPane(workspace, paneName),
    );
    const { fragment } = splitLinkDestination(destination.trim());
    const address =
      fragment !== undefined && fragment !== '' ? fragment : undefined;
    const revealOpts = preserveFocus ? { preserveFocus: true as const } : {};
    if (resolved !== null) {
      const id = String(resolved.ref.documentId);
      await this.openDocument(
        id,
        undefined,
        address === undefined
          ? { pane: paneName, ...revealOpts }
          : { pane: paneName, address, ...revealOpts },
      );
      let revealed = true;
      if (address !== undefined) {
        // `openDocument` already reveals via `#openSession`, but an
        // already-open tab that skips session teardown still needs the
        // reveal: `#openDocumentNow` always reopens, so this is a no-op
        // when the session was rebuilt and the safety net when it was not.
        // History already carries the address from `#openSession`.
        // a cross-pane duplicate focuses the live owner, so reveal
        // where the document actually ended up, not the requested pane.
        revealed = this.revealAddress(this.#owningPaneFor(id, paneName), address, revealOpts);
      }
      return { created: false, documentId: id, revealed };
    }
    const { path } = splitLinkDestination(destination.trim());
    const safePath = sanitizeLinkPath(path);
    if (safePath === null)
      throw linkError(
        LINK_ERROR_CODES.INVALID_LINK_DESTINATION,
        `cannot create a document for link ${JSON.stringify(destination)}`,
      );
    const ref = await this.createAndOpen(safePath, undefined, {
      pane: paneName,
      ...(address !== undefined ? { address } : {}),
      ...revealOpts,
    });
    if (ref === null)
      throw linkError(
        LINK_ERROR_CODES.INVALID_LINK_DESTINATION,
        `failed to create document for link ${JSON.stringify(destination)}`,
      );
    let revealed = true;
    if (address !== undefined) {
      // `createAndOpen` may have focused a live owner instead of `paneName`
      // reveal where the document actually ended up.
      revealed = this.revealAddress(this.#owningPaneFor(String(ref.documentId), paneName), address, revealOpts);
    }
    return { created: true, documentId: ref.documentId, revealed };
  }

  /**
   * Stable copy-link target for a document plus an optional opaque
   * sub-document address (heading slug / block id / page id / object id).
   * Returns `null` when the document is unknown. The address is stored
   * verbatim and never interpreted here.
   */
  resourceTargetFor(
    documentId: string,
    address?: string,
  ): ResourceTarget | null {
    const workspace = this.#requireWorkspace();
    const ref = workspace
      .listDocuments()
      .find((candidate) => String(candidate.documentId) === documentId);
    if (ref === undefined) return null;
    return resourceTargetForDocument(ref, address);
  }

  /**
   * Canonical copy-link clipboard form for a document plus an optional
   * opaque sub-document address. Returns `null` when the document is
   * unknown. Follows `formatResourceLink` key order (byte-stable).
   */
  copyLinkFor(documentId: string, address?: string): string | null {
    const target = this.resourceTargetFor(documentId, address);
    if (target === null) return null;
    return formatResourceLink(target);
  }

  /**
   * Open a validated `ResourceTarget` by stable identity.
   * Every link flavor (picker/paste/menu/copy-link) converges here on the
   * single `isResourceLinkTarget` validation; divergent payloads
   * (path/title-shaped, partial identities) throw `INVALID_RESOURCE_LINK`
   * instead of opening, and well-formed but unknown identities throw
   * `UNKNOWN_RESOURCE_TARGET`. Resolution is identity-based (`documentId`,
   * `resourceId` fallback) so rename/move preserves links; the opaque
   * address is passed verbatim to the existing `revealAddress` seam and
   * lands exact after reopen. The returned `revealed` flag propagates the
   * seam's boolean — never a silent success (honesty): boolean
   * seams report exact, legacy `void` seams normalize to `true` (seam
   * presence).
   *
   * `opts.preserveFocus` threads through the beside `splitPane`, the
   * target `openDocument`, and the trailing `revealAddress` safety net.
   */
  async openResourceTarget(
    target: unknown,
    opts: { pane?: string; openBeside?: boolean; preserveFocus?: boolean } = {},
  ): Promise<OpenLinkResult> {
    if (!isResourceLinkTarget(target)) {
      throw linkError(
        LINK_ERROR_CODES.INVALID_RESOURCE_LINK,
        'invalid resource link target',
      );
    }
    const preserveFocus = opts.preserveFocus === true;
    const revealOpts = preserveFocus ? { preserveFocus: true as const } : {};
    if (opts.openBeside === true) {
      const sourcePane = opts.pane ?? this.#focusedPane;
      const workspace = this.#requireWorkspace();
      const resolved = resolveResourceTarget(workspace, target);
      if (resolved === null) {
        throw linkError(
          LINK_ERROR_CODES.UNKNOWN_RESOURCE_TARGET,
          `unknown document ${target.documentId}`,
        );
      }
      const id = String(resolved.ref.documentId);
      // pre-split guard: a live duplicate redirects to its owner, so
      // never materialize a fresh leaf it will not use. Open via the live
      // owner lane (source stays untouched even if the owner vanishes
      // mid-flight) and keep beside return shape.
      const live = this.#liveOwnerOf(id);
      if (live !== null) {
        await this.openDocument(
          id,
          undefined,
          resolved.address === undefined
            ? { pane: live, ...revealOpts }
            : { pane: live, address: resolved.address, ...revealOpts },
        );
        let revealedLive = true;
        if (resolved.address !== undefined) {
          revealedLive = this.revealAddress(this.#owningPaneFor(id, live), resolved.address, revealOpts);
        }
        return { created: false, documentId: id, revealed: revealedLive };
      }
      const created = this.splitPane(
        sourcePane,
        'right',
        preserveFocus ? { preserveFocus: true } : {},
      );
      await this.openDocument(
        id,
        undefined,
        resolved.address === undefined
          ? { pane: created, ...revealOpts }
          : { pane: created, address: resolved.address, ...revealOpts },
      );
      // Race net: the owner may have appeared after the pre-split probe.
      this.#discardRedirectedSplit(created, id);
      let revealed = true;
      if (resolved.address !== undefined) {
        revealed = this.revealAddress(this.#owningPaneFor(id, created), resolved.address, revealOpts);
      }
      return { created: false, documentId: id, revealed };
    }
    const paneName = opts.pane ?? this.#focusedPane;
    const workspace = this.#requireWorkspace();
    const resolved = resolveResourceTarget(workspace, target);
    if (resolved === null) {
      throw linkError(
        LINK_ERROR_CODES.UNKNOWN_RESOURCE_TARGET,
        `unknown document ${target.documentId}`,
      );
    }
    const id = String(resolved.ref.documentId);
    await this.openDocument(
      id,
      undefined,
      resolved.address === undefined
        ? { pane: paneName, ...revealOpts }
        : { pane: paneName, address: resolved.address, ...revealOpts },
    );
    let revealed = true;
    if (resolved.address !== undefined) {
      // Safety net for the already-open fast path (mirrors `openLink`).
      // reveal where the document actually ended up after a
      // cross-pane duplicate redirect, not the requested pane.
      revealed = this.revealAddress(this.#owningPaneFor(id, paneName), resolved.address, revealOpts);
    }
    return { created: false, documentId: id, revealed };
  }

  /**
   * Open any link destination beside the source pane (split-pane).
   * The source stays visible: a fresh split is created beside it and the
   * target opens there with exact reveal. Copy-link JSON routes by stable
   * identity; path destinations keep the `openLink` resolution plus
   * create-on-click, opening/creating in the new pane.
   *
   * The split is created only after the destination validates (resolve +
   * safe-path): a rejected destination throws before any pane exists, so
   * the pane count and focus are unchanged on the failing path.
   * `opts.preserveFocus` threads through the split, the target open, and
   * the trailing reveal so a background beside-open never steals focus.
   */
  async openLinkBeside(
    destination: string,
    opts: { pane?: string; preserveFocus?: boolean } = {},
  ): Promise<OpenLinkResult> {
    if (typeof destination !== 'string') {
      throw linkError(
        LINK_ERROR_CODES.INVALID_RESOURCE_LINK,
        `invalid resource link ${JSON.stringify(destination)}`,
      );
    }
    const preserveFocus = opts.preserveFocus === true;
    const revealOpts = preserveFocus ? { preserveFocus: true as const } : {};
    const splitOpts = preserveFocus ? { preserveFocus: true } : {};
    const sourcePane = opts.pane ?? this.#focusedPane;
    const trimmed = destination.trim();
    if (trimmed.length > MAX_LINK_DESTINATION_LENGTH) {
      throw linkError(
        LINK_ERROR_CODES.INVALID_LINK_DESTINATION,
        `link destination exceeds ${MAX_LINK_DESTINATION_LENGTH} characters`,
      );
    }
    const pasted = parseResourceLink(trimmed);
    if (pasted !== null) {
      return this.openResourceTarget(pasted, {
        pane: sourcePane,
        openBeside: true,
        ...(preserveFocus ? { preserveFocus: true as const } : {}),
      });
    }
    // Malformed copy-link JSON is a broken identity link, never a note
    // title: reject before any pane is created (no split leak, no doc).
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      throw linkError(
        LINK_ERROR_CODES.INVALID_RESOURCE_LINK,
        `invalid resource link ${JSON.stringify(destination)}`,
      );
    }
    if (URL_SCHEME_PREFIX.test(trimmed)) {
      throw linkError(
        LINK_ERROR_CODES.INVALID_LINK_DESTINATION,
        `cannot create a document for link ${JSON.stringify(destination)}`,
      );
    }
    const workspace = this.#requireWorkspace();
    const resolved = resolveDocumentLink(
      workspace,
      destination,
      this.#sourceResourceForPane(workspace, sourcePane),
    );
    const { fragment } = splitLinkDestination(trimmed);
    const address =
      fragment !== undefined && fragment !== '' ? fragment : undefined;
    if (resolved !== null) {
      const id = String(resolved.ref.documentId);
      // pre-split guard (mirrors openResourceTarget beside): a live
      // duplicate redirects to its owner, so skip the fresh split entirely.
      const live = this.#liveOwnerOf(id);
      if (live !== null) {
        await this.openDocument(
          id,
          undefined,
          address === undefined
            ? { pane: live, ...revealOpts }
            : { pane: live, address, ...revealOpts },
        );
        let revealedLive = true;
        if (address !== undefined) {
          revealedLive = this.revealAddress(this.#owningPaneFor(id, live), address, revealOpts);
        }
        return { created: false, documentId: id, revealed: revealedLive };
      }
      const created = this.splitPane(sourcePane, 'right', splitOpts);
      await this.openDocument(
        id,
        undefined,
        address === undefined
          ? { pane: created, ...revealOpts }
          : { pane: created, address, ...revealOpts },
      );
      // Race net: the owner may have appeared after the pre-split probe.
      this.#discardRedirectedSplit(created, id);
      let revealed = true;
      if (address !== undefined) {
        revealed = this.revealAddress(this.#owningPaneFor(id, created), address, revealOpts);
      }
      return { created: false, documentId: id, revealed };
    }
    const { path } = splitLinkDestination(trimmed);
    const safePath = sanitizeLinkPath(path);
    if (safePath === null)
      throw linkError(
        LINK_ERROR_CODES.INVALID_LINK_DESTINATION,
        `cannot create a document for link ${JSON.stringify(destination)}`,
      );
    const created = this.splitPane(sourcePane, 'right', splitOpts);
    const ref = await this.createAndOpen(safePath, undefined, {
      pane: created,
      ...(address !== undefined ? { address } : {}),
      ...revealOpts,
    });
    if (ref === null)
      throw linkError(
        LINK_ERROR_CODES.INVALID_LINK_DESTINATION,
        `failed to create document for link ${JSON.stringify(destination)}`,
      );
    // an existing live document opened via create-on-click path
    // redirects to its owner; discard the unused fresh split.
    this.#discardRedirectedSplit(created, String(ref.documentId));
    let revealed = true;
    if (address !== undefined) {
      // `createAndOpen` may have focused a live owner instead of the fresh
      // split; reveal where the document actually ended up.
      revealed = this.revealAddress(this.#owningPaneFor(String(ref.documentId), created), address, revealOpts);
    }
    return { created: true, documentId: ref.documentId, revealed };
  }

  /** Navigate one step back through the focused pane's workspace history. */
  async goBack(): Promise<boolean> {
    return this.#navigate(-1);
  }

  /** Move a document to a new workspace path, refreshing derived state. */
  async moveDocumentTo(documentId: string, toPath: string): Promise<void> {
    const workspace = this.#requireWorkspace();
    await workspace.moveDocument(
      documentId as DocumentId,
      workspacePath(toPath),
    );
    for (const runtime of this.#panes.values()) {
      if (runtime.documentId === documentId) {
        const ref = workspace
          .listDocuments()
          .find((candidate) => String(candidate.documentId) === documentId);
        if (ref !== undefined) {
          runtime.documentPath = String(
            workspace.resolveResourcePath(ref.location.resourceId),
          );
          runtime.documentTitle = pathName(
            workspace.resolveResourcePath(ref.location.resourceId),
          );
        }
      }
    }
    await workspace.rebuildDerivedState();
    this.#notify();
  }

  /**
   * Delete a document. Its tabs disappear from every pane; panes showing it
   * tear the session down and activate a neighbor.
   */
  async deleteDocument(documentId: string): Promise<void> {
    const paneNames = [...this.#panes].filter(([, runtime]) =>
      runtime.documentId === documentId || runtime.tabs.some(tab => tab.documentId === documentId),
    ).map(([pane]) => pane);
    return this.#queuePaneOperations(paneNames.length > 0 ? paneNames : [MAIN_PANE], async () => {
      const workspace = this.#requireWorkspace();
      await this.#drainDocumentSession(documentId, true);
      await this.#removeDocumentTabs(documentId);
      await workspace.removeDocument(documentId as DocumentId);
      await workspace.rebuildDerivedState();
      this.#notify();
    });
  }

  /**
   * Prune tabs whose documents no longer exist in the workspace.
   *
   * The file-explorer service removes canonical bytes directly
   * (`workspace.removeDocument`) without going through the controller, so a
   * tree delete would otherwise leave dangling tabs that render as raw ids
   * and throw `unknown document` when activated. The shell calls this after
   * external deletions (and it is safe to call when nothing is missing).
   */
  async pruneMissingDocuments(): Promise<void> {
    let workspace: WorkspaceService;
    try {
      workspace = this.#requireWorkspace();
    } catch {
      return;
    }
    let existing: Set<string>;
    try {
      existing = new Set(
        workspace.listDocuments().map((ref) => String(ref.documentId)),
      );
    } catch {
      return;
    }
    const missing = new Set<string>();
    for (const runtime of this.#panes.values()) {
      for (const tab of runtime.tabs) {
        if (
          tab.kind === 'document' &&
          tab.documentId !== null &&
          !existing.has(tab.documentId)
        ) {
          missing.add(tab.documentId);
        }
      }
      // An active session can also outlive an external removal even when
      // its tab was already pruned elsewhere (e.g. layout restore races).
      if (
        runtime.documentId !== null &&
        !existing.has(runtime.documentId) &&
        !runtime.tabs.some((tab) => tab.documentId === runtime.documentId)
      ) {
        missing.add(runtime.documentId);
      }
    }
    for (const documentId of this.#retainedSessions.keys()) {
      if (!existing.has(documentId)) missing.add(documentId);
    }
    if (missing.size === 0) return;
    const affectedPanes = [...this.#panes].filter(([, runtime]) =>
      runtime.documentId !== null && missing.has(runtime.documentId) ||
      runtime.tabs.some(tab => tab.documentId !== null && missing.has(tab.documentId)),
    ).map(([pane]) => pane);
    return this.#queuePaneOperations(affectedPanes.length > 0 ? affectedPanes : [MAIN_PANE], async () => {
      for (const documentId of missing) {
        await this.#drainDocumentSession(documentId, false);
        await this.#removeDocumentTabs(documentId, false);
      }
      this.#notify();
    });
  }

  /** Strip one document's tabs from every pane, reopening neighbors. */
  async #drainDocumentSession(documentId: string, saveDirty: boolean): Promise<void> {
    const runtime = this.#paneForDocument(documentId);
    const retained = this.#retainedSessions.get(documentId);
    const session = runtime?.session ?? retained?.session ??
      this.#requireWorkspace().getOpenDocument(documentId as DocumentId) ?? null;
    if (session === null) return;
    if (runtime !== null && runtime !== undefined) runtime.editor?.flush?.();
    const pending = this.#sessionSaveOperations.get(session);
    if (pending !== undefined) await pending;
    if (saveDirty && session.dirty) {
      await this.#saveIfDirty(runtime ?? ({ session, editor: null } as PaneRuntime));
    }
    if (retained !== undefined && this.#retainedSessions.get(documentId) === retained) {
      await this.#closeRetainedSession(documentId, retained);
    }
  }

  #paneForDocument(documentId: string): PaneRuntime | null {
    return [...this.#panes.values()].find(pane => pane.documentId === documentId) ?? null;
  }

  async #closeRetainedSession(documentId: string, retained: RetainedSession): Promise<void> {
    const closing = retained.session.close();
    retained.close = closing;
    try {
      await closing;
    } catch (error) {
      retained.close = null;
      throw error;
    }
    if (this.#retainedSessions.get(documentId) === retained) {
      this.#retainedSessions.delete(documentId);
    }
  }

  async #removeDocumentTabs(documentId: string, saveBeforeRemoval = true): Promise<void> {
    for (const [pane, runtime] of [...this.#panes.entries()]) {
      if (
        runtime.documentId === documentId ||
        runtime.tabs.some((tab) => tab.documentId === documentId)
      ) {
        const ownedActiveSession = runtime.documentId === documentId;
        const wasActive =
          runtime.activeTab !== null &&
          runtime.tabs.find((tab) => tab.id === runtime.activeTab)
            ?.documentId === documentId;
        if (wasActive || ownedActiveSession) {
          if (saveBeforeRemoval) await this.#saveIfDirty(runtime);
          await this.#teardownPaneSession(runtime);
        }
        runtime.tabs = runtime.tabs.filter(
          (tab) => tab.documentId !== documentId,
        );
        runtime.modes.delete(documentId);
        if (
          runtime.activeTab !== null &&
          runtime.tabs.every((tab) => tab.id !== runtime.activeTab)
        ) {
          runtime.activeTab = null;
        }
        if (wasActive || ownedActiveSession) {
          // The neighbor may itself have been deleted externally (folder
          // deletes); skip any tabs whose documents are gone.
          const next = runtime.tabs.find(
            (tab) =>
              tab.id === runtime.activeTab &&
              (tab.kind !== 'document' ||
                tab.documentId === null ||
                this.#hasDocument(tab.documentId)),
          );
          if (next === undefined && runtime.activeTab !== null) {
            // Active tab id is stale but other valid tabs remain: fall back
            // to the first valid neighbor instead of leaving a blank pane.
            const fallback = runtime.tabs.find(
              (tab) =>
                tab.kind !== 'document' ||
                tab.documentId === null ||
                this.#hasDocument(tab.documentId),
            );
            if (fallback !== undefined) runtime.activeTab = fallback.id;
          }
          const target = runtime.tabs.find(
            (tab) => tab.id === runtime.activeTab,
          );
          if (
            target !== undefined &&
            target.kind === 'document' &&
            target.documentId !== null &&
            this.#hasDocument(target.documentId)
          ) {
            await this.#reopenQuietly(
              pane,
              target.documentId,
              this.#editorParents.get(pane) ?? null,
            );
          } else if (target?.kind === 'view') {
            // View tabs need no session; activeTab already points at them.
          } else if (runtime.activeTab !== null && target === undefined) {
            runtime.activeTab = null;
          }
          // Prune any remaining dangling document tabs in this pane that
          // were not the active one (folder deletes remove several at once).
          runtime.tabs = runtime.tabs.filter(
            (tab) =>
              tab.kind !== 'document' ||
              tab.documentId === null ||
              this.#hasDocument(tab.documentId),
          );
          if (
            runtime.activeTab !== null &&
            runtime.tabs.every((tab) => tab.id !== runtime.activeTab)
          ) {
            runtime.activeTab =
              runtime.tabs.find(
                (tab) =>
                  tab.kind !== 'document' ||
                  tab.documentId === null ||
                  this.#hasDocument(tab.documentId),
              )?.id ?? null;
          }
        } else {
          // Background pane: drop any other dangling tabs left by a folder
          // delete without touching the live session.
          runtime.tabs = runtime.tabs.filter(
            (tab) =>
              tab.kind !== 'document' ||
              tab.documentId === null ||
              this.#hasDocument(tab.documentId),
          );
        }
      }
    }
  }

  /** Create a Markdown note named `name` inside `folder` ('' for root). */
  async createMarkdownNote(folder: string, name: string): Promise<DocumentRef> {
    const trimmedName = name.trim().replace(/\.md$/i, '');
    const safeFolder = folder.replace(/^\/+|\/+$/g, '');
    const path =
      safeFolder === ''
        ? `${trimmedName}.md`
        : `${safeFolder}/${trimmedName}.md`;
    const ref = await this.createAndOpen(path);
    if (ref === null)
      throw new Error(`failed to create note at ${JSON.stringify(path)}`);
    return ref;
  }

  /** Navigate one step forward through the focused pane's workspace history. */
  async goForward(): Promise<boolean> {
    return this.#navigate(1);
  }

  /** Make `pane` the target of state/save/history operations and focus its editor. */
  focusPane(pane: string): void {
    if (findLeaf(this.#root, pane) === null) return;
    this.#focusedPane = pane;
    const runtime = this.#pane(pane);
    if (this.tabMode(pane) !== 'reading') runtime.editor?.focus();
    this.#notify();
  }

  /** Presentation mode of the given tab (defaults to its pane's active tab). */
  tabMode(pane: string, tabId?: string): PaneMode {
    const runtime = this.#panes.get(pane);
    const id = tabId ?? runtime?.activeTab ?? null;
    return id !== null ? (runtime?.modes.get(id) ?? 'edit') : 'edit';
  }

  /** Supported modes from core kind metadata, never inferred from providers. */
  availableTabModes(pane: string, tabId?: string): readonly PaneMode[] {
    const runtime = this.#panes.get(pane);
    const id = tabId ?? runtime?.activeTab;
    const tab = runtime?.tabs.find((candidate) => candidate.id === id);
    if (tab?.kind !== 'document') return DEFAULT_DOCUMENT_PRESENTATION_MODES;
    let kindId = runtime !== undefined && runtime.activeTab === id ? runtime.kindId : null;
    if (kindId === null) {
      kindId = this.#app.getWorkspace()?.listDocuments()
        .find((ref) => String(ref.documentId) === tab.documentId)?.kindId ?? null;
    }
    return (kindId === null ? null : this.#app.getDocumentKind?.(kindId)?.presentationModes)
      ?? DEFAULT_DOCUMENT_PRESENTATION_MODES;
  }

  /** Set a supported mode; unsupported direct calls are rejected before mutation. */
  setTabMode(pane: string, tabId: string, mode: PaneMode): void {
    if (!this.availableTabModes(pane, tabId).includes(mode)) {
      throw new RangeError(`Unsupported document mode: ${mode}`);
    }
    const runtime = this.#pane(pane);
    const previousMode = this.tabMode(pane, tabId);
    if (previousMode === mode) return;
    runtime.modes.set(tabId, mode);
    try {
      if (runtime.activeTab === tabId) this.#syncPresentation(pane);
    } catch (error) {
      runtime.modes.set(tabId, previousMode);
      throw error;
    } finally {
      // Failure must publish the actual retained presentation too.
      this.#notify();
    }
  }

  /** Reconcile synchronous handles around the same authoritative session. */
  #syncPresentation(paneName: string, preserveFocus = false): void {
    const pane = this.#panes.get(paneName);
    if (!pane?.session || !pane.kindId || pane.session.state === 'closed' || pane.session.state === 'closing') return;
    const mode = this.tabMode(paneName);
    const separate = this.getDocumentReader(pane.kindId) !== null;
    const needsEditor = mode !== 'reading' || !separate;
    const mountingMarkdown = needsEditor && pane.editor === null && pane.kindId === markdownKindId;
    // Flush before reading the model, but keep the current handle alive until
    // replacement creation succeeds. A throwing factory must not blank the pane.
    if (!needsEditor) pane.editor?.flush?.();
    if (needsEditor && pane.editor === null) {
      const parent = this.#editorParents.get(paneName) ?? null;
      // A transferred session defers editor/reader recreation until its new
      // hosts attach (hostless moves); creating with a null parent would
      // throw inside providers. Reader-only hosts still mount immediately.
      if (parent === null) {
        if (mode === 'edit') this.#teardownReader(pane);
        if (mode !== 'edit') {
          this.#ensureReader(paneName);
        }
        return;
      }
      pane.editor = this.#app.getDocumentEditor(pane.kindId)?.createEditor({
        session: pane.session,
        parent: this.#editorParents.get(paneName) ?? null,
      }) ?? null;
      // the content path already bumped the shell synchronously
      // in this tick (single notify per keystroke covers outline + toolbar
      // snapshot). The per-session coalescing skips only that
      // docChanged-coupled redundant bump for the same sequence; a new
      // sequence (next commit) or a selection-driven tools change (the
      // skip already consumed) still notifies, as do async
      // selection/diagnostics changes after the drain.
      pane.editorSubscription = pane.editor?.tools?.onDidChange(() => {
        const toolsSession = pane.session;
        this.#notifyCoalesced(
          toolsSession,
          this.#sequenceOf(
            toolsSession as unknown as { contentSequence?: unknown } | null,
          ),
          'tools',
        );
      }) ?? null;
    }
    if (mode === 'reading' && needsEditor) pane.editor?.flush?.();
    if (needsEditor) pane.editor?.setReadOnly?.(mode === 'reading');
    if (mode !== 'edit') this.#ensureReader(paneName);
    if (mode === 'edit') this.#teardownReader(pane);
    if (!needsEditor) this.#teardownEditor(pane, false);
    // Opening Markdown leaves the insertion point to the user's text click.
    if (mode !== 'reading' && !preserveFocus && !mountingMarkdown) pane.editor?.focus();
  }

  #teardownEditor(pane: PaneRuntime, flush = true): void {
    if (flush && (pane.session?.state === 'open' || pane.session?.state === 'saving' || pane.session?.canRetrySave === true)) pane.editor?.flush?.();
    pane.editorSubscription?.dispose();
    pane.editorSubscription = null;
    pane.editor?.destroy();
    pane.editor = null;
  }

  /** Reading-view provider for a document kind, or null (native-readonly). */
  getDocumentReader(kindId: DocumentKindId): DocumentReaderProvider | null {
    return this.#app.getDocumentReader?.(kindId) ?? null;
  }

  /** Canonical kind of the pane's live session, if any. */
  getPaneKindId(pane: string): DocumentKindId | null {
    return this.#panes.get(pane)?.kindId ?? null;
  }

  /**
   * Reading presentation for one pane through a single discriminated query
   * (UI workbench port contract). Shell code resolves presentation here
   * instead of probing reader-seam methods independently.
   */
  readingPresentation(pane: string):
    | {
        kind: 'separate-reader';
        provider: DocumentReaderProvider;
        kindId: DocumentKindId;
      }
    | { kind: 'editor-readonly'; kindId: DocumentKindId | null } {
    let kindId = this.getPaneKindId(pane);
    if (kindId === null) {
      // Restored but unopened tabs have no live session yet: resolve the
      // kind from the document record instead of reporting unknown.
      const runtime = this.#panes.get(pane);
      const active =
        runtime?.tabs.find((tab) => tab.id === runtime.activeTab) ?? null;
      const tabDocumentId =
        active?.kind === 'document' ? active.documentId : null;
      if (tabDocumentId !== null) {
        try {
          kindId =
            this.#requireWorkspace()
              .listDocuments()
              .find((ref) => String(ref.documentId) === tabDocumentId)
              ?.kindId ?? null;
        } catch {
          kindId = null;
        }
      }
    }
    if (kindId !== null) {
      const provider = this.#app.getDocumentReader?.(kindId) ?? null;
      if (provider !== null)
        return { kind: 'separate-reader', provider, kindId };
      return { kind: 'editor-readonly', kindId };
    }
    return { kind: 'editor-readonly', kindId: null };
  }

  /**
   * Attach the shell's stable reading-view host for `pane`. When the active
   * tab is in `reading` mode and its kind has a reader provider, the reader
   * is (re)created into this host.
   */
  setReaderHost(pane: string, readerParent: unknown): void {
    const previous = this.#readerParents.get(pane);
    this.#readerParents.set(pane, readerParent);
    const runtime = this.#panes.get(pane);
    if (
      runtime === undefined ||
      runtime.session === null ||
      runtime.activeTab === null ||
      this.tabMode(pane) === 'edit'
    ) {
      return;
    }
    if (previous === readerParent && runtime.reader !== null) return;
    this.#teardownReader(runtime);
    this.#ensureReader(pane);
    this.#notify();
  }

  /** True when the pane's stored reading host is exactly `readerParent`. */
  isReaderAttached(pane: string, readerParent: unknown): boolean {
    return this.#readerParents.get(pane) === readerParent;
  }

  /** Create the pane's reader into its stored host when one applies. */
  #ensureReader(paneName: string): void {
    const runtime = this.#panes.get(paneName);
    if (
      runtime === undefined ||
      runtime.session === null ||
      runtime.kindId === null ||
      runtime.reader !== null
    ) {
      return;
    }
    const provider = this.#app.getDocumentReader?.(runtime.kindId) ?? null;
    if (provider === null) return;
    const parent = this.#readerParents.get(paneName) ?? null;
    if (parent === null || parent === undefined) return;
    runtime.reader = provider.createReader({
      session: runtime.session,
      parent,
    });
    runtime.reader.update();
  }

  /** Destroy the pane's reader, if any. */
  #teardownReader(runtime: PaneRuntime): void {
    runtime.reader?.destroy();
    runtime.reader = null;
  }

  /** Serializable dock layout snapshot for per-vault persistence. */
  dockLayout(): DockLayoutRecord {
    const leaves = this.leafIds();
    return {
      format: 'froglight.dock',
      version: 1,
      root: this.#root,
      panes: leaves.map((pane) => {
        const runtime = this.#panes.get(pane);
        return {
          pane,
          tabs: runtime?.tabs ?? [],
          activeTab: runtime?.activeTab ?? null,
          modes: runtime
            ? [...runtime.modes.entries()].map(([tab, mode]) => ({ tab, mode }))
            : [],
        };
      }),
      focusedPane: this.dockState().focusedPane,
    };
  }

  /**
   * Restore a dock layout: rebuilds the tree, tab strips, active tabs, and
   * modes without opening sessions — the shell reopens each pane's active
   * document as its editor host mounts.
   */
  async restoreDockLayout(record: DockLayoutRecord): Promise<void> {
    if (record.format !== 'froglight.dock') {
      throw new Error(
        `expected dock layout format "froglight.dock", got ${JSON.stringify(record.format)}`,
      );
    }
    if (record.version !== 1) {
      throw new Error(
        `unsupported dock layout version ${JSON.stringify(record.version)}`,
      );
    }
    await this.#teardownAllPanes();
    const root = record.root ?? leafPane(MAIN_PANE);
    const leaves = leafIdsOf(root);
    this.#root = root;
    let maxViewInstance = 0;
    for (const entry of record.panes) {
      if (!leaves.includes(entry.pane)) continue;
      const runtime = this.#pane(entry.pane);
      const tabs: DockTab[] = [];
      for (const tab of entry.tabs) {
        if (tab.kind === 'document' && tab.documentId !== null) {
          // A persisted layout can outlive a tree/folder delete: skip tabs
          // whose documents are gone instead of restoring dangling ids that
          // crash activation.
          if (!this.#hasDocument(tab.documentId)) continue;
          tabs.push({
            id: tab.id,
            kind: 'document',
            documentId: tab.documentId,
            viewId: null,
          });
        } else if (tab.kind === 'view' && tab.viewId !== null) {
          tabs.push({
            id: tab.id,
            kind: 'view',
            documentId: null,
            viewId: tab.viewId,
          });
          const instance = Number(tab.id.slice(tab.id.lastIndexOf(':') + 1));
          if (Number.isFinite(instance) && instance > maxViewInstance)
            maxViewInstance = instance;
        }
      }
      runtime.tabs = tabs;
      runtime.activeTab = tabs.some((tab) => tab.id === entry.activeTab)
        ? entry.activeTab
        : (tabs[0]?.id ?? null);
      for (const { tab, mode } of entry.modes) {
        if (this.availableTabModes(entry.pane, tab).includes(mode)) runtime.modes.set(tab, mode);
      }
    }
    this.#viewCounter = maxViewInstance;
    const focused =
      record.focusedPane !== null && leaves.includes(record.focusedPane)
        ? record.focusedPane
        : (leaves[0] ?? MAIN_PANE);
    this.#focusedPane = focused;
    this.#notify();
  }

  /** Raw text of a specific pane's Markdown document; `null` when nothing is open. */
  getPaneText(pane: string): string | null {
    const runtime = this.#panes.get(pane);
    // Only Markdown projects raw text to the shell. Other `{ raw: string }`
    // models (notably LaTeX) have their own reading presentation and must
    // never be rendered as Markdown.
    if (runtime?.kindId !== markdownKindId) return null;
    const session = runtime.session as
      | DocumentSession<{ raw: string }>
      | undefined;
    if (session === undefined || session === null) return null;
    const raw = (session.model as { raw?: unknown } | undefined)?.raw;
    return typeof raw === 'string' ? raw : null;
  }

  /**
   * Structured outline model for one document: the
   * `getOutlineModel` filler for the UI-owned structural port
   * `WorkbenchOutlineProviderLike`.
   *
   * An arrow-function property (not a prototype method) so the shell's
   * unbound read (`provider.getOutlineModel` called as a bare function)
   * keeps working — a lost `this` would fail closed into "no structured
   * model" and silently hide every structured Outline tab.
   *
   * Returns `{ model, revision }` for the live session owning `documentId`
   * (`revision` is the dirty-aware outline key
   * `${contentRevision}:${contentSequence}`; omitted while `contentRevision`
   * is not a string or the sequence is not a finite number, so the
   * registry falls back to its content hash), or `null` when
   * there is no live session. The sequence suffix keeps the key stable when
   * content is unchanged (same base + same sequence hits the frozen rows)
   * and advances on every in-place `markDirty` commit — including repeated
   * dirty edits that never touch `contentRevision` until save — so surface
   * commits and LaTeX typing re-render the outline without a tab switch,
   * save, or undo. Sessions without a numeric `contentSequence` (legacy
   * doubles) omit the revision so the identity-scoped slot still
   * recomputes on content change instead of cache-hitting stale rows.
   * Markdown resolves to
   * `null` deliberately: it stays on the
   * shell text projection (`getPaneText` plus the text content hash) so its
   * outline keeps updating per keystroke instead of freezing at the last
   * saved `contentRevision`. Unknown kinds resolve to their live model and
   * fail closed downstream (`UNKNOWN_OUTLINE_KIND` hides the tab). Never
   * throws into the shell: any failure means "no structured model".
   */
  getOutlineModel = (
    documentId: string,
  ): { readonly model: unknown; readonly revision?: string | number } | null => {
    try {
      for (const runtime of this.#panes.values()) {
        if (runtime.documentId !== documentId || runtime.session === null) {
          continue;
        }
        if (runtime.kindId === markdownKindId) return null;
        const base = runtime.session.contentRevision;
        const model: unknown = runtime.session.model;
        if (typeof base !== 'string') return { model };
        const sequence = (runtime.session as { contentSequence?: unknown })
          .contentSequence;
        if (typeof sequence !== 'number' || !Number.isFinite(sequence)) {
          return { model };
        }
        return { model, revision: `${base}:${sequence}` };
      }
      return null;
    } catch {
      return null;
    }
  };

  async #navigate(step: -1 | 1): Promise<boolean> {
    const nav = this.#navigation();
    if (nav === null) return false;
    const canMove = step < 0 ? nav.canGoBack : nav.canGoForward;
    if (!canMove) return false;
    if (step < 0) nav.back();
    else nav.forward();
    const entry = nav.current;
    if (entry === null) return false;
    // View opens carry a namespaced resource id: restore the view tab.
    if (entry.resourceId.startsWith(VIEW_HISTORY_PREFIX)) {
      const viewId = entry.resourceId.slice(VIEW_HISTORY_PREFIX.length);
      const focusedNow = this.#pane(this.#focusedPane);
      const active = focusedNow.tabs.find(
        (tab) => tab.id === focusedNow.activeTab,
      );
      if (active?.kind === 'view' && active.viewId === viewId) return true;
      this.#restoringHistory = true;
      try {
        await this.openView(viewId, { pane: this.#focusedPane });
      } catch (error) {
        this.#restoringHistory = false;
        throw error;
      }
      return true;
    }
    // Find the document that owns the history entry's resource id.
    const workspace = this.#requireWorkspace();
    const match = workspace
      .listDocuments()
      .find((ref) => String(ref.location.resourceId) === entry.resourceId);
    if (match === undefined) return false;
    const focused = this.#pane(this.#focusedPane);
    // Navigating between addresses of the already-open active document must
    // not tear the session down: reveal in place. This covers Back/Forward
    // across two headings of the same note and repeated reveals.
    if (focused.documentId === String(match.documentId)) {
      if (entry.address !== undefined) {
        this.revealAddress(this.#focusedPane, entry.address);
      }
      return true;
    }
    this.#restoringHistory = true;
    try {
      await this.openDocument(
        String(match.documentId),
        this.#editorParent(),
        entry.address === undefined
          ? { pane: this.#focusedPane }
          : { pane: this.#focusedPane, address: entry.address },
      );
    } catch (error) {
      this.#restoringHistory = false;
      throw error;
    }
    // `#openSession` already revealed the address after the presentation was
    // ready (reader vs editor path). Reveal again as a safety net for
    // providers whose first reveal races mount; history is not grown here
    // because `#restoringHistory` was consumed.
    if (entry.address !== undefined) {
      this.revealAddress(this.#focusedPane, entry.address);
    }
    return true;
  }

  #navigation(): NavigationService | null {
    // Workspace history is per pane: the focused pane's own trail drives
    // back/forward, state flags, and history pushes.
    return this.#panes.get(this.#focusedPane)?.nav ?? null;
  }

  /** Push a location onto the given pane's trail. */
  #pushHistory(paneName: string, resourceId: string, address?: string): void {
    const nav = this.#panes.get(paneName)?.nav;
    if (nav === undefined) return;
    // Re-opening the current entry replaces it rather than growing history,
    // unless the address differs: two addresses of the same document are
    // distinct history steps so Back/Forward can restore each reveal.
    const current = nav.current;
    if (
      current !== null &&
      current.resourceId === resourceId &&
      (current.address ?? undefined) === (address ?? undefined)
    ) {
      nav.replace(
        address === undefined ? { resourceId } : { resourceId, address },
      );
      return;
    }
    nav.push(address === undefined ? { resourceId } : { resourceId, address });
  }

  saveActive(): Promise<SaveResult | null> {
    return this.savePane(this.#focusedPane);
  }

  /** Save the document living in `pane`; `null` when the pane is empty. */
  async savePane(pane: string): Promise<SaveResult | null> {
    const admitted = await this.#queuePaneOperation(pane, async () => {
      const runtime = this.#panes.get(pane);
      const session = runtime?.session ?? null;
      if (runtime === undefined || session === null) return null;
      runtime?.editor?.flush?.();
      return { runtime, session, operation: this.#startSessionSave(session, true) };
    });
    if (admitted === null) return null;
    const result = await admitted.operation;
    if (this.#panes.get(pane) === admitted.runtime && admitted.runtime.session === admitted.session && !this.#disposed) {
      this.#notify();
    }
    return result;
  }

  execEditorCommand(
    command: 'undo' | 'redo',
    pane: string = this.#focusedPane,
  ): boolean {
    if (this.tabMode(pane) === 'reading') return false;
    const editor = this.#panes.get(pane)?.editor ?? null;
    const handled = editor?.execCommand(command) ?? false;
    if (handled) this.#notify();
    return handled;
  }

  canExecEditorCommand(
    command: 'undo' | 'redo',
    pane: string = this.#focusedPane,
  ): boolean {
    if (this.tabMode(pane) === 'reading') return false;
    const editor = this.#panes.get(pane)?.editor ?? null;
    return editor?.canExecCommand?.(command) ?? editor !== null;
  }

  /** Semantic controls for the active editor in `pane`. */
  editorToolSnapshot(
    pane: string = this.#focusedPane,
  ): DocumentToolSnapshot | null {
    return this.#panes.get(pane)?.editor?.tools?.snapshot() ?? null;
  }

  /** Route one shared-toolbar action back to the editor that owns it. */
  executeEditorTool(
    pane: string,
    id: string,
    value?: string,
  ): boolean | Promise<boolean> {
    const tools = this.#panes.get(pane)?.editor?.tools;
    if (tools === undefined) return false;
    const result = tools.execute(id, value);
    if (result instanceof Promise) {
      return result.then((handled) => {
        if (handled) this.#notify();
        return handled;
      });
    }
    if (result) this.#notify();
    return result;
  }

  /**
   * Reveal a portable document address through the active presentation. In
   * edit mode the editor is focused unless `opts.preserveFocus` is true
   * (a background reveal must never steal focus); reading-mode reveals never
   * touch focus.
   *
   * The seam's honest boolean propagates: boolean seams
   * report exact (`false` on unknown); legacy `void` seams normalize to
   * `true` (seam presence is their only signal). Focus still happens
   * whenever the editor exists — a miss still opened the document, so the
   * editor deserves focus exactly as before.
   */
  revealAddress(
    pane: string,
    address: string,
    opts: { preserveFocus?: boolean } = {},
  ): boolean {
    const runtime = this.#panes.get(pane);
    if (runtime === undefined) return false;
    const reading = this.tabMode(pane) === 'reading';
    if (reading && runtime.reader?.revealAddress !== undefined) {
      const revealed = this.#revealThroughPresentation(pane, runtime, address);
      this.#notify();
      return revealed;
    }
    const editor = runtime.editor ?? null;
    if (editor?.revealAddress === undefined) return false;
    const revealed = this.#revealThroughPresentation(pane, runtime, address);
    if (opts.preserveFocus !== true) {
      editor.focus();
    }
    this.#notify();
    return revealed;
  }

  /**
   * Invoke the active presentation's existing `revealAddress` seam and
   * normalize its honest boolean: `false` stays `false` (exact miss);
   * anything else (`true`, or `undefined` from legacy `void` seams)
   * counts as revealed. A missing presentation is document-open-only
   * degrade (`false`). Shared by `revealAddress` and `#openSession` so
   * both sites stay convergent.
   */
  #revealThroughPresentation(
    paneName: string,
    pane: PaneRuntime,
    address: string,
  ): boolean {
    const reading = this.tabMode(paneName) === 'reading';
    if (reading && pane.reader?.revealAddress !== undefined) {
      const outcome: unknown = pane.reader.revealAddress(address);
      return outcome !== false;
    }
    if (pane.editor?.revealAddress === undefined) return false;
    const outcome: unknown = pane.editor.revealAddress(address);
    return outcome !== false;
  }

  /**
   *  redirect-aware reveal target for the openLink-family trailing
   * safety nets. `openDocument` focuses the live owner when the document is
   * already open elsewhere, so the net must reveal where the document
   * actually ended up — never the requested pane, which may now hold
   * another document (a wrong-pane scroll) or nothing (a dishonest `false`).
   */
  #owningPaneFor(documentId: string, preferred: string): string {
    const current = this.#panes.get(preferred);
    if (current?.documentId === documentId && current.session !== null) {
      return preferred;
    }
    for (const [name, runtime] of this.#panes) {
      if (
        name !== preferred &&
        runtime.documentId === documentId &&
        runtime.session !== null
      ) {
        return name;
      }
    }
    return preferred;
  }

  /**
   *  synchronous live-owner probe for UI split guards. Returns the
   * pane currently owning a live session for `documentId`, or `null` when
   * the document is not live anywhere. UI pre-split guards (`splitWithTab`,
   * background-split resolve) call this synchronously before `splitPane`
   * so a duplicate never materializes a fresh leaf it will not use.
   * Synchronous with no lane waits, mirroring `#liveOwnerOf`.
   */
  liveOwnerOf(documentId: string): string | null {
    return this.#liveOwnerOf(documentId);
  }

  /**
   *  safety net for UI split races: after an externally created
   * split + `openDocument`, a redirect leaves the fresh split empty
   * (no session, no tabs, no document). Remove exactly that empty leaf so
   * pane count stays stable across repeated splits. Never touches a pane
   * that gained content (the owner closed mid-flight and the open landed
   * in `created`). Synchronous with no lane waits.
   */
  discardRedirectedSplit(created: string, documentId: string): void {
    this.#discardRedirectedSplit(created, documentId);
  }

  /**
   *  synchronous live-owner probe for beside pre-split guards. Returns
   * the pane currently owning a live session for `documentId`, or `null` when
   * the document is not live anywhere. Read synchronously before `splitPane`
   * so a duplicate never materializes a fresh leaf it will not use.
   */
  #liveOwnerOf(documentId: string): string | null {
    for (const [name, runtime] of this.#panes) {
      if (runtime.documentId === documentId && runtime.session !== null) {
        return name;
      }
    }
    return null;
  }

  /**
   *  safety net for beside races: after `splitPane` + `openDocument`,
   * a redirect leaves the fresh split empty (no session, no tabs, no
   * document). Remove exactly that empty leaf so pane count stays stable
   * across repeated beside-clicks. Never touches a pane that gained content
   * (the owner closed mid-flight and the open landed in `created`).
   */
  #discardRedirectedSplit(created: string, documentId: string): void {
    if (this.#owningPaneFor(documentId, created) === created) return;
    if (findLeaf(this.#root, created) === null) return;
    const runtime = this.#panes.get(created);
    if (runtime === undefined) return;
    if (runtime.session !== null) return;
    if (runtime.tabs.length !== 0) return;
    if (runtime.documentId !== null) return;
    this.#removePaneFromTree(created);
    this.#notify();
  }

  /** Replace the isolated vault without mounting/opening a document yet. */
  async openVault<C extends Readonly<Record<string, unknown>>>(
    plugin: PluginDefinition<C>,
    config?: C,
  ): Promise<void> {
    if (this.#disposalRequested) throw new Error('Workbench disposal has been requested');
    return this.#reserveTerminal(() => this.#openVaultNow(plugin, config));
  }

  async #openVaultNow<C extends Readonly<Record<string, unknown>>>(
    plugin: PluginDefinition<C>, config?: C,
  ): Promise<void> {
    // Flush the outgoing vault's layout, then keep saves suppressed until
    // the next initialize so the swap never writes a default layout into
    // the incoming vault.
    await this.#flushLayoutAndSuppress();
    try {
      await this.#saveAllIfDirty();
      await this.#teardownAllPanes(true);
      await this.#app.replaceVault(plugin, config);
    } catch (error) {
      this.#suppressLayoutSave = false;
      throw error;
    }
    this.#notify();
  }

  /**
   * Close the current vault completely. The vault provider is withdrawn, so
   * WorkspaceService and every dependent feature become inactive in launcher mode.
   */
  async closeVaultView(): Promise<void> {
    if (this.#disposalRequested) throw new Error('Workbench disposal has been requested');
    return this.#reserveTerminal(() => this.#closeVaultViewNow());
  }

  async #closeVaultViewNow(): Promise<void> {
    await this.#flushLayoutAndSuppress();
    try {
      await this.#saveAllIfDirty();
      await this.#teardownAllPanes(true);
      await this.#app.closeVault();
      this.#editorParents.clear();
      this.#readerParents.clear();
    } catch (error) {
      this.#suppressLayoutSave = false;
      throw error;
    }
    this.#notify();
  }

  async dispose(): Promise<void> {
    if (this.#disposeOperation !== null) return this.#disposeOperation;
    if (this.#disposed) return;
    // Keep normal admission closed even after failure: a partially torn-down
    // controller must not create replacement owners before cleanup is retried.
    this.#disposalRequested = true;
    this.#disposeOperation = this.#reserveTerminal(() => this.#disposeNow()).then(
      () => { this.#disposed = true; },
      (error: unknown) => {
        // Only concurrent callers share a failed attempt, not future retries.
        // Sessions remain owned until save/close succeeds.
        this.#disposeOperation = null;
        throw error;
      },
    );
    return this.#disposeOperation;
  }

  async #disposeNow(): Promise<void> {
    await this.#flushLayoutAndSuppress();
    try {
      await this.#saveAllIfDirty();
      await this.#teardownAllPanes(true);
    } finally {
      this.#suppressLayoutSave = false;
    }
    for (const disposer of this.#commandDisposers) disposer.dispose();
    this.#commandDisposers.length = 0;
    // Outline registrations are controller-owned: dispose the
    // five extractor registrations so dispose yields zero (reactivation is
    // a fresh controller with a fresh registry).
    this.#disposeOutlineRegistry();
    this.#notebookProviderSubscription?.dispose();
    this.#listeners.clear();
  }

  #editorParent(): unknown {
    return this.#editorParents.get(this.#focusedPane) ?? null;
  }

  #requireWorkspace(): WorkspaceService {
    const workspace = this.#app.getWorkspace();
    if (workspace === null)
      throw new Error('workspace capability is unavailable');
    return workspace;
  }

  #requireRef(documentId: string): DocumentRef {
    const workspace = this.#requireWorkspace();
    const ref = workspace
      .listDocuments()
      .find((candidate) => String(candidate.documentId) === documentId);
    if (ref === undefined) throw new Error(`unknown document ${documentId}`);
    return ref;
  }

  #hasDocument(documentId: string): boolean {
    try {
      const workspace = this.#requireWorkspace();
      return workspace
        .listDocuments()
        .some((candidate) => String(candidate.documentId) === documentId);
    } catch {
      return false;
    }
  }

  /** Make sure `pane` exists in the dock tree; otherwise split it in from the first leaf. */
  #ensurePaneInTree(pane: string): void {
    if (findLeaf(this.#root, pane) !== null) return;
    const anchor = firstLeaf(this.#root) ?? MAIN_PANE;
    this.#root = splitLeaf(this.#root, anchor, 'right', pane).root;
  }

  #removePaneFromTree(pane: string): void {
    this.#root = removeLeaf(this.#root, pane) ?? leafPane(MAIN_PANE);
    this.#panes.delete(pane);
    this.#editorParents.delete(pane);
    this.#readerParents.delete(pane);
    if (this.#maximizedPane === pane) this.#maximizedPane = null;
    if (!this.leafIds().includes(this.#focusedPane)) {
      this.#focusedPane = firstLeaf(this.#root) ?? MAIN_PANE;
    }
  }

  #nextPaneId(): string {
    let counter = this.#panes.size + 1;
    let candidate = `pane-${counter}`;
    while (
      findLeaf(this.#root, candidate) !== null ||
      this.#panes.has(candidate) ||
      this.#paneOpenOperations.has(candidate)
    ) {
      counter += 1;
      candidate = `pane-${counter}`;
    }
    return candidate;
  }

  /** Detach a session while its save runs, retaining only dirty or pending work. */
  async #suspendActiveSession(runtime: PaneRuntime): Promise<void> {
    const session = runtime.session;
    if (session === null) return;
    runtime.editor?.flush?.();
    if (session.dirty || this.#sessionSaveOperations.has(session)) {
      const documentId = String(session.document.documentId);
      const retained: RetainedSession = { session, save: null, close: null };
      this.#retainedSessions.set(documentId, retained);
      await this.#detachPaneSession(runtime);
      this.#startRetainedSave(documentId, retained, runtime);
      return;
    }
    await this.#teardownPaneSession(runtime);
  }

  async #detachPaneSession(runtime: PaneRuntime): Promise<void> {
    this.#teardownEditor(runtime);
    this.#teardownReader(runtime);
    const subscriptions = runtime.subscriptions;
    runtime.subscriptions = [];
    for (const subscription of subscriptions) subscription.dispose();
    runtime.session = null;
    runtime.kindId = null;
    runtime.documentId = null;
    runtime.documentTitle = null;
    runtime.documentPath = null;
  }

  #startRetainedSave(
    documentId: string,
    retained: RetainedSession,
    activeRuntime: PaneRuntime | null,
  ): Promise<void> {
    if (retained.save !== null) return retained.save;
    const save = (async () => {
      try {
        for (let round = 0; round < 5; round += 1) {
          const result = await this.#startSessionSave(retained.session, false);
          if (result !== null && !result.committed) {
            throw result.error instanceof Error ? result.error : new Error('inactive save failed');
          }
          if (!retained.session.dirty) break;
        }
        if (retained.session.dirty) throw new Error('failed to reach a stable inactive save');
      } catch (error) {
        // The workspace continues to own the dirty session. Reopening the
        // document borrows this same recovery source; no second decode occurs.
        console.warn('[workbench-controller] inactive save failed:', error);
      } finally {
        retained.save = null;
        if (this.#retainedSessions.get(documentId) === retained) {
          const isActive = [...this.#panes.values()].some(
            pane => pane.session === retained.session,
          );
          if (!isActive && !retained.session.dirty) {
            try {
              await this.#closeRetainedSession(documentId, retained);
            } catch (error) {
              console.warn('[workbench-controller] inactive session close failed:', error);
            }
          }
        }
        if (activeRuntime !== null && !this.#disposed) this.#notify();
      }
    })();
    retained.save = save;
    return save;
  }

  async #disposePaneRuntime(runtime: PaneRuntime): Promise<void> {
    // Pane closure is destructive for this runtime even when its tabs migrate;
    // leave their next owner with closed sessions that can be reopened from
    // committed bytes. Tab activation itself uses the nonblocking suspend path.
    await this.#saveIfDirty(runtime);
    await this.#teardownPaneSession(runtime);
    runtime.tabs = [];
    runtime.activeTab = null;
    runtime.modes.clear();
  }

  /** Open the document session + editor for `pane` and record history. */
  async #openSession(
    paneName: string,
    ref: DocumentRef,
    parent: unknown,
    address?: string,
    preserveFocus = false,
  ): Promise<void> {
    const workspace = this.#requireWorkspace();
    const pane = this.#pane(paneName);
    const id = String(ref.documentId);
    let retained = this.#retainedSessions.get(id);
    if (retained?.close !== null && retained?.close !== undefined) {
      await retained.close;
      if (this.#retainedSessions.get(id) === retained) {
        this.#retainedSessions.delete(id);
      }
      retained = undefined;
    }
    const borrowed = retained?.session ?? workspace.getOpenDocument(ref.documentId);
    const opened = borrowed ?? await workspace.openDocument(ref.documentId);

    const path = workspace.resolveResourcePath(ref.location.resourceId);
    this.#editorParents.set(paneName, parent);
    pane.session = opened;
    if (retained !== undefined && this.#retainedSessions.get(id) === retained) {
      this.#retainedSessions.delete(id);
    }
    pane.kindId = ref.kindId;
    pane.documentId = String(ref.documentId);
    pane.documentPath = String(path);
    pane.documentTitle = pathName(path);
    this.#subscribeSession(pane);
    this.#syncPresentation(paneName, preserveFocus);
    if (address !== undefined) {
      // Best-effort in-session reveal through the shared seam helper; the
      // result is intentionally unconsumed here because the openLink-family
      // trailing safety nets propagate this same boolean into `revealed`.
      this.#revealThroughPresentation(paneName, pane, address);
    }
    if (this.#restoringHistory || this.#restoringTab) {
      this.#restoringHistory = false;
    } else {
      this.#pushHistory(paneName, String(ref.location.resourceId), address);
    }
  }

  #subscribeSession(pane: PaneRuntime): void {
    const session = pane.session;
    if (session === null) return;
    let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
    const scheduleAutosave = () => {
      // Surface edits are journalled on every commit. Publication is throttled,
      // so continuous writing still advances without a debounce that can starve.
      if (session.localJournalEnabled === true && autosaveTimer !== null) return;
      if (autosaveTimer !== null) clearTimeout(autosaveTimer);
      autosaveTimer = setTimeout(() => {
        autosaveTimer = null;
        const paneName = [...this.#panes].find(([, runtime]) => runtime === pane)?.[0];
        if (paneName === undefined || pane.session !== session || !session.dirty) return;
        void this.#queuePaneOperation(paneName, async () => {
          if (pane.session !== session || !session.dirty) return;
          pane.editor?.flush?.();
          return { operation: this.#startSessionSave(session, false) };
        }).then(async (operation) => {
          if (operation !== undefined) await operation.operation;
          if (pane.session === session) this.#notify();
        }).catch((error: unknown) => {
          console.warn('[workbench-controller] autosave failed:', error);
        });
      }, session.localJournalEnabled === true && session.durableSeq !== undefined ? PUBLICATION_DELAY_MS : AUTOSAVE_DELAY_MS);
    };
    if (session.localJournalEnabled === true) {
      const persistenceSubscription = session.onDidChangePersistence?.(() => this.#notify());
      if (persistenceSubscription !== undefined) pane.subscriptions.push(persistenceSubscription);
    }
    let previousState = session.state;
    // single-bump coalescing, per session: `markDirty`
    // on a clean session fires both dirty + content synchronously; LaTeX
    // typing additionally fires a tools change in the same tick. Only the
    // first bump per session per sequence per tick notifies; the redundant
    // second bump for the SAME session and sequence is skipped, plus at
    // most one docChanged-coupled tools bump. A new sequence
    // (next commit, even in the same tick) still notifies synchronously
    // (freshness); async changes after the microtask drains still
    // notify; a second session's same-sequence commit notifies
    // independently.
    pane.subscriptions.push(
      session.onStateChange((state) => {
        if (previousState === 'opening' && state === 'open') pane.reader?.update();
        previousState = state;
        this.#notify();
      }),
      session.onDidChangeDirty(() => {
        this.#notifyCoalesced(session, this.#sequenceOf(session), 'content');
      }),
      // repeated dirty edits never flip the dirty flag, so the
      // dirty edge alone leaves the shell (and its outline memo) stale
      // after in-place surface/LaTeX commits. Content commits must also
      // bump the shell revision; the dirty-aware outline key
      // (`getOutlineModel`) turns that bump into a registry recompute,
      // while a stable key keeps the frozen-row hit. The reader update
      // runs first so reading views never lag the shell bump; a throwing
      // reader is contained (warned) and never propagates into the
      // `markDirty` caller, and the shell is notified once per sequence
      // via the coalescing above (redundant same-sequence second bump
      // skipped, new-sequence commits still notify).
      session.onDidChangeContent(() => {
        try {
          pane.reader?.update();
        } catch (error) {
          console.warn(
            '[workbench-controller] reader update failed:',
            error,
          );
        }
        this.#notifyCoalesced(session, this.#sequenceOf(session), 'content');
        scheduleAutosave();
      }),
      { dispose: () => { if (autosaveTimer !== null) clearTimeout(autosaveTimer); } },
    );
    if (session.dirty) scheduleAutosave();
  }

  /**
   * Persist the pane's dirty source before its session loses its owner.
   * Source edits accepted while a save is in flight (during the vault write
   * or its post-commit hooks) leave the session dirty again; a single save
   * would still commit and then let teardown close away that newer content.
   * Flush, save, and re-check until the source is stable so every accepted
   * edit is committed — bounded, with an honest failure that keeps the tab
   * and dirty session available for recovery instead of a silently clean
   * snapshot; snapshot semantics are unchanged per save.
   */
  async #saveIfDirty(runtime: PaneRuntime): Promise<void> {
    const session = runtime.session;
    if (session === null) return;
    runtime.editor?.flush?.();
    await this.#saveSessionIfDirty(session);
  }

  async #saveSessionIfDirty(session: DocumentSession): Promise<void> {
    for (let round = 0; round < 5; round += 1) {
      this.#paneForSession(session)?.editor?.flush?.();
      const pending = this.#sessionSaveOperations.get(session);
      if (pending !== undefined) {
        const pendingResult = await pending;
        this.#paneForSession(session)?.editor?.flush?.();
        if (pendingResult !== null && !pendingResult.committed &&
            !(session.dirty && session.canRetrySave === true)) {
          throw pendingResult.error instanceof Error
            ? pendingResult.error
            : new Error('failed to save active document');
        }
      }
      if (!session.dirty) return;
      const result = await this.#startSessionSave(session, false);
      if (result !== null && !result.committed) {
        throw result.error instanceof Error ? result.error : new Error('failed to save active document');
      }
    }
    this.#paneForSession(session)?.editor?.flush?.();
    if (session.dirty) throw new Error('failed to reach a stable save');
  }

  #startSessionSave(
    session: DocumentSession,
    force: boolean,
  ): Promise<SaveResult | null> {
    const existing = this.#sessionSaveOperations.get(session);
    if (existing !== undefined) {
      // An explicit save admitted during background publication must include
      // the caller's newer edits and record its requested historical revision.
      return force ? existing.then(result => result !== null && !result.committed ? result : this.#startSessionSave(session, true)) : existing;
    }
    const operation = (async () => {
      if (force) return session.save();
      let result: SaveResult | null = null;
      for (let round = 0; round < 5; round += 1) {
        this.#paneForSession(session)?.editor?.flush?.();
        if (!force && !session.dirty) return result;
        result = await session.save({ recordRevision: false });
        if (!result.committed || session.localJournalEnabled === true) return result;
        force = false;
      }
      this.#paneForSession(session)?.editor?.flush?.();
      if (session.dirty) throw new Error('failed to reach a stable save');
      return result;
    })();
    this.#sessionSaveOperations.set(session, operation);
    void operation.finally(() => {
      if (this.#sessionSaveOperations.get(session) === operation) {
        this.#sessionSaveOperations.delete(session);
      }
    }).catch(() => undefined);
    return operation;
  }

  #paneForSession(session: DocumentSession): PaneRuntime | null {
    return [...this.#panes.values()].find(pane => pane.session === session) ?? null;
  }

  async #saveAllIfDirty(): Promise<void> {
    for (let round = 0; round < 5; round++) {
      for (const runtime of this.#panes.values()) {
        await this.#saveIfDirty(runtime);
      }
      for (const [documentId, retained] of this.#retainedSessions) {
        if (retained.save !== null) await retained.save;
        if (retained.session.dirty) {
          await this.#saveSessionIfDirty(retained.session);
        }
        if (!retained.session.dirty && this.#retainedSessions.get(documentId) === retained) {
          await this.#closeRetainedSession(documentId, retained);
        }
      }
      // An earlier pane can accept input while a later pane awaits its write
      // or post-commit work. Flush every editor before checking any dirtiness,
      // including after the last round; never declare only the last pane clean.
      for (const runtime of this.#panes.values()) runtime.editor?.flush?.();
      if (
        [...this.#panes.values()].every(runtime => !runtime.session?.dirty) &&
        [...this.#retainedSessions.values()].every(({ session }) => !session.dirty)
      ) return;
    }
    throw new Error('failed to reach a stable all-pane save before teardown');
  }

  async #teardownPaneSession(runtime: PaneRuntime): Promise<void> {
    this.#teardownEditor(runtime);
    this.#teardownReader(runtime);
    // Outline cache hygiene: drop this document's slot so a
    // closed document never lingers in the bounded registry cache. The
    // shell's effect-owned `useSidebarOutlineInvalidation` covers unmount /
    // focus changes; this covers session teardown (tab/pane/vault close).
    // Fail-closed: invalidation must never break teardown.
    const outlineKind = runtime.kindId;
    const outlineIdentity = runtime.documentId;
    if (outlineKind !== null && outlineIdentity !== null) {
      try {
        this.outlineRegistry.invalidate(outlineKind, outlineIdentity);
      } catch {
        // Best-effort cache hygiene; the slot simply ages out via LRU.
      }
    }
    // Failure-atomic ownership: hold the subscriptions only in this frame
    // while the close is awaited. A rejected close restores them untouched so
    // EVERY resumption path (reattach, mode change, provider reconcile,
    // explicit open) keeps the retained session fully wired — no per-entry
    // restore conditions. A successful close disposes them before clearing.
    const subscriptions = runtime.subscriptions;
    runtime.subscriptions = [];
    const session = runtime.session;
    // Retain the recovery owner if close rejects after projections/subscriptions
    // have been released. A retry can finish closing without reopening bytes.
    try {
      if (session !== null) await session.close();
    } catch (error) {
      runtime.subscriptions = subscriptions;
      throw error;
    }
    for (const subscription of subscriptions) subscription.dispose();
    runtime.session = null;
    runtime.kindId = null;
    runtime.documentId = null;
    runtime.documentTitle = null;
    runtime.documentPath = null;
  }

  async #teardownAllPanes(requireClean = false): Promise<void> {
    for (const runtime of this.#panes.values()) {
      if (requireClean) {
        // The save-all await (or the previous pane's close) can yield to input.
        // Do not destroy this editor or its recovery owner if that input was
        // not included in the converged save. The terminal operation may retry.
        runtime.editor?.flush?.();
        if (runtime.session?.dirty) {
          throw new Error('pane became dirty before terminal teardown');
        }
      }
      await this.#teardownPaneSession(runtime);
    }
    this.#panes.clear();
    for (const [documentId, retained] of this.#retainedSessions) {
      if (requireClean && retained.session.dirty) {
        throw new Error('inactive document became dirty before terminal teardown');
      }
      await this.#closeRetainedSession(documentId, retained);
    }
    this.#root = leafPane(MAIN_PANE);
    this.#maximizedPane = null;
    this.#focusedPane = MAIN_PANE;
  }

  /** Rebind live Notebook/PDF sessions when either replaceable provider changes. */
  async #reconcilePagedEditors(): Promise<void> {
    this.#reconcileEditors([notebookKindId, pdfKindId]);
  }

  #reconcileEditors(kindIds: readonly DocumentKindId[]): void {
    const errors: unknown[] = [];
    for (const [paneName, pane] of this.#panes) {
      if (
        pane.kindId === null ||
        !kindIds.includes(pane.kindId) ||
        pane.session === null
      ) {
        continue;
      }
      pane.attachmentGeneration++;
      try {
        this.#teardownEditor(pane);
        this.#syncPresentation(paneName);
      } catch (error) {
        errors.push(error);
      }
    }
    try { this.#notify(); } catch (error) { errors.push(error); }
    // Do not let one failed restoration strand later withdrawn providers.
    // Propagate after the sweep so failed acquisitions still roll back.
    if (errors.length > 0) throw errors[0];
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
    // Dock mutations persist through the coalesced per-vault store; the
    // store skips writes whose serialized record did not change, so noisy
    // notifications (dirty flips) never reach the vault. Vault switches and
    // shutdown suppress the save: their teardown resets the tree, and the
    // vault must keep the layout it had.
    if (!this.#suppressLayoutSave) {
      try {
        this.#dockLayoutStore()?.save(this.dockLayout());
      } catch {
        // The store is replaced per vault and can disappear mid-teardown;
        // a layout save must never break disposal or vault switches.
      }
    }
  }

  /** Flush the current layout, then tear down without overwriting it. */
  async #flushLayoutAndSuppress(): Promise<void> {
    this.#suppressLayoutSave = true;
    try {
      await this.#dockLayoutStore()?.flush();
    } catch {
      // Best-effort: the vault keeps whatever was last written.
    }
  }
}

export function createWorkbenchController(
  app: WorkbenchApplication,
): WorkbenchController {
  return new WorkbenchController(app);
}

/**
 * Turn a free-form link destination into a safe workspace path for a new
 * Markdown note, or `null` when nothing usable remains. Backslashes and
 * control characters become dashes; `.`/`..`/empty segments are dropped.
 * Over-long candidates (> `MAX_LINK_PATH_LENGTH`) are rejected instead of
 * creating absurd documents.
 */
function sanitizeLinkPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  if (raw.length > MAX_LINK_DESTINATION_LENGTH) return null;
  // The character class intentionally matches control characters so they can
  // be stripped; that is exactly what no-control-regex exists to flag, and
  // here it is the purpose.
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/\\/g, '-').replace(/[\u0000-\u001f]/g, '');
  const segments = cleaned
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..');
  if (segments.length === 0) return null;
  let candidate = segments.join('/');
  if (!/\.md$/i.test(candidate)) candidate = `${candidate}.md`;
  if (candidate.length > MAX_LINK_PATH_LENGTH) return null;
  if (!isWorkspacePath(candidate)) return null;
  return candidate;
}
