// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { Runtime, definePlugin, type ServiceToken } from '@froglight/runtime';
import {
  baseOf,
  documentAssetStoreToken,
  documentRegistryToken,
  InMemorySearchService,
  inkPageKind,
  inkPageKindId,
  isNavigablePage,
  markdownKind,
  memoryVaultPlugin,
  notebookKind,
  pdfProviderToken,
  searchToken,
  sha256Hex,
  workspacePath,
  workspacePlugin,
  workspaceToken,
  vaultToken,
  type DocumentAssetStore,
  type DocumentRef,
  type PdfProvider,
  type StoredAsset,
  type NotebookPageEntry,
  type VaultService,
  type WorkspaceService,
} from '@froglight/foundation';
import {
  fileExplorerPlugin,
  fileExplorerToken,
  type FileExplorerService,
} from './file-explorer.js';
import { viewRegistryPlugin } from './view-registry.js';

/** Content-addressed in-memory asset store, mirroring the real contract. */
function memoryAssetStore(): DocumentAssetStore {
  const stored = new Map<string, Uint8Array>();
  let counter = 0;
  return {
    async put(bytes, options) {
      const sha256 = await sha256Hex(bytes);
      const suggested = options?.suggestedName ?? 'asset.bin';
      let path = '';
      for (const candidate of stored.keys()) {
        if (candidate.includes(sha256)) {
          path = candidate;
          break;
        }
      }
      if (path === '') {
        path = `assets/${sha256}-${(counter += 1)}-${suggested}`;
        stored.set(path, bytes);
      }
      const asset: StoredAsset = { path: workspacePath(path), sha256 };
      return asset;
    },
    async read(path) {
      const bytes = stored.get(path);
      if (bytes === undefined) throw new Error(`no asset at ${path}`);
      return bytes;
    },
  };
}

/** Minimal PDF provider double: '%PDF-fake' bytes report two letter pages. */
function memoryPdfProvider(): PdfProvider {
  return {
    async open({ bytes }) {
      const pageCount = new TextDecoder().decode(bytes).includes('%PDF-fake')
        ? 2
        : 1;
      return {
        pageCount,
        async getPageInfo(pageIndex: number) {
          return {
            pageIndex,
            geometry: {
              pageBox: { widthPt: 612, heightPt: 792 },
              effectiveBox: { minX: 0, minY: 0, maxX: 612, maxY: 792 },
              offsetXPt: 0,
              offsetYPt: 0,
              userUnit: 1,
              rotate: 0,
            },
          };
        },
        async getPageText() {
          return { kind: 'source' as const, items: [] };
        },
        async getOutline() {
          return [];
        },
        async getLinks() {
          return [];
        },
        async close() {
          return undefined;
        },
      };
    },
  };
}

async function compose(options: { withPdfPipeline?: boolean } = {}): Promise<{
  runtime: Runtime;
  explorer: FileExplorerService;
  workspace: WorkspaceService;
  vault: VaultService;
}> {
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
  await runtime.registerSlot({
    id: 'notebook-kind',
    plugin: definePlugin({
      id: 'test.notebook-kind',
      requirements: { requires: [documentRegistryToken] },
      activate: (ctx) => {
        ctx.effect(
          () =>
            ctx.require(documentRegistryToken).register(notebookKind).dispose,
        );
      },
    }),
  });
  await runtime.registerSlot({
    id: 'ink-kind',
    plugin: definePlugin({
      id: 'test.ink-kind',
      requirements: { requires: [documentRegistryToken] },
      activate: (ctx) => {
        ctx.effect(
          () => ctx.require(documentRegistryToken).register(inkPageKind).dispose,
        );
      },
    }),
  });
  if (options.withPdfPipeline === true) {
    await runtime.registerSlot({
      id: 'assets',
      plugin: definePlugin({
        id: 'test.asset-store',
        activate: (ctx) => {
          ctx.provide(documentAssetStoreToken, memoryAssetStore());
        },
      }),
    });
    await runtime.registerSlot({
      id: 'pdf',
      plugin: definePlugin({
        id: 'test.pdf-provider',
        activate: (ctx) => {
          ctx.provide(pdfProviderToken, memoryPdfProvider());
        },
      }),
    });
  }
  await runtime.registerSlot({
    id: 'view-registry',
    plugin: viewRegistryPlugin,
  });
  await runtime.registerSlot({
    id: 'file-explorer',
    plugin: fileExplorerPlugin,
  });

  let explorer: FileExplorerService | null = null;
  let workspace: WorkspaceService | null = null;
  let vault: VaultService | null = null;
  await runtime.registerSlot({
    id: 'probe',
    plugin: definePlugin({
      id: 'test.convert-probe',
      requirements: {
        requires: [fileExplorerToken, workspaceToken, vaultToken],
      },
      activate: (ctx) => {
        explorer = ctx.require(fileExplorerToken);
        workspace = ctx.require(workspaceToken);
        vault = ctx.require(vaultToken);
      },
    }),
  });
  if (explorer === null || workspace === null || vault === null) {
    throw new Error('composition failed');
  }
  return { runtime, explorer, workspace, vault };
}

function decodeDocument<T>(kind: { decode(data: Uint8Array, ref: DocumentRef): { model: T } }, data: Uint8Array): T {
  const ref = {
    documentId: 'probe' as never,
    kindId: 'probe' as never,
    location: { resourceId: 'probe' as never },
  };
  return kind.decode(data, ref).model;
}

const FAKE_PDF_BYTES = new TextEncoder().encode(
  '%PDF-fake\ntwo pages for the converter',
);

