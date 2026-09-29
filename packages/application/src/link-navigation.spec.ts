import { describe, expect, it } from 'vitest';
import {
  InMemorySearchService,
  markdownKind,
  memoryVaultPlugin,
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

describe('WorkbenchController.openLink', () => {
  it('opens an existing linked document', async () => {
    const { app, controller } = await makeController();
    await controller.initialize({});
    await controller.createAndOpen('wiki/Existing.md', {});
    const result = await controller.openLink('Existing');
    expect(result.created).toBe(false);
    expect(controller.state.activeDocumentTitle).toBe('Existing.md');
    await app.dispose();
  });

  it('creates and opens a missing linked document (Obsidian-style)', async () => {
    const { app, controller } = await makeController();
    await controller.initialize({});
    const result = await controller.openLink('Fresh Idea');
    expect(result.created).toBe(true);
    expect(controller.state.activeDocumentTitle).toBe('Fresh Idea.md');
    expect(controller.state.activeDocumentPath).toBe('Fresh Idea.md');
    // Second click resolves to the now-existing note.
    const again = await controller.openLink('Fresh Idea');
    expect(again.created).toBe(false);
    await app.dispose();
  });

  it('creates missing links inside nested folders', async () => {
    const { app, controller } = await makeController();
    await controller.initialize({});
    await controller.openLink('projects/froglight/Roadmap');
    expect(controller.state.activeDocumentPath).toBe('projects/froglight/Roadmap.md');
    await app.dispose();
  });

  it('ignores fragments when resolving', async () => {
    const { app, controller } = await makeController();
    await controller.initialize({});
    await controller.createAndOpen('notes/Anchored.md', {});
    const result = await controller.openLink('notes/Anchored.md#section-two');
    expect(result.created).toBe(false);
    expect(controller.state.activeDocumentTitle).toBe('Anchored.md');
    await app.dispose();
  });
});

describe('WorkbenchController navigation history', () => {
  it('records visits and navigates back/forward between documents', async () => {
    const { app, controller } = await makeController();
    await controller.initialize({});
    await controller.createAndOpen('notes/first.md', {});
    await controller.createAndOpen('notes/second.md', {});
    expect(controller.state.activeDocumentTitle).toBe('second.md');
    expect(controller.state.canGoBack).toBe(true);
    expect(controller.state.canGoForward).toBe(false);

    await controller.goBack();
    expect(controller.state.activeDocumentTitle).toBe('first.md');
    expect(controller.state.canGoForward).toBe(true);

    await controller.goForward();
    expect(controller.state.activeDocumentTitle).toBe('second.md');
    expect(controller.state.canGoForward).toBe(false);
    await app.dispose();
  });

  it('opening a link pushes history so back returns to the origin', async () => {
    const { app, controller } = await makeController();
    await controller.initialize({});
    await controller.createAndOpen('notes/Home.md', {});
    await controller.openLink('notes/Home.md#nothing'); // already active → no extra entry
    await controller.createAndOpen('notes/Away.md', {});
    await controller.openLink('Home');
    expect(controller.state.activeDocumentTitle).toBe('Home.md');
    await controller.goBack();
    expect(controller.state.activeDocumentTitle).toBe('Away.md');
    await app.dispose();
  });
});
