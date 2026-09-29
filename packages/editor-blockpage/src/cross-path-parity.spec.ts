/**
 * Cross-path parity matrix and convergence regression coverage.
 *
 * For each trigger family the slash-commit, markdown input-rule, and
 * toolbar/handle turn-into paths converge on identical canonical blocks with
 * single-undo restore. Lists mint a fresh container id by design (never reuse
 * the source paragraph id), so list comparisons normalize the fresh id and
 * assert shape + text + flags instead of byte equality. Leaf conversions
 * carry the source block id and assert exact equality.
 *
 * Toggle/callout have no markdown trigger by design (inventory is
 * #/-,1.,[ ],>,```,--- only): parity there is slash == toolbar/handle, with
 * the input-rule absence pinned as literal-text. Divider has no turn-into
 * target by design (atoms reject): parity there is slash-insert ==
 * input-rule == insert-block on multiset (one divider + one paragraph, no
 * trigger survival), with order/id differences documented (insert-after vs
 * replace-inherit).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Editor } from '@tiptap/core';
import { StarterKit } from '@tiptap/starter-kit';
import {
  emptyBlockPage,
  paragraphBlock,
  headingBlock,
  InMemoryBlockRegistry,
  type BlockPageModel,
} from '@froglight/foundation';
import { BlockPageDocumentEditorProvider } from './editor.js';
import { FlbpInputRules } from './input-rules.js';
import { froglightExtensions } from './extensions.js';

function mount(model: BlockPageModel, registry?: InMemoryBlockRegistry) {
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
    ...(registry !== undefined ? { blockRegistry: registry } : {}),
  });
  return {
    parent,
    handle,
    latest: () => latest as BlockPageModel | null,
    pm: () => parent.querySelector('.ProseMirror')!,
    slash: () =>
      parent.querySelector(
        '.flbp-slash:not(.flbp-resource-menu):not(.flbp-turninto-menu)',
      ) as HTMLElement | null,
    menu: () =>
      parent.querySelector('.flbp-turninto-menu') as HTMLElement | null,
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

/** Char-by-char, like physical typing (one transaction per keystroke). */
function typeChars(env: ReturnType<typeof mount>, text: string): void {
  for (const ch of text) {
    if (!command(env, 'insert-text', { text: ch }))
      throw new Error('insert-text failed');
  }
}

function type(env: ReturnType<typeof mount>, text: string): void {
  if (!command(env, 'insert-text', { text }))
    throw new Error('insert-text failed');
}

function key(env: ReturnType<typeof mount>, k: string): void {
  env
    .pm()
    .dispatchEvent(
      new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }),
    );
}

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 4));

function seedPara(text = 'parity text'): BlockPageModel {
  const model = emptyBlockPage();
  model.rootOrder = ['p0'];
  model.blocks = { p0: paragraphBlock('p0', [{ text }]) };
  return model;
}

function blank(): BlockPageModel {
  const m = emptyBlockPage();
  m.rootOrder = ['p0'];
  m.blocks = { p0: paragraphBlock('p0', [{ text: '' }]) };
  return m;
}

function openMenuFor(
  env: ReturnType<typeof mount>,
  blockId: string,
  transforms = false,
): void {
  const host = env.parent.firstElementChild as HTMLElement;
  const block = env
    .pm()
    .querySelector(`[data-block-id="${blockId}"]`) as HTMLElement;
  block.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
  const handle = host.querySelector('.flbp-drag-handle') as HTMLElement;
  handle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  if (transforms) {
    const turnInto = [...env.menu()!.querySelectorAll('.flbp-slash-item')].find(
      (el) => el.textContent === 'Turn into…',
    );
    turnInto?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }
}

function textOfBlock(block: unknown): string {
  if (typeof block !== 'object' || block === null) return '';
  const rec = block as {
    runs?: Array<{ text?: string }>;
    text?: string;
    items?: Array<{ runs?: Array<{ text?: string }> }>;
  };
  if (typeof rec.text === 'string') return rec.text;
  if (Array.isArray(rec.runs))
    return rec.runs.map((r) => r.text ?? '').join('');
  if (Array.isArray(rec.items))
    return rec.items
      .map((it) => (it.runs ?? []).map((r) => r.text ?? '').join(''))
      .join('\n');
  return JSON.stringify(block);
}

/**
 * Normalized list-shape equality: list containers mint a fresh
 * id by design, so cross-path convergence compares the ordered flag +
 * per-item run texts + per-item checked flags instead of byte equality.
 * `checked ?? null` normalizes pm-map's omit-when-null decoding (plain
 * bullets decode with no key, todos with explicit false) so representation
 * noise never masks a real divergence. Single source shared by the
 * bullet/ordered/todo parity loops.
 */
function expectListShapeEqual(actual: unknown, expected: unknown): void {
  const a = actual as {
    ordered?: boolean;
    items?: Array<{
      runs?: Array<{ text?: string }>;
      checked?: boolean | null;
    }>;
  };
  const e = expected as {
    ordered?: boolean;
    items?: Array<{
      runs?: Array<{ text?: string }>;
      checked?: boolean | null;
    }>;
  };
  expect(a.ordered).toBe(e.ordered);
  const runTexts = (l: typeof a): string[] =>
    (l.items ?? []).map((it) =>
      (it.runs ?? []).map((r) => r.text ?? '').join(''),
    );
  expect(runTexts(a)).toEqual(runTexts(e));
  expect((a.items ?? []).map((it) => it.checked ?? null)).toEqual(
    (e.items ?? []).map((it) => it.checked ?? null),
  );
}

/**
 * All non-spec TS sources under a dir as relative paths, sorted
 * the offline pin's inspection surface, so a new module cannot
 * add network calls behind the pin's back.
 */
function collectSources(dir: string, base: string = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectSources(full, base));
    } else if (
      /\.(?:mts|cts|ts|tsx|jsx|js|mjs|cjs)$/.test(entry) &&
      !/[.-](?:spec|test)\./.test(entry)
    ) {
      out.push(full.slice(base.length + 1));
    }
  }
  return out.sort();
}

afterEach(() => {
  document.body.replaceChildren();
  document.getElementById('flbp-chrome-styles')?.remove();
});

