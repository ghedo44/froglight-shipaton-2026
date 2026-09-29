// @vitest-environment jsdom
/**
 *  writing grouping (markdown/latex) — shared grammar via
 * contributions/builders only.
 *
 * - One shared grammar (Style/Format/Insert/Structure, toggle roles):
 *   portable controls deep-equal the shared builder output with
 *   provider-owned ids and provider-computed active/mixed/disabled.
 * - Unsupported roles stay unresolved, never synthesized: Markdown emits
 *  no `writing.strike`; neither family emits indent/outdent;
 *   LaTeX emits no strike/code/link/code-block.
 * - Selection-clamped contextual formatting + focus preservation:
 *   every execute path refocuses the editor; keyboard shortcuts converge
 *   on the same source outcomes as the toolbar.
 * - Mock/alternate-provider open/save/reopen intact (AGENTS.md
 *   editor-provider rule): toolbar edits flow through onDirtyText/session
 *   bytes and reopen byte-faithful.
 * - No canonical/engine changes: snapshots are plain data with no
 *  CodeMirror markers; no editor-library types cross the seam.
 */

import { describe, expect, it } from 'vitest';
import {
  latexModel,
  markdownModel,
  writingCodeBlockControl,
  writingFormatToggleControl,
  writingLinkControl,
  type DocumentSession,
  type DocumentToolSnapshot,
} from '@froglight/foundation';
import { MarkdownDocumentEditorProvider } from './markdown.js';
import {
  LatexDocumentEditorProvider,
  type LatexDocumentEditorDeps,
} from './latex.js';

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

type MarkdownHandle = ReturnType<
  MarkdownDocumentEditorProvider['createEditor']
> & {
  getTextForTest(): string;
  setSelectionForTest(anchor: number, head?: number): void;
  getSelectionForTest(): { readonly from: number; readonly to: number };
  hasFocus(): boolean;
  focus(): void;
  destroy(): void;
};

function markdownSession() {
  const model = markdownModel('# Hello\n');
  const session = {
    model,
    markDirty: () => undefined,
  };
  return session as never;
}

function makeMarkdown(
  initialText: string,
  onDirtyText: (text: string) => void = () => undefined,
): { parent: HTMLElement; handle: MarkdownHandle } {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const handle = new MarkdownDocumentEditorProvider().createEditor({
    session: markdownSession(),
    parent,
    initialText,
    onDirtyText,
  }) as unknown as MarkdownHandle;
  return { parent, handle };
}

function markdownSnapshotOf(handle: MarkdownHandle): DocumentToolSnapshot {
  const tools = handle.tools;
  if (tools === undefined) throw new Error('markdown tools unavailable');
  return tools.snapshot();
}

type LatexHandle = ReturnType<LatexDocumentEditorProvider['createEditor']> & {
  getTextForTest(): string;
  setSelectionForTest(anchor: number, head?: number): void;
  getSelectionForTest(): { readonly from: number; readonly to: number };
  hasFocus(): boolean;
  focus(): void;
  destroy(): void;
};

function makeLatex(initialRaw: string): {
  parent: HTMLElement;
  handle: LatexHandle;
  model: { raw: string };
} {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const model = latexModel(initialRaw);
  const session = {
    model,
    markDirty: () => undefined,
  } as unknown as DocumentSession;
  const provider = new LatexDocumentEditorProvider({
    latexProvider: () => null,
    createResolver: () => null,
    resolveDocumentPath: () => null,
    renderDebounceMillis: 5,
  } satisfies LatexDocumentEditorDeps);
  const handle = provider.createEditor({
    session,
    parent,
  }) as unknown as LatexHandle;
  return { parent, handle, model };
}

function latexSnapshotOf(handle: LatexHandle): DocumentToolSnapshot {
  const tools = handle.tools;
  if (tools === undefined) throw new Error('latex tools unavailable');
  return tools.snapshot();
}

