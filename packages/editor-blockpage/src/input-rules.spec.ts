/**
 * Markdown input-rule micro-extensions.
 * every trigger family converts at block start with the trigger
 * consumed and the caret in the new block, through both the char-by-char
 * physical typing path and the whole-string insert-text channel; one undo
 * restores the exact pre-rule model; code contexts and mid-prose never fire.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  emptyBlockPage,
  paragraphBlock,
  codeBlock,
  listBlock,
  quoteBlock,
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
  if (run === undefined)
    throw new Error('block command channel is unavailable');
  return run.call(env.handle, id, arg);
}

/** Char-by-char, like physical typing (one transaction per keystroke). */
function typeChars(env: ReturnType<typeof mount>, text: string): void {
  for (const ch of text) {
    if (!command(env, 'insert-text', { text: ch }))
      throw new Error('insert-text failed');
  }
}

/** Whole-string insert-text channel (programmatic parity path). */
function typeString(env: ReturnType<typeof mount>, text: string): void {
  if (!command(env, 'insert-text', { text }))
    throw new Error('insert-text failed');
}

function pressBackspace(env: ReturnType<typeof mount>): void {
  env.pm().dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Backspace',
      bubbles: true,
      cancelable: true,
    }),
  );
}

function pressEnter(env: ReturnType<typeof mount>): void {
  env.pm().dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    }),
  );
}

function emptyPara(id = 'p0'): BlockPageModel {
  const model = emptyBlockPage();
  model.rootOrder = [id];
  model.blocks = { [id]: paragraphBlock(id, [{ text: '' }]) };
  return model;
}

function typesOf(model: BlockPageModel): string[] {
  return Object.values(model.blocks).map((b) => b.type);
}

afterEach(() => {
  document.body.replaceChildren();
  document.getElementById('flbp-chrome-styles')?.remove();
});

