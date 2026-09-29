// @vitest-environment jsdom
import { act } from 'react';
import { expect, it } from 'vitest';
import { Runtime, definePlugin } from '@froglight/runtime';
import {
  createMemoryVault,
  InMemoryDocumentRegistry,
  InMemoryMetadataService,
  InMemoryRelationshipService,
  InMemoryDocumentEditorRegistry,
  WorkspaceServiceImpl,
  WorkspaceResourceProperties,
  PropertyCatalog,
  InMemoryDatabaseQueryProvider,
  databaseKind,
  documentKindId,
  createDatabase,
  workspacePath,
  workspaceToken,
  resourcePropertiesToken,
  databaseQueryToken,
  documentEditorRegistryToken,
  documentRegistryToken,
  databaseDefinitionsToken,
  relationshipsToken,
} from '@froglight/foundation';
import { createDatabaseEditorPlugin } from './DatabaseView.js';

it('withdraws mounted database consumers and reactivates after query replacement', async () => {
  const { vault } = createMemoryVault();
  const kinds = new InMemoryDocumentRegistry();
  kinds.register(databaseKind);
  const metadata = new InMemoryMetadataService();
  const relationships = new InMemoryRelationshipService();
  const workspace = await WorkspaceServiceImpl.create({
    vault,
    registry: kinds,
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
  const editors = new InMemoryDocumentEditorRegistry();
  const runtime = new Runtime();
  const parent = document.createElement('div');
  document.body.append(parent);
  try {
    await runtime.registerSlot({
      id: 'services',
      plugin: definePlugin({
        id: 'test.services',
        activate(ctx) {
          ctx.provide(workspaceToken, workspace);
          ctx.provide(resourcePropertiesToken, properties);
          ctx.provide(documentEditorRegistryToken, editors);
          ctx.provide(documentRegistryToken, kinds);
          ctx.provide(databaseDefinitionsToken, { get: () => undefined });
          ctx.provide(relationshipsToken, relationships);
        },
      }),
    });
    const query = definePlugin({
      id: 'test.query',
      activate(ctx) {
        ctx.provide(databaseQueryToken, new InMemoryDatabaseQueryProvider());
      },
    });
    await runtime.registerSlot({ id: 'query', plugin: query });
    await runtime.registerSlot({
      id: 'editor',
      plugin: createDatabaseEditorPlugin(() => undefined),
    });
    expect(editors.list()).toHaveLength(1);
    const ref = await workspace.createDocument({
      kindId: databaseKind.id,
      path: workspacePath('Records.base'),
      initialModel: createDatabase('Records'),
    });
    const session = await workspace.openDocument(ref.documentId);
    const handle = editors
      .get(databaseKind.id)!
      .createEditor({ session, parent });
    expect(parent.querySelector('h1')?.textContent).toBe('Records');
    await act(async () => undefined);
    expect(parent.querySelector('[aria-label="Filter"]')).not.toBeNull();
    expect(parent.querySelector('[aria-label="Sort"]')).not.toBeNull();
    await act(async () => {
      parent
        .querySelector<HTMLElement>('[aria-label="More database actions"]')
        ?.click();
    });
    expect(parent.querySelector('details[open]')?.textContent).toContain(
      'Add existing document',
    );
    expect(parent.querySelector('details[open]')?.textContent).toContain(
      'View settings',
    );
    await act(async () => {
      parent
        .querySelector<HTMLElement>('[aria-label="More database actions"]')
        ?.click();
    });
    let pluginKind: { dispose(): void } | undefined;
    await act(async () => {
      pluginKind = kinds.register({
        ...databaseKind,
        id: documentKindId('test.plugin-page'),
        creation: {
          label: 'Plugin page',
          extension: '.plugin',
          createInitialModel: createDatabase,
        },
      });
    });
    await act(async () => {
      [...parent.querySelectorAll('button')]
        .find((button) => button.textContent === 'New item')
        ?.click();
    });
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'Plugin page',
    );
    await act(async () => {
      [
        ...document.querySelectorAll<HTMLButtonElement>(
          '[role="dialog"] button',
        ),
      ]
        .find((button) => button.textContent === 'Cancel')
        ?.click();
    });
    await act(async () => {
      pluginKind?.dispose();
    });
    await act(async () => {
      [...parent.querySelectorAll('button')]
        .find((button) => button.textContent === 'New item')
        ?.click();
    });
    expect(
      document.querySelector('[role="dialog"]')?.textContent,
    ).not.toContain('Plugin page');
    await act(async () => {
      [
        ...document.querySelectorAll<HTMLButtonElement>(
          '[role="dialog"] button',
        ),
      ]
        .find((button) => button.textContent === 'Cancel')
        ?.click();
    });
    await act(async () => {
      handle.setReadOnly?.(true);
    });
    expect(
      [...parent.querySelectorAll('button')].some(
        (button) => button.textContent === 'Add existing document',
      ),
    ).toBe(false);
    await act(async () => {
      await runtime.removeSlot('query');
    });
    expect(editors.list()).toHaveLength(0);
    expect(parent.childElementCount).toBe(0);
    await runtime.registerSlot({ id: 'query', plugin: query });
    expect(editors.list()).toHaveLength(1);
    const replacement = editors
      .get(databaseKind.id)!
      .createEditor({ session, parent });
    handle.destroy();
    expect(parent.querySelector('h1')?.textContent).toBe('Records');
    await act(async () => {
      replacement.destroy();
    });
  } finally {
    await act(async () => {
      await runtime.dispose();
    });
    await properties.dispose();
    await workspace.dispose();
    parent.remove();
  }
});
