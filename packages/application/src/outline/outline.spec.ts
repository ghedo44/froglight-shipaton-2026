/**
 * Outline extractors + registry.
 *
 * Headless and engine-free: plain entries only, no editor/DOM/host types.
 * - Markdown reuses `extractHeadings` slugs verbatim (ATX-only, dedup);
 *   empty ATX headings fall back to `heading-<line>`.
 * - Blockpage headings-only: only heading blocks outline
 *   with verbatim levels/labels; paragraph/quote/toggle/callout/code body
 *   blocks, list/table/image/divider/resource-link/embed/opaque/empty/
 *   internals are excluded. `^` sequences are literal plain text in
 *  labels.
 * - Notebook emits heading-role text objects from navigable pages
 *   (`role === 'heading'` via tolerant `textRoleOf`;
 *   body/caption/label/unknown/missing excluded) ordered
 *   deterministically by page-order, then y, x, id.
 * - Conformance hardening: blockpage levels/order/labels
 *   pinned (heading levels verbatim, rootOrder order, verbatim multi-run
 *   labels, invalid levels/records excluded, full body + non-text-family
 *   exclusion sweep); notebook non-heading object exclusion, H1/H2/H3
 *   levels, pageId:objectId ids with pageId addresses, first-line trimmed
 *   labels, opaque-page exclusion, and empty/no-headings docs yielding [].
 * - LaTeX emits section/subsection/subsubsection rows (levels 1/2/3) with
 *   plain-text titles and markdown-style deduped slug addresses; starred
 *   sections are included, while labels, citations, includes, part/chapter,
 *   and paragraph-and-below never become rows.
 * - PDF is a registered empty stub: the real outline is async and
 *   provider-owned (`PdfDocumentHandle.getOutline`), which cannot fit the
 *   synchronous headless `extract` contract.
 */

import { describe, expect, it } from 'vitest';
import { Runtime, definePlugin } from '@froglight/runtime';
import {
  ErrorCodes,
  FroglightError,
  blockPageKindId,
  emptyNotebook,
  latexKindId,
  latexModel,
  markdownKindId,
  notebookKindId,
  notebookPage,
  pdfKindId,
  textObject,
  cardObject,
  imageObject,
  inkStrokeObject,
  markdownModel,
  paragraphBlock,
  headingBlock,
  quoteBlock,
  toggleBlock,
  calloutBlock,
  codeBlock,
  listBlock,
  tableBlock,
  imageBlock,
  dividerBlock,
  resourceLinkBlock,
  resourceEmbedBlock,
  transclusionBlock,
  linkedViewBlock,
  emptyBlockPage,
  navigablePageIds,
  type BlockPageModel,
  type NotebookModel,
} from '@froglight/foundation';
import { extractHeadings } from '@froglight/foundation';
import {
  InMemoryOutlineRegistry,
  MAX_OUTLINE_CACHE_SLOTS,
  firstPartyOutlineExtractors,
  blockPageOutlineExtractor,
  latexOutlineExtractor,
  markdownOutlineExtractor,
  notebookOutlineExtractor,
  outlineExtractorsPlugin,
  outlineRegistryPlugin,
  outlineRegistryToken,
  pdfOutlineExtractor,
  type OutlineExtractor,
} from './index.js';

function blockModelWith(blocks: BlockPageModel['blocks'], rootOrder: string[]): BlockPageModel {
  return { formatVersion: 1, meta: {}, rootOrder, blocks };
}

describe('markdown outline extractor', () => {
  it('reuses extractHeadings slugs verbatim (ATX-only, dedup)', () => {
    const raw = '# Hello\n# Hello\nSetext\n======\n## Two ##';
    const model = markdownModel(raw);
    const entries = markdownOutlineExtractor.extract({ model });
    const expected = extractHeadings(raw);
    expect(entries.map((e) => e.address)).toEqual(expected.map((h) => h.slug));
    expect(entries.map((e) => e.id)).toEqual(expected.map((h) => h.slug));
    expect(entries.map((e) => e.level)).toEqual(expected.map((h) => h.level));
    expect(entries.map((e) => e.label)).toEqual(expected.map((h) => h.text));
    expect(entries.every((e) => e.kind === 'heading')).toBe(true);
    // Setext headings are out of scope (ATX-only contract).
    expect(entries).toHaveLength(3);
  });

  it('maps empty ATX headings to heading-<line>', () => {
    const model = markdownModel('# Title\n#\n##   \n### Sub');
    const entries = markdownOutlineExtractor.extract({ model });
    expect(entries.map((e) => e.address)).toEqual(['title', 'heading-1', 'heading-2', 'sub']);
    expect(entries[1]).toMatchObject({ level: 1, label: '', kind: 'heading' });
    expect(entries[2]).toMatchObject({ level: 2, label: '', kind: 'heading' });
  });

  it('keeps ^ sequences as literal plain text in labels', () => {
    const model = markdownModel('# Hello ^abc\n');
    const entries = markdownOutlineExtractor.extract({ model });
    expect(entries).toHaveLength(1);
    expect(entries[0].label).toBe('Hello ^abc');
  });

  it('returns no entries for an empty document', () => {
    expect(markdownOutlineExtractor.extract({ model: markdownModel('') })).toEqual([]);
    expect(markdownOutlineExtractor.extract({ model: markdownModel('just text\n') })).toEqual([]);
  });

  it('does not mutate the model', () => {
    const model = markdownModel('# A\n# B\n');
    const before = model.raw;
    markdownOutlineExtractor.extract({ model });
    expect(model.raw).toBe(before);
  });
});

