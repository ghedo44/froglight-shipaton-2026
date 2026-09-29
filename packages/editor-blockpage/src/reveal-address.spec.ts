/**
 *  block/whiteboard revealAddress seams.
 *
 * TDD anchor: the production Tiptap handle must scroll a block into view
 * with a transient highlight (true on hit, false on unknown) and the
 * headless handle must resolve-only (true iff the block id exists).
 * Both are focus-neutral: a background reveal never steals focus, and
 * neither mutates canonical bytes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  emptyBlockPage,
  paragraphBlock,
  type BlockPageModel,
} from '@froglight/foundation';
import { BlockPageDocumentEditorProvider } from './editor.js';
import { HeadlessBlockpageEditorHandle } from './headless-handle.js';

function twoBlocks(): BlockPageModel {
  const model = emptyBlockPage({ title: 'Reveal' });
  model.rootOrder = ['a', 'b'];
  model.blocks = {
    a: paragraphBlock('a', [{ text: 'alpha' }]),
    b: paragraphBlock('b', [{ text: 'beta' }]),
  };
  return model;
}

function mountTiptap(model: BlockPageModel) {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  let dirtyCalls = 0;
  const handle = new BlockPageDocumentEditorProvider().createEditor({
    session: {} as never,
    parent,
    initialModel: model,
    onDirtyModel: () => {
      dirtyCalls += 1;
    },
  });
  return {
    parent,
    handle,
    dirtyCalls: () => dirtyCalls,
    cleanup: () => {
      handle.destroy();
      parent.remove();
    },
  };
}

function mountHeadless(model: BlockPageModel) {
  let dirtyCalls = 0;
  const handle = new HeadlessBlockpageEditorHandle({
    session: {} as never,
    parent: {},
    initialModel: model,
    onDirtyModel: () => {
      dirtyCalls += 1;
    },
  });
  return { handle, dirtyCalls: () => dirtyCalls };
}

afterEach(() => {
  document.body.replaceChildren();
  document.getElementById('flbp-chrome-styles')?.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('blockpage headless revealAddress (resolve-only)', () => {
  it('returns true iff the block id exists', () => {
    const { handle } = mountHeadless(twoBlocks());
    try {
      expect(handle.revealAddress?.('a')).toBe(true);
      expect(handle.revealAddress?.('b')).toBe(true);
      expect(handle.revealAddress?.('missing')).toBe(false);
      expect(handle.revealAddress?.('')).toBe(false);
    } finally {
      handle.destroy();
    }
  });

  it('never marks dirty and never takes focus', () => {
    const { handle, dirtyCalls } = mountHeadless(twoBlocks());
    try {
      expect(handle.hasFocus()).toBe(false);
      expect(handle.revealAddress?.('a')).toBe(true);
      expect(handle.hasFocus()).toBe(false);
      expect(dirtyCalls()).toBe(0);
      expect(handle.revealAddress?.('missing')).toBe(false);
      expect(dirtyCalls()).toBe(0);
    } finally {
      handle.destroy();
    }
  });

  it('rejects non-string addresses and stays silent after destroy', () => {
    const { handle, dirtyCalls } = mountHeadless(twoBlocks());
    try {
      for (const bad of [42, null, undefined, {}, []] as unknown[]) {
        expect(handle.revealAddress?.(bad as string)).toBe(false);
      }
      expect(dirtyCalls()).toBe(0);
      expect(handle.hasFocus()).toBe(false);
      handle.destroy();
      expect(handle.revealAddress?.('a')).toBe(false);
      expect(handle.revealAddress?.('missing')).toBe(false);
      expect(handle.hasFocus()).toBe(false);
      expect(dirtyCalls()).toBe(0);
    } finally {
      handle.destroy();
    }
  });
});

describe('blockpage tiptap revealAddress (scroll + highlight)', () => {
  it('reveals a known block with scroll + transient highlight and returns true', () => {
    const env = mountTiptap(twoBlocks());
    try {
      const target = env.parent.querySelector(
        '[data-block-id="b"]',
      ) as HTMLElement | null;
      expect(target).not.toBeNull();
      const scrollMock = vi.fn();
      // jsdom has no layout engine: install the scroll seam explicitly.
      (target! as HTMLElement & { scrollIntoView: unknown }).scrollIntoView =
        scrollMock;
      const before = env.handle.getModelForTest!();
      expect(env.handle.revealAddress?.('b')).toBe(true);
      expect(scrollMock).toHaveBeenCalled();
      expect(target!.classList.contains('flbp-reveal')).toBe(true);
      // Canonical bytes untouched by the ephemeral highlight.
      expect(env.handle.getModelForTest!()).toEqual(before);
      expect(env.dirtyCalls()).toBe(0);
    } finally {
      env.cleanup();
    }
  });

  it('returns false on unknown/empty addresses without side effects', () => {
    const env = mountTiptap(twoBlocks());
    try {
      const scrollSpy = vi.fn();
      for (const el of env.parent.querySelectorAll<HTMLElement>(
        '[data-block-id]',
      )) {
        (el as HTMLElement & { scrollIntoView: unknown }).scrollIntoView =
          scrollSpy;
      }
      const before = env.handle.getModelForTest!();
      expect(env.handle.revealAddress?.('missing')).toBe(false);
      expect(env.handle.revealAddress?.('')).toBe(false);
      expect(scrollSpy).not.toHaveBeenCalled();
      expect(
        env.parent.querySelector('.flbp-reveal'),
      ).toBeNull();
      expect(env.handle.getModelForTest!()).toEqual(before);
      expect(env.dirtyCalls()).toBe(0);
    } finally {
      env.cleanup();
    }
  });

  it('is focus-neutral (background reveals never steal focus)', () => {
    const env = mountTiptap(twoBlocks());
    try {
      expect(env.handle.hasFocus()).toBe(false);
      expect(env.handle.revealAddress?.('a')).toBe(true);
      expect(env.handle.hasFocus()).toBe(false);
    } finally {
      env.cleanup();
    }
  });

  it('unknown addresses dispatch no selection transaction and move nothing', () => {
    const env = mountTiptap(twoBlocks());
    try {
      // Every ProseMirror dispatch funnels through onTransaction into the
      // tools change signal, so the notification count is the observable
      // proof that selection did (or did not) move.
      let notifications = 0;
      const sub = env.handle.tools!.onDidChange(() => {
        notifications += 1;
      });
      try {
        expect(env.handle.blockCommand?.('set-selection', { from: 0, to: 0 })).toBe(
          true,
        );
        const baseline = notifications;
        expect(baseline).toBeGreaterThan(0);
        const scrollSpy = vi.fn();
        for (const el of env.parent.querySelectorAll<HTMLElement>(
          '[data-block-id]',
        )) {
          (el as HTMLElement & { scrollIntoView: unknown }).scrollIntoView =
            scrollSpy;
        }
        const before = env.handle.getModelForTest!();
        expect(env.handle.revealAddress?.('missing')).toBe(false);
        expect(env.handle.revealAddress?.('')).toBe(false);
        expect(notifications).toBe(baseline);
        expect(scrollSpy).not.toHaveBeenCalled();
        expect(env.parent.querySelector('.flbp-reveal')).toBeNull();
        expect(env.handle.getModelForTest!()).toEqual(before);
        expect(env.dirtyCalls()).toBe(0);
      } finally {
        sub.dispose();
      }
    } finally {
      env.cleanup();
    }
  });

  it('a later hit clears the previous transient highlight (unknowns preserve it)', () => {
    const env = mountTiptap(twoBlocks());
    try {
      expect(env.handle.revealAddress?.('a')).toBe(true);
      const a = env.parent.querySelector('[data-block-id="a"]')!;
      expect(a.classList.contains('flbp-reveal')).toBe(true);
      // Unknown addresses preserve the prior highlight (documented
      // contract): only a new hit replaces it.
      expect(env.handle.revealAddress?.('missing')).toBe(false);
      expect(a.classList.contains('flbp-reveal')).toBe(true);
      expect(env.handle.revealAddress?.('b')).toBe(true);
      expect(a.classList.contains('flbp-reveal')).toBe(false);
      expect(
        env.parent
          .querySelector('[data-block-id="b"]')!
          .classList.contains('flbp-reveal'),
      ).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  it('the transient highlight expires on its timer', () => {
    const env = mountTiptap(twoBlocks());
    try {
      vi.useFakeTimers();
      try {
        expect(env.handle.revealAddress?.('a')).toBe(true);
        const a = env.parent.querySelector(
          '[data-block-id="a"]',
        ) as HTMLElement;
        expect(a.classList.contains('flbp-reveal')).toBe(true);
        vi.advanceTimersByTime(1500);
        expect(a.classList.contains('flbp-reveal')).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    } finally {
      env.cleanup();
    }
  });

  it('destroy clears the outstanding reveal highlight and timer', () => {
    const env = mountTiptap(twoBlocks());
    // Manual teardown: destroy() already unmounts, so env.cleanup() would
    // double-destroy the editor.
    try {
      vi.useFakeTimers();
      try {
        expect(env.handle.revealAddress?.('a')).toBe(true);
        const a = env.parent.querySelector(
          '[data-block-id="a"]',
        ) as HTMLElement;
        expect(a.classList.contains('flbp-reveal')).toBe(true);
        env.handle.destroy();
        // Cleared synchronously (no wait for the 1.2s timer)…
        expect(a.classList.contains('flbp-reveal')).toBe(false);
        // …and firing any leftover timers stays a harmless no-op.
        vi.advanceTimersByTime(5000);
        expect(a.classList.contains('flbp-reveal')).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    } finally {
      env.parent.remove();
    }
  });

  it('returns false without throwing after destroy', () => {
    const env = mountTiptap(twoBlocks());
    env.handle.destroy();
    try {
      expect(env.handle.revealAddress?.('a')).toBe(false);
      expect(env.handle.revealAddress?.('missing')).toBe(false);
      expect(env.dirtyCalls()).toBe(0);
    } finally {
      env.parent.remove();
    }
  });

  it('rejects non-string addresses without side effects', () => {
    const env = mountTiptap(twoBlocks());
    try {
      let notifications = 0;
      const sub = env.handle.tools!.onDidChange(() => {
        notifications += 1;
      });
      try {
        const before = env.handle.getModelForTest!();
        for (const bad of [42, null, undefined, {}, []] as unknown[]) {
          expect(env.handle.revealAddress?.(bad as string)).toBe(false);
        }
        expect(notifications).toBe(0);
        expect(env.parent.querySelector('.flbp-reveal')).toBeNull();
        expect(env.handle.getModelForTest!()).toEqual(before);
        expect(env.dirtyCalls()).toBe(0);
      } finally {
        sub.dispose();
      }
    } finally {
      env.cleanup();
    }
  });
});
