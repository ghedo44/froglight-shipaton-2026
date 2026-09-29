/**
 * Notebook picker-host integration through the PUBLIC notebook entry
 * The host consumes the shared picker (dialog, link
 * codec, card) through `@froglight/ui/react`; the picker's output — one
 * stable `ResourceTarget` — lands here, where this spec proves the notebook
 * half of the contract through `./index.js` (the notebook barrel, never
 * `./react/resource-embed.js`): (a) a pick inserts a resource-embed at the
 * expected page-surface position; (b) a dangling target keeps its record —
 * identity intact for the placeholder card — until an explicit
 * replace/remove.
 */
import { describe, expect, it } from 'vitest';
import {
  appendPage,
  boundedFrame,
  emptyNotebook,
  emptySurface,
  notebookPage,
  type NotebookModel,
  type NotebookPageId,
  type ResourceTarget,
  type SurfaceModel,
} from '@froglight/foundation';
import {
  insertNotebookEmbed,
  isNotebookEmbedDangling,
  isNotebookEmbedRecord,
  removeNotebookEmbed,
  replaceNotebookEmbedTarget,
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

function fixture(): NotebookModel {
  const model = emptyNotebook('Embed fixture');
  appendPage(
    model,
    notebookPage('p1', { surface: emptySurface(boundedFrame(800, 600)) }),
  );
  return model;
}

function surfaceOf(model: NotebookModel, pageId: NotebookPageId): SurfaceModel {
  const entry = model.pages[pageId] as unknown as { surface: SurfaceModel };
  return entry.surface;
}

describe('notebook picker-host integration (public barrel entry)', () => {
  it('inserts the picked target at the expected page-surface position', () => {
    const model = fixture();
    const { target, label } = pick();
    const id = insertNotebookEmbed(model, 'p1', target, {
      x: 40,
      y: 60,
      cachedTitle: label,
    });
    expect(id).not.toBeNull();
    const surface = surfaceOf(model, 'p1');
    expect(surface.order).toContain(id);
    const record = surface.objects[id!]!;
    expect(record).toMatchObject({
      type: 'froglight.resource-embed',
      x: 40,
      y: 60,
      cachedTitle: 'Source doc',
    });
    expect(record.target).toEqual(target);
    expect(JSON.stringify(record)).not.toContain('http');
    expect(isNotebookEmbedRecord(record)).toBe(true);
  });

  it('keeps a dangling record with identity intact for the placeholder card', () => {
    const model = fixture();
    const { target, label } = pick();
    const id = insertNotebookEmbed(model, 'p1', target, {
      x: 10,
      y: 20,
      cachedTitle: label,
      cachedKind: 'froglight.markdown',
    });
    expect(id).not.toBeNull();
    // The target is gone (resolver reports missing): the record stays —
    // hosts never auto-delete — with identity intact for the card.
    expect(isNotebookEmbedDangling(model, 'p1', id!, () => false)).toBe(true);
    const stored = surfaceOf(model, 'p1').objects[id!]! as unknown as Record<
      string,
      unknown
    >;
    expect(stored.target).toEqual(target);
    expect(stored.cachedTitle).toBe('Source doc');
    // Card input contract: the preserved record still carries everything
    // `ResourceEmbedCard` renders (id/type/target/cached display).
    expect(stored.id).toBe(id);
    expect(stored.type).toBe('froglight.resource-embed');
    expect(stored.cachedKind).toBe('froglight.markdown');
    // Replace preserves the frame and clears stale display; remove deletes
    // only the reference record.
    expect(
      replaceNotebookEmbedTarget(
        model,
        'p1',
        id!,
        {
          documentId: 'docB',
          kindId: 'froglight.markdown',
          resourceId: 'resB',
        },
      ),
    ).toBe(true);
    expect(surfaceOf(model, 'p1').objects[id!]).toMatchObject({
      x: 10,
      y: 20,
    });
    expect(surfaceOf(model, 'p1').objects[id!]!.target).toEqual({
      documentId: 'docB',
      kindId: 'froglight.markdown',
      resourceId: 'resB',
    });
    expect(removeNotebookEmbed(model, 'p1', id!)).toBe(true);
    expect(surfaceOf(model, 'p1').objects[id!]).toBeUndefined();
    expect(surfaceOf(model, 'p1').order).not.toContain(id);
    expect(removeNotebookEmbed(model, 'p1', id!)).toBe(false);
  });
});
