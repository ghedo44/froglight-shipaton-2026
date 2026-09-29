/**
 * Notebook embed aggregation: per-page `notebook.embed` edges with
 * `pageId/objectId` sources, opaque exclusion, ordering, save→reextract.
 */

import { describe, expect, it } from 'vitest';
import { WorkspaceServiceImpl } from '../workspace.js';
import { InMemoryDocumentRegistry } from '../documents.js';
import { InMemoryMetadataService } from '../metadata.js';
import { InMemoryRelationshipService } from '../relationships.js';
import { VaultRevisionService } from '../revisions.js';
import { InMemorySearchService } from '../search/service.js';
import { createMemoryVault } from '../vault/memory.js';
import { workspacePath } from '../paths.js';
import {
  boundedFrame,
  emptySurface,
  resourceEmbedObject,
  textObject,
} from '../surfaces/model.js';
import {
  emptyNotebook,
  notebookPage,
  type NotebookModel,
} from './model.js';
import { encodeNotebook } from './codec.js';
import {
  NOTEBOOK_EMBED_EDGE_TYPE,
  extractNotebookEmbedRelationships,
  formatNotebookEmbedAddress,
  notebookKind,
  notebookKindId,
  parseNotebookEmbedAddress,
} from './kind.js';

function target(overrides: Record<string, unknown> = {}) {
  return {
    documentId: 'doc1',
    kindId: 'froglight.markdown',
    resourceId: 'res1',
    ...overrides,
  };
}

function decodeRef(resourceId: string) {
  return {
    documentId: 'doc-nb' as never,
    kindId: notebookKindId,
    location: { resourceId: resourceId as never },
  };
}

function makeWorkspace() {
  const { vault } = createMemoryVault();
  const registry = new InMemoryDocumentRegistry();
  registry.register(notebookKind);
  const metadata = new InMemoryMetadataService();
  const relationships = new InMemoryRelationshipService();
  const search = new InMemorySearchService();
  const revisions = new VaultRevisionService({
    vault,
    resolveResource: () => undefined,
  });
  const wsPromise = WorkspaceServiceImpl.create({
    vault,
    registry,
    metadata,
    relationships,
    revisions,
    search,
    workspaceId: 'ws-notebook-refs-test',
  });
  return { vault, registry, metadata, relationships, search, wsPromise };
}

describe('extractNotebookEmbedRelationships', () => {
  it('aggregates per-page edges with pageId/objectId sources in page order', () => {
    const model = emptyNotebook('refs');
    const surfaceA = emptySurface(boundedFrame(100, 100));
    surfaceA.objects.e1 = resourceEmbedObject('e1', {
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      target: target(),
    });
    surfaceA.objects.e2 = resourceEmbedObject('e2', {
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      target: target({ documentId: 'doc2', address: 'sec1' }),
    });
    surfaceA.order.push('e1', 'e2');
    const surfaceB = emptySurface(boundedFrame(100, 100));
    surfaceB.objects.e1 = resourceEmbedObject('e1', {
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      target: target({ documentId: 'doc3' }),
    });
    surfaceB.order.push('e1');
    model.pages.a = notebookPage('a', { surface: surfaceA });
    model.pages.b = notebookPage('b', { surface: surfaceB });
    model.pageOrder.push('a', 'b');

    const edges = extractNotebookEmbedRelationships(
      model,
      decodeRef('res-nb'),
    );
    expect(edges.map((e) => e.source.address)).toEqual([
      'a/e1',
      'a/e2',
      'b/e1',
    ]);
    expect(edges.map((e) => e.type)).toEqual([
      'notebook.embed',
      'notebook.embed',
      'notebook.embed',
    ]);
    expect(edges[1]!.target.location.address).toBe('sec1');
    expect(edges[0]!.metadata).toEqual({ objectId: 'e1', pageId: 'a' });
    expect(edges[2]!.metadata).toEqual({ objectId: 'e1', pageId: 'b' });
  });

  it('skips opaque pages and invalid targets, preserves dangling', () => {
    const model = emptyNotebook();
    const surface = emptySurface(boundedFrame(100, 100));
    surface.objects.good = resourceEmbedObject('good', {
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      target: target({ documentId: 'ghost', resourceId: 'ghost-res' }),
    });
    surface.objects.bad = {
      id: 'bad',
      type: 'froglight.resource-embed',
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      target: { documentId: '', kindId: '', resourceId: '' },
    };
    surface.order.push('good', 'bad');
    model.pages.good = notebookPage('good', { surface });
    model.pages.broken = {
      kind: 'opaque',
      id: 'broken',
      raw: { id: 'broken', surface: {} },
    };
    model.pageOrder.push('good', 'broken');

    const edges = extractNotebookEmbedRelationships(
      model as NotebookModel,
      decodeRef('res-nb'),
    );
    expect(edges.map((e) => e.source.address)).toEqual(['good/good']);
  });

  it('decodes relationships through the kind (not empty) and re-encodes', () => {
    const model = emptyNotebook();
    const surface = emptySurface(boundedFrame(100, 100));
    surface.objects.e1 = resourceEmbedObject('e1', {
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      target: target({ address: 'sec9' }),
    });
    surface.order.push('e1');
    model.pages.p1 = notebookPage('p1', { surface });
    model.pageOrder.push('p1');
    const decoded = notebookKind.decode(encodeNotebook(model), decodeRef('r-1'));
    expect(decoded.relationships).toHaveLength(1);
    expect(decoded.relationships[0]!.type).toBe('notebook.embed');
    expect(decoded.relationships[0]!.type).toBe(NOTEBOOK_EMBED_EDGE_TYPE);
    expect(decoded.relationships[0]!.source.address).toBe('p1/e1');
    // Sub-location survives encode→decode (reopen) at the notebook level.
    expect(decoded.relationships[0]!.target.location.address).toBe('sec9');
  });

  it('keeps the composite address opaque: metadata is authoritative when ids contain /', () => {
    const model = emptyNotebook('slash');
    const surface = emptySurface(boundedFrame(100, 100));
    const objectId = 'obj/with/slash';
    surface.objects[objectId] = resourceEmbedObject(objectId, {
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      target: target(),
    });
    surface.order.push(objectId);
    // Page ids are opaque too: exercise a slash-containing page id.
    const pageId = 'page/with/slash';
    model.pages[pageId] = notebookPage(pageId, { surface });
    model.pageOrder.push(pageId);

    const edges = extractNotebookEmbedRelationships(
      model,
      decodeRef('res-nb'),
    );
    expect(edges).toHaveLength(1);
    // Composite is a plain join — opaque, never parsed by consumers.
    expect(edges[0]!.source.address).toBe(`${pageId}/${objectId}`);
    // Authoritative split lives in metadata, never in string parsing.
    expect(edges[0]!.metadata).toEqual({ objectId, pageId });
  });

  it('pins the best-effort parse rule: split on the first / (metadata wins)', () => {
    // Canonical format helper round-trips the slash-free case.
    expect(formatNotebookEmbedAddress('p1', 'e1')).toBe('p1/e1');
    expect(parseNotebookEmbedAddress('p1/e1')).toEqual({
      pageId: 'p1',
      objectId: 'e1',
    });
    // Slash-containing ids are NOT reversible via string: first-/ split keeps
    // the objectId suffix verbatim, so consumers must read metadata instead.
    expect(parseNotebookEmbedAddress('page/with/slash/obj/with/slash')).toEqual(
      {
        pageId: 'page',
        objectId: 'with/slash/obj/with/slash',
      },
    );
    expect(parseNotebookEmbedAddress('p1/e1/extra')).toEqual({
      pageId: 'p1',
      objectId: 'e1/extra',
    });
    expect(parseNotebookEmbedAddress('no-slash')).toBeNull();
    expect(parseNotebookEmbedAddress(undefined)).toBeNull();
  });
});

