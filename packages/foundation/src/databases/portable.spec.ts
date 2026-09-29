import { describe, expect, it } from 'vitest';
import { InMemoryDocumentRegistry } from '../documents.js';
import { InMemoryMetadataService } from '../metadata.js';
import { InMemoryRelationshipService } from '../relationships.js';
import { markdownKind, markdownKindId } from '../markdown/kind.js';
import { markdownModel } from '../markdown/model.js';
import { workspacePath } from '../paths.js';
import { PropertyCatalog } from '../resource-properties/catalog.js';
import {
  resourcePropertyPath,
  WorkspaceResourceProperties,
} from '../resource-properties/provider.js';
import { createMemoryVault } from '../vault/memory.js';
import { WorkspaceServiceImpl } from '../workspace.js';
import { databaseKind, databaseKindId } from './kind.js';
import { createDatabase, type DatabaseModel } from './model.js';
import { exportPortableDatabase, importPortableDatabase } from './portable.js';

function registry() {
  const value = new InMemoryDocumentRegistry();
  value.register(markdownKind);
  value.register(databaseKind);
  return value;
}

async function workspace(
  vault = createMemoryVault().vault,
  documents = registry(),
) {
  return {
    vault,
    registry: documents,
    workspace: await WorkspaceServiceImpl.create({
      vault,
      registry: documents,
      metadata: new InMemoryMetadataService(),
      relationships: new InMemoryRelationshipService(),
      revisions: null,
    }),
  };
}

async function sourceFixture() {
  const env = await workspace();
  const included = await env.workspace.createDocument({
    kindId: markdownKindId,
    path: workspacePath('Notes/Included.md'),
    initialModel: markdownModel('# Included\nBody'),
  });
  const external = await env.workspace.createDocument({
    kindId: markdownKindId,
    path: workspacePath('Notes/External.md'),
    initialModel: markdownModel('# External'),
  });
  const model = createDatabase('Portable');
  model.properties.push(
    { id: 'status', name: 'Status', type: 'text' },
    {
      id: 'related',
      name: 'Related',
      type: 'relation',
      relation: { databaseId: 'pending' },
    },
  );
  model.membership = {
    mode: 'explicit',
    resourceIds: [included.location.resourceId, external.location.resourceId],
  };
  model.views[0] = {
    ...model.views[0]!,
    where: {
      operator: 'or',
      filters: [
        {
          property: 'related',
          operator: 'contains',
          value: included.location.resourceId,
        },
        {
          property: 'related',
          operator: 'contains',
          value: external.location.resourceId,
        },
      ],
    },
  };
  const database = await env.workspace.createDocument({
    kindId: databaseKindId,
    path: workspacePath('Portable.base'),
    initialModel: model,
  });
  const session = await env.workspace.openDocument<DatabaseModel>(
    database.documentId,
  );
  session.model.properties[1] = {
    id: 'related',
    name: 'Related',
    type: 'relation',
    relation: { databaseId: database.location.resourceId },
  };
  session.markDirty();
  await session.save();
  await session.close();

  const properties = new WorkspaceResourceProperties({
    workspace: env.workspace,
    vault: env.vault,
    metadata: new InMemoryMetadataService(),
    relationships: new InMemoryRelationshipService(),
    revisions: null,
    catalog: new PropertyCatalog(),
  });
  await properties.write(
    included,
    { id: 'status', name: 'Status', type: 'text' },
    'ready',
  );
  await properties.write(
    included,
    { id: 'related', name: 'Related', type: 'relation' },
    [database.location.resourceId, external.location.resourceId],
  );
  return { ...env, database, included, external };
}

