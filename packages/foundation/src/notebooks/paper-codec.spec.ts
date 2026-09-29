/**
 * Notebook paper codec conformance (slice 10): the additive `paper`
 * record on template bases round-trips byte-stably and degrades invalid
 * paper to opaque-with-warning.
 */

import { describe, expect, it } from 'vitest';
import { utf8Decode, utf8Encode } from '../encoding.js';
import { decodeNotebook, encodeNotebook } from './codec.js';
import {
  emptyNotebook,
  notebookPage,
  paperOptionsOf,
  setPaperOptions,
} from './model.js';

function bytesOf(value: unknown): Uint8Array {
  return utf8Encode(JSON.stringify(value));
}

describe('paper codec', () => {
  it('round-trips paper options byte-stably', () => {
    const model = emptyNotebook();
    const page = notebookPage('p1', {
      template: 'froglight.lined',
      paper: { spacing: 48, paperColor: '#faf7ef' },
    });
    model.pages.p1 = page;
    model.pageOrder.push('p1');
    const original = utf8Decode(encodeNotebook(model));
    const decoded = decodeNotebook(utf8Encode(original));
    expect(decoded.warnings).toEqual([]);
    expect(paperOptionsOf(decoded.model.pages.p1 as never)).toEqual({
      spacing: 48,
      paperColor: '#faf7ef',
    });
    expect(utf8Decode(encodeNotebook(decoded.model))).toBe(original);
  });

  it('reads absent paper as template defaults', () => {
    const model = emptyNotebook();
    model.pages.p1 = notebookPage('p1', { template: 'froglight.grid' });
    model.pageOrder.push('p1');
    const decoded = decodeNotebook(encodeNotebook(model));
    expect(decoded.warnings).toEqual([]);
    expect(paperOptionsOf(decoded.model.pages.p1 as never)).toBeUndefined();
  });

  it('sets and clears paper options through the model helpers', () => {
    const page = notebookPage('p1', { template: 'froglight.lined' });
    setPaperOptions(page, { spacing: 56 });
    expect(paperOptionsOf(page)).toEqual({ spacing: 56 });
    setPaperOptions(page, undefined);
    expect(paperOptionsOf(page)).toBeUndefined();
    expect('paper' in (page.record.base as Record<string, unknown>)).toBe(false);
  });

  it('degrades invalid paper to opaque-with-warning without dropping bytes', () => {
    const raw = {
      formatVersion: 1,
      meta: {},
      pageOrder: ['p1'],
      pages: {
        p1: {
          id: 'p1',
          base: {
            kind: 'template',
            template: 'froglight.lined',
            paper: { spacing: -5 },
          },
          surface: {
            formatVersion: 1,
            frame: { kind: 'bounded', width: 100, height: 100 },
            order: [],
            objects: {},
          },
        },
      },
    };
    const decoded = decodeNotebook(bytesOf(raw));
    expect(decoded.warnings).toEqual([
      { code: 'INVALID_PAGE_BASE', pageId: 'p1' },
    ]);
    const entry = decoded.model.pages.p1;
    expect(entry?.kind).toBe('opaque');
    // Re-encoding preserves the damaged record verbatim.
    const reencoded = JSON.parse(utf8Decode(encodeNotebook(decoded.model)));
    expect(reencoded.pages.p1.base.paper).toEqual({ spacing: -5 });
  });

  it('reads current pages without paper as template defaults', () => {
    const raw = {
      formatVersion: 1,
      meta: {},
      pageOrder: ['p1'],
      pages: {
        p1: {
          id: 'p1',
          base: { kind: 'template', template: 'froglight.cornell' },
          surface: {
            formatVersion: 1,
            frame: { kind: 'bounded', width: 100, height: 100 },
            order: [],
            objects: {},
          },
        },
      },
    };
    const decoded = decodeNotebook(bytesOf(raw));
    expect(decoded.warnings).toEqual([]);
    const entry = decoded.model.pages.p1;
    expect(entry?.kind).toBe('page');
    if (entry?.kind !== 'page') return;
    expect(entry.record.base).toEqual({
      kind: 'template',
      template: 'froglight.cornell',
    });
  });
});
