/**
 * Surface text role, appearance, and bounds conformance. The tests pin the
 * current wire shape, deterministic measurement, and opaque-field preservation
 * without mounting an editor engine.
 */

import { describe, expect, it } from 'vitest';
import { utf8Decode, utf8Encode } from '../encoding.js';
import {
  decodeSurfacePayload,
  encodeSurfacePayload,
} from './codec.js';
import {
  SURFACE_MAX_COORDINATE,
  TEXT_DEFAULT_WRAP_WIDTH,
  effectiveSurfaceTextSizeOf,
  effectiveTextSizeOf,
  isValidCoreSurfaceObject,
  isValidWrapWidth,
  textAlignOf,
  textBoldOf,
  textItalicOf,
  textObject,
  textRoleOf,
  textWrapWidthOf,
  type SurfaceModel,
} from './model.js';
import {
  centerOfBounds,
  estimateTextLineWidth,
  rotatedBoundsAabb,
  splitTextLines,
  textEstBounds,
  textV2EstBounds,
  textV2Lines,
} from './geometry.js';
import { createDefaultSurfaceObjectTypeRegistry } from './objects.js';
import { compileScene } from './render.js';
import { RecordingSurfaceBackend } from '../testing/headless-surface-backend.js';
import { createCamera } from './geometry.js';
import { renderSurfaceScene } from './render.js';

function bytesOf(value: unknown): Uint8Array {
  return utf8Encode(JSON.stringify(value));
}

function modelWithText(id: string, record: Record<string, unknown>): SurfaceModel {
  return {
    formatVersion: 1,
    frame: { kind: 'infinite' },
    order: [id],
    objects: { [id]: { id, type: 'froglight.text', ...record } as never },
  };
}

describe('Surface text wire table (frozen fixtures)', () => {
  it('role absent means body/start/unbounded (t1)', () => {
    const record = {
      id: 't1',
      type: 'froglight.text',
      x: 10,
      y: 20,
      text: 'plain body',
    } as never;
    expect(textRoleOf(record)).toBe('body');
    expect(textAlignOf(record)).toBe('start');
    expect(textWrapWidthOf(record)).toBeNull();
    expect(isValidCoreSurfaceObject(record)).toBe(true);
    const decoded = decodeSurfacePayload(
      bytesOf({
        formatVersion: 1,
        frame: { kind: 'infinite' },
        order: ['t1'],
        objects: { t1: record },
      }),
    );
    expect(decoded.warnings).toEqual([]);
    expect(textRoleOf(decoded.model.objects['t1']!)).toBe('body');
  });

  it('explicit heading role (t2)', () => {
    const record = textObject('t2', {
      x: 10,
      y: 40,
      text: 'Chapter',
      role: 'heading',
    });
    expect(textRoleOf(record)).toBe('heading');
    expect(isValidCoreSurfaceObject(record)).toBe(true);
    const decoded = decodeSurfacePayload(encodeSurfacePayload(modelWithText('t2', record as never)));
    expect(decoded.warnings).toEqual([]);
    expect(decoded.model.objects['t2']).toMatchObject({ role: 'heading' });
  });

  it('caption centered with wrap width (t3)', () => {
    const record = textObject('t3', {
      x: 10,
      y: 60,
      text: 'Figure 1.',
      role: 'caption',
      appearance: { align: 'center', wrapWidth: 240 },
    });
    expect(textRoleOf(record)).toBe('caption');
    expect(textAlignOf(record)).toBe('center');
    expect(textWrapWidthOf(record)).toBe(240);
    expect(isValidCoreSurfaceObject(record)).toBe(true);
  });

  it('label end-aligned (t4)', () => {
    const record = textObject('t4', {
      x: 10,
      y: 80,
      text: 'axis',
      role: 'label',
      appearance: { align: 'end' },
    });
    expect(textRoleOf(record)).toBe('label');
    expect(textAlignOf(record)).toBe('end');
    expect(textWrapWidthOf(record)).toBeNull();
  });

  it('unknown role renders as body and round-trips verbatim (t5)', () => {
    const raw = {
      id: 't5',
      type: 'froglight.text',
      x: 10,
      y: 100,
      text: 'future kind',
      role: 'pull-quote',
    };
    const decoded = decodeSurfacePayload(
      bytesOf({
        formatVersion: 1,
        frame: { kind: 'infinite' },
        order: ['t5'],
        objects: { t5: raw },
      }),
    );
    // Frozen §1.2 rules 2+6: stays valid, NO warning, default render.
    expect(decoded.warnings).toEqual([]);
    expect(isValidCoreSurfaceObject(decoded.model.objects['t5']!)).toBe(true);
    expect(textRoleOf(decoded.model.objects['t5']!)).toBe('body');
    // Verbatim: unknown member survives byte-stably.
    expect((decoded.model.objects['t5'] as Record<string, unknown>).role).toBe(
      'pull-quote',
    );
    const reEncoded = JSON.parse(utf8Decode(encodeSurfacePayload(decoded.model)));
    expect(reEncoded.objects['t5'].role).toBe('pull-quote');
    // Compile normalizes to body for backends (no payload knowledge).
    const items = compileScene(decoded.model, createDefaultSurfaceObjectTypeRegistry());
    expect(items[0]).toMatchObject({ kind: 'text', role: 'body' });
  });

  it('invalid appearance degrades layout only, bytes preserved (t6)', () => {
    const raw = {
      id: 't6',
      type: 'froglight.text',
      x: 10,
      y: 120,
      text: 'bad wrap',
      role: 'body',
      appearance: { align: 'justify', wrapWidth: -5 },
    };
    const decoded = decodeSurfacePayload(
      bytesOf({
        formatVersion: 1,
        frame: { kind: 'infinite' },
        order: ['t6'],
        objects: { t6: raw },
      }),
    );
    // Frozen contract: stays valid, NO warning (task summary said
    // opaque-with-warning — contract wins; see handoff). Default layout.
    expect(decoded.warnings).toEqual([]);
    expect(isValidCoreSurfaceObject(decoded.model.objects['t6']!)).toBe(true);
    expect(textRoleOf(decoded.model.objects['t6']!)).toBe('body');
    expect(textAlignOf(decoded.model.objects['t6']!)).toBe('start');
    expect(textWrapWidthOf(decoded.model.objects['t6']!)).toBeNull();
    expect(decoded.model.objects['t6']).toMatchObject({
      appearance: { align: 'justify', wrapWidth: -5 },
    });
    const items = compileScene(decoded.model, createDefaultSurfaceObjectTypeRegistry());
    expect(items[0]).toMatchObject({ kind: 'text', role: 'body', align: 'start' });
    expect(items[0]).not.toHaveProperty('wrapWidth');
  });
});

