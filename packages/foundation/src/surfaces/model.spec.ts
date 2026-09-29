/**
 * Surface model primitives.
 * Tests assert external behavior: constructor field order, validation
 * outcomes, and frame semantics — never internal representations.
 */

import { describe, expect, it } from 'vitest';
import { utf8Decode, utf8Encode } from '../encoding.js';
import {
  SURFACE_OBJECT_TYPES,
  RESOURCE_EMBED_PRESENTATIONS,
  boundedFrame,
  ellipseObject,
  emptySurface,
  groupObject,
  imageObject,
  isCoreSurfaceObjectType,
  isKnownResourceEmbedPresentation,
  isValidCoreSurfaceObject,
  findGeometryLimitViolation,
  rectangleObject,
  resourceEmbedObject,
  resourceEmbedPresentationOf,
  textObject,
  frameBounds,
  SURFACE_MAX_COORDINATE,
} from './model.js';
import { decodeSurfacePayload, encodeSurfacePayload } from './codec.js';

describe('surface frame', () => {
  it('defaults to an infinite frame', () => {
    const model = emptySurface();
    expect(model.formatVersion).toBe(1);
    expect(model.frame).toEqual({ kind: 'infinite' });
    expect(frameBounds(model.frame)).toBeNull();
    expect(model.order).toEqual([]);
    expect(model.objects).toEqual({});
  });

  it('bounded frames carry finite positive dimensions', () => {
    const frame = boundedFrame(800, 600);
    expect(frame).toEqual({ kind: 'bounded', width: 800, height: 600 });
    expect(frameBounds(frame)).toEqual({ width: 800, height: 600 });
  });
});

describe('core object types', () => {
  it('exposes exactly the closed core type set', () => {
    expect(Object.values(SURFACE_OBJECT_TYPES)).toEqual([
      'froglight.rectangle',
      'froglight.ellipse',
      'froglight.text',
      'froglight.image',
      'froglight.ink.stroke',
      'froglight.ink.source',
      'froglight.line',
      'froglight.card',
      'froglight.resource-embed',
      'froglight.group',
    ]);
    for (const typeId of Object.values(SURFACE_OBJECT_TYPES)) {
      expect(isCoreSurfaceObjectType(typeId)).toBe(true);
    }
    expect(isCoreSurfaceObjectType('acme.callout')).toBe(false);
    expect(isCoreSurfaceObjectType('froglight.rectangle-ish')).toBe(false);
  });

  it('constructors emit canonical field order', () => {
    expect(
      JSON.stringify(
        rectangleObject('r1', { x: 1, y: 2, width: 3, height: 4 }),
      ),
    ).toBe(
      JSON.stringify({
        id: 'r1',
        type: 'froglight.rectangle',
        x: 1,
        y: 2,
        width: 3,
        height: 4,
      }),
    );
    expect(
      JSON.stringify(
        rectangleObject('r2', {
          x: 1,
          y: 2,
          width: 3,
          height: 4,
          rotation: 0.5,
          fill: '#fff',
        }),
      ),
    ).toBe(
      JSON.stringify({
        id: 'r2',
        type: 'froglight.rectangle',
        x: 1,
        y: 2,
        width: 3,
        height: 4,
        rotation: 0.5,
        fill: '#fff',
      }),
    );
    expect(
      JSON.stringify(ellipseObject('e1', { x: 0, y: 0, width: 2, height: 8 })),
    ).toBe(
      JSON.stringify({
        id: 'e1',
        type: 'froglight.ellipse',
        x: 0,
        y: 0,
        width: 2,
        height: 8,
      }),
    );
    expect(JSON.stringify(textObject('t1', { x: 5, y: 6, text: 'hi' }))).toBe(
      JSON.stringify({
        id: 't1',
        type: 'froglight.text',
        x: 5,
        y: 6,
        text: 'hi',
      }),
    );
    expect(
      JSON.stringify(
        imageObject('i1', {
          x: 1,
          y: 1,
          width: 2,
          height: 2,
          src: 'a.png',
          sha256: 'ff',
        }),
      ),
    ).toBe(
      JSON.stringify({
        id: 'i1',
        type: 'froglight.image',
        x: 1,
        y: 1,
        width: 2,
        height: 2,
        src: 'a.png',
        sha256: 'ff',
      }),
    );
    expect(JSON.stringify(groupObject('g1', { children: ['a', 'b'] }))).toBe(
      JSON.stringify({
        id: 'g1',
        type: 'froglight.group',
        children: ['a', 'b'],
      }),
    );
  });
});

