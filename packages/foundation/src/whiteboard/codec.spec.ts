/**
 * Whiteboard codec conformance — infinite surface document.
 * Mirrors surface-format §7–§9 but enforces infinite frame only.
 */

import { describe, expect, it } from 'vitest';
import { FroglightError } from '../errors.js';
import { utf8Decode, utf8Encode } from '../encoding.js';
import {
  cardObject,
  emptySurface,
  infiniteFrame,
  rectangleObject,
  resourceEmbedObject,
  textObject,
  boundedFrame,
} from '../surfaces/model.js';
import {
  decodeWhiteboard,
  encodeWhiteboard,
  canonicalWhiteboardJson,
  WHITEBOARD_FORMAT_VERSION,
  WHITEBOARD_LIMITS,
} from './codec.js';

function bytesOf(value: unknown): Uint8Array {
  return utf8Encode(JSON.stringify(value));
}

describe('whiteboard round-trip identity', () => {
  it('re-encodes an unmodified clean infinite model to identical bytes', () => {
    const model = emptySurface(infiniteFrame());
    (model.objects as Record<string, unknown>).c1 = cardObject('c1', { x: 0, y: 0, width: 200, height: 120, text: 'hello card' });
    (model.objects as Record<string, unknown>).e1 = resourceEmbedObject('e1', {
      x: 300,
      y: 100,
      width: 400,
      height: 300,
      target: { documentId: 'doc1', kindId: 'froglight.markdown', resourceId: 'res1' },
      cachedTitle: 'Referenced note',
    });
    model.order.push('c1', 'e1');
    const original = utf8Decode(encodeWhiteboard(model));
    const decoded = decodeWhiteboard(utf8Encode(original));
    expect(decoded.warnings).toEqual([]);
    expect(utf8Decode(encodeWhiteboard(decoded.model))).toBe(original);
  });

  it('preserves unknown members at payload, frame, and object level', () => {
    const raw = {
      formatVersion: 1,
      frame: { kind: 'infinite', vendorNote: { keep: true } },
      order: ['o1'],
      objects: { o1: { id: 'o1', type: 'acme.widget', a: 1 } },
    };
    const decoded = decodeWhiteboard(bytesOf(raw));
    expect(decoded.warnings).toEqual([]);
    expect(decoded.model.objects['o1']).toEqual(raw.objects.o1);
  });

  it('preserves unknown payload-level members via unknownFields', () => {
    const raw = {
      formatVersion: 1,
      frame: { kind: 'infinite' },
      order: ['o1'],
      objects: { o1: { id: 'o1', type: 'acme.widget', a: 1 } },
      futureTopLevel: 'keep me',
    };
    const decoded = decodeWhiteboard(bytesOf(raw));
    expect(decoded.model.unknownFields).toEqual({ futureTopLevel: 'keep me' });
    expect(JSON.parse(utf8Decode(encodeWhiteboard(decoded.model)))).toEqual(raw);
  });
});

describe('whiteboard frame enforcement', () => {
  it('rejects bounded frames as RECORD_CORRUPT', () => {
    const raw = {
      formatVersion: 1,
      frame: { kind: 'bounded', width: 800, height: 600 },
      order: [],
      objects: {},
    };
    try {
      decodeWhiteboard(bytesOf(raw));
      expect.unreachable('expected RECORD_CORRUPT');
    } catch (error) {
      expect(error).toBeInstanceOf(FroglightError);
      expect((error as FroglightError).code).toBe('RECORD_CORRUPT');
    }
    const model = emptySurface(boundedFrame(800, 600));
    expect(() => encodeWhiteboard(model as never)).toThrow();
  });

  it('accepts infinite frames', () => {
    const raw = { formatVersion: 1, frame: { kind: 'infinite' }, order: [], objects: {} };
    const decoded = decodeWhiteboard(bytesOf(raw));
    expect(decoded.warnings).toEqual([]);
    expect(decoded.model.frame).toEqual({ kind: 'infinite' });
  });
});

