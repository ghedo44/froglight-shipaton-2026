/**
 * Whiteboard picker-host integration through the PUBLIC whiteboard entry
 * The host consumes the shared picker (dialog, link
 * codec, card) through `@froglight/ui/react`; the picker's output — one
 * stable `ResourceTarget` — lands here, where this spec proves the
 * whiteboard half of the contract through `./index.js` (the whiteboard
 * barrel, never `./resource-embed.js`): (a) a pick inserts a
 * resource-embed at the expected surface position; (b) a dangling target
 * keeps its record — identity intact for the placeholder card — until an
 * explicit replace/remove.
 */
import { describe, expect, it } from 'vitest';
import {
  emptySurface,
  infiniteFrame,
  type ResourceTarget,
} from '@froglight/foundation';
import {
  insertWhiteboardEmbed,
  isWhiteboardEmbedDangling,
  isWhiteboardEmbedRecord,
  removeWhiteboardEmbed,
  replaceWhiteboardEmbedTarget,
} from './index.js';

/** A pick as produced by the shared picker: stable identity + host label. */
function pick(): { target: ResourceTarget; label: string } {
  return {
    target: {
      documentId: 'docA',
      kindId: 'froglight.markdown',
      resourceId: 'resA',
    },
    label: 'Source doc',
  };
}

describe('whiteboard picker-host integration (public barrel entry)', () => {
  it('inserts the picked target at the expected surface position', () => {
    const model = emptySurface(infiniteFrame());
    const { target, label } = pick();
    const id = insertWhiteboardEmbed(model, target, {
      x: 120,
      y: 80,
      cachedTitle: label,
    });
    expect(model.order).toContain(id);
    const record = model.objects[id]!;
    expect(record).toMatchObject({
      type: 'froglight.resource-embed',
      x: 120,
      y: 80,
      cachedTitle: 'Source doc',
    });
    expect(record.target).toEqual(target);
    expect(JSON.stringify(record)).not.toContain('http');
    expect(isWhiteboardEmbedRecord(record)).toBe(true);
  });

  it('keeps a dangling record with identity intact for the placeholder card', () => {
    const model = emptySurface(infiniteFrame());
    const { target, label } = pick();
    const id = insertWhiteboardEmbed(model, target, {
      x: 10,
      y: 20,
      cachedTitle: label,
      cachedKind: 'froglight.markdown',
    });
    // The target is gone (resolver reports missing): the record stays —
    // hosts never auto-delete — with identity intact for the card.
    expect(isWhiteboardEmbedDangling(model, id, () => false)).toBe(true);
    const record = model.objects[id]! as unknown as Record<string, unknown>;
    expect(record.target).toEqual(target);
    expect(record.cachedTitle).toBe('Source doc');
    // Card input contract: the preserved record still carries everything
    // `ResourceEmbedCard` renders (id/type/target/cached display).
    expect(record.id).toBe(id);
    expect(record.type).toBe('froglight.resource-embed');
    expect(record.cachedKind).toBe('froglight.markdown');
    // Replace preserves the frame and clears stale display; remove deletes
    // only the reference record.
    expect(
      replaceWhiteboardEmbedTarget(model, id, {
        documentId: 'docB',
        kindId: 'froglight.markdown',
        resourceId: 'resB',
      }),
    ).toBe(true);
    expect(model.objects[id]).toMatchObject({ x: 10, y: 20 });
    expect(model.objects[id]!.target).toEqual({
      documentId: 'docB',
      kindId: 'froglight.markdown',
      resourceId: 'resB',
    });
    expect(removeWhiteboardEmbed(model, id)).toBe(true);
    expect(model.objects[id]).toBeUndefined();
    expect(model.order).not.toContain(id);
    expect(removeWhiteboardEmbed(model, id)).toBe(false);
  });
});
