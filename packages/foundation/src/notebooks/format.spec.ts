import { describe, expect, it } from 'vitest';
import { utf8Decode, utf8Encode } from '../encoding.js';
import { boundedFrame, emptySurface } from '../surfaces/model.js';
import {
  decodeNotebook,
  encodeNotebook,
  emptyNotebook,
  notebookPage,
  pdfNotebookPage,
  setPageTemplate,
  templateOf,
} from './index.js';

const surface = (width = 612, height = 792): Record<string, unknown> =>
  JSON.parse(JSON.stringify(emptySurface(boundedFrame(width, height)))) as Record<string, unknown>;

describe('Notebook page bases', () => {
  it('preserves unknown page fields in the current page shape', () => {
    const input = {
      formatVersion: 1,
      meta: { title: 'Legacy', vendor: true },
      pageOrder: ['p1'],
      pages: {
        p1: {
          id: 'p1',
          label: 'One',
          base: { kind: 'template', template: 'froglight.grid' },
          vendorPage: { keep: true },
          surface: surface(400, 300),
        },
      },
      vendorDocument: [1, 2],
    };

    const { model, warnings } = decodeNotebook(utf8Encode(JSON.stringify(input)));
    expect(warnings).toEqual([]);
    expect(model.formatVersion).toBe(1);
    expect(model.pageOrder).toEqual(['p1']);
    expect(model.pages.p1).toMatchObject({
      kind: 'page',
      id: 'p1',
      record: {
        id: 'p1',
        label: 'One',
        base: { kind: 'template', template: 'froglight.grid' },
        vendorPage: { keep: true },
      },
    });
    expect(templateOf(model.pages.p1?.kind === 'page' ? model.pages.p1 : undefined!)).toBe(
      'froglight.grid',
    );
    const encoded = JSON.parse(utf8Decode(encodeNotebook(model))) as typeof input & {
      formatVersion: 1;
    };
    expect(encoded.pages.p1).toHaveProperty('base', {
      kind: 'template',
      template: 'froglight.grid',
    });
    expect(encoded.pages.p1.surface).toEqual(input.pages.p1.surface);
    expect(encoded.vendorDocument).toEqual([1, 2]);
  });

  it('round-trips a PDF page base and preserves unknown base members', () => {
    const raw = {
      formatVersion: 1,
      meta: {},
      pageOrder: ['pdf-1'],
      pages: {
        'pdf-1': {
          id: 'pdf-1',
          base: {
            kind: 'pdf-page',
            asset: { path: 'attachments/abc', sha256: 'a'.repeat(64) },
            pageIndex: 3,
            pageBox: { widthPt: 792, heightPt: 612 },
            'acme.future': { preserved: true },
          },
          surface: surface(792, 612),
        },
      },
    };
    const decoded = decodeNotebook(utf8Encode(JSON.stringify(raw)));
    expect(decoded.warnings).toEqual([]);
    expect(JSON.parse(utf8Decode(encodeNotebook(decoded.model)))).toEqual(raw);
  });

  it('constructs PDF-backed pages with a bounded Surface matching pageBox', () => {
    const page = pdfNotebookPage('p1', {
      asset: { path: 'attachments/' + 'b'.repeat(64) as never, sha256: 'b'.repeat(64) },
      pageIndex: 0,
      pageBox: { widthPt: 595.276, heightPt: 841.89 },
    });
    expect(page.record.base).toEqual({
      kind: 'pdf-page',
      asset: { path: 'attachments/' + 'b'.repeat(64), sha256: 'b'.repeat(64) },
      pageIndex: 0,
      pageBox: { widthPt: 595.276, heightPt: 841.89 },
    });
    expect(page.surface.frame).toEqual({
      kind: 'bounded',
      width: 595.276,
      height: 841.89,
    });
  });

  it('creates new template notebooks directly in the current format', () => {
    const model = emptyNotebook();
    const page = notebookPage('p1', { template: 'froglight.lined' });
    expect(model.formatVersion).toBe(1);
    expect(page.record).toHaveProperty('base', {
      kind: 'template',
      template: 'froglight.lined',
    });
    expect(page.record).not.toHaveProperty('template');
  });

  it('preserves an opaque page record without changing its Surface payload', () => {
    const futureSurface = { formatVersion: 999, vendor: { keep: true } };
    const decoded = decodeNotebook(utf8Encode(JSON.stringify({
      formatVersion: 1,
      meta: {},
      pageOrder: ['opaque'],
      pages: {
        opaque: {
          id: 'opaque',
          base: { kind: 'template', template: 'froglight.dots' },
          surface: futureSurface,
        },
      },
    })));
    expect(decoded.model.pages.opaque).toMatchObject({
      kind: 'opaque',
      raw: {
        base: { kind: 'template', template: 'froglight.dots' },
        surface: futureSurface,
      },
    });
    const encoded = JSON.parse(utf8Decode(encodeNotebook(decoded.model)));
    expect(encoded.pages.opaque.surface).toEqual(futureSurface);
  });

  it('preserves plugin-defined template-base members when changing paper', () => {
    const page = notebookPage('p1');
    page.record.base = {
      kind: 'template',
      template: 'vendor.paper',
      'vendor.options': { color: 'cream' },
    };
    setPageTemplate(page, 'froglight.grid');
    expect(page.record.base).toEqual({
      kind: 'template',
      template: 'froglight.grid',
      'vendor.options': { color: 'cream' },
    });
  });
});
