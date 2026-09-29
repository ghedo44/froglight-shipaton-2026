/**
 * Adapter tests for the LaTeX.js provider.
 *
 * Exercises the adapter contract surface — flattener integration, asset URL
 * substitution, diagnostics normalization, preview document hardening —
 * against the real library under jsdom. Math fixtures are avoided
 * deliberately: KaTeX rejects the jsdom quirks-mode document, which is a
 * test-environment artifact, not an adapter behavior.
 */
import { describe, expect, it } from 'vitest';
import {
  buildPreviewDocument,
  LatexJsProvider,
  LATEXJS_PREVIEW_CSP,
  LATEXJS_SUPPORTED_PACKAGES,
} from './index.js';
import type { LaTeXSourceResolver } from '@froglight/foundation';

const BS = String.fromCharCode(92);
const doc = (body: string) =>
  [`${BS}documentclass{article}`, `${BS}begin{document}`, body, `${BS}end{document}`].join('\n');

function resolver(overrides: Partial<LaTeXSourceResolver> = {}): LaTeXSourceResolver {
  return {
    readFile: async () => {
      throw latexDenied();
    },
    assetUrl: async (path) => `blob:mock/${path}`,
    ...overrides,
  };
}

function latexDenied(): Error & { code: string } {
  const error = new Error('denied') as Error & { code: string };
  error.code = 'LATEX_RESOLVE_DENIED';
  return error;
}

describe('LatexJsProvider', () => {
  it('renders a simple article with hardened preview document markup', async () => {
    const provider = new LatexJsProvider();
    const handle = await provider.open({
      entry: [`${BS}documentclass{article}`, `${BS}title{Probe}`, `${BS}begin{document}`, `${BS}maketitle`, 'Hello world.', `${BS}end{document}`].join('\n'),
      resolve: resolver(),
    });
    const result = await handle.render();
    await handle.close();

    expect(result.html).toContain('<!DOCTYPE html>');
    expect(result.html).toContain('Probe');
    expect(result.html).not.toMatch(/<script\b/i);
    expect(result.html).toContain(LATEXJS_PREVIEW_CSP);
    // Vendored stylesheets are inlined, not linked.
    expect(result.html).not.toMatch(/<link\b/i);
    expect(result.html).toContain('katex');
    expect(result.diagnostics).toEqual([]);
  });

  it('expands includes through the resolver', async () => {
    const provider = new LatexJsProvider();
    const handle = await provider.open({
      entry: doc(`${BS}input{part}`),
      resolve: resolver({ readFile: async () => 'Included section text.' }),
    });
    const result = await handle.render();
    await handle.close();
    expect(result.html).toContain('Included section text.');
    expect(result.diagnostics).toEqual([]);
  });

  it('substitutes includegraphics paths with resolver asset URLs', async () => {
    const provider = new LatexJsProvider();
    const entry = [
      `${BS}documentclass{article}`,
      `${BS}usepackage{graphicx}`,
      `${BS}begin{document}`,
      `${BS}includegraphics[width=5cm]{fig.png}`,
      `${BS}end{document}`,
    ].join('\n');
    const handle = await provider.open({
      entry,
      resolve: resolver({ readFile: async () => '' }),
    });
    const result = await handle.render();
    await handle.close();
    expect(result.html).toContain('src="blob:mock/fig.png"');
  });

  it('maps unsupported commands to structured diagnostics and empty html', async () => {
    const provider = new LatexJsProvider();
    const handle = await provider.open({
      entry: doc(`${BS}foobar{x}`),
      resolve: resolver(),
    });
    const result = await handle.render();
    await handle.close();
    expect(result.html).toBe('');
    const parseDiag = result.diagnostics.at(-1)!;
    expect(['LATEX_PARSE_ERROR', 'LATEX_UNSUPPORTED_COMMAND']).toContain(parseDiag.code);
    expect(parseDiag.message).toContain('foobar');
    expect(parseDiag.line).toBeTypeOf('number');
  });

  it('reports unsupported packages while still rendering', async () => {
    const provider = new LatexJsProvider();
    const entry = [`${BS}documentclass{article}`, `${BS}usepackage{siunitx}`, `${BS}begin{document}`, 'body text', `${BS}end{document}`].join('\n');
    const handle = await provider.open({ entry, resolve: resolver() });
    const result = await handle.render();
    await handle.close();
    expect(result.diagnostics.some((d) => d.code === 'LATEX_UNSUPPORTED_PACKAGE' && d.message.includes('siunitx'))).toBe(true);
    expect(result.html).toContain('body text');
  });

  it('renders cite placeholders without failing', async () => {
    const provider = new LatexJsProvider();
    const handle = await provider.open({
      entry: doc(`As shown ${BS}cite{knuth84}.`),
      resolve: resolver(),
    });
    const result = await handle.render();
    await handle.close();
    expect(result.html).toContain('[knuth84]');
  });

  it('enforces one active render per handle and refuses closed handles', async () => {
    const provider = new LatexJsProvider();
    const release: { fn: ((url: string) => void) | null } = { fn: null };
    const entry = [
      `${BS}documentclass{article}`,
      `${BS}usepackage{graphicx}`,
      `${BS}begin{document}`,
      `${BS}includegraphics{fig.png}`,
      `${BS}end{document}`,
    ].join('\n');
    const handle = await provider.open({
      entry,
      resolve: resolver({
        readFile: async () => '',
        assetUrl: (path) =>
          new Promise<string>((resolvePromise) => {
            release.fn = () => resolvePromise(`blob:mock/${path}`);
          }),
      }),
    });
    const first = handle.render();
    await expect(handle.render()).rejects.toMatchObject({ code: 'LATEX_RESOURCE_LIMIT' });

    const handle2 = await provider.open({ entry: doc('t'), resolve: resolver() });
    await handle2.close();
    await expect(handle2.render()).rejects.toMatchObject({ code: 'LATEX_RENDER_CANCELLED' });

    // Close while a render is outstanding: it must reject, not resolve.
    await handle.close();
    release.fn?.('blob:mock/fig.png');
    await expect(first).rejects.toMatchObject({ code: 'LATEX_RENDER_CANCELLED' });
  });
});

