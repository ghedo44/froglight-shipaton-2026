import { describe, expect, it, vi } from 'vitest';
import { createApp } from './index.js';
import {
  asBlockDocumentEditorProvider,
  asNotebookDocumentEditorProvider,
  withApplicationEditorCapabilities,
} from './editor-adapters.js';
import {
  InMemorySearchService,
  InMemorySettingsService,
  InMemoryStylusService,
  createStylusHost,
  blockPageKind,
  blockPageKindId,
  boundedFrame,
  emptyBlockPage,
  emptyNotebook,
  emptySurface,
  infiniteFrame,
  inkPageKind,
  inkPageKindId,
  markdownKind,
  markdownKindId,
  memoryVaultPlugin,
  notebookKind,
  notebookKindId,
  whiteboardKind,
  whiteboardKindId,
  workspacePath,
  type BlockPageEditorProvider,
  type BlockPageModel,
  type DocumentAssetStore,
  type DocumentEditorProvider,
  type MarkdownModel,
  type NotebookEditorInput,
  type NotebookEditorProvider,
  type NotebookModel,
  type PdfProvider,
  type SurfaceModel,
} from '@froglight/foundation';
import {
  MockBlockPageEditorProvider,
  MockHandwritingRecognizer,
  MockInkEditorProvider,
  MockLaTeXProvider,
  MockMarkdownEditorProvider,
  MockNotebookEditorProvider,
  MockPdfProvider,
} from '@froglight/foundation/testing';

function stubAssets(): DocumentAssetStore {
  return {
    put: async (data) =>
      ({ path: `attachments/${data.length}`, sha256: 'hash' }) as never,
    read: async () => new Uint8Array([1]),
  };
}

function stubPdf(): PdfProvider {
  return new MockPdfProvider({
    pages: [{ geometry: { mediaBox: [0, 0, 10, 10] }, text: [], links: [] }],
  });
}

describe('editor adapters — pure typed adaptation', () => {
  it('adapts Markdown dirty bridging without asset wiring', async () => {
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      documentKinds: [markdownKind],
      markdownEditorProvider: new MockMarkdownEditorProvider(),
    });
    const workspace = app.getWorkspace()!;
    const ref = await workspace.createDocument({
      kindId: markdownKindId,
      path: workspacePath('notes/a.md'),
      initialModel: { raw: 'hello' },
    });
    const session = await workspace.openDocument<MarkdownModel>(ref.documentId);
    const provider = app.getDocumentEditor(markdownKindId)!;
    const handle = provider.createEditor({ session, parent: {} });
    (handle as unknown as { replaceAll(text: string): void }).replaceAll('changed');
    expect((session.model as { raw: string }).raw).toBe('changed');
    await session.close();
    await app.dispose();
  });

  it('adapts Block Page model bridging with an injected resolver', async () => {
    let observed: unknown = null;
    const recording: BlockPageEditorProvider = {
      createEditor(input) {
        observed = input.resourceResolver ?? null;
        return new MockBlockPageEditorProvider().createEditor(input);
      },
    };
    const fakeResolver = { search: async () => [] };
    const compositionRegistry = {
      register: () => ({
        dispose() {
          /* test double: nothing to dispose */
        },
      }),
      open: () => {
        throw new Error('unused');
      },
    } as never;
    const blockRegistry = {
      register: () => ({
        dispose() {
          /* test double: nothing to dispose */
        },
      }),
    } as never;
    const adapted = asBlockDocumentEditorProvider(recording, {
      compositionRegistry,
      blockRegistry,
      openResource: () => {
        /* test double: resource opening is unobserved */
      },
      resourceResolver: fakeResolver,
    });
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      documentKinds: [blockPageKind],
      documentEditorProviders: [adapted],
    });
    const workspace = app.getWorkspace()!;
    const ref = await workspace.createDocument({
      kindId: blockPageKindId,
      path: workspacePath('pages/a.blockpage'),
      initialModel: emptyBlockPage({ title: 'A' }),
    });
    const session = await workspace.openDocument<BlockPageModel>(ref.documentId);
    app.getDocumentEditor(blockPageKindId)!.createEditor({ session, parent: {} });
    expect(observed).toBe(fakeResolver);
    await session.close();
    await app.dispose();
  });
});