describe('markdown grouping via shared builders', () => {
  it('emits one Style selector + Format/Insert groups with no flat fallback', async () => {
    const { parent, handle } = makeMarkdown('hello');
    try {
      const snapshot = markdownSnapshotOf(handle);
      const style = snapshot.controls.find((c) => c.id === 'markdown.block');
      expect(style?.kind).toBe('choice');
      expect(style?.semanticRole).toBe('writing.style');
      // Portable Format roles converge through the shared builder.
      const byId = new Map(snapshot.controls.map((c) => [c.id, c]));
      expect(byId.get('markdown.bold')).toEqual(
        writingFormatToggleControl('markdown.bold', 'bold', {}),
      );
      expect(byId.get('markdown.italic')).toEqual(
        writingFormatToggleControl('markdown.italic', 'italic', {}),
      );
      expect(byId.get('markdown.code')).toEqual(
        writingFormatToggleControl('markdown.code', 'code', {}),
      );
      expect(byId.get('markdown.link')).toEqual(
        writingLinkControl('markdown.link', {}),
      );
      expect(byId.get('markdown.code-block')).toEqual(
        writingCodeBlockControl('markdown.code-block', {}),
      );
      // Every format toggle carries the toggle role (never exclusive).
      for (const id of ['markdown.bold', 'markdown.italic', 'markdown.code']) {
        const control = byId.get(id);
        if (control?.kind !== 'button') throw new Error(`missing ${id}`);
        expect(control.activationRole).toBe('toggle');
        expect(control.group).toBe('format');
      }
    } finally {
      handle.destroy();
      parent.remove();
    }
  });

  it('omits writing.strike without synthesizing it', async () => {
    const { parent, handle } = makeMarkdown('a **bold** tail');
    try {
      await tick();
      const roles = markdownSnapshotOf(handle).controls.map(
        (c) => c.semanticRole,
      );
      expect(roles).not.toContain('writing.strike');
      expect(
        markdownSnapshotOf(handle).controls.some((c) =>
          c.id.includes('strike'),
        ),
      ).toBe(false);
      const tools = handle.tools;
      if (tools === undefined) throw new Error('missing tools');
      // Unknown/synthesized strike ids refuse without mutation.
      expect(await tools.execute('markdown.strike')).toBe(false);
      expect(handle.getTextForTest()).toBe('a **bold** tail');
    } finally {
      handle.destroy();
      parent.remove();
    }
  });

  it('emits no indent/outdent: structure stays unresolved, never synthesized', async () => {
    const { parent, handle } = makeMarkdown('hello');
    try {
      const ids = markdownSnapshotOf(handle).controls.map((c) => c.id);
      expect(ids).not.toContain('markdown.indent');
      expect(ids).not.toContain('markdown.outdent');
      const roles = markdownSnapshotOf(handle).controls.map(
        (c) => c.semanticRole,
      );
      expect(roles).not.toContain('writing.indent');
      expect(roles).not.toContain('writing.outdent');
    } finally {
      handle.destroy();
      parent.remove();
    }
  });

  it('passes provider-computed active/mixed/disabled through untouched', async () => {
    const { handle } = makeMarkdown('a **bold** tail and _it_ plus `cd` end');
    try {
      await tick();
      const button = (id: string) => {
        const control = markdownSnapshotOf(handle).controls.find(
          (c) => c.id === id,
        );
        if (control?.kind !== 'button') throw new Error(`missing ${id}`);
        return control;
      };
      handle.setSelectionForTest(6);
      expect(button('markdown.bold').active).toBe(true);
      handle.setSelectionForTest(0, 10);
      expect(button('markdown.bold').mixed).toBe(true);
      expect(button('markdown.bold').active).toBeUndefined();
    } finally {
      handle.destroy();
    }
  });

  it('clamps formatting to the selection: code/fenced contexts refuse', async () => {
    const { handle } = makeMarkdown('a `code` b\n\n```\nfenced\n```\n');
    try {
      await tick();
      const tools = handle.tools;
      if (tools === undefined) throw new Error('missing tools');
      handle.setSelectionForTest(4, 7);
      expect(await tools.execute('markdown.bold')).toBe(false);
      expect(await tools.execute('markdown.link', 'https://a.test')).toBe(
        false,
      );
      handle.setSelectionForTest(16);
      expect(await tools.execute('markdown.code-block')).toBe(false);
      expect(handle.getTextForTest()).toBe('a `code` b\n\n```\nfenced\n```\n');
    } finally {
      handle.destroy();
    }
  });

  it('preserves focus on every toolbar execute', async () => {
    const { parent, handle } = makeMarkdown('hello world');
    try {
      const tools = handle.tools;
      if (tools === undefined) throw new Error('missing tools');
      handle.setSelectionForTest(0, 5);
      expect(await tools.execute('markdown.bold')).toBe(true);
      expect(handle.hasFocus()).toBe(true);
      handle.setSelectionForTest(0, 5);
      expect(await tools.execute('markdown.link', 'https://f.test')).toBe(true);
      expect(handle.hasFocus()).toBe(true);
      expect(await tools.execute('markdown.block', 'heading:1')).toBe(true);
      expect(handle.hasFocus()).toBe(true);
    } finally {
      handle.destroy();
      parent.remove();
    }
  });

  it('keeps keyboard and toolbar on the same source outcomes', async () => {
    const { handle: toolbar } = makeMarkdown('hello');
    const { parent, handle: keyboard } = makeMarkdown('hello');
    try {
      const tools = toolbar.tools;
      if (tools === undefined) throw new Error('missing tools');
      toolbar.setSelectionForTest(0, 5);
      await tools.execute('markdown.bold');
      const toolbarText = toolbar.getTextForTest();
      keyboard.setSelectionForTest(0, 5);
      const content = parent.querySelector('.cm-content');
      if (content === null) throw new Error('missing CodeMirror content');
      content.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'b',
          ctrlKey: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      expect(keyboard.getTextForTest()).toBe(toolbarText);
    } finally {
      toolbar.destroy();
      keyboard.destroy();
      parent.remove();
    }
  });

  it('reopens toolbar edits byte-faithful through the dirty-text path', async () => {
    const seen: string[] = [];
    const { handle } = makeMarkdown('hello world', (text) => seen.push(text));
    try {
      const tools = handle.tools;
      if (tools === undefined) throw new Error('missing tools');
      handle.setSelectionForTest(6, 11);
      expect(await tools.execute('markdown.link', 'https://w.test')).toBe(true);
      const saved = seen.at(-1) ?? '';
      const { handle: reopened } = makeMarkdown(saved);
      try {
        expect(reopened.getTextForTest()).toBe(saved);
      } finally {
        reopened.destroy();
      }
    } finally {
      handle.destroy();
    }
  });

  it('exposes plain-data snapshots with no engine markers', async () => {
    const { parent, handle } = makeMarkdown('hello');
    try {
      const json = JSON.stringify(markdownSnapshotOf(handle));
      expect(json).not.toMatch(/cm-|CodeMirror|__cm/i);
    } finally {
      handle.destroy();
      parent.remove();
    }
  });
});

