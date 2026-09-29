import { describe, expect, it } from 'vitest';
import { definePlugin } from '@froglight/runtime';
import {
  documentEditorRegistryToken,
  documentReaderRegistryToken,
  InMemorySearchService,
  latexKind,
  latexKindId,
  latexModel,
  markdownKind,
  markdownKindId,
  markdownModel,
  memoryVaultPlugin,
  workspacePath,
  type DocumentSession,
  type DocumentEditorProvider,
  type DocumentKindId,
  type DocumentReaderHandle,
  type DocumentReaderProvider,
} from '@froglight/foundation';
import { createApp, createWorkbenchController } from './index.js';

interface EditorSpy {
  setReadOnlyCalls: boolean[];
  flushCalls: number;
  focused: boolean;
  destroyed: boolean;
  revealCalls: string[];
}

function mockEditorProvider(
  kindId: DocumentKindId,
  onCreate?: (spy: EditorSpy) => void,
): DocumentEditorProvider & { spies: EditorSpy[] } {
  const spies: EditorSpy[] = [];
  return {
    id: `test-editor-${String(kindId)}`,
    kindIds: [kindId],
    spies,
    createEditor() {
      const spy: EditorSpy = {
        setReadOnlyCalls: [],
        flushCalls: 0,
        focused: false,
        destroyed: false,
        revealCalls: [],
      };
      spies.push(spy);
      onCreate?.(spy);
      return {
        focus() {
          spy.focused = true;
        },
        hasFocus() {
          return spy.focused;
        },
        execCommand() {
          return false;
        },
        setReadOnly(readOnly: boolean) {
          spy.setReadOnlyCalls.push(readOnly);
        },
        flush() {
          spy.flushCalls += 1;
        },
        revealAddress(address: string) {
          spy.revealCalls.push(address);
        },
        destroy() {
          spy.destroyed = true;
        },
      };
    },
  };
}

interface ReaderSpy {
  updates: number;
  destroyed: boolean;
  revealCalls: string[];
}

function mockReaderProvider(
  kindId: DocumentKindId,
): DocumentReaderProvider & { spies: ReaderSpy[] } {
  const spies: ReaderSpy[] = [];
  return {
    id: `test-reader-${String(kindId)}`,
    kindIds: [kindId],
    spies,
    createReader(): DocumentReaderHandle {
      const spy: ReaderSpy = { updates: 0, destroyed: false, revealCalls: [] };
      spies.push(spy);
      return {
        update() {
          spy.updates += 1;
        },
        revealAddress(address: string) {
          spy.revealCalls.push(address);
        },
        destroy() {
          spy.destroyed = true;
        },
      };
    },
  };
}

async function setup(kind = latexKind) {
  const markdownEditor = mockEditorProvider(markdownKindId);
  const latexEditor = mockEditorProvider(latexKindId);
  const markdownReader = mockReaderProvider(markdownKindId);
  const app = await createApp({
    vaultPlugin: memoryVaultPlugin,
    vaultConfig: {},
    searchService: new InMemorySearchService(),
    documentKinds: [markdownKind, kind],
    documentEditorProviders: [markdownEditor, latexEditor],
    documentReaderProviders: [markdownReader],
  });
  const controller = createWorkbenchController(app);
  await controller.initialize({});
  controller.setReaderHost('main', {});
  return { app, controller, markdownEditor, latexEditor, markdownReader };
}

describe('centralized edit/reading presentation', () => {
  it('exposes registered readers by kind and null otherwise', async () => {
    const { app, controller } = await setup();
    expect(app.getDocumentReader(markdownKindId)?.id).toBe(
      'test-reader-froglight.markdown',
    );
    expect(app.getDocumentReader(latexKindId)).toBeNull();
    expect(controller.getDocumentReader(markdownKindId)?.id).toBe(
      'test-reader-froglight.markdown',
    );
    expect(controller.getPaneKindId('main')).toBe(markdownKindId);
    await app.dispose();
  });

  it('opens in edit mode with an editor and no reader', async () => {
    const { controller, markdownEditor, markdownReader, app } = await setup();
    expect(controller.tabMode('main')).toBe('edit');
    expect(markdownEditor.spies.length).toBe(1);
    expect(markdownReader.spies.length).toBe(0);
    await app.dispose();
  });

  it('entering reading mode flushes, destroys the editor, and mounts a reader', async () => {
    const { controller, markdownEditor, markdownReader, app } = await setup();
    const tabId = controller.paneStates()[0]?.activeTab;
    expect(tabId).not.toBeNull();
    controller.setTabMode('main', tabId!, 'reading');
    const editor = markdownEditor.spies[0]!;
    expect(editor.flushCalls).toBe(1);
    expect(editor.setReadOnlyCalls).toEqual([false]);
    expect(editor.destroyed).toBe(true);
    expect(markdownReader.spies.length).toBe(1);
    expect(markdownReader.spies[0]!.updates).toBeGreaterThanOrEqual(1);
    expect(controller.tabMode('main')).toBe('reading');
    expect(controller.execEditorCommand('undo')).toBe(false);
    await app.dispose();
  });

  it('returning to edit mode destroys the reader and recreates the editor', async () => {
    const { controller, markdownEditor, markdownReader, app } = await setup();
    const tabId = controller.paneStates()[0]?.activeTab;
    controller.setTabMode('main', tabId!, 'reading');
    controller.setTabMode('main', tabId!, 'edit');
    expect(markdownReader.spies[0]!.destroyed).toBe(true);
    expect(markdownEditor.spies[0]!.destroyed).toBe(true);
    expect(markdownEditor.spies[1]!.setReadOnlyCalls).toEqual([false]);
    await app.dispose();
  });

  it('routes revealAddress to the reader while reading', async () => {
    const { controller, markdownEditor, markdownReader, app } = await setup();
    const tabId = controller.paneStates()[0]?.activeTab;
    controller.setTabMode('main', tabId!, 'reading');
    expect(controller.revealAddress('main', 'welcome')).toBe(true);
    expect(markdownReader.spies[0]!.revealCalls).toEqual(['welcome']);
    expect(markdownEditor.spies[0]!.revealCalls).toEqual([]);
    await app.dispose();
  });

  it('gates getPaneText to Markdown so LaTeX never renders as Markdown', async () => {
    const { controller, app, latexEditor } = await setup();
    expect(controller.getPaneText('main')).not.toBeNull();
    const created = await controller.createAndOpen(
      'papers/thesis.tex',
      {},
      {
        kindId: latexKindId,
      },
    );
    expect(created).not.toBeNull();
    controller.setReaderHost('main', {});
    expect(controller.getPaneKindId('main')).toBe(latexKindId);
    expect(controller.getPaneText('main')).toBeNull();
    // LaTeX has no reader registered here: reading falls back to the
    // native read-only editor surface without crashing.
    const tabId = controller.paneStates()[0]?.activeTab;
    controller.setTabMode('main', tabId!, 'reading');
    expect(controller.tabMode('main')).toBe('reading');
    expect(latexEditor.spies[0]!.destroyed).toBe(false);
    expect(latexEditor.spies[0]!.setReadOnlyCalls).toEqual([false, true]);
    await app.dispose();
  });
});


describe('core presentation modes', () => {
  it('uses descriptor overrides without changing providers', async () => {
    const { app, controller } = await setup({ ...latexKind, presentationModes: ['edit', 'reading'] });
    await controller.createAndOpen('binary.tex', {}, { kindId: latexKindId });
    const tab = controller.paneStates()[0]!.activeTab!;
    expect(controller.availableTabModes('main')).toEqual(['edit', 'reading']);
    expect(() => controller.setTabMode('main', tab, 'split')).toThrow(RangeError);
    expect(controller.tabMode('main')).toBe('edit');
    await controller.dispose(); await app.dispose();
  });
  it('declares Markdown and LaTeX split through their kind metadata', async () => {
    const { app, controller } = await setup();
    const tab = controller.paneStates()[0]!.activeTab!;
    expect(controller.availableTabModes('main')).toEqual(['edit', 'split', 'reading']);
    controller.setTabMode('main', tab, 'split');
    expect(controller.tabMode('main')).toBe('split');
    await controller.createAndOpen('paper.tex', {}, { kindId: latexKindId });
    expect(controller.availableTabModes('main')).toEqual(['edit', 'split', 'reading']);
    await app.dispose();
  });
});

// Alternate providers exercise only public session/workspace contracts.
async function setupSplit(failures = { editor: false, reader: false }) {
  const sessions: DocumentSession[] = [];
  const readerSessions: DocumentSession[] = [];
  const counts = { editors: 0, readers: 0, tools: 0, updates: 0, flushes: 0 };
  let pending: string | null = null;
  const editor: DocumentEditorProvider = {
    id: 'alternate-latex', kindIds: [latexKindId],
    createEditor({ session }) {
      if (failures.editor) { failures.editor = false; throw new Error("editor factory failed"); }
      sessions.push(session);
      counts.editors++;
      let dead = false;
      return {
        focus() { /* headless */ }, hasFocus: () => false,
        execCommand: () => true,
        flush() {
          counts.flushes++;
          if (pending !== null) {
            (session.model as { raw: string }).raw = pending;
            pending = null;
            session.markDirty();
          }
        },
        tools: {
          snapshot: () => ({ context: 'source', controls: [] }),
          execute: () => true,
          onDidChange() {
            counts.tools++;
            return { dispose() { counts.tools--; } };
          },
        },
        destroy() { expect(dead).toBe(false); dead = true; counts.editors--; },
      };
    },
  };
  const reader: DocumentReaderProvider = {
    id: 'alternate-reader', kindIds: [latexKindId],
    createReader({ session }) {
      if (failures.reader) { failures.reader = false; throw new Error("reader factory failed"); }
      readerSessions.push(session);
      counts.readers++;
      let dead = false;
      return {
        update() { expect(dead).toBe(false); counts.updates++; },
        destroy() { expect(dead).toBe(false); dead = true; counts.readers--; },
      };
    },
  };
  const app = await createApp({
    vaultPlugin: memoryVaultPlugin, vaultConfig: {},
    searchService: new InMemorySearchService(),
    documentKinds: [markdownKind, latexKind],
    documentEditorProviders: [editor], documentReaderProviders: [reader],
  });
  const controller = createWorkbenchController(app);
  const host = {};
  await controller.initialize(host);
  await controller.createAndOpen('paper.tex', host, { kindId: latexKindId });
  controller.setReaderHost('main', {});
  const tab = controller.paneStates()[0]!.activeTab!;
  const session = sessions[0]!;
  const edit = (raw: string) => { (session.model as { raw: string }).raw = raw; session.markDirty(); };
  return { app, controller, tab, session, sessions, readerSessions, counts, reader, editor, edit,
    pending(raw: string) { pending = raw; } };
}