const TURN_INTO_EXPECTED = [
  'paragraph',
  'heading:1',
  'heading:2',
  'heading:3',
  'heading:4',
  'heading:5',
  'heading:6',
  'bullet',
  'ordered',
  'quote',
  'todo',
  'toggle',
  'callout',
  'code',
];

describe('cross-path parity matrix — headings H1-6', () => {
  for (const level of [1, 2, 3, 4, 5, 6] as const) {
    it(`H${level}: slash vs input-rule vs toolbar produce identical heading + single undo`, async () => {
      const text = `parity h${level}`;
      // --- slash path: seed + "/head" + navigate + Enter ---
      const slashEnv = mount(seedPara(text));
      try {
        command(slashEnv, 'set-selection', { from: 1 });
        type(slashEnv, '/head');
        await flush();
        for (let i = 1; i < level; i += 1) key(slashEnv, 'ArrowDown');
        const slashBefore = slashEnv.handle.getModelForTest!();
        key(slashEnv, 'Enter');
        const slashAfter = slashEnv.handle.getModelForTest!();
        expect(slashAfter.rootOrder).toEqual(['p0']);
        expect(slashAfter.blocks['p0']).toMatchObject({
          type: 'froglight.heading',
          level,
        });
        expect(textOfBlock(slashAfter.blocks['p0'])).toBe(text);
        expect(JSON.stringify(slashAfter)).not.toContain('/head');
        expect(slashEnv.handle.execCommand('undo')).toBe(true);
        expect(slashEnv.handle.getModelForTest!()).toEqual(slashBefore);
        // --- input-rule path: seed + hashes + space ---
        const ruleEnv = mount(seedPara(text));
        try {
          command(ruleEnv, 'set-selection', { from: 1 });
          const trigger = `${'#'.repeat(level)} `;
          const head = trigger.slice(0, -1);
          const last = trigger.slice(-1);
          typeChars(ruleEnv, head);
          const ruleBefore = ruleEnv.handle.getModelForTest!();
          typeChars(ruleEnv, last);
          const ruleAfter = ruleEnv.handle.getModelForTest!();
          expect(ruleAfter.rootOrder).toEqual(['p0']);
          expect(ruleAfter.blocks['p0']).toMatchObject({
            type: 'froglight.heading',
            level,
          });
          expect(textOfBlock(ruleAfter.blocks['p0'])).toBe(text);
          expect(ruleEnv.handle.execCommand('undo')).toBe(true);
          expect(ruleEnv.handle.getModelForTest!()).toEqual(ruleBefore);
          // --- toolbar path: seed + execute ---
          const toolEnv = mount(seedPara(text));
          try {
            const tools = toolsOf(toolEnv);
            command(toolEnv, 'set-selection', { from: 2, to: 2 });
            const toolBefore = toolEnv.handle.getModelForTest!();
            expect(tools.execute('block.type', `heading:${level}`)).toBe(true);
            const toolAfter = toolEnv.handle.getModelForTest!();
            expect(toolAfter.rootOrder).toEqual(['p0']);
            expect(toolAfter.blocks['p0']).toMatchObject({
              type: 'froglight.heading',
              level,
            });
            expect(textOfBlock(toolAfter.blocks['p0'])).toBe(text);
            expect(toolEnv.handle.execCommand('undo')).toBe(true);
            expect(toolEnv.handle.getModelForTest!()).toEqual(toolBefore);
            // Cross-path identity: leaf carries p0, so exact block equality.
            expect(ruleAfter.blocks['p0']).toEqual(slashAfter.blocks['p0']);
            expect(toolAfter.blocks['p0']).toEqual(slashAfter.blocks['p0']);
          } finally {
            toolEnv.cleanup();
          }
        } finally {
          ruleEnv.cleanup();
        }
      } finally {
        slashEnv.cleanup();
      }
    });
  }
});

