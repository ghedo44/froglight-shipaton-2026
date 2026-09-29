// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  latexModel,
  markdownModel,
  type DocumentSession,
  type LaTeXSourceResolver,
  type MarkdownEditorHandle,
} from '@froglight/foundation';
import { MockLaTeXProvider } from '@froglight/foundation/testing';
import {
  LatexDocumentEditorProvider,
  LatexDocumentReaderProvider,
  MarkdownDocumentEditorProvider,
  type LatexEditorSkeleton as LatexEditorSkeletonData,
  type LatexReaderSkeleton as LatexReaderSkeletonData,
  type MarkdownSkeleton,
} from '../index.js';
import { CodemirrorMarkdownSkeleton } from './CodemirrorMarkdownSkeleton.jsx';
import hostStyles from './CodemirrorHost.module.css';
import hostCss from './CodemirrorHost.module.css?inline';
import latexEditorCss from './LatexEditorSkeleton.css?inline';
import { LatexEditorSkeleton } from './LatexEditorSkeleton.jsx';
import { LatexReaderSkeleton } from './LatexReaderSkeleton.jsx';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

type CmHandle = MarkdownEditorHandle & {
  replaceAll(next: string): void;
  getTextForTest(): string;
  canExecCommand(id: 'undo' | 'redo'): boolean;
};

function makeMarkdownSession(initialRaw = '# Hello\n') {
  const model = markdownModel(initialRaw);
  const session = {
    model,
    markDirty: () => {
      (model as { raw?: string }).raw = model.raw;
    },
  };
  return session as never;
}

function makeLatexSession(initialRaw: string) {
  const model = latexModel(initialRaw);
  const dirty = { count: 0 };
  const session = {
    model,
    markDirty: () => {
      dirty.count += 1;
    },
  };
  return { session: session as unknown as DocumentSession, model, dirty };
}

function makeLatexDeps(overrides: Record<string, unknown> = {}) {
  return {
    latexProvider: () => new MockLaTeXProvider({ html: '<p>unused</p>' }),
    createResolver: ((_documentPath: string) => ({
      readFile: async () => '',
      assetUrl: async () => 'blob:mock',
    })) as (documentPath: string) => LaTeXSourceResolver,
    resolveDocumentPath: () => 'papers/thesis.tex',
    renderDebounceMillis: 5,
    ...overrides,
  };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  host = null;
  root = null;
});

afterEach(() => {
  if (root !== null) act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('codemirror markdown skeleton (React chrome)', () => {
  it('commits the identical skeleton structure with refs populated', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const skeletonRef: { current: MarkdownSkeleton | null } = {
      current: null,
    };
    await act(async () => {
      root!.render(createElement(CodemirrorMarkdownSkeleton, { skeletonRef }));
    });
    const skeleton = skeletonRef.current;
    expect(skeleton).not.toBeNull();
    expect(skeleton!.root.className).toBe(
      `froglight-markdown-editor ${hostStyles['froglight-cm-host']}`,
    );
    // Sizing lives in CSS (flex shrink chain), not inline styles: the host
    // must stay shrinkable inside the keyboard-shrinking pane track.
    expect(skeleton!.root.style.height).toBe('');
    expect(host.contains(skeleton!.root)).toBe(true);
  });

  it('provider creation synchronously commits chrome the engine consumes', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const provider = new MarkdownDocumentEditorProvider();
    let handle: CmHandle | undefined;
    await act(async () => {
      handle = provider.createEditor({
        session: makeMarkdownSession(),
        parent,
        initialText: '# Hello',
        onDirtyText: () => undefined,
      }) as CmHandle;
    });
    // No extra flush: the CodeMirror host exists immediately, preserving
    // the synchronous createEditor contract.
    const editor = parent.querySelector('.cm-editor');
    expect(editor).not.toBeNull();
    expect(parent.querySelector('.froglight-markdown-editor')).not.toBeNull();
    expect(handle!.tools).toBeDefined();
    expect(handle!.canExecCommand('undo')).toBe(false);
    handle!.destroy();
    expect(parent.querySelector('.cm-editor')).toBeNull();
    expect(parent.childElementCount).toBe(0);
    parent.remove();
  });

  it('keeps undo history and dirty-text bridging through the session path', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const provider = new MarkdownDocumentEditorProvider();
    const seen: string[] = [];
    let handle: CmHandle | undefined;
    await act(async () => {
      handle = provider.createEditor({
        session: makeMarkdownSession(),
        parent,
        initialText: 'v1',
        onDirtyText: (text) => seen.push(text),
      }) as CmHandle;
    });
    handle!.replaceAll('v2');
    expect(seen.at(-1)).toBe('v2');
    expect(handle!.getTextForTest()).toBe('v2');
    expect(handle!.canExecCommand('undo')).toBe(true);
    handle!.execCommand('undo');
    expect(handle!.getTextForTest()).toBe('v1');
    expect(handle!.canExecCommand('redo')).toBe(true);
    handle!.execCommand('redo');
    expect(handle!.getTextForTest()).toBe('v2');
    handle!.destroy();
    expect(parent.childElementCount).toBe(0);
    parent.remove();
  });

  it('falls back to the headless handle without an element host', () => {
    const provider = new MarkdownDocumentEditorProvider();
    const seen: string[] = [];
    const handle = provider.createEditor({
      session: makeMarkdownSession(),
      parent: {},
      initialText: 'v1',
      onDirtyText: (text) => seen.push(text),
    }) as CmHandle;
    expect(
      document.querySelector(`.${hostStyles['froglight-cm-host']}`),
    ).toBeNull();
    expect(handle.getTextForTest()).toBe('v1');
    expect(handle.canExecCommand('undo')).toBe(false);
    handle.replaceAll('v2');
    expect(seen.at(-1)).toBe('v2');
    expect(handle.canExecCommand('undo')).toBe(true);
    handle.execCommand('undo');
    expect(handle.getTextForTest()).toBe('v1');
    handle.destroy();
  });
});