describe('portable database export/import', () => {
  it('round-trips canonical content, schema and sidecars while remapping included identities', async () => {
    const source = await sourceFixture();
    const bundle = await exportPortableDatabase({
      databaseId: source.database.location.resourceId,
      includeResourceIds: [source.included.location.resourceId],
      workspace: source.workspace,
      vault: source.vault,
    });
    const targetMemory = createMemoryVault();
    const target = await workspace(targetMemory.vault);
    const result = await importPortableDatabase({
      bundle,
      workspace: target.workspace,
      vault: target.vault,
      registry: target.registry,
      destinationRoot: workspacePath('Restored'),
    });
    expect(result.status).toBe('complete');
    if (result.status !== 'complete') return;
    await target.workspace.dispose();
    const reopenedMemory = createMemoryVault({ state: targetMemory.state });
    const reopened = await workspace(reopenedMemory.vault);

    const note = result.imported.find(
      (item) => item.sourceResourceId === source.included.location.resourceId,
    );
    if (!note) throw new Error('Imported note mapping is missing');
    expect(note.resourceId).not.toBe(source.included.location.resourceId);
    expect(
      (await reopened.workspace.readDocument<{ raw: string }>(note.documentId))
        .model.raw,
    ).toBe('# Included\nBody');
    const database = (
      await reopened.workspace.readDocument<DatabaseModel>(
        result.database.documentId,
      )
    ).model;
    expect(database.membership).toEqual({
      mode: 'explicit',
      resourceIds: [note.resourceId, source.external.location.resourceId],
    });
    expect(database.properties[1]?.relation?.databaseId).toBe(
      result.database.resourceId,
    );
    expect(database.views[0]?.where).toEqual({
      operator: 'or',
      filters: [
        { property: 'related', operator: 'contains', value: note.resourceId },
        {
          property: 'related',
          operator: 'contains',
          value: source.external.location.resourceId,
        },
      ],
    });
    const propertyRecord = JSON.parse(
      new TextDecoder().decode(
        await reopened.vault.read(resourcePropertyPath(note.resourceId)),
      ),
    ) as { owner: string; values: Record<string, unknown> };
    expect(propertyRecord.owner).toBe(note.resourceId);
    expect(propertyRecord.values).toMatchObject({
      status: 'ready',
      related: [
        result.database.resourceId,
        source.external.location.resourceId,
      ],
    });
    expect(result.externalReferences.map((item) => item.kind).sort()).toEqual([
      'membership',
      'relation-value',
      'relation-value',
    ]);
  });

  it('rejects unsupported plugin schema and destination collisions before mutation', async () => {
    const source = await sourceFixture();
    const session = await source.workspace.openDocument<DatabaseModel>(
      source.database.documentId,
    );
    session.model.views.push({ id: 'map', name: 'Map', type: 'plugin.map' });
    session.markDirty();
    await session.save();
    await session.close();
    await expect(
      exportPortableDatabase({
        databaseId: source.database.location.resourceId,
        workspace: source.workspace,
        vault: source.vault,
      }),
    ).rejects.toThrow('Unsupported plugin view');

    const clean = await sourceFixture();
    const bundle = await exportPortableDatabase({
      databaseId: clean.database.location.resourceId,
      includeResourceIds: [clean.included.location.resourceId],
      workspace: clean.workspace,
      vault: clean.vault,
    });
    const target = await workspace();
    await target.workspace.createDocument({
      kindId: markdownKindId,
      path: workspacePath('Restored/Notes/Included.md'),
      initialModel: markdownModel('existing'),
    });
    const before = target.workspace.listDocuments().length;
    await expect(
      importPortableDatabase({
        bundle,
        workspace: target.workspace,
        vault: target.vault,
        registry: target.registry,
        destinationRoot: workspacePath('Restored'),
      }),
    ).rejects.toThrow('already exists');
    expect(target.workspace.listDocuments()).toHaveLength(before);
  });

  it('reports committed documents when a later sidecar write fails', async () => {
    const source = await sourceFixture();
    const bundle = await exportPortableDatabase({
      databaseId: source.database.location.resourceId,
      includeResourceIds: [source.included.location.resourceId],
      workspace: source.workspace,
      vault: source.vault,
    });
    const memory = createMemoryVault({
      fail: (operation, path) =>
        operation === 'write' && path.startsWith('.froglight/properties/')
          ? new Error('injected sidecar failure')
          : null,
    });
    const target = await workspace(memory.vault);
    const result = await importPortableDatabase({
      bundle,
      workspace: target.workspace,
      vault: target.vault,
      registry: target.registry,
    });
    expect(result).toMatchObject({
      status: 'partial',
      phase: 'write-properties',
      failedSourceResourceId: source.included.location.resourceId,
    });
    expect(result.imported).toHaveLength(2);
    expect(target.workspace.listDocuments()).toHaveLength(2);
  });
});
