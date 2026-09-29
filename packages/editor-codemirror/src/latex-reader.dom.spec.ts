// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  latexModel,
  latexKindId,
  type DocumentSession,
  type LaTeXSourceResolver,
} from '@froglight/foundation';
import { MockLaTeXProvider } from '@froglight/foundation/testing';
import { LatexDocumentReaderProvider } from './latex-reader.js';
import { PREVIEW_SANDBOX, resolveLatexAddress } from './latex-shared.js';

const FIXTURE_HTML =
  '<!DOCTYPE html><html><head></head><body><h2 id="sec-1">1 One</h2><p>alpha</p><h2 id="sec-2">2 Two</h2><p>beta</p></body></html>';

function makeSession(initialRaw: string) {
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

function makeDeps(overrides: Record<string, unknown> = {}) {
  return {
    latexProvider: () => new MockLaTeXProvider({ html: FIXTURE_HTML }),
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

describe('LatexDocumentReaderProvider (jsdom)', () => {
  it('suppresses the browser menu inside each preview document', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const { session } = makeSession('\\section{One}');
    const handle = new LatexDocumentReaderProvider(makeDeps()).createReader({ session, parent });
    const iframe = parent.querySelector('iframe')!;
    iframe.dispatchEvent(new Event('load'));
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    iframe.contentDocument!.body.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    handle.destroy();
    parent.remove();
  });

  it('mounts a sandboxed preview without scripts and without a source editor', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const { session } = makeSession('\\section{One}\nalpha\n');
    const provider = new LatexDocumentReaderProvider(makeDeps());
    const handle = provider.createReader({ session, parent });

    const iframe = parent.querySelector('iframe');
    expect(iframe).not.toBeNull();
    expect(iframe!.getAttribute('sandbox')).toBe(PREVIEW_SANDBOX);
    expect(iframe!.getAttribute('sandbox')).not.toContain('allow-scripts');
    expect(parent.querySelector('.cm-editor')).toBeNull();
    handle.destroy();
  });

  it('mirrors the shell theme into the isolated preview document', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const outer = document.documentElement;
    const previous = outer.getAttribute('data-theme');
    outer.setAttribute('data-theme', 'dark');
    try {
      const { session } = makeSession('\\section{One}\nalpha\n');
      const provider = new LatexDocumentReaderProvider(makeDeps());
      const handle = provider.createReader({ session, parent });
      try {
        const iframe = parent.querySelector('iframe')!;
        iframe.dispatchEvent(new Event('load'));
        expect(iframe.contentDocument?.documentElement.getAttribute('data-theme')).toBe('dark');
        // Switching the shell world propagates without a re-render.
        outer.setAttribute('data-theme', 'light');
        await flush();
        expect(iframe.contentDocument?.documentElement.getAttribute('data-theme')).toBe('light');
        outer.removeAttribute('data-theme');
        await flush();
        expect(iframe.contentDocument?.documentElement.hasAttribute('data-theme')).toBe(false);
      } finally {
        handle.destroy();
      }
    } finally {
      if (previous === null) outer.removeAttribute('data-theme');
      else outer.setAttribute('data-theme', previous);
      parent.remove();
    }
  });

  it('mirrors pane-local floating-toolbar clearance into the preview', () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const { session } = makeSession('\\section{One}\nalpha\n');
    const provider = new LatexDocumentReaderProvider(makeDeps());
    const handle = provider.createReader({ session, parent });
    try {
      const wrapper = parent.querySelector<HTMLElement>(
        '.froglight-latex-reader',
      );
      const iframe = parent.querySelector<HTMLIFrameElement>('iframe');
      expect(wrapper).not.toBeNull();
      expect(iframe).not.toBeNull();
      if (wrapper === null || iframe === null)
        throw new Error('missing LaTeX preview skeleton');
      wrapper.style.setProperty('--_fl-editor-floating-top', '58px');
      iframe.dispatchEvent(new Event('load'));
      expect(
        iframe.contentDocument?.documentElement.style.getPropertyValue(
          '--_fl-editor-floating-top',
        ),
      ).toBe('58px');
    } finally {
      handle.destroy();
      parent.remove();
    }
  });

  it('renders provider HTML into the iframe on update', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const { session } = makeSession('\\section{One}\nalpha\n');
    const provider = new LatexDocumentReaderProvider(makeDeps());
    const handle = provider.createReader({ session, parent });
    handle.update();
    await flush();
    await flush();
    const iframe = parent.querySelector('iframe')!;
    expect(iframe.getAttribute('srcdoc')).toContain('id="sec-1"');
    handle.destroy();
  });

  it('degrades to a recoverable placeholder when no provider is bound', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const { session } = makeSession('\\section{One}\n');
    const provider = new LatexDocumentReaderProvider(
      makeDeps({ latexProvider: () => null }),
    );
    const handle = provider.createReader({ session, parent });
    await flush();
    await flush();
    const srcdoc = parent.querySelector('iframe')!.getAttribute('srcdoc') ?? '';
    expect(srcdoc).toContain('unavailable');
    expect(srcdoc).toContain('Content-Security-Policy');
    handle.destroy();
  });

  it('keeps preview clicks inside the preview', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const { session } = makeSession(
      '\\section{One}\nalpha\n\\section{Two}\nbeta\n',
    );
    const provider = new LatexDocumentReaderProvider(makeDeps());
    const handle = provider.createReader({ session, parent });
    await flush();
    await flush();
    const doc = parent.querySelector('iframe')!.contentDocument;
    expect(doc).not.toBeNull();
    expect(() =>
      doc!
        .querySelector('p')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    ).not.toThrow();
    handle.destroy();
  });

  it('reveals a section address by scrolling the preview', async () => {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const { session } = makeSession(
      '\\section{One}\nalpha\n\\section{Two}\nbeta\n',
    );
    const provider = new LatexDocumentReaderProvider(makeDeps());
    const handle = provider.createReader({ session, parent });
    await flush();
    await flush();
    expect(() => handle.revealAddress?.('Two')).not.toThrow();
    handle.destroy();
  });

  it('closes the provider handle and detaches on destroy', async () => {
    const parent = document.createElement('div');
    const host = document.createElement('div');
    host.appendChild(parent);
    document.body.appendChild(host);
    const mock = new MockLaTeXProvider({ html: FIXTURE_HTML });
    const { session } = makeSession('\\section{One}\n');
    const provider = new LatexDocumentReaderProvider(
      makeDeps({ latexProvider: () => mock }),
    );
    const handle = provider.createReader({ session, parent });
    await flush();
    await flush();
    expect(mock.activeHandleCountForTest()).toBe(1);
    handle.destroy();
    expect(mock.activeHandleCountForTest()).toBe(0);
    expect(host.querySelector('.froglight-latex-reader')).toBeNull();
  });

  it('binds to the latex document kind under its own provider id', () => {
    const provider = new LatexDocumentReaderProvider(makeDeps());
    expect(provider.id).toBe('latex-reader');
    expect(provider.kindIds).toEqual([latexKindId]);
  });
});