describe('Surface text validation', () => {
  it('accepts all known roles/aligns and valid wrap widths', () => {
    for (const role of ['body', 'heading', 'caption', 'label'] as const) {
      const rec = textObject('t', { x: 0, y: 0, text: 'hi', role });
      expect(isValidCoreSurfaceObject(rec)).toBe(true);
      expect(textRoleOf(rec)).toBe(role);
    }
    for (const align of ['start', 'center', 'end'] as const) {
      const rec = textObject('t', { x: 0, y: 0, text: 'hi', appearance: { align } });
      expect(isValidCoreSurfaceObject(rec)).toBe(true);
      expect(textAlignOf(rec)).toBe(align);
    }
    expect(isValidWrapWidth(240)).toBe(true);
    expect(isValidWrapWidth(0.5)).toBe(true);
    expect(isValidWrapWidth(SURFACE_MAX_COORDINATE)).toBe(true);
  });

  it('bad wrapWidth degrades to unbounded without warning or hard error', () => {
    for (const bad of [0, -5, NaN, Infinity, -Infinity, SURFACE_MAX_COORDINATE + 1, '240' as unknown, null as unknown]) {
      const raw = {
        id: 't',
        type: 'froglight.text',
        x: 1,
        y: 2,
        text: 'hi',
        appearance: { wrapWidth: bad },
      } as never;
      expect(isValidCoreSurfaceObject(raw)).toBe(true);
      expect(textWrapWidthOf(raw)).toBeNull();
      const decoded = decodeSurfacePayload(
        bytesOf({ formatVersion: 1, frame: { kind: 'infinite' }, order: ['t'], objects: { t: raw } }),
      );
      expect(decoded.warnings).toEqual([]);
      expect(textWrapWidthOf(decoded.model.objects['t']!)).toBeNull();
    }
  });

  it('unknown align falls back to start and preserves verbatim', () => {
    const raw = {
      id: 't',
      type: 'froglight.text',
      x: 0,
      y: 0,
      text: 'hi',
      appearance: { align: 'justify', wrapWidth: 100 },
    } as never;
    expect(textAlignOf(raw)).toBe('start');
    expect(textWrapWidthOf(raw)).toBe(100);
    expect(isValidCoreSurfaceObject(raw)).toBe(true);
  });

  it('non-finite geometry still hard-errors (existing §9 rules)', () => {
    // Over-cap trips FORMAT_LIMIT_EXCEEDED via bytes.
    const huge = bytesOf({
      formatVersion: 1,
      frame: { kind: 'infinite' },
      order: ['t'],
      objects: {
        t: { id: 't', type: 'froglight.text', x: 1e10, y: 0, text: 'hi' },
      },
    });
    expect(() => decodeSurfacePayload(huge)).toThrow();
    // JSON has no NaN literal; 1e400 parses as Infinity (see codec.spec).
    const infinite = utf8Encode(
      '{"formatVersion":1,"frame":{"kind":"infinite"},"order":["t"],' +
        '"objects":{"t":{"id":"t","type":"froglight.text","x":1e400,"y":0,"text":"hi"}}}',
    );
    expect(() => decodeSurfacePayload(infinite)).toThrow();
  });

  it('effective size defaults to 16 when absent or invalid', () => {
    expect(effectiveTextSizeOf({})).toBe(16);
    expect(effectiveTextSizeOf({ size: undefined })).toBe(16);
    expect(effectiveTextSizeOf({ size: 20 })).toBe(20);
    expect(effectiveTextSizeOf({ size: 0 })).toBe(16);
    expect(effectiveTextSizeOf({ size: -3 })).toBe(16);
    expect(effectiveTextSizeOf({ size: NaN })).toBe(16);
    expect(effectiveTextSizeOf({ size: Infinity })).toBe(16);
  });

  it('geometry delegates size and wrap limits to the model single source', () => {
    // At-cap values are usable; over-cap degrades exactly like the model
    // predicates (no literal 1e9 restated in geometry).
    expect(effectiveTextSizeOf({ size: SURFACE_MAX_COORDINATE })).toBe(
      SURFACE_MAX_COORDINATE,
    );
    expect(effectiveTextSizeOf({ size: SURFACE_MAX_COORDINATE + 1 })).toBe(16);
    expect(
      textV2EstBounds(
        { x: 0, y: 0, size: SURFACE_MAX_COORDINATE + 1 },
        'hi',
      ),
    ).toEqual(textV2EstBounds({ x: 0, y: 0 }, 'hi'));
    expect(
      textV2EstBounds(
        { x: 0, y: 0, size: 16, appearance: { wrapWidth: SURFACE_MAX_COORDINATE + 1 } },
        'hi',
      ),
    ).toEqual(textV2EstBounds({ x: 0, y: 0, size: 16 }, 'hi'));
  });
});

