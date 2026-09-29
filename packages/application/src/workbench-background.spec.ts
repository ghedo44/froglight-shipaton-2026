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
} from '@froglight/foundation';
import { createApp, createWorkbenchController } from './index.js';

function mockEditorProvider(
  kindId: DocumentKindId,
  focused: string[] = [],
): DocumentEditorProvider {
  return {
    id: `preserve-editor-${String(kindId)}`,
    kindIds: [kindId],
    createEditor() {
      return {
        focus() {
          // Record every DOM-focus steal so background opens can prove they
          // never focus their target editor, even transiently.
          focused.push(String(kindId));
        },
        hasFocus() {
          return false;
        },
        execCommand() {
          return false;
        },
        destroy() {
          /* test double: teardown is unobserved */
        },
      };
    },
  };
}

async function makeController(focused: string[] = []) {
  const app = await createApp({
    vaultPlugin: memoryVaultPlugin,
    vaultConfig: {},
    searchService: new InMemorySearchService(),
    documentKinds: [markdownKind],
    documentEditorProviders: [mockEditorProvider(markdownKindId, focused)],
  });
  const controller = createWorkbenchController(app);
  const workspace = app.getWorkspace()!;
  const seed = async (path: string) => {
    const ref = await workspace.createDocument({
      kindId: markdownKindId,
      path: workspacePath(path),
      initialModel: markdownModel(`# ${path}`),
    });
    return String(ref.documentId);
  };
  return { app, controller, seed };
}

