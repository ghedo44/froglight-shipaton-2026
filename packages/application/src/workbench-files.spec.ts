import { describe, expect, it } from 'vitest';
import {
  InMemorySearchService,
  markdownKind,
  markdownKindId,
  memoryVaultPlugin,
  workspacePath,
} from '@froglight/foundation';
import { MockMarkdownEditorProvider } from '@froglight/foundation/testing';
import { createApp, createWorkbenchController } from './index.js';

async function makeController() {
  const app = await createApp({
    vaultPlugin: memoryVaultPlugin,
    vaultConfig: {},
    searchService: new InMemorySearchService(),
    documentKinds: [markdownKind],
    markdownEditorProvider: new MockMarkdownEditorProvider(),
  });
  const controller = createWorkbenchController(app);
  return { app, controller };
}

describe('WorkbenchController document management', () => {
  it('moves a blank document into a folder', async () => {
    const { app, controller } = await makeController();
    await controller.initialize({});
    const ref = await controller.createAndOpen('notes/movable.md', {});
    expect(ref).not.toBeNull();

    await controller.moveDocumentTo(String(ref?.documentId), 'archive/deep/movable.md');
    const workspace = app.getWorkspace();
    if (workspace === null) throw new Error('no workspace');
    expect(controller.state.activeDocumentPath).toBe('archive/deep/movable.md');
    expect(workspace.findByResourcePath(workspacePath('archive/deep/movable.md'))).not.toBeNull();
    await app.dispose();
  });

  it('deletes a document and clears active state when it was open', async () => {
    const { app, controller } = await makeController();
    await controller.initialize({});
    const ref = await controller.createAndOpen('notes/temporary.md', {});
    expect(ref).not.toBeNull();
    await controller.deleteDocument(String(ref?.documentId));
    expect(app.getWorkspace()?.listDocuments().length).toBe(1); // welcome doc remains
    expect(controller.state.activeDocumentId).toBeNull();
    expect(controller.search('temporary')).toHaveLength(0);
    await app.dispose();
  });

  it('deleting an inactive document keeps the active session', async () => {
    const { app, controller } = await makeController();
    await controller.initialize({});
    const ref = await controller.createAndOpen('notes/other.md', {});
    const activeBefore = controller.state.activeDocumentId;
    const workspace = app.getWorkspace();
    if (workspace === null) throw new Error('no workspace');
    const welcome = workspace
      .listDocuments()
      .find((candidate) => workspace.resolveResourcePath(candidate.location.resourceId) === 'notes/welcome.md');
    expect(welcome).toBeDefined();
    await controller.deleteDocument(String(welcome?.documentId));
    expect(controller.state.activeDocumentId).toBe(activeBefore);
    void ref;
    await app.dispose();
  });
});

describe('WorkbenchController.createMarkdownNote', () => {
  it('creates a note inside an existing folder path', async () => {
    const { app, controller } = await makeController();
    await controller.initialize({});
    const ref = await controller.createMarkdownNote('journal', '2026-08-23');
    expect(controller.state.activeDocumentPath).toBe('journal/2026-08-23.md');
    expect(String(ref.kindId)).toBe(markdownKindId);
    expect((await app.getWorkspace()!.readDocument<{ raw: string }>(ref.documentId)).model.raw).toBe('');
    await app.dispose();
  });
});