describe('cross-path parity matrix — lists + quote + code', () => {
  it('bullet: slash vs input-rule vs toolbar converge (fresh listId by design)', async () => {
    const text = 'parity bullet';
    const slashEnv = mount(seedPara(text));
    try {
      command(slashEnv, 'set-selection', { from: 1 });
      type(slashEnv, '/bullet');
      await flush();
      const slashBefore = slashEnv.handle.getModelForTest!();
      key(slashEnv, 'Enter');
      const slashAfter = slashEnv.handle.getModelForTest!();
      const slashListId = slashAfter.rootOrder[0]!;
      expect(slashAfter.blocks[slashListId]).toMatchObject({
        type: 'froglight.list',
        ordered: false,
      });
      expect(JSON.stringify(slashAfter)).toContain(text);
      expect(slashListId).not.toBe('p0');
      expect(slashAfter.blocks['p0']).toBeUndefined();
      expect(slashEnv.handle.execCommand('undo')).toBe(true);
      expect(slashEnv.handle.getModelForTest!()).toEqual(slashBefore);

      const ruleEnv = mount(seedPara(text));
      try {
        command(ruleEnv, 'set-selection', { from: 1 });
        typeChars(ruleEnv, '-');
        const ruleBefore = ruleEnv.handle.getModelForTest!();
        typeChars(ruleEnv, ' ');
        const ruleAfter = ruleEnv.handle.getModelForTest!();
        const ruleListId = ruleAfter.rootOrder[0]!;
        expect(ruleAfter.blocks[ruleListId]).toMatchObject({
          type: 'froglight.list',
          ordered: false,
        });
        expect(JSON.stringify(ruleAfter)).toContain(text);
        expect(ruleListId).not.toBe('p0');
        expect(ruleEnv.handle.execCommand('undo')).toBe(true);
        expect(ruleEnv.handle.getModelForTest!()).toEqual(ruleBefore);

        const toolEnv = mount(seedPara(text));
        try {
          command(toolEnv, 'set-selection', { from: 2, to: 2 });
          const toolBefore = toolEnv.handle.getModelForTest!();
          expect(toolsOf(toolEnv).execute('block.type', 'bullet')).toBe(true);
          const toolAfter = toolEnv.handle.getModelForTest!();
          const toolListId = toolAfter.rootOrder[0]!;
          expect(toolAfter.blocks[toolListId]).toMatchObject({
            type: 'froglight.list',
            ordered: false,
          });
          expect(JSON.stringify(toolAfter)).toContain(text);
          expect(toolEnv.handle.execCommand('undo')).toBe(true);
          expect(toolEnv.handle.getModelForTest!()).toEqual(toolBefore);
          // Normalized shape equality (fresh ids differ by design).
          for (const after of [ruleAfter, toolAfter]) {
            const id = after.rootOrder[0]!;
            expectListShapeEqual(
              after.blocks[id],
              slashAfter.blocks[slashListId],
            );
          }
        } finally {
          toolEnv.cleanup();
        }
      } finally {
        ruleEnv.cleanup();
      }
    } finally {
      slashEnv.cleanup();
    }
  });

  it('ordered: slash vs input-rule vs toolbar converge + single undo (mirror)', async () => {
    const text = 'parity ordered';
    const slashEnv = mount(seedPara(text));
    try {
      command(slashEnv, 'set-selection', { from: 1 });
      type(slashEnv, '/numbered');
      await flush();
      const slashBefore = slashEnv.handle.getModelForTest!();
      key(slashEnv, 'Enter');
      const slashAfter = slashEnv.handle.getModelForTest!();
      const slashId = slashAfter.rootOrder[0]!;
      expect(slashAfter.blocks[slashId]).toMatchObject({
        type: 'froglight.list',
        ordered: true,
      });
      expect(JSON.stringify(slashAfter)).toContain(text);
      expect(JSON.stringify(slashAfter)).not.toContain('/numbered');
      expect(slashEnv.handle.execCommand('undo')).toBe(true);
      expect(slashEnv.handle.getModelForTest!()).toEqual(slashBefore);

      const ruleEnv = mount(seedPara(text));
      try {
        command(ruleEnv, 'set-selection', { from: 1 });
        typeChars(ruleEnv, '1.');
        const ruleBefore = ruleEnv.handle.getModelForTest!();
        typeChars(ruleEnv, ' ');
        const ruleAfter = ruleEnv.handle.getModelForTest!();
        const ruleId = ruleAfter.rootOrder[0]!;
        expect(ruleAfter.blocks[ruleId]).toMatchObject({
          type: 'froglight.list',
          ordered: true,
        });
        expect(JSON.stringify(ruleAfter)).toContain(text);
        expect(ruleEnv.handle.execCommand('undo')).toBe(true);
        expect(ruleEnv.handle.getModelForTest!()).toEqual(ruleBefore);

        const toolEnv = mount(seedPara(text));
        try {
          command(toolEnv, 'set-selection', { from: 2, to: 2 });
          const toolBefore = toolEnv.handle.getModelForTest!();
          expect(toolsOf(toolEnv).execute('block.type', 'ordered')).toBe(true);
          const toolAfter = toolEnv.handle.getModelForTest!();
          const toolId = toolAfter.rootOrder[0]!;
          expect(toolAfter.blocks[toolId]).toMatchObject({
            type: 'froglight.list',
            ordered: true,
          });
          expect(JSON.stringify(toolAfter)).toContain(text);
          expect(toolEnv.handle.execCommand('undo')).toBe(true);
          expect(toolEnv.handle.getModelForTest!()).toEqual(toolBefore);
          // Normalized shape equality (fresh ids differ by design): ordered
          // flag + per-item run texts + checked flags match slash. The old
          // per-path toContain could not catch order or
          // flag divergence between paths).
          for (const after of [ruleAfter, toolAfter]) {
            const id = after.rootOrder[0]!;
            expectListShapeEqual(after.blocks[id], slashAfter.blocks[slashId]);
          }
        } finally {
          toolEnv.cleanup();
        }
      } finally {
        ruleEnv.cleanup();
      }
    } finally {
      slashEnv.cleanup();
    }
  });

  it('todo: slash vs input-rule vs toolbar converge unchecked + single undo', async () => {
    const text = 'parity todo';
    const slashEnv = mount(seedPara(text));
    try {
      command(slashEnv, 'set-selection', { from: 1 });
      type(slashEnv, '/todo');
      await flush();
      const slashBefore = slashEnv.handle.getModelForTest!();
      key(slashEnv, 'Enter');
      const slashAfter = slashEnv.handle.getModelForTest!();
      const slashId = slashAfter.rootOrder[0]!;
      const slashList = slashAfter.blocks[slashId] as unknown as {
        items: Array<{ checked?: boolean }>;
      };
      expect(slashAfter.blocks[slashId]?.type).toBe('froglight.list');
      expect(slashList.items[0]?.checked).toBe(false);
      expect(JSON.stringify(slashAfter)).toContain(text);
      expect(slashEnv.handle.execCommand('undo')).toBe(true);
      expect(slashEnv.handle.getModelForTest!()).toEqual(slashBefore);

      const ruleEnv = mount(seedPara(text));
      try {
        command(ruleEnv, 'set-selection', { from: 1 });
        typeChars(ruleEnv, '[ ]');
        const ruleBefore = ruleEnv.handle.getModelForTest!();
        typeChars(ruleEnv, ' ');
        const ruleAfter = ruleEnv.handle.getModelForTest!();
        const ruleId = ruleAfter.rootOrder[0]!;
        const ruleList = ruleAfter.blocks[ruleId] as unknown as {
          items: Array<{ checked?: boolean }>;
        };
        expect(ruleAfter.blocks[ruleId]?.type).toBe('froglight.list');
        expect(ruleList.items[0]?.checked).toBe(false);
        expect(JSON.stringify(ruleAfter)).toContain(text);
        expect(ruleEnv.handle.execCommand('undo')).toBe(true);
        expect(ruleEnv.handle.getModelForTest!()).toEqual(ruleBefore);

        const toolEnv = mount(seedPara(text));
        try {
          command(toolEnv, 'set-selection', { from: 2, to: 2 });
          const toolBefore = toolEnv.handle.getModelForTest!();
          expect(toolsOf(toolEnv).execute('block.type', 'todo')).toBe(true);
          const toolAfter = toolEnv.handle.getModelForTest!();
          const toolId = toolAfter.rootOrder[0]!;
          const toolList = toolAfter.blocks[toolId] as unknown as {
            items: Array<{ checked?: boolean }>;
          };
          expect(toolAfter.blocks[toolId]?.type).toBe('froglight.list');
          expect(toolList.items[0]?.checked).toBe(false);
          // Normalized shape equality (fresh ids differ by design): ordered
          // flag + per-item run texts + checked flags match slash; the todo
          // the todo paths previously had no cross-path comparison at all).
          for (const after of [ruleAfter, toolAfter]) {
            const id = after.rootOrder[0]!;
            expectListShapeEqual(after.blocks[id], slashAfter.blocks[slashId]);
          }
          expect(toolEnv.handle.execCommand('undo')).toBe(true);
          expect(toolEnv.handle.getModelForTest!()).toEqual(toolBefore);
        } finally {
          toolEnv.cleanup();
        }
      } finally {
        ruleEnv.cleanup();
      }
    } finally {
      slashEnv.cleanup();
    }
  });

  it('quote: slash vs input-rule vs toolbar produce identical block + single undo', async () => {
    const text = 'parity quote';
    const slashEnv = mount(seedPara(text));
    try {
      command(slashEnv, 'set-selection', { from: 1 });
      type(slashEnv, '/quote');
      await flush();
      const slashBefore = slashEnv.handle.getModelForTest!();
      key(slashEnv, 'Enter');
      const slashAfter = slashEnv.handle.getModelForTest!();
      expect(slashAfter.rootOrder).toEqual(['p0']);
      expect(slashAfter.blocks['p0']?.type).toBe('froglight.quote');
      expect(textOfBlock(slashAfter.blocks['p0'])).toBe(text);
      expect(slashEnv.handle.execCommand('undo')).toBe(true);
      expect(slashEnv.handle.getModelForTest!()).toEqual(slashBefore);

      const ruleEnv = mount(seedPara(text));
      try {
        command(ruleEnv, 'set-selection', { from: 1 });
        typeChars(ruleEnv, '>');
        const ruleBefore = ruleEnv.handle.getModelForTest!();
        typeChars(ruleEnv, ' ');
        const ruleAfter = ruleEnv.handle.getModelForTest!();
        expect(ruleAfter.rootOrder).toEqual(['p0']);
        expect(ruleAfter.blocks['p0']?.type).toBe('froglight.quote');
        expect(textOfBlock(ruleAfter.blocks['p0'])).toBe(text);
        expect(ruleEnv.handle.execCommand('undo')).toBe(true);
        expect(ruleEnv.handle.getModelForTest!()).toEqual(ruleBefore);

        const toolEnv = mount(seedPara(text));
        try {
          command(toolEnv, 'set-selection', { from: 2, to: 2 });
          const toolBefore = toolEnv.handle.getModelForTest!();
          expect(toolsOf(toolEnv).execute('block.type', 'quote')).toBe(true);
          const toolAfter = toolEnv.handle.getModelForTest!();
          expect(toolAfter.blocks['p0']?.type).toBe('froglight.quote');
          expect(textOfBlock(toolAfter.blocks['p0'])).toBe(text);
          expect(toolEnv.handle.execCommand('undo')).toBe(true);
          expect(toolEnv.handle.getModelForTest!()).toEqual(toolBefore);
          expect(ruleAfter.blocks['p0']).toEqual(slashAfter.blocks['p0']);
          expect(toolAfter.blocks['p0']).toEqual(slashAfter.blocks['p0']);
        } finally {
          toolEnv.cleanup();
        }
      } finally {
        ruleEnv.cleanup();
      }
    } finally {
      slashEnv.cleanup();
    }
  });

  it('code: slash vs input-rule vs toolbar produce identical code + single undo', async () => {
    const text = 'parity code';
    const slashEnv = mount(seedPara(text));
    try {
      command(slashEnv, 'set-selection', { from: 1 });
      type(slashEnv, '/code');
      await flush();
      const slashBefore = slashEnv.handle.getModelForTest!();
      key(slashEnv, 'Enter');
      const slashAfter = slashEnv.handle.getModelForTest!();
      expect(slashAfter.rootOrder).toEqual(['p0']);
      expect(slashAfter.blocks['p0']?.type).toBe('froglight.code');
      expect(textOfBlock(slashAfter.blocks['p0'])).toBe(text);
      expect(slashEnv.handle.execCommand('undo')).toBe(true);
      expect(slashEnv.handle.getModelForTest!()).toEqual(slashBefore);

      const ruleEnv = mount(seedPara(text));
      try {
        command(ruleEnv, 'set-selection', { from: 1 });
        typeChars(ruleEnv, '```');
        const ruleBefore = ruleEnv.handle.getModelForTest!();
        typeChars(ruleEnv, ' ');
        const ruleAfter = ruleEnv.handle.getModelForTest!();
        expect(ruleAfter.rootOrder).toEqual(['p0']);
        expect(ruleAfter.blocks['p0']?.type).toBe('froglight.code');
        expect(textOfBlock(ruleAfter.blocks['p0'])).toBe(text);
        expect(ruleEnv.handle.execCommand('undo')).toBe(true);
        expect(ruleEnv.handle.getModelForTest!()).toEqual(ruleBefore);

        const toolEnv = mount(seedPara(text));
        try {
          command(toolEnv, 'set-selection', { from: 2, to: 2 });
          const toolBefore = toolEnv.handle.getModelForTest!();
          expect(toolsOf(toolEnv).execute('block.type', 'code')).toBe(true);
          const toolAfter = toolEnv.handle.getModelForTest!();
          expect(toolAfter.blocks['p0']?.type).toBe('froglight.code');
          expect(textOfBlock(toolAfter.blocks['p0'])).toBe(text);
          expect(toolEnv.handle.execCommand('undo')).toBe(true);
          expect(toolEnv.handle.getModelForTest!()).toEqual(toolBefore);
          expect(ruleAfter.blocks['p0']).toEqual(slashAfter.blocks['p0']);
          expect(toolAfter.blocks['p0']).toEqual(slashAfter.blocks['p0']);
        } finally {
          toolEnv.cleanup();
        }
      } finally {
        ruleEnv.cleanup();
      }
    } finally {
      slashEnv.cleanup();
    }
  });

  it('handle menu commits through the same path (bullet + heading + toggle sample)', async () => {
    // Toolbar/handle convergence: the handle menu reuses the
    // catalog subset and runs #turnInto/#turnIntoList, so sampling three
    // families plus the catalog-order pin in handle-menu.spec covers parity.
    for (const [label, check] of [
      [
        'Heading 2',
        (m: BlockPageModel) =>
          expect(m.blocks['p0']).toMatchObject({
            type: 'froglight.heading',
            level: 2,
          }),
      ],
      [
        'Bullet list',
        (m: BlockPageModel) =>
          expect(Object.values(m.blocks).map((b) => b.type)).toContain(
            'froglight.list',
          ),
      ],
      [
        'Toggle',
        (m: BlockPageModel) =>
          expect(m.blocks['p0']?.type).toBe('froglight.toggle'),
      ],
    ] as const) {
      const env = mount(seedPara(`handle ${label}`));
      try {
        const before = env.handle.getModelForTest!();
        openMenuFor(env, 'p0', true);
        expect(env.menu()?.style.display).toBe('block');
        const item = [...env.menu()!.querySelectorAll('.flbp-slash-item')].find(
          (el) => el.textContent === label,
        )!;
        expect(item).toBeDefined();
        item.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        const next = env.handle.getModelForTest!();
        check(next);
        expect(JSON.stringify(next)).toContain(`handle ${label}`);
        expect(env.handle.execCommand('undo')).toBe(true);
        expect(env.handle.getModelForTest!()).toEqual(before);
      } finally {
        env.cleanup();
      }
    }
  });
});