describe('block page outline extractor', () => {
  function fixture(): BlockPageModel {
    return blockModelWith(
      {
        h1: headingBlock('h1', 2, [{ text: 'Section' }]),
        h2: headingBlock('h2', 1, [{ text: 'Top' }]),
        p1: paragraphBlock('p1', [{ text: 'Intro paragraph' }]),
        q1: quoteBlock('q1', [{ text: 'Quoted' }]),
        t1: toggleBlock('t1', [{ text: 'Toggle title' }]),
        c1: calloutBlock('c1', [{ text: 'Callout body' }]),
        code1: codeBlock('code1', '\n  const x = 1;\n  const y = 2;\n'),
        empty: paragraphBlock('empty', [{ text: '   ' }]),
        list1: listBlock('list1', false, [{ runs: [{ text: 'item' }] }]),
        table1: tableBlock('table1', 1, [{ cells: [[{ text: 'cell' }]] }]),
        img1: imageBlock('img1', 'assets/a.png', 'abc'),
        div1: dividerBlock('div1'),
        res1: resourceLinkBlock('res1', { documentId: 'd', kindId: 'k', resourceId: 'r' }, 'label'),
        opaque: { id: 'opaque', type: 'acme.future-widget', payload: { keep: true } },
      },
      ['h1', 'h2', 'p1', 'q1', 't1', 'c1', 'code1', 'empty', 'list1', 'table1', 'img1', 'div1', 'res1', 'opaque'],
    );
  }

  it('admits headings only; body blocks never outline', () => {
    const entries = blockPageOutlineExtractor.extract({ model: fixture() });
    expect(entries.map((e) => e.id)).toEqual(['h1', 'h2']);
    expect(entries[0]).toMatchObject({ address: 'h1', level: 2, label: 'Section', kind: 'heading' });
    expect(entries[1]).toMatchObject({ address: 'h2', level: 1, label: 'Top', kind: 'heading' });
  });

  it('excludes code blocks even with non-empty text', () => {
    const model = blockModelWith(
      {
        code: codeBlock('code', '\n\n   const x = 1;   \n  const y = 2;\n'),
        blank: codeBlock('blank', '   \n  \n'),
      },
      ['blank', 'code'],
    );
    expect(blockPageOutlineExtractor.extract({ model })).toEqual([]);
  });

  it('keeps ^ sequences literal in heading labels', () => {
    const model = blockModelWith(
      { h1: headingBlock('h1', 1, [{ text: 'Note ^h1 trailing' }]) },
      ['h1'],
    );
    const entries = blockPageOutlineExtractor.extract({ model });
    expect(entries).toHaveLength(1);
    expect(entries[0].label).toBe('Note ^h1 trailing');
    expect(entries[0].address).toBe('h1');
  });

  it('always admits headings, even with empty text', () => {
    const model = blockModelWith({ h: headingBlock('h', 1, [{ text: '' }]) }, ['h']);
    const entries = blockPageOutlineExtractor.extract({ model });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ level: 1, label: '', kind: 'heading' });
  });

  it('returns no entries for an empty document', () => {
    expect(blockPageOutlineExtractor.extract({ model: emptyBlockPage() })).toEqual([]);
  });

  it('preserves unknown fields and leaves the model untouched', () => {
    const model = fixture();
    const snapshot = JSON.parse(JSON.stringify(model)) as unknown;
    blockPageOutlineExtractor.extract({ model });
    expect(model).toEqual(snapshot);
    expect(model.blocks.opaque).toEqual({
      id: 'opaque',
      type: 'acme.future-widget',
      payload: { keep: true },
    });
  });
});

describe('notebook outline extractor', () => {
  function notebookFixture(): NotebookModel {
    const model = emptyNotebook('Notes');
    const first = notebookPage('page-a', { label: 'First' });
    first.surface.objects['t2'] = textObject('t2', { x: 10, y: 200, text: 'Lower', role: 'heading' });
    first.surface.objects['t1'] = textObject('t1', { x: 10, y: 50, text: 'Upper\nsecond line', role: 'heading' });
    first.surface.objects['blank'] = textObject('blank', { x: 0, y: 10, text: '   ', role: 'heading' });
    first.surface.objects['body'] = textObject('body', { x: 0, y: 5, text: 'Body text' });
    first.surface.order.push('t2', 't1', 'blank', 'body');
    const second = notebookPage('page-b', {});
    second.surface.objects['only'] = textObject('only', { x: 5, y: 5, text: 'Solo', role: 'heading' });
    second.surface.order.push('only');
    model.pages[first.id] = first;
    model.pages[second.id] = second;
    model.pageOrder.push(first.id, second.id);
    // Opaque page: excluded from navigation and from the outline.
    model.pages['ghost'] = { kind: 'opaque', id: 'ghost', raw: { id: 'ghost' } };
    model.pageOrder.push('ghost');
    return model;
  }

  it('omits page rows and opaque pages', () => {
    const model = notebookFixture();
    expect(navigablePageIds(model)).toEqual(['page-a', 'page-b']);
    const entries = notebookOutlineExtractor.extract({ model });
    expect(entries.every((entry) => entry.kind === 'object')).toBe(true);
    expect(entries.some((entry) => entry.label === 'First')).toBe(false);
    expect(entries.some((e) => e.id === 'ghost')).toBe(false);
  });

  it('orders heading objects deterministically by y, then x, then id; body excluded', () => {
    const entries = notebookOutlineExtractor.extract({ model: notebookFixture() });
    const objects = entries.filter((e) => e.kind === 'object');
    expect(objects.map((e) => e.id)).toEqual(['page-a:t1', 'page-a:t2', 'page-b:only']);
    expect(objects[0]).toMatchObject({ address: 'page-a', level: 3, label: 'Upper' });
    expect(objects.some((e) => e.id === 'page-a:body')).toBe(false);
  });

  it('breaks full position ties by object id', () => {
    const model = emptyNotebook();
    const page = notebookPage('p', { label: 'P' });
    page.surface.objects['b-obj'] = textObject('b-obj', { x: 10, y: 10, text: 'Bee', role: 'heading' });
    page.surface.objects['a-obj'] = textObject('a-obj', { x: 10, y: 10, text: 'Aye', role: 'heading' });
    page.surface.order.push('b-obj', 'a-obj');
    model.pages[page.id] = page;
    model.pageOrder.push(page.id);
    const objects = notebookOutlineExtractor.extract({ model }).filter((e) => e.kind === 'object');
    expect(objects.map((e) => e.id)).toEqual(['p:a-obj', 'p:b-obj']);
  });

  it('uses the editor heading sizes for H1, H2, and H3 levels', () => {
    const model = emptyNotebook();
    const page = notebookPage('p');
    for (const [id, size] of [['h1', 24], ['h2', 20], ['h3', 18]] as const) {
      page.surface.objects[id] = textObject(id, { x: 0, y: size, text: id, role: 'heading', size });
      page.surface.order.push(id);
    }
    model.pages[page.id] = page;
    model.pageOrder.push(page.id);
    expect(notebookOutlineExtractor.extract({ model }).map((entry) => [entry.label, entry.level]))
      .toEqual([['h3', 3], ['h2', 2], ['h1', 1]]);
  });

  it('returns no entries for an empty notebook', () => {
    expect(notebookOutlineExtractor.extract({ model: emptyNotebook() })).toEqual([]);
  });

  it('preserves unknown model fields', () => {
    const model = notebookFixture();
    (model as { extra?: unknown }).extra = { future: [1, 2, 3] };
    const snapshot = JSON.parse(JSON.stringify(model)) as unknown;
    notebookOutlineExtractor.extract({ model });
    expect(model).toEqual(snapshot);
  });
});

