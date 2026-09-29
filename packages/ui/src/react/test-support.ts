/**
 * Shared harness for behavior specs that drive the mounted app through its
 * public seam (`mountFroglightApp`).
 *
 * The composition is real where the risk lives — runtime, vault, workspace,
 * search, and every default first-party UI plugin — while the workbench
 * controller is a contract-faithful fake: `WorkbenchController` itself has a
 * dedicated suite in the application package, and editor interiors belong to
 * the editor provider, not to the shell.
 */

import { Runtime, definePlugin } from '@froglight/runtime';
import { act } from 'react';
import { vi } from 'vitest';
import {
  InMemorySearchService,
  MemoryVault,
  markdownKind,
  markdownKindId,
  memoryVaultPlugin,
  pathName,
  searchToken,
  vaultToken,
  workspacePath,
  workspaceToken,
  documentRegistryToken,
  type DocumentRef,
  type VaultService,
  type WorkspaceService,
} from '@froglight/foundation';
import type { DocumentKindId } from '@froglight/foundation';
import { workspacePlugin } from '@froglight/foundation';
import type { ServiceToken } from '@froglight/runtime';
import {
  installDefaultUi,
  type InstalledUi,
  type VaultChoice,
  type VaultHostAdapter,
} from '../workbench.js';
import type {
  DockMoveTargetView,
  WorkbenchControllerView,
  WorkbenchDocumentView,
} from '../workbench.js';
import type { WindowChrome } from '../window-chrome.js';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A Tauri-like `WindowChrome` double whose window operations are recorded.
 * Overrides apply to the contract surface; the operation spies always win.
 */
