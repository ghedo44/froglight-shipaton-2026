/**
 * Markdown ↔ Block Page conversion.
 *
 * Converters are explicit document-kind capabilities: they report
 * `{status, warnings}` and never drop content silently.
 * Export targets the CommonMark+GFM subset.
 */

import type { BlockRegistry } from './registry.js';
import { parseFrontmatter } from '../markdown/frontmatter.js';
import {
  BLOCK_PAGE_BLOCK_TYPES as T,
  emptyBlockPage,
  isCoreBlockType,
  isResourceMark,
  isValidCoreRecord,
  runsOf,
  type BlockId,
  type BlockPageModel,
  type BlockRecord,
  type Run,
  type ResourceTarget,
} from './model.js';

export type ConversionStatus = 'lossless' | 'lossy' | 'unsupported';

export interface ImportResult {
  readonly model: BlockPageModel;
  readonly status: ConversionStatus;
  readonly warnings: readonly string[];
}

export interface ExportResult {
  readonly markdown: string;
  readonly status: ConversionStatus;
  readonly warnings: readonly string[];
}

/** Resolves stable identity to an explicitly portable Markdown target. */
export type ResourceMarkdownResolver = (target: ResourceTarget) => string | null;

/** Beyond this nesting depth Markdown structure is flattened (loss-table row). */
const MAX_EXPORT_DEPTH = 32;

const INLINE_PATTERN =
  /(`([^`]+)`)|(\*\*([^*]+)\*\*)|(\*([^*]+)\*)|(~~([^~]+)~~)|(\[([^\]]+)\]\(([^)]+)\))/g;

/** Parse a subset of CommonMark inline spans into runs. */
function parseInline(text: string): Run[] {
  const runs: Run[] = [];
  let lastIndex = 0;
  for (const match of text.matchAll(INLINE_PATTERN)) {
    const index = match.index ?? 0;
    if (index > lastIndex) runs.push({ text: text.slice(lastIndex, index) });
    const [full, , codeText, , boldText, , emText, , strikeText, , linkText, linkHref] = match;
    if (codeText !== undefined) {
      runs.push({ text: codeText, marks: ['code'] });
    } else if (boldText !== undefined) {
      runs.push({ text: boldText, marks: ['bold'] });
    } else if (emText !== undefined) {
      runs.push({ text: emText, marks: ['italic'] });
    } else if (strikeText !== undefined) {
      runs.push({ text: strikeText, marks: ['strikethrough'] });
    } else if (linkText !== undefined && linkHref !== undefined) {
      runs.push({ text: linkText, marks: [{ type: 'link', href: linkHref }] });
    } else {
      runs.push({ text: full });
    }
    lastIndex = index + full.length;
  }
  if (lastIndex < text.length) runs.push({ text: text.slice(lastIndex) });
  return runs.length > 0 ? runs : [{ text: '' }];
}

/** Registry lookup that treats unknown ids as absent instead of throwing. */
function lookupType(
  registry: BlockRegistry | undefined,
  typeId: string,
): { toMarkdown?: (record: Record<string, unknown>) => string | null } | undefined {
  if (registry === undefined) return undefined;
  try {
    return registry.get(typeId);
  } catch {
    return undefined;
  }
}

/** Render runs back to inline Markdown (deterministic wrap order). */
function renderRuns(
  runs: Run[],
  resolveResource?: ResourceMarkdownResolver,
  onUnresolvedResource?: () => void,
): string {
  let out = '';
  for (const run of runs) {
    let text = run.text;
    const marks = run.marks ?? [];
    if (marks.includes('bold')) text = `**${text}**`;
    if (marks.includes('italic')) text = `*${text}*`;
    if (marks.includes('strikethrough')) text = `~~${text}~~`;
    if (marks.includes('code')) text = `\`${text}\``;
    for (const mark of marks) {
      if (typeof mark === 'object' && mark !== null && !Array.isArray(mark) && (mark as {type?:string}).type === 'link') {
        text = `[${text}](${(mark as { href: string }).href})`;
      } else if (isResourceMark(mark)) {
        const portable = resolveResource?.(mark.target) ?? null;
        if (portable === null) onUnresolvedResource?.();
        else text = `[${text}](${portable})`;
      }
    }
    out += text;
  }
  return out;
}