async function seedFile(
  vault: VaultService,
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  const segments = path.split('/');
  for (let depth = 1; depth < segments.length; depth += 1) {
    await vault.createDirectory(
      workspacePath(segments.slice(0, depth).join('/')),
    );
  }
  await vault.write(workspacePath(path), bytes);
}

describe('raw-file link resolution (composition seam)', () => {
  it('prefers the source folder, then a unique vault file, without claiming documents', async () => {
    const { runtime, explorer, vault } = await compose();
    await seedFile(vault, 'notes/photo.png', new Uint8Array([1]));
    await seedFile(vault, 'photo.png', new Uint8Array([2]));
    await seedFile(vault, 'assets/report.txt', new TextEncoder().encode('report'));
    await explorer.importFile('notes', 'Target.md', new TextEncoder().encode('# Target'));

    expect(await explorer.resolveRawFileLink('photo.png', 'notes/source.md')).toEqual({ path: 'notes/photo.png' });
    expect(await explorer.resolveRawFileLink('/photo.png', 'notes/source.md')).toEqual({ path: 'photo.png' });
    expect(await explorer.resolveRawFileLink('report.txt', 'notes/source.md')).toEqual({ path: 'assets/report.txt' });
    expect(await explorer.resolveRawFileLink('Target.md', 'notes/source.md')).toBeNull();
    await runtime.dispose();
  });

  it('does not pick an arbitrary file when a basename is ambiguous', async () => {
    const { runtime, explorer, vault } = await compose();
    await seedFile(vault, 'left/photo.png', new Uint8Array([1]));
    await seedFile(vault, 'right/photo.png', new Uint8Array([2]));
    expect(await explorer.resolveRawFileLink('photo.png', 'notes/source.md')).toEqual({ ambiguous: true });
    await runtime.dispose();
  });
});

describe('raw-file conversions (composition seam)', () => {
  it('creates a Notebook from a vault PDF without touching the source', async () => {
    const { runtime, explorer, vault } = await compose({ withPdfPipeline: true });
    await seedFile(vault, 'docs/report.pdf', FAKE_PDF_BYTES);

    const documentId = await explorer.createNotebookFromPdf('docs/report.pdf');

    // The new notebook document is created beside its source, with one
    // PDF-backed page per source page referencing the stored asset by hash.
    const created = await vault.read(workspacePath('docs/report.notebook'));
    const model = decodeDocument(notebookKind, created) as unknown as {
      pageOrder: string[];
      pages: Record<string, object>;
    };
    expect(model.pageOrder).toHaveLength(2);
    for (const pageId of model.pageOrder) {
      const page = model.pages[pageId] as unknown as NotebookPageEntry;
      expect(isNavigablePage(page)).toBe(true);
      expect(baseOf(page as never).kind).toBe('pdf-page');
    }
    // The source PDF stays exactly where it was.
    const source = await vault.read(workspacePath('docs/report.pdf'));
    expect(new TextDecoder().decode(source)).toContain('%PDF-fake');
    expect(documentId).toBeTruthy();
    await runtime.dispose();
  });

  it('allocates a fresh notebook path when the title is already taken', async () => {
    const { runtime, explorer, vault } = await compose({ withPdfPipeline: true });
    await seedFile(vault, 'report.pdf', FAKE_PDF_BYTES);

    await explorer.createNotebookFromPdf('report.pdf');
    await explorer.createNotebookFromPdf('report.pdf');

    await expect(vault.read(workspacePath('report.notebook'))).resolves.toHaveProperty('byteLength');
    await expect(vault.read(workspacePath('report (1).notebook'))).resolves.toHaveProperty('byteLength');
    await runtime.dispose();
  });

  it('creates an Ink drawing from a vault image without touching the source', async () => {
    const { runtime, explorer, vault } = await compose({ withPdfPipeline: true });
    const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);
    await seedFile(vault, 'shots/photo.png', png);

    await explorer.createInkFromImage('shots/photo.png');

    const created = await vault.read(workspacePath('shots/photo.ink'));
    const surface = decodeDocument(inkPageKind, created) as unknown as {
      frame: { kind: string; width?: number; height?: number };
      order: string[];
      objects: Record<
        string,
        {
          type: string;
          src: string;
          sha256: string;
          x: number;
          y: number;
          width: number;
          height: number;
        }
      >;
    };
    expect(surface.order).toHaveLength(1);
    const image = surface.objects[surface.order[0]!]!;
    expect(image.type).toBe('froglight.image');
    expect(image.sha256).toBe(await sha256Hex(png));
    expect(image.src).toContain(image.sha256);
    // jsdom cannot decode images, so the fallback size applies.
    expect(image.width).toBe(960);
    expect(image.height).toBe(720);
    // The canvas starts at the image's size and the image fills it.
    expect(surface.frame).toEqual({ kind: 'bounded', width: 960, height: 720 });
    expect(image.x).toBe(0);
    expect(image.y).toBe(0);
    const source = await vault.read(workspacePath('shots/photo.png'));
    expect([...source]).toEqual([...png]);
    expect(inkPageKindId).toBeTruthy();
    await runtime.dispose();
  });

  it('reports unavailability instead of failing silently', async () => {
    const { runtime, explorer, vault } = await compose();
    await seedFile(vault, 'only.pdf', FAKE_PDF_BYTES);
    await expect(explorer.createNotebookFromPdf('only.pdf')).rejects.toThrow(
      /unavailable/i,
    );
    await expect(explorer.createInkFromImage('only.pdf')).rejects.toThrow(
      /unavailable/i,
    );
    await runtime.dispose();
  });
});
