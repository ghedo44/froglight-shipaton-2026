// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { definePlugin } from '@froglight/runtime';
import {
  documentEditorRegistryToken, InMemorySearchService, latexKind, latexKindId,
  markdownKind, markdownKindId, memoryVaultPlugin, workspacePath,
  type DocumentEditorProvider, type DocumentSession,
} from '@froglight/foundation';
import { installDefaultUi, mountFroglightApp } from '@froglight/ui';
import { createApp, createWorkbenchController } from './index.js';

// The public shell mount owns React; application has no direct React dependency.
async function mountedFixture() {
  const counts = { created: 0, live: 0, attempts: 0, notifications: 0 };
  const failures = { editor: false };
  const provider: DocumentEditorProvider = {
    id: 'buffered-test', kindIds: [markdownKindId, latexKindId],
    createEditor({ session, parent }) {
      counts.created++;
      if (failures.editor) throw new Error('persistent editor factory failure');
      counts.live++;
      let pending: string | null = null;
      const input = document.createElement('textarea');
      input.setAttribute('aria-label', 'Buffered source');
      input.value = (session.model as { raw: string }).raw;
      input.oninput = () => { pending = input.value; };
      (parent as HTMLElement).append(input);
      return {
        focus: () => input.focus(), hasFocus: () => document.activeElement === input,
        execCommand: () => false, setReadOnly: value => { input.readOnly = value; },
        flush() {
          if (pending !== null) {
            (session.model as { raw: string }).raw = pending;
            session.markDirty();
            pending = null;
          }
        },
        destroy() { pending = null; input.remove(); counts.live--; },
      };
    },
  };
  const app = await createApp({ vaultPlugin: memoryVaultPlugin,
    searchService: new InMemorySearchService(), documentKinds: [markdownKind, latexKind] });
  const plugin = definePlugin({ id: 'test-editor', requirements: { requires: [documentEditorRegistryToken] },
    activate(ctx) { ctx.effect(() => ctx.require(documentEditorRegistryToken).register(provider).dispose); } });
  const register = () => app.runtime.registerSlot({ id: 'test-editor', plugin });
  await register();
  const c = createWorkbenchController(app);
  const reattach = c.reattachPane.bind(c);
  c.reattachPane = (...args) => {
    counts.attempts++;
    // Test-only circuit breaker: turn an infinite shell loop into a bounded
    // assertion failure, never an uncontrolled hang. Does not fake a mount.
    if (counts.attempts > 16) return Promise.reject(new Error('attachment loop budget exceeded'));
    return reattach(...args);
  };
  const observer = c.onDidChange(() => { counts.notifications++; });
  const ui = await installDefaultUi(app.runtime);
  const root = document.createElement('div'); document.body.append(root);
  const choice = { id: 'test', name: 'Test vault', location: 'Memory', activate: async () => undefined };
  const mount = await mountFroglightApp(root, c, {
    listRecent: async () => [choice], chooseCreateLocation: async () => null,
    openForBackup: async () => { throw new Error('Backup is outside this fixture'); },
    openVault: async () => choice, forgetVault: async () => undefined,
  }, ui);
  const settle = async () => {
    // Bounded React scheduler turns, no polling for a possibly impossible state.
    for (let i = 0; i < 8; i++) await new Promise<void>(resolve => setTimeout(resolve, 0));
  };
  await expect.poll(() => root.querySelector('[class*="recent-vault-card"]')).not.toBeNull();
  (root.querySelector('[class*="recent-vault-card"]') as HTMLElement).click();
  await expect.poll(() => c.listDocuments().length).toBeGreaterThan(0);
  await settle();
  await c.createAndOpen('paper.tex', undefined, { kindId: latexKindId });
  await settle();
  const tab = c.paneStates()[0]!.activeTab!;
  const workspace = app.getWorkspace()!;
  const ref = workspace.listDocuments().find(ref => String(ref.documentId) === tab)!;
  const session = workspace.getOpenDocument(ref.documentId) as DocumentSession<{ raw: string }>;
  const vault = app.getVault()!;
  const write = vault.write.bind(vault);
  return { app, c, counts, failures, register, settle, root, tab, session, vault, write,
    type(text: string) {
      const input = root.querySelector<HTMLTextAreaElement>('[aria-label="Buffered source"]')!;
      input.value = text; input.dispatchEvent(new Event('input', { bubbles: true }));
    },
    async dispose() {
      vault.write = write; failures.editor = false;
      observer.dispose();
      try { await mount.dispose(); } finally { await app.dispose(); root.remove(); }
    },
  };
}

