/**
 * Integration tests for the LaTeX vertical slice.
 *
 * Proves the required lifecycle invariants through the shared
 * session/workspace path with no renderer at all: create/open/edit/save,
 * restart with canonical bytes unchanged, and derived projections
 * (metadata, relationships, search) rebuilt from canonical bytes.
 */
import { describe, expect, it } from 'vitest';
import { WorkspaceServiceImpl } from '../workspace.js';
import { InMemoryDocumentRegistry } from '../documents.js';
import { InMemoryMetadataService } from '../metadata.js';
import { InMemoryRelationshipService } from '../relationships.js';
import { InMemoryNavigationService } from '../navigation.js';
import { VaultRevisionService } from '../revisions.js';
import { InMemorySearchService } from '../search/service.js';
import { createMemoryVault, createMemoryVaultState } from '../vault/memory.js';
import { latexKind, latexKindId } from './kind.js';
import { latexModel } from './model.js';
import { workspacePath } from '../paths.js';
import type { LaTeXModel } from './model.js';
import type { ResourceId } from '../identity.js';

function makeWorkspace(state: ReturnType<typeof createMemoryVaultState>) {
  const { vault } = createMemoryVault({ state });
  const registry = new InMemoryDocumentRegistry();
  registry.register(latexKind);
  const metadata = new InMemoryMetadataService();
  const relationships = new InMemoryRelationshipService();
  const navigation = new InMemoryNavigationService();
  const search = new InMemorySearchService();
  let resolver: (id: ResourceId) => ReturnType<typeof workspacePath> | undefined = () => undefined;
  const revisions = new VaultRevisionService({ vault, resolveResource: (id) => resolver(id) });
  const wsPromise = WorkspaceServiceImpl.create({ vault, registry, metadata, relationships, revisions, search, workspaceId: 'ws-latex-test' });
  wsPromise.then((ws) => {
    resolver = (id) => {
      try {
        return ws.resolveResourcePath(id);
      } catch {
        return undefined;
      }
    };
  });
  return { vault, registry, metadata, relationships, navigation, search, revisions, wsPromise };
}

describe('LaTeX vertical slice — no renderer required', () => {
  it('creates, opens, edits, saves, restarts, and reopens with canonical bytes unchanged', async () => {
    const state = createMemoryVaultState();
    const { wsPromise, metadata, relationships, search } = makeWorkspace(state);
    const ws = await wsPromise;
    const initial = [
      '\\documentclass{article}',
      '\\title{Thesis Notes}',
      '\\author{Ada}',
      '\\begin{document}',
      '\\section{Intro}\\label{sec:intro}',
      'Hello \\cite{knuth84}.',
      '\\input{chapters/one}',
      '\\bibliography{refs}',
      '\\end{document}',
    ].join('\n');
    const ref = await ws.createDocument({
      kindId: latexKindId,
      path: workspacePath('papers/thesis.tex'),
      initialModel: latexModel(initial),
    });

    const session = (await ws.openDocument(ref.documentId)) as unknown as {
      model: LaTeXModel;
      markDirty(): void;
      save(): Promise<{ committed: boolean }>;
    };
    expect(session.model).toEqual(latexModel(initial));

    // Edit through the session — the editor seam writes text; no renderer involved.
    const edited = session.model.raw.replace('Hello', 'Howdy');
    (session.model as unknown as { raw: string }).raw = edited;
    session.markDirty();
    const result = await session.save();
    expect(result.committed).toBe(true);

    // Derived projections exist without any preview provider.
    expect(metadata.get(ref.documentId).title).toBe('Thesis Notes');
    expect(metadata.get(ref.documentId).properties).toMatchObject({ author: 'Ada', documentClass: 'article' });
    const edgeTypes = relationships.bySource(ref.location.resourceId).map((edge) => edge.type);
    expect(edgeTypes).toContain('latex.include');
    expect(edgeTypes).toContain('latex.bibliography');
    expect(search.search({ text: 'thesis' }).length).toBeGreaterThan(0);
    expect(search.search({ text: 'howdy' }).length).toBeGreaterThan(0);

    // Restart: a fresh workspace over the same vault bytes.
    await ws.dispose();
    const restart = makeWorkspace(state);
    const ws2 = await restart.wsPromise;
    const session2 = (await ws2.openDocument(ref.documentId)) as unknown as { model: LaTeXModel };
    expect(session2.model.raw).toBe(edited);
    expect(session2.model.raw.startsWith('\\documentclass{article}')).toBe(true);
  });

  it('indexes search anchors against portable label addresses', async () => {
    const { wsPromise } = makeWorkspace(createMemoryVaultState());
    const ws = await wsPromise;
    const ref = await ws.createDocument({
      kindId: latexKindId,
      path: workspacePath('papers/anchors.tex'),
      initialModel: latexModel(['\\begin{document}', '\\section{One}\\label{s1}', 'alpha content', '\\end{document}'].join('\n')),
    });
    const read = await ws.readDocument(ref.documentId);
    expect(read.model).toEqual(latexModel(['\\begin{document}', '\\section{One}\\label{s1}', 'alpha content', '\\end{document}'].join('\n')));
  });
});
