/**
 * Search projection for block pages.
 *
 * Body text is the concatenation of run/code text in traversal order; a
 * parallel anchor list maps character ranges of `body` back to containing
 * block ids so search results can carry `DocumentLocation.address`.
 */

import { runsOf, inlineRunsOf, codeTextOf, childrenOf, type BlockPageModel } from './model.js';
import type { SearchDocument } from '../markdown/search.js';
import { tokenize } from '../markdown/search.js';

export interface SearchAnchor {
  /** Block id used as `DocumentLocation.address`. */
  readonly address: string;
  readonly start: number;
  readonly end: number;
}

export interface BlockPageSearchProjection extends SearchDocument {
  /** Character ranges in `body` per contributing block. */
  readonly anchors: readonly SearchAnchor[];
}

/** Build the textual projection with per-block anchors. Engine-free. */
export function projectBlockPageForSearch(model: BlockPageModel, docId: string): BlockPageSearchProjection {
  const parts: string[] = [];
  const anchors: SearchAnchor[] = [];
  let cursor = 0;

  const pushText = (id: string, text: string): void => {
    if (text === '') return;
    if (cursor > 0) {
      parts.push('\n');
      cursor += 1;
    }
    parts.push(text);
    anchors.push({ address: id, start: cursor, end: cursor + text.length });
    cursor += text.length;
  };

  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    visited.add(id);
    const record = model.blocks[id];
    if (record === undefined) return;
    const runs = runsOf(record);
    if (runs !== null) {
      pushText(id, runs.map((run) => run.text).join(''));
    } else {
      const code = codeTextOf(record);
      if (code !== null) {
      pushText(id, code);
      } else if (record.type === 'froglight.list' || record.type === 'froglight.table') {
        pushText(id, inlineRunsOf(record).map((run) => run.text).filter(Boolean).join(' '));
      } else if (
        record.type === 'froglight.video' ||
        record.type === 'froglight.audio' ||
        record.type === 'froglight.file'
      ) {
        // Host-authored presentation text only: `name`/`caption`
        // are indexed. Vault paths, integrity hashes, and remote URL bytes
        // never enter the projection: only name/caption are indexed.
        // `alt` stays unindexed, like other provider hint text.
        if (typeof record.name === 'string') pushText(id, record.name);
        if (typeof record.caption === 'string') pushText(id, record.caption);
      } else if (record.type === 'froglight.math' || record.type === 'froglight.diagram') {
        // Source-only indexing: the author-written source text is
        // host text like code-block content; rendered output (KaTeX HTML,
        // Mermaid SVG) is derived and never indexed.
        if (typeof record.source === 'string') pushText(id, record.source);
      } else if (
        record.type === 'froglight.resource-link' ||
        record.type === 'froglight.resource-embed' ||
        record.type === 'froglight.transclusion' ||
        record.type === 'froglight.linked-view'
      ) {
        // Only host-authored cached labels participate. Provider-rendered
        // source text/results never enter this projection.
        if (typeof record.label === 'string') pushText(id, record.label);
      }
    }
    for (const child of childrenOf(record)) visit(child);
  };
  for (const id of model.rootOrder) visit(id);
  // Unreachable blocks still contribute text (recovered documents).
  for (const id of Object.keys(model.blocks)) visit(id);

  const body = parts.join('');
  const title = typeof model.meta.title === 'string' ? model.meta.title : '';
  const tags = Array.isArray(model.meta.tags)
    ? (model.meta.tags.filter((tag): tag is string => typeof tag === 'string') as string[])
    : [];

  const propertyTexts: string[] = [];
  const properties = model.meta.properties;
  if (typeof properties === 'object' && properties !== null && !Array.isArray(properties)) {
    for (const value of Object.values(properties as Record<string, unknown>)) {
      if (typeof value === 'string') propertyTexts.push(value);
    }
  }

  const titleBoost = title !== '' ? `${title} ${title}` : '';
  const indexText = [titleBoost, tags.join(' '), body, propertyTexts.join(' ')]
    .filter(Boolean)
    .join('\n');

  return { documentId: docId, title, tags, body, indexText, anchors };
}

export { tokenize };