describe('separate-reader split lifecycle', () => {
  it('keeps one unsaved session, reuses visible handles, and saves/reopens with an alternate editor', async () => {
    const f = await setupSplit();
    const { controller: c, tab, counts, session } = f;
    f.edit('unsaved');
    expect([counts.editors, counts.readers, counts.tools]).toEqual([1, 0, 1]);
    c.setTabMode('main', tab, 'split');
    expect([counts.editors, counts.readers, counts.tools]).toEqual([1, 1, 1]);
    expect(f.sessions).toHaveLength(1);
    expect(f.readerSessions).toEqual([session]);
    expect(c.execEditorCommand('undo')).toBe(true);
    const updates = counts.updates;
    f.edit('dirty again');
    f.edit('dirty third');
    expect(counts.updates).toBe(updates + 2);
    // User saves now enter the pane lane. Observe actual snapshot start,
    // rather than assuming it happened synchronously at the request call.
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const state = session.onStateChange(value => { if (value === 'saving') entered(); });
    const saving = c.saveActive();
    await started;
    f.edit('during save');
    await saving;
    state.dispose();
    expect(counts.updates).toBe(updates + 3);
    expect(session.dirty).toBe(true);
    f.pending('flushed unsaved');
    c.setTabMode('main', tab, 'reading');
    expect([counts.editors, counts.readers, counts.tools]).toEqual([0, 1, 0]);
    expect((session.model as { raw: string }).raw).toBe('flushed unsaved');
    expect(f.readerSessions).toHaveLength(1);
    await c.openDocument(tab, undefined, { address: 'section' });
    expect(session.dirty).toBe(true);
    expect(f.readerSessions).toHaveLength(1);
    c.setTabMode('main', tab, 'split');
    expect(f.sessions).toEqual([session, session]);
    c.setTabMode('main', tab, 'edit');
    expect([counts.editors, counts.readers, counts.tools]).toEqual([1, 0, 1]);
    expect(f.sessions).toHaveLength(2);
    for (let i = 0; i < 12; i++) {
      c.setTabMode('main', tab, 'split');
      c.setTabMode('main', tab, 'reading');
      c.setTabMode('main', tab, 'edit');
    }
    expect([counts.editors, counts.readers, counts.tools]).toEqual([1, 0, 1]);
    expect(new Set(f.sessions)).toEqual(new Set([session]));
    f.pending('saved alternate');
    expect((await c.saveActive())?.committed).toBe(true);
    await c.closeTab('main', tab);
    expect([counts.editors, counts.readers, counts.tools]).toEqual([0, 0, 0]);
    await c.openDocument(tab, {});
    expect((f.sessions.at(-1)!.model as { raw: string }).raw).toBe('saved alternate');
    expect(f.sessions.at(-1)).not.toBe(session);
    await c.dispose(); await f.app.dispose();
  });

  it('reparents and moves split handles without saving/reopening or duplicating subscriptions', async () => {
    const f = await setupSplit();
    const { controller: c, tab, session, counts } = f;
    c.setTabMode('main', tab, 'split');
    f.pending('pending on reparent');
    const host = {}, readerHost = {};
    await c.reattachPane('main', host, readerHost);
    expect((session.model as { raw: string }).raw).toBe('pending on reparent');
    expect(session.dirty).toBe(true);
    expect([counts.editors, counts.readers, counts.tools]).toEqual([1, 1, 1]);
    const created = f.sessions.length;
    await c.reattachPane('main', host, readerHost);
    expect(f.sessions).toHaveLength(created);
    const next = await c.moveTab('main', tab, { kind: 'split', pane: 'main', direction: 'right' },
      { editorParent: {}, readerParent: {} });
    expect(next).not.toBeNull();
    expect(c.tabMode(next!)).toBe('split');
    expect(session.dirty).toBe(true);
    expect(new Set(f.sessions)).toEqual(new Set([session]));
    expect([counts.editors, counts.readers, counts.tools]).toEqual([1, 1, 1]);
    const before = counts.updates;
    f.edit('after move');
    expect(counts.updates).toBe(before + 1);
    await c.closeTab(next!, tab);
    const after = counts.updates;
    await session.open();
    f.edit('detached session');
    expect(counts.updates).toBe(after);
    await session.close();
    await c.dispose(); await f.app.dispose();
  });

  it('retains supported modes and source across editor and reader withdrawal/replacement', async () => {
    const f = await setupSplit();
    const { controller: c, tab, counts, session, app } = f;
    c.setTabMode('main', tab, 'split');
    f.pending('flush on provider removal');
    await app.runtime.removeSlot('editor-provider-0');
    expect([counts.editors, counts.readers, counts.tools]).toEqual([0, 1, 0]);
    expect((session.model as { raw: string }).raw).toBe('flush on provider removal');
    expect(c.tabMode('main')).toBe('split');
    await app.runtime.registerSlot({ id: 'alternate-editor-return', plugin: definePlugin({
      id: 'alternate-editor-return', requirements: { requires: [documentEditorRegistryToken] },
      activate(ctx) { ctx.effect(() => ctx.require(documentEditorRegistryToken).register(f.editor).dispose); },
    }) });
    c.setTabMode('main', tab, 'reading');
    expect([counts.editors, counts.readers]).toEqual([0, 1]);
    await app.runtime.removeSlot('reader-provider-0');
    expect(c.tabMode('main')).toBe('reading');
    expect(c.readingPresentation('main').kind).toBe('editor-readonly');
    expect([counts.editors, counts.readers]).toEqual([1, 0]);
    await app.runtime.registerSlot({ id: 'alternate-reader-return', plugin: definePlugin({
      id: 'alternate-reader-return', requirements: { requires: [documentReaderRegistryToken] },
      activate(ctx) { ctx.effect(() => ctx.require(documentReaderRegistryToken).register(f.reader).dispose); },
    }) });
    expect([counts.editors, counts.readers, counts.tools]).toEqual([0, 1, 0]);
    expect(new Set([...f.sessions, ...f.readerSessions])).toEqual(new Set([session]));
    const before = counts.updates;
    f.edit('current reader only');
    expect(counts.updates).toBe(before + 1);
    await c.dispose();
    expect([counts.editors, counts.readers, counts.tools]).toEqual([0, 0, 0]);
    await app.dispose();
  });
});

describe('hostless transferred-session moves', () => {
  it('defers editor creation until the destination host attaches and never passes null', async () => {
    const f = await setupSplit();
    const { controller: c, tab, session, counts, app } = f;
    c.setTabMode('main', tab, 'split');
    f.pending('unsaved across hostless move');
    // Host-validating editor replacement: any createEditor({parent:null}) fails.
    // Registered so the assertions actually execute; creation reuses the live session.
    await app.runtime.registerSlot({ id: 'strict-editor-find004', plugin: definePlugin({
      id: 'strict-editor-find004', requirements: { requires: [documentEditorRegistryToken] },
      activate(ctx) {
        ctx.effect(() => ctx.require(documentEditorRegistryToken).register({
          ...f.editor,
          id: 'strict-host-validator',
          createEditor(input) {
            expect(input.parent).not.toBeNull();
            expect(input.parent).not.toBeUndefined();
            return f.editor.createEditor(input);
          },
        }).dispose);
      },
    }) });
    // Actual UI gesture: split drag with no hosts travelling (useTabDrag).
    const next = await c.moveTab('main', tab, { kind: 'split', pane: 'main', direction: 'right' });
    expect(next).not.toBeNull();
    expect([counts.editors, counts.readers, counts.tools]).toEqual([0, 0, 0]);
    expect(session.dirty).toBe(true);
    expect(c.tabMode(next!)).toBe('split');
    expect(c.availableTabModes(next!)).toEqual(['edit', 'split', 'reading']);
    expect(new Set(f.sessions)).toEqual(new Set([session]));
    // Notification allows the shell to mount hosts, then attachment creates once.
    const host = {}, readerHost = {};
    await c.reattachPane(next!, host, readerHost);
    expect([counts.editors, counts.readers, counts.tools]).toEqual([1, 1, 1]);
    expect(new Set(f.sessions)).toEqual(new Set([session]));
    const before = counts.updates;
    f.edit('after attach');
    expect(counts.updates).toBe(before + 1);
    await c.reattachPane(next!, host, readerHost);
    expect([counts.editors, counts.readers, counts.tools]).toEqual([1, 1, 1]);
    c.setTabMode(next!, tab, 'reading');
    expect([counts.editors, counts.readers, counts.tools]).toEqual([0, 1, 0]);
    c.setTabMode(next!, tab, 'edit');
    expect([counts.editors, counts.readers, counts.tools]).toEqual([1, 0, 1]);
    expect((session.model as { raw: string }).raw).toBe('after attach');
    await c.dispose();
    expect([counts.editors, counts.readers, counts.tools]).toEqual([0, 0, 0]);
    await app.dispose();
  });
});

describe('reader-only host before editor host', () => {
  it('never recreates a reader in edit mode while the editor host is absent', async () => {
    const f = await setupSplit();
    const { controller: c, tab, session, counts, app } = f;
    c.setTabMode('main', tab, 'split');
    f.pending('unsaved before hostless move');
    const next = await c.moveTab('main', tab, { kind: 'split', pane: 'main', direction: 'right' });
    expect(next).not.toBeNull();
    // Reader-only host attaches first (edit not yet selectable through a host).
    c.setReaderHost(next!, {});
    expect([counts.editors, counts.readers, counts.tools]).toEqual([0, 1, 0]);
    // Selecting edit with no editor host must not recreate the exited reader.
    c.setTabMode(next!, tab, 'edit');
    expect([counts.editors, counts.readers, counts.tools]).toEqual([0, 0, 0]);
    expect(session.dirty).toBe(true);
    expect(new Set(f.sessions)).toEqual(new Set([session]));
    // Reading through the reader-only host still works without an editor host.
    c.setTabMode(next!, tab, 'reading');
    expect([counts.editors, counts.readers, counts.tools]).toEqual([0, 1, 0]);
    c.setTabMode(next!, tab, 'edit');
    expect([counts.editors, counts.readers, counts.tools]).toEqual([0, 0, 0]);
    // Editor host attaches last: created exactly once, edit matrix restored.
    await c.reattachPane(next!, {}, undefined);
    expect([counts.editors, counts.readers, counts.tools]).toEqual([1, 0, 1]);
    expect(new Set(f.sessions)).toEqual(new Set([session]));
    const before = counts.updates;
    f.edit('after late editor host');
    expect(counts.updates).toBe(before);
    await c.dispose();
    expect([counts.editors, counts.readers, counts.tools]).toEqual([0, 0, 0]);
    await app.dispose();
  });
});

describe('transfer failure keeps the unsaved session reachable', () => {
  for (const failure of ['neighbor open', 'destination suspension'] as const) {
    it(`retains the dirty split source after rejected ${failure}`, async () => {
      const f = await setupSplit();
      const { controller: c, tab, session, counts, app } = f;
      const workspace = app.getWorkspace()!;
      const originalOpen = workspace.openDocument.bind(workspace);
      let restoreFailure = () => { workspace.openDocument = originalOpen; };
      if (failure === 'destination suspension') {
        const neighbor = c.paneStates()[0]!.tabs.find(t => t.id !== tab)!;
        await c.openDocument(neighbor.documentId!, {}, { pane: 'destination' });
        const destination = workspace.getOpenDocument(
          workspace.listDocuments().find(d => String(d.documentId) === neighbor.documentId)!.documentId,
        )!;
        const close = destination.close.bind(destination);
        destination.close = async () => { throw new Error('destination suspension rejected'); };
        restoreFailure = () => { destination.close = close; };
      } else {
        workspace.openDocument = async () => { throw new Error('neighbor open rejected'); };
      }
      c.setTabMode('main', tab, 'split');
      f.pending('pending source must survive');
      f.edit('dirty source must survive');
      try {
        await expect(c.moveTab('main', tab, failure === 'neighbor open'
          ? { kind: 'split', pane: 'main', direction: 'right' }
          : { kind: 'pane', pane: 'destination' },
        )).rejects.toThrow(`${failure} rejected`);
        const source = c.paneStates().find(p => p.pane === 'main')!;
        expect(source.activeTab).toBe(tab);
        expect(source.tabs.some(t => t.id === tab)).toBe(true);
        expect(c.tabMode('main', tab)).toBe('split');
        expect(session.state).toBe('open');
        expect(session.dirty).toBe(true);
        expect((session.model as { raw: string }).raw).toBe('pending source must survive');
        expect(workspace.getOpenDocument(session.document.documentId)).toBe(session);
        expect([counts.editors, counts.readers, counts.tools]).toEqual([1, 1, 1]);
        expect(f.sessions.at(-1)).toBe(session);
        expect(f.readerSessions.at(-1)).toBe(session);
        const updates = counts.updates;
        f.edit('still reachable after failure');
        expect(counts.updates).toBe(updates + 1);
        expect((await c.savePane('main'))?.committed).toBe(true);
        expect(session.dirty).toBe(false);
      } finally {
        restoreFailure();
        await c.dispose();
        await app.dispose();
      }
      expect([counts.editors, counts.readers, counts.tools]).toEqual([0, 0, 0]);
    });
  }
});


