// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  markdownModel,
  type DocumentToolSnapshot,
  type MarkdownEditorHandle,
} from '@froglight/foundation';
import {
  codeFenceFor,
  isValidLinkDestination,
  MarkdownDocumentEditorProvider,
} from './markdown.js';

/** Test-visible surface of the real CodeMirror handle. */
type CmHandle = MarkdownEditorHandle & {
  replaceAll(next: string): void;
  getTextForTest(): string;
  setSelectionForTest(anchor: number, head?: number): void;
  getSelectionForTest(): { readonly from: number; readonly to: number };
  canExecCommand(id: 'undo' | 'redo'): boolean;
};

function makeSession(initialRaw = '# Hello\n') {
  const model = markdownModel(initialRaw);
  const session = {
    model,
    markDirty: () => {
      (model as { raw?: string }).raw = model.raw;
    },
  };
  return session as never;
}

/** One microtask frame for parser-dependent (active/mixed/link) assertions. */
const tick = (): Promise<void> => Promise.resolve();

function makeHandle(
  initialText: string,
  onDirtyText: (text: string) => void = () => undefined,
): { parent: HTMLElement; handle: CmHandle } {
  const parent = document.createElement('div');
  document.body.appendChild(parent);
  const handle = new MarkdownDocumentEditorProvider().createEditor({
    session: makeSession(),
    parent,
    initialText,
    onDirtyText,
  }) as CmHandle;
  return { parent, handle };
}

function snapshotOf(handle: CmHandle): DocumentToolSnapshot {
  const tools = handle.tools;
  if (tools === undefined) throw new Error('semantic tools are unavailable');
  return tools.snapshot();
}

async function execute(
  handle: CmHandle,
  id: string,
  value?: string,
): Promise<boolean> {
  const tools = handle.tools;
  if (tools === undefined) throw new Error('semantic tools are unavailable');
  return value === undefined ? tools.execute(id) : tools.execute(id, value);
}

function buttonOf(handle: CmHandle, id: string) {
  const control = snapshotOf(handle).controls.find(
    (candidate) => candidate.id === id,
  );
  if (control?.kind !== 'button')
    throw new Error(`missing button control ${id}`);
  return control;
}

function inputOf(handle: CmHandle, id: string) {
  const control = snapshotOf(handle).controls.find(
    (candidate) => candidate.id === id,
  );
  if (control?.kind !== 'input') throw new Error(`missing input control ${id}`);
  return control;
}

function choiceOf(handle: CmHandle, id: string) {
  const control = snapshotOf(handle).controls.find(
    (candidate) => candidate.id === id,
  );
  if (control?.kind !== 'choice')
    throw new Error(`missing choice control ${id}`);
  return control;
}

// jsdom has no Range#getClientRects, which CodeMirror's async measure loop
// calls off the critical assertion path. Polyfill it so those cycles stay
// silent instead of surfacing as unhandled jsdom errors.
const rangePrototype = (
  globalThis as unknown as { Range?: { prototype: Record<string, unknown> } }
).Range?.prototype;
if (
  rangePrototype !== undefined &&
  typeof rangePrototype['getClientRects'] !== 'function'
) {
  rangePrototype['getClientRects'] = () => [] as unknown as DOMRectList;
}

/** Dispatch a full mousedown sequence on an element (jsdom has no .click() for custom flows). */
function mouseDown(element: Element): void {
  element.dispatchEvent(
    new MouseEvent('mousedown', { bubbles: true, cancelable: true }),
  );
}

