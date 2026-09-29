// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { markdownModel } from '@froglight/foundation';
import type { MarkdownEditorHandle } from '@froglight/foundation';
import { MarkdownDocumentEditorProvider } from './markdown.js';

type CmHandle = MarkdownEditorHandle & {
  replaceAll(next: string): void;
  getTextForTest(): string;
  setSelectionForTest(anchor: number, head?: number): void;
  getSelectionForTest(): { readonly from: number; readonly to: number };
  canExecCommand(id: 'undo' | 'redo'): boolean;
  execCommand(id: 'undo' | 'redo'): boolean;
};

function makeSession() {
  const model = markdownModel('# Hello\n');
  const session = {
    model,
    markDirty: () => undefined,
  };
  return session as never;
}

function makeHandle(initialText: string): {
  parent: HTMLElement;
  handle: CmHandle;
} {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const handle = new MarkdownDocumentEditorProvider().createEditor({
    session: makeSession(),
    parent,
    initialText,
    onDirtyText: () => undefined,
  }) as CmHandle;
  return { parent, handle };
}

async function execute(
  handle: CmHandle,
  id: string,
  value?: string,
): Promise<boolean> {
  const tools = handle.tools;
  if (tools === undefined) throw new Error('missing tools');
  return value === undefined ? tools.execute(id) : tools.execute(id, value);
}

function buttonOf(handle: CmHandle, id: string) {
  const control = handle.tools?.snapshot().controls.find((c) => c.id === id);
  if (control?.kind !== 'button') throw new Error(`missing button ${id}`);
  return control;
}

const rangePrototype = (
  globalThis as unknown as { Range?: { prototype: Record<string, unknown> } }
).Range?.prototype;
if (
  rangePrototype !== undefined &&
  typeof rangePrototype['getClientRects'] !== 'function'
) {
  rangePrototype['getClientRects'] = () => [] as unknown as DOMRectList;
}

const tick = (): Promise<void> => Promise.resolve();

