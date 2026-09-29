import { describe, expect, it } from 'vitest';
import type {
  DocumentRef,
  Relationship,
  RelationshipService,
  WorkspaceService,
} from '@froglight/foundation';
import {
  localConnectionProjection,
  projectConnections,
} from './connection-projection.js';

const documents = [
  ref('doc-a', 'res-a', 'froglight.blockpage'),
  ref('doc-b', 'res-b', 'froglight.markdown'),
  ref('doc-c', 'res-c', 'froglight.notebook'),
  ref('doc-d', 'res-d', 'froglight.ink'),
];
const paths = new Map([
  ['res-a', 'topics/a.blockpage'],
  ['res-b', 'topics/b.md'],
  ['res-c', 'topics/c.notebook'],
  ['res-d', 'other/d.ink'],
]);

function ref(
  documentId: string,
  resourceId: string,
  kindId: string,
): DocumentRef {
  return {
    documentId: documentId as never,
    kindId: kindId as never,
    location: { resourceId: resourceId as never },
  };
}

function edge(input: {
  id: string;
  type: string;
  source: string;
  targetDocument: string;
  targetResource: string;
  sourceAddress?: string;
  targetAddress?: string;
  metadata?: Readonly<Record<string, unknown>>;
}): Relationship {
  return {
    id: input.id,
    type: input.type,
    source: {
      resourceId: input.source as never,
      ...(input.sourceAddress === undefined
        ? {}
        : { address: input.sourceAddress }),
    },
    target: {
      documentId: input.targetDocument as never,
      kindId: 'test.kind' as never,
      location: {
        resourceId: input.targetResource as never,
        ...(input.targetAddress === undefined
          ? {}
          : { address: input.targetAddress }),
      },
    },
    metadata: input.metadata ?? {},
  };
}

function services(edges: readonly Relationship[]) {
  const workspace = {
    listDocuments: () => documents,
    resolveResourcePath: (resourceId: string) => paths.get(resourceId) as never,
    findByResourcePath: (path: string) => {
      const resource = [...paths.entries()].find(
        ([, value]) => value === path,
      )?.[0];
      return (
        documents.find((item) => item.location.resourceId === resource) ?? null
      );
    },
  } as unknown as WorkspaceService;
  const relationships = {
    list: () => edges,
  } as unknown as RelationshipService;
  return { workspace, relationships };
}

describe('connection projection', () => {
  it('unifies mixed families, stable identity, addresses, repeats, and one-hop graphs', () => {
    const projection = projectConnections(
      services([
        edge({
          id: 'block-link',
          type: 'blockpage.link',
          source: 'res-a',
          sourceAddress: 'block-1',
          targetDocument: 'doc-b',
          // Deliberately not the document id: document and resource identity
          // must remain separate.
          targetResource: 'res-b',
          targetAddress: 'heading',
        }),
        edge({
          id: 'embed-repeat',
          type: 'blockpage.embed',
          source: 'res-a',
          sourceAddress: 'block-2',
          targetDocument: 'doc-b',
          targetResource: 'res-b',
        }),
        edge({
          id: 'second-hop',
          type: 'notebook.embed',
          source: 'res-b',
          targetDocument: 'doc-c',
          targetResource: 'res-c',
        }),
        edge({
          id: 'incoming',
          type: 'ink.embed',
          source: 'res-d',
          sourceAddress: 'object-7',
          targetDocument: 'doc-a',
          targetResource: 'res-a',
        }),
        edge({
          id: 'missing',
          type: 'markdown.link',
          source: 'res-a',
          targetDocument: 'missing.md',
          targetResource: 'missing.md',
          metadata: { href: 'missing.md' },
        }),
      edge({
        id: 'external',
          type: 'markdown.link.external',
          source: 'res-a',
          targetDocument: 'https://example.test',
          targetResource: 'https://example.test',
        metadata: { href: 'https://example.test' },
      }),
      edge({
        id: 'stale-stable',
        type: 'blockpage.link',
        source: 'res-a',
        targetDocument: 'removed-doc',
        targetResource: 'removed-resource',
        metadata: { href: 'topics/b.md' },
      }),
      ]),
    );

    const ab = projection.edges.find((item) =>
      item.occurrences.some((occurrence) => occurrence.id === 'block-link'),
    );
    expect(ab?.occurrences).toHaveLength(2);
    expect(ab?.forwardCount).toBe(2);
    expect(projection.unresolved.map((item) => item.id)).toEqual([
      'missing',
      'stale-stable',
    ]);
    expect(
      projection.occurrences.find((item) => item.id === 'block-link'),
    ).toMatchObject({
      sourceAddress: 'block-1',
      targetAddress: 'heading',
      targetDocumentId: 'doc-b',
    });
    expect(projection.occurrences.some((item) => item.id === 'external')).toBe(
      false,
    );

    const local = localConnectionProjection(projection, 'doc-a');
    expect(local.documents.map((item) => item.documentId).sort()).toEqual([
      'doc-a',
      'doc-b',
      'doc-d',
    ]);
    expect(local.edges).toHaveLength(2);
    expect(local.documents.some((item) => item.documentId === 'doc-c')).toBe(
      false,
    );
  });
});
