/**
 * Notebook paper options and page sizes (slice 10): validation,
 * normalization, resolution, and orientation helpers. Headless.
 */

import { describe, expect, it } from 'vitest';
import {
  isValidPaperOptions,
  normalizePaperOptions,
  orientSize,
  orientationOf,
  pageSizePreset,
  resolvePaperColor,
  resolvePaperSpacing,
  NOTEBOOK_PAGE_SIZE_IDS,
  NOTEBOOK_PAGE_SIZES,
} from './paper.js';

describe('paper options validation', () => {
  it('accepts absent and empty options', () => {
    expect(isValidPaperOptions(undefined)).toBe(true);
    expect(isValidPaperOptions({})).toBe(true);
  });

  it('accepts valid spacing and paper color', () => {
    expect(isValidPaperOptions({ spacing: 32 })).toBe(true);
    expect(isValidPaperOptions({ paperColor: '#faf7ef' })).toBe(true);
    expect(isValidPaperOptions({ spacing: 44, paperColor: 'linen' })).toBe(true);
  });

  it('rejects out-of-range or malformed spacing', () => {
    expect(isValidPaperOptions({ spacing: 0 })).toBe(false);
    expect(isValidPaperOptions({ spacing: -4 })).toBe(false);
    expect(isValidPaperOptions({ spacing: Number.NaN })).toBe(false);
    expect(isValidPaperOptions({ spacing: Number.POSITIVE_INFINITY })).toBe(false);
    expect(isValidPaperOptions({ spacing: 1000 })).toBe(false);
    expect(isValidPaperOptions({ spacing: '32' })).toBe(false);
  });

  it('rejects malformed paper colors', () => {
    expect(isValidPaperOptions({ paperColor: '' })).toBe(false);
    expect(isValidPaperOptions({ paperColor: 42 })).toBe(false);
    expect(isValidPaperOptions({ paperColor: 'x'.repeat(1001) })).toBe(false);
  });

  it('rejects non-records', () => {
    expect(isValidPaperOptions(null)).toBe(false);
    expect(isValidPaperOptions('paper')).toBe(false);
    expect(isValidPaperOptions([])).toBe(false);
  });

  it('tolerates unknown members', () => {
    expect(isValidPaperOptions({ spacing: 32, vendorFuture: true })).toBe(true);
  });
});

describe('paper options normalization', () => {
  it('drops invalid known members while preserving unknown ones', () => {
    expect(normalizePaperOptions({ spacing: -2, vendorFuture: 1 })).toEqual({
      vendorFuture: 1,
    });
    expect(normalizePaperOptions({ spacing: 0 })).toBeUndefined();
    expect(normalizePaperOptions({})).toBeUndefined();
    expect(normalizePaperOptions(undefined)).toBeUndefined();
    expect(normalizePaperOptions(null)).toBeUndefined();
  });

  it('keeps valid members verbatim', () => {
    expect(normalizePaperOptions({ spacing: 48, paperColor: '#fff' })).toEqual({
      spacing: 48,
      paperColor: '#fff',
    });
  });
});

describe('paper resolution', () => {
  it('falls back to the template default gap without options', () => {
    expect(resolvePaperSpacing(undefined, 44)).toBe(44);
    expect(resolvePaperSpacing({}, 32)).toBe(32);
    expect(resolvePaperSpacing({ spacing: 48 }, 44)).toBe(48);
    expect(resolvePaperSpacing({ spacing: -5 }, 44)).toBe(44);
  });

  it('resolves paper color with white as absent', () => {
    expect(resolvePaperColor(undefined)).toBeUndefined();
    expect(resolvePaperColor({})).toBeUndefined();
    expect(resolvePaperColor({ paperColor: '#faf7ef' })).toBe('#faf7ef');
  });
});

describe('page sizes and orientation', () => {
  it('ships A4-compatible defaults with Letter/Legal/Square presets', () => {
    expect(NOTEBOOK_PAGE_SIZES['froglight.a4']).toEqual({
      width: 1240,
      height: 1754,
    });
    expect(NOTEBOOK_PAGE_SIZE_IDS).toContain('froglight.letter');
    expect(pageSizePreset('froglight.letter')).toEqual({
      width: 1275,
      height: 1650,
    });
    expect(pageSizePreset('nope.size')).toBeNull();
  });

  it('classifies square as portrait and swaps for orientation', () => {
    expect(orientationOf({ width: 100, height: 100 })).toBe('portrait');
    expect(orientationOf({ width: 200, height: 100 })).toBe('landscape');
    expect(orientSize({ width: 1240, height: 1754 }, 'landscape')).toEqual({
      width: 1754,
      height: 1240,
    });
    expect(orientSize({ width: 1754, height: 1240 }, 'portrait')).toEqual({
      width: 1240,
      height: 1754,
    });
    // Already-correct orientation is a no-op copy.
    expect(orientSize({ width: 1240, height: 1754 }, 'portrait')).toEqual({
      width: 1240,
      height: 1754,
    });
  });
});
