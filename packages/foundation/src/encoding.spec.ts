/**
 * Tests for portable UTF-8 helpers.
 */

import { describe, expect, it } from 'vitest';
import { parseJsonAsync, utf8Decode, utf8Encode } from './encoding.js';

describe('utf8 helpers', () => {
  it('round-trips ASCII and Unicode text', () => {
    for (const text of ['', 'hello', '你好', 'emoji 😀', 'café e\u0301', 'MixedCase-123_-.txt']) {
      expect(utf8Decode(utf8Encode(text))).toBe(text);
    }
  });

  it('encodes to exact UTF-8 bytes', () => {
    expect(Array.from(utf8Encode('A'))).toEqual([0x41]);
    expect(Array.from(utf8Encode('é'))).toEqual([0xc3, 0xa9]);
    expect(Array.from(utf8Encode('😀'))).toEqual([0xf0, 0x9f, 0x98, 0x80]);
  });

  it('decodes replacement characters for invalid input', () => {
    expect(utf8Decode(new Uint8Array([0xff, 0xfe]))).toContain('\uFFFD');
  });

  it('returns plain Uint8Array (byte-oriented contract)', () => {
    const bytes = utf8Encode('x');
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.byteLength).toBe(1);
  });

  it('parses JSON cooperatively with JSON.parse-compatible object semantics', async () => {
    const source = '{"__proto__":{"safe":true},"__proto__":{"last":true},"n":-0,"u":"\\ud83d\\ude00"}';
    const result = await parseJsonAsync(utf8Encode(source), () => true, 8, 0);
    expect(result).toEqual(JSON.parse(source));
    expect(Object.hasOwn(result as object, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(Object.is((result as { n: number }).n, -0)).toBe(true);
  });

  it('yields while parsing a large value and stops when its owner cancels', async () => {
    const bytes = utf8Encode(JSON.stringify({ values: Array.from({ length: 80_000 }, (_, i) => i) }));
    let alive = true;
    let ticked = false;
    setTimeout(() => { ticked = true; }, 0);
    const pending = parseJsonAsync(bytes, () => alive, 1_024, 0);
    const result = await pending;
    expect(result).toEqual(JSON.parse(utf8Decode(bytes)));
    expect(ticked).toBe(true);

    alive = false;
    await expect(parseJsonAsync(bytes, () => alive, 1_024, 0)).resolves.toBeNull();
  });

  it('rejects malformed and trailing JSON just as JSON.parse does', async () => {
    for (const source of ['{', '01', 'true false', '[1,]']) {
      await expect(parseJsonAsync(utf8Encode(source), () => true, 64 * 1024, 0)).rejects.toThrow();
      expect(() => JSON.parse(source)).toThrow();
    }
  });
});
