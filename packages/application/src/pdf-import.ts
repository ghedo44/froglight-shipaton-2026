import {
  FroglightError,
  baseOf,
  emptyNotebook,
  isNavigablePage,
  isWorkspacePath,
  pdfNotebookPage,
  projectNotebookForSearch,
  NOTEBOOK_LIMITS,
  sha256Hex,
  type DocumentAssetStore,
  type NotebookModel,
  type NotebookPage,
  type PdfLink,
  type PdfOutlineEntry,
  type PdfProvider,
  type StoredAsset,
  type DocumentId,
  type DocumentLocation,
  type SearchService,
} from '@froglight/foundation';

export interface ImportedPdfOutlineEntry extends PdfOutlineEntry {
  readonly pageId?: string;
  readonly children: readonly ImportedPdfOutlineEntry[];
}

export interface PdfNotebookImportResult {
  readonly notebook: NotebookModel;
  readonly asset: StoredAsset;
  readonly sourcePageIds: ReadonlyMap<number, string>;
  readonly outline: readonly ImportedPdfOutlineEntry[];
}

export interface PdfImportOptions {
  readonly bytes: Uint8Array;
  readonly provider: PdfProvider;
  readonly assets: DocumentAssetStore;
  readonly password?: string;
  readonly selectedPageIndexes?: readonly number[];
  readonly createPageId?: (pageIndex: number, selectedIndex: number) => string;
  readonly signal?: AbortSignal;
}

function importError(code: 'PDF_ASSET_INTEGRITY' | 'PDF_PAGE_OUT_OF_RANGE' | 'PDF_RESOURCE_LIMIT', message: string): FroglightError {
  return new FroglightError(code, message);
}

async function ingestVerifiedAsset(
  bytes: Uint8Array,
  assets: DocumentAssetStore,
): Promise<{ readonly asset: StoredAsset; readonly storedBytes: Uint8Array }> {
  const asset = await assets.put(bytes, { suggestedName: 'source.pdf' });
  const storedBytes = await assets.read(asset.path);
  const actual = await sha256Hex(storedBytes);
  if (actual !== asset.sha256) {
    throw importError(
      'PDF_ASSET_INTEGRITY',
      `stored PDF asset hash ${actual} does not match ${asset.sha256}`,
    );
  }
  return { asset, storedBytes };
}

function selectedIndexes(pageCount: number, requested?: readonly number[]): number[] {
  const values = requested === undefined
    ? Array.from({ length: pageCount }, (_, pageIndex) => pageIndex)
    : [...new Set(requested)].sort((a, b) => a - b);
  for (const pageIndex of values) {
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pageCount) {
      throw importError('PDF_PAGE_OUT_OF_RANGE', `PDF page ${pageIndex} is out of range`);
    }
  }
  return values;
}

function freshPageId(pageIndex: number): string {
  const random = globalThis.crypto?.getRandomValues(new Uint32Array(1))[0] ?? pageIndex;
  return `pdf-${pageIndex}-${random.toString(36)}`;
}

function mapOutline(
  entries: readonly PdfOutlineEntry[],
  pageIds: ReadonlyMap<number, string>,
): ImportedPdfOutlineEntry[] {
  return entries.map((entry) => ({
    ...entry,
    ...(entry.pageIndex !== undefined && pageIds.has(entry.pageIndex)
      ? { pageId: pageIds.get(entry.pageIndex)! }
      : {}),
    children: mapOutline(entry.children, pageIds),
  }));
}

