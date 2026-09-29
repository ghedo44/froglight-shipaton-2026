import {
  readVaultProfile,
  writeVaultProfile,
  InMemoryDocumentRegistry,
  InMemoryMetadataService,
  InMemoryRelationshipService,
  WorkspaceServiceImpl,
  blockPageKind,
  inkPageKind,
  latexKind,
  markdownKind,
  markdownModel,
  notebookKind,
  whiteboardKind,
  workspacePath,
  type DocumentKindDescriptor,
  type DocumentRef,
  type ResourceTarget,
  type VaultService,
} from '@froglight/foundation';
import { demoNotes, readingRoom } from './notes.js';
import { designNotes } from './latex.js';
import {
  controlSketch,
  energySketch,
  fieldNotebook,
  missionWhiteboard,
  orbitSketch,
  spacecraftSketch,
} from './surfaces.js';
import { missionControl } from './mission.js';
import { DockLayoutStoreImpl } from '../dock-layout.js';
import { VaultPluginStore } from '@froglight/plugin-platform';
import {
  calculatorPluginManifest,
  calculatorPluginSource,
} from './calculator-plugin.js';

export const DEMO_VAULT_NAME = 'Asteria — Aerospace Studio';
export const DEMO_VAULT_ID = 'froglight-asteria-demo';
const complete = workspacePath('.froglight/asteria-demo.complete');
const installing = workspacePath('.froglight/asteria-demo.installing');
const encoder = new TextEncoder();

async function exists(
  vault: VaultService,
  path: ReturnType<typeof workspacePath>,
) {
  try {
    await vault.stat(path);
    return true;
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'NOT_FOUND'
    )
      return false;
    throw error;
  }
}

/** Only hosts' dedicated demo stores call this, before opening their workspace.
 * Completion is durable: edits, renames and deletions are never reseeded.
 * Interrupted installs resume by canonical path without replacing any content.
 */
export async function installDemoVault(vault: VaultService): Promise<void> {
  if (await exists(vault, complete)) {
    if ((await readVaultProfile(vault)) === null)
      await writeVaultProfile(vault, {
        name: DEMO_VAULT_NAME,
        icon: 'satellite',
        color: 'blue',
      });
    return;
  }
  if (!(await exists(vault, installing))) {
    if ((await vault.list(workspacePath(''))).length !== 0)
      throw new Error(
        'The demo destination is not empty; existing content was preserved.',
      );
    await vault.createDirectory(workspacePath('.froglight'));
    await vault.write(
      installing,
      encoder.encode('Asteria demo installation\n'),
    );
  }
  const registry = new InMemoryDocumentRegistry();
  registry.register(markdownKind);
  registry.register(blockPageKind);
  registry.register(inkPageKind);
  registry.register(notebookKind);
  registry.register(whiteboardKind);
  registry.register(latexKind);
  const workspace = await WorkspaceServiceImpl.create({
    vault,
    registry,
    metadata: new InMemoryMetadataService(),
    relationships: new InMemoryRelationshipService(),
    revisions: null,
  });
  const refs = new Map<string, DocumentRef>(
    workspace
      .listDocuments()
      .map((ref) => [
        workspace.resolveResourcePath(ref.location.resourceId),
        ref,
      ]),
  );
  async function create<T>(
    path: string,
    kind: DocumentKindDescriptor<T>,
    model: T,
  ) {
    if (refs.has(path)) return;
    const ref = await workspace.createDocument({
      path: workspacePath(path),
      kindId: kind.id,
      initialModel: model,
    });
    refs.set(path, ref);
  }
  function target(path: string): ResourceTarget {
    const ref = refs.get(path);
    if (!ref) throw new Error(`Missing demo document: ${path}`);
    return {
      documentId: ref.documentId,
      kindId: ref.kindId,
      resourceId: ref.location.resourceId,
    };
  }
  try {
    for (const note of demoNotes)
      await create(note.path, markdownKind, note.model);
    await create('Reading room.md', markdownKind, readingRoom);
    await create(
      'Examples/Calculator plugin.md',
      markdownKind,
      markdownModel(
        '# Calculator plugin\n\nThe **Calculator** button in the left activity rail comes from a plugin installed in this vault. Select it to open a movable window; drag its title bar and use × to close it.\n\nThe editable example lives at `.froglight/plugins/froglight.demo-calculator/main.js`, with its permissions in the adjacent `manifest.json`. Its entry point registers a view like this:\n\n```js\nexport function activate({ uiViews }) {\n  uiViews.register({\n    id: "froglight.demo-calculator",\n    area: "activity",\n    title: "Calculator",\n    icon: "math",\n    mount(container) {\n      // Create your controls inside container. Return a cleanup function.\n    },\n  });\n}\n```\n\nThe app owns the button, draggable window, and close control. The plugin owns only the calculator controls. Disable the plugin in Settings → Community plugins to remove its button and window. This is trusted code running in the app process.\n',
      ),
    );
    await create('Asteria design notes.tex', latexKind, designNotes);
    await create('Sketches/Orbit geometry.ink', inkPageKind, orbitSketch());
    await create(
      'Sketches/Spacecraft architecture.ink',
      inkPageKind,
      spacecraftSketch(),
    );
    await create(
      'Sketches/Eclipse energy budget.ink',
      inkPageKind,
      energySketch(),
    );
    await create(
      'Sketches/Attitude control loop.ink',
      inkPageKind,
      controlSketch(),
    );
    await create('Field notebook.notebook', notebookKind, fieldNotebook());
    await create(
      'Design room.whiteboard',
      whiteboardKind,
      missionWhiteboard(target('Sketches/Spacecraft architecture.ink')),
    );
    await create(
      '00 Mission Control.blockpage',
      blockPageKind,
      missionControl(target),
    );
    const plugins = new VaultPluginStore(vault);
    if ((await plugins.readManifest(calculatorPluginManifest.id)) === null) {
      await plugins.install({
        manifestJson: calculatorPluginManifest,
        code: calculatorPluginSource,
      });
      const state = await plugins.loadState();
      await plugins.saveState({
        ...state,
        enabled: [...new Set([...state.enabled, calculatorPluginManifest.id])],
      });
    }
    await workspace.rebuildDerivedState();
    const dock = await DockLayoutStoreImpl.open(vault);
    try {
      if ((await dock.load()) === null) {
        const documentId = target('00 Mission Control.blockpage').documentId;
        dock.save({
          format: 'froglight.dock',
          version: 1,
          root: { kind: 'leaf', pane: 'main' },
          focusedPane: 'main',
          panes: [
            {
              pane: 'main',
              tabs: [
                { id: documentId, kind: 'document', documentId, viewId: null },
              ],
              activeTab: documentId,
              modes: [{ tab: documentId, mode: 'edit' }],
            },
          ],
        });
        await dock.flush();
      }
    } finally {
      await dock.dispose();
    }
    await writeVaultProfile(vault, {
      name: DEMO_VAULT_NAME,
      icon: 'satellite',
      color: 'blue',
    });
    await vault.write(complete, encoder.encode('Asteria demo installed\n'));
  } finally {
    await workspace.dispose();
  }
}