export type ChromeDouble = WindowChrome & {
  minimize: ReturnType<typeof vi.fn>;
  toggleMaximize: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

export function chromeDouble(
  overrides: Partial<WindowChrome> = {},
): ChromeDouble {
  const ops = {
    minimize: vi.fn().mockResolvedValue(undefined),
    toggleMaximize: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
  return {
    kind: 'tauri',
    appControls: true,
    dragRegion: true,
    inset: () => ({ left: 0, right: 0 }),
    ...overrides,
    ...ops,
  } as ChromeDouble;
}

/** Flush microtasks/timers enough for React effects and async handlers. */
export async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** Wait for real wall-clock time (for CSS animation windows). */
export async function waitMs(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** Repeatedly settle until `predicate` holds or attempts run out. */
export async function until(
  predicate: () => boolean,
  attempts = 100,
): Promise<void> {
  for (let i = 0; i < attempts && !predicate(); i += 1) {
    await act(async () => {
      await settle();
    });
  }
  if (!predicate()) throw new Error('condition not reached before timeout');
}

async function actSettle(): Promise<void> {
  await act(async () => {
    await settle();
  });
}

/** Click an element inside `root`, wrapped so React state updates flush. */
export async function click(
  root: ParentNode,
  selector: string,
): Promise<HTMLElement> {
  const element = root.querySelector<HTMLElement>(selector);
  if (element === null) throw new Error(`no element matches ${selector}`);
  await actClick(element);
  return element;
}

export async function actClick(element: HTMLElement): Promise<void> {
  element.dispatchEvent(
    new MouseEvent('click', { bubbles: true, cancelable: true }),
  );
  await actSettle();
}

// ---------------------------------------------------------------- fake controller

export interface FakeControllerOptions {
  readonly documents?: readonly {
    documentId: string;
    kindId?: string;
    path: string;
    text?: string;
  }[];
}

export interface FakeWorkbenchController extends WorkbenchControllerView {
  /** Simulate a dirty-state transition for the pane's session. */
  setPaneDirty(pane: string, dirty: boolean): void;
  /** Element most recently passed as the pane's editor parent. */
  editorParentOf(pane: string): unknown;
  /** Test-only: inject a view tab as if restored from a saved dock layout. */
  injectViewTab(pane: string, viewId: string): string;
  calls: {
    initialize: number;
    openDocument: { documentId: string; pane: string }[];
    closePane: string[];
    closeVault: number;
    dispose: number;
    saves: (string | null)[];
    creations: { path: string; kindId?: string }[];
    pdfImports: { name: string; bytes: Uint8Array; password?: string }[];
    reveals: { pane: string; address: string }[];
  };
}

interface FakePaneRecord {
  documentId: string | null;
  dirty: boolean;
  tabs: {
    id: string;
    kind: 'document' | 'view';
    documentId: string | null;
    viewId: string | null;
  }[];
  activeTab: string | null;
  modes: Map<string, import('@froglight/foundation').DocumentPresentationMode>;
}

export function createFakeWorkbenchController(
  options: FakeControllerOptions = {},
): FakeWorkbenchController {
  const listeners = new Set<() => void>();
  const documents = new Map<string, WorkbenchDocumentView & { text: string }>();
  for (const seed of options.documents ?? [
    {
      documentId: 'doc-1',
      path: 'notes/welcome.md',
      text: '# Welcome\n\nHello.',
    },
  ]) {
    documents.set(seed.documentId, {
      documentId: seed.documentId,
      kindId: seed.kindId ?? markdownKindId,
      path: seed.path,
      title: pathName(workspacePath(seed.path)) ?? seed.path,
      text: seed.text ?? '',
    });
  }
  let creationCounter = 0;
  const panes = new Map<string, FakePaneRecord>();
  const editorParents = new Map<string, unknown>();
  const readerParents = new Map<string, unknown>();
  let focusedPane = 'main';
  let viewCounter = 0;
  let maximizedPane: string | null = null;
  // Dock tree: binary splits over pane ids, mirroring the real controller.
  type FakeNode =
    | { kind: 'leaf'; pane: string }
    | {
        kind: 'split';
        direction: 'horizontal' | 'vertical';
        ratio: number;
        first: FakeNode;
        second: FakeNode;
      };
  let root: FakeNode = { kind: 'leaf', pane: 'main' };
  const calls = {
    initialize: 0,
    openDocument: [] as { documentId: string; pane: string }[],
    closePane: [] as string[],
    closeVault: 0,
    dispose: 0,
    saves: [] as (string | null)[],
    creations: [] as { path: string; kindId?: string }[],
    pdfImports: [] as { name: string; bytes: Uint8Array; password?: string }[],
    reveals: [] as { pane: string; address: string }[],
  };

  const notify = (): void => {
    for (const listener of [...listeners]) listener();
  };

  const ensurePane = (pane: string): FakePaneRecord => {
    const existing = panes.get(pane);
    if (existing !== undefined) return existing;
    panes.set(pane, {
      documentId: null,
      dirty: false,
      tabs: [],
      activeTab: null,
      modes: new Map(),
    });
    return panes.get(pane)!;
  };

  const fakeLeafIds = (from?: FakeNode): string[] => {
    const out: string[] = [];
    const walk = (node: FakeNode): void => {
      if (node.kind === 'leaf') out.push(node.pane);
      else {
        walk(node.first);
        walk(node.second);
      }
    };
    walk(from ?? root);
    return out;
  };

  const fakeFindLeaf = (pane: string): boolean => fakeLeafIds().includes(pane);

  const fakeRemoveLeaf = (pane: string): void => {
    const prune = (node: FakeNode): FakeNode | null => {
      if (node.kind === 'leaf') return node.pane === pane ? null : node;
      const first = prune(node.first);
      const second = prune(node.second);
      if (first === null) return second;
      if (second === null) return first;
      return { ...node, first, second };
    };
    root = prune(root) ?? { kind: 'leaf', pane: 'main' };
  };

  const fakeSplit = (
    pane: string,
    direction: 'right' | 'down' | 'left' | 'up',
    newPane: string,
  ): void => {
    const axis =
      direction === 'right' || direction === 'left' ? 'horizontal' : 'vertical';
    const before = direction === 'left' || direction === 'up';
    const walk = (node: FakeNode): FakeNode => {
      if (node.kind === 'leaf') {
        if (node.pane !== pane) return node;
        const fresh: FakeNode = { kind: 'leaf', pane: newPane };
        return {
          kind: 'split',
          direction: axis,
          ratio: 0.5,
          first: before ? fresh : node,
          second: before ? node : fresh,
        };
      }
      return { ...node, first: walk(node.first), second: walk(node.second) };
    };
    root = walk(root);
  };

  const controller: FakeWorkbenchController = {
    calls,
    setPaneDirty(pane, dirty) {
      const target = panes.get(pane);
      if (target === undefined) return;
      target.dirty = dirty;
      notify();
    },
    editorParentOf(pane) {
      return editorParents.get(pane);
    },
    injectViewTab(pane, viewId) {
      const restored = ensurePane(pane);
      viewCounter += 1;
      const tabId = `view:${viewId}:${viewCounter}`;
      restored.tabs = [
        ...restored.tabs,
        { id: tabId, kind: 'view', documentId: null, viewId },
      ];
      restored.activeTab = tabId;
      restored.documentId = null;
      notify();
      return tabId;
    },
    get focusedPane() {
      return focusedPane;
    },
    onDidChange(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    get state() {
      const active = panes.get(focusedPane);
      const doc =
        active?.documentId != null
          ? documents.get(active.documentId)
          : undefined;
      return {
        activeDocumentId: active?.documentId ?? null,
        activeDocumentTitle: doc?.title ?? null,
        activeDocumentPath: doc?.path ?? null,
        dirty: active?.dirty ?? false,
        canGoBack: false,
        canGoForward: false,
      };
    },
    listDocuments() {
      return [...documents.values()].map(({ text: _text, ...view }) => view);
    },
    async initialize(editorParent) {
      calls.initialize += 1;
      editorParents.set('main', editorParent);
      const first = [...documents.keys()][0];
      if (first !== undefined)
        await controller.openDocument(first, editorParent);
    },
    async createAndOpen(
      pathText: string,
      editorParent?: unknown,
      opts?: { pane?: string; kindId?: string },
    ) {
      // Host-bearing, like the real controller: the second argument is an
      // opaque editor host, never options. Document-only callers must go
      // through `createWorkbenchDocumentPort`.
      void editorParent;
      creationCounter += 1;
      const id = `doc-created-${creationCounter}`;
      documents.set(id, {
        documentId: id,
        kindId: opts?.kindId ?? markdownKindId,
        path: pathText,
        title: pathName(workspacePath(pathText)) ?? pathText,
        text: '',
      });
      calls.creations.push({
        path: pathText,
        ...(opts?.kindId !== undefined ? { kindId: opts.kindId } : {}),
      });
      await controller.openDocument(id, undefined, opts);
      return { documentId: id } as DocumentRef;
    },
    async importPdfAsNotebook(input) {
      calls.pdfImports.push({
        name: input.name,
        bytes: input.bytes.slice(),
        ...(input.password !== undefined ? { password: input.password } : {}),
      });
      return { documentId: 'pdf-import', pageCount: 2 };
    },
    async openDocument(
      documentId: string,
      editorParent?: unknown,
      opts?: { pane?: string; address?: string; preserveFocus?: boolean },
    ) {
      void opts?.address;
      if (!documents.has(documentId))
        throw new Error(`unknown document ${documentId}`);
      const pane = opts?.pane ?? 'main';
      if (!fakeFindLeaf(pane)) {
        // Mirror the real controller: opening into an unknown pane splits
        // it in from the first leaf.
        fakeSplit(fakeLeafIds()[0] ?? 'main', 'right', pane);
      }
      ensurePane(pane);
      const record2 = panes.get(pane)!;
      record2.documentId = documentId;
      record2.dirty = false;
      const existing = record2.tabs.find(
        (tab) => tab.kind === 'document' && tab.documentId === documentId,
      );
      if (existing === undefined) {
        record2.tabs = [
          ...record2.tabs,
          { id: documentId, kind: 'document', documentId, viewId: null },
        ];
        record2.activeTab = documentId;
      } else {
        record2.activeTab = existing.id;
      }
      editorParents.set(pane, editorParent);
      // Background opens never modify global focus (never-touch semantic).
      if (opts?.preserveFocus !== true) {
        focusedPane = pane;
      }
      calls.openDocument.push({ documentId, pane });
      notify();
    },
    async deleteDocument(documentId) {
      documents.delete(documentId);
      for (const record2 of panes.values()) {
        record2.tabs = record2.tabs.filter(
          (tab) => tab.documentId !== documentId,
        );
        if (
          record2.activeTab !== null &&
          !record2.tabs.some((tab) => tab.id === record2.activeTab)
        ) {
          const next = record2.tabs[0];
          record2.activeTab = next?.id ?? null;
          record2.documentId =
            next?.kind === 'document' ? next.documentId : null;
        }
      }
      notify();
    },
    async pruneMissingDocuments() {
      for (const record2 of panes.values()) {
        record2.tabs = record2.tabs.filter(
          (tab) =>
            tab.kind !== 'document' ||
            tab.documentId === null ||
            documents.has(tab.documentId),
        );
        if (
          record2.activeTab !== null &&
          !record2.tabs.some((tab) => tab.id === record2.activeTab)
        ) {
          const next = record2.tabs[0];
          record2.activeTab = next?.id ?? null;
          record2.documentId =
            next?.kind === 'document' ? next.documentId : null;
        }
      }
      notify();
    },
    dockState() {
      const leaves = fakeLeafIds();
      return {
        root,
        focusedPane: leaves.includes(focusedPane)
          ? focusedPane
          : (leaves[0] ?? null),
        maximizedPane,
      };
    },
    leafIds() {
      return fakeLeafIds();
    },
    splitPane(pane, direction, opts?: { preserveFocus?: boolean }) {
      const anchor = fakeFindLeaf(pane) ? pane : (fakeLeafIds()[0] ?? 'main');
      let counter = panes.size + 1;
      let created = `pane-${counter}`;
      while (fakeFindLeaf(created) || panes.has(created)) {
        counter += 1;
        created = `pane-${counter}`;
      }
      fakeSplit(anchor, direction, created);
      ensurePane(created);
      // Background splits never modify global focus (never-touch semantic).
      if (opts?.preserveFocus !== true) {
        focusedPane = created;
      }
      notify();
      return created;
    },
    async activateTab(pane, tabId) {
      const record2 = panes.get(pane);
      if (record2 === undefined || record2.activeTab === tabId) return;
      const tab = record2.tabs.find((candidate) => candidate.id === tabId);
      if (tab === undefined) return;
      record2.activeTab = tabId;
      record2.documentId = tab.kind === 'document' ? tab.documentId : null;
      record2.dirty = false;
      notify();
    },
    async closeTab(pane, tabId) {
      const record2 = panes.get(pane);
      if (record2 === undefined) return;
      const index = record2.tabs.findIndex((tab) => tab.id === tabId);
      if (index < 0) return;
      const wasActive = record2.activeTab === tabId;
      record2.tabs = record2.tabs.filter((tab) => tab.id !== tabId);
      record2.modes.delete(tabId);
      if (!wasActive) {
        notify();
        return;
      }
      const next = record2.tabs[Math.min(index, record2.tabs.length - 1)];
      if (next !== undefined) {
        record2.activeTab = next.id;
        record2.documentId = next.kind === 'document' ? next.documentId : null;
        record2.dirty = false;
      } else {
        record2.activeTab = null;
        record2.documentId = null;
        fakeRemoveLeaf(pane);
        panes.delete(pane);
        if (focusedPane === pane) focusedPane = fakeLeafIds()[0] ?? 'main';
      }
      notify();
    },
    async openView(viewId, opts?: { pane?: string; preserveFocus?: boolean }) {
      const pane = opts?.pane ?? focusedPane;
      const preserve = opts?.preserveFocus === true;
      ensurePane(pane);
      const record2 = panes.get(pane)!;
      record2.documentId = null;
      record2.dirty = false;
      const focusTarget = (): void => {
        // Background opens never modify global focus (never-touch semantic).
        if (!preserve) {
          focusedPane = pane;
        }
      };
      // Mirror the real controller: one tab per view id per pane.
      const existing = record2.tabs.find(
        (tab) => tab.kind === 'view' && tab.viewId === viewId,
      );
      if (existing !== undefined) {
        record2.activeTab = existing.id;
        focusTarget();
        notify();
        return existing.id;
      }
      viewCounter += 1;
      const tabId = `view:${viewId}:${viewCounter}`;
      record2.tabs = [
        ...record2.tabs,
        { id: tabId, kind: 'view', documentId: null, viewId },
      ];
      record2.activeTab = tabId;
      focusTarget();
      notify();
      return tabId;
    },
    async moveTab(fromPane: string, tabId: string, target: DockMoveTargetView) {
      const source = panes.get(fromPane);
      if (source === undefined) return null;
      const tab = source.tabs.find((candidate) => candidate.id === tabId);
      if (tab === undefined) return null;
      source.tabs = source.tabs.filter((candidate) => candidate.id !== tabId);
      if (source.activeTab === tabId) {
        const next = source.tabs[source.tabs.length - 1];
        source.activeTab = next?.id ?? null;
        source.documentId = next?.kind === 'document' ? next.documentId : null;
      }
      if (source.tabs.length === 0 && fromPane !== target.pane) {
        fakeRemoveLeaf(fromPane);
        panes.delete(fromPane);
      }
      let targetPane: string;
      if (target.kind === 'split') {
        targetPane = `pane-${panes.size + 1}-${tabId}`;
        fakeSplit(target.pane, target.direction, targetPane);
        ensurePane(targetPane);
      } else {
        targetPane = target.pane;
        ensurePane(targetPane);
      }
      const targetRecord = panes.get(targetPane)!;
      const without = targetRecord.tabs.filter(
        (candidate) => candidate.id !== tabId,
      );
      const index = Math.max(
        0,
        Math.min(
          target.kind === 'pane' && target.index !== undefined
            ? target.index
            : without.length,
          without.length,
        ),
      );
      targetRecord.tabs = [
        ...without.slice(0, index),
        tab,
        ...without.slice(index),
      ];
      targetRecord.activeTab = tabId;
      targetRecord.documentId = tab.kind === 'document' ? tab.documentId : null;
      focusedPane = targetPane;
      notify();
      return target.kind === 'split' ? targetPane : null;
    },
    movePaneBeside(fromPane, targetPane, direction) {
      if (
        fromPane === targetPane ||
        !fakeFindLeaf(fromPane) ||
        !fakeFindLeaf(targetPane)
      )
        return;
      // Group-drag behavior belongs to the real controller; this test double
      // only needs to preserve the public callback seam.
      void direction;
      notify();
    },
    setSplitRatio(pane, ratio) {
      const clamp = Math.min(0.8, Math.max(0.2, ratio));
      const walk = (node: FakeNode): FakeNode => {
        if (node.kind === 'leaf') return node;
        const inFirst = fakeLeafIds(node.first).includes(pane);
        const inSecond = fakeLeafIds(node.second).includes(pane);
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
      root = walk(root);
      notify();
    },
    setSplitRatioAt(path, ratio) {
      const clamp = Math.min(0.8, Math.max(0.2, ratio));
      const walk = (
        node: FakeNode,
        remaining: readonly ('first' | 'second')[],
      ): FakeNode => {
        if (node.kind === 'leaf') return node;
        const [side, ...rest] = remaining;
        if (side === undefined) return { ...node, ratio: clamp };
        return { ...node, [side]: walk(node[side], rest) };
      };
      root = walk(root, path);
      notify();
    },
    toggleMaximize(pane) {
      const target = pane ?? focusedPane;
      maximizedPane = maximizedPane === target ? null : target;
      notify();
    },
    availableTabModes() {
      return ['edit', 'reading'] as const;
    },
    tabMode(pane, tabId) {
      const record2 = panes.get(pane);
      const id = tabId ?? record2?.activeTab ?? null;
      return id !== null ? (record2?.modes.get(id) ?? 'edit') : 'edit';
    },
    setTabMode(pane, tabId, mode) {
      ensurePane(pane).modes.set(tabId, mode);
      notify();
    },
    async closeOtherPanes(keep) {
      const target = keep ?? focusedPane;
      for (const pane of fakeLeafIds().filter((leaf) => leaf !== target)) {
        panes.delete(pane);
        fakeRemoveLeaf(pane);
      }
      focusedPane = target;
      notify();
    },
    liveOwnerOf(documentId: string): string | null {
      // Mirror the controller's #liveOwnerOf: scan panes for an active
      // documentId with a live session, return the pane name or null.
      // Synchronous with no lane waits.
      for (const [name, record2] of panes) {
        if (record2.documentId === documentId) return name;
      }
      return null;
    },
    discardRedirectedSplit(created: string, documentId: string): void {
      // Mirror the controller's #discardRedirectedSplit: remove only a
      // strictly-empty leaf. Never touches a pane that gained content (the
      // live owner closed mid-flight and the open landed in `created`).
      // Synchronous with no lane waits.
      const current = panes.get(created);
      if (current?.documentId === documentId) return;
      let redirected = false;
      for (const [name, record2] of panes) {
        if (name !== created && record2.documentId === documentId) {
          redirected = true;
          break;
        }
      }
      if (!redirected) return;
      if (!fakeFindLeaf(created)) return;
      const runtime = panes.get(created);
      if (runtime === undefined) return;
      if (runtime.documentId !== null) return;
      if (runtime.tabs.length !== 0) return;
      fakeRemoveLeaf(created);
      panes.delete(created);
      if (focusedPane === created || !fakeFindLeaf(focusedPane))
        focusedPane = fakeLeafIds()[0] ?? 'main';
      notify();
    },
    async openLink(destination: string) {
      const match = [...documents.values()].find(
        (candidate) =>
          candidate.title.replace(/\.md$/i, '') === destination ||
          candidate.path.replace(/\.md$/i, '') === destination,
      );
      if (match !== undefined) {
        await controller.openDocument(match.documentId);
        return { created: false, documentId: match.documentId };
      }
      const ref = await controller.createAndOpen(`${destination}.md`);
      return {
        created: true,
        documentId: (ref as { documentId: string }).documentId,
      };
    },
    async saveActive() {
      calls.saves.push(focusedPane);
      const pane = panes.get(focusedPane);
      if (pane === undefined || pane.documentId === null) return null;
      pane.dirty = false;
      notify();
      return { committed: true, error: undefined };
    },
    async savePane(paneId: string) {
      calls.saves.push(paneId);
      const pane = panes.get(paneId);
      if (pane === undefined || pane.documentId === null) return null;
      pane.dirty = false;
      notify();
      return { committed: true, error: undefined };
    },
    execEditorCommand(): boolean {
      return true;
    },
    canExecEditorCommand(): boolean {
      return true;
    },
    editorToolSnapshot() {
      return null;
    },
    executeEditorTool() {
      return false;
    },
    revealAddress(pane, address) {
      calls.reveals.push({ pane, address });
      return true;
    },
    async goBack() {
      return false;
    },
    async goForward() {
      return false;
    },
    focusPane(pane) {
      if (!fakeFindLeaf(pane)) return;
      focusedPane = pane;
      notify();
    },
    isPaneActive(pane) {
      const record2 = panes.get(pane);
      return record2?.documentId != null;
    },
    isPaneAttached(pane, editorParent) {
      const record2 = panes.get(pane);
      return (
        record2?.documentId != null && editorParents.get(pane) === editorParent
      );
    },
    async reattachPane(pane, editorParent) {
      const record2 = panes.get(pane);
      if (record2?.documentId == null) return;
      editorParents.set(pane, editorParent);
      notify();
    },
    async closePane(pane) {
      calls.closePane.push(pane);
      // Migrate tabs into the next neighbor, then drop the pane.
      const leaves = fakeLeafIds();
      const index = leaves.indexOf(pane);
      if (index >= 0 && leaves.length > 1) {
        const neighbor = leaves[index + 1] ?? leaves[index - 1]!;
        const source = panes.get(pane);
        const targetRecord = ensurePane(neighbor);
        if (source !== undefined) {
          for (const tab of source.tabs) {
            const duplicate =
              tab.kind === 'document' &&
              targetRecord.tabs.some(
                (existing) =>
                  existing.kind === 'document' &&
                  existing.documentId === tab.documentId,
              );
            if (!duplicate) targetRecord.tabs = [...targetRecord.tabs, tab];
          }
          if (targetRecord.activeTab === null && targetRecord.tabs.length > 0) {
            targetRecord.activeTab = targetRecord.tabs[0]!.id;
            const activeTab = targetRecord.tabs[0]!;
            targetRecord.documentId =
              activeTab.kind === 'document' ? activeTab.documentId : null;
          }
        }
      }
      panes.delete(pane);
      fakeRemoveLeaf(pane);
      if (focusedPane === pane || !fakeFindLeaf(focusedPane))
        focusedPane = fakeLeafIds()[0] ?? 'main';
      notify();
    },
    paneStates() {
      return fakeLeafIds().map((pane) => {
        const record2 = panes.get(pane);
        const tabs = record2?.tabs ?? [];
        const activeTab = record2?.activeTab ?? null;
        const active = tabs.find((tab) => tab.id === activeTab) ?? null;
        const doc =
          active?.kind === 'document' && active.documentId != null
            ? documents.get(active.documentId)
            : undefined;
        return {
          pane,
          tabs,
          activeTab,
          mode:
            activeTab !== null
              ? (record2?.modes.get(activeTab) ?? 'edit')
              : 'edit',
          documentId:
            active?.kind === 'document' ? (active.documentId ?? null) : null,
          viewId: active?.kind === 'view' ? (active.viewId ?? null) : null,
          title: doc?.title ?? null,
          path: doc?.path ?? null,
          dirty: record2?.dirty ?? false,
          recoveryWarnings: [],
          canGoBack: false,
          canGoForward: false,
        };
      });
    },
    readingPresentation(pane: string) {
      const active = panes.get(pane);
      const doc =
        active?.documentId != null
          ? documents.get(active.documentId)
          : undefined;
      // The shell test double has no separate reader: reading mode keeps
      // the editor's read-only surface.
      return {
        kind: 'editor-readonly',
        kindId: (doc?.kindId ?? null) as DocumentKindId | null,
      } as const;
    },
    getPaneText(pane: string) {
      const active = panes.get(pane);
      const doc =
        active?.documentId != null
          ? documents.get(active.documentId)
          : undefined;
      return doc?.kindId === markdownKindId ? doc.text : null;
    },
    setReaderHost(pane: string, readerParent: unknown): void {
      readerParents.set(pane, readerParent);
    },
    isReaderAttached(pane: string, readerParent: unknown): boolean {
      return readerParents.get(pane) === readerParent;
    },
    async closeVaultView() {
      calls.closeVault += 1;
      panes.clear();
      editorParents.clear();
      focusedPane = 'main';
      notify();
    },
    async dispose() {
      calls.dispose += 1;
      listeners.clear();
    },
  };
  return controller;
}

// ---------------------------------------------------------------- fake vault host

export interface RecordedChoice extends VaultChoice {
  activations: number;
}

export function makeChoice(init: {
  id: string;
  name: string;
  location?: string;
}): RecordedChoice {
  const choice: RecordedChoice = {
    id: init.id,
    name: init.name,
    location: init.location ?? `/vaults/${init.id}`,
    activations: 0,
    async activate() {
      choice.activations += 1;
    },
  };
  return choice;
}

export interface FakeVaultHostAdapter extends VaultHostAdapter {
  readonly choices: RecordedChoice[];
  forgotten: string[];
  openError: Error | null;
}

export function createFakeVaultAdapter(
  choices: RecordedChoice[] = [],
): FakeVaultHostAdapter {
  const forgotten: string[] = [];
  return {
    choices,
    forgotten,
    openError: null,
    async listRecent() {
      return choices.filter((choice) => !forgotten.includes(choice.id));
    },
    async openForBackup(id) {
      if (
        !choices.some((choice) => choice.id === id && !forgotten.includes(id))
      )
        throw new Error('Vault is no longer available');
      return new MemoryVault();
    },
    async chooseCreateLocation() {
      return null;
    },
    async openVault() {
      if (this.openError !== null) throw this.openError;
      return null;
    },
    async forgetVault(id) {
      forgotten.push(id);
    },
  };
}

// ---------------------------------------------------------------- composition

export interface Harness {
  readonly runtime: Runtime;
  readonly search: InMemorySearchService;
  readonly workspace: WorkspaceService;
  readonly vault: VaultService;
  readonly controller: FakeWorkbenchController;
  readonly adapter: FakeVaultHostAdapter;
  readonly ui: InstalledUi;
  /** Attached by the spec via mountFroglightApp. */
  root: HTMLElement;
  dispose(): Promise<void>;
}

/**
 * Real composition: runtime + memory vault + workspace (+ markdown kind) +
 * in-memory search + every default first-party UI plugin.
 */
export async function createHarness(
  recents: RecordedChoice[] = [],
  documents: readonly { documentId: string; path: string; text?: string }[] = [
    {
      documentId: 'doc-1',
      path: 'notes/welcome.md',
      text: '# Welcome\n\nHello.',
    },
  ],
): Promise<Harness> {
  const runtime = new Runtime();
  const search = new InMemorySearchService();

  await runtime.registerSlot({ id: 'vault', plugin: memoryVaultPlugin });
  await runtime.registerSlot({
    id: 'search',
    plugin: definePlugin({
      id: 'test.search-binding',
      activate: (ctx) => {
        ctx.provide(searchToken as ServiceToken<InMemorySearchService>, search);
      },
    }),
  });
  await runtime.registerSlot({ id: 'workspace', plugin: workspacePlugin });
  await runtime.registerSlot({
    id: 'markdown-kind',
    plugin: definePlugin({
      id: 'test.markdown-kind',
      requirements: { requires: [documentRegistryToken] },
      activate: (ctx) => {
        ctx.effect(
          () =>
            ctx.require(documentRegistryToken).register(markdownKind).dispose,
        );
      },
    }),
  });

  const ui = await installDefaultUi(runtime);

  const workspace = await captureWorkspace(runtime);
  const vault = await captureVault(runtime);

  return {
    runtime,
    search,
    workspace,
    vault,
    controller: createFakeWorkbenchController({ documents }),
    adapter: createFakeVaultAdapter(recents),
    ui,
    root: null as unknown as HTMLElement,
    async dispose() {
      await runtime.dispose();
      document.body.innerHTML = '';
    },
  };
}

async function captureVault(runtime: Runtime): Promise<VaultService> {
  let captured: VaultService | null = null;
  const probe = definePlugin({
    id: 'test.vault-capture',
    requirements: { requires: [vaultToken] },
    activate: (ctx) => {
      captured = ctx.require(vaultToken);
    },
  });
  await runtime.registerSlot({ id: 'vault-capture', plugin: probe });
  if (captured === null) throw new Error('vault service failed to activate');
  return captured;
}

async function captureWorkspace(runtime: Runtime): Promise<WorkspaceService> {
  let captured: WorkspaceService | null = null;
  const probe = definePlugin({
    id: 'test.workspace-capture',
    requirements: { requires: [workspaceToken] },
    activate: (ctx) => {
      captured = ctx.require(workspaceToken);
    },
  });
  await runtime.registerSlot({ id: 'workspace-capture', plugin: probe });
  if (captured === null)
    throw new Error('workspace service failed to activate');
  return captured;
}