describe('cross-path parity matrix — toggle + callout', () => {
  for (const [query, value, expectedType] of [
    ['/toggle', 'toggle', 'froglight.toggle'],
    ['/callout', 'callout', 'froglight.callout'],
  ] as const) {
    it(`${value}: slash vs toolbar/handle identical; input-rule has no trigger by design`, async () => {
      const text = `parity ${value}`;
      const slashEnv = mount(seedPara(text));
      try {
        command(slashEnv, 'set-selection', { from: 1 });
        type(slashEnv, query);
        await flush();
        const slashBefore = slashEnv.handle.getModelForTest!();
        key(slashEnv, 'Enter');
        const slashAfter = slashEnv.handle.getModelForTest!();
        expect(slashAfter.rootOrder).toEqual(['p0']);
        expect(slashAfter.blocks['p0']?.type).toBe(expectedType);
        expect(textOfBlock(slashAfter.blocks['p0'])).toBe(text);
        expect(JSON.stringify(slashAfter)).not.toContain(query);
        expect(slashEnv.handle.execCommand('undo')).toBe(true);
        expect(slashEnv.handle.getModelForTest!()).toEqual(slashBefore);

        // No markdown trigger exists for toggle/callout (inventory):
        // typing lookalikes stays literal paragraph text.
        const ruleEnv = mount(seedPara(text));
        try {
          command(ruleEnv, 'set-selection', { from: 1 });
          typeChars(ruleEnv, '>> ');
          const ruleAfter = ruleEnv.handle.getModelForTest!();
          expect(ruleAfter.blocks['p0']?.type).toBe('froglight.paragraph');
          expect(JSON.stringify(ruleAfter.blocks['p0'])).toContain('>> ');
        } finally {
          ruleEnv.cleanup();
        }

        // A second lookalike (`>! `) also stays literal: the quote rule only
        // fires on exactly `> ` at block start.
        const lookEnv = mount(seedPara(text));
        try {
          command(lookEnv, 'set-selection', { from: 1 });
          typeChars(lookEnv, '>! ');
          const lookAfter = lookEnv.handle.getModelForTest!();
          expect(lookAfter.blocks['p0']?.type).toBe('froglight.paragraph');
          expect(JSON.stringify(lookAfter.blocks['p0'])).toContain('>! ');
        } finally {
          lookEnv.cleanup();
        }

        const toolEnv = mount(seedPara(text));
        try {
          command(toolEnv, 'set-selection', { from: 2, to: 2 });
          const toolBefore = toolEnv.handle.getModelForTest!();
          expect(toolsOf(toolEnv).execute('block.type', value)).toBe(true);
          const toolAfter = toolEnv.handle.getModelForTest!();
          expect(toolAfter.blocks['p0']?.type).toBe(expectedType);
          expect(textOfBlock(toolAfter.blocks['p0'])).toBe(text);
          expect(toolEnv.handle.execCommand('undo')).toBe(true);
          expect(toolEnv.handle.getModelForTest!()).toEqual(toolBefore);
          expect(toolAfter.blocks['p0']).toEqual(slashAfter.blocks['p0']);
        } finally {
          toolEnv.cleanup();
        }
      } finally {
        slashEnv.cleanup();
      }
    });
  }
});

