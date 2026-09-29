import { describe, expect, it } from 'vitest';
import {
  createWorkspaceDocumentRouter,
  type DocumentRouterEffects,
  type DocumentRouterPreviews,
  type DocumentRouterWorkbench,
} from './documentRouter.js';
import type { PaneView } from '../../../workbench-view.js';
import { PREVIEW_VIEW_ID_PREFIX } from '../../../view-registry.js';

interface FakeTab {
  id: string;
  kind: 'document' | 'view';
  documentId: string | null;
  viewId: string | null;
}

interface FakePane {
  tabs: FakeTab[];
  activeTab: string | null;
}

/** Contract-faithful fake: per-pane promise serialization like the real controller. */
function createFakeWorkbench(
  options: {
    documents?: readonly string[];
    panes?: Record<string, FakePane>;
    focused?: string;
    pending?: readonly string[];
    openDelay?: (documentId: string) => Promise<void> | void;
    viewDelay?: (viewId: string) => Promise<void> | void;
  } = {},
): DocumentRouterWorkbench & {
  calls: {
    openDocument: { pane: string; documentId: string }[];
    openDocumentPreserve: boolean[];
    openView: { viewId: string; pane: string }[];
    openViewPreserve: boolean[];
    closeTab: { pane: string; tabId: string }[];
    activateTab: { pane: string; tabId: string }[];
    reveals: { pane: string; address: string }[];
    openLink: { destination: string; pane?: string }[];
    splits: { pane: string; preserveFocus: boolean }[];
    discards: { created: string; documentId: string }[];
    prunes: number;
  };
  /** Every global-focus assignment, in order. Empty means focus never moved. */
  focusLog: string[];
  setPending(pane: string, pending: boolean): void;
  activeDocumentIn(pane: string): string | null;
  activeViewIn(pane: string): string | null;
} {
  const documents = new Set(options.documents ?? ['doc-a', 'doc-b', 'doc-c']);
  const panes = new Map<string, FakePane>();
  for (const [pane, state] of Object.entries(options.panes ?? {})) {
    panes.set(pane, {
      tabs: state.tabs.map((tab) => ({ ...tab })),
      activeTab: state.activeTab,
    });
  }
  if (panes.size === 0) {
    panes.set('main', { tabs: [], activeTab: null });
  }
  let focused = options.focused ?? 'main';
  const pending = new Set<string>(options.pending ?? []);
  // Leaf order mirrors insertion; splits append new leaves.
  const leaves: string[] = [...panes.keys()];
  let splitCounter = leaves.length;
  const chains = new Map<string, Promise<void>>();
  const focusLog: string[] = [];
  function setFocused(pane: string): void {
    focused = pane;
    focusLog.push(pane);
  }
  const calls = {
    openDocument: [] as { pane: string; documentId: string }[],
    openDocumentPreserve: [] as boolean[],
    openView: [] as { viewId: string; pane: string }[],
    openViewPreserve: [] as boolean[],
    closeTab: [] as { pane: string; tabId: string }[],
    activateTab: [] as { pane: string; tabId: string }[],
    reveals: [] as { pane: string; address: string }[],
    openLink: [] as { destination: string; pane?: string }[],
    splits: [] as { pane: string; preserveFocus: boolean }[],
    discards: [] as { created: string; documentId: string }[],
    prunes: 0,
  };

  function paneView(pane: string): PaneView {
    const record = panes.get(pane);
    const tabs = record?.tabs ?? [];
    const activeTab = record?.activeTab ?? null;
    const active = tabs.find((tab) => tab.id === activeTab) ?? null;
    return {
      pane,
      tabs: tabs.map((tab) => ({ ...tab })),
      activeTab,
      mode: 'edit',
      documentId: active?.kind === 'document' ? active.documentId : null,
      viewId: active?.kind === 'view' ? active.viewId : null,
      title: null,
      path: null,
      dirty: false,
      recoveryWarnings: [],
      canGoBack: false,
      canGoForward: false,
    };
  }

  function queuePane<T>(pane: string, run: () => Promise<T>): Promise<T> {
    const previous = chains.get(pane) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(run);
    const settled = operation.then(
      () => undefined,
      () => undefined,
    );
    chains.set(pane, settled);
    void settled.then(() => {
      if (chains.get(pane) === settled) chains.delete(pane);
    });
    return operation;
  }

  const workbench: DocumentRouterWorkbench & {
    calls: typeof calls;
    focusLog: string[];
    setPending(p: string, v: boolean): void;
    activeDocumentIn(p: string): string | null;
    activeViewIn(p: string): string | null;
  } = {
    calls,
    focusLog,
    setPending(pane, value) {
      if (value) pending.add(pane);
      else pending.delete(pane);
    },
    activeDocumentIn(pane) {
      return paneView(pane).documentId;
    },
    activeViewIn(pane) {
      return paneView(pane).viewId;
    },
    get focusedPane() {
      return focused;
    },
    leafIds() {
      return [...leaves];
    },
    paneStates() {
      return leaves.map(paneView);
    },
    focusPane(pane: string) {
      if (leaves.includes(pane)) setFocused(pane);
    },
    splitPane(pane, _direction?, opts?) {
      splitCounter += 1;
      const created = `pane-${splitCounter}`;
      leaves.push(created);
      panes.set(created, { tabs: [], activeTab: null });
      const preserve = opts?.preserveFocus === true;
      if (!preserve) setFocused(created);
      calls.splits.push({ pane, preserveFocus: preserve });
      return created;
    },
    liveOwnerOf(documentId: string): string | null {
      for (const leaf of leaves) {
        if (paneView(leaf).documentId === documentId) return leaf;
      }
      return null;
    },
    discardRedirectedSplit(created: string, documentId: string): void {
      calls.discards.push({ created, documentId });
      // Mirror the controller: keep the pane when the open landed there
      // (the owner closed mid-flight); otherwise remove exactly the
      // strictly-empty redirected leaf.
      const owner = (() => {
        for (const leaf of leaves) {
          if (paneView(leaf).documentId === documentId) return leaf;
        }
        return null;
      })();
      if (owner === created) return;
      if (!leaves.includes(created)) return;
      const record = panes.get(created);
      if (record === undefined) return;
      if (record.tabs.length !== 0) return;
      if (record.activeTab !== null) return;
      const index = leaves.indexOf(created);
      if (index >= 0) leaves.splice(index, 1);
      panes.delete(created);
      if (focused === created) {
        focused = leaves[0] ?? 'main';
      }
    },
    openDocument(pane, documentId, address?: string, opts?: { preserveFocus?: boolean }) {
      return queuePane(pane, async () => {
        if (!documents.has(documentId)) throw new Error('unknown document');
        await options.openDelay?.(documentId);
        calls.openDocument.push({ pane, documentId });
        calls.openDocumentPreserve.push(opts?.preserveFocus === true);
        void address;
        if (!leaves.includes(pane)) {
          leaves.push(pane);
          panes.set(pane, { tabs: [], activeTab: null });
        }
        const record = panes.get(pane)!;
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
        if (opts?.preserveFocus !== true) setFocused(pane);
      });
    },
    openLink(destination, pane) {
      const target = pane ?? focused;
      calls.openLink.push(
        pane === undefined ? { destination } : { destination, pane },
      );
      // Resolve like the shell double: title match or create.
      const match = [...documents].find((id) => id === destination);
      const documentId = match ?? destination;
      documents.add(documentId);
      return workbench.openDocument(target, documentId).then(() => ({
        created: match === undefined,
        documentId,
      }));
    },
    openView(viewId, opts) {
      const pane = opts?.pane ?? focused;
      const preserve = opts?.preserveFocus === true;
      return queuePane(pane, async () => {
        await options.viewDelay?.(viewId);
        calls.openView.push({ viewId, pane });
        calls.openViewPreserve.push(preserve);
        if (!leaves.includes(pane)) {
          leaves.push(pane);
          panes.set(pane, { tabs: [], activeTab: null });
        }
        const record = panes.get(pane)!;
        const existing = record.tabs.find(
          (tab) => tab.kind === 'view' && tab.viewId === viewId,
        );
        if (existing !== undefined) {
          record.activeTab = existing.id;
        } else {
          const tabId = `view:${viewId}:${record.tabs.length + 1}`;
          record.tabs = [
            ...record.tabs,
            { id: tabId, kind: 'view', documentId: null, viewId },
          ];
          record.activeTab = tabId;
        }
        if (!preserve) setFocused(pane);
        return record.activeTab!;
      });
    },
    closeTab(pane, tabId) {
      return queuePane(pane, async () => {
        calls.closeTab.push({ pane, tabId });
        const record = panes.get(pane);
        if (record === undefined) return;
        const wasActive = record.activeTab === tabId;
        record.tabs = record.tabs.filter((tab) => tab.id !== tabId);
        if (!wasActive) return;
        const next = record.tabs[record.tabs.length - 1] ?? null;
        record.activeTab = next?.id ?? null;
      });
    },
    activateTab(pane, tabId) {
      return queuePane(pane, async () => {
        calls.activateTab.push({ pane, tabId });
        const record = panes.get(pane);
        if (record === undefined) return;
        record.activeTab = tabId;
        // Match the real controller: tab activation changes only the pane's
        // active tab, never global focus.
      });
    },
    revealAddress(pane, address) {
      calls.reveals.push({ pane, address });
      return true;
    },
    hasPendingOpen(pane) {
      return pending.has(pane);
    },
    pruneMissingDocuments: async (): Promise<void> => {
      calls.prunes += 1;
      for (const record of panes.values()) {
        record.tabs = record.tabs.filter(
          (tab) =>
            tab.kind !== 'document' ||
            tab.documentId === null ||
            documents.has(tab.documentId),
        );
        if (
          record.activeTab !== null &&
          !record.tabs.some((tab) => tab.id === record.activeTab)
        ) {
          const next = record.tabs[0] ?? null;
          record.activeTab = next?.id ?? null;
        }
      }
    },
  };
  return workbench;
}

