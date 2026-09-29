/**
 * Focused per-port fakes for the workbench contracts (#44).
 *
 * Each factory implements exactly one narrow port over a shared
 * `FakeWorkbenchState` — dock, document, reading, tools, and host concerns
 * can each be faked without implementing unrelated methods. Document opens
 * serialize through a per-pane promise queue mirroring
 * `WorkbenchController.#paneOpenOperations`, so ordering/races behave like
 * the real controller.
 *
 * Framework-free (no React): the shared contract suite runs these fakes in
 * `@froglight/ui` specs and `@froglight/application` specs alike. The
 * mount-oriented full fake in `react/test-support.ts` keeps serving mounted
 * shell tests; these factories serve port-level behavior.
 */

import type {
  DocumentKindId,
  DocumentReaderProvider,
} from '@froglight/foundation';
import type {
  DockMoveTargetView,
  PaneModeView,
  PaneView,
  WorkbenchDocumentView,
} from './workbench-view.js';
import type {
  WorkbenchDockPort,
  WorkbenchDocumentPort,
  WorkbenchEditorToolsPort,
  WorkbenchHostPort,
  WorkbenchImportExportPort,
  WorkbenchReadingPort,
  WorkbenchReadingPresentation,
  WorkbenchStatePort,
} from './workbench-ports.js';

export interface FakeDocumentSeed {
  readonly documentId: string;
  readonly kindId?: string;
  readonly path: string;
  readonly text?: string;
}

export interface FakeWorkbenchSeedOptions {
  readonly documents?: readonly FakeDocumentSeed[];
  /**
   * Kinds with a registered separate reader. Seeded documents default to
   * `fake.markdown` (no reader) unless their `kindId` is listed here with a
   * provider.
   */
  readonly readers?: readonly {
    readonly kindId: string;
    readonly provider: DocumentReaderProvider;
  }[];
}

interface FakeTab {
  id: string;
  kind: 'document' | 'view';
  documentId: string | null;
  viewId: string | null;
}

interface FakePaneState {
  tabs: FakeTab[];
  activeTab: string | null;
  modes: Map<string, import('@froglight/foundation').DocumentPresentationMode>;
  /** Document with a live session in this pane, if any. */
  openDocumentId: string | null;
  dirty: boolean;
  history: string[];
  historyIndex: number;
}

type FakeTreeNode =
  | { kind: 'leaf'; pane: string }
  | {
      kind: 'split';
      direction: 'horizontal' | 'vertical';
      ratio: number;
      first: FakeTreeNode;
      second: FakeTreeNode;
    };

export interface FakeWorkbenchState {
  readonly documents: Map<
    string,
    WorkbenchDocumentView & { text: string; kindId: string }
  >;
  readonly panes: Map<string, FakePaneState>;
  readonly readers: Map<string, DocumentReaderProvider>;
  readonly editorParents: Map<string, unknown>;
  readonly readerParents: Map<string, unknown>;
  readonly listeners: Set<() => void>;
  readonly chains: Map<string, Promise<void>>;
  focusedPane: string;
  maximizedPane: string | null;
  viewCounter: number;
  creationCounter: number;
  splitCounter: number;
  root: FakeTreeNode;
  /** Set by goBack/goForward: the next open restores without pushing history. */
  restoringHistory: boolean;
}

function paneRecord(state: FakeWorkbenchState, pane: string): FakePaneState {
  const existing = state.panes.get(pane);
  if (existing !== undefined) return existing;
  const record: FakePaneState = {
    tabs: [],
    activeTab: null,
    modes: new Map(),
    openDocumentId: null,
    dirty: false,
    history: [],
    historyIndex: -1,
  };
  state.panes.set(pane, record);
  return record;
}

function leafIdsOf(node: FakeTreeNode): string[] {
  const out: string[] = [];
  const walk = (current: FakeTreeNode): void => {
    if (current.kind === 'leaf') out.push(current.pane);
    else {
      walk(current.first);
      walk(current.second);
    }
  };
  walk(node);
  return out;
}

