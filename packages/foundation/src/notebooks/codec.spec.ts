/**
 * Notebook conformance:
 * engine-free byte-level behavior only — round trips, preservation,
 * structured errors, partial recovery, limits, page-order stability.
 */

import { describe, expect, it } from 'vitest';
import { FroglightError } from '../errors.js';
import { utf8Decode, utf8Encode } from '../encoding.js';
import {
  decodeNotebook,
  encodeNotebook,
  NOTEBOOK_LIMITS,
} from './codec.js';
import {
  emptySurface,
  boundedFrame,
  textObject,
  inkStrokeObject,
} from '../surfaces/model.js';
import {
  NOTEBOOK_FORMAT_VERSION,
  emptyNotebook,
  notebookPage,
} from './model.js';

function bytesOf(value: unknown): Uint8Array {
  return utf8Encode(JSON.stringify(value));
}

describe('round-trip identity', () => {
  it('re-encodes an unmodified clean two-page model to identical bytes', () => {
    const model = emptyNotebook('Journal');
    model.pageOrder.push('p1', 'p2');
    model.pages['p1'] = notebookPage('p1');
    model.pages['p2'] = notebookPage('p2', {
      template: 'froglight.grid',
      surface: emptySurface(boundedFrame(800, 600)),
    });
    const original = utf8Decode(encodeNotebook(model));
    const decoded = decodeNotebook(utf8Encode(original));
    expect(decoded.warnings).toEqual([]);
    expect(utf8Decode(encodeNotebook(decoded.model))).toBe(original);
  });

  it('round-trips ink and text objects inside page surfaces', () => {
    const surface = emptySurface(boundedFrame(400, 300));
    surface.objects['t1'] = textObject('t1', { x: 4, y: 4, text: 'page one' });
    surface.order.push('t1');
    surface.objects['s1'] = inkStrokeObject('s1', {
      points: [{ x: 0, y: 0 }, { x: 5, y: 5 }],
      width: 3,
    });
    surface.order.push('s1');

    const model = emptyNotebook();
    model.pages['p1'] = notebookPage('p1', { surface });
    model.pageOrder.push('p1');

    const decoded = decodeNotebook(encodeNotebook(model));
    expect(decoded.warnings).toEqual([]);
    const page = decoded.model.pages['p1'];
    expect(page).toMatchObject({ kind: 'page', id: 'p1' });
    if (page.kind !== 'page') return;
    expect(page.surface.order).toEqual(['t1', 's1']);
    expect((page.surface.objects['t1'] as { text?: string }).text).toBe('page one');
    // Byte-stable through a full decode→encode cycle.
    const once = utf8Decode(encodeNotebook(model));
    const twice = utf8Decode(encodeNotebook(decodeNotebook(utf8Encode(once)).model));
    expect(twice).toBe(once);
  });

  it('preserves unknown document-level members semantically (re-emitted after known members)', () => {
    const raw = {
      vendorExtra: { nested: [1, 2, { deep: true }] },
      formatVersion: 1,
      meta: {},
      pageOrder: ['p1'],
      pages: { p1: {
        id: 'p1',
        base: { kind: 'template', template: 'froglight.blank' },
        surface: JSON.parse(JSON.stringify(emptySurface(boundedFrame(100, 100)))),
      } },
    };
    const decoded = decodeNotebook(bytesOf(raw));
    expect(decoded.warnings).toEqual([]);
    expect(utf8Decode(encodeNotebook(decoded.model))).toBe(
      `${JSON.stringify(
        {
          formatVersion: 1,
          meta: {},
          pageOrder: ['p1'],
          pages: {
            p1: raw.pages.p1,
          },
          vendorExtra: { nested: [1, 2, { deep: true }] },
        },
        null,
        2,
      )}\n`,
    );
  });

  it('preserves unknown members inside meta and page records byte-stably', () => {
    const raw = {
      formatVersion: NOTEBOOK_FORMAT_VERSION,
      meta: { title: 'T', vendorMeta: 'keep-me' },
      pageOrder: ['p1'],
      pages: {
        p1: {
          id: 'p1',
          vendorPageField: { a: [1] },
          base: { kind: 'template', template: 'froglight.blank' },
          surface: JSON.parse(JSON.stringify(emptySurface(boundedFrame(10, 10)))),
        },
      },
    };
    const bytes = bytesOf(raw);
    const decoded = decodeNotebook(bytes);
    expect(decoded.warnings).toEqual([]);
    expect(utf8Decode(encodeNotebook(decoded.model))).toBe(
      `${JSON.stringify(raw, null, 2)}\n`,
    );
  });

  it('serializes with two-space indent, LF newlines, and trailing newline', () => {
    const model = emptyNotebook('X');
    model.pages['p1'] = notebookPage('p1');
    model.pageOrder.push('p1');
    const text = utf8Decode(encodeNotebook(model));
    expect(text.startsWith('{\n  "formatVersion"')).toBe(true);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.includes('\r')).toBe(false);
  });
});