describe('presentation factory failures', () => {
  for (const requested of ['edit', 'reading'] as const) {
    it(`preserves the prior presentation after failed ${requested} creation and retries`, async () => {
      const failures = { editor: false, reader: false };
      const f = await setupSplit(failures);
      const { controller: c, tab, counts, session, app } = f;
      const previous = requested === 'edit' ? 'reading' : 'edit';
      c.setTabMode('main', tab, previous);
      f.edit('unsaved during failed mode switch');
      failures[requested === 'edit' ? 'editor' : 'reader'] = true;
      let notifications = 0;
      const sub = c.onDidChange(() => notifications++);
      try {
        expect(() => c.setTabMode('main', tab, requested)).toThrow('factory failed');
        expect(c.tabMode('main')).toBe(previous);
        expect([counts.editors, counts.readers, counts.tools]).toEqual(previous === 'edit' ? [1, 0, 1] : [0, 1, 0]);
        expect(notifications).toBeGreaterThan(0);
        expect(session.dirty).toBe(true);
        c.setTabMode('main', tab, requested);
        expect(c.tabMode('main')).toBe(requested);
        expect([counts.editors, counts.readers, counts.tools]).toEqual(requested === 'edit' ? [1, 0, 1] : [0, 1, 0]);
        expect(new Set([...f.sessions, ...f.readerSessions])).toEqual(new Set([session]));
        expect((session.model as { raw: string }).raw).toBe('unsaved during failed mode switch');
      } finally {
        sub.dispose(); await c.dispose(); await app.dispose();
      }
      expect([counts.editors, counts.readers, counts.tools]).toEqual([0, 0, 0]);
    });
  }
});