describe('core object validation', () => {
  it('accepts structurally valid records', () => {
    expect(
      isValidCoreSurfaceObject(
        rectangleObject('r', { x: 0, y: 0, width: 1, height: 1 }),
      ),
    ).toBe(true);
    expect(
      isValidCoreSurfaceObject(
        rectangleObject('r', {
          x: 0,
          y: 0,
          width: 1,
          height: 1,
          rotation: Math.PI,
          fill: 'red',
        }),
      ),
    ).toBe(true);
    expect(
      isValidCoreSurfaceObject(
        ellipseObject('e', { x: 0, y: 0, width: 4, height: 2 }),
      ),
    ).toBe(true);
    expect(
      isValidCoreSurfaceObject(
        textObject('t', { x: 1, y: 2, text: 'hello', size: 12 }),
      ),
    ).toBe(true);
    expect(
      isValidCoreSurfaceObject(
        imageObject('i', {
          x: 0,
          y: 0,
          width: 3,
          height: 3,
          src: 'img/a.png',
          sha256: 'ab',
        }),
      ),
    ).toBe(true);
  });

  it.each(['rectangle', 'rounded', 'diamond', 'triangle'] as const)(
    'preserves the %s variant as a valid rectangle record',
    (shape) => {
      const record = rectangleObject('shape', {
        x: 0,
        y: 0,
        width: 100,
        height: 80,
        shape,
        stroke: '#336699',
      });
      const restored = JSON.parse(JSON.stringify(record));
      expect(restored.shape).toBe(shape);
      expect(isValidCoreSurfaceObject(restored)).toBe(true);
      expect(
        isValidCoreSurfaceObject({
          ...restored,
          shape: 'unknown-future-shape',
        }),
      ).toBe(false);
    },
  );

  it('preserves a finite corner radius and rejects invalid radii', () => {
    const record = rectangleObject('radius', {
      x: 0,
      y: 0,
      width: 100,
      height: 80,
      shape: 'triangle',
      cornerRadius: 18,
    });
    expect(JSON.parse(JSON.stringify(record)).cornerRadius).toBe(18);
    expect(isValidCoreSurfaceObject(record)).toBe(true);
    for (const cornerRadius of [-1, NaN, Infinity, '18'])
      expect(isValidCoreSurfaceObject({ ...record, cornerRadius })).toBe(false);
  });

  it('rejects missing/wrong-typed envelope members', () => {
    expect(
      isValidCoreSurfaceObject({
        id: 'r',
        type: 'froglight.rectangle',
        x: 0,
        y: 0,
        width: 1,
      }),
    ).toBe(false);
    expect(
      isValidCoreSurfaceObject({
        id: 'r',
        type: 'froglight.rectangle',
        x: 0,
        y: 0,
        width: -1,
        height: 1,
      }),
    ).toBe(false);
    expect(
      isValidCoreSurfaceObject({
        id: 'r',
        type: 'froglight.rectangle',
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        fill: 7,
      }),
    ).toBe(false);
    expect(
      isValidCoreSurfaceObject({
        id: 't',
        type: 'froglight.text',
        x: 0,
        y: 0,
        text: 'hi',
        size: 0,
      }),
    ).toBe(false);
    expect(
      isValidCoreSurfaceObject({
        id: 'i',
        type: 'froglight.image',
        x: 0,
        y: 0,
        width: 1,
        height: 1,
        src: '/etc/passwd',
        sha256: 'ab',
      }),
    ).toBe(false);
  });

  it('rejects unknown and non-core types', () => {
    expect(isValidCoreSurfaceObject({ id: 'x', type: 'acme.callout' })).toBe(
      false,
    );
  });

  it('validates group membership lists', () => {
    expect(
      isValidCoreSurfaceObject(groupObject('g', { children: ['a', 'b'] })),
    ).toBe(true);
    const bad = (children: unknown) =>
      isValidCoreSurfaceObject({
        id: 'g',
        type: 'froglight.group',
        children,
      } as never);
    expect(bad([])).toBe(false);
    expect(bad('ab')).toBe(false);
    expect(bad(['a', ''])).toBe(false);
    expect(bad(['a', 7])).toBe(false);
    expect(bad(undefined)).toBe(false);
  });
});

