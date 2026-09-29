/**
 * Surface payload conformance§9
 * engine-free byte-level behavior only — round trips,
 * preservation, structured errors, partial recovery, limits.
 */

import { describe, expect, it } from 'vitest';
import { FroglightError } from '../errors.js';
import { utf8Decode, utf8Encode } from '../encoding.js';
import {
  SURFACE_FORMAT_VERSION,
  SURFACE_LIMITS,
  canonicalSurfaceJson,
  decodeSurfacePayload,
  decodeSurfacePayloadAsync,
  encodeSurfacePayload,
} from './codec.js';
import {
  ellipseObject,
  imageObject,
  infiniteFrame,
  rectangleObject,
  textObject,
  type SurfaceModel,
} from './model.js';

function cleanModel(): SurfaceModel {
  return {
    formatVersion: 1,
    frame: infiniteFrame(),
    order: ['r1', 't1', 'x1'],
    objects: {
      r1: rectangleObject('r1', { x: 0, y: 0, width: 10, height: 5 }),
      t1: textObject('t1', { x: 1, y: 2, text: 'hello' }),
      x1: {
        id: 'x1',
        type: 'acme.callout',
        tone: 'loud',
        payload: { nested: [1, 2] },
      },
    },
  };
}

function bytesOf(value: unknown): Uint8Array {
  return utf8Encode(JSON.stringify(value));
}

describe('round-trip identity', () => {
  it('keeps a large Surface open yielding to the UI while JSON is decoded', async () => {
    const objects: Record<string, unknown> = {};
    const order: string[] = [];
    for (let i = 0; i < 20_000; i++) {
      const id = `opaque-${i}`;
      order.push(id);
      objects[id] = { id, type: 'vendor.opaque', payload: [i, 'preserved'] };
    }
    const bytes = bytesOf({ formatVersion: 1, frame: { kind: 'infinite' }, order, objects });
    let uiTurn = false;
    setTimeout(() => { uiTurn = true; }, 0);
    const decoded = await decodeSurfacePayloadAsync(bytes, () => true);
    expect(uiTurn).toBe(true);
    expect(decoded?.model.order).toHaveLength(20_000);
    expect(decoded?.model.objects['opaque-19999']).toEqual(objects['opaque-19999']);
  });
  it('re-encodes an unmodified clean model to identical bytes', () => {
    const original = utf8Decode(encodeSurfacePayload(cleanModel()));
    const decoded = decodeSurfacePayload(utf8Encode(original));
    expect(decoded.warnings).toEqual([]);
    expect(utf8Decode(encodeSurfacePayload(decoded.model))).toBe(original);
  });

  it('preserves unknown members at payload, frame, and object level byte-stably', () => {
    const raw = {
      formatVersion: 1,
      frame: { kind: 'infinite', vendorNote: { keep: [true] } },
      order: ['o1'],
      objects: {
        o1: { id: 'o1', type: 'acme.thing', a: 1, nested: { b: null } },
      },
    };
    const bytes = bytesOf(raw);
    const decoded = decodeSurfacePayload(bytes);
    expect(decoded.warnings).toEqual([]);
    // The opaque object is untouched: verbatim.
    expect(decoded.model.objects['o1']).toEqual(raw.objects.o1);
    // With no unknown *payload-level* members, the round trip is byte-identical.
    expect(utf8Decode(encodeSurfacePayload(decoded.model))).toBe(
      `${JSON.stringify(raw, null, 2)}\n`,
    );
  });

  it('preserves unknown payload-level members semantically (re-emitted after known keys)', () => {
    const raw = {
      formatVersion: 1,
      frame: { kind: 'infinite' },
      order: ['o1'],
      objects: {
        o1: { id: 'o1', type: 'acme.thing', a: 1, nested: { b: null } },
      },
      futureTopLevel: 'keep me',
    };
    const decoded = decodeSurfacePayload(bytesOf(raw));
    expect(decoded.warnings).toEqual([]);
    expect(decoded.model.unknownFields).toEqual({ futureTopLevel: 'keep me' });
    expect(JSON.parse(utf8Decode(encodeSurfacePayload(decoded.model)))).toEqual(
      raw,
    );
  });

  it('keeps paint order stable across open/save', () => {
    const decoded = decodeSurfacePayload(encodeSurfacePayload(cleanModel()));
    expect(decoded.model.order).toEqual(['r1', 't1', 'x1']);
  });
});