describe('queued open with pane closure and transfer', () => {
  for (const action of ['close', 'move source', 'move destination'] as const) {
    it(`serializes ${action} against a deferred document open`, async () => {
      const f = await setupSplit();
      const { controller: c, app, counts, tab } = f;
      const workspace = app.getWorkspace()!;
      const incoming = await workspace.createDocument({
        kindId: latexKindId, path: workspacePath('incoming.tex'), initialModel: { raw: 'incoming' },
      });
      const pane = action === 'move destination' ? c.splitPane('main', 'right') : 'main';
      const destination = action === 'move source' ? c.splitPane('main', 'right') : pane;
      let enter!: () => void;
      let release!: () => void;
      const entered = new Promise<void>(resolve => { enter = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const original = workspace.openDocument.bind(workspace);
      workspace.openDocument = async (id) => {
        if (id === incoming.documentId) { enter(); await gate; }
        return original(id);
      };
      let transitionsSettled = false;
      const opening = c.openDocument(String(incoming.documentId), {}, { pane });
      await entered;
      const transition = (action === 'close' ? c.closePane(pane) :
        c.moveTab(action === 'move destination' ? 'main' : pane,
          action === 'move destination' ? tab : String(incoming.documentId),
          { kind: 'pane', pane: destination }, { editorParent: {}, readerParent: {} }))
        .then(() => { transitionsSettled = true; });
      // The pending open has finished outgoing teardown, but not adoption.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      const premature = transitionsSettled;
      release();
      try {
        await Promise.all([opening, transition]);
        expect(premature).toBe(false);
        if (action === 'close') {
          expect(c.paneStates().some(p => p.documentId === String(incoming.documentId))).toBe(false);
          expect(workspace.getOpenDocument(incoming.documentId)).toBeNull();
          expect([counts.editors, counts.readers, counts.tools]).toEqual([0, 0, 0]);
          // A closed session must not retain the controller's state/content listeners.
          const closed = f.sessions.at(-1)!;
          let staleNotifications = 0;
          const observer = c.onDidChange(() => staleNotifications++);
          await closed.open();
          closed.markDirty();
          await closed.close();
          observer.dispose();
          expect(staleNotifications).toBe(0);
        } else {
          const expected = action === 'move destination' ? tab : String(incoming.documentId);
          expect(c.paneStates().find(p => p.pane === destination)?.activeTab).toBe(expected);
          // Moving incoming out reopens the remaining LaTeX source tab too.
          const live = action === 'move source' ? 2 : 1;
          expect(counts.editors).toBe(live);
          expect(counts.tools).toBe(live);
        }
      } finally {
        workspace.openDocument = original;
        await c.dispose(); await app.dispose();
      }
      expect([counts.editors, counts.readers, counts.tools]).toEqual([0, 0, 0]);
    });
  }
});

describe('new split destination joins the transfer queue', () => {
  it('waits for split-destination adoption before moving it to an unrelated pane', async () => {
    const f = await setupSplit();
    const { controller: c, app, tab, counts } = f;
    const workspace = app.getWorkspace()!;
    // Leave the LaTeX tab inactive in A, then move it to a fresh split C by B.
    const neighbor = c.paneStates()[0]!.tabs.find(t => t.id !== tab)!;
    await c.activateTab('main', neighbor.id);
    c.setTabMode('main', tab, 'split');
    const anchor = c.splitPane('main', 'right');
    const destination = c.splitPane(anchor, 'right');
    const original = workspace.openDocument.bind(workspace);
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let adopted: DocumentSession | null = null;
    let firstOpen = true;
    workspace.openDocument = async <TModel,>(id: Parameters<typeof original>[0]) => {
      if (String(id) === tab && firstOpen) { firstOpen = false; enter(); await gate; }
      const session = await original<TModel>(id);
      if (String(id) === tab) {
        adopted = session;
        (session.model as { raw: string }).raw = 'unsaved in deferred split open';
        session.markDirty();
      }
      return session;
    };
    const first = c.moveTab('main', tab,
      { kind: 'split', pane: anchor, direction: 'right' }, { editorParent: {}, readerParent: {} });
    await entered;
    const intermediate = c.paneStates().find(p => p.activeTab === tab)!.pane;
    let secondSettled = false;
    const second = c.moveTab(intermediate, tab, { kind: 'pane', pane: destination },
      { editorParent: {}, readerParent: {} }).then(() => { secondSettled = true; });
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    const premature = secondSettled;
    release();
    try {
      await Promise.all([first, second]);
      expect(premature).toBe(false);
      expect(c.leafIds()).not.toContain(intermediate);
      expect(c.paneStates().find(p => p.pane === destination)?.activeTab).toBe(tab);
      expect(c.tabMode(destination)).toBe('split');
      expect([counts.editors, counts.readers, counts.tools]).toEqual([1, 1, 1]);
      const session = f.sessions.at(-1)!;
      expect(session).toBe(adopted);
      expect(session.dirty).toBe(true);
      expect((session.model as { raw: string }).raw).toBe('unsaved in deferred split open');
      expect(workspace.getOpenDocument(session.document.documentId)).toBe(session);
      expect(f.readerSessions.at(-1)).toBe(session);
      const updates = counts.updates;
      session.markDirty();
      expect(counts.updates).toBe(updates + 1);
      await c.closePane(destination);
      expect([counts.editors, counts.readers, counts.tools]).toEqual([0, 0, 0]);
      expect(workspace.getOpenDocument(session.document.documentId)).toBeNull();
      let notifications = 0;
      const observer = c.onDidChange(() => notifications++);
      await session.open();
      session.markDirty();
      await session.close();
      observer.dispose();
      expect(notifications).toBe(0);
    } finally {
      workspace.openDocument = original;
      await c.dispose(); await app.dispose();
    }
  });
});

describe('terminal pane reservations', () => {
  for (const pending of ['open', 'transfer'] as const) {
    for (const terminal of ['others', 'dispose', 'close vault', 'replace vault'] as const) {
      it(`drains deferred ${pending} before ${terminal}, releasing every owned effect`, async () => {
        const f = await setupSplit();
        const { controller: c, app, tab, counts } = f;
        const workspace = app.getWorkspace()!;
        const neighbor = c.paneStates()[0]!.tabs.find(t => t.id !== tab)!;
        await c.activateTab('main', neighbor.id);
        c.setTabMode('main', tab, 'split');
        const side = c.splitPane('main', 'right');
        c.setReaderHost(side, {});
        let enter!: () => void;
        let release!: () => void;
        const entered = new Promise<void>(resolve => { enter = resolve; });
        const gate = new Promise<void>(resolve => { release = resolve; });
        const original = workspace.openDocument.bind(workspace);
        let subscriptions = 0;
        const opened: DocumentSession[] = [];
        workspace.openDocument = async <TModel,>(id: Parameters<typeof original>[0]) => {
          const session = await original<TModel>(id);
          if (String(id) === tab) {
            opened.push(session);
            // Count actual controller subscriptions, including a late adoption
            // that could otherwise be hidden by clearing controller listeners.
            function track<T>(subscribe: (listener: (value: T) => void) => { dispose(): void }) {
              return (listener: (value: T) => void) => {
                subscriptions++;
                const sub = subscribe(listener);
                return { dispose() { subscriptions--; sub.dispose(); } };
              };
            }
            session.onDidChangeDirty = track(session.onDidChangeDirty.bind(session));
            session.onStateChange = track(session.onStateChange.bind(session));
            session.onDidChangeContent = track<void>(session.onDidChangeContent.bind(session));
            enter();
            await gate;
          }
          return session;
        };
        const operation = pending === 'open'
          ? c.openDocument(tab, {}, { pane: side })
          : c.moveTab('main', tab, { kind: 'split', pane: side, direction: 'right' },
              { editorParent: {}, readerParent: {} });
        await entered;
        let finished = false;
        const closing = (terminal === 'others' ? c.closeOtherPanes('main') :
          terminal === 'dispose' ? c.dispose() :
          terminal === 'close vault' ? c.closeVaultView() : c.openVault(memoryVaultPlugin, {}))
          .then(() => { finished = true; });
        // Attach rejection handling immediately (the correct implementation
        // rejects admission rather than silently opening in the next vault).
        const admission = c.openDocument(neighbor.id, {}).then(() => 'admitted', () => 'blocked');
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        const premature = finished;
        release();
        try {
          await Promise.all([operation, closing]);
          expect(premature).toBe(false);
          expect(await admission).toBe('blocked');
          expect(subscriptions).toBe(0);
          expect([counts.editors, counts.readers, counts.tools]).toEqual([0, 0, 0]);
          expect(opened.map(session => session.state)).toEqual(['closed']);
          if (terminal === 'others' || terminal === 'dispose') {
            expect(workspace.getOpenDocument(f.session.document.documentId)).toBeNull();
          } else {
            expect(app.getWorkspace()).not.toBe(workspace);
          }
          expect(c.paneStates().some(p => p.documentId === tab)).toBe(false);
          if (terminal === 'others') {
            expect(c.leafIds()).toEqual(['main']);
            expect(c.paneStates()[0]!.tabs.some(t => t.id === tab)).toBe(true);
            // Temporary exclusion releases admission after migrating tabs.
            await c.activateTab('main', tab);
            expect(c.tabMode('main')).toBe('split');
            expect([counts.editors, counts.readers, counts.tools]).toEqual([1, 1, 1]);
          } else if (terminal === 'dispose') {
            await expect(c.openDocument(neighbor.id, {})).rejects.toThrow();
            await c.dispose(); // repeat disposal must not deadlock/reopen
          } else {
            await c.openVault(memoryVaultPlugin, {});
            await c.initialize({}); // a new vault can admit operations again
          }
        } finally {
          release();
          workspace.openDocument = original;
          await c.dispose(); await app.dispose();
        }
        expect(subscriptions).toBe(0);
        expect([counts.editors, counts.readers, counts.tools]).toEqual([0, 0, 0]);
      });
    }
  }
});

describe('retryable disposal attempts', () => {
  it('coalesces a failed storage save and retries with the same dirty session', async () => {
    const f = await setupSplit();
    const { controller: c, app, session, counts, tab } = f;
    c.setTabMode('main', tab, 'split');
    f.edit('authoritative unsaved source');
    const vault = app.getVault()!;
    const write = vault.write.bind(vault);
    let attempts = 0;
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { enter = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    vault.write = async (path, bytes) => {
      if (String(path).endsWith('paper.tex')) {
        attempts++;
        if (attempts === 1) {
          enter(); await gate;
          throw new Error('storage temporarily unavailable');
        }
      }
      return write(path, bytes);
    };
    try {
      const first = c.dispose();
      const second = c.dispose();
      const failed = Promise.allSettled([first, second]);
      await entered;
      expect(attempts).toBe(1);
      release();
      const results = await failed;
      expect(results.map(result => result.status)).toEqual(['rejected', 'rejected']);
      expect(attempts).toBe(1);
      expect(session.dirty).toBe(true);
      expect((session.model as { raw: string }).raw).toBe('authoritative unsaved source');
      expect(app.getWorkspace()!.getOpenDocument(session.document.documentId)).toBe(session);
      expect(c.paneStates().find(p => p.pane === 'main')?.documentId).toBe(tab);
      expect([counts.editors, counts.readers, counts.tools]).toEqual([1, 1, 1]);
      const updates = counts.updates;
      session.markDirty();
      expect(counts.updates).toBe(updates + 1);
      await expect(c.openDocument(tab, {})).rejects.toThrow();
      await Promise.all([c.dispose(), c.dispose()]);
      expect(attempts).toBe(2);
      expect(session.state).toBe('closed');
      expect(app.getWorkspace()!.getOpenDocument(session.document.documentId)).toBeNull();
      expect([counts.editors, counts.readers, counts.tools]).toEqual([0, 0, 0]);
      expect(new TextDecoder().decode(await vault.read(workspacePath('paper.tex')))).toBe('authoritative unsaved source');
      await c.dispose();
      expect(attempts).toBe(2);
      // Reopen only the detached test session: no controller subscription may survive.
      const after = counts.updates;
      await session.open(); session.markDirty(); await session.close();
      expect(counts.updates).toBe(after);
    } finally {
      release(); vault.write = write;
      await c.dispose(); await app.dispose();
    }
  });

  it('retains a session whose close fails after another pane was torn down', async () => {
    const f = await setupSplit();
    const { controller: c, app, session: firstSession, counts } = f;
    const workspace = app.getWorkspace()!;
    const ref = await workspace.createDocument({ kindId: latexKindId,
      path: workspacePath('second.tex'), initialModel: { raw: 'second source' } });
    const side = c.splitPane('main', 'right');
    await c.openDocument(String(ref.documentId), {}, { pane: side });
    const secondSession = f.sessions.at(-1)!;
    const close = secondSession.close.bind(secondSession);
    let attempts = 0;
    secondSession.close = async () => {
      if (++attempts === 1) throw new Error('close temporarily failed');
      await close();
    };
    try {
      await expect(c.dispose()).rejects.toThrow('close temporarily failed');
      expect(firstSession.state).toBe('closed');
      expect(secondSession.state).toBe('open');
      expect(workspace.getOpenDocument(ref.documentId)).toBe(secondSession);
      expect(c.paneStates().find(p => p.pane === side)?.documentId).toBe(String(ref.documentId));
      expect([counts.editors, counts.readers, counts.tools]).toEqual([0, 0, 0]);
      await c.dispose();
      expect(attempts).toBe(2);
      expect(secondSession.state).toBe('closed');
      expect(workspace.getOpenDocument(ref.documentId)).toBeNull();
      expect([counts.editors, counts.readers, counts.tools]).toEqual([0, 0, 0]);
    } finally {
      secondSession.close = close;
      await c.dispose(); await app.dispose();
    }
  });
});

describe('reader registration and attachment failures', () => {
  for (const mode of ['split', 'reading'] as const) {
    it(`rolls back a throwing runtime-owned reader replacement in ${mode}`, async () => {
      const f = await setupSplit();
      const { controller: c, app, tab, counts, session } = f;
      c.setTabMode('main', tab, mode);
      f.edit('retained registration source');
      let fail = true;
      let creates = 0;
      let acquired = 0;
      const provider: DocumentReaderProvider = {
        ...f.reader, id: 'throwing-replacement',
        createReader(input) {
          creates++;
          if (fail) throw new Error('replacement failed');
          return f.reader.createReader(input);
        },
      };
      const plugin = definePlugin({
        id: 'throwing-reader-registration', requirements: { requires: [documentReaderRegistryToken] },
        activate(ctx) {
          ctx.effect(() => {
            const registration = ctx.require(documentReaderRegistryToken).register(provider);
            acquired++;
            return () => { acquired--; registration.dispose(); };
          });
        },
      });
      try {
        // Runtime may report failed activation through state rather than rejection.
        await app.runtime.registerSlot({ id: 'throwing-reader', plugin }).catch(() => undefined);
        expect(creates).toBe(1);
        expect(acquired).toBe(0);
        expect(app.getDocumentReader(latexKindId)).toBe(f.reader);
        expect([counts.editors, counts.readers, counts.tools]).toEqual(mode === 'split' ? [1, 1, 1] : [0, 1, 0]);
        await app.runtime.removeSlot('throwing-reader');
        fail = false;
        await app.runtime.registerSlot({ id: 'throwing-reader', plugin });
        expect(app.getDocumentReader(latexKindId)).toBe(provider);
        expect(acquired).toBe(1);
        expect(counts.readers).toBe(1);
        await app.runtime.removeSlot('throwing-reader');
        expect(acquired).toBe(0);
        expect(app.getDocumentReader(latexKindId)).toBe(f.reader);
        expect(counts.readers).toBe(1);
        expect(c.tabMode('main')).toBe(mode);
        expect((session.model as { raw: string }).raw).toBe('retained registration source');
        expect(new Set(f.readerSessions)).toEqual(new Set([session]));
      } finally {
        await c.dispose(); await app.dispose();
      }
      expect([counts.editors, counts.readers, counts.tools]).toEqual([0, 0, 0]);
    });
  }

  for (const factory of ['editor', 'reader'] as const) {
    it(`retries the same attachment hosts after a ${factory} factory failure`, async () => {
      const failures = { editor: false, reader: false };
      const f = await setupSplit(failures);
      const { controller: c, app, tab, session, counts } = f;
      c.setTabMode('main', tab, 'split');
      f.edit('same unsaved attachment model');
      const host = {};
      const readerHost = {};
      failures[factory] = true;
      try {
        await expect(c.reattachPane('main', host, readerHost)).rejects.toThrow('factory failed');
        expect(c.isPaneAttached('main', host)).toBe(false);
        await c.reattachPane('main', host, readerHost);
        expect(c.isPaneAttached('main', host)).toBe(true);
        expect([counts.editors, counts.readers, counts.tools]).toEqual([1, 1, 1]);
        const created = f.sessions.length + f.readerSessions.length;
        await c.reattachPane('main', host, readerHost);
        expect(f.sessions.length + f.readerSessions.length).toBe(created);
        expect(new Set([...f.sessions, ...f.readerSessions])).toEqual(new Set([session]));
        expect(session.dirty).toBe(true);
        expect((session.model as { raw: string }).raw).toBe('same unsaved attachment model');
        expect(c.tabMode('main')).toBe('split');
      } finally {
        await c.dispose(); await app.dispose();
      }
      expect([counts.editors, counts.readers, counts.tools]).toEqual([0, 0, 0]);
    });
  }
});

describe('edits accepted during persistence', () => {
  for (const scenario of ['write', 'postcommit', 'failed follow-up save'] as const) {
    it(`keeps source accepted during ${scenario} authoritative until committed or retained`, async () => {
      const f = await setupSplit();
      const { controller: c, app, tab, session, counts } = f;
      const workspace = app.getWorkspace()!;
      const vault = app.getVault()!;
      const write = vault.write.bind(vault);
      c.setTabMode('main', tab, 'split');
      f.edit('snapshot source');
      let entered!: () => void;
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const enteredGate = new Promise<void>(resolve => { entered = resolve; });
      if (scenario !== 'postcommit') {
        vault.write = async (path, bytes) => {
          if (String(path).endsWith('paper.tex')) { entered(); await gate; }
          return write(path, bytes);
        };
      }
      let closing: Promise<void> | null = null;
      try {
        if (scenario === 'postcommit') {
          const subscription = session.onPostCommit(() => {
            f.edit('edited during postcommit');
            entered();
          });
          closing = c.closeTab('main', tab);
          await enteredGate;
          subscription.dispose();
        } else {
          closing = c.closeTab('main', tab);
          await enteredGate;
          f.edit('edited during write');
          release();
        }
        if (scenario === 'failed follow-up save') {
          // The follow-up save fails: the controller must keep owning the
          // dirty session with the accepted content, discarding nothing.
          vault.write = async () => { throw new Error('storage unavailable again'); };
          await expect(closing).rejects.toThrow('storage unavailable again');
          // The save error stays retryable: content is retained for another attempt.
          expect(session.state).toBe('error');
          expect(session.dirty).toBe(true);
          expect((session.model as { raw: string }).raw).toBe('edited during write');
          expect(workspace.getOpenDocument(session.document.documentId)).toBe(session);
          expect(c.paneStates()[0]!.tabs.some(t => t.id === tab)).toBe(true);
          const restore = vault.write.bind(vault);
          vault.write = async (path, bytes) => {
            if (String(path).endsWith('paper.tex')) {
              vault.write = write;
              return write(path, bytes);
            }
            return restore(path, bytes);
          };
          await c.closeTab('main', tab);
          expect(new TextDecoder().decode(await vault.read(workspacePath('paper.tex')))).toBe('edited during write');
          expect(c.paneStates()[0]!.tabs.some(t => t.id === tab)).toBe(false);
          return;
        }
        await closing;
        expect(session.state).toBe('closed');
        expect(new TextDecoder().decode(await vault.read(workspacePath('paper.tex')))).toBe(
          scenario === 'write' ? 'edited during write' : 'edited during postcommit');
        expect(workspace.getOpenDocument(session.document.documentId)).toBeNull();
        expect([counts.editors, counts.readers, counts.tools]).toEqual([0, 0, 0]);
        let notifications = 0;
        const observer = c.onDidChange(() => notifications++);
        await session.open(); session.markDirty(); await session.close();
        observer.dispose();
        expect(notifications).toBe(0);
      } finally {
        release(); vault.write = write;
        await c.dispose(); await app.dispose();
      }
      expect([counts.editors, counts.readers, counts.tools]).toEqual([0, 0, 0]);
    });
  }
});

// A pane saved early remains editable while another pane persists.
async function terminalPair() {
  const inputs = new Map<string, (text: string, buffered: boolean) => void>();
  const sessions = new Map<string, DocumentSession<{ raw: string }>>();
  const live = new Set<string>();
  const readerLive = new Set<string>();
  const readerUpdates = new Map<string, number>();
  const reader: DocumentReaderProvider = {
    id: 'close-reader', kindIds: [latexKindId],
    createReader({ session }) {
      const id = String(session.document.documentId);
      readerLive.add(id); readerUpdates.set(id, 0);
      return {
        update() { readerUpdates.set(id, (readerUpdates.get(id) ?? 0) + 1); },
        destroy() { readerLive.delete(id); readerUpdates.delete(id); },
      };
    },
  };
  const editor: DocumentEditorProvider = {
    id: 'terminal-buffered', kindIds: [latexKindId],
    createEditor({ session }) {
      const id = String(session.document.documentId);
      const source = session as DocumentSession<{ raw: string }>;
      sessions.set(id, source); live.add(id);
      let pending: string | null = null;
      inputs.set(id, (text, buffered) => {
        if (buffered) pending = text;
        else { source.model.raw = text; source.markDirty(); }
      });
      return {
        focus() { /* headless host */ }, hasFocus: () => false,
        execCommand: () => false,
        flush() {
          if (pending === null) return;
          source.model.raw = pending; source.markDirty(); pending = null;
        },
        destroy() { inputs.delete(id); live.delete(id); },
      };
    },
  };
  const app = await createApp({ vaultPlugin: memoryVaultPlugin,
    searchService: new InMemorySearchService(), documentKinds: [latexKind],
    documentEditorProviders: [editor], documentReaderProviders: [reader] });
  const c = createWorkbenchController(app);
  const ws = app.getWorkspace()!;
  const a = await ws.createDocument({ kindId: latexKindId, path: workspacePath('a.tex'), initialModel: latexModel('A initial') });
  const b = await ws.createDocument({ kindId: latexKindId, path: workspacePath('b.tex'), initialModel: latexModel('B initial') });
  const aid = String(a.documentId), bid = String(b.documentId);
  await c.openDocument(aid, {});
  const side = c.splitPane('main', 'right');
  await c.openDocument(bid, {}, { pane: side });
  const vault = app.getVault()!;
  const write = vault.write.bind(vault);
  const finish = (terminal: string) => terminal === 'dispose' ? c.dispose() :
    terminal === 'close' ? c.closeVaultView() : c.openVault(memoryVaultPlugin, {});
  return { app, c, ws, aid, bid, side, inputs, sessions, live, vault, write, finish,
    async cleanup() { vault.write = write; await c.dispose(); await app.dispose(); } };
}

for (const terminal of ['close', 'dispose', 'replace']) {
  for (const buffered of [false, true]) {
    it(`persists ${buffered? 'buffered': 'immediate'} A input during deferred B write before ${terminal}`, async () => {
      const f = await terminalPair();
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const writing = new Promise<void>(resolve => { entered = resolve; });
      let operation: Promise<void> | undefined;
      try {
        f.inputs.get(f.bid)!('B latest', false);
        f.vault.write = async (path, bytes) => {
          if (String(path) === 'b.tex') { entered(); await gate; }
          return f.write(path, bytes);
        };
        operation = f.finish(terminal);
        await writing; // A was already checked clean; B is now awaiting storage.
        f.inputs.get(f.aid)!('A latest\n\\alpha', buffered);
        release();
        await operation;
        expect(new TextDecoder().decode(await f.vault.read(workspacePath('a.tex')))).toBe('A latest\n\\alpha');
        expect(new TextDecoder().decode(await f.vault.read(workspacePath('b.tex')))).toBe('B latest');
        expect(f.live.size).toBe(0);
      } finally { release(); await operation?.catch(() => undefined); await f.cleanup(); }
    });
  }
}

it('bounds cross-pane churn and retains dirty ownership after the final B save', async () => {
  const f = await terminalPair();
  let bWrites = 0;
  try {
    f.inputs.get(f.bid)!('B initial', false);
    f.vault.write = async (path, bytes) => {
      if (String(path) === 'a.tex') f.inputs.get(f.bid)!('B next', true);
      if (String(path) === 'b.tex') f.inputs.get(f.aid)!(`A latest ${++bWrites}`, true);
      return f.write(path, bytes);
    };
    await expect(f.c.dispose()).rejects.toThrow('stable');
    expect(bWrites).toBe(5);
    const a = f.sessions.get(f.aid)!;
    expect(a.model.raw).toBe('A latest 5');
    expect(a.dirty).toBe(true);
    expect(f.ws.getOpenDocument(a.document.documentId)).toBe(a);
    expect(f.c.paneStates().some(p => p.documentId === f.aid)).toBe(true);
    expect(f.live.size).toBe(2);
    f.vault.write = f.write;
    await f.c.dispose();
    expect(new TextDecoder().decode(await f.vault.read(workspacePath('a.tex')))).toBe('A latest 5');
    expect(f.live.size).toBe(0);
  } finally { await f.cleanup(); }
});

for (const buffered of [false, true]) {
  it(`retains ${buffered? 'buffered': 'immediate'} B input accepted while A close awaits`, async () => {
    const f = await terminalPair();
    const a = f.sessions.get(f.aid)!;
    const b = f.sessions.get(f.bid)!;
    const close = a.close.bind(a);
    let entered!: () => void;
    let release!: () => void;
    const closing = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    a.close = async () => { entered(); await gate; await close(); };
    let operation: Promise<void> | undefined;
    try {
      operation = f.c.dispose();
      // Attach failure observation before allowing the controlled close to finish.
      const result = operation.then(() => 'closed', () => 'retained');
      await closing;
      f.inputs.get(f.bid)!('B edited during A close', buffered);
      release();
      expect(await result).toBe('retained');
      expect(b.model.raw).toBe('B edited during A close');
      expect(b.dirty).toBe(true);
      expect(f.ws.getOpenDocument(b.document.documentId)).toBe(b);
      expect(f.c.paneStates().some(p => p.documentId === f.bid)).toBe(true);
      expect(f.live.has(f.bid)).toBe(true);
      await f.c.dispose();
      expect(new TextDecoder().decode(await f.vault.read(workspacePath('b.tex')))).toBe('B edited during A close');
      expect(f.live.size).toBe(0);
    } finally { release(); await operation?.catch(() => undefined); a.close = close; await f.cleanup(); }
  });
}

// A failed last-tab close must keep its pane reachable for retry.
async function closeFixture(placement?: 'primary' | 'secondary') {
  const live = new Set<string>();
  const readerLive = new Set<string>();
  const readerUpdates = new Map<string, number>();
  const reader: DocumentReaderProvider = {
    id: 'close-reader', kindIds: [latexKindId],
    createReader({ session }) {
      const id = String(session.document.documentId);
      readerLive.add(id); readerUpdates.set(id, 0);
      return {
        update() { readerUpdates.set(id, (readerUpdates.get(id) ?? 0) + 1); },
        destroy() { readerLive.delete(id); readerUpdates.delete(id); },
      };
    },
  };
  const editor: DocumentEditorProvider = {
    id: 'close-lifecycle', kindIds: [latexKindId],
    createEditor({ session }) {
      const id = String(session.document.documentId);
      live.add(id);
      return {
        focus() { /* headless */ }, hasFocus: () => false,
        execCommand: () => false, setReadOnly: () => undefined,
        flush() { /* nothing buffered */ },
        destroy() { live.delete(id); },
      };
    },
  };
  const app = await createApp({ vaultPlugin: memoryVaultPlugin,
    searchService: new InMemorySearchService(), documentKinds: [latexKind],
    documentEditorProviders: [editor], documentReaderProviders: [reader] });
  const c = createWorkbenchController(app);
  const ws = app.getWorkspace()!;
  // Track controller-owned subscriptions: installed before the controller
  // subscribes so every registration and disposal is counted.
  const ownedByDoc = new Map<string, () => number>();
  const wsOpen = ws.openDocument.bind(ws) as <TModel>(
    documentId: Parameters<typeof ws.openDocument>[0],
  ) => Promise<DocumentSession<TModel>>;
  ws.openDocument = async <TModel>(
    documentId: Parameters<typeof ws.openDocument>[0],
  ): Promise<DocumentSession<TModel>> => {
    const opened = await wsOpen<TModel>(documentId);
    const key = String(opened.document.documentId);
    if (!ownedByDoc.has(key)) {
      ownedByDoc.set(key, trackedSession(opened as unknown as DocumentSession<{ raw: string }>));
    }
    return opened;
  };
  const a = await ws.createDocument({ kindId: latexKindId, path: workspacePath('close-a.tex'), initialModel: latexModel('A') });
  const aid = String(a.documentId);
  await c.openDocument(aid, {});
  let side: string | null = null;
  let bid: string | null = null;
  let session: DocumentSession<{ raw: string }> | null = null;
  if (placement === 'secondary') {
    const b = await ws.createDocument({ kindId: latexKindId, path: workspacePath('close-b.tex'), initialModel: latexModel('B') });
    bid = String(b.documentId);
    side = c.splitPane('main', 'right');
    await c.openDocument(bid, {}, { pane: side });
    session = ws.getOpenDocument(b.documentId) as DocumentSession<{ raw: string }>;
  } else {
    session = ws.getOpenDocument(a.documentId) as DocumentSession<{ raw: string }>;
  }
  return { app, c, ws, aid, bid, side, live, readerLive, readerUpdates, session,
    owned: (id: string) => ownedByDoc.get(id)?.() ?? -1,
    async cleanup() {
      ws.openDocument = wsOpen;
      await c.dispose(); await app.dispose();
    } };
}

for (const placement of ['primary', 'secondary'] as const) {
  it(`retains a reachable owner when a ${placement} last-tab close fails, then closes on retry`, async () => {
    const f = await closeFixture(placement);
    const pane = placement === 'primary' ? 'main' : f.side!;
    const tab = f.c.paneStates().find(p => p.pane === pane)!.activeTab!;
    const session = f.session!;
    const close = session.close.bind(session);
    let closeAttempts = 0;
    session.close = async () => {
      closeAttempts++;
      if (closeAttempts === 1) throw new Error('close refused once');
      await close();
    };
    try {
      await expect(f.c.closeTab(pane, tab)).rejects.toThrow('close refused once');
      expect(closeAttempts).toBe(1);
      const state = f.c.paneStates().find(p => p.pane === pane)!;
      expect(state.tabs.some(candidate => candidate.id === tab)).toBe(true);
      expect(state.activeTab).toBe(tab);
      expect(f.c.leafIds().includes(pane)).toBe(true);
      expect(f.c.isPaneActive(pane)).toBe(true);
      expect(f.ws.getOpenDocument(session.document.documentId)).toBe(session);
      // The close released the editor handle but retained the clean session
      // as the reachable recovery owner; nothing else was torn down yet.
      // A retry (identical inputs, no registration/host/mode change) closes.
      await f.c.closeTab(pane, tab);
      expect(f.live.has(placement === 'primary' ? f.aid : f.bid!)).toBe(false);
      expect(f.c.isPaneActive(pane)).toBe(false);
      if (placement === 'primary') {
        // Removing the last leaf recreates the empty main pane by design.
        expect(f.c.paneStates().find(p => p.pane === pane)!.tabs).toHaveLength(0);
      } else {
        expect(f.c.paneStates().some(p => p.pane === pane)).toBe(false);
      }
      expect(f.ws.getOpenDocument(session.document.documentId)).toBeNull();
      if (placement === 'secondary') {
        expect(f.c.paneStates().some(p => p.pane === 'main' && p.documentId === f.aid)).toBe(true);
        expect(f.live.has(f.aid)).toBe(true);
      }
      expect(closeAttempts).toBe(2);
    } finally { session.close = close; await f.cleanup(); }
  });
}



// A failed close retains the session, so every legitimate resumption path
// must see its subscription plumbing intact, not just the explorer open.
// Owned-subscription tracking also proves the final successful close leaves
// zero controller subscriptions.
function trackedSession(session: DocumentSession<{ raw: string }>): () => number {
  let owned = 0;
  const wrap = <L,>(install: (listener: L) => { dispose(): void }) => (listener: L) => {
    owned += 1;
    const disposer = install(listener);
    return { dispose() { owned -= 1; disposer.dispose(); } };
  };
  const state = session.onStateChange.bind(session);
  session.onStateChange = wrap(state);
  const dirty = session.onDidChangeDirty.bind(session);
  session.onDidChangeDirty = wrap(dirty);
  const content = session.onDidChangeContent.bind(session);
  session.onDidChangeContent = wrap(content);
  return () => owned;
}

for (const placement of ['primary', 'secondary'] as const) {
  it(`central recovery keeps subscriptions across every ${placement} resumption path, then closes silently`, async () => {
    const f = await closeFixture(placement);
    const pane = placement === 'primary' ? 'main' : f.side!;
    const docId = placement === 'primary' ? f.aid : f.bid!;
    const activeTab = () => f.c.paneStates().find(p => p.pane === pane)!.activeTab!;
    const session = f.session!;
    expect(f.owned(docId)).toBe(3);
    const close = session.close.bind(session);
    let closeAttempts = 0;
    session.close = async () => {
      closeAttempts++;
      if (closeAttempts < 5) throw new Error('close refused once');
      await close();
    };
    let notifications = 0;
    const observer = f.c.onDidChange(() => { notifications += 1; });
    const alternate: DocumentEditorProvider = {
      id: 'close-lifecycle-alt', kindIds: [latexKindId],
      createEditor({ session: recovered }) {
        const id = String(recovered.document.documentId);
        f.live.add(id);
        return {
          focus() { /* headless */ }, hasFocus: () => false,
          execCommand: () => false, setReadOnly: () => undefined,
          flush() { /* nothing buffered */ },
          destroy() { f.live.delete(id); },
        };
      },
    };
    const plugin = definePlugin({
      id: `alt-editor-${placement}`, requirements: { requires: [documentEditorRegistryToken] },
      activate(ctx) { ctx.effect(() => ctx.require(documentEditorRegistryToken).register(alternate).dispose); },
    });
    try {
      await f.c.setReaderHost(pane, {});
      await f.c.setTabMode(pane, activeTab(), 'split');
      expect(f.c.tabMode(pane)).toBe('split');
      const recover = [
        async () => { await f.c.reattachPane(pane, {}); },
        async () => { await f.app.runtime.registerSlot({ id: `alt-editor-${placement}`, plugin }); },
        async () => {
          await f.c.setTabMode(pane, activeTab(), 'edit');
          await f.c.setTabMode(pane, activeTab(), 'split');
        },
        async () => { await f.c.openDocument(docId, {}, { pane }); },
      ];
      for (let cycle = 1; cycle <= 4; cycle++) {
        await expect(f.c.closeTab(pane, activeTab())).rejects.toThrow('close refused once');
        expect(closeAttempts).toBe(cycle);
        // Central ownership rule: subscriptions survive the failed close.
        expect(f.owned(docId)).toBe(3);
        expect(f.c.isPaneActive(pane)).toBe(true);
        await recover[cycle - 1]();
        expect(f.c.tabMode(pane)).toBe('split');
        // EXACTLY one controller reader.update per edit, every cycle.
        const before = f.readerUpdates.get(docId) ?? 0;
        for (let step = 1; step <= 2; step++) {
          session.model.raw = `cycle ${cycle} edit ${step}`;
          session.markDirty();
          expect(f.readerUpdates.get(docId)).toBe(before + step);
        }
        // clean -> dirty -> save drives exactly three controller events
        // (dirty flip, saving, open); saves emit no content invalidation.
        const cleanNotifications = notifications;
        await session.save();
        expect(notifications - cleanNotifications).toBe(3);
        expect(session.dirty).toBe(false);
      }
      // Successful close: zero handles AND zero owned controller subscriptions.
      await f.c.closeTab(pane, activeTab());
      expect(closeAttempts).toBe(5);
      expect(f.live.has(docId)).toBe(false);
      expect(f.readerLive.has(docId)).toBe(false);
      expect(f.owned(docId)).toBe(0);
      expect(f.ws.getOpenDocument(session.document.documentId)).toBeNull();
      // Subscription silence: no controller events after the close resolved.
      const silent = notifications;
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(notifications).toBe(silent);
      if (placement === 'secondary') {
        expect(f.c.paneStates().some(p => p.pane === 'main' && f.live.has(f.aid))).toBe(true);
      }
    } finally {
      session.close = close;
      observer.dispose();
      await f.app.runtime.removeSlot(`alt-editor-${placement}`).catch(() => undefined);
      await f.cleanup();
    }
  });
}

for (const mode of ['edit', 'split'] as const) {
  it(`rolls back runtime editor acquisition failure in ${mode} without losing dirty source`, async () => {
    const f = await setupSplit();
    const { app, controller: c, session, counts, tab } = f;
    let fail = true;
    let acquired = 0;
    const provider: DocumentEditorProvider = {
      ...f.editor, id: 'failed-editor-acquisition',
      createEditor(input) {
        if (fail) throw new Error('replacement editor failed');
        return f.editor.createEditor(input);
      },
    };
    const plugin = definePlugin({
      id: 'failed-editor-acquisition', requirements: { requires: [documentEditorRegistryToken] },
      activate(ctx) {
        ctx.effect(() => {
          const registration = ctx.require(documentEditorRegistryToken).register(provider);
          acquired++;
          return () => { acquired--; registration.dispose(); };
        });
      },
    });
    try {
      c.setTabMode('main', tab, mode);
      f.edit('dirty original'); f.pending('latest buffered source');
      await app.runtime.registerSlot({ id: 'editor-acquisition', plugin }).catch(() => undefined);
      expect(acquired).toBe(0);
      expect(app.getDocumentEditor(latexKindId)).toBe(f.editor);
      await app.runtime.removeSlot('editor-acquisition');
      expect(app.getDocumentEditor(latexKindId)).toBe(f.editor);
      expect([counts.editors, counts.readers, counts.tools]).toEqual([1, mode === 'split' ? 1 : 0, 1]);
      expect(session.model).toMatchObject({ raw: 'latest buffered source' });
      expect(session.dirty).toBe(true);
      fail = false;
      await app.runtime.registerSlot({ id: 'editor-acquisition', plugin });
      expect(acquired).toBe(1);
      expect(app.getDocumentEditor(latexKindId)).toBe(provider);
      await app.runtime.removeSlot('editor-acquisition');
      expect(acquired).toBe(0);
      expect(app.getDocumentEditor(latexKindId)).toBe(f.editor);
      expect(new Set(f.sessions)).toEqual(new Set([session]));
      await c.dispose();
      expect([counts.editors, counts.readers, counts.tools]).toEqual([0, 0, 0]);
      expect(new TextDecoder().decode(await app.getVault()!.read(workspacePath('paper.tex')))).toBe('latest buffered source');
    } finally {
      fail = false;
      await app.runtime.removeSlot('editor-acquisition');
      await c.dispose(); await app.dispose();
    }
  });
}

for (const terminal of ['tab', 'close vault', 'dispose'] as const) {
  for (const newer of [false, true]) {
    it(`${terminal} joins clean pending user save${newer? ' plus newer buffered edit': ''}`, async () => {
      const f = await setupSplit();
      const { controller: c, app, session, tab } = f;
      const vault = app.getVault()!;
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>(resolve => { entered = resolve; });
      const gate = new Promise<void>(resolve => { release = resolve; });
      const postCommit = session.onPostCommit(async () => { entered(); await gate; });
      let saving: ReturnType<typeof c.savePane> | undefined;
      let closing: Promise<void> | undefined;
      let notifications = 0;
      const observer = c.onDidChange(() => { notifications++; });
      try {
        f.edit('saved snapshot');
        saving = c.savePane('main');
        await started;
        expect(session.dirty).toBe(false);
        expect(session.state).toBe('saving');
        let finished = false;
        closing = (terminal === 'tab' ? c.closeTab('main', tab) :
          terminal === 'dispose' ? c.dispose() : c.closeVaultView()).then(() => { finished = true; });
        // Give the real terminal enough event-loop turns to expose premature close.
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        expect(finished).toBe(false);
        expect(session.state).toBe('saving');
        if (newer) f.pending('newest accepted while saving');
        release();
        await Promise.all([saving, closing]);
        expect(session.state).toBe('closed');
        const after = notifications;
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        expect(notifications).toBe(after);
        expect([f.counts.editors, f.counts.readers, f.counts.tools]).toEqual([0, 0, 0]);
        expect(new TextDecoder().decode(await vault.read(workspacePath('paper.tex'))))
          .toBe(newer ? 'newest accepted while saving' : 'saved snapshot');
      } finally {
        release(); postCommit.dispose();
        await saving?.catch(() => undefined); await closing?.catch(() => undefined);
        observer.dispose(); await c.dispose(); await app.dispose();
      }
    });
  }
}

it('pending user save failure retains newer source when terminal retry also fails', async () => {
  const f = await setupSplit();
  const { controller: c, app, session } = f;
  const vault = app.getVault()!;
  const write = vault.write.bind(vault);
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let attempts = 0;
  let saving: ReturnType<typeof c.savePane> | undefined;
  let outcome: Promise<unknown> | undefined;
  try {
    f.edit('initial write');
    vault.write = async (path, bytes) => {
      if (String(path) === 'paper.tex') {
        attempts++;
        entered(); await gate;
        throw new Error('storage offline');
      }
      return write(path, bytes);
    };
    saving = c.savePane('main');
    await started;
    let completed = false;
    outcome = c.dispose().then(() => { completed = true; return null; }, error => { completed = true; return error; });
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    expect(completed).toBe(false);
    f.pending('latest retained after write failures');
    release();
    expect((await saving)?.committed).toBe(false);
    expect(await outcome).toMatchObject({ message: 'storage offline' });
    expect(attempts).toBe(2);
    expect(session.model).toMatchObject({ raw: 'latest retained after write failures' });
    expect(session.dirty).toBe(true);
    expect(c.isPaneActive('main')).toBe(true);
    expect(app.getWorkspace()!.getOpenDocument(session.document.documentId)).toBe(session);
    expect(f.counts.editors).toBe(1);
    vault.write = write;
    await c.dispose();
    expect(session.state).toBe('closed');
    expect(f.counts.editors).toBe(0);
    expect(new TextDecoder().decode(await vault.read(workspacePath('paper.tex')))).toBe('latest retained after write failures');
  } finally {
    release(); vault.write = write;
    await saving?.catch(() => undefined); await outcome;
    await c.dispose(); await app.dispose();
  }
});

for (const kind of ['editor', 'reader'] as const) {
  it(`withdraws ${kind} effects from distinct A/B even when A restoration fails`, async () => {
    const records: { doc: string; kind: string; shadow: boolean; handles: number; tools: number; content: number }[] = [];
    let firstId = '';
    let armed = false;
    let failures = 0;
    function owned(session: DocumentSession, type: 'editor' | 'reader', shadow: boolean) {
      const doc = String(session.document.documentId);
      if (armed && !shadow && type === kind && doc === firstId) {
        armed = false; failures++;
        throw new Error('original factory fails only A');
      }
      const record = { doc, kind: type, shadow, handles: 1, tools: 0, content: 1 };
      records.push(record);
      const sub = session.onDidChangeContent(() => { expect(record.handles).toBe(1); });
      return { record, destroy() { record.handles--; sub.dispose(); record.content--; } };
    }
    const editor = (shadow: boolean): DocumentEditorProvider => ({
      id: `multipane-editor-${shadow}`, kindIds: [latexKindId],
      createEditor({ session }) {
        const handle = owned(session, 'editor', shadow);
        return {
          focus() { /* headless */ }, hasFocus: () => false, execCommand: () => false,
          destroy: handle.destroy,
          tools: {
            snapshot: () => ({ context: 'source', controls: [] }), execute: () => false,
            onDidChange() {
              handle.record.tools++;
              return { dispose() { handle.record.tools--; } };
            },
          },
        };
      },
    });
    const reader = (shadow: boolean): DocumentReaderProvider => ({
      id: `multipane-reader-${shadow}`, kindIds: [latexKindId],
      createReader({ session }) {
        const handle = owned(session, 'reader', shadow);
        return { update() { expect(handle.record.handles).toBe(1); }, destroy: handle.destroy };
      },
    });
    const app = await createApp({ vaultPlugin: memoryVaultPlugin,
      searchService: new InMemorySearchService(), documentKinds: [latexKind],
      documentEditorProviders: [editor(false)], documentReaderProviders: [reader(false)] });
    const c = createWorkbenchController(app);
    const ws = app.getWorkspace()!;
    let effects = 0;
    const plugin = definePlugin({
      id: 'multipane-shadow', requirements: { requires: [documentEditorRegistryToken, documentReaderRegistryToken] },
      activate(ctx) {
        ctx.effect(() => {
          const registration = kind === 'editor'
            ? ctx.require(documentEditorRegistryToken).register(editor(true))
            : ctx.require(documentReaderRegistryToken).register(reader(true));
          effects++;
          return () => { effects--; registration.dispose(); };
        });
      },
    });
    const totals = (doc: string, shadow: boolean) => records
      .filter(r => r.doc === doc && r.kind === kind && r.shadow === shadow)
      .reduce((sum, r) => [sum[0]! + r.handles, sum[1]! + r.tools, sum[2]! + r.content], [0, 0, 0]);
    try {
      const a = await ws.createDocument({ kindId: latexKindId, path: workspacePath('A.tex'), initialModel: latexModel('A') });
      const b = await ws.createDocument({ kindId: latexKindId, path: workspacePath('B.tex'), initialModel: latexModel('B') });
      firstId = String(a.documentId);
      await c.openDocument(firstId, {});
      c.setReaderHost('main', {}); c.setTabMode('main', firstId, 'split');
      const side = c.splitPane('main', 'right');
      await c.openDocument(String(b.documentId), {}, { pane: side });
      c.setReaderHost(side, {}); c.setTabMode(side, String(b.documentId), 'split');
      const sessions = [a, b].map(ref => ws.getOpenDocument(ref.documentId)!);
      sessions.forEach((session, i) => {
        (session.model as { raw: string }).raw = `unsaved ${i}`; session.markDirty();
      });
      await app.runtime.registerSlot({ id: 'multipane-shadow', plugin });
      expect(effects).toBe(1);
      for (const ref of [a, b]) expect(totals(String(ref.documentId), true)).toEqual([1, kind === 'editor' ? 1 : 0, 1]);
      armed = true;
      await app.runtime.removeSlot('multipane-shadow');
      expect(failures).toBe(1);
      expect(effects).toBe(0);
      // B's withdrawn effects must be zero immediately, before any host retry.
      expect(totals(String(b.documentId), true)).toEqual([0, 0, 0]);
      expect(totals(firstId, true)).toEqual([0, 0, 0]);
      expect(totals(String(b.documentId), false)).toEqual([1, kind === 'editor' ? 1 : 0, 1]);
      expect(totals(firstId, false)).toEqual([0, 0, 0]);
      await c.reattachPane('main', {}, {});
      expect(totals(firstId, false)).toEqual([1, kind === 'editor' ? 1 : 0, 1]);
      sessions.forEach((session, i) => {
        expect(ws.getOpenDocument(session.document.documentId)).toBe(session);
        expect(session.model).toMatchObject({ raw: `unsaved ${i}` });
        expect(session.dirty).toBe(true);
      });
      await c.dispose();
      expect(records.every(r => r.handles === 0 && r.tools === 0 && r.content === 0)).toBe(true);
      for (const [i, name] of ['A', 'B'].entries()) {
        expect(new TextDecoder().decode(await app.getVault()!.read(workspacePath(`${name}.tex`)))).toBe(`unsaved ${i}`);
      }
    } finally {
      armed = false;
      await app.runtime.removeSlot('multipane-shadow');
      await c.dispose(); await app.dispose();
    }
  });
}

describe('cross-pane duplicate open focuses the live owner', () => {
  async function setupCrossPane() {
    const markdownEditor = mockEditorProvider(markdownKindId);
    const latexEditor = mockEditorProvider(latexKindId);
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      vaultConfig: {},
      searchService: new InMemorySearchService(),
      documentKinds: [markdownKind, latexKind],
      documentEditorProviders: [markdownEditor, latexEditor],
    });
    const controller = createWorkbenchController(app);
    await controller.initialize({});
    const workspace = app.getWorkspace()!;
    const ref = await workspace.createDocument({
      kindId: latexKindId,
      path: workspacePath('paper.tex'),
      initialModel: latexModel('canonical'),
    });
    const id = String(ref.documentId);
    await controller.openDocument(id, {});
    const session = workspace.getOpenDocument(ref.documentId)!;
    // Splitting moves focus to the new pane, mirroring the explorer Split
    // scenario: the duplicate open below targets the non-owning pane.
    const side = controller.splitPane('main', 'right');
    expect(controller.focusedPane).toBe(side);
    return { app, controller, workspace, id, session, side, latexEditor };
  }

  it('dirty duplicate open focuses the owner and preserves session, dirt, and handles', async () => {
    const f = await setupCrossPane();
    try {
      (f.session.model as { raw: string }).raw = 'UNSAVED-D009-ONLY-A-UNIQUE';
      f.session.markDirty();
      const editorsBefore = f.latexEditor.spies.length;
      await f.controller.openDocument(f.id, {}, { pane: f.side });
      // The existing owner is focused; no second session is created.
      expect(f.controller.focusedPane).toBe('main');
      expect(f.workspace.getOpenDocument(f.session.document.documentId)).toBe(f.session);
      expect(f.session.state).toBe('open');
      expect(f.session.dirty).toBe(true);
      expect((f.session.model as { raw: string }).raw).toBe('UNSAVED-D009-ONLY-A-UNIQUE');
      // Owner handles are preserved: no replacement editor was created.
      expect(f.latexEditor.spies.length).toBe(editorsBefore);
      expect(f.latexEditor.spies.every((spy) => !spy.destroyed)).toBe(true);
      // The target pane is untouched: no tab, no session, no document.
      const sideState = f.controller.paneStates().find((pane) => pane.pane === f.side)!;
      expect(sideState.tabs).toEqual([]);
      expect(sideState.documentId).toBeNull();
      // The owner retains save authority: the unique marker reaches storage.
      expect((await f.controller.savePane('main'))?.committed).toBe(true);
      expect(new TextDecoder().decode(await f.app.getVault()!.read(workspacePath('paper.tex'))))
        .toBe('UNSAVED-D009-ONLY-A-UNIQUE');
    } finally {
      await f.controller.dispose(); await f.app.dispose();
    }
  });

  it('clean duplicate open focuses the owner without replacing the session', async () => {
    const f = await setupCrossPane();
    try {
      const editorsBefore = f.latexEditor.spies.length;
      await f.controller.openDocument(f.id, {}, { pane: f.side });
      expect(f.controller.focusedPane).toBe('main');
      expect(f.workspace.getOpenDocument(f.session.document.documentId)).toBe(f.session);
      expect(f.session.state).toBe('open');
      expect(f.latexEditor.spies.length).toBe(editorsBefore);
      expect(f.latexEditor.spies.every((spy) => !spy.destroyed)).toBe(true);
      const sideState = f.controller.paneStates().find((pane) => pane.pane === f.side)!;
      expect(sideState.tabs).toEqual([]);
      expect(sideState.documentId).toBeNull();
    } finally {
      await f.controller.dispose(); await f.app.dispose();
    }
  });

  it('background duplicate open keeps focus and creates no second session', async () => {
    const f = await setupCrossPane();
    try {
      f.controller.focusPane('main');
      // Forget legitimate foreground focus: only a background steal may set
      // these flags again (mirrors workbench-background.spec.ts).
      for (const spy of f.latexEditor.spies) spy.focused = false;
      const editorsBefore = f.latexEditor.spies.length;
      await f.controller.openDocument(f.id, {}, { pane: f.side, preserveFocus: true });
      // Background opens never steal focus — and still must not duplicate
      // the session or touch the target pane.
      expect(f.controller.focusedPane).toBe('main');
      expect(f.workspace.getOpenDocument(f.session.document.documentId)).toBe(f.session);
      expect(f.session.state).toBe('open');
      expect(f.latexEditor.spies.length).toBe(editorsBefore);
      expect(f.latexEditor.spies.every((spy) => !spy.focused)).toBe(true);
      const sideState = f.controller.paneStates().find((pane) => pane.pane === f.side)!;
      expect(sideState.tabs).toEqual([]);
      expect(sideState.documentId).toBeNull();
    } finally {
      await f.controller.dispose(); await f.app.dispose();
    }
  });
});

describe('beside duplicate never leaks an empty leaf', () => {
  async function setupBeside() {
    const markdownEditor = mockEditorProvider(markdownKindId);
    const latexEditor = mockEditorProvider(latexKindId);
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      vaultConfig: {},
      searchService: new InMemorySearchService(),
      documentKinds: [markdownKind, latexKind],
      documentEditorProviders: [markdownEditor, latexEditor],
    });
    const controller = createWorkbenchController(app);
    await controller.initialize({});
    const workspace = app.getWorkspace()!;
    const ref = await workspace.createDocument({
      kindId: latexKindId,
      path: workspacePath('paper.tex'),
      initialModel: latexModel('canonical'),
    });
    const id = String(ref.documentId);
    await controller.openDocument(id, {});
    const session = workspace.getOpenDocument(ref.documentId)!;
    const side = controller.splitPane('main', 'right');
    expect(controller.focusedPane).toBe(side);
    return { app, controller, workspace, id, session, side, latexEditor };
  }

  it('openLinkBeside duplicate keeps pane count stable across repeated clicks', async () => {
    const f = await setupBeside();
    try {
      const panesBefore = f.controller.paneStates().length;
      expect(panesBefore).toBe(2);
      for (let i = 0; i < 3; i += 1) {
        const result = await f.controller.openLinkBeside('paper.tex', { pane: f.side });
        expect(result.documentId).toBe(f.id);
        expect(result.created).toBe(false);
        // redirect: focus ends at the live owner, no second session.
        expect(f.controller.focusedPane).toBe('main');
        expect(f.workspace.getOpenDocument(f.session.document.documentId)).toBe(f.session);
        expect(f.controller.paneStates().length).toBe(panesBefore);
        // No persisted empty leaf beyond the original empty side pane.
        const empties = f.controller.paneStates().filter((pane) => pane.documentId === null);
        expect(empties.length).toBeLessThanOrEqual(1);
        // Return focus to the beside source so the next click repeats the leak.
        f.controller.focusPane(f.side);
      }
      expect(f.controller.paneStates().length).toBe(panesBefore);
      // Sanity: a genuinely new beside target still splits.
      const other = await f.workspace.createDocument({
        kindId: latexKindId,
        path: workspacePath('other.tex'),
        initialModel: latexModel('other'),
      });
      const otherId = String(other.documentId);
      const created = await f.controller.openLinkBeside('other.tex', { pane: 'main' });
      expect(created.documentId).toBe(otherId);
      expect(f.controller.paneStates().length).toBe(panesBefore + 1);
    } finally {
      await f.controller.dispose(); await f.app.dispose();
    }
  });

  it('openResourceTarget openBeside duplicate keeps pane count stable and respects preserveFocus', async () => {
    const f = await setupBeside();
    try {
      const target = f.controller.resourceTargetFor(f.id)!;
      expect(target).not.toBeNull();
      const panesBefore = f.controller.paneStates().length;
      // Foreground beside duplicate: focus ends at the owner, no new leaf.
      const first = await f.controller.openResourceTarget(target, { pane: f.side, openBeside: true });
      expect(first.documentId).toBe(f.id);
      expect(f.controller.focusedPane).toBe('main');
      expect(f.workspace.getOpenDocument(f.session.document.documentId)).toBe(f.session);
      expect(f.controller.paneStates().length).toBe(panesBefore);
      // Background beside duplicate: focus stays where it was.
      f.controller.focusPane(f.side);
      for (const spy of f.latexEditor.spies) spy.focused = false;
      const second = await f.controller.openResourceTarget(target, {
        pane: f.side,
        openBeside: true,
        preserveFocus: true,
      });
      expect(second.documentId).toBe(f.id);
      expect(f.controller.focusedPane).toBe(f.side);
      expect(f.workspace.getOpenDocument(f.session.document.documentId)).toBe(f.session);
      expect(f.latexEditor.spies.every((spy) => !spy.focused)).toBe(true);
      expect(f.controller.paneStates().length).toBe(panesBefore);
    } finally {
      await f.controller.dispose(); await f.app.dispose();
    }
  });

  it('ghost-pane duplicate creates no stray leaf', async () => {
    const f = await setupBeside();
    try {
      const panesBefore = f.controller.paneStates().length;
      const leavesBefore = [...f.controller.leafIds()].sort();
      await f.controller.openDocument(f.id, {}, { pane: 'ghost-pane-xyz' });
      // Redirect to the live owner without materializing the ghost leaf.
      expect(f.controller.focusedPane).toBe('main');
      expect(f.workspace.getOpenDocument(f.session.document.documentId)).toBe(f.session);
      expect(f.controller.paneStates().length).toBe(panesBefore);
      expect([...f.controller.leafIds()].sort()).toEqual(leavesBefore);
      expect(f.controller.leafIds()).not.toContain('ghost-pane-xyz');
    } finally {
      await f.controller.dispose(); await f.app.dispose();
    }
  });

  it('openLinkBeside create-path redirect discards the unused fresh split (race net)', async () => {
    const markdownEditor = mockEditorProvider(markdownKindId);
    const latexEditor = mockEditorProvider(latexKindId);
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      vaultConfig: {},
      searchService: new InMemorySearchService(),
      documentKinds: [markdownKind, latexKind],
      documentEditorProviders: [markdownEditor, latexEditor],
    });
    const controller = createWorkbenchController(app);
    try {
      await controller.initialize({});
      const workspace = app.getWorkspace()!;
      const ref = await workspace.createDocument({
        kindId: markdownKindId,
        path: workspacePath('notes.md'),
        initialModel: markdownModel('# Notes'),
      });
      const id = String(ref.documentId);
      await controller.openDocument(id, {});
      const session = workspace.getOpenDocument(ref.documentId)!;
      const side = controller.splitPane('main', 'right');
      const panesBefore = controller.paneStates().length;
      expect(panesBefore).toBe(2);
      // 'notes.md/' misses link resolution (trailing slash) yet sanitizes to
      // the existing path, so the create-on-click path opens the live
      // document and redirects to the owner: the fresh split it
      // materialized must be discarded, not left as an empty leaf.
      const result = await controller.openLinkBeside('notes.md/', { pane: side });
      expect(result.documentId).toBe(id);
      expect(controller.focusedPane).toBe('main');
      expect(workspace.getOpenDocument(session.document.documentId)).toBe(session);
      expect(controller.paneStates().length).toBe(panesBefore);
      const empties = controller.paneStates().filter((pane) => pane.documentId === null);
      expect(empties.length).toBeLessThanOrEqual(1);
    } finally {
      await controller.dispose(); await app.dispose();
    }
  });
});

