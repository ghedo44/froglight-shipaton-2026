/**
 *  pm-map round-trip + opaque/extMark preservation (V4).
 * pm-map stays the only canonical bridge; paste sanitization feeds it
 * through the normal pipeline (covered in paste.spec.ts).
 */
import { describe, expect, it } from 'vitest';
import {
  emptyBlockPage,
  paragraphBlock,
  type BlockPageModel,
} from '@froglight/foundation';
import { modelToPmDoc, pmDocToModel } from './pm-map.js';

function rich(): BlockPageModel {
  const model = emptyBlockPage({ title: 'Preserve', tags: [], properties: {} });
  model.rootOrder = ['p1', 'x1'];
  model.blocks = {
    p1: paragraphBlock('p1', [
      { text: 'plain ' },
      {
        text: 'mystery',
        marks: [
          { type: 'acme.highlight', color: 'yellow', extra: { deep: [1, 2] } },
        ],
      },
      { text: ' link', marks: [{ type: 'link', href: 'https://x.test' }] },
      {
        text: ' res',
        marks: [
          {
            type: 'resource',
            target: {
              documentId: 'd',
              kindId: 'froglight.markdown',
              resourceId: 'r',
            },
          },
        ],
      },
      { text: ' bare', marks: ['acme.sparkle'] },
    ]),
    x1: {
      id: 'x1',
      type: 'acme.kanban',
      lanes: [1, 2],
      vendor: { keep: true, nested: { a: 1 } },
      unknownField: 'preserve-me',
    },
  };
  model.blocks.x1 = { ...model.blocks.x1!, children: ['c1'] };
  model.blocks.c1 = paragraphBlock('c1', [{ text: 'inside opaque' }]);
  return model;
}