describe('MarkdownDocumentEditorProvider (real CodeMirror 6)', () => {
  it('mounts a real CodeMirror editor into the parent', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const provider = new MarkdownDocumentEditorProvider();
    let dirty = '';
    const handle = provider.createEditor({
      session: makeSession(),
      parent,
      initialText: '# Hello',
      onDirtyText: (text) => {
        dirty = text;
      },
    }) as CmHandle;
    expect(parent.querySelector('.cm-editor')).not.toBeNull();
    expect(handle.hasFocus()).toBe(false);
    handle.destroy();
    expect(parent.querySelector('.cm-editor')).toBeNull();
    void dirty;
  });

  it('forwards edits to onDirtyText', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const provider = new MarkdownDocumentEditorProvider();
    const seen: string[] = [];
    const handle = provider.createEditor({
      session: makeSession(),
      parent,
      initialText: '',
      onDirtyText: (text) => seen.push(text),
    }) as CmHandle;
    handle.replaceAll('first line');
    expect(seen.at(-1)).toBe('first line');
    expect(handle.getTextForTest()).toBe('first line');
    handle.destroy();
  });

  it('supports editor-local undo/redo without touching the session', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const provider = new MarkdownDocumentEditorProvider();
    let latest = '';
    const handle = provider.createEditor({
      session: makeSession(),
      parent,
      initialText: 'v1',
      onDirtyText: (text) => {
        latest = text;
      },
    }) as CmHandle;
    expect(handle.canExecCommand('undo')).toBe(false);
    handle.replaceAll('v2');
    expect(latest).toBe('v2');
    expect(handle.canExecCommand('undo')).toBe(true);
    handle.execCommand('undo');
    expect(handle.getTextForTest()).toBe('v1');
    expect(handle.canExecCommand('redo')).toBe(true);
    handle.execCommand('redo');
    expect(handle.getTextForTest()).toBe('v2');
    handle.destroy();
  });

  it('exposes provider-neutral Markdown controls and contextual line state', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const handle = new MarkdownDocumentEditorProvider().createEditor({
      session: makeSession(),
      parent,
      initialText: 'Hello',
      onDirtyText: () => undefined,
    }) as CmHandle;
    const tools = handle.tools;
    if (tools === undefined) throw new Error('semantic tools are unavailable');

    expect(tools.snapshot().context).toBe('Markdown paragraph');
    expect(await tools.execute('markdown.block', 'heading:2')).toBe(true);
    expect(handle.getTextForTest()).toBe('## Hello');
    expect(tools.snapshot().context).toBe('Markdown heading 2');
    expect(await tools.execute('markdown.link', 'https://froglight.test')).toBe(
      true,
    );
    expect(handle.getTextForTest()).toContain('(https://froglight.test)');
    handle.destroy();
  });

  it('focuses the editor and reports focus state', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const provider = new MarkdownDocumentEditorProvider();
    const handle = provider.createEditor({
      session: makeSession(),
      parent,
      initialText: 'x',
      onDirtyText: () => undefined,
    }) as CmHandle;
    handle.focus();
    expect(handle.hasFocus()).toBe(true);
    handle.destroy();
  });

  it('reveals portable Markdown heading addresses', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const handle = new MarkdownDocumentEditorProvider().createEditor({
      session: makeSession(),
      parent,
      initialText: '# First\n\nText\n\n## Second\n',
      onDirtyText: () => undefined,
    }) as CmHandle;

    handle.revealAddress?.('second');
    expect(handle.tools?.snapshot().context).toBe('Markdown heading 2');
    handle.destroy();
  });

  it('decorates wiki-links and dispatches open-link events on click', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const provider = new MarkdownDocumentEditorProvider();
    const events: Array<{ destination: string; fragment?: string }> = [];
    parent.addEventListener('froglight:open-link', (event) => {
      const detail = (
        event as CustomEvent<{ destination: string; fragment?: string }>
      ).detail;
      events.push(detail);
    });
    const handle = provider.createEditor({
      session: makeSession(),
      parent,
      initialText: 'See [[Target Note|the target]] and [[Other#Section]].\n',
      onDirtyText: () => undefined,
    }) as CmHandle;
    // Allow the decoration update to run (ViewPlugin updates are synchronous
    // on creation, but give the microtask queue a tick regardless).
    await Promise.resolve();
    const links = [
      ...parent.querySelectorAll<HTMLElement>('.froglight-wiki-link'),
    ];
    expect(links.length).toBe(2);
    expect(links[0]?.dataset.destination).toBe('Target Note');
    expect(links[0]?.dataset.fragment).toBeUndefined();
    expect(links[1]?.dataset.destination).toBe('Other');
    expect(links[1]?.dataset.fragment).toBe('Section');

    const link = links[0];
    if (link === undefined) throw new Error('missing link element');
    mouseDown(link);
    expect(events).toEqual([
      { destination: 'Target Note', fragment: undefined },
    ]);

    // A plain mousedown elsewhere must not navigate or move through history.
    mouseDown(parent.querySelector('.cm-content') as HTMLElement);
    expect(events).toHaveLength(1);
    void handle;
    handle.destroy();
  });
});