describe('Markdown enclosing-mark toggle convergence (review slice 3)', () => {
  it.each([
    ['**bold**', 'markdown.bold', 'bold'],
    ['__bold__', 'markdown.bold', 'bold'],
    ['_italic_', 'markdown.italic', 'italic'],
    ['*italic*', 'markdown.italic', 'italic'],
    ['`code`', 'markdown.code', 'code'],
  ])(
    'unwraps inner-only selection %s via %s (no double wrap)',
    async (source, controlId, inner) => {
      const { parent, handle } = makeHandle(source);
      await tick();
      const start = source.indexOf(inner);
      handle.setSelectionForTest(start, start + inner.length);
      // Snapshot proves active before the toggle.
      expect(buttonOf(handle, controlId).active).toBe(true);
      expect(await execute(handle, controlId)).toBe(true);
      expect(handle.getTextForTest()).toBe(inner);
      // Repaired selection still covers the inner text.
      expect(handle.getSelectionForTest()).toEqual({
        from: 0,
        to: inner.length,
      });
      handle.destroy();
      parent.remove();
    },
  );

  it.each([
    ['**bold**', 'markdown.bold', 'bold'],
    ['__bold__', 'markdown.bold', 'bold'],
    ['_italic_', 'markdown.italic', 'italic'],
    ['*italic*', 'markdown.italic', 'italic'],
    ['`code`', 'markdown.code', 'code'],
  ])(
    'unwraps full-delimiter selection %s via %s',
    async (source, controlId, inner) => {
      const { parent, handle } = makeHandle(source);
      await tick();
      handle.setSelectionForTest(0, source.length);
      expect(await execute(handle, controlId)).toBe(true);
      expect(handle.getTextForTest()).toBe(inner);
      handle.destroy();
      parent.remove();
    },
  );

  it('removes an active mark from a collapsed caret inside bold', async () => {
    const { parent, handle } = makeHandle('a **bold** tail');
    await tick();
    // Caret strictly inside the bold content.
    handle.setSelectionForTest(6);
    expect(buttonOf(handle, 'markdown.bold').active).toBe(true);
    expect(await execute(handle, 'markdown.bold')).toBe(true);
    expect(handle.getTextForTest()).toBe('a bold tail');
    handle.destroy();
    parent.remove();
  });

  it('does not claim active for mixed formatting selections', async () => {
    const { parent, handle } = makeHandle('**a** plain');
    await tick();
    handle.setSelectionForTest(0, 10);
    const bold = buttonOf(handle, 'markdown.bold');
    expect(bold.active).toBeUndefined();
    expect(bold.mixed).toBe(true);
    handle.destroy();
    parent.remove();
  });

  it('keeps inline code with internal backticks valid', async () => {
    const { parent, handle } = makeHandle('use ``a`b`` here');
    await tick();
    // Select the inner `a`b` (without fences, with padding handling).
    const text = handle.getTextForTest();
    const inner = 'a`b';
    const start = text.indexOf(inner);
    handle.setSelectionForTest(start, start + inner.length);
    expect(buttonOf(handle, 'markdown.code').active).toBe(true);
    expect(await execute(handle, 'markdown.code')).toBe(true);
    expect(handle.getTextForTest()).toBe('use a`b here');
    handle.destroy();
    parent.remove();
  });

  it('supports undo/redo around enclosing-mark unwraps', async () => {
    const { parent, handle } = makeHandle('**bold**');
    await tick();
    handle.setSelectionForTest(2, 6);
    expect(await execute(handle, 'markdown.bold')).toBe(true);
    expect(handle.getTextForTest()).toBe('bold');
    expect(handle.canExecCommand('undo')).toBe(true);
    handle.execCommand('undo');
    expect(handle.getTextForTest()).toBe('**bold**');
    expect(handle.canExecCommand('redo')).toBe(true);
    handle.execCommand('redo');
    expect(handle.getTextForTest()).toBe('bold');
    handle.destroy();
    parent.remove();
  });

  it('keeps keyboard and toolbar on the same enclosing-mark outcome', async () => {
    const { parent: p1, handle: toolbar } = makeHandle('**bold**');
    await tick();
    toolbar.setSelectionForTest(2, 6);
    await execute(toolbar, 'markdown.bold');
    const toolbarText = toolbar.getTextForTest();

    const { parent: p2, handle: keyboard } = makeHandle('**bold**');
    await tick();
    keyboard.setSelectionForTest(2, 6);
    const content = p2.querySelector('.cm-content');
    if (content === null) throw new Error('missing content');
    // Mod-b runs the same shared transform as the toolbar.
    content.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'b',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(keyboard.getTextForTest()).toBe(toolbarText);
    expect(toolbarText).toBe('bold');
    toolbar.destroy();
    keyboard.destroy();
    p1.remove();
    p2.remove();
  });

  it('marks writing format toggles as toggle activationRole (exclusive-tool exclusion)', async () => {
    const { parent, handle } = makeHandle('**bold**');
    await tick();
    try {
      handle.setSelectionForTest(2, 6);
      const snapshot = handle.tools?.snapshot();
      if (snapshot === undefined) throw new Error('missing tools snapshot');
      for (const id of ['markdown.bold', 'markdown.italic', 'markdown.code']) {
        const control = snapshot.controls.find((c) => c.id === id);
        if (control?.kind !== 'button') throw new Error(`missing button ${id}`);
        // Provider computes active/mixed; UI interprets via activationRole.
        expect(control.activationRole).toBe('toggle');
      }
      // Bold is active here, but its toggle role keeps it out of
      // exclusive-tool reconciliation (proved in ui activation-semantics).
      expect(buttonOf(handle, 'markdown.bold').active).toBe(true);
      expect(buttonOf(handle, 'markdown.bold').activationRole).toBe('toggle');
      // Link is kind input: no activationRole field, and the shared
      // exclusive-tool matcher already excludes non-button kinds.
      const link = snapshot.controls.find((c) => c.id === 'markdown.link');
      expect(link?.kind).toBe('input');
      expect('activationRole' in (link as Record<string, unknown>)).toBe(false);
    } finally {
      handle.destroy();
      parent.remove();
    }
  });
});