describe('dual configuration acceptance', () => {
  it('bounded and infinite frames drive the identical codec path', () => {
    for (const frame of [
      { kind: 'infinite' },
      { kind: 'bounded', width: 800, height: 600 },
    ]) {
      const raw = { formatVersion: 1, frame, order: [], objects: {} };
      const decoded = decodeSurfacePayload(bytesOf(raw));
      expect(decoded.warnings).toEqual([]);
      expect(decoded.model.frame).toEqual(frame);
      expect(utf8Decode(encodeSurfacePayload(decoded.model))).toBe(
        `${JSON.stringify(raw, null, 2)}\n`,
      );
    }
  });
});

describe('canonical serialization', () => {
  it('emits UTF-8 JSON with two-space indent, LF newlines, trailing newline', () => {
    const text = canonicalSurfaceJson(cleanModel());
    expect(text.endsWith('\n')).toBe(true);
    expect(text).not.toContain('\r');
    expect(text.split('\n')[1]).toContain('"formatVersion": 1,');
    expect(utf8Decode(encodeSurfacePayload(cleanModel()))).toBe(text);
  });

  it('is deterministic across repeated encodes', () => {
    const model = decodeSurfacePayload(bytesOf(cleanModel())).model;
    expect(encodeSurfacePayload(model)).toEqual(encodeSurfacePayload(model));
  });
});

describe('structured rejection', () => {
  const expectCode = (run: () => unknown, code: string) => {
    try {
      run();
      expect.unreachable(`expected ${code}`);
    } catch (error) {
      expect(error).toBeInstanceOf(FroglightError);
      expect((error as FroglightError).code).toBe(code);
    }
  };

  it('rejects unparseable JSON and non-object documents', () => {
    expectCode(
      () => decodeSurfacePayload(utf8Encode('{nope')),
      'RECORD_CORRUPT',
    );
    expectCode(
      () => decodeSurfacePayload(utf8Encode('[1,2]')),
      'RECORD_CORRUPT',
    );
  });

  it('rejects missing or unsupported format versions', () => {
    expectCode(
      () =>
        decodeSurfacePayload(
          bytesOf({ frame: { kind: 'infinite' }, order: [], objects: {} }),
        ),
      'RECORD_CORRUPT',
    );
    expectCode(
      () =>
        decodeSurfacePayload(
          bytesOf({
            formatVersion: 99,
            frame: { kind: 'infinite' },
            order: [],
            objects: {},
          }),
        ),
      'UNKNOWN_FORMAT_VERSION',
    );
    expectCode(
      () =>
        decodeSurfacePayload(
          bytesOf({
            formatVersion: 2,
            frame: { kind: 'infinite' },
            order: [],
            objects: {},
          }),
        ),
      'UNKNOWN_FORMAT_VERSION',
    );
    expectCode(
      () =>
        decodeSurfacePayload(
          bytesOf({
            formatVersion: 1.5,
            frame: { kind: 'infinite' },
            order: [],
            objects: {},
          }),
        ),
      'UNKNOWN_FORMAT_VERSION',
    );
  });

  it('preserves unknown-version rejection in the cooperative decoder', async () => {
    const bytes = bytesOf({
      formatVersion: 99,
      frame: { kind: 'infinite' },
      order: [],
      objects: {},
    });
    await expect(decodeSurfacePayloadAsync(bytes, () => true)).rejects.toMatchObject({
      code: 'UNKNOWN_FORMAT_VERSION',
    });
  });

  it('rejects damaged frames, orders, and maps at payload level', () => {
    const base = { formatVersion: 1 };
    expectCode(() => decodeSurfacePayload(bytesOf(base)), 'RECORD_CORRUPT');
    expectCode(
      () =>
        decodeSurfacePayload(
          bytesOf({ ...base, frame: 'big', order: [], objects: {} }),
        ),
      'RECORD_CORRUPT',
    );
    expectCode(
      () =>
        decodeSurfacePayload(
          bytesOf({
            ...base,
            frame: { kind: 'bounded', width: -4, height: 6 },
            order: [],
            objects: {},
          }),
        ),
      'RECORD_CORRUPT',
    );
    expectCode(
      () =>
        decodeSurfacePayload(
          bytesOf({
            ...base,
            frame: { kind: 'infinite' },
            order: 'all',
            objects: {},
          }),
        ),
      'RECORD_CORRUPT',
    );
    expectCode(
      () =>
        decodeSurfacePayload(
          bytesOf({ ...base, frame: { kind: 'infinite' }, order: [] }),
        ),
      'RECORD_CORRUPT',
    );
    expectCode(
      () =>
        decodeSurfacePayload(
          bytesOf({
            ...base,
            frame: { kind: 'infinite' },
            order: [],
            objects: [],
          }),
        ),
      'RECORD_CORRUPT',
    );
  });
});

