import { expect, it, vi } from 'vitest';
import { InMemoryDocumentRegistry } from '../documents.js';
import { InMemoryMetadataService } from '../metadata.js';
import { InMemoryRelationshipService } from '../relationships.js';
import { createMemoryVault } from '../vault/memory.js';
import { WorkspaceServiceImpl } from '../workspace.js';
import { workspacePath } from '../paths.js';
import { markdownKind } from '../markdown/kind.js';
import { PropertyCatalog } from '../resource-properties/catalog.js';
import { WorkspaceResourceProperties } from '../resource-properties/provider.js';
import { databaseKind } from './kind.js';
import { createDatabase, type DatabaseModel } from './model.js';
import { FormulaFunctions } from './formula.js';
import { InMemoryDatabaseQueryProvider } from './query.js';
import { DatabaseController } from './controller.js';
import { PartialRelationWriteError } from './relations.js';

it('edits either relation direction, preserves canonical ownership and reports partial writes', async () => {
  const { vault } = createMemoryVault();
  const registry = new InMemoryDocumentRegistry();
  registry.register(databaseKind);
  registry.register(markdownKind);
  const metadata = new InMemoryMetadataService();
  const relationships = new InMemoryRelationshipService();
  const workspace = await WorkspaceServiceImpl.create({
    vault,
    registry,
    metadata,
    relationships,
    revisions: null,
  });
  const catalog = new PropertyCatalog();
  const properties = new WorkspaceResourceProperties({
    workspace,
    vault,
    metadata,
    relationships,
    revisions: null,
    catalog,
  });
  workspace.registerProjection({
    project: (ref) => properties.project(ref),
    remove: (ref) => properties.remove(ref.location.resourceId),
  });
  try {
    const contacts = await workspace.createDocument({
      kindId: databaseKind.id,
      path: workspacePath('Contacts.base'),
      initialModel: createDatabase('Contacts'),
    });
    const deals = await workspace.createDocument({
      kindId: databaseKind.id,
      path: workspacePath('Deals.base'),
      initialModel: createDatabase('Deals'),
    });
    const contactSession = await workspace.openDocument<DatabaseModel>(
      contacts.documentId,
    );
    const dealSession = await workspace.openDocument<DatabaseModel>(
      deals.documentId,
    );
    const definitions = {
      get: (id: string) =>
        id === contacts.location.resourceId
          ? contactSession.model
          : id === deals.location.resourceId
            ? dealSession.model
            : undefined,
    };
    const query = new InMemoryDatabaseQueryProvider(
      new FormulaFunctions(),
      catalog,
      definitions,
      relationships,
    );
    const context = { definitions, relationships };
    const contactController = new DatabaseController(
      contactSession,
      workspace,
      properties,
      query,
      context,
    );
    const dealController = new DatabaseController(
      dealSession,
      workspace,
      properties,
      query,
      context,
    );
    await dealController.saveRelation(
      {
        id: 'contact',
        name: 'Contact',
        type: 'relation',
        relation: {
          databaseId: contacts.location.resourceId,
          inversePropertyId: 'deals',
        },
      },
      'Deals',
    );
    expect(contactSession.model.properties[0]?.relation).toEqual({
      databaseId: deals.location.resourceId,
      inversePropertyId: 'contact',
      inverse: true,
    });
    const contact = await contactController.createResource({
      kindId: markdownKind.id,
      path: workspacePath('Ada.md'),
      initialModel: { raw: '# Ada' },
    });
    const first = await dealController.createResource({
      kindId: markdownKind.id,
      path: workspacePath('First.md'),
      initialModel: { raw: '# First' },
    });
    const second = await dealController.createResource({
      kindId: markdownKind.id,
      path: workspacePath('Second.md'),
      initialModel: { raw: '# Second' },
    });
    await dealController.write(first.location.resourceId, 'contact', [
      contact.location.resourceId,
    ]);
    expect((await contactController.rows('table'))[0]?.values.deals).toEqual([
      first.location.resourceId,
    ]);
    await contactController.write(contact.location.resourceId, 'deals', [
      second.location.resourceId,
    ]);
    expect((await properties.read(first)).contact).toEqual([]);
    expect((await properties.read(second)).contact).toEqual([
      contact.location.resourceId,
    ]);
    expect((await properties.read(contact)).deals).toBeUndefined();
    await expect(
      properties.write(contact, contactSession.model.properties[0]!, []),
    ).rejects.toThrow(/relation authority/);
    await workspace.rebuildDerivedState();
    expect((await contactController.rows('table'))[0]?.values.deals).toEqual([
      second.location.resourceId,
    ]);
    await contactController.write(contact.location.resourceId, 'deals', []);
    const update = properties.update.bind(properties);
    const fault = vi
      .spyOn(properties, 'update')
      .mockImplementationOnce(update)
      .mockRejectedValueOnce(new Error('storage failure'));
    const failure = await contactController
      .write(contact.location.resourceId, 'deals', [
        first.location.resourceId,
        second.location.resourceId,
      ])
      .catch((error) => error);
    expect(failure).toBeInstanceOf(PartialRelationWriteError);
    expect(failure.committedResources).toEqual([first.location.resourceId]);
    expect(failure.failedResource).toBe(second.location.resourceId);
    expect((await properties.read(first)).contact).toEqual([
      contact.location.resourceId,
    ]);
    fault.mockRestore();
    await properties.write(first, dealSession.model.properties[0]!, []);
    await Promise.all([
      properties.update(first, dealSession.model.properties[0]!, (current) => [
        ...(Array.isArray(current) ? current : []),
        'one',
      ]),
      properties.update(first, dealSession.model.properties[0]!, (current) => [
        ...(Array.isArray(current) ? current : []),
        'two',
      ]),
    ]);
    expect((await properties.read(first)).contact).toEqual(['one', 'two']);
    expect((await workspace.readDocument(contact.documentId)).model).toEqual({
      raw: '# Ada',
    });
  } finally {
    await properties.dispose();
    await workspace.dispose();
  }
});
