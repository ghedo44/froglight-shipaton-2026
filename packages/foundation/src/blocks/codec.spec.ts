/**
 * Engine-free conformance fixtures for the `.blockpage` canonical codec
 * without instantiating an editor engine.
 */

import { describe, expect, it } from 'vitest';
import type { DocumentRef } from '../documents.js';
import { refFor, newDocumentId, newResourceId } from '../documents.js';
import { utf8Encode, utf8Decode } from '../encoding.js';
import { blockPageKindId } from './kind.js';
import {
  decodeBlockPage,
  encodeBlockPage,
  canonicalBlockPageJson,
} from './codec.js';
import { paragraphBlock, listBlock } from './model.js';

function makeRef(): DocumentRef {
  return refFor(newDocumentId(), blockPageKindId, newResourceId());
}

/** Canonical serialization of a literal document (matches §6 serializer rules). */
function canonical(value: unknown): Uint8Array {
  return utf8Encode(`${JSON.stringify(value, null, 2)}\n`);
}

function expectErrorCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect((error as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`expected error with code ${code}`);
}

describe('block page codec — versioning', () => {
  it('rejects a newer formatVersion with UNKNOWN_FORMAT_VERSION', () => {
    const bytes = canonical({
      formatVersion: 99,
      meta: {},
      rootOrder: [],
      blocks: {},
    });
    expectErrorCode(
      () => decodeBlockPage(bytes, makeRef()),
      'UNKNOWN_FORMAT_VERSION',
    );
  });

  it('rejects unparseable JSON and missing document members with RECORD_CORRUPT', () => {
    expectErrorCode(
      () => decodeBlockPage(utf8Encode('{oops'), makeRef()),
      'RECORD_CORRUPT',
    );
    expectErrorCode(
      () =>
        decodeBlockPage(
          canonical({ meta: {}, rootOrder: [], blocks: {} }),
          makeRef(),
        ),
      'RECORD_CORRUPT',
    );
  });

  it('rejects wrong member types at document level with RECORD_CORRUPT', () => {
    const bytes = canonical({
      formatVersion: 1,
      meta: [],
      rootOrder: [],
      blocks: {},
    });
    expectErrorCode(() => decodeBlockPage(bytes, makeRef()), 'RECORD_CORRUPT');
  });
});

describe('block page codec — partial recovery', () => {
  it('dedupes duplicate rootOrder ids with a warning', () => {
    const bytes = canonical({
      formatVersion: 1,
      meta: {},
      rootOrder: ['p1', 'p1'],
      blocks: { p1: paragraphBlock('p1', [{ text: 'a' }]) },
    });
    const decoded = decodeBlockPage(bytes, makeRef());
    expect(decoded.model.rootOrder).toEqual(['p1']);
    expect(decoded.warnings).toEqual([
      { code: 'DUPLICATE_ROOT_REFERENCE', refId: 'p1' },
    ]);
  });

  it('drops child references to missing blocks with a warning', () => {
    const bytes = canonical({
      formatVersion: 1,
      meta: {},
      rootOrder: ['l1'],
      blocks: {
        l1: listBlock('l1', false, [
          { runs: [{ text: 'x' }], children: ['ghost'] },
        ]),
      },
    });
    const decoded = decodeBlockPage(bytes, makeRef());
    expect(decoded.warnings).toEqual([
      { code: 'DANGLING_CHILD_REFERENCE', blockId: 'l1', refId: 'ghost' },
    ]);
    expect(utf8Decode(encodeBlockPage(decoded.model, makeRef()))).not.toContain(
      'ghost',
    );
  });

  it('preserves an invalid core-typed record verbatim as opaque with a warning', () => {
    const bytes = canonical({
      formatVersion: 1,
      meta: {},
      rootOrder: ['h1'],
      blocks: {
        h1: { id: 'h1', type: 'froglight.heading', level: 99, runs: [] },
      },
    });
    const decoded = decodeBlockPage(bytes, makeRef());
    expect(decoded.warnings).toEqual([
      { code: 'INVALID_CORE_BLOCK_OPAQUE', blockId: 'h1' },
    ]);
    expect(utf8Decode(encodeBlockPage(decoded.model, makeRef()))).toBe(
      utf8Decode(bytes),
    );
  });

  it('breaks reference cycles and truncates over-deep chains with warnings', () => {
    const bytes = canonical({
      formatVersion: 1,
      meta: {},
      rootOrder: ['a'],
      blocks: {
        a: listBlock('a', false, [{ runs: [], children: ['b'] }]),
        b: listBlock('b', false, [{ runs: [], children: ['a'] }]),
      },
    });
    const decoded = decodeBlockPage(bytes, makeRef());
    expect(decoded.warnings.length).toBeGreaterThanOrEqual(1);
    // Encode must not recurse forever.
    expect(utf8Decode(encodeBlockPage(decoded.model, makeRef()))).toContain(
      'froglight.list',
    );
  });

  it('drops non-object block entries with a warning', () => {
    const bytes = canonical({
      formatVersion: 1,
      meta: {},
      rootOrder: [],
      blocks: { bad: 7 },
    });
    const decoded = decodeBlockPage(bytes, makeRef());
    expect(decoded.warnings).toEqual([
      { code: 'MALFORMED_BLOCK_DROPPED', blockId: 'bad' },
    ]);
    expect(decoded.model.blocks.bad).toBeUndefined();
  });
});

