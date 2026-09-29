import { expect, it } from 'vitest';
import { Runtime, definePlugin } from '@froglight/runtime';
import { InMemoryDocumentRegistry } from '../documents.js';
import { InMemoryMetadataService } from '../metadata.js';
import { InMemoryRelationshipService } from '../relationships.js';
import { createMemoryVault } from '../vault/memory.js';
import { WorkspaceServiceImpl } from '../workspace.js';
import { workspaceToken } from '../tokens.js';
import { workspacePath } from '../paths.js';
import { databaseKind } from './kind.js';
import { createDatabase, type DatabaseModel } from './model.js';
import {
  databaseDefinitionsPlugin,
  databaseDefinitionsToken,
  type DatabaseDefinitions,
} from './definitions.js';

it('rebuilds definitions from canonical files and owns its projection through replacement', async () => {
  const { vault } = createMemoryVault();
  const registry = new InMemoryDocumentRegistry();
  registry.register(databaseKind);
  const workspace = await WorkspaceServiceImpl.create({
    vault,
    registry,
    metadata: new InMemoryMetadataService(),
    relationships: new InMemoryRelationshipService(),
    revisions: null,
  });
  const ref = await workspace.createDocument({
    kindId: databaseKind.id,
    path: workspacePath('Contacts.base'),
    initialModel: createDatabase('Contacts'),
  });
  const runtime = new Runtime();
  let current: DatabaseDefinitions | undefined;
  try {
    await runtime.registerSlot({
      id: 'workspace',
      plugin: definePlugin({
        id: 'test.workspace',
        activate(ctx) {
          ctx.provide(workspaceToken, workspace);
        },
      }),
    });
    await runtime.registerSlot({
      id: 'definitions',
      plugin: databaseDefinitionsPlugin,
    });
    await runtime.registerSlot({
      id: 'consumer',
      plugin: definePlugin({
        id: 'test.consumer',
        requirements: { requires: [databaseDefinitionsToken] },
        activate(ctx) {
          current = ctx.require(databaseDefinitionsToken);
          return () => {
            current = undefined;
          };
        },
      }),
    });
    const first = current!;
    expect(first.get(ref.location.resourceId)?.title).toBe('Contacts');
    const session = await workspace.openDocument<DatabaseModel>(ref.documentId);
    session.model.title = 'People';
    session.markDirty();
    expect((await session.save()).committed).toBe(true);
    expect(first.get(ref.location.resourceId)?.title).toBe('People');
    await runtime.removeSlot('definitions');
    expect(current).toBeUndefined();
    expect(first.get(ref.location.resourceId)).toBeUndefined();
    await runtime.registerSlot({
      id: 'definitions',
      plugin: databaseDefinitionsPlugin,
    });
    expect(current).not.toBe(first);
    expect(current!.get(ref.location.resourceId)?.title).toBe('People');
    await workspace.removeDocument(ref.documentId);
    expect(current!.get(ref.location.resourceId)).toBeUndefined();
  } finally {
    await runtime.dispose();
    await workspace.dispose();
  }
});
