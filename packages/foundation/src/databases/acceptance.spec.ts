import { PropertyCatalog } from '../resource-properties/catalog.js';
import {
  WorkspaceResourceProperties,
  resourcePropertyPath,
} from '../resource-properties/provider.js';
import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryDocumentRegistry,
  cloneTemplateValue,
  type DocumentKindDescriptor,
} from '../documents.js';
import { InMemoryMetadataService } from '../metadata.js';
import { InMemoryRelationshipService } from '../relationships.js';
import { WorkspaceServiceImpl } from '../workspace.js';
import { createMemoryVault } from '../vault/memory.js';
import { markdownKind } from '../markdown/kind.js';
import { blockPageKind } from '../blocks/kind.js';
import {
  emptyBlockPage,
  childrenOf,
  paragraphBlock,
  resourceLinkBlock,
  type BlockPageModel,
} from '../blocks/model.js';
import { notebookKind } from '../notebooks/kind.js';
import {
  appendPage,
  emptyNotebook,
  pdfNotebookPage,
} from '../notebooks/model.js';
import {
  boundedFrame,
  emptySurface,
  groupObject,
  lineObject,
  rectangleObject,
} from '../surfaces/model.js';
import { documentKindId } from '../identity.js';
import { workspacePath } from '../paths.js';
import {
  InMemoryCompositionRegistry,
  type CompositionHandle,
} from '../composition.js';
import { databaseKind, databaseKindId } from './kind.js';
import { createDatabase, type DatabaseModel } from './model.js';
import {
  DatabaseController,
  PartialDatabaseCreationError,
  applyDatabasePropertyToDocument,
  writeDatabaseProperty,
} from './controller.js';
import { createDatabaseCompositionProvider } from './composition.js';
import {
  InMemoryDatabaseQueryProvider,
  type DatabaseQueryProvider,
} from './query.js';

async function settled(handle: CompositionHandle) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const snapshot = handle.snapshot();
    if (snapshot.state !== 'loading') return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('Composition did not settle');
}
async function fixture(
  query: DatabaseQueryProvider = new InMemoryDatabaseQueryProvider(),
) {
  const { vault } = createMemoryVault();
  const registry = new InMemoryDocumentRegistry();
  registry.register(markdownKind);
  registry.register(blockPageKind);
  registry.register(notebookKind);
  registry.register(databaseKind);
  const metadata = new InMemoryMetadataService();
  const relationships = new InMemoryRelationshipService();
  const workspace = await WorkspaceServiceImpl.create({
    vault,
    registry,
    metadata,
    relationships,
    revisions: null,
  });
  const properties = new WorkspaceResourceProperties({
    workspace,
    vault,
    metadata,
    relationships,
    revisions: null,
    catalog: new PropertyCatalog(),
  });
  workspace.registerProjection({
    project: (ref) => properties.project(ref),
    remove: (ref) => properties.remove(ref.location.resourceId),
  });
  const model = createDatabase('Projects');
  // A workflow is authored from generic primitives, never constructor policy.
  model.properties.push({
    id: 'status',
    name: 'Status',
    type: 'select',
    options: [
      { id: 'todo', name: 'To do' },
      { id: 'doing', name: 'In progress' },
      { id: 'done', name: 'Done' },
    ],
  });
  model.views.push({
    id: 'board',
    name: 'Board',
    type: 'board',
    groupBy: 'status',
  });
  model.properties.push({ id: 'due', name: 'Due', type: 'date' });
  model.templates = [
    {
      id: 'markdown',
      name: 'Note',
      kindId: markdownKind.id,
      model: { raw: '# Project' },
      defaults: { status: 'todo' },
    },
    {
      id: 'blocks',
      name: 'Page',
      kindId: blockPageKind.id,
      model: emptyBlockPage(),
      defaults: { status: 'todo' },
    },
  ];
  const database = await workspace.createDocument({
    kindId: databaseKindId,
    path: workspacePath('Projects.base'),
    initialModel: model,
  });
  const session = await workspace.openDocument<DatabaseModel>(
    database.documentId,
  );
  const controller = new DatabaseController(
    session,
    workspace,
    properties,
    query,
  );
  return {
    vault,
    registry,
    metadata,
    relationships,
    workspace,
    database,
    session,
    controller,
    properties,
  };
}

