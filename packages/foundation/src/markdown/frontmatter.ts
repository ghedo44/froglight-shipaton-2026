/**
 * Frontmatter parsing.
 *
 * YAML frontmatter is recognized only when the file starts with `---\n`
 * and is closed by a line `---` or `...` on its own. Preservation-first:
 * the raw block is kept, unknown keys survive round trips, and malformed
 * YAML still opens but yields `frontmatter === null` with the raw block
 * preserved.
 */

import type { JsonValue } from '../metadata.js';

export interface FrontmatterResult {
  /** Parsed YAML object; `null` when no frontmatter or malformed. */
  readonly frontmatter: Readonly<Record<string, JsonValue>> | null;
  /** Raw block including fences and inner text; `null` when no block. */
  readonly raw: string | null;
  /** Body text after the block (or entire raw when no block). */
  readonly body: string;
  /** Raw inner YAML text without fences; `null` when no block. */
  readonly inner: string | null;
}

/**
 * Very small YAML subset parser sufficient for v1: handles
 * simple keys: values where values are string / number / boolean / null
 * / arrays of strings via `["a", "b"]` or line `tags: [a, b]` or `tags:` newline `  - a` style.
 * Preservation of unknown fields is handled at the codec layer by keeping
 * the original raw block unchanged on write when the parsed model hasn't
 * been mutated through a structured API — but for the model is
 * raw-string-based, so the original bytes are always preserved.
 */
export function parseFrontmatter(raw: string): FrontmatterResult {
  if (!raw.startsWith('---\n') && !raw.startsWith('---\r\n')) {
    return { frontmatter: null, raw: null, body: raw, inner: null };
  }
  const lines = raw.split(/\r?\n/);
  if (lines[0] !== '---') {
    return { frontmatter: null, raw: null, body: raw, inner: null };
  }
  let closing = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === '---' || lines[i] === '...') {
      closing = i;
      break;
    }
  }
  if (closing === -1) {
    return { frontmatter: null, raw: null, body: raw, inner: null };
  }
  const innerLines = lines.slice(1, closing);
  const inner = innerLines.join('\n');
  const rawBlock = lines.slice(0, closing + 1).join('\n') + (closing + 1 < lines.length ? '\n' : '');
  const body = lines.slice(closing + 1).join('\n');
  // Handle leading newline: join will have dropped one newline after fence.
  // rawBlock already includes the trailing newline after closing fence.
  // Body should not have an extra leading newline beyond that.
  const parsed = parseYamlObject(inner);
  return { frontmatter: parsed, raw: rawBlock, body, inner };
}

function parseYamlObject(source: string): Readonly<Record<string, JsonValue>> | null {
  const result: Record<string, JsonValue> = {};
  const lines = source.split('\n');
  let currentKey: string | null = null;
  let currentList: JsonValue[] | null = null;
  try {
    for (const rawLine of lines) {
      const line = rawLine.trimEnd();
      if (line.trim() === '' || line.trim().startsWith('#')) {
        continue;
      }
      // List continuation: "  - value"
      const listMatch = line.match(/^\s*-\s*(.*)$/);
      if (listMatch !== null && currentKey !== null && currentList !== null) {
        const value = parseYamlValue(listMatch[1].trim());
        currentList.push(value as JsonValue);
        result[currentKey] = [...currentList];
        continue;
      }
      // Key: value
      const idx = line.indexOf(':');
      if (idx === -1) {
        // Not a key line — malformed YAML, abandon.
        return null;
      }
      const key = line.slice(0, idx).trim();
      const rest = line.slice(idx + 1).trim();
      if (key === '') {
        return null;
      }
      currentKey = key;
      if (rest === '') {
        // Start of block list on next lines.
        currentList = [];
        result[key] = [];
        continue;
      }
      if (rest.startsWith('[') && rest.endsWith(']')) {
        const inner = rest.slice(1, -1).trim();
        if (inner === '') {
          result[key] = [];
        } else {
          const items = splitArray(inner).map((s) => parseYamlValue(s.trim()));
          result[key] = items as JsonValue[];
        }
        currentList = null;
        currentKey = null;
        continue;
      }
      const value = parseYamlValue(rest);
      result[key] = value as JsonValue;
      currentList = null;
      currentKey = null;
    }
    return result;
  } catch {
    return null;
  }
}

function splitArray(inner: string): string[] {
  // Simple split on commas not inside quotes.
  const items: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      current += ch;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      current += ch;
    } else if (ch === ',' && !inSingle && !inDouble) {
      items.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current !== '') {
    items.push(current);
  }
  return items;
}

function parseYamlValue(text: string): unknown {
  if (text === '' || text === 'null' || text === '~') {
    return null;
  }
  if (text === 'true') {
    return true;
  }
  if (text === 'false') {
    return false;
  }
  if (text.startsWith('"') && text.endsWith('"')) return JSON.parse(text);
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replaceAll("''", "'");
  if (text.startsWith('{') && text.endsWith('}')) return JSON.parse(text);
  if (/^-?\d+$/.test(text)) {
    return Number.parseInt(text, 10);
  }
  if (/^-?\d*\.\d+$/.test(text)) {
    return Number.parseFloat(text);
  }
  // Strip surrounding brackets already handled; fallback string.
  return text;
}

/** Re-serialize frontmatter map into a YAML block (used only when constructing new files). */
export function serializeFrontmatter(frontmatter: Readonly<Record<string, JsonValue>>): string {
  const lines: string[] = ['---'];
  for (const [key, value] of Object.entries(frontmatter)) {
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}: []`);
      } else if (value.every((v) => typeof v === 'string')) {
        lines.push(`${key}: [${(value as string[]).map((s) => JSON.stringify(s)).join(', ')}]`);
      } else {
        lines.push(`${key}:`);
        for (const item of value) {
          lines.push(`  - ${JSON.stringify(item)}`);
        }
      }
    } else if (typeof value === 'string') {
      // Quote if needed
      if (value.includes(':') || value.includes('#') || value.trim() !== value) {
        lines.push(`${key}: ${JSON.stringify(value)}`);
      } else {
        lines.push(`${key}: ${value}`);
      }
    } else {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    }
  }
  lines.push('---');
  return lines.join('\n') + '\n';
}
