import { describe, expect, it } from 'vitest';
import {
  InMemorySearchService,
  markdownKind,
  markdownKindId,
  markdownModel,
  memoryVaultPlugin,
  workspacePath,
  type DocumentEditorProvider,
  type DocumentKindId,
  type DocumentReaderHandle,
  type DocumentReaderProvider,
} from '@froglight/foundation';
import { createApp, createWorkbenchController } from './index.js';

function editorProviderWithReveal(
  kindId: DocumentKindId,
  revealed: string[],
  counts?: { created: number; destroyed: number; instances: unknown[] },
): DocumentEditorProvider {
  return {
    id: `addr-editor-${String(kindId)}`,
    kindIds: [kindId],
    createEditor() {
      const handle = {
        focus() {
          /* test double: focus is unobserved */
        },
        hasFocus() {
          return false;
        },
        execCommand() {
          return false;
        },
        revealAddress(address: string) {
          revealed.push(`editor:${address}`);
        },
        destroy() {
          if (counts) counts.destroyed += 1;
        },
      };
      if (counts) {
        counts.created += 1;
        counts.instances.push(handle);
      }
      return handle;
    },
  };
}

function readerProviderWithReveal(
  kindId: DocumentKindId,
  revealed: string[],
  counts?: { created: number; destroyed: number; instances: unknown[] },
): DocumentReaderProvider {
  return {
    id: `addr-reader-${String(kindId)}`,
    kindIds: [kindId],
    createReader(): DocumentReaderHandle {
      const handle = {
        update() {
          /* test double: rendering is unobserved */
        },
        revealAddress(address: string) {
          revealed.push(`reader:${address}`);
        },
        destroy() {
          if (counts) counts.destroyed += 1;
        },
      };
      if (counts) {
        counts.created += 1;
        counts.instances.push(handle);
      }
      return handle;
    },
  };
}

function freshCounts() {
  return { created: 0, destroyed: 0, instances: [] as unknown[] };
}

async function makeController(revealed: string[]) {
  const app = await createApp({
    vaultPlugin: memoryVaultPlugin,
    vaultConfig: {},
    searchService: new InMemorySearchService(),
    documentKinds: [markdownKind],
    documentEditorProviders: [
      editorProviderWithReveal(markdownKindId, revealed),
    ],
    documentReaderProviders: [
      readerProviderWithReveal(markdownKindId, revealed),
    ],
  });
  const controller = createWorkbenchController(app);
  await controller.initialize({});
  return { app, controller };
}

async function seed(
  controller: ReturnType<typeof createWorkbenchController>,
  app: Awaited<ReturnType<typeof createApp>>,
  path: string,
  text = '# Note',
) {
  const workspace = app.getWorkspace()!;
  const ref = await workspace.createDocument({
    kindId: markdownKindId,
    path: workspacePath(path),
    initialModel: markdownModel(text),
  });
  return String(ref.documentId);
}