describe('database workspace acceptance', () => {
  it('lets document providers clone template identities while preserving explicit references and unknown content', async () => {
    const env = await fixture();
    try {
      const target = {
        documentId: 'external-document',
        kindId: markdownKind.id,
        resourceId: 'external-resource',
        address: 'heading:details',
      };
      const page = emptyBlockPage({ future: { retained: true } } as never);
      page.rootOrder.push('parent');
      page.blocks.parent = {
        ...paragraphBlock('parent', [{ text: 'Parent' }]),
        children: ['link'],
        'acme.payload': { retained: 1 },
      };
      page.blocks.link = resourceLinkBlock('link', target, 'External');
      await env.controller.saveTemplate({
        id: 'rich-blocks',
        name: 'Rich blocks',
        kindId: blockPageKind.id,
        model: page,
        defaults: {},
      });

      const first = await env.controller.createMember(
        'rich-blocks',
        workspacePath('Rich one.blockpage'),
      );
      const second = await env.controller.createMember(
        'rich-blocks',
        workspacePath('Rich two.blockpage'),
      );
      const firstModel = (
        await env.workspace.readDocument<BlockPageModel>(first.documentId)
      ).model;
      const secondModel = (
        await env.workspace.readDocument<BlockPageModel>(second.documentId)
      ).model;
      const firstParent = firstModel.blocks[firstModel.rootOrder[0]!]!;
      const firstLinkId = childrenOf(firstParent)[0];
      const secondParent = secondModel.blocks[secondModel.rootOrder[0]!]!;
      expect(firstModel.rootOrder[0]).not.toBe('parent');
      expect(secondModel.rootOrder[0]).not.toBe(firstModel.rootOrder[0]);
      expect(firstLinkId).not.toBe('link');
      expect(firstModel.blocks[firstLinkId!]!.target).toEqual(target);
      expect(firstParent['acme.payload']).toEqual({ retained: 1 });
      expect(firstModel.meta).toEqual({ future: { retained: true } });
      expect(childrenOf(secondParent)[0]).not.toBe(firstLinkId);
      expect(page.rootOrder).toEqual(['parent']);
      expect(page.blocks.parent!.children).toEqual(['link']);
    } finally {
      await env.properties.dispose();
      await env.workspace.dispose();
    }
  });

  it('remaps notebook page and surface identities when creating from a template', async () => {
    const env = await fixture();
    try {
      const surface = emptySurface(boundedFrame(400, 300));
      surface.order.push('shape', 'line', 'group');
      surface.objects.shape = rectangleObject('shape', {
        x: 10,
        y: 20,
        width: 80,
        height: 40,
      });
      surface.objects.line = lineObject('line', {
        x: 0,
        y: 0,
        x2: 10,
        y2: 20,
        source: { objectId: 'shape', anchor: 'center' },
      });
      surface.objects.group = groupObject('group', { children: ['shape'] });
      const notebook = emptyNotebook('Template');
      appendPage(
        notebook,
        pdfNotebookPage('page', {
          asset: {
            path: workspacePath('assets/template.pdf'),
            sha256: 'b'.repeat(64),
          },
          pageIndex: 2,
          pageBox: { widthPt: 400, heightPt: 300 },
          surface,
        }),
      );
      await env.controller.saveTemplate({
        id: 'notebook',
        name: 'Notebook',
        kindId: notebookKind.id,
        model: notebook,
        defaults: {},
      });

      const member = await env.controller.createMember(
        'notebook',
        workspacePath('Notebook.notebook'),
      );
      const cloned = (
        await env.workspace.readDocument<ReturnType<typeof emptyNotebook>>(
          member.documentId,
        )
      ).model;
      const pageId = cloned.pageOrder[0]!;
      const clonedPage = cloned.pages[pageId]!;
      expect(pageId).not.toBe('page');
      expect(clonedPage.id).toBe(pageId);
      if (clonedPage.kind !== 'page') throw new Error('Expected cloned page');
      expect(clonedPage.record.base).toMatchObject({
        asset: {
          path: 'assets/template.pdf',
          sha256: 'b'.repeat(64),
        },
        pageIndex: 2,
      });
      const [shapeId, lineId, groupId] = clonedPage.surface.order;
      expect([shapeId, lineId, groupId]).not.toContain('shape');
      expect(clonedPage.surface.objects[lineId!]!.source).toMatchObject({
        objectId: shapeId,
      });
      expect(clonedPage.surface.objects[groupId!]!.children).toEqual([shapeId]);
    } finally {
      await env.properties.dispose();
      await env.workspace.dispose();
    }
  });

  it('requires an independently registered plugin to own cloning before creating anything', async () => {
    const env = await fixture();
    const pluginKindId = documentKindId('acme.template-document');
    type PluginModel = {
      nodeId: string;
      external: { resourceId: string };
      asset: { path: string; sha256: string };
      future: Record<string, unknown>;
    };
    const codec = {
      decode: (data: Uint8Array) => ({
        model: JSON.parse(new TextDecoder().decode(data)) as PluginModel,
        metadata: {},
        relationships: [],
      }),
      encode: (model: PluginModel) =>
        new TextEncoder().encode(JSON.stringify(model)),
    };
    const unavailable: DocumentKindDescriptor<PluginModel> = {
      id: pluginKindId,
      creation: {
        label: 'Acme document',
        extension: '.acme',
        createInitialModel: () => ({
          nodeId: 'blank',
          external: { resourceId: 'outside' },
          asset: { path: 'assets/acme.bin', sha256: 'a'.repeat(64) },
          future: {},
        }),
      },
      ...codec,
    };
    const unavailableRegistration = env.registry.register(unavailable);
    const templateModel: PluginModel = {
      nodeId: 'template-node',
      external: { resourceId: 'external-resource' },
      asset: { path: 'assets/acme.bin', sha256: 'a'.repeat(64) },
      future: { retained: ['opaque', 1] },
    };
    try {
      await env.controller.saveTemplate({
        id: 'plugin',
        name: 'Plugin',
        kindId: pluginKindId,
        model: templateModel,
        defaults: {},
      });
      const count = env.workspace.listDocuments().length;
      await expect(
        env.controller.createMember('plugin', workspacePath('Unsafe.acme')),
      ).rejects.toThrow(/does not support template cloning/);
      expect(env.workspace.listDocuments()).toHaveLength(count);
      await expect(
        env.vault.stat(workspacePath('Unsafe.acme')),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      unavailableRegistration.dispose();
      const registration = env.registry.register({
        ...unavailable,
        cloneTemplate: (model, context) => ({
          ...cloneTemplateValue(model),
          nodeId: context.newInternalId(),
        }),
      });
      const member = await env.controller.createMember(
        'plugin',
        workspacePath('Supported.acme'),
      );
      const cloned = (
        await env.workspace.readDocument<PluginModel>(member.documentId)
      ).model;
      expect(cloned.nodeId).not.toBe(templateModel.nodeId);
      expect(cloned.external).toEqual(templateModel.external);
      expect(cloned.asset).toEqual(templateModel.asset);
      expect(cloned.future).toEqual(templateModel.future);
      registration.dispose();
    } finally {
      unavailableRegistration.dispose();
      await env.properties.dispose();
      await env.workspace.dispose();
    }
  });

  it('merges concurrent template default edits against the latest canonical definition', async () => {
    const env = await fixture();
    try {
      await Promise.all([
        env.controller.writeTemplateDefault('markdown', 'status', 'doing'),
        env.controller.writeTemplateDefault('markdown', 'score', 42),
      ]);
      expect(
        env.controller.model.templates.find((item) => item.id === 'markdown')
          ?.defaults,
      ).toMatchObject({ status: 'doing', score: 42 });
      await expect(
        env.controller.writeTemplateDefault('missing', 'score', 1),
      ).rejects.toThrow(/Unknown database template/);
    } finally {
      await env.properties.dispose();
      await env.workspace.dispose();
    }
  });
  it('validates template defaults through the injected catalog before creating a resource', async () => {
    const env = await fixture();
    const registration = env.properties.catalog.register({
      id: 'example.code',
      label: 'Code',
      storage: 'stored',
      editor: 'text',
      validate: (value) => (value === 'ABC' ? null : 'Expected ABC'),
    });
    try {
      await env.controller.saveProperty({
        id: 'code',
        name: 'Code',
        type: 'example.code',
      });
      const template = {
        id: 'custom',
        name: 'Custom',
        kindId: markdownKind.id,
        model: { raw: '# Custom' },
        defaults: { code: 'ABC' },
      };
      await env.controller.saveTemplate(template);
      const member = await env.controller.createMember(
        'custom',
        workspacePath('Custom.md'),
      );
      expect((await env.properties.read(member)).code).toBe('ABC');
      await env.controller.saveProperty({
        id: 'created',
        name: 'Created',
        type: 'created',
      });
      await env.controller.saveTemplate({
        ...template,
        defaults: { created: '2026-09-08' },
      });
      const count = env.workspace.listDocuments().length;
      await expect(
        env.controller.createMember('custom', workspacePath('Invalid.md')),
      ).rejects.toThrow(/derived or read-only/);
      expect(env.workspace.listDocuments()).toHaveLength(count);
      await env.controller.saveProperty({
        id: 'related',
        name: 'Related',
        type: 'relation',
        relation: { databaseId: 'missing' },
      });
      await env.controller.saveTemplate({
        ...template,
        defaults: { related: ['missing-resource'] },
      });
      await expect(
        env.controller.createMember(
          'custom',
          workspacePath('Invalid relation.md'),
        ),
      ).rejects.toThrow(/Related database unavailable/);
      expect(env.workspace.listDocuments()).toHaveLength(count);
      registration.dispose();
      await env.controller.saveTemplate(template);
      await expect(
        env.controller.createMember('custom', workspacePath('Unavailable.md')),
      ).rejects.toThrow(/provider unavailable/);
      expect(env.workspace.listDocuments()).toHaveLength(count);
    } finally {
      registration.dispose();
      await env.properties.dispose();
      await env.workspace.dispose();
    }
  });
  it('uses an asynchronous query provider through the same session path', async () => {
    const reference = new InMemoryDatabaseQueryProvider();
    const env = await fixture({
      execute: async (...args) => reference.execute(...args),
    });
    try {
      const member = await env.controller.createMember(
        'markdown',
        workspacePath('Async.md'),
      );
      await env.controller.saveMembership({
        mode: 'query',
        filters: [{ property: 'status', operator: 'eq', value: 'todo' }],
      });
      expect(
        (await env.controller.rows('table')).map((row) => row.resourceId),
      ).toEqual([member.location.resourceId]);
      await env.controller.write(member.location.resourceId, 'status', 'doing');
      expect(await env.controller.rows('table')).toEqual([]);
    } finally {
      await env.properties.dispose();
      await env.workspace.dispose();
    }
  });
  it('rejects a stale property draft without replacing a newer committed value', async () => {
    const env = await fixture();
    try {
      const member = await env.controller.createMember(
        'markdown',
        workspacePath('Concurrent.md'),
      );
      await env.controller.write(member.location.resourceId, 'status', 'doing');
      await expect(
        writeDatabaseProperty(
          env.controller.model,
          env.workspace,
          env.properties,
          env.controller.query,
          member.location.resourceId,
          'status',
          'done',
          undefined,
          'todo',
        ),
      ).rejects.toThrow('Property changed elsewhere');
      expect((await env.properties.read(member)).status).toBe('doing');
    } finally {
      await env.properties.dispose();
      await env.workspace.dispose();
    }
  });
  it('applies a known field before a document matches a smart collection', async () => {
    const env = await fixture();
    try {
      const document = await env.workspace.createDocument({
        kindId: markdownKind.id,
        path: workspacePath('Unmatched.md'),
        initialModel: { raw: '# Unmatched' },
      });
      await env.controller.saveMembership({
        mode: 'query',
        filters: [{ property: 'status', operator: 'eq', value: 'doing' }],
      });
      expect(await env.controller.rows('table')).toEqual([]);
      const input = {
        databaseId: env.database.location.resourceId,
        resourceId: document.location.resourceId,
        propertyId: 'status',
        value: 'doing',
        expectedValue: null,
        definitions: { get: () => env.controller.model },
        workspace: env.workspace,
        properties: env.properties,
        query: env.controller.query,
      } as const;
      await applyDatabasePropertyToDocument(input);
      expect(
        (await env.controller.rows('table')).map((row) => row.resourceId),
      ).toEqual([document.location.resourceId]);
      await expect(applyDatabasePropertyToDocument(input)).rejects.toThrow(
        'Property changed elsewhere',
      );
      expect((await env.properties.read(document)).status).toBe('doing');
    } finally {
      await env.properties.dispose();
      await env.workspace.dispose();
    }
  });
  it('creates ordinary documents in an empty database without installing templates', async () => {
    const env = await fixture();
    try {
      const ref = await env.workspace.createDocument({
        kindId: databaseKindId,
        path: workspacePath('Contacts.base'),
        initialModel: createDatabase('Contacts'),
      });
      const session = await env.workspace.openDocument<DatabaseModel>(
        ref.documentId,
      );
      const controller = new DatabaseController(
        session,
        env.workspace,
        env.properties,
        new InMemoryDatabaseQueryProvider(),
      );
      const member = await controller.createResource({
        kindId: blockPageKind.id,
        path: workspacePath('Ada.blockpage'),
        initialModel: emptyBlockPage({ title: 'Ada' }),
      });
      expect(controller.model.templates).toEqual([]);
      expect(controller.model.properties).toEqual([]);
      expect(
        (await controller.rows('table')).map((row) => row.resourceId),
      ).toEqual([member.location.resourceId]);
      expect((await controller.rows('table'))[0]?.title).toBe('Ada');
      await controller.saveProperty({
        id: 'created',
        name: 'Created',
        type: 'created',
      });
      await controller.saveProperty({
        id: 'updated',
        name: 'Updated',
        type: 'updated',
      });
      const before = (await controller.rows('table'))[0]!;
      expect(before.values.created).toEqual(expect.any(String));
      expect(before.values.updated).toEqual(expect.any(String));
      await expect(
        controller.write(member.location.resourceId, 'created', '2020-01-01'),
      ).rejects.toThrow(/read-only/);
      await env.workspace.rebuildDerivedState();
      expect((await controller.rows('table'))[0]?.values).toEqual(
        before.values,
      );
      expect(
        (await env.workspace.readDocument(member.documentId)).model,
      ).toEqual(emptyBlockPage({ title: 'Ada' }));
    } finally {
      await env.properties.dispose();
      await env.workspace.dispose();
    }
  });
  it('keeps a created document when membership fails and retries by resource ID', async () => {
    const env = await fixture();
    try {
      vi.spyOn(env.controller, 'addMember').mockRejectedValueOnce(
        new Error('injected save failure'),
      );
      let partial: PartialDatabaseCreationError | undefined;
      try {
        await env.controller.createResource({
          kindId: blockPageKind.id,
          path: workspacePath('Recoverable.blockpage'),
          initialModel: emptyBlockPage({ title: 'Recoverable' }),
        });
      } catch (failure) {
        if (failure instanceof PartialDatabaseCreationError) partial = failure;
        else throw failure;
      }
      expect(partial?.createdResourceId).toBeDefined();
      const created = env.workspace
        .listDocuments()
        .find((ref) => ref.location.resourceId === partial?.createdResourceId);
      expect(created).toBeDefined();
      expect(
        (await env.workspace.readDocument(created!.documentId)).model,
      ).toEqual(emptyBlockPage({ title: 'Recoverable' }));
      await env.controller.addMember(partial!.createdResourceId);
      expect(
        env.controller.model.membership.mode === 'explicit' &&
          env.controller.model.membership.resourceIds,
      ).toContain(partial!.createdResourceId);
      expect(
        env.workspace
          .listDocuments()
          .filter(
            (ref) => ref.location.resourceId === partial!.createdResourceId,
          ),
      ).toHaveLength(1);
    } finally {
      await env.properties.dispose();
      await env.workspace.dispose();
    }
  });
  it('retries only untouched template defaults after a partial write', async () => {
    const env = await fixture();
    try {
      await env.controller.writeTemplateDefault(
        'markdown',
        'due',
        '2026-09-23',
      );
      const update = env.properties.update.bind(env.properties);
      let failDue = true;
      vi.spyOn(env.properties, 'update').mockImplementation(async (...args) => {
        if (args[1].id === 'due' && failDue) {
          failDue = false;
          throw new Error('injected default failure');
        }
        return update(...args);
      });
      let partial: PartialDatabaseCreationError | undefined;
      try {
        await env.controller.createMember(
          'markdown',
          workspacePath('Retry.md'),
        );
      } catch (failure) {
        if (failure instanceof PartialDatabaseCreationError) partial = failure;
        else throw failure;
      }
      expect(partial?.membershipSaved).toBe(true);
      const id = partial!.createdResourceId;
      await env.controller.write(id, 'status', 'doing');
      await env.controller.applyTemplateDefaults('markdown', id);
      const ref = env.workspace
        .listDocuments()
        .find((item) => item.location.resourceId === id);
      expect(await env.properties.read(ref!)).toMatchObject({
        status: 'doing',
        due: '2026-09-23',
      });
      expect(
        env.workspace
          .listDocuments()
          .filter((item) => item.location.resourceId === id),
      ).toHaveLength(1);
    } finally {
      await env.properties.dispose();
      await env.workspace.dispose();
    }
  });
  it('keeps a final saved view and applies queued view patches to current state', async () => {
    const env = await fixture();
    try {
      await Promise.all([
        env.controller.patchView('board', { name: 'By status' }),
        env.controller.patchView('board', { groupBy: 'due' }),
        env.controller.setColumnWidth('board', '$title', 240),
        env.controller.setColumnWidth('board', 'status', 216),
      ]);
      expect(
        env.controller.model.views.find((view) => view.id === 'board'),
      ).toMatchObject({
        name: 'By status',
        groupBy: 'due',
        columnWidths: { $title: 240, status: 216 },
      });
      const duplicateId = await env.controller.duplicateView('board');
      expect(duplicateId).not.toBe('board');
      expect(
        env.controller.model.views.find((view) => view.id === duplicateId),
      ).toMatchObject({
        name: 'By status copy',
        groupBy: 'due',
        columnWidths: { $title: 240, status: 216 },
      });
      await env.controller.deleteView('table');
      await env.controller.deleteView(duplicateId);
      await expect(env.controller.deleteView('board')).rejects.toThrow(
        'Keep at least one',
      );
      expect(env.controller.model.views.map((view) => view.id)).toEqual([
        'board',
      ]);
    } finally {
      await env.properties.dispose();
      await env.workspace.dispose();
    }
  });
  it('removes membership without deleting shared document content or another membership', async () => {
    const env = await fixture();
    try {
      const member = await env.controller.createMember(
        'blocks',
        workspacePath('Shared.blockpage'),
      );
      const other = await env.workspace.createDocument({
        kindId: databaseKindId,
        path: workspacePath('Other.base'),
        initialModel: createDatabase('Other'),
      });
      const otherSession = await env.workspace.openDocument<DatabaseModel>(
        other.documentId,
      );
      const otherController = new DatabaseController(
        otherSession,
        env.workspace,
        env.properties,
        new InMemoryDatabaseQueryProvider(),
      );
      await otherController.addMember(member.location.resourceId);
      await env.controller.removeMember(member.location.resourceId);
      expect(
        (await env.controller.rows('table')).map((row) => row.resourceId),
      ).not.toContain(member.location.resourceId);
      expect(
        (await otherController.rows('table')).map((row) => row.resourceId),
      ).toContain(member.location.resourceId);
      expect(
        (await env.workspace.readDocument(member.documentId)).model,
      ).toEqual(emptyBlockPage());
    } finally {
      await env.properties.dispose();
      await env.workspace.dispose();
    }
  });
  it('creates independently openable members, shares views and survives rename, rebuild and offline reopen', async () => {
    const env = await fixture();
    const first = await env.controller.createMember(
      'markdown',
      workspacePath('Project.md'),
    );
    const second = await env.controller.createMember(
      'blocks',
      workspacePath('Plan.blockpage'),
    );
    expect((await env.workspace.readDocument(first.documentId)).model).toEqual({
      raw: '# Project',
    });
    expect(
      (await env.workspace.readDocument(second.documentId)).ref.kindId,
    ).toBe(blockPageKind.id);
    await env.controller.write(first.location.resourceId, 'status', 'doing');
    await env.controller.write(first.location.resourceId, 'due', '2026-09-09');
    await env.controller.saveView({
      id: 'calendar',
      name: 'Schedule',
      type: 'calendar',
      dateProperty: 'due',
    });
    const table = await env.controller.rows('table');
    expect(
      (await env.controller.rows('board')).map((row) => row.values),
    ).toEqual(table.map((row) => row.values));
    expect((await env.controller.rows('calendar'))[0]?.values.due).toBe(
      '2026-09-09',
    );
    await env.workspace.moveDocument(
      first.documentId,
      workspacePath('Renamed.md'),
    );
    const canonical = await env.vault.read(workspacePath('Projects.base'));
    await env.workspace.rebuildDerivedState();
    expect((await env.controller.rows('table'))[0]?.resourceId).toBe(
      first.location.resourceId,
    );
    expect(env.metadata.get(first.documentId).properties?.status).toBe('doing');
    const alternate = new DatabaseController(
      env.session,
      env.workspace,
      env.properties,
      {
        execute: (...args) =>
          new InMemoryDatabaseQueryProvider().execute(...args),
      },
    );
    expect(await alternate.rows('table')).toEqual(
      await env.controller.rows('table'),
    );
    expect(await env.vault.read(workspacePath('Projects.base'))).toEqual(
      canonical,
    );
    await env.workspace.dispose();
    const workspace = await WorkspaceServiceImpl.create({
      ...env,
      revisions: null,
    });
    const properties = new WorkspaceResourceProperties({
      ...env,
      workspace,
      revisions: null,
      catalog: new PropertyCatalog(),
    });
    workspace.registerProjection({ project: (ref) => properties.project(ref) });
    await properties.rebuild();
    const session = await workspace.openDocument<DatabaseModel>(
      env.database.documentId,
    );
    expect(
      (
        await new DatabaseController(
          session,
          workspace,
          properties,
          new InMemoryDatabaseQueryProvider(),
        ).rows('table')
      ).map((row) => row.values),
    ).toEqual(table.map((row) => row.values));
    await workspace.dispose();
  });
  it('writes linked table/board properties through the source and preserves a missing saved view', async () => {
    const env = await fixture();
    const member = await env.controller.createMember(
      'blocks',
      workspacePath('Plan.blockpage'),
    );
    const memberSession = await env.workspace.openDocument(member.documentId);
    const host = await env.workspace.createDocument({
      kindId: blockPageKind.id,
      path: workspacePath('Dashboard.blockpage'),
      initialModel: emptyBlockPage(),
    });
    const hostBytes = await env.vault.read(
      workspacePath('Dashboard.blockpage'),
    );
    const canonicalReads = vi.spyOn(env.workspace, 'readDocument');
    const compositions = new InMemoryCompositionRegistry();
    const registration = compositions.register(
      createDatabaseCompositionProvider({
        definitions: {
          get: (id) =>
            id === env.database.location.resourceId
              ? env.session.model
              : undefined,
        },
        workspace: () => env.workspace,
        properties: () => env.properties,
        query: () => new InMemoryDatabaseQueryProvider(),
        openSource: () => undefined,
      }),
    );
    const input = {
      role: 'linked-view' as const,
      target: {
        documentId: env.database.documentId,
        kindId: databaseKindId,
        resourceId: env.database.location.resourceId,
      },
      viewId: 'board',
      overrides: {
        filters: [{ property: 'status', operator: 'eq', value: 'todo' }],
      },
    };
    const handle = compositions.open(input);
    expect((await settled(handle)).state).toBe('ready');
    await env.controller.saveProperty({
      id: 'rating',
      name: 'Rating',
      type: 'example.rating',
    });
    const ratingType = {
      id: 'example.rating',
      label: 'Rating',
      storage: 'stored' as const,
      editor: 'number' as const,
      validate: (value: unknown) =>
        typeof value === 'number' && Number.isFinite(value)
          ? null
          : 'Expected number',
    };
    const provider = env.properties.catalog.register(ratingType);
    await env.controller.write(member.location.resourceId, 'rating', 4);
    const editor = () => {
      const snapshot = handle.snapshot();
      if (snapshot.state !== 'ready') return undefined;
      const entries = snapshot.presentation?.data.propertyEditors as
        | Record<string, { editor: string }>
        | undefined;
      return entries?.rating?.editor;
    };
    await vi.waitFor(() => expect(editor()).toBe('number'));
    provider.dispose();
    await vi.waitFor(() => expect(editor()).toBeUndefined());
    expect((await env.properties.read(member)).rating).toBe(4);
    const restored = env.properties.catalog.register(ratingType);
    await vi.waitFor(() => expect(editor()).toBe('number'));
    restored.dispose();
    const sourceView = JSON.stringify(env.session.model.views);
    await handle.invoke?.('write-property', {
      resourceId: member.location.resourceId,
      propertyId: 'status',
      value: 'doing',
      expectedValue: 'todo',
    });
    await expect(
      handle.invoke?.('write-property', {
        resourceId: member.location.resourceId,
        propertyId: 'status',
        value: 'todo',
        expectedValue: 'todo',
      }),
    ).rejects.toThrow('changed elsewhere');
    const snapshot = handle.snapshot();
    expect(
      snapshot.state === 'ready' &&
        Array.isArray(snapshot.presentation?.data.rows) &&
        snapshot.presentation.data.rows.length,
    ).toBe(0);
    expect(memberSession.state).toBe('open');
    expect(env.session.state).toBe('open');
    expect(JSON.stringify(env.session.model.views)).toBe(sourceView);
    expect(canonicalReads).not.toHaveBeenCalled();
    expect(await env.vault.read(workspacePath('Dashboard.blockpage'))).toEqual(
      hostBytes,
    );
    expect((await env.workspace.readDocument(host.documentId)).ref).toEqual(
      host,
    );
    await env.controller.deleteView('board');
    await expect(
      handle.invoke?.('write-property', {
        resourceId: member.location.resourceId,
        propertyId: 'status',
        value: 'todo',
      }),
    ).rejects.toThrow('Saved view unavailable');
    const missing = compositions.open(input);
    expect(await settled(missing)).toMatchObject({
      state: 'placeholder',
      reason: 'missing-view',
    });
    handle.dispose();
    missing.dispose();
    registration.dispose();
    expect(compositions.open(input).snapshot()).toMatchObject({
      state: 'placeholder',
      reason: 'missing-provider',
    });
    await env.workspace.dispose();
  });
  it('renders a database resource embed as a read-only preview of its first view', async () => {
    const env = await fixture();
    const compositions = new InMemoryCompositionRegistry();
    const registration = compositions.register(
      createDatabaseCompositionProvider({
        role: 'preview',
        definitions: {
          get: (id) => id === env.database.location.resourceId ? env.session.model : undefined,
        },
        workspace: () => env.workspace,
        properties: () => env.properties,
        query: () => new InMemoryDatabaseQueryProvider(),
        openSource: () => undefined,
      }),
    );
    const handle = compositions.open({
      role: 'preview',
      target: {
        documentId: env.database.documentId,
        kindId: databaseKindId,
        resourceId: env.database.location.resourceId,
      },
    });
    const snapshot = await settled(handle);
    expect(snapshot.state).toBe('ready');
    expect(snapshot.presentation?.data.previewOnly).toBe(true);
    expect(snapshot.presentation?.data.viewId).toBe(env.session.model.views[0]?.id);
    expect(snapshot.actions?.some((action) => action.id === 'write-property')).toBe(false);
    handle.dispose();
    registration.dispose();
    await env.workspace.dispose();
  });
  it('removes a definition without erasing stored values and restores it with undo', async () => {
    const env = await fixture();
    const note = await env.workspace.createDocument({
      kindId: markdownKind.id,
      path: workspacePath('Retained.md'),
      initialModel: { raw: '# Retained\n' },
    });
    await env.controller.saveProperty({
      id: 'retained',
      name: 'Retained',
      type: 'text',
    });
    await env.controller.addMember(note.location.resourceId);
    await env.controller.write(
      note.location.resourceId,
      'retained',
      'canonical value',
    );
    const sidecar = await env.vault.read(
      resourcePropertyPath(note.location.resourceId),
    );
    const undo = await env.controller.removePropertyWithUndo('retained');
    expect(
      env.controller.model.properties.some((item) => item.id === 'retained'),
    ).toBe(false);
    expect(
      await env.vault.read(resourcePropertyPath(note.location.resourceId)),
    ).toEqual(sidecar);
    expect((await env.properties.read(note)).retained).toBe('canonical value');
    await undo.undo();
    expect(
      env.controller.model.properties.some((item) => item.id === 'retained'),
    ).toBe(true);
    expect(
      (await env.controller.rows('table')).find(
        (row) => row.resourceId === note.location.resourceId,
      )?.values.retained,
    ).toBe('canonical value');
    await env.workspace.dispose();
  });
});