export async function insertPdfIntoNotebook(
  options: PdfImportOptions & {
    readonly notebook: NotebookModel;
    /** Boundary in canonical pageOrder, from 0 through pageOrder.length. */
    readonly at: number;
  },
): Promise<PdfNotebookImportResult> {
  if (!Number.isInteger(options.at) || options.at < 0 || options.at > options.notebook.pageOrder.length) {
    throw new RangeError('PDF insertion boundary is outside Notebook pageOrder');
  }
  const { asset, storedBytes } = await ingestVerifiedAsset(options.bytes, options.assets);
  const handle = await options.provider.open({
    bytes: storedBytes,
    ...(options.password !== undefined ? { password: options.password } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
  try {
    const indexes = selectedIndexes(handle.pageCount, options.selectedPageIndexes);
    if (Object.keys(options.notebook.pages).length + indexes.length > NOTEBOOK_LIMITS.maxPages) {
      throw importError('PDF_RESOURCE_LIMIT', `PDF import exceeds the Notebook page limit (${NOTEBOOK_LIMITS.maxPages})`);
    }
    const staged: NotebookPage[] = [];
    const sourcePageIds = new Map<number, string>();
    for (let selectedIndex = 0; selectedIndex < indexes.length; selectedIndex += 1) {
      const pageIndex = indexes[selectedIndex]!;
      const info = await handle.getPageInfo(pageIndex, options.signal);
      const id = options.createPageId?.(pageIndex, selectedIndex) ?? freshPageId(pageIndex);
      if (id === '' || options.notebook.pages[id] !== undefined || staged.some((page) => page.id === id)) {
        throw new Error(`PDF import produced duplicate or invalid Notebook page id: ${id}`);
      }
      staged.push(
        pdfNotebookPage(id, {
          asset,
          pageIndex,
          pageBox: info.geometry.pageBox,
        }),
      );
      sourcePageIds.set(pageIndex, id);
    }
    const outline = mapOutline(await handle.getOutline(options.signal), sourcePageIds);

    // Commit only after every source page and outline record has validated.
    for (const page of staged) options.notebook.pages[page.id] = page;
    options.notebook.pageOrder.splice(options.at, 0, ...staged.map((page) => page.id));
    return { notebook: options.notebook, asset, sourcePageIds, outline };
  } finally {
    await handle.close();
  }
}

export async function importPdfAsNotebook(
  options: PdfImportOptions & { readonly title?: string },
): Promise<PdfNotebookImportResult> {
  const notebook = emptyNotebook(options.title);
  return insertPdfIntoNotebook({ ...options, notebook, at: 0 });
}

export type MappedPdfLink =
  | { readonly kind: 'external'; readonly url: string }
  | { readonly kind: 'notebook-page'; readonly pageId: string }
  | { readonly kind: 'source-page'; readonly pageIndex: number };

/** Keep external links inert and map internal destinations only when imported. */
export function mapPdfLinkToNotebook(
  link: PdfLink,
  sourcePageIds: ReadonlyMap<number, string>,
): MappedPdfLink {
  if (link.kind === 'external') return { kind: 'external', url: link.url };
  const pageId = sourcePageIds.get(link.pageIndex);
  return pageId === undefined
    ? { kind: 'source-page', pageIndex: link.pageIndex }
    : { kind: 'notebook-page', pageId };
}

export interface PdfSourceTextProjection {
  readonly pageId: string;
  readonly text: string;
  readonly authority: 'pdf-source';
}

/** Rebuild derived source text, grouping pages by shared content-addressed asset. */
export async function projectPdfSourceText(options: {
  readonly notebook: NotebookModel;
  readonly provider: PdfProvider;
  readonly assets: DocumentAssetStore;
  readonly password?: string;
  readonly signal?: AbortSignal;
}): Promise<PdfSourceTextProjection[]> {
  const groups = new Map<string, { asset: StoredAsset; pages: Array<{ pageId: string; pageIndex: number }> }>();
  for (const pageId of options.notebook.pageOrder) {
    const page = options.notebook.pages[pageId];
    if (!isNavigablePage(page)) continue;
    const base = baseOf(page);
    if (base.kind !== 'pdf-page') continue;
    const group = groups.get(base.asset.sha256) ?? { asset: base.asset, pages: [] };
    group.pages.push({ pageId, pageIndex: base.pageIndex });
    groups.set(base.asset.sha256, group);
  }

  const result: PdfSourceTextProjection[] = [];
  for (const group of groups.values()) {
    if (!isWorkspacePath(group.asset.path)) {
      throw importError('PDF_ASSET_INTEGRITY', 'PDF asset path is not portable');
    }
    const bytes = await options.assets.read(group.asset.path);
    if ((await sha256Hex(bytes)) !== group.asset.sha256) {
      throw importError('PDF_ASSET_INTEGRITY', 'PDF asset bytes do not match the Notebook hash');
    }
    const handle = await options.provider.open({
      bytes,
      ...(options.password !== undefined ? { password: options.password } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    try {
      for (const page of group.pages) {
        const source = await handle.getPageText(page.pageIndex, options.signal);
        if (source.kind !== 'source') continue;
        const text = source.items.map((item) => item.text).join('');
        if (text !== '') result.push({ pageId: page.pageId, text, authority: 'pdf-source' });
      }
    } finally {
      await handle.close();
    }
  }
  return result;
}

function indexPageText(
  search: SearchService,
  documentId: DocumentId,
  location: DocumentLocation,
  pages: readonly { readonly pageId: string; readonly text: string }[],
): void {
  const chunks: string[] = [];
  const anchors: Array<{ address: string; start: number; end: number }> = [];
  let cursor = 0;
  for (const page of pages) {
    if (page.text === '') continue;
    if (chunks.length > 0) {
      chunks.push('\n');
      cursor += 1;
    }
    chunks.push(page.text);
    anchors.push({ address: page.pageId, start: cursor, end: cursor + page.text.length });
    cursor += page.text.length;
  }
  search.indexDocument(documentId, location, chunks.join(''), anchors);
}

/** Explicit rebuild hook for standalone PDF derived source text. */
export async function indexStandalonePdfSource(options: {
  readonly documentId: DocumentId;
  readonly location: DocumentLocation;
  readonly bytes: Uint8Array;
  readonly provider: PdfProvider;
  readonly search: SearchService;
  readonly password?: string;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const handle = await options.provider.open({
    bytes: options.bytes,
    ...(options.password !== undefined ? { password: options.password } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
  try {
    const pages: Array<{ pageId: string; text: string }> = [];
    for (let pageIndex = 0; pageIndex < handle.pageCount; pageIndex += 1) {
      const page = await handle.getPageText(pageIndex, options.signal);
      if (page.kind !== 'source') continue;
      pages.push({ pageId: String(pageIndex), text: page.items.map((item) => item.text).join('') });
    }
    indexPageText(options.search, options.documentId, options.location, pages);
  } finally {
    await handle.close();
  }
}

/** Explicit rebuild hook for PDF-backed Notebook source text. */
export async function indexPdfBackedNotebookSource(options: {
  readonly documentId: DocumentId;
  readonly location: DocumentLocation;
  readonly notebook: NotebookModel;
  readonly provider: PdfProvider;
  readonly assets: DocumentAssetStore;
  readonly search: SearchService;
  readonly password?: string;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const pages = await projectPdfSourceText(options);
  const canonical = projectNotebookForSearch(options.notebook, options.documentId);
  const chunks = canonical.body === '' ? [] : [canonical.body];
  const anchors = [...canonical.anchors];
  let cursor = canonical.body.length;
  for (const page of pages) {
    if (page.text === '') continue;
    if (chunks.length > 0) {
      chunks.push('\n');
      cursor += 1;
    }
    chunks.push(page.text);
    anchors.push({ address: page.pageId, start: cursor, end: cursor + page.text.length });
    cursor += page.text.length;
  }
  options.search.indexDocument(options.documentId, options.location, chunks.join(''), anchors);
}
