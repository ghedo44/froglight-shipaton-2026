/**
 *  #insertBlock must assign stable block ids at creation
 * (like the paste path) so keyed lookup (hover/drag/move-block) works
 * immediately after insert.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  emptyBlockPage,
  paragraphBlock,
  type BlockPageModel,
  type ResourceTarget,
} from '@froglight/foundation';
import { BlockPageDocumentEditorProvider } from './editor.js';

const TARGET: ResourceTarget = {
  documentId: 'd',
  kindId: 'froglight.markdown',
  resourceId: 'r',
};

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
    cleanup: () => {
      handle.destroy();
      parent.remove();
    },
  };
}

function command(env: ReturnType<typeof mount>, id: string, arg?: unknown): boolean {
  const run = env.handle.blockCommand;
  if (run === undefined) throw new Error('no blockCommand');
  return run.call(env.handle, id, arg);
}

function blank(): BlockPageModel {
  const m = emptyBlockPage();
  m.rootOrder = ['p1'];
  m.blocks = { p1: paragraphBlock('p1', [{ text: '' }]) };
  return m;
}

afterEach(() => {
  document.body.replaceChildren();
  document.getElementById('flbp-chrome-styles')?.remove();
});

describe('insert-block assigns stable ids at creation', () => {
  const cases: Array<{ label: string; arg: Record<string, unknown> }> = [
    { label: 'divider', arg: { type: 'divider' } },
    { label: 'image', arg: { type: 'image' } },
    { label: 'video', arg: { type: 'video' } },
    { label: 'audio', arg: { type: 'audio' } },
    { label: 'file', arg: { type: 'file' } },
    { label: 'table', arg: { type: 'table' } },
    { label: 'toggle', arg: { type: 'toggle' } },
    { label: 'callout', arg: { type: 'callout' } },
    { label: 'opaque', arg: { type: 'opaque', typeId: 'acme.kanban' } },
    { label: 'composition', arg: { type: 'resource-link', target: TARGET } },
  ];

  for (const { label, arg } of cases) {
    it(`${label}: inserted block carries a stable id and move-block finds it`, () => {
      const env = mount(blank());
      try {
        expect(command(env, 'insert-block', arg)).toBe(true);
        const next = env.handle.getModelForTest!();
        expect(next.rootOrder.length).toBe(2);
        const insertedId = next.rootOrder[1]!;
        expect(typeof insertedId).toBe('string');
        expect(insertedId).not.toBe('');
        expect(next.blocks[insertedId]).toBeDefined();
        // Keyed lookup works immediately: drag/move targets the new block.
        expect(
          command(env, 'move-block', { blockId: insertedId, index: 0 }),
        ).toBe(true);
        const moved = env.handle.getModelForTest!();
        expect(moved.rootOrder[0]).toBe(insertedId);
      } finally {
        env.cleanup();
      }
    });
  }
});
