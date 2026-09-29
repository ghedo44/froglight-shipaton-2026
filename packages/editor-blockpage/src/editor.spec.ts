/**
 * Tiptap adapter conformance at the provider seam (checklist):
 * every interaction is driven through public surface only —
 * blockCommand / execCommand / real DOM events — never editor internals.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  InMemoryBlockRegistry,
  InMemoryCompositionRegistry,
  calloutBlock,
  codeBlock,
  dividerBlock,
  emptyBlockPage,
  headingBlock,
  listBlock,
  paragraphBlock,
  tableBlock,
  toggleBlock,
  resourceEmbedBlock,
  resourceLinkBlock,
  linkedViewBlock,
  documentKindId,
  type CompositionRegistry,
  type CompositionPresenter,
  type ResourceResolver,
  type ResourceTarget,
  type BlockPageEditorHandle,
  type BlockPageModel,
} from '@froglight/foundation';
import { BlockPageDocumentEditorProvider } from './editor.js';
import { HeadlessBlockpageEditorHandle } from './headless-handle.js';
import hostStyles from './react/BlockpageHost.module.css';

function fixture(): BlockPageModel {
  const model = emptyBlockPage({ title: 'Fixture', tags: [], properties: {} });
  model.rootOrder = ['h1', 'p1', 'c1', 'l1', 't1', 'x1'];
  model.blocks = {
    h1: headingBlock('h1', 1, [{ text: 'Title' }]),
    p1: paragraphBlock('p1', [
      { text: 'plain ' },
      { text: 'bold', marks: ['bold'] },
    ]),
    c1: codeBlock('c1', 'const x = 1;', 'js'),
    l1: listBlock('l1', false, [
      { runs: [{ text: 'one' }] },
      { runs: [{ text: 'two' }], checked: true },
    ]),
    t1: toggleBlock('t1', [{ text: 'more' }]),
    x1: {
      id: 'x1',
      type: 'acme.kanban',
      lanes: [1, 2],
      payload: { nested: [1, 2] },
    },
  };
  return model;
}

function mount(
  model: BlockPageModel,
  options?: {
    registry?: InMemoryBlockRegistry;
    resourceResolver?: ResourceResolver;
    compositionRegistry?: CompositionRegistry;
    compositionPresenter?: CompositionPresenter;
    openResource?: (target: ResourceTarget) => void;
  },
) {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  let latest: BlockPageModel | null = null;
  const handle: BlockPageEditorHandle =
    new BlockPageDocumentEditorProvider().createEditor({
      session: {} as never,
      parent,
      initialModel: model,
      onDirtyModel: (next) => {
        latest = next;
      },
      ...(options?.registry !== undefined
        ? { blockRegistry: options.registry }
        : {}),
      ...(options?.resourceResolver !== undefined
        ? { resourceResolver: options.resourceResolver }
        : {}),
      ...(options?.compositionRegistry !== undefined
        ? { compositionRegistry: options.compositionRegistry }
        : {}),
      ...(options?.compositionPresenter !== undefined
        ? { compositionPresenter: options.compositionPresenter }
        : {}),
      ...(options?.openResource !== undefined
        ? { openResource: options.openResource }
        : {}),
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

function type(env: ReturnType<typeof mount>, text: string): void {
  if (!command(env, 'insert-text', { text }))
    throw new Error('insert-text failed');
}

function pressKey(env: ReturnType<typeof mount>, key: string): void {
  env
    .pm()
    .dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
    );
}

function pointer(
  type: string,
  options: {
    pointerType: string;
    pointerId?: number;
    clientX?: number;
    clientY?: number;
  },
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries(options))
    Object.defineProperty(event, key, { value });
  return event;
}

const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 4));

describe('blockpage tiptap adapter — mount & sync', () => {
  afterEach(() => {
    document.body.replaceChildren();
    document.getElementById('flbp-chrome-styles')?.remove();
  });

  it('owns one wrapper without leaking provider classes or siblings into the pane host', () => {
    const env = mount(fixture());
    expect(env.parent.children).toHaveLength(1);
    expect(
      env.parent.classList.contains(hostStyles['froglight-blockpage']),
    ).toBe(false);
    expect(env.parent.firstElementChild?.classList).toContain(
      hostStyles['froglight-blockpage'],
    );

    env.handle.destroy();

    expect(env.parent.children).toHaveLength(0);
    expect(env.parent.className).toBe('');
    env.parent.remove();
  });

  it('renders core families plus opaque wrappers without emitting a dirty model', () => {
    const env = mount(fixture());
    try {
      expect(env.latest()).toBeNull();
      expect(
        env.pm().querySelector('h1[data-block-id="h1"]')?.textContent,
      ).toContain('Title');
      expect(
        env.pm().querySelectorAll('[data-block-id],[data-list-id]').length,
      ).toBeGreaterThanOrEqual(6);
      const opaque = env.pm().querySelector<HTMLElement>('.flbp-opaque');
      expect(opaque?.dataset.typeId).toBe('acme.kanban');
      const payload = JSON.parse(
        opaque!.querySelector('script')!.textContent ?? '{}',
      );
      expect(payload.lanes).toEqual([1, 2]);
      // Checked list item renders as a to-do row.
      expect(env.pm().querySelector('li[data-checked="true"]')).not.toBeNull();
    } finally {
      env.cleanup();
    }
  });

  it('folds typed edits into the canonical model without touching other records', () => {
    const env = mount(fixture());
    try {
      const p1Start = env.pm().querySelector('[data-block-id="p1"]')!;
      expect(p1Start).not.toBeNull();
      // p1 follows h1 ('Title' = 7 positions); its text starts at 8.
      const end = 8 + 'plain bold'.length;
      command(env, 'set-selection', { from: 8, to: end });
      type(env, 'rewritten');
      const next = env.latest();
      expect(next?.blocks.p1?.runs).toEqual([{ text: 'rewritten' }]);
      expect(next?.blocks.h1).toEqual(fixture().blocks.h1);
      expect(next?.blocks.x1).toEqual(fixture().blocks.x1);
    } finally {
      env.cleanup();
    }
  });

  it('keeps unknown fields on an edited core record', () => {
    const model = emptyBlockPage();
    model.vendorDocumentField = { keep: 'root' };
    model.rootOrder = ['p1'];
    model.blocks = {
      p1: {
        id: 'p1',
        type: 'froglight.paragraph',
        runs: [{ text: 'before' }],
        vendorTag: { keep: true },
      },
    };
    const env = mount(model);
    try {
      expect(command(env, 'set-selection', { from: 7, to: 7 })).toBe(true);
      type(env, ' after');
      expect(env.handle.getModelForTest!().blocks['p1']).toEqual({
        id: 'p1',
        type: 'froglight.paragraph',
        runs: [{ text: 'before after' }],
        vendorTag: { keep: true },
      });
      expect(env.handle.getModelForTest!().vendorDocumentField).toEqual({
        keep: 'root',
      });
    } finally {
      env.cleanup();
    }
  });
});

describe('blockpage tiptap adapter — structural editing', () => {
  afterEach(() => {
    document.body.replaceChildren();
    document.getElementById('flbp-chrome-styles')?.remove();
  });

  function twoParas(): BlockPageModel {
    const model = emptyBlockPage();
    model.rootOrder = ['a', 'b'];
    model.blocks = {
      a: paragraphBlock('a', [{ text: 'alpha' }]),
      b: paragraphBlock('b', [{ text: 'beta' }]),
    };
    return model;
  }

  it('Enter splits a paragraph at the cursor', () => {
    const env = mount(twoParas());
    try {
      command(env, 'set-selection', { from: 1 + 2 }); // inside 'alpha' after 'al'
      pressKey(env, 'Enter');
      const next = env.latest();
      expect(next?.rootOrder.length).toBe(3);
      const first = next!.blocks[next!.rootOrder[0]!]! as unknown as {
        runs: Array<{ text: string }>;
      };
      expect(first.runs[0]?.text).toBe('al');
    } finally {
      env.cleanup();
    }
  });

  it('Backspace at block start merges into the previous block', () => {
    const env = mount(twoParas());
    try {
      command(env, 'set-selection', { from: 1 + 'alpha'.length + 1 }); // pos 7 = b's opening token
      command(env, 'set-selection', { from: 8 }); // first character of 'beta'
      pressKey(env, 'Backspace');
      const next = env.latest();
      expect(next?.rootOrder.length).toBe(1);
      const merged = next!.blocks[next!.rootOrder[0]!]! as unknown as {
        runs: Array<{ text: string }>;
      };
      expect(merged.runs.map((r) => r.text).join('')).toBe('alphabeta');
    } finally {
      env.cleanup();
    }
  });

  it('moves blocks to exact toggle child positions and rejects ordinary nesting', () => {
    const model = twoParas();
    model.rootOrder = ['t', 'a', 'b'];
    model.blocks.t = {
      id: 't', type: 'froglight.toggle', runs: [{ text: 'Tasks' }], children: ['c'],
    };
    model.blocks.c = paragraphBlock('c', [{ text: 'existing child' }]);
    const env = mount(model);
    try {
      expect(command(env, 'move-block-under', { blockId: 'b', parentId: 'a' })).toBe(false);
      expect(command(env, 'move-block-under', { blockId: 'b', parentId: 't', index: 1 })).toBe(true);
      expect(env.handle.getModelForTest!().blocks.t?.children).toEqual(['b', 'c']);
      expect(command(env, 'move-block-under', { blockId: 'a', parentId: 't', index: 3 })).toBe(true);
      expect(env.handle.getModelForTest!().blocks.t?.children).toEqual(['b', 'c', 'a']);
      expect(command(env, 'move-block-under', { blockId: 'b', parentId: 't', index: 3 })).toBe(true);
      expect(env.handle.getModelForTest!().blocks.t?.children).toEqual(['c', 'b', 'a']);
    } finally {
      env.cleanup();
    }
  });



  it('reorders blocks through move-block', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['p1', 'p2', 'p3'];
    model.blocks = {
      p1: paragraphBlock('p1', [{ text: 'one' }]),
      p2: paragraphBlock('p2', [{ text: 'two' }]),
      p3: paragraphBlock('p3', [{ text: 'three' }]),
    };
    const env = mount(model);
    try {
      expect(command(env, 'move-block', { blockId: 'p3', index: 0 })).toBe(
        true,
      );
      expect(env.latest()?.rootOrder).toEqual(['p3', 'p1', 'p2']);
    } finally {
      env.cleanup();
    }
  });

  it('moves the first block to the final root slot without nesting or losing content', () => {
    const env = mount(twoParas());
    try {
      expect(command(env, 'move-block', { blockId: 'a', index: 2 })).toBe(true);
      const next = env.handle.getModelForTest!();
      expect(next.rootOrder).toEqual(['b', 'a']);
      expect(next.blocks.a?.runs).toEqual([{ text: 'alpha' }]);
      expect(next.blocks.b?.runs).toEqual([{ text: 'beta' }]);
    } finally {
      env.cleanup();
    }
  });





  it('moves a nested block back to the root with its subtree intact', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['a'];
    model.blocks = {
      a: { ...paragraphBlock('a', [{ text: 'alpha' }]), children: ['b'] },
      b: { ...paragraphBlock('b', [{ text: 'beta' }]), children: ['c'] },
      c: paragraphBlock('c', [{ text: 'gamma' }]),
    };
    const env = mount(model);
    try {
      expect(command(env, 'move-block', { blockId: 'b', index: 2 })).toBe(true);
      const next = env.handle.getModelForTest!();
      expect(next.rootOrder).toEqual(['a', 'b']);
      expect(next.blocks.a?.children).toBeUndefined();
      expect(next.blocks.b?.children).toEqual(['c']);
    } finally {
      env.cleanup();
    }
  });

  it('centers the gutter handle and keeps document layout stable during drag', () => {
    const env = mount(twoParas());
    try {
      const host = env.parent.firstElementChild as HTMLElement;
      const pm = env.pm() as HTMLElement;
      const first = pm.querySelector('[data-block-id="a"]') as HTMLElement;
      const second = pm.querySelector('[data-block-id="b"]') as HTMLElement;
      host.getBoundingClientRect = () => ({
        x: 100,
        y: 50,
        left: 100,
        top: 50,
        right: 600,
        bottom: 500,
        width: 500,
        height: 450,
        toJSON: () => ({}),
      });
      pm.getBoundingClientRect = () => ({
        x: 200,
        y: 90,
        left: 200,
        top: 90,
        right: 600,
        bottom: 200,
        width: 400,
        height: 110,
        toJSON: () => ({}),
      });
      first.getBoundingClientRect = () => ({
        x: 220,
        y: 100,
        left: 220,
        top: 100,
        right: 580,
        bottom: 130,
        width: 360,
        height: 30,
        toJSON: () => ({}),
      });
      second.getBoundingClientRect = () => ({
        x: 220,
        y: 140,
        left: 220,
        top: 140,
        right: 580,
        bottom: 170,
        width: 360,
        height: 30,
        toJSON: () => ({}),
      });
      first.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      const handle = host.querySelector('.flbp-drag-handle') as HTMLElement;
      expect(handle.style.top).toBe('51px');
      expect(handle.style.left).toBe('84px');

      // The handle lives inside the scrolling host: after scrolling, its
      // absolute local coordinate must include scrollTop or it drifts away
      // from the hovered block. Tall blocks stay near their first line.
      host.scrollTop = 120;
      first.getBoundingClientRect = () => ({
        x: 220,
        y: 100,
        left: 220,
        top: 100,
        right: 580,
        bottom: 300,
        width: 360,
        height: 200,
        toJSON: () => ({}),
      });
      first.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      expect(handle.style.top).toBe('174px');
      expect(handle.style.left).toBe('84px');

      // Restore non-overlapping row geometry for the reorder portion. The
      // tall-block handle assertion above intentionally overlaps the second
      // synthetic row, which is not a valid drag layout.
      first.getBoundingClientRect = () => ({
        x: 220,
        y: 100,
        left: 220,
        top: 100,
        right: 580,
        bottom: 130,
        width: 360,
        height: 30,
        toJSON: () => ({}),
      });

      handle.dispatchEvent(pointer('pointerdown', {
        pointerType: 'mouse', pointerId: 1, clientX: 100, clientY: 100,
      }));
      handle.dispatchEvent(pointer('pointermove', {
        pointerType: 'mouse', pointerId: 1, clientX: 400, clientY: 180,
      }));
      expect(first.classList).toContain('flbp-drag-source');
      expect(document.querySelector('.flbp-drag-preview')).not.toBeNull();
      expect(host.querySelector('style[data-flbp-drag-layout]')).toBeNull();
      expect(first.style.transform).toBe('');
      handle.dispatchEvent(pointer('pointercancel', {
        pointerType: 'mouse', pointerId: 1,
      }));
      expect(host.querySelector('style[data-flbp-drag-layout]')).toBeNull();
      expect(document.querySelector('.flbp-drag-preview')).toBeNull();
    } finally {
      env.cleanup();
    }
  });





  it('undo/redo converge through provider-local history', () => {
    const env = mount(twoParas());
    try {
      const before = env.handle.getModelForTest!();
      expect(command(env, 'insert-block', { type: 'divider' })).toBe(true);
      expect(env.handle.getModelForTest!().rootOrder.length).toBe(3);
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!().rootOrder.length).toBe(2);
      expect(env.handle.getModelForTest!()).toEqual(before);
      expect(env.handle.execCommand('redo')).toBe(true);
      expect(env.handle.getModelForTest!().rootOrder.length).toBe(3);
    } finally {
      env.cleanup();
    }
  });
});

describe('blockpage tiptap adapter — markdown input rules', () => {
  afterEach(() => {
    document.body.replaceChildren();
    document.getElementById('flbp-chrome-styles')?.remove();
  });

  function seededWith(text: string): BlockPageModel {
    const model = emptyBlockPage();
    model.rootOrder = ['p0'];
    model.blocks = { p0: paragraphBlock('p0', [{ text }]) };
    return model;
  }

  it('"# " turns a paragraph into a heading', () => {
    const env = mount(seededWith(''));
    try {
      command(env, 'set-selection', { from: 1 });
      type(env, '# ');
      expect(
        Object.values(env.latest()?.blocks ?? {}).map((b) => b.type),
      ).toContain('froglight.heading');
      // adapter: the conversion carries the source block id (no
      // nb-N churn) and is a single undo unit restoring the trigger text.
      const next = env.handle.getModelForTest!();
      expect(next.rootOrder).toEqual(['p0']);
      expect(next.blocks['p0']).toMatchObject({
        type: 'froglight.heading',
        level: 1,
      });
    } finally {
      env.cleanup();
    }
  });

  it('"- " turns a paragraph into a list', () => {
    const env = mount(seededWith(''));
    try {
      command(env, 'set-selection', { from: 1 });
      type(env, '- ');
      expect(
        Object.values(env.latest()?.blocks ?? {}).map((b) => b.type),
      ).toContain('froglight.list');
      // adapter: one list block with a single empty item; one undo
      // restores the trigger-only paragraph.
      const next = env.handle.getModelForTest!();
      const lists = Object.values(next.blocks).filter(
        (b) => b.type === 'froglight.list',
      );
      expect(lists).toHaveLength(1);
      expect(env.handle.execCommand('undo')).toBe(true);
      // Whole-string channel: trigger and conversion share one transaction,
      // so undo restores the pristine empty paragraph.
      expect(env.handle.getModelForTest!().blocks['p0']).toMatchObject({
        type: 'froglight.paragraph',
        runs: [{ text: '' }],
      });
    } finally {
      env.cleanup();
    }
  });

  it('"> " turns a paragraph into a quote and "---" inserts a divider', () => {
    const env = mount(seededWith(''));
    try {
      command(env, 'set-selection', { from: 1 });
      type(env, '> ');
      expect(
        Object.values(env.latest()?.blocks ?? {}).map((b) => b.type),
      ).toContain('froglight.quote');
      // adapter: the quote inherits the source block id.
      expect(env.handle.getModelForTest!().rootOrder).toEqual(['p0']);

      // Leave the quote below it, then draw a thematic break.
      command(env, 'insert-block', { type: 'divider' });
      expect(
        Object.values(env.latest()?.blocks ?? {}).map((b) => b.type),
      ).toContain('froglight.divider');
    } finally {
      env.cleanup();
    }
  });

  it('"---" typed at block start converts to a divider', () => {
    const env = mount(seededWith(''));
    try {
      command(env, 'set-selection', { from: 1 });
      for (const ch of '---') type(env, ch);
      const next = env.handle.getModelForTest!();
      expect(next.blocks[next.rootOrder[0]!]).toMatchObject({
        id: 'p0',
        type: 'froglight.divider',
      });
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!().blocks['p0']).toMatchObject({
        type: 'froglight.paragraph',
        runs: [{ text: '--' }],
      });
    } finally {
      env.cleanup();
    }
  });
});

describe('blockpage tiptap adapter — slash menu', () => {
  afterEach(() => {
    document.body.replaceChildren();
    document.getElementById('flbp-chrome-styles')?.remove();
  });

  it('opens on "/", filters, and applies the active entry', async () => {
    const model = emptyBlockPage();
    model.rootOrder = ['p1'];
    model.blocks = { p1: paragraphBlock('p1', [{ text: '' }]) };
    const env = mount(model);
    try {
      type(env, '/');
      await flush();
      const menu = env.parent.querySelector('.flbp-slash')!;
      expect(menu.getAttribute('style')).toContain('block');

      type(env, 'headin');
      await flush();
      expect(menu.querySelectorAll('.flbp-slash-item').length).toBe(6);
      pressKey(env, 'ArrowDown');
      pressKey(env, 'ArrowDown');
      pressKey(env, 'Enter');
      const next = env.latest()!;
      expect(next.blocks[next.rootOrder[0]!]?.type).toBe('froglight.heading');
      expect(menu.getAttribute('style')).toContain('none');
    } finally {
      env.cleanup();
    }
  });

  it('lists trusted-tier registered block types from the registry', async () => {
    const registry = new InMemoryBlockRegistry();
    registry.register({ typeId: 'acme.board', version: 1 });
    const seeded = emptyBlockPage();
    seeded.rootOrder = ['p1'];
    seeded.blocks = { p1: paragraphBlock('p1', [{ text: '' }]) };
    const env = mount(seeded, { registry });
    try {
      type(env, '/');
      await flush();
      const labels = [...env.parent.querySelectorAll('.flbp-slash-item')].map(
        (el) => el.textContent,
      );
      expect(labels).toContain('acme.board');
      const boardItem = env.parent.querySelector(
        '.flbp-slash-item[data-index]',
      )!;
      void boardItem;
      const target = [...env.parent.querySelectorAll('.flbp-slash-item')].find(
        (el) => el.textContent === 'acme.board',
      )!;
      target.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const next = env.latest()!;
      const inserted = Object.values(next.blocks).find(
        (b) => b.type === 'acme.board',
      );
      expect(inserted).toBeDefined();
    } finally {
      env.cleanup();
    }
  });
});

describe('blockpage tiptap adapter — resource composition', () => {
  it('rebinds host configuration without invoking source writes and preserves unknown settings', async () => {
    const registry = new InMemoryCompositionRegistry();
    const opened: string[] = [];
    const invoke = vi.fn();
    registry.register({
      kindId: documentKindId('froglight.markdown'),
      roles: ['linked-view'],
      writeAuthority: 'source',
      open: (input) => {
        opened.push(input.viewId ?? '');
        return {
          snapshot: () => ({
            state: 'ready',
            presentation: { type: 'example', data: {} },
          }),
          onDidChange: () => ({
            dispose() {
              /* no-op test stub */
            },
          }),
          invoke,
          dispose() {
            /* no-op test stub */
          },
        };
      },
    });
    let configure: Parameters<CompositionPresenter['mount']>[0]['configure'];
    const model = emptyBlockPage();
    model.rootOrder = ['linked'];
    model.blocks.linked = linkedViewBlock('linked', suggestion.target, 'old', {
      overrides: { vendor: { keep: true } },
    });
    const env = mount(model, {
      compositionRegistry: registry,
      compositionPresenter: {
        mount: (input) => {
          configure = input.configure;
          return {
            update() {
              /* no-op test stub */
            },
            dispose() {
              /* no-op test stub */
            },
          };
        },
      },
    });
    try {
      await flush();
      expect(configure).toBeTypeOf('function');
      configure?.({
        viewId: 'new',
        overrides: {
          vendor: { keep: true },
          filters: [{ property: '$title', operator: 'eq', value: 'Ada' }],
        },
      });
      await flush();
      expect(env.latest()?.blocks.linked).toMatchObject({
        viewId: 'new',
        overrides: {
          vendor: { keep: true },
          filters: [{ property: '$title', operator: 'eq', value: 'Ada' }],
        },
      });
      expect(opened).toEqual(['old', 'new']);
      expect(invoke).not.toHaveBeenCalled();
      env.handle.setReadOnly?.(true);
      expect(() => configure?.({ viewId: 'blocked' })).toThrow(/read-only/);
    } finally {
      env.cleanup();
    }
  });
  it('propagates read-only changes to an already mounted presentation', async () => {
    const registry = new InMemoryCompositionRegistry();
    registry.register({
      kindId: documentKindId('froglight.markdown'),
      roles: ['preview'],
      writeAuthority: 'none',
      open: () => ({
        snapshot: () => ({
          state: 'ready',
          presentation: { type: 'example', data: {} },
        }),
        onDidChange: () => ({
          dispose() {
            /* no-op test stub */
          },
        }),
        dispose() {
          /* no-op test stub */
        },
      }),
    });
    const update = vi.fn();
    const dispose = vi.fn();
    const model = emptyBlockPage();
    model.rootOrder = ['e'];
    model.blocks.e = resourceEmbedBlock('e', suggestion.target);
    const env = mount(model, {
      compositionRegistry: registry,
      compositionPresenter: { mount: () => ({ update, dispose }) },
    });
    try {
      await flush();
      env.handle.setReadOnly?.(true);
      expect(update).toHaveBeenLastCalledWith(
        expect.objectContaining({ state: 'ready' }),
        true,
      );
      env.handle.setReadOnly?.(false);
      expect(update).toHaveBeenLastCalledWith(
        expect.objectContaining({ state: 'ready' }),
        false,
      );
    } finally {
      env.cleanup();
    }
    expect(dispose).toHaveBeenCalledTimes(1);
  });
  afterEach(() => {
    document.body.replaceChildren();
    document.getElementById('flbp-chrome-styles')?.remove();
  });

  const suggestion = {
    target: {
      documentId: 'doc-target',
      kindId: 'froglight.markdown',
      resourceId: 'res-target',
    },
    label: 'Target note',
    addresses: [{ address: 'details', label: 'Details' }],
  };

  it('resolves `[[` and `@` only through explicit keyboard selection into stable marks', async () => {
    for (const trigger of ['[[', '@']) {
      const model = emptyBlockPage();
      model.rootOrder = ['p1'];
      model.blocks = { p1: paragraphBlock('p1', [{ text: '' }]) };
      const env = mount(model, {
        resourceResolver: { search: () => [suggestion] },
      });
      try {
        type(env, `${trigger}Tar`);
        await flush();
        const menu = env.parent.querySelector<HTMLElement>(
          '.flbp-resource-menu',
        )!;
        expect(menu.style.display).toBe('block');
        pressKey(env, 'Enter');
        const result = env.handle.getModelForTest!();
        const run = result.blocks[result.rootOrder[0]!]?.runs as Array<{
          text: string;
          marks?: unknown[];
        }>;
        expect(run).toEqual([
          {
            text: 'Target note',
            marks: [{ type: 'resource', target: suggestion.target }],
          },
        ]);
      } finally {
        env.cleanup();
      }
    }
  });

  it('keeps unresolved autocomplete input as ordinary canonical text', async () => {
    const model = emptyBlockPage();
    model.rootOrder = ['p1'];
    model.blocks = { p1: paragraphBlock('p1', [{ text: '' }]) };
    const env = mount(model, { resourceResolver: { search: () => [] } });
    try {
      type(env, '[[Missing');
      await flush();
      pressKey(env, 'Escape');
      const result = env.handle.getModelForTest!();
      expect(result.blocks[result.rootOrder[0]!]?.runs).toEqual([
        { text: '[[Missing' },
      ]);
    } finally {
      env.cleanup();
    }
  });

  it('navigates inline resources and resource-link blocks through stable targets', () => {
    const openResource = vi.fn();
    const model = emptyBlockPage();
    model.rootOrder = ['p', 'link'];
    model.blocks.p = paragraphBlock('p', [
      {
        text: 'Target',
        marks: [{ type: 'resource', target: suggestion.target }],
      },
    ]);
    model.blocks.link = resourceLinkBlock(
      'link',
      suggestion.target,
      'Target card',
    );
    const env = mount(model, { openResource });
    try {
      env.parent.querySelector<HTMLElement>('[data-flbp-resource]')!.click();
      env.parent.querySelector<HTMLElement>('[data-flbp-composition]')!.click();
      expect(openResource).toHaveBeenNthCalledWith(1, suggestion.target);
      expect(openResource).toHaveBeenNthCalledWith(2, suggestion.target);
    } finally {
      env.cleanup();
    }
  });

  it('inserts all composition record kinds through the structured command and lazily renders provider snapshots', async () => {
    const registry = new InMemoryCompositionRegistry();
    const invoke = vi.fn();
    registry.register({
      kindId: documentKindId('froglight.markdown'),
      roles: ['preview', 'transclusion'],
      writeAuthority: 'none',
      open: () => ({
        snapshot: () => ({
          state: 'ready',
          title: 'Provider title',
          summary: 'Read-only source',
          image: {
            mimeType: 'image/png',
            dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
            alt: 'Source preview',
            width: 640,
            height: 480,
          },
        }),
        onDidChange: () => ({
          dispose() {
            /* deterministic static mock */
          },
        }),
        dispose() {
          /* deterministic static mock */
        },
      }),
    });
    registry.register({
      kindId: documentKindId('acme.database'),
      roles: ['linked-view'],
      writeAuthority: 'source',
      open: () => ({
        snapshot: () => ({
          state: 'ready',
          title: 'Board',
          items: [
            {
              id: 'row-1',
              text: 'Task',
              actions: [
                { id: 'complete', label: 'Complete task', authority: 'source' },
              ],
            },
          ],
        }),
        onDidChange: () => ({
          dispose() {
            /* deterministic static mock */
          },
        }),
        invoke,
        dispose() {
          /* deterministic static mock */
        },
      }),
    });
    const model = emptyBlockPage();
    model.rootOrder = ['e'];
    model.blocks.e = resourceEmbedBlock('e', suggestion.target, {
      label: 'Preview',
    });
    const env = mount(model, { compositionRegistry: registry });
    try {
      await flush();
      expect(
        env.parent.querySelector('[data-flbp-composition]')?.textContent,
      ).toContain('Provider title');
      const image = env.parent.querySelector<HTMLImageElement>(
        '.flbp-composition-image',
      );
      expect(image?.alt).toBe('Source preview');
      expect(image?.width).toBe(640);
      expect(
        command(env, 'insert-block', {
          type: 'resource-link',
          target: suggestion.target,
          label: 'Link',
        }),
      ).toBe(true);
      expect(
        command(env, 'insert-block', {
          type: 'transclusion',
          target: { ...suggestion.target, address: 'details' },
          label: 'Details',
        }),
      ).toBe(true);
      expect(
        command(env, 'insert-block', {
          type: 'linked-view',
          target: { ...suggestion.target, kindId: 'acme.database' },
          label: 'Board',
          viewId: 'view-1',
        }),
      ).toBe(true);
      await flush();
      const linkedAction = [
        ...env.parent.querySelectorAll<HTMLButtonElement>(
          '.flbp-composition button',
        ),
      ].find((button) => button.textContent === 'Complete task');
      expect(linkedAction).toBeDefined();
      linkedAction!.focus();
      linkedAction!.click();
      expect(invoke).toHaveBeenCalledWith('complete', { itemId: 'row-1' });
      const types = Object.values(env.handle.getModelForTest!().blocks).map(
        (block) => block.type,
      );
      expect(types).toEqual(
        expect.arrayContaining([
          'froglight.resource-embed',
          'froglight.resource-link',
          'froglight.transclusion',
          'froglight.linked-view',
        ]),
      );
    } finally {
      env.cleanup();
    }
  });
});