function createEffects(
  overrides: { compact?: boolean } = {},
): DocumentRouterEffects & {
  notifies: { message: string }[];
  closes: number;
  bumps: number;
  published: { documentId: string | null; previewPath: string | null }[];
} {
  const compact = overrides.compact ?? false;
  const effects = {
    notifies: [] as { message: string }[],
    closes: 0,
    bumps: 0,
    published: [] as {
      documentId: string | null;
      previewPath: string | null;
    }[],
    notify(message: string) {
      effects.notifies.push({ message });
    },
    closeDrawer() {
      effects.closes += 1;
    },
    bump() {
      effects.bumps += 1;
    },
    publishActiveDocument(detail: {
      readonly documentId: string | null;
      readonly previewPath: string | null;
    }) {
      effects.published.push({
        documentId: detail.documentId,
        previewPath: detail.previewPath,
      });
    },
    isCompact: () => compact,
  };
  return effects;
}

function createPreviews(): DocumentRouterPreviews & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    ensurePreviewView(path: string): string {
      calls.push(path);
      return `${PREVIEW_VIEW_ID_PREFIX}${path}`;
    },
  };
}

describe('workspace document router', () => {
  it('foreground document open targets the focused pane', async () => {
    const workbench = createFakeWorkbench({
      panes: { main: { tabs: [], activeTab: null } },
      focused: 'main',
    });
    const previews = createPreviews();
    const effects = createEffects();
    const router = createWorkspaceDocumentRouter({
      workbench,
      previews,
      effects,
    });
    await router.dispatch({
      type: 'open-document',
      documentId: 'doc-a',
      disposition: 'foreground',
    });
    expect(workbench.calls.openDocument).toEqual([
      { pane: 'main', documentId: 'doc-a' },
    ]);
    expect(workbench.activeDocumentIn('main')).toBe('doc-a');
    expect(effects.closes).toBe(1);
  });

  it('foreground open with an explicit pane uses that pane', async () => {
    const workbench = createFakeWorkbench({
      panes: {
        main: { tabs: [], activeTab: null },
        second: { tabs: [], activeTab: null },
      },
      focused: 'main',
    });
    const router = createWorkspaceDocumentRouter({
      workbench,
      previews: createPreviews(),
      effects: createEffects(),
    });
    await router.dispatch({
      type: 'open-document',
      documentId: 'doc-b',
      disposition: 'foreground',
      pane: 'second',
    });
    expect(workbench.calls.openDocument).toEqual([
      { pane: 'second', documentId: 'doc-b' },
    ]);
  });

  it('reveals the portable address in the final presentation', async () => {
    const workbench = createFakeWorkbench();
    const router = createWorkspaceDocumentRouter({
      workbench,
      previews: createPreviews(),
      effects: createEffects(),
    });
    await router.dispatch({
      type: 'open-document',
      documentId: 'doc-a',
      address: 'heading-slug',
      disposition: 'foreground',
    });
    expect(workbench.calls.reveals).toEqual([
      { pane: 'main', address: 'heading-slug' },
    ]);
  });

  it('background open prefers an idle existing leaf', async () => {
    const workbench = createFakeWorkbench({
      documents: ['doc-a', 'doc-b'],
      panes: {
        main: {
          tabs: [
            {
              id: 'doc-a',
              kind: 'document',
              documentId: 'doc-a',
              viewId: null,
            },
          ],
          activeTab: 'doc-a',
        },
        second: { tabs: [], activeTab: null },
      },
      focused: 'main',
    });
    const router = createWorkspaceDocumentRouter({
      workbench,
      previews: createPreviews(),
      effects: createEffects(),
    });
    await router.dispatch({
      type: 'open-document',
      documentId: 'doc-b',
      disposition: 'background',
    });
    expect(workbench.calls.openDocument).toEqual([
      { pane: 'second', documentId: 'doc-b' },
    ]);
    expect(workbench.calls.splits).toEqual([]);
  });

  it('background open skips panes with pending host-readiness work', async () => {
    const workbench = createFakeWorkbench({
      documents: ['doc-a', 'doc-b'],
      panes: {
        main: {
          tabs: [
            {
              id: 'doc-a',
              kind: 'document',
              documentId: 'doc-a',
              viewId: null,
            },
          ],
          activeTab: 'doc-a',
        },
        second: { tabs: [], activeTab: null },
      },
      focused: 'main',
      pending: ['second'],
    });
    const router = createWorkspaceDocumentRouter({
      workbench,
      previews: createPreviews(),
      effects: createEffects(),
    });
    await router.dispatch({
      type: 'open-document',
      documentId: 'doc-b',
      disposition: 'background',
    });
    // No idle leaf remains: desktop layout splits right exactly once.
    expect(workbench.calls.splits).toHaveLength(1);
    const created = workbench.calls.openDocument[0]?.pane ?? '';
    expect(created).not.toBe('main');
    expect(created).not.toBe('second');
  });

  it('background open on compact layouts reuses the focused pane without splitting', async () => {
    const workbench = createFakeWorkbench({
      documents: ['doc-a', 'doc-b'],
      panes: {
        main: {
          tabs: [
            {
              id: 'doc-a',
              kind: 'document',
              documentId: 'doc-a',
              viewId: null,
            },
          ],
          activeTab: 'doc-a',
        },
      },
      focused: 'main',
    });
    const effects = createEffects({ compact: true });
    const router = createWorkspaceDocumentRouter({
      workbench,
      previews: createPreviews(),
      effects,
    });
    await router.dispatch({
      type: 'open-document',
      documentId: 'doc-b',
      disposition: 'background',
    });
    expect(workbench.calls.openDocument).toEqual([
      { pane: 'main', documentId: 'doc-b' },
    ]);
    expect(workbench.calls.splits).toEqual([]);
  });

  it('background open on desktop splits right when no leaf is idle', async () => {
    const workbench = createFakeWorkbench({
      documents: ['doc-a', 'doc-b'],
      panes: {
        main: {
          tabs: [
            {
              id: 'doc-a',
              kind: 'document',
              documentId: 'doc-a',
              viewId: null,
            },
          ],
          activeTab: 'doc-a',
        },
      },
      focused: 'main',
    });
    const router = createWorkspaceDocumentRouter({
      workbench,
      previews: createPreviews(),
      effects: createEffects(),
    });
    await router.dispatch({
      type: 'open-document',
      documentId: 'doc-b',
      disposition: 'background',
    });
    expect(workbench.calls.splits).toHaveLength(1);
    expect(workbench.calls.openDocument).toHaveLength(1);
    expect(workbench.calls.openDocument[0]?.pane).not.toBe('main');
  });

  it('rapid opens in one pane finish with the last document active', async () => {
    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const workbench = createFakeWorkbench({
      documents: ['doc-a', 'doc-b'],
      panes: { main: { tabs: [], activeTab: null } },
      openDelay: (documentId) => (documentId === 'doc-a' ? gateA : undefined),
    });
    const router = createWorkspaceDocumentRouter({
      workbench,
      previews: createPreviews(),
      effects: createEffects(),
    });
    const first = router.dispatch({
      type: 'open-document',
      documentId: 'doc-a',
      disposition: 'foreground',
    });
    const second = router.dispatch({
      type: 'open-document',
      documentId: 'doc-b',
      disposition: 'foreground',
    });
    releaseA();
    await Promise.all([first, second]);
    // The controller queue is the only serializer: B runs after A and wins.
    expect(workbench.calls.openDocument.map((call) => call.documentId)).toEqual(
      ['doc-a', 'doc-b'],
    );
    expect(workbench.activeDocumentIn('main')).toBe('doc-b');
  });

  it('opens links through the workbench and bumps the snapshot', async () => {
    const workbench = createFakeWorkbench({ documents: ['doc-a'] });
    const effects = createEffects();
    const router = createWorkspaceDocumentRouter({
      workbench,
      previews: createPreviews(),
      effects,
    });
    await router.dispatch({ type: 'open-link', destination: 'doc-a' });
    expect(workbench.calls.openLink).toHaveLength(1);
    expect(effects.bumps).toBe(1);
  });

  it('routes an existing raw-file link to its preview instead of creating a note', async () => {
    const workbench = createFakeWorkbench();
    const previews = createPreviews();
    previews.resolveRawFileLink = async () => ({ path: 'assets/photo.png' });
    const router = createWorkspaceDocumentRouter({
      workbench,
      previews,
      effects: createEffects(),
    });
    await router.dispatch({ type: 'open-link', destination: 'photo.png' });
    expect(workbench.calls.openLink).toEqual([]);
    expect(workbench.calls.openView).toEqual([
      { viewId: 'preview:assets/photo.png', pane: 'main' },
    ]);
  });

  it('does not create a note for an ambiguous raw-file link', async () => {
    const workbench = createFakeWorkbench();
    const previews = createPreviews();
    previews.resolveRawFileLink = async () => ({ ambiguous: true });
    const effects = createEffects();
    const router = createWorkspaceDocumentRouter({ workbench, previews, effects });
    await router.dispatch({ type: 'open-link', destination: 'photo.png' });
    expect(workbench.calls.openLink).toEqual([]);
    expect(workbench.calls.openView).toEqual([]);
    expect(effects.notifies).toHaveLength(1);
  });

  it('opens previews foreground into the focused pane', async () => {
    const workbench = createFakeWorkbench();
    const previews = createPreviews();
    const router = createWorkspaceDocumentRouter({
      workbench,
      previews,
      effects: createEffects(),
    });
    await router.dispatch({
      type: 'open-preview',
      path: 'a.png',
      disposition: 'foreground',
    });
    expect(previews.calls).toEqual(['a.png']);
    expect(workbench.calls.openView).toEqual([
      { viewId: 'preview:a.png', pane: 'main' },
    ]);
  });

  it('moves a background preview without stealing the pane focus', async () => {
    const workbench = createFakeWorkbench({
      panes: {
        main: {
          tabs: [
            {
              id: 'doc-a',
              kind: 'document',
              documentId: 'doc-a',
              viewId: null,
            },
            {
              id: 'view:preview:old.png:1',
              kind: 'view',
              documentId: null,
              viewId: 'preview:old.png',
            },
          ],
          activeTab: 'doc-a',
        },
      },
    });
    const router = createWorkspaceDocumentRouter({
      workbench,
      previews: createPreviews(),
      effects: createEffects(),
    });
    await router.dispatch({
      type: 'preview-moved',
      from: 'old.png',
      to: 'new.png',
    });
    expect(workbench.activeViewIn('main')).toBeNull();
    expect(workbench.activeDocumentIn('main')).toBe('doc-a');
    const views = workbench
      .paneStates()
      .flatMap((pane) => pane.tabs)
      .filter((tab) => tab.kind === 'view')
      .map((tab) => tab.viewId);
    expect(views).toContain('preview:new.png');
    expect(views).not.toContain('preview:old.png');
  });

  it('keeps a moved active preview active at the new path', async () => {
    const workbench = createFakeWorkbench({
      panes: {
        main: {
          tabs: [
            {
              id: 'view:preview:old.png:1',
              kind: 'view',
              documentId: null,
              viewId: 'preview:old.png',
            },
          ],
          activeTab: 'view:preview:old.png:1',
        },
      },
    });
    const router = createWorkspaceDocumentRouter({
      workbench,
      previews: createPreviews(),
      effects: createEffects(),
    });
    await router.dispatch({
      type: 'preview-moved',
      from: 'old.png',
      to: 'new.png',
    });
    expect(workbench.activeViewIn('main')).toBe('preview:new.png');
  });

  it('deleting a raw preview closes every matching tab', async () => {
    const workbench = createFakeWorkbench({
      panes: {
        main: {
          tabs: [
            {
              id: 'view:preview:doomed.png:1',
              kind: 'view',
              documentId: null,
              viewId: 'preview:doomed.png',
            },
          ],
          activeTab: 'view:preview:doomed.png:1',
        },
        second: {
          tabs: [
            {
              id: 'view:preview:doomed.png:2',
              kind: 'view',
              documentId: null,
              viewId: 'preview:doomed.png',
            },
          ],
          activeTab: 'view:preview:doomed.png:2',
        },
      },
    });
    const router = createWorkspaceDocumentRouter({
      workbench,
      previews: createPreviews(),
      effects: createEffects(),
    });
    await router.dispatch({ type: 'preview-deleted', path: 'doomed.png' });
    const remaining = workbench
      .paneStates()
      .flatMap((pane) => pane.tabs)
      .filter((tab) => tab.viewId === 'preview:doomed.png');
    expect(remaining).toEqual([]);
  });

  it('prunes dangling document tabs after external deletes', async () => {
    const workbench = createFakeWorkbench({
      documents: ['doc-a'],
      panes: {
        main: {
          tabs: [
            {
              id: 'doc-a',
              kind: 'document',
              documentId: 'doc-a',
              viewId: null,
            },
          ],
          activeTab: 'doc-a',
        },
      },
    });
    // Simulate an external delete that bypasses the controller: the tab
    // dangles until the router reconciles.
    const effects = createEffects();
    const router = createWorkspaceDocumentRouter({
      workbench,
      previews: createPreviews(),
      effects,
    });
    await router.dispatch({ type: 'documents-deleted' });
    expect(workbench.calls.prunes).toBe(1);
    expect(effects.bumps).toBe(1);
  });

  it('background document into existing idle pane preserves original focus', async () => {
    const workbench = createFakeWorkbench({
      documents: ['doc-a', 'doc-b'],
      panes: {
        main: {
          tabs: [
            {
              id: 'doc-a',
              kind: 'document',
              documentId: 'doc-a',
              viewId: null,
            },
          ],
          activeTab: 'doc-a',
        },
        second: { tabs: [], activeTab: null },
      },
      focused: 'main',
    });
    const router = createWorkspaceDocumentRouter({
      workbench,
      previews: createPreviews(),
      effects: createEffects(),
    });
    await router.dispatch({
      type: 'open-document',
      documentId: 'doc-b',
      disposition: 'background',
    });
    expect(workbench.calls.openDocument).toEqual([
      { pane: 'second', documentId: 'doc-b' },
    ]);
    expect(workbench.focusedPane).toBe('main');
    expect(workbench.activeDocumentIn('second')).toBe('doc-b');
  });

  it('background document into newly created desktop split preserves original focus', async () => {
    const workbench = createFakeWorkbench({
      documents: ['doc-a', 'doc-b'],
      panes: {
        main: {
          tabs: [
            {
              id: 'doc-a',
              kind: 'document',
              documentId: 'doc-a',
              viewId: null,
            },
          ],
          activeTab: 'doc-a',
        },
      },
      focused: 'main',
    });
    const router = createWorkspaceDocumentRouter({
      workbench,
      previews: createPreviews(),
      effects: createEffects(),
    });
    await router.dispatch({
      type: 'open-document',
      documentId: 'doc-b',
      disposition: 'background',
    });
    expect(workbench.calls.splits).toHaveLength(1);
    expect(workbench.calls.openDocument).toHaveLength(1);
    const target = workbench.calls.openDocument[0]?.pane ?? '';
    expect(target).not.toBe('main');
    expect(workbench.focusedPane).toBe('main');
    expect(workbench.activeDocumentIn(target)).toBe('doc-b');
  });

  it('background preview preserves original focus', async () => {
    const workbench = createFakeWorkbench({
      panes: {
        main: {
          tabs: [
            {
              id: 'doc-a',
              kind: 'document',
              documentId: 'doc-a',
              viewId: null,
            },
          ],
          activeTab: 'doc-a',
        },
        second: { tabs: [], activeTab: null },
      },
      focused: 'main',
    });
    const router = createWorkspaceDocumentRouter({
      workbench,
      previews: createPreviews(),
      effects: createEffects(),
    });
    await router.dispatch({
      type: 'open-preview',
      path: 'a.png',
      disposition: 'background',
    });
    expect(workbench.calls.openView[0]?.pane).toBe('second');
    expect(workbench.focusedPane).toBe('main');
  });

  it('background generic view preserves original focus', async () => {
    const workbench = createFakeWorkbench({
      panes: {
        main: {
          tabs: [
            {
              id: 'doc-a',
              kind: 'document',
              documentId: 'doc-a',
              viewId: null,
            },
          ],
          activeTab: 'doc-a',
        },
        second: { tabs: [], activeTab: null },
      },
      focused: 'main',
    });
    const router = createWorkspaceDocumentRouter({
      workbench,
      previews: createPreviews(),
      effects: createEffects(),
    });
    await router.dispatch({
      type: 'open-view',
      viewId: 'graph',
      disposition: 'background',
    });
    expect(workbench.calls.openView[0]?.pane).toBe('second');
    expect(workbench.focusedPane).toBe('main');
  });

  it('preview move in a background pane preserves global focus', async () => {
    const workbench = createFakeWorkbench({
      panes: {
        main: {
          tabs: [
            {
              id: 'doc-a',
              kind: 'document',
              documentId: 'doc-a',
              viewId: null,
            },
          ],
          activeTab: 'doc-a',
        },
        second: {
          tabs: [
            {
              id: 'view:preview:old.png:1',
              kind: 'view',
              documentId: null,
              viewId: 'preview:old.png',
            },
          ],
          activeTab: 'view:preview:old.png:1',
        },
      },
      focused: 'main',
    });
    const router = createWorkspaceDocumentRouter({
      workbench,
      previews: createPreviews(),
      effects: createEffects(),
    });
    await router.dispatch({
      type: 'preview-moved',
      from: 'old.png',
      to: 'new.png',
    });
    expect(workbench.focusedPane).toBe('main');
    const views = workbench
      .paneStates()
      .flatMap((pane) => pane.tabs)
      .filter((tab) => tab.kind === 'view')
      .map((tab) => tab.viewId);
    expect(views).toContain('preview:new.png');
  });

  it('foreground opens still focus their target normally', async () => {
    const workbench = createFakeWorkbench({
      documents: ['doc-a', 'doc-b'],
      panes: {
        main: {
          tabs: [
            {
              id: 'doc-a',
              kind: 'document',
              documentId: 'doc-a',
              viewId: null,
            },
          ],
          activeTab: 'doc-a',
        },
        second: { tabs: [], activeTab: null },
      },
      focused: 'main',
    });
    const router = createWorkspaceDocumentRouter({
      workbench,
      previews: createPreviews(),
      effects: createEffects(),
    });
    await router.dispatch({
      type: 'open-document',
      documentId: 'doc-b',
      disposition: 'foreground',
      pane: 'second',
    });
    expect(workbench.focusedPane).toBe('second');
    await router.dispatch({
      type: 'open-view',
      viewId: 'graph',
      disposition: 'foreground',
      pane: 'second',
    });
    expect(workbench.focusedPane).toBe('second');
  });

  it('mobile background reuses focused pane and keeps focus', async () => {
    const workbench = createFakeWorkbench({
      documents: ['doc-a', 'doc-b'],
      panes: {
        main: {
          tabs: [
            {
              id: 'doc-a',
              kind: 'document',
              documentId: 'doc-a',
              viewId: null,
            },
          ],
          activeTab: 'doc-a',
        },
      },
      focused: 'main',
    });
    const effects = createEffects({ compact: true });
    const router = createWorkspaceDocumentRouter({
      workbench,
      previews: createPreviews(),
      effects,
    });
    await router.dispatch({
      type: 'open-document',
      documentId: 'doc-b',
      disposition: 'background',
    });
    expect(workbench.calls.openDocument).toEqual([
      { pane: 'main', documentId: 'doc-b' },
    ]);
    expect(workbench.calls.splits).toEqual([]);
    expect(workbench.focusedPane).toBe('main');
  });

  it('background document into an idle pane never moves global focus', async () => {
    const workbench = createFakeWorkbench({
      documents: ['doc-a', 'doc-b'],
      panes: {
        main: {
          tabs: [
            {
              id: 'doc-a',
              kind: 'document',
              documentId: 'doc-a',
              viewId: null,
            },
          ],
          activeTab: 'doc-a',
        },
        second: { tabs: [], activeTab: null },
      },
      focused: 'main',
    });
    const effects = createEffects();
    const router = createWorkspaceDocumentRouter({
      workbench,
      previews: createPreviews(),
      effects,
    });
    await router.dispatch({
      type: 'open-document',
      documentId: 'doc-b',
      disposition: 'background',
    });
    expect(workbench.calls.openDocument).toEqual([
      { pane: 'second', documentId: 'doc-b' },
    ]);
    expect(workbench.calls.openDocumentPreserve).toEqual([true]);
    // Truly non-focus-changing: not even a transient focus-then-restore.
    expect(workbench.focusLog).toEqual([]);
    expect(workbench.focusedPane).toBe('main');
    expect(workbench.activeDocumentIn('second')).toBe('doc-b');
    // A background open into another pane is not the active presentation.
    expect(effects.published).toEqual([]);
  });

  it('background document requiring a desktop split creates it without moving focus', async () => {
    const workbench = createFakeWorkbench({
      documents: ['doc-a', 'doc-b'],
      panes: {
        main: {
          tabs: [
            {
              id: 'doc-a',
              kind: 'document',
              documentId: 'doc-a',
              viewId: null,
            },
          ],
          activeTab: 'doc-a',
        },
      },
      focused: 'main',
    });
    const effects = createEffects();
    const router = createWorkspaceDocumentRouter({
      workbench,
      previews: createPreviews(),
      effects,
    });
    await router.dispatch({
      type: 'open-document',
      documentId: 'doc-b',
      disposition: 'background',
    });
    expect(workbench.calls.splits).toEqual([
      { pane: 'main', preserveFocus: true },
    ]);
    expect(workbench.calls.openDocumentPreserve).toEqual([true]);
    expect(workbench.focusLog).toEqual([]);
    expect(workbench.focusedPane).toBe('main');
    expect(effects.published).toEqual([]);
  });

  it('background preview never moves global focus nor becomes active', async () => {
    const workbench = createFakeWorkbench({
      panes: {
        main: {
          tabs: [
            {
              id: 'doc-a',
              kind: 'document',
              documentId: 'doc-a',
              viewId: null,
            },
          ],
          activeTab: 'doc-a',
        },
        second: { tabs: [], activeTab: null },
      },
      focused: 'main',
    });
    const effects = createEffects();
    const router = createWorkspaceDocumentRouter({
      workbench,
      previews: createPreviews(),
      effects,
    });
    await router.dispatch({
      type: 'open-preview',
      path: 'a.png',
      disposition: 'background',
    });
    expect(workbench.calls.openView[0]?.pane).toBe('second');
    expect(workbench.calls.openViewPreserve).toEqual([true]);
    expect(workbench.focusLog).toEqual([]);
    expect(workbench.focusedPane).toBe('main');
    expect(effects.published).toEqual([]);
  });

  it('background generic view never moves global focus nor becomes active', async () => {
    const workbench = createFakeWorkbench({
      panes: {
        main: {
          tabs: [
            {
              id: 'doc-a',
              kind: 'document',
              documentId: 'doc-a',
              viewId: null,
            },
          ],
          activeTab: 'doc-a',
        },
        second: { tabs: [], activeTab: null },
      },
      focused: 'main',
    });
    const effects = createEffects();
    const router = createWorkspaceDocumentRouter({
      workbench,
      previews: createPreviews(),
      effects,
    });
    await router.dispatch({
      type: 'open-view',
      viewId: 'graph',
      disposition: 'background',
    });
    expect(workbench.calls.openView[0]?.pane).toBe('second');
    expect(workbench.calls.openViewPreserve).toEqual([true]);
    expect(workbench.focusLog).toEqual([]);
    expect(workbench.focusedPane).toBe('main');
    expect(effects.published).toEqual([]);
  });

  it('preview move in a non-focused pane never moves global focus', async () => {
    const workbench = createFakeWorkbench({
      panes: {
        main: {
          tabs: [
            {
              id: 'doc-a',
              kind: 'document',
              documentId: 'doc-a',
              viewId: null,
            },
          ],
          activeTab: 'doc-a',
        },
        second: {
          tabs: [
            {
              id: 'view:preview:old.png:1',
              kind: 'view',
              documentId: null,
              viewId: 'preview:old.png',
            },
          ],
          activeTab: 'view:preview:old.png:1',
        },
      },
      focused: 'main',
    });
    const router = createWorkspaceDocumentRouter({
      workbench,
      previews: createPreviews(),
      effects: createEffects(),
    });
    await router.dispatch({
      type: 'preview-moved',
      from: 'old.png',
      to: 'new.png',
    });
    expect(workbench.focusLog).toEqual([]);
    expect(workbench.focusedPane).toBe('main');
    expect(workbench.calls.openViewPreserve).toEqual([true]);
  });

  it('foreground document publishes the newly focused presentation', async () => {
    const workbench = createFakeWorkbench({
      documents: ['doc-a', 'doc-b'],
      panes: {
        main: {
          tabs: [
            {
              id: 'doc-a',
              kind: 'document',
              documentId: 'doc-a',
              viewId: null,
            },
          ],
          activeTab: 'doc-a',
        },
        second: { tabs: [], activeTab: null },
      },
      focused: 'main',
    });
    const effects = createEffects();
    const router = createWorkspaceDocumentRouter({
      workbench,
      previews: createPreviews(),
      effects,
    });
    await router.dispatch({
      type: 'open-document',
      documentId: 'doc-b',
      disposition: 'foreground',
      pane: 'second',
    });
    expect(workbench.focusedPane).toBe('second');
    expect(effects.published).toEqual([
      { documentId: 'doc-b', previewPath: null },
    ]);
  });

  it('background into the focused pane publishes the new presentation', async () => {
    const workbench = createFakeWorkbench({
      documents: ['doc-a', 'doc-b'],
      panes: {
        main: {
          tabs: [
            {
              id: 'doc-a',
              kind: 'document',
              documentId: 'doc-a',
              viewId: null,
            },
          ],
          activeTab: 'doc-a',
        },
      },
      focused: 'main',
    });
    const effects = createEffects({ compact: true });
    const router = createWorkspaceDocumentRouter({
      workbench,
      previews: createPreviews(),
      effects,
    });
    await router.dispatch({
      type: 'open-document',
      documentId: 'doc-b',
      disposition: 'background',
    });
    expect(workbench.calls.openDocument).toEqual([
      { pane: 'main', documentId: 'doc-b' },
    ]);
    expect(effects.published).toEqual([
      { documentId: 'doc-b', previewPath: null },
    ]);
  });

  it('user focus change during a pending background document open wins', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const workbench = createFakeWorkbench({
      documents: ['doc-a', 'doc-b'],
      panes: {
        main: {
          tabs: [
            {
              id: 'doc-a',
              kind: 'document',
              documentId: 'doc-a',
              viewId: null,
            },
          ],
          activeTab: 'doc-a',
        },
        second: { tabs: [], activeTab: null },
        third: { tabs: [], activeTab: null },
      },
      focused: 'main',
      openDelay: (documentId) => (documentId === 'doc-b' ? gate : undefined),
    });
    const effects = createEffects();
    const router = createWorkspaceDocumentRouter({
      workbench,
      previews: createPreviews(),
      effects,
    });
    const pending = router.dispatch({
      type: 'open-document',
      documentId: 'doc-b',
      disposition: 'background',
    });
    // The user intentionally moves focus while the background open is pending.
    workbench.focusPane('third');
    release();
    await pending;
    // The stale focus captured before the operation must never be restored.
    expect(workbench.focusedPane).toBe('third');
    expect(workbench.focusLog).not.toContain('main');
    expect(workbench.focusLog).not.toContain('second');
    expect(workbench.activeDocumentIn('second')).toBe('doc-b');
    expect(effects.published).toEqual([]);
  });

  it('user focus change during a pending background view open wins', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const workbench = createFakeWorkbench({
      panes: {
        main: {
          tabs: [
            {
              id: 'doc-a',
              kind: 'document',
              documentId: 'doc-a',
              viewId: null,
            },
          ],
          activeTab: 'doc-a',
        },
        second: { tabs: [], activeTab: null },
        third: { tabs: [], activeTab: null },
      },
      focused: 'main',
      viewDelay: (viewId) => (viewId === 'graph' ? gate : undefined),
    });
    const effects = createEffects();
    const router = createWorkspaceDocumentRouter({
      workbench,
      previews: createPreviews(),
      effects,
    });
    const pending = router.dispatch({
      type: 'open-view',
      viewId: 'graph',
      disposition: 'background',
    });
    // The user intentionally moves focus while the background open is pending.
    workbench.focusPane('third');
    release();
    await pending;
    // The stale focus captured before the operation must never be restored.
    expect(workbench.focusedPane).toBe('third');
    expect(workbench.focusLog).not.toContain('main');
    expect(workbench.focusLog).not.toContain('second');
    expect(effects.published).toEqual([]);
  });

  it('background open of a live-active document reuses its owner without splitting', async () => {
    // live-active doc + no idle leaf. Without the
    // live-owner guard the router would split right, the controller
    // redirect would leave the fresh leaf strictly empty, and the
    // reveal would misdirect to that empty split. With the guard the
    // owner wins before any split: no empty leaf persists, focus stays
    // at the owner, and the address reveals via the owner.
    const workbench = createFakeWorkbench({
      documents: ['doc-a', 'doc-b'],
      panes: {
        main: {
          tabs: [
            {
              id: 'doc-a',
              kind: 'document',
              documentId: 'doc-a',
              viewId: null,
            },
          ],
          activeTab: 'doc-a',
        },
      },
      focused: 'main',
    });
    const effects = createEffects();
    const router = createWorkspaceDocumentRouter({
      workbench,
      previews: createPreviews(),
      effects,
    });
    expect(workbench.liveOwnerOf('doc-a')).toBe('main');
    await router.dispatch({
      type: 'open-document',
      documentId: 'doc-a',
      address: 'heading-slug',
      disposition: 'background',
    });
    // No fresh leaf materialized for a duplicate.
    expect(workbench.calls.splits).toEqual([]);
    expect(workbench.calls.openDocument).toEqual([
      { pane: 'main', documentId: 'doc-a' },
    ]);
    // No empty leaf persists: pane count stays stable.
    expect(workbench.leafIds()).toEqual(['main']);
    const states = workbench.paneStates();
    expect(states).toHaveLength(1);
    expect(states[0]?.activeTab).toBe('doc-a');
    // Background semantic: focus never moves (owner is already focused).
    expect(workbench.focusLog).toEqual([]);
    expect(workbench.focusedPane).toBe('main');
    // Reveal goes where the document actually lives, never a split.
    expect(workbench.calls.reveals).toEqual([
      { pane: 'main', address: 'heading-slug' },
    ]);
    expect(workbench.calls.discards).toEqual([]);
  });

  it('background open of a live document owned elsewhere reuses the owner pane', async () => {
    // Owner is a background pane: the router still returns the owner
    // before any idle/split policy, so no duplicate leaf appears and
    // global focus stays where the user left it.
    const workbench = createFakeWorkbench({
      documents: ['doc-a', 'doc-b'],
      panes: {
        main: {
          tabs: [
            {
              id: 'doc-a',
              kind: 'document',
              documentId: 'doc-a',
              viewId: null,
            },
          ],
          activeTab: 'doc-a',
        },
        second: {
          tabs: [
            {
              id: 'doc-b',
              kind: 'document',
              documentId: 'doc-b',
              viewId: null,
            },
          ],
          activeTab: 'doc-b',
        },
      },
      focused: 'main',
    });
    const router = createWorkspaceDocumentRouter({
      workbench,
      previews: createPreviews(),
      effects: createEffects(),
    });
    expect(workbench.liveOwnerOf('doc-b')).toBe('second');
    await router.dispatch({
      type: 'open-document',
      documentId: 'doc-b',
      address: 'other-heading',
      disposition: 'background',
    });
    expect(workbench.calls.splits).toEqual([]);
    expect(workbench.calls.openDocument).toEqual([
      { pane: 'second', documentId: 'doc-b' },
    ]);
    expect(workbench.leafIds()).toEqual(['main', 'second']);
    expect(workbench.focusLog).toEqual([]);
    expect(workbench.focusedPane).toBe('main');
    expect(workbench.calls.reveals).toEqual([
      { pane: 'second', address: 'other-heading' },
    ]);
  });
});