describe('LaTeX reader revealAddress accepts extractor slug addresses', () => {
  const SOURCE = [
    '\\section{Introduction}',
    'one',
    '\\section{Introduction}',
    'two',
    '\\section{Methods & Materials}',
    'three',
  ].join('\n');
  const DUP_HTML =
    '<!DOCTYPE html><html><head></head><body>' +
    '<h2>1 Introduction</h2><p>one</p>' +
    '<h2>2 Introduction</h2><p>two</p>' +
    '<h2>3 Methods &amp; Materials</h2><p>three</p>' +
    '</body></html>';

  async function makeRevealedHandle() {
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const { session } = makeSession(SOURCE);
    const provider = new LatexDocumentReaderProvider(
      makeDeps({ latexProvider: () => new MockLaTeXProvider({ html: DUP_HTML }) }),
    );
    const handle = provider.createReader({ session, parent });
    await flush();
    await flush();
    // jsdom does not parse iframe srcdoc into contentDocument on its own;
    // project the same provider HTML explicitly. revealAddress queries the
    // live contentDocument, so this exercises the real scroll path.
    const frame = parent.querySelector('iframe')!;
    const doc = frame.contentDocument!;
    doc.open();
    doc.write(DUP_HTML);
    doc.close();
    const headings = Array.from(doc.querySelectorAll('h2'));
    expect(headings).toHaveLength(3);
    const scrolled = headings.map((heading) => {
      const spy = vi.fn();
      heading.scrollIntoView = spy;
      return spy;
    });
    return { parent, handle, scrolled };
  }

  it('scrolls the preview to the slug heading', async () => {
    const { parent, handle, scrolled } = await makeRevealedHandle();
    try {
      handle.revealAddress?.('methods-materials');
      expect(scrolled[2]).toHaveBeenCalledTimes(1);
      expect(scrolled[2]).toHaveBeenCalledWith({ block: 'start' });
      expect(scrolled[0]).not.toHaveBeenCalled();
      expect(scrolled[1]).not.toHaveBeenCalled();
    } finally {
      handle.destroy();
      parent.remove();
    }
  });

  it('resolves duplicate titles deterministically per dedup order', async () => {
    const { parent, handle, scrolled } = await makeRevealedHandle();
    try {
      handle.revealAddress?.('introduction');
      expect(scrolled[0]).toHaveBeenCalledTimes(1);
      expect(scrolled[1]).not.toHaveBeenCalled();
      handle.revealAddress?.('introduction-1');
      expect(scrolled[1]).toHaveBeenCalledTimes(1);
    } finally {
      handle.destroy();
      parent.remove();
    }
  });

  it('reaches every row of suffix-colliding titles at its own heading', async () => {
    const collisionSource = [
      '\\section{Hello}',
      'one',
      '\\section{Hello}',
      'two',
      '\\section{Hello-1}',
      'three',
    ].join('\n');
    const collisionHtml =
      '<!DOCTYPE html><html><head></head><body>' +
      '<h2>1 Hello</h2><p>one</p>' +
      '<h2>2 Hello</h2><p>two</p>' +
      '<h2>3 Hello-1</h2><p>three</p>' +
      '</body></html>';
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const { session } = makeSession(collisionSource);
    const provider = new LatexDocumentReaderProvider(
      makeDeps({ latexProvider: () => new MockLaTeXProvider({ html: collisionHtml }) }),
    );
    const handle = provider.createReader({ session, parent });
    await flush();
    await flush();
    const frame = parent.querySelector('iframe')!;
    const doc = frame.contentDocument!;
    doc.open();
    doc.write(collisionHtml);
    doc.close();
    const headings = Array.from(doc.querySelectorAll('h2'));
    expect(headings).toHaveLength(3);
    const scrolled = headings.map((heading) => {
      const spy = vi.fn();
      heading.scrollIntoView = spy;
      return spy;
    });
    try {
      handle.revealAddress?.('hello');
      expect(scrolled[0]).toHaveBeenCalledTimes(1);
      handle.revealAddress?.('hello-1');
      expect(scrolled[1]).toHaveBeenCalledTimes(1);
      handle.revealAddress?.('hello-1-1');
      expect(scrolled[2]).toHaveBeenCalledTimes(1);
      scrolled.forEach((spy) => spy.mockClear());
      expect(() => handle.revealAddress?.('hello-1-2')).not.toThrow();
      for (const spy of scrolled) expect(spy).not.toHaveBeenCalled();
    } finally {
      handle.destroy();
      parent.remove();
    }
  });

  it('keeps section-<line> fallbacks globally unique against real slugs (round-trip)', async () => {
    // Same extractor fixture as the edit-mode round-trip: `$$$` on line 1
    // takes `section-1`, the real `Section-1` on line 2 takes `section-1-1`.
    const fallbackSource = ['\\section{Hello}', '\\section{$$$}', '\\section{Section-1}'].join('\n');
    expect(resolveLatexAddress(fallbackSource, 'hello')).toMatchObject({ title: 'Hello', line: 0 });
    expect(resolveLatexAddress(fallbackSource, 'section-1')).toMatchObject({ title: '$$$', line: 1 });
    expect(resolveLatexAddress(fallbackSource, 'section-1-1')).toMatchObject({ title: 'Section-1', line: 2 });
    const fallbackHtml =
      '<!DOCTYPE html><html><head></head><body>' +
      '<h2>1 Hello</h2><p>one</p>' +
      '<h2>2 $$$</h2><p>two</p>' +
      '<h2>3 Section-1</h2><p>three</p>' +
      '</body></html>';
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const { session } = makeSession(fallbackSource);
    const provider = new LatexDocumentReaderProvider(
      makeDeps({ latexProvider: () => new MockLaTeXProvider({ html: fallbackHtml }) }),
    );
    const handle = provider.createReader({ session, parent });
    await flush();
    await flush();
    const frame = parent.querySelector('iframe')!;
    const doc = frame.contentDocument!;
    doc.open();
    doc.write(fallbackHtml);
    doc.close();
    const headings = Array.from(doc.querySelectorAll('h2'));
    expect(headings).toHaveLength(3);
    const scrolled = headings.map((heading) => {
      const spy = vi.fn();
      heading.scrollIntoView = spy;
      return spy;
    });
    try {
      handle.revealAddress?.('section-1');
      expect(scrolled[1]).toHaveBeenCalledTimes(1);
      expect(scrolled[2]).not.toHaveBeenCalled();
      scrolled.forEach((spy) => spy.mockClear());
      handle.revealAddress?.('section-1-1');
      expect(scrolled[2]).toHaveBeenCalledTimes(1);
      expect(scrolled[1]).not.toHaveBeenCalled();
    } finally {
      handle.destroy();
      parent.remove();
    }
  });

  it('treats commented-out sections as unknown: resolver null + silent no-op', async () => {
    const ghostSource = ['% \\section{Ghost}', '\\section{Real}', 'body'].join('\n');
    expect(resolveLatexAddress(ghostSource, 'Ghost')).toBeNull();
    expect(resolveLatexAddress(ghostSource, 'ghost')).toBeNull();
    expect(resolveLatexAddress(ghostSource, 'real')).toMatchObject({ title: 'Real', line: 1 });
    const ghostHtml =
      '<!DOCTYPE html><html><head></head><body><h2>1 Real</h2><p>body</p></body></html>';
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    const { session } = makeSession(ghostSource);
    const provider = new LatexDocumentReaderProvider(
      makeDeps({ latexProvider: () => new MockLaTeXProvider({ html: ghostHtml }) }),
    );
    const handle = provider.createReader({ session, parent });
    await flush();
    await flush();
    const frame = parent.querySelector('iframe')!;
    const doc = frame.contentDocument!;
    doc.open();
    doc.write(ghostHtml);
    doc.close();
    const headings = Array.from(doc.querySelectorAll('h2'));
    expect(headings).toHaveLength(1);
    const spy = vi.fn();
    headings[0]!.scrollIntoView = spy;
    try {
      expect(() => handle.revealAddress?.('Ghost')).not.toThrow();
      expect(() => handle.revealAddress?.('ghost')).not.toThrow();
      expect(spy).not.toHaveBeenCalled();
      handle.revealAddress?.('real');
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      handle.destroy();
      parent.remove();
    }
  });

  it('resolves exact-title addresses and misses unknown addresses silently', async () => {
    const { parent, handle, scrolled } = await makeRevealedHandle();
    try {
      handle.revealAddress?.('Introduction');
      expect(scrolled[0]).toHaveBeenCalledTimes(1);
      scrolled.forEach((spy) => spy.mockClear());
      expect(() => handle.revealAddress?.('no-such-section')).not.toThrow();
      expect(() => handle.revealAddress?.('')).not.toThrow();
      expect(() => handle.revealAddress?.('introduction-2')).not.toThrow();
      for (const spy of scrolled) expect(spy).not.toHaveBeenCalled();
    } finally {
      handle.destroy();
      parent.remove();
    }
  });
});
