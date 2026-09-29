/**
 * Markdown → HTML renderer for the Froglight reading view.
 *
 * This is a presentation projection only: canonical storage stays raw
 * `.md`. All input is HTML-escaped before any markup is generated, and
 * inline rules run in a single pass over the source text so generated
 * attributes are never re-scanned.
 *
 * Wiki-links (`[[Note]]`, `[[Note#Head|alias]]`) become anchors with class
 * `wiki-link` plus `data-destination`/`data-fragment`; navigation is owned
 * by the preview container's delegated click handler.
 */

import katex from 'katex';
import { extractHeadings, parseFrontmatter } from '@froglight/foundation';

const EXTERNAL_HREF = /^(https?:)?\/\//i;
const SAFE_URI = /^(https?:\/\/|mailto:|#)/i;

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** KaTeX receives source, never HTML; unsupported input stays readable. */
function renderMath(source: string, displayMode: boolean): string {
  try {
    if (source.length > 65536) throw new Error('Math source is too long');
    return katex.renderToString(source, {
      displayMode,
      throwOnError: true,
      trust: false,
      strict: 'error',
      maxExpand: 1000,
      maxSize: 20,
      output: 'htmlAndMathml',
    });
  } catch {
    const delimiter = displayMode ? '$$' : '$';
    return `<span class="md-math-error" title="Cannot render this formula">${escapeHtml(delimiter + source + delimiter)}</span>`;
  }
}

/** Display delimiters occupy their own line, or enclose a single-line block. */
function mathBlock(
  lines: readonly string[],
  start: number,
): { source: string; end: number } | null {
  const first = (lines[start] ?? '').trim();
  if (!first.startsWith('$$')) return null;
  if (first.length > 4 && first.endsWith('$$')) {
    return { source: first.slice(2, -2), end: start + 1 };
  }
  if (first !== '$$') return null;
  for (let end = start + 1; end < lines.length; end += 1) {
    if (lines[end]?.trim() === '$$') {
      return { source: lines.slice(start + 1, end).join('\n'), end: end + 1 };
    }
  }
  return null;
}

/** Emphasis runs on already-escaped text. */
function renderEmphasis(text: string): string {
  let out = text;
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  out = out.replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  out = out.replace(/(^|[\s(])_([^_\s][^_]*)_/g, '$1<em>$2</em>');
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return out;
}

function safeHref(destination: string): string {
  const trimmed = destination.trim();
  if (SAFE_URI.test(trimmed)) return escapeHtml(trimmed);
  // Everything else is treated as a workspace-relative destination.
  return '#';
}

function decodePercent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Render one wiki-link body (text between `[[` and `]]`). */
function renderWikiBody(body: string): string {
  const pipeIndex = body.indexOf('|');
  const target = pipeIndex === -1 ? body : body.slice(0, pipeIndex);
  const alias = pipeIndex === -1 ? undefined : body.slice(pipeIndex + 1);
  const hashIndex = target.indexOf('#');
  const destination =
    hashIndex === -1 ? target.trim() : target.slice(0, hashIndex).trim();
  const fragment =
    hashIndex === -1
      ? undefined
      : target.slice(hashIndex + 1).trim() || undefined;
  const label =
    alias?.trim() ||
    (fragment !== undefined ? `${destination} › ${fragment}` : destination);
  const attrs = [
    'class="wiki-link"',
    `data-destination="${escapeHtml(destination)}"`,
    fragment !== undefined ? `data-fragment="${escapeHtml(fragment)}"` : '',
    'href="#"',
  ]
    .filter((part) => part !== '')
    .join(' ');
  return `<a ${attrs}>${renderEmphasis(escapeHtml(label))}</a>`;
}

function renderWikiEmbed(body: string): string {
  const pipe = body.indexOf('|');
  const target = (pipe < 0 ? body : body.slice(0, pipe)).trim();
  if (target === '') return escapeHtml(`![[${body}]]`);
  const size = pipe < 0 ? '' : body.slice(pipe + 1).trim();
  return `<span class="md-embed" data-embed-destination="${escapeHtml(target)}"${/^\d{1,4}(?:x\d{1,4})?$/.test(size) ? ` data-embed-size="${size}"` : ''}>Loading ${escapeHtml(target)}…</span>`;
}

/**
 * Single-pass inline renderer. Code spans short-circuit all other rules;
 * link/wiki/image targets never receive emphasis or math. Math delimiters
 * cannot touch whitespace; a closing dollar cannot precede a digit (currency).
 */
function renderInline(text: string): string {
  const pattern =
    /(`+)([\s\S]*?)\1|!\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+"[^"]*")?\)|!\[\[([^\]]+)\]\]|\[\[([^\]]+)\]\]|\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+"[^"]*")?\)|(https?:\/\/[^\s<>"')]+)|\\([\\$])|(?<!\$)\$(?![\s$])((?:\\.|[^$\\\n`])+?)(?<!\s)\$(?![\d$])/g;
  let out = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    out += renderEmphasis(escapeHtml(text.slice(lastIndex, match.index)));
    if (match[2] !== undefined) {
      // Code span — escaped verbatim, no further rules.
      out += `<code>${escapeHtml(match[2])}</code>`;
    } else if (match[4] !== undefined) {
      const alt = escapeHtml(match[3] ?? '');
      const src = escapeHtml(decodePercent(match[4]));
      const dimensions = /^(\d{1,4})(?:x(\d{1,4}))?$/.exec(match[3] ?? '');
      const size = dimensions
        ? ` width="${Math.min(4096, Number(dimensions[1]))}"${dimensions[2] ? ` height="${Math.min(4096, Number(dimensions[2]))}"` : ''}`
        : '';
      out += `<img src="${src}" alt="${alt}"${size}>`;
    } else if (match[5] !== undefined) {
      out += renderWikiEmbed(match[5]);
    } else if (match[6] !== undefined) {
      out += renderWikiBody(match[6]);
    } else if (match[8] !== undefined) {
      const label = match[7] ?? '';
      const dest = match[8];
      const trimmedDest = dest.trim();
      const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmedDest);
      const href = safeHref(trimmedDest);
      const inner = renderEmphasis(escapeHtml(label));
      if (!hasScheme) {
        // Scheme-less destination → workspace link.
        out += `<a class="wiki-link" data-destination="${escapeHtml(
          decodePercent(trimmedDest),
        )}" href="#">${inner}</a>`;
      } else if (trimmedDest.startsWith('#')) {
        out += `<a href="${href}">${inner}</a>`;
      } else if (href !== '#') {
        out += `<a href="${href}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
      } else {
        // Unsafe scheme: keep the label, drop the destination entirely.
        out += `<a href="#">${inner}</a>`;
      }
    } else if (match[9] !== undefined) {
      const url = escapeHtml(match[9]);
      out += `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`;
    } else if (match[10] !== undefined) {
      out += escapeHtml(match[10]);
    } else if (match[11] !== undefined) {
      out += renderMath(match[11], false);
    }
    lastIndex = match.index + match[0].length;
  }
  out += renderEmphasis(escapeHtml(text.slice(lastIndex)));
  return out;
}

interface ListItem {
  readonly content: string;
  readonly children: string[];
  task?: 'checked' | 'unchecked';
}

const LIST_ITEM_RE = /^(\s*)([-*+]|\d+[.)])\s+(.+)$/;

function isTableSeparator(line: string): boolean {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
}

function splitRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());
}

/**
 * Render list items starting at `start` whose items share the given indent.
 * Returns HTML and the index of the first unconsumed line.
 */
function renderListBlock(
  lines: readonly string[],
  start: number,
): { html: string; end: number } {
  const firstMatch = LIST_ITEM_RE.exec(lines[start] ?? '');
  if (firstMatch === null) return { html: '', end: start };
  const indent = firstMatch[1].length;
  const ordered = /\d/.test(firstMatch[2]);
  const items: ListItem[] = [];
  let i = start;

  while (i < lines.length) {
    const match = LIST_ITEM_RE.exec(lines[i] ?? '');
    if (match === null || match[1].length < indent) break;
    if (match[1].length > indent) {
      // Deeper content belongs to the previous item's children.
      const nested = renderListBlock(lines, i);
      const previous = items.at(-1);
      if (previous === undefined) break;
      (previous.children as string[]).push(nested.html);
      i = nested.end;
      continue;
    }
    const content = match[3];
    const item: {
      content: string;
      children: string[];
      task?: 'checked' | 'unchecked';
    } = {
      content,
      children: [],
    };
    const task = /^\[([ xX])\]\s+(.*)$/.exec(content);
    if (task !== null) {
      item.task = task[1]?.toLowerCase() === 'x' ? 'checked' : 'unchecked';
      item.content = task[2] ?? '';
    }
    items.push(item);
    i += 1;
    // Continuation lines for this item (indented text under the marker).
    while (
      i < lines.length &&
      lines[i] !== undefined &&
      /^\s{2,}\S/.test(lines[i] as string)
    ) {
      if (LIST_ITEM_RE.test(lines[i] as string)) break;
      (item.children as string[]).push(
        `<p>${renderInline((lines[i] as string).trim())}</p>`,
      );
      i += 1;
    }
  }

  const tag = ordered ? 'ol' : 'ul';
  const html = items
    .map((item) => {
      const children = item.children.join('');
      if (item.task === undefined)
        return `<li>${renderInline(item.content)}${children}</li>`;
      const checkbox =
        item.task === 'checked'
          ? '<input type="checkbox" checked disabled>'
          : '<input type="checkbox" disabled>';
      return `<li class="md-task"><span class="md-task-line">${checkbox}<span class="md-task-text">${renderInline(item.content)}</span></span>${children}</li>`;
    })
    .join('');
  return { html: `<${tag}>${html}</${tag}>`, end: i };
}

function renderFrontmatter(fields: Readonly<Record<string, unknown>>): string {
  const rows = Object.entries(fields)
    .map(([key, value]) => {
      const text =
        key === 'tags' &&
        Array.isArray(value) &&
        value.every((tag) => typeof tag === 'string')
          ? value.join(', ')
          : typeof value === 'string'
            ? value
            : JSON.stringify(value);
      return `<div class="md-frontmatter-row"><dt>${escapeHtml(key)}</dt><dd>${renderInline(text)}</dd></div>`;
    })
    .join('');
  return `<div class="md-frontmatter">${rows}</div>`;
}

/** Render raw Markdown (including optional frontmatter) to an HTML string. */
export function renderMarkdown(rawMarkdown: string): string {
  const { frontmatter, body } = parseFrontmatter(rawMarkdown);
  const lines = body.split('\n');
  const headingAddresses = extractHeadings(body);
  const html: string[] = [];
  let i = 0;
  let headingIndex = 0;

  if (frontmatter !== null && Object.keys(frontmatter).length > 0) {
    html.push(renderFrontmatter(frontmatter));
  }

  while (i < lines.length) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();

    // Blank line.
    if (trimmed === '') {
      i += 1;
      continue;
    }

    // Fenced code block.
    const fenceMatch = /^(```+|~~~+)\s*(\w*)\s*$/.exec(trimmed);
    if (fenceMatch !== null) {
      const fence = fenceMatch[1]?.charAt(0) ?? '`';
      const fenceLength = fenceMatch[1]?.length ?? 3;
      const language = fenceMatch[2] ?? '';
      const codeLines: string[] = [];
      i += 1;
      while (i < lines.length) {
        const candidate = lines[i] ?? '';
        const closeMatch = new RegExp(
          `^\\s*\\${fence}{${fenceLength},}\\s*$`,
        ).exec(candidate.trim());
        if (closeMatch !== null) {
          i += 1;
          break;
        }
        codeLines.push(candidate);
        i += 1;
      }
      const languageClass = /^\w[\w+-]*$/.test(language)
        ? ` class="language-${language}"`
        : '';
      html.push(
        `<pre><code${languageClass}>${escapeHtml(codeLines.join('\n'))}</code></pre>`,
      );
      continue;
    }

    const math = mathBlock(lines, i);
    if (math !== null) {
      html.push(renderMath(math.source, true));
      i = math.end;
      continue;
    }

    // Heading.
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      const level = heading[1]?.length ?? 1;
      const address = headingAddresses[headingIndex]?.slug;
      headingIndex += 1;
      const attribute =
        address === undefined
          ? ''
          : ` data-document-address="${escapeHtml(address)}"`;
      html.push(
        `<h${level}${attribute}>${renderInline((heading[2] ?? '').trim())}</h${level}>`,
      );
      i += 1;
      continue;
    }

    // Thematic break.
    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
      html.push('<hr>');
      i += 1;
      continue;
    }

    // Blockquote.
    if (trimmed.startsWith('>')) {
      const quoteLines: string[] = [];
      while (i < lines.length && (lines[i] ?? '').trim().startsWith('>')) {
        quoteLines.push((lines[i] ?? '').trim().replace(/^>\s?/, ''));
        i += 1;
      }
      html.push(
        `<blockquote>${renderInline(quoteLines.join(' '))}</blockquote>`,
      );
      continue;
    }

    // Table (header row + separator).
    if (
      trimmed.includes('|') &&
      i + 1 < lines.length &&
      isTableSeparator(lines[i + 1] ?? '')
    ) {
      const headerCells = splitRow(trimmed);
      i += 2;
      const bodyRows: string[][] = [];
      while (i < lines.length && (lines[i] ?? '').includes('|')) {
        bodyRows.push(splitRow((lines[i] ?? '').trim()));
        i += 1;
      }
      const head = headerCells
        .map((cell) => `<th>${renderInline(cell)}</th>`)
        .join('');
      const body = bodyRows
        .map(
          (row) =>
            `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join('')}</tr>`,
        )
        .join('');
      html.push(
        `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`,
      );
      continue;
    }

    // Lists.
    if (LIST_ITEM_RE.test(line)) {
      const list = renderListBlock(lines, i);
      html.push(list.html);
      i = list.end;
      continue;
    }

    // Paragraph: consecutive non-blank, non-block lines joined by hard breaks.
    const paragraphLines: string[] = [];
    while (i < lines.length) {
      const candidate = lines[i] ?? '';
      const candidateTrimmed = candidate.trim();
      if (
        candidateTrimmed === '' ||
        mathBlock(lines, i) !== null ||
        LIST_ITEM_RE.test(candidate) ||
        candidateTrimmed.startsWith('#') ||
        candidateTrimmed.startsWith('>') ||
        candidateTrimmed.startsWith('```') ||
        candidateTrimmed.startsWith('~~~')
      ) {
        break;
      }
      paragraphLines.push(candidateTrimmed);
      i += 1;
    }
    if (paragraphLines.length > 0) {
      html.push(
        `<p>${paragraphLines.map((l) => renderInline(l)).join('<br>')}</p>`,
      );
    }
  }

  return html.join('\n');
}

/** True when a rendered anchor represents an external URL target. */
export function isExternalAnchor(href: string): boolean {
  return EXTERNAL_HREF.test(href);
}
