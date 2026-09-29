/**
 * Conformance fixtures for the format amendment:
 * universal optional `children` on every block record, expanded core
 * block set (quote/divider/toggle/callout), and to-do list items.
 * Engine-free.
 */

import { describe, expect, it } from 'vitest';
import type { DocumentRef } from '../documents.js';
import { refFor, newDocumentId, newResourceId } from '../documents.js';
import { utf8Encode, utf8Decode } from '../encoding.js';
import { blockPageKindId } from './kind.js';
import { decodeBlockPage, encodeBlockPage } from './codec.js';
import {
  BLOCK_PAGE_BLOCK_TYPES,
  calloutBlock,
  dividerBlock,
  isCoreBlockType,
  isValidCoreRecord,
  listBlock,
  paragraphBlock,
  quoteBlock,
  toggleBlock,
} from './model.js';

function makeRef(): DocumentRef {
  return refFor(newDocumentId(), blockPageKindId, newResourceId());
}

function canonical(value: unknown): Uint8Array {
  return utf8Encode(`${JSON.stringify(value, null, 2)}\n`);
}

describe('expanded core block set', () => {
  it('recognizes the new core type ids', () => {
    expect(BLOCK_PAGE_BLOCK_TYPES.quote).toBe('froglight.quote');
    expect(BLOCK_PAGE_BLOCK_TYPES.divider).toBe('froglight.divider');
    expect(BLOCK_PAGE_BLOCK_TYPES.toggle).toBe('froglight.toggle');
    expect(BLOCK_PAGE_BLOCK_TYPES.callout).toBe('froglight.callout');
    expect(isCoreBlockType('froglight.quote')).toBe(true);
    expect(isCoreBlockType('froglight.divider')).toBe(true);
    expect(isCoreBlockType('froglight.toggle')).toBe(true);
    expect(isCoreBlockType('froglight.callout')).toBe(true);
  });

  it('constructs valid canonical records', () => {
    const quote = quoteBlock('q1', [{ text: 'words' }]);
    const divider = dividerBlock('d1');
    const toggle = toggleBlock('t1', [{ text: 'summary' }]);
    const callout = calloutBlock('c1', [{ text: 'note' }], { icon: '💡', tone: 'info' });
    for (const record of [quote, divider, toggle, callout]) {
      expect(isValidCoreRecord(record)).toBe(true);
    }
    // Canonical field order per spec §4.
    expect(Object.keys(callout)).toEqual(['id', 'type', 'icon', 'tone', 'runs']);
    expect(divider).toEqual({ id: 'd1', type: 'froglight.divider' });
  });

  it('flags invalid new-typed records as opaque with a warning', () => {
    const bytes = canonical({
      formatVersion: 1,
      meta: {},
      rootOrder: ['q1'],
      blocks: { q1: { id: 'q1', type: 'froglight.quote', runs: 'not-runs' } },
    });
    const decoded = decodeBlockPage(bytes, makeRef());
    expect(decoded.warnings).toEqual([{ code: 'INVALID_CORE_BLOCK_OPAQUE', blockId: 'q1' }]);
  });

  it('round-trips a document using every new type byte-stably', () => {
    const doc = {
      formatVersion: 1,
      meta: {},
      rootOrder: ['q1', 'd1', 't1', 'c1'],
      blocks: {
        q1: quoteBlock('q1', [{ text: 'wise' }]),
        d1: dividerBlock('d1'),
        t1: toggleBlock('t1', [{ text: 'more' }]),
        c1: calloutBlock('c1', [{ text: 'careful' }], { icon: '⚠️' }),
      },
    };
    const bytes = canonical(doc);
    const decoded = decodeBlockPage(bytes, makeRef());
    expect(decoded.warnings).toEqual([]);
    expect(utf8Decode(encodeBlockPage(decoded.model, makeRef()))).toBe(utf8Decode(bytes));
  });

  it('accepts to-do list items carrying checked and preserves them verbatim', () => {
    const bytes = canonical({
      formatVersion: 1,
      meta: {},
      rootOrder: ['l1'],
      blocks: {
        l1: listBlock('l1', false, [
          { runs: [{ text: 'buy milk' }], checked: false },
          { runs: [{ text: 'ship' }], checked: true },
        ]),
      },
    });
    const decoded = decodeBlockPage(bytes, makeRef());
    expect(decoded.warnings).toEqual([]);
    expect(utf8Decode(encodeBlockPage(decoded.model, makeRef()))).toBe(utf8Decode(bytes));
  });
});

describe('universal children on every block record', () => {
  it('decodes children on a non-container type without warnings', () => {
    const bytes = canonical({
      formatVersion: 1,
      meta: {},
      rootOrder: ['h1'],
      blocks: {
        h1: { ...headingWithChildren() },
        c1: paragraphBlock('c1', [{ text: 'child' }]),
      },
    });
    function headingWithChildren(): Record<string, unknown> {
      return {
        id: 'h1',
        type: 'froglight.heading',
        level: 2,
        runs: [{ text: 'Parent' }],
        children: ['c1'],
      };
    }
    const decoded = decodeBlockPage(bytes, makeRef());
    expect(decoded.warnings).toEqual([]);
  });

  it('recovers dangling children on any record type with a warning', () => {
    const bytes = canonical({
      formatVersion: 1,
      meta: {},
      rootOrder: ['p1'],
      blocks: {
        p1: { id: 'p1', type: 'froglight.paragraph', runs: [{ text: 'a' }], children: ['ghost'] },
      },
    });
    const decoded = decodeBlockPage(bytes, makeRef());
    expect(decoded.warnings).toEqual([
      { code: 'DANGLING_CHILD_REFERENCE', blockId: 'p1', refId: 'ghost' },
    ]);
    expect(utf8Decode(encodeBlockPage(decoded.model, makeRef()))).not.toContain('ghost');
  });

  it('applies graph recovery to children declared on opaque plugin records', () => {
    const bytes = canonical({
      formatVersion: 1,
      meta: {},
      rootOrder: ['x'],
      blocks: {
        x: { type: 'acme.kanban', id: 'x', lanes: [1], children: ['y'] },
        y: { type: 'acme.card', id: 'y', children: ['x'] },
      },
    });
    const decoded = decodeBlockPage(bytes, makeRef());
    expect(decoded.warnings.some((w) => w.code === 'CYCLE_BROKEN')).toBe(true);
    // Non-child opaque payload survives untouched.
    expect((decoded.model.blocks.x as Record<string, unknown>).lanes).toEqual([1]);
  });
});