describe('structured errors', () => {
  it('rejects unknown format versions without best-effort parsing', () => {
    for (const formatVersion of [0, 2, 99]) {
      const raw = { formatVersion, meta: {}, pageOrder: [], pages: {} };
      expect(() => decodeNotebook(bytesOf(raw))).toThrowError(FroglightError);
      try {
        decodeNotebook(bytesOf(raw));
      } catch (error) {
        expect((error as FroglightError).code).toBe('UNKNOWN_FORMAT_VERSION');
      }
    }
  });

  it('fails loudly on document-level corruption', () => {
    expect(() => decodeNotebook(utf8Encode('{not json'))).toThrowError(FroglightError);
    const missingPages = { formatVersion: 1, meta: {}, pageOrder: [] };
    try {
      decodeNotebook(bytesOf(missingPages));
      expect.unreachable();
    } catch (error) {
      expect((error as FroglightError).code).toBe('RECORD_CORRUPT');
    }
    const badOrder = {
      formatVersion: 1,
      meta: {},
      pageOrder: 'p1',
      pages: {},
    };
    try {
      decodeNotebook(bytesOf(badOrder));
      expect.unreachable();
    } catch (error) {
      expect((error as FroglightError).code).toBe('RECORD_CORRUPT');
    }
  });

  it('enforces security limits as structured errors', () => {
    const pages: Record<string, unknown> = {};
    for (let i = 0; i < 1001; i += 1) {
      pages[`p${i}`] = {
        id: `p${i}`,
        surface: JSON.parse(JSON.stringify(emptySurface(boundedFrame(10, 10)))),
      };
    }
    const raw = { formatVersion: 1, meta: {}, pageOrder: Object.keys(pages), pages };
    try {
      decodeNotebook(bytesOf(raw));
      expect.unreachable();
    } catch (error) {
      expect((error as FroglightError).code).toBe('FORMAT_LIMIT_EXCEEDED');
    }
  });

  it('enforces the same page and label limits on writes', () => {
    const tooMany = emptyNotebook();
    for (let i = 0; i <= NOTEBOOK_LIMITS.maxPages; i += 1) {
      const id = `p${i}`;
      tooMany.pages[id] = { kind: 'opaque', id, raw: { id, future: true } };
      tooMany.pageOrder.push(id);
    }
    expect(() => encodeNotebook(tooMany)).toThrowError(FroglightError);

    const tooLong = emptyNotebook();
    tooLong.pages.p1 = notebookPage('p1', { label: 'x'.repeat(NOTEBOOK_LIMITS.maxLabelLength + 1) });
    tooLong.pageOrder.push('p1');
    expect(() => encodeNotebook(tooLong)).toThrowError(FroglightError);
  });

  it('propagates hard limits struck inside a single page payload', () => {
    // A bounded frame whose width exceeds the coordinate cap is rejected by
    // the surface codec even though the shape is otherwise valid.
    const raw = {
      formatVersion: 1,
      meta: {},
      pageOrder: ['p1'],
      pages: {
        p1: {
          id: 'p1',
          base: { kind: 'template', template: 'froglight.blank' },
          surface: {
            formatVersion: 1,
            frame: { kind: 'bounded', width: 1e12, height: 10 },
            order: [],
            objects: {},
          },
        },
      },
    };
    try {
      decodeNotebook(bytesOf(raw));
      expect.unreachable();
    } catch (error) {
      expect((error as FroglightError).code).toBe('FORMAT_LIMIT_EXCEEDED');
    }
  });
});

