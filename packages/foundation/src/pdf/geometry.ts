import { FroglightError } from '../errors.js';

export type PdfBoxTuple = readonly [number, number, number, number];
export type PdfRotation = 0 | 90 | 180 | 270;

export interface PdfSourceGeometry {
  readonly mediaBox: PdfBoxTuple;
  readonly cropBox?: PdfBoxTuple;
  readonly userUnit?: number;
  readonly rotate?: number;
}

export interface PdfEffectiveBox {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export interface NormalizedPdfPageGeometry {
  readonly effectiveBox: PdfEffectiveBox;
  readonly userUnit: number;
  readonly rotate: PdfRotation;
  readonly pageBox: { readonly widthPt: number; readonly heightPt: number };
}

function corrupt(message: string): FroglightError {
  return new FroglightError('PDF_CORRUPT', `PDF geometry: ${message}`);
}

function normalizeBox(tuple: PdfBoxTuple): PdfEffectiveBox | null {
  if (tuple.length !== 4 || tuple.some((value) => !Number.isFinite(value))) return null;
  const minX = Math.min(tuple[0], tuple[2]);
  const minY = Math.min(tuple[1], tuple[3]);
  const maxX = Math.max(tuple[0], tuple[2]);
  const maxY = Math.max(tuple[1], tuple[3]);
  return maxX > minX && maxY > minY ? { minX, minY, maxX, maxY } : null;
}

export function normalizePdfPageGeometry(
  source: PdfSourceGeometry,
): NormalizedPdfPageGeometry {
  const media = normalizeBox(source.mediaBox);
  if (media === null) throw corrupt('MediaBox must be a finite non-empty rectangle');
  const crop = source.cropBox === undefined ? null : normalizeBox(source.cropBox);
  const intersection = crop === null
    ? null
    : {
        minX: Math.max(media.minX, crop.minX),
        minY: Math.max(media.minY, crop.minY),
        maxX: Math.min(media.maxX, crop.maxX),
        maxY: Math.min(media.maxY, crop.maxY),
      };
  const effectiveBox =
    intersection !== null &&
    intersection.maxX > intersection.minX &&
    intersection.maxY > intersection.minY
      ? intersection
      : media;
  const userUnit = source.userUnit ?? 1;
  if (!Number.isFinite(userUnit) || userUnit <= 0) {
    throw corrupt('UserUnit must be finite and positive');
  }
  const rawRotate = source.rotate ?? 0;
  if (!Number.isFinite(rawRotate) || !Number.isInteger(rawRotate)) {
    throw corrupt('Rotate must be an integer');
  }
  const rotate = ((rawRotate % 360) + 360) % 360;
  if (rotate !== 0 && rotate !== 90 && rotate !== 180 && rotate !== 270) {
    throw corrupt('Rotate must normalize to 0, 90, 180, or 270 degrees');
  }
  const width = (effectiveBox.maxX - effectiveBox.minX) * userUnit;
  const height = (effectiveBox.maxY - effectiveBox.minY) * userUnit;
  return {
    effectiveBox,
    userUnit,
    rotate,
    pageBox:
      rotate === 90 || rotate === 270
        ? { widthPt: height, heightPt: width }
        : { widthPt: width, heightPt: height },
  };
}

export function sourcePointToSurface(
  geometry: NormalizedPdfPageGeometry,
  point: { readonly x: number; readonly y: number },
): { readonly x: number; readonly y: number } {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw corrupt('source point must be finite');
  }
  const { effectiveBox, userUnit, rotate } = geometry;
  const width = effectiveBox.maxX - effectiveBox.minX;
  const height = effectiveBox.maxY - effectiveBox.minY;
  const rx = point.x - effectiveBox.minX;
  const ry = point.y - effectiveBox.minY;
  if (rotate === 0) return { x: rx * userUnit, y: (height - ry) * userUnit };
  if (rotate === 90) return { x: ry * userUnit, y: rx * userUnit };
  if (rotate === 180) return { x: (width - rx) * userUnit, y: ry * userUnit };
  return { x: (height - ry) * userUnit, y: (width - rx) * userUnit };
}