describe('Surface text codec', () => {
  it('round-trips role/appearance with byte stability and no version bump', () => {
    const model: SurfaceModel = {
      formatVersion: 1,
      frame: { kind: 'infinite' },
      order: ['t1', 't2'],
      objects: {
        t1: textObject('t1', { x: 1, y: 2, text: 'hello', role: 'heading' }),
        t2: textObject('t2', {
          x: 3,
          y: 4,
          text: 'cap',
          role: 'caption',
          appearance: { align: 'center', wrapWidth: 120 },
        }),
      },
    };
    const first = utf8Decode(encodeSurfacePayload(model));
    const decoded = decodeSurfacePayload(utf8Encode(first));
    expect(decoded.warnings).toEqual([]);
    expect(decoded.model.formatVersion).toBe(1);
    expect(utf8Decode(encodeSurfacePayload(decoded.model))).toBe(first);
  });

  it('legacy records without role/appearance open as body/start/unbounded', () => {
    const raw = {
      formatVersion: 1,
      frame: { kind: 'infinite' },
      order: ['t1'],
      objects: { t1: { id: 't1', type: 'froglight.text', x: 5, y: 6, text: 'hi' } },
    };
    const decoded = decodeSurfacePayload(bytesOf(raw));
    expect(decoded.warnings).toEqual([]);
    const rec = decoded.model.objects['t1']!;
    expect(textRoleOf(rec)).toBe('body');
    expect(textAlignOf(rec)).toBe('start');
    expect(textWrapWidthOf(rec)).toBeNull();
    const items = compileScene(decoded.model, createDefaultSurfaceObjectTypeRegistry());
    expect(items[0]).toMatchObject({ kind: 'text', role: 'body', align: 'start' });
  });

  it('constructor emits canonical field order (role after text, appearance last)', () => {
    expect(
      JSON.stringify(
        textObject('t', { x: 1, y: 2, text: 'hi', role: 'heading', color: '#fff', appearance: { align: 'center', wrapWidth: 10 } }),
      ),
    ).toBe(
      JSON.stringify({
        id: 't',
        type: 'froglight.text',
        x: 1,
        y: 2,
        text: 'hi',
        role: 'heading',
        color: '#fff',
        appearance: { align: 'center', wrapWidth: 10 },
      }),
    );
    expect(JSON.stringify(textObject('t', { x: 1, y: 2, text: 'hi' }))).toBe(
      JSON.stringify({ id: 't', type: 'froglight.text', x: 1, y: 2, text: 'hi' }),
    );
  });
});

