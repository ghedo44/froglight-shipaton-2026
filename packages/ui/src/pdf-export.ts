import { renderMarkdown } from './markdown-render.js';
import type { PdfExportOptions } from './right-sidebar-registry.js';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Build the isolated document sent to the host print/PDF dialog. */
export function buildPrintableDocument(input: {
  readonly title: string;
  readonly markdown: string;
  readonly options: PdfExportOptions;
}): string {
  const { title, markdown, options } = input;
  const page = options.pageSize === 'letter' ? 'letter' : 'A4';
  const margin = options.margins === 'narrow' ? '12mm' : '20mm';
  const heading = options.includeTitle
    ? `<h1 class="print-title">${escapeHtml(title)}</h1>`
    : '';
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
@page { size: ${page}; margin: ${margin}; }
html { color: #282622; background: #fff; font: 11pt/1.62 Inter, system-ui, sans-serif; }
body { margin: 0 auto; max-width: 72ch; }
.print-title { margin: 0 0 1.4em; font-size: 24pt; line-height: 1.2; letter-spacing: -0.02em; }
h1, h2, h3, h4, h5, h6 { break-after: avoid; margin: 1.5em 0 0.55em; line-height: 1.25; }
p, ul, ol, blockquote, pre, table { margin: 0 0 0.9em; }
pre, blockquote, table, img { break-inside: avoid; }
pre { white-space: pre-wrap; padding: 10pt; background: #f7f7f5; border-radius: 4pt; }
code { font-family: ui-monospace, monospace; font-size: 0.9em; }
img { max-width: 100%; }
a { color: inherit; text-decoration: underline; text-underline-offset: 0.16em; }
.md-frontmatter { display: none; }
</style></head><body>${heading}<main>${renderMarkdown(markdown)}</main></body></html>`;
}

/**
 * Open the host print dialog with an isolated document. Browsers and desktop
 * webviews expose "Save as PDF" there; the canonical source remains untouched.
 */
export function printMarkdownPdf(input: {
  readonly title: string;
  readonly markdown: string;
  readonly options: PdfExportOptions;
}): void {
  const frame = document.createElement('iframe');
  frame.className = 'fl-print-frame';
  frame.setAttribute('title', `PDF export preview for ${input.title}`);
  document.body.appendChild(frame);
  let printed = false;
  const print = (): void => {
    if (printed || !frame.isConnected) return;
    printed = true;
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    setTimeout(() => frame.remove(), 0);
  };
  frame.addEventListener('load', print);
  const target = frame.contentDocument;
  if (target === null) {
    frame.remove();
    throw new Error('print preview is unavailable');
  }
  target.open();
  target.write(buildPrintableDocument(input));
  target.close();
  // jsdom and some already-loaded WebViews do not emit an iframe load after
  // document.write(); keep cleanup deterministic without racing real print.
  setTimeout(() => {
    if (frame.contentDocument?.readyState === 'complete') {
      print();
    }
  }, 0);
}