export function createFakeWorkbenchState(
  options: FakeWorkbenchSeedOptions = {},
): FakeWorkbenchState {
  const documents = new Map<
    string,
    WorkbenchDocumentView & { text: string; kindId: string }
  >();
  for (const seed of options.documents ?? []) {
    const kindId = seed.kindId ?? 'fake.markdown';
    documents.set(seed.documentId, {
      documentId: seed.documentId,
      kindId,
      path: seed.path,
      title: seed.path.split('/').pop() ?? seed.path,
      text: seed.text ?? '',
    });
  }
  const readers = new Map<string, DocumentReaderProvider>();
  for (const reader of options.readers ?? []) {
    readers.set(reader.kindId, reader.provider);
  }
  return {
    documents,
    panes: new Map(),
    readers,
    editorParents: new Map(),
    readerParents: new Map(),
    listeners: new Set(),
    chains: new Map(),
    focusedPane: 'main',
    maximizedPane: null,
    viewCounter: 0,
    creationCounter: 0,
    splitCounter: 0,
    root: { kind: 'leaf', pane: 'main' },
    restoringHistory: false,
  };
}

function notify(state: FakeWorkbenchState): void {
  for (const listener of [...state.listeners]) listener();
}

/** Per-pane promise queue mirroring the real controller's serializer. */
function queuePaneOperation<T>(
  state: FakeWorkbenchState,
  pane: string,
  run: () => Promise<T>,
): Promise<T> {
  const previous = state.chains.get(pane) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(run);
  const settled = operation.then(
    () => undefined,
    () => undefined,
  );
  state.chains.set(pane, settled);
  void settled.then(() => {
    if (state.chains.get(pane) === settled) state.chains.delete(pane);
  });
  return operation;
}

function paneViewOf(state: FakeWorkbenchState, pane: string): PaneView {
  const record = state.panes.get(pane);
  const tabs = record?.tabs ?? [];
  const activeTab = record?.activeTab ?? null;
  const active = tabs.find((tab) => tab.id === activeTab) ?? null;
  const document =
    active?.kind === 'document' && active.documentId !== null
      ? state.documents.get(active.documentId)
      : undefined;
  return {
    pane,
    tabs: tabs.map((tab) => ({ ...tab })),
    activeTab,
    mode:
      activeTab !== null ? (record?.modes.get(activeTab) ?? 'edit') : 'edit',
    documentId:
      active?.kind === 'document' ? (active.documentId ?? null) : null,
    viewId: active?.kind === 'view' ? (active.viewId ?? null) : null,
    title: document?.title ?? null,
    path: document?.path ?? null,
    dirty: record?.dirty ?? false,
    recoveryWarnings: [],
    canGoBack: (record?.historyIndex ?? -1) > 0,
    canGoForward:
      (record?.historyIndex ?? -1) < (record?.history.length ?? 0) - 1,
  };
}

function pushHistory(record: FakePaneState, documentId: string): void {
  record.history = [
    ...record.history.slice(0, record.historyIndex + 1),
    documentId,
  ];
  record.historyIndex = record.history.length - 1;
}

/** History push skipped while restoring (mirrors the real controller). */
function pushHistoryUnlessRestoring(
  state: FakeWorkbenchState,
  record: FakePaneState,
  documentId: string,
): void {
  if (state.restoringHistory) {
    state.restoringHistory = false;
    return;
  }
  pushHistory(record, documentId);
}

function splitLeaf(
  node: FakeTreeNode,
  anchor: string,
  direction: 'right' | 'down' | 'left' | 'up',
  created: string,
): FakeTreeNode {
  const axis =
    direction === 'right' || direction === 'left' ? 'horizontal' : 'vertical';
  const before = direction === 'left' || direction === 'up';
  const fresh: FakeTreeNode = { kind: 'leaf', pane: created };
  if (node.kind === 'leaf') {
    if (node.pane !== anchor) return node;
    return {
      kind: 'split',
      direction: axis,
      ratio: 0.5,
      first: before ? fresh : node,
      second: before ? node : fresh,
    };
  }
  return {
    ...node,
    first: splitLeaf(node.first, anchor, direction, created),
    second: splitLeaf(node.second, anchor, direction, created),
  };
}

function removeLeaf(node: FakeTreeNode, pane: string): FakeTreeNode | null {
  if (node.kind === 'leaf') return node.pane === pane ? null : node;
  const first = removeLeaf(node.first, pane);
  const second = removeLeaf(node.second, pane);
  if (first === null) return second;
  if (second === null) return first;
  return { ...node, first, second };
}

function freshPaneId(state: FakeWorkbenchState): string {
  state.splitCounter += 1;
  let created = `pane-${state.splitCounter}`;
  while (leafIdsOf(state.root).includes(created) || state.panes.has(created)) {
    state.splitCounter += 1;
    created = `pane-${state.splitCounter}`;
  }
  return created;
}

