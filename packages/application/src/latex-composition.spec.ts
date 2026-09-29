/**
 * Application-level tests for the LaTeX seam.
 *
 * Covers: provider slot lifecycle (activate → 1, dispose → 0, reactivate → 1),
 * composition placeholder on provider loss with a stable reference, the
 * structure-summary ready state, label-addressed transclusion placeholders,
 * the resolver factory, and provider replacement without touching canonical
 * bytes.
 */
import { describe, expect, it } from 'vitest';
import {
  latexKind,
  latexKindId,
  latexModel,
  memoryVaultPlugin,
  workspacePath,
  type CompositionHandle,
  type CompositionSnapshot,
  type LaTeXModel,
  type LaTeXProvider,
  type LaTeXDocumentHandle,
  type LaTeXRenderResult,
  type DocumentSession,
  type DocumentEditorProvider,
  type DocumentReaderProvider,
  type LaTeXSourceResolver,
} from '@froglight/foundation';
import { MockLaTeXProvider } from '@froglight/foundation/testing';
import { createApp, createWorkbenchController, createLaTeXSourceResolver } from './index.js';

async function settled(
  handle: CompositionHandle,
): Promise<CompositionSnapshot> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const snapshot = handle.snapshot();
    if (snapshot.state !== 'loading') return snapshot;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  return handle.snapshot();
}

const ENTRY = [
  '\\documentclass{article}',
  '\\title{Thesis Notes}',
  '\\begin{document}',
  '\\maketitle',
  '\\section{Intro}\\label{sec:intro}',
  'Hello \\cite{knuth84}.',
  '\\section{Method}',
  'Body.',
  '\\end{document}',
].join('\n');

async function makeApp(latexProvider: unknown) {
  const app = await createApp({
    vaultPlugin: memoryVaultPlugin,
    documentKinds: [latexKind],
    ...(latexProvider !== undefined ? { latexProvider: latexProvider as never } : {}),
  });
  const workspace = app.getWorkspace()!;
  const doc = await workspace.createDocument({
    kindId: latexKindId,
    path: workspacePath('papers/thesis.tex'),
    initialModel: latexModel(ENTRY),
  });
  return { app, workspace, doc };
}

describe('application — LaTeX composition seam', () => {
  it('renders a structure summary ready state when the provider is bound', async () => {
    const { app, workspace, doc } = await makeApp(new MockLaTeXProvider());
    const registry = app.getCompositionRegistry();
    const handle = registry.open({
      role: 'preview',
      target: {
        documentId: doc.documentId,
        kindId: latexKindId,
        resourceId: doc.location.resourceId,
      },
    });
    const snapshot = await settled(handle);
    handle.dispose();
    expect(snapshot.state).toBe('ready');
    if (snapshot.state !== 'ready') return;
    expect(snapshot.title).toBe('Thesis Notes');
    expect(snapshot.summary).toContain('2 sections');
    expect(snapshot.summary).toContain('1 citation');
    expect(snapshot.items?.map((item) => item.text)).toEqual(['Intro', 'Method']);
    expect(workspace).toBeDefined();
  });

  it('degrades to a recoverable missing-provider placeholder when the provider is unbound', async () => {
    const { app, doc } = await makeApp(undefined);
    const registry = app.getCompositionRegistry();
    const handle = registry.open({
      role: 'preview',
      target: {
        documentId: doc.documentId,
        kindId: latexKindId,
        resourceId: doc.location.resourceId,
      },
    });
    const snapshot = await settled(handle);
    handle.dispose();
    expect(snapshot.state).toBe('placeholder');
    if (snapshot.state !== 'placeholder') return;
    expect(snapshot.reason).toBe('missing-provider');
    expect(snapshot.recoverable).toBe(true);
    expect(snapshot.actions?.some((action) => action.id === 'open-source')).toBe(true);
  });

  it('keeps the stable reference when the provider is replaced with null and restored', async () => {
    const { app, doc } = await makeApp(new MockLaTeXProvider());
    const registry = app.getCompositionRegistry();
    const target = {
      documentId: doc.documentId,
      kindId: latexKindId,
      resourceId: doc.location.resourceId,
    };
    const before = await settled(registry.open({ role: 'preview', target }));
    expect(before.state).toBe('ready');

    await app.replaceLatexProvider(null);
    const during = await settled(registry.open({ role: 'preview', target }));
    expect(during.state).toBe('placeholder');
    if (during.state === 'placeholder') expect(during.reason).toBe('missing-provider');

    await app.replaceLatexProvider(new MockLaTeXProvider({ html: '<p>new</p>' }));
    const after = await settled(registry.open({ role: 'preview', target }));
    expect(after.state).toBe('ready');

    // Canonical bytes untouched by all the provider churn.
    const read = await app.getWorkspace()!.readDocument<LaTeXModel>(doc.documentId);
    expect(read.model.raw).toBe(ENTRY);
  });

  it('renders label-addressed transclusions as recoverable placeholders', async () => {
    const { app, doc } = await makeApp(new MockLaTeXProvider());
    const registry = app.getCompositionRegistry();
    const target = {
      documentId: doc.documentId,
      kindId: latexKindId,
      resourceId: doc.location.resourceId,
      address: 'sec:intro',
    };
    const known = await settled(registry.open({ role: 'transclusion', target }));
    expect(known.state).toBe('placeholder');
    if (known.state === 'placeholder') {
      expect(known.reason).toBe('unsupported-address');
      expect(known.message).toContain('sec:intro');
    }

    const unknown = await settled(
      registry.open({
        role: 'transclusion',
        target: { ...target, address: 'nope' },
      }),
    );
    expect(unknown.state).toBe('placeholder');
    if (unknown.state === 'placeholder') {
      expect(unknown.message).toContain('not defined');
    }
  });
});