describe('latex outline extractor', () => {
  it('maps section/subsection/subsubsection to levels 1/2/3 with slug addresses', () => {
    const model = latexModel(
      ['\\section{Intro}', '\\subsection{Background}', '\\subsubsection{Detail}'].join('\n'),
    );
    const entries = latexOutlineExtractor.extract({ model });
    expect(entries).toEqual([
      { id: 'intro', address: 'intro', level: 1, label: 'Intro', kind: 'heading' },
      { id: 'background', address: 'background', level: 2, label: 'Background', kind: 'heading' },
      { id: 'detail', address: 'detail', level: 3, label: 'Detail', kind: 'heading' },
    ]);
  });

  it('includes starred sections at the same level', () => {
    const model = latexModel('\\section*{Unnumbered}\n\\subsection*{Deep}\n');
    const entries = latexOutlineExtractor.extract({ model });
    expect(entries.map((e) => e.address)).toEqual(['unnumbered', 'deep']);
    expect(entries[0]).toMatchObject({ level: 1, label: 'Unnumbered', kind: 'heading' });
    expect(entries[1]).toMatchObject({ level: 2, label: 'Deep', kind: 'heading' });
  });

  it('reduces titles to plain text for labels and slugs', () => {
    const model = latexModel('\\section{The \\textbf{Bold} Title}\n');
    const entries = latexOutlineExtractor.extract({ model });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ address: 'the-bold-title', label: 'The Bold Title' });
  });

  it('dedupes repeated titles markdown-style with a -1 suffix', () => {
    const model = latexModel('\\section{Hello}\n\\section{Hello}\n\\section{Hello}\n');
    const entries = latexOutlineExtractor.extract({ model });
    expect(entries.map((e) => e.address)).toEqual(['hello', 'hello-1', 'hello-2']);
    expect(entries.map((e) => e.id)).toEqual(entries.map((e) => e.address));
  });

  it('keeps suffix-colliding titles globally unique', () => {
    const model = latexModel('\\section{Hello}\n\\section{Hello}\n\\section{Hello-1}\n');
    const entries = latexOutlineExtractor.extract({ model });
    expect(entries.map((e) => e.address)).toEqual(['hello', 'hello-1', 'hello-1-1']);
    expect(entries.map((e) => e.id)).toEqual(entries.map((e) => e.address));
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
  });

  it('keeps section-<line> fallbacks globally unique against real slugs', () => {
    const model = latexModel('\\section{Hello}\n\\section{$$$}\n\\section{Section-1}\n');
    const entries = latexOutlineExtractor.extract({ model });
    expect(entries.map((e) => e.address)).toEqual(['hello', 'section-1', 'section-1-1']);
    expect(entries.map((e) => e.id)).toEqual(entries.map((e) => e.address));
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
  });

  it('excludes labels, citations, includes, part/chapter, and paragraph-and-below', () => {
    const model = latexModel(
      [
        '\\part{Top}',
        '\\chapter{Book}',
        '\\section{Real}\\label{sec:real}',
        'See \\cite{knuth84}.',
        '\\input{chapters/one}',
        '\\paragraph{Too deep}',
        '\\subsubsection{Kept}',
      ].join('\n'),
    );
    const entries = latexOutlineExtractor.extract({ model });
    expect(entries.map((e) => e.label)).toEqual(['Real', 'Kept']);
    expect(entries.map((e) => e.level)).toEqual([1, 3]);
  });

  it('ignores commented-out sections and prefers the long title over the optional short one', () => {
    const model = latexModel('% \\section{Ghost}\n\\section[Short]{Long Title}\n');
    const entries = latexOutlineExtractor.extract({ model });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ address: 'long-title', label: 'Long Title', level: 1 });
  });

  it('returns no entries for an empty document', () => {
    expect(latexOutlineExtractor.extract({ model: latexModel('') })).toEqual([]);
    expect(latexOutlineExtractor.extract({ model: latexModel('just text\n') })).toEqual([]);
  });

  it('does not mutate the model', () => {
    const model = latexModel('\\section{A}\n\\section{B}\n');
    const before = model.raw;
    latexOutlineExtractor.extract({ model });
    expect(model.raw).toBe(before);
  });
});

describe('pdf outline extractor stub', () => {
  it('returns empty: the real outline is async and provider-owned', () => {
    expect(pdfOutlineExtractor.extract({ model: { bytes: new Uint8Array() } })).toEqual([]);
  });
});

