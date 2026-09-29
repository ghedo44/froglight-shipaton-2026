/**
 *  drag-handle turn-into menu: engine-owned overlay
 * reusing the slash catalog subset; keyboard/touch parity with slash; entry
 * executes the same #turnInto/#turnIntoList path as slash/toolbar.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
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

function singlePara(text: string): BlockPageModel {
  const model = emptyBlockPage();
  model.rootOrder = ['p1'];
  model.blocks = { p1: paragraphBlock('p1', [{ text }]) };
  return model;
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
  // Hover to retarget the gutter handle, then click it to open the menu.
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

/** Deterministic drag geometry (same column layout as editor.spec.ts). */
function mockColumnGeometry(env: ReturnType<typeof mount>): void {
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
}

function twoParas(): BlockPageModel {
  const model = emptyBlockPage();
  model.rootOrder = ['a', 'b'];
  model.blocks = {
    a: paragraphBlock('a', [{ text: 'alpha' }]),
    b: paragraphBlock('b', [{ text: 'beta' }]),
  };
  return model;
}

afterEach(() => {
  document.body.replaceChildren();
  document.getElementById('flbp-chrome-styles')?.remove();
});

describe('drag-handle turn-into menu', () => {
  it('keeps block actions short and deletes with one undo step', () => {
    const env = mount(twoParas());
    try {
      openMenuFor(env, 'a');
      const labels = [...env.menu()!.querySelectorAll('.flbp-slash-item')].map(
        (entry) => entry.textContent,
      );
      expect(labels).toEqual(['Turn into…', 'Move down', 'Delete block']);
      const before = env.handle.getModelForTest!();
      const remove = [...env.menu()!.querySelectorAll('.flbp-slash-item')].find(
        (entry) => entry.textContent === 'Delete block',
      );
      remove?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(env.handle.getModelForTest!().rootOrder).toEqual(['b']);
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
  });

  it('anchors contextual formatting to a text selection', () => {
    const env = mount(singlePara('hello'));
    try {
      expect(command(env, 'set-selection', { from: 1, to: 4 })).toBe(true);
      const tools = (
        env.handle as unknown as {
          tools: { snapshot(): { contextualAnchor?: unknown } };
        }
      ).tools;
      expect(tools.snapshot().contextualAnchor).toBeDefined();
    } finally {
      env.cleanup();
    }
  });

  it('uses the same slash catalog from the side add button', async () => {
    const env = mount(twoParas());
    try {
      const first = env.pm().querySelector('[data-block-id="a"]')!;
      first.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      const add = env.parent.querySelector(
        '.flbp-add-block',
      ) as HTMLButtonElement;
      expect(add.getAttribute('aria-label')).toBe('Add block');
      add.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const model = env.handle.getModelForTest!();
      expect(model.rootOrder).toHaveLength(3);
      expect(model.rootOrder[0]).toBe('a');
      expect(model.rootOrder[2]).toBe('b');
      expect(
        env.parent.querySelector('.flbp-slash')?.getAttribute('style'),
      ).toContain('block');
      expect(
        env.parent.querySelectorAll('.flbp-slash-item').length,
      ).toBeGreaterThan(10);
    } finally {
      env.cleanup();
    }
  });

  it('adds after an entire block subtree and reuses an empty block', async () => {
    const model = twoParas();
    model.blocks.a = { ...model.blocks.a!, children: ['child'] };
    model.blocks.child = paragraphBlock('child', [{ text: 'nested' }]);
    const env = mount(model);
    try {
      const first = env.pm().querySelector('[data-block-id="a"]')!;
      first.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      (env.parent.querySelector('.flbp-add-block') as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const after = env.handle.getModelForTest!();
      expect(after.rootOrder).toHaveLength(3);
      expect(after.blocks.a?.children).toEqual(['child']);
      expect(after.blocks.child).toMatchObject({ type: 'froglight.paragraph' });
    } finally {
      env.cleanup();
    }
    const empty = mount(singlePara(''));
    try {
      empty.pm().querySelector('[data-block-id="p1"]')?.dispatchEvent(
        new MouseEvent('mouseover', { bubbles: true }),
      );
      (empty.parent.querySelector('.flbp-add-block') as HTMLButtonElement).click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(empty.handle.getModelForTest!().rootOrder).toEqual(['p1']);
      expect(empty.parent.querySelector('.flbp-slash')?.getAttribute('style')).toContain('block');
    } finally {
      empty.cleanup();
    }
  });

  it('lists compatible transforms without the current no-op type', () => {
    const env = mount(singlePara('hello'));
    try {
      openMenuFor(env, 'p1', true);
      const menu = env.menu()!;
      expect(menu.style.display).toBe('block');
      expect(menu.getAttribute('role')).toBe('listbox');
      expect(menu.getAttribute('aria-label')).toBe('Block actions');
      const labels = [...menu.querySelectorAll('.flbp-slash-item')].map(
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
      expect(
        [...menu.querySelectorAll('.flbp-menu-group-label')].map(
          (el) => el.textContent,
        ),
      ).toEqual(['Turn into']);
      const active = menu.querySelector('.flbp-slash-item.active');
      expect(active?.getAttribute('role')).toBe('option');
      expect(menu.getAttribute('aria-activedescendant')).toBe(active?.id);
    } finally {
      env.cleanup();
    }
  });

  it('keeps the touch handle through compatibility mouseleave and restores mouse hover behavior', () => {
    const env = mount(twoParas());
    try {
      const host = env.parent.firstElementChild as HTMLElement;
      const block = env.pm().querySelector('[data-block-id="a"]')!;
      const handle = host.querySelector('.flbp-drag-handle')!;
      block.dispatchEvent(
        pointer('pointerdown', {
          pointerType: 'touch',
          clientX: 100,
          clientY: 100,
        }),
      );
      host.dispatchEvent(new MouseEvent('mouseleave'));
      expect(handle.classList.contains('visible')).toBe(true);
      host.dispatchEvent(pointer('pointerover', { pointerType: 'mouse' }));
      host.dispatchEvent(new MouseEvent('mouseleave'));
      expect(handle.classList.contains('visible')).toBe(false);
    } finally {
      env.cleanup();
    }
  });

  it('moves a block with its children and undoes in one step', () => {
    const model = twoParas();
    model.blocks.a = { ...model.blocks.a!, children: ['child'] };
    model.blocks.child = paragraphBlock('child', [{ text: 'preserved child' }]);
    const env = mount(model);
    try {
      openMenuFor(env, 'a');
      const move = [...env.menu()!.querySelectorAll('[role="option"]')].find(
        (item) => item.textContent === 'Move down',
      )!;
      move.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const after = env.handle.getModelForTest!();
      expect(after.rootOrder).toEqual(['b', 'a']);
      expect(after.blocks.a).toEqual(model.blocks.a);
      expect(after.blocks.child).toEqual(model.blocks.child);
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!().rootOrder).toEqual(['a', 'b']);
      expect(env.handle.execCommand('redo')).toBe(true);
      expect(env.handle.getModelForTest!().rootOrder).toEqual(['b', 'a']);
    } finally {
      env.cleanup();
    }
  });

  it('moves nested siblings without extracting them from their parent', () => {
    const model = twoParas();
    model.blocks.a = { ...model.blocks.a!, children: ['child1', 'child2'] };
    model.blocks.child1 = paragraphBlock('child1', [{ text: 'first child' }]);
    model.blocks.child2 = paragraphBlock('child2', [{ text: 'second child' }]);
    const env = mount(model);
    try {
      openMenuFor(env, 'child2');
      const move = [...env.menu()!.querySelectorAll('[role="option"]')].find(
        (item) => item.textContent === 'Move up',
      )!;
      move.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const after = env.handle.getModelForTest!();
      expect(after.rootOrder).toEqual(['a', 'b']);
      expect(after.blocks.a!.children).toEqual(['child2', 'child1']);
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!().blocks.a!.children).toEqual([
        'child1',
        'child2',
      ]);
    } finally {
      env.cleanup();
    }
  });

  it('click commits through the same path as slash/toolbar', () => {
    const env = mount(singlePara('hello world'));
    try {
      openMenuFor(env, 'p1', true);
      const before = env.handle.getModelForTest!();
      const item = [...env.menu()!.querySelectorAll('.flbp-slash-item')].find(
        (el) => el.textContent === 'Heading 2',
      )!;
      item.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const next = env.handle.getModelForTest!();
      expect(next.blocks['p1']).toMatchObject({
        type: 'froglight.heading',
        level: 2,
      });
      expect(JSON.stringify(next.blocks['p1'])).toContain('hello world');
      expect(env.menu()?.style.display).toBe('none');
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(env.handle.getModelForTest!()).toEqual(before);
    } finally {
      env.cleanup();
    }
  });

  it('keyboard arrows/Enter/Esc match the slash model', () => {
    const env = mount(singlePara('keyboard'));
    try {
      openMenuFor(env, 'p1', true);
      // The current Paragraph no-op is omitted, so two downs land on H3.
      pressKey(env, 'ArrowDown');
      pressKey(env, 'ArrowDown');
      pressKey(env, 'ArrowDown');
      pressKey(env, 'Enter');
      expect(env.handle.getModelForTest!().blocks['p1']).toMatchObject({
        type: 'froglight.heading',
        level: 3,
      });
    } finally {
      env.cleanup();
    }
    const env2 = mount(singlePara('dismiss'));
    try {
      openMenuFor(env2, 'p1');
      pressKey(env2, 'Escape');
      expect(env2.menu()?.style.display).toBe('none');
      expect(JSON.stringify(env2.handle.getModelForTest!())).toContain(
        'dismiss',
      );
    } finally {
      env2.cleanup();
    }
  });

  it('touch tap commits the same entry (pointerup parity)', () => {
    const env = mount(singlePara('touch me'));
    try {
      openMenuFor(env, 'p1', true);
      const item = [...env.menu()!.querySelectorAll('.flbp-slash-item')].find(
        (el) => el.textContent === 'Bullet list',
      )!;
      item.dispatchEvent(
        new PointerEvent('pointerup', {
          bubbles: true,
          cancelable: true,
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
      // The synthetic click that follows must be a no-op (menu closed).
      item.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const next = env.handle.getModelForTest!();
      expect(Object.values(next.blocks).map((b) => b.type)).toContain(
        'froglight.list',
      );
      expect(JSON.stringify(next)).toContain('touch me');
    } finally {
      env.cleanup();
    }
  });

  it('freezes the gutter handle while open (hover does not retarget)', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['a', 'b'];
    model.blocks = {
      a: paragraphBlock('a', [{ text: 'alpha' }]),
      b: paragraphBlock('b', [{ text: 'beta' }]),
    };
    const env = mount(model);
    try {
      openMenuFor(env, 'a');
      const host = env.parent.firstElementChild as HTMLElement;
      const handle = host.querySelector('.flbp-drag-handle') as HTMLElement;
      const topBefore = handle.style.top;
      // Hovering the other block must not move the frozen handle.
      const other = env
        .pm()
        .querySelector('[data-block-id="b"]') as HTMLElement;
      other.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      expect(handle.style.top).toBe(topBefore);
      expect(handle.classList).toContain('visible');
      pressKey(env, 'Escape');
      // After dismiss, hover retargets again.
      other.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      expect(env.menu()?.style.display).toBe('none');
    } finally {
      env.cleanup();
    }
  });

  it('same-block no-op drop dispatches nothing (no history step)', () => {
    const env = mount(twoParas());
    try {
      mockColumnGeometry(env);
      const host = env.parent.firstElementChild as HTMLElement;
      const first = env
        .pm()
        .querySelector('[data-block-id="a"]') as HTMLElement;
      first.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      const handle = host.querySelector('.flbp-drag-handle') as HTMLElement;
      const dataTransfer = {
        effectAllowed: '',
        dropEffect: '',
        setData() {
          /* test transport */
        },
        setDragImage() {
          /* jsdom has no native drag image */
        },
      };
      const start = new Event('dragstart', { bubbles: true, cancelable: true });
      Object.defineProperty(start, 'dataTransfer', { value: dataTransfer });
      handle.dispatchEvent(start);
      // Pointer over the first block's own top half: boundary index 0, the
      // dragged block's own slot (fromIndex 0) — a no-op drop.
      const over = new MouseEvent('dragover', {
        bubbles: true,
        cancelable: true,
        clientY: 105,
      });
      Object.defineProperty(over, 'dataTransfer', { value: dataTransfer });
      host.dispatchEvent(over);
      const drop = new MouseEvent('drop', {
        bubbles: true,
        cancelable: true,
        clientY: 105,
      });
      Object.defineProperty(drop, 'dataTransfer', { value: dataTransfer });
      host.dispatchEvent(drop);
      expect(env.handle.getModelForTest!().rootOrder).toEqual(['a', 'b']);
      // No dispatch means no dirty model and no undo step.
      expect(env.latest()).toBeNull();
      expect(env.handle.canExecCommand?.('undo')).toBe(false);
    } finally {
      env.cleanup();
    }
  });

  it('foreign drags are ignored without preventDefault (relevance gate)', () => {
    const env = mount(twoParas());
    try {
      mockColumnGeometry(env);
      const host = env.parent.firstElementChild as HTMLElement;
      // No dragstart: #draggingId stays null, so this is foreign content
      // (files, text, another app). Non-file foreign drags keep native
      // handling (never claimed); file drags ARE claimed for uploadMedia
      // ingestion, so the gate below uses a text drag.
      const over = new MouseEvent('dragover', {
        bubbles: true,
        cancelable: true,
        clientY: 150,
      });
      Object.defineProperty(over, 'dataTransfer', {
        value: { dropEffect: '', types: ['text/plain'] },
      });
      host.dispatchEvent(over);
      expect(over.defaultPrevented).toBe(false);
      const drop = new MouseEvent('drop', {
        bubbles: true,
        cancelable: true,
        clientY: 150,
      });
      Object.defineProperty(drop, 'dataTransfer', {
        value: { types: ['text/plain'] },
      });
      host.dispatchEvent(drop);
      expect(drop.defaultPrevented).toBe(false);
      expect(env.handle.getModelForTest!().rootOrder).toEqual(['a', 'b']);
      expect(env.latest()).toBeNull();
    } finally {
      env.cleanup();
    }
  });

  it('file drags are claimed for ingestion; fileless file-drops stay inert', () => {
    const env = mount(twoParas());
    try {
      mockColumnGeometry(env);
      const host = env.parent.firstElementChild as HTMLElement;
      // A Files-typed dragover IS claimed (dragover must preventDefault or
      // the browser never fires drop) — the relevance gate now distinguishes
      // file drags (ingestion path) from other foreign drags (native).
      const over = new MouseEvent('dragover', {
        bubbles: true,
        cancelable: true,
        clientY: 150,
      });
      Object.defineProperty(over, 'dataTransfer', {
        value: { dropEffect: '', types: ['Files'] },
      });
      host.dispatchEvent(over);
      expect(over.defaultPrevented).toBe(true);
      // A file drop carrying no readable entries stays inert: nothing to
      // ingest, model untouched, no dirty signal, no undo step.
      const drop = new MouseEvent('drop', {
        bubbles: true,
        cancelable: true,
        clientY: 150,
      });
      Object.defineProperty(drop, 'dataTransfer', {
        value: { types: ['Files'] },
      });
      host.dispatchEvent(drop);
      expect(env.handle.getModelForTest!().rootOrder).toEqual(['a', 'b']);
      expect(env.latest()).toBeNull();
      expect(env.handle.canExecCommand?.('undo')).toBe(false);
    } finally {
      env.cleanup();
    }
  });

  it('touch tap on the gutter handle opens the menu (no drag)', () => {
    const env = mount(singlePara('tap me'));
    try {
      const host = env.parent.firstElementChild as HTMLElement;
      const block = env
        .pm()
        .querySelector('[data-block-id="p1"]') as HTMLElement;
      // Touch gutter path: press on the block retargets the handle…
      block.dispatchEvent(
        pointer('pointerdown', {
          pointerType: 'touch',
          pointerId: 9,
          clientX: 240,
          clientY: 110,
        }),
      );
      const handle = host.querySelector('.flbp-drag-handle') as HTMLElement;
      expect(handle.classList).toContain('visible');
      // …tap (down + up, no movement) opens the turn-into menu…
      handle.dispatchEvent(
        pointer('pointerdown', {
          pointerType: 'touch',
          pointerId: 9,
          clientX: 190,
          clientY: 110,
        }),
      );
      handle.dispatchEvent(
        pointer('pointerup', {
          pointerType: 'touch',
          pointerId: 9,
          clientX: 190,
          clientY: 110,
        }),
      );
      expect(env.menu()?.style.display).toBe('block');
      // …and the synthetic click that follows the tap must not toggle it shut.
      handle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(env.menu()?.style.display).toBe('block');
      pressKey(env, 'Escape');
      expect(env.menu()?.style.display).toBe('none');
    } finally {
      env.cleanup();
    }
  });

  it('nested same-parent no-op drop dispatches nothing', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['a', 'b'];
    model.blocks = {
      a: { ...paragraphBlock('a', [{ text: 'parent' }]), children: ['c'] },
      c: paragraphBlock('c', [{ text: 'child' }]),
      b: paragraphBlock('b', [{ text: 'beta' }]),
    };
    const env = mount(model);
    try {
      const host = env.parent.firstElementChild as HTMLElement;
      const pm = env.pm() as HTMLElement;
      const aEl = pm.querySelector('[data-block-id="a"]') as HTMLElement;
      const cEl = pm.querySelector('[data-block-id="c"]') as HTMLElement;
      const bEl = pm.querySelector('[data-block-id="b"]') as HTMLElement;
      const groupEl = pm.querySelector('.flbp-group') as HTMLElement;
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
        bottom: 220,
        width: 400,
        height: 130,
        toJSON: () => ({}),
      });
      aEl.getBoundingClientRect = () => ({
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
      groupEl.getBoundingClientRect = () => ({
        x: 220,
        y: 130,
        left: 220,
        top: 130,
        right: 580,
        bottom: 160,
        width: 360,
        height: 30,
        toJSON: () => ({}),
      });
      bEl.getBoundingClientRect = () => ({
        x: 220,
        y: 160,
        left: 220,
        top: 160,
        right: 580,
        bottom: 190,
        width: 360,
        height: 30,
        toJSON: () => ({}),
      });
      // Hover the nested child so the handle targets it, then start a drag.
      cEl.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      const handle = host.querySelector('.flbp-drag-handle') as HTMLElement;
      const dataTransfer = {
        effectAllowed: '',
        dropEffect: '',
        setData() {
          /* test transport */
        },
        setDragImage() {
          /* jsdom has no native drag image */
        },
      };
      const start = new Event('dragstart', { bubbles: true, cancelable: true });
      Object.defineProperty(start, 'dataTransfer', { value: dataTransfer });
      handle.dispatchEvent(start);
      // Indented pointer over the group's top half: boundary index 1 with
      // `a` as the previous sibling — a nested drop back under `a`, where
      // `c` already sits last. A same-slot no-op drop.
      const over = new MouseEvent('dragover', {
        bubbles: true,
        cancelable: true,
        clientX: 300,
        clientY: 135,
      });
      Object.defineProperty(over, 'dataTransfer', { value: dataTransfer });
      host.dispatchEvent(over);
      const drop = new MouseEvent('drop', {
        bubbles: true,
        cancelable: true,
        clientX: 300,
        clientY: 135,
      });
      Object.defineProperty(drop, 'dataTransfer', { value: dataTransfer });
      host.dispatchEvent(drop);
      const next = env.handle.getModelForTest!();
      expect(next.rootOrder).toEqual(['a', 'b']);
      expect((next.blocks['a'] as { children?: string[] }).children).toEqual([
        'c',
      ]);
      expect(next.blocks['c']).toBeDefined();
      // No dispatch means no dirty model and no undo step.
      expect(env.latest()).toBeNull();
      expect(env.handle.canExecCommand?.('undo')).toBe(false);
    } finally {
      env.cleanup();
    }
  });

  it('a late synthetic click after a touch tap stays suppressed', () => {
    const env = mount(singlePara('tap me'));
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      try {
        const host = env.parent.firstElementChild as HTMLElement;
        const block = env
          .pm()
          .querySelector('[data-block-id="p1"]') as HTMLElement;
        block.dispatchEvent(
          pointer('pointerdown', {
            pointerType: 'touch',
            pointerId: 9,
            clientX: 240,
            clientY: 110,
          }),
        );
        const handle = host.querySelector('.flbp-drag-handle') as HTMLElement;
        handle.dispatchEvent(
          pointer('pointerdown', {
            pointerType: 'touch',
            pointerId: 9,
            clientX: 190,
            clientY: 110,
          }),
        );
        handle.dispatchEvent(
          pointer('pointerup', {
            pointerType: 'touch',
            pointerId: 9,
            clientX: 190,
            clientY: 110,
          }),
        );
        expect(env.menu()?.style.display).toBe('block');
        // The platform compat click can arrive hundreds of ms after the tap
        // (long after a setTimeout(0) flag would have cleared): it must still
        // be suppressed while the window holds...
        vi.advanceTimersByTime(100);
        handle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(env.menu()?.style.display).toBe('block');
        // ...and clicks past the window behave normally again.
        vi.advanceTimersByTime(500);
        handle.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(env.menu()?.style.display).toBe('none');
      } finally {
        vi.useRealTimers();
      }
    } finally {
      env.cleanup();
    }
  });
});

/** Raw provider stylesheet text (touch-contract pins below).*/
function envCss(): string {
  return fs.readFileSync(
    path.resolve(__dirname, 'styles/prose-mirror.css'),
    'utf8',
  );
}

/** Bodies of every `(hover: none), (pointer: coarse)` media block. */
function coarseBlocks(css: string): string[] {
  const body = css
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/url\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\)/g, 'url()');
  const out: string[] = [];
  for (const m of body.matchAll(
    /@media\s*\(hover:\s*none\),\s*\(pointer:\s*coarse\)\s*\{/g,
  )) {
    let depth = 1;
    let i = (m.index ?? 0) + m[0].length;
    for (; i < body.length && depth > 0; i += 1) {
      if (body[i] === '{') depth += 1;
      else if (body[i] === '}') depth -= 1;
    }
    out.push(body.slice((m.index ?? 0) + m[0].length, i - 1));
  }
  return out;
}

