import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { GlobalWorkerOptions } from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  createPdfPageLinkCache,
  PdfJsProvider,
  pdfJsWorkerUrl,
} from './pdf-provider.js';

async function fixture(): Promise<Uint8Array> {
  const document = await PDFDocument.create();
  const font = await document.embedFont(StandardFonts.Helvetica);
  const first = document.addPage([612, 792]);
  first.drawText('Froglight selectable source', {
    x: 72,
    y: 700,
    size: 18,
    font,
  });
  const second = document.addPage([792, 612]);
  second.setRotation({ type: 'degrees', angle: 90 } as never);
  second.drawText('Landscape page', { x: 72, y: 520, size: 18, font });
  return document.save({ useObjectStreams: false });
}

describe('PdfJsProvider', () => {
  it('configures an application-bundled worker instead of a missing relative default', () => {
    expect(pdfJsWorkerUrl).not.toBe('./pdf.worker.mjs');
    expect(pdfJsWorkerUrl).toContain('pdf.worker');
    expect(GlobalWorkerOptions.workerSrc).toBe('./pdf.worker.mjs');
  });

  it('opens immutable bytes and projects provider-neutral page geometry and text', async () => {
    const bytes = await fixture();
    const before = bytes.slice();
    const handle = await new PdfJsProvider().open({ bytes });
    expect(handle.pageCount).toBe(2);
    expect(await handle.getPageInfo(0)).toMatchObject({
      pageIndex: 0,
      geometry: { pageBox: { widthPt: 612, heightPt: 792 } },
    });
    const text = await handle.getPageText(0);
    expect(text.kind).toBe('source');
    expect(text.items.map((item) => item.text).join('')).toContain(
      'Froglight selectable source',
    );
    expect(await handle.getOutline()).toEqual([]);
    expect(await handle.getLinks(0)).toEqual([]);
    expect(bytes).toEqual(before);
    await handle.close();
  });

  it('normalizes out-of-range access and closed-handle work', async () => {
    const handle = await new PdfJsProvider().open({ bytes: await fixture() });
    await expect(handle.getPageInfo(-1)).rejects.toMatchObject({
      code: 'PDF_PAGE_OUT_OF_RANGE',
    });
    await handle.close();
    await expect(handle.getPageText(0)).rejects.toMatchObject({
      code: 'PDF_RENDER_CANCELLED',
    });
  });

  it('keeps link lookup retryable and bounds recent pages for remounts', async () => {
    const document = await PDFDocument.create();
    for (let page = 0; page < 18; page += 1) document.addPage([612, 792]);
    const handle = await new PdfJsProvider().open({ bytes: await document.save() });
    const cancelled = new AbortController();
    cancelled.abort();
    try {
      await expect(handle.getLinks(0, cancelled.signal)).rejects.toMatchObject({
        code: 'PDF_RENDER_CANCELLED',
      });
      const first = await handle.getLinks(0);
      expect(await handle.getLinks(0)).toBe(first);

      for (let page = 1; page < 18; page += 1) await handle.getLinks(page);
      const afterEviction = await handle.getLinks(0);
      expect(afterEviction).not.toBe(first);
      expect(await handle.getLinks(0)).toBe(afterEviction);
    } finally {
      await handle.close();
    }
  });

  it('drops a failed annotation extraction so the next page mount can retry', async () => {
    let attempts = 0;
    const cache = createPdfPageLinkCache(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient annotation failure');
      return [];
    });
    await expect(cache.get(0)).rejects.toThrow('transient annotation failure');
    const links = await cache.get(0);
    expect(await cache.get(0)).toBe(links);
    expect(attempts).toBe(2);
  });

  it('rejects corrupt input through a structured provider error', async () => {
    await expect(
      new PdfJsProvider().open({ bytes: new Uint8Array([1, 2, 3]) }),
    ).rejects.toMatchObject({ code: 'PDF_CORRUPT' });
  });
});
