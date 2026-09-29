/**
 * LaTeX.js render provider — initial browser adapter.
 *
 * Turns canonical `.tex` source into preview HTML through the Froglight-owned
 * flattener (single-string engine) and the `latex.js` translator. Froglight
 * owns the preview host: this provider returns a complete HTML document
 * string, never mounted DOM, and the sandbox/CSP boundary lives on the
 * consumer side. Unsupported constructs fail visibly.
 */

import {
  applyLaTeXAssetUrls,
  extractLaTeXStructure,
  flattenLaTeX,
  latexError,
  LATEX_LIMITS,
  type LaTeXDiagnostic,
  type LaTeXDocumentHandle,
  type LaTeXProvider,
  type LaTeXRenderResult,
} from '@froglight/foundation';
import { parse, HtmlGenerator } from 'latex.js';
import { articleCss, baseCss, bookCss, katexCss } from './vendor-css.js';

/**
 * Packages that load natively in latex.js 0.12.6. Anything else produces an
 * `LATEX_UNSUPPORTED_PACKAGE` diagnostic (the library itself only
 * console-warns, which is not capturable).
 */
export const LATEXJS_SUPPORTED_PACKAGES: readonly string[] = [
  'graphicx',
  'hyperref',
  'xcolor',
  'multicol',
  'echo',
  'color',
];

/** Virtual base for the generated document's own scripts/stylesheets. */
const PREVIEW_BASE_URL = 'https://latexjs.froglight.invalid/';
const ENTRY_NAME = 'document.tex';

/**
 * Hardened content security policy for the preview document. Scripts and
 * network are dead by CSP *and* by the consumer's iframe sandbox.
 */
export const LATEXJS_PREVIEW_CSP = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src blob: data:",
  "font-src data:",
].join('; ');

function parseErrorDiagnostic(error: unknown): LaTeXDiagnostic {
  const err = error as { name?: string; message?: string; location?: { start?: { line?: number; column?: number } } };
  const message = err.message ?? String(error);
  const unsupported = /unknown (macro|environment|command)|not been parsed|already defined/i.test(message);
  const line = err.location?.start?.line;
  return {
    code: unsupported ? 'LATEX_UNSUPPORTED_COMMAND' : 'LATEX_PARSE_ERROR',
    message: `LaTeX source could not be rendered: ${message}`,
    path: ENTRY_NAME,
    ...(typeof line === 'number' ? { line: line - 1 } : {}),
  };
}

function stylesheetFor(documentClass: string | undefined): string {
  // `@import url(...)` references (local font stylesheets) cannot load inside
  // a srcdoc sandbox and would only produce blocked-request noise; math
  // renders with system font fallbacks instead.
  const css = baseCss + (documentClass === 'book' ? bookCss : articleCss) + katexCss;
  return css.replace(/@import\s+url\([^)]*\);?/gi, '');
}

/** Continuous paper, not TeX pagination. Keep vendor type/math rules intact.
 * The srcdoc lives in an isolated document, so it cannot inherit the shell's
 * tokens directly: it consumes the global `--fl-*` theme vars (mirrored onto
 * the preview document by the reader host, `latex-reader.ts`) with light
 * fallbacks, plus explicit/system dark defaults when no host has mirrored
 * values yet. Gutter and page share the normal editor paper
 * (`--fl-surface-editor`) with the page border intact. Geometry follows the
 * iframe viewport, so split and phone panes never scale type.
 */