describe('input rules — conversion at block start', () => {
  it.each([1, 2, 3, 4, 5, 6])(
    'heading level %i converts with trigger consumed and caret inside',
    (level) => {
      const env = mount(emptyPara());
      try {
        command(env, 'set-selection', { from: 1 });
        typeChars(env, `${'#'.repeat(level)} `);
        const next = env.handle.getModelForTest!();
        // Stable id carried across the conversion.
        expect(next.rootOrder).toEqual(['p0']);
        expect(next.blocks['p0']).toMatchObject({
          type: 'froglight.heading',
          level,
        });
        // Caret lives in the new block: trailing text lands in the heading.
        typeChars(env, 'Hi');
        expect(
          (
            env.handle.getModelForTest!().blocks['p0'] as unknown as {
              runs: Array<{ text: string }>;
            }
          ).runs
            .map((r) => r.text)
            .join(''),
        ).toBe('Hi');
      } finally {
        env.cleanup();
      }
    },
  );

  it('seven hashes do not convert', () => {
    const env = mount(emptyPara());
    try {
      command(env, 'set-selection', { from: 1 });
      typeChars(env, '####### ');
      expect(env.handle.getModelForTest!().blocks['p0']).toMatchObject({
        type: 'froglight.paragraph',
        runs: [{ text: '####### ' }],
      });
    } finally {
      env.cleanup();
    }
  });

  it.each(['-', '+', '*'])(
    'bullet marker %s converts with caret in the item',
    (marker) => {
      const env = mount(emptyPara());
      try {
        command(env, 'set-selection', { from: 1 });
        typeChars(env, `${marker} `);
        const next = env.handle.getModelForTest!();
        expect(typesOf(next)).toEqual(['froglight.list']);
        expect(next.blocks[next.rootOrder[0]!]).toMatchObject({
          type: 'froglight.list',
          ordered: false,
        });
        typeChars(env, 'item');
        const items = (
          env.handle.getModelForTest!().blocks[
            next.rootOrder[0]!
          ] as unknown as {
            items: Array<{ runs: Array<{ text: string }> }>;
          }
        ).items;
        expect(
          items.map((item) => item.runs.map((r) => r.text).join('')),
        ).toEqual(['item']);
      } finally {
        env.cleanup();
      }
    },
  );

  it('ordered marker converts and continues the start number', () => {
    const env = mount(emptyPara());
    try {
      command(env, 'set-selection', { from: 1 });
      typeChars(env, '12. ');
      const next = env.handle.getModelForTest!();
      expect(typesOf(next)).toEqual(['froglight.list']);
      const list = next.blocks[next.rootOrder[0]!] as unknown as {
        ordered: boolean;
        start?: unknown;
      };
      expect(list).toMatchObject({
        type: 'froglight.list',
        ordered: true,
        start: 12,
      });
      // The typed start is canonical and survives the provider bridge.
    } finally {
      env.cleanup();
    }
  });

  it.each([
    ['[ ] ', false],
    ['[x] ', true],
    ['[X] ', true],
  ] as const)('todo marker %s converts with checked=%s', (marker, checked) => {
    const env = mount(emptyPara());
    try {
      command(env, 'set-selection', { from: 1 });
      typeChars(env, marker);
      const next = env.handle.getModelForTest!();
      const list = next.blocks[next.rootOrder[0]!] as unknown as {
        type: string;
        ordered: boolean;
        items: Array<{ runs: Array<{ text: string }>; checked?: boolean }>;
      };
      expect(list).toMatchObject({ type: 'froglight.list', ordered: false });
      expect(list.items).toHaveLength(1);
      expect(list.items[0]?.checked).toBe(checked);
      typeChars(env, 'task');
      expect(
        (
          env.handle.getModelForTest!().blocks[
            next.rootOrder[0]!
          ] as unknown as typeof list
        ).items[0]?.runs
          .map((r) => r.text)
          .join(''),
      ).toBe('task');
    } finally {
      env.cleanup();
    }
  });

  it('quote converts with trigger consumed and caret inside', () => {
    const env = mount(emptyPara());
    try {
      command(env, 'set-selection', { from: 1 });
      typeChars(env, '> ');
      const next = env.handle.getModelForTest!();
      expect(next.rootOrder).toEqual(['p0']);
      expect(next.blocks['p0']?.type).toBe('froglight.quote');
      typeChars(env, 'quoted');
      expect(
        JSON.stringify(env.handle.getModelForTest!().blocks['p0']),
      ).toContain('quoted');
    } finally {
      env.cleanup();
    }
  });

  it('code fence converts with trigger consumed, caret inside, id kept', () => {
    const env = mount(emptyPara());
    try {
      command(env, 'set-selection', { from: 1 });
      typeChars(env, '``` ');
      const next = env.handle.getModelForTest!();
      expect(next.rootOrder).toEqual(['p0']);
      expect(next.blocks['p0']?.type).toBe('froglight.code');
      typeChars(env, 'const x = 1;');
      expect(
        (
          env.handle.getModelForTest!().blocks['p0'] as unknown as {
            text: string;
          }
        ).text,
      ).toBe('const x = 1;');
    } finally {
      env.cleanup();
    }
  });

  it('fence language resolves verbatim and declines compound text', () => {
    const env = mount(emptyPara());
    try {
      command(env, 'set-selection', { from: 1 });
      typeChars(env, '```js ');
      expect(env.handle.getModelForTest!().blocks['p0']).toMatchObject({
        type: 'froglight.code',
        language: 'js',
      });
    } finally {
      env.cleanup();
    }
    // Char-by-char, the fence fires at the FIRST trailing space (` ```a `)
    // with language `a`; the rest stays code text. Compound input arriving
    // in one transaction declines instead of guessing a language.
    const env2 = mount(emptyPara());
    try {
      command(env2, 'set-selection', { from: 1 });
      typeString(env2, '```a b ');
      expect(env2.handle.getModelForTest!().blocks['p0']).toMatchObject({
        type: 'froglight.paragraph',
        runs: [{ text: '```a b ' }],
      });
    } finally {
      env2.cleanup();
    }
  });

  it('divider converts the empty paragraph, inherits its id, caret in the next block', () => {
    const env = mount(emptyPara());
    try {
      command(env, 'set-selection', { from: 1 });
      typeChars(env, '---');
      const next = env.handle.getModelForTest!();
      expect(next.rootOrder).toHaveLength(2);
      expect(next.blocks[next.rootOrder[0]!]).toMatchObject({
        id: 'p0',
        type: 'froglight.divider',
      });
      expect(next.blocks[next.rootOrder[1]!]?.type).toBe('froglight.paragraph');
      // Caret placement proof: typing lands in the paragraph after the rule.
      typeChars(env, 'after');
      const landed = env.handle.getModelForTest!();
      expect(
        (
          landed.blocks[landed.rootOrder[1]!] as unknown as {
            runs: Array<{ text: string }>;
          }
        ).runs
          .map((r) => r.text)
          .join(''),
      ).toBe('after');
    } finally {
      env.cleanup();
    }
  });

  it('whole-string insert-text channel converges with physical typing', () => {
    const cases: Array<{ trigger: string; expectType: string }> = [
      { trigger: '# ', expectType: 'froglight.heading' },
      { trigger: '### ', expectType: 'froglight.heading' },
      { trigger: '- ', expectType: 'froglight.list' },
      { trigger: '1. ', expectType: 'froglight.list' },
      { trigger: '[ ] ', expectType: 'froglight.list' },
      { trigger: '> ', expectType: 'froglight.quote' },
      { trigger: '``` ', expectType: 'froglight.code' },
      { trigger: '```ts ', expectType: 'froglight.code' },
    ];
    for (const { trigger, expectType } of cases) {
      const env = mount(emptyPara());
      try {
        command(env, 'set-selection', { from: 1 });
        typeString(env, trigger);
        expect(typesOf(env.handle.getModelForTest!())).toContain(expectType);
      } finally {
        env.cleanup();
      }
    }
    const divider = mount(emptyPara());
    try {
      command(divider, 'set-selection', { from: 1 });
      typeString(divider, '---');
      expect(typesOf(divider.handle.getModelForTest!())).toContain(
        'froglight.divider',
      );
    } finally {
      divider.cleanup();
    }
  });

  it('bullet under a bullet list extends it instead of forking', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['l1', 'p2'];
    model.blocks = {
      l1: listBlock('l1', false, [{ runs: [{ text: 'one' }] }]),
      p2: paragraphBlock('p2', [{ text: '' }]),
    };
    const env = mount(model);
    try {
      // Caret at the start of the empty paragraph right under the list:
      // bulletList(listItem(paragraph('one'))) spans 0..9, so p2 opens at 9
      // and its content starts at 10.
      command(env, 'set-selection', { from: 10 });
      typeChars(env, '- ');
      const next = env.handle.getModelForTest!();
      const lists = Object.values(next.blocks).filter(
        (b) => b.type === 'froglight.list',
      );
      expect(lists).toHaveLength(1);
      expect(
        (
          lists[0] as unknown as {
            items: Array<{ runs: Array<{ text: string }> }>;
          }
        ).items,
      ).toHaveLength(2);
    } finally {
      env.cleanup();
    }
  });
});

