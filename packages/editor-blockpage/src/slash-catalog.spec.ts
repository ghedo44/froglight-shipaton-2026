/**
 *  registry-driven slash catalog.
 *
 * The single catalog builder feeds the slash menu: plus all
 * insertable core rows plus the resource 4-pack plus one labeled opaque row
 * per trusted-registry descriptor. Filter/commit/dismiss/aria/undo semantics
 * from slash-picker.spec.ts are preserved and asserted here end to end.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  FroglightError,
  InMemoryBlockRegistry,
  codeBlock,
  emptyBlockPage,
  paragraphBlock,
  type BlockPageModel,
} from '@froglight/foundation';
import { BlockPageDocumentEditorProvider } from './editor.js';

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
    slash: () => parent.querySelector('.flbp-slash:not(.flbp-resource-menu)') as HTMLElement | null,
    labels: () =>
      [...(parent.querySelector('.flbp-slash:not(.flbp-resource-menu)')?.querySelectorAll('.flbp-slash-item') ?? [])].map(
        (el) => el.textContent,
      ),
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
function type(env: ReturnType<typeof mount>, text: string): void {
  if (!command(env, 'insert-text', { text })) throw new Error('insert-text failed');
}
function key(env: ReturnType<typeof mount>, k: string): void {
  env.pm().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
}
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 4));
function blank(): BlockPageModel {
  const m = emptyBlockPage();
  m.rootOrder = ['p1'];
  m.blocks = { p1: paragraphBlock('p1', [{ text: '' }]) };
  return m;
}

const CORE_LABELS = [
  'Paragraph',
  'Quote',
  'To-do item',
  'Toggle',
  'Callout',
  'Divider',
  'Heading 1',
  'Heading 2',
  'Heading 3',
  'Heading 4',
  'Heading 5',
  'Heading 6',
  'Bullet list',
  'Numbered list',
  'Image',
  'Video',
  'Audio',
  'File',
  'Table',
  'Code block',
  'Math',
  'Diagram',
  'Resource link',
  'Resource embed',
  'Transclusion',
  'Linked view',
];

afterEach(() => {
  document.body.replaceChildren();
  document.getElementById('flbp-chrome-styles')?.remove();
});

describe('slash catalog from trusted registry', () => {
  it('core-only session lists H1-H6 plus all insertable core plus the resource 4-pack', async () => {
    const env = mount(blank(), new InMemoryBlockRegistry());
    try {
      type(env, '/');
      await flush();
      expect(env.slash()?.style.display).toBe('block');
      expect(env.labels()).toEqual(CORE_LABELS);
    } finally {
      env.cleanup();
    }
  });

  it('core-only session without an explicit registry works too (no errors)', async () => {
    const env = mount(blank());
    try {
      type(env, '/');
      await flush();
      expect(env.labels()).toEqual(CORE_LABELS);
    } finally {
      env.cleanup();
    }
  });

  it('/head narrows to all six headings; Enter commits with the trigger removed', async () => {
    const env = mount(blank());
    try {
      type(env, '/head');
      await flush();
      expect(env.labels()).toEqual([
        'Heading 1',
        'Heading 2',
        'Heading 3',
        'Heading 4',
        'Heading 5',
        'Heading 6',
      ]);
      // the fused commit (trigger deletion + turn-into in one
      // transaction) restores the exact pre-commit state on a single undo —
      // trigger text included.
      const before = env.handle.getModelForTest!();
      key(env, 'Enter');
      const next = env.latest()!;
      expect(next.blocks[next.rootOrder[0]!]?.type).toBe('froglight.heading');
      expect(JSON.stringify(next)).not.toContain('/head');
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
  });

  it('keyword aliases still match (case-insensitive): /TASK offers the to-do item', async () => {
    const env = mount(blank());
    try {
      type(env, '/TASK');
      await flush();
      expect(env.labels()).toEqual(['To-do item']);
    } finally {
      env.cleanup();
    }
  });

  it('registered trusted type appears with its label and matches keyword, hint, and typeId', async () => {
    const registry = new InMemoryBlockRegistry();
    const env = mount(blank(), registry);
    const held = registry.register({
      typeId: 'acme.board',
      version: 1,
      label: 'Kanban Board',
      shortLabel: 'Board',
      hint: 'Track work on a board',
      keywords: 'KANBAN columns',
    });
    try {
      // Label presentation.
      type(env, '/');
      await flush();
      expect(env.labels()).toContain('Kanban Board');
      expect(env.labels()).not.toContain('acme.board');
      key(env, 'Escape');

      // Mixed-case keyword matches (single normalization: lowercase + split).
      type(env, '/kanban');
      await flush();
      expect(env.labels()).toEqual(['Kanban Board']);
      key(env, 'Escape');

      // Hint text matches (single-token query: the trigger only spans letters).
      type(env, '/track');
      await flush();
      expect(env.labels()).toEqual(['Kanban Board']);
      key(env, 'Escape');

      // typeId always matches even though keywords are present.
      type(env, '/acme');
      await flush();
      expect(env.labels()).toEqual(['Kanban Board']);
    } finally {
      held.dispose();
      env.cleanup();
    }
  });

  it('fallback: missing label shows typeId; blank label falls back instead of blanking the menu', async () => {
    const registry = new InMemoryBlockRegistry();
    const env = mount(blank(), registry);
    const held = [
      registry.register({ typeId: 'acme.bare', version: 1 }),
      registry.register({ typeId: 'acme.quux', version: 1, label: '', shortLabel: 'Quux' }),
      registry.register({ typeId: 'acme.zilch', version: 1, label: '   ', shortLabel: '  ' }),
    ];
    try {
      type(env, '/');
      await flush();
      expect(env.labels()).toContain('acme.bare');
      expect(env.labels()).toContain('Quux');
      expect(env.labels()).toContain('acme.zilch');
      // No blank row ever renders.
      for (const label of env.labels()) expect(label).not.toBe('');

      // Keywords absent: the typeId itself is still the match key
      // (dotless substring: the trigger spans letters only).
      key(env, 'Escape');
      type(env, '/bare');
      await flush();
      expect(env.labels()).toEqual(['acme.bare']);
    } finally {
      for (const h of held) h.dispose();
      env.cleanup();
    }
  });

  it('opaque commit inserts the registered typeId block and removes the trigger', async () => {
    const registry = new InMemoryBlockRegistry();
    registry.register({ typeId: 'acme.board', version: 1, label: 'Kanban Board' });
    const env = mount(blank(), registry);
    try {
      type(env, '/kanban');
      await flush();
      expect(env.labels()).toEqual(['Kanban Board']);
      // insert commits (trigger deletion + insert in one
      // transaction) undo in a single step to the pre-commit model.
      const before = env.handle.getModelForTest!();
      key(env, 'Enter');
      const next = env.latest()!;
      expect(Object.values(next.blocks).map((b) => b.type)).toContain('acme.board');
      expect(JSON.stringify(next)).not.toContain('/kanban');
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
  });

  it('resource row without a resolver refuses with the trigger untouched', async () => {
    // No resourceResolver is configured on this mount, so the resource
    // 4-pack can never open its picker: committing must report failure and
    // leave the typed text exactly as it was (no trigger deletion, no block).
    const env = mount(blank());
    try {
      type(env, '/resource');
      await flush();
      expect(env.labels()).toEqual(['Resource link', 'Resource embed']);
      const before = env.handle.getModelForTest!();
      key(env, 'Enter');
      // The failed commit consumes the key (no newline split) and mutates
      // nothing: the model is identical and the menu is dismissed.
      expect(env.handle.getModelForTest!()).toEqual(before);
      expect(JSON.stringify(before)).toContain('/resource');
      expect(env.slash()?.style.display).toBe('none');
    } finally {
      env.cleanup();
    }
  });

  it('to-do commit inside a code block refuses with the trigger untouched', async () => {
    // Converting code into a to-do would destroy code semantics (and content)
    // on decode, so the fused todo path refuses before mutating anything.
    const m = emptyBlockPage();
    m.rootOrder = ['c1'];
    m.blocks = { c1: codeBlock('c1', '') };
    const env = mount(m);
    try {
      type(env, '/todo');
      await flush();
      expect(env.labels()).toEqual(['To-do item']);
      const before = env.handle.getModelForTest!();
      expect(JSON.stringify(before)).toContain('/todo');
      key(env, 'Enter');
      expect(env.handle.getModelForTest!()).toEqual(before);
      expect(env.handle.getModelForTest!().blocks['c1']?.type).toBe('froglight.code');
    } finally {
      env.cleanup();
    }
  });

  it('dispose removes the entry without restart; duplicate registration still throws DUPLICATE_BLOCK_TYPE', async () => {
    const registry = new InMemoryBlockRegistry();
    const env = mount(blank(), registry);
    try {
      const held = registry.register({ typeId: 'acme.board', version: 1, label: 'Kanban Board' });
      type(env, '/kanban');
      await flush();
      expect(env.labels()).toEqual(['Kanban Board']);

      // Duplicate is foundation-owned: same code, no menu corruption.
      try {
        registry.register({ typeId: 'acme.board', version: 2 });
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(FroglightError);
        expect((error as FroglightError).code).toBe('DUPLICATE_BLOCK_TYPE');
      }
      // The failed duplicate never duplicated the row.
      key(env, 'Escape');
      type(env, '/');
      await flush();
      expect(env.labels().filter((label) => label === 'Kanban Board')).toHaveLength(1);

      // Dispose on the live session: the next filter no longer offers it.
      held.dispose();
      key(env, 'Escape');
      type(env, '/kanban');
      await flush();
      expect(env.labels()).toEqual([]);
      expect(env.slash()?.style.display).toBe('none');
    } finally {
      env.cleanup();
    }
  });
});

describe('slash row rhythm polish', () => {
  const proseCss = fs.readFileSync(
    path.resolve(__dirname, 'styles', 'prose-mirror.css'),
    'utf8',
  );

  it('rows carry an explicit 1.4 line-height rhythm (never UA normal)', () => {
    expect(proseCss).toMatch(
      /\.flbp-slash-item\s*\{[^}]*line-height:\s*1\.4/,
    );
  });

  it('rows suppress double-tap-zoom delay on every pointer at the base', () => {
    // owns the coarse 44px sizing hunk; extends manipulation to
    // the base rule so fine-pointer touch laptops get the same no-delay tap.
    expect(proseCss).toMatch(
      /\.flbp-slash-item\s*\{[^}]*touch-action:\s*manipulation/,
    );
  });

  it('active row is never color-only: semibold weight plus aria-selected parity', () => {
    expect(proseCss).toMatch(/\.flbp-slash-item\[aria-selected='true'\]/);
    expect(proseCss).toMatch(
      /aria-selected='true'\]\s*\{[^}]*font-weight:\s*600/,
    );
  });

  it('rows expose pressed and keyboard-focus states on --fl-* tokens', () => {
    expect(proseCss).toMatch(
      /\.flbp-slash-item:active\s*\{[^}]*var\(--fl-surface-active\)/,
    );
    expect(proseCss).toMatch(
      /\.flbp-slash-item:focus-visible\s*\{[^}]*var\(--fl-accent-strong\)/,
    );
  });

  it('long opaque labels stay one line (ellipsis) instead of breaking rhythm', () => {
    expect(proseCss).toMatch(
      /\.flbp-slash-item\s*\{[^}]*text-overflow:\s*ellipsis/,
    );
    expect(proseCss).toMatch(
      /\.flbp-slash-item\s*\{[^}]*white-space:\s*nowrap/,
    );
  });

  it('the pop-in animation yields to prefers-reduced-motion', () => {
    expect(proseCss).toMatch(/prefers-reduced-motion:\s*reduce/);
    expect(proseCss).toMatch(
      /prefers-reduced-motion:\s*reduce\s*\)\s*\{[^}]*\.flbp-slash\s*\{[^}]*animation:\s*none/,
    );
  });
});