describe('address-aware routing and history', () => {
  it('[[Note#Heading]] resolves Note and reveals Heading', async () => {
    const revealed: string[] = [];
    const { app, controller } = await makeController(revealed);
    try {
      const id = await seed(controller, app, 'Note.md', '# Heading\nbody');
      revealed.length = 0;
      const result = await controller.openLink('Note#Heading');
      expect(result.created).toBe(false);
      expect(result.documentId).toBe(id);
      expect(revealed).toContain('editor:Heading');
    } finally {
      await app.dispose();
    }
  });

  it('Markdown links with #fragment reveal through the editor', async () => {
    const revealed: string[] = [];
    const { app, controller } = await makeController(revealed);
    try {
      await seed(controller, app, 'Note.md', '# Frag\nbody');
      revealed.length = 0;
      await controller.openLink('Note.md#frag');
      expect(revealed).toContain('editor:frag');
    } finally {
      await app.dispose();
    }
  });

  it('explicit { documentId, address } stores address-aware history', async () => {
    const revealed: string[] = [];
    const { app, controller } = await makeController(revealed);
    try {
      const id = await seed(controller, app, 'Doc.md');
      await controller.openDocument(id, {}, { pane: 'main', address: 'sec-1' });
      expect(revealed).toContain('editor:sec-1');
      // History entry must include the address: going back after a second
      // open should restore the first address.
      const other = await seed(controller, app, 'Other.md');
      await controller.openDocument(other, {}, { pane: 'main' });
      await controller.goBack();
      expect(revealed).toContain('editor:sec-1');
    } finally {
      await app.dispose();
    }
  });

  it('restores addresses through Back and Forward', async () => {
    const revealed: string[] = [];
    const { app, controller } = await makeController(revealed);
    try {
      const first = await seed(controller, app, 'First.md');
      const second = await seed(controller, app, 'Second.md');
      await controller.openDocument(first, {}, { pane: 'main', address: 'a1' });
      await controller.openDocument(
        second,
        {},
        { pane: 'main', address: 'b1' },
      );
      revealed.length = 0;
      await controller.goBack();
      expect(controller.state.activeDocumentTitle).toBe('First.md');
      expect(revealed).toContain('editor:a1');
      revealed.length = 0;
      await controller.goForward();
      expect(controller.state.activeDocumentTitle).toBe('Second.md');
      expect(revealed).toContain('editor:b1');
    } finally {
      await app.dispose();
    }
  });

  it('navigates between two addresses of the same open document without teardown', async () => {
    const revealed: string[] = [];
    const editorCounts = freshCounts();
    const readerCounts = freshCounts();
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      vaultConfig: {},
      searchService: new InMemorySearchService(),
      documentKinds: [markdownKind],
      documentEditorProviders: [
        editorProviderWithReveal(markdownKindId, revealed, editorCounts),
      ],
      documentReaderProviders: [
        readerProviderWithReveal(markdownKindId, revealed, readerCounts),
      ],
    });
    const controller = createWorkbenchController(app);
    // Seed before initialize so startup opens the seeded document itself.
    const id = await seed(controller, app, 'Same.md');
    await controller.initialize({});
    expect(editorCounts.created).toBe(1);
    try {
      await controller.openDocument(id, {}, { pane: 'main', address: 'one' });
      // Same document, same pane, live session: no teardown, no recreate.
      expect(editorCounts.created).toBe(1);
      expect(editorCounts.destroyed).toBe(0);
      await controller.openDocument(id, {}, { pane: 'main', address: 'two' });
      // The live session/editor survives: no teardown, no recreate — only
      // the address/reveal/history location changes.
      expect(editorCounts.created).toBe(1);
      expect(editorCounts.destroyed).toBe(0);
      expect(editorCounts.instances).toHaveLength(1);
      expect(revealed).toContain('editor:two');
      // Back stays on the same document and reveals the first address,
      // again without tearing the session down.
      revealed.length = 0;
      const before = controller
        .paneStates()
        .find((p) => p.pane === 'main')?.documentId;
      await controller.goBack();
      const after = controller
        .paneStates()
        .find((p) => p.pane === 'main')?.documentId;
      expect(before).toBe(id);
      expect(after).toBe(id);
      expect(revealed).toContain('editor:one');
      expect(editorCounts.created).toBe(1);
      expect(editorCounts.destroyed).toBe(0);
      // Forward restores the second address with the same live session.
      revealed.length = 0;
      await controller.goForward();
      expect(
        controller.paneStates().find((p) => p.pane === 'main')?.documentId,
      ).toBe(id);
      expect(revealed).toContain('editor:two');
      expect(editorCounts.created).toBe(1);
      expect(editorCounts.destroyed).toBe(0);
    } finally {
      await app.dispose();
    }
  });

  it('same-document navigation in reading mode keeps the live reader', async () => {
    const revealed: string[] = [];
    const editorCounts = freshCounts();
    const readerCounts = freshCounts();
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      vaultConfig: {},
      searchService: new InMemorySearchService(),
      documentKinds: [markdownKind],
      documentEditorProviders: [
        editorProviderWithReveal(markdownKindId, revealed, editorCounts),
      ],
      documentReaderProviders: [
        readerProviderWithReveal(markdownKindId, revealed, readerCounts),
      ],
    });
    const controller = createWorkbenchController(app);
    // Seed before initialize so startup opens the seeded document itself.
    const id = await seed(controller, app, 'Read2.md');
    await controller.initialize({});
    expect(editorCounts.created).toBe(1);
    try {
      const tabId = controller
        .paneStates()
        .find((p) => p.pane === 'main')?.activeTab;
      expect(tabId).not.toBeNull();
      controller.setReaderHost('main', {});
      controller.setTabMode('main', tabId!, 'reading');
      expect(readerCounts.created).toBe(1);
      revealed.length = 0;
      await controller.openDocument(id, {}, { pane: 'main', address: 'r-one' });
      await controller.openDocument(id, {}, { pane: 'main', address: 'r-two' });
      // The active reader receives both reveals; neither reader nor editor
      // is recreated.
      expect(revealed).toEqual(['reader:r-one', 'reader:r-two']);
      expect(readerCounts.created).toBe(1);
      expect(readerCounts.destroyed).toBe(0);
      expect(editorCounts.created).toBe(1);
      // Entering reading exited the editor once; address navigation adds no churn.
      expect(editorCounts.destroyed).toBe(1);
    } finally {
      await app.dispose();
    }
  });

  it('switching to a different document still performs a session transition', async () => {
    const revealed: string[] = [];
    const editorCounts = freshCounts();
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      vaultConfig: {},
      searchService: new InMemorySearchService(),
      documentKinds: [markdownKind],
      documentEditorProviders: [
        editorProviderWithReveal(markdownKindId, revealed, editorCounts),
      ],
      documentReaderProviders: [
        readerProviderWithReveal(markdownKindId, revealed),
      ],
    });
    const controller = createWorkbenchController(app);
    // Seed before initialize so startup opens a seeded document itself.
    const alpha = await seed(controller, app, 'Alpha.md');
    const beta = await seed(controller, app, 'Beta.md');
    await controller.initialize({});
    expect(editorCounts.created).toBe(1);
    // Startup opens one of the seeded documents; navigate from whichever is
    // already live so the same-document fast path is exercised first.
    const startupId = controller.paneStates().find((p) => p.pane === 'main')
      ?.documentId;
    expect([alpha, beta]).toContain(startupId);
    const first = startupId!;
    const second = first === alpha ? beta : alpha;
    try {
      await controller.openDocument(first, {}, { pane: 'main', address: 'a' });
      // Same document as the startup session: fast path, no transition.
      expect(editorCounts.created).toBe(1);
      expect(editorCounts.destroyed).toBe(0);
      await controller.openDocument(second, {}, { pane: 'main', address: 'b' });
      // A different document tears the old session down and creates a new one.
      expect(editorCounts.created).toBe(2);
      expect(editorCounts.destroyed).toBe(1);
      expect(
        controller.paneStates().find((p) => p.pane === 'main')?.documentId,
      ).toBe(second);
      expect(revealed).toContain('editor:a');
      expect(revealed).toContain('editor:b');
      // Back restores the first document (a real transition back).
      revealed.length = 0;
      await controller.goBack();
      expect(
        controller.paneStates().find((p) => p.pane === 'main')?.documentId,
      ).toBe(first);
      expect(revealed).toContain('editor:a');
      expect(editorCounts.created).toBe(3);
      expect(editorCounts.destroyed).toBe(2);
    } finally {
      await app.dispose();
    }
  });

  it('reveals through the reader in reading mode', async () => {
    const revealed: string[] = [];
    const { app, controller } = await makeController(revealed);
    try {
      const id = await seed(controller, app, 'Read.md');
      await controller.openDocument(id, {}, { pane: 'main' });
      const tabId = controller
        .paneStates()
        .find((p) => p.pane === 'main')?.activeTab;
      expect(tabId).not.toBeNull();
      // Readers mount into a stored host (the shell sets this); without it
      // `#ensureReader` cannot create the reader and reveal falls back.
      controller.setReaderHost('main', {});
      controller.setTabMode('main', tabId!, 'reading');
      revealed.length = 0;
      const ok = controller.revealAddress('main', 'heading-x');
      expect(ok).toBe(true);
      expect(revealed).toContain('reader:heading-x');
      // openLink with fragment while in reading mode also goes through reader
      revealed.length = 0;
      await controller.openLink('Read#heading-x');
      expect(revealed).toContain('reader:heading-x');
    } finally {
      await app.dispose();
    }
  });

  it('reveals through the editor in edit mode', async () => {
    const revealed: string[] = [];
    const { app, controller } = await makeController(revealed);
    try {
      const id = await seed(controller, app, 'Edit.md');
      await controller.openDocument(id, {}, { pane: 'main' });
      revealed.length = 0;
      const ok = controller.revealAddress('main', 'sec-9');
      expect(ok).toBe(true);
      expect(revealed).toContain('editor:sec-9');
    } finally {
      await app.dispose();
    }
  });
});
