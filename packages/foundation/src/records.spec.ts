/**
 * Tests for versioned record helpers.
 *
 * Every `.froglight/` metadata record is a versioned JSON document:
 * validated on read, unknown fields preserved on write, deterministic
 * serialization across hosts.
 */

import { describe, expect, it } from 'vitest';
import {
  parseVersionedRecord,
  pickUnknown,
  serializeVersionedRecord,
  stableStringify,
  type VersionedRecord,
} from './records.js';
import { isFroglightError, FroglightError } from './errors.js';
import { utf8Decode, utf8Encode } from './encoding.js';

const FORMAT = 'froglight.test';
const KNOWN_KEYS = new Set(['format', 'version', 'title']);

interface TestRecord extends VersionedRecord {
  readonly title: string;
}

function parse(data: Uint8Array): { record: TestRecord; extras: Readonly<Record<string, unknown>> } {
  return parseVersionedRecord<TestRecord>(data, FORMAT, [1], KNOWN_KEYS);
}

/** Assert that `fn` throws a FroglightError with the given code. */
function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    expect.unreachable('expected the call to throw');
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

describe('parseVersionedRecord', () => {
  it('parses a valid record and separates known keys from extras', () => {
    const { record, extras } = parse(utf8Encode('{"format":"froglight.test","version":1,"title":"Hi","futureField":42}'));
    expect(record.title).toBe('Hi');
    expect(extras).toEqual({ futureField: 42 });
  });

  it('throws RECORD_CORRUPT for invalid JSON', () => {
    expectCode(() => parse(utf8Encode('{not json')), 'RECORD_CORRUPT');
  });

  it('throws RECORD_CORRUPT for non-object roots', () => {
    for (const bad of ['42', '"str"', 'null', '[1,2]']) {
      expectCode(() => parse(utf8Encode(bad)), 'RECORD_CORRUPT');
    }
  });

  it('throws RECORD_FORMAT_MISMATCH for a different format', () => {
    expectCode(() => parse(utf8Encode('{"format":"other","version":1,"title":"x"}')), 'RECORD_FORMAT_MISMATCH');
  });

  it('throws RECORD_VERSION_UNSUPPORTED for missing or unsupported versions', () => {
    for (const bad of [
      '{"format":"froglight.test","title":"x"}',
      '{"format":"froglight.test","version":2,"title":"x"}',
      '{"format":"froglight.test","version":"1","title":"x"}',
    ]) {
      expectCode(() => parse(utf8Encode(bad)), 'RECORD_VERSION_UNSUPPORTED');
    }
  });

  it('ignores unknown keys of any shape (tolerant reads)', () => {
    const { record, extras } = parse(
      utf8Encode('{"format":"froglight.test","version":1,"title":"x","weird":{"nested":[1,{"a":2}]}}'),
    );
    expect(record.title).toBe('x');
    expect(extras).toEqual({ weird: { nested: [1, { a: 2 }] } });
  });

  it('thrown errors are FroglightErrors with a stable code', () => {
    try {
      parse(utf8Encode('{bad'));
      expect.unreachable();
    } catch (error) {
      expect(isFroglightError(error)).toBe(true);
      expect(error).toBeInstanceOf(FroglightError);
      expect((error as FroglightError).code).toBe('RECORD_CORRUPT');
    }
  });
});

describe('serializeVersionedRecord', () => {
  it('serializes deterministically with sorted keys', () => {
    const a = serializeVersionedRecord({ format: FORMAT, version: 1, title: 'x' } as TestRecord & Record<string, unknown>);
    const b = serializeVersionedRecord({ title: 'x', version: 1, format: FORMAT } as TestRecord & Record<string, unknown>);
    expect(a).toEqual(b);
    expect(utf8Decode(a)).toBe('{"format":"froglight.test","title":"x","version":1}');
  });

  it('returns Uint8Array bytes, not a string', () => {
    const bytes = serializeVersionedRecord({ format: FORMAT, version: 1, title: 'x' } as TestRecord & Record<string, unknown>);
    expect(bytes).toBeInstanceOf(Uint8Array);
  });

  it('merges extras back so unknown fields survive round trips', () => {
    const original = utf8Encode('{"format":"froglight.test","version":1,"title":"Hi","futureField":{"a":1}}');
    const { record, extras } = parse(original);
    const rewritten = serializeVersionedRecord(record as TestRecord & Record<string, unknown>, extras);
    const { record: record2, extras: extras2 } = parse(rewritten);
    expect(record2.title).toBe('Hi');
    expect(extras2).toEqual({ futureField: { a: 1 } });
    // Round trip is byte-stable (sorted keys).
    expect(utf8Decode(rewritten)).toBe('{"format":"froglight.test","futureField":{"a":1},"title":"Hi","version":1}');
  });
});

describe('stableStringify', () => {
  it('sorts nested object keys recursively', () => {
    const json = stableStringify({ b: { d: 1, c: 2 }, a: [3, { f: 1, e: 2 }] });
    expect(json).toBe('{"a":[3,{"e":2,"f":1}],"b":{"c":2,"d":1}}');
  });

  it('is stable across repeated calls', () => {
    const input = { z: 1, a: { y: 2, b: 3 } };
    expect(stableStringify(input)).toBe(stableStringify(input));
  });
});

describe('pickUnknown', () => {
  it('returns only keys not in the known set', () => {
    const result = pickUnknown({ format: 'x', version: 1, title: 't', extra: 1 }, ['format', 'version', 'title']);
    expect(result).toEqual({ extra: 1 });
  });

  it('returns an empty object when everything is known', () => {
    expect(pickUnknown({ format: 'x', version: 1 }, ['format', 'version'])).toEqual({});
  });
});