describe('input rules — single undo restores the pre-rule model', () => {
  it.each([
    '# ',
    '## ',
    '- ',
    '1. ',
    '[ ] ',
    '[x] ',
    '> ',
    '``` ',
    '```js ',
    '---',
  ])('one undo after %s restores the exact pre-rule model', (trigger) => {
    // The divider only fires on a trigger-only block, so it seeds an empty
    // paragraph; every other trigger fires ahead of existing prose, proving
    // the prefix survives the round trip byte-for-byte.
    const seedText = trigger === '---' ? '' : 'keep ';
    const model = emptyBlockPage();
    model.rootOrder = ['p0'];
    model.blocks = { p0: paragraphBlock('p0', [{ text: seedText }]) };
    const env = mount(model);
    try {
      // Caret at block start; type all but the firing keystroke first so the
      // pre-rule snapshot holds the full trigger-minus-last text.
      command(env, 'set-selection', { from: 1 });
      const head = trigger.slice(0, -1);
      const last = trigger.slice(-1);
      typeChars(env, head);
      const preRule = env.handle.getModelForTest!();
      typeChars(env, last);
      // Sanity: the rule actually fired (model changed shape).
      expect(env.handle.getModelForTest!()).not.toEqual(preRule);
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!()).toEqual(preRule);
    } finally {
      env.cleanup();
    }
  });

  it.each(['# ', '- ', '1. ', '[ ] ', '> ', '``` ', '---'])(
    'Backspace right after %s restores the literal trigger',
    (trigger) => {
      const env = mount(emptyPara());
      try {
        command(env, 'set-selection', { from: 1 });
        typeChars(env, trigger);
        pressBackspace(env);
        const after = env.handle.getModelForTest!();
        expect(after.rootOrder).toEqual(['p0']);
        expect(after.blocks['p0']).toMatchObject({
          type: 'froglight.paragraph',
          runs: [{ text: trigger }],
        });
      } finally {
        env.cleanup();
      }
    },
  );
});

