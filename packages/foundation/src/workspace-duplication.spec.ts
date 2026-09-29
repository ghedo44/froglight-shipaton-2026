import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryDocumentRegistry,
  cloneTemplateValue,
  type DocumentKindDescriptor,
} from './documents.js';
import { documentKindId } from './identity.js';
import { InMemoryMetadataService } from './metadata.js';
import { workspacePath } from './paths.js';
import { InMemoryRelationshipService } from './relationships.js';
import { createMemoryVault } from './vault/memory.js';
import { WorkspaceServiceImpl } from './workspace.js';
import {
  createDatabase,
  databaseKind,
  databaseKindId,
  type DatabaseModel,
} from './databases/index.js';

async function fixture() {
  const { vault } = createMemoryVault();
  const registry = new InMemoryDocumentRegistry();
  const workspace = await WorkspaceServiceImpl.create({
    vault,
    registry,
    metadata: new InMemoryMetadataService(),
    relationships: new InMemoryRelationshipService(),
    revisions: null,
    workspaceId: 'duplication-test',
  });
  return { registry, vault, workspace };
}

describe('workspace duplication lifecycle', () => {
  it('fails closed while a custom kind is withdrawn and clones once after reactivation', async () => {
    const env = await fixture();
    const kindId = documentKindId('acme.lifecycle-document');
    type PluginModel = {
      nodeId: string;
      externalResourceId: string;
      opaque: Record<string, unknown>;
    };
    const clone = vi.fn(
      (model: PluginModel, context: { newInternalId(): string }) => ({
        ...cloneTemplateValue(model),
        nodeId: context.newInternalId(),
      }),
    );
    const kind: DocumentKindDescriptor<PluginModel> = {
      id: kindId,
      cloneTemplate: clone,
      decode: (bytes) => ({
        model: JSON.parse(new TextDecoder().decode(bytes)) as PluginModel,
        metadata: {},
        relationships: [],
      }),
      encode: (model) => new TextEncoder().encode(JSON.stringify(model)),
    };
    const registration = env.registry.register(kind);
    const source = await env.workspace.createDocument({
      kindId,
      path: workspacePath('Source.acme'),
      initialModel: {
        nodeId: 'node-1',
        externalResourceId: 'outside-resource',
        opaque: { future: ['preserved', 1] },
      },
    });

    registration.dispose();
    await expect(
      env.workspace.duplicateDocument(
        source.documentId,
        workspacePath('Unavailable.acme'),
      ),
    ).rejects.toThrow(/document kind/i);
    expect(env.workspace.listDocuments()).toHaveLength(1);
    await expect(
      env.vault.stat(workspacePath('Unavailable.acme')),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    const restored = env.registry.register(kind);
    const duplicate = await env.workspace.duplicateDocument(
      source.documentId,
      workspacePath('Copy.acme'),
    );
    const copied = (
      await env.workspace.readDocument<PluginModel>(duplicate.documentId)
    ).model;
    expect(clone).toHaveBeenCalledOnce();
    expect(duplicate.documentId).not.toBe(source.documentId);
    expect(duplicate.location.resourceId).not.toBe(source.location.resourceId);
    expect(copied.nodeId).not.toBe('node-1');
    expect(copied.externalResourceId).toBe('outside-resource');
    expect(copied.opaque).toEqual({ future: ['preserved', 1] });
    restored.dispose();
    await env.workspace.dispose();
  });

  it('duplicates a database with independent schema identities and explicit external membership', async () => {
    const env = await fixture();
    env.registry.register(databaseKind);
    const model = createDatabase('Projects');
    model.properties = [
      {
        id: 'status',
        name: 'Status',
        type: 'select',
        options: [{ id: 'active', name: 'Active' }],
      },
      {
        id: 'rating',
        name: 'Rating',
        type: 'acme.rating',
        pluginConfiguration: { stars: 7 },
      },
      {
        id: 'score',
        name: 'Score',
        type: 'formula',
        formula: 'prop("rating") * 2',
      },
    ];
    model.membership = {
      mode: 'explicit',
      resourceIds: ['external-member' as never],
    };
    model.views = [
      {
        id: 'board',
        name: 'Board',
        type: 'board',
        filters: [{ property: 'status', operator: 'eq', value: 'active' }],
        sorts: [{ property: 'rating' }],
        groupBy: 'status',
        visibleProperties: ['status', 'rating'],
        columnWidths: { status: 180, rating: 200 },
      },
    ];
    model.templates = [
      {
        id: 'default-template',
        name: 'Default',
        kindId: 'acme.lifecycle-document',
        model: { future: true },
        defaults: { status: 'active', rating: 5 },
      },
    ];
    model.propertyPresentation = {
      order: ['rating', 'status'],
      sections: [{ name: 'Main', propertyIds: ['status', 'rating'] }],
    };
    const source = await env.workspace.createDocument({
      kindId: databaseKindId,
      path: workspacePath('Projects.base'),
      initialModel: model,
    });
    const duplicate = await env.workspace.duplicateDocument(
      source.documentId,
      workspacePath('Projects copy.base'),
    );
    const copied = (
      await env.workspace.readDocument<DatabaseModel>(duplicate.documentId)
    ).model;
    const ids = Object.fromEntries(
      copied.properties.map((property) => [property.name, property.id]),
    );

    expect(copied.properties.map((property) => property.id)).not.toEqual(
      model.properties.map((property) => property.id),
    );
    expect(copied.properties[1]).toMatchObject({
      type: 'acme.rating',
      pluginConfiguration: { stars: 7 },
    });
    expect(copied.properties[2]?.formula).toContain(`prop("${ids.Rating}")`);
    expect(copied.views[0]).toMatchObject({
      groupBy: ids.Status,
      visibleProperties: [ids.Status, ids.Rating],
      sorts: [{ property: ids.Rating }],
    });
    expect(copied.views[0]?.id).not.toBe('board');
    expect(copied.templates[0]?.id).not.toBe('default-template');
    expect(copied.templates[0]?.defaults).toEqual({
      [ids.Status]: copied.properties[0]?.options?.[0]?.id,
      [ids.Rating]: 5,
    });
    expect(copied.membership).toEqual(model.membership);
    expect(copied.propertyPresentation).toMatchObject({
      order: [ids.Rating, ids.Status],
      sections: [{ name: 'Main', propertyIds: [ids.Status, ids.Rating] }],
    });
    await env.workspace.dispose();
  });
});