describe('LATEXJS_SUPPORTED_PACKAGES', () => {
  it('covers the spike-established loadable package set', () => {
    expect(LATEXJS_SUPPORTED_PACKAGES).toContain('graphicx');
    expect(LATEXJS_SUPPORTED_PACKAGES).toContain('hyperref');
    expect(LATEXJS_SUPPORTED_PACKAGES).toContain('xcolor');
    expect(LATEXJS_SUPPORTED_PACKAGES).not.toContain('siunitx');
  });
});

describe('buildPreviewDocument', () => {
  it('injects CSP as the first head child and strips external references', () => {
    const source = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><script src="x.js"></script><link rel="stylesheet" href="css/article.css"></head><body><p class="body">x</p></body></html>`;
    const html = buildPreviewDocument(
      new DOMParser().parseFromString(source, 'text/html'),
      'article',
    );
    const headStart = html.indexOf('<head');
    expect(html.slice(headStart, headStart + 80)).toContain('Content-Security-Policy');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('<link');
    expect(html).toContain('<style>');
  });
});

describe('continuous reader page presentation', () => {
  it('scopes readable geometry after untouched vendor styles and preserves generated semantics', () => {
    const input = new DOMParser().parseFromString('<html lang="fr"><head><title>Une étude</title></head><body><div class="body"><h2>Étude</h2><p>Texte</p><div class="katex-display">math</div><pre>verbatim</pre><img src="blob:x"></div></body></html>', 'text/html');
    const output = new DOMParser().parseFromString(buildPreviewDocument(input, 'article'), 'text/html');
    expect(output.documentElement.lang).toBe('fr');
    expect(output.title).toBe('Une étude');
    expect(output.documentElement.classList.contains('fl-latex-preview')).toBe(true);
    const styles = output.querySelectorAll('style');
    expect(styles).toHaveLength(2);
    const page = styles[1]!.textContent!;
    expect(page).toContain('max-width: 52rem');
    expect(page).toContain('margin-inline: auto');
    expect(page).toContain('font-size: 17px');
    expect(page).toContain('minmax(0, 1fr)');
    expect(page).toContain('overflow-x: auto');
    // Absolute clipped MathML must be contained by the local equation scroller.
    expect(page).toContain('position: relative');
    // latex.js can emit zero width before resolver-backed images load.
    expect(page).toContain('img[width="0"] { width: auto; }');
    // Local scrollers are keyboard-reachable (axe scrollable-region-focusable).
    expect(output.querySelectorAll('.katex-display[tabindex="0"], pre[tabindex="0"]')).toHaveLength(2);
    // Generated figures keep a non-empty accessible name.
    expect(output.querySelector('img')?.getAttribute('alt')).toBe('Figure');
    expect(output.documentElement.outerHTML).toContain('class="katex-display" tabindex="0"');
    expect(output.documentElement.outerHTML).toContain('<pre tabindex="0"');
    expect(page).not.toMatch(/transform:|zoom:|@import|url\(/);
    expect(output.querySelector('h2')?.textContent).toBe('Étude');
  });

  it('paints the preview from global theme vars with a kept page border', () => {
    const input = new DOMParser().parseFromString('<html><head></head><body><div class="body"><p>x</p></div></body></html>', 'text/html');
    const output = new DOMParser().parseFromString(buildPreviewDocument(input, 'article'), 'text/html');
    const page = output.querySelectorAll('style')[1]!.textContent!;
    // Gutter and page share the normal editor paper token, never a fixed shell grey.
    expect(page).toContain('var(--fl-surface-editor');
    expect(page).not.toContain('#f7f7f5');
    // The rendered page keeps its border, resolved from the theme.
    expect(page).toContain('var(--fl-border-default');
    // Text/focus/selection resolve from the theme with light fallbacks.
    expect(page).toContain('var(--fl-text-primary');
    expect(page).toContain('var(--fl-accent-strong');
    expect(page).toContain('var(--fl-accent-soft');
    // Both worlds resolve: explicit choice plus system preference fallback.
    expect(page).toContain("html.fl-latex-preview[data-theme='dark']");
    expect(page).toContain('prefers-color-scheme: dark');
    expect(page).toContain('color-scheme: light dark');
  });
});