describe('partial recovery with warnings', () => {
  it('dedupes order entries keeping the first occurrence', () => {
    const raw = {
      formatVersion: 1,
      frame: { kind: 'infinite' },
      order: ['a', 'a', 'b'],
      objects: {
        a: rectangleObject('a', { x: 0, y: 0, width: 1, height: 1 }),
        b: rectangleObject('b', { x: 0, y: 0, width: 1, height: 1 }),
      },
    };
    const decoded = decodeSurfacePayload(bytesOf(raw));
    expect(decoded.model.order).toEqual(['a', 'b']);
    expect(decoded.warnings).toEqual([
      { code: 'DUPLICATE_ORDER_REFERENCE', refId: 'a' },
    ]);
  });

  it('drops dangling order references with a warning', () => {
    const raw = {
      formatVersion: 1,
      frame: { kind: 'infinite' },
      order: ['ghost', 'a'],
      objects: { a: rectangleObject('a', { x: 0, y: 0, width: 1, height: 1 }) },
    };
    const decoded = decodeSurfacePayload(bytesOf(raw));
    expect(decoded.model.order).toEqual(['a']);
    expect(decoded.warnings).toEqual([
      { code: 'DANGLING_ORDER_REFERENCE', refId: 'ghost' },
    ]);
  });

  it('appends orphaned objects to the end of paint order with a warning', () => {
    const raw = {
      formatVersion: 1,
      frame: { kind: 'infinite' },
      order: ['a'],
      objects: {
        a: rectangleObject('a', { x: 0, y: 0, width: 1, height: 1 }),
        lost: textObject('lost', { x: 3, y: 3, text: 'found' }),
      },
    };
    const decoded = decodeSurfacePayload(bytesOf(raw));
    expect(decoded.model.order).toEqual(['a', 'lost']);
    expect(decoded.warnings).toEqual([
      { code: 'OBJECT_MISSING_FROM_ORDER', objectId: 'lost' },
    ]);
  });

  it('drops malformed map entries and preserves them away from saves', () => {
    const raw = {
      formatVersion: 1,
      frame: { kind: 'infinite' },
      order: [],
      objects: { bad: 42, worse: { type: 'froglight.rectangle' } },
    };
    const decoded = decodeSurfacePayload(bytesOf(raw));
    expect(decoded.model.order).toEqual([]);
    expect(decoded.model.objects).toEqual({});
    expect(decoded.warnings).toEqual([
      { code: 'MALFORMED_OBJECT_DROPPED', objectId: 'bad' },
      { code: 'MALFORMED_OBJECT_DROPPED', objectId: 'worse' },
    ]);
  });

  it('preserves failing core records verbatim as opaque with warnings', () => {    const broken = {
      id: 'k',
      type: 'froglight.rectangle',
      x: 0,
      y: 0,
      width: 1,
    };
    const mismatched = {
      ...rectangleObject('m', { x: 0, y: 0, width: 1, height: 1 }),
      id: 'other',
    };
    const raw = {
      formatVersion: 1,
      frame: { kind: 'infinite' },
      order: [],
      objects: { k: broken, m: mismatched },
    };
    const decoded = decodeSurfacePayload(bytesOf(raw));
    expect(decoded.model.objects.k).toEqual(broken);
    expect(decoded.model.objects.m).toEqual(mismatched);
    // Opaque warnings during the map pass, then orphan-append warnings.
    expect(decoded.warnings).toEqual([
      { code: 'INVALID_CORE_OBJECT_OPAQUE', objectId: 'k' },
      { code: 'INVALID_CORE_OBJECT_OPAQUE', objectId: 'm' },
      { code: 'OBJECT_MISSING_FROM_ORDER', objectId: 'k' },
      { code: 'OBJECT_MISSING_FROM_ORDER', objectId: 'm' },
    ]);
  });
});

