import { describe, expect, it } from 'vitest';
import { FroglightError } from '../errors.js';
import { documentKindId } from '../identity.js';
import { resourceId, documentId } from '../identity.js';
import {
  normalizePdfPageGeometry,
  pdfKind,
  pdfKindId,
  sourcePointToSurface,
} from './index.js';

describe('PDF canonical source contracts', () => {
  it.each([
    [0, { x: 20, y: 260 }, { widthPt: 400, heightPt: 300 }],
    [90, { x: 40, y: 20 }, { widthPt: 300, heightPt: 400 }],
    [180, { x: 380, y: 40 }, { widthPt: 400, heightPt: 300 }],
    [270, { x: 260, y: 380 }, { widthPt: 300, heightPt: 400 }],
  ])('normalizes CropBox, UserUnit, and rotate %s', (rotate, expectedPoint, expectedBox) => {
    const geometry = normalizePdfPageGeometry({
      mediaBox: [0, 0, 300, 250],
      cropBox: [50, 50, 250, 200],
      userUnit: 2,
      rotate,
    });
    expect(geometry.pageBox).toEqual(expectedBox);
    expect(sourcePointToSurface(geometry, { x: 60, y: 70 })).toEqual(expectedPoint);
  });

  it('intersects a reversed CropBox with MediaBox and falls back when empty', () => {
    expect(
      normalizePdfPageGeometry({
        mediaBox: [300, 200, 0, 0],
        cropBox: [350, 250, 50, 25],
      }).effectiveBox,
    ).toEqual({ minX: 50, minY: 25, maxX: 300, maxY: 200 });
    expect(
      normalizePdfPageGeometry({
        mediaBox: [0, 0, 300, 200],
        cropBox: [400, 400, 500, 500],
      }).effectiveBox,
    ).toEqual({ minX: 0, minY: 0, maxX: 300, maxY: 200 });
  });

  it('fails malformed geometry with a structured PDF error', () => {
    for (const input of [
      { mediaBox: [0, 0, 0, 1] as const },
      { mediaBox: [0, 0, 1, 1] as const, userUnit: 0 },
      { mediaBox: [0, 0, 1, 1] as const, rotate: 45 },
    ]) {
      try {
        normalizePdfPageGeometry(input);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(FroglightError);
        expect((error as FroglightError).code).toBe('PDF_CORRUPT');
      }
    }
  });

  it('registers immutable standalone PDF bytes without provider types', () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
    const ref = {
      documentId: documentId('pdf-doc'),
      kindId: documentKindId('froglight.pdf'),
      location: { resourceId: resourceId('pdf-resource') },
    };
    const decoded = pdfKind.decode(bytes, ref);
    expect(pdfKindId).toBe('froglight.pdf');
    expect(pdfKind.recognize?.('reports/paper.pdf')).toBe(true);
    expect(pdfKind.encode(decoded.model, ref)).toEqual(bytes);
    expect(decoded.model).toEqual({ bytes });
  });
});
