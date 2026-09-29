/**
 *  slash menu: filter/commit/dismiss across keyboard + touch.
 * Menus converge on stable labels (exactly-named effects) and a single
 * undoable transaction per commit.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  emptyBlockPage,
  paragraphBlock,
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
    slash: () =>
      parent.querySelector(
        '.flbp-slash:not(.flbp-resource-menu)',
      ) as HTMLElement | null,
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
  if (run === undefined) throw new Error('no blockCommand');
  return run.call(env.handle, id, arg);
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

describe('slash menu keyboard + touch', () => {
  it('filters case-insensitively and commits the active entry via Enter', async () => {
    const env = mount(blank());
    try {
      type(env, '/');
      await flush();
      expect(env.slash()?.style.display).toBe('block');
      type(env, 'HEADIN');
      await flush();
      const items = env.slash()!.querySelectorAll('.flbp-slash-item');
      expect(items.length).toBe(6);
      expect([...items].map((el) => el.textContent)).toEqual([
        'Heading 1',
        'Heading 2',
        'Heading 3',
        'Heading 4',
        'Heading 5',
        'Heading 6',
      ]);
      // one fused transaction per commit, so a single undo
      // restores the exact pre-commit model (trigger text included).
      const before = env.handle.getModelForTest!();
      key(env, 'Enter');
      const next = env.latest()!;
      expect(next.blocks[next.rootOrder[0]!]?.type).toBe('froglight.heading');
      expect(env.slash()?.style.display).toBe('none');
      // Trigger never survives the command.
      expect(JSON.stringify(next)).not.toContain('/HEADIN');
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
  });

  it('finds multiword numbered labels and commits the entire query as one undo step', async () => {
    const env = mount(blank());
    try {
      type(env, '/heading 2');
      await flush();
      expect(env.slash()?.style.display).toBe('block');
      expect(
        [...env.slash()!.querySelectorAll('.flbp-slash-item')].map(
          (el) => el.textContent,
        ),
      ).toEqual(['Heading 2']);
      const before = env.handle.getModelForTest!();
      key(env, 'Enter');
      const next = env.handle.getModelForTest!();
      expect(next.blocks[next.rootOrder[0]!]).toMatchObject({
        type: 'froglight.heading',
        level: 2,
      });
      expect(env.pm().textContent).toBe('');
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
  });

  it('ArrowUp/Down moves active, Tab commits like Enter', async () => {
    const env = mount(blank());
    try {
      type(env, '/');
      await flush();
      type(env, 'headin');
      await flush();
      key(env, 'ArrowDown');
      key(env, 'ArrowDown');
      // Active is Heading 3; Tab commits it (keyboard-first parity with picker).
      key(env, 'Tab');
      const next = env.latest()!;
      expect(next.blocks[next.rootOrder[0]!]).toMatchObject({
        type: 'froglight.heading',
        level: 3,
      });
    } finally {
      env.cleanup();
    }
  });

  it('Escape dismisses without mutating and keeps typed text', async () => {
    const env = mount(blank());
    try {
      type(env, '/head');
      await flush();
      expect(env.slash()?.style.display).toBe('block');
      key(env, 'Escape');
      expect(env.slash()?.style.display).toBe('none');
      // Dismiss keeps the typed trigger as ordinary text (no surprise delete).
      const model = env.handle.getModelForTest!();
      expect(JSON.stringify(model.blocks[model.rootOrder[0]!])).toContain(
        '/head',
      );
    } finally {
      env.cleanup();
    }
  });

  it('click commits and touch tap commits the same entry', async () => {
    for (const via of ['click', 'touch'] as const) {
      const env = mount(blank());
      try {
        type(env, '/table');
        await flush();
        const item = [
          ...env.slash()!.querySelectorAll('.flbp-slash-item'),
        ].find((el) => el.textContent === 'Table')!;
        expect(item).toBeDefined();
        if (via === 'click') {
          item.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        } else {
          // Touch tap: pointerup + click sequence as a coarse pointer would emit.
          const touchInit = {
            bubbles: true,
            cancelable: true,
          } as PointerEventInit;
          item.dispatchEvent(
            new PointerEvent('pointerup', {
              ...touchInit,
              pointerType: 'touch',
            } as PointerEventInit),
          );
          expect(
            item.dispatchEvent(
              new TouchEvent('touchend', {
                bubbles: true,
                cancelable: true,
              }),
            ),
          ).toBe(false);
          item.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        }
        // Table opens the size picker: committing the default
        // preset inserts the grid.
        const picker = env.parent.querySelector(
          '.flbp-table-menu',
        ) as HTMLElement | null;
        expect(picker?.style.display).toBe('block');
        const preset = picker!.querySelector('.flbp-slash-item') as HTMLElement;
        if (via === 'click') {
          preset.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        } else {
          const touchInit = {
            bubbles: true,
            cancelable: true,
          } as PointerEventInit;
          preset.dispatchEvent(
            new PointerEvent('pointerup', {
              ...touchInit,
              pointerType: 'touch',
            } as PointerEventInit),
          );
          expect(
            preset.dispatchEvent(
              new TouchEvent('touchend', {
                bubbles: true,
                cancelable: true,
              }),
            ),
          ).toBe(false);
          preset.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        }
        const next = env.latest()!;
        expect(Object.values(next.blocks).map((b) => b.type)).toContain(
          'froglight.table',
        );
        type(env, 'First cell');
        const typed = env.latest();
        if (typed === null) throw new Error('expected a typed table model');
        const table = Object.values(typed.blocks).find(
          (block) => block.type === 'froglight.table',
        );
        expect(JSON.stringify(table)).toContain('First cell');
      } finally {
        env.cleanup();
      }
    }
  });

  it('touch commit cancels click-through and keeps typing in the transformed block', async () => {
    const env = mount(blank());
    try {
      type(env, '/heading 2');
      await flush();
      const menu = env.slash();
      if (menu === null) throw new Error('expected slash menu');
      const item = menu.querySelector('.flbp-slash-item');
      if (!(item instanceof HTMLElement)) throw new Error('expected slash row');
      item.dispatchEvent(
        new PointerEvent('pointerup', {
          bubbles: true,
          cancelable: true,
          pointerType: 'touch',
        } as PointerEventInit),
      );
      const touchend = new TouchEvent('touchend', {
        bubbles: true,
        cancelable: true,
      });
      expect(item.dispatchEvent(touchend)).toBe(false);
      expect(touchend.defaultPrevented).toBe(true);

      type(env, 'Searchable heading');
      expect(env.pm().querySelector('h2')?.textContent).toBe(
        'Searchable heading',
      );
    } finally {
      env.cleanup();
    }
  });

  it('to-do commit fuses trigger deletion, toggle, and check into one undo step', async () => {
    const env = mount(blank());
    try {
      type(env, '/todo');
      await flush();
      const before = env.handle.getModelForTest!();
      key(env, 'Enter');
      const next = env.latest()!;
      expect(next.blocks[next.rootOrder[0]!]?.type).toBe('froglight.list');
      expect(JSON.stringify(next)).not.toContain('/todo');
      // the old three-transaction commit needed three undos and
      // left the trigger deleted; the fused chain restores everything at once.
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
  });

  it('bullet commit fuses trigger deletion and toggle into one undo step', async () => {
    const env = mount(blank());
    try {
      type(env, '/bullet');
      await flush();
      const before = env.handle.getModelForTest!();
      key(env, 'Enter');
      const next = env.latest()!;
      expect(next.blocks[next.rootOrder[0]!]?.type).toBe('froglight.list');
      expect(JSON.stringify(next)).not.toContain('/bullet');
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
  });

  it('exposes listbox semantics with active descendant', async () => {
    const env = mount(blank());
    try {
      type(env, '/');
      await flush();
      const menu = env.slash()!;
      expect(menu.getAttribute('role')).toBe('listbox');
      const active = menu.querySelector('.flbp-slash-item.active');
      expect(active?.getAttribute('role')).toBe('option');
      expect(active?.getAttribute('aria-selected')).toBe('true');
    } finally {
      env.cleanup();
    }
  });

  it('empty filter falls through: Enter inserts a newline (no trap)', async () => {
    const env = mount(blank());
    try {
      type(env, '/zzzznope');
      await flush();
      // No entries: the menu hides and keeps no commit target.
      expect(env.slash()?.style.display).toBe('none');
      const before = env.handle.getModelForTest!();
      expect(before.rootOrder.length).toBe(1);
      key(env, 'Enter');
      // Enter falls through to the default newline (mirror of the resource
      // picker count>0 guard): the paragraph splits, typed text survives.
      const after = env.handle.getModelForTest!();
      expect(after.rootOrder.length).toBe(2);
      expect(JSON.stringify(after)).toContain('/zzzznope');
    } finally {
      env.cleanup();
    }
  });

  it('ArrowDown on an empty filter never underflows (still falls through)', async () => {
    const env = mount(blank());
    try {
      type(env, '/zzzznope');
      await flush();
      key(env, 'ArrowDown');
      key(env, 'ArrowDown');
      key(env, 'ArrowUp');
      // No crash, no negative active index: Enter still inserts a newline.
      key(env, 'Enter');
      expect(env.handle.getModelForTest!().rootOrder.length).toBe(2);
    } finally {
      env.cleanup();
    }
  });

  it('narrows the active index when the filter shrinks (no stale commit)', async () => {
    const env = mount(blank());
    try {
      type(env, '/');
      await flush();
      key(env, 'ArrowDown');
      key(env, 'ArrowDown');
      // Narrow to a single entry: the stale active index must clamp so Enter
      // commits the visible entry instead of deleting the trigger for nothing.
      type(env, 'table');
      await flush();
      const items = env.slash()!.querySelectorAll('.flbp-slash-item');
      expect(items.length).toBe(1);
      key(env, 'Enter');
      // Table commits into the size picker; a second Enter
      // takes the default 2×2 preset and inserts the grid.
      key(env, 'Enter');
      const next = env.latest()!;
      expect(Object.values(next.blocks).map((b) => b.type)).toContain(
        'froglight.table',
      );
    } finally {
      env.cleanup();
    }
  });

  it('options carry stable ids linked via aria-activedescendant', async () => {
    const env = mount(blank());
    try {
      type(env, '/head');
      await flush();
      const menu = env.slash()!;
      const activeId = menu.getAttribute('aria-activedescendant');
      expect(activeId).not.toBeNull();
      const active = menu.querySelector('.flbp-slash-item.active')!;
      expect(active.id).toBe(activeId);
      for (const item of menu.querySelectorAll('.flbp-slash-item')) {
        expect((item as HTMLElement).id).not.toBe('');
        expect(item.getAttribute('role')).toBe('option');
      }
    } finally {
      env.cleanup();
    }
  });

  it('slash-created bullet reports Bullet in the toolbar snapshot', async () => {
    const env = mount(blank());
    try {
      type(env, '/bullet');
      await flush();
      key(env, 'Enter');
      const tools = (
        env.handle as unknown as {
          tools: {
            snapshot(): {
              context: string;
              controls: Array<{ id: string } & Record<string, unknown>>;
            };
          };
        }
      ).tools;
      const choice = tools
        .snapshot()
        .controls.find((c) => c.id === 'block.type') as unknown as {
        value: string;
      };
      // The fused slash commit stamps the list id, strips the stale inner
      // paragraph id, and focuses the list — so the toolbar describes the
      // new list instead of misreporting it as a paragraph.
      expect(choice.value).toBe('bullet');
      expect(tools.snapshot().context).toBe('Bullet list');
    } finally {
      env.cleanup();
    }
  });
});

describe('slash math/diagram opens the source overlay (wiring)', () => {
  it.each([
    ['math', 'froglight.math', 'figure[data-flbp-math]'],
    ['diagram', 'froglight.diagram', 'figure[data-flbp-diagram]'],
  ])(
    'slash %s commits the atom and opens its overlay anchored live',
    async (query, blockType, figureSelector) => {
      const env = mount(blank());
      try {
        type(env, `/${query}`);
        await flush();
        key(env, 'Enter');
        const next = env.latest()!;
        expect(Object.values(next.blocks).map((block) => block.type)).toContain(
          blockType,
        );
        // The trigger never survives the fused commit.
        expect(JSON.stringify(next)).not.toContain(`/${query}`);
        // The engine-owned overlay opens on the fresh figure (live caret
        // anchor): source editing starts immediately, commit stays a
        // separate undo unit from the empty insert.
        const overlay = env.parent.querySelector(
          '.flbp-md-overlay',
        ) as HTMLElement | null;
        expect(overlay).not.toBeNull();
        const figure = env.parent.querySelector(figureSelector) as HTMLElement;
        expect(figure).not.toBeNull();
        expect(overlay!.dataset.flbpMdBlock).toBe(
          figure.getAttribute('data-block-id'),
        );
        // Escape dismisses with the empty insert intact (no mutation).
        overlay!.querySelector('textarea')!.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
          }),
        );
        expect(env.parent.querySelector('.flbp-md-overlay')).toBeNull();
        expect(
          Object.values(env.handle.getModelForTest!().blocks).map(
            (block) => block.type,
          ),
        ).toContain(blockType);
      } finally {
        env.cleanup();
      }
    },
  );
});

describe('slash active-row selection parity (rhythm polish)', () => {
  it('ArrowDown/Up moves.active, aria-selected, and aria-activedescendant in lockstep', async () => {
    // presentation relies on aria-selected parity
    // (.flbp-slash-item[aria-selected='true'] shares the active style), so
    // the class and the attribute must never diverge while navigating.
    const env = mount(blank());
    try {
      type(env, '/head');
      await flush();
      const menu = env.slash()!;
      const expectLockstep = (index: number): void => {
        const items = [...menu.querySelectorAll('.flbp-slash-item')];
        expect(menu.getAttribute('aria-activedescendant')).toBe(
          `flbp-slash-${index}`,
        );
        items.forEach((item, i) => {
          expect(item.classList.contains('active')).toBe(i === index);
          expect(item.getAttribute('aria-selected')).toBe(String(i === index));
        });
      };
      expectLockstep(0);
      key(env, 'ArrowDown');
      key(env, 'ArrowDown');
      expectLockstep(2);
      key(env, 'ArrowUp');
      expectLockstep(1);
    } finally {
      env.cleanup();
    }
  });
});