describe('outline registry revision cache', () => {
  it('does not rebuild for repeated keystrokes at the same revision', () => {
    const registry = new InMemoryOutlineRegistry();
    let computes = 0;
    const counting: OutlineExtractor = {
      kindId: markdownKindId,
      extract: (input) => {
        computes += 1;
        return markdownOutlineExtractor.extract(input);
      },
    };
    registry.register(counting);
    const model = markdownModel('# A\n');
    const first = registry.getOutline(markdownKindId, model, 'rev-1', { documentIdentity: 'doc-a' });
    const second = registry.getOutline(markdownKindId, model, 'rev-1', { documentIdentity: 'doc-a' });
    expect(computes).toBe(1);
    expect(second).toBe(first);
    registry.getOutline(markdownKindId, model, 'rev-2', { documentIdentity: 'doc-a' });
    expect(computes).toBe(2);
  });

  it('falls back to a stable content hash when no revision is given', () => {
    const registry = new InMemoryOutlineRegistry();
    let computes = 0;
    const counting: OutlineExtractor = {
      kindId: blockPageKindId,
      extract: (input) => {
        computes += 1;
        return blockPageOutlineExtractor.extract(input);
      },
    };
    registry.register(counting);
    const a = blockModelWith({ p: paragraphBlock('p', [{ text: 'hi' }]) }, ['p']);
    const b = blockModelWith({ p: paragraphBlock('p', [{ text: 'hi' }]) }, ['p']);
    expect(registry.getOutline(blockPageKindId, a, undefined, { documentIdentity: 'doc-a' })).toBe(registry.getOutline(blockPageKindId, b, undefined, { documentIdentity: 'doc-a' }));
    expect(computes).toBe(1);
    const c = blockModelWith({ p: paragraphBlock('p', [{ text: 'changed' }]) }, ['p']);
    registry.getOutline(blockPageKindId, c, undefined, { documentIdentity: 'doc-a' });
    expect(computes).toBe(2);
  });

  it('supports explicit invalidation owned by the panel effect', () => {
    const registry = new InMemoryOutlineRegistry();
    let computes = 0;
    const counting: OutlineExtractor = {
      kindId: notebookKindId,
      extract: (input) => {
        computes += 1;
        return notebookOutlineExtractor.extract(input);
      },
    };
    registry.register(counting);
    const model = emptyNotebook();
    registry.getOutline(notebookKindId, model, 'r1', { documentIdentity: 'doc-a' });
    registry.invalidate(notebookKindId);
    registry.getOutline(notebookKindId, model, 'r1', { documentIdentity: 'doc-a' });
    expect(computes).toBe(2);
  });

  it('rejects duplicate kinds and unknown lookups', () => {
    const registry = new InMemoryOutlineRegistry();
    registry.register(markdownOutlineExtractor);
    expect(() => registry.register(markdownOutlineExtractor)).toThrow();
    expect(() => registry.get(pdfKindId)).toThrow();
    expect(() => registry.getOutline(pdfKindId, {})).toThrow();
  });
});

describe('outline registry document scoping', () => {
  function countingMarkdown() {
    let computes = 0;
    const counting: OutlineExtractor = {
      kindId: markdownKindId,
      extract: (input) => {
        computes += 1;
        return markdownOutlineExtractor.extract(input);
      },
    };
    return { counting, computes: () => computes };
  }

  it('isolates documents sharing one revision when documentIdentity is supplied', () => {
    const registry = new InMemoryOutlineRegistry();
    const { counting, computes } = countingMarkdown();
    registry.register(counting);
    const first = registry.getOutline(markdownKindId, markdownModel('# Alpha\n'), 'rev-1', {
      documentIdentity: 'doc-a',
    });
    const other = registry.getOutline(markdownKindId, markdownModel('# Beta\n'), 'rev-1', {
      documentIdentity: 'doc-b',
    });
    expect(computes()).toBe(2);
    expect(first.map((e) => e.label)).toEqual(['Alpha']);
    expect(other.map((e) => e.label)).toEqual(['Beta']);
    // Re-reading doc-a at the same revision is a cache hit.
    expect(registry.getOutline(markdownKindId, markdownModel('# Alpha\n'), 'rev-1', {
      documentIdentity: 'doc-a',
    })).toBe(first);
    expect(computes()).toBe(2);
  });

  it('hits the cache for the same documentIdentity at the same revision', () => {
    const registry = new InMemoryOutlineRegistry();
    const { counting, computes } = countingMarkdown();
    registry.register(counting);
    const model = markdownModel('# A\n');
    const first = registry.getOutline(markdownKindId, model, 'rev-1', {
      documentIdentity: 'doc-a',
    });
    const second = registry.getOutline(markdownKindId, model, 'rev-1', {
      documentIdentity: 'doc-a',
    });
    expect(computes()).toBe(1);
    expect(second).toBe(first);
  });

  it('misses when the revision advances for the same documentIdentity', () => {
    const registry = new InMemoryOutlineRegistry();
    const { counting, computes } = countingMarkdown();
    registry.register(counting);
    registry.getOutline(markdownKindId, markdownModel('# A\n'), 'rev-1', {
      documentIdentity: 'doc-a',
    });
    registry.getOutline(markdownKindId, markdownModel('# A changed\n'), 'rev-2', {
      documentIdentity: 'doc-a',
    });
    expect(computes()).toBe(2);
  });

  it('extracts fresh rows when a caller has no document identity', () => {
    const registry = new InMemoryOutlineRegistry();
    const { counting, computes } = countingMarkdown();
    registry.register(counting);
    const first = registry.getOutline(markdownKindId, markdownModel('# Alpha\n'), 'rev-1');
    const second = registry.getOutline(markdownKindId, markdownModel('# Beta\n'), 'rev-1');
    expect(first.map((entry) => entry.label)).toEqual(['Alpha']);
    expect(second.map((entry) => entry.label)).toEqual(['Beta']);
    expect(computes()).toBe(2);
    expect(registry.stats().size).toBe(0);
  });

  it('scopes invalidation per documentIdentity', () => {
    const registry = new InMemoryOutlineRegistry();
    const { counting, computes } = countingMarkdown();
    registry.register(counting);
    const modelA = markdownModel('# Alpha\n');
    const modelB = markdownModel('# Beta\n');
    const firstA = registry.getOutline(markdownKindId, modelA, 'rev-1', {
      documentIdentity: 'doc-a',
    });
    registry.getOutline(markdownKindId, modelB, 'rev-1', { documentIdentity: 'doc-b' });
    expect(computes()).toBe(2);
    registry.invalidate(markdownKindId, 'doc-a');
    // doc-b stays cached; doc-a rebuilds.
    expect(registry.getOutline(markdownKindId, modelB, 'rev-1', {
      documentIdentity: 'doc-b',
    })).toHaveLength(1);
    expect(computes()).toBe(2);
    expect(registry.getOutline(markdownKindId, modelA, 'rev-1', {
      documentIdentity: 'doc-a',
    })).not.toBe(firstA);
    expect(computes()).toBe(3);
  });

  it('drops every document of a kind on kind-wide invalidation', () => {
    const registry = new InMemoryOutlineRegistry();
    const { counting, computes } = countingMarkdown();
    registry.register(counting);
    registry.getOutline(markdownKindId, markdownModel('# Alpha\n'), 'rev-1', {
      documentIdentity: 'doc-a',
    });
    registry.getOutline(markdownKindId, markdownModel('# Beta\n'), 'rev-1', {
      documentIdentity: 'doc-b',
    });
    expect(computes()).toBe(2);
    registry.invalidate(markdownKindId);
    registry.getOutline(markdownKindId, markdownModel('# Alpha\n'), 'rev-1', {
      documentIdentity: 'doc-a',
    });
    registry.getOutline(markdownKindId, markdownModel('# Beta\n'), 'rev-1', {
      documentIdentity: 'doc-b',
    });
    expect(computes()).toBe(4);
  });
});

