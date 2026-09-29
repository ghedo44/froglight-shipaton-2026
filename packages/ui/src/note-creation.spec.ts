/**
 * Kind-aware note creation through the file-explorer service: extension
 * mapping, canonical seed models, and name sanitization per kind.
 */

import { describe, expect, it } from 'vitest';
import { Runtime, definePlugin } from '@froglight/runtime';
import {
  blockPageKind,
  blockPageKindId,
  inkPageKind,
  inkPageKindId,
  markdownKind,
  markdownKindId,
  latexKind,
  latexKindId,
  markdownModel,
  documentKindId,
  memoryVaultPlugin,
  workspacePlugin,
  workspaceToken,
  documentRegistryToken,
  type BlockPageModel,
  type SurfaceModel,
  type WorkspaceService,
} from '@froglight/foundation';
import { fileExplorerPlugin, fileExplorerToken } from './index.js';

function makeRuntime() {
  const captured: { explorer?: unknown; workspace?: WorkspaceService } = {};
  const runtime = new Runtime();
  const kinds = definePlugin({
    id: 'test.document-kinds',
    requirements: { requires: [documentRegistryToken] },
    activate: (ctx) => {
      const registry = ctx.require(documentRegistryToken);
      const pluginKindId = documentKindId('test.plugin-page');
      const pluginKind = {
        ...markdownKind,
        id: pluginKindId,
        importExtensions: ['.acme'],
        creation: {
          label: 'Plugin page',
          extension: '.acme',
          createInitialModel: (title: string) =>
            markdownModel(`Created ${title}`),
        },
      };
      ctx.effect(() => registry.register(markdownKind).dispose);
      ctx.effect(() => registry.register(blockPageKind).dispose);
      ctx.effect(() => registry.register(inkPageKind).dispose);
      ctx.effect(() => registry.register(latexKind).dispose);
      ctx.effect(() => registry.register(pluginKind).dispose);
    },
  });
  const probe = definePlugin({
    id: 'test.probe',
    requirements: { requires: [workspaceToken, fileExplorerToken] },
    activate: (ctx) => {
      captured.workspace = ctx.require(workspaceToken);
      captured.explorer = ctx.require(fileExplorerToken);
    },
  });

  return (async () => {
    await runtime.registerSlot({ id: 'vault', plugin: memoryVaultPlugin });
    await runtime.registerSlot({ id: 'workspace', plugin: workspacePlugin });
    await runtime.registerSlot({ id: 'kinds', plugin: kinds });
    await runtime.registerSlot({
      id: 'file-explorer',
      plugin: fileExplorerPlugin,
    });
    await runtime.registerSlot({ id: 'probe', plugin: probe });
    return {
      explorer: captured.explorer as {
        creatableKinds(): readonly {
          label: string;
          kindId: string | null;
          extension: string;
        }[];
        createNote(
          folder: string,
          name: string,
          kindId?: string,
        ): Promise<string>;
        importFile(folder: string, name: string, data: Uint8Array): Promise<void>;
      },
      workspace: captured.workspace!,
      dispose: () => runtime.dispose(),
    };
  })();
}