describe('workbench background preserve-focus', () => {
  it('background document into idle pane preserves original focus', async () => {
    const { app, controller, seed } = await makeController();
    try {
      const first = await seed('one.md');
      const second = await seed('two.md');
      await controller.openDocument(first, {}, { pane: 'main' });
      expect(controller.focusedPane).toBe('main');
      const idle = controller.splitPane('main', 'right');
      controller.focusPane('main');
      expect(controller.focusedPane).toBe('main');
      await controller.openDocument(
        second,
        {},
        { pane: idle, preserveFocus: true },
      );
      expect(controller.focusedPane).toBe('main');
      expect(
        controller.paneStates().find((pane) => pane.pane === idle)?.documentId,
      ).toBe(second);
    } finally {
      await app.dispose();
    }
  });

  it('background document into new split preserves original focus', async () => {
    const { app, controller, seed } = await makeController();
    try {
      const first = await seed('one.md');
      const second = await seed('two.md');
      await controller.openDocument(first, {}, { pane: 'main' });
      const created = controller.splitPane('main', 'right', {
        preserveFocus: true,
      });
      expect(controller.focusedPane).toBe('main');
      await controller.openDocument(
        second,
        {},
        { pane: created, preserveFocus: true },
      );
      expect(controller.focusedPane).toBe('main');
    } finally {
      await app.dispose();
    }
  });

  it('background view preserves original focus, foreground focuses target', async () => {
    const { app, controller } = await makeController();
    try {
      const idle = controller.splitPane('main', 'right');
      controller.focusPane('main');
      await controller.openView('graph', { pane: idle, preserveFocus: true });
      expect(controller.focusedPane).toBe('main');
      await controller.openView('graph', { pane: idle });
      expect(controller.focusedPane).toBe(idle);
    } finally {
      await app.dispose();
    }
  });

  it('foreground document still focuses its target', async () => {
    const { app, controller, seed } = await makeController();
    try {
      const first = await seed('one.md');
      const second = await seed('two.md');
      await controller.openDocument(first, {}, { pane: 'main' });
      const idle = controller.splitPane('main', 'right');
      controller.focusPane('main');
      await controller.openDocument(second, {}, { pane: idle });
      expect(controller.focusedPane).toBe(idle);
    } finally {
      await app.dispose();
    }
  });

  it('background document never focuses its target editor', async () => {
    const focused: string[] = [];
    const { app, controller, seed } = await makeController(focused);
    try {
      const first = await seed('one.md');
      const second = await seed('two.md');
      await controller.openDocument(first, {}, { pane: 'main' });
      const idle = controller.splitPane('main', 'right');
      controller.focusPane('main');
      focused.length = 0;
      await controller.openDocument(
        second,
        {},
        { pane: idle, preserveFocus: true },
      );
      expect(controller.focusedPane).toBe('main');
      // The background session mounts without ever stealing DOM focus.
      expect(focused).toEqual([]);
      expect(
        controller.paneStates().find((pane) => pane.pane === idle)?.documentId,
      ).toBe(second);
    } finally {
      await app.dispose();
    }
  });

  it('foreground Markdown activates its pane and waits for explicit editor focus', async () => {
    const focused: string[] = [];
    const { app, controller, seed } = await makeController(focused);
    try {
      const first = await seed('one.md');
      const second = await seed('two.md');
      await controller.openDocument(first, {}, { pane: 'main' });
      const idle = controller.splitPane('main', 'right');
      controller.focusPane('main');
      focused.length = 0;
      await controller.openDocument(second, {}, { pane: idle });
      expect(controller.focusedPane).toBe(idle);
      expect(focused).toEqual([]);
      controller.focusPane(idle);
      expect(focused.length).toBeGreaterThan(0);
    } finally {
      await app.dispose();
    }
  });

  it('background view never focuses its target', async () => {
    const { app, controller } = await makeController();
    try {
      const idle = controller.splitPane('main', 'right');
      controller.focusPane('main');
      await controller.openView('graph', { pane: idle, preserveFocus: true });
      expect(controller.focusedPane).toBe('main');
    } finally {
      await app.dispose();
    }
  });

  it('user focus change during a pending background view open wins', async () => {
    const { app, controller } = await makeController();
    try {
      const idle = controller.splitPane('main', 'right');
      controller.focusPane('main');
      const third = controller.splitPane('main', 'right', {
        preserveFocus: true,
      });
      controller.focusPane('main');
      // `openView` races the user's explicit focus change: the stale focus
      // captured before the operation must never be restored.
      const pending = controller.openView('graph', {
        pane: idle,
        preserveFocus: true,
      });
      controller.focusPane(third);
      await pending;
      expect(controller.focusedPane).toBe(third);
    } finally {
      await app.dispose();
    }
  });

  it('background reveal never steals editor focus', async () => {
    const focused: string[] = [];
    const revealed: string[] = [];
    const app = await createApp({
      vaultPlugin: memoryVaultPlugin,
      vaultConfig: {},
      searchService: new InMemorySearchService(),
      documentKinds: [markdownKind],
      documentEditorProviders: [
        {
          id: 'reveal-editor',
          kindIds: [markdownKindId],
          createEditor() {
            return {
              focus() {
                focused.push('edit');
              },
              hasFocus() {
                return false;
              },
              execCommand() {
                return false;
              },
              revealAddress(address: string) {
                revealed.push(address);
              },
              destroy() {
                /* test double: teardown is unobserved */
              },
            };
          },
        },
      ],
    });
    const controller = createWorkbenchController(app);
    try {
      const workspace = app.getWorkspace()!;
      const ref = await workspace.createDocument({
        kindId: markdownKindId,
        path: workspacePath('note.md'),
        initialModel: markdownModel('# note'),
      });
      const id = String(ref.documentId);
      await controller.openDocument(id, {}, { pane: 'main' });
      const idle = controller.splitPane('main', 'right');
      controller.focusPane('main');
      await controller.openDocument(id, {}, { pane: idle, preserveFocus: true });
      // single owner: the duplicate open redirects to the live owner
      // (main) and leaves the target untouched, so reveal where the document
      // actually lives instead of the empty requested pane.
      const owningPane =
        controller.paneStates().find((pane) => pane.documentId === id)?.pane ??
        'main';
      focused.length = 0;
      revealed.length = 0;
      expect(
        controller.revealAddress(owningPane, 'sec-1', { preserveFocus: true }),
      ).toBe(true);
      expect(revealed).toEqual(['sec-1']);
      expect(focused).toEqual([]);
      expect(controller.focusedPane).toBe('main');
    } finally {
      await app.dispose();
    }
  });
});