describe('cross-path parity matrix — divider', () => {
  it('slash-insert vs input-rule vs insert-block each single-undo with trigger consumed', async () => {
    // Divider has no turn-into target (atoms reject): parity is insert paths.
    // Slash and insert-block both insert-after the current block; input-rule
    // replaces the trigger-only block inheriting its id. All three converge
    // on one divider + one paragraph with no trigger survival.
    const slashEnv = mount(blank());
    try {
      command(slashEnv, 'set-selection', { from: 1 });
      type(slashEnv, '/divider');
      await flush();
      const slashBefore = slashEnv.handle.getModelForTest!();
      key(slashEnv, 'Enter');
      const slashAfter = slashEnv.handle.getModelForTest!();
      const slashTypes = Object.values(slashAfter.blocks)
        .map((b) => b.type)
        .sort();
      expect(slashTypes).toEqual(
        ['froglight.divider', 'froglight.paragraph'].sort(),
      );
      expect(JSON.stringify(slashAfter)).not.toContain('/divider');
      expect(slashEnv.handle.execCommand('undo')).toBe(true);
      expect(slashEnv.handle.getModelForTest!()).toEqual(slashBefore);
      // Toolbar turn-into must reject divider (atom policy).
      command(slashEnv, 'set-selection', { from: 1, to: 1 });
      expect(toolsOf(slashEnv).execute('block.type', 'divider' as never)).toBe(
        false,
      );
    } finally {
      slashEnv.cleanup();
    }

    const ruleEnv = mount(blank());
    try {
      command(ruleEnv, 'set-selection', { from: 1 });
      typeChars(ruleEnv, '--');
      const ruleBefore = ruleEnv.handle.getModelForTest!();
      typeChars(ruleEnv, '-');
      const ruleAfter = ruleEnv.handle.getModelForTest!();
      const ruleTypes = Object.values(ruleAfter.blocks)
        .map((b) => b.type)
        .sort();
      expect(ruleTypes).toEqual(
        ['froglight.divider', 'froglight.paragraph'].sort(),
      );
      // Input-rule inherits the source id by design.
      expect(ruleAfter.blocks['p0']?.type).toBe('froglight.divider');
      expect(ruleEnv.handle.execCommand('undo')).toBe(true);
      expect(ruleEnv.handle.getModelForTest!()).toEqual(ruleBefore);
    } finally {
      ruleEnv.cleanup();
    }

    const insertEnv = mount(blank());
    try {
      const insertBefore = insertEnv.handle.getModelForTest!();
      expect(command(insertEnv, 'insert-block', { type: 'divider' })).toBe(
        true,
      );
      const insertAfter = insertEnv.handle.getModelForTest!();
      const insertTypes = Object.values(insertAfter.blocks)
        .map((b) => b.type)
        .sort();
      expect(insertTypes).toEqual(
        ['froglight.divider', 'froglight.paragraph'].sort(),
      );
      expect(JSON.stringify(insertAfter)).not.toContain('---');
      // Single-undo restore: the insert-block path must be its
      // own history unit, like the slash and input-rule paths above.
      expect(insertEnv.handle.execCommand('undo')).toBe(true);
      expect(insertEnv.handle.getModelForTest!()).toEqual(insertBefore);
    } finally {
      insertEnv.cleanup();
    }
  });
});