const readerPageCss = `
html.fl-latex-preview {
  font-size: 17px;
  line-height: 1.65;
  color-scheme: light dark;
  background: var(--fl-surface-editor, #ffffff);
  color: var(--fl-text-primary, #37352f);
}
html.fl-latex-preview[data-theme='dark'] {
  --fl-surface-editor: #1d1d21;
  --fl-text-primary: #dcdde3;
  --fl-border-default: rgba(255, 255, 255, 0.16);
  --fl-accent-soft: rgba(155, 139, 245, 0.32);
  --fl-accent-strong: #b4a7ff;
}
@media (prefers-color-scheme: dark) {
  html.fl-latex-preview:not([data-theme='light']) {
    --fl-surface-editor: #1d1d21;
    --fl-text-primary: #dcdde3;
    --fl-border-default: rgba(255, 255, 255, 0.16);
    --fl-accent-soft: rgba(155, 139, 245, 0.32);
    --fl-accent-strong: #b4a7ff;
  }
}
.fl-latex-preview body {
  box-sizing: border-box;
  display: grid;
  grid-template-columns: [body] minmax(0, 1fr);
  min-width: 0;
  width: calc(100% - 2 * clamp(8px, 2vw, 24px));
  max-width: 52rem;
  min-height: calc(
    100vh - max(
        clamp(8px, 2vw, 24px),
        var(--_fl-editor-floating-top, 0px)
      ) - clamp(8px, 2vw, 24px)
  );
  margin-block-start: max(
    clamp(8px, 2vw, 24px),
    var(--_fl-editor-floating-top, 0px)
  );
  margin-block-end: clamp(8px, 2vw, 24px);
  margin-inline: auto;
  padding: clamp(24px, 5vw, 64px) clamp(16px, 5vw, 64px) 64px;
  background: var(--fl-surface-editor, #ffffff);
  border: 1px solid var(--fl-border-default, #e4e3e0);
}
.fl-latex-preview .body {
  min-width: 0;
  overflow-wrap: anywhere;
}
.fl-latex-preview .body > :first-child { margin-top: 0; }
.fl-latex-preview p { text-align: start; }
.fl-latex-preview img { max-width: 100%; height: auto; }
/* LaTeX.js may serialize unresolved intrinsic dimensions as zero before the
   sandbox loads a resolver-backed image. Let the loaded asset size itself. */
.fl-latex-preview img[width="0"] { width: auto; }
.fl-latex-preview :is(pre, .katex-display) {
  position: relative;
  max-width: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  overflow-wrap: normal;
}
.fl-latex-preview .katex-display > .katex { display: block; width: max-content; min-width: 100%; }
.fl-latex-preview :is(.margin-left, .margin-right) {
  grid-column: body;
  grid-row: auto;
  justify-self: stretch;
  margin-top: 1.5rem;
}
.fl-latex-preview .marginpar { width: auto; min-width: 0; margin-inline: 0; }
.fl-latex-preview a:focus-visible { outline: 2px solid var(--fl-accent-strong, #604ae0); outline-offset: 2px; }
.fl-latex-preview ::selection { background: var(--fl-accent-soft, #e2dcfa); }
`;

/**
 * Post-process the generated document for the sandboxed preview host:
 * serialize with doctype, strip script tags, drop external stylesheet links,
 * inline the vendored CSS, and inject the CSP meta.
 */
export function buildPreviewDocument(document: Document, documentClass: string | undefined): string {
  document.documentElement.classList.add('fl-latex-preview');
  // The renderer currently emits no source-language metadata. "und" means
  // undetermined; never falsely label arbitrary canonical text as English.
  if (!document.documentElement.lang) document.documentElement.lang = 'und';
  if (!document.title.trim()) document.title = 'LaTeX preview';
  // The page CSS makes wide equations and verbatim blocks scroll locally;
  // a keyboard-only reader must be able to reach that scrolling content.
  for (const scrollable of document.querySelectorAll('.katex-display, pre')) {
    scrollable.setAttribute('tabindex', '0');
  }
  // The flattener resolves asset URLs before parsing, so the original file
  // name no longer exists in the generated document. LaTeX.js emits images
  // without alt text; label them honestly rather than leaving them nameless
  // to assistive technology. Existing author-supplied alts are kept.
  for (const image of document.querySelectorAll('img:not([alt])')) {
    image.setAttribute('alt', 'Figure');
  }
  let html = `<!DOCTYPE html>\n${document.documentElement.outerHTML}`;
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<script\b[^>]*\/>/gi, '');
  html = html.replace(/<link\b[^>]*>/gi, '');
  const head = '<style>' + stylesheetFor(documentClass) + '</style><style>' + readerPageCss + '</style>';
  const csp = `<meta http-equiv="Content-Security-Policy" content="${LATEXJS_PREVIEW_CSP}">`;
  const headMatch = /<head[^>]*>/i.exec(html);
  if (headMatch === null) {
    return html.replace(/<html[^>]*>/i, (match) => `${match}<head>${csp}${head}</head>`);
  }
  const insertAt = headMatch.index + headMatch[0].length;
  return html.slice(0, insertAt) + csp + head + html.slice(insertAt);
}

