import { describe, expect, it } from 'vitest';
import { preferredReadingMode } from './readingMode.js';

describe('preferredReadingMode', () => {
  it('prefers the per-document reading default over the workspace mode', () => {
    expect(
      preferredReadingMode({
        perDocumentReading: true,
        defaultView: 'split',
        availableModes: ['edit', 'split', 'reading'],
      }),
    ).toBe('reading');
  });

  it('honors split when the document kind supports it', () => {
    expect(
      preferredReadingMode({
        perDocumentReading: false,
        defaultView: 'split',
        availableModes: ['edit', 'split', 'reading'],
      }),
    ).toBe('split');
  });

  it('keeps editing when the requested mode is unavailable for this kind', () => {
    expect(
      preferredReadingMode({
        perDocumentReading: false,
        defaultView: 'split',
        availableModes: ['edit', 'reading'],
      }),
    ).toBe('edit');
    expect(
      preferredReadingMode({
        perDocumentReading: true,
        defaultView: 'edit',
        availableModes: ['edit'],
      }),
    ).toBe('edit');
  });

  it.each(['edit', 'reading'] as const)(
    'honors the %s workspace default',
    (defaultView) => {
      expect(
        preferredReadingMode({
          perDocumentReading: false,
          defaultView,
          availableModes: ['edit', 'reading'],
        }),
      ).toBe(defaultView);
    },
  );
});