describe('block page codec — preservation', () => {
  it('preserves unknown document fields byte-stably', () => {
    const doc = {
      formatVersion: 1,
      meta: { title: 'T' },
      rootOrder: [],
      blocks: {},
      vendorDocumentField: { nested: [1, 2, { keep: true }] },
    };
    const bytes = canonical(doc);
    const decoded = decodeBlockPage(bytes, makeRef());
    expect(utf8Decode(encodeBlockPage(decoded.model, makeRef()))).toBe(
      utf8Decode(bytes),
    );
  });

  it('preserves unknown meta fields and unknown marks byte-stably', () => {
    const doc = {
      formatVersion: 1,
      meta: { title: 'T', futureField: { nested: [1, 2] } },
      rootOrder: ['p1'],
      blocks: {
        p1: {
          id: 'p1',
          type: 'froglight.paragraph',
          runs: [
            {
              text: 'x',
              marks: ['bold', { type: 'acme.sparkle', intensity: 3 }],
            },
          ],
        },
      },
    };
    const bytes = canonical(doc);
    const decoded = decodeBlockPage(bytes, makeRef());
    expect(decoded.warnings).toEqual([]);
    expect(utf8Decode(encodeBlockPage(decoded.model, makeRef()))).toBe(
      utf8Decode(bytes),
    );
  });

  it('preserves opaque plugin blocks verbatim including key order', () => {
    const doc = {
      formatVersion: 1,
      meta: {},
      rootOrder: ['x'],
      blocks: {
        x: {
          type: 'acme.callout',
          tone: 'loud',
          id: 'x',
          extras: [true, null],
        },
      },
    };
    const bytes = canonical(doc);
    const decoded = decodeBlockPage(bytes, makeRef());
    const model = decoded.model;
    expect(model.blocks.x?.type).toBe('acme.callout');
    expect(utf8Decode(encodeBlockPage(model, makeRef()))).toBe(
      utf8Decode(bytes),
    );
  });

  it('keeps unknown extra fields on core-typed records after canonical fields', () => {
    const doc = {
      formatVersion: 1,
      meta: {},
      rootOrder: ['p1'],
      blocks: {
        p1: {
          id: 'p1',
          type: 'froglight.paragraph',
          runs: [{ text: 'a' }],
          vendorTag: 'z',
        },
      },
    };
    const bytes = canonical(doc);
    const out = utf8Decode(
      encodeBlockPage(decodeBlockPage(bytes, makeRef()).model, makeRef()),
    );
    expect(out.indexOf('"vendorTag"')).toBeGreaterThan(out.indexOf('"runs"'));
    expect(out).toBe(utf8Decode(bytes));
  });
});

describe('block page codec — round trip', () => {
  it('decode→encode of an unmodified canonical document is byte-identical', () => {
    const doc = {
      formatVersion: 1,
      meta: { title: 'Hello', tags: ['a'], properties: { mood: 'fine' } },
      rootOrder: ['p1'],
      blocks: { p1: paragraphBlock('p1', [{ text: 'Hi' }]) },
    };
    const bytes = canonical(doc);
    const decoded = decodeBlockPage(bytes, makeRef());
    const encoded = encodeBlockPage(decoded.model, makeRef());
    expect(utf8Decode(encoded)).toBe(utf8Decode(bytes));
  });

  it('canonical serializer matches the documented formatting rules', () => {
    const doc = { formatVersion: 1, meta: {}, rootOrder: [], blocks: {} };
    expect(canonicalBlockPageJson(doc)).toBe(
      `${JSON.stringify(doc, null, 2)}\n`,
    );
  });
});