describe('locked flag + brush cap conformance (repair pass item 11)', () => {
  it('round-trips locked records verbatim with no warnings', () => {
    const raw = {
      formatVersion: 1,
      frame: { kind: 'infinite' },
      order: ['r', 's'],
      objects: {
        r: { ...rectangleObject('r', { x: 0, y: 0, width: 1, height: 1 }), locked: true },
        s: {
          id: 's',
          type: 'froglight.ink.stroke',
          points: [{ x: 0, y: 0 }],
          locked: true,
        },
      },
    };
    const decoded = decodeSurfacePayload(bytesOf(raw));
    expect(decoded.warnings).toEqual([]);
    expect(decoded.model.objects.r!.locked).toBe(true);
    expect(decoded.model.objects.s!.locked).toBe(true);
    const reloaded = decodeSurfacePayload(encodeSurfacePayload(decoded.model));
    expect(reloaded.warnings).toEqual([]);
    expect(reloaded.model.objects.r!.locked).toBe(true);
  });

  it('degrades non-boolean locked to opaque with a warning, preserving bytes', () => {
    const bad = {
      ...rectangleObject('r', { x: 0, y: 0, width: 1, height: 1 }),
      locked: 'yes',
    };
    const raw = {
      formatVersion: 1,
      frame: { kind: 'infinite' },
      order: [],
      objects: { r: bad },
    };
    const decoded = decodeSurfacePayload(bytesOf(raw));
    expect(decoded.model.objects.r).toEqual(bad);
    expect(decoded.warnings).toContainEqual({
      code: 'INVALID_CORE_OBJECT_OPAQUE',
      objectId: 'r',
    });
  });

  it('accepts the brush tip cap and rejects unknown caps as opaque', () => {
    const good = {
      id: 's',
      type: 'froglight.ink.stroke',
      points: [{ x: 0, y: 0 }],
      brush: { kind: 'highlighter', tip: { shape: 'round', cap: 'butt' } },
    };
    const bad = {
      id: 't',
      type: 'froglight.ink.stroke',
      points: [{ x: 0, y: 0 }],
      brush: { kind: 'ball', tip: { cap: 'spike' } },
    };
    const raw = {
      formatVersion: 1,
      frame: { kind: 'infinite' },
      order: ['s', 't'],
      objects: { s: good, t: bad },
    };
    const decoded = decodeSurfacePayload(bytesOf(raw));
    expect(decoded.model.objects.s).toEqual(good);
    expect(decoded.model.objects.t).toEqual(bad);
    expect(decoded.warnings).toContainEqual({
      code: 'INVALID_CORE_OBJECT_OPAQUE',
      objectId: 't',
    });
  });
});