export class LatexJsProvider implements LaTeXProvider {
  async open(input: {
    readonly entry: string;
    readonly resolve: import('@froglight/foundation').LaTeXSourceResolver;
    readonly signal?: AbortSignal;
  }): Promise<LaTeXDocumentHandle> {
    if (input.signal?.aborted === true) {
      throw latexError('LATEX_RENDER_CANCELLED', 'open was cancelled');
    }
    let closed = false;
    let activeRender = false;
    const entry = input.entry;
    const resolve = input.resolve;

    return {
      render: async (request?: { readonly signal?: AbortSignal }): Promise<LaTeXRenderResult> => {
        if (closed) throw latexError('LATEX_RENDER_CANCELLED', 'handle is closed');
        if (activeRender) {
          throw latexError('LATEX_RESOURCE_LIMIT', 'a render is already active for this document');
        }
        if (request?.signal?.aborted === true) {
            throw latexError('LATEX_RENDER_CANCELLED', 'render was cancelled');
        }
        const signal = request?.signal;
        const isAborted = (): boolean => signal?.aborted ?? false;
        if (isAborted()) {
            throw latexError('LATEX_RENDER_CANCELLED', 'render was cancelled');
        }
        activeRender = true;
        try {
          // Flatten includes/assets, then translate. Parse errors resolve with
          // empty html plus diagnostics (readers display a recoverable placeholder).
          const flattened = await flattenLaTeX({
            entryPath: ENTRY_NAME,
            entrySource: entry,
            readFile: resolve.readFile,
          });
          if (closed || isAborted()) {
              throw latexError('LATEX_RENDER_CANCELLED', 'render was cancelled');
          }
          const withAssets = await applyLaTeXAssetUrls(flattened.source, resolve.assetUrl);
          if (closed || isAborted()) {
              throw latexError('LATEX_RENDER_CANCELLED', 'render was cancelled');
          }
          const structure = extractLaTeXStructure(withAssets.source);
          const diagnostics: LaTeXDiagnostic[] = [...flattened.diagnostics, ...withAssets.diagnostics];
          for (const name of structure.packages) {
            if (!LATEXJS_SUPPORTED_PACKAGES.includes(name)) {
              diagnostics.push({
                code: 'LATEX_UNSUPPORTED_PACKAGE',
                message: `package "${name}" is not supported by the active preview provider`,
                path: ENTRY_NAME,
              });
            }
          }

          let generator: HtmlGenerator;
          try {
            generator = parse(withAssets.source, {
              generator: new HtmlGenerator({ hyphenate: false }),
            });
          } catch (error) {
            diagnostics.push(parseErrorDiagnostic(error));
            return { html: '', diagnostics };
          }

          const document = generator.htmlDocument(PREVIEW_BASE_URL);
          return { html: buildPreviewDocument(document, structure.documentClass), diagnostics };
        } finally {
          activeRender = false;
        }
      },
      close: async () => {
        closed = true;
      },
    };
  }
}

export const latexJsLimits = LATEX_LIMITS;