describe('per-page damage isolation', () => {
  const goodPayload = (): Record<string, unknown> =>
    JSON.parse(JSON.stringify(emptySurface(boundedFrame(50, 50)))) as Record<string, unknown>;

  it('preserves pages with unreadable payloads verbatim as opaque-with-warning', () => {
    const raw = {
      formatVersion: 1,
      meta: {},
      pageOrder: ['bad', 'good'],
      pages: {
        bad: {
          id: 'bad',
          base: { kind: 'template', template: 'froglight.blank' },
          surface: { formatVersion: 1, frame: 'oops', order: [], objects: {} },
        },
        good: {
          id: 'good',
          base: { kind: 'template', template: 'froglight.blank' },
          surface: goodPayload(),
        },
      },
    };
    const decoded = decodeNotebook(bytesOf(raw));
    expect(decoded.model.pages['bad']).toMatchObject({ kind: 'opaque', id: 'bad' });
    expect(decoded.model.pages['good']).toMatchObject({ kind: 'page', id: 'good' });
    expect(decoded.warnings).toEqual([{ code: 'INVALID_PAGE_OPAQUE', pageId: 'bad' }]);
    // The damaged Surface survives untouched inside the current page shape.
    expect(utf8Decode(encodeNotebook(decoded.model))).toBe(
      `${JSON.stringify({
        ...raw,
        formatVersion: 1,
        pages: raw.pages,
      }, null, 2)}\n`,
    );
  });

  it('preserves pages carrying an unsupported payload version verbatim', () => {
    const raw = {
      formatVersion: 1,
      meta: {},
      pageOrder: ['future'],
      pages: {
        future: {
          id: 'future',
          base: { kind: 'template', template: 'froglight.blank' },
          surface: { ...goodPayload(), formatVersion: 99 },
        },
      },
    };
    const decoded = decodeNotebook(bytesOf(raw));
    expect(decoded.model.pages['future']).toMatchObject({ kind: 'opaque' });
    expect(utf8Decode(encodeNotebook(decoded.model))).toBe(
      `${JSON.stringify({
        ...raw,
        formatVersion: 1,
        pages: {
          future: {
            id: 'future',
            base: { kind: 'template', template: 'froglight.blank' },
            surface: raw.pages.future.surface,
          },
        },
      }, null, 2)}\n`,
    );
  });

  it('preserves unbounded-frame pages verbatim and flags them for consumers', () => {
    const raw = {
      formatVersion: 1,
      meta: {},
      pageOrder: ['inf'],
      pages: {
        inf: {
          id: 'inf',
          base: { kind: 'template', template: 'froglight.blank' },
          surface: JSON.parse(JSON.stringify(emptySurface({ kind: 'infinite' }))),
        },
      },
    };
    const decoded = decodeNotebook(bytesOf(raw));
    expect(decoded.model.pages['inf']).toMatchObject({ kind: 'opaque' });
    expect(decoded.warnings).toEqual([{ code: 'PAGE_SURFACE_UNBOUNDED', pageId: 'inf' }]);
  });

  it('recovers duplicate, dangling, and unordered page-order entries individually', () => {
    const raw = {
      formatVersion: 1,
      meta: {},
      pageOrder: ['a', 'a', 'ghost'],
      pages: {
        b: { id: 'b', base: { kind: 'template', template: 'froglight.blank' }, surface: goodPayload() },
        a: { id: 'a', base: { kind: 'template', template: 'froglight.blank' }, surface: goodPayload() },
      },
    };
    const decoded = decodeNotebook(bytesOf(raw));
    expect(decoded.model.pageOrder).toEqual(['a', 'b']);
    expect(decoded.warnings).toEqual([
      { code: 'DUPLICATE_PAGE_REFERENCE', pageId: 'a' },
      { code: 'DANGLING_PAGE_REFERENCE', pageId: 'ghost' },
      { code: 'PAGE_MISSING_FROM_ORDER', pageId: 'b' },
    ]);
  });

  it('drops malformed page entries with warnings', () => {
    const raw = {
      formatVersion: 1,
      meta: {},
      pageOrder: ['nokey'],
      pages: {
        nokey: { surface: goodPayload() }, // id missing
        wrongid: { id: 'other', surface: goodPayload() },
        notobject: 42,
      },
    };
    const decoded = decodeNotebook(bytesOf(raw));
    expect(Object.keys(decoded.model.pages)).toEqual([]);
    expect(decoded.warnings.map((w) => w.code)).toEqual([
      'MALFORMED_PAGE_DROPPED',
      'MALFORMED_PAGE_DROPPED',
      'MALFORMED_PAGE_DROPPED',
      'DANGLING_PAGE_REFERENCE',
    ]);
  });

  it('treats invalid label/template members as opaque but over-cap labels as hard limits', () => {
    const badLabel = {
      formatVersion: 1,
      meta: {},
      pageOrder: ['p'],
      pages: { p: { id: 'p', label: 7, surface: goodPayload() } },
    };
    const decodedBadLabel = decodeNotebook(bytesOf(badLabel));
    expect(decodedBadLabel.model.pages['p']).toMatchObject({ kind: 'opaque' });

    const longLabel = 'x'.repeat(100_001);
    const capped = {
      formatVersion: 1,
      meta: {},
      pageOrder: ['p'],
      pages: { p: { id: 'p', label: longLabel, surface: goodPayload() } },
    };
    try {
      decodeNotebook(bytesOf(capped));
      expect.unreachable();
    } catch (error) {
      expect((error as FroglightError).code).toBe('FORMAT_LIMIT_EXCEEDED');
    }
  });
});