describe('Markdown toolbar authoring controls (source-first)', () => {
  it('validates link destinations and code fences without an editor', () => {
    expect(isValidLinkDestination('https://froglight.test/x')).toBe(true);
    expect(isValidLinkDestination('   ')).toBe(false);
    expect(isValidLinkDestination('https://a.test/x y')).toBe(false);
    expect(isValidLinkDestination('a\nb')).toBe(false);
    expect(codeFenceFor('plain')).toBe('`');
    expect(codeFenceFor('a ` tick')).toBe('``');
    expect(codeFenceFor('a `` tick')).toBe('```');
  });

  it('wraps a selection and toggles the markers back off', async () => {
    const { handle } = makeHandle('hello');
    handle.setSelectionForTest(1, 4);
    expect(await execute(handle, 'markdown.bold')).toBe(true);
    expect(handle.getTextForTest()).toBe('h**ell**o');
    // Re-select the wrapped region; toggling strips the pair.
    handle.setSelectionForTest(1, 8);
    expect(await execute(handle, 'markdown.bold')).toBe(true);
    expect(handle.getTextForTest()).toBe('hello');

    handle.setSelectionForTest(0, 5);
    expect(await execute(handle, 'markdown.italic')).toBe(true);
    expect(handle.getTextForTest()).toBe('_hello_');
    handle.setSelectionForTest(0, 7);
    expect(await execute(handle, 'markdown.italic')).toBe(true);
    expect(handle.getTextForTest()).toBe('hello');
    handle.destroy();
  });

  it('inserts an empty marker pair with the caret between them', async () => {
    const { handle } = makeHandle('ab');
    handle.setSelectionForTest(1);
    expect(await execute(handle, 'markdown.bold')).toBe(true);
    expect(handle.getTextForTest()).toBe('a****b');
    expect(handle.getSelectionForTest()).toEqual({ from: 3, to: 3 });
    handle.destroy();
  });

  it.each([
    ['****', 2, 'markdown.bold'],
    ['____', 2, 'markdown.bold'],
    ['__', 1, 'markdown.italic'],
    ['**', 1, 'markdown.italic'],
    ['``', 1, 'markdown.code'],
  ])(
    'recognizes and removes an empty %s mark at the caret',
    async (source, caret, controlId) => {
      const { handle } = makeHandle(source);
      await tick();
      handle.setSelectionForTest(caret);
      expect(buttonOf(handle, controlId).active).toBe(true);
      expect(await execute(handle, controlId)).toBe(true);
      expect(handle.getTextForTest()).toBe('');
      expect(handle.getSelectionForTest()).toEqual({ from: 0, to: 0 });
      handle.destroy();
    },
  );

  it.each([
    ['markdown.bold', '****', 2],
    ['markdown.italic', '__', 1],
    ['markdown.code', '``', 1],
  ])(
    'recognizes toolbar-created empty %s and toggles it back off',
    async (controlId, emptyPair, caret) => {
      const { handle } = makeHandle('');
      expect(await execute(handle, controlId)).toBe(true);
      expect(handle.getTextForTest()).toBe(emptyPair);
      handle.setSelectionForTest(caret);
      expect(buttonOf(handle, controlId).active).toBe(true);
      expect(await execute(handle, controlId)).toBe(true);
      expect(handle.getTextForTest()).toBe('');
      handle.destroy();
    },
  );

  it.each([
    ['heading:1', '# Text', 2],
    ['heading:2', '## Text', 3],
    ['quote', '> Text', 2],
    ['bullet', '- Text', 2],
    ['numbered', '1. Text', 3],
    ['task', '- [ ] Text', 6],
  ])(
    'keeps the caret after the %s prefix when formatting a line',
    async (value, expectedText, expectedCaret) => {
      const { handle } = makeHandle('Text');
      handle.setSelectionForTest(0);
      expect(await execute(handle, 'markdown.block', value)).toBe(true);
      expect(handle.getTextForTest()).toBe(expectedText);
      expect(handle.getSelectionForTest()).toEqual({
        from: expectedCaret,
        to: expectedCaret,
      });
      handle.destroy();
    },
  );

  it('preserves the caret offset in line content when changing its prefix', async () => {
    const { handle } = makeHandle('before after');
    handle.setSelectionForTest('before '.length);
    expect(await execute(handle, 'markdown.block.bullet')).toBe(true);
    expect(handle.getTextForTest()).toBe('- before after');
    expect(handle.getSelectionForTest()).toEqual({ from: 9, to: 9 });
    handle.destroy();
  });

  it('reports provider-computed active state that follows the caret', async () => {
    const { handle } = makeHandle('a **bold** tail and _it_ plus `cd` end');
    await tick();
    // Caret inside bold markers.
    handle.setSelectionForTest(6);
    expect(buttonOf(handle, 'markdown.bold').active).toBe(true);
    expect(buttonOf(handle, 'markdown.italic').active).toBeUndefined();
    expect(buttonOf(handle, 'markdown.code').active).toBeUndefined();
    // Caret on plain text claims nothing.
    handle.setSelectionForTest(0);
    expect(buttonOf(handle, 'markdown.bold').active).toBeUndefined();
    expect(buttonOf(handle, 'markdown.bold').mixed).toBeUndefined();
    // Caret inside italic and code markers.
    handle.setSelectionForTest('a **bold** tail and _'.length + 1);
    expect(buttonOf(handle, 'markdown.italic').active).toBe(true);
    handle.setSelectionForTest('a **bold** tail and _it_ plus `'.length + 1);
    expect(buttonOf(handle, 'markdown.code').active).toBe(true);
    handle.destroy();
  });

  it('reports conservative mixed state for selections crossing format boundaries', async () => {
    const { handle } = makeHandle('**a** plain');
    await tick();
    // Fully wrapped selection is active, not mixed.
    handle.setSelectionForTest(0, 5);
    expect(buttonOf(handle, 'markdown.bold').active).toBe(true);
    expect(buttonOf(handle, 'markdown.bold').mixed).toBeUndefined();
    // A selection spanning marked and plain text is mixed, never active.
    handle.setSelectionForTest(0, 10);
    const bold = buttonOf(handle, 'markdown.bold');
    expect(bold.active).toBeUndefined();
    expect(bold.mixed).toBe(true);
    expect(buttonOf(handle, 'markdown.italic').mixed).toBeUndefined();
    expect(buttonOf(handle, 'markdown.code').mixed).toBeUndefined();
    handle.destroy();
  });

  it('keeps inline-code transformations valid for backtick content', async () => {
    // A selection containing a backtick run gets a longer fence.
    const { handle } = makeHandle('use a`b here');
    await tick();
    handle.setSelectionForTest(4, 7);
    expect(await execute(handle, 'markdown.code')).toBe(true);
    expect(handle.getTextForTest()).toBe('use ``a`b`` here');
    expect(buttonOf(handle, 'markdown.code').active).toBe(true);
    handle.destroy();

    // A fully wrapped selection toggles back to plain source.
    const { handle: wrapped } = makeHandle('use `x` here');
    wrapped.setSelectionForTest(4, 7);
    expect(await execute(wrapped, 'markdown.code')).toBe(true);
    expect(wrapped.getTextForTest()).toBe('use x here');
    wrapped.destroy();
  });

  it('creates links from selections and placeholders from carets', async () => {
    const { handle } = makeHandle('hello world');
    handle.setSelectionForTest(6, 11);
    expect(await execute(handle, 'markdown.link', 'https://w.test')).toBe(true);
    expect(handle.getTextForTest()).toBe('hello [world](https://w.test)');

    const { handle: caret } = makeHandle('before ');
    caret.setSelectionForTest(7);
    expect(await execute(caret, 'markdown.link', 'https://p.test')).toBe(true);
    expect(caret.getTextForTest()).toBe('before [link text](https://p.test)');
    // The placeholder label is selected so typing replaces it immediately.
    expect(caret.getSelectionForTest()).toEqual({ from: 8, to: 17 });
    handle.destroy();
    caret.destroy();
  });

  it('edits an existing link target in place and prefills it', async () => {
    const { handle } = makeHandle('see [lab](https://a.test/x) end');
    await tick();
    // Caret inside the label exposes the current target and link state.
    handle.setSelectionForTest(6);
    expect(inputOf(handle, 'markdown.link').value).toBe('https://a.test/x');
    expect(inputOf(handle, 'markdown.link').active).toBe(true);
    expect(await execute(handle, 'markdown.link', 'https://b.test')).toBe(true);
    // The label is untouched; only the destination is replaced.
    expect(handle.getTextForTest()).toBe('see [lab](https://b.test) end');
    // Submitting returns focus to the editor for continued typing.
    expect(handle.hasFocus()).toBe(true);
    handle.destroy();
  });

  it('reopens toolbar edits identically through the dirty-text path', async () => {
    // Toolbar code never writes canonical bytes directly: every edit flows
    // through onDirtyText, and reopening with those bytes reproduces the
    // exact expected source transformation.
    const seen: string[] = [];
    const { handle } = makeHandle('hello world', (text) => seen.push(text));
    handle.setSelectionForTest(6, 11);
    expect(await execute(handle, 'markdown.link', 'https://w.test')).toBe(true);
    expect(seen.at(-1)).toBe('hello [world](https://w.test)');
    handle.setSelectionForTest(0, 5);
    expect(await execute(handle, 'markdown.bold')).toBe(true);
    expect(seen.at(-1)).toBe('**hello** [world](https://w.test)');

    const { handle: reopened } = makeHandle(seen.at(-1) ?? '');
    expect(reopened.getTextForTest()).toBe('**hello** [world](https://w.test)');
    handle.destroy();
    reopened.destroy();
  });

  it('rejects empty or invalid link destinations without mutating source', async () => {
    const { handle } = makeHandle('keep me');
    handle.setSelectionForTest(0, 4);
    expect(await execute(handle, 'markdown.link', '   ')).toBe(false);
    expect(await execute(handle, 'markdown.link', 'https://a.test/x y')).toBe(
      false,
    );
    expect(await execute(handle, 'markdown.link')).toBe(false);
    expect(handle.getTextForTest()).toBe('keep me');
    handle.destroy();
  });

  it('inserts fenced code blocks distinctly from inline code', async () => {
    const { handle } = makeHandle('hello');
    expect(buttonOf(handle, 'markdown.code-block').label).toBe('Code block');
    handle.setSelectionForTest(0, 5);
    expect(await execute(handle, 'markdown.code-block')).toBe(true);
    expect(handle.getTextForTest()).toBe('```\nhello\n```');
    expect(handle.getSelectionForTest()).toEqual({ from: 4, to: 9 });

    const { handle: caret } = makeHandle('');
    expect(await execute(caret, 'markdown.code-block')).toBe(true);
    expect(caret.getTextForTest()).toBe('```\n\n```');
    expect(caret.getSelectionForTest()).toEqual({ from: 4, to: 4 });
    handle.destroy();
    caret.destroy();
  });

  it('disables unsafe controls inside fenced code', async () => {
    const { handle } = makeHandle('```\ncode body\n```\n\nplain');
    await tick();
    handle.setSelectionForTest(6);
    expect(buttonOf(handle, 'markdown.bold').disabled).toBe(true);
    expect(buttonOf(handle, 'markdown.italic').disabled).toBe(true);
    expect(inputOf(handle, 'markdown.link').disabled).toBe(true);
    expect(buttonOf(handle, 'markdown.code-block').disabled).toBe(true);
    expect(choiceOf(handle, 'markdown.block').disabled).toBe(true);
    handle.setSelectionForTest(20);
    expect(buttonOf(handle, 'markdown.bold').disabled).toBeUndefined();
    expect(inputOf(handle, 'markdown.link').disabled).toBeUndefined();
    handle.destroy();
  });

  it('refuses disabled-context transforms through execute, not just the UI', async () => {
    const { handle } = makeHandle('a `code` b\n\n```\nfenced\n```\n');
    await tick();
    // Bold/italic inside inline code: rejected, source untouched.
    handle.setSelectionForTest(4, 7);
    expect(await execute(handle, 'markdown.bold')).toBe(false);
    expect(await execute(handle, 'markdown.italic')).toBe(false);
    expect(await execute(handle, 'markdown.link', 'https://a.test')).toBe(
      false,
    );
    expect(handle.getTextForTest()).toBe('a `code` b\n\n```\nfenced\n```\n');
    // Code-block insertion and line-style rewrites inside fenced code.
    handle.setSelectionForTest(16);
    expect(await execute(handle, 'markdown.code-block')).toBe(false);
    expect(await execute(handle, 'markdown.code')).toBe(false);
    expect(await execute(handle, 'markdown.block', 'heading:1')).toBe(false);
    expect(handle.getTextForTest()).toBe('a `code` b\n\n```\nfenced\n```\n');
    // Inline code stays toggleable inside InlineCode (so it can be removed).
    handle.setSelectionForTest(2, 8);
    expect(await execute(handle, 'markdown.code')).toBe(true);
    expect(handle.getTextForTest()).toBe('a code b\n\n```\nfenced\n```\n');
    handle.destroy();
  });

  it('updates the line-style selector as the caret moves across contexts', async () => {
    const { handle } = makeHandle(
      '# H1\n\n> quote\n\n- item\n\n- [ ] task\n\npara',
    );
    await tick();
    const cases: Array<[number, string]> = [
      [1, 'heading:1'],
      [8, 'paragraph'],
      [17, 'paragraph'],
      [25, 'paragraph'],
      [36, 'paragraph'],
    ];
    for (const [pos, value] of cases) {
      handle.setSelectionForTest(pos);
      expect(choiceOf(handle, 'markdown.block').value).toBe(value);
    }
    handle.setSelectionForTest(8);
    expect(buttonOf(handle, 'markdown.block.quote').active).toBe(true);
    expect(buttonOf(handle, 'markdown.block.quote').icon).toBe('quote');
    handle.setSelectionForTest(17);
    expect(buttonOf(handle, 'markdown.block.bullet').active).toBe(true);
    expect(buttonOf(handle, 'markdown.block.bullet').icon).toBe('list-bullet');
    handle.setSelectionForTest(25);
    expect(buttonOf(handle, 'markdown.block.task').active).toBe(true);
    expect(buttonOf(handle, 'markdown.block.numbered').icon).toBe(
      'list-numbered',
    );
    expect(buttonOf(handle, 'markdown.block.task').icon).toBe('list-check');
    handle.destroy();
  });

  it('keeps headings in the selector and gives lists, quote and divider source buttons', async () => {
    const { handle } = makeHandle('Text');
    expect(
      choiceOf(handle, 'markdown.block').options.map((option) => option.value),
    ).toEqual([
      'paragraph',
      'heading:1',
      'heading:2',
      'heading:3',
      'heading:4',
      'heading:5',
    ]);
    expect(await execute(handle, 'markdown.block', 'heading:5')).toBe(true);
    expect(handle.getTextForTest()).toBe('##### Text');
    expect(await execute(handle, 'markdown.block.numbered')).toBe(true);
    expect(handle.getTextForTest()).toBe('1. Text');
    expect(buttonOf(handle, 'markdown.block.numbered').active).toBe(true);
    expect(await execute(handle, 'markdown.block.numbered')).toBe(true);
    expect(handle.getTextForTest()).toBe('Text');
    expect(await execute(handle, 'markdown.divider')).toBe(true);
    expect(handle.getTextForTest()).toBe('Text\n\n---\n');
    handle.destroy();
  });

  it('inserts a table from bounded menu values', async () => {
    const { handle } = makeHandle('');
    expect(await execute(handle, 'markdown.table', '4:51:blank')).toBe(false);
    expect(await execute(handle, 'markdown.table', '4:2:blank')).toBe(true);
    const lines = handle.getTextForTest().trimEnd().split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe('|   |   |   |   |');
    expect(lines[1]).toBe('| --- | --- | --- | --- |');
    handle.destroy();
  });

  it('keeps toolbar snapshots bounded on large documents', async () => {
    // Performance guard: snapshot work is line/selection-scoped, so moving
    // the caret across a large document stays cheap. The test timeout is the
    // backstop — full-document serialization per cursor move would blow it.
    const lines = Array.from(
      { length: 10_000 },
      (_, index) => `paragraph line ${index}`,
    );
    // Keep the fence near the top: the incremental parse covers it within
    // the first frame, so detection doesn't depend on background progress.
    lines.splice(10, 0, '```', 'fenced body', '```');
    const { handle } = makeHandle(lines.join('\n'));
    await tick();
    for (const lineNo of [1, 2_500, 5_002, 7_500, 10_000]) {
      const line = lines.slice(0, lineNo).join('\n').length + 1;
      handle.setSelectionForTest(
        Math.min(line, handle.getTextForTest().length),
      );
      const snapshot = snapshotOf(handle);
      expect(snapshot.context).toMatch(/^Markdown /);
      expect(
        snapshot.controls.some((control) => control.id === 'markdown.block'),
      ).toBe(true);
    }
    // Inside the fenced body the format group is inapplicable, not stale.
    const fencedAt = lines.slice(0, 11).join('\n').length + 1;
    handle.setSelectionForTest(fencedAt);
    expect(buttonOf(handle, 'markdown.bold').disabled).toBe(true);
    handle.destroy();
  });

  it('notifies tool listeners on doc and selection changes without dirtying on caret moves', async () => {
    const seen: string[] = [];
    const { handle } = makeHandle('one\n\ntwo', (text) => seen.push(text));
    const tools = handle.tools;
    if (tools === undefined) throw new Error('semantic tools are unavailable');
    let notifications = 0;
    const subscription = tools.onDidChange(() => {
      notifications += 1;
    });
    handle.setSelectionForTest(0);
    expect(notifications).toBeGreaterThan(0);
    const dirtyBefore = seen.length;
    handle.setSelectionForTest(5);
    expect(notifications).toBeGreaterThan(1);
    expect(seen.length).toBe(dirtyBefore);
    handle.setSelectionForTest(0, 3);
    expect(await execute(handle, 'markdown.bold')).toBe(true);
    expect(seen.at(-1)).toBe('**one**\n\ntwo');
    subscription.dispose();
    handle.destroy();
  });

  it('undoes toolbar edits through provider-local history', async () => {
    const { handle } = makeHandle('hello');
    handle.setSelectionForTest(1, 4);
    expect(await execute(handle, 'markdown.bold')).toBe(true);
    expect(handle.getTextForTest()).toBe('h**ell**o');
    expect(handle.canExecCommand('undo')).toBe(true);
    handle.execCommand('undo');
    expect(handle.getTextForTest()).toBe('hello');
    expect(handle.canExecCommand('redo')).toBe(true);
    handle.execCommand('redo');
    expect(handle.getTextForTest()).toBe('h**ell**o');
    handle.destroy();
  });

  it('keeps keyboard and toolbar formatting on the same source outcomes', async () => {
    const { handle: toolbar } = makeHandle('hello');
    toolbar.setSelectionForTest(0, 5);
    await execute(toolbar, 'markdown.bold');
    const toolbarText = toolbar.getTextForTest();

    const { parent, handle: keyboard } = makeHandle('hello');
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
    toolbar.destroy();
    keyboard.destroy();
  });

  it('keeps toolbar selection context isolated per editor', async () => {
    const { handle: first } = makeHandle('**a**');
    const { handle: second } = makeHandle('plain');
    await tick();
    first.setSelectionForTest(2);
    second.setSelectionForTest(0);
    expect(buttonOf(first, 'markdown.bold').active).toBe(true);
    expect(buttonOf(second, 'markdown.bold').active).toBeUndefined();
    first.destroy();
    second.destroy();
  });
});