/** Import Markdown into a new Block Page model. Never mutates the source. */
export function importMarkdownToBlockPage(rawMarkdown: string): ImportResult {
  const warnings: string[] = [];
  const { frontmatter, body } = parseFrontmatter(rawMarkdown);
  const model = emptyBlockPage();

  if (frontmatter !== null) {
    if (typeof frontmatter.title === 'string') model.meta.title = frontmatter.title;
    if (Array.isArray(frontmatter.tags)) model.meta.tags = frontmatter.tags.filter((t): t is string => typeof t === 'string');
    const props: NonNullable<BlockPageModel['meta']['properties']> = {};
    for (const [key, value] of Object.entries(frontmatter)) {
      if (key === 'title' || key === 'tags') continue;
      props[key] = value;
    }
    if (Object.keys(props).length > 0) model.meta.properties = props;
  }

  const lines = body.split('\n');
  let idCounter = 0;
  const nextId = (): BlockId => `imp-${++idCounter}`;
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';

    if (line.trim() === '') { index++; continue; }

    // Fenced code.
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence !== null) {
      const language = fence[1] !== '' ? fence[1] : undefined;
      const codeLines: string[] = [];
      index++;
      while (index < lines.length && !/^```\s*$/.test(lines[index] ?? '')) {
        codeLines.push(lines[index] ?? '');
        index++;
      }
      index++; // closing fence
      const id = nextId();
      const text = `${codeLines.join('\n')}${codeLines.length > 0 ? '\n' : ''}`;
      // Exported math/diagram fences map back to source blocks (explicit
      // portable approximation); every other fence stays a code
      // block.
      if (language === 'math') {
        model.blocks[id] = { id, type: T.math, source: text };
      } else if (language === 'mermaid') {
        model.blocks[id] = { id, type: T.diagram, source: text };
      } else {
        model.blocks[id] = {
          id,
          type: T.code,
          ...(language !== undefined ? { language } : {}),
          text,
        };
      }
      model.rootOrder.push(id);
      continue;
    }

    // Thematic break (divider).
    if (/^\s*(?:---|\*\*\*|___)\s*$/.test(line)) {
      const id = nextId();
      model.blocks[id] = { id, type: T.divider };
      model.rootOrder.push(id);
      index++;
      continue;
    }

    // Blockquote (quote core type; callout approximations are export-only).
    if (/^\s*>/.test(line)) {
      const quoteLines: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index] ?? '')) {
        quoteLines.push((lines[index] ?? '').replace(/^\s*>\s?/, ''));
        index++;
      }
      const id = nextId();
      model.blocks[id] = { id, type: T.quote, runs: parseInline(quoteLines.join(' ').trim()) };
      model.rootOrder.push(id);
      continue;
    }

    // Heading.
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading !== null) {
      const level = (heading[1]?.length ?? 1) as 1 | 2 | 3 | 4 | 5 | 6;
      const id = nextId();
      model.blocks[id] = { id, type: T.heading, level, runs: parseInline(heading[2] ?? '') };
      model.rootOrder.push(id);
      index++;
      continue;
    }

    // Table: header row + alignment separator.
    if (
      line.includes('|') &&
      /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[index + 1] ?? '')
    ) {
      const splitRow = (row: string): string[] =>
        row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
      const headerCells = splitRow(line);
      const separator = splitRow(lines[index + 1] ?? '');
      const align = separator.map((cell) =>
        cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : 'left',
      ) as Array<'left' | 'center' | 'right'>;
      const rows: Array<{ cells: Run[][] }> = [
        { cells: headerCells.map((text) => [{ text }]) },
      ];
      index += 2;
      while (index < lines.length && (lines[index] ?? '').includes('|') && (lines[index] ?? '').trim() !== '') {
        rows.push({ cells: splitRow(lines[index] ?? '').map((text) => [{ text }]) });
        index++;
      }
      const id = nextId();
      model.blocks[id] = {
        id,
        type: T.table,
        columnCount: headerCells.length,
        header: true,
        align,
        rows,
      };
      model.rootOrder.push(id);
      continue;
    }

    // Lists (single-line items; nesting via two-space indentation).
    const LIST_LINE = /^(\s*)([-*+]|\d+\.)\s*(?:\[([ xX])\]\s+)?(.*)$/;
    const listMatch = line.match(LIST_LINE);
    if (listMatch !== null) {
      const ordered = /\d+\./.test(listMatch[2] ?? '');
      const baseIndent = listMatch[1]?.length ?? 0;
      const items: Array<{ runs: Run[]; checked?: boolean; children?: BlockId[] }> = [];
      const childIds: BlockId[] = [];
      while (index < lines.length) {
        const candidate = lines[index] ?? '';
        const itemMatch = candidate.match(LIST_LINE);
        const indent = (candidate.match(/^(\s*)/)?.[1]?.length ?? 0);
        if (itemMatch === null || indent < baseIndent) {
          if (indent >= baseIndent + 2 && candidate.trim() !== '' && itemMatch === null) {
            // Continuation block under the previous item (e.g. an exported
            // toggle's body): collected as a child paragraph block.
            const contLines: string[] = [candidate.trim()];
            index++;
            while (index < lines.length) {
              const nextLine = lines[index] ?? '';
              const nextIndent = nextLine.match(/^(\s*)/)?.[1]?.length ?? 0;
              if (nextLine.trim() === '' || nextIndent < baseIndent + 2 || nextLine.match(LIST_LINE) !== null) break;
              contLines.push(nextLine.trim());
              index++;
            }
            const childId = nextId();
            model.blocks[childId] = {
              id: childId,
              type: T.paragraph,
              runs: parseInline(contLines.join(' ')),
            };
            const parentItem = items[items.length - 1];
            if (parentItem !== undefined) {
              parentItem.children = [...(parentItem.children ?? []), childId];
            } else {
              childIds.push(childId);
            }
            continue;
          }
          break;
        }
        if (indent >= baseIndent + 2) {
          // Nested list becomes a child of its parent item (spec §4).
          const nestedId = nextId();
          const nestedItems: Array<{ runs: Run[] }> = [{ runs: parseInline(itemMatch[4] ?? '') }];
          model.blocks[nestedId] = { id: nestedId, type: T.list, ordered: /\d+\./.test(itemMatch[2] ?? ''), items: nestedItems };
          const parentItem = items[items.length - 1];
          if (parentItem !== undefined) {
            parentItem.children = [...(parentItem.children ?? []), nestedId];
          } else {
            childIds.push(nestedId);
          }
          index++;
          continue;
        }
        const taskBox = itemMatch[3];
        items.push({
          runs: parseInline(itemMatch[4] ?? ''),
          ...(taskBox !== undefined ? { checked: taskBox.toLowerCase() === 'x' } : {}),
        });
        index++;
      }
      const id = nextId();
      let listRecord: Record<string, unknown> = {
        id,
        type: T.list,
        ordered,
        items,
        ...(childIds.length > 0 ? { children: childIds } : {}),
      };
      // An exported toggle round-trips: a single-item list whose cargo
      // includes non-list blocks was a collapsible toggle.
      if (
        items.length === 1 &&
        items[0] !== undefined &&
        (items[0].children?.length ?? 0) > 0 &&
        (items[0].children ?? []).some((cid) => model.blocks[cid]?.type !== T.list)
      ) {
        listRecord = {
          id,
          type: T.toggle,
          runs: items[0].runs,
          ...(childIds.length > 0 ? { children: childIds } : {}),
          children: items[0].children,
        };
      }
      model.blocks[id] = listRecord as never;
      model.rootOrder.push(id);
      continue;
    }

    // Image on its own line.
    const image = line.trim().match(/^!\[([^\]]*)\]\(([^)]+)\)$/);
    if (image !== null) {
      const id = nextId();
      model.blocks[id] = {
        id,
        type: T.image,
        src: image[2] ?? '',
        sha256: '',
        alt: image[1] ?? '',
      };
      warnings.push(`image "${image[2]}" imported without integrity hash (source Markdown cannot carry one)`);
      model.rootOrder.push(id);
      index++;
      continue;
    }

    // Everything else unsupported in v1 (HTML blocks, thematic breaks, quotes…).
    if (/^<|^(---|\*\*\*|___)\s*$|^>/.test(line.trim())) {
      warnings.push(`unsupported construct skipped at line ${index + 1}: ${line.trim().slice(0, 40)}`);
      index++;
      continue;
    }

    // Paragraph: consecutive plain lines.
    const paragraphLines: string[] = [];
    while (
      index < lines.length &&
      (lines[index] ?? '').trim() !== '' &&
      !/^(#{1,6})\s|^```|^(\s*)([-*+]|\d+\.)\s+/.test(lines[index] ?? '') &&
      !/^!\[([^\]]*)\]\(([^)]+)\)$/.test((lines[index] ?? '').trim())
    ) {
      paragraphLines.push(lines[index] ?? '');
      index++;
    }
    const id = nextId();
    model.blocks[id] = { id, type: T.paragraph, runs: parseInline(paragraphLines.join(' ').trim()) };
    model.rootOrder.push(id);
  }

  return { model, status: warnings.length > 0 ? 'lossy' : 'lossless', warnings };
}