it('flushes buffered input before provider teardown in retryable save error', async () => {
  const f = await mountedFixture();
  try {
    f.type('first dirty source');
    f.vault.write = async (path, bytes) => {
      if (String(path) === 'paper.tex') throw new Error('transient storage failure');
      return f.write(path, bytes);
    };
    await expect(f.c.closeTab('main', f.tab)).rejects.toThrow('transient storage failure');
    expect(f.session.state).toBe('error');
    f.type('latest buffered source\n\\alpha');
    expect(f.session.model.raw).toBe('first dirty source');
    // Re-registration is not another save: it destroys the old buffered handle.
    await f.app.runtime.removeSlot('test-editor');
    await f.register();
    await f.settle();
    expect(f.session.model.raw).toBe('latest buffered source\n\\alpha');
    expect(f.session.dirty).toBe(true);
    f.vault.write = f.write;
    await f.c.closeTab('main', f.tab);
    expect(new TextDecoder().decode(await f.vault.read(workspacePath('paper.tex'))))
      .toBe('latest buffered source\n\\alpha');
    await f.c.openDocument(f.tab, undefined);
    await f.settle();
    expect(f.root.querySelector<HTMLTextAreaElement>('[aria-label="Buffered source"]')?.value)
      .toBe('latest buffered source\n\\alpha');
  } finally { await f.dispose(); }
  expect(f.counts.live).toBe(0);
});

it('autosaves a mounted pane after content edits and reopens the committed source', async () => {
  const f = await mountedFixture();
  try {
    f.session.model.raw = 'first';
    f.session.markDirty();
    f.session.model.raw = 'latest';
    f.session.markDirty();
    await expect.poll(async () =>
      new TextDecoder().decode(await f.vault.read(workspacePath('paper.tex'))),
    ).toBe('latest');
    expect(f.session.dirty).toBe(false);
    await f.c.closeTab('main', f.tab);
    await f.c.openDocument(f.tab, undefined);
    expect(f.app.getWorkspace()!.getOpenDocument(f.session.document.documentId)?.model)
      .toMatchObject({ raw: 'latest' });
  } finally { await f.dispose(); }
});

it('keeps a failed autosave available for an explicit retry', async () => {
  const f = await mountedFixture();
  try {
    f.vault.write = async (path, bytes) => {
      if (String(path) === 'paper.tex') throw new Error('transient storage failure');
      return f.write(path, bytes);
    };
    f.session.model.raw = 'recoverable edit';
    f.session.markDirty();
    await expect.poll(() => f.session.state).toBe('error');
    expect(f.session.dirty).toBe(true);
    f.vault.write = f.write;
    expect((await f.c.saveActive())?.committed).toBe(true);
    expect(new TextDecoder().decode(await f.vault.read(workspacePath('paper.tex'))))
      .toBe('recoverable edit');
  } finally { await f.dispose(); }
});

it('switches during a gated save and reactivates the same in-flight session', async () => {
  const f = await mountedFixture();
  let releaseWrite!: () => void;
  let signalWriteStarted!: () => void;
  const blockedWrite = new Promise<void>(resolve => { releaseWrite = resolve; });
  const writeStarted = new Promise<void>(resolve => { signalWriteStarted = resolve; });
  try {
    f.session.model.raw = 'first snapshot';
    f.session.markDirty();
    f.vault.write = async (path, bytes) => {
      if (String(path) === 'paper.tex') {
        signalWriteStarted();
        await blockedWrite;
      }
      return f.write(path, bytes);
    };

    const saving = f.c.saveActive();
    await writeStarted;
    const opening = f.c.createAndOpen('next.md');
    const switched = await Promise.race([
      opening.then(() => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 1000)),
    ]);
    expect(switched).toBe(true);
    await opening;

    f.session.model.raw = 'newer edit while snapshot is pending';
    f.session.markDirty();
    const side = await f.c.splitPane('main', 'right');
    await f.c.openDocument(f.tab, undefined, { pane: side });
    expect(f.app.getWorkspace()!.getOpenDocument(f.session.document.documentId)).toBe(f.session);
    expect(f.c.paneStates().find(pane => pane.pane === side)!.dirty).toBe(true);

    releaseWrite();
    expect((await saving)?.committed).toBe(true);
    await expect.poll(async () =>
      new TextDecoder().decode(await f.vault.read(workspacePath('paper.tex'))),
    ).toBe('newer edit while snapshot is pending');
    expect(f.session.dirty).toBe(false);
  } finally {
    releaseWrite();
    f.vault.write = f.write;
    await f.dispose();
  }
});

