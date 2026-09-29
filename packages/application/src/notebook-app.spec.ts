/**
 *  composition-root tests: notebooks flow through the same
 * workspace/session/persistence path, the notebook editor is demonstrably
 * replaceable at the generic registry seam, and handwriting recognition
 * stays derived-only until explicitly run.
 */

import { describe, expect, it } from 'vitest';
import { createApp, createWorkbenchController } from './index.js';
import { runNotebookHandwritingRecognition } from './recognition.js';
import {
  HandwritingAwareSearchService,
  InMemorySearchService,
  appendPage,
  emptyNotebook,
  encodeNotebook,
  notebookKind,
  notebookKindId,
  notebookPage,
  markdownKind,
  memoryVaultPlugin,
  textObject,
  workspacePath,
  type NotebookModel,
  type NotebookEditorProvider,
  type DocumentAssetStore,
  type DocumentEditorProvider,
  type NotebookEditorInput,
  type PdfExportRequest,
} from '@froglight/foundation';
import {
  MockHandwritingRecognizer,
  MockNotebookEditorHandle,
  MockNotebookEditorProvider,
  MockPdfProvider,
} from '@froglight/foundation/testing';

function seedModel(): NotebookModel {
  const model = emptyNotebook('Chemistry');
  const page = notebookPage('p1', {
    label: 'Intro',
    template: 'froglight.grid',
  });
  page.surface.objects['t1'] = textObject('t1', {
    x: 8,
    y: 8,
    text: 'valence electrons',
  });
  page.surface.order.push('t1');
  appendPage(model, page);
  return model;
}