/** Human kind label for media export warnings. */
function mediaKindLabel(type: string): string {
  return type === T.video ? 'video' : type === T.audio ? 'audio' : 'file';
}

/** Preferred display text for an exported media locator: caption, name, alt, else kind. */
function mediaExportLabel(record: BlockRecord): string {
  for (const key of ['caption', 'name', 'alt'] as const) {
    const value = record[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return mediaKindLabel(String(record.type));
}

/** Canonical locator bytes for export; null when the record carries none (invalid shapes). */
function mediaExportLocator(record: BlockRecord): string | null {
  if (typeof record.src === 'string') return record.src;
  const remote = record.remote;
  if (typeof remote === 'object' && remote !== null && !Array.isArray(remote)) {
    const url = (remote as { url?: unknown }).url;
    if (typeof url === 'string') return url;
  }
  return null;
}

/** Export a Block Page to the CommonMark+GFM subset with loss reporting. */
export function exportBlockPageToMarkdown(
  model: BlockPageModel,
  registry?: BlockRegistry,
  resolveResource?: ResourceMarkdownResolver,
): ExportResult {
  const warnings: string[] = [];
  const chunks: string[] = [];

  // Frontmatter meta.
  const metaLines: string[] = [];
  if (typeof model.meta.title === 'string') metaLines.push(`title: ${model.meta.title}`);
  if (Array.isArray(model.meta.tags) && model.meta.tags.length > 0) {
    metaLines.push('tags:');
    for (const tag of model.meta.tags) metaLines.push(`  - ${String(tag)}`);
  }
  if (model.meta.properties !== undefined && typeof model.meta.properties === 'object') {
    metaLines.push(`properties: ${JSON.stringify(model.meta.properties)}`);
  }
  if (metaLines.length > 0) chunks.push(`---\n${metaLines.join('\n')}\n---`);

  const visited = new Set<BlockId>();
  const flattened = new Set<BlockId>();
  /** Depth-capped child emission: past the cap, subtrees continue flat with one warning. */
  const emitChild = (
    parentId: BlockId,
    parentIndent: string,
    depth: number,
    childId: BlockId,
    childIndent: string,
  ): void => {
    const nextDepth = depth + 1;
    if (nextDepth > MAX_EXPORT_DEPTH) {
      if (!flattened.has(parentId)) {
        warnings.push(`structure under "${parentId}" flattened: deeper than Markdown represents`);
        flattened.add(parentId);
      }
      emitBlock(childId, parentIndent, depth);
      return;
    }
    emitBlock(childId, childIndent, nextDepth);
  };
  const emitBlock = (id: BlockId, indent: string, depth = 0): void => {
    if (visited.has(id)) return;
    visited.add(id);
    const record: BlockRecord | undefined = model.blocks[id];
    if (record === undefined) return;
    if (!isCoreBlockType(record.type)) {
      // Registered plugin types may contribute a Markdown mapping; anything
      // else is omitted loudly.
      const descriptor = lookupType(registry, record.type);
      const rendered = descriptor?.toMarkdown?.(record as Record<string, unknown>);
      if (typeof rendered === 'string' && rendered !== '') {
        for (const line of rendered.split('\n')) chunks.push(`${indent}${line}`);
      } else if (descriptor !== undefined) {
        warnings.push(`block "${id}" (${record.type}) has no Markdown mapping; omitted from export`);
      } else {
        warnings.push(`unregistered block "${id}" (${record.type}) omitted from export`);
      }
      return;
    }
    let warnedResourceMark = false;
    const inline = (runs: Run[]): string => renderRuns(runs, resolveResource, () => {
      if (warnedResourceMark) return;
      warnedResourceMark = true;
      warnings.push(`resource mark in block "${id}" has no portable Markdown target; emitted as text`);
    });
    switch (record.type) {
      case T.heading: {
        const level = typeof record.level === 'number' ? Math.min(6, Math.max(1, record.level)) : 1;
        chunks.push(`${indent}${'#'.repeat(level)} ${inline(runsOf(record) ?? [])}`);
        break;
      }
      case T.paragraph:
        chunks.push(`${indent}${inline(runsOf(record) ?? [])}`);
        break;
      case T.code:
        chunks.push('```' + (typeof record.language === 'string' ? record.language : '') + '\n' + String(record.text ?? '').replace(/\n$/, '') + '\n```');
        break;
      case T.image: {
        chunks.push(`![${String(record.alt ?? '')}](${String(record.src)})`);
        if (record.sha256 === '') warnings.push(`image "${id}" exported without integrity verification`);
        break;
      }
      case T.video:
      case T.audio:
      case T.file: {
        // Only valid locators export: an invalid (e.g. rejected-remote)
        // media record stays canonical-but-opaque and its locator bytes
        // must never be emitted as a fetchable Markdown link.
        if (!isValidCoreRecord(record)) {
          warnings.push(`${mediaKindLabel(record.type)} "${id}" has no usable locator; omitted from export`);
          break;
        }
        const label = mediaExportLabel(record);
        const locator = mediaExportLocator(record) ?? '';
        if (record.type === T.video) {
          chunks.push(`${indent}![${label}](${locator})`);
          warnings.push(`video "${id}" approximated as an image link; media type and integrity pin are not representable`);
        } else {
          chunks.push(`${indent}[${label}](${locator})`);
          warnings.push(`${mediaKindLabel(record.type)} "${id}" approximated as a link; media type and integrity pin are not representable`);
        }
        break;
      }
      case T.math: {
        if (typeof record.source !== 'string') {
          warnings.push(`math "${id}" has no usable source; omitted from export`);
          break;
        }
        chunks.push('```math\n' + String(record.source).replace(/\n$/, '') + '\n```');
        warnings.push(`math "${id}" exported as a fenced math block; rendered output is not representable`);
        break;
      }
      case T.diagram: {
        if (typeof record.source !== 'string') {
          warnings.push(`diagram "${id}" has no usable source; omitted from export`);
          break;
        }
        chunks.push('```mermaid\n' + String(record.source).replace(/\n$/, '') + '\n```');
        warnings.push(`diagram "${id}" exported as a fenced mermaid block; rendered output is not representable`);
        break;
      }
      case T.list: {
        const ordered = record.ordered === true;
        const items = Array.isArray(record.items)
          ? (record.items as Array<{ runs?: Run[]; checked?: boolean; children?: BlockId[] }>)
          : [];
        const lines: string[] = [];
        items.forEach((item, itemIndex) => {
          const marker = ordered ? `${itemIndex + 1}.` : '-';
          const taskBox = item.checked === undefined ? '' : item.checked ? '[x] ' : '[ ] ';
          lines.push(`${indent}${marker} ${taskBox}${inline(item.runs ?? [])}`);
          for (const child of item.children ?? []) {
            const before = chunks.length;
            emitChild(id, indent, depth, child, `${indent}  `);
            // Nested blocks splice into this chunk to stay inside the list.
            if (chunks.length > before) {
              lines.push(...chunks.splice(before).join('\n').split('\n'));
            }
          }
        });
        chunks.push(lines.join('\n'));
        for (const child of Array.isArray(record.children) ? (record.children as BlockId[]) : []) {
          emitChild(id, indent, depth, child, indent);
        }
        break;
      }
      case T.table: {
        const rows = Array.isArray(record.rows) ? (record.rows as Array<{ cells?: Run[][] }>) : [];
        const columnCount = typeof record.columnCount === 'number' ? record.columnCount : 0;
        const align = Array.isArray(record.align) ? (record.align as string[]) : [];
        const renderRow = (cells: Run[][]): string =>
          `| ${Array.from({ length: Math.max(columnCount, cells.length) }, (_, i) => inline(cells[i] ?? [])).join(' | ')} |`;
        rows.forEach((row, rowIndex) => {
          chunks.push(renderRow(row.cells ?? []));
          if (rowIndex === 0 && record.header === true) {
            chunks.push(`| ${align.map((a) => (a === 'center' ? ':---:' : a === 'right' ? '---:' : '---')).join(' | ')} |`);
          }
        });
        break;
      }
      case T.quote:
        chunks.push(`${indent}> ${inline(runsOf(record) ?? [])}`);
        break;
      case T.divider:
        chunks.push(`${indent}---`);
        break;
      case T.toggle: {
        warnings.push(`toggle "${id}" exported as a list item; collapsed state is not representable`);
        const before = chunks.length;
        const lines = [`${indent}- ${inline(runsOf(record) ?? [])}`];
        for (const child of Array.isArray(record.children) ? (record.children as BlockId[]) : []) {
          emitChild(id, indent, depth, child, `${indent}  `);
          if (chunks.length > before) {
            lines.push(...chunks.splice(before).join('\n').split('\n'));
          }
        }
        chunks.push(lines.join('\n'));
        break;
      }
      case T.callout: {
        const icon = typeof record.icon === 'string' && record.icon !== '' ? `${record.icon} ` : '';
        chunks.push(`${indent}> ${icon}${inline(runsOf(record) ?? [])}`);
        warnings.push(`callout "${id}" tone/icon approximated as a blockquote`);
        break;
      }
      case T.resourceLink: {
        const portable = resolveResource?.(record.target as ResourceTarget) ?? null;
        if (portable === null) warnings.push(`resource link "${id}" has no portable Markdown target; omitted from export`);
        else chunks.push(`${indent}[${typeof record.label === 'string' ? record.label : portable}](${portable})`);
        break;
      }
      case T.resourceEmbed:
      case T.transclusion: {
        const portable = resolveResource?.(record.target as ResourceTarget) ?? null;
        if (portable === null) warnings.push(`${record.type === T.resourceEmbed ? 'resource embed' : 'transclusion'} "${id}" has no supported portable Markdown target; omitted from export`);
        else chunks.push(`${indent}![[${portable}]]`);
        break;
      }
      case T.linkedView:
        warnings.push(`linked view "${id}" cannot be reconstructed from Markdown; omitted from export`);
        break;
    }

    // Universal children on non-list parents have no Markdown nesting
    // representation: emitted flat, warned once per parent (loss table).
    if (record.type !== T.list && record.type !== T.toggle) {
      const kids = Array.isArray(record.children) ? (record.children as BlockId[]) : [];
      if (kids.length > 0) {
        warnings.push(`structure under "${id}" emitted flat (Markdown cannot nest here)`);
        for (const child of kids) emitChild(id, indent, depth, child, indent);
      }
    }
  };

  for (const id of model.rootOrder) emitBlock(id, '');
  // Unreachable blocks still get their omission reported.
  for (const id of Object.keys(model.blocks)) emitBlock(id, '');

  // Non-empty pages with no exportable content are unsupported; any
  // reported loss is lossy.
  const hadContent = model.rootOrder.length > 0 || Object.keys(model.blocks).length > 0;
  const hasBody = chunks.some((chunk) => !chunk.startsWith('---'));
  const status: ConversionStatus =
    hadContent && !hasBody ? 'unsupported' : warnings.length > 0 ? 'lossy' : 'lossless';
  const markdown = `${chunks.join('\n\n')}${chunks.length > 0 ? '\n' : ''}`;
  return { markdown, status, warnings };
}