export function createStateFakePort(
  state: FakeWorkbenchState,
): WorkbenchStatePort {
  return {
    get state() {
      const record = state.panes.get(state.focusedPane);
      const document =
        record?.openDocumentId != null
          ? state.documents.get(record.openDocumentId)
          : undefined;
      return {
        activeDocumentId: record?.openDocumentId ?? null,
        activeDocumentTitle: document?.title ?? null,
        activeDocumentPath: document?.path ?? null,
        dirty: record?.dirty ?? false,
        canGoBack: (record?.historyIndex ?? -1) > 0,
        canGoForward:
          (record?.historyIndex ?? -1) < (record?.history.length ?? 0) - 1,
      };
    },
    get focusedPane() {
      return state.focusedPane;
    },
    onDidChange(listener: () => void) {
      state.listeners.add(listener);
      return { dispose: () => state.listeners.delete(listener) };
    },
    listDocuments() {
      return [...state.documents.values()].map(
        ({ text: _text, ...view }) => view,
      );
    },
    paneStates() {
      return leafIdsOf(state.root).map((pane) => paneViewOf(state, pane));
    },
    focusPane(pane: string) {
      if (!leafIdsOf(state.root).includes(pane)) return;
      state.focusedPane = pane;
      notify(state);
    },
  };
}

