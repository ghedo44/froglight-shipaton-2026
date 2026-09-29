import { describe, expect, it, vi } from 'vitest';
import {
  resolveDocumentLink,
  createMemoryVault,
  workspacePath,
  decodeBlockPage,
  decodeNotebook,
  decodeSurfacePayload,
  type DocumentRef,
  documentId,
  resourceId,
  blockPageKindId,
  InMemoryDocumentRegistry,
  InMemoryMetadataService,
  InMemoryRelationshipService,
  WorkspaceServiceImpl,
  markdownKind,
  blockPageKind,
  notebookKind,
  inkPageKind,
  whiteboardKind,
  latexKind,
} from '@froglight/foundation';
import { installDemoVault } from './index.js';
import { renderMarkdown } from '@froglight/ui';
import { demoNotes } from './notes.js';
import { VaultPluginStore } from '@froglight/plugin-platform';
import { calculatorPluginManifest } from './calculator-plugin.js';

const landing: DocumentRef = {
  documentId: documentId('test'),
  kindId: blockPageKindId,
  location: { resourceId: resourceId('test') },
};
const path = workspacePath;

describe('bundled Asteria vault', () => {
  it('installs the enabled calculator example without reseeding user edits', async () => {
    const { vault } = createMemoryVault();
    await installDemoVault(vault);
    const plugins = new VaultPluginStore(vault);
    expect((await plugins.readManifest(calculatorPluginManifest.id))?.id).toBe(
      calculatorPluginManifest.id,
    );
    expect((await plugins.loadState()).enabled).toContain(
      calculatorPluginManifest.id,
    );
    expect(await plugins.readCode(calculatorPluginManifest.id)).toContain(
      "area: 'activity'",
    );
    await vault.write(
      path('.froglight/plugins/froglight.demo-calculator/main.js'),
      new TextEncoder().encode('user edit'),
    );
    await installDemoVault(vault);
    expect(await plugins.readCode(calculatorPluginManifest.id)).toBe(
      'user edit',
    );
  });
  it('renders the teaching formulas and metadata in the Markdown reader', () => {
    let displayEquations = 0;
    for (const note of demoNotes) {
      const html = renderMarkdown(note.model.raw);
      expect(html, note.path).not.toContain('md-math-error');
      expect(html, note.path).toContain(
        '<dd>aerospace, asteria, permanent-note</dd>',
      );
      displayEquations += (html.match(/class="katex-display"/g) ?? []).length;
    }
    expect(displayEquations).toBe(10);
  });

  it('installs 30 valid documents with resolvable relationships and editable artwork', async () => {
    const { vault } = createMemoryVault();
    await installDemoVault(vault);
    const registry = new InMemoryDocumentRegistry();
    registry.register(markdownKind);
    registry.register(blockPageKind);
    registry.register(notebookKind);
    registry.register(inkPageKind);
    registry.register(whiteboardKind);
    registry.register(latexKind);
    const relationships = new InMemoryRelationshipService();
    const workspace = await WorkspaceServiceImpl.create({
      vault,
      registry,
      metadata: new InMemoryMetadataService(),
      relationships,
      revisions: null,
    });
    try {
      await workspace.rebuildDerivedState();
      expect(workspace.listDocuments()).toHaveLength(30);
      const ids = new Set(
        workspace.listDocuments().map((ref) => ref.documentId),
      );
      expect(relationships.list().length).toBeGreaterThan(80);
      for (const relation of relationships.list()) {
        if (typeof relation.metadata.href === 'string') {
          const href = relation.metadata.href;
          if (/^https?:/.test(href)) continue;
          expect(
            resolveDocumentLink(workspace, href, relation.source.resourceId),
            href,
          ).not.toBeNull();
        } else
          expect(
            ids.has(relation.target.documentId),
            JSON.stringify(relation),
          ).toBe(true);
      }
      for (const ref of workspace.listDocuments()) {
        const file = workspace.resolveResourcePath(ref.location.resourceId);
        const bytes = await vault.read(file);
        if (file.endsWith('.ink') || file.endsWith('.whiteboard')) {
          const result = decodeSurfacePayload(bytes);
          expect(result.warnings, file).toEqual([]);
          expect(
            Object.values(result.model.objects).some(
              (o) => o.type === 'froglight.ink.stroke',
            ),
          ).toBe(true);
        }
      }
      const page = decodeBlockPage(
        await vault.read(path('00 Mission Control.blockpage')),
        landing,
      );
      expect(page.warnings).toEqual([]);
      expect(page.model.rootOrder.length).toBeGreaterThan(40);
      const notebook = decodeNotebook(
        await vault.read(path('Field notebook.notebook')),
      );
      expect(notebook.warnings).toEqual([]);
      expect(notebook.model.pageOrder).toHaveLength(3);
      for (const entry of Object.values(notebook.model.pages)) {
        expect(entry.kind).toBe('page');
        if (entry.kind === 'page')
          expect(entry.surface.order.length).toBeGreaterThan(25);
      }
    } finally {
      await workspace.dispose();
    }
  });

  it('preserves edits and deletions after installation, including on subsequent app versions', async () => {
    const { vault } = createMemoryVault();
    await installDemoVault(vault);
    await vault.write(
      path('Reading room.md'),
      new TextEncoder().encode('My reading notes'),
    );
    await vault.remove(path('Sketches/Orbit geometry.ink'));
    const manifest = await vault.read(path('.froglight/workspace.json'));
    await installDemoVault(vault);
    expect(
      new TextDecoder().decode(await vault.read(path('Reading room.md'))),
    ).toBe('My reading notes');
    await expect(
      vault.stat(path('Sketches/Orbit geometry.ink')),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await vault.read(path('.froglight/workspace.json'))).toEqual(
      manifest,
    );
  });

  it('resumes an interrupted installation without replacing committed document identities', async () => {
    const { vault } = createMemoryVault();
    const write = vault.write.bind(vault);
    const spy = vi.spyOn(vault, 'write').mockImplementation(async (...args) => {
      if (args[0] === 'Sketches/Spacecraft architecture.ink')
        throw new Error('storage interrupted');
      return write(...args);
    });
    await expect(installDemoVault(vault)).rejects.toThrow(
      'storage interrupted',
    );
    const prior = JSON.parse(
      new TextDecoder().decode(
        await vault.read(path('.froglight/workspace.json')),
      ),
    );
    spy.mockRestore();
    await installDemoVault(vault);
    const next = JSON.parse(
      new TextDecoder().decode(
        await vault.read(path('.froglight/workspace.json')),
      ),
    );
    expect(next.documents).toHaveLength(30);
    expect(next.documents.slice(0, prior.documents.length)).toEqual(
      prior.documents,
    );
  });

  it('refuses an unrelated nonempty destination and propagates storage failures', async () => {
    const { vault } = createMemoryVault();
    await vault.write(path('mine.md'), new TextEncoder().encode('Keep'));
    await expect(installDemoVault(vault)).rejects.toThrow('not empty');
    expect(new TextDecoder().decode(await vault.read(path('mine.md')))).toBe(
      'Keep',
    );
    vi.spyOn(vault, 'stat').mockRejectedValue(new Error('storage unavailable'));
    await expect(installDemoVault(vault)).rejects.toThrow(
      'storage unavailable',
    );
  });
});