describe('input rules — quote Enter-split keeps ids unique live (R1)', () => {
  it('input-rule `> quote` then Enter inside the quote re-ids the second paragraph live, zero nb- on save', () => {
    const env = mount(emptyPara());
    try {
      command(env, 'set-selection', { from: 1 });
      typeChars(env, '> ');
      typeChars(env, 'ab');
      // Split between the two chars (blockquote(paragraph) content opens
      // at position 2, so 3 sits between `a` and `b`).
      command(env, 'set-selection', { from: 3 });
      pressEnter(env);
      const next = env.handle.getModelForTest!();
      // Live uniqueness: every id distinct, none minted by the save decode
      // (the dedupe appendTransaction re-id'd the split copy in the same
      // dispatch; only the FIRST shadowed inner keeps the wrapper's id).
      const ids = Object.keys(next.blocks);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.filter((id) => id.startsWith('nb-'))).toEqual([]);
      expect(JSON.stringify(next)).not.toContain('nb-');
      // Shape: the quote keeps p0 with the first-half runs; the split-off
      // second half is a fresh child block (neither p0 nor nb-).
      const quote = next.blocks['p0'] as unknown as {
        type: string;
        runs: Array<{ text: string }>;
        children?: string[];
      };
      expect(quote.type).toBe('froglight.quote');
      expect(quote.runs.map((r) => r.text).join('')).toBe('a');
      expect(quote.children).toHaveLength(1);
      const childId = quote.children![0]!;
      expect(childId).not.toBe('p0');
      expect(next.blocks[childId]).toMatchObject({
        type: 'froglight.paragraph',
      });
      expect(
        (
          next.blocks[childId] as unknown as {
            runs: Array<{ text: string }>;
          }
        ).runs
          .map((r) => r.text)
          .join(''),
      ).toBe('b');
      // Save round-trip: remount the live model; the reload decodes
      // byte-identical with still zero nb- mints.
      const env2 = mount(next);
      try {
        const reopened = env2.handle.getModelForTest!();
        expect(reopened).toEqual(next);
        expect(JSON.stringify(reopened)).not.toContain('nb-');
      } finally {
        env2.cleanup();
      }
    } finally {
      env.cleanup();
    }
  });
});

