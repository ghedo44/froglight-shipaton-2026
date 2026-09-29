import { describe, expect, it } from 'vitest';
import { InMemoryDocumentRegistry } from '../documents.js';
import { markdownKind } from '../markdown/kind.js';
import { InMemoryMetadataService } from '../metadata.js';
import { workspacePath } from '../paths.js';
import { PropertyCatalog } from '../resource-properties/catalog.js';
import { WorkspaceResourceProperties } from '../resource-properties/provider.js';
import { InMemoryRelationshipService } from '../relationships.js';
import { createMemoryVault } from '../vault/memory.js';
import { WorkspaceServiceImpl } from '../workspace.js';
import { DatabaseController } from './controller.js';
import { databaseKind, databaseKindId } from './kind.js';
import { createDatabase, type DatabaseModel } from './model.js';
import { InMemoryDatabaseQueryProvider } from './query.js';
import { DatabaseUndoConflictError, databaseUndoOperation } from './undo.js';

async function fixture() {
  const { vault } = createMemoryVault();
  const registry = new InMemoryDocumentRegistry();
  registry.register(markdownKind);
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
  const member = await workspace.createDocument({
    kindId: markdownKind.id,
    path: workspacePath('member.md'),
    initialModel: { raw: '# Member' },
  });
  const model = createDatabase('Projects');
  model.properties.push({ id: 'status', name: 'Status', type: 'text' });
  model.membership = {
    mode: 'explicit',
    resourceIds: [member.location.resourceId],
  };
  const database = await workspace.createDocument({
    kindId: databaseKindId,
    path: workspacePath('projects.base'),
    initialModel: model,
  });
  const session = await workspace.openDocument<DatabaseModel>(
    database.documentId,
  );
  const controller = new DatabaseController(
    session,
    workspace,
    properties,
    new InMemoryDatabaseQueryProvider(),
  );
  return { workspace, properties, session, controller, member };
}