describe('splitWithTab and background-split duplicates never leak an empty leaf', () => {
  async function setupLiveLatex() {
    const markdownEditor = mockEditorProvider(markdownKindId);
    const latexEditor = mockEditorProvider(latexKindId);
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      vaultConfig: {},
      searchService: new InMemorySearchService(),
      documentKinds: [markdownKind, latexKind],
      documentEditorProviders: [markdownEditor, latexEditor],
    });
    const controller = createWorkbenchController(app);
    await controller.initialize({});
    const workspace = app.getWorkspace()!;
    const ref = await workspace.createDocument({
      kindId: latexKindId,
      path: workspacePath('paper.tex'),
      initialModel: latexModel('canonical'),
    });
    const id = String(ref.documentId);
    await controller.openDocument(id, {});
    const session = workspace.getOpenDocument(ref.documentId)!;
    return { app, controller, workspace, id, session, latexEditor };
  }

  it('splitWithTab guard: live-active duplicate focuses the owner without a new leaf', async () => {
    const f = await setupLiveLatex();
    try {
      // UI pre-split probe mirrors beside guards: a live duplicate
      // re-opens via the owner lane instead of materializing a fresh leaf.
      expect(f.controller.liveOwnerOf(f.id)).toBe('main');
      const panesBefore = f.controller.paneStates().length;
      expect(panesBefore).toBe(1);
      for (let i = 0; i < 3; i += 1) {
        const live = f.controller.liveOwnerOf(f.id);
        expect(live).toBe('main');
        if (live !== null) {
          await f.controller.openDocument(f.id, {}, { pane: live });
        }
        expect(f.controller.focusedPane).toBe('main');
        expect(f.workspace.getOpenDocument(f.session.document.documentId)).toBe(f.session);
        expect(f.controller.paneStates().length).toBe(panesBefore);
      }
      const empties = f.controller.paneStates().filter((pane) => pane.documentId === null);
      expect(empties).toEqual([]);
    } finally {
      await f.controller.dispose(); await f.app.dispose();
    }
  });

  it('splitWithTab race net: unguarded split plus redirect discards the empty leaf', async () => {
    const f = await setupLiveLatex();
    try {
      // Simulate the pre-fix path (unconditional splitPane + openDocument
      // into the fresh leaf): redirects to the owner, leaving the
      // fresh split strictly empty. The race net must remove it.
      const created = f.controller.splitPane('main', 'right');
      expect(f.controller.paneStates().length).toBe(2);
      await f.controller.openDocument(f.id, {}, { pane: created });
      expect(f.controller.focusedPane).toBe('main');
      expect(f.workspace.getOpenDocument(f.session.document.documentId)).toBe(f.session);
      const beforeDiscard = f.controller.paneStates().find((pane) => pane.pane === created)!;
      expect(beforeDiscard.tabs).toEqual([]);
      expect(beforeDiscard.documentId).toBeNull();
      f.controller.discardRedirectedSplit(created, f.id);
      expect(f.controller.paneStates().length).toBe(1);
      expect(f.controller.leafIds()).not.toContain(created);
      expect(f.controller.focusedPane).toBe('main');
      // Safety: discarding a pane that gained content is a no-op.
      const other = await f.workspace.createDocument({
        kindId: latexKindId,
        path: workspacePath('other.tex'),
        initialModel: latexModel('other'),
      });
      const otherId = String(other.documentId);
      const kept = f.controller.splitPane('main', 'right');
      await f.controller.openDocument(otherId, {}, { pane: kept });
      expect(f.controller.paneStates().length).toBe(2);
      f.controller.discardRedirectedSplit(kept, otherId);
      expect(f.controller.paneStates().length).toBe(2);
      expect(f.controller.leafIds()).toContain(kept);
    } finally {
      await f.controller.dispose(); await f.app.dispose();
    }
  });

  it('background-split guard: live duplicate reuses the owner without a new leaf and preserves focus', async () => {
    const f = await setupLiveLatex();
    try {
      f.controller.focusPane('main');
      for (const spy of f.latexEditor.spies) spy.focused = false;
      const panesBefore = f.controller.paneStates().length;
      // Router background-split resolve probes the live owner first: no
      // idle-leaf search, no splitPane, just the owner lane with
      // preserveFocus so global focus never moves.
      const live = f.controller.liveOwnerOf(f.id);
      expect(live).toBe('main');
      const target = live ?? f.controller.splitPane(f.controller.focusedPane, 'right', { preserveFocus: true });
      expect(target).toBe('main');
      await f.controller.openDocument(f.id, {}, { pane: target, preserveFocus: true });
      expect(f.controller.focusedPane).toBe('main');
      expect(f.workspace.getOpenDocument(f.session.document.documentId)).toBe(f.session);
      expect(f.latexEditor.spies.every((spy) => !spy.focused)).toBe(true);
      expect(f.controller.paneStates().length).toBe(panesBefore);
    } finally {
      await f.controller.dispose(); await f.app.dispose();
    }
  });

  it('inactive-tab split still creates the second tab entry (no live owner)', async () => {
    const markdownEditor = mockEditorProvider(markdownKindId);
    const latexEditor = mockEditorProvider(latexKindId);
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      vaultConfig: {},
      searchService: new InMemorySearchService(),
      documentKinds: [markdownKind, latexKind],
      documentEditorProviders: [markdownEditor, latexEditor],
    });
    const controller = createWorkbenchController(app);
    try {
      await controller.initialize({});
      const workspace = app.getWorkspace()!;
      const first = await workspace.createDocument({
        kindId: latexKindId,
        path: workspacePath('paper.tex'),
        initialModel: latexModel('canonical'),
      });
      const firstId = String(first.documentId);
      const second = await workspace.createDocument({
        kindId: markdownKindId,
        path: workspacePath('notes.md'),
        initialModel: markdownModel('# Notes'),
      });
      const secondId = String(second.documentId);
      await controller.openDocument(firstId, {});
      await controller.openDocument(secondId, {});
      // Main now holds two tabs; the live session is the second document,
      // so the first (inactive) document has no live owner.
      expect(controller.liveOwnerOf(firstId)).toBeNull();
      expect(controller.liveOwnerOf(secondId)).toBe('main');
      const created = controller.splitPane('main', 'right');
      await controller.openDocument(firstId, {}, { pane: created });
      controller.discardRedirectedSplit(created, firstId);
      // The second entry landed in the fresh split: both panes are live
      // with different documents and the split is kept.
      expect(controller.paneStates().length).toBe(2);
      expect(controller.leafIds()).toContain(created);
      const createdState = controller.paneStates().find((pane) => pane.pane === created)!;
      expect(createdState.documentId).toBe(firstId);
      expect(createdState.tabs.some((tab) => tab.documentId === firstId)).toBe(true);
      expect(workspace.getOpenDocument(first.documentId)).not.toBeNull();
      expect(workspace.getOpenDocument(second.documentId)).not.toBeNull();
    } finally {
      await controller.dispose(); await app.dispose();
    }
  });
});
