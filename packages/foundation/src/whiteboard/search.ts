/**
 * Whiteboard search projection — indexes host-authored text plus cached embed
 * titles, never flattened preview content (search semantics).
 */

import type { SurfaceModel } from '../surfaces/model.js';

export interface WhiteboardSearchProjection {
  readonly body: string;
  readonly anchors: ReadonlyArray<{ address: string; excerpt: string }>;
}

export function projectWhiteboardForSearch(model: SurfaceModel): WhiteboardSearchProjection {
  const parts: string[] = [];
  const anchors: Array<{ address: string; excerpt: string }> = [];

  for (const id of model.order) {
    const record = model.objects[id];
    if (!record) continue;
    if ((record.type === 'froglight.text' || record.type === 'froglight.card') && typeof record.text === 'string' && record.text.trim() !== '') {
      const text = record.text.trim();
      parts.push(text);
      anchors.push({ address: id, excerpt: text.slice(0, 200) });
      continue;
    }
    if (record.type === 'froglight.resource-embed' && typeof record.cachedTitle === 'string' && record.cachedTitle.trim() !== '') {
      const title = record.cachedTitle.trim();
      parts.push(title);
      anchors.push({ address: id, excerpt: title.slice(0, 200) });
      continue;
    }
    if (record.type === 'froglight.image' && typeof record.alt === 'string' && record.alt.trim() !== '') {
      const alt = record.alt.trim();
      parts.push(alt);
      anchors.push({ address: id, excerpt: alt.slice(0, 200) });
    }
  }

  // Also index out-of-order text for robustness
  for (const id of Object.keys(model.objects)) {
    if (model.order.includes(id)) continue;
    const record = model.objects[id];
    if (!record) continue;
    if ((record.type === 'froglight.text' || record.type === 'froglight.card') && typeof record.text === 'string' && record.text.trim() !== '') {
      const text = record.text.trim();
      parts.push(text);
      anchors.push({ address: id, excerpt: text.slice(0, 200) });
    }
  }

  return { body: parts.join('\n'), anchors };
}