export function createDockFakePort(
  state: FakeWorkbenchState,
): WorkbenchDockPort {
  const port: WorkbenchDockPort = {
    onDidChange(listener: () => void) {
      state.listeners.add(listener);
      return { dispose: () => state.listeners.delete(listener) };
    },
    dockState() {
      const leaves = leafIdsOf(state.root);
      return {
        root: state.root,
        focusedPane: leaves.includes(state.focusedPane)
          ? state.focusedPane
          : (leaves[0] ?? null),
        maximizedPane: state.maximizedPane,
      };
    },
    leafIds() {
      return leafIdsOf(state.root);
    },
    splitPane(
      pane: string,
      direction: 'right' | 'down' | 'left' | 'up',
      opts?: { preserveFocus?: boolean },
    ) {
      const anchor = leafIdsOf(state.root).includes(pane)
        ? pane
        : (leafIdsOf(state.root)[0] ?? 'main');
      const created = freshPaneId(state);
      state.root = splitLeaf(state.root, anchor, direction, created);
      paneRecord(state, created);
      // Background splits never modify global focus (never-touch semantic).
      if (opts?.preserveFocus !== true) {
        state.focusedPane = created;
      }
      notify(state);
      return created;
    },
    activateTab(pane: string, tabId: string) {
      return queuePaneOperation(state, pane, async () => {
        const record = state.panes.get(pane);
        if (record === undefined || record.activeTab === tabId) return;
        const tab = record.tabs.find((candidate) => candidate.id === tabId);
        if (tab === undefined) return;
        if (
          tab.kind === 'document' &&
          tab.documentId !== null &&
          !state.documents.has(tab.documentId)
        ) {
          await port.closeTab(pane, tabId);
          return;
        }
        record.activeTab = tabId;
        if (tab.kind === 'document') {
          // Tab activation reopens quietly without growing history.
          record.openDocumentId = tab.documentId;
          record.dirty = false;
        } else {
          record.openDocumentId = null;
        }
        notify(state);
      });
    },
    closeTab(pane: string, tabId: string) {
      return queuePaneOperation(state, pane, async () => {
        const record = state.panes.get(pane);
        if (record === undefined) return;
        const index = record.tabs.findIndex((tab) => tab.id === tabId);
        if (index < 0) return;
        const wasActive = record.activeTab === tabId;
        record.tabs = record.tabs.filter((tab) => tab.id !== tabId);
        record.modes.delete(tabId);
        if (!wasActive) {
          notify(state);
          return;
        }
        const next = record.tabs[Math.min(index, record.tabs.length - 1)];
        if (next !== undefined) {
          record.activeTab = next.id;
          record.openDocumentId =
            next.kind === 'document' ? next.documentId : null;
          record.dirty = false;
        } else {
          record.activeTab = null;
          record.openDocumentId = null;
          state.root = removeLeaf(state.root, pane) ?? {
            kind: 'leaf',
            pane: 'main',
          };
          state.panes.delete(pane);
          if (!leafIdsOf(state.root).includes(state.focusedPane)) {
            state.focusedPane = leafIdsOf(state.root)[0] ?? 'main';
          }
        }
        notify(state);
      });
    },
    closePane(pane: string) {
      return queuePaneOperation(state, pane, async () => {
        const leaves = leafIdsOf(state.root);
        const index = leaves.indexOf(pane);
        if (index >= 0 && leaves.length > 1) {
          const neighbor = leaves[index + 1] ?? leaves[index - 1]!;
          const source = state.panes.get(pane);
          const target = paneRecord(state, neighbor);
          if (source !== undefined) {
            for (const tab of source.tabs) {
              const duplicate =
                tab.kind === 'document' &&
                target.tabs.some(
                  (existing) =>
                    existing.kind === 'document' &&
                    existing.documentId === tab.documentId,
                );
              if (!duplicate) target.tabs = [...target.tabs, { ...tab }];
            }
            if (target.activeTab === null && target.tabs.length > 0) {
              target.activeTab = target.tabs[0]!.id;
              const activeTab = target.tabs[0]!;
              target.openDocumentId =
                activeTab.kind === 'document' ? activeTab.documentId : null;
            }
          }
        }
        state.panes.delete(pane);
        state.root = removeLeaf(state.root, pane) ?? {
          kind: 'leaf',
          pane: 'main',
        };
        if (!leafIdsOf(state.root).includes(state.focusedPane)) {
          state.focusedPane = leafIdsOf(state.root)[0] ?? 'main';
        }
        notify(state);
      });
    },
    moveTab(fromPane: string, tabId: string, target: DockMoveTargetView) {
      return queuePaneOperation(
        state,
        target.kind === 'pane' ? target.pane : fromPane,
        async () => {
          const source = state.panes.get(fromPane);
          if (source === undefined) return null;
          const tab = source.tabs.find((candidate) => candidate.id === tabId);
          if (tab === undefined) return null;
          if (target.kind === 'split') {
            const created = freshPaneId(state);
            state.root = splitLeaf(
              state.root,
              target.pane,
              target.direction,
              created,
            );
            const createdRecord = paneRecord(state, created);
            source.tabs = source.tabs.filter(
              (candidate) => candidate.id !== tabId,
            );
            if (source.activeTab === tabId) {
              const next = source.tabs[source.tabs.length - 1] ?? null;
              source.activeTab = next?.id ?? null;
              source.openDocumentId =
                next?.kind === 'document' ? next.documentId : null;
            }
            if (source.tabs.length === 0) {
              state.root = removeLeaf(state.root, fromPane) ?? state.root;
              state.panes.delete(fromPane);
            }
            createdRecord.tabs = [{ ...tab }];
            createdRecord.activeTab = tabId;
            createdRecord.openDocumentId =
              tab.kind === 'document' ? tab.documentId : null;
            state.focusedPane = created;
            notify(state);
            return created;
          }
          const targetRecord = paneRecord(state, target.pane);
          const without = targetRecord.tabs.filter(
            (candidate) => candidate.id !== tabId,
          );
          const samePane = target.pane === fromPane;
          let sourceIndex = -1;
          if (samePane) {
            sourceIndex = source.tabs.findIndex(
              (candidate) => candidate.id === tabId,
            );
          }
          let index = Math.max(
            0,
            Math.min(target.index ?? without.length, without.length),
          );
          if (samePane && sourceIndex !== -1 && sourceIndex < index) index -= 1;
          targetRecord.tabs = [
            ...without.slice(0, index),
            { ...tab },
            ...without.slice(index),
          ];
          targetRecord.activeTab = tabId;
          targetRecord.openDocumentId =
            tab.kind === 'document' ? tab.documentId : null;
          if (!samePane) {
            source.tabs = source.tabs.filter(
              (candidate) => candidate.id !== tabId,
            );
            if (source.activeTab === tabId) {
              const next = source.tabs[source.tabs.length - 1] ?? null;
              source.activeTab = next?.id ?? null;
              source.openDocumentId =
                next?.kind === 'document' ? next.documentId : null;
            }
            if (source.tabs.length === 0) {
              state.root = removeLeaf(state.root, fromPane) ?? state.root;
              state.panes.delete(fromPane);
            }
          }
          state.focusedPane = target.pane;
          notify(state);
          return null;
        },
      );
    },
    openView(
      viewId: string,
      opts?: { pane?: string; preserveFocus?: boolean },
    ) {
      const pane = opts?.pane ?? state.focusedPane;
      const preserve = opts?.preserveFocus === true;
      return queuePaneOperation(state, pane, async () => {
        const record = paneRecord(state, pane);
        const focusTarget = (): void => {
          // Background opens never modify global focus (never-touch).
          if (!preserve) {
            state.focusedPane = pane;
          }
        };
        const existing = record.tabs.find(
          (tab) => tab.kind === 'view' && tab.viewId === viewId,
        );
        if (existing !== undefined) {
          record.activeTab = existing.id;
          focusTarget();
          notify(state);
          return existing.id;
        }
        state.viewCounter += 1;
        const tabId = `view:${viewId}:${state.viewCounter}`;
        record.tabs = [
          ...record.tabs,
          { id: tabId, kind: 'view', documentId: null, viewId },
        ];
        record.activeTab = tabId;
        record.openDocumentId = null;
        focusTarget();
        notify(state);
        return tabId;
      });
    },
    movePaneBeside(
      fromPane: string,
      targetPane: string,
      direction: 'right' | 'down' | 'left' | 'up',
    ) {
      if (fromPane === targetPane) return;
      const leaves = leafIdsOf(state.root);
      if (!leaves.includes(fromPane) || !leaves.includes(targetPane)) return;
      const axis =
        direction === 'right' || direction === 'left'
          ? 'horizontal'
          : 'vertical';
      const before = direction === 'left' || direction === 'up';
      // Rebuild a left-deep tree with fromPane beside targetPane.
      const rest = leaves.filter((leaf) => leaf !== fromPane);
      const at = rest.indexOf(targetPane);
      const ordered = [
        ...rest.slice(0, before ? at : at + 1),
        fromPane,
        ...rest.slice(before ? at : at + 1),
      ];
      let node: FakeTreeNode = { kind: 'leaf', pane: ordered[0]! };
      for (const leaf of ordered.slice(1)) {
        node = {
          kind: 'split',
          direction: axis,
          ratio: 0.5,
          first: node,
          second: { kind: 'leaf', pane: leaf },
        };
      }
      state.root = node;
      notify(state);
    },
    setSplitRatio(pane: string, ratio: number) {
      const clamp = Math.min(0.8, Math.max(0.2, ratio));
      const walk = (node: FakeTreeNode): FakeTreeNode => {
        if (node.kind === 'leaf') return node;
        const inFirst = leafIdsOf(node.first).includes(pane);
        const inSecond = leafIdsOf(node.second).includes(pane);
        if (inFirst || inSecond) {
          return {
            ...node,
            ratio: clamp,
            first: walk(node.first),
            second: walk(node.second),
          };
        }
        return { ...node, first: walk(node.first), second: walk(node.second) };
      };
      state.root = walk(state.root);
      notify(state);
    },
    setSplitRatioAt(path: readonly ('first' | 'second')[], ratio: number) {
      const clamp = Math.min(0.8, Math.max(0.2, ratio));
      const walk = (
        node: FakeTreeNode,
        remaining: readonly ('first' | 'second')[],
      ): FakeTreeNode => {
        if (node.kind === 'leaf') return node;
        const [side, ...rest] = remaining;
        if (side === undefined) return { ...node, ratio: clamp };
        return { ...node, [side]: walk(node[side], rest) };
      };
      state.root = walk(state.root, path);
      notify(state);
    },
    toggleMaximize(pane?: string) {
      const target = pane ?? state.focusedPane;
      state.maximizedPane = state.maximizedPane === target ? null : target;
      notify(state);
    },
    closeOtherPanes(keep?: string) {
      const target = keep ?? state.focusedPane;
      return queuePaneOperation(state, target, async () => {
        for (const pane of leafIdsOf(state.root).filter(
          (leaf) => leaf !== target,
        )) {
          state.panes.delete(pane);
          state.root = removeLeaf(state.root, pane) ?? state.root;
        }
        state.focusedPane = target;
        notify(state);
      });
    },
    liveOwnerOf(documentId: string): string | null {
      // Mirror the controller's #liveOwnerOf: scan panes for an active
      // documentId with a live session (`openDocumentId`), return the pane
      // name or null. Synchronous with no lane waits.
      for (const [name, record] of state.panes) {
        if (record.openDocumentId === documentId) return name;
      }
      return null;
    },
    discardRedirectedSplit(created: string, documentId: string): void {
      // Mirror the controller's #discardRedirectedSplit: remove only a
      // strictly-empty leaf. Never touches a pane that gained content (the
      // live owner closed mid-flight and the open landed in `created`).
      // Synchronous with no lane waits.
      const current = state.panes.get(created);
      if (current?.openDocumentId === documentId) return;
      let redirected = false;
      for (const [name, record] of state.panes) {
        if (name !== created && record.openDocumentId === documentId) {
          redirected = true;
          break;
        }
      }
      if (!redirected) return;
      if (!leafIdsOf(state.root).includes(created)) return;
      const runtime = state.panes.get(created);
      if (runtime === undefined) return;
      if (runtime.openDocumentId !== null) return;
      if (runtime.tabs.length !== 0) return;
      state.root = removeLeaf(state.root, created) ?? {
        kind: 'leaf',
        pane: 'main',
      };
      state.panes.delete(created);
      if (!leafIdsOf(state.root).includes(state.focusedPane)) {
        state.focusedPane = leafIdsOf(state.root)[0] ?? 'main';
      }
      notify(state);
    },
  };
  return port;
}