describe('input-rule plugin order vs StarterKit upgrades', () => {
  it('flbpInputRules priority 200 precedes StarterKit rule plugins', () => {
    const priority = (
      FlbpInputRules as unknown as { config: { priority: number } }
    ).config.priority;
    // Tiptap default priority is 100; 200 guarantees first-match-wins for
    // overlapping triggers (heading/bullet/ordered/quote/fence) across upgrades.
    expect(priority).toBe(200);
    expect(priority).toBeGreaterThan(100);
  });

  it('live extension order keeps flbp first among inputRule owners', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const probe = new Editor({
      element: el,
      extensions: [
        StarterKit.configure({
          link: false,
          bulletList: false,
          orderedList: false,
          listItem: false,
          horizontalRule: false,
        }),
        ...froglightExtensions(),
      ],
      content: '<p></p>',
    });
    try {
      const names = probe.extensionManager.extensions.map((e) => e.name);
      const flbpIdx = names.indexOf('flbpInputRules');
      expect(flbpIdx).toBeGreaterThanOrEqual(0);
      // Overlapping built-ins that must never shadow our id-preserving adapters.
      for (const rival of [
        'heading',
        'blockquote',
        'codeBlock',
        'bulletList',
        'orderedList',
      ]) {
        const idx = names.indexOf(rival);
        if (idx !== -1) expect(flbpIdx).toBeLessThan(idx);
      }
    } finally {
      probe.destroy();
      el.remove();
    }
  });

  it('live shadowing vs real StarterKit list rules (lists enabled)', () => {
    // The probe above (like production) disables StarterKit lists, so it
    // cannot prove our adapters shadow the REAL StarterKit list rules. This
    // throwaway leaves heading/quote/code AND bullet/ordered lists enabled —
    // only link (paste rules, no input rules) and the legacy horizontalRule
    // (disabled in production per so declined `---` stays
    // literal) are off — and asserts the live resolved order.
    //
    // Version contract (@tiptap/* ^3.30.3, see package.json): Tiptap flattens
    // and priority-sorts extensions (higher first), and ExtensionManager
    // builds one ProseMirror inputRules plugin per rule-owning extension in
    // that order (first-match-wins per handleTextInput). Verified live below
    // that the plugin count matches the rule-owner count (1:1 premise) and
    // that flbpInputRules is the first rule owner — so its live rule plugin
    // precedes every rival rule plugin. (Rule-less extensions, e.g.
    // paragraph at priority 1000, may sort before us; they own no rule
    // plugin and cannot shadow.)
    const el = document.createElement('div');
    document.body.appendChild(el);
    const probe = new Editor({
      element: el,
      extensions: [
        StarterKit.configure({
          link: false,
          horizontalRule: false,
        }),
        FlbpInputRules,
      ],
      content: '<p></p>',
    });
    try {
      const exts = probe.extensionManager.extensions;
      const names = exts.map((e) => e.name);
      const flbpIdx = names.indexOf('flbpInputRules');
      expect(flbpIdx).toBeGreaterThanOrEqual(0);
      // Every overlapping rival rule owner is REALLY present here (no
      // absent-guard skip) and resolves AFTER flbp: heading, blockquote,
      // codeBlock, bulletList and orderedList all ship input rules in
      // StarterKit v3.
      for (const rival of [
        'heading',
        'blockquote',
        'codeBlock',
        'bulletList',
        'orderedList',
      ]) {
        expect(names.indexOf(rival)).toBeGreaterThan(flbpIdx);
      }
      // Live ProseMirror plugin order: flbp must be the first rule-owning
      // extension, and every rule owner must contribute exactly one live
      // rule plugin (no drops, no duplicates).
      const ruleOwners = exts.filter(
        (e) =>
          typeof (e as unknown as { config?: { addInputRules?: unknown } })
            .config?.addInputRules === 'function',
      );
      const ruleIdxs: number[] = [];
      probe.state.plugins.forEach((p, i) => {
        if ((p.spec as { isInputRules?: unknown }).isInputRules === true)
          ruleIdxs.push(i);
      });
      expect(ruleOwners.length).toBeGreaterThan(1);
      expect(ruleIdxs.length).toBe(ruleOwners.length);
      expect(ruleOwners[0]?.name).toBe('flbpInputRules');
    } finally {
      probe.destroy();
      el.remove();
    }
  });

  it('Backspace upgrade gate still restores literal trigger (representative)', () => {
    // Full Backspace matrix lives in input-rules.spec.ts; this pin keeps the
    // upgrade gate green from the parity file too.
    const env = mount(blank());
    try {
      command(env, 'set-selection', { from: 1 });
      typeChars(env, '# ');
      env.pm().dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Backspace',
          bubbles: true,
          cancelable: true,
        }),
      );
      const after = env.handle.getModelForTest!();
      expect(after.rootOrder).toEqual(['p0']);
      expect(after.blocks['p0']).toMatchObject({
        type: 'froglight.paragraph',
        runs: [{ text: '# ' }],
      });
    } finally {
      env.cleanup();
    }
  });
});