describe('blockpage tiptap adapter — semantic document tools', () => {
  afterEach(() => {
    document.body.replaceChildren();
    document.getElementById('flbp-chrome-styles')?.remove();
  });

  it('opens, edits, and remounts canonical external-link marks', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['p1'];
    model.blocks = {
      p1: paragraphBlock('p1', [
        {
          text: 'linked text',
          marks: [{ type: 'link', href: 'https://example.invalid' }],
        },
        { text: ' and plain text' },
      ]),
    };
    const env = mount(model);
    try {
      expect(env.pm().textContent).toBe('linked text and plain text');
      expect(env.pm().querySelector('a')?.getAttribute('href')).toBe(
        'https://example.invalid',
      );

      const tools = env.handle.tools;
      if (tools === undefined)
        throw new Error('semantic tools are unavailable');
      command(env, 'set-selection', { from: 1, to: 12 });
      expect(tools.execute('block.link', 'https://edited.invalid')).toBe(true);
      const edited = env.handle.getModelForTest!();
      expect(edited.blocks.p1).toMatchObject({
        runs: [
          {
            text: 'linked text',
            marks: [{ type: 'link', href: 'https://edited.invalid' }],
          },
          { text: ' and plain text' },
        ],
      });

      const reopened = mount(edited);
      try {
        expect(reopened.pm().textContent).toBe('linked text and plain text');
        expect(reopened.pm().querySelector('a')?.getAttribute('href')).toBe(
          'https://edited.invalid',
        );
      } finally {
        reopened.cleanup();
      }
    } finally {
      env.cleanup();
    }
  });

  it('reports selection-aware controls and applies bold/link marks', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['p1'];
    model.blocks = { p1: paragraphBlock('p1', [{ text: 'hello world' }]) };
    const env = mount(model);
    try {
      const tools = env.handle.tools;
      if (tools === undefined)
        throw new Error('semantic tools are unavailable');
      command(env, 'set-selection', { from: 1, to: 6 });
      expect(tools.snapshot().context).toBe('Paragraph');
      expect(
        tools
          .snapshot()
          .controls.some((control) => control.id === 'block.link'),
      ).toBe(true);

      expect(tools.execute('block.bold')).toBe(true);
      const marked = env.latest()?.blocks.p1 as unknown as {
        runs: Array<{ text: string; marks?: string[] }>;
      };
      expect(marked.runs.some((run) => run.marks?.includes('bold'))).toBe(true);
      // Toolbar edits participate in provider-local history like typing.
      expect(env.handle.execCommand('undo')).toBe(true);
      const undone = env.handle.getModelForTest!();
      expect(
        (
          undone.blocks.p1 as unknown as { runs: Array<{ marks?: string[] }> }
        ).runs.some((run) => run.marks?.includes('bold')),
      ).toBe(false);
      expect(env.handle.execCommand('redo')).toBe(true);

      expect(tools.execute('block.link', 'https://froglight.test')).toBe(true);
      const linked = env.latest()?.blocks.p1 as unknown as {
        runs: Array<{
          marks?: Array<string | { type: string; href?: string }>;
        }>;
      };
      expect(
        linked.runs.some((run) =>
          (run.marks ?? []).some(
            (mark) => typeof mark === 'object' && mark.type === 'link',
          ),
        ),
      ).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  it('reports conservative active/mixed mark state like the Markdown provider', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['p1'];
    model.blocks = {
      p1: paragraphBlock('p1', [
        { text: 'plain ' },
        { text: 'bold', marks: ['bold'] },
        { text: ' tail' },
      ]),
    };
    const env = mount(model);
    try {
      const tools = env.handle.tools;
      if (tools === undefined)
        throw new Error('semantic tools are unavailable');
      const button = (id: string) => {
        const control = tools
          .snapshot()
          .controls.find((candidate) => candidate.id === id);
        if (control?.kind !== 'button')
          throw new Error(`missing button control ${id}`);
        return control;
      };
      // ProseMirror positions: text starts at 1; 'bold' spans 7..11.
      // Caret inside the bold run: active, never mixed.
      command(env, 'set-selection', { from: 8, to: 8 });
      expect(button('block.bold').active).toBe(true);
      expect(button('block.bold').mixed).toBeUndefined();
      expect(button('block.italic').active).toBeUndefined();
      // Selection covering only the bold run: active, not mixed.
      command(env, 'set-selection', { from: 7, to: 11 });
      expect(button('block.bold').active).toBe(true);
      expect(button('block.bold').mixed).toBeUndefined();
      // Selection spanning plain and bold text: mixed, never active.
      command(env, 'set-selection', { from: 1, to: 11 });
      expect(button('block.bold').active).toBeUndefined();
      expect(button('block.bold').mixed).toBe(true);
      expect(button('block.italic').mixed).toBeUndefined();
    } finally {
      env.cleanup();
    }
  });

  it('marks writing format toggles as toggle activationRole (exclusive-tool exclusion)', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['p1'];
    model.blocks = { p1: paragraphBlock('p1', [{ text: 'hello world' }]) };
    const env = mount(model);
    try {
      const tools = env.handle.tools;
      if (tools === undefined)
        throw new Error('semantic tools are unavailable');
      command(env, 'set-selection', { from: 1, to: 6 });
      const snapshot = tools.snapshot();
      for (const id of [
        'block.bold',
        'block.italic',
        'block.strike',
        'block.code',
      ]) {
        const control = snapshot.controls.find((c) => c.id === id);
        if (control?.kind !== 'button') throw new Error(`missing button ${id}`);
        expect(control.activationRole).toBe('toggle');
      }
      // Link is kind input: no activationRole field; the shared
      // exclusive-tool matcher already excludes non-button kinds.
      const link = snapshot.controls.find((c) => c.id === 'block.link');
      expect(link?.kind).toBe('input');
      expect('activationRole' in (link as Record<string, unknown>)).toBe(false);
    } finally {
      env.cleanup();
    }
  });

  it('exposes link as a compact popover trigger with prefill and active state', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['p1'];
    model.blocks = { p1: paragraphBlock('p1', [{ text: 'hello world' }]) };
    const env = mount(model);
    try {
      const tools = env.handle.tools;
      if (tools === undefined)
        throw new Error('semantic tools are unavailable');
      const inputOf = () => {
        const control = tools
          .snapshot()
          .controls.find((candidate) => candidate.id === 'block.link');
        if (control?.kind !== 'input')
          throw new Error('missing input control block.link');
        return control;
      };
      // Range selection: compact trigger, no permanent value yet.
      command(env, 'set-selection', { from: 1, to: 6 });
      const trigger = inputOf();
      expect(trigger.label).toBe('Link destination');
      expect(trigger.icon).toBe('link');
      expect(trigger.placeholder).toBe('https://…');
      expect(trigger.actionLabel).toBe('Link');
      expect(trigger.value).toBeUndefined();
      expect(trigger.active).toBeUndefined();

      // Create the link, then caret inside it exposes prefill + active.
      expect(tools.execute('block.link', 'https://froglight.test')).toBe(true);
      // Selection collapses after setMark; move caret inside the linked run.
      command(env, 'set-selection', { from: 3, to: 3 });
      const editing = inputOf();
      expect(editing.value).toBe('https://froglight.test');
      expect(editing.active).toBe(true);

      // Caret edit updates the destination in place; label untouched.
      expect(tools.execute('block.link', 'https://edited.test')).toBe(true);
      const relinked = env.latest()?.blocks.p1 as unknown as {
        runs: Array<{
          text: string;
          marks?: Array<string | { type: string; href?: string }>;
        }>;
      };
      expect(
        relinked.runs.some((run) =>
          (run.marks ?? []).some(
            (mark) =>
              typeof mark === 'object' &&
              mark.type === 'link' &&
              mark.href === 'https://edited.test',
          ),
        ),
      ).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  it('suppresses incompatible controls in code blocks through provider data', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['c1'];
    model.blocks = { c1: codeBlock('c1', 'const x = 1;', 'js') };
    const env = mount(model);
    try {
      const tools = env.handle.tools;
      if (tools === undefined)
        throw new Error('semantic tools are unavailable');
      command(env, 'set-selection', { from: 2, to: 2 });
      const ids = tools.snapshot().controls.map((control) => control.id);
      expect(tools.snapshot().context).toBe('Code block');
      expect(ids).not.toContain('block.bold');
      expect(ids).not.toContain('block.italic');
      expect(ids).not.toContain('block.strike');
      expect(ids).not.toContain('block.code');
      expect(ids).not.toContain('block.link');
      // Structure stays: provider.enablement, not UI hard-coding.
      expect(ids).not.toContain('block.indent');
      expect(ids).not.toContain('block.outdent');
      // Execute refuses disabled-context transforms, not just the UI.
      expect(tools.execute('block.bold')).toBe(false);
      expect(tools.execute('block.link', 'https://froglight.test')).toBe(false);
    } finally {
      env.cleanup();
    }
  });

  it('suppresses inline formatting in special atom contexts', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['d1'];
    model.blocks = {
      d1: { id: 'd1', type: 'froglight.divider' },
    };
    const env = mount(model);
    try {
      const tools = env.handle.tools;
      if (tools === undefined)
        throw new Error('semantic tools are unavailable');
      // Divider-only doc: the initial selection lands on the atom (no
      // TextSelection positions exist). No inline actions; structure stays.
      const ids = tools.snapshot().controls.map((control) => control.id);
      expect(ids).not.toContain('block.bold');
      expect(ids).not.toContain('block.link');
      expect(ids).toContain('block.type');
      expect(ids).not.toContain('block.indent');
    } finally {
      env.cleanup();
    }
  });



  it('rejects empty or whitespace link destinations without mutating', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['p1'];
    model.blocks = { p1: paragraphBlock('p1', [{ text: 'keep me' }]) };
    const env = mount(model);
    try {
      const tools = env.handle.tools;
      if (tools === undefined)
        throw new Error('semantic tools are unavailable');
      command(env, 'set-selection', { from: 1, to: 5 });
      const before = env.handle.getModelForTest!();
      expect(tools.execute('block.link', '   ')).toBe(false);
      expect(tools.execute('block.link', 'https://a.test/x y')).toBe(false);
      expect(tools.execute('block.link')).toBe(false);
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
  });

  it('executes turn-into through the toolbar with provider semantics', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['p1'];
    model.blocks = { p1: paragraphBlock('p1', [{ text: 'Title' }]) };
    const env = mount(model);
    try {
      const tools = env.handle.tools;
      if (tools === undefined)
        throw new Error('semantic tools are unavailable');
      command(env, 'set-selection', { from: 2, to: 2 });
      expect(tools.execute('block.type', 'heading:2')).toBe(true);
      const next = env.handle.getModelForTest!();
      expect(next.blocks.p1?.type).toBe('froglight.heading');
      expect((next.blocks.p1 as { level?: number }).level).toBe(2);
      expect(tools.snapshot().context).toBe('Heading 2');
    } finally {
      env.cleanup();
    }
  });

  it('preserves unknown marks across unrelated toolbar edits', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['p1'];
    model.blocks = {
      p1: paragraphBlock('p1', [
        { text: 'plain ' },
        {
          text: 'mystery',
          marks: [{ type: 'acme.highlight', color: 'yellow' }],
        },
      ]),
    };
    const env = mount(model);
    try {
      const tools = env.handle.tools;
      if (tools === undefined)
        throw new Error('semantic tools are unavailable');
      const before = env.handle.getModelForTest!();
      // Bold the plain run; the unknown mark on the other run must survive.
      command(env, 'set-selection', { from: 1, to: 6 });
      expect(tools.execute('block.bold')).toBe(true);
      const after = env.handle.getModelForTest!();
      const runs = (
        after.blocks.p1 as unknown as {
          runs: Array<{ text: string; marks?: unknown[] }>;
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
      expect(after.blocks.p1?.type).toBe(before.blocks.p1?.type);
    } finally {
      env.cleanup();
    }
  });

  it('notifies tool listeners on selection and transaction changes', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['p1'];
    model.blocks = { p1: paragraphBlock('p1', [{ text: 'hello' }]) };
    const env = mount(model);
    try {
      const tools = env.handle.tools;
      if (tools === undefined)
        throw new Error('semantic tools are unavailable');
      let notifications = 0;
      const sub = tools.onDidChange(() => {
        notifications += 1;
      });
      command(env, 'set-selection', { from: 1, to: 3 });
      expect(notifications).toBeGreaterThan(0);
      const seen = notifications;
      command(env, 'set-selection', { from: 2, to: 4 });
      expect(notifications).toBeGreaterThan(seen);
      sub.dispose();
    } finally {
      env.cleanup();
    }
  });
});

