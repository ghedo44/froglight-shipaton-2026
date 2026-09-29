import { describe, expect, it } from 'vitest';
import {
  appendPage,
  boundedFrame,
  emptyNotebook,
  emptySurface,
  inkStrokeObject,
  notebookPage,
  pdfNotebookPage,
  sha256Hex,
  textObject,
  workspacePath,
} from '@froglight/foundation';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { PdfJsProvider } from '@froglight/provider-pdfjs';
import { PdfLibExportProvider } from './index.js';

async function sourcePdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([300, 200]);
  page.drawText('Original selectable source', { x: 20, y: 160, size: 14, font });
  return pdf.save({ useObjectStreams: false });
}

function png1x1(): Uint8Array {
  const binary = atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  );
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

describe('PdfLibExportProvider', () => {
  it('preserves source text and page geometry while adding vector/text overlay content', async () => {
    const source = await sourcePdf();
    const sourceBefore = source.slice();
    const notebook = emptyNotebook('Export');
    const sourceHash = await sha256Hex(source);
    const asset = { path: workspacePath(`attachments/${sourceHash}`), sha256: sourceHash };
    const pdfPage = pdfNotebookPage('source', {
      asset,
      pageIndex: 0,
      pageBox: { widthPt: 300, heightPt: 200 },
    });
    pdfPage.surface.objects.text = textObject('text', {
      x: 20,
      y: 60,
      text: 'Froglight overlay',
      size: 12,
    });
    pdfPage.surface.objects.stroke = inkStrokeObject('stroke', {
      points: [{ x: 20, y: 80 }, { x: 100, y: 100 }],
      width: 3,
      color: '#ff0000',
    });
    pdfPage.surface.order.push('text', 'stroke');
    appendPage(notebook, pdfPage);
    appendPage(
      notebook,
      notebookPage('template', {
        template: 'froglight.grid',
        surface: emptySurface(boundedFrame(200, 300)),
      }),
    );
    const notebookBefore = JSON.stringify(notebook);

    const exported = await new PdfLibExportProvider().exportNotebook({
      notebook,
      mode: 'preserve',
      assets: { read: async () => source.slice() },
    });
    const reader = await new PdfJsProvider().open({ bytes: exported.bytes });
    expect(reader.pageCount).toBe(2);
    expect((await reader.getPageInfo(0)).geometry.pageBox).toEqual({
      widthPt: 300,
      heightPt: 200,
    });
    expect((await reader.getPageInfo(1)).geometry.pageBox).toEqual({
      widthPt: 200,
      heightPt: 300,
    });
    const text = (await reader.getPageText(0)).items.map((item) => item.text).join(' ');
    expect(text).toContain('Original selectable source');
    expect(text).toContain('Froglight overlay');
    expect(exported.warnings).toContainEqual(
      expect.objectContaining({ code: 'EXPORT_FEATURE_DROPPED', pageId: 'source' }),
    );
    expect(source).toEqual(sourceBefore);
    expect(JSON.stringify(notebook)).toBe(notebookBefore);
    await reader.close();
  });

  it('makes flattened output explicit, validates DPI, and produces distinct bytes', async () => {
    const notebook = emptyNotebook();
    appendPage(
      notebook,
      notebookPage('page', { surface: emptySurface(boundedFrame(72, 72)) }),
    );
    const exporter = new PdfLibExportProvider();
    const flattened = await exporter.exportNotebook({
      notebook,
      mode: 'flatten',
      rasterDpi: 150,
      assets: { read: async () => new Uint8Array() },
      renderFlattenedPage: async () => png1x1(),
    });
    const preserving = await exporter.exportNotebook({
      notebook,
      mode: 'preserve',
      assets: { read: async () => new Uint8Array() },
    });
    expect(flattened.bytes).not.toEqual(preserving.bytes);
    expect(flattened.warnings).toEqual([
      expect.objectContaining({ code: 'EXPORT_FLATTENED', pageId: 'page' }),
    ]);
    await expect(
      exporter.exportNotebook({
        notebook,
        mode: 'flatten',
        rasterDpi: 600,
        assets: { read: async () => new Uint8Array() },
        renderFlattenedPage: async () => png1x1(),
      }),
    ).rejects.toMatchObject({ code: 'PDF_RESOURCE_LIMIT' });
  });

  it('never silently flattens when preserve cannot resolve a source page', async () => {
    const notebook = emptyNotebook();
    const source = await sourcePdf();
    const sourceHash = await sha256Hex(source);
    appendPage(
      notebook,
      pdfNotebookPage('source', {
        asset: { path: workspacePath(`attachments/${sourceHash}`), sha256: sourceHash },
        pageIndex: 4,
        pageBox: { widthPt: 300, heightPt: 200 },
      }),
    );
    await expect(
      new PdfLibExportProvider().exportNotebook({
        notebook,
        mode: 'preserve',
        assets: { read: async () => source.slice() },
      }),
    ).rejects.toMatchObject({ code: 'PDF_FEATURE_UNSUPPORTED' });
  });

  it('uses a warned deterministic visual fallback for text outside the built-in font', async () => {
    const notebook = emptyNotebook();
    const page = notebookPage('unicode', {
      surface: emptySurface(boundedFrame(200, 100)),
    });
    page.surface.objects.unicode = textObject('unicode', {
      x: 10,
      y: 10,
      text: 'study 🐸',
      size: 14,
    });
    page.surface.order.push('unicode');
    appendPage(notebook, page);
    const result = await new PdfLibExportProvider().exportNotebook({
      notebook,
      mode: 'preserve',
      assets: { read: async () => new Uint8Array() },
    });
    expect(result.bytes.byteLength).toBeGreaterThan(0);
    expect(result.warnings).toContainEqual(expect.objectContaining({
      code: 'EXPORT_TEXT_FALLBACK',
      pageId: 'unicode',
    }));
  });

  it('fails explicitly instead of misaligning preserve output for rotated source geometry', async () => {
    const source = await PDFDocument.create();
    const sourcePage = source.addPage([300, 200]);
    sourcePage.setRotation({ type: 'degrees', angle: 90 } as never);
    const bytes = await source.save();
    const hash = await sha256Hex(bytes);
    const notebook = emptyNotebook();
    appendPage(notebook, pdfNotebookPage('rotated', {
      asset: { path: workspacePath(`attachments/${hash}`), sha256: hash },
      pageIndex: 0,
      pageBox: { widthPt: 200, heightPt: 300 },
    }));
    await expect(new PdfLibExportProvider().exportNotebook({
      notebook,
      mode: 'preserve',
      assets: { read: async () => bytes },
    })).rejects.toMatchObject({ code: 'PDF_FEATURE_UNSUPPORTED' });
  });
});