describe('withApplicationEditorCapabilities matrix', () => {
  it('leaves unrelated kinds untouched (same reference)', () => {
    const provider: DocumentEditorProvider = {
      id: 'markdown-direct',
      kindIds: [markdownKindId],
      createEditor: () => {
        throw new Error('unused');
      },
    };
    const decorated = withApplicationEditorCapabilities(provider, {
      getAssets: () => stubAssets(),
      getPdfProvider: () => stubPdf(),
    });
    expect(decorated).toBe(provider);
  });

  it('injects assets into ink and whiteboard when present', async () => {
    const cases = [
      {
        kindId: inkPageKindId,
        kind: inkPageKind,
        path: 'sketches/a.ink',
        model: emptySurface(boundedFrame(400, 300)),
      },
      {
        kindId: whiteboardKindId,
        kind: whiteboardKind,
        path: 'boards/a.whiteboard',
        model: emptySurface(infiniteFrame()),
      },
    ] as const;
    for (const { kindId, kind, path, model } of cases) {
      const inputs: unknown[] = [];
      const inner: DocumentEditorProvider = {
        id: `rec-${String(kindId)}`,
        kindIds: [kindId],
        createEditor(input) {
          inputs.push(input);
          return new MockInkEditorProvider().createEditor(input as never) as never;
        },
      };
      const assets = stubAssets();
      const decorated = withApplicationEditorCapabilities(inner, {
        getAssets: () => assets,
        getPdfProvider: () => null,
      });
      const app = await createApp({
        vaultPlugin: memoryVaultPlugin,
        documentKinds: [kind],
        documentEditorProviders: [decorated],
      });
      const workspace = app.getWorkspace()!;
      const ref = await workspace.createDocument({
        kindId,
        path: workspacePath(path),
        initialModel: model,
      });
      const session = await workspace.openDocument<SurfaceModel>(ref.documentId);
      app.getDocumentEditor(kindId)!.createEditor({ session, parent: {} });
      expect((inputs[0] as { assets?: unknown }).assets).toBe(assets);
      await session.close();
      await app.dispose();
    }
  });

  it('omits assets for surfaces when the store is absent', () => {    const inputs: unknown[] = [];
    const inner: DocumentEditorProvider = {
      id: 'rec-ink-absent',
      kindIds: [inkPageKindId],
      createEditor(input) {
        inputs.push(input);
        return new MockInkEditorProvider().createEditor(input as never) as never;
      },
    };
    const decorated = withApplicationEditorCapabilities(inner, {
      getAssets: () => null,
      getPdfProvider: () => null,
    });
    decorated.createEditor({
      session: { model: emptySurface(boundedFrame(10, 10)) } as never,
      parent: {},
    });
    expect(inputs[0] as object).not.toHaveProperty('assets');
  });

  it('forwards template editing context through capability decoration', () => {
    const inputs: unknown[] = [];
    const inner: DocumentEditorProvider = {
      id: 'rec-ink-template-context',
      kindIds: [inkPageKindId],
      createEditor(input) {
        inputs.push(input);
        return new MockInkEditorProvider().createEditor(input as never) as never;
      },
    };
    const decorated = withApplicationEditorCapabilities(inner, {
      getAssets: () => null,
      getPdfProvider: () => null,
    });
    decorated.createEditor({
      session: { model: emptySurface(boundedFrame(10, 10)) } as never,
      parent: {},
      context: { kind: 'template', templateId: 'template-1' },
    });
    expect(inputs[0]).toMatchObject({
      context: { kind: 'template', templateId: 'template-1' },
    });
  });

  it('shares one settings service across ink, notebook, and whiteboard editors', () => {
    const settings = new InMemorySettingsService();
    const deps = {
      getAssets: () => null,
      getPdfProvider: () => null,
      getSettings: () => settings,
    };
    for (const kindId of [inkPageKindId, whiteboardKindId, notebookKindId]) {
      const inputs: unknown[] = [];
      const inner: DocumentEditorProvider = {
        id: `rec-settings-${String(kindId)}`,
        kindIds: [kindId],
        createEditor(input) {
          inputs.push(input);
          return new MockInkEditorProvider().createEditor(input as never) as never;
        },
      };
      const decorated = withApplicationEditorCapabilities(inner, deps);
      decorated.createEditor({
        session: { model: emptySurface(boundedFrame(10, 10)) } as never,
        parent: {},
      });
      // One shared service reaches every surface family: user defaults
      // survive page/doc/editor changes without sharing live objects.
      expect(
        (inputs[0] as { presetSettings?: unknown }).presetSettings,
      ).toBe(settings);
    }
    // Absent settings stay absent (memory-only presets).
    const inputs: unknown[] = [];
    const inner: DocumentEditorProvider = {
      id: 'rec-settings-absent',
      kindIds: [inkPageKindId],
      createEditor(input) {
        inputs.push(input);
        return new MockInkEditorProvider().createEditor(input as never) as never;
      },
    };
    const decorated = withApplicationEditorCapabilities(inner, {
      getAssets: () => null,
      getPdfProvider: () => null,
    });
    decorated.createEditor({
      session: { model: emptySurface(boundedFrame(10, 10)) } as never,
      parent: {},
    });
    expect(inputs[0] as object).not.toHaveProperty('presetSettings');
  });

  it('injects one stylus policy into drawing families and leaves text editors untouched', () => {
    const stylusInput = new InMemoryStylusService();
    for (const kindId of [inkPageKindId, whiteboardKindId, notebookKindId, blockPageKindId, markdownKindId]) {
      const createEditor = vi.fn<DocumentEditorProvider['createEditor']>(() => new MockInkEditorProvider().createEditor({
        session: { model: emptySurface(boundedFrame(10, 10)) } as never,
        parent: {},
      }));
      const decorated = withApplicationEditorCapabilities({
        id: 'capture-stylus', kindIds: [kindId], createEditor,
      }, {
        getAssets: () => null,
        getPdfProvider: () => null,
        getStylusInput: () => stylusInput,
      });
      decorated.createEditor({ session: {} as never, parent: {} });
      const input = createEditor.mock.calls[0];
      // The capture uses the generic provider contract at the composition seam.
      expect(input).toBeDefined();
      const drawing = [inkPageKindId, whiteboardKindId, notebookKindId].includes(kindId);
      if (drawing) expect(input?.[0]).toHaveProperty('stylusInput', stylusInput);
      else expect(input?.[0]).not.toHaveProperty('stylusInput');
    }
  });

  it('resolves stylus ownership through the real application bootstrap', async () => {
    const stylus = createStylusHost();
    const inputs: Parameters<DocumentEditorProvider['createEditor']>[0][] = [];
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      documentKinds: [inkPageKind],
      documentEditorProviders: [{
        id: 'capture-stylus-bootstrap',
        kindIds: [inkPageKindId],
        createEditor(input) {
          inputs.push(input);
          return new MockInkEditorProvider().createEditor(input as never);
        },
      }],
      extraPlugins: [stylus.definition],
    });
    try {
      const workspace = app.getWorkspace();
      if (workspace === null) throw new Error('Expected workspace');
      const ref = await workspace.createDocument({
        kindId: inkPageKindId,
        path: workspacePath('scribble.ink'),
        initialModel: emptySurface(boundedFrame(400, 300)),
      });
      const session = await workspace.openDocument<SurfaceModel>(ref.documentId);
      const editor = app.getDocumentEditor(inkPageKindId)?.createEditor({ session, parent: {} });
      expect(inputs[0]?.stylusInput).toBe(stylus.service);
      editor?.destroy();
      await session.close();
    } finally { await app.dispose(); }
  });

  it('wires notebook assets/pdf/import through one path for typed and generic providers', async () => {
    const assets = stubAssets();
    const pdf = stubPdf();
    const deps = { getAssets: () => assets, getPdfProvider: () => pdf };

    const typedHolder: { current: NotebookEditorInput | null } = { current: null };
    const typed: NotebookEditorProvider = {
      createEditor(input) {
        typedHolder.current = input;
        return new MockNotebookEditorProvider().createEditor(input as never) as never;
      },
    };
    const genericHolder: { current: NotebookEditorInput | null } = { current: null };
    const generic: DocumentEditorProvider = {
      id: 'generic-notebook',
      kindIds: [notebookKindId],
      createEditor(input) {
        genericHolder.current = input as NotebookEditorInput;
        return new MockNotebookEditorProvider().createEditor(input);
      },
    };

    const decoratedTyped = withApplicationEditorCapabilities(
      asNotebookDocumentEditorProvider(typed),
      deps,
    );
    const decoratedGeneric = withApplicationEditorCapabilities(generic, deps);

    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      documentKinds: [notebookKind],
    });
    const workspace = app.getWorkspace()!;
    const ref = await workspace.createDocument({
      kindId: notebookKindId,
      path: workspacePath('book.notebook'),
      initialModel: emptyNotebook('T'),
    });
    const session = await workspace.openDocument<NotebookModel>(ref.documentId);
    decoratedTyped.createEditor({ session, parent: {} });
    decoratedGeneric.createEditor({ session, parent: {} });
    const typedInput = typedHolder.current as NotebookEditorInput | null;
    const genericInput = genericHolder.current as NotebookEditorInput | null;
    expect(typedInput?.assets).toBe(assets);
    expect(typedInput?.pdfProvider).toBe(pdf);
    expect(typedInput?.importPdf).toBeTypeOf('function');
    expect(genericInput?.assets).toBe(assets);
    expect(genericInput?.pdfProvider).toBe(pdf);
    expect(genericInput?.importPdf).toBeTypeOf('function');
    await session.close();
    await app.dispose();
  });

  it('injects the vault asset store into blockpage (typed + generic), omits when absent', async () => {
    const assets = stubAssets();
    const deps = { getAssets: () => assets, getPdfProvider: () => null };

    // Typed path: the decorator injects the store into the generic input
    // and the block adapter forwards it to the typed provider.
    const typedSeen: unknown[] = [];
    const typed: BlockPageEditorProvider = {
      createEditor(input) {
        typedSeen.push(input);
        return new MockBlockPageEditorProvider().createEditor(input);
      },
    };
    const fakeResolver = { search: async () => [] };
    const adapted = asBlockDocumentEditorProvider(typed, {
      compositionRegistry: {
        register: () => ({
          dispose() {
            /* test double: nothing to dispose */
          },
        }),
      } as never,
      blockRegistry: {
        register: () => ({
          dispose() {
            /* test double: nothing to dispose */
          },
        }),
      } as never,
      openResource: () => {
        /* test double: resource opening is unobserved */
      },
      resourceResolver: fakeResolver,
    });
    const decoratedTyped = withApplicationEditorCapabilities(adapted, deps);

    // Generic path: a direct blockpage provider receives the store too.
    const genericSeen: unknown[] = [];
    const generic: DocumentEditorProvider = {
      id: 'generic-blockpage',
      kindIds: [blockPageKindId],
      createEditor(input) {
        genericSeen.push(input);
        return new MockInkEditorProvider().createEditor(input as never) as never;
      },
    };
    const decoratedGeneric = withApplicationEditorCapabilities(generic, deps);

    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      documentKinds: [blockPageKind],
    });
    const workspace = app.getWorkspace()!;
    const ref = await workspace.createDocument({
      kindId: blockPageKindId,
      path: workspacePath('pages/assets.blockpage'),
      initialModel: emptyBlockPage({ title: 'Assets' }),
    });
    const session = await workspace.openDocument<BlockPageModel>(ref.documentId);
    decoratedTyped.createEditor({ session, parent: {} });
    decoratedGeneric.createEditor({ session, parent: {} });
    expect((typedSeen[0] as { assets?: unknown }).assets).toBe(assets);
    expect((genericSeen[0] as { assets?: unknown }).assets).toBe(assets);
    // No PDF/settings/import surface leaks into the block path.
    expect(genericSeen[0] as object).not.toHaveProperty('pdfProvider');
    expect(genericSeen[0] as object).not.toHaveProperty('importPdf');
    expect(genericSeen[0] as object).not.toHaveProperty('presetSettings');
    await session.close();
    await app.dispose();

    // Absent store stays absent (the provider fails safe to placeholders).
    const absentSeen: unknown[] = [];
    const absent: DocumentEditorProvider = {
      id: 'blockpage-absent',
      kindIds: [blockPageKindId],
      createEditor(input) {
        absentSeen.push(input);
        return new MockInkEditorProvider().createEditor(input as never) as never;
      },
    };
    const decoratedAbsent = withApplicationEditorCapabilities(absent, {
      getAssets: () => null,
      getPdfProvider: () => null,
    });
    decoratedAbsent.createEditor({
      session: { model: emptyBlockPage({ title: 'X' }) } as never,
      parent: {},
    });
    expect(absentSeen[0] as object).not.toHaveProperty('assets');
  });

  it('notebook importPdf fails cleanly when capabilities are absent', async () => {
    const inner: DocumentEditorProvider = {
      id: 'notebook-absent',
      kindIds: [notebookKindId],
      createEditor(input) {
        return new MockNotebookEditorProvider().createEditor(input);
      },
    };
    const holder: { current: NotebookEditorInput | null } = { current: null };
    const capturing: DocumentEditorProvider = {
      id: 'notebook-capture-absent',
      kindIds: [notebookKindId],
      createEditor(input) {
        holder.current = input as NotebookEditorInput;
        return new MockNotebookEditorProvider().createEditor(input);
      },
    };
    void inner;
    const decorated = withApplicationEditorCapabilities(capturing, {
      getAssets: () => null,
      getPdfProvider: () => null,
    });
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      documentKinds: [notebookKind],
    });
    const workspace = app.getWorkspace()!;
    const ref = await workspace.createDocument({
      kindId: notebookKindId,
      path: workspacePath('absent.notebook'),
      initialModel: emptyNotebook('Absent'),
    });
    const session = await workspace.openDocument<NotebookModel>(ref.documentId);
    decorated.createEditor({ session, parent: {} });
    const captured = holder.current as NotebookEditorInput | null;
    expect(captured?.importPdf).toBeTypeOf('function');
    await expect(
      (captured as NotebookEditorInput).importPdf!(session.model, new Uint8Array([37, 80, 68, 70]), 0),
    ).rejects.toThrow();
    await session.close();
    await app.dispose();
  });
});