describe('block page nested children are internals', () => {
  it('excludes paragraph children nested under list items even when present in blocks', () => {
    const model = blockModelWith(
      {
        list1: listBlock('list1', false, [
          { runs: [{ text: 'item' }], children: ['child1'] },
        ]),
        child1: paragraphBlock('child1', [{ text: 'Nested paragraph' }]),
      },
      ['list1'],
    );
    expect(blockPageOutlineExtractor.extract({ model })).toEqual([]);
  });

  it('excludes heading children nested under list items', () => {
    const model = blockModelWith(
      {
        list1: listBlock('list1', false, [
          { runs: [{ text: 'item' }], children: ['child1'] },
        ]),
        child1: headingBlock('child1', 2, [{ text: 'Nested heading' }]),
      },
      ['list1'],
    );
    expect(blockPageOutlineExtractor.extract({ model })).toEqual([]);
  });

  it('excludes children referenced by the generic children member', () => {
    const model = blockModelWith(
      {
        h1: { ...headingBlock('h1', 1, [{ text: 'Top' }]), children: ['kid'] },
        kid: headingBlock('kid', 2, [{ text: 'Nested kid' }]),
      },
      ['h1'],
    );
    const entries = blockPageOutlineExtractor.extract({ model });
    expect(entries.map((e) => e.id)).toEqual(['h1']);
  });

  it('marks transitive grandchildren as internals', () => {
    const model = blockModelWith(
      {
        list1: listBlock('list1', false, [
          { runs: [{ text: 'item' }], children: ['mid'] },
        ]),
        mid: { ...paragraphBlock('mid', [{ text: 'Mid' }]), children: ['leaf'] },
        leaf: paragraphBlock('leaf', [{ text: 'Leaf' }]),
      },
      ['list1'],
    );
    expect(blockPageOutlineExtractor.extract({ model })).toEqual([]);
  });

  it('still outlines truly-unreachable top-level records (recovered documents)', () => {
    const model = blockModelWith(
      {
        h1: headingBlock('h1', 1, [{ text: 'Top' }]),
        orphan: headingBlock('orphan', 2, [{ text: 'Orphan' }]),
      },
      ['h1'],
    );
    const entries = blockPageOutlineExtractor.extract({ model });
    expect(entries.map((e) => e.id)).toEqual(['h1', 'orphan']);
  });
});