describe('blockpage tiptap adapter — collapse chevrons', () => {
  afterEach(() => {
    document.body.replaceChildren();
    document.getElementById('flbp-chrome-styles')?.remove();
  });

  it('shows a chevron on toggles; collapsing stays out of canonical bytes', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['t1'];
    model.blocks = { t1: toggleBlock('t1', [{ text: 'summary' }]) };
    const env = mount(model);
    try {
      const chevron = env
        .pm()
        .querySelector<HTMLElement>('.flbp-chevron[data-target="t1"]');
      expect(chevron).not.toBeNull();
      const before = env.handle.getModelForTest!();
      chevron!.click();
      expect(
        env.pm().querySelector('.flbp-toggle')?.getAttribute('data-collapsed'),
      ).toBe('true');
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
  });
});

describe('blockpage tiptap adapter — opaque preservation', () => {
  afterEach(() => {
    document.body.replaceChildren();
    document.getElementById('flbp-chrome-styles')?.remove();
  });

  it('keeps plugin payloads byte-faithful across an editing session', () => {
    const model = fixture();
    model.blocks.x1 = { ...model.blocks.x1!, children: ['p9'] };
    model.blocks.p9 = paragraphBlock('p9', [{ text: 'inside plugin block' }]);
    const env = mount(model);
    try {
      expect(command(env, 'insert-block', { type: 'divider' })).toBe(true);
      const next = env.latest()!;
      expect(next.blocks.x1).toEqual(model.blocks.x1);
      expect(next.blocks.c1).toEqual(model.blocks.c1);
    } finally {
      env.cleanup();
    }
  });
});

