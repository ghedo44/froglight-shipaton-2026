/**
 * Markdown ↔ Block Page conversion fixtures
 * explicit-conversion rule: results report lossless/lossy/unsupported plus
 * warnings; unknown content degrades loudly, never silently.
 */

import { describe, expect, it } from 'vitest';
import { InMemoryBlockRegistry } from './registry.js';
import { importMarkdownToBlockPage, exportBlockPageToMarkdown } from './conversion.js';
import {
  BLOCK_PAGE_BLOCK_TYPES as T,
  emptyBlockPage,
  headingBlock,
  paragraphBlock,
} from './model.js';

describe('Markdown import', () => {
  it('maps headings, paragraphs, fences, tables, lists, and frontmatter', () => {
    const raw = [
      '---',
      'title: Imported',
      'tags:',
      '  - one',
      '---',
      '# Head',
      '',
      'Plain **bold** and *em* and `code` and [link](x.md#frag)',
      '',
      '- alpha',
      '- beta',
      '',
      '```ts',
      'const x = 1;',
      '```',
      '',
      '| h1 | h2 |',
      '| --- | :---: |',
      '| a | b |',
    ].join('\n');
    const result = importMarkdownToBlockPage(raw);
    expect(result.status).toBe('lossless');
    expect(result.warnings).toEqual([]);

    const model = result.model;
    expect(model.meta.title).toBe('Imported');
    expect(model.meta.tags).toEqual(['one']);

    const types = model.rootOrder.map((id) => model.blocks[id]?.type);
    expect(types).toEqual([
      T.heading,
      T.paragraph,
      T.list,
      T.code,
      T.table,
    ]);

    const paragraph = model.blocks[model.rootOrder[1]!]!;
    const runs = paragraph.runs as Array<{ text: string; marks?: string[] }>;
    expect(runs.map((run) => run.text)).toEqual(['Plain ', 'bold', ' and ', 'em', ' and ', 'code', ' and ', 'link']);
    expect(runs[1]?.marks).toContain('bold');

    const linkRun = runs[7]!;
    expect(linkRun.marks?.some((m) => typeof m === 'object' && (m as { href?: string }).href === 'x.md#frag')).toBe(true);
  });

  it('warns on unsupported constructs instead of dropping silently', () => {
    const raw = '<div>html</div>\n\nparagraph after';
    const result = importMarkdownToBlockPage(raw);
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
    expect(result.status).toBe('lossy');
    expect(JSON.stringify(result.model)).not.toContain('<div>');
    // The supported trailing paragraph still imported.
    expect(Object.values(result.model.blocks).some((block) => block.type === T.paragraph)).toBe(true);
  });

  it('imports images with an integrity warning (hash unknowable from source)', () => {
    const raw = '![alt text](assets/pic.png)';
    const result = importMarkdownToBlockPage(raw);
    const image = Object.values(result.model.blocks).find((b) => b.type === T.image);
    expect(image).toBeDefined();
    expect(image?.src).toBe('assets/pic.png');
    expect(result.warnings.some((w) => w.includes('integrity'))).toBe(true);
  });
});

describe('Markdown export', () => {
  it('exports the canonical subset with frontmatter meta', () => {
    const model = emptyBlockPage({ title: 'Doc', tags: ['t1'] });
    model.rootOrder = ['h', 'p'];
    model.blocks = {
      h: headingBlock('h', 2, [{ text: 'Section' }]),
      p: paragraphBlock('p', [
        { text: 'plain ' },
        { text: 'bold', marks: ['bold'] },
        { text: ' ' },
        { text: 'go', marks: [{ type: 'link', href: 'other.md' }] },
      ]),
    };
    const out = exportBlockPageToMarkdown(model);
    expect(out.status).toBe('lossless');
    expect(out.markdown).toContain('---\ntitle: Doc');
    expect(out.markdown).toContain('## Section');
    expect(out.markdown).toContain('plain **bold** [go](other.md)');
  });

  it('omits opaque blocks with explicit warnings and reports lossy', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['p', 'x'];
    model.blocks = {
      p: paragraphBlock('p', [{ text: 'kept' }]),
      x: { id: 'x', type: 'acme.callout', tone: 'loud' },
    };
    const out = exportBlockPageToMarkdown(model);
    expect(out.markdown).not.toContain('acme.callout');
    expect(out.warnings.some((w) => w.includes('x'))).toBe(true);
    expect(out.status).toBe('lossy');
  });

  it('registered plugin types export through their Markdown mapping', () => {
    const registry = new InMemoryBlockRegistry();
    registry.register({
      typeId: 'acme.callout',
      version: 1,
      toMarkdown: (record) => `> [!CALLOUP] ${String(record.tone ?? '')}`,
    });
    const model = emptyBlockPage();
    model.rootOrder = ['x'];
    model.blocks.x = { id: 'x', type: 'acme.callout', tone: 'loud' };

    const mapped = exportBlockPageToMarkdown(model, registry);
    expect(mapped.markdown).toContain('> [!CALLOUP] loud');
    expect(mapped.warnings).toEqual([]);

    // Without a mapping the same page exports nothing representable and
    // says so as 'unsupported' rather than pretending success.
    const unmapped = exportBlockPageToMarkdown(model);
    expect(unmapped.markdown).not.toContain('CALLOUP');
    expect(unmapped.warnings).toHaveLength(1);
    expect(unmapped.status).toBe('unsupported');
  });

  it('semantically round-trips import→export→import', () => {
    const raw = '# Title\n\nA **b** and [l](m.md)\n\n- i1\n- i2';
    const first = importMarkdownToBlockPage(raw);
    const exported = exportBlockPageToMarkdown(first.model);
    expect(exported.warnings).toEqual([]);
    const second = importMarkdownToBlockPage(exported.markdown);
    expect(second.warnings).toEqual([]);
    expect(second.model.rootOrder.map((id) => second.model.blocks[id]?.type)).toEqual(
      first.model.rootOrder.map((id) => first.model.blocks[id]?.type),
    );
  });
});