describe('outline registry error contract (hardened)', () => {
  it('reports supported kinds independently of whether they have rows', () => {
    const registry = new InMemoryOutlineRegistry();
    expect(registry.supports(notebookKindId)).toBe(false);
    const registration = registry.register(notebookOutlineExtractor);
    expect(registry.supports(notebookKindId)).toBe(true);
    expect(registry.getOutline(notebookKindId, emptyNotebook())).toEqual([]);
    registry.register(pdfOutlineExtractor);
    expect(registry.supports(pdfKindId)).toBe(false);
    registration.dispose();
    expect(registry.supports(notebookKindId)).toBe(false);
  });

  it('throws DUPLICATE_OUTLINE_EXTRACTOR on duplicate registration', () => {
    const registry = new InMemoryOutlineRegistry();
    registry.register(markdownOutlineExtractor);
    let caught: unknown;
    try {
      registry.register(markdownOutlineExtractor);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FroglightError);
    expect((caught as FroglightError).code).toBe('DUPLICATE_OUTLINE_EXTRACTOR');
    expect((caught as FroglightError).code).toBe(ErrorCodes.DUPLICATE_OUTLINE_EXTRACTOR);
    expect((caught as Error).message).toMatch(/already registered/);
  });

  it('throws UNKNOWN_OUTLINE_KIND on unknown kind lookups', () => {
    const registry = new InMemoryOutlineRegistry();
    for (const lookup of [
      () => registry.get(pdfKindId),
      () => registry.getOutline(pdfKindId, {}),
    ]) {
      let caught: unknown;
      try {
        lookup();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(FroglightError);
      expect((caught as FroglightError).code).toBe('UNKNOWN_OUTLINE_KIND');
      expect((caught as FroglightError).code).toBe(ErrorCodes.UNKNOWN_OUTLINE_KIND);
      expect((caught as Error).message).toMatch(/unknown outline kind/);
    }
  });
});

describe('outline registry hardening', () => {
  function countingMarkdown() {
    let computes = 0;
    const counting: OutlineExtractor = {
      kindId: markdownKindId,
      extract: (input) => {
        computes += 1;
        return markdownOutlineExtractor.extract(input);
      },
    };
    return { counting, computes: () => computes };
  }

  it('freezes row arrays and rows on every return; hits keep identity', () => {
    const registry = new InMemoryOutlineRegistry();
    const { counting } = countingMarkdown();
    registry.register(counting);
    const model = markdownModel('# A\n');
    const first = registry.getOutline(markdownKindId, model, 'r1', {
      documentIdentity: 'doc-a',
    });
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.length).toBeGreaterThan(0);
    for (const row of first) expect(Object.isFrozen(row)).toBe(true);
    const second = registry.getOutline(markdownKindId, model, 'r1', {
      documentIdentity: 'doc-a',
    });
    expect(second).toBe(first);
    expect(Object.isFrozen(second)).toBe(true);
    // Freshly computed uncached rows are frozen as well.
    const fresh = registry.getOutline(markdownKindId, markdownModel('# B\n'), 'r2', {
      documentIdentity: 'doc-b',
    });
    expect(Object.isFrozen(fresh)).toBe(true);
  });

  it('tracks hit/miss counters and size; invalidate preserves counters', () => {
    const registry = new InMemoryOutlineRegistry();
    const { counting } = countingMarkdown();
    registry.register(counting);
    expect(registry.stats()).toEqual({ hits: 0, misses: 0, size: 0, capacity: MAX_OUTLINE_CACHE_SLOTS });
    const model = markdownModel('# A\n');
    registry.getOutline(markdownKindId, model, 'r1', { documentIdentity: 'doc-a' });
    expect(registry.stats()).toMatchObject({ hits: 0, misses: 1, size: 1 });
    registry.getOutline(markdownKindId, model, 'r1', { documentIdentity: 'doc-a' });
    expect(registry.stats()).toMatchObject({ hits: 1, misses: 1, size: 1 });
    registry.getOutline(markdownKindId, markdownModel('# A changed\n'), 'r2', {
      documentIdentity: 'doc-a',
    });
    expect(registry.stats()).toMatchObject({ hits: 1, misses: 2, size: 1 });
    registry.invalidate(markdownKindId, 'doc-a');
    expect(registry.stats()).toMatchObject({ hits: 1, misses: 2, size: 0 });
  });

  it('bounds the cache with LRU eviction at MAX_OUTLINE_CACHE_SLOTS', () => {
    const registry = new InMemoryOutlineRegistry();
    const { counting, computes } = countingMarkdown();
    registry.register(counting);
    for (let i = 0; i < MAX_OUTLINE_CACHE_SLOTS; i += 1) {
      registry.getOutline(markdownKindId, markdownModel(`# Doc ${i}\n`), 'rev-1', {
        documentIdentity: `doc-${i}`,
      });
    }
    expect(computes()).toBe(MAX_OUTLINE_CACHE_SLOTS);
    expect(registry.stats().size).toBe(MAX_OUTLINE_CACHE_SLOTS);
    // Touch doc-0 so it becomes most-recent; the next insert must evict
    // doc-1 (LRU), not doc-0.
    registry.getOutline(markdownKindId, markdownModel('# Doc 0\n'), 'rev-1', {
      documentIdentity: 'doc-0',
    });
    expect(computes()).toBe(MAX_OUTLINE_CACHE_SLOTS);
    expect(registry.stats().hits).toBe(1);
    registry.getOutline(markdownKindId, markdownModel('# Extra\n'), 'rev-1', {
      documentIdentity: 'doc-extra',
    });
    expect(computes()).toBe(MAX_OUTLINE_CACHE_SLOTS + 1);
    expect(registry.stats().size).toBe(MAX_OUTLINE_CACHE_SLOTS);
    // doc-0 survives (recently touched); doc-1 was evicted.
    registry.getOutline(markdownKindId, markdownModel('# Doc 0\n'), 'rev-1', {
      documentIdentity: 'doc-0',
    });
    expect(computes()).toBe(MAX_OUTLINE_CACHE_SLOTS + 1);
    registry.getOutline(markdownKindId, markdownModel('# Doc 1\n'), 'rev-1', {
      documentIdentity: 'doc-1',
    });
    expect(computes()).toBe(MAX_OUTLINE_CACHE_SLOTS + 2);
    expect(registry.stats().size).toBe(MAX_OUTLINE_CACHE_SLOTS);
  });
});

