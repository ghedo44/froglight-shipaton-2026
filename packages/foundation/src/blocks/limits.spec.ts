/**
 * Security-limit and asset-reference conformance fixtures (spec §8–§9).
 */

import { describe, expect, it } from 'vitest';
import type { DocumentRef } from '../documents.js';
import { refFor, newDocumentId, newResourceId } from '../documents.js';
import { utf8Encode } from '../encoding.js';
import { BLOCK_PAGE_LIMITS, decodeBlockPage } from './codec.js';
import { paragraphBlock } from './model.js';

function makeRef(): DocumentRef {
  return refFor(newDocumentId(), 'froglight.blockpage' as never, newResourceId());
}

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

describe('block page codec — security limits', () => {
  it('rejects runs over the per-block limit with FORMAT_LIMIT_EXCEEDED', () => {
    const runs = Array.from({ length: BLOCK_PAGE_LIMITS.maxRunsPerBlock + 1 }, () => ({ text: 'x' }));
    const bytes = canonical({
      formatVersion: 1,
      meta: {},
      rootOrder: ['p1'],
      blocks: { p1: { id: 'p1', type: 'froglight.paragraph', runs } },
    });
    expectErrorCode(() => decodeBlockPage(bytes, makeRef()), 'FORMAT_LIMIT_EXCEEDED');
  });

  it('rejects block counts over the map limit with FORMAT_LIMIT_EXCEEDED', () => {
    const blocks: Record<string, unknown> = {};
    for (let i = 0; i < BLOCK_PAGE_LIMITS.maxBlocks + 1; i++) {
      blocks[`b${i}`] = paragraphBlock(`b${i}`, [{ text: 'x' }]);
    }
    const bytes = canonical({ formatVersion: 1, meta: {}, rootOrder: [], blocks });
    expectErrorCode(() => decodeBlockPage(bytes, makeRef()), 'FORMAT_LIMIT_EXCEEDED');
  });

  it('rejects image sources escaping the vault with FORMAT_LIMIT_EXCEEDED', () => {
    for (const badSrc of ['../outside.png', '/absolute.png', 'back\\slash.png']) {
      const bytes = canonical({
        formatVersion: 1,
        meta: {},
        rootOrder: ['i1'],
        blocks: { i1: { id: 'i1', type: 'froglight.image', src: badSrc, sha256: 'ab12' } },
      });
      // Invalid asset references degrade to opaque preservation with a
      // warning when they fail core validation... except path escapes,
      // which spec §8 treats as a hard security error.
      expectErrorCode(() => decodeBlockPage(bytes, makeRef()), 'FORMAT_LIMIT_EXCEEDED');
    }
  });

  it('accepts well-formed relative image sources without warnings', () => {
    const bytes = canonical({
      formatVersion: 1,
      meta: {},
      rootOrder: ['i1'],
      blocks: { i1: { id: 'i1', type: 'froglight.image', src: 'assets/pic.png', sha256: 'ab12' } },
    });
    const decoded = decodeBlockPage(bytes, makeRef());
    expect(decoded.warnings).toEqual([]);
  });
});
