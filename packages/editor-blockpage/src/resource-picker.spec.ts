/**
 *  resource picker: `[[` and `@` share one picker semantics
 * (filter/commit/dismiss across keyboard + touch) converging on stable
 * ResourceTarget. Only explicit selection creates a resource mark.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  emptyBlockPage,
  isResourceTarget,
  paragraphBlock,
  type BlockPageModel,
  type ResourceTarget,
} from '@froglight/foundation';
import { BlockPageDocumentEditorProvider } from './editor.js';

const TARGET: ResourceTarget = { documentId: 'd', kindId: 'froglight.markdown', resourceId: 'r' };
const SUGGESTION = { target: TARGET, label: 'Target note' };

function mount(model: BlockPageModel, search: () => unknown) {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const handle = new BlockPageDocumentEditorProvider().createEditor({
    session: {} as never,
    parent,
    initialModel: model,
    onDirtyModel: () => undefined,
    resourceResolver: { search: search as never },
  });
  return {
    parent,
    handle,
    pm: () => parent.querySelector('.ProseMirror')!,
    menu: () => parent.querySelector('.flbp-resource-menu') as HTMLElement | null,
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
function runsOf(env: ReturnType<typeof mount>): Array<{ text: string; marks?: unknown[] }> {
  const model = env.handle.getModelForTest!();
  return (model.blocks[model.rootOrder[0]!] as unknown as { runs: Array<{ text: string; marks?: unknown[] }> }).runs;
}

afterEach(() => {
  document.body.replaceChildren();
  document.getElementById('flbp-chrome-styles')?.remove();
});

describe('resource picker shared semantics [[ / @', () => {
  for (const trigger of ['[[', '@'] as const) {
    it(`${trigger} commits via Enter into a stable ResourceTarget mark`, async () => {
      const env = mount(blank(), () => [SUGGESTION]);
      try {
        type(env, `${trigger}Tar`);
        await flush();
        expect(env.menu()?.style.display).toBe('block');
        key(env, 'Enter');
        const runs = runsOf(env);
        expect(runs).toEqual([{ text: 'Target note', marks: [{ type: 'resource', target: TARGET }] }]);
        expect(isResourceTarget((runs[0]!.marks as Array<{ target: unknown }>)[0]!.target)).toBe(true);
      } finally {
        env.cleanup();
      }
    });

    it(`${trigger} commits via Tab and via click/touch identically`, async () => {
      for (const via of ['Tab', 'click', 'touch'] as const) {
        const env = mount(blank(), () => [SUGGESTION]);
        try {
          type(env, `${trigger}Tar`);
          await flush();
          const item = env.menu()!.querySelector('.flbp-slash-item')!;
          expect(item.textContent).toBe('Target note');
          if (via === 'Tab') key(env, 'Tab');
          else if (via === 'click') item.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          else {
            item.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch' } as PointerEventInit));
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
          expect(runsOf(env)).toEqual([{ text: 'Target note', marks: [{ type: 'resource', target: TARGET }] }]);
        } finally {
          env.cleanup();
        }
      }
    });

    it(`${trigger} Escape dismisses and keeps typed text as ordinary text`, async () => {
      const env = mount(blank(), () => [SUGGESTION]);
      try {
        type(env, `${trigger}Tar`);
        await flush();
        key(env, 'Escape');
        expect(env.menu()?.style.display).toBe('none');
        expect(runsOf(env)).toEqual([{ text: `${trigger}Tar` }]);
      } finally {
        env.cleanup();
      }
    });

    it(`${trigger} ArrowUp/Down navigates shared listbox semantics`, async () => {
      const env = mount(blank(), () => [
        SUGGESTION,
        { target: { ...TARGET, resourceId: 'r2' }, label: 'Second note' },
      ]);
      try {
        type(env, `${trigger}T`);
        await flush();
        expect(env.menu()?.getAttribute('role')).toBe('listbox');
        key(env, 'ArrowDown');
        const active = env.menu()!.querySelector('.flbp-slash-item.active');
        expect(active?.textContent).toBe('Second note');
        expect(active?.getAttribute('aria-selected')).toBe('true');
        key(env, 'ArrowUp');
        expect(env.menu()!.querySelector('.flbp-slash-item.active')?.textContent).toBe('Target note');
      } finally {
        env.cleanup();
      }
    });
  }

  it('passes the typed query to the shared resolver for both triggers', async () => {
    for (const trigger of ['[[', '@'] as const) {
      const search = vi.fn(() => [SUGGESTION]);
      const env = mount(blank(), search);
      try {
        type(env, `${trigger}hello`);
        await flush();
        expect(search).toHaveBeenCalledWith('hello');
      } finally {
        env.cleanup();
      }
    }
  });

  it('rejects malformed targets instead of inserting unstable marks', async () => {
    const env = mount(blank(), () => [{ target: { documentId: '', kindId: '', resourceId: '' }, label: 'Bad' }]);
    try {
      type(env, '[[Bad');
      await flush();
      key(env, 'Enter');
      // Malformed target must not become a resource mark; text stays plain.
      const runs = runsOf(env);
      expect(runs).toEqual([{ text: '[[Bad' }]);
    } finally {
      env.cleanup();
    }
  });

  it('inserted target is a stable clone (mutating resolver payload later is harmless)', async () => {
    const mutable = { documentId: 'd', kindId: 'froglight.markdown', resourceId: 'r' };
    const env = mount(blank(), () => [{ target: mutable, label: 'Target note' }]);
    try {
      type(env, '[[Tar');
      await flush();
      key(env, 'Enter');
      mutable.resourceId = 'MUTATED';
      const runs = runsOf(env);
      expect(runs).toEqual([
        { text: 'Target note', marks: [{ type: 'resource', target: TARGET }] },
      ]);
    } finally {
      env.cleanup();
    }
  });

  it('slow resolver: commit revalidates trigger text at the caret', async () => {
    // A divider gives a non-textblock selection that skips the
    // appendTransaction caret tracking (which only manages textblock
    // carets): the stale menu stays open and Enter must revalidate.
    const model = blank();
    model.rootOrder = ['p1', 'd1'];
    model.blocks = {
      p1: paragraphBlock('p1', [{ text: '' }]),
      d1: { id: 'd1', type: 'froglight.divider' },
    };
    let resolveSearch!: (value: unknown) => void;
    const search = vi.fn(
      () => new Promise((resolve) => { resolveSearch = resolve; }),
    );
    const env = mount(model, search);
    try {
      command(env, 'set-selection', { from: 1, to: 1 });
      type(env, '[[Tar');
      await flush();
      resolveSearch([SUGGESTION]);
      await flush();
      expect(env.menu()?.style.display).toBe('block');
      // Caret to doc end (past the divider): textblock tracking skips, the
      // stale menu stays open, and the commit range no longer holds the
      // trigger text.
      command(env, 'set-selection', { from: 8, to: 8 });
      key(env, 'Enter');
      // No range is deleted: the trigger text and the divider survive
      // verbatim and no resource mark is inserted at the unrelated caret.
      // The rejected commit falls through, so Enter still inserts its
      // default newline after the divider (same fall-through contract as
      // the empty-filter slash menu).
      const next = env.handle.getModelForTest!();
      expect(next.rootOrder.slice(0, 2)).toEqual(['p1', 'd1']);
      expect(next.blocks['d1']?.type).toBe('froglight.divider');
      expect(
        (next.blocks['p1'] as unknown as { runs: unknown[] }).runs,
      ).toEqual([{ text: '[[Tar' }]);
      expect(JSON.stringify(next)).not.toContain('resource');
    } finally {
      env.cleanup();
    }
  });

  it('slow resolver: matching trigger text still commits (no false reject)', async () => {
    let resolveSearch!: (value: unknown) => void;
    const search = vi.fn(
      () => new Promise((resolve) => { resolveSearch = resolve; }),
    );
    const env = mount(blank(), search);
    try {
      type(env, '[[Tar');
      await flush();
      resolveSearch([SUGGESTION]);
      await flush();
      key(env, 'Enter');
      expect(runsOf(env)).toEqual([
        { text: 'Target note', marks: [{ type: 'resource', target: TARGET }] },
      ]);
    } finally {
      env.cleanup();
    }
  });

  it('slash resource-picker trigger delete is its own undo unit', async () => {
    // Without closeHistory the trigger delete merges with the adjacent
    // /resource typing via history newGroupDelay into one undo step. The
    // fix opens a fresh group so the first undo restores the trigger text
    // and the second restores the empty start. The later async picker
    // commit stays a separate step by design (accepted, not asserted here).
    const env = mount(blank(), () => [SUGGESTION]);
    try {
      type(env, '/resource');
      await flush();
      const slash = env.parent.querySelector(
        '.flbp-slash:not(.flbp-resource-menu):not(.flbp-turninto-menu)',
      ) as HTMLElement | null;
      expect(slash?.style.display).toBe('block');
      key(env, 'Enter');
      await flush();
      // Trigger consumed and the async picker opened (not a fall-through).
      expect(JSON.stringify(env.handle.getModelForTest!())).not.toContain('/resource');
      expect(env.menu()?.style.display).toBe('block');
      // First undo restores the trigger text (pre-delete).
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(JSON.stringify(env.handle.getModelForTest!())).toContain('/resource');
      // Second undo restores the empty start (pre-typing).
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(JSON.stringify(env.handle.getModelForTest!())).not.toContain('/resource');
    } finally {
      env.cleanup();
    }
  });

  it('async [[ inline mark commit is its own undo unit', async () => {
    // Without closeHistory the async replaceWith merges with the adjacent
    // [[Tar typing (wall-clock-dependent granularity). The fix opens a
    // fresh group so a single undo restores the trigger text. Follows the
    // race harness: the resolver resolves before Enter, so the
    // commit range still holds exactly trigger + query.
    let resolveSearch!: (value: unknown) => void;
    const search = vi.fn(
      () => new Promise((resolve) => { resolveSearch = resolve; }),
    );
    const env = mount(blank(), search);
    try {
      type(env, '[[Tar');
      await flush();
      resolveSearch([SUGGESTION]);
      await flush();
      expect(env.menu()?.style.display).toBe('block');
      key(env, 'Enter');
      expect(runsOf(env)).toEqual([
        { text: 'Target note', marks: [{ type: 'resource', target: TARGET }] },
      ]);
      // Single undo restores the [[Tar trigger text (pre-commit).
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(runsOf(env)).toEqual([{ text: '[[Tar' }]);
      // Second undo restores the empty start (pre-typing).
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(JSON.stringify(env.handle.getModelForTest!())).not.toContain('[[Tar');
    } finally {
      env.cleanup();
    }
  });
});