describe('turn-into derived allow-list', () => {
  it('toolbar options equal the derived catalog set (core order, empty registry)', () => {
    const env = mount(seedPara('derived'), new InMemoryBlockRegistry());
    try {
      command(env, 'set-selection', { from: 2, to: 2 });
      const choice = toolsOf(env)
        .snapshot()
        .controls.find((c) => c.id === 'block.type') as unknown as {
        options: Array<{ value: string; label: string }>;
      };
      expect(choice.options.map((o) => o.value)).toEqual(TURN_INTO_EXPECTED);
      expect(choice.options.map((o) => o.label)).toEqual([
        'Paragraph',
        'Heading 1',
        'Heading 2',
        'Heading 3',
        'Heading 4',
        'Heading 5',
        'Heading 6',
        'Bullet list',
        'Numbered list',
        'Quote',
        'To-do item',
        'Toggle',
        'Callout',
        'Code block',
      ]);
    } finally {
      env.cleanup();
    }
  });

  it('opaque-seeded registry derives identically (opaque/insert never enter turn-into)', () => {
    const registry = new InMemoryBlockRegistry();
    const held = [
      registry.register({
        typeId: 'acme.board',
        version: 1,
        label: 'Kanban Board',
      }),
      registry.register({ typeId: 'acme.bare', version: 1 }),
    ];
    const env = mount(seedPara('derived opaque'), registry);
    try {
      command(env, 'set-selection', { from: 2, to: 2 });
      const choice = toolsOf(env)
        .snapshot()
        .controls.find((c) => c.id === 'block.type') as unknown as {
        options: Array<{ value: string; label: string }>;
      };
      expect(choice.options.map((o) => o.value)).toEqual(TURN_INTO_EXPECTED);
      // Opaque typeIds and insert-only values never validate.
      const tools = toolsOf(env);
      expect(tools.execute('block.type', 'acme.board')).toBe(false);
      expect(tools.execute('block.type', 'divider' as never)).toBe(false);
      expect(tools.execute('block.type', 'image' as never)).toBe(false);
      // Every derived value executes (paragraph is a no-op success path).
      for (const value of TURN_INTO_EXPECTED) {
        const probe = mount(seedPara(`probe ${value}`), registry);
        try {
          command(probe, 'set-selection', { from: 2, to: 2 });
          // code->todo rejects by policy (slash parity); all others succeed.
          if (value === 'todo') {
            // paragraph->todo succeeds; code->todo tested separately.
            expect(toolsOf(probe).execute('block.type', value)).toBe(true);
          } else {
            expect(toolsOf(probe).execute('block.type', value)).toBe(true);
          }
        } finally {
          probe.cleanup();
        }
      }
    } finally {
      for (const h of held) h.dispose();
      env.cleanup();
    }
  });

  it('handle menu entries match the toolbar catalog subset', () => {
    const env = mount(seedPara('handle match'));
    try {
      openMenuFor(env, 'p0', true);
      const labels = [...env.menu()!.querySelectorAll('.flbp-slash-item')].map(
        (el) => el.textContent,
      );
      expect(labels).toEqual([
        'Back to block actions',
        'Heading 1',
        'Heading 2',
        'Heading 3',
        'Heading 4',
        'Heading 5',
        'Heading 6',
        'Bullet list',
        'Numbered list',
        'Quote',
        'To-do item',
        'Toggle',
        'Callout',
        'Code block',
      ]);
    } finally {
      env.cleanup();
    }
  });
});