describe('blockpage provider — missing/detached host fallback', () => {
  afterEach(() => {
    document.body.replaceChildren();
    document.getElementById('flbp-chrome-styles')?.remove();
  });

  it('mounts a visible fallback host when parent is not an element', () => {
    const handle = new BlockPageDocumentEditorProvider().createEditor({
      session: {} as never,
      parent: null,
      initialModel: fixture(),
      onDirtyModel: () => undefined,
    });
    try {
      const fallback = document.querySelector('.flbp-fallback-host')!;
      expect(fallback).not.toBeNull();
      expect(fallback.querySelector('.ProseMirror')).not.toBeNull();
    } finally {
      handle.destroy();
    }
    expect(document.querySelector('.flbp-fallback-host')).toBeNull();
  });

  it('mounts a visible fallback host when parent is detached from the document', () => {
    const detached = document.createElement('div');
    const handle = new BlockPageDocumentEditorProvider().createEditor({
      session: {} as never,
      parent: detached,
      initialModel: fixture(),
      onDirtyModel: () => undefined,
    });
    try {
      expect(
        document.querySelector('.flbp-fallback-host .ProseMirror'),
      ).not.toBeNull();
    } finally {
      handle.destroy();
    }
    expect(document.querySelector('.flbp-fallback-host')).toBeNull();
  });
});