describe('codemirror latex editor skeleton (React chrome)', () => {
  it('commits the identical skeleton structure with refs populated', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const skeletonRef: { current: LatexEditorSkeletonData | null } = {
      current: null,
    };
    await act(async () => {
      root!.render(createElement(LatexEditorSkeleton, { skeletonRef }));
    });
    const skeleton = skeletonRef.current;
    expect(skeleton).not.toBeNull();
    expect(skeleton!.root.className).toBe('froglight-latex-editor');
    expect(skeleton!.source.className).toBe('froglight-latex-source');
    expect(skeleton!.root.contains(skeleton!.source)).toBe(true);
    // No permanent provider-owned status/diagnostics strip: diagnostics
    // live in the unified toolbar as semantic controls (latex-toolbar-spec).
    expect(host.querySelector('.froglight-latex-status')).toBeNull();
    expect(host.querySelector('.froglight-latex-diagnostics')).toBeNull();
  });

  it('provider creation synchronously commits chrome the engine consumes', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const { session } = makeLatexSession('\\section{One}\nalpha\n');
    const provider = new LatexDocumentEditorProvider(makeLatexDeps());
    let handle: ReturnType<LatexDocumentEditorProvider['createEditor']>;
    await act(async () => {
      handle = provider.createEditor({ session, parent });
    });
    // No extra flush: the CodeMirror view exists immediately, preserving
    // the synchronous createEditor contract. Edit mode keeps no permanent
    // status strip; diagnostics arrive via the toolbar snapshot.
    expect(parent.querySelector('.cm-editor')).not.toBeNull();
    expect(parent.querySelector('.froglight-latex-source')).not.toBeNull();
    expect(parent.querySelector('.froglight-latex-status')).toBeNull();
    expect(parent.querySelector('.froglight-latex-diagnostics')).toBeNull();
    expect(handle!.execCommand('undo')).toBe(false);
    handle!.destroy();
    expect(parent.querySelector('.cm-editor')).toBeNull();
    expect(parent.childElementCount).toBe(0);
    parent.remove();
  });

  it('pushes edits into the session model with undo history intact', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const { session, model, dirty } = makeLatexSession(
      '\\section{One}\nalpha\n',
    );
    const provider = new LatexDocumentEditorProvider(makeLatexDeps());
    type LatexTestHandle = ReturnType<
      LatexDocumentEditorProvider['createEditor']
    > & {
      replaceTextForTest(next: string): void;
      canExecCommand(id: 'undo' | 'redo'): boolean;
    };
    let handle: LatexTestHandle | undefined;
    await act(async () => {
      handle = provider.createEditor({
        session,
        parent,
      }) as unknown as LatexTestHandle;
    });
    handle!.replaceTextForTest('\\section{One}\nalphaX\n');
    expect(model.raw).toContain('alphaX');
    expect(dirty.count).toBeGreaterThan(0);
    expect(handle!.canExecCommand('undo')).toBe(true);
    handle!.execCommand('undo');
    expect(handle!.canExecCommand('redo')).toBe(true);
    handle!.destroy();
    expect(parent.childElementCount).toBe(0);
    parent.remove();
  });
});