describe('outline registry effect ownership', () => {
  it('activate -> registrations, dispose -> zero, reactivate -> registrations', async () => {
    const runtime = new Runtime();
    await runtime.registerSlot({ id: 'outline-registry', plugin: outlineRegistryPlugin });
    const slot = await runtime.registerSlot({ id: 'outline-extractors', plugin: outlineExtractorsPlugin });
    void slot;
    const probe = definePlugin({
      id: 'test.outline-probe',
      requirements: { requires: [outlineRegistryToken] },
      activate: (ctx) => {
        const registry = ctx.require(outlineRegistryToken);
        expect(registry.list()).toEqual(firstPartyOutlineExtractors);
        expect(registry.get(markdownKindId)).toBe(markdownOutlineExtractor);
        expect(registry.get(blockPageKindId)).toBe(blockPageOutlineExtractor);
        expect(registry.get(notebookKindId)).toBe(notebookOutlineExtractor);
        expect(registry.get(latexKindId)).toBe(latexOutlineExtractor);
        expect(registry.get(pdfKindId)).toBe(pdfOutlineExtractor);
      },
    });
    await runtime.registerSlot({ id: 'probe', plugin: probe });

    await runtime.removeSlot('outline-extractors');
    const checkEmpty = definePlugin({
      id: 'test.outline-probe-empty',
      requirements: { requires: [outlineRegistryToken] },
      activate: (ctx) => {
        expect(ctx.require(outlineRegistryToken).list()).toHaveLength(0);
      },
    });
    await runtime.registerSlot({ id: 'probe-empty', plugin: checkEmpty });
    await runtime.removeSlot('probe-empty');

    await runtime.registerSlot({ id: 'outline-extractors', plugin: outlineExtractorsPlugin });
    const checkFull = definePlugin({
      id: 'test.outline-probe-full',
      requirements: { requires: [outlineRegistryToken] },
      activate: (ctx) => {
        expect(ctx.require(outlineRegistryToken).list()).toEqual(
          firstPartyOutlineExtractors,
        );
      },
    });
    await runtime.registerSlot({ id: 'probe-full', plugin: checkFull });

    await runtime.dispose();
  });
});

