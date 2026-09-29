import { PropertyCatalog } from '../resource-properties/catalog.js';
import { describe, expect, it, vi } from 'vitest';
import { InMemoryDocumentRegistry } from '../documents.js';
import { InMemoryMetadataService } from '../metadata.js';
import { InMemoryRelationshipService } from '../relationships.js';
import { WorkspaceServiceImpl } from '../workspace.js';
import { createMemoryVault } from '../vault/memory.js';
import { markdownKind } from '../markdown/kind.js';
import { blockPageKind } from '../blocks/kind.js';
import { emptyBlockPage } from '../blocks/model.js';
import { workspacePath } from '../paths.js';
import { VaultRevisionService } from '../revisions.js';
import {
  WorkspaceResourceProperties,
  propertyResourceId,
  resourcePropertyPath,
} from '../resource-properties/provider.js';

describe('canonical resource properties', () => {
  async function fixture() {
    const { vault } = createMemoryVault();
    const registry = new InMemoryDocumentRegistry();
    registry.register(markdownKind);
    registry.register(blockPageKind);
    const metadata = new InMemoryMetadataService();
    const relationships = new InMemoryRelationshipService();
    const workspace = await WorkspaceServiceImpl.create({
      vault,
      registry,
      metadata,
      relationships,
      revisions: null,
    });
    const markdown = await workspace.createDocument({
      kindId: markdownKind.id,
      path: workspacePath('note.md'),
      initialModel: { raw: '# Note' },
    });
    const block = await workspace.createDocument({
      kindId: blockPageKind.id,
      path: workspacePath('page.blockpage'),
      initialModel: emptyBlockPage(),
    });
    const revisions = new VaultRevisionService({
      vault,
      resolveResource: (id) => {
        for (const ref of workspace.listDocuments())
          if (propertyResourceId(ref.location.resourceId) === id)
            return resourcePropertyPath(ref.location.resourceId);
        return undefined;
      },
    });
    const properties = new WorkspaceResourceProperties({
      workspace,
      vault,
      metadata,
      relationships,
      revisions,
      catalog: new PropertyCatalog(),
    });
    return {
      workspace,
      vault,
      registry,
      metadata,
      relationships,
      revisions,
      properties,
      markdown,
      block,
    };
  }
  it('writes through source revisions without closing or changing an open content session', async () => {
    const env = await fixture();
    const content = await env.workspace.openDocument(env.markdown.documentId);
    const bytes = await env.vault.read(workspacePath('note.md'));
    const result = await env.properties.write(
      env.markdown,
      { id: 'status', name: 'Status', type: 'text' },
      'Doing',
    );
    expect(result.committed).toBe(true);
    expect(result.revision?.documentId).toBe(env.markdown.documentId);
    expect(content.state).toBe('open');
    expect(content.dirty).toBe(false);
    expect(await env.vault.read(workspacePath('note.md'))).toEqual(bytes);
    expect(await env.properties.read(env.markdown)).toEqual({
      status: 'Doing',
    });
    await env.workspace.moveDocument(
      env.markdown.documentId,
      workspacePath('renamed.md'),
    );
    expect(await env.properties.read(env.markdown)).toEqual({
      status: 'Doing',
    });
    await env.properties.dispose();
    await env.workspace.dispose();
  });
  it('removes stale overlays and isolates corrupt property records during rebuild', async () => {
    const env = await fixture();
    try {
      env.metadata.upsert(env.markdown.documentId, {
        title: 'Note',
        properties: { source: 'canonical', count: 1 },
      });
      await env.properties.write(
        env.markdown,
        { id: 'count', name: 'Count', type: 'number' },
        2,
      );
      await env.properties.write(
        env.block,
        { id: 'healthy', name: 'Healthy', type: 'boolean' },
        true,
      );
      env.metadata.remove(env.block.documentId);
      await env.properties.rebuild();
      expect(
        env.properties
          .rows()
          .find((row) => row.resourceId === env.block.location.resourceId)
          ?.values.healthy,
      ).toBe(true);
      env.metadata.upsert(env.block.documentId, {});
      await env.vault.remove(
        resourcePropertyPath(env.markdown.location.resourceId),
      );
      await env.properties.project(env.markdown);
      expect(env.metadata.get(env.markdown.documentId).properties).toEqual({
        source: 'canonical',
        count: 1,
      });
      expect(
        env.properties
          .rows()
          .find((row) => row.resourceId === env.markdown.location.resourceId)
          ?.values.count,
      ).toBe(1);
      await env.vault.write(
        resourcePropertyPath(env.markdown.location.resourceId),
        new TextEncoder().encode('{broken'),
      );
      await env.properties.rebuild();
      expect(
        env.properties
          .rows()
          .find((row) => row.resourceId === env.block.location.resourceId)
          ?.values.healthy,
      ).toBe(true);
      expect(
        env.properties
          .rows()
          .find((row) => row.resourceId === env.markdown.location.resourceId)
          ?.diagnostics?.$properties,
      ).toBeTruthy();
      await expect(
        env.properties.write(
          env.markdown,
          { id: 'count', name: 'Count', type: 'number' },
          3,
        ),
      ).rejects.toThrow();
      expect(
        new TextDecoder().decode(
          await env.vault.read(
            resourcePropertyPath(env.markdown.location.resourceId),
          ),
        ),
      ).toBe('{broken');
      await env.properties.dispose();
      expect(
        env.metadata.get(env.block.documentId).properties?.healthy,
      ).toBeUndefined();
    } finally {
      await env.properties.dispose();
      await env.workspace.dispose();
    }
  });
  it('serializes concurrent writes, rebuilds shared projections and restores property revisions', async () => {
    const env = await fixture();
    await Promise.all([
      env.properties.write(
        env.block,
        { id: 'count', name: 'Count', type: 'number' },
        2,
      ),
      env.properties.write(
        env.block,
        { id: 'related', name: 'Related', type: 'relation' },
        [env.markdown.location.resourceId],
      ),
    ]);
    expect(await env.properties.read(env.block)).toEqual({
      count: 2,
      related: [env.markdown.location.resourceId],
    });
    await env.workspace.rebuildDerivedState();
    await env.properties.rebuild();
    expect(env.metadata.get(env.block.documentId).properties?.count).toBe(2);
    expect(env.relationships.byTarget(env.markdown.documentId)).toHaveLength(1);
    const revisions = await env.revisions.listRevisions(env.block.documentId);
    await env.properties.write(
      env.block,
      { id: 'count', name: 'Count', type: 'number' },
      8,
    );
    await env.revisions.restoreRevision(revisions[0]!.revisionId);
    expect((await env.properties.read(env.block)).count).toBe(2);
    await env.properties.dispose();
    await env.workspace.dispose();
  });
  it('rejects derived writes and survives offline workspace restart', async () => {
    const env = await fixture();
    await expect(
      env.properties.write(
        env.block,
        { id: 'x', name: 'X', type: 'formula', formula: '1' },
        3,
      ),
    ).rejects.toThrow('read-only');
    await env.properties.write(
      env.block,
      { id: 'date', name: 'Date', type: 'date' },
      '2026-09-07',
    );
    await env.properties.dispose();
    await env.workspace.dispose();
    const workspace = await WorkspaceServiceImpl.create({
      ...env,
      revisions: null,
    });
    const properties = new WorkspaceResourceProperties({
      ...env,
      workspace,
      catalog: new PropertyCatalog(),
    });
    expect(await properties.read(env.block)).toEqual({ date: '2026-09-07' });
    await properties.dispose();
    await workspace.dispose();
  });
  it('reports derived listener failure without denying a successful canonical commit', async () => {
    const env = await fixture();
    env.properties.onDidChange(() => {
      throw new Error('index listener failed');
    });
    const result = await env.properties.write(
      env.markdown,
      { id: 'company', name: 'Company', type: 'text' },
      'Acme',
    );
    expect(result.committed).toBe(true);
    expect(result.derivedError).toBeInstanceOf(Error);
    expect(await env.properties.read(env.markdown)).toEqual({
      company: 'Acme',
    });
    await env.properties.dispose();
    await env.workspace.dispose();
  });
  it('serves repeated queries from one projection without reading canonical files', async () => {
    const env = await fixture();
    await env.properties.rebuild();
    const reads = vi.spyOn(env.vault, 'read');
    for (let index = 0; index < 20; index++)
      expect(env.properties.rows()).toHaveLength(2);
    expect(reads).not.toHaveBeenCalled();
    reads.mockRestore();
    await env.properties.dispose();
    await env.workspace.dispose();
  });
  it('drains an in-flight commit before disposal resolves', async () => {
    const env = await fixture();
    await env.properties.write(
      env.markdown,
      { id: 'company', name: 'Company', type: 'text' },
      'Before',
    );
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const original = env.vault.write.bind(env.vault);
    vi.spyOn(env.vault, 'write').mockImplementation(async (...args) => {
      if (args[0] === resourcePropertyPath(env.markdown.location.resourceId)) {
        entered();
        await gate;
      }
      return original(...args);
    });
    const write = env.properties.write(
      env.markdown,
      { id: 'company', name: 'Company', type: 'text' },
      'After',
    );
    await started;
    let disposed = false;
    const disposal = env.properties.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);
    release();
    expect((await write).committed).toBe(true);
    await disposal;
    expect(disposed).toBe(true);
    await env.workspace.dispose();
  });
});