describe('Surface text bounds (contracts §1.2 rule 3)', () => {
  it('single-line unbounded parity with legacy textEstBounds', () => {
    for (const text of ['hi', 'hello world', '', 'a']) {
      for (const size of [undefined, 12, 16, 20]) {
        const geo = { x: 10, y: 20, ...(size !== undefined ? { size } : {}) };
        const legacy = textEstBounds(geo, text);
        const v2 = textV2EstBounds({ ...geo, appearance: undefined }, text);
        expect(v2).toEqual(legacy);
      }
    }
  });

  it('explicit newlines break lines with 1.25x height and longest width', () => {
    const size = 16;
    const bounds = textV2EstBounds({ x: 10, y: 20, size }, 'ab\ncdef\ng');
    expect(bounds.x).toBe(10);
    expect(bounds.y).toBe(20);
    expect(bounds.height).toBeCloseTo(3 * 1.25 * size, 9);
    expect(bounds.width).toBeCloseTo(4 * 0.6 * size, 9);
    expect(splitTextLines('a\r\nb\nc')).toEqual(['a', 'b', 'c']);
  });

  it('wrapWidth bounds box width and grows height (auto vs wrapped parity)', () => {
    const size = 16;
    const text = 'hello world foo bar';
    const auto = textV2EstBounds({ x: 0, y: 0, size }, text);
    const wide = textV2EstBounds({ x: 0, y: 0, size, appearance: { wrapWidth: 10000 } }, text);
    // Wide enough to fit: same single line, same height; width becomes wrapWidth.
    expect(wide.height).toBeCloseTo(auto.height, 9);
    expect(wide.width).toBe(10000);
    const narrow = textV2EstBounds({ x: 0, y: 0, size, appearance: { wrapWidth: 50 } }, text);
    expect(narrow.width).toBe(50);
    expect(narrow.height).toBeGreaterThan(auto.height);
    expect(narrow.x).toBe(0);
    expect(narrow.y).toBe(0);
    // Wrapped lines helper agrees with bounds height.
    const lines = textV2Lines(text, size, 50);
    expect(narrow.height).toBeCloseTo(lines.length * 1.25 * size, 9);
  });

  it('envelope is align-invariant with (x,y) first-line origin', () => {
    const base = { x: 7, y: 11, size: 16, appearance: { wrapWidth: 60 } } as const;
    const text = 'hello world foo';
    const start = textV2EstBounds({ ...base, appearance: { align: 'start', wrapWidth: 60 } }, text);
    const center = textV2EstBounds({ ...base, appearance: { align: 'center', wrapWidth: 60 } }, text);
    const end = textV2EstBounds({ ...base, appearance: { align: 'end', wrapWidth: 60 } }, text);
    expect(center).toEqual(start);
    expect(end).toEqual(start);
    expect(start.x).toBe(7);
    expect(start.y).toBe(11);
  });

  it('pivot is the envelope center (not the first-line center)', () => {
    const bounds = textV2EstBounds({ x: 0, y: 0, size: 16 }, 'a\nbb\nccc\nDDDD');
    // 4 lines → height 80; center y = 40, first-line center y = 10.
    expect(bounds.height).toBeCloseTo(4 * 20, 9);
    expect(centerOfBounds(bounds)).toEqual({ x: bounds.x + bounds.width / 2, y: 40 });
    // Rotated AABB pivots around that center (quarter turn swaps extents around it).
    const aabb = rotatedBoundsAabb(bounds, Math.PI / 2);
    expect(aabb.width).toBeCloseTo(bounds.height, 9);
    expect(aabb.height).toBeCloseTo(bounds.width, 9);
  });

  it('estimate helper matches the per-character 0.6em value', () => {
    expect(estimateTextLineWidth('ab', 10)).toBeCloseTo(2 * 0.6 * 10, 9);
  });
});