describe('outline conformance hardening', () => {
  describe('blockpage levels, labels, and order', () => {
    it('keeps heading levels verbatim in rootOrder; body blocks never outline', () => {
      const model = blockModelWith(
        {
          p2: paragraphBlock('p2', [{ text: 'Second' }]),
          h6: headingBlock('h6', 6, [{ text: 'Deep' }]),
          p1: paragraphBlock('p1', [{ text: 'First' }]),
          h1: headingBlock('h1', 1, [{ text: 'Top' }]),
        },
        ['h1', 'p1', 'h6', 'p2'],
      );
      const entries = blockPageOutlineExtractor.extract({ model });
      // rootOrder wins over blocks map insertion order; body blocks excluded.
      expect(entries.map((e) => e.id)).toEqual(['h1', 'h6']);
      expect(entries.map((e) => e.level)).toEqual([1, 6]);
      // The row address is the block id itself.
      expect(entries.map((e) => e.address)).toEqual(['h1', 'h6']);
      expect(entries[0]).toMatchObject({ kind: 'heading', label: 'Top' });
      expect(entries[1]).toMatchObject({ kind: 'heading', label: 'Deep' });
    });

    it('joins multi-run heading text verbatim, ignoring marks', () => {
      const model = blockModelWith(
        {
          m: headingBlock('m', 2, [
            { text: 'Hello ' },
            { text: 'world', marks: ['bold'] },
            { text: '!' },
          ]),
        },
        ['m'],
      );
      const entries = blockPageOutlineExtractor.extract({ model });
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        id: 'm',
        address: 'm',
        level: 2,
        label: 'Hello world!',
        kind: 'heading',
      });
    });

    it('excludes invalid heading levels and structurally invalid records', () => {
      const model = blockModelWith(
        {
          badZero: { id: 'badZero', type: 'froglight.heading', level: 0, runs: [{ text: 'Zero' }] },
          badSeven: { id: 'badSeven', type: 'froglight.heading', level: 7, runs: [{ text: 'Seven' }] },
          badFloat: { id: 'badFloat', type: 'froglight.heading', level: 2.5, runs: [{ text: 'Float' }] },
          badMissing: { id: 'badMissing', type: 'froglight.heading', runs: [{ text: 'No level' }] },
          broken: { id: 'broken', type: 'froglight.paragraph' },
          ok: headingBlock('ok', 3, [{ text: 'Kept' }]),
        },
        ['badZero', 'badSeven', 'badFloat', 'badMissing', 'broken', 'ok'],
      );
      const entries = blockPageOutlineExtractor.extract({ model });
      expect(entries.map((e) => e.id)).toEqual(['ok']);
      expect(entries[0]).toMatchObject({ level: 3, label: 'Kept', kind: 'heading' });
    });

    it('excludes every body + non-text family: paragraph/quote/toggle/callout/code/list/table/image/divider/resource-link/embed/transclusion/linked-view/opaque/empty', () => {
      const target = { documentId: 'd', kindId: 'k', resourceId: 'r' };
      const model = blockModelWith(
        {
          keep: headingBlock('keep', 2, [{ text: 'Kept' }]),
          para: paragraphBlock('para', [{ text: 'Body' }]),
          quote: quoteBlock('quote', [{ text: 'Quoted' }]),
          toggle: toggleBlock('toggle', [{ text: 'Toggle' }]),
          callout: calloutBlock('callout', [{ text: 'Callout' }]),
          code: codeBlock('code', 'const x = 1;'),
          list: listBlock('list', false, [{ runs: [{ text: 'item' }] }]),
          table: tableBlock('table', 1, [{ cells: [[{ text: 'cell' }]] }]),
          image: imageBlock('image', 'assets/a.png', 'abc'),
          divider: dividerBlock('divider'),
          link: resourceLinkBlock('link', target, 'label'),
          embed: resourceEmbedBlock('embed', target),
          transclusion: transclusionBlock('transclusion', { ...target, address: 'keep' }),
          linked: linkedViewBlock('linked', target, 'view-1'),
          opaque: { id: 'opaque', type: 'acme.future-widget', payload: { keep: true } },
          empty: headingBlock('empty', 1, [{ text: '' }]),
          blank: paragraphBlock('blank', [{ text: '   ' }]),
        },
        [
          'keep',
          'para',
          'quote',
          'toggle',
          'callout',
          'code',
          'list',
          'table',
          'image',
          'divider',
          'link',
          'embed',
          'transclusion',
          'linked',
          'opaque',
          'empty',
          'blank',
        ],
      );
      const entries = blockPageOutlineExtractor.extract({ model });
      // Only headings outline; empty headings are admitted per policy.
      expect(entries.map((e) => e.id)).toEqual(['keep', 'empty']);
      expect(entries[0]).toMatchObject({ kind: 'heading', label: 'Kept' });
    });

    it('excludes code blocks even with non-empty text', () => {
      const model = blockModelWith(
        {
          blank: codeBlock('blank', '   \n  \n'),
          code: codeBlock('code', '\n\n   const x = 1;   \n  const y = 2;\n'),
        },
        ['blank', 'code'],
      );
      expect(blockPageOutlineExtractor.extract({ model })).toEqual([]);
    });

    it('yields no rows for a paragraph-only document', () => {
      const model = blockModelWith(
        {
          p1: paragraphBlock('p1', [{ text: 'Body one' }]),
          p2: paragraphBlock('p2', [{ text: 'Body two' }]),
        },
        ['p1', 'p2'],
      );
      expect(blockPageOutlineExtractor.extract({ model })).toEqual([]);
    });

    it('yields no rows for a document with only excluded content', () => {
      const model = blockModelWith(
        { l: listBlock('l', false, [{ runs: [{ text: 'item' }] }]) },
        ['l'],
      );
      expect(blockPageOutlineExtractor.extract({ model })).toEqual([]);
    });
  });

  describe('notebook pages, objects, and addresses', () => {
    it('omits page labels when no headings are present', () => {
      const model = emptyNotebook('Notes');
      const first = notebookPage('page-a', {});
      const second = notebookPage('page-b', {});
      const named = notebookPage('page-c', { label: 'Named' });
      model.pages[first.id] = first;
      model.pages[second.id] = second;
      model.pages[named.id] = named;
      model.pageOrder.push(first.id, second.id, named.id);
      expect(notebookOutlineExtractor.extract({ model })).toEqual([]);
    });

    it('emits y->x->id heading rows with pageId:objectId ids, pageId addresses, and trimmed first-line labels', () => {
      const model = emptyNotebook('Notes');
      const first = notebookPage('page-a', { label: 'First' });
      first.surface.objects['late'] = textObject('late', { x: 0, y: 300, text: 'Late', role: 'heading' });
      first.surface.objects['early'] = textObject('early', {
        x: 5,
        y: 20,
        text: '\n   Padded   \nsecond line',
        role: 'heading',
      });
      first.surface.objects['blank'] = textObject('blank', { x: 0, y: 10, text: '   ', role: 'heading' });
      first.surface.objects['body'] = textObject('body', { x: 0, y: 4, text: 'Body text' });
      first.surface.objects['caption'] = textObject('caption', { x: 0, y: 5, text: 'Caption text', role: 'caption' });
      first.surface.objects['label'] = textObject('label', { x: 0, y: 6, text: 'Label text', role: 'label' });
      first.surface.objects['unknown'] = {
        ...textObject('unknown', { x: 0, y: 7, text: 'Future text' }),
        role: 'acme.future-role',
      };
      first.surface.objects['missing'] = textObject('missing', { x: 0, y: 8, text: 'No role' });
      first.surface.objects['card'] = cardObject('card', {
        x: 0,
        y: 1,
        width: 10,
        height: 10,
        text: 'Card text',
      });
      first.surface.objects['img'] = imageObject('img', {
        x: 0,
        y: 2,
        width: 10,
        height: 10,
        src: 'a.png',
        sha256: 'abc',
      });
      first.surface.objects['stroke'] = inkStrokeObject('stroke', { points: [{ x: 0, y: 3 }] });
      first.surface.objects['future'] = { id: 'future', type: 'acme.future-object', x: 0, y: 0 };
      first.surface.order.push('late', 'early', 'blank', 'body', 'caption', 'label', 'unknown', 'missing', 'card', 'img', 'stroke', 'future');
      model.pages[first.id] = first;
      model.pageOrder.push(first.id);
      // Surface insertion order loses to the y->x->id sort; blank, body,
      // caption, label, unknown/missing-role, card, image, stroke, and
      // opaque objects never become rows — only heading-role texts do.
      expect(notebookOutlineExtractor.extract({ model })).toEqual([
        { id: 'page-a:early', address: 'page-a', level: 3, label: 'Padded', kind: 'object' },
        { id: 'page-a:late', address: 'page-a', level: 3, label: 'Late', kind: 'object' },
      ]);
    });

    it('excludes opaque pages even when listed in page order', () => {
      const model = emptyNotebook();
      const page = notebookPage('p', { label: 'P' });
      model.pages[page.id] = page;
      model.pageOrder.push(page.id);
      model.pages['ghost'] = { kind: 'opaque', id: 'ghost', raw: { id: 'ghost' } };
      model.pageOrder.push('ghost');
      const entries = notebookOutlineExtractor.extract({ model });
      expect(entries).toEqual([]);
      expect(entries.some((e) => e.id === 'ghost' || e.address === 'ghost')).toBe(false);
    });

    it('returns no entries for an empty notebook', () => {
      expect(notebookOutlineExtractor.extract({ model: emptyNotebook() })).toEqual([]);
      expect(notebookOutlineExtractor.extract({ model: emptyNotebook('Notes') })).toEqual([]);
    });

    it('returns no rows for a body-only notebook', () => {
      const model = emptyNotebook('Notes');
      const page = notebookPage('page-a', { label: 'First' });
      page.surface.objects['body'] = textObject('body', { x: 0, y: 10, text: 'Body text' });
      page.surface.objects['caption'] = textObject('caption', { x: 0, y: 20, text: 'Caption', role: 'caption' });
      page.surface.order.push('body', 'caption');
      model.pages[page.id] = page;
      model.pageOrder.push(page.id);
      expect(notebookOutlineExtractor.extract({ model })).toEqual([]);
    });
  });
});