describe('blockpage provider — shell host contract', () => {
  afterEach(() => {
    document.body.replaceChildren();
    document.getElementById('flbp-chrome-styles')?.remove();
  });

  it('tags its owned wrapper with the theme sizing class so the editor cannot collapse to zero width', () => {
    // The shell's `.editor-area` is a flex row; the colocated host module
    // sizes the writing surface through the `froglight-blockpage` wrapper
    // class (the same contract as the CodeMirror provider's host module).
    // If the class goes missing, `.ProseMirror` shrinks to max-content
    // width — an empty page renders 0px wide: a white pane with no errors.
    const parent = document.createElement('div');
    parent.className = 'editor-area fl-pane-editor';
    parent.style.display = 'flex';
    document.body.appendChild(parent);
    const handle = new BlockPageDocumentEditorProvider().createEditor({
      session: {} as never,
      parent,
      initialModel: fixture(),
      onDirtyModel: () => undefined,
    });
    try {
      const wrapper = parent.firstElementChild;
      expect(
        wrapper?.classList.contains(hostStyles['froglight-blockpage']),
      ).toBe(true);
      expect(wrapper?.classList.contains('flbp-host')).toBe(true);
      expect(parent.classList.contains(hostStyles['froglight-blockpage'])).toBe(
        false,
      );
      expect(parent.querySelector('.ProseMirror')).not.toBeNull();
    } finally {
      handle.destroy();
      parent.remove();
    }
  });
});

