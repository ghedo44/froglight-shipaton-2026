/**
 * PDF toolbar contributions through the workbench seam.
 *
 * Behavioral pins only — no PDF redesign, no id renames, no canonical or
 * engine changes. The `PdfDocumentEditorProvider` snapshot is the sole
 * toolbar source for standalone PDFs; the composition graph and geometric
 * placements both consume it. These tests drive the real provider handle
 * headlessly and prove every PDF action stays executable through the same
 * `DocumentEditorTools` seam after the grouping migration:
 *
 * - page navigation (previous/next) with edge disabled states,
 * - source-selection toggle,
 * - import-as-notebook (bytes-copy export, disabled without an importer),
 * - unknown ids rejected, stable ids + semantic roles (no renames),
 * - plain DTO controls.
 */

import { describe, expect, it } from 'vitest';
import {
  documentId,
  pdfKindId,
  resourceId,
  type DocumentToolControl,
  type PdfProvider,
} from '@froglight/foundation';
import {
  PdfDocumentEditorProvider,
  type PdfReaderHandle,
} from './editor.js';

function makeFakeProvider(pageCount = 3): PdfProvider {
  return {
    async open(input) {
      const bytes = input.bytes;
      void bytes;
      return {
        pageCount,
        getPageInfo: async (pageIndex) => ({
          pageIndex,
          geometry: {
            effectiveBox: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
            userUnit: 1,
            rotate: 0 as const,
            pageBox: { widthPt: 100, heightPt: 100 },
          },
        }),
        getPageText: async (pageIndex) => ({
          kind: 'source' as const,
          items: [{ text: `page ${pageIndex} hello` }],
        }),
        getOutline: async () => [],
        getLinks: async () => [],
        mountPage: async (request) => {
          const parent = request.parent as unknown as {
            ownerDocument: Document;
            appendChild(node: unknown): void;
          };
          const marker = parent.ownerDocument.createElement('div');
          marker.className = 'fl-pdf-page';
          parent.appendChild(marker);
          return {
            destroy: () => {
              marker.remove();
            },
          };
        },
        close: async () => undefined,
      };
    },
  };
}

