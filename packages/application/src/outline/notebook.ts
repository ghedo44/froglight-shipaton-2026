/**
 * Notebook outline extractor for heading-role text.
 *
 * Only navigable pages contribute heading-role text objects. Only
 * `froglight.text` objects with `role === 'heading'` participate
 * (tolerant `textRoleOf` read: missing/unknown/caption/label/body roles
 * are non-heading and excluded); cards, images, strokes, and other
 * objects are excluded, as are empty/whitespace-only texts.
 *
 * Heading levels follow the editor's H1/H2/H3 size thresholds. Deterministic
 * order: canonical page order, then within a page ascending
 * y, ascending x, then object id (full ties break by id). Object rows use
 * `pageId:objectId` as the outline id and the page id as the portable
 * address (search anchors are page-scoped); labels pin to the first line,
 * trimmed.
 */

import {
  SURFACE_OBJECT_TYPES,
  SURFACE_TEXT_H1_MIN_SIZE,
  SURFACE_TEXT_H2_MIN_SIZE,
  effectiveSurfaceTextSizeOf,
  isNavigablePage,
  navigablePageIds,
  notebookKindId,
  textRoleOf,
  type NotebookModel,
} from '@froglight/foundation';
import type { DocumentOutlineEntry, OutlineExtractInput, OutlineExtractor } from './types.js';

function finiteOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function firstLine(text: string): string | null {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed !== '') return trimmed;
  }
  return null;
}

/** Extract in-page text headings; never mutates the model. */
export function extractNotebookOutline(model: NotebookModel): readonly DocumentOutlineEntry[] {
  const entries: DocumentOutlineEntry[] = [];
  const navigable = navigablePageIds(model);
  navigable.forEach((pageId) => {
    const page = model.pages[pageId];
    if (!isNavigablePage(page)) return;
    const objects = page.surface.order
      .map((objectId) => ({ objectId, record: page.surface.objects[objectId] }))
      .filter(
        (item): item is { objectId: string; record: NonNullable<typeof item.record> } =>
          item.record !== undefined &&
          item.record.type === SURFACE_OBJECT_TYPES.text &&
          typeof item.record.text === 'string' &&
          firstLine(item.record.text) !== null &&
          textRoleOf(item.record) === 'heading',
      )
      .sort((a, b) => {
        const yDelta = finiteOrZero(a.record.y) - finiteOrZero(b.record.y);
        if (yDelta !== 0) return yDelta;
        const xDelta = finiteOrZero(a.record.x) - finiteOrZero(b.record.x);
        if (xDelta !== 0) return xDelta;
        return a.objectId < b.objectId ? -1 : a.objectId > b.objectId ? 1 : 0;
      });
    for (const { objectId, record } of objects) {
      const size = effectiveSurfaceTextSizeOf(record);
      entries.push({
        id: `${pageId}:${objectId}`,
        address: pageId,
        level: size >= SURFACE_TEXT_H1_MIN_SIZE ? 1 : size >= SURFACE_TEXT_H2_MIN_SIZE ? 2 : 3,
        label: firstLine(record.text as string) as string,
        kind: 'object',
      });
    }
  });
  return entries;
}

export const notebookOutlineExtractor: OutlineExtractor = {
  kindId: notebookKindId,
  extract: (input: OutlineExtractInput) => extractNotebookOutline(input.model as NotebookModel),
};
