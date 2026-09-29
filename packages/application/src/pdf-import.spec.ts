import { describe, expect, it } from 'vitest';
import {
  appendPage,
  emptyNotebook,
  notebookPage,
  sha256Hex,
  workspacePath,
  InMemorySearchService,
  documentId,
  resourceId,
  type DocumentAssetStore,
  type PdfProvider,
} from '@froglight/foundation';
import { MockPdfProvider } from '@froglight/foundation/testing';
import {
  importPdfAsNotebook,
  insertPdfIntoNotebook,
  mapPdfLinkToNotebook,
  projectPdfSourceText,
  indexPdfBackedNotebookSource,
  indexStandalonePdfSource,
} from './pdf-import.js';

function provider(): PdfProvider {
  return new MockPdfProvider({
    pages: [
      {
        geometry: { mediaBox: [0, 0, 612, 792] },
        text: [{ text: 'first source page' }],
        links: [{ kind: 'page', pageIndex: 1 }],
      },
      {
        geometry: {
          mediaBox: [0, 0, 800, 600],
          cropBox: [100, 50, 700, 550],
          userUnit: 2,
          rotate: 90,
        },
        text: [{ text: 'second source page' }],
        links: [],
      },
    ],
    outline: [{ id: 'chapter', title: 'Chapter', pageIndex: 1, children: [] }],
  });
}

class RecordingAssets implements DocumentAssetStore {
  readonly stored = new Map<string, Uint8Array>();
  puts = 0;

  async put(data: Uint8Array) {
    this.puts += 1;
    const sha256 = await sha256Hex(data);
    const path = workspacePath(`attachments/${sha256}`);
    this.stored.set(path, data.slice());
    return { path, sha256 };
  }

  async read(path: ReturnType<typeof workspacePath>) {
    const value = this.stored.get(path);
    if (value === undefined) throw new Error('missing');
    return value.slice();
  }
}