it('does not hold the pane queue while autosave is writing', async () => {
  const f = await mountedFixture();
  let releaseWrite!: () => void;
  let signalWriteStarted!: () => void;
  const blockedWrite = new Promise<void>(resolve => { releaseWrite = resolve; });
  const writeStarted = new Promise<void>(resolve => { signalWriteStarted = resolve; });
  try {
    f.session.model.raw = 'autosaved source';
    f.session.markDirty();
    f.vault.write = async (path, bytes) => {
      if (String(path) === 'paper.tex') {
        signalWriteStarted();
        await blockedWrite;
      }
      return f.write(path, bytes);
    };
    await writeStarted;
    await f.c.createAndOpen('next.md');
    expect(f.c.paneStates()[0]!.activeTab).not.toBe(f.tab);
    releaseWrite();
    await expect.poll(async () =>
      new TextDecoder().decode(await f.vault.read(workspacePath('paper.tex'))),
    ).toBe('autosaved source');
  } finally {
    releaseWrite();
    f.vault.write = f.write;
    await f.dispose();
  }
});

it('drains a clean inactive post-commit save before closing the vault', async () => {
  const f = await mountedFixture();
  let releaseCommit!: () => void;
  let signalCommitStarted!: () => void;
  const blockedCommit = new Promise<void>(resolve => { releaseCommit = resolve; });
  const commitStarted = new Promise<void>(resolve => { signalCommitStarted = resolve; });
  const postCommit = f.session.onPostCommit(async () => {
    signalCommitStarted();
    await blockedCommit;
  });
  try {
    f.session.model.raw = 'committed bytes with pending hooks';
    f.session.markDirty();
    const saving = f.c.saveActive();
    await commitStarted;
    expect(f.session.dirty).toBe(false);
    await f.c.createAndOpen('next.md');

    let finished = false;
    const closing = f.c.closeVaultView().then(() => { finished = true; });
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(finished).toBe(false);
    expect(f.session.state).toBe('saving');

    releaseCommit();
    expect((await saving)?.committed).toBe(true);
    await closing;
    expect(finished).toBe(true);
    expect(f.session.state).toBe('closed');
    expect(f.app.getWorkspace()).toBeNull();
  } finally {
    releaseCommit();
    postCommit.dispose();
    await f.dispose();
  }
});

it('drains an admitted save before moving the document to trash', async () => {
  const f = await mountedFixture();
  let releaseWrite!: () => void;
  let signalWriteStarted!: () => void;
  const blockedWrite = new Promise<void>(resolve => { releaseWrite = resolve; });
  const writeStarted = new Promise<void>(resolve => { signalWriteStarted = resolve; });
  try {
    f.session.model.raw = 'content to preserve in trash';
    f.session.markDirty();
    f.vault.write = async (path, bytes) => {
      if (String(path) === 'paper.tex') {
        signalWriteStarted();
        await blockedWrite;
      }
      return f.write(path, bytes);
    };
    const saving = f.c.saveActive();
    await writeStarted;
    const deleting = f.c.deleteDocument(f.tab);
    const completedEarly = await Promise.race([
      deleting.then(() => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(false), 1000)),
    ]);
    expect(completedEarly).toBe(false);
    releaseWrite();
    expect((await saving)?.committed).toBe(true);
    await deleting;
    const workspace = f.app.getWorkspace()!;
    expect(workspace.getOpenDocument(f.session.document.documentId)).toBeNull();
    expect(workspace.listDocuments().some(ref => String(ref.documentId) === f.tab)).toBe(false);
    expect(workspace.listTrashedDocuments().some(entry => String(entry.documentId) === f.tab)).toBe(true);
  } finally {
    releaseWrite();
    f.vault.write = f.write;
    await f.dispose();
  }
});

