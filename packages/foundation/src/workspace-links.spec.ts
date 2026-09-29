import { describe, expect, it } from 'vitest';
import {
  InMemoryDocumentRegistry,
  markdownKind,
  markdownKindId,
  markdownModel,
  createMemoryVault,
  WorkspaceServiceImpl,
} from './index.js';
import { resolveDocumentLink } from './workspace-links.js';

async function makeWorkspace() {
  const { vault } = createMemoryVault({});
  const registry = new InMemoryDocumentRegistry();
  registry.register(markdownKind);
  return WorkspaceServiceImpl.create({
    vault,
    registry,
    metadata: new (await import('./metadata.js')).InMemoryMetadataService(),
    relationships: new (await import('./relationships.js')).InMemoryRelationshipService(),
    revisions: null,
  });
}

describe('resolveDocumentLink', () => {
  it('resolves an exact workspace path', async () => {
    const workspace = await makeWorkspace();
    const ref = await workspace.createDocument({
      kindId: markdownKindId,
      path: 'notes/target.md' as never,
      initialModel: markdownModel('# Target'),
    });
    const resolved = resolveDocumentLink(workspace, 'notes/target.md');
    expect(resolved?.ref.documentId).toBe(ref.documentId);
    expect(resolved?.path).toBe('notes/target.md');
  });

  it('appends.md when the destination omits it', async () => {
    const workspace = await makeWorkspace();
    const ref = await workspace.createDocument({
      kindId: markdownKindId,
      path: 'notes/Target.md' as never,
      initialModel: markdownModel('# Target'),
    });
    expect(resolveDocumentLink(workspace, 'notes/Target')?.ref.documentId).toBe(ref.documentId);
    expect(resolveDocumentLink(workspace, 'Target')?.ref.documentId).toBe(ref.documentId);
  });

  it('falls back to a case-insensitive basename match', async () => {
    const workspace = await makeWorkspace();
    const ref = await workspace.createDocument({
      kindId: markdownKindId,
      path: 'deep/Nested Page.md' as never,
      initialModel: markdownModel('# Nested'),
    });
    expect(resolveDocumentLink(workspace, 'nested page')?.ref.documentId).toBe(ref.documentId);
  });

  it('ignores fragments during resolution', async () => {
    const workspace = await makeWorkspace();
    const ref = await workspace.createDocument({
      kindId: markdownKindId,
      path: 'notes/Anchored.md' as never,
      initialModel: markdownModel('# A'),
    });
    expect(
      resolveDocumentLink(workspace, 'notes/Anchored.md#section-two')?.ref.documentId,
    ).toBe(ref.documentId);
  });

  it('returns null for unknown destinations and empty input', async () => {
    const workspace = await makeWorkspace();
    expect(resolveDocumentLink(workspace, 'does-not-exist')).toBeNull();
    expect(resolveDocumentLink(workspace, '')).toBeNull();
    expect(resolveDocumentLink(workspace, '   ')).toBeNull();
  });

  it('resolves relative to the source and refuses ambiguous basename guesses', async () => {
    const workspace = await makeWorkspace();
    const source = await workspace.createDocument({
      kindId: markdownKindId,
      path: 'one/source.md' as never,
      initialModel: markdownModel('# Source'),
    });
    const nearby = await workspace.createDocument({
      kindId: markdownKindId,
      path: 'one/target.md' as never,
      initialModel: markdownModel('# Nearby'),
    });
    await workspace.createDocument({
      kindId: markdownKindId,
      path: 'two/target.md' as never,
      initialModel: markdownModel('# Other'),
    });
    expect(resolveDocumentLink(workspace, 'target.md')).toBeNull();
    expect(
      resolveDocumentLink(workspace, 'target.md', source.location.resourceId)
        ?.ref.documentId,
    ).toBe(nearby.documentId);
  });
});