describe('Surface text draw items', () => {
  it('compile emits effective role/align/wrapWidth plain-data (unknown → body)', () => {
    const model: SurfaceModel = {
      formatVersion: 1,
      frame: { kind: 'infinite' },
      order: ['known', 'unknown'],
      objects: {
        known: textObject('known', {
          x: 0,
          y: 0,
          text: 'hi',
          role: 'heading',
          appearance: { align: 'center', wrapWidth: 80 },
        }),
        unknown: {
          id: 'unknown',
          type: 'froglight.text',
          x: 0,
          y: 30,
          text: 'future',
          role: 'pull-quote',
          appearance: { align: 'justify', wrapWidth: -1 },
        } as never,
      },
    };
    const items = compileScene(model, createDefaultSurfaceObjectTypeRegistry());
    expect(items[0]).toMatchObject({
      kind: 'text',
      objectId: 'known',
      role: 'heading',
      align: 'center',
      wrapWidth: 80,
    });
    expect(items[1]).toMatchObject({
      kind: 'text',
      objectId: 'unknown',
      role: 'body',
      align: 'start',
    });
    expect(items[1]).not.toHaveProperty('wrapWidth');
    // Bounds and item bounds agree (single envelope path).
    const registry = createDefaultSurfaceObjectTypeRegistry();
    expect(registry.get('froglight.text')!.boundsOf!(model.objects['known']!)).toEqual(
      (items[0] as { bounds: unknown }).bounds,
    );
  });
});

describe('Surface text hit-testing uses the envelope', () => {
  it('hits inside the wrapped envelope and misses outside it', () => {
    const registry = createDefaultSurfaceObjectTypeRegistry();
    const hitTest = registry.get('froglight.text')!.hitTest!;
    const record = textObject('t', {
      x: 0,
      y: 0,
      text: 'hello world foo bar',
      appearance: { wrapWidth: 50 },
    });
    const bounds = registry.get('froglight.text')!.boundsOf!(record)!;
    // Center of the wrapped multi-line envelope hits.
    expect(
      hitTest(record, bounds.x + bounds.width / 2, bounds.y + 5),
    ).toBe(true);
    // Beyond the tight box width misses (align-invariant tight envelope).
    expect(hitTest(record, bounds.x + bounds.width + 10, bounds.y + 5)).toBe(
      false,
    );
    // Above the first line misses.
    expect(hitTest(record, bounds.x + 2, bounds.y - 5)).toBe(false);
  });
});

describe('Surface text renderer swap', () => {
  it('two backends see identical items and canonical bytes never change', () => {
    const model: SurfaceModel = {
      formatVersion: 1,
      frame: { kind: 'infinite' },
      order: ['t1', 't2'],
      objects: {
        t1: textObject('t1', { x: 5, y: 6, text: 'hi\nthere', role: 'heading' }),
        t2: textObject('t2', {
          x: 10,
          y: 40,
          text: 'wrapped caption text here',
          role: 'caption',
          appearance: { align: 'center', wrapWidth: 60 },
        }),
      },
    };
    const before = utf8Decode(encodeSurfacePayload(model));
    const registry = createDefaultSurfaceObjectTypeRegistry();
    const camera = createCamera(0, 0, 1);
    const viewport = { width: 400, height: 300 };
    const first = new RecordingSurfaceBackend();
    const second = new RecordingSurfaceBackend();
    renderSurfaceScene(first, model, registry, camera, viewport);
    renderSurfaceScene(second, model, registry, camera, viewport);
    expect(second.ops).toEqual(first.ops);
    expect(utf8Decode(encodeSurfacePayload(model))).toBe(before);
  });
});