it('keeps a failed inactive save tab reachable when closing it also fails', async () => {
  const f = await mountedFixture();
  let releaseWrite!: () => void;
  let signalWriteStarted!: () => void;
  const blockedWrite = new Promise<void>(resolve => { releaseWrite = resolve; });
  const writeStarted = new Promise<void>(resolve => { signalWriteStarted = resolve; });
  try {
    f.session.model.raw = 'dirty recovery source';
    f.session.markDirty();
    f.vault.write = async (path, bytes) => {
      if (String(path) === 'paper.tex') {
        signalWriteStarted();
        await blockedWrite;
        throw new Error('storage is unavailable');
      }
      return f.write(path, bytes);
    };
    const saving = f.c.saveActive();
    await writeStarted;
    const opening = f.c.createAndOpen('next.md');
    await opening;
    releaseWrite();
    expect((await saving)?.committed).toBe(false);
    await expect.poll(() =>
      f.c.paneStates()[0]!.tabs.find(tab => tab.id === f.tab)?.saveError,
    ).toBe(true);

    await expect(f.c.closeTab('main', f.tab)).rejects.toThrow('storage is unavailable');
    expect(f.c.paneStates()[0]!.tabs.some(tab => tab.id === f.tab)).toBe(true);
    expect(f.app.getWorkspace()!.getOpenDocument(f.session.document.documentId)).toBe(f.session);
    expect(f.session.dirty).toBe(true);
  } finally {
    releaseWrite();
    f.vault.write = f.write;
    await f.dispose();
  }
});

it('mounted missing/throwing editor attempts settle and restoration mounts the same session', async () => {
  const f = await mountedFixture();
  try {
    f.session.model.raw = 'unsaved retained source'; f.session.markDirty();
    const beforeWithdrawal = f.counts.attempts;
    await f.app.runtime.removeSlot('test-editor');
    await f.settle();
    const missing = { ...f.counts };
    expect(missing.attempts - beforeWithdrawal).toBeLessThanOrEqual(1);
    await f.settle();
    expect(f.counts.attempts).toBeLessThan(16);
    expect(f.counts.attempts).toBe(missing.attempts);
    expect(f.counts.notifications).toBe(missing.notifications);
    expect(f.counts.live).toBe(0);
    f.c.setTabMode('main', f.tab, 'split');
    await f.settle();
    await f.register();
    f.failures.editor = true;
    // Acquisition succeeded; the existing provider now fails on remount.
    // Failed acquisition itself is rolled back, never left installed.
    await expect(f.c.reattachPane('main', document.createElement('div')))
      .rejects.toThrow('persistent editor factory failure');
    await f.settle();
    const failed = { ...f.counts };
    expect(failed.attempts - missing.attempts).toBeLessThanOrEqual(3);
    await f.settle();
    expect(f.counts.attempts).toBeLessThan(16);
    expect(f.counts.attempts).toBe(failed.attempts);
    expect(f.counts.notifications).toBe(failed.notifications);
    f.failures.editor = false;
    await f.app.runtime.removeSlot('test-editor');
    await f.register();
    await f.settle();
    expect(f.counts.live).toBe(1);
    expect(f.app.getWorkspace()!.getOpenDocument(f.session.document.documentId)).toBe(f.session);
    expect(f.session.model.raw).toBe('unsaved retained source');
    expect(f.session.dirty).toBe(true);
    expect(f.c.tabMode('main')).toBe('split');
    expect(f.root.querySelector<HTMLTextAreaElement>('[aria-label="Buffered source"]')?.value)
      .toBe('unsaved retained source');
  } finally { await f.dispose(); }
  expect(f.counts.live).toBe(0);
});

