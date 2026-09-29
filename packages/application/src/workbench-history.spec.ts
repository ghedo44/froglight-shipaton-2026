import { describe, expect, it } from 'vitest';
import {
  InMemorySearchService,
  markdownKindId,
  markdownModel,
  memoryVaultPlugin,
  workspacePath,
  type DocumentEditorProvider,
} from '@froglight/foundation';
import { createApp, createWorkbenchController } from './index.js';

async function setup() {
  const provider = {
    id: 'history-editor',
    kindIds: [markdownKindId],
    createEditor({ session }) {
      return {
        focus() {
          return undefined;
        },
        hasFocus() {
          return false;
        },
        execCommand() {
          return false;
        },
        destroy() {
          return undefined;
        },
      };
    },
  } as const satisfies DocumentEditorProvider;
  const app = await createApp({
    vaultPlugin: memoryVaultPlugin,
    vaultConfig: {},
    searchService: new InMemorySearchService(),
    documentEditorProviders: [provider],
  });
  const controller = createWorkbenchController(app);
  const workspace = app.getWorkspace()!;
  const create = async (path: string, body: string): Promise<string> => {
    const ref = await workspace.createDocument({
      kindId: markdownKindId,
      path: workspacePath(path),
      initialModel: markdownModel(body),
    });
    return String(ref.documentId);
  };
  const alphaId = await create('alpha.md', '# Alpha');
  const betaId = await create('beta.md', '# Beta');
  const gammaId = await create('gamma.md', '# Gamma');
  return { app, controller, create, alphaId, betaId, gammaId };
}

describe('per-pane workspace history', () => {
  it('each pane walks its own back/forward trail', async () => {
    const { app, controller, alphaId, betaId, gammaId } = await setup();
    await controller.openDocument(alphaId, {});
    await controller.openDocument(betaId, {}, { pane: 'main' });
    const second = controller.splitPane('main', 'right');
    await controller.openDocument(gammaId, {}, { pane: second });

    // Main goes back to alpha; second stays on gamma.
    controller.focusPane('main');
    await expect(controller.goBack()).resolves.toBe(true);
    expect(controller.getPaneText('main')).toContain('Alpha');
    expect(controller.getPaneText(second)).toContain('Gamma');
    expect(controller.state.canGoForward).toBe(true);

    await expect(controller.goBack()).resolves.toBe(false);
    await expect(controller.goForward()).resolves.toBe(true);
    expect(controller.getPaneText('main')).toContain('Beta');

    // The second pane has no trail of its own yet.
    controller.focusPane(second);
    await expect(controller.goBack()).resolves.toBe(false);

    await app.dispose();
  });

  it('navigating a pane reopens documents into that pane only', async () => {
    const { app, controller, alphaId, betaId, gammaId } = await setup();
    await controller.openDocument(alphaId, {});
    await controller.openDocument(betaId, {}, { pane: 'main' });
    const second = controller.splitPane('main', 'right');
    await controller.openDocument(gammaId, {}, { pane: second });

    controller.focusPane('main');
    await controller.goBack();
    expect(controller.focusedPane).toBe('main');
    expect(controller.getPaneText(second)).toContain('Gamma');

    await app.dispose();
  });

  it('registers reversible navigation and dock commands', async () => {
    const { app, controller } = await setup();
    const commands = app.getCommands();
    if (commands === null) throw new Error('command service unavailable');

    // Created with the controller, gone after dispose (effect ownership).
    const expected = [
      'froglight.navigation.back',
      'froglight.navigation.forward',
      'froglight.workspace.splitRight',
      'froglight.workspace.splitDown',
      'froglight.workspace.closePane',
      'froglight.workspace.closeOtherPanes',
      'froglight.workspace.moveTabToNextPane',
      'froglight.workspace.focusNextPane',
      'froglight.workspace.focusPreviousPane',
      'froglight.workspace.toggleMaximize',
    ];
    // `get` throws for unknown ids; lookups after dispose must not find them.
    const lookup = (id: string): unknown => {
      try {
        return commands.get(id);
      } catch {
        return undefined;
      }
    };
    for (const id of expected) {
      expect(lookup(id)).toBeDefined();
    }
    await controller.dispose();
    for (const id of expected) {
      expect(lookup(id)).toBeUndefined();
    }
    // Reactivate: a fresh controller over the same app registers one set again.
    const revived = createWorkbenchController(app);
    for (const id of expected) {
      expect(lookup(id)).toBeDefined();
    }
    await revived.dispose();
    for (const id of expected) {
      expect(lookup(id)).toBeUndefined();
    }
    await app.dispose();
  });

  it('dock commands drive the focused pane', async () => {
    const { app, controller, alphaId, betaId, gammaId } = await setup();
    const commands = app.getCommands();
    if (commands === null) throw new Error('command service unavailable');

    await controller.openDocument(alphaId, {});
    await controller.openDocument(betaId, {}, { pane: 'main' });
    await commands.execute('froglight.workspace.splitRight');
    const second = controller.focusedPane;
    await controller.openDocument(gammaId, {}, { pane: second });

    await commands.execute('froglight.workspace.focusPreviousPane');
    expect(controller.focusedPane).toBe('main');

    // Move the focused pane's active tab (beta) into the next pane.
    await commands.execute('froglight.workspace.moveTabToNextPane');
    const main = controller.paneStates().find((pane) => pane.pane === 'main');
    const secondState = controller.paneStates().find((pane) => pane.pane === second);
    expect(main?.tabs.map((tab) => tab.documentId)).toEqual([alphaId]);
    expect(secondState?.tabs.map((tab) => tab.documentId)).toEqual([gammaId, betaId]);
    expect(controller.focusedPane).toBe(second);

    await commands.execute('froglight.workspace.closeOtherPanes');
    expect(controller.leafIds()).toEqual([second]);
    const merged = controller.paneStates().find((pane) => pane.pane === second);
    expect(merged?.tabs.map((tab) => tab.documentId)).toEqual([gammaId, betaId, alphaId]);

    await app.dispose();
  });

  it('view opens join the pane trail and Back returns to the previous document', async () => {
    const { app, controller, alphaId } = await setup();
    await controller.openDocument(alphaId, {});

    await controller.openView('graph');
    let main = controller.paneStates().find((pane) => pane.pane === 'main');
    expect(main?.canGoBack).toBe(true);

    expect(await controller.goBack()).toBe(true);
    main = controller.paneStates().find((pane) => pane.pane === 'main');
    expect(main?.documentId).toBe(alphaId);
    expect(controller.getPaneText('main')).toContain('Alpha');

    expect(await controller.goForward()).toBe(true);
    main = controller.paneStates().find((pane) => pane.pane === 'main');
    expect(main?.viewId).toBe('graph');

    await app.dispose();
  });

  it('a lone view open leaves no back trail', async () => {
    const { app, controller } = await setup();
    await controller.openView('graph');
    expect(await controller.goBack()).toBe(false);

    await app.dispose();
  });
});