describe('input rules — suppression guards', () => {
  it.each(['# ', '- ', '1. ', '[ ] ', '[x] ', '> ', '``` ', '---'])(
    'trigger %s stays literal inside code blocks',
    (trigger) => {
      const model = emptyBlockPage();
      model.rootOrder = ['c1'];
      model.blocks = { c1: codeBlock('c1', '', 'js') };
      const env = mount(model);
      try {
        command(env, 'set-selection', { from: 1 });
        typeChars(env, trigger);
        const next = env.handle.getModelForTest!();
        expect(next.blocks['c1']?.type).toBe('froglight.code');
        expect((next.blocks['c1'] as unknown as { text: string }).text).toBe(
          trigger,
        );
      } finally {
        env.cleanup();
      }
    },
  );

  it('ordered marker mid-sentence does not convert', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['p0'];
    model.blocks = { p0: paragraphBlock('p0', [{ text: 'I counted ' }]) };
    const env = mount(model);
    try {
      command(env, 'set-selection', { from: 11 });
      typeChars(env, '1. ');
      const next = env.handle.getModelForTest!();
      expect(next.blocks['p0']).toMatchObject({
        type: 'froglight.paragraph',
        runs: [{ text: 'I counted 1. ' }],
      });
    } finally {
      env.cleanup();
    }
  });

  it('bullet marker after prose does not convert', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['p0'];
    model.blocks = { p0: paragraphBlock('p0', [{ text: 'a' }]) };
    const env = mount(model);
    try {
      command(env, 'set-selection', { from: 2 });
      typeChars(env, '- ');
      expect(env.handle.getModelForTest!().blocks['p0']).toMatchObject({
        type: 'froglight.paragraph',
        runs: [{ text: 'a- ' }],
      });
    } finally {
      env.cleanup();
    }
  });

  it('divider declines with leading prose: the trigger stays literal (no silent drop)', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['p0'];
    model.blocks = { p0: paragraphBlock('p0', [{ text: 'a' }]) };
    const env = mount(model);
    try {
      command(env, 'set-selection', { from: 1 });
      typeChars(env, '---');
      // our divider declines (splicing block nodes around
      // mid-textblock prose would be schema-invalid), and the legacy
      // StarterKit horizontal-rule input rule is disabled at the provider —
      // so the keystrokes stay literal text. The old behavior converted via
      // the legacy rule to an unmapped `horizontalRule` node that canonical
      // decoding dropped, silently losing the typed `---`.
      expect(env.handle.getModelForTest!().blocks['p0']).toMatchObject({
        type: 'froglight.paragraph',
        runs: [{ text: '---a' }],
      });
    } finally {
      env.cleanup();
    }
  });

  it.each(['___ ', '*** '] as const)(
    'legacy hr trigger %s stays literal in an empty paragraph',
    (trigger) => {
      // `___`/`***` never belonged to our divider inventory; they
      // only ever converted via the legacy StarterKit horizontal-rule rule
      // (whose node has no canonical mapping, so the text was lost). With
      // that rule disabled, the trigger — including the trailing space the
      // legacy rule fired on — stays literal text.
      const env = mount(emptyPara());
      try {
        command(env, 'set-selection', { from: 1 });
        typeChars(env, trigger);
        expect(env.handle.getModelForTest!().blocks['p0']).toMatchObject({
          type: 'froglight.paragraph',
          runs: [{ text: trigger }],
        });
      } finally {
        env.cleanup();
      }
    },
  );

  it('nested-depth --- declines and stays literal', () => {
    // the divider only splices top-level paragraphs
    // ($from.depth === 1). Inside a quote the caret sits deeper, so the
    // rule declines — and with the legacy horizontal-rule rule disabled,
    // the trigger stays literal quote text instead of dropping.
    const model = emptyBlockPage();
    model.rootOrder = ['q1'];
    model.blocks = { q1: quoteBlock('q1', [{ text: '' }]) };
    const env = mount(model);
    try {
      // blockquote(paragraph): paragraph content opens at position 2.
      command(env, 'set-selection', { from: 2 });
      typeChars(env, '---');
      const next = env.handle.getModelForTest!();
      expect(typesOf(next)).toEqual(['froglight.quote']);
      expect(next.blocks['q1']).toMatchObject({
        type: 'froglight.quote',
        runs: [{ text: '---' }],
      });
    } finally {
      env.cleanup();
    }
  });

  it('list conversion mints a fresh list id (never reuses the paragraph id)', () => {
    // block conversions carry the source `blockId`, but wrapping
    // a paragraph in a list creates a new container — its `listId` is fresh
    // by design, so the source paragraph id must not survive on the list.
    const env = mount(emptyPara());
    try {
      command(env, 'set-selection', { from: 1 });
      typeChars(env, '- ');
      const next = env.handle.getModelForTest!();
      expect(typesOf(next)).toEqual(['froglight.list']);
      expect(next.rootOrder).toHaveLength(1);
      expect(next.rootOrder[0]).not.toBe('p0');
      expect(next.blocks['p0']).toBeUndefined();
    } finally {
      env.cleanup();
    }
  });

  it('markers without the trailing space stay literal', () => {
    for (const trigger of ['#', '-', '1.', '[ ]', '>']) {
      const env = mount(emptyPara());
      try {
        command(env, 'set-selection', { from: 1 });
        typeChars(env, trigger);
        expect(env.handle.getModelForTest!().blocks['p0']).toMatchObject({
          type: 'froglight.paragraph',
          runs: [{ text: trigger }],
        });
      } finally {
        env.cleanup();
      }
    }
  });
});

