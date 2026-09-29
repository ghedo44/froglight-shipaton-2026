/**
 * Markdown document kind `froglight.markdown`.
 *
 * Host- and editor-free: no CodeMirror/ProseMirror/DOM types.
 */

import { documentKindId, type DocumentKindId } from '../identity.js';
import type { DocumentKindDescriptor } from '../documents.js';
import type { MarkdownModel } from './model.js';
import { decodeMarkdown, encodeMarkdown } from './codec.js';
import { markdownModel } from './model.js';
import { parseFrontmatter } from './frontmatter.js';
import type { PropertyValue } from '../resource-properties/catalog.js';

export const markdownKindId: DocumentKindId =
  documentKindId('froglight.markdown');

function markdownPropertySource(value: PropertyValue): string {
  if (typeof value === 'string')
    return /^[A-Za-z0-9_./-]+$/.test(value) &&
      !['null', 'true', 'false', '~'].includes(value) &&
      !/^-?\d+(?:\.\d+)?$/.test(value)
      ? value
      : JSON.stringify(value);
  if (value === null || typeof value === 'number' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (Array.isArray(value) && value.every((item) => typeof item === 'string'))
    return `[${value.map((item) => JSON.stringify(item)).join(', ')}]`;
  if (typeof value === 'object' && value !== null && !Array.isArray(value))
    return JSON.stringify(value);
  throw new Error(
    'This property value cannot be represented safely in Markdown frontmatter',
  );
}

function inspectMarkdownProperty(
  source: string,
  key: string,
): { parsed: ReturnType<typeof parseFrontmatter>; line: string | null } {
  const parsed = parseFrontmatter(source);
  if (parsed.raw !== null && parsed.frontmatter === null)
    throw new Error('Malformed Markdown frontmatter cannot be edited safely');
  if (!parsed.raw) return { parsed, line: null };
  const lines = parsed.raw.split(/\r?\n/).slice(1, -1);
  if (lines.some((line) => /^\s+[^\s#-][^:]*:/.test(line)))
    throw new Error('Nested Markdown frontmatter cannot be edited safely');
  const matches = lines.filter((line) => new RegExp(`^${key}\\s*:`).test(line));
  if (matches.length > 1)
    throw new Error('Duplicate Markdown property storage key');
  const line = matches[0] ?? null;
  if (
    line &&
    (/^\S+\s*:\s*(?:[>|]|$)/.test(line) ||
      /:\s*(?:[!&*])/.test(line) ||
      /\s+#/.test(line))
  )
    throw new Error('Structured Markdown property cannot be mutated safely');
  return { parsed, line };
}

function mutateMarkdownProperty(
  model: MarkdownModel,
  key: string,
  value?: PropertyValue,
): void {
  if (
    !/^[A-Za-z][A-Za-z0-9_-]*$/.test(key) ||
    key === 'title' ||
    key === 'tags'
  )
    throw new Error('Invalid Markdown property storage key');
  const mutable = model as { raw: string };
  const source = model.raw;
  const { parsed } = inspectMarkdownProperty(source, key);
  if (parsed.raw === null) {
    if (value !== undefined)
      mutable.raw = `---\n${key}: ${markdownPropertySource(value)}\n---\n${source}`;
    return;
  }
  // Parse offsets from the original source so line endings and body bytes survive.
  const newline = source.startsWith('---\r\n') ? '\r\n' : '\n';
  const fence = /^---\r?\n[\s\S]*?^(?:---|\.\.\.)(?=\r?\n|$)/m.exec(source);
  if (!fence)
    throw new Error('Malformed Markdown frontmatter cannot be edited safely');
  const block = fence[0];
  const lines = block.split(/\r?\n/);
  const matches: number[] = [];
  for (let index = 1; index < lines.length - 1; index += 1) {
    const line = lines[index]!;
    if (new RegExp(`^${key}\\s*:`).test(line)) matches.push(index);
  }
  if (matches.length === 1) {
    const index = matches[0]!;
    if (value === undefined) lines.splice(index, 1);
    else lines[index] = `${key}: ${markdownPropertySource(value)}`;
  } else if (value !== undefined) {
    lines.splice(
      lines.length - 1,
      0,
      `${key}: ${markdownPropertySource(value)}`,
    );
  }
  mutable.raw = lines.join(newline) + source.slice(block.length);
}

function writeMarkdownTitle(model: MarkdownModel, title: string): void {
  const mutable = model as { raw: string };
  const parsed = parseFrontmatter(model.raw);
  if (parsed.raw !== null && parsed.frontmatter === null)
    throw new Error('Malformed Markdown frontmatter cannot be edited safely.');
  const scalar = JSON.stringify(title);
  if (parsed.raw === null) {
    mutable.raw = `---\ntitle: ${scalar}\n---\n${model.raw}`;
    return;
  }
  const lines = parsed.raw.replace(/\n$/, '').split('\n');
  let found = false;
  for (let index = 1; index < lines.length - 1; index += 1) {
    if (!/^title\s*:/.test(lines[index]!)) continue;
    lines[index] = `title: ${scalar}`;
    found = true;
  }
  if (!found) lines.splice(1, 0, `title: ${scalar}`);
  mutable.raw = `${lines.join('\n')}\n${parsed.body}`;
}

export const markdownKind: DocumentKindDescriptor<MarkdownModel> = {
  importExtensions: ['.md', '.markdown', '.mdx'],
  id: markdownKindId,
  documentProperties: {
    key: (_propertyId, storageKey) => storageKey,
    read(model, key) {
      const { parsed, line } = inspectMarkdownProperty(model.raw, key);
      return line !== null &&
        parsed.frontmatter &&
        Object.prototype.hasOwnProperty.call(parsed.frontmatter, key)
        ? { present: true, value: parsed.frontmatter[key]! }
        : { present: false };
    },
    write: (model, key, value) => mutateMarkdownProperty(model, key, value),
    unset: (model, key) => mutateMarkdownProperty(model, key),
  },
  creation: {
    label: 'Markdown',
    extension: '.md',
    createInitialModel: () => markdownModel(''),
  },
  cloneTemplate: (model) => ({ ...model }),
  presentationModes: ['edit', 'split', 'reading'],
  documentTitle: {
    read: (model) => {
      const parsed = parseFrontmatter(model.raw);
      return typeof parsed.frontmatter?.title === 'string'
        ? parsed.frontmatter.title
        : null;
    },
    write: (model, title) => writeMarkdownTitle(model, title),
  },
  recognize: (kindId) => kindId === markdownKindId,
  decode: (data, ref) => decodeMarkdown(data, ref),
  encode: (model, ref) => encodeMarkdown(model, ref),
};