function makeSession(bytes: Uint8Array): Record<string, unknown> {
  return {
    model: { bytes },
    ref: {
      documentId: documentId('pdf-doc'),
      kindId: pdfKindId,
      location: { resourceId: resourceId('pdf-resource') },
    },
  };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

function byId(
  handle: PdfReaderHandle,
  id: string,
): Extract<DocumentToolControl, { kind: 'button' }> {
  const control = handle
    .tools!.snapshot()
    .controls.find((entry) => entry.id === id);
  if (control === undefined) throw new Error(`missing control ${id}`);
  if (control.kind !== 'button') throw new Error(`not a button: ${id}`);
  return control;
}

describe('pdf toolbar grouping seam', () => {
  it('emits stable ids, roles, and labels (no renames)', () => {
    const provider = new PdfDocumentEditorProvider({
      pdfProvider: makeFakeProvider(3),
      importAsNotebook: () => undefined,
    });
    const handle = provider.createEditor({
      session: makeSession(new Uint8Array([1, 2, 3])) as never,
      parent: {},
    });
    try {
      const snapshot = handle.tools!.snapshot();
      expect(snapshot.controls.map((control) => control.id)).toEqual([
        'pdf.previous',
        'pdf.page',
        'pdf.next',
        'pdf.source-select',
        'pdf.import-notebook',
      ]);
      const roles = new Map(
        snapshot.controls.map((control) => [
          control.id,
          (control as { semanticRole?: string }).semanticRole ?? null,
        ]),
      );
      expect(roles.get('pdf.previous')).toBe('pdf.page.previous');
      expect(roles.get('pdf.page')).toBe(null);
      expect(roles.get('pdf.next')).toBe('pdf.page.next');
      expect(roles.get('pdf.source-select')).toBe('pdf.select.source');
      expect(roles.get('pdf.import-notebook')).toBe('pdf.annotate.notebook');
      const labels = new Map(
        snapshot.controls.map((control) => [control.id, control.label]),
      );
      expect(labels.get('pdf.previous')).toBe('Previous PDF page');
      expect(labels.get('pdf.next')).toBe('Next PDF page');
      expect(labels.get('pdf.source-select')).toBe(
        'Select and copy source text',
      );
      expect(labels.get('pdf.import-notebook')).toBe(
        'Annotate / Import as Notebook',
      );
      // The source-select toggle never claims exclusive-tool semantics.
      expect(byId(handle, 'pdf.source-select').activationRole).toBe('toggle');
    } finally {
      handle.destroy();
    }
  });

  it('navigates pages through execute with edge disabled states', async () => {
    const provider = new PdfDocumentEditorProvider({
      pdfProvider: makeFakeProvider(3),
    });
    const handle = provider.createEditor({
      session: makeSession(new Uint8Array([4, 5, 6])) as never,
      parent: {},
    });
    try {
      await flush();
      const label = (): string =>
        handle
          .tools!.snapshot()
          .controls.find((control) => control.id === 'pdf.page')?.label ??
        '';
      expect(label()).toBe('1 / 3');
      expect(byId(handle, 'pdf.previous').disabled).toBe(true);
      expect(byId(handle, 'pdf.next').disabled).toBe(false);
      expect(handle.tools!.execute('pdf.next')).toBe(true);
      await flush();
      expect(label()).toBe('2 / 3');
      expect(byId(handle, 'pdf.previous').disabled).toBe(false);
      expect(handle.tools!.execute('pdf.next')).toBe(true);
      await flush();
      expect(label()).toBe('3 / 3');
      expect(byId(handle, 'pdf.next').disabled).toBe(true);
      // Past-the-end navigation stays put through the same seam.
      expect(handle.tools!.execute('pdf.next')).toBe(true);
      await flush();
      expect(label()).toBe('3 / 3');
      expect(handle.tools!.execute('pdf.previous')).toBe(true);
      await flush();
      expect(label()).toBe('2 / 3');
    } finally {
      handle.destroy();
    }
  });

  it('toggles source selection through execute', async () => {
    const provider = new PdfDocumentEditorProvider({
      pdfProvider: makeFakeProvider(2),
    });
    const handle = provider.createEditor({
      session: makeSession(new Uint8Array([7, 8, 9])) as never,
      parent: {},
    });
    try {
      await flush();
      expect(byId(handle, 'pdf.source-select').active).toBe(true);
      expect(handle.tools!.execute('pdf.source-select')).toBe(true);
      expect(byId(handle, 'pdf.source-select').active).toBe(false);
      expect(handle.tools!.execute('pdf.source-select')).toBe(true);
      expect(byId(handle, 'pdf.source-select').active).toBe(true);
    } finally {
      handle.destroy();
    }
  });

  it('exports a bytes copy as notebook, disabled without an importer', async () => {
    const source = new Uint8Array([10, 20, 30]);
    let exported: Uint8Array | null = null;
    const withImporter = new PdfDocumentEditorProvider({
      pdfProvider: makeFakeProvider(2),
      importAsNotebook: (bytes) => {
        exported = bytes;
      },
    });
    const handle = withImporter.createEditor({
      session: makeSession(source) as never,
      parent: {},
    });
    try {
      await flush();
      expect(byId(handle, 'pdf.import-notebook').disabled).not.toBe(true);
      expect(handle.tools!.execute('pdf.import-notebook')).toBe(true);
      expect(exported).not.toBeNull();
      expect(Array.from(exported!)).toEqual([10, 20, 30]);
      expect(exported!).not.toBe(source);
      expect(Array.from(source)).toEqual([10, 20, 30]);
    } finally {
      handle.destroy();
    }
    const withoutImporter = new PdfDocumentEditorProvider({
      pdfProvider: makeFakeProvider(2),
    });
    const reader = withoutImporter.createEditor({
      session: makeSession(source) as never,
      parent: {},
    });
    try {
      await flush();
      expect(byId(reader, 'pdf.import-notebook').disabled).toBe(true);
      expect(reader.tools!.execute('pdf.import-notebook')).toBe(false);
    } finally {
      reader.destroy();
    }
  });

  it('rejects unknown ids and keeps controls as plain DTO data', async () => {
    const provider = new PdfDocumentEditorProvider({
      pdfProvider: makeFakeProvider(1),
      importAsNotebook: () => undefined,
    });
    const handle = provider.createEditor({
      session: makeSession(new Uint8Array([1])) as never,
      parent: {},
    });
    try {
      await flush();
      expect(handle.tools!.execute('pdf.zoom-in')).toBe(false);
      expect(handle.tools!.execute('pdf.unknown')).toBe(false);
      const snapshot = handle.tools!.snapshot();
      expect(JSON.parse(JSON.stringify(snapshot))).toEqual({
        context: snapshot.context,
        controls: snapshot.controls.map((control) => ({ ...control })),
      });
    } finally {
      handle.destroy();
    }
  });
});
