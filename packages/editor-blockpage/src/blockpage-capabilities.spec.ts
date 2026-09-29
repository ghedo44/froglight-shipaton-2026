/**
 * Block Page full-selection capabilities (review slice 5).
 *
 * Toolbar context must inspect every relevant root block touched by the
 * ProseMirror selection, not just the anchor block. Snapshot and execute
 * share one capability computation.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  codeBlock,
  dividerBlock,
  emptyBlockPage,
  headingBlock,
  listBlock,
  paragraphBlock,
  toggleBlock,
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
    onDirtyModel: (next: BlockPageModel) => {
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

function command(
  env: ReturnType<typeof mount>,
  id: string,
  arg?: unknown,
): boolean {
  const run = (
    env.handle as unknown as {
      blockCommand(id: string, arg?: unknown): boolean;
    }
  ).blockCommand;
  return run.call(env.handle, id, arg);
}

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
  if (tools === undefined) throw new Error('missing tools');
  return tools;
}

function modelWith(
  ids: string[],
  blocks: Record<string, never>,
): BlockPageModel {
  const model = emptyBlockPage();
  model.rootOrder = ids;
  model.blocks = blocks as never;
  return model;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('block selection capabilities over the full range', () => {
  it('paragraph + paragraph allows inline formatting', () => {
    const model = modelWith(['p1', 'p2'], {
      p1: paragraphBlock('p1', [{ text: 'first' }]),
      p2: paragraphBlock('p2', [{ text: 'second' }]),
    } as never);
    const env = mount(model);
    try {
      const tools = toolsOf(env);
      // Both endpoints inside inline text (spans both paragraphs).
      command(env, 'set-selection', { from: 2, to: 10 });
      const ids = tools.snapshot().controls.map((c) => c.id);
      expect(ids).toContain('block.bold');
      expect(ids).toContain('block.link');
      expect(tools.execute('block.bold')).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  it('heading + paragraph allows inline when both support marks', () => {
    const model = modelWith(['h1', 'p1'], {
      h1: headingBlock('h1', 2, [{ text: 'Title' }]),
      p1: paragraphBlock('p1', [{ text: 'body' }]),
    } as never);
    const env = mount(model);
    try {
      const tools = toolsOf(env);
      command(env, 'set-selection', { from: 2, to: 10 });
      const ids = tools.snapshot().controls.map((c) => c.id);
      expect(ids).toContain('block.bold');
      // Mixed heading/paragraph reports mixed block type, never first-only.
      const type = tools
        .snapshot()
        .controls.find((c) => c.id === 'block.type') as unknown as {
        value: string;
        disabled?: boolean;
      };
      // Compatible but different types → mixed → disabled selector.
      expect(type.disabled).toBe(true);
      expect(tools.snapshot().context).toBe('Multiple blocks');
    } finally {
      env.cleanup();
    }
  });

  it('paragraph + code block suppresses inline formatting and link', () => {
    const model = modelWith(['p1', 'c1'], {
      p1: paragraphBlock('p1', [{ text: 'para' }]),
      c1: codeBlock('c1', 'const x = 1;', 'js'),
    } as never);
    const env = mount(model);
    try {
      const tools = toolsOf(env);
      // From inside paragraph text to inside code text (both inline).
      command(env, 'set-selection', { from: 2, to: 10 });
      const ids = tools.snapshot().controls.map((c) => c.id);
      expect(ids).not.toContain('block.bold');
      expect(ids).not.toContain('block.italic');
      expect(ids).not.toContain('block.link');
      expect(tools.execute('block.bold')).toBe(false);
      expect(tools.execute('block.link', 'https://a.test')).toBe(false);
    } finally {
      env.cleanup();
    }
  });

  it('paragraph + special atom suppresses inline and reports unsupported type', () => {
    // Trailing paragraph keeps both endpoints inside inline text while the
    // range spans the divider atom in the middle.
    const model = modelWith(['p1', 'd1', 'p2'], {
      p1: paragraphBlock('p1', [{ text: 'para' }]),
      d1: dividerBlock('d1'),
      p2: paragraphBlock('p2', [{ text: 'tail' }]),
    } as never);
    const env = mount(model);
    try {
      const tools = toolsOf(env);
      command(env, 'set-selection', { from: 2, to: 10 });
      const ids = tools.snapshot().controls.map((c) => c.id);
      expect(ids).not.toContain('block.bold');
      expect(ids).not.toContain('block.link');
      const type = tools
        .snapshot()
        .controls.find((c) => c.id === 'block.type') as unknown as {
        disabled?: boolean;
      };
      expect(type.disabled).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  it('list + paragraph keeps inline but multi-root disables turn-into', () => {
    const model = modelWith(['l1', 'p1'], {
      l1: listBlock('l1', false, [
        { runs: [{ text: 'one' }] },
        { runs: [{ text: 'two' }] },
      ]),
      p1: paragraphBlock('p1', [{ text: 'tail' }]),
    } as never);
    const env = mount(model);
    try {
      const tools = toolsOf(env);
      // Span both keyed roots: single lists are turn-into-able; only
      // multi-root stays disabled). Positions: UL0 LI1 P2 'one'3-6 … p1 text
      // 17-20, so 3..18 touches l1 and p1 without hitting doc boundaries.
      command(env, 'set-selection', { from: 3, to: 18 });
      const ids = tools.snapshot().controls.map((c) => c.id);
      // List text supports marks, so inline stays available.
      expect(ids).toContain('block.bold');
      // Multi-root ranges never offer turn-into.
      const type = tools
        .snapshot()
        .controls.find((c) => c.id === 'block.type') as unknown as {
        disabled?: boolean;
      };
      expect(type.disabled).toBe(true);
      expect(tools.snapshot().context).toBe('Multiple blocks');
    } finally {
      env.cleanup();
    }
  });

  it('single list offers turn-into with bullet value', () => {
    const model = modelWith(['l1'], {
      l1: listBlock('l1', false, [{ runs: [{ text: 'one' }] }]),
    } as never);
    const env = mount(model);
    try {
      const tools = toolsOf(env);
      command(env, 'set-selection', { from: 3, to: 3 });
      const type = tools
        .snapshot()
        .controls.find((c) => c.id === 'block.type') as unknown as {
        value: string;
        disabled?: boolean;
      };
      expect(type.disabled).toBeUndefined();
      expect(type.value).toBe('bullet');
      expect(tools.snapshot().context).toBe('Bullet list');
    } finally {
      env.cleanup();
    }
  });

  it('nested toggle + paragraph reports mixed when types differ', () => {
    const model = modelWith(['t1', 'p1'], {
      t1: toggleBlock('t1', [{ text: 'more' }]),
      p1: paragraphBlock('p1', [{ text: 'tail' }]),
    } as never);
    const env = mount(model);
    try {
      const tools = toolsOf(env);
      command(env, 'set-selection', { from: 2, to: 12 });
      const ids = tools.snapshot().controls.map((c) => c.id);
      expect(ids).toContain('block.bold');
      expect(tools.snapshot().context).toBe('Multiple blocks');
    } finally {
      env.cleanup();
    }
  });

  it('single paragraph reports its actual block type', () => {
    const model = modelWith(['p1'], {
      p1: paragraphBlock('p1', [{ text: 'solo' }]),
    } as never);
    const env = mount(model);
    try {
      const tools = toolsOf(env);
      command(env, 'set-selection', { from: 1, to: 5 });
      const type = tools
        .snapshot()
        .controls.find((c) => c.id === 'block.type') as unknown as {
        value: string;
        disabled?: boolean;
      };
      expect(type.value).toBe('paragraph');
      expect(type.disabled).toBeUndefined();
      expect(tools.snapshot().context).toBe('Paragraph');
    } finally {
      env.cleanup();
    }
  });

  it('same-type multi-block range disables turn-into like execute does', () => {
    const model = modelWith(['p1', 'p2'], {
      p1: paragraphBlock('p1', [{ text: 'first' }]),
      p2: paragraphBlock('p2', [{ text: 'second' }]),
    } as never);
    const env = mount(model);
    try {
      const tools = toolsOf(env);
      const before = env.handle.getModelForTest!();
      // Both endpoints inside inline text (spans both paragraphs).
      command(env, 'set-selection', { from: 2, to: 10 });
      // Snapshot must not offer what execute refuses: multi-root turn-into
      // rejects instead of turning only the anchor.
      const type = tools
        .snapshot()
        .controls.find((c) => c.id === 'block.type') as unknown as {
        value: string;
        disabled?: boolean;
      };
      expect(type.disabled).toBe(true);
      expect(tools.execute('block.type', 'heading:2')).toBe(false);
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
  });

  it('snapshot and execute converge for mixed link ranges', () => {
    const model = modelWith(['p1'], {
      p1: paragraphBlock('p1', [{ text: 'hello world' }]),
    } as never);
    const env = mount(model);
    try {
      const tools = toolsOf(env);
      // Link the first word only, then select both linked and unlinked text.
      command(env, 'set-selection', { from: 1, to: 6 });
      expect(tools.execute('block.link', 'https://a.test')).toBe(true);
      command(env, 'set-selection', { from: 1, to: 11 });
      const link = tools
        .snapshot()
        .controls.find((c) => c.id === 'block.link') as unknown as {
        active?: boolean;
        value?: string;
      };
      // Partially linked range exposes creation but never claims active with
      // a single prefilled href.
      expect(link).toBeDefined();
      expect(link.active).toBeUndefined();
      expect(link.value).toBeUndefined();
    } finally {
      env.cleanup();
    }
  });

  it('unknown marks survive unrelated toolbar operations', () => {
    const model = modelWith(['p1'], {
      p1: paragraphBlock('p1', [
        { text: 'plain ' },
        {
          text: 'mystery',
          marks: [{ type: 'acme.highlight', color: 'yellow' }],
        },
      ]),
    } as never);
    const env = mount(model);
    try {
      const tools = toolsOf(env);
      // Bold the plain run; the unknown mark on the other run must survive
      // (same pattern as the existing preservation test, proving snapshot/
      // execute convergence does not drop opaque marks).
      command(env, 'set-selection', { from: 1, to: 6 });
      expect(tools.execute('block.bold')).toBe(true);
      const latest = env.latest();
      const runs = (
        latest?.blocks['p1'] as unknown as {
          runs: Array<{ marks?: unknown[] }>;
        }
      ).runs;
      expect(
        runs.some((run) =>
          (run.marks ?? []).some(
            (mark) =>
              typeof mark === 'object' &&
              mark !== null &&
              (mark as { type?: string }).type === 'acme.highlight',
          ),
        ),
      ).toBe(true);
    } finally {
      env.cleanup();
    }
  });
});