describe('input rules — todo polish', () => {
  it('[X] converts checked with the trigger consumed and caret inside', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['p0'];
    model.blocks = { p0: paragraphBlock('p0', [{ text: 'keep ' }]) };
    const env = mount(model);
    try {
      command(env, 'set-selection', { from: 1 });
      typeChars(env, '[X]');
      const preRule = env.handle.getModelForTest!();
      typeChars(env, ' ');
      const next = env.handle.getModelForTest!();
      expect(next).not.toEqual(preRule);
      const list = next.blocks[next.rootOrder[0]!] as unknown as {
        type: string;
        ordered: boolean;
        items: Array<{ runs: Array<{ text: string }>; checked?: boolean }>;
      };
      expect(list).toMatchObject({ type: 'froglight.list', ordered: false });
      expect(list.items).toHaveLength(1);
      expect(list.items[0]?.checked).toBe(true);
      // Source prose survives ahead of the new item (no drops).
      expect(JSON.stringify(list)).toContain('keep ');
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!()).toEqual(preRule);
    } finally {
      env.cleanup();
    }
  });

  it('todo marker under a bullet list extends it and marks only the new item', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['l1', 'p2'];
    model.blocks = {
      l1: listBlock('l1', false, [{ runs: [{ text: 'one' }] }]),
      p2: paragraphBlock('p2', [{ text: '' }]),
    };
    const env = mount(model);
    try {
      // Caret at the start of the empty paragraph right under the list:
      // bulletList(listItem(paragraph('one'))) spans 0..9, so p2 opens at 9
      // and its content starts at 10 (same geometry as the bullet test).
      command(env, 'set-selection', { from: 10 });
      typeChars(env, '[ ] ');
      const next = env.handle.getModelForTest!();
      const lists = Object.values(next.blocks).filter(
        (b) => b.type === 'froglight.list',
      );
      expect(lists).toHaveLength(1);
      const items = (
        lists[0] as unknown as {
          items: Array<{
            runs: Array<{ text: string }>;
            checked?: boolean;
          }>;
        }
      ).items;
      expect(items).toHaveLength(2);
      // The pre-existing bullet stays a plain bullet; only the new item is
      // marked a todo (no fork, no mass-marking).
      expect(items[0]).not.toHaveProperty('checked');
      expect(items[1]?.checked).toBe(false);
      typeChars(env, 'two');
      const landed = env.handle.getModelForTest!().blocks[
        next.rootOrder[0]!
      ] as unknown as {
        items: Array<{ runs: Array<{ text: string }> }>;
      };
      expect(landed.items[1]?.runs.map((r) => r.text).join('')).toBe('two');
    } finally {
      env.cleanup();
    }
  });
});