export function createDocumentFakePort(
  state: FakeWorkbenchState,
): WorkbenchDocumentPort {
  async function openIntoPane(
    documentId: string,
    pane: string,
    preserveFocus?: boolean,
  ): Promise<void> {
    return queuePaneOperation(state, pane, async () => {
      if (!state.documents.has(documentId)) {
        throw new Error(`unknown document ${documentId}`);
      }
      // Mirror the real controller: opening into an unknown pane splits it
      // in from the first leaf.
      if (!leafIdsOf(state.root).includes(pane)) {
        state.root = splitLeaf(
          state.root,
          leafIdsOf(state.root)[0] ?? 'main',
          'right',
          pane,
        );
      }
      const record = paneRecord(state, pane);
      record.dirty = false;
      const existing = record.tabs.find(
        (tab) => tab.kind === 'document' && tab.documentId === documentId,
      );
      if (existing === undefined) {
        record.tabs = [
          ...record.tabs,
          { id: documentId, kind: 'document', documentId, viewId: null },
        ];
        record.activeTab = documentId;
      } else {
        record.activeTab = existing.id;
      }
      record.openDocumentId = documentId;
      pushHistoryUnlessRestoring(state, record, documentId);
      // Background opens never modify global focus (never-touch semantic).
      if (preserveFocus !== true) {
        state.focusedPane = pane;
      }
      notify(state);
    });
  }

  return {
    onDidChange(listener: () => void) {
      state.listeners.add(listener);
      return { dispose: () => state.listeners.delete(listener) };
    },
    async createAndOpen(
      path: string,
      opts?: { pane?: string; kindId?: string },
    ) {
      state.creationCounter += 1;
      const documentId = `doc-created-${state.creationCounter}`;
      state.documents.set(documentId, {
        documentId,
        kindId: opts?.kindId ?? 'fake.markdown',
        path,
        title: path.split('/').pop() ?? path,
        text: '',
      });
      notify(state);
      await openIntoPane(documentId, opts?.pane ?? state.focusedPane);
      return { documentId };
    },
    openDocument(
      documentId: string,
      opts?: { pane?: string; address?: string; preserveFocus?: boolean },
    ) {
      void opts?.address;
      return openIntoPane(
        documentId,
        opts?.pane ?? state.focusedPane,
        opts?.preserveFocus,
      );
    },
    async openLink(destination: string, opts?: { readonly pane?: string }) {
      const target = opts?.pane ?? state.focusedPane;
      const match = [...state.documents.values()].find(
        (candidate) =>
          candidate.title.replace(/\.md$/i, '') === destination ||
          candidate.path.replace(/\.md$/i, '') === destination,
      );
      if (match !== undefined) {
        await openIntoPane(match.documentId, target);
        return { created: false, documentId: match.documentId };
      }
      const created = (await this.createAndOpen(`${destination}.md`, {
        ...(opts?.pane !== undefined ? { pane: opts.pane } : {}),
      })) as { documentId: string };
      return { created: true, documentId: created.documentId };
    },
    async deleteDocument(documentId: string) {
      state.documents.delete(documentId);
      for (const record of state.panes.values()) {
        record.tabs = record.tabs.filter(
          (tab) => tab.documentId !== documentId,
        );
        record.history = record.history.filter((id) => id !== documentId);
        record.historyIndex = Math.min(
          record.historyIndex,
          record.history.length - 1,
        );
        if (
          record.activeTab !== null &&
          !record.tabs.some((tab) => tab.id === record.activeTab)
        ) {
          const next = record.tabs[0] ?? null;
          record.activeTab = next?.id ?? null;
          record.openDocumentId =
            next?.kind === 'document' ? next.documentId : null;
        }
        if (record.openDocumentId === documentId) {
          record.openDocumentId = null;
        }
      }
      notify(state);
    },
    async pruneMissingDocuments() {
      for (const record of state.panes.values()) {
        record.tabs = record.tabs.filter(
          (tab) =>
            tab.kind !== 'document' ||
            tab.documentId === null ||
            state.documents.has(tab.documentId),
        );
        if (
          record.activeTab !== null &&
          !record.tabs.some((tab) => tab.id === record.activeTab)
        ) {
          const next = record.tabs[0] ?? null;
          record.activeTab = next?.id ?? null;
          record.openDocumentId =
            next?.kind === 'document' ? next.documentId : null;
        }
      }
      notify(state);
    },
    async saveActive() {
      const record = state.panes.get(state.focusedPane);
      if (record === undefined || record.openDocumentId === null) return null;
      record.dirty = false;
      notify(state);
      return { committed: true, error: undefined };
    },
    async savePane(pane) {
      const record = state.panes.get(pane);
      if (record === undefined || record.openDocumentId === null) return null;
      record.dirty = false;
      notify(state);
      return { committed: true, error: undefined };
    },
    async goBack() {
      const record = state.panes.get(state.focusedPane);
      if (record === undefined || record.historyIndex <= 0) return false;
      record.historyIndex -= 1;
      const documentId = record.history[record.historyIndex]!;
      state.restoringHistory = true;
      await openIntoPane(documentId, state.focusedPane);
      return true;
    },
    async goForward() {
      const record = state.panes.get(state.focusedPane);
      if (
        record === undefined ||
        record.historyIndex >= record.history.length - 1
      ) {
        return false;
      }
      record.historyIndex += 1;
      const documentId = record.history[record.historyIndex]!;
      state.restoringHistory = true;
      await openIntoPane(documentId, state.focusedPane);
      return true;
    },
  };
}