describe('codemirror latex reader skeleton (React chrome)', () => {
  it('commits the identical skeleton structure with refs populated', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const skeletonRef: { current: LatexReaderSkeletonData | null } = {
      current: null,
    };
    await act(async () => {
      root!.render(createElement(LatexReaderSkeleton, { skeletonRef }));
    });
    const skeleton = skeletonRef.current;
    expect(skeleton).not.toBeNull();
    expect(skeleton!.root.className).toBe('froglight-latex-reader');
    expect(skeleton!.frame.tagName.toLowerCase()).toBe('iframe');
    expect(skeleton!.frame.getAttribute('sandbox')).toBe('allow-same-origin');
    expect(skeleton!.frame.getAttribute('sandbox')).not.toContain(
      'allow-scripts',
    );
    expect(skeleton!.frame.getAttribute('title')).toBe('LaTeX preview');
    expect(skeleton!.frame.srcdoc).toContain('Rendering');
    expect(skeleton!.root.contains(skeleton!.frame)).toBe(true);
  });

  it('provider creation synchronously commits the iframe host', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const { session } = makeLatexSession('\\section{One}\nalpha\n');
    const provider = new LatexDocumentReaderProvider(makeLatexDeps());
    let handle: ReturnType<LatexDocumentReaderProvider['createReader']>;
    await act(async () => {
      handle = provider.createReader({ session, parent });
    });
    // No extra flush: the sandboxed host exists immediately, preserving
    // the synchronous createReader contract.
    const iframe = parent.querySelector('iframe');
    expect(iframe).not.toBeNull();
    expect(iframe!.getAttribute('sandbox')).not.toContain('allow-scripts');
    expect(parent.querySelector('.cm-editor')).toBeNull();
    handle!.destroy();
    expect(parent.querySelector('iframe')).toBeNull();
    expect(parent.childElementCount).toBe(0);
    parent.remove();
  });

  it('renders provider HTML into the React-committed iframe', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const { session } = makeLatexSession('\\section{One}\nalpha\n');
    const mock = new MockLaTeXProvider({
      html: '<h2>One</h2><p>alpha</p>',
    });
    const provider = new LatexDocumentReaderProvider(
      makeLatexDeps({ latexProvider: () => mock }),
    );
    let handle: ReturnType<LatexDocumentReaderProvider['createReader']>;
    await act(async () => {
      handle = provider.createReader({ session, parent });
    });
    handle!.update();
    await flush();
    await flush();
    const iframe = parent.querySelector('iframe')!;
    expect(iframe.getAttribute('srcdoc')).toContain('<h2>One</h2>');
    expect(mock.activeHandleCountForTest()).toBe(1);
    // Unmount the React owner before engine teardown: same order the
    // provider uses, so no React-managed node is yanked mid-teardown.
    handle!.destroy();
    expect(mock.activeHandleCountForTest()).toBe(0);
    expect(parent.childElementCount).toBe(0);
    parent.remove();
  });
});

describe('codemirror host styles (token consumer, not token owner)', () => {
  it('defines no:root tokens: values come from the --fl-* contract', () => {
    expect(hostCss.replace(/\/\*[\s\S]*?\*\//g, '')).not.toMatch(
      /^\s*:root\s*\{/m,
    );
  });

  it('leaves vertical scrolling to the CodeMirror scroller', () => {
    // Scroll-ownership invariant: the host may shrink with the pane but
    // must never become a second vertical scroll container, and the
    // CodeMirror scroller rule the engine scrolls must exist. Deliberately
    // property-agnostic (a contain-size or grid refactor of the host keeps
    // passing as long as ownership holds).
    const css = hostCss.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).toContain('.cm-scroller');
    expect(css).not.toMatch(/overflow-y:\s*(auto|scroll)/);
    expect(css).toMatch(/min-height:\s*0/);
  });
});

describe('latex editor styles (scroll ownership + headspace, no strips)', () => {
  const css = () => latexEditorCss.replace(/\/\*[\s\S]*?\*\//g, '');

  it('defines no:root tokens: values come from the --fl-* contract', () => {
    expect(css()).not.toMatch(/^\s*:root\s*\{/m);
  });

  it('leaves vertical scrolling to the source scroller alone', () => {
    // scroll-ownership invariant (mirrors the markdown host pin):
    // the source pane is the flex-constrained box, `.cm-editor` fills it,
    // and only `.cm-scroller` scrolls beneath the floating toolbar. No
    // provider `overflow-y` rule may compete with the engine base.
    expect(css()).toContain('.froglight-latex-source .cm-editor');
    expect(css()).toMatch(/\.froglight-latex-source\s+\.cm-editor\s*\{[^}]*height:\s*100%/s);
    expect(css()).toContain('.froglight-latex-source .cm-scroller');
    expect(css()).not.toMatch(/overflow-y:\s*(auto|scroll)/);
    expect(css()).toMatch(/min-height:\s*0/);
  });

  it('reserves scroller headspace and end pasture like the markdown reference', () => {
    // First lines stay clear of the floating islands while unscrolled and
    // final lines stay reachable: inherited toolbar headspace (44px when
    // standalone) plus 45vh end pasture, scoped to the source scroller.
    expect(css()).toMatch(
      /\.froglight-latex-source\s+\.cm-scroller\s*\{[^}]*padding:\s*max\(44px,\s*var\(--_fl-editor-floating-top,\s*0px\)\)\s+0\s+45vh/s,
    );
  });

  it('adds no permanent provider-owned strip or second row', () => {
    // Diagnostics and status live in the unified toolbar as semantic
    // controls; edit mode keeps no persistent visible chrome that would
    // regain vertical space under the floating islands (latex-toolbar-spec
    // completion gate, CSS-level pin beside the DOM-level pins).
    expect(css()).not.toMatch(/froglight-latex-status/);
    expect(css()).not.toMatch(/froglight-latex-diagnostics/);
  });
});
