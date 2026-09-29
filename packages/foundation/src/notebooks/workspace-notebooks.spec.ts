/**
 * Foundation-level Notebook integration: create/open/
 * edit/reorder/save/reopen through WorkspaceService with derived
 * metadata/search projections kept fresh, page-addressed results, and the
 * shared revision path.
 */

import { describe, expect, it } from 'vitest';
import { WorkspaceServiceImpl } from '../workspace.js';
import { InMemoryDocumentRegistry } from '../documents.js';
import { InMemoryMetadataService } from '../metadata.js';
import { InMemoryRelationshipService } from '../relationships.js';
import { VaultRevisionService } from '../revisions.js';
import { InMemorySearchService } from '../search/service.js';
import { createMemoryVault } from '../vault/memory.js';
import { boundedFrame, inkStrokeObject, textObject } from '../surfaces/model.js';
import { createCamera } from '../surfaces/geometry.js';
import { compileScene, renderSurfaceScene } from '../surfaces/render.js';
import { createDefaultSurfaceObjectTypeRegistry } from '../surfaces/objects.js';
import { RecordingSurfaceBackend } from '../testing/headless-surface-backend.js';
import {
  appendPage,
  emptyNotebook,
  encodeNotebook,
  isNavigablePage,
  navigablePageIds,
  notebookPage,
  notebookKind,
  notebookKindId,
  type NotebookModel,
} from './index.js';
import { workspacePath } from '../paths.js';

function makeWorkspace() {
  const { vault } = createMemoryVault();
  const registry = new InMemoryDocumentRegistry();
  registry.register(notebookKind);
  const metadata = new InMemoryMetadataService();
  const relationships = new InMemoryRelationshipService();
  const search = new InMemorySearchService();
  const revisions = new VaultRevisionService({ vault, resolveResource: () => undefined });
  const wsPromise = WorkspaceServiceImpl.create({
    vault,
    registry,
    metadata,
    relationships,
    revisions,
    search,
    workspaceId: 'ws-notebooks-test',
  });
  return { vault, registry, metadata, relationships, search, revisions, wsPromise };
}

function sampleModel(): NotebookModel {
  const model = emptyNotebook('Journal');
  const first = notebookPage('p1', { label: 'Lecture', template: 'froglight.lined' });
  first.surface.objects['t1'] = textObject('t1', { x: 4, y: 4, text: 'eigenvalues' });
  first.surface.order.push('t1');
  appendPage(model, first);
  appendPage(model, notebookPage('p2', { template: 'froglight.grid' }));
  return model;
}

describe('notebook vertical slice — shared document path', () => {
  it('creates, opens, edits pages, saves, and keeps derived state fresh', async () => {
    const { wsPromise, metadata, search } = makeWorkspace();
    const ws = await wsPromise;
    const ref = await ws.createDocument({
      kindId: notebookKindId,
      path: workspacePath('notebooks/journal.notebook'),
      initialModel: sampleModel(),
    });
    await ws.rebuildDerivedState();

    expect(metadata.get(ref.documentId).title).toBe('Journal');
    expect(search.search({ text: 'eigenvalues' })[0]?.location.address).toBe('p1');

    const session = await ws.openDocument<NotebookModel>(ref.documentId);
    // Page ops are plain model operations on canonical data.
    const third = notebookPage('p3', { label: 'Appendix', template: 'froglight.dots' });
    appendPage(session.model, third);
    // Duplicate page two ahead of it (fresh id, copied content).
    const sourcePage = session.model.pages['p2'];
    if (!sourcePage || sourcePage.kind !== 'page') throw new Error('expected navigable p2');
    const copy = notebookPage('p2-copy', {
      template: 'froglight.grid',
      surface: JSON.parse(JSON.stringify(sourcePage.surface)),
    });
    session.model.pages[copy.id] = copy;
    const order = session.model.pageOrder;
    order.splice(order.indexOf('p2') + 1, 0, 'p2-copy');
    session.markDirty();
    expect((await session.save()).committed).toBe(true);

    const reopened = await ws.openDocument<NotebookModel>(ref.documentId);
    expect(reopened.model.pageOrder).toEqual(['p1', 'p2', 'p2-copy', 'p3']);
    expect(navigablePageIds(reopened.model)).toHaveLength(4);
    expect(search.search({ text: 'Appendix' })[0]?.location.address).toBe('p3');
  });

  it('keeps page ids stable across reorder/delete and round-trips through save', async () => {
    const { wsPromise, search } = makeWorkspace();
    const ws = await wsPromise;
    const ref = await ws.createDocument({
      kindId: notebookKindId,
      path: workspacePath('notebooks/stability.notebook'),
      initialModel: sampleModel(),
    });
    const session = await ws.openDocument<NotebookModel>(ref.documentId);

    // Reorder p2 before p1, then delete p1.
    const order = session.model.pageOrder;
    order.splice(order.indexOf('p2'), 1);
    order.unshift('p2');
    delete session.model.pages['p1'];
    const p1Index = order.indexOf('p1');
    if (p1Index !== -1) order.splice(p1Index, 1);
    session.markDirty();
    await session.save();

    const reopened = await ws.openDocument<NotebookModel>(ref.documentId);
    expect(reopened.model.pageOrder).toEqual(['p2']);
    const page = reopened.model.pages['p2'];
    expect(isNavigablePage(page)).toBe(true);
    if (isNavigablePage(page)) {
      expect(page.surface.frame).toEqual(boundedFrame(1240, 1754));
    }
    // Deleted page's text no longer searchable; remaining projections intact.
    await reopened.close();
    await ws.rebuildDerivedState();
    expect(search.search({ text: 'eigenvalues' })).toHaveLength(0);
  });
});

describe('notebook many-page smoke', () => {
  it('decodes, compiles, culls, and walks a stroke-heavy page list within budget', () => {
    const model = emptyNotebook('Many pages');
    for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
      const page = notebookPage(`p${pageIndex}`);
      for (let strokeIndex = 0; strokeIndex < 20; strokeIndex += 1) {
        const id = `s${pageIndex}-${strokeIndex}`;
        page.surface.objects[id] = inkStrokeObject(id, {
          points: [
            { x: strokeIndex * 12, y: 20 },
            { x: strokeIndex * 12 + 8, y: 32 },
            { x: strokeIndex * 12 + 16, y: 20 },
          ],
          width: 3,
        });
        page.surface.order.push(id);
      }
      appendPage(model, page);
    }

    const started = performance.now();
    const decoded = notebookKind.decode(encodeNotebook(model), {
      documentId: 'notebook-performance' as never,
      kindId: notebookKindId,
      location: { resourceId: 'notebook-performance-resource' as never },
    });
    const registry = createDefaultSurfaceObjectTypeRegistry();
    let compiledCount = 0;
    let drawnCount = 0;
    for (const id of navigablePageIds(decoded.model)) {
      const page = decoded.model.pages[id];
      if (page?.kind !== 'page') continue;
      compiledCount += compileScene(page.surface, registry).length;
      const backend = new RecordingSurfaceBackend();
      renderSurfaceScene(
        backend,
        page.surface,
        registry,
        createCamera(0, 0, 1),
        { width: 800, height: 600 },
      );
      drawnCount += backend.drawnItemIds().length;
    }

    expect(performance.now() - started).toBeLessThan(10_000);
    expect(navigablePageIds(decoded.model)).toHaveLength(100);
    expect(compiledCount).toBe(2_000);
    expect(drawnCount).toBeGreaterThan(0);
  });
});