describe('PDF import application operation', () => {
  it('imports one content-addressed asset into multiple mixed-size v2 pages', async () => {
    const assets = new RecordingAssets();
    const source = new Uint8Array([37, 80, 68, 70, 1, 2, 3]);
    let next = 0;
    const imported = await importPdfAsNotebook({
      bytes: source,
      provider: provider(),
      assets,
      title: 'Lecture',
      createPageId: () => `page-${++next}`,
    });

    expect(assets.puts).toBe(1);
    expect(imported.notebook.formatVersion).toBe(1);
    expect(imported.notebook.pageOrder).toEqual(['page-1', 'page-2']);
    const first = imported.notebook.pages['page-1'];
    const second = imported.notebook.pages['page-2'];
    expect(first).toMatchObject({
      kind: 'page',
      record: {
        base: { kind: 'pdf-page', pageIndex: 0, pageBox: { widthPt: 612, heightPt: 792 } },
      },
    });
    expect(second).toMatchObject({
      kind: 'page',
      record: {
        base: { kind: 'pdf-page', pageIndex: 1, pageBox: { widthPt: 1000, heightPt: 1200 } },
      },
    });
    const firstAsset = first?.kind === 'page' ? first.record.base : null;
    const secondAsset = second?.kind === 'page' ? second.record.base : null;
    expect(firstAsset).toEqual(expect.objectContaining({ asset: expect.any(Object) }));
    expect(secondAsset).toEqual(expect.objectContaining({ asset: (firstAsset as any).asset }));
    expect(imported.outline).toEqual([
      { id: 'chapter', title: 'Chapter', pageIndex: 1, pageId: 'page-2', children: [] },
    ]);
    expect(source).toEqual(new Uint8Array([37, 80, 68, 70, 1, 2, 3]));
  });

  it('stages an insertion completely before mutating an existing Notebook', async () => {
    const assets = new RecordingAssets();
    const model = emptyNotebook('Mixed');
    appendPage(model, notebookPage('blank'));
    const before = JSON.stringify(model);
    const failing: PdfProvider = {
      async open() {
        return {
          pageCount: 2,
          getPageInfo: async (index) => {
            if (index === 1) throw new Error('page failed');
            return (await provider().open({ bytes: new Uint8Array([1]) })).getPageInfo(0);
          },
          getPageText: async () => ({ kind: 'source', items: [] }),
          getOutline: async () => [],
          getLinks: async () => [],
          close: async () => undefined,
        };
      },
    };
    await expect(
      insertPdfIntoNotebook({
        notebook: model,
        bytes: new Uint8Array([1]),
        provider: failing,
        assets,
        at: 1,
        createPageId: (pageIndex) => `pdf-${pageIndex}`,
      }),
    ).rejects.toThrow('page failed');
    expect(JSON.stringify(model)).toBe(before);
  });

  it('inserts selected pages at an explicit boundary and maps only imported destinations', async () => {
    const assets = new RecordingAssets();
    const model = emptyNotebook();
    appendPage(model, notebookPage('before'));
    appendPage(model, notebookPage('after'));
    const inserted = await insertPdfIntoNotebook({
      notebook: model,
      bytes: new Uint8Array([9, 8, 7]),
      provider: provider(),
      assets,
      selectedPageIndexes: [1],
      at: 1,
      createPageId: () => 'pdf-page',
    });
    expect(model.pageOrder).toEqual(['before', 'pdf-page', 'after']);
    expect(inserted.sourcePageIds).toEqual(new Map([[1, 'pdf-page']]));
    expect(mapPdfLinkToNotebook({ kind: 'page', pageIndex: 1 }, inserted.sourcePageIds)).toEqual({
      kind: 'notebook-page',
      pageId: 'pdf-page',
    });
    expect(mapPdfLinkToNotebook({ kind: 'page', pageIndex: 0 }, inserted.sourcePageIds)).toEqual({
      kind: 'source-page',
      pageIndex: 0,
    });
  });

  it('rejects substituted asset bytes before opening the provider', async () => {
    const assets = new RecordingAssets();
    let opened = 0;
    const guarded: PdfProvider = {
      open: async (input) => {
        opened += 1;
        return provider().open(input);
      },
    };
    const originalPut = assets.put.bind(assets);
    assets.put = async (bytes) => {
      const stored = await originalPut(bytes);
      assets.stored.set(stored.path, new Uint8Array([0]));
      return stored;
    };
    await expect(
      importPdfAsNotebook({ bytes: new Uint8Array([1, 2]), provider: guarded, assets }),
    ).rejects.toMatchObject({ code: 'PDF_ASSET_INTEGRITY' });
    expect(opened).toBe(0);
  });

  it('rebuilds page-addressed source text without writing it into Notebook bytes', async () => {
    const assets = new RecordingAssets();
    const imported = await importPdfAsNotebook({
      bytes: new Uint8Array([3, 2, 1]),
      provider: provider(),
      assets,
      createPageId: (index) => `p-${index}`,
    });
    const canonicalBefore = JSON.stringify(imported.notebook);
    const projection = await projectPdfSourceText({
      notebook: imported.notebook,
      provider: provider(),
      assets,
    });
    expect(projection).toEqual([
      { pageId: 'p-0', text: 'first source page', authority: 'pdf-source' },
      { pageId: 'p-1', text: 'second source page', authority: 'pdf-source' },
    ]);
    expect(JSON.stringify(imported.notebook)).toBe(canonicalBefore);
  });

  it('rebuilds standalone and Notebook PDF text into page-addressed search results', async () => {
    const search = new InMemorySearchService();
    const pdfDocumentId = documentId('pdf-search');
    const pdfLocation = { resourceId: resourceId('pdf-resource') };
    await indexStandalonePdfSource({
      documentId: pdfDocumentId,
      location: pdfLocation,
      bytes: new Uint8Array([1]),
      provider: provider(),
      search,
    });
    expect(search.search({ text: 'second' })[0]?.location.address).toBe('1');

    search.clear();
    const assets = new RecordingAssets();
    const imported = await importPdfAsNotebook({
      bytes: new Uint8Array([4, 5, 6]),
      provider: provider(),
      assets,
      createPageId: (index) => `page-${index}`,
    });
    const first = imported.notebook.pages['page-0'];
    if (first?.kind !== 'page') throw new Error('expected first imported page');
    first.surface.objects.note = {
      id: 'note',
      type: 'froglight.text',
      x: 1,
      y: 1,
      text: 'canonical overlay words',
    };
    first.surface.order.push('note');
    const notebookDocumentId = documentId('notebook-search');
    await indexPdfBackedNotebookSource({
      documentId: notebookDocumentId,
      location: { resourceId: resourceId('notebook-resource') },
      notebook: imported.notebook,
      provider: provider(),
      assets,
      search,
    });
    expect(search.search({ text: 'canonical' })[0]?.location.address).toBe('page-0');
    expect(search.search({ text: 'second' })[0]?.location.address).toBe('page-1');
    search.clear();
    expect(search.search({ text: 'second' })).toEqual([]);
    await indexPdfBackedNotebookSource({
      documentId: notebookDocumentId,
      location: { resourceId: resourceId('notebook-resource') },
      notebook: imported.notebook,
      provider: provider(),
      assets,
      search,
    });
    expect(search.search({ text: 'second' })[0]?.location.address).toBe('page-1');
  });

  it('does not invent selectable text for image-only pages', async () => {
    const imageOnly = new MockPdfProvider({
      pages: [{ geometry: { mediaBox: [0, 0, 100, 100] }, text: [], links: [] }],
    });
    const handle = await imageOnly.open({ bytes: new Uint8Array([1]) });
    expect((await handle.getPageInfo(0)).hasSourceText).toBe(false);
    expect(await handle.getPageText(0)).toEqual({ kind: 'source', items: [] });
    await handle.close();
  });
});