describe('database logical undo', () => {
  it('rejects a second undo while the one-shot inverse is still pending', async () => {
    let release: () => void = () => undefined;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation = databaseUndoOperation('Pending edit', () => waiting);

    const first = operation.undo();
    await expect(operation.undo()).rejects.toThrow(/already undone/);
    release();
    await first;
  });

  it('undoes a first property write by restoring the absent value', async () => {
    const env = await fixture();
    try {
      const operation = await env.controller.writeWithUndo(
        env.member.location.resourceId,
        'status',
        'Doing',
      );
      expect(await env.properties.read(env.member)).toEqual({
        status: 'Doing',
      });

      await operation.undo();

      expect(await env.properties.read(env.member)).toEqual({});
      await expect(operation.undo()).rejects.toThrow(/already undone/);
    } finally {
      await env.session.close();
      await env.properties.dispose();
      await env.workspace.dispose();
    }
  });

  it('rejects stale property undo without erasing the later value', async () => {
    const env = await fixture();
    try {
      await env.controller.write(
        env.member.location.resourceId,
        'status',
        'To do',
      );
      const operation = await env.controller.writeWithUndo(
        env.member.location.resourceId,
        'status',
        'Doing',
      );
      await env.controller.write(
        env.member.location.resourceId,
        'status',
        'Done',
      );

      await expect(operation.undo()).rejects.toBeInstanceOf(
        DatabaseUndoConflictError,
      );
      expect(await env.properties.read(env.member)).toEqual({ status: 'Done' });
    } finally {
      await env.session.close();
      await env.properties.dispose();
      await env.workspace.dispose();
    }
  });

  it('rejects a stale expected value before creating an undo operation', async () => {
    const env = await fixture();
    try {
      await env.controller.write(
        env.member.location.resourceId,
        'status',
        'Done',
      );

      await expect(
        env.controller.writeWithUndo(
          env.member.location.resourceId,
          'status',
          'Doing',
          'To do',
        ),
      ).rejects.toThrow('Property changed elsewhere');
      expect(await env.properties.read(env.member)).toEqual({ status: 'Done' });
    } finally {
      await env.session.close();
      await env.properties.dispose();
      await env.workspace.dispose();
    }
  });

  it('undoes exact membership changes and rejects a stale membership snapshot', async () => {
    const env = await fixture();
    try {
      const removed = await env.controller.removeMemberWithUndo(
        env.member.location.resourceId,
      );
      expect(env.controller.model.membership).toEqual({
        mode: 'explicit',
        resourceIds: [],
      });
      await removed.undo();
      expect(env.controller.model.membership).toEqual({
        mode: 'explicit',
        resourceIds: [env.member.location.resourceId],
      });

      const second = await env.workspace.createDocument({
        kindId: markdownKind.id,
        path: workspacePath('second.md'),
        initialModel: { raw: '# Second' },
      });
      const added = await env.controller.addMemberWithUndo(
        second.location.resourceId,
      );
      await env.controller.removeMember(env.member.location.resourceId);

      await expect(added.undo()).rejects.toBeInstanceOf(
        DatabaseUndoConflictError,
      );
      expect(env.controller.model.membership).toEqual({
        mode: 'explicit',
        resourceIds: [second.location.resourceId],
      });
    } finally {
      await env.session.close();
      await env.properties.dispose();
      await env.workspace.dispose();
    }
  });

  it('undoes a membership mode edit only while its saved definition is current', async () => {
    const env = await fixture();
    try {
      const operation = await env.controller.saveMembershipWithUndo({
        mode: 'query',
        filters: [],
      });
      expect(env.controller.model.membership).toEqual({
        mode: 'query',
        filters: [],
      });

      await operation.undo();

      expect(env.controller.model.membership).toEqual({
        mode: 'explicit',
        resourceIds: [env.member.location.resourceId],
      });
    } finally {
      await env.session.close();
      await env.properties.dispose();
      await env.workspace.dispose();
    }
  });

  it('undoes a saved view edit unless a later edit changed that view', async () => {
    const env = await fixture();
    try {
      const viewId = env.controller.model.views[0]!.id;
      const originalName = env.controller.model.views[0]!.name;
      const operation = await env.controller.patchViewWithUndo(viewId, {
        name: 'My view',
      });
      expect(env.controller.model.views[0]!.name).toBe('My view');
      await operation.undo();
      expect(env.controller.model.views[0]!.name).toBe(originalName);

      const stale = await env.controller.patchViewWithUndo(viewId, {
        name: 'Draft',
      });
      await env.controller.patchView(viewId, { name: 'Newer' });
      await expect(stale.undo()).rejects.toBeInstanceOf(
        DatabaseUndoConflictError,
      );
      expect(env.controller.model.views[0]!.name).toBe('Newer');
    } finally {
      await env.session.close();
      await env.properties.dispose();
      await env.workspace.dispose();
    }
  });

  it('undoes a column resize while preserving an unrelated view edit', async () => {
    const env = await fixture();
    try {
      const viewId = env.controller.model.views[0]!.id;
      const operation = await env.controller.setColumnWidthWithUndo(
        viewId,
        'status',
        240,
      );
      await env.controller.patchView(viewId, { name: 'Renamed' });
      await operation.undo();
      expect(env.controller.model.views[0]!.name).toBe('Renamed');
      expect(env.controller.model.views[0]!.columnWidths).toEqual({});
    } finally {
      await env.session.close();
      await env.properties.dispose();
      await env.workspace.dispose();
    }
  });

  it('undoes shared property presentation and rejects a later arrangement', async () => {
    const env = await fixture();
    try {
      const operation = await env.controller.patchPropertyPresentationWithUndo({
        order: ['status'],
      });
      expect(env.controller.model.propertyPresentation?.order).toEqual([
        'status',
      ]);
      await operation.undo();
      expect(env.controller.model.propertyPresentation).toEqual({});

      const stale = await env.controller.patchPropertyPresentationWithUndo({
        hideWhenEmpty: ['status'],
      });
      await env.controller.patchPropertyPresentationWithUndo({
        sections: [{ name: 'Work', propertyIds: ['status'] }],
      });
      await expect(stale.undo()).rejects.toBeInstanceOf(
        DatabaseUndoConflictError,
      );
    } finally {
      await env.session.close();
      await env.properties.dispose();
      await env.workspace.dispose();
    }
  });

  it('undoes a property definition without purging its stored values', async () => {
    const env = await fixture();
    try {
      await env.controller.write(
        env.member.location.resourceId,
        'status',
        'To do',
      );
      const operation = await env.controller.savePropertyWithUndo({
        id: 'status',
        name: 'Workflow',
        type: 'text',
      });

      await operation.undo();

      expect(env.controller.model.properties[0]?.name).toBe('Status');
      expect(await env.properties.read(env.member)).toEqual({
        status: 'To do',
      });
    } finally {
      await env.session.close();
      await env.properties.dispose();
      await env.workspace.dispose();
    }
  });
});