describe('application composition — regressions', () => {
  it('retained notebook importPdf uses the fresh PDF provider after replacement', async () => {
    const firstPdf = new MockPdfProvider({
      pages: [{ geometry: { mediaBox: [0, 0, 100, 100] }, text: [], links: [] }],
    });
    const secondPdf = new MockPdfProvider({
      pages: [
        { geometry: { mediaBox: [0, 0, 100, 100] }, text: [], links: [] },
        { geometry: { mediaBox: [0, 0, 200, 200] }, text: [], links: [] },
      ],
    });
    const holder: { current: NotebookEditorInput['importPdf'] } = { current: undefined };
    const capturing: DocumentEditorProvider = {
      id: 'capture-notebook',
      kindIds: [notebookKindId],
      createEditor(input) {
        holder.current = (input as NotebookEditorInput).importPdf;
        return new MockNotebookEditorProvider().createEditor(input);
      },
    };
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      searchService: new InMemorySearchService(),
      documentKinds: [notebookKind],
      documentEditorProviders: [capturing],
      pdfProvider: firstPdf,
    });
    const workspace = app.getWorkspace()!;
    const ref = await workspace.createDocument({
      kindId: notebookKindId,
      path: workspacePath('books/replace.notebook'),
      initialModel: emptyNotebook('Replace'),
    });
    const session = await workspace.openDocument<NotebookModel>(ref.documentId);
    app.getDocumentEditor(notebookKindId)!.createEditor({ session, parent: {} });
    const capturedImport = holder.current;
    expect(capturedImport).toBeTypeOf('function');

    await app.replacePdfProvider(secondPdf);
    // The retained callback must use the fresh 2-page provider, not the stale 1-page one.
    // Note: the mock notebook editor seeds one page on empty models, so fresh gives 1 + 2 = 3.
    await (capturedImport as NonNullable<typeof capturedImport>)(session.model, new Uint8Array([37, 80, 68, 70]), 0);
    expect(session.model.pageOrder).toHaveLength(3);
    await session.close();
    await app.dispose();
  });

  it('two app instances do not overwrite one another probe state', async () => {
    const firstRecognizer = new MockHandwritingRecognizer(['one']);
    const secondRecognizer = new MockHandwritingRecognizer(['two']);
    const first = await createApp({
      vaultPlugin: memoryVaultPlugin,
      handwritingRecognizer: firstRecognizer,
    });
    const second = await createApp({
      vaultPlugin: memoryVaultPlugin,
      handwritingRecognizer: secondRecognizer,
    });
    expect(first.getHandwritingRecognizer()).toBe(firstRecognizer);
    expect(second.getHandwritingRecognizer()).toBe(secondRecognizer);
    await first.dispose();
    // Disposing the first app must not clear the second app's capture.
    expect(second.getHandwritingRecognizer()).toBe(secondRecognizer);
    await second.dispose();
  });

  it('markdown/notebook/pdf/latex replacements share one lifecycle (no duplicates)', async () => {
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      searchService: new InMemorySearchService(),
      documentKinds: [markdownKind, notebookKind],
      markdownEditorProvider: new MockMarkdownEditorProvider(),
      notebookEditorProvider: new MockNotebookEditorProvider(),
      pdfProvider: stubPdf(),
      latexProvider: new MockLaTeXProvider(),
    });
    const onNotebook = vi.fn();
    app.onNotebookEditorProviderChange?.(onNotebook);

    await app.replaceMarkdownEditorProvider(new MockMarkdownEditorProvider());
    expect(app.getDocumentEditor(markdownKindId)).not.toBeNull();

    await app.replaceNotebookEditorProvider(new MockNotebookEditorProvider());
    expect(app.getDocumentEditor(notebookKindId)).not.toBeNull();
    expect(onNotebook).toHaveBeenCalled();

    const freshPdf = stubPdf();
    await app.replacePdfProvider(freshPdf);
    expect(app.getPdfProvider()).toBe(freshPdf);

    const freshLatex = new MockLaTeXProvider();
    await app.replaceLatexProvider(freshLatex);
    expect(app.getLatexProvider()).toBe(freshLatex);

    await app.replaceLatexProvider(null);
    expect(app.getLatexProvider()).toBeNull();

    const slots = app.runtime.inspect().slots;
    const ids = slots.map((slot) => slot.id);
    expect(new Set(ids).size).toBe(ids.length);
    await app.dispose();
  });
});