describe('notebook save→reextract refresh', () => {
  it('refreshes indexed edges after page edits without stale entries', async () => {
    const { relationships, wsPromise } = makeWorkspace();
    const ws = await wsPromise;
    const model = emptyNotebook('refresh');
    const surface = emptySurface(boundedFrame(100, 100));
    surface.objects.e1 = resourceEmbedObject('e1', {
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      target: target(),
    });
    surface.order.push('e1');
    model.pages.p1 = notebookPage('p1', { surface });
    model.pageOrder.push('p1');

    const created = await ws.createDocument({
      kindId: notebookKindId,
      path: workspacePath('nb.notebook'),
      initialModel: model,
    });
    const documentId = created.documentId;
    expect(relationships.byTarget('doc1' as never)).toHaveLength(1);

    // Add a second embed on a second page, save, expect two edges.
    const opened = await ws.openDocument<NotebookModel>(documentId);
    const live = opened.model;
    const surface2 = emptySurface(boundedFrame(100, 100));
    surface2.objects.e9 = resourceEmbedObject('e9', {
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      target: target({ documentId: 'doc2', resourceId: 'res2' }),
    });
    surface2.order.push('e9');
    live.pages.p2 = notebookPage('p2', { surface: surface2 });
    live.pageOrder.push('p2');
    // Touch text on p1 to prove non-embed edits do not disturb edges.
    const p1 = live.pages.p1;
    if (p1 !== undefined && p1.kind === 'page') {
      p1.surface.objects.t1 = textObject('t1', { x: 0, y: 0, text: 'hi' });
      p1.surface.order.push('t1');
    }
    opened.markDirty();
    await opened.save();
    expect(
      relationships.bySource(created.location.resourceId).map((e) => e.source.address),
    ).toEqual(['p1/e1', 'p2/e9']);

    // Remove the first embed, save, expect only the second edge (no stale).
    const p1b = (opened.model as NotebookModel).pages.p1;
    if (p1b !== undefined && p1b.kind === 'page') {
      delete p1b.surface.objects.e1;
      p1b.surface.order = p1b.surface.order.filter((id) => id !== 'e1');
    }
    opened.markDirty();
    await opened.save();
    expect(
      relationships.bySource(created.location.resourceId).map((e) => e.source.address),
    ).toEqual(['p2/e9']);
    expect(relationships.byTarget('doc1' as never)).toHaveLength(0);
    await opened.close();
  });
});