describe('multi-item list-to-paragraph unwrap policy', () => {
  it('three-item list unwraps to three paragraphs with text preserved + single undo', () => {
    // Policy: one paragraph per item, inline preserved, nested tails ride as
    // siblings (see #turnListIntoParagraph). Fresh paragraph ids by design
    // (inner list paragraphs carry no blockId).
    const model = emptyBlockPage();
    model.rootOrder = ['l1'];
    model.blocks = {
      l1: {
        id: 'l1',
        type: 'froglight.list',
        ordered: false,
        items: [
          { runs: [{ text: 'one' }] },
          { runs: [{ text: 'two' }] },
          { runs: [{ text: 'three' }] },
        ],
      } as never,
    };
    const env = mount(model);
    try {
      const before = env.handle.getModelForTest!();
      command(env, 'set-selection', { from: 3, to: 3 });
      expect(command(env, 'turn-into', { type: 'paragraph' })).toBe(true);
      const next = env.handle.getModelForTest!();
      expect(next.rootOrder).toHaveLength(3);
      const paras = next.rootOrder.map((id) => next.blocks[id]);
      expect(paras.map((b) => b?.type)).toEqual([
        'froglight.paragraph',
        'froglight.paragraph',
        'froglight.paragraph',
      ]);
      // Order-sensitive: independent toContain assertions would
      // pass on reversal; the mapped text sequence pins the unwrap order.
      expect(next.rootOrder.map((id) => textOfBlock(next.blocks[id]))).toEqual([
        'one',
        'two',
        'three',
      ]);
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
  });

  it('ordered multi-item unwrap preserves order + single undo', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['l1'];
    model.blocks = {
      l1: {
        id: 'l1',
        type: 'froglight.list',
        ordered: true,
        items: [{ runs: [{ text: 'first' }] }, { runs: [{ text: 'second' }] }],
      } as never,
    };
    const env = mount(model);
    try {
      const before = env.handle.getModelForTest!();
      command(env, 'set-selection', { from: 3, to: 3 });
      expect(command(env, 'turn-into', { type: 'paragraph' })).toBe(true);
      const next = env.handle.getModelForTest!();
      expect(next.rootOrder).toHaveLength(2);
      // Order-sensitive: independent toContain assertions would
      // pass on reversal; the mapped text sequence pins the unwrap order.
      expect(next.rootOrder.map((id) => textOfBlock(next.blocks[id]))).toEqual([
        'first',
        'second',
      ]);
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
  });
});

describe('leaf closeHistory grouping regression', () => {
  it('type then immediate leaf turn-into needs two undos (typing vs turn split)', () => {
    // Without closeHistory the turn-into merges with adjacent typing via
    // history newGroupDelay into one undo step. The fix opens a fresh group
    // so undo restores the typed paragraph first, then the empty start.
    const env = mount(blank());
    try {
      command(env, 'set-selection', { from: 1 });
      typeChars(env, 'hello');
      const typed = env.handle.getModelForTest!();
      expect(JSON.stringify(typed)).toContain('hello');
      command(env, 'set-selection', { from: 3, to: 3 });
      expect(command(env, 'turn-into', { type: 'heading', level: 2 })).toBe(
        true,
      );
      const turned = env.handle.getModelForTest!();
      expect(turned.blocks['p0']).toMatchObject({
        type: 'froglight.heading',
        level: 2,
      });
      // First undo restores the typed paragraph (pre-turn).
      expect(env.handle.execCommand('undo')).toBe(true);
      const undoneOnce = env.handle.getModelForTest!();
      expect(undoneOnce.blocks['p0']?.type).toBe('froglight.paragraph');
      expect(JSON.stringify(undoneOnce)).toContain('hello');
      // Second undo restores the empty start (pre-typing).
      expect(env.handle.execCommand('undo')).toBe(true);
      const undoneTwice = env.handle.getModelForTest!();
      expect(undoneTwice.blocks['p0']).toMatchObject({
        type: 'froglight.paragraph',
      });
      expect(JSON.stringify(undoneTwice.blocks['p0'])).not.toContain('hello');
    } finally {
      env.cleanup();
    }
  });

  it('type then immediate no-trigger insert-block divider needs two undos', () => {
    // Without closeHistory the no-trigger #insertBlock dispatch merges with
    // adjacent typing via history newGroupDelay into one undo step (same
    // failure as the leaf turn-into above). The fix opens a fresh group so
    // the first undo restores the typed paragraph and the second restores
    // the empty start. Covers every programmatic insert (divider here) plus
    // the async resource commit via #insertBlock which shares this path.
    const env = mount(blank());
    try {
      command(env, 'set-selection', { from: 1 });
      typeChars(env, 'hello');
      const typed = env.handle.getModelForTest!();
      expect(JSON.stringify(typed)).toContain('hello');
      command(env, 'set-selection', { from: 3, to: 3 });
      expect(command(env, 'insert-block', { type: 'divider' })).toBe(true);
      const inserted = env.handle.getModelForTest!();
      expect(
        Object.values(inserted.blocks)
          .map((b) => (b as { type: string }).type)
          .sort(),
      ).toEqual(['froglight.divider', 'froglight.paragraph'].sort());
      expect(JSON.stringify(inserted)).toContain('hello');
      // First undo restores the typed paragraph (pre-insert).
      expect(env.handle.execCommand('undo')).toBe(true);
      const undoneOnce = env.handle.getModelForTest!();
      expect(JSON.stringify(undoneOnce)).toContain('hello');
      expect(
        Object.values(undoneOnce.blocks).map(
          (b) => (b as { type: string }).type,
        ),
      ).not.toContain('froglight.divider');
      // Second undo restores the empty start (pre-typing).
      expect(env.handle.execCommand('undo')).toBe(true);
      const undoneTwice = env.handle.getModelForTest!();
      expect(undoneTwice.blocks['p0']).toMatchObject({
        type: 'froglight.paragraph',
      });
      expect(JSON.stringify(undoneTwice.blocks['p0'])).not.toContain('hello');
    } finally {
      env.cleanup();
    }
  });
});

describe('preservation invariants through edit sessions', () => {
  it('opaque record round-trips byte-faithful through an edit session', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['p1', 'x1'];
    model.blocks = {
      p1: paragraphBlock('p1', [{ text: 'editable' }]),
      x1: {
        id: 'x1',
        type: 'acme.kanban',
        lanes: [1, 2],
        vendor: { keep: true },
      } as never,
    };
    const beforeOpaque = model.blocks['x1'];
    const env = mount(model);
    try {
      // Edit the paragraph elsewhere; the opaque must survive untouched.
      command(env, 'set-selection', { from: 2, to: 2 });
      typeChars(env, ' +more');
      const next = env.handle.getModelForTest!();
      // Deep equality (key order irrelevant in-memory): unknown payload
      // lanes/vendor survive byte-faithful through the edit session.
      expect(next.blocks['x1']).toEqual(beforeOpaque);
      expect(next.blocks['x1']).toMatchObject({
        type: 'acme.kanban',
        lanes: [1, 2],
        vendor: { keep: true },
      });
      expect(JSON.stringify(next.blocks['p1'])).toContain('editable');
    } finally {
      env.cleanup();
    }
  });

  it('untouched docs are byte-identical (no canonical churn on open)', () => {
    const model = emptyBlockPage({ title: 'churn check' });
    model.rootOrder = ['p1', 'h1', 'x1'];
    model.blocks = {
      p1: paragraphBlock('p1', [{ text: 'alpha' }]),
      h1: headingBlock('h1', 2, [{ text: 'Beta' }]),
      x1: { id: 'x1', type: 'acme.kanban', lanes: [3] } as never,
    };
    const env = mount(model);
    try {
      expect(env.handle.getModelForTest!()).toEqual(model);
      expect(env.latest()).toBeNull();
    } finally {
      env.cleanup();
    }
  });

  it('offline-local: touched provider paths issue no network calls', () => {
    // By construction the provider paths use no network; pin the convergence
    // surface against future additions by inspecting source. Anchored via
    // __dirname (not process cwd) so the pin holds however vitest is
    // invoked, and covers the full provider dir (not just two files) so a
    // new module cannot add network calls behind the pin's back.
    const network = [
      /fetch\s*\(/,
      /XMLHttpRequest/,
      /WebSocket/,
      /EventSource/,
      /sendBeacon/,
      /axios/,
      /http\.request/,
    ];
    const sources = collectSources(__dirname);
    expect(sources).toContain('tiptap-handle.ts');
    expect(sources).toContain('input-rules.ts');
    for (const file of sources) {
      const src = readFileSync(join(__dirname, file), 'utf8');
      for (const pattern of network)
        expect(src, `${file}: ${String(pattern)}`).not.toMatch(pattern);
    }
  });
});