export function createToolsFakePort(
  state: FakeWorkbenchState,
): WorkbenchEditorToolsPort {
  void state;
  return {
    onDidChange(listener: () => void) {
      state.listeners.add(listener);
      return { dispose: () => state.listeners.delete(listener) };
    },
    execEditorCommand() {
      return false;
    },
    canExecEditorCommand() {
      return false;
    },
    editorToolSnapshot() {
      return null;
    },
    executeEditorTool() {
      return false;
    },
  };
}

function kindOfPane(state: FakeWorkbenchState, pane: string): string | null {
  const record = state.panes.get(pane);
  const openId = record?.openDocumentId ?? null;
  if (openId !== null) {
    return state.documents.get(openId)?.kindId ?? null;
  }
  const active =
    record?.tabs.find((tab) => tab.id === record.activeTab) ?? null;
  if (active?.kind === 'document' && active.documentId !== null) {
    return state.documents.get(active.documentId)?.kindId ?? null;
  }
  return null;
}

export function createReadingFakePort(
  state: FakeWorkbenchState,
): WorkbenchReadingPort {
  return {
    onDidChange(listener: () => void) {
      state.listeners.add(listener);
      return { dispose: () => state.listeners.delete(listener) };
    },
    readingPresentation(pane: string): WorkbenchReadingPresentation {
      const kindId = kindOfPane(state, pane);
      if (kindId !== null) {
        const provider = state.readers.get(kindId) ?? null;
        if (provider !== null) {
          return {
            kind: 'separate-reader',
            provider,
            kindId: kindId as DocumentKindId,
          };
        }
        return { kind: 'editor-readonly', kindId: kindId as DocumentKindId };
      }
      return { kind: 'editor-readonly', kindId: null };
    },
    getPaneText(pane: string): string | null {
      const record = state.panes.get(pane);
      const openId = record?.openDocumentId ?? null;
      if (openId === null) return null;
      const document = state.documents.get(openId);
      if (document === undefined || document.kindId !== 'fake.markdown') {
        return null;
      }
      return document.text;
    },
    availableTabModes() {
      return ['edit', 'reading'] as const;
    },
    tabMode(pane: string, tabId?: string): PaneModeView {
      const record = state.panes.get(pane);
      const id = tabId ?? record?.activeTab ?? null;
      return id !== null ? (record?.modes.get(id) ?? 'edit') : 'edit';
    },
    setTabMode(pane: string, tabId: string, mode: PaneModeView) {
      paneRecord(state, pane).modes.set(tabId, mode);
      notify(state);
    },
    revealAddress() {
      return true;
    },
  };
}