describe('pm-map preservation hardening', () => {
  it('round-trips opaque payloads with unknown fields byte-faithful', () => {
    const original = rich();
    const rebuilt = pmDocToModel(modelToPmDoc(original)).model;
    expect(rebuilt.blocks['x1']).toEqual(original.blocks['x1']);
    expect(rebuilt.blocks['c1']).toEqual(original.blocks['c1']);
  });

  it('retains opaque record key order across the editor bridge', () => {
    const original = emptyBlockPage();
    original.rootOrder = ['x1'];
    original.blocks = {
      x1: {
        type: 'acme.callout',
        tone: 'loud',
        id: 'x1',
        extras: [true, null],
      },
    };
    const rebuilt = pmDocToModel(modelToPmDoc(original)).model;
    expect(JSON.stringify(rebuilt.blocks['x1'])).toBe(
      JSON.stringify(original.blocks['x1']),
    );
  });

  it('applies image presentation edits and removals while preserving vendor fields', () => {
    const original = emptyBlockPage();
    original.rootOrder = ['i1'];
    original.blocks = {
      i1: {
        id: 'i1',
        type: 'froglight.image',
        src: 'attachments/hash',
        sha256: 'hash',
        alt: 'Alt',
        name: 'Reference',
        caption: 'Old caption',
        vendorTag: { keep: true },
      },
    };
    const edited = modelToPmDoc(original);
    edited.content![0]!.attrs!.caption = 'Updated caption';
    const updated = pmDocToModel(edited, original).model;
    expect(updated.blocks['i1']).toMatchObject({
      name: 'Reference',
      caption: 'Updated caption',
      vendorTag: { keep: true },
    });

    delete edited.content![0]!.attrs!.caption;
    const removed = pmDocToModel(edited, updated).model;
    expect(removed.blocks['i1']).not.toHaveProperty('caption');
    expect(removed.blocks['i1']).toMatchObject({
      name: 'Reference',
      vendorTag: { keep: true },
    });
  });

  it('carries unknown block and nested fields in ProseMirror state', () => {
    const original = emptyBlockPage();
    original.rootOrder = ['p1', 'l1', 't1'];
    original.blocks = {
      p1: {
        id: 'p1',
        type: 'froglight.paragraph',
        runs: [{ text: 'alpha', vendorRun: { keep: true } }],
        vendorTag: 'keep-block',
      },
      l1: {
        id: 'l1',
        type: 'froglight.list',
        ordered: false,
        items: [
          {
            runs: [{ text: 'item', vendorRun: 'keep-item-run' }],
            vendorItem: ['keep-item'],
          },
        ],
        vendorList: true,
      },
      t1: {
        id: 't1',
        type: 'froglight.table',
        columnCount: 1,
        rows: [
          {
            cells: [[{ text: 'cell', vendorRun: 'keep-cell-run' }]],
            vendorRow: { keep: 'row' },
          },
        ],
        vendorTable: 1,
      },
    };

    const doc = modelToPmDoc(original);
    const rebuilt = pmDocToModel(doc).model;
    expect(rebuilt.blocks).toEqual(original.blocks);
  });

  it('moves nested metadata with its run, list item, and table row owner', () => {
    const original = emptyBlockPage();
    original.rootOrder = ['p1', 'l1', 't1'];
    original.blocks = {
      p1: {
        id: 'p1',
        type: 'froglight.paragraph',
        runs: [
          { text: 'alpha', vendorRun: 'a' },
          { text: 'beta', vendorRun: 'b' },
        ],
      },
      l1: {
        id: 'l1',
        type: 'froglight.list',
        ordered: false,
        items: [
          { runs: [{ text: 'one' }], vendorItem: 'one' },
          { runs: [{ text: 'two' }], vendorItem: 'two' },
        ],
      },
      t1: {
        id: 't1',
        type: 'froglight.table',
        columnCount: 1,
        rows: [
          { cells: [[{ text: 'top' }]], vendorRow: 'top' },
          { cells: [[{ text: 'bottom' }]], vendorRow: 'bottom' },
        ],
      },
    };

    const doc = modelToPmDoc(original);
    for (const owner of doc.content ?? []) {
      if (owner.attrs?.blockId === 'p1') owner.content?.reverse();
      if (owner.attrs?.listId === 'l1') owner.content?.reverse();
      if (owner.attrs?.blockId === 't1') owner.content?.reverse();
    }
    const moved = pmDocToModel(doc).model;
    expect(moved.blocks.p1?.runs).toEqual([
      { text: 'beta', vendorRun: 'b' },
      { text: 'alpha', vendorRun: 'a' },
    ]);
    expect(moved.blocks.l1?.items).toEqual([
      { runs: [{ text: 'two' }], vendorItem: 'two' },
      { runs: [{ text: 'one' }], vendorItem: 'one' },
    ]);
    expect(moved.blocks.t1?.rows).toEqual([
      { cells: [[{ text: 'bottom' }]], vendorRow: 'bottom' },
      { cells: [[{ text: 'top' }]], vendorRow: 'top' },
    ]);
  });

  it('keeps unknown block fields across a type change and drops stale known fields', () => {
    const original = emptyBlockPage();
    original.rootOrder = ['p1'];
    original.blocks = {
      p1: {
        id: 'p1',
        type: 'froglight.heading',
        level: 3,
        runs: [{ text: 'alpha' }],
        vendorTag: { keep: true },
      },
    };
    const doc = modelToPmDoc(original);
    doc.content![0]!.type = 'paragraph';
    delete doc.content![0]!.attrs!.level;

    expect(pmDocToModel(doc).model.blocks.p1).toEqual({
      id: 'p1',
      type: 'froglight.paragraph',
      runs: [{ text: 'alpha' }],
      vendorTag: { keep: true },
    });
  });

  it('preserves fields unknown to the source type while target fields stay authoritative', () => {
    const original = emptyBlockPage();
    original.rootOrder = ['p1'];
    original.blocks = {
      p1: {
        id: 'p1',
        type: 'froglight.paragraph',
        runs: [{ text: 'alpha' }],
        caption: 'paragraph extension caption',
        source: 'paragraph extension source',
        level: 99,
      },
    };
    const doc = modelToPmDoc(original);
    expect(pmDocToModel(doc).model.blocks.p1).toEqual(original.blocks.p1);

    doc.content![0]!.type = 'heading';
    doc.content![0]!.attrs!.level = 2;
    expect(pmDocToModel(doc).model.blocks.p1).toEqual({
      id: 'p1',
      type: 'froglight.heading',
      level: 2,
      runs: [{ text: 'alpha' }],
      caption: 'paragraph extension caption',
      source: 'paragraph extension source',
    });
  });

  it('keeps editable ordered-list start authoritative alongside vendor fields', () => {
    const original = emptyBlockPage();
    original.rootOrder = ['l1'];
    original.blocks = {
      l1: {
        id: 'l1',
        type: 'froglight.list',
        ordered: true,
        start: 3,
        items: [{ runs: [{ text: 'Third' }] }],
        vendorTag: 'keep',
      },
    };
    const edited = modelToPmDoc(original);
    expect(edited.content![0]!.attrs!.start).toBe(3);
    edited.content![0]!.attrs!.start = 5;
    expect(pmDocToModel(edited, original).model.blocks['l1']).toMatchObject({
      start: 5,
      vendorTag: 'keep',
    });
  });

  it('preserves unknown extMarks (object + bare string) across round-trip', () => {
    const original = rich();
    const rebuilt = pmDocToModel(modelToPmDoc(original)).model;
    expect(rebuilt.blocks['p1']).toEqual(original.blocks['p1']);
  });

  it('preserves resource marks with stable targets', () => {
    const original = rich();
    const rebuilt = pmDocToModel(modelToPmDoc(original)).model;
    const runs = (
      rebuilt.blocks['p1'] as unknown as { runs: Array<{ marks?: unknown[] }> }
    ).runs;
    expect(
      runs.some((r) =>
        (r.marks ?? []).some(
          (m) =>
            typeof m === 'object' &&
            m !== null &&
            (m as { type?: string }).type === 'resource',
        ),
      ),
    ).toBe(true);
  });

  it('keeps nested remote-locator and known-mark extension fields with their owners', () => {
    const original = emptyBlockPage();
    original.rootOrder = ['p1', 'f1'];
    original.blocks = {
      p1: paragraphBlock('p1', [
        {
          text: 'link',
          marks: [
            {
              type: 'link',
              href: 'https://old.invalid',
              vendorLink: { keep: 1 },
            },
          ],
        },
        {
          text: ' resource',
          marks: [
            {
              type: 'resource',
              target: {
                documentId: 'doc',
                kindId: 'froglight.blockpage',
                resourceId: 'resource',
              },
              vendorMark: { keep: 2 },
            },
          ],
        },
      ]),
      f1: {
        id: 'f1',
        type: 'froglight.file',
        remote: {
          url: 'https://assets.invalid/old.pdf',
          vendorLocator: { keep: 3 },
        },
        sha256: 'abc',
        vendorBlock: { keep: 4 },
      },
    };

    const doc = modelToPmDoc(original);
    const paragraph = doc.content?.find((node) => node.attrs?.blockId === 'p1');
    const link = paragraph?.content?.[0]?.marks?.find(
      (mark) => mark.type === 'link',
    );
    const resource = paragraph?.content?.[1]?.marks?.find(
      (mark) => mark.type === 'resourceMark',
    );
    const file = doc.content?.find((node) => node.attrs?.blockId === 'f1');
    if (link?.attrs === undefined || resource?.attrs === undefined)
      throw new Error('missing known mark carriers');
    if (file?.attrs === undefined) throw new Error('missing file carrier');

    // Known members remain editable and authoritative while their adjacent
    // extension members stay attached to the same canonical owner.
    link.attrs.href = 'https://new.invalid';
    resource.attrs.target = {
      documentId: 'next',
      kindId: 'froglight.blockpage',
      resourceId: 'next-resource',
    };
    file.attrs.remoteUrl = 'https://assets.invalid/new.pdf';

    const rebuilt = pmDocToModel(doc).model;
    expect(rebuilt.blocks.p1?.runs).toEqual([
      {
        text: 'link',
        marks: [
          {
            type: 'link',
            href: 'https://new.invalid',
            vendorLink: { keep: 1 },
          },
        ],
      },
      {
        text: ' resource',
        marks: [
          {
            type: 'resource',
            target: {
              documentId: 'next',
              kindId: 'froglight.blockpage',
              resourceId: 'next-resource',
            },
            vendorMark: { keep: 2 },
          },
        ],
      },
    ]);
    expect(rebuilt.blocks.f1).toEqual({
      id: 'f1',
      type: 'froglight.file',
      remote: {
        url: 'https://assets.invalid/new.pdf',
        vendorLocator: { keep: 3 },
      },
      sha256: 'abc',
      vendorBlock: { keep: 4 },
    });
  });

  it('maps a plain empty run to editable blank content without invalid text nodes', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['p1'];
    model.blocks = { p1: paragraphBlock('p1', [{ text: '' }]) };
    const doc = modelToPmDoc(model);
    expect(doc.content![0]!.content ?? []).toEqual([]);
    const rebuilt = pmDocToModel(doc).model;
    expect(rebuilt.blocks[rebuilt.rootOrder[0]!]).toEqual(model.blocks['p1']);
  });

  it('keeps metadata and marks on empty runs with the owning run', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['p1'];
    model.blocks = {
      p1: JSON.parse(
        '{"id":"p1","type":"froglight.paragraph","runs":[{"text":"","marks":[{"type":"acme.empty","value":1}],"vendorRun":{"keep":true}},{"text":"visible","vendorRun":"visible"}]}',
      ) as BlockPageModel['blocks'][string],
    };
    const doc = modelToPmDoc(model);
    const content = doc.content?.[0]?.content;
    expect(content).toBeDefined();
    content?.reverse();
    expect(pmDocToModel(doc).model.blocks.p1?.runs).toEqual([
      { text: 'visible', vendorRun: 'visible' },
      {
        text: '',
        marks: [{ type: 'acme.empty', value: 1 }],
        vendorRun: { keep: true },
      },
    ]);
  });

  it('preserves arbitrary unknown member names as own properties', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['p1'];
    const block = JSON.parse(
      '{"id":"p1","type":"froglight.paragraph","runs":[{"text":"safe","__proto__":{"polluted":true}}],"__proto__":{"blockPolluted":true}}',
    ) as BlockPageModel['blocks'][string];
    model.blocks = { p1: block };

    const rebuilt = pmDocToModel(modelToPmDoc(model)).model.blocks.p1;
    expect(rebuilt).toBeDefined();
    if (rebuilt === undefined) throw new Error('missing rebuilt paragraph');
    const rebuiltRun = (
      rebuilt as unknown as { runs: Array<Record<string, unknown>> }
    ).runs[0];
    expect(rebuiltRun).toBeDefined();
    if (rebuiltRun === undefined) throw new Error('missing rebuilt run');
    expect(Object.prototype.hasOwnProperty.call(rebuilt, '__proto__')).toBe(
      true,
    );
    expect(Object.prototype.hasOwnProperty.call(rebuiltRun, '__proto__')).toBe(
      true,
    );
    expect(rebuilt['__proto__']).toEqual({ blockPolluted: true });
    expect(rebuiltRun['__proto__']).toEqual({ polluted: true });
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(({} as Record<string, unknown>)['blockPolluted']).toBeUndefined();
  });

  it('drops the ProseMirror trailing caret paragraph (chrome, never content)', () => {
    const original = rich();
    const doc = modelToPmDoc(original);
    const withCaret = structuredClone(doc);
    withCaret.content!.push({ type: 'paragraph' });
    const rebuilt = pmDocToModel(withCaret).model;
    expect(rebuilt.rootOrder).toEqual(pmDocToModel(doc).model.rootOrder);
  });

  it('round-trips canonical strikethrough through the Tiptap strike mark', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['p1'];
    model.blocks = {
      p1: paragraphBlock('p1', [{ text: 'struck', marks: ['strikethrough'] }]),
    };
    const doc = modelToPmDoc(model);
    // The Tiptap schema mark is named `strike`, never `strikethrough`.
    expect(doc.content![0]!.content![0]!.marks).toEqual([{ type: 'strike' }]);
    const rebuilt = pmDocToModel(doc).model;
    expect(rebuilt.blocks['p1']).toEqual(model.blocks['p1']);
  });

  it('decodes Tiptap strike marks to canonical strikethrough', () => {
    const rebuilt = pmDocToModel({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { blockId: 'p1' },
          content: [{ type: 'text', text: 'x', marks: [{ type: 'strike' }] }],
        },
      ],
    }).model;
    expect(
      (rebuilt.blocks['p1'] as unknown as { runs: unknown[] }).runs,
    ).toEqual([{ text: 'x', marks: ['strikethrough'] }]);
  });
});