describe('file-explorer kind-aware note creation', () => {
  it('imports LaTeX aliases through the registered kind', async () => {
    const env = await makeRuntime();
    try {
      await env.explorer.importFile('papers', 'Draft.ltx', new TextEncoder().encode('Hello'));
      const ref = env.workspace.listDocuments().find((candidate) =>
        String(env.workspace.resolveResourcePath(candidate.location.resourceId)) === 'papers/Draft.ltx',
      );
      expect(ref?.kindId).toBe(latexKindId);
    } finally {
      env.dispose();
    }
  });

  it('imports a plugin kind through its creator extension', async () => {
    const env = await makeRuntime();
    try {
      await env.explorer.importFile('plugins', 'Custom.acme', new TextEncoder().encode('Custom content'));
      const ref = env.workspace.listDocuments().find((candidate) =>
        String(env.workspace.resolveResourcePath(candidate.location.resourceId)) === 'plugins/Custom.acme',
      );
      expect(ref?.kindId).toBe('test.plugin-page');
    } finally {
      env.dispose();
    }
  });

  it('creates Markdown notes with the.md extension by default', async () => {
    const env = await makeRuntime();
    try {
      const id = await env.explorer.createNote('notes', 'Roadmap');
      const ref = env.workspace
        .listDocuments()
        .find((candidate) => String(candidate.documentId) === id)!;
      expect(
        String(env.workspace.resolveResourcePath(ref.location.resourceId)),
      ).toBe('notes/Roadmap.md');
      expect(ref.kindId).toBe(markdownKindId);
      expect(
        (await env.workspace.readDocument<{ raw: string }>(ref.documentId))
          .model.raw,
      ).toBe('');
      const duplicateId = await env.explorer.createNote('notes', 'Roadmap');
      const duplicateRef = env.workspace
        .listDocuments()
        .find((candidate) => String(candidate.documentId) === duplicateId)!;
      expect(
        String(
          env.workspace.resolveResourcePath(duplicateRef.location.resourceId),
        ),
      ).toBe('notes/Roadmap (1).md');
      expect(
        (
          await env.workspace.readDocument<{ raw: string }>(
            duplicateRef.documentId,
          )
        ).model.raw,
      ).toBe('');
    } finally {
      env.dispose();
    }
  });

  it('block pages take the.blockpage extension and a titled seed model', async () => {
    const env = await makeRuntime();
    try {
      const id = await env.explorer.createNote(
        'pages',
        'Ideas.blockpage',
        blockPageKindId,
      );
      const ref = env.workspace
        .listDocuments()
        .find((candidate) => String(candidate.documentId) === id)!;
      expect(
        String(env.workspace.resolveResourcePath(ref.location.resourceId)),
      ).toBe('pages/Ideas.blockpage');
      expect(ref.kindId).toBe(blockPageKindId);

      const session = await env.workspace.openDocument(ref.documentId);
      const model = session.model as BlockPageModel;
      expect(model.meta.title).toBe('Ideas');
      expect(model.rootOrder.length).toBe(1);
      await session.close();
    } finally {
      env.dispose();
    }
  });

  it('ink pages take the.ink extension and a blank bounded surface seed', async () => {
    const env = await makeRuntime();
    try {
      const id = await env.explorer.createNote(
        'sketches',
        'Doodle.ink',
        inkPageKindId,
      );
      const ref = env.workspace
        .listDocuments()
        .find((candidate) => String(candidate.documentId) === id)!;
      expect(
        String(env.workspace.resolveResourcePath(ref.location.resourceId)),
      ).toBe('sketches/Doodle.ink');
      expect(ref.kindId).toBe(inkPageKindId);

      const session = await env.workspace.openDocument(ref.documentId);
      const model = session.model as SurfaceModel;
      expect(model.formatVersion).toBe(1);
      expect(model.frame).toEqual({ kind: 'bounded', width: 800, height: 600 });
      expect(model.order).toEqual([]);
      await session.close();
    } finally {
      env.dispose();
    }
  });

  it('lists and creates plugin kinds from their registered creator metadata', async () => {
    const env = await makeRuntime();
    try {
      const kind = env.explorer
        .creatableKinds()
        .find((candidate) => candidate.label === 'Plugin page');
      expect(kind).toMatchObject({ label: 'Plugin page', extension: '.acme' });
      expect(kind?.kindId).toBe('test.plugin-page');
      const id = await env.explorer.createNote(
        'plugins',
        'Custom.acme',
        kind?.kindId ?? undefined,
      );
      const ref = env.workspace
        .listDocuments()
        .find((candidate) => String(candidate.documentId) === id)!;
      expect(
        String(env.workspace.resolveResourcePath(ref.location.resourceId)),
      ).toBe('plugins/Custom.acme');
      expect(
        (await env.workspace.readDocument<{ raw: string }>(ref.documentId))
          .model.raw,
      ).toBe('Created Custom');
    } finally {
      env.dispose();
    }
  });

  it('rejects path-traversing names for either kind', async () => {
    const env = await makeRuntime();
    try {
      await expect(env.explorer.createNote('', '../escape')).rejects.toThrow();
      await expect(env.explorer.createNote('', '.md')).rejects.toThrow(
        /invalid note name/,
      );
      await expect(
        env.explorer.createNote('', 'Unknown', 'test.missing-kind'),
      ).rejects.toThrow(/unknown document kind/);
      await expect(
        env.explorer.createNote('', 'a/b', blockPageKindId),
      ).rejects.toThrow();
      await expect(
        env.explorer.createNote('', 'a/b', inkPageKindId),
      ).rejects.toThrow();
    } finally {
      env.dispose();
    }
  });
});