export function createHostFakePort(
  state: FakeWorkbenchState,
): WorkbenchHostPort {
  return {
    onDidChange(listener: () => void) {
      state.listeners.add(listener);
      return { dispose: () => state.listeners.delete(listener) };
    },
    initialize(editorParent: unknown) {
      return queuePaneOperation(state, 'main', async () => {
        state.editorParents.set('main', editorParent);
        notify(state);
      });
    },
    isPaneActive(pane: string) {
      return (state.panes.get(pane)?.openDocumentId ?? null) !== null;
    },
    isPaneAttached(pane: string, editorParent: unknown) {
      const record = state.panes.get(pane);
      return (
        (record?.openDocumentId ?? null) !== null &&
        state.editorParents.get(pane) === editorParent
      );
    },
    openDocument(
      documentId: string,
      editorParent: unknown,
      opts?: { pane?: string; address?: string; preserveFocus?: boolean },
    ) {
      const pane = opts?.pane ?? state.focusedPane;
      const preserve = opts?.preserveFocus === true;
      void opts?.address;
      return queuePaneOperation(state, pane, async () => {
        if (!state.documents.has(documentId)) {
          throw new Error(`unknown document ${documentId}`);
        }
        const record = paneRecord(state, pane);
        const existing = record.tabs.find(
          (tab) => tab.kind === 'document' && tab.documentId === documentId,
        );
        if (existing === undefined) {
          record.tabs = [
            ...record.tabs,
            { id: documentId, kind: 'document', documentId, viewId: null },
          ];
          record.activeTab = documentId;
        } else {
          record.activeTab = existing.id;
        }
        record.openDocumentId = documentId;
        record.dirty = false;
        pushHistoryUnlessRestoring(state, record, documentId);
        state.editorParents.set(pane, editorParent);
        // Background opens never modify global focus (never-touch semantic).
        if (!preserve) {
          state.focusedPane = pane;
        }
        notify(state);
      });
    },
    reattachPane(pane: string, editorParent: unknown, readerParent?: unknown) {
      return queuePaneOperation(state, pane, async () => {
        const record = state.panes.get(pane);
        if ((record?.openDocumentId ?? null) === null) return;
        state.editorParents.set(pane, editorParent);
        if (readerParent !== undefined) {
          state.readerParents.set(pane, readerParent);
        }
        notify(state);
      });
    },
    setReaderHost(pane: string, readerParent: unknown) {
      state.readerParents.set(pane, readerParent);
    },
    isReaderAttached(pane: string, readerParent: unknown) {
      return state.readerParents.get(pane) === readerParent;
    },
  };
}