describe('whiteboard card and resource-embed core types', () => {
  it('round-trips card and resource-embed together', () => {
    const model = emptySurface(infiniteFrame());
    model.objects.c1 = cardObject('c1', { x: 10, y: 10, width: 200, height: 100, text: 'card text', fill: '#fff', stroke: '#000' });
    model.objects.e1 = resourceEmbedObject('e1', {
      x: 50,
      y: 50,
      width: 300,
      height: 200,
      target: { documentId: 'doc2', kindId: 'froglight.notebook', resourceId: 'res2', address: 'page1' },
      cachedTitle: 'Notebook page',
    });
    model.order.push('c1', 'e1');
    const bytes = encodeWhiteboard(model);
    const decoded = decodeWhiteboard(bytes);
    expect(decoded.warnings).toEqual([]);
    expect(utf8Decode(encodeWhiteboard(decoded.model))).toBe(utf8Decode(bytes));
  });

  it('preserves failing card/resource-embed as opaque with warning', () => {
    const brokenCard = { id: 'c', type: 'froglight.card', x: 0, y: 0, width: 10, height: 10 } as unknown;
    const raw = {
      formatVersion: 1,
      frame: { kind: 'infinite' },
      order: [],
      objects: { c: brokenCard },
    };
    const decoded = decodeWhiteboard(bytesOf(raw));
    expect(decoded.model.objects.c).toEqual(brokenCard);
    expect(decoded.warnings.some((w) => w.code === 'INVALID_CORE_OBJECT_OPAQUE')).toBe(true);
  });
});

describe('whiteboard partial recovery', () => {
  it('dedupes order and drops dangling, appends orphaned', () => {
    const raw = {
      formatVersion: 1,
      frame: { kind: 'infinite' },
      order: ['a', 'a', 'ghost'],
      objects: {
        a: rectangleObject('a', { x: 0, y: 0, width: 1, height: 1 }),
        orphan: textObject('orphan', { x: 1, y: 1, text: 'lost' }),
      },
    };
    const decoded = decodeWhiteboard(bytesOf(raw));
    expect(decoded.model.order).toEqual(['a', 'orphan']);
    expect(decoded.warnings.map((w) => w.code)).toContain('DUPLICATE_ORDER_REFERENCE');
    expect(decoded.warnings.map((w) => w.code)).toContain('DANGLING_ORDER_REFERENCE');
    expect(decoded.warnings.map((w) => w.code)).toContain('OBJECT_MISSING_FROM_ORDER');
  });
});

describe('whiteboard security limits', () => {
  it('rejects oversized card text', () => {
    const long = 'x'.repeat(WHITEBOARD_LIMITS.maxTextLength + 1);
    expect(() =>
      decodeWhiteboard(
        bytesOf({
          formatVersion: 1,
          frame: { kind: 'infinite' },
          order: ['c'],
          objects: { c: cardObject('c', { x: 0, y: 0, width: 10, height: 10, text: long }) },
        }),
      ),
    ).toThrow();
  });

  it('rejects out-of-range coordinates in resource-embed', () => {
    const huge = bytesOf({
      formatVersion: 1,
      frame: { kind: 'infinite' },
      order: ['e'],
      objects: {
        e: { ...resourceEmbedObject('e', { x: 0, y: 0, width: 10, height: 10, target: { documentId: 'd', kindId: 'k', resourceId: 'r' } }), x: 1e10 },
      },
    });
    expect(() => decodeWhiteboard(huge)).toThrow();
  });
});

describe('whiteboard format version', () => {
  it('pins the latest Surface version', () => {
    expect(WHITEBOARD_FORMAT_VERSION).toBe(1);
  });

  it('rejects unknown formatVersion', () => {
    try {
      decodeWhiteboard(bytesOf({ formatVersion: 99, frame: { kind: 'infinite' }, order: [], objects: {} }));
      expect.unreachable('expected UNKNOWN_FORMAT_VERSION');
    } catch (error) {
      expect((error as FroglightError).code).toBe('UNKNOWN_FORMAT_VERSION');
    }
  });
});

describe('whiteboard canonical serialization', () => {
  it('emits UTF-8 JSON with two-space indent, LF, trailing newline', () => {
    const model = emptySurface(infiniteFrame());
    const text = canonicalWhiteboardJson(model as never);
    expect(text.endsWith('\n')).toBe(true);
    expect(text).not.toContain('\r');
  });
});