describe('geometry security limits', () => {
  it('flags non-finite and out-of-range geometry as hard violations', () => {
    const huge = {
      ...rectangleObject('r', { x: 0, y: 0, width: 1, height: 1 }),
      x: 1e10,
    };
    expect(findGeometryLimitViolation(huge)).toMatch(/magnitude/i);

    const infinite = {
      ...rectangleObject('r', { x: 0, y: 0, width: 1, height: 1 }),
      height: Number.POSITIVE_INFINITY,
    };
    expect(findGeometryLimitViolation(infinite)).toMatch(/finite/i);

    const nanRotation = {
      ...textObject('t', { x: 0, y: 0, text: 'x' }),
      rotation: NaN,
    };
    expect(findGeometryLimitViolation(nanRotation)).toMatch(/finite/i);

    expect(
      findGeometryLimitViolation(
        rectangleObject('r', { x: 0, y: 0, width: 1, height: 1 }),
      ),
    ).toBeNull();
    expect(
      findGeometryLimitViolation(
        textObject('t', { x: SURFACE_MAX_COORDINATE, y: 0, text: 'edge' }),
      ),
    ).toBeNull();
  });
});

describe('resource-embed presentation (delta)', () => {
  const target = {
    documentId: 'd1',
    kindId: 'froglight.ink',
    resourceId: 'r1',
  };

  function payloadWith(
    id: string,
    record: Record<string, unknown>,
  ): Uint8Array {
    return utf8Encode(
      JSON.stringify({
        formatVersion: 1,
        frame: { kind: 'infinite' },
        order: [id],
        objects: { [id]: record },
      }),
    );
  }

  it('exposes exactly the known presentation set', () => {
    expect([...RESOURCE_EMBED_PRESENTATIONS]).toEqual(['preview', 'link']);
    expect(isKnownResourceEmbedPresentation('preview')).toBe(true);
    expect(isKnownResourceEmbedPresentation('link')).toBe(true);
    expect(isKnownResourceEmbedPresentation('gallery')).toBe(false);
    expect(isKnownResourceEmbedPresentation(undefined)).toBe(false);
  });

  it('resolves absent/unknown to preview, known link to link', () => {
    expect(
      resourceEmbedPresentationOf(
        resourceEmbedObject('e', { x: 0, y: 0, width: 8, height: 8, target }),
      ),
    ).toBe('preview');
    expect(
      resourceEmbedPresentationOf(
        resourceEmbedObject('e', {
          x: 0,
          y: 0,
          width: 8,
          height: 8,
          target,
          presentation: 'link',
        }),
      ),
    ).toBe('link');
    expect(
      resourceEmbedPresentationOf({
        id: 'e',
        type: 'froglight.resource-embed',
        presentation: 'gallery',
      }),
    ).toBe('preview');
  });

  it('emits presentation last in canonical field order', () => {
    const full = resourceEmbedObject('e', {
      x: 1,
      y: 2,
      width: 3,
      height: 4,
      target,
      rotation: 0.5,
      cachedTitle: 'T',
      cachedKind: 'froglight.ink',
      presentation: 'link',
    });
    expect(Object.keys(full)).toEqual([
      'id',
      'type',
      'x',
      'y',
      'width',
      'height',
      'target',
      'rotation',
      'cachedTitle',
      'cachedKind',
      'presentation',
    ]);
    const minimal = resourceEmbedObject('e', {
      x: 1,
      y: 2,
      width: 3,
      height: 4,
      target,
    });
    expect(minimal).not.toHaveProperty('presentation');
    const unknown = resourceEmbedObject('e', {
      x: 1,
      y: 2,
      width: 3,
      height: 4,
      target,
      presentation: 'gallery',
    });
    // Unknown strings emit verbatim, never normalized (Surface text role precedent).
    expect((unknown as Record<string, unknown>).presentation).toBe('gallery');
  });

  it('validates known and unknown presentations without warnings', () => {
    const cases: Array<{ name: string; presentation?: unknown }> = [
      { name: 'absent' },
      { name: 'preview', presentation: 'preview' },
      { name: 'link', presentation: 'link' },
      { name: 'unknown string', presentation: 'gallery' },
      { name: 'object shape tolerance', presentation: { mode: 'link' } },
    ];
    for (const { name, presentation } of cases) {
      const record =
        presentation === undefined
          ? resourceEmbedObject('e', {
              x: 0,
              y: 0,
              width: 8,
              height: 8,
              target,
            })
          : {
              ...resourceEmbedObject('e', {
                x: 0,
                y: 0,
                width: 8,
                height: 8,
                target,
              }),
              presentation,
            };
      expect(isValidCoreSurfaceObject(record), name).toBe(true);
      const decoded = decodeSurfacePayload(
        payloadWith('e', record as Record<string, unknown>),
      );
      expect(decoded.warnings, name).toEqual([]);
      expect(isValidCoreSurfaceObject(decoded.model.objects['e']!), name).toBe(
        true,
      );
    }
  });

  it('round-trips absent/link/preview/unknown byte-stably', () => {
    const members: readonly unknown[] = [
      undefined,
      'link',
      'preview',
      'gallery',
    ];
    for (const presentation of members) {
      const record =
        presentation === undefined
          ? resourceEmbedObject('e', {
              x: 0,
              y: 0,
              width: 8,
              height: 8,
              target,
            })
          : resourceEmbedObject('e', {
              x: 0,
              y: 0,
              width: 8,
              height: 8,
              target,
              presentation: presentation as 'link',
            });
      const model = {
        formatVersion: 1 as const,
        frame: { kind: 'infinite' } as const,
        order: ['e'],
        objects: { e: record },
      };
      const bytes = encodeSurfacePayload(model as never);
      const decoded = decodeSurfacePayload(bytes);
      expect(decoded.warnings).toEqual([]);
      // Byte-stability: decode → re-encode is identical.
      expect(utf8Decode(encodeSurfacePayload(decoded.model))).toBe(
        utf8Decode(bytes),
      );
      const roundTripped = decoded.model.objects['e']! as Record<
        string,
        unknown
      >;
      if (presentation === undefined) {
        expect(roundTripped).not.toHaveProperty('presentation');
        expect(resourceEmbedPresentationOf(decoded.model.objects['e']!)).toBe(
          'preview',
        );
      } else {
        expect(roundTripped.presentation).toBe(presentation);
      }
    }
    // Unknown renders as preview while preserving verbatim.
    const unknownBytes = payloadWith('e', {
      id: 'e',
      type: 'froglight.resource-embed',
      x: 0,
      y: 0,
      width: 8,
      height: 8,
      target,
      presentation: 'gallery',
    });
    const unknownDecoded = decodeSurfacePayload(unknownBytes);
    expect(unknownDecoded.warnings).toEqual([]);
    expect(
      resourceEmbedPresentationOf(unknownDecoded.model.objects['e']!),
    ).toBe('preview');
    expect(
      (unknownDecoded.model.objects['e']! as Record<string, unknown>)
        .presentation,
    ).toBe('gallery');
  });

  it('opens a legacy record without the member unchanged', () => {
    const legacy = {
      id: 'e',
      type: 'froglight.resource-embed',
      x: 4,
      y: 5,
      width: 16,
      height: 12,
      target,
      cachedTitle: 'Old title',
    };
    const decoded = decodeSurfacePayload(payloadWith('e', legacy));
    expect(decoded.warnings).toEqual([]);
    expect(isValidCoreSurfaceObject(decoded.model.objects['e']!)).toBe(true);
    expect(decoded.model.objects['e']!).not.toHaveProperty('presentation');
    expect(resourceEmbedPresentationOf(decoded.model.objects['e']!)).toBe(
      'preview',
    );
    const reEncoded = JSON.parse(
      utf8Decode(encodeSurfacePayload(decoded.model)),
    ) as { objects: Record<string, Record<string, unknown>> };
    expect(reEncoded.objects['e']).not.toHaveProperty('presentation');
    expect(reEncoded.objects['e']).toMatchObject({
      cachedTitle: 'Old title',
      target,
    });
  });
});