describe('application — notebook vertical slice', () => {
  it('creates a seeded notebook through the workbench creation path', async () => {
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      searchService: new InMemorySearchService(),
      documentKinds: [notebookKind],
      documentEditorProviders: [new MockNotebookEditorProvider()],
    });
    const controller = createWorkbenchController(app);

    const ref = await controller.createAndOpen(
      'notes/field.notebook',
      {},
      { kindId: notebookKindId },
    );
    const session = await app
      .getWorkspace()!
      .openDocument<NotebookModel>(ref!.documentId);

    expect(session.model.meta.title).toBe('field');
    expect(session.model.pageOrder).toEqual(['page-1']);
    expect(session.model.pages['page-1']?.kind).toBe('page');
    await session.close();
    await app.dispose();
  });

  it('imports PDF bytes as a uniquely named Notebook through the workbench', async () => {
    let exported: PdfExportRequest | null = null;
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      searchService: new InMemorySearchService(),
      documentKinds: [notebookKind],
      documentEditorProviders: [new MockNotebookEditorProvider()],
      pdfProvider: new MockPdfProvider({
        pages: [
          { geometry: { mediaBox: [0, 0, 612, 792] }, text: [], links: [] },
          { geometry: { mediaBox: [0, 0, 792, 612] }, text: [], links: [] },
        ],
      }),
      pdfExportProvider: {
        async exportNotebook(request) {
          exported = request;
          return { bytes: new Uint8Array([37, 80, 68, 70]), warnings: [] };
        },
      },
    });
    const controller = createWorkbenchController(app);

    const first = await controller.importPdfAsNotebook({
      name: 'Lecture.pdf',
      bytes: new Uint8Array([37, 80, 68, 70]),
    });
    const pdf = await controller.exportNotebookPdf({ mode: 'preserve' });
    const second = await controller.importPdfAsNotebook({
      name: 'Lecture.pdf',
      bytes: new Uint8Array([37, 80, 68, 70]),
    });

    expect(first.pageCount).toBe(2);
    expect(
      controller
        .listDocuments()
        .filter((document) => document.kindId === notebookKindId),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          documentId: first.documentId,
          path: 'Lecture.notebook',
        }),
        expect.objectContaining({
          documentId: second.documentId,
          path: 'Lecture 2.notebook',
        }),
      ]),
    );
    const session = await app
      .getWorkspace()!
      .openDocument<NotebookModel>(first.documentId as never);
    expect(session.model.pageOrder).toHaveLength(2);
    expect(session.model.pages[session.model.pageOrder[0]!]).toMatchObject({
      record: { base: { kind: 'pdf-page', pageIndex: 0 } },
    });
    expect(pdf.filename).toBe('Lecture.pdf');
    expect(pdf.bytes).toEqual(new Uint8Array([37, 80, 68, 70]));
    expect(exported).toMatchObject({
      mode: 'preserve',
      notebook: session.model,
    });
    await session.close();
    await controller.dispose();
    await app.dispose();
  });

  it('creates/opens/edits/saves a notebook through the shared composition', async () => {
    const search = new InMemorySearchService();
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      searchService: search,
      documentKinds: [markdownKind, notebookKind],
      documentEditorProviders: [new MockNotebookEditorProvider()],
    });
    const workspace = app.getWorkspace()!;

    // The notebook editor resolves through the generic registry seam.
    const provider = app.getDocumentEditor(notebookKindId);
    expect(provider?.id).toBe('mock-notebook');

    const ref = await workspace.createDocument({
      kindId: notebookKindId,
      path: workspacePath('notebooks/chem.notebook'),
      initialModel: seedModel(),
    });
    await workspace.rebuildDerivedState();

    const session = await workspace.openDocument<NotebookModel>(ref.documentId);
    const handle = provider!.createEditor({
      session,
      parent: {},
    }) as MockNotebookEditorHandle;
    handle.addStrokeToFirstPage(10, 10);
    handle.addPage('froglight.lined');
    const saved = await session.save();
    expect(saved.committed).toBe(true);

    // Search still sees the stored text projection after edits.
    expect(search.search({ text: 'valence' })[0]?.location.address).toBe('p1');

    // Pages, order, and stroke survive save/reopen.
    const reopened = await workspace.openDocument<NotebookModel>(
      ref.documentId,
    );
    expect(reopened.model.pageOrder).toEqual(['p1', 'page-2']);
    const first = reopened.model.pages['p1'];
    if (!first || first.kind !== 'page')
      throw new Error('expected navigable p1');
    expect(first.surface.order).toEqual(['t1', 'mock-stroke-1']);
    await app.dispose();
  });

  it('swaps the notebook adapter without changing canonical contracts', async () => {
    let firstCalls = 0;
    let secondCalls = 0;
    let firstHandle: MockNotebookEditorHandle | null = null;
    let secondHandle: MockNotebookEditorHandle | null = null;
    const first: NotebookEditorProvider = {
      createEditor(input) {
        firstCalls += 1;
        firstHandle = new MockNotebookEditorProvider().createEditor(input);
        return firstHandle;
      },
    };
    const second: NotebookEditorProvider = {
      createEditor(input) {
        secondCalls += 1;
        secondHandle = new MockNotebookEditorProvider().createEditor(input);
        return secondHandle;
      },
    };
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      searchService: new InMemorySearchService(),
      documentKinds: [notebookKind],
      notebookEditorProvider: first,
    });
    const workspace = app.getWorkspace()!;
    const ref = await workspace.createDocument({
      kindId: notebookKindId,
      path: workspacePath('notebooks/swap.notebook'),
      initialModel: seedModel(),
    });
    const controller = createWorkbenchController(app);
    await controller.openDocument(String(ref.documentId), {});
    firstHandle!.addPage('froglight.lined');
    await controller.saveActive();
    const before = encodeNotebook(firstHandle!.getModelForTest());

    await app.replaceNotebookEditorProvider(second);

    expect(firstCalls).toBe(1);
    expect(secondCalls).toBe(1);
    expect(firstHandle!.destroyed).toBe(true);
    expect(secondHandle).not.toBeNull();
    expect(encodeNotebook(secondHandle!.getModelForTest())).toEqual(before);
    await controller.dispose();
    await app.dispose();
  });

  it('passes the active vault asset capability into the notebook provider', async () => {
    let assets: DocumentAssetStore | null = null;
    const provider: NotebookEditorProvider = {
      createEditor(input) {
        assets = input.assets ?? null;
        return new MockNotebookEditorProvider().createEditor(input);
      },
    };
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      documentKinds: [notebookKind],
      notebookEditorProvider: provider,
    });
    const workspace = app.getWorkspace()!;
    const ref = await workspace.createDocument({
      kindId: notebookKindId,
      path: workspacePath('notebooks/assets.notebook'),
      initialModel: seedModel(),
    });
    const session = await workspace.openDocument<NotebookModel>(ref.documentId);
    app
      .getDocumentEditor(notebookKindId)!
      .createEditor({ session, parent: {} });

    expect(assets).not.toBeNull();
    const first = await assets!.put(new Uint8Array([1, 2, 3]), {
      suggestedName: 'photo.PNG',
    });
    const second = await assets!.put(new Uint8Array([1, 2, 3]), {
      suggestedName: 'other.jpg',
    });
    expect(second).toEqual(first);
    expect(await assets!.read(first.path)).toEqual(new Uint8Array([1, 2, 3]));

    await session.close();
    await app.dispose();
  });

  it('injects assets into a notebook provider registered at the generic seam', async () => {
    let received: DocumentAssetStore | null = null;
    const provider: DocumentEditorProvider = {
      id: 'generic-asset-aware-notebook',
      kindIds: [notebookKindId],
      createEditor(input) {
        received = (input as NotebookEditorInput).assets ?? null;
        return new MockNotebookEditorProvider().createEditor(input);
      },
    };
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      documentKinds: [notebookKind],
      documentEditorProviders: [provider],
    });
    const workspace = app.getWorkspace()!;
    const ref = await workspace.createDocument({
      kindId: notebookKindId,
      path: workspacePath('notebooks/generic-assets.notebook'),
      initialModel: seedModel(),
    });
    const session = await workspace.openDocument<NotebookModel>(ref.documentId);
    app
      .getDocumentEditor(notebookKindId)!
      .createEditor({ session, parent: {} });

    expect(received).not.toBeNull();
    await session.close();
    await app.dispose();
  });

  it('injects a working atomic PDF insertion callback into a generic notebook editor', async () => {
    let received: NotebookEditorInput | null = null;
    const editor: DocumentEditorProvider = {
      id: 'generic-pdf-aware-notebook',
      kindIds: [notebookKindId],
      createEditor(input) {
        received = input as NotebookEditorInput;
        return new MockNotebookEditorProvider().createEditor(input);
      },
    };
    const pdfProvider = new MockPdfProvider({
      pages: [
        { geometry: { mediaBox: [0, 0, 300, 200] }, text: [], links: [] },
      ],
    });
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      documentKinds: [notebookKind],
      documentEditorProviders: [editor],
      pdfProvider,
    });
    const workspace = app.getWorkspace()!;
    const ref = await workspace.createDocument({
      kindId: notebookKindId,
      path: workspacePath('notebooks/pdf-insert.notebook'),
      initialModel: seedModel(),
    });
    const session = await workspace.openDocument<NotebookModel>(ref.documentId);
    app
      .getDocumentEditor(notebookKindId)!
      .createEditor({ session, parent: {} });

    const input = received as NotebookEditorInput | null;
    expect(input?.pdfProvider).toBe(pdfProvider);
    expect(input?.importPdf).toBeTypeOf('function');
    await input!.importPdf!(session.model, new Uint8Array([37, 80, 68, 70]), 1);
    expect(session.model.pageOrder).toHaveLength(2);
    expect(session.model.pages[session.model.pageOrder[1]!]!).toMatchObject({
      kind: 'page',
      record: { base: { kind: 'pdf-page', pageIndex: 0 } },
    });

    await session.close();
    await app.dispose();
  });

  it('indexes recognized handwriting only after the explicit action, derived-only', async () => {
    const aware = new HandwritingAwareSearchService(
      new InMemorySearchService(),
    );
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      searchService: aware,
      documentKinds: [notebookKind],
      documentEditorProviders: [new MockNotebookEditorProvider()],
      handwritingRecognizer: new MockHandwritingRecognizer([
        'recognized words',
      ]),
    });
    const workspace = app.getWorkspace()!;
    const ref = await workspace.createDocument({
      kindId: notebookKindId,
      path: workspacePath('notebooks/hw.notebook'),
      initialModel: seedModel(),
    });
    await workspace.rebuildDerivedState();

    // Nothing derived before the explicit action.
    expect(app.getSearch()!.search({ text: 'recognized' })).toHaveLength(0);

    // Give page one a stroke so the deterministic recognizer has input.
    const session = await workspace.openDocument<NotebookModel>(ref.documentId);
    const handle = app
      .getDocumentEditor(notebookKindId)!
      .createEditor({ session, parent: {} }) as MockNotebookEditorHandle;
    handle.addStrokeToFirstPage(0, 0);
    await session.save();

    const { lines } = await runNotebookHandwritingRecognition(
      app,
      ref.documentId,
    );
    expect(lines).toBeGreaterThan(0);
    const hits = app.getSearch()!.search({ text: 'recognized' });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.location.address).toBe('p1');
    app.getSearch()!.clear();
    expect(app.getSearch()!.search({ text: 'recognized' })).toHaveLength(0);
    await workspace.rebuildDerivedState();
    expect(app.getSearch()!.search({ text: 'recognized' })).toHaveLength(0);
    await app.dispose();
  });
});
