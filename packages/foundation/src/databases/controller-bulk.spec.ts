import { describe, expect, it, vi } from 'vitest';
import { InMemoryDocumentRegistry } from '../documents.js';
import { InMemoryMetadataService } from '../metadata.js';
import { InMemoryRelationshipService } from '../relationships.js';
import { markdownKind } from '../markdown/kind.js';
import { workspacePath } from '../paths.js';
import { PropertyCatalog } from '../resource-properties/catalog.js';
import { WorkspaceResourceProperties } from '../resource-properties/provider.js';
import { createMemoryVault } from '../vault/memory.js';
import { WorkspaceServiceImpl } from '../workspace.js';
import { DatabaseController } from './controller.js';
import { databaseKind, databaseKindId } from './kind.js';
import { createDatabase, type DatabaseModel } from './model.js';
import { InMemoryDatabaseQueryProvider } from './query.js';
import { DatabaseUndoConflictError } from './undo.js';

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
  const model = createDatabase('Bulk edits');
  model.properties.push({
    id: 'status',
    name: 'Status',
    type: 'select',
    options: [
      { id: 'todo', name: 'To do' },
      { id: 'doing', name: 'Doing' },
      { id: 'done', name: 'Done' },
    ],
  });
  const database = await workspace.createDocument({
    kindId: databaseKindId,
    path: workspacePath('Bulk.base'),
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
  const members = await Promise.all(
    ['Alpha', 'Beta', 'Gamma'].map((name) =>
      workspace.createDocument({
        kindId: markdownKind.id,
        path: workspacePath(`${name}.md`),
        initialModel: { raw: `# ${name}` },
      }),
    ),
  );
  const [alpha, beta, gamma] = members;
  if (!alpha || !beta || !gamma) throw new Error('Fixture members unavailable');
  const fixtureMembers = [alpha, beta, gamma] as const;
  for (const member of fixtureMembers)
    await controller.addMember(member.location.resourceId);
  return {
    workspace,
    properties,
    session,
    controller,
    members: fixtureMembers,
  };
}

const absent = { present: false, value: null } as const;

describe('database bulk property authority', () => {
  it('reports partial commits and retries only targets that remain failed', async () => {
    const env = await fixture();
    try {
      const beta = env.members[1].location.resourceId;
      const attempts = new Map<string, number>();
      const update = env.properties.update.bind(env.properties);
      vi.spyOn(env.properties, 'update').mockImplementation(
        async (ref, property, change) => {
          const id = ref.location.resourceId;
          attempts.set(id, (attempts.get(id) ?? 0) + 1);
          if (id === beta && attempts.get(id) === 1)
            throw new Error('injected storage failure');
          return update(ref, property, change);
        },
      );

      const first = await env.controller.bulkWriteWithUndo(
        'status',
        'doing',
        env.members.map((member) => ({
          resourceId: member.location.resourceId,
          expected: absent,
        })),
      );
      expect(first.committed.map((item) => item.resourceId)).toEqual([
        env.members[0].location.resourceId,
        env.members[2].location.resourceId,
      ]);
      expect(first.failed).toMatchObject([
        { resourceId: beta, error: new Error('injected storage failure') },
      ]);

      const retried = await first.retry();
      expect(retried.committed.map((item) => item.resourceId)).toEqual(
        env.members.map((member) => member.location.resourceId),
      );
      expect(retried.failed).toEqual([]);
      expect(
        env.members.map(
          (member) => attempts.get(member.location.resourceId) ?? 0,
        ),
      ).toEqual([1, 2, 1]);
      for (const member of env.members)
        expect((await env.properties.read(member)).status).toBe('doing');

      const undone = await retried.undo.undo();
      expect(undone.failed).toEqual([]);
      expect(undone.reverted.map((item) => item.resourceId)).toEqual(
        env.members.map((member) => member.location.resourceId),
      );
      for (const member of env.members)
        expect((await env.properties.read(member)).status).toBeUndefined();
    } finally {
      await env.session.close();
      await env.properties.dispose();
      await env.workspace.dispose();
    }
  });

  it('undoes unchanged commits, reports later edits as conflicts, and retries only remaining undos', async () => {
    const env = await fixture();
    try {
      const [alpha, beta] = env.members;
      const edit = await env.controller.bulkWriteWithUndo('status', 'doing', [
        { resourceId: alpha.location.resourceId, expected: absent },
        { resourceId: beta.location.resourceId, expected: absent },
      ]);
      await env.controller.write(beta.location.resourceId, 'status', 'done');

      const firstUndo = await edit.undo.undo();
      expect(firstUndo.reverted).toEqual([
        { resourceId: alpha.location.resourceId },
      ]);
      expect(firstUndo.failed).toHaveLength(1);
      expect(firstUndo.failed[0]).toMatchObject({
        resourceId: beta.location.resourceId,
      });
      expect(firstUndo.failed[0]?.error).toBeInstanceOf(
        DatabaseUndoConflictError,
      );
      expect((await env.properties.read(alpha)).status).toBeUndefined();
      expect((await env.properties.read(beta)).status).toBe('done');

      await env.controller.write(beta.location.resourceId, 'status', 'doing');
      const retried = await firstUndo.retry();
      expect(retried.failed).toEqual([]);
      expect(retried.reverted).toEqual([
        { resourceId: alpha.location.resourceId },
        { resourceId: beta.location.resourceId },
      ]);
      expect((await env.properties.read(beta)).status).toBeUndefined();
    } finally {
      await env.session.close();
      await env.properties.dispose();
      await env.workspace.dispose();
    }
  });

  it('preserves the original compare-and-apply expectation across retries', async () => {
    const env = await fixture();
    try {
      const [alpha, beta] = env.members;
      await env.controller.write(beta.location.resourceId, 'status', 'todo');
      const first = await env.controller.bulkWriteWithUndo('status', 'doing', [
        { resourceId: alpha.location.resourceId, expected: absent },
        { resourceId: beta.location.resourceId, expected: absent },
      ]);
      expect(first.committed).toEqual([
        { resourceId: alpha.location.resourceId },
      ]);
      expect(first.failed).toHaveLength(1);

      const retried = await first.retry();
      expect(retried.committed).toEqual(first.committed);
      expect(retried.failed).toHaveLength(1);
      expect((await env.properties.read(beta)).status).toBe('todo');
    } finally {
      await env.session.close();
      await env.properties.dispose();
      await env.workspace.dispose();
    }
  });

  it('rejects invalid values and duplicate targets before the first write', async () => {
    const env = await fixture();
    try {
      const resourceId = env.members[0].location.resourceId;
      const update = vi.spyOn(env.properties, 'update');
      await expect(
        env.controller.bulkWriteWithUndo('status', 'missing-option', [
          { resourceId, expected: absent },
        ]),
      ).rejects.toThrow(/Unknown option/);
      await expect(
        env.controller.bulkWriteWithUndo('status', 'doing', [
          { resourceId, expected: absent },
          { resourceId, expected: absent },
        ]),
      ).rejects.toThrow(/Duplicate bulk target/);
      expect(update).not.toHaveBeenCalled();
    } finally {
      await env.session.close();
      await env.properties.dispose();
      await env.workspace.dispose();
    }
  });
});