it.each([1, 2, 3, 4, 5])('preserves input buffered during save round %i before permitting close', async (bufferRound) => {
  const f = await mountedFixture();
  let writes = 0;
  try {
    f.type('initial source');
    f.vault.write = async (path, bytes) => {
      if (String(path) === 'paper.tex') {
        writes++;
        if (writes < bufferRound) {
          f.session.model.raw = `dirty during round ${writes}`;
          f.session.markDirty();
        } else if (writes === bufferRound) {
          f.type('buffered at completion\n\\omega');
        }
      }
      return f.write(path, bytes);
    };
    if (bufferRound === 5) {
      await expect(f.c.closeTab('main', f.tab)).rejects.toThrow('failed to reach a stable save');
      expect(writes).toBe(5);
      expect(f.app.getWorkspace()!.getOpenDocument(f.session.document.documentId)).toBe(f.session);
      expect(f.session.model.raw).toBe('buffered at completion\n\\omega');
      expect(f.session.dirty).toBe(true);
      expect(f.counts.live).toBe(1);
      expect(f.c.paneStates()[0]!.activeTab).toBe(f.tab);
      f.vault.write = f.write;
      await f.c.closeTab('main', f.tab);
    } else {
      await f.c.closeTab('main', f.tab);
      expect(writes).toBe(bufferRound + 1);
    }
    expect(new TextDecoder().decode(await f.vault.read(workspacePath('paper.tex'))))
      .toBe('buffered at completion\n\\omega');
  } finally { await f.dispose(); }
  expect(f.counts.live).toBe(0);
});

it('a user same-document open retries a recovered factory without availability changes', async () => {
  const f = await mountedFixture();
  const read = f.vault.read.bind(f.vault);
  let reads = 0;
  try {
    f.session.model.raw = 'dirty retained on explicit retry'; f.session.markDirty();
    f.failures.editor = true;
    // Keep the successfully acquired provider installed, then fail a remount.
    // The later explorer retry must not depend on an orphaned registration.
    await expect(f.c.reattachPane('main', document.createElement('div')))
      .rejects.toThrow('persistent editor factory failure');
    await f.settle();
    const stable = { ...f.counts };
    await f.settle();
    expect(f.counts).toEqual(stable);
    expect(f.counts.live).toBe(0);
    const generation = f.c.attachmentGeneration('main');
    const host = f.root.querySelector('.fl-pane-editor');
    f.vault.read = async path => {
      if (String(path) === 'paper.tex') reads++;
      return read(path);
    };
    // The factory alone recovers: no registration, host, or mode change.
    f.failures.editor = false;
    const row = f.root.querySelector<HTMLElement>('[data-kind="file"][data-path="paper.tex"]');
    expect(row).not.toBeNull();
    row!.click(); // explorer -> workspace router -> hook requestOpen mailbox
    await f.settle();
    expect(f.counts.live).toBe(1);
    expect(f.counts.created).toBe(stable.created + 1);
    expect(reads).toBe(0);
    expect(f.c.attachmentGeneration('main')).toBe(generation);
    expect(f.root.querySelector('.fl-pane-editor')).toBe(host);
    expect(f.app.getWorkspace()!.getOpenDocument(f.session.document.documentId)).toBe(f.session);
    expect(f.session.dirty).toBe(true);
    expect(f.root.querySelector<HTMLTextAreaElement>('[aria-label="Buffered source"]')?.value)
      .toBe('dirty retained on explicit retry');
    const restored = { ...f.counts };
    await f.settle();
    expect(f.counts).toEqual(restored);
  } finally { f.vault.read = read; await f.dispose(); }
  expect(f.counts.live).toBe(0);
});

it('live-owner probe and redirected-split discard are provider-neutral and preserve the authoritative session', async () => {
  const f = await mountedFixture();
  try {
    // The mounted controller exposes the synchronous guards used by
    // splitWithTab and the router background-split resolve. They are
    // provider-neutral (no editor internals) and never duplicate the session.
    expect(f.c.liveOwnerOf(f.tab)).toBe('main');
    const panesBefore = f.c.paneStates().length;
    const live = f.c.liveOwnerOf(f.tab);
    expect(live).toBe('main');
    if (live !== null) {
      await f.c.openDocument(f.tab, undefined, { pane: live });
    }
    expect(f.c.focusedPane).toBe('main');
    expect(f.app.getWorkspace()!.getOpenDocument(f.session.document.documentId)).toBe(f.session);
    expect(f.c.paneStates().length).toBe(panesBefore);
    // A strictly-empty fresh split for the live document is discarded;
    // a split that gained content is kept.
    const created = f.c.splitPane('main', 'right');
    await f.c.openDocument(f.tab, undefined, { pane: created });
    f.c.discardRedirectedSplit(created, f.tab);
    expect(f.c.paneStates().length).toBe(panesBefore);
    expect(f.c.leafIds()).not.toContain(created);
    expect(f.app.getWorkspace()!.getOpenDocument(f.session.document.documentId)).toBe(f.session);
  } finally { await f.dispose(); }
  expect(f.counts.live).toBe(0);
});
