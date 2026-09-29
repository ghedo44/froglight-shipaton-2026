/**
 * Search projection for notebooks
 * page labels and stored text objects in page order, with
 * anchors mapping character ranges back to containing page ids. Only
 * canonical content projects here — recognized handwriting joins search
 * exclusively through the derived recognition flow.
 */

import type { NotebookModel } from './model.js';
import { isNavigablePage, labelOf } from './model.js';
import { SURFACE_OBJECT_TYPES } from '../surfaces/model.js';
import type { SearchDocument } from '../markdown/search.js';

export interface NotebookSearchAnchor {
  /** Page id used as `DocumentLocation.address`. */
  readonly address: string;
  readonly start: number;
  readonly end: number;
}

export interface NotebookSearchProjection extends SearchDocument {
  /** Character ranges in `body` per contributing chunk. */
  readonly anchors: readonly NotebookSearchAnchor[];
}

/** Build the textual projection with per-page anchors. Engine-free. */
export function projectNotebookForSearch(
  model: NotebookModel,
  docId: string,
): NotebookSearchProjection {
  const parts: string[] = [];
  const anchors: NotebookSearchAnchor[] = [];
  let cursor = 0;

  const pushText = (pageId: string, text: string): void => {
    if (text === '') return;
    if (cursor > 0) {
      parts.push('\n');
      cursor += 1;
    }
    parts.push(text);
    anchors.push({ address: pageId, start: cursor, end: cursor + text.length });
    cursor += text.length;
  };

  for (const id of model.pageOrder) {
    const entry = model.pages[id];
    if (!isNavigablePage(entry)) continue;
    const label = labelOf(entry);
    if (label !== undefined && label !== '') pushText(id, label);
    for (const objectId of entry.surface.order) {
      const record = entry.surface.objects[objectId];
      if (record?.type !== SURFACE_OBJECT_TYPES.text) continue;
      if (typeof record.text === 'string' && record.text !== '') {
        pushText(id, record.text);
      }
    }
  }

  const body = parts.join('');
  const title =
    typeof model.meta.title === 'string' ? model.meta.title : '';
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
