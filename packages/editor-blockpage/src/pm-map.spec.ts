/**
 * Engine-free conformance for the canonical ↔ ProseMirror-JSON mapping
 * used by the Tiptap adapter. ProseMirror JSON is plain data,
 * so these fixtures run without DOM or an editor instance.
 */

import { describe, expect, it } from 'vitest';
import {
  calloutBlock,
  dividerBlock,
  emptyBlockPage,
  headingBlock,
  imageBlock,
  listBlock,
  paragraphBlock,
  quoteBlock,
  resourceEmbedBlock,
  tableBlock,
  toggleBlock,
  type BlockPageModel,
} from '@froglight/foundation';
import { modelToPmDoc, pmDocToModel } from './pm-map.js';

function fixture(): BlockPageModel {
  const model = emptyBlockPage({
    title: 'Map fixture',
    tags: [],
    properties: {},
  });
  model.rootOrder = [
    'p1',
    'h1',
    'l1',
    't1',
    'c1',
    'q1',
    'd1',
    'i1',
    'tb1',
    'x1',
    'g1',
  ];
  model.blocks = {
    p1: paragraphBlock('p1', [
      { text: 'plain ' },
      { text: 'bold', marks: ['bold'] },
      { text: ' link', marks: [{ type: 'link', href: 'https://x.test' }] },
      { text: ' weird', marks: ['acme.sparkle'] },
      { text: ' resource', marks: [{ type: 'resource', target: { documentId: 'd', kindId: 'froglight.markdown', resourceId: 'r' } }] },
    ]),
    h1: headingBlock('h1', 2, [{ text: 'Head' }]),
    l1: listBlock('l1', false, [
      { runs: [{ text: 'todo' }], checked: true },
      { runs: [{ text: 'branch' }], children: ['l2'] },
    ]),
    l2: listBlock('l2', false, [{ runs: [{ text: 'leaf' }] }]),
    t1: toggleBlock('t1', [{ text: 'more' }]),
    c1: calloutBlock('c1', [{ text: 'careful' }], {
      icon: '⚠️',
      tone: 'danger',
    }),
    q1: quoteBlock('q1', [{ text: 'wise' }]),
    d1: dividerBlock('d1'),
    i1: imageBlock('i1', 'assets/f.png', 'deadbeef', 'A figure'),
    tb1: tableBlock('tb1', 2, [{ cells: [[{ text: 'a' }], [{ text: 'b' }]] }]),
    x1: { id: 'x1', type: 'acme.kanban', lanes: [1, 2] },
    g1: paragraphBlock('g1', [{ text: 'grouped under h1' }]),
    e1: resourceEmbedBlock('e1', { documentId: 'd', kindId: 'froglight.markdown', resourceId: 'r' }, { label: 'Preview' }),
  };
  // Structural edges.
  model.blocks.h1 = { ...model.blocks.h1!, children: ['g1'] };
  model.blocks.t1 = { ...model.blocks.t1!, children: ['p2'] };
  model.blocks.p2 = paragraphBlock('p2', [{ text: 'hidden body' }]);
  model.rootOrder.push('p2');
  model.rootOrder.push('e1');
  model.blocks.x1 = { ...model.blocks.x1!, children: ['p3'] };
  model.blocks.p3 = paragraphBlock('p3', [{ text: 'inside plugin block' }]);
  model.rootOrder.push('p3');
  return model;
}

describe('pm-map — model to ProseMirror JSON', () => {
  it('produces a doc whose top-level content mirrors root order', () => {
    const doc = modelToPmDoc(fixture());
    expect(doc.type).toBe('doc');
    expect(
      doc.content!.map((n) =>
        n.type === 'blockGroup'
          ? `group:${String(n.attrs?.owner)}`
          : (n.attrs?.blockId ?? n.attrs?.listId),
      ),
    ).toEqual([
      'p1',
      'h1',
      'group:h1',
      'l1',
      't1',
      'c1',
      'q1',
      'd1',
      'i1',
      'tb1',
      'x1',
      'e1',
    ]);
  });

  it('maps runs, marks, links, and unknown marks to inline JSON', () => {
    const doc = modelToPmDoc(fixture());
    const p1 = doc.content![0]!;
    const texts = p1.content!.map((n) => ({
      text: n.text,
      marks: n.marks ?? [],
    }));
    expect(texts[1]).toEqual({ text: 'bold', marks: [{ type: 'bold' }] });
    expect(texts[2]).toEqual({
      text: ' link',
      marks: [{ type: 'link', attrs: { href: 'https://x.test' } }],
    });
    expect(texts[3]?.marks[0]).toEqual({
      type: 'extMark',
      attrs: { name: 'acme.sparkle', json: 'acme.sparkle' },
    });
    expect(texts[4]?.marks[0]).toEqual({ type: 'resourceMark', attrs: { target: { documentId: 'd', kindId: 'froglight.markdown', resourceId: 'r' } } });
  });
});

describe('pm-map — ProseMirror JSON to model', () => {
  it('round-trips a rich document back to the canonical shape', () => {
    const original = fixture();
    const rebuilt = pmDocToModel(modelToPmDoc(original));
    expect(
      rebuilt.model.rootOrder.filter((id) => !['g1', 'p2', 'p3'].includes(id)),
    ).toEqual(
      original.rootOrder.filter((id) => !['g1', 'p2', 'p3'].includes(id)),
    );
    expect(rebuilt.model.blocks.p1).toEqual(original.blocks.p1);
    expect(rebuilt.model.blocks.l1).toEqual(original.blocks.l1);
    expect(rebuilt.model.blocks.t1).toEqual(original.blocks.t1);
    expect(rebuilt.model.blocks.c1).toEqual(original.blocks.c1);
    expect(rebuilt.model.blocks.x1).toEqual(original.blocks.x1);
    // Universal children survive: heading owns its grouped paragraph.
    expect(rebuilt.model.blocks.h1).toEqual(original.blocks.h1);
    expect(rebuilt.model.blocks.e1).toEqual(original.blocks.e1);
  });

  it('preserves keyed paragraph children of list items across saving', () => {
    const original = fixture();
    original.blocks.l1 = listBlock('l1', false, [
      { runs: [{ text: 'summary' }], children: ['child'] },
    ]);
    original.blocks.child = paragraphBlock('child', [{ text: 'nested body' }]);
    const { model } = pmDocToModel(modelToPmDoc(original));
    expect(model.blocks.l1).toEqual(original.blocks.l1);
    expect(model.blocks.child).toEqual(original.blocks.child);
  });

  it('assigns fresh stable ids to nodes lacking blockId attrs', () => {
    const doc = modelToPmDoc(fixture());
    const bare = structuredClone(doc);
    delete (bare.content![0]!.attrs as { blockId?: string }).blockId;
    const { model } = pmDocToModel(bare);
    const first = model.rootOrder[0]!;
    expect(first).not.toBe('p1');
    expect((model.blocks[first] as { type: string }).type).toBe(
      'froglight.paragraph',
    );
  });
});