describe('createLaTeXSourceResolver', () => {
  it('reads sibling files through the vault and rejects workspace escape', async () => {
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      documentKinds: [latexKind],
    });
    const workspace = app.getWorkspace()!;
    await workspace.createDocument({
      kindId: latexKindId,
      path: workspacePath('papers/thesis.tex'),
      initialModel: latexModel(ENTRY),
    });
    await workspace.createDocument({
      kindId: latexKindId,
      path: workspacePath('papers/chapters/one.tex'),
      initialModel: latexModel('chapter one'),
    });
    const resolver: LaTeXSourceResolver = createLaTeXSourceResolver({
      vault: app.getVault()!,
      documentPath: 'papers/thesis.tex',
    });
    await expect(resolver.readFile('chapters/one.tex')).resolves.toBe('chapter one');
    // `..` that stays inside the workspace is legal (NOT_FOUND surfaces as MISSING).
    await expect(resolver.readFile('../secrets.tex')).rejects.toMatchObject({
      code: 'LATEX_RESOLVE_MISSING',
    });
    // Only escaping above the workspace root is denied.
    await expect(resolver.readFile('../../secrets.tex')).rejects.toMatchObject({
      code: 'LATEX_RESOLVE_DENIED',
    });
    await expect(resolver.readFile('ghost.tex')).rejects.toMatchObject({
      code: 'LATEX_RESOLVE_MISSING',
    });
    await app.dispose();
  });

  it('serves asset urls through the host factory and rejects non-image types', async () => {
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      documentKinds: [latexKind],
    });
    const workspace = app.getWorkspace()!;
    await workspace.createDocument({
      kindId: latexKindId,
      path: workspacePath('papers/thesis.tex'),
      initialModel: latexModel(ENTRY),
    });
    await app.getVault()!.write(
      workspacePath('papers/fig.png'),
      new Uint8Array([137, 80, 78, 71]),
    );
    await app.getVault()!.write(
      workspacePath('papers/data.zip'),
      new Uint8Array([1, 2, 3]),
    );
    const resolver: LaTeXSourceResolver = createLaTeXSourceResolver({
      vault: app.getVault()!,
      documentPath: 'papers/thesis.tex',
      createAssetUrl: (bytes, mime) => `blob:mock/${bytes.length}/${mime}`,
    });
    await expect(resolver.assetUrl('fig.png')).resolves.toBe('blob:mock/4/image/png');
    await expect(resolver.assetUrl('data.zip')).rejects.toMatchObject({
      code: 'LATEX_UNSUPPORTED_COMMAND',
    });
    await app.dispose();
  });
});