/**
 * Touch targets and closures:
 * Gutter tap-versus-drag and suppression stay intact while closing. Todo
 * taps toggle by pointer; nested menus use the innermost anchor; toggles
 * remain single-undo; contextual anchors cover tables, media, math, and
 * columns; mounted anchors retain disclosure; overlays handle slash
 * insertion, figure source editing, Escape focus return, and semantic commit.
 */
describe('touch closures + contextual anchor', () => {
  function todoModel(): BlockPageModel {
    const model = emptyBlockPage();
    model.rootOrder = ['l1'];
    model.blocks = {
      l1: {
        id: 'l1',
        type: 'froglight.list',
        ordered: false,
        items: [{ runs: [{ text: 'task body' }], checked: false }],
      } as never,
    };
    return model;
  }

  function nestedTodoModel(): BlockPageModel {
    const model = emptyBlockPage();
    model.rootOrder = ['l1'];
    model.blocks = {
      l1: {
        id: 'l1',
        type: 'froglight.list',
        ordered: false,
        items: [
          { runs: [{ text: 'outer' }], checked: false, children: ['l2'] },
        ],
      } as never,
      l2: {
        id: 'l2',
        type: 'froglight.list',
        ordered: false,
        items: [{ runs: [{ text: 'inner' }], checked: false }],
      } as never,
    };
    return model;
  }

  const checkedOf = (model: BlockPageModel, id: string, index: number) =>
    (
      model.blocks[id] as unknown as {
        items: Array<{ checked?: boolean }>;
      }
    ).items[index]?.checked;

  function toolsOf(env: ReturnType<typeof mount>) {
    const tools = (
      env.handle as unknown as {
        tools?: {
          snapshot(): {
            context: string;
            controls: Array<{ id: string }>;
            contextualAnchor?: {
              x: number;
              y: number;
              width: number;
              height: number;
            };
          };
          execute(id: string, value?: string): boolean;
          onDidChange(listener: () => void): { dispose(): void };
        };
      }
    ).tools;
    if (tools === undefined) throw new Error('semantic tools unavailable');
    return tools;
  }

  it('touch tap on the checkbox toggles the intended row', () => {
    const env = mount(todoModel());
    try {
      const li = env.parent.querySelector(
        'li[data-checked="false"]',
      ) as HTMLElement;
      expect(li).not.toBeNull();
      li.dispatchEvent(
        pointer('pointerdown', {
          pointerType: 'touch',
          pointerId: 7,
          clientX: 0,
          clientY: 0,
        }),
      );
      li.dispatchEvent(
        pointer('pointerup', {
          pointerType: 'touch',
          pointerId: 7,
          clientX: 1,
          clientY: 1,
        }),
      );
      expect(checkedOf(env.handle.getModelForTest!(), 'l1', 0)).toBe(true);
      // The compat click that follows the handled tap stays suppressed.
      li.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(checkedOf(env.handle.getModelForTest!(), 'l1', 0)).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  it('mouse click on the checkbox toggles; text-body clicks edit (no mis-taps)', () => {
    const env = mount(todoModel());
    try {
      const li = env.parent.querySelector(
        'li[data-checked="false"]',
      ) as HTMLElement;
      li.getBoundingClientRect = () => ({
        x: 100,
        y: 50,
        left: 100,
        top: 50,
        right: 400,
        bottom: 94,
        width: 300,
        height: 44,
        toJSON: () => ({}),
      });
      // Text body: caret moves, checked untouched.
      li.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          clientX: 250,
          clientY: 70,
        }),
      );
      expect(checkedOf(env.handle.getModelForTest!(), 'l1', 0)).toBe(false);
      // Checkbox zone: toggles.
      li.dispatchEvent(
        new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          clientX: 108,
          clientY: 70,
        }),
      );
      expect(checkedOf(env.handle.getModelForTest!(), 'l1', 0)).toBe(true);
    } finally {
      env.cleanup();
    }
  });

  it('touch scroll over a todo never toggles', () => {
    const env = mount(todoModel());
    try {
      const li = env.parent.querySelector(
        'li[data-checked="false"]',
      ) as HTMLElement;
      li.dispatchEvent(
        pointer('pointerdown', {
          pointerType: 'touch',
          pointerId: 9,
          clientX: 0,
          clientY: 0,
        }),
      );
      li.dispatchEvent(
        pointer('pointerup', {
          pointerType: 'touch',
          pointerId: 9,
          clientX: 0,
          clientY: 60,
        }),
      );
      expect(checkedOf(env.handle.getModelForTest!(), 'l1', 0)).toBe(false);
    } finally {
      env.cleanup();
    }
  });

  it('nested todos toggle the innermost row only', () => {
    const env = mount(nestedTodoModel());
    try {
      expect(env.parent.querySelectorAll('li[data-checked]')).toHaveLength(2);
      // Caret inside the inner text flips the inner item; the outer stays.
      command(env, 'set-selection', { from: 12, to: 12 });
      expect(command(env, 'set-item-checked', { value: true })).toBe(true);
      const next = env.handle.getModelForTest!();
      expect(checkedOf(next, 'l2', 0)).toBe(true);
      expect(checkedOf(next, 'l1', 0)).toBe(false);
      // Tapping the inner checkbox row toggles it back via the same path.
      const rows = env.parent.querySelectorAll('li[data-checked]');
      const inner = rows[rows.length - 1] as HTMLElement;
      inner.dispatchEvent(
        pointer('pointerdown', {
          pointerType: 'touch',
          pointerId: 11,
          clientX: 0,
          clientY: 0,
        }),
      );
      inner.dispatchEvent(
        pointer('pointerup', {
          pointerType: 'touch',
          pointerId: 11,
          clientX: 0,
          clientY: 0,
        }),
      );
      const after = env.handle.getModelForTest!();
      expect(checkedOf(after, 'l2', 0)).toBe(false);
      expect(checkedOf(after, 'l1', 0)).toBe(false);
    } finally {
      env.cleanup();
    }
  });

  it('rapid toggles stay single-undo each', () => {
    const env = mount(todoModel());
    try {
      command(env, 'set-selection', { from: 3, to: 3 });
      expect(command(env, 'set-item-checked', { value: true })).toBe(true);
      expect(command(env, 'set-item-checked', { value: false })).toBe(true);
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(checkedOf(env.handle.getModelForTest!(), 'l1', 0)).toBe(true);
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(checkedOf(env.handle.getModelForTest!(), 'l1', 0)).toBe(false);
    } finally {
      env.cleanup();
    }
  });

  it('table/media/math/columns selections carry a viewport anchor', () => {
    const model = emptyBlockPage();
    model.rootOrder = ['p0', 't1', 'i1', 'm1', 'cl1', 'c1', 'c2', 'p1'];
    model.blocks = {
      p0: {
        id: 'p0',
        type: 'froglight.paragraph',
        runs: [{ text: 'outside columns' }],
      } as never,
      t1: {
        id: 't1',
        type: 'froglight.table',
        columnCount: 2,
        rows: [{ cells: [[{ text: 'a' }], [{ text: 'b' }]] }],
      } as never,
      i1: {
        id: 'i1',
        type: 'froglight.image',
        src: 'attachments/',
        sha256: '',
        alt: '',
      } as never,
      m1: { id: 'm1', type: 'froglight.math', source: 'x' } as never,
      cl1: {
        id: 'cl1',
        type: 'froglight.columnList',
        children: ['c1', 'c2'],
      } as never,
      c1: {
        id: 'c1',
        type: 'froglight.column',
        children: ['p1'],
      } as never,
      c2: { id: 'c2', type: 'froglight.column', children: [] } as never,
      p1: {
        id: 'p1',
        type: 'froglight.paragraph',
        runs: [{ text: 'in column' }],
      } as never,
    };
    const env = mount(model);
    try {
      // Table cell caret: grid island + anchor (p0 paragraph occupies
      // doc 0..17, so the first cell text sits at 21).
      command(env, 'set-selection', { from: 21, to: 21 });
      let snap = toolsOf(env).snapshot();
      expect(
        snap.controls.some((control) => control.id === 'table.addRow'),
      ).toBe(true);
      expect(snap.contextualAnchor).toBeDefined();
      // Media atom: caption island + anchor.
      expect(command(env, 'select-block', { blockId: 'i1' })).toBe(true);
      snap = toolsOf(env).snapshot();
      expect(
        snap.controls.some((control) => control.id === 'media.caption'),
      ).toBe(true);
      expect(snap.contextualAnchor).toBeDefined();
      // Math atom: source island + anchor.
      expect(command(env, 'select-block', { blockId: 'm1' })).toBe(true);
      snap = toolsOf(env).snapshot();
      expect(
        snap.controls.some((control) => control.id === 'math.source'),
      ).toBe(true);
      expect(snap.contextualAnchor).toBeDefined();
      // Plain paragraph outside columns: no island, no anchor
      // (float.selection stays home).
      expect(command(env, 'select-block', { blockId: 'p0' })).toBe(true);
      snap = toolsOf(env).snapshot();
      expect(
        snap.controls.some(
          (control) =>
            control.id.startsWith('table.') ||
            control.id.startsWith('media.') ||
            control.id.startsWith('math.') ||
            control.id.startsWith('column.'),
        ),
      ).toBe(false);
      expect(snap.contextualAnchor).toBeUndefined();
    } finally {
      env.cleanup();
    }
  });



  it('scroll/resize coalesces anchor moves per frame and stays edge-gated', async () => {
    const model = emptyBlockPage();
    model.rootOrder = ['m1'];
    model.blocks = {
      m1: { id: 'm1', type: 'froglight.math', source: 'x' } as never,
    };
    const env = mount(model);
    try {
      expect(command(env, 'select-block', { blockId: 'm1' })).toBe(true);
      const tools = toolsOf(env);
      let notices = 0;
      const sub = tools.onDidChange(() => {
        notices += 1;
      });
      try {
        const host = env.parent.firstElementChild as HTMLElement;
        const figure = env.parent.querySelector(
          'figure[data-flbp-math]',
        ) as HTMLElement;
        // Multiple events publish only once on the next frame.
        host.dispatchEvent(new Event('scroll', { bubbles: true }));
        host.dispatchEvent(new Event('scroll', { bubbles: true }));
        expect(notices).toBe(0);
        host.dispatchEvent(new Event('scroll', { bubbles: true }));
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        expect(notices).toBe(1);
        // Identical rect: silent.
        host.dispatchEvent(new Event('scroll', { bubbles: true }));
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        expect(notices).toBe(1);
        // Moved rect: notifies once, then settles again.
        figure.getBoundingClientRect = () => ({
          x: 10,
          y: 20,
          left: 10,
          top: 20,
          right: 110,
          bottom: 60,
          width: 100,
          height: 40,
          toJSON: () => ({}),
        });
        host.dispatchEvent(new Event('scroll', { bubbles: true }));
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        expect(notices).toBe(2);
        host.dispatchEvent(new Event('scroll', { bubbles: true }));
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
        expect(notices).toBe(2);
        // The published snapshot carries the moved rect verbatim.
        expect(tools.snapshot().contextualAnchor).toMatchObject({
          x: 10,
          y: 20,
          width: 100,
          height: 40,
        });
      } finally {
        sub.dispose();
      }
    } finally {
      env.cleanup();
    }
  });

  it('figure click opens the source overlay; Save commits single-undo; Esc cancels (wiring)', async () => {
    const model = emptyBlockPage();
    model.rootOrder = ['m1'];
    model.blocks = {
      m1: { id: 'm1', type: 'froglight.math', source: 'a' } as never,
    };
    const env = mount(model);
    try {
      const figure = env.parent.querySelector(
        'figure[data-flbp-math]',
      ) as HTMLElement;
      expect(figure).not.toBeNull();
      figure.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
      const overlay = env.parent.querySelector(
        '.flbp-md-overlay',
      ) as HTMLElement;
      expect(overlay).not.toBeNull();
      const textarea = overlay.querySelector('textarea') as HTMLTextAreaElement;
      textarea.value = 'b';
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      (overlay.querySelector('.flbp-md-commit') as HTMLElement).dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(env.parent.querySelector('.flbp-md-overlay')).toBeNull();
      expect(
        (
          env.handle.getModelForTest!().blocks['m1'] as unknown as {
            source: string;
          }
        ).source,
      ).toBe('b');
      expect(env.handle.execCommand('undo')).toBe(true);
      expect(
        (
          env.handle.getModelForTest!().blocks['m1'] as unknown as {
            source: string;
          }
        ).source,
      ).toBe('a');
      // Reopen, then Esc dismisses without mutation and returns focus.
      const figure2 = env.parent.querySelector(
        'figure[data-flbp-math]',
      ) as HTMLElement;
      figure2.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
      const overlay2 = env.parent.querySelector(
        '.flbp-md-overlay',
      ) as HTMLElement;
      expect(overlay2).not.toBeNull();
      (overlay2.querySelector('textarea') as HTMLTextAreaElement).value = 'zzz';
      overlay2.querySelector('textarea')!.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(env.parent.querySelector('.flbp-md-overlay')).toBeNull();
      expect(
        (
          env.handle.getModelForTest!().blocks['m1'] as unknown as {
            source: string;
          }
        ).source,
      ).toBe('a');
    } finally {
      env.cleanup();
    }
  });

  it('side affordances and slash rows meet the 44px coarse contract without a permanent gutter', () => {
    const coarse = coarseBlocks(envCss());
    expect(coarse.length).toBeGreaterThan(0);
    // Gutter handle: 44x44, manipulation (never none — scroll keeps working).
    expect(
      coarse.some((block) =>
        /\.flbp-drag-handle,\s*\.flbp-add-block\s*\{[^}]*width:\s*44px[^}]*height:\s*44px/.test(
          block,
        ),
      ),
    ).toBe(true);
    expect(
      coarse.some((block) =>
        /\.flbp-add-block\s*\{[^}]*touch-action:\s*manipulation/.test(block),
      ),
    ).toBe(true);
    expect(
      coarse.some((block) =>
        /\.flbp-drag-handle\s*\{[^}]*touch-action:\s*none/.test(block),
      ),
    ).toBe(false);
    expect(coarse.join('')).not.toMatch(
      /\.flbp-host \.ProseMirror\s*\{[^}]*padding-left:\s*44px/,
    );
    // Slash rows: 44px floor with no double-tap-zoom delay.
    expect(
      coarse.some((block) =>
        /\.flbp-slash-item\s*\{[^}]*min-height:\s*44px/.test(block),
      ),
    ).toBe(true);
    expect(
      coarse.some((block) =>
        /\.flbp-slash-item\s*\{[^}]*touch-action:\s*manipulation/.test(block),
      ),
    ).toBe(true);
  });
});