describe('headless blockpage handle', () => {
  function makeHandle() {
    let dirtyCount = 0;
    const handle = new HeadlessBlockpageEditorHandle({
      session: {} as never,
      parent: {},
      initialModel: fixture(),
      onDirtyModel: () => {
        dirtyCount += 1;
      },
    });
    return { handle, dirty: () => dirtyCount };
  }

  it('edits append and remove while preserving opaque records', () => {
    const { handle, dirty } = makeHandle();
    handle.appendParagraph('after');
    expect(handle.getModelForTest().rootOrder.at(-1)).not.toBe('x1');
    expect(handle.getModelForTest().blocks.x1).toEqual(fixture().blocks.x1);
    expect(dirty()).toBe(1);

    handle.deleteLastBlock();
    expect(handle.getModelForTest().rootOrder.length).toBe(6);
    expect(handle.canExecCommand('undo')).toBe(true);

    handle.execCommand('undo');
    expect(handle.getModelForTest().blocks.x1).toEqual(fixture().blocks.x1);
    expect(dirty()).toBe(3);
    expect(handle.canExecCommand('redo')).toBe(true);

    handle.destroy();
    expect(() => handle.appendParagraph('x')).toThrowError();
    expect(dirty()).toBe(3);
  });
});

// Keep unused imports referenced for strict TS.
void calloutBlock;
void dividerBlock;
void tableBlock;
