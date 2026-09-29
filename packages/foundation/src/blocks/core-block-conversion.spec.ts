/**
 * Markdown conversion reports structured warnings for content it cannot
 * preserve; it never drops content silently.
 */

import { describe, expect, it } from 'vitest';
import {
  BLOCK_PAGE_BLOCK_TYPES as T,
  calloutBlock,
  dividerBlock,
  emptyBlockPage,
  headingBlock,
  listBlock,
  paragraphBlock,
  quoteBlock,
  toggleBlock,
  type BlockPageModel,
} from './model.js';
import { exportBlockPageToMarkdown, importMarkdownToBlockPage } from './conversion.js';

function pageWith(...records: Array<Record<string, unknown>>): BlockPageModel {
  const model = emptyBlockPage();
  for (const record of records) {
    const id = String(record.id);
    model.blocks[id] = record as never;
    model.rootOrder.push(id);
  }
  return model;
}

describe('export of new core types', () => {
  it('exports quote and divider losslessly', () => {
    const result = exportBlockPageToMarkdown(
      pageWith(quoteBlock('q', [{ text: 'wise' }]), dividerBlock('d')),
    );
    expect(result.warnings).toEqual([]);
    expect(result.status).toBe('lossless');
    expect(result.markdown).toBe('> wise\n\n---\n');
  });

  it('exports to-do items as GFM task items', () => {
    const result = exportBlockPageToMarkdown(
      pageWith(
        listBlock('l', false, [
          { runs: [{ text: 'open' }], checked: false },
          { runs: [{ text: 'done' }], checked: true },
        ]),
      ),
    );
    expect(result.status).toBe('lossless');
    expect(result.markdown).toBe('- [ ] open\n- [x] done\n');
  });

  it('exports a toggle as a list item with indented children and warns', () => {
    const model = pageWith(toggleBlock('t', [{ text: 'summary' }]));
    model.blocks.t = { ...model.blocks.t!, children: ['p'] };
    model.blocks.p = paragraphBlock('p', [{ text: 'inside' }]);
    model.rootOrder = ['t'];
    const result = exportBlockPageToMarkdown(model);
    expect(result.markdown).toBe('- summary\n  inside\n');
    expect(result.status).toBe('lossy');
    expect(result.warnings.some((w) => w.includes('"t"') && w.includes('toggle'))).toBe(true);
  });

  it('exports a callout as a blockquote carrying its icon, and warns about tone', () => {
    const result = exportBlockPageToMarkdown(
      pageWith(calloutBlock('c', [{ text: 'careful' }], { icon: '⚠️', tone: 'danger' })),
    );
    expect(result.markdown).toBe('> ⚠️ careful\n');
    expect(result.status).toBe('lossy');
    expect(result.warnings.some((w) => w.includes('"c"') && w.includes('callout'))).toBe(true);
  });

  it('emits children of non-container blocks flat with a structural warning', () => {
    const model = pageWith({ ...headingBlock('h', 2, [{ text: 'Parent' }]), children: ['p'] });
    model.blocks.p = paragraphBlock('p', [{ text: 'child prose' }]);
    const result = exportBlockPageToMarkdown(model);
    expect(result.markdown).toContain('## Parent');
    expect(result.markdown).toContain('child prose');
    expect(result.warnings.some((w) => w.includes('"h"') && w.includes('flat'))).toBe(true);
    expect(result.status).toBe('lossy');
  });
});

describe('import of new mappings', () => {
  it('imports thematic breaks as divider blocks', () => {
    const result = importMarkdownToBlockPage('above\n\n---\n\nbelow');
    expect(result.status).toBe('lossless');
    const dividers = Object.values(result.model.blocks).filter((b) => b.type === T.divider);
    expect(dividers).toHaveLength(1);
  });

  it('imports blockquotes as quote blocks', () => {
    const result = importMarkdownToBlockPage('> wise words\n');
    expect(result.status).toBe('lossless');
    const quotes = Object.values(result.model.blocks).filter((b) => b.type === T.quote);
    expect(quotes).toHaveLength(1);
    expect(result.model.rootOrder).toEqual([quotes[0]!.id]);
  });

  it('imports GFM task items as checked list items', () => {
    const result = importMarkdownToBlockPage('- [ ] open\n- [x] done\n');
    expect(result.status).toBe('lossless');
    const lists = Object.values(result.model.blocks).filter((b) => b.type === T.list);
    expect(lists).toHaveLength(1);
    expect((lists[0] as unknown as { items: Array<{ checked?: boolean }> }).items).toEqual([
      { runs: [{ text: 'open' }], checked: false },
      { runs: [{ text: 'done' }], checked: true },
    ]);
  });

  it('re-imports an exported toggle as a toggle, and keeps nested lists as lists', () => {
    const toggleDoc = importMarkdownToBlockPage('- summary\n  inside text\n');
    const toggles = Object.values(toggleDoc.model.blocks).filter((b) => b.type === T.toggle);
    expect(toggles).toHaveLength(1);

    const listDoc = importMarkdownToBlockPage('- outer\n  - inner\n');
    const lists = Object.values(listDoc.model.blocks).filter((b) => b.type === T.list);
    expect(lists.length).toBeGreaterThanOrEqual(2);
    expect(Object.values(listDoc.model.blocks).some((b) => b.type === T.toggle)).toBe(false);
  });
});