describe('live document render capability replacement', () => {
  for (const replacement of ['withdraw', 'replace'] as const) {
  for (const pending of ['open', 'render', 'idle'] as const) {
    it(`invalidates ${pending} projections immediately on capability ${replacement} and recovers`, async () => {
      let resolveOpen!: (handle: LaTeXDocumentHandle) => void;
      let resolveRender!: (result: LaTeXRenderResult) => void;
      const opening = new Promise<LaTeXDocumentHandle>(resolve => { resolveOpen = resolve; });
      const rendering = new Promise<LaTeXRenderResult>(resolve => { resolveRender = resolve; });
      let closes = 0;
      const oldHandle = (): LaTeXDocumentHandle => ({
        render: async () => pending === 'render' ? rendering : { html: 'OLD', diagnostics: [] },
        close: async () => { closes++; },
      });
      const old: LaTeXProvider = {
        open: async () => pending === 'open' ? opening : oldHandle(),
      };
      const fresh = new MockLaTeXProvider({ html: 'NEW' });
      const outputs = { editor: '', reader: '' };
      const live = { editor: 0, reader: 0 };
      const sessions: DocumentSession[] = [];
      let updates = 0;
      const jobs: Promise<void>[] = [];
      // Small alternate providers exercise the controller's composition seam;
      // individual reader/editor tests independently prove asynchronous fencing.
      function projection(which: 'editor' | 'reader', session: DocumentSession) {
        sessions.push(session);
        live[which]++;
        let destroyed = false;
        let owned: LaTeXDocumentHandle | null = null;
        const provider = app.getLatexProvider();
        outputs[which] = provider === null ? 'unavailable' : 'pending';
        if (provider !== null) jobs.push((async () => {
          const handle = await provider.open({
            entry: (session.model as LaTeXModel).raw,
            resolve: { readFile: async () => '', assetUrl: async () => 'blob:test' },
          });
          if (destroyed) { await handle.close(); return; }
          owned = handle;
          const result = await handle.render();
          if (!destroyed) outputs[which] = result.html;
        })());
        return {
          destroy() {
            expect(destroyed).toBe(false);
            destroyed = true;
            live[which]--;
            if (owned !== null) void owned.close();
          },
        };
      }
      const editor: DocumentEditorProvider = {
        id: 'render-capability-editor', kindIds: [latexKindId],
        createEditor({ session }) {
          return { ...projection('editor', session), focus() { /* headless */ }, hasFocus: () => false, execCommand: () => false };
        },
      };
      const reader: DocumentReaderProvider = {
        id: 'render-capability-reader', kindIds: [latexKindId],
        createReader({ session }) { return { ...projection('reader', session), update() { updates++; } }; },
      };
      const app = await createApp({
        vaultPlugin: memoryVaultPlugin, documentKinds: [latexKind], latexProvider: old,
        documentEditorProviders: [editor], documentReaderProviders: [reader],
      });
      const workspace = app.getWorkspace()!;
      const ref = await workspace.createDocument({ kindId: latexKindId, path: workspacePath('render.tex'), initialModel: latexModel('stored') });
      const c = createWorkbenchController(app);
      await c.openDocument(String(ref.documentId), {});
      c.setReaderHost('main', {});
      c.setTabMode('main', String(ref.documentId), 'split');
      const session = sessions[0]!;
      (session.model as { raw: string }).raw = 'unsaved';
      session.markDirty();
      // Let currently scheduled opens enter render without arbitrary timers.
      await Promise.resolve(); await Promise.resolve();
      if (pending === 'idle') await Promise.all(jobs);
      try {
        const withdrawal = app.replaceLatexProvider(replacement === 'withdraw' ? null : fresh);
        // Invalidate synchronously, BEFORE slot-removal awaits can settle old work.
        expect(app.getLatexProvider()).toBeNull();
        expect(outputs).toEqual({ editor: 'unavailable', reader: 'unavailable' });
        await withdrawal;
        expect(live).toEqual({ editor: 1, reader: 1 });
        if (replacement === 'withdraw') await app.replaceLatexProvider(fresh);
        expect(app.getLatexProvider()).toBe(fresh);
        resolveOpen(oldHandle());
        resolveRender({ html: 'OLD', diagnostics: [] });
        await Promise.all(jobs);
        expect(outputs).toEqual({ editor: 'NEW', reader: 'NEW' });
        expect(closes).toBe(2);
        expect(fresh.activeHandleCountForTest()).toBe(2);
        expect(c.tabMode('main')).toBe('split');
        expect(new Set(sessions)).toEqual(new Set([session]));
        expect((session.model as { raw: string }).raw).toBe('unsaved');
        expect(session.dirty).toBe(true);
        const before = updates;
        session.markDirty();
        expect(updates).toBe(before + 1);
        await c.dispose();
        expect(live).toEqual({ editor: 0, reader: 0 });
        expect(fresh.activeHandleCountForTest()).toBe(0);
      } finally {
        resolveOpen(oldHandle()); resolveRender({ html: 'OLD', diagnostics: [] });
        await Promise.all(jobs); await c.dispose(); await app.dispose();
      }
    });
  }
  }
});
