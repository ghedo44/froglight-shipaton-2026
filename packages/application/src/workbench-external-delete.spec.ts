import { describe, expect, it } from 'vitest';
import {
  InMemorySearchService,
  markdownKind,
  markdownKindId,
  markdownModel,
  memoryVaultPlugin,
  workspacePath,
} from '@froglight/foundation';
import { MockMarkdownEditorProvider } from '@froglight/foundation/testing';
import { createApp, createWorkbenchController } from './index.js';

async function setup() {
  const app = await createApp({
    vaultPlugin: memoryVaultPlugin,
    vaultConfig: {},
    searchService: new InMemorySearchService(),
    documentKinds: [markdownKind],
    markdownEditorProvider: new MockMarkdownEditorProvider(),
  });
  const controller = createWorkbenchController(app);
  await controller.initialize({});
  return { app, controller };
}

describe('external document deletion (file-explorer path)', () => {
  it('activating a tab deleted outside the controller closes it instead of throwing', async () => {
    const { app, controller } = await setup();
    const workspace = app.getWorkspace()!;
    const doomed = await workspace.createDocument({
      kindId: markdownKindId,
      path: workspacePath('notes/doomed.md'),
      initialModel: markdownModel('# doomed\n'),
    });
    const doomedId = String(doomed.documentId);
    await controller.openDocument(doomedId, {});
    const other = await workspace.createDocument({
      kindId: markdownKindId,
      path: workspacePath('notes/other.md'),
      initialModel: markdownModel('# other\n'),
    });
    const otherId = String(other.documentId);
    await controller.openDocument(otherId, {});
    // Explorer service removes bytes directly, bypassing the controller.
    await workspace.removeDocument(doomed.documentId);
    await workspace.rebuildDerivedState();

    await controller.activateTab('main', doomedId);
    const tabs = controller.paneStates()[0]?.tabs ?? [];
    expect(tabs.some((tab) => tab.documentId === doomedId)).toBe(false);
    expect(controller.paneStates()[0]?.documentId).toBe(otherId);
    await app.dispose();
  });

  it('pruneMissingDocuments removes dangling tabs from every pane', async () => {
    const { app, controller } = await setup();
    const workspace = app.getWorkspace()!;
    const doomed = await workspace.createDocument({
      kindId: markdownKindId,
      path: workspacePath('notes/doomed.md'),
      initialModel: markdownModel('# doomed\n'),
    });
    const doomedId = String(doomed.documentId);
    await controller.openDocument(doomedId, {});
    await workspace.removeDocument(doomed.documentId);
    await workspace.rebuildDerivedState();

    // Dangling until the shell reports the external deletion.
    expect(
      (controller.paneStates()[0]?.tabs ?? []).some(
        (tab) => tab.documentId === doomedId,
      ),
    ).toBe(true);
    await controller.pruneMissingDocuments();
    expect(
      (controller.paneStates()[0]?.tabs ?? []).some(
        (tab) => tab.documentId === doomedId,
      ),
    ).toBe(false);
    await app.dispose();
  });

  it('restoreDockLayout skips tabs whose documents are gone', async () => {
    const { app, controller } = await setup();
    const workspace = app.getWorkspace()!;
    const doomed = await workspace.createDocument({
      kindId: markdownKindId,
      path: workspacePath('notes/doomed.md'),
      initialModel: markdownModel('# doomed\n'),
    });
    const doomedId = String(doomed.documentId);
    await controller.openDocument(doomedId, {});
    const layout = controller.dockLayout();
    await workspace.removeDocument(doomed.documentId);
    await workspace.rebuildDerivedState();

    await controller.restoreDockLayout(layout);
    expect(
      (controller.paneStates()[0]?.tabs ?? []).some(
        (tab) => tab.documentId === doomedId,
      ),
    ).toBe(false);
    await app.dispose();
  });
});