export function createImportExportFakePort(
  state: FakeWorkbenchState,
): WorkbenchImportExportPort {
  void state;
  return {
    importPdfAsNotebook(input: { readonly name: string }) {
      return Promise.resolve({
        documentId: `pdf-import:${input.name}`,
        pageCount: 1,
      });
    },
    exportNotebookPdf() {
      return Promise.resolve({
        bytes: new Uint8Array(),
        filename: 'notebook.pdf',
        warnings: [],
      });
    },
  };
}

/** Every narrow port over one shared fake state. */
export interface FakeWorkbenchPorts {
  readonly state: FakeWorkbenchState;
  readonly statePort: WorkbenchStatePort;
  readonly dockPort: WorkbenchDockPort;
  readonly documentPort: WorkbenchDocumentPort;
  readonly toolsPort: WorkbenchEditorToolsPort;
  readonly readingPort: WorkbenchReadingPort;
  readonly hostPort: WorkbenchHostPort;
  readonly importExportPort: WorkbenchImportExportPort;
}

export function createFakeWorkbenchPorts(
  options: FakeWorkbenchSeedOptions = {},
): FakeWorkbenchPorts {
  const state = createFakeWorkbenchState(options);
  return {
    state,
    statePort: createStateFakePort(state),
    dockPort: createDockFakePort(state),
    documentPort: createDocumentFakePort(state),
    toolsPort: createToolsFakePort(state),
    readingPort: createReadingFakePort(state),
    hostPort: createHostFakePort(state),
    importExportPort: createImportExportFakePort(state),
  };
}
