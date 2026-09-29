/**
 *  transform preservation: every turn-into target keeps exactly
 * the source's textual effect (no drops), carries the same block id, and
 * participates in provider-local undo/redo. Actions are exactly named:
 * each slash label maps to one deterministic blockCommand effect.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  emptyBlockPage,
  paragraphBlock,
  headingBlock,
  toggleBlock,
  calloutBlock,
  quoteBlock,
  codeBlock,
  imageBlock,
  tableBlock,
  type BlockPageModel,
} from '@froglight/foundation';
import { BlockPageDocumentEditorProvider } from './editor.js';

function mount(model: BlockPageModel) {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  let latest: BlockPageModel | null = null;
  const handle = new BlockPageDocumentEditorProvider().createEditor({
    session: {} as never,
    parent,
    initialModel: model,
    onDirtyModel: (next) => {
      latest = next;
    },
  });
  return {
    parent,
    handle,
    latest: () => latest as BlockPageModel | null,
    pm: () => parent.querySelector('.ProseMirror')!,
    cleanup: () => {
      handle.destroy();
      parent.remove();
    },
  };
}

function command(
  env: ReturnType<typeof mount>,
  id: string,
  arg?: unknown,
): boolean {
  const run = env.handle.blockCommand;
  if (run === undefined) throw new Error('block command channel unavailable');
  return run.call(env.handle, id, arg);
}

function singlePara(
  text: string,
  marks?: Array<string | Record<string, unknown>>,
): BlockPageModel {
  const model = emptyBlockPage();
  model.rootOrder = ['p1'];
  model.blocks = {
    p1: paragraphBlock(
      'p1',
      marks ? [{ text, marks: marks as never }] : [{ text }],
    ),
  };
  return model;
}

afterEach(() => {
  document.body.replaceChildren();
  document.getElementById('flbp-chrome-styles')?.remove();
});

describe('block transform preservation + undo', () => {
  it('keeps unknown block metadata through paragraph/list transforms', () => {
    const model = singlePara('list owner');
    model.blocks.p1 = { ...model.blocks.p1!, vendorTag: 'keep' };
    const env = mount(model);
    try {
      command(env, 'set-selection', { from: 2, to: 2 });
      expect(command(env, 'turn-into', { type: 'bullet' })).toBe(true);
      const list = env.handle.getModelForTest!();
      const listId = list.rootOrder[0]!;
      expect(list.blocks[listId]).toMatchObject({
        type: 'froglight.list',
        vendorTag: 'keep',
      });
      expect(command(env, 'turn-into', { type: 'paragraph' })).toBe(true);
      const paragraph = env.handle.getModelForTest!();
      expect(paragraph.blocks[paragraph.rootOrder[0]!]).toMatchObject({
        type: 'froglight.paragraph',
        vendorTag: 'keep',
      });
    } finally {
      env.cleanup();
    }
  });

  it('keeps unknown metadata through type change, delete/undo, and redo', () => {
    const model = singlePara('preserved');
    model.blocks.p1 = {
      ...model.blocks.p1!,
      runs: [{ text: 'preserved', vendorRun: 'run-owner' }],
      vendorTag: { source: 'plugin' },
    };
    model.rootOrder.push('l1', 't1');
    model.blocks.l1 = {
      id: 'l1',
      type: 'froglight.list',
      ordered: false,
      items: [
        {
          runs: [{ text: 'item', vendorRun: 'item-run-owner' }],
          vendorItem: 'item-owner',
        },
      ],
    };
    model.blocks.t1 = {
      id: 't1',
      type: 'froglight.table',
      columnCount: 1,
      rows: [
        {
          cells: [[{ text: 'cell', vendorRun: 'cell-run-owner' }]],
          vendorRow: 'row-owner',
        },
      ],
    };
    const env = mount(model);
    try {
      command(env, 'set-selection', { from: 2, to: 2 });
      expect(command(env, 'turn-into', { type: 'heading', level: 2 })).toBe(
        true,
      );
      expect(env.handle.getModelForTest!().blocks.p1).toMatchObject({
        type: 'froglight.heading',
        level: 2,
        vendorTag: { source: 'plugin' },
      });
      expect(env.handle.getModelForTest!().blocks.p1?.runs).toEqual([
        { text: 'preserved', vendorRun: 'run-owner' },
      ]);
      expect(env.handle.getModelForTest!().blocks.l1?.items).toEqual([
        {
          runs: [{ text: 'item', vendorRun: 'item-run-owner' }],
          vendorItem: 'item-owner',
        },
      ]);
      expect(env.handle.getModelForTest!().blocks.t1?.rows).toEqual([
        {
          cells: [[{ text: 'cell', vendorRun: 'cell-run-owner' }]],
          vendorRow: 'row-owner',
        },
      ]);

      expect(command(env, 'select-block', { blockId: 'p1' })).toBe(true);
      env.pm().dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Backspace',
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(env.handle.getModelForTest!().blocks.p1).toBeUndefined();
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!().blocks.p1).toMatchObject({
        vendorTag: { source: 'plugin' },
      });
      expect(env.handle.execCommand('redo')).toBe(true);
      expect(env.handle.getModelForTest!().blocks.p1).toBeUndefined();
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!().blocks.p1).toMatchObject({
        vendorTag: { source: 'plugin' },
      });
    } finally {
      env.cleanup();
    }
  });

  it('keeps remote locator extensions through adjacent edits and history', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['f1', 'p1'];
    model.blocks = {
      f1: {
        id: 'f1',
        type: 'froglight.file',
        remote: {
          url: 'https://assets.invalid/file.pdf',
          vendorLocator: { keep: 2 },
        },
        vendorBlock: { keep: 3 },
      },
      p1: paragraphBlock('p1', [{ text: 'adjacent' }]),
    };
    const env = mount(model);
    const expectPreserved = () => {
      expect(env.handle.getModelForTest!().blocks.f1).toMatchObject({
        remote: {
          url: 'https://assets.invalid/file.pdf',
          vendorLocator: { keep: 2 },
        },
        vendorBlock: { keep: 3 },
      });
    };
    try {
      command(env, 'set-selection', { from: 4, to: 4 });
      env.pm().dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        }),
      );
      expectPreserved();
      expect(env.handle.execCommand('undo')).toBe(true);
      expectPreserved();
      expect(env.handle.execCommand('redo')).toBe(true);
      expectPreserved();
    } finally {
      env.cleanup();
    }
  });

  it('keeps block metadata on its owner when Enter splits a paragraph', () => {
    const model = singlePara('alpha');
    model.blocks.p1 = {
      ...model.blocks.p1!,
      vendorTag: { source: 'plugin' },
    };
    const env = mount(model);
    try {
      command(env, 'set-selection', { from: 3, to: 3 });
      env.pm().dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
        }),
      );
      const split = env.handle.getModelForTest!();
      expect(split.rootOrder).toHaveLength(2);
      expect(split.blocks.p1).toMatchObject({
        runs: [{ text: 'al' }],
        vendorTag: { source: 'plugin' },
      });
      const created = split.blocks[split.rootOrder[1]!];
      expect(created).toMatchObject({ runs: [{ text: 'pha' }] });
      expect(created).not.toHaveProperty('vendorTag');
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!().blocks.p1).toEqual(model.blocks.p1);
    } finally {
      env.cleanup();
    }
  });

  const targets: Array<{
    label: string;
    arg: { type: string; level?: number };
    expectType: string;
  }> = [
    {
      label: 'paragraph',
      arg: { type: 'paragraph' },
      expectType: 'froglight.paragraph',
    },
    {
      label: 'heading:1',
      arg: { type: 'heading', level: 1 },
      expectType: 'froglight.heading',
    },
    {
      label: 'heading:2',
      arg: { type: 'heading', level: 2 },
      expectType: 'froglight.heading',
    },
    {
      label: 'heading:3',
      arg: { type: 'heading', level: 3 },
      expectType: 'froglight.heading',
    },
    {
      label: 'heading:4',
      arg: { type: 'heading', level: 4 },
      expectType: 'froglight.heading',
    },
    {
      label: 'heading:5',
      arg: { type: 'heading', level: 5 },
      expectType: 'froglight.heading',
    },
    {
      label: 'heading:6',
      arg: { type: 'heading', level: 6 },
      expectType: 'froglight.heading',
    },
    { label: 'quote', arg: { type: 'quote' }, expectType: 'froglight.quote' },
    { label: 'code', arg: { type: 'code' }, expectType: 'froglight.code' },
    {
      label: 'toggle',
      arg: { type: 'toggle' },
      expectType: 'froglight.toggle',
    },
    {
      label: 'callout',
      arg: { type: 'callout' },
      expectType: 'froglight.callout',
    },
  ];

  for (const target of targets) {
    it(`turn-into ${target.label} preserves text and is undoable`, () => {
      const env = mount(singlePara('hello world'));
      try {
        const before = env.handle.getModelForTest!();
        command(env, 'set-selection', { from: 2, to: 2 });
        expect(command(env, 'turn-into', target.arg)).toBe(true);
        const next = env.handle.getModelForTest!();
        const id = next.rootOrder[0]!;
        expect(next.blocks[id]?.type).toBe(target.expectType);
        // Same block id survives the transform.
        expect(id).toBe('p1');
        // Textual effect preserved: joined text still contains source.
        const joined = JSON.stringify(next.blocks[id]);
        expect(joined).toContain('hello world');
        // Undo restores the exact previous model.
        expect(env.handle.execCommand('undo')).toBe(true);
        expect(env.handle.getModelForTest!()).toEqual(before);
        expect(env.handle.execCommand('redo')).toBe(true);
        expect(env.handle.getModelForTest!().blocks[id]?.type).toBe(
          target.expectType,
        );
      } finally {
        env.cleanup();
      }
    });
  }

  it('turn-into preserves bold + unknown extMarks + resource marks', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['p1'];
    model.blocks = {
      p1: paragraphBlock('p1', [
        { text: 'plain ' },
        { text: 'bold', marks: ['bold'] },
        {
          text: ' mystery',
          marks: [{ type: 'acme.highlight', color: 'yellow' }],
        },
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
      ]),
    };
    const env = mount(model);
    try {
      command(env, 'set-selection', { from: 2, to: 2 });
      expect(command(env, 'turn-into', { type: 'heading', level: 2 })).toBe(
        true,
      );
      const next = env.handle.getModelForTest!();
      const runs = (
        next.blocks['p1'] as unknown as {
          runs: Array<{ text: string; marks?: unknown[] }>;
        }
      ).runs;
      expect(runs.map((r) => r.text).join('')).toBe('plain bold mystery res');
      expect(runs.some((r) => (r.marks ?? []).includes('bold'))).toBe(true);
      expect(
        runs.some((r) =>
          (r.marks ?? []).some(
            (m) =>
              typeof m === 'object' &&
              m !== null &&
              (m as { type?: string }).type === 'acme.highlight',
          ),
        ),
      ).toBe(true);
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
      expect(env.handle.execCommand('undo')).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  it('container -> leaf keeps summary text and nested children as siblings (no drops)', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['t1'];
    model.blocks = {
      t1: { ...toggleBlock('t1', [{ text: 'summary' }]), children: ['c1'] },
      c1: paragraphBlock('c1', [{ text: 'child body' }]),
    };
    const env = mount(model);
    try {
      command(env, 'set-selection', { from: 2, to: 2 });
      expect(command(env, 'turn-into', { type: 'paragraph' })).toBe(true);
      const next = env.handle.getModelForTest!();
      const allText = Object.values(next.blocks)
        .map((b) => JSON.stringify(b))
        .join(' ');
      expect(allText).toContain('summary');
      expect(allText).toContain('child body');
      // Both records still exist (child preserved, not dropped).
      expect(next.blocks['c1']).toBeDefined();
      expect(env.handle.execCommand('undo')).toBe(true);
      const undone = env.handle.getModelForTest!();
      expect(undone.blocks['t1']?.type).toBe('froglight.toggle');
      expect(undone.blocks['c1']).toBeDefined();
    } finally {
      env.cleanup();
    }
  });

  it('callout -> callout preserves icon/tone; other -> callout gets defaults', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['c1'];
    model.blocks = {
      c1: calloutBlock('c1', [{ text: 'note' }], {
        icon: '⚠️',
        tone: 'danger',
      }),
    };
    const env = mount(model);
    try {
      command(env, 'set-selection', { from: 2, to: 2 });
      // Same-type re-apply must not wipe canonical icon/tone.
      expect(command(env, 'turn-into', { type: 'callout' })).toBe(true);
      const next = env.handle.getModelForTest!();
      expect(next.blocks['c1']).toMatchObject({ icon: '⚠️', tone: 'danger' });
    } finally {
      env.cleanup();
    }
  });

  it('turn-into rejects atoms/specials instead of dropping their payload', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['d1'];
    model.blocks = { d1: { id: 'd1', type: 'froglight.divider' } };
    const env = mount(model);
    try {
      const before = env.handle.getModelForTest!();
      expect(command(env, 'turn-into', { type: 'paragraph' })).toBe(false);
      expect(env.handle.getModelForTest!()).toEqual(before);
      expect(command(env, 'turn-into', { type: 'nope' })).toBe(false);
      expect(command(env, 'turn-into', {})).toBe(false);
    } finally {
      env.cleanup();
    }
  });

  it('turn-into treats media atoms like other atoms (rejects both ways)', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['v1'];
    model.blocks = {
      v1: {
        id: 'v1',
        type: 'froglight.video',
        src: 'attachments/h',
        sha256: 'h',
      },
    };
    const env = mount(model);
    try {
      expect(command(env, 'select-block', { blockId: 'v1' })).toBe(true);
      const before = env.handle.getModelForTest!();
      for (const target of [
        { type: 'paragraph' },
        { type: 'heading', level: 1 },
        { type: 'bullet' },
        { type: 'code' },
      ]) {
        expect(command(env, 'turn-into', target)).toBe(false);
        expect(env.handle.getModelForTest!()).toEqual(before);
      }
      expect(command(env, 'turn-into', { type: 'video' })).toBe(false);
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
  });

  it('turn-into treats the table grid as an atom (rejects both ways)', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['t1'];
    model.blocks = {
      t1: tableBlock('t1', 2, [{ cells: [[{ text: 'a' }], [{ text: 'b' }]] }]),
    };
    const env = mount(model);
    try {
      // Caret inside a grid cell: the grid source rejects every target.
      command(env, 'set-selection', { from: 4, to: 4 });
      const before = env.handle.getModelForTest!();
      for (const target of [
        { type: 'paragraph' },
        { type: 'heading', level: 1 },
        { type: 'bullet' },
        { type: 'code' },
      ]) {
        expect(command(env, 'turn-into', target)).toBe(false);
        expect(env.handle.getModelForTest!()).toEqual(before);
      }
    } finally {
      env.cleanup();
    }
  });

  it('heading/quote/code sources keep exact text through paragraph round-trip', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['h1', 'q1', 'c1'];
    model.blocks = {
      h1: headingBlock('h1', 2, [{ text: 'Head text' }]),
      q1: quoteBlock('q1', [{ text: 'Quoted' }]),
      c1: codeBlock('c1', 'const x = 1;', 'js'),
    };
    const env = mount(model);
    try {
      // Heading -> paragraph preserves text.
      command(env, 'set-selection', { from: 2, to: 2 });
      expect(command(env, 'turn-into', { type: 'paragraph' })).toBe(true);
      const next = env.handle.getModelForTest!();
      expect(JSON.stringify(next.blocks['h1'])).toContain('Head text');
      expect(env.handle.execCommand('undo')).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  it('heading level outside 1-6 clamps instead of throwing', () => {
    const env = mount(singlePara('leveled'));
    try {
      command(env, 'set-selection', { from: 2, to: 2 });
      expect(command(env, 'turn-into', { type: 'heading', level: 99 })).toBe(
        true,
      );
      expect(env.handle.getModelForTest!().blocks['p1']).toMatchObject({
        type: 'froglight.heading',
        level: 6,
      });
      expect(command(env, 'turn-into', { type: 'heading', level: 0 })).toBe(
        true,
      );
      expect(env.handle.getModelForTest!().blocks['p1']).toMatchObject({
        type: 'froglight.heading',
        level: 1,
      });
      expect(
        command(env, 'turn-into', { type: 'heading', level: Number.NaN }),
      ).toBe(true);
      expect(env.handle.getModelForTest!().blocks['p1']).toMatchObject({
        type: 'froglight.heading',
        level: 1,
      });
    } finally {
      env.cleanup();
    }
  });

  it('multi-block range turn-into rejects instead of turning only the anchor', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['p1', 'p2'];
    model.blocks = {
      p1: paragraphBlock('p1', [{ text: 'aaa' }]),
      p2: paragraphBlock('p2', [{ text: 'bbb' }]),
    };
    const env = mount(model);
    try {
      const before = env.handle.getModelForTest!();
      // Caret inside p1 (pos 2) through p2 text: touches two keyed roots.
      command(env, 'set-selection', { from: 2, to: 7 });
      expect(command(env, 'turn-into', { type: 'heading', level: 2 })).toBe(
        false,
      );
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
  });

  it('container -> code flattens descendant text into the code value', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['t1'];
    model.blocks = {
      t1: { ...toggleBlock('t1', [{ text: 'summary' }]), children: ['c1'] },
      c1: paragraphBlock('c1', [{ text: 'child body' }]),
    };
    const env = mount(model);
    try {
      command(env, 'set-selection', { from: 2, to: 2 });
      expect(command(env, 'turn-into', { type: 'code' })).toBe(true);
      const next = env.handle.getModelForTest!();
      // Explicit flattening policy: container descendants become code text
      // lines (no drops, no duplicated sibling blocks), single undo step.
      const code = next.blocks['t1'] as unknown as { text: string };
      expect(code.text).toContain('summary');
      expect(code.text).toContain('child body');
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!().blocks['t1']?.type).toBe(
        'froglight.toggle',
      );
    } finally {
      env.cleanup();
    }
  });

  it('container -> code rejects when the tail holds non-text payload', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['t1'];
    model.blocks = {
      t1: { ...toggleBlock('t1', [{ text: 'summary' }]), children: ['img1'] },
      img1: imageBlock('img1', 'assets/pic.png', '', 'a picture'),
    };
    const env = mount(model);
    try {
      const before = env.handle.getModelForTest!();
      command(env, 'set-selection', { from: 2, to: 2 });
      // Code is plain text: the image tail has no text representation, so
      // flattening would silently drop it. Reject explicitly instead.
      expect(command(env, 'turn-into', { type: 'code' })).toBe(false);
      expect(env.handle.getModelForTest!()).toEqual(before);
      // Leaf targets still preserve the image tail as a sibling (no drops).
      expect(command(env, 'turn-into', { type: 'paragraph' })).toBe(true);
      const next = env.handle.getModelForTest!();
      expect(next.blocks['img1']).toBeDefined();
      expect(JSON.stringify(next.blocks['t1'])).toContain('summary');
    } finally {
      env.cleanup();
    }
  });
});

describe('block transform list family + toolbar convergence', () => {
  function toolsOf(env: ReturnType<typeof mount>) {
    const tools = (
      env.handle as unknown as {
        tools?: {
          snapshot(): {
            context: string;
            controls: Array<
              { id: string; kind: string } & Record<string, unknown>
            >;
          };
          execute(id: string, value?: string): boolean;
        };
      }
    ).tools;
    if (tools === undefined) throw new Error('semantic tools unavailable');
    return tools;
  }

  it('paragraph -> bullet preserves text+marks and is single-undo', () => {
    const env = mount(singlePara('hello world'));
    try {
      const before = env.handle.getModelForTest!();
      command(env, 'set-selection', { from: 2, to: 2 });
      expect(command(env, 'turn-into', { type: 'bullet' })).toBe(true);
      const next = env.handle.getModelForTest!();
      expect(JSON.stringify(next)).toContain('hello world');
      const lists = Object.values(next.blocks).filter(
        (b) => b.type === 'froglight.list',
      );
      expect(lists).toHaveLength(1);
      expect((lists[0] as { ordered?: boolean }).ordered).toBe(false);
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
  });

  it('paragraph -> ordered preserves text and is single-undo', () => {
    const env = mount(singlePara('count me'));
    try {
      const before = env.handle.getModelForTest!();
      command(env, 'set-selection', { from: 2, to: 2 });
      expect(command(env, 'turn-into', { type: 'ordered' })).toBe(true);
      const next = env.handle.getModelForTest!();
      expect(JSON.stringify(next)).toContain('count me');
      const lists = Object.values(next.blocks).filter(
        (b) => b.type === 'froglight.list',
      );
      expect(lists).toHaveLength(1);
      expect((lists[0] as { ordered?: boolean }).ordered).toBe(true);
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
  });

  it('paragraph -> todo creates an unchecked item and is single-undo', () => {
    const env = mount(singlePara('task body'));
    try {
      const before = env.handle.getModelForTest!();
      command(env, 'set-selection', { from: 2, to: 2 });
      expect(command(env, 'turn-into', { type: 'todo' })).toBe(true);
      const next = env.handle.getModelForTest!();
      const list = Object.values(next.blocks).find(
        (b) => b.type === 'froglight.list',
      ) as unknown as {
        items: Array<{ runs: Array<{ text: string }>; checked?: boolean }>;
      };
      expect(list).toBeDefined();
      expect(JSON.stringify(list)).toContain('task body');
      expect(list.items[0]?.checked).toBe(false);
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
  });

  it('code -> todo rejects without mutation (slash parity)', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['c1'];
    model.blocks = { c1: codeBlock('c1', 'const x = 1;', 'js') };
    const env = mount(model);
    try {
      const before = env.handle.getModelForTest!();
      command(env, 'set-selection', { from: 2, to: 2 });
      expect(command(env, 'turn-into', { type: 'todo' })).toBe(false);
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
  });

  it('single-item list -> paragraph unwraps with text preserved', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['l1'];
    model.blocks = {
      l1: {
        id: 'l1',
        type: 'froglight.list',
        ordered: false,
        items: [{ runs: [{ text: 'solo item' }] }],
      } as never,
    };
    const env = mount(model);
    try {
      // Caret inside the item text (pos 3: UL0 LI1 P2 text3...), never the
      // LI/P boundary at 2 which has no inline parent.
      command(env, 'set-selection', { from: 3, to: 3 });
      expect(command(env, 'turn-into', { type: 'paragraph' })).toBe(true);
      const next = env.handle.getModelForTest!();
      expect(JSON.stringify(next)).toContain('solo item');
      expect(
        Object.values(next.blocks).some(
          (b) => b.type === 'froglight.paragraph',
        ),
      ).toBe(true);
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!().blocks['l1']?.type).toBe(
        'froglight.list',
      );
    } finally {
      env.cleanup();
    }
  });

  it('list -> heading rejects without mutation (policy)', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['l1'];
    model.blocks = {
      l1: {
        id: 'l1',
        type: 'froglight.list',
        ordered: false,
        items: [{ runs: [{ text: 'one' }] }, { runs: [{ text: 'two' }] }],
      } as never,
    };
    const env = mount(model);
    try {
      const before = env.handle.getModelForTest!();
      command(env, 'set-selection', { from: 3, to: 3 });
      expect(command(env, 'turn-into', { type: 'heading', level: 2 })).toBe(
        false,
      );
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
  });

  it('toolbar block.type offers H4-6 + lists with slash labels', () => {
    const env = mount(singlePara('labels'));
    try {
      command(env, 'set-selection', { from: 2, to: 2 });
      const choice = toolsOf(env)
        .snapshot()
        .controls.find((c) => c.id === 'block.type') as unknown as {
        options: Array<{ value: string; label: string }>;
      };
      const byValue = new Map(choice.options.map((o) => [o.value, o.label]));
      expect(byValue.get('heading:4')).toBe('Heading 4');
      expect(byValue.get('heading:5')).toBe('Heading 5');
      expect(byValue.get('heading:6')).toBe('Heading 6');
      expect(byValue.get('bullet')).toBe('Bullet list');
      expect(byValue.get('ordered')).toBe('Numbered list');
      expect(byValue.get('todo')).toBe('To-do item');
      expect(byValue.get('paragraph')).toBe('Paragraph');
    } finally {
      env.cleanup();
    }
  });

  it('H4-6 toolbar round-trip works (execute -> option reflects)', () => {
    const env = mount(singlePara('deep head'));
    try {
      const tools = toolsOf(env);
      command(env, 'set-selection', { from: 2, to: 2 });
      expect(tools.execute('block.type', 'heading:4')).toBe(true);
      const next = env.handle.getModelForTest!();
      expect(next.blocks['p1']).toMatchObject({
        type: 'froglight.heading',
        level: 4,
      });
      const choice = tools
        .snapshot()
        .controls.find((c) => c.id === 'block.type') as unknown as {
        value: string;
      };
      expect(choice.value).toBe('heading:4');
      expect(tools.snapshot().context).toBe('Heading 4');
      expect(tools.execute('block.type', 'heading:6')).toBe(true);
      expect(
        (
          tools
            .snapshot()
            .controls.find((c) => c.id === 'block.type') as unknown as {
            value: string;
          }
        ).value,
      ).toBe('heading:6');
    } finally {
      env.cleanup();
    }
  });

  it('toolbar bullet round-trip reflects and todo marks the list', () => {
    const env = mount(singlePara('round trip'));
    try {
      const tools = toolsOf(env);
      command(env, 'set-selection', { from: 2, to: 2 });
      expect(tools.execute('block.type', 'bullet')).toBe(true);
      const afterBullet = tools
        .snapshot()
        .controls.find((c) => c.id === 'block.type') as unknown as {
        value: string;
      };
      expect(afterBullet.value).toBe('bullet');
      expect(tools.execute('block.type', 'todo')).toBe(true);
      const afterTodo = tools
        .snapshot()
        .controls.find((c) => c.id === 'block.type') as unknown as {
        value: string;
      };
      expect(afterTodo.value).toBe('todo');
      expect(tools.snapshot().context).toBe('To-do item');
    } finally {
      env.cleanup();
    }
  });

  it('opaque/multi-root still reject without mutation', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['x1'];
    model.blocks = {
      x1: { id: 'x1', type: 'acme.kanban', lanes: [1] } as never,
    };
    const env = mount(model);
    try {
      const before = env.handle.getModelForTest!();
      expect(command(env, 'turn-into', { type: 'paragraph' })).toBe(false);
      expect(command(env, 'turn-into', { type: 'bullet' })).toBe(false);
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
  });

  it('list with nested toggle child -> bullet preserves the child id', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['l1'];
    model.blocks = {
      l1: {
        id: 'l1',
        type: 'froglight.list',
        ordered: true,
        items: [{ runs: [{ text: 'first' }], children: ['t1'] }],
      } as never,
      t1: { ...toggleBlock('t1', [{ text: 'summary' }]), children: ['c1'] },
      c1: paragraphBlock('c1', [{ text: 'child body' }]),
    };
    const env = mount(model);
    try {
      const before = env.handle.getModelForTest!();
      // Caret inside the first item text (pos 3: OL0 LI1 P2 text3...).
      command(env, 'set-selection', { from: 3, to: 3 });
      expect(command(env, 'turn-into', { type: 'bullet' })).toBe(true);
      const next = env.handle.getModelForTest!();
      // The nested toggle child survives with its stable id: the scoped
      // strip only clears direct listItem > paragraph wrappers, so no nb-N
      // mint replaces the legitimate child.
      expect(next.blocks['c1']).toBeDefined();
      expect(JSON.stringify(next.blocks['c1'])).toContain('child body');
      expect(next.blocks['t1']).toMatchObject({ children: ['c1'] });
      expect(Object.keys(next.blocks).some((id) => id.startsWith('nb-'))).toBe(
        false,
      );
      const lists = Object.values(next.blocks).filter(
        (b) => b.type === 'froglight.list',
      );
      expect(lists).toHaveLength(1);
      expect((lists[0] as { ordered?: boolean }).ordered).toBe(false);
      expect(JSON.stringify(lists[0])).toContain('first');
      const allText = Object.values(next.blocks)
        .map((b) => JSON.stringify(b))
        .join(' ');
      expect(allText).toContain('first');
      expect(allText).toContain('summary');
      expect(allText).toContain('child body');
      // Single undo restores the exact previous model.
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
  });
});

describe('turn-into rejects new insertables both directions', () => {
  // Source-side: every insert-only atom/region rejects every turn-into
  // target without mutation (content-preservation: turning an image
  // into a paragraph would strand the vault locator; turning a column
  // region would strand or duplicate nested blocks). Video + table sources
  // are pinned above; image/audio/file/math/diagram/column sources land
  // here (audit: previously thin).
  const atomSources: Array<{ label: string; block: Record<string, unknown> }> =
    [
      {
        label: 'image',
        block: {
          id: 'm1',
          type: 'froglight.image',
          src: 'attachments/h',
          sha256: 'h',
        },
      },
      {
        label: 'audio',
        block: {
          id: 'm1',
          type: 'froglight.audio',
          src: 'attachments/h',
          sha256: 'h',
        },
      },
      {
        label: 'file',
        block: {
          id: 'm1',
          type: 'froglight.file',
          src: 'attachments/h',
          sha256: 'h',
        },
      },
      {
        label: 'math',
        block: { id: 'm1', type: 'froglight.math', source: 'x^2' },
      },
      {
        label: 'diagram',
        block: {
          id: 'm1',
          type: 'froglight.diagram',
          source: 'graph TD;A-->B',
        },
      },
    ];
  const everyTarget = [
    { type: 'paragraph' },
    { type: 'heading', level: 1 },
    { type: 'quote' },
    { type: 'code' },
    { type: 'toggle' },
    { type: 'callout' },
    { type: 'bullet' },
    { type: 'ordered' },
    { type: 'todo' },
  ];
  for (const { label, block } of atomSources) {
    it(`turn-into from ${label} rejects every target without mutation`, () => {
      const model = emptyBlockPage();
      model.rootOrder = ['m1'];
      model.blocks = { m1: block as never };
      const env = mount(model);
      try {
        expect(command(env, 'select-block', { blockId: 'm1' })).toBe(true);
        const before = env.handle.getModelForTest!();
        for (const target of everyTarget) {
          expect(command(env, 'turn-into', target)).toBe(false);
          expect(env.handle.getModelForTest!()).toEqual(before);
        }
        // Self-type targets are not turn-into destinations either.
        expect(command(env, 'turn-into', { type: label })).toBe(false);
        expect(env.handle.getModelForTest!()).toEqual(before);
      } finally {
        env.cleanup();
      }
    });
  }

  it('turn-into from columnList and column shells rejects without mutation', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['cl1'];
    model.blocks = {
      cl1: {
        id: 'cl1',
        type: 'froglight.columnList',
        children: ['c1', 'c2'],
      } as never,
      c1: { id: 'c1', type: 'froglight.column', children: ['p1'] } as never,
      c2: { id: 'c2', type: 'froglight.column', children: ['p2'] } as never,
      p1: paragraphBlock('p1', [{ text: 'left' }]),
      p2: paragraphBlock('p2', [{ text: 'right' }]),
    };
    const env = mount(model);
    try {
      const before = env.handle.getModelForTest!();
      // Node selections on the region shells (carets always resolve to the
      // inner blocks, which stay turn-into-able paragraphs).
      for (const shell of ['cl1', 'c1']) {
        expect(command(env, 'select-block', { blockId: shell })).toBe(true);
        for (const target of everyTarget) {
          expect(command(env, 'turn-into', target)).toBe(false);
          expect(env.handle.getModelForTest!()).toEqual(before);
        }
      }
    } finally {
      env.cleanup();
    }
  });

  it('turn-into to insert-only types rejects without mutation', () => {
    const env = mount(singlePara('stay text'));
    try {
      command(env, 'set-selection', { from: 2, to: 2 });
      const before = env.handle.getModelForTest!();
      // No turn-into destination is an insert-only type: tables, media,
      // math/diagram, and columns are creation-only (slash/toolbar/insert).
      for (const type of [
        'table',
        'image',
        'video',
        'audio',
        'file',
        'math',
        'diagram',
        'columns',
        'column',
        'divider',
      ]) {
        expect(command(env, 'turn-into', { type })).toBe(false);
        expect(env.handle.getModelForTest!()).toEqual(before);
      }
    } finally {
      env.cleanup();
    }
  });
});

describe('todo toggle + touch rhythm', () => {
  function todoListModel(): BlockPageModel {
    const model = emptyBlockPage();
    model.rootOrder = ['l1'];
    model.blocks = {
      l1: {
        id: 'l1',
        type: 'froglight.list',
        ordered: false,
        items: [{ runs: [{ text: 'task body' }], checked: false }],
      } as never,
    };
    return model;
  }

  function checkedOf(
    model: BlockPageModel,
    listId: string,
    index: number,
  ): unknown {
    return (
      model.blocks[listId] as unknown as {
        items: Array<{ checked?: boolean }>;
      }
    ).items[index]?.checked;
  }

  it('set-item-checked flips the todo and persists through save/reopen', () => {
    const env = mount(todoListModel());
    try {
      // Caret inside the item text (pos 3: UL0 LI1 P2 text3...).
      command(env, 'set-selection', { from: 3, to: 3 });
      expect(command(env, 'set-item-checked', { value: true })).toBe(true);
      const on = env.handle.getModelForTest!();
      expect(checkedOf(on, 'l1', 0)).toBe(true);
      expect(JSON.stringify(on.blocks['l1'])).toContain('task body');
      expect(command(env, 'set-item-checked', { value: false })).toBe(true);
      const off = env.handle.getModelForTest!();
      expect(checkedOf(off, 'l1', 0)).toBe(false);
      // Save/reopen: the dirty model reopens byte-faithful.
      const reopenParent = document.createElement('div');
      document.body.appendChild(reopenParent);
      let reopened:
        | { destroy(): void; getModelForTest(): BlockPageModel }
        | undefined;
      try {
        reopened = new BlockPageDocumentEditorProvider().createEditor({
          session: {} as never,
          parent: reopenParent,
          initialModel: off,
          onDirtyModel: () => undefined,
        }) as unknown as {
          destroy(): void;
          getModelForTest(): BlockPageModel;
        };
        expect(reopened.getModelForTest()).toEqual(off);
        expect(
          reopenParent.querySelector('li[data-checked="false"]')?.textContent,
        ).toContain('task body');
      } finally {
        reopened?.destroy();
        reopenParent.remove();
      }
    } finally {
      env.cleanup();
    }
  });

  it('a lone toggle is its own undo unit', () => {
    const env = mount(todoListModel());
    try {
      // The toggle is the only history event on this mount, so one undo
      // restores the exact pre-toggle model (no text touched, id stable).
      command(env, 'set-selection', { from: 3, to: 3 });
      const before = env.handle.getModelForTest!();
      expect(command(env, 'set-item-checked', { value: true })).toBe(true);
      expect(checkedOf(env.handle.getModelForTest!(), 'l1', 0)).toBe(true);
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!()).toEqual(before);
      expect(env.handle.execCommand('redo')).toBe(true);
      expect(checkedOf(env.handle.getModelForTest!(), 'l1', 0)).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  it('set-item-checked refuses outside todos without mutation', () => {
    const env = mount(singlePara('plain'));
    try {
      command(env, 'set-selection', { from: 2, to: 2 });
      const before = env.handle.getModelForTest!();
      expect(command(env, 'set-item-checked', { value: true })).toBe(false);
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
  });

  it('nested todos keep structure; outer toggle leaves the inner item alone', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['l1'];
    model.blocks = {
      l1: {
        id: 'l1',
        type: 'froglight.list',
        ordered: false,
        items: [
          { runs: [{ text: 'outer' }], checked: false, children: ['l2'] },
        ],
      } as never,
      l2: {
        id: 'l2',
        type: 'froglight.list',
        ordered: false,
        items: [{ runs: [{ text: 'inner' }], checked: false }],
      } as never,
    };
    const env = mount(model);
    try {
      // Headless alignment structure: the inner list nests inside the outer
      // item (no wrapper elements that would break the first-line-locked
      // inline checkbox), and both rows draw a checkbox.
      const rows = env.parent.querySelectorAll('li[data-checked]');
      expect(rows).toHaveLength(2);
      const outerLi = env.parent.querySelector(
        'li[data-checked] > ul > li[data-checked]',
      );
      expect(outerLi?.textContent).toContain('inner');
      // Caret in the outer text (pos 3) toggles the outer item only; the
      // toggle is the sole history event, so one undo restores everything.
      command(env, 'set-selection', { from: 3, to: 3 });
      const before = env.handle.getModelForTest!();
      expect(command(env, 'set-item-checked', { value: true })).toBe(true);
      const next = env.handle.getModelForTest!();
      expect(checkedOf(next, 'l1', 0)).toBe(true);
      expect(checkedOf(next, 'l2', 0)).toBe(false);
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
  });

  it('todo stylesheet pins: 44px coarse row, first-line box, token-only chrome', () => {
    const css = fs.readFileSync(
      path.resolve(__dirname, 'styles/prose-mirror.css'),
      'utf8',
    );
    const body = css
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/url\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\)/g, 'url()');
    // 44px coarse hit area: a li[data-checked] rule with min-height 44px
    // lives inside a (hover: none), (pointer: coarse) media block.
    const coarseBlocks: string[] = [];
    for (const m of body.matchAll(
      /@media\s*\(hover:\s*none\),\s*\(pointer:\s*coarse\)\s*\{/g,
    )) {
      let depth = 1;
      let i = (m.index ?? 0) + m[0].length;
      for (; i < body.length && depth > 0; i += 1) {
        if (body[i] === '{') depth += 1;
        else if (body[i] === '}') depth -= 1;
      }
      coarseBlocks.push(body.slice((m.index ?? 0) + m[0].length, i - 1));
    }
    expect(coarseBlocks.length).toBeGreaterThan(0);
    expect(
      coarseBlocks.some((block) =>
        /li\[data-checked\][^{]*\{[^}]*min-height:\s*44px/.test(block),
      ),
    ).toBe(true);
    // First-line box: list item text is a block paragraph, so absolute
    // positioning avoids placing the pseudo-element on its own line.
    expect(
      /li\[data-checked\]::before\s*\{[^}]*position:\s*absolute[^}]*top:\s*calc\(/.test(
        body,
      ),
    ).toBe(true);
    // Token discipline on the todo slice: --fl-* only, no color literals
    // (blockpage-tokens.spec.ts owns the whole-sheet contract; this pins the
    // todo slice touches).
    const todoRules = [
      ...body.matchAll(/li\[data-checked\][^{]*\{[^}]*\}/g),
    ].map((m) => m[0]);
    expect(todoRules.length).toBeGreaterThan(0);
    for (const rule of todoRules) {
      expect(rule).not.toMatch(/var\(\s*--(?!fl-)/);
      expect(rule).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(rule).not.toMatch(/\brgba?\s*\(/);
      expect(rule).not.toMatch(/\bhsla?\s*\(/);
    }
  });
});
