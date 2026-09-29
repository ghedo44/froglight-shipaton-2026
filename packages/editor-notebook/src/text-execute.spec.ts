/**
 * Notebook text write path.
 *
 * Unit coverage for `executeNotebookTextControl` mapping (dormant,
 * style/align values, toggle direction) plus pager-level integration over
 * the real engine (mountNotebook + shared ink surface):
 * - H1/H2 write `role: 'heading'` + H1/H2 size (outline feed: heading
 *   roles outline, body does not)
 * - Body writes `role: 'body'` leaving size alone
 * - bold/italic toggle additively without normalizing unknowns
 * - align sets verbatim; wrap toggles the fixed default (never measured)
 * - round-trip preserves unknown roles/aligns/appearance members
 * - one commit is one history gesture (one-step undo + redo)
 * - snapshot reflects the new traits (overlay reads them)
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendPage,
  boundedFrame,
  emptyNotebook,
  emptySurface,
  notebookPage,
  textObject,
  textRoleOf,
  type NotebookModel,
  type SurfaceObjectRecord,
} from '@froglight/foundation';
import { installCanvasStub } from '@froglight/foundation/testing';
import { executeNotebookTextControl } from './editor.js';
import {
  mountNotebook,
  type NotebookPagerHandle,
  type NotebookPagerOptions,
} from './pager.js';
import type { SurfaceTextSelectionState } from '@froglight/foundation';
import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import {
  NotebookChrome,
  type NotebookPagerSkeleton,
} from './react/NotebookChrome.jsx';

function liveState(
  overrides: Partial<SurfaceTextSelectionState> = {},
): SurfaceTextSelectionState {
  return {
    hasText: true,
    style: 'body',
    size: 16,
    bold: { active: false, mixed: false },
    italic: { active: false, mixed: false },
    align: 'start',
    color: '#37352f',
    wrap: { active: false, mixed: false },
    ...overrides,
  };
}

function fakePager(
  state: SurfaceTextSelectionState,
  onStyle: (style: Record<string, unknown>) => string[] = () => ['t1'],
): Pick<NotebookPagerHandle, 'textSelectionState' | 'setTextStyle'> {
  return {
    textSelectionState: () => state,
    setTextStyle: (style) => onStyle(style as Record<string, unknown>),
  };
}

function fixtureModel(): NotebookModel {
  const model = emptyNotebook('Text execute fixture');
  appendPage(
    model,
    notebookPage('p1', { surface: emptySurface(boundedFrame(800, 600)) }),
  );
  return model;
}

function mountUiPager(
  parent: HTMLElement,
  options: Omit<NotebookPagerOptions, 'host'>,
): NotebookPagerHandle {
  const chromeRef: { current: NotebookPagerSkeleton | null } = {
    current: null,
  };
  const root = createRoot(parent);
  flushSync(() => {
    root.render(createElement(NotebookChrome, { chromeRef }));
  });
  const skeleton = chromeRef.current;
  if (skeleton === null) throw new Error('test chrome failed to commit');
  const pager = mountNotebook({ ...options, host: skeleton });
  let disposed = false;
  return {
    ...pager,
    destroy: () => {
      if (disposed) return;
      disposed = true;
      root.unmount();
      pager.destroy();
    },
  };
}

function seedText(
  model: NotebookModel,
  pageId: string,
  id: string,
  extra: Record<string, unknown> = {},
): void {
  const page = model.pages[pageId];
  if (page?.kind !== 'page') throw new Error('expected a navigable page');
  const record = {
    ...textObject(id, { x: 10, y: 20, text: `text ${id}` }),
    ...extra,
  } as SurfaceObjectRecord;
  page.surface.objects[id] = record;
  page.surface.order.push(id);
}

describe('executeNotebookTextControl mapping', () => {
  it('stays dormant without text (false, no side effects)', () => {
    let calls = 0;
    const pager = fakePager({ ...liveState(), hasText: false }, () => {
      calls += 1;
      return ['t1'];
    });
    expect(executeNotebookTextControl(pager, 'notebook.text.style', 'h1')).toBe(
      false,
    );
    expect(
      executeNotebookTextControl(pager, 'notebook.text.bold', undefined),
    ).toBe(false);
    expect(calls).toBe(0);
  });

  it('maps style values onto role + H1/H2/H3 size; rejects unknowns', () => {
    const seen: Record<string, unknown>[] = [];
    const pager = fakePager(liveState(), (style) => {
      seen.push(style);
      return ['t1'];
    });
    expect(
      executeNotebookTextControl(pager, 'notebook.text.style', 'body'),
    ).toBe(true);
    expect(executeNotebookTextControl(pager, 'notebook.text.style', 'h1')).toBe(
      true,
    );
    expect(executeNotebookTextControl(pager, 'notebook.text.style', 'h2')).toBe(
      true,
    );
    expect(executeNotebookTextControl(pager, 'notebook.text.style', 'h3')).toBe(
      true,
    );
    expect(seen).toEqual([
      { textRole: 'body' },
      { textRole: 'heading', textSize: 24 },
      { textRole: 'heading', textSize: 20 },
      { textRole: 'heading', textSize: 18 },
    ]);
    expect(executeNotebookTextControl(pager, 'notebook.text.style', 'h4')).toBe(
      false,
    );
    expect(executeNotebookTextControl(pager, 'notebook.text.nope', 'h1')).toBe(
      false,
    );
  });

  it('toggles bold/italic/wrap from honest state (all-active turns off)', () => {
    const seen: Record<string, unknown>[] = [];
    const on = fakePager(
      liveState({
        bold: { active: true, mixed: false },
        italic: { active: false, mixed: true },
        wrap: { active: true, mixed: false },
      }),
      (style) => {
        seen.push(style);
        return ['t1'];
      },
    );
    expect(
      executeNotebookTextControl(on, 'notebook.text.bold', undefined),
    ).toBe(true);
    expect(
      executeNotebookTextControl(on, 'notebook.text.italic', undefined),
    ).toBe(true);
    expect(
      executeNotebookTextControl(on, 'notebook.text.wrap', undefined),
    ).toBe(true);
    expect(seen).toEqual([
      { textBold: false },
      { textItalic: true },
      { textWrap: false },
    ]);

    const off = fakePager(liveState(), (style) => {
      seen.push(style);
      return ['t1'];
    });
    expect(
      executeNotebookTextControl(off, 'notebook.text.bold', undefined),
    ).toBe(true);
    expect(seen.at(-1)).toEqual({ textBold: true });
  });

  it('maps align values verbatim; rejects unknowns', () => {
    const seen: Record<string, unknown>[] = [];
    const pager = fakePager(liveState(), (style) => {
      seen.push(style);
      return ['t1'];
    });
    expect(
      executeNotebookTextControl(pager, 'notebook.text.align', 'center'),
    ).toBe(true);
    expect(seen).toEqual([{ textAlign: 'center' }]);
    expect(
      executeNotebookTextControl(pager, 'notebook.text.align', 'justify'),
    ).toBe(false);
  });

  it('writes explicit size and color additively; rejects garbage', () => {
    const seen: Record<string, unknown>[] = [];
    const pager = fakePager(liveState(), (style) => {
      seen.push(style);
      return ['t1'];
    });
    expect(executeNotebookTextControl(pager, 'notebook.text.size', '24')).toBe(
      true,
    );
    expect(executeNotebookTextControl(pager, 'notebook.text.size', 18)).toBe(
      true,
    );
    expect(
      executeNotebookTextControl(pager, 'notebook.text.color', '#c4554d'),
    ).toBe(true);
    expect(seen).toEqual([
      { textSize: 24 },
      { textSize: 18 },
      { color: '#c4554d' },
    ]);
    expect(executeNotebookTextControl(pager, 'notebook.text.size', 'big')).toBe(
      false,
    );
    expect(executeNotebookTextControl(pager, 'notebook.text.size', -3)).toBe(
      false,
    );
    expect(executeNotebookTextControl(pager, 'notebook.text.color', '')).toBe(
      false,
    );
    expect(seen).toHaveLength(3);
  });
});

describe('notebook text write path integration (pager + engine)', () => {
  let restoreCanvas: (() => void) | null = null;

  beforeEach(() => {
    restoreCanvas = installCanvasStub();
  });

  afterEach(() => {
    restoreCanvas?.();
    restoreCanvas = null;
    document.body.replaceChildren();
  });

  function mountWithText(seed: (model: NotebookModel) => void): {
    parent: HTMLElement;
    model: NotebookModel;
    pager: NotebookPagerHandle;
  } {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const model = fixtureModel();
    seed(model);
    const pager = mountUiPager(parent, {
      model,
      markDirty: () => undefined,
    });
    return { parent, model, pager };
  }

  it('writes H1 as heading + 24 with one undo; Body leaves size and drops from outline feed', () => {
    const { parent, model, pager } = mountWithText((m) =>
      seedText(m, 'p1', 't1'),
    );
    try {
      pager.setSelection(['t1']);
      expect(pager.textSelectionState()).toMatchObject({
        hasText: true,
        style: 'body',
      });
      expect(
        executeNotebookTextControl(pager, 'notebook.text.style', 'h1'),
      ).toBe(true);
      const page = model.pages.p1;
      if (page?.kind !== 'page') throw new Error('expected a page');
      expect(textRoleOf(page.surface.objects['t1']!)).toBe('heading');
      expect(page.surface.objects['t1']!.size).toBe(24);
      // Outline feed: heading roles outline (filter).
      expect(textRoleOf(page.surface.objects['t1']!)).toBe('heading');
      expect(pager.textSelectionState()).toMatchObject({ style: 'h1' });

      // One history gesture: single undo reverts, single redo restores.
      expect(pager.canUndo()).toBe(true);
      expect(pager.undo()).toBe(true);
      expect(textRoleOf(page.surface.objects['t1']!)).toBe('body');
      expect(pager.undo()).toBe(false);
      expect(pager.redo()).toBe(true);
      expect(textRoleOf(page.surface.objects['t1']!)).toBe('heading');

      // Body drops the heading (outline-excluded) leaving size alone.
      pager.setSelection(['t1']);
      expect(
        executeNotebookTextControl(pager, 'notebook.text.style', 'body'),
      ).toBe(true);
      expect(textRoleOf(page.surface.objects['t1']!)).toBe('body');
      expect(page.surface.objects['t1']!.size).toBe(24);
      expect(pager.textSelectionState()).toMatchObject({ style: 'body' });

      // H3 writes heading + 18 with the same single-gesture history.
      pager.setSelection(['t1']);
      expect(
        executeNotebookTextControl(pager, 'notebook.text.style', 'h3'),
      ).toBe(true);
      expect(textRoleOf(page.surface.objects['t1']!)).toBe('heading');
      expect(page.surface.objects['t1']!.size).toBe(18);
      expect(pager.textSelectionState()).toMatchObject({
        style: 'h3',
        size: 18,
      });
      expect(pager.canUndo()).toBe(true);
      expect(pager.undo()).toBe(true);
      expect(textRoleOf(page.surface.objects['t1']!)).toBe('body');
    } finally {
      pager.destroy();
      parent.remove();
    }
  });

  it('toggles bold/italic/align/wrap additively with verbatim unknown preservation', () => {
    const { parent, model, pager } = mountWithText((m) =>
      seedText(m, 'p1', 't1', {
        role: 'pull-quote',
        customFuture: 'keep-me',
        appearance: {
          align: 'justify',
          wrapWidth: 120,
          customTrait: 'keep-too',
        },
      }),
    );
    try {
      const page = model.pages.p1;
      if (page?.kind !== 'page') throw new Error('expected a page');
      pager.setSelection(['t1']);
      // Unknowns read degraded but survive.
      expect(pager.textSelectionState()).toMatchObject({
        hasText: true,
        style: 'body',
        align: 'start',
      });

      expect(
        executeNotebookTextControl(pager, 'notebook.text.bold', undefined),
      ).toBe(true);
      let record = page.surface.objects['t1']! as unknown as Record<
        string,
        unknown
      >;
      expect(record.role).toBe('pull-quote');
      expect(record.customFuture).toBe('keep-me');
      expect(record.appearance).toMatchObject({
        align: 'justify',
        bold: true,
        wrapWidth: 120,
        customTrait: 'keep-too',
      });
      expect(pager.textSelectionState()).toMatchObject({
        bold: { active: true, mixed: false },
      });

      expect(
        executeNotebookTextControl(pager, 'notebook.text.align', 'center'),
      ).toBe(true);
      record = page.surface.objects['t1']! as unknown as Record<
        string,
        unknown
      >;
      // Explicit align replaces the unknown intentionally; customs survive.
      expect(record.appearance).toMatchObject({
        align: 'center',
        bold: true,
        customTrait: 'keep-too',
      });

      expect(
        executeNotebookTextControl(pager, 'notebook.text.wrap', undefined),
      ).toBe(true);
      // All wrapped → unwrap removes only the width.
      record = page.surface.objects['t1']! as unknown as Record<
        string,
        unknown
      >;
      expect(
        (record.appearance as Record<string, unknown>).wrapWidth,
      ).toBeUndefined();
      expect(record.appearance).toMatchObject({ align: 'center', bold: true });

      // One undo per commit (wrap-off reverts, then align, then bold).
      expect(pager.undo()).toBe(true);
      record = page.surface.objects['t1']! as unknown as Record<
        string,
        unknown
      >;
      expect((record.appearance as Record<string, unknown>).wrapWidth).toBe(
        120,
      );
    } finally {
      pager.destroy();
      parent.remove();
    }
  });

  it('writes explicit size and color with verbatim unknown preservation', () => {
    const { parent, model, pager } = mountWithText((m) =>
      seedText(m, 'p1', 't1', {
        customFuture: 'keep-me',
        appearance: { customTrait: 'keep-too' },
      }),
    );
    try {
      const page = model.pages.p1;
      if (page?.kind !== 'page') throw new Error('expected a page');
      pager.setSelection(['t1']);
      expect(pager.textSelectionState()).toMatchObject({
        hasText: true,
        size: 16,
        color: '#37352f',
      });
      expect(executeNotebookTextControl(pager, 'notebook.text.size', 22)).toBe(
        true,
      );
      expect(
        executeNotebookTextControl(pager, 'notebook.text.color', '#c4554d'),
      ).toBe(true);
      const record = page.surface.objects['t1']! as unknown as Record<
        string,
        unknown
      >;
      expect(record.size).toBe(22);
      expect(record.color).toBe('#c4554d');
      expect(record.customFuture).toBe('keep-me');
      expect(record.appearance).toMatchObject({ customTrait: 'keep-too' });
      expect(pager.textSelectionState()).toMatchObject({
        size: 22,
        color: '#c4554d',
        style: 'body',
      });
      // Each write is one history gesture: undo color, then size.
      expect(pager.undo()).toBe(true);
      expect(page.surface.objects['t1']!.color).toBeUndefined();
      expect(pager.undo()).toBe(true);
      expect(page.surface.objects['t1']!.size).toBeUndefined();
      expect(pager.textSelectionState()).toMatchObject({
        size: 16,
        color: '#37352f',
      });
    } finally {
      pager.destroy();
      parent.remove();
    }
  });

  it('wraps unwrapped text with the fixed default (never measured)', () => {
    const { parent, model, pager } = mountWithText((m) =>
      seedText(m, 'p1', 't1'),
    );
    try {
      const page = model.pages.p1;
      if (page?.kind !== 'page') throw new Error('expected a page');
      pager.setSelection(['t1']);
      expect(pager.textSelectionState()).toMatchObject({
        wrap: { active: false, mixed: false },
      });
      expect(
        executeNotebookTextControl(pager, 'notebook.text.wrap', undefined),
      ).toBe(true);
      expect(
        (page.surface.objects['t1']! as unknown as Record<string, unknown>)
          .appearance,
      ).toMatchObject({ wrapWidth: 240 });
      expect(pager.textSelectionState()).toMatchObject({
        wrap: { active: true, mixed: false },
      });
    } finally {
      pager.destroy();
      parent.remove();
    }
  });
});