describe('Surface text additive traits /', () => {
  it('reads additive bold/italic traits (exactly true), else inactive', () => {
    const on = textObject('t', {
      x: 0,
      y: 0,
      text: 'hi',
      appearance: { bold: true, italic: true },
    });
    expect(textBoldOf(on)).toBe(true);
    expect(textItalicOf(on)).toBe(true);
    for (const appearance of [
      undefined,
      {},
      { bold: false },
      { bold: 'yes' },
      { bold: 1 },
      { italic: 0 },
    ]) {
      const rec = textObject('t', {
        x: 0,
        y: 0,
        text: 'hi',
        ...(appearance !== undefined
          ? { appearance: appearance as never }
          : {}),
      });
      expect(textBoldOf(rec)).toBe(false);
      expect(textItalicOf(rec)).toBe(false);
      expect(isValidCoreSurfaceObject(rec)).toBe(true);
    }
  });

  it('prefers appearance.size for the effective size, else record size', () => {
    expect(
      effectiveSurfaceTextSizeOf({ size: 20, appearance: { size: 30 } }),
    ).toBe(30);
    expect(effectiveSurfaceTextSizeOf({ size: 20 })).toBe(20);
    expect(effectiveSurfaceTextSizeOf({})).toBe(16);
    expect(effectiveSurfaceTextSizeOf({ appearance: { size: -5 } })).toBe(16);
    expect(
      effectiveSurfaceTextSizeOf({
        size: 20,
        appearance: { size: 'big' },
      }),
    ).toBe(20);
    // Bounds agree with the appearance-first size (H1/H2 box grows).
    const viaAppearance = textV2EstBounds(
      { x: 0, y: 0, appearance: { size: 24 } },
      'hi',
    );
    const viaRecord = textV2EstBounds({ x: 0, y: 0, size: 24 }, 'hi');
    expect(viaAppearance).toEqual(viaRecord);
  });

  it('pins the wrap-on default (fixed, never measured)', () => {
    expect(TEXT_DEFAULT_WRAP_WIDTH).toBe(240);
  });

  it('round-trips bold/italic/appearance.size with unknown members verbatim, no version bump', () => {
    const model: SurfaceModel = {
      formatVersion: 1,
      frame: { kind: 'infinite' },
      order: ['t1'],
      objects: {
        t1: {
          id: 't1',
          type: 'froglight.text',
          x: 1,
          y: 2,
          text: 'hi',
          role: 'pull-quote',
          customFuture: 'keep-me',
          appearance: {
            align: 'justify',
            bold: true,
            italic: true,
            size: 24,
            wrapWidth: 120,
            customTrait: 'keep-too',
          },
        } as never,
      },
    };
    const first = utf8Decode(encodeSurfacePayload(model));
    const decoded = decodeSurfacePayload(utf8Encode(first));
    expect(decoded.warnings).toEqual([]);
    expect(decoded.model.formatVersion).toBe(1);
    const rec = decoded.model.objects['t1']! as unknown as Record<
      string,
      unknown
    >;
    // Unknowns survive; effective reads degrade layout-only.
    expect(rec.role).toBe('pull-quote');
    expect(textRoleOf(decoded.model.objects['t1']!)).toBe('body');
    expect(textAlignOf(decoded.model.objects['t1']!)).toBe('start');
    expect(textBoldOf(decoded.model.objects['t1']!)).toBe(true);
    expect(textItalicOf(decoded.model.objects['t1']!)).toBe(true);
    expect(effectiveSurfaceTextSizeOf(decoded.model.objects['t1']!)).toBe(24);
    expect(rec.customFuture).toBe('keep-me');
    expect(
      (rec.appearance as Record<string, unknown>).customTrait,
    ).toBe('keep-too');
    expect(utf8Decode(encodeSurfacePayload(decoded.model))).toBe(first);
    // Compile carries effective traits for backends (unknowns stay out).
    const items = compileScene(
      decoded.model,
      createDefaultSurfaceObjectTypeRegistry(),
    );
    expect(items[0]).toMatchObject({
      kind: 'text',
      role: 'body',
      align: 'start',
      wrapWidth: 120,
      bold: true,
      italic: true,
      size: 24,
    });
  });
});

describe('provider text measurements', () => {
  it('uses the same measured height for rendering, hit areas and connector anchors', () => {
    const registry = createDefaultSurfaceObjectTypeRegistry({
      measureText: (_record, text) => text.length * 4,
    });
    const descriptor = registry.get('froglight.text')!;
    const record = textObject('measured', {
      x: 10,
      y: 20,
      text: 'iiiiiiiiiiiiiiiiiiii',
      size: 41,
      appearance: { wrapWidth: 100 },
    });
    expect(descriptor.boundsOf?.(record)).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 51.25,
    });
    expect(descriptor.compile?.(record)).toMatchObject({
      bounds: { height: 51.25 },
    });
    expect(descriptor.connectorAnchor?.(record, 's')).toEqual({
      x: 60,
      y: 71.25,
    });
    expect(descriptor.hitTest?.(record, 50, 100)).toBe(false);
  });
});