describe('latex grouping via shared builders', () => {
  it('emits the exact grouped snapshot: style + format + math/references/diagnostics', () => {
    const { parent, handle } = makeLatex('\\section{One}\n');
    try {
      const snapshot = latexSnapshotOf(handle);
      expect(snapshot.controls.map((c) => c.id)).toEqual([
        'latex.structure',
        'latex.bold',
        'latex.emphasis',
        'latex.inline-math',
        'latex.display-math',
        'latex.environment.itemize',
        'latex.environment.enumerate',
        'latex.environment.quote',
        'latex.label',
        'latex.ref',
        'latex.cite',
        'latex.diagnostics',
      ]);
      const structure = snapshot.controls.find(
        (c) => c.id === 'latex.structure',
      );
      expect(structure?.semanticRole).toBe('writing.style');
    } finally {
      handle.destroy();
      parent.remove();
    }
  });

  it('routes portable format controls through the shared builder', () => {
    const { parent, handle } = makeLatex('\\section{One}\n');
    try {
      const byId = new Map(
        latexSnapshotOf(handle).controls.map((c) => [c.id, c]),
      );
      expect(byId.get('latex.bold')).toEqual(
        writingFormatToggleControl('latex.bold', 'bold', {}),
      );
      // Documented Emphasis exemption: label differs, everything else converges.
      expect(byId.get('latex.emphasis')).toEqual(
        writingFormatToggleControl(
          'latex.emphasis',
          'italic',
          {},
          { label: 'Emphasis' },
        ),
      );
      for (const id of ['latex.bold', 'latex.emphasis']) {
        const control = byId.get(id);
        if (control?.kind !== 'button') throw new Error(`missing ${id}`);
        expect(control.activationRole).toBe('toggle');
        expect(control.group).toBe('format');
      }
    } finally {
      handle.destroy();
      parent.remove();
    }
  });

  it('omits strike/code/link/code-block/indent/outdent without synthesizing', () => {
    const { parent, handle } = makeLatex('alpha\n');
    try {
      const roles = latexSnapshotOf(handle).controls.map((c) => c.semanticRole);
      for (const role of [
        'writing.strike',
        'writing.code',
        'writing.link',
        'writing.code-block',
        'writing.indent',
        'writing.outdent',
      ]) {
        expect(roles).not.toContain(role);
      }
      const tools = handle.tools;
      if (tools === undefined) throw new Error('missing tools');
      expect(tools.execute('latex.strike')).toBe(false);
      expect(handle.getTextForTest()).toBe('alpha\n');
    } finally {
      handle.destroy();
      parent.remove();
    }
  });

  it('preserves focus on structure and format executes', () => {
    const { parent, handle } = makeLatex('hello\n');
    try {
      const tools = handle.tools;
      if (tools === undefined) throw new Error('missing tools');
      handle.setSelectionForTest(0, 5);
      expect(tools.execute('latex.bold')).toBe(true);
      expect(handle.hasFocus()).toBe(true);
      handle.setSelectionForTest(0, 0);
      expect(tools.execute('latex.structure', 'section')).toBe(true);
      expect(handle.hasFocus()).toBe(true);
    } finally {
      handle.destroy();
      parent.remove();
    }
  });

  it('reopens toolbar edits byte-faithful through the session model', () => {
    const { parent, handle, model } = makeLatex('alpha\n');
    try {
      const tools = handle.tools;
      if (tools === undefined) throw new Error('missing tools');
      handle.setSelectionForTest(0, 5);
      expect(tools.execute('latex.bold')).toBe(true);
      expect(model.raw).toBe('\\textbf{alpha}\n');
      const reopened = makeLatex(model.raw);
      try {
        expect(reopened.handle.getTextForTest()).toBe('\\textbf{alpha}\n');
      } finally {
        reopened.handle.destroy();
        reopened.parent.remove();
      }
    } finally {
      handle.destroy();
      parent.remove();
    }
  });

  it('exposes plain-data snapshots with no engine markers', () => {
    const { parent, handle } = makeLatex('\\section{One}\n');
    try {
      const json = JSON.stringify(latexSnapshotOf(handle));
      expect(json).not.toMatch(/cm-|CodeMirror|iframe|__cm/i);
    } finally {
      handle.destroy();
      parent.remove();
    }
  });
});