describe('security limits', () => {
  const expectLimit = (run: () => unknown) => {
    try {
      run();
      expect.unreachable('expected FORMAT_LIMIT_EXCEEDED');
    } catch (error) {
      expect(error).toBeInstanceOf(FroglightError);
      expect((error as FroglightError).code).toBe('FORMAT_LIMIT_EXCEEDED');
    }
  };

  it('rejects oversized payloads before parsing', () => {
    expectLimit(() =>
      decodeSurfacePayload(new Uint8Array(SURFACE_LIMITS.maxFileBytes + 1)),
    );
  });

  it('rejects payloads beyond the object-count cap', () => {
    const objects: Record<string, unknown> = {};
    for (let i = 0; i <= SURFACE_LIMITS.maxObjects; i++) {
      objects[`o${i}`] = { id: `o${i}`, type: 'acme.dot' };
    }
    expectLimit(() =>
      decodeSurfacePayload(
        bytesOf({
          formatVersion: 1,
          frame: { kind: 'infinite' },
          order: [],
          objects,
        }),
      ),
    );
  });

  it('rejects out-of-range coordinates and non-finite numbers in core objects', () => {
    const huge = bytesOf({
      formatVersion: 1,
      frame: { kind: 'infinite' },
      order: ['h'],
      objects: {
        h: {
          ...rectangleObject('h', { x: 0, y: 0, width: 1, height: 1 }),
          x: 1e10,
        },
      },
    });
    expectLimit(() => decodeSurfacePayload(huge));

    // JSON has no NaN literal; 1e400 parses as Infinity.
    const infinite = utf8Encode(
      '{"formatVersion":1,"frame":{"kind":"infinite"},"order":["n"],' +
        '"objects":{"n":{"id":"n","type":"froglight.text","x":1e400,"y":0,"text":"x"}}}',
    );
    expectLimit(() => decodeSurfacePayload(infinite));
  });

  it('rejects oversized text payloads', () => {
    const long = 'x'.repeat(SURFACE_LIMITS.maxTextLength + 1);
    expectLimit(() =>
      decodeSurfacePayload(
        bytesOf({
          formatVersion: 1,
          frame: { kind: 'infinite' },
          order: ['t'],
          objects: { t: textObject('t', { x: 0, y: 0, text: long }) },
        }),
      ),
    );
  });

  it('rejects unsafe image asset paths outright', () => {
    expectLimit(() =>
      decodeSurfacePayload(
        bytesOf({
          formatVersion: 1,
          frame: { kind: 'infinite' },
          order: ['i'],
          objects: {
            i: imageObject('i', {
              x: 0,
              y: 0,
              width: 1,
              height: 1,
              src: '../evil.png',
              sha256: 'ab',
            }),
          },
        }),
      ),
    );
  });
});

describe('format version constant', () => {
  it('pins the implemented version', () => {
    expect(SURFACE_FORMAT_VERSION).toBe(1);
    expect(SURFACE_LIMITS.maxFileBytes).toBe(32 * 1024 * 1024);
    expect(SURFACE_LIMITS.maxObjects).toBe(100_000);
  });
});

describe('ellipse coverage in the shared path', () => {
  it('round-trips every core type together', () => {
    const model: SurfaceModel = {
      formatVersion: 1,
      frame: { kind: 'bounded', width: 100, height: 100 },
      order: ['e', 'i'],
      objects: {
        e: ellipseObject('e', {
          x: 10,
          y: 10,
          width: 30,
          height: 20,
          rotation: Math.PI / 6,
        }),
        i: imageObject('i', {
          x: 0,
          y: 0,
          width: 8,
          height: 8,
          src: 'assets/p.png',
          sha256: 'dd',
        }),
      },
    };
    const bytes = encodeSurfacePayload(model);
    const decoded = decodeSurfacePayload(bytes);
    expect(decoded.warnings).toEqual([]);
    expect(utf8Decode(encodeSurfacePayload(decoded.model))).toBe(
      utf8Decode(bytes),
    );
  });
});

describe('invalid scalar tilt recovery', () => {
  it('preserves an invalid core stroke verbatim as opaque data', () => {
    const raw = {
      formatVersion: 1,
      frame: { kind: 'infinite' },
      order: ['s1'],
      objects: {
        s1: {
          id: 's1',
          type: 'froglight.ink.stroke',
          points: [{ x: 0, y: 0, tilt: 0.3 }],
        },
      },
    };
    const decoded = decodeSurfacePayload(bytesOf(raw));
    expect(decoded.warnings).toEqual([
      { code: 'INVALID_CORE_OBJECT_OPAQUE', objectId: 's1' },
    ]);
    expect(decoded.model.objects.s1).toEqual(raw.objects.s1);
    expect(decodeSurfacePayload(encodeSurfacePayload(decoded.model)).model.objects.s1)
      .toEqual(raw.objects.s1);
  });
});